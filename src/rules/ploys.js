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
 * Scope, deliberately: STRATEGIC ploys are bought in the strategy phase and
 * last the turning point, which is what the printed timing says and what maps
 * onto an always-on hook. FIREFIGHT ploys are reactive — "use this when an
 * attack dice inflicts Normal Dmg" — and need an interrupt the step machine
 * does not have, so they are catalogued, costed and reported as unsupported
 * rather than approximated. EQUIPMENT is chosen before the battle and is
 * likewise catalogued but not applied.
 */
import { warnUnsupported, EVENTS, logEvent } from '../state.js';

/** Ploy kinds a pack may declare, and where each one is bought. */
export const PLOY_KINDS = {
  strategic: { field: 'strategicPloys', label: 'Strategic ploy', timing: 'strategy phase' },
  firefight: { field: 'firefightPloys', label: 'Firefight ploy', timing: 'during an activation' },
};

/** What a ploy costs when its pack does not say. Every printed ploy is 1 CP. */
export const DEFAULT_PLOY_COST = 1;

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

/** Normalise one pack entry into the shape the rest of this module uses. */
function normalise(entry, kind) {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  return {
    id: entry.id,
    kind,
    name: entry.name || entry.id,
    description: entry.description || '',
    cost: Number.isInteger(entry.cost) ? entry.cost : DEFAULT_PLOY_COST,
    /** Some ploys may only be bought once in a battle; most may recur. */
    oncePerBattle: entry.oncePerBattle === true,
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
  if (!player.ploys) {
    player.ploys = { active: [], usedThisBattle: [], spentThisTurningPoint: 0 };
  }
  return player.ploys;
}

/** Ploy ids in force for `playerId` right now. */
export function activePloyIds(state, playerId) {
  return ployState(state, playerId).active;
}

/** Clear the strategic ploys bought last turning point. */
export function expirePloys(state) {
  for (const playerId of ['p1', 'p2']) {
    const ps = ployState(state, playerId);
    ps.active = [];
    ps.spentThisTurningPoint = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Legality and purchase                                               */
/* ------------------------------------------------------------------ */

/**
 * Why this ploy cannot be bought right now, or null if it can.
 * Kept separate from `activatePloy` so the AI can explain a rejection.
 */
export function ployBlocker(state, playerId, ploy) {
  if (!ploy) return 'no such ploy';
  if (ploy.kind !== 'strategic') return `${PLOY_KINDS[ploy.kind].label}s are used ${PLOY_KINDS[ploy.kind].timing}`;
  if (!ploy.supported) return 'not simulated by this engine';
  const ps = ployState(state, playerId);
  if (ps.active.includes(ploy.id)) return 'already in force this turning point';
  if (ploy.oncePerBattle && ps.usedThisBattle.includes(ploy.id)) return 'already used this battle';
  if (state.players[playerId].cp < ploy.cost) return `costs ${ploy.cost} CP, ${state.players[playerId].cp} available`;
  return null;
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

  const player = state.players[playerId];
  const ps = ployState(state, playerId);
  player.cp -= ploy.cost;
  ps.active.push(ploy.id);
  ps.spentThisTurningPoint += ploy.cost;
  if (ploy.oncePerBattle) ps.usedThisBattle.push(ploy.id);

  logEvent(state, EVENTS.PLOY_USED, {
    playerId, ployId: ploy.id, ployName: ploy.name, kind: ploy.kind,
    cost: ploy.cost, cpRemaining: player.cp, turningPoint: state.turningPoint,
  });
  return { ok: true, ploy };
}

/* ------------------------------------------------------------------ */
/* Reaching the rules engine                                           */
/* ------------------------------------------------------------------ */

/**
 * Hooks contributed by the ploys currently in force, tagged so the battle log
 * names the ploy that paid for the effect rather than an anonymous rule id.
 */
export function activePloyHooks(state, playerId, trigger) {
  const pack = state.teamPacks?.[playerId];
  if (!pack) return [];
  const out = [];
  for (const ployId of activePloyIds(state, playerId)) {
    const ploy = findPloy(pack, ployId);
    if (!ploy) continue;
    for (const [i, hook] of ploy.hooks.entries()) {
      if (hook.trigger !== trigger) continue;
      out.push({ ...hook, id: hook.id || `${ploy.id}:${i}`, rule: hook.rule || ploy.name });
    }
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

    // A strategic ploy with no hooks is a specific, fillable gap — someone can
    // sit down and author it — so each one is named.
    for (const ploy of ployCatalogue(pack, 'strategic')) {
      if (ploy.supported) continue;
      warnUnsupported(state, `ploy:${pack.id}:${ploy.id}`,
        `${name}: strategic ploy "${ploy.name}" declares no hooks — it will never be used`);
    }

    // Firefight ploys and equipment are blocked on engine work rather than on
    // data, and there are ~10 per team. Naming each one every battle buries
    // the warnings that a reader can act on, so they are counted instead.
    const firefight = ployCatalogue(pack, 'firefight');
    if (firefight.length) {
      warnUnsupported(state, `ploy-firefight:${pack.id}`,
        `${name}: ${firefight.length} firefight ploys are reactive and are not simulated ` +
        `(${firefight.map((p) => p.name).join(', ')})`);
    }
    const equipment = (pack.equipment || []).filter((e) => e?.id);
    if (equipment.length) {
      warnUnsupported(state, `equipment:${pack.id}`,
        `${name}: ${equipment.length} equipment options are chosen before the battle ` +
        `and are not simulated (${equipment.map((e) => e.name || e.id).join(', ')})`);
    }
  }
}
