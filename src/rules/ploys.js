/**
 * Ploys: the CP economy, and the rules a team buys with it.
 *
 * Every pack already carried `strategicPloys`, `firefightPloys` and
 * `equipment`, and the engine read none of them. That was not a cosmetic gap.
 * On the tabletop a team's power budget is split between its statline and the
 * rules it can pay for, so simulating only the statline silently taxes every
 * team whose design leans on its ploys — and hands a rebate to the teams whose
 * strength is printed on the card. CP accrued at `phases.js` and was never
 * spent by anything, which is the same bug seen from the other end.
 *
 * A ploy reaches the engine the way every other pack rule does (§34): as DATA
 * drawn from a fixed vocabulary, never as code. Specifically, a supported ploy
 * declares `hooks` in exactly the shape `ruleHooks` already uses:
 *
 *   { "id": "waaagh", "name": "WAAAGH!", "cost": 1,
 *     "description": "…the printed wording…",
 *     "hooks": [{ "trigger": "beforeAttackRoll",
 *                 "condition": { "weaponType": "melee" },
 *                 "effect": { "type": "grantWeaponRule", "rules": ["balanced"] } }] }
 *
 * so it inherits the whole condition and effect vocabulary of `hooks.js`, and
 * needs no engine change to add one. A ploy with no `hooks` is *unsupported*,
 * not broken: it is reported once through `warnUnsupported` and then ignored,
 * so a pack is never silently half-simulated.
 *
 * Three kinds of spend, which is what makes CP a decision rather than a tax:
 *
 *  - STRATEGIC ploys are bought in the strategy phase and last the turning
 *    point. They reach the whole team, so they are the buy for a player who
 *    knows what the turning point is *for*.
 *  - FIREFIGHT ploys with `timing: "activation"` are bought during one
 *    operative's activation, as a 0-AP action the AI plans like a resource
 *    spend (`{type:'ploy'}` in `engine.js`). Their hooks are scoped to that
 *    operative and lapse when its activation ends — this is the CP that buys a
 *    second Fight, a heavier swing, one more inch of charge.
 *  - FIREFIGHT ploys with `timing: "defence"` are REACTIVE: they are bought in
 *    the middle of somebody else's attack, which is a window with no action
 *    layer to ask. Those follow the published policy in `reactiveDefenceHooks`
 *    below, funded by the reserve the controller wrote into `player.cpPlan`.
 *
 * EQUIPMENT is chosen before the battle and is catalogued but not applied.
 */
import { warnUnsupported, EVENTS, logEvent } from '../state.js';

/** Ploy kinds a pack may declare, and where each one is bought. */
export const PLOY_KINDS = {
  strategic: { field: 'strategicPloys', label: 'Strategic ploy', timing: 'strategy phase' },
  firefight: { field: 'firefightPloys', label: 'Firefight ploy', timing: 'during an activation' },
};

/** What a ploy costs when its pack does not say. Every printed ploy is 1 CP. */
export const DEFAULT_PLOY_COST = 1;

/** When a firefight ploy may be bought. */
export const FIREFIGHT_TIMINGS = {
  activation: 'During a friendly operative\'s activation, as a 0-AP choice.',
  defence: 'When a friendly operative is attacked — a reaction, not an action.',
};

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

/** Normalise one pack entry into the shape the rest of this module uses. */
function normalise(entry, kind) {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  const timing = kind === 'firefight'
    ? (entry.timing in FIREFIGHT_TIMINGS ? entry.timing : 'activation')
    : 'strategy';
  return {
    id: entry.id,
    kind,
    name: entry.name || entry.id,
    description: entry.description || '',
    cost: Number.isInteger(entry.cost) ? entry.cost : DEFAULT_PLOY_COST,
    /** Some ploys may only be bought once in a battle; most may recur. */
    oncePerBattle: entry.oncePerBattle === true,
    /** …and some only once each turning point, however many operatives want it. */
    oncePerTurningPoint: entry.oncePerTurningPoint === true,
    timing,
    /**
     * Who a firefight ploy reaches. Almost all of them are printed as "that
     * operative"; a few buff the whole team for the activation, and say so.
     */
    scope: entry.scope === 'team' ? 'team' : 'operative',
    hooks,
    supported: hooks.length > 0,
  };
}

/** Every ploy a pack declares, of one kind or of all kinds. */
export function ployCatalogue(pack, kind = null) {
  const kinds = kind ? [kind] : Object.keys(PLOY_KINDS);
  const out = [];
  for (const k of kinds) {
    for (const entry of pack?.[PLOY_KINDS[k].field] || []) {
      if (entry?.id) out.push(normalise(entry, k));
    }
  }
  return out;
}

/** One ploy by id, from either list. */
export function findPloy(pack, ployId) {
  return ployCatalogue(pack).find((p) => p.id === ployId) || null;
}

/* ------------------------------------------------------------------ */
/* Player ploy state                                                   */
/* ------------------------------------------------------------------ */

/**
 * The per-player bookkeeping, created lazily so a state built before this
 * module existed (an old replay) still runs.
 */
function ployState(state, playerId) {
  const player = state.players[playerId];
  if (!player.ploys) player.ploys = {};
  const ps = player.ploys;
  if (!ps.active) ps.active = [];
  if (!ps.usedThisBattle) ps.usedThisBattle = [];
  if (!ps.usedThisTurningPoint) ps.usedThisTurningPoint = [];
  /** Firefight ploys in force: {ployId, operativeId, scope, duration}. */
  if (!ps.firefight) ps.firefight = [];
  if (ps.spentThisTurningPoint === undefined) ps.spentThisTurningPoint = 0;
  /** What the battle log and the roster panel report about the CP economy. */
  if (!ps.cpSpent) ps.cpSpent = { strategic: 0, firefight: 0, reactive: 0 };
  return ps;
}

/** Strategic ploy ids in force for `playerId` right now. */
export function activePloyIds(state, playerId) {
  return ployState(state, playerId).active;
}

/** Firefight ploys in force for `playerId` right now. */
export function activeFirefightPloys(state, playerId) {
  return ployState(state, playerId).firefight;
}

/** What this player has spent CP on so far, by kind. */
export function cpSpentBreakdown(state, playerId) {
  return { ...ployState(state, playerId).cpSpent };
}

/** Clear the ploys bought last turning point. */
export function expirePloys(state) {
  for (const playerId of ['p1', 'p2']) {
    const ps = ployState(state, playerId);
    ps.active = [];
    ps.firefight = [];
    ps.usedThisTurningPoint = [];
    ps.spentThisTurningPoint = 0;
  }
}

/**
 * A firefight ploy bought for an activation lapses when that activation ends,
 * which is what "during that activation" means and what stops a 1 CP action
 * ploy from buffing the whole turning point.
 */
export function expireActivationPloys(state, op) {
  if (!op) return;
  const ps = ployState(state, op.playerId);
  ps.firefight = ps.firefight.filter(
    (f) => f.duration !== 'activation' || f.operativeId !== op.id);
}

/**
 * A reactive ploy lasts "until the end of that sequence" — the shot or the
 * fight it was bought against, and no longer.
 */
export function expireSequencePloys(state) {
  for (const playerId of ['p1', 'p2']) {
    const ps = ployState(state, playerId);
    if (!ps.firefight.length) continue;
    ps.firefight = ps.firefight.filter((f) => f.duration !== 'sequence');
  }
}

/* ------------------------------------------------------------------ */
/* Legality and purchase                                               */
/* ------------------------------------------------------------------ */

/** Limits that apply to any ploy however it is bought. */
function commonBlocker(state, playerId, ploy) {
  if (!ploy) return 'no such ploy';
  if (!ploy.supported) return 'not simulated by this engine';
  const ps = ployState(state, playerId);
  if (ploy.oncePerBattle && ps.usedThisBattle.includes(ploy.id)) return 'already used this battle';
  if (ploy.oncePerTurningPoint && ps.usedThisTurningPoint.includes(ploy.id)) {
    return 'already used this turning point';
  }
  if (state.players[playerId].cp < ploy.cost) {
    return `costs ${ploy.cost} CP, ${state.players[playerId].cp} available`;
  }
  return null;
}

/**
 * Why this strategic ploy cannot be bought right now, or null if it can.
 * Kept separate from `activatePloy` so the AI can explain a rejection.
 */
export function ployBlocker(state, playerId, ploy) {
  if (!ploy) return 'no such ploy';
  if (ploy.kind !== 'strategic') return `${PLOY_KINDS[ploy.kind].label}s are used ${PLOY_KINDS[ploy.kind].timing}`;
  const ps = ployState(state, playerId);
  if (ps.active.includes(ploy.id)) return 'already in force this turning point';
  return commonBlocker(state, playerId, ploy);
}

/** Every strategic ploy `playerId` could buy at this moment. */
export function playablePloys(state, playerId) {
  const pack = state.teamPacks?.[playerId];
  return ployCatalogue(pack, 'strategic').filter((p) => !ployBlocker(state, playerId, p));
}

/**
 * Buy one strategic ploy. Returns `{ok}` so an AI proposing an illegal
 * purchase is rejected the way an illegal action is (#3), never trusted.
 */
export function activatePloy(state, playerId, ployId) {
  const pack = state.teamPacks?.[playerId];
  const ploy = findPloy(pack, ployId);
  const blocker = ployBlocker(state, playerId, ploy);
  if (blocker) return { ok: false, reason: blocker };

  const ps = ployState(state, playerId);
  payFor(state, playerId, ploy, 'strategic');
  ps.active.push(ploy.id);
  ps.spentThisTurningPoint += ploy.cost;

  logPloy(state, playerId, ploy, { detail: 'in force until the end of the turning point' });
  return { ok: true, ploy };
}

/* ------------------------------------------------------------------ */
/* Firefight ploys                                                     */
/* ------------------------------------------------------------------ */

/**
 * Why this operative cannot buy this firefight ploy right now, or null.
 *
 * A reactive ploy is deliberately never legal here: it is bought inside an
 * attack sequence by `reactiveDefenceHooks`, not chosen as an action.
 */
export function firefightBlocker(state, op, ploy) {
  if (!ploy) return 'no such ploy';
  if (ploy.kind !== 'firefight') return `${PLOY_KINDS[ploy.kind].label}s are used ${PLOY_KINDS[ploy.kind].timing}`;
  if (ploy.timing !== 'activation') return 'used when this operative is attacked, not as an action';
  if (!op?.alive) return 'operative is incapacitated';
  const ps = ployState(state, op.playerId);
  if (ps.firefight.some((f) => f.ployId === ploy.id && f.operativeId === op.id)) {
    return 'already in force for this operative';
  }
  return commonBlocker(state, op.playerId, ploy);
}

/** Every firefight ploy this operative could buy during its activation. */
export function playableFirefightPloys(state, op) {
  const pack = state.teamPacks?.[op?.playerId];
  return ployCatalogue(pack, 'firefight').filter((p) => !firefightBlocker(state, op, p));
}

/**
 * Spend CP on a firefight ploy during `op`'s activation.
 *
 * The hooks it brings have already missed `onActivationStart` — the activation
 * is under way — so those are replayed here, and everything else is left for
 * the triggers still to come. That is what makes "this operative can perform
 * two Fight actions" work when the CP is paid after the first swing.
 */
export function useFirefightPloy(state, op, ployId, { applyStart = null } = {}) {
  const pack = state.teamPacks?.[op?.playerId];
  const ploy = findPloy(pack, ployId);
  const blocker = firefightBlocker(state, op, ploy);
  if (blocker) return { ok: false, reason: blocker };

  payFor(state, op.playerId, ploy, 'firefight');
  ployState(state, op.playerId).firefight.push({
    ployId: ploy.id,
    operativeId: op.id,
    scope: ploy.scope,
    duration: 'activation',
    turningPoint: state.turningPoint,
  });

  // Replay the start-of-activation grants this ploy brings with it.
  if (applyStart) {
    for (const hook of ploy.hooks) {
      if (hook.trigger !== 'onActivationStart') continue;
      applyStart(state, op, { ...hook, id: hook.id || `${ploy.id}:start`, rule: hook.rule || ploy.name });
    }
  }

  logPloy(state, op.playerId, ploy, {
    operative: op, detail: `during ${op.name}'s activation`,
  });
  return { ok: true, ploy };
}

/**
 * Reactive ploys: the CP a team keeps in hand for somebody else's turn.
 *
 * There is no action layer inside an attack sequence, so — like the dice-window
 * resource spends in `resources.js` — this is a published, deterministic
 * policy rather than a call back into the AI. What it is NOT is a reflex: the
 * budget and the trigger come from `player.cpPlan`, which the controller wrote
 * in the strategy phase out of its doctrine. A team that plans to bank its CP
 * for a strategic ploy has no reserve here and will take the hit instead.
 *
 * Bought at most once per sequence, and the instance lasts the sequence, so a
 * ploy that both adds defence dice and caps damage applies at both triggers.
 *
 * @returns {Array} hooks contributed by whatever was just bought (possibly [])
 */
export function reactiveDefenceHooks(state, defender, ctx = {}) {
  const pack = state.teamPacks?.[defender?.playerId];
  if (!pack || !defender?.alive) return [];
  const ps = ployState(state, defender.playerId);
  // One reaction per sequence: a second would be paying twice for the same shot.
  if (ps.firefight.some((f) => f.duration === 'sequence')) return [];

  const plan = state.players[defender.playerId].cpPlan || {};
  const budget = Number(plan.reactionBudget) || 0;
  if (budget <= 0) return [];

  const options = ployCatalogue(pack, 'firefight')
    .filter((p) => p.timing === 'defence')
    .filter((p) => p.supported)
    .filter((p) => !commonBlocker(state, defender.playerId, p))
    .filter((p) => p.cost <= budget)
    .sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));
  if (!options.length) return [];

  if (!reactionWarranted(state, defender, ctx, plan)) return [];

  const ploy = options[0];
  payFor(state, defender.playerId, ploy, 'reactive');
  state.players[defender.playerId].cpPlan = { ...plan, reactionBudget: budget - ploy.cost };
  ps.firefight.push({
    ployId: ploy.id,
    operativeId: defender.id,
    scope: ploy.scope,
    duration: 'sequence',
    turningPoint: state.turningPoint,
  });
  logPloy(state, defender.playerId, ploy, {
    operative: defender, detail: `reacting to the attack on ${defender.name}`,
  });

  return ploy.hooks.map((hook, i) => ({
    ...hook,
    id: hook.id || `${ploy.id}:${i}`,
    rule: hook.rule || ploy.name,
  }));
}

/**
 * Is this the attack worth reacting to?
 *
 * `reactionTrigger` is the controller's answer, and it is the difference
 * between a team that spends its reserve on the first bolt round it sees and
 * one that holds it for the shot that would take an operative off the board.
 *
 *  - `always`  — any attack. A team with CP it has nothing else to do with.
 *  - `wounded` — the defender has already lost wounds.
 *  - `lethal`  — the attack could plausibly finish the defender (the default).
 */
function reactionWarranted(state, defender, ctx, plan) {
  const trigger = plan.reactionTrigger || 'lethal';
  if (trigger === 'always') return true;
  if (trigger === 'wounded') return defender.woundsRemaining < defender.wounds;

  const weapon = ctx.weapon;
  if (!weapon) return false;
  // A coarse projection of the shot: about half the dice land, and a landed
  // die does somewhere between normal and critical damage. Precise enough to
  // separate "this could kill me" from "this is a scratch", which is the only
  // question being asked.
  const normal = Number(weapon.damage?.normal) || 0;
  const critical = Number(weapon.damage?.critical) || 0;
  const perHit = normal * 0.75 + critical * 0.25;
  const projected = (Number(weapon.atk) || 0) * 0.5 * perHit;
  return projected >= defender.woundsRemaining * (Number(plan.reactionRatio) || 0.6);
}

/* ------------------------------------------------------------------ */
/* Paying, and saying so                                               */
/* ------------------------------------------------------------------ */

function payFor(state, playerId, ploy, bucket) {
  const player = state.players[playerId];
  const ps = ployState(state, playerId);
  player.cp -= ploy.cost;
  ps.cpSpent[bucket] = (ps.cpSpent[bucket] || 0) + ploy.cost;
  if (ploy.oncePerBattle) ps.usedThisBattle.push(ploy.id);
  if (ploy.oncePerTurningPoint) ps.usedThisTurningPoint.push(ploy.id);
}

function logPloy(state, playerId, ploy, { operative = null, detail = '' } = {}) {
  logEvent(state, EVENTS.PLOY_USED, {
    playerId,
    ployId: ploy.id,
    ployName: ploy.name,
    kind: ploy.kind,
    timing: ploy.timing,
    cost: ploy.cost,
    cpRemaining: state.players[playerId].cp,
    turningPoint: state.turningPoint,
    operativeId: operative?.id ?? null,
    operativeName: operative?.name ?? null,
    detail,
  });
}

/* ------------------------------------------------------------------ */
/* Reaching the rules engine                                           */
/* ------------------------------------------------------------------ */

/**
 * Hooks contributed by the ploys currently in force, tagged so the battle log
 * names the ploy that paid for the effect rather than an anonymous rule id.
 *
 * `operative` scopes the firefight ploys: one bought during a Banshee's
 * activation belongs to that Banshee, not to the team. A strategic ploy has no
 * such limit — the whole team paid for it.
 */
export function activePloyHooks(state, playerId, trigger, operative = null) {
  const pack = state.teamPacks?.[playerId];
  if (!pack) return [];
  const ps = state.players?.[playerId]?.ploys;
  const out = [];

  const collect = (ployId, tag) => {
    const ploy = findPloy(pack, ployId);
    if (!ploy) return;
    for (const [i, hook] of ploy.hooks.entries()) {
      if (hook.trigger !== trigger) continue;
      out.push({ ...hook, id: hook.id || `${tag}:${i}`, rule: hook.rule || ploy.name });
    }
  };

  for (const ployId of ps?.active || []) collect(ployId, ployId);
  for (const inst of ps?.firefight || []) {
    if (inst.scope !== 'team' && operative && inst.operativeId !== operative.id) continue;
    if (inst.scope !== 'team' && !operative) continue;
    collect(inst.ployId, inst.ployId);
  }
  return out;
}

/**
 * Report the ploys and equipment this engine cannot play, once per battle.
 * Called at setup so the notice sits at the top of the log next to the team's
 * support badge, where it explains a result rather than trailing it.
 */
export function reportUnsupportedPloys(state) {
  for (const playerId of ['p1', 'p2']) {
    const pack = state.teamPacks?.[playerId];
    if (!pack) continue;
    const name = pack.displayName || pack.id;

    // A ploy with no hooks is a specific, fillable gap — someone can sit down
    // and author it — so each one is named, whichever list it is printed in.
    for (const ploy of ployCatalogue(pack)) {
      if (ploy.supported) continue;
      warnUnsupported(state, `ploy:${pack.id}:${ploy.id}`,
        `${name}: ${PLOY_KINDS[ploy.kind].label.toLowerCase()} "${ploy.name}" declares no hooks ` +
        '— it will never be used');
    }

    const equipment = (pack.equipment || []).filter((e) => e?.id);
    if (equipment.length) {
      warnUnsupported(state, `equipment:${pack.id}`,
        `${name}: ${equipment.length} equipment options are chosen before the battle ` +
        `and are not simulated (${equipment.map((e) => e.name || e.id).join(', ')})`);
    }
  }
}
