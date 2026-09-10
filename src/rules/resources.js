/**
 * Team resource economies: Power From Pain, GORE TANKs, Blooded tokens.
 *
 * A family of faction rules share one shape the engine had no home for. The
 * team earns a countable *something* — a Pain token, a level of GORE TANK, a
 * Blooded token — off the back of what its operatives do, and then spends it
 * again on a small menu of effects with their own windows and limits. Until
 * now the engine counted the earnings and nothing spent them, which made the
 * three teams that live on those economies play like teams with a dead rule.
 *
 * The shape is the same three parts every time, so it is DATA (§34) in exactly
 * the way `ruleHooks` and `weaponRules` are data. A pack declares:
 *
 *   "resources": {
 *     "pain": {
 *       "name": "Pain token",
 *       "rule": "Power From Pain",
 *       "scope": "operative",          // or "player" — a shared pool
 *       "start": 0, "max": 4,
 *       "gains":  [ { "trigger": …, "amount": 1, … } ],
 *       "spends": [ { "id": …, "window": …, "cost": 1, "effect": { … } } ]
 *     }
 *   }
 *
 * Nothing here is evaluated: a trigger, window or effect the engine does not
 * implement is reported through `warnUnsupported` and ignored, never guessed
 * (#7). The three vocabularies below are the whole contract.
 *
 * Who decides to spend, and when:
 *
 *  - `activation` spends are a 0-AP **action** (`{type:'spend'}`), so the AI
 *    proposes them and the action layer validates them like anything else.
 *    That is what puts Dark Animus and Rejuvenate in the AI's hands rather
 *    than in a hard-coded reflex.
 *  - `attackDice` / `defenceDice` spends land in the middle of a dice roll,
 *    where there is no action layer to ask. Those use the fixed policy in
 *    `diceRerollSpend` below, which is documented and deterministic.
 */
import { Rng } from '../rng.js';
import { EVENTS, logEvent, liveOperatives, warnUnsupported } from '../state.js';
import { rollExpression, grantFreeAction, timesAllowed, profileOf } from './hooks.js';
import { applyDamage, isInjured } from './effects.js';
import { grantToken } from './tokens.js';
import { baseDistance } from '../maps/geometry.js';
import { withinControlRange } from './visibility.js';

/** How a resource is earned. Anything else is reported and fails closed. */
export const RESOURCE_GAIN_TRIGGERS = {
  readyStep: 'Gained in the Ready step of every turning point.',
  enemyInjured: 'The operative\'s action left an enemy injured, but alive.',
  enemyIncapacitated: 'The operative\'s action incapacitated an enemy.',
  killWithin: 'The operative incapacitated something within x" of it.',
  firstKillEachTurningPoint: 'The first enemy incapacitated in each turning point.',
  firstLossNearEnemyEachTurningPoint:
    'The first friendly operative lost within x" of an enemy, each turning point.',
};

/** When a spend may be made. */
export const RESOURCE_SPEND_WINDOWS = {
  activation: 'A 0-AP action during the operative\'s activation or counteraction.',
  attackDice: 'After rolling attack dice for the operative.',
  defenceDice: 'After rolling defence dice for the operative.',
};

/** What a spend does. */
export const RESOURCE_SPEND_EFFECTS = {
  addApl: 'Add to the operative\'s APL until the start of its next activation.',
  healWounds: 'Regain lost wounds, up to a dice expression.',
  freeAction: 'Grant one action that costs no AP.',
  extraAction: 'Allow one action type to be performed again this activation.',
  weaponBoost: 'Add Atk, Dmg or weapon rules for the next action of a named type.',
  moveBonus: 'Add inches to the Move stat for the next move action.',
  inflictDamage: 'Inflict damage on an enemy the operative is standing over.',
  rerollDice: 'Re-roll dice after they are rolled (attack or defence).',
};

/** Conditions a gain or a spend may carry. */
export const RESOURCE_CONDITIONS = [
  'keyword',                     // the holder's profile has this keyword
  'wounded',                     // the holder has lost at least one wound
  'injured',                     // the holder is Injured
  'incapacitatedThisActivation', // it has killed something this activation
  'actionAvailable',             // it could still legally perform this action
  'performedThisActivation',
  'notPerformedThisActivation',
  'enemyWithinControlRange',
];

/* ------------------------------------------------------------------ */
/* Declaration lookup                                                  */
/* ------------------------------------------------------------------ */

/** The `resources` block of the pack this player is running. */
export function resourceDefs(state, playerId) {
  return state.teamPacks?.[playerId]?.resources || {};
}

export function resourceDef(state, playerId, key) {
  const def = resourceDefs(state, playerId)[key];
  return def ? { key, ...def } : null;
}

/** True when this pack runs any resource economy at all. */
export function hasResources(state, playerId) {
  return Object.keys(resourceDefs(state, playerId)).length > 0;
}

/**
 * The starting amount for one resource, for a pack loading into a new battle.
 * A GORE TANK starts at half, which is why this is not simply zero.
 */
export function startingResources(pack, scope) {
  const out = {};
  for (const [key, def] of Object.entries(pack?.resources || {})) {
    if ((def.scope || 'operative') !== scope) continue;
    const start = Number(def.start) || 0;
    if (start > 0) out[key] = start;
  }
  return out;
}

/** Where a resource of this shape is kept: on the operative, or in a pool. */
function holderOf(state, op, def) {
  return (def.scope || 'operative') === 'player' ? state.players[op.playerId] : op;
}

/** How much of `key` this operative can draw on right now. */
export function amountOf(state, op, key) {
  const def = resourceDef(state, op.playerId, key);
  if (!def) return 0;
  return Number(holderOf(state, op, def).resources?.[key]) || 0;
}

/** The pool an operative's team shares, for the roster panel. */
export function playerResources(state, playerId) {
  const out = [];
  for (const [key, def] of Object.entries(resourceDefs(state, playerId))) {
    if ((def.scope || 'operative') !== 'player') continue;
    out.push({
      key,
      label: def.name || key,
      amount: Number(state.players[playerId].resources?.[key]) || 0,
    });
  }
  return out;
}

/** Everything an operative is personally holding, for its roster card. */
export function operativeResources(state, op) {
  const out = [];
  for (const [key, def] of Object.entries(resourceDefs(state, op.playerId))) {
    if ((def.scope || 'operative') === 'player') continue;
    if (!keywordHolds(state, op, def.keyword)) continue;
    const amount = Number(op.resources?.[key]) || 0;
    out.push({ key, label: def.name || key, amount, text: levelLabel(def, amount) });
  }
  return out;
}

/** A levelled track reads as a word, not a number: "GORE TANK: half". */
export function levelLabel(def, amount) {
  const levels = def.levels;
  if (!Array.isArray(levels) || !levels.length) return String(amount);
  return levels[Math.max(0, Math.min(levels.length - 1, amount))];
}

function keywordHolds(state, op, keyword) {
  if (!keyword) return true;
  return (profileOf(state, op)?.keywords || []).includes(keyword);
}

/* ------------------------------------------------------------------ */
/* Changing the count                                                  */
/* ------------------------------------------------------------------ */

/**
 * Move a resource count up or down, respecting its cap and floor.
 *
 * A GORE TANK "cannot increase when it's already full, or decrease when it's
 * already empty", which is the same clamp every counted resource wants, so it
 * lives here rather than in each caller.
 *
 * @returns {number} how much actually moved (0 when the clamp ate it).
 */
export function changeResource(state, op, key, delta, { rule = null, detail = null } = {}) {
  const def = resourceDef(state, op.playerId, key);
  if (!def || !delta) return 0;
  const holder = holderOf(state, op, def);
  if (!holder.resources) holder.resources = {};

  const before = Number(holder.resources[key]) || 0;
  const max = def.max === undefined || def.max === null ? Infinity : Number(def.max);
  const after = Math.max(0, Math.min(max, before + delta));
  if (after === before) return 0;
  holder.resources[key] = after;

  const name = def.name || key;
  const moved = after - before;
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: `resource:${key}`,
    rule: rule || def.rule || name,
    operativeId: op.id, operativeName: op.name, playerId: op.playerId,
    detail: detail || (def.levels
      ? `${name} ${moved > 0 ? 'increases' : 'decreases'} to ${levelLabel(def, after)}`
      : `${moved > 0 ? 'gains' : 'spends'} ${Math.abs(moved)} ${name} (now ${after})`),
    resource: { key, amount: after, delta: moved },
  });
  return moved;
}

/**
 * Grant a resource from a weapon rule — Flay's Pain token, Blood Offering,
 * Ritual's GORE TANK. The weapon rule says who gets it; the clamp, the label
 * and the log entry are the same as any other gain.
 */
export function grantResourceFromWeapon(state, op, effect, { rule = null } = {}) {
  const key = effect.resource;
  if (!resourceDef(state, op.playerId, key)) {
    warnUnsupported(state, `resource:${key}`,
      `${rule || key} feeds a "${key}" resource this pack does not declare`);
    return 0;
  }
  const recipient = effect.target === 'friendly'
    ? bestFriendForResource(state, op, key, effect.within)
    : op;
  if (!recipient) return 0;
  return changeResource(state, recipient, key, Number(effect.amount) || 1, { rule });
}

/**
 * Who a "select one friendly operative to gain one of your Pain tokens" rule
 * hands it to: the nearest friend in range that can still hold one, the
 * wielder itself included, breaking ties on operative id so replays match.
 */
function bestFriendForResource(state, op, key, within) {
  const def = resourceDef(state, op.playerId, key);
  const max = def.max === undefined || def.max === null ? Infinity : Number(def.max);
  const reach = Number(within) || 6;
  return liveOperatives(state, op.playerId)
    .filter((o) => o.id === op.id || baseDistance(op, o) <= reach)
    .filter((o) => keywordHolds(state, o, def.keyword))
    .filter((o) => (Number(o.resources?.[key]) || 0) < max)
    .sort((a, b) => (Number(b.resources?.[key]) || 0) - (Number(a.resources?.[key]) || 0) ||
      baseDistance(op, a) - baseDistance(op, b) || (a.id < b.id ? -1 : 1))[0] || null;
}

/* ------------------------------------------------------------------ */
/* Gains                                                               */
/* ------------------------------------------------------------------ */

/**
 * The Ready step: resources that accrue with the turning point rather than
 * with anything an operative did, plus the assignment step that turns a shared
 * pool into per-operative tokens (Blooded).
 */
export function resourceReadyStep(state) {
  for (const playerId of ['p1', 'p2']) {
    for (const [key, raw] of Object.entries(resourceDefs(state, playerId))) {
      const def = { key, ...raw };
      for (const gain of def.gains || []) {
        if (gain.trigger !== 'readyStep') continue;
        const amount = Number(gain.amount) || 1;
        if ((def.scope || 'operative') === 'player') {
          const anchor = liveOperatives(state, playerId)[0];
          if (anchor) changeResource(state, anchor, def.key, amount, { rule: gain.rule || def.rule });
        } else {
          for (const op of liveOperatives(state, playerId)) {
            if (!keywordHolds(state, op, def.keyword)) continue;
            changeResource(state, op, def.key, amount, { rule: gain.rule || def.rule });
          }
        }
      }
      assignPooledResource(state, playerId, def);
    }
  }
}

/**
 * Blooded's STRATEGIC GAMBIT: unassigned tokens from the pool are handed to
 * operatives, one each, and the token is what carries the rule the operative
 * then plays with. Four or more assigned puts one of them under the GAZE OF
 * THE GODS until the end of the turning point.
 *
 * The engine assigns as many as it can, nearest-to-the-enemy first — a token
 * that grants Accurate 1 is worth most on an operative about to shoot.
 */
function assignPooledResource(state, playerId, def) {
  const assign = def.assign;
  if (!assign || (def.scope || 'operative') !== 'player') return;

  const pool = Number(state.players[playerId].resources?.[def.key]) || 0;
  if (pool <= 0) return;

  const enemies = liveOperatives(state).filter((o) => o.playerId !== playerId);
  const kind = assign.token?.kind || def.key;
  const candidates = liveOperatives(state, playerId)
    .filter((o) => keywordHolds(state, o, assign.toKeyword || def.keyword))
    .filter((o) => !(o.tokens || []).some((t) => t.kind === kind && t.owner === playerId))
    .sort((a, b) => nearestDistance(a, enemies) - nearestDistance(b, enemies) ||
      (a.id < b.id ? -1 : 1));

  let spent = 0;
  for (const op of candidates) {
    if (spent >= pool) break;
    if (!grantToken(state, op, assign.token, { owner: playerId, rule: def.rule || def.key })) continue;
    spent++;
  }
  if (spent > 0) {
    changeResource(state, candidates[0], def.key, -spent, {
      rule: def.rule,
      detail: `assigns ${spent} ${def.name || def.key}(s) to friendly operatives`,
    });
  }

  // GAZE OF THE GODS: with enough operatives marked, one of them is elevated
  // for the turning point. The engine picks the one holding the best weapon,
  // measured by Atk × Critical Dmg, so the upgrade lands where it converts.
  const elevate = assign.elevate;
  if (!elevate) return;
  const marked = liveOperatives(state, playerId)
    .filter((o) => (o.tokens || []).some((t) => t.kind === kind && t.owner === playerId));
  if (marked.length < (Number(elevate.atLeast) || 4)) return;
  const already = marked.some((o) => (o.tokens || []).some(
    (t) => t.kind === elevate.token?.kind && t.owner === playerId));
  if (already) return;
  const chosen = [...marked].sort((a, b) => weaponWeight(state, b) - weaponWeight(state, a) ||
    (a.id < b.id ? -1 : 1))[0];
  if (chosen) {
    grantToken(state, chosen, elevate.token, { owner: playerId, rule: elevate.label || def.rule });
  }
}

function nearestDistance(op, others) {
  return others.length ? Math.min(...others.map((o) => baseDistance(op, o))) : Infinity;
}

function weaponWeight(state, op) {
  const weapons = profileOf(state, op)?.weapons || [];
  return weapons.reduce((best, w) => Math.max(best, w.atk * (w.damage?.critical || 0)), 0);
}

/**
 * Everything a team earns from one action, evaluated for BOTH players.
 *
 * Power From Pain and Gore Tanks reward the operative that acted; Blooded also
 * pays out when one of its own is killed, which happens during the *enemy's*
 * action — so the window is offered to both packs and each reads what it
 * declares an interest in.
 *
 * The action's effects are read off the event log slice it produced, the same
 * way `tallyKills` reads its kills: it is the one record of what happened that
 * cannot drift out of step with what the rules actually did.
 */
export function applyPostActionResources(state, actingOp, fromSeq) {
  const window = summariseWindow(state, fromSeq);
  if (!window.incapacitated.length && !window.damaged.length) return;

  // Vitalised Surge asks whether this operative has killed yet, so the count
  // is kept whether or not either team runs an economy.
  if (actingOp) {
    const mine = window.incapacitated.filter(
      (d) => d.playerId !== actingOp.playerId &&
        (!d.source.attackerId || d.source.attackerId === actingOp.id)).length;
    if (mine) actingOp.killsThisActivation = (actingOp.killsThisActivation || 0) + mine;
  }
  if (!hasResources(state, 'p1') && !hasResources(state, 'p2')) return;

  for (const playerId of ['p1', 'p2']) {
    const defs = resourceDefs(state, playerId);
    for (const [key, raw] of Object.entries(defs)) {
      const def = { key, ...raw };
      for (const gain of def.gains || []) {
        applyGain(state, playerId, def, gain, actingOp, window);
      }
    }
  }
}

function summariseWindow(state, fromSeq) {
  const incapacitated = [];
  const damaged = [];
  for (let i = fromSeq; i < state.eventLog.length; i++) {
    const e = state.eventLog[i];
    if (e.type === EVENTS.OPERATIVE_INCAPACITATED) {
      incapacitated.push({ id: e.operativeId, playerId: e.playerId, source: e.source || {} });
    } else if (e.type === EVENTS.DAMAGE_APPLIED) {
      damaged.push({ id: e.operativeId, playerId: e.playerId, source: e.source || {} });
    }
  }
  return { incapacitated, damaged };
}

function applyGain(state, playerId, def, gain, actingOp, window) {
  const trigger = gain.trigger;
  if (!(trigger in RESOURCE_GAIN_TRIGGERS)) {
    warnUnsupported(state, `resource-gain:${trigger}`,
      `${def.rule || def.key} uses an unknown gain trigger "${trigger}"`);
    return;
  }
  if (trigger === 'readyStep') return; // handled in the Ready step

  const rule = gain.rule || def.rule;
  const mine = actingOp && actingOp.playerId === playerId;
  const eligible = mine && keywordHolds(state, actingOp, gain.keyword || def.keyword);

  if (trigger === 'enemyInjured' && eligible) {
    // "an enemy operative was injured during that action, but was not
    // incapacitated" — Injured is the keyword: half wounds or fewer.
    const hurt = window.damaged.filter((d) => d.playerId !== playerId)
      .map((d) => state.operatives[d.id])
      .filter((o) => o && o.alive && isInjured(o) && attributedTo(actingOp, o, window));
    if (hurt.length) changeResource(state, actingOp, def.key, Number(gain.amount) || 1, { rule });
    return;
  }

  if (trigger === 'enemyIncapacitated' && eligible) {
    const kills = window.incapacitated.filter((d) => d.playerId !== playerId)
      .filter((d) => !d.source.attackerId || d.source.attackerId === actingOp.id);
    if (!kills.length) return;
    let amount = Number(gain.amount) || 1;
    const bonus = gain.bonusIfWoundsAtLeast;
    if (bonus && kills.some((k) => (state.operatives[k.id]?.wounds || 0) >= Number(bonus.wounds))) {
      amount = Number(bonus.amount) || amount;
    }
    changeResource(state, actingOp, def.key, amount, { rule });
    return;
  }

  if (trigger === 'killWithin' && eligible) {
    const reach = Number(gain.within) || 2;
    const near = window.incapacitated
      .filter((d) => !d.source.attackerId || d.source.attackerId === actingOp.id)
      .map((d) => state.operatives[d.id])
      .filter((o) => o && (withinControlRange(actingOp, o) || baseDistance(actingOp, o) <= reach));
    if (near.length) changeResource(state, actingOp, def.key, Number(gain.amount) || 1, { rule });
    return;
  }

  if (trigger === 'firstKillEachTurningPoint') {
    if (!window.incapacitated.some((d) => d.playerId !== playerId)) return;
    if (!claimOncePerTurningPoint(state, playerId, `${def.key}:kill`)) return;
    const anchor = liveOperatives(state, playerId)[0];
    if (anchor) changeResource(state, anchor, def.key, Number(gain.amount) || 1, { rule });
    return;
  }

  if (trigger === 'firstLossNearEnemyEachTurningPoint') {
    const reach = Number(gain.within) || 6;
    const lost = window.incapacitated
      .filter((d) => d.playerId === playerId)
      .map((d) => state.operatives[d.id])
      .filter((o) => o && liveOperatives(state).some(
        (e) => e.playerId !== playerId && baseDistance(o, e) <= reach));
    if (!lost.length) return;
    if (!claimOncePerTurningPoint(state, playerId, `${def.key}:loss`)) return;
    const anchor = liveOperatives(state, playerId)[0] || lost[0];
    changeResource(state, anchor, def.key, Number(gain.amount) || 1, { rule });
  }
}

/** Did this operative's action cause the damage, as far as the log can tell? */
function attributedTo(actingOp, target, window) {
  return window.damaged.some(
    (d) => d.id === target.id && (!d.source.attackerId || d.source.attackerId === actingOp.id)
  );
}

/** "the first time … during each turning point", tracked on the player. */
function claimOncePerTurningPoint(state, playerId, key) {
  const player = state.players[playerId];
  if (!player.resourceFirsts) player.resourceFirsts = {};
  if (player.resourceFirsts[key] === state.turningPoint) return false;
  player.resourceFirsts[key] = state.turningPoint;
  return true;
}

/* ------------------------------------------------------------------ */
/* Spends: what is on the menu right now                               */
/* ------------------------------------------------------------------ */

/** Per-activation bookkeeping. Reset by an activation AND a counteraction. */
export function resetSpendLimits(op) {
  op.spendsThisActivation = {};
  op.actionBoosts = [];
  op.spendExtraActions = {};
  op.killsThisActivation = 0;
}

function spendCount(op, tag) {
  return Number(op.spendsThisActivation?.[tag]) || 0;
}

/**
 * Every spend this operative could make in this window, cheapest first.
 * @returns {Array<{key:string, def:object, spend:object, cost:number}>}
 */
export function availableSpends(state, op, { window = 'activation' } = {}) {
  const out = [];
  if (!op?.alive) return out;
  for (const [key, raw] of Object.entries(resourceDefs(state, op.playerId))) {
    const def = { key, ...raw };
    for (const spend of def.spends || []) {
      if ((spend.window || 'activation') !== window) continue;
      if (spendBlocker(state, op, def, spend)) continue;
      out.push({ key, def, spend, cost: Number(spend.cost) || 1 });
    }
  }
  return out.sort((a, b) => a.cost - b.cost || (a.spend.id < b.spend.id ? -1 : 1));
}

/**
 * Spends this operative could afford, ignoring the conditions that depend on
 * what has not happened yet.
 *
 * `availableSpends` answers "what can I do now", which is the right question
 * for the action layer and the wrong one for an AI planning a *reaction*:
 * Vitalised Surge is never available while the enemy it needs dead is alive,
 * so a planner that only asked the first question could never plan for it.
 */
export function declaredSpends(state, op, { window = 'activation' } = {}) {
  const out = [];
  if (!op?.alive) return out;
  for (const [key, raw] of Object.entries(resourceDefs(state, op.playerId))) {
    const def = { key, ...raw };
    for (const spend of def.spends || []) {
      if ((spend.window || 'activation') !== window) continue;
      if (!(spend.effect?.type in RESOURCE_SPEND_EFFECTS)) continue;
      if (!keywordHolds(state, op, spend.keyword || def.keyword)) continue;
      if (amountOf(state, op, key) < (Number(spend.cost) || 1)) continue;
      out.push({ key, def, spend, cost: Number(spend.cost) || 1 });
    }
  }
  return out;
}

/** Look a spend up by id, across every resource this pack declares. */
export function findSpend(state, playerId, key, spendId) {
  const raw = resourceDefs(state, playerId)[key];
  if (!raw) return null;
  const def = { key, ...raw };
  const spend = (def.spends || []).find((s) => s.id === spendId);
  return spend ? { key, def, spend, cost: Number(spend.cost) || 1 } : null;
}

/**
 * Why this operative may not make this spend, or null.
 *
 * Covers the count, the printed per-activation limits ("you cannot use more
 * than one invigoration per activation", "not more than two SANGUAVITAE
 * rules", "you cannot use Mania and Fury during the same activation") and the
 * spend's own conditions.
 */
export function spendBlocker(state, op, def, spend) {
  const effectType = spend.effect?.type;
  if (!effectType || !(effectType in RESOURCE_SPEND_EFFECTS)) {
    return `${spend.name || spend.id} uses an unimplemented effect`;
  }
  const cost = Number(spend.cost) || 1;
  if (amountOf(state, op, def.key) < cost) {
    return `not enough ${def.name || def.key}`;
  }
  if (!keywordHolds(state, op, spend.keyword || def.keyword)) {
    return `${spend.name || spend.id} is not for this operative`;
  }

  // Per-spend, per-resource and mutual-exclusion limits. `group` lets one
  // printed rule that appears in two windows — Stimulated Senses covers both
  // attack and defence dice — share a single per-activation allowance.
  if (spendCount(op, `spend:${spend.group || spend.id}`) >= (Number(spend.perActivation) || 1)) {
    return `${spend.name || spend.id} already used this activation`;
  }
  const poolLimit = Number(def.perActivation);
  if (poolLimit && !spend.exempt &&
      spendCount(op, `res:${def.key}`) >= poolLimit) {
    return `already used ${poolLimit} ${def.rule || def.key} this activation`;
  }
  for (const other of spend.excludes || []) {
    if (spendCount(op, `spend:${other}`) > 0) {
      return `${spend.name || spend.id} cannot follow ${other} in one activation`;
    }
  }

  return conditionBlocker(state, op, spend);
}

function conditionBlocker(state, op, spend) {
  const cond = spend.condition || {};
  for (const key of Object.keys(cond)) {
    if (!RESOURCE_CONDITIONS.includes(key)) {
      warnUnsupported(state, `resource-condition:${key}`,
        `${spend.name || spend.id} uses an unknown condition "${key}"`);
      return `unknown condition "${key}"`;
    }
  }
  if (cond.keyword && !keywordHolds(state, op, cond.keyword)) return 'wrong keyword';
  if (cond.wounded && op.woundsRemaining >= op.wounds) return 'has lost no wounds';
  if (cond.injured && !isInjured(op)) return 'is not injured';
  if (cond.incapacitatedThisActivation && !(op.killsThisActivation > 0)) {
    return 'has not incapacitated anything this activation';
  }
  if (cond.enemyWithinControlRange &&
      !liveOperatives(state).some((o) => o.playerId !== op.playerId && withinControlRange(op, o))) {
    return 'no enemy within control range';
  }
  if (cond.actionAvailable && !actionStillAvailable(state, op, cond.actionAvailable)) {
    return `cannot perform ${cond.actionAvailable} again this activation`;
  }
  const used = op.usedThisActivation || [];
  if (cond.performedThisActivation &&
      !cond.performedThisActivation.every((a) => used.includes(a))) {
    return `has not performed ${cond.performedThisActivation.join(', ')}`;
  }
  if (cond.notPerformedThisActivation &&
      cond.notPerformedThisActivation.some((a) => used.includes(a))) {
    return `has already performed ${cond.notPerformedThisActivation.join(', ')}`;
  }
  return null;
}

/**
 * Could this operative still perform `type` this activation?
 *
 * Rage and Fury are bought "when a friendly operative performs the Fight
 * action", so paying for one after the last Fight is spent is a wasted token.
 * Mirrors `alreadyUsed` in the action layer, which is not importable here
 * without a cycle.
 */
function actionStillAvailable(state, op, type) {
  const used = (op.usedThisActivation || []).filter((t) => t === type).length;
  return used < timesAllowed(state, op, type) + extraActionsFromSpends(op, type);
}

/* ------------------------------------------------------------------ */
/* Spends: resolution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Make one spend. Called by the action layer for `activation` spends, so every
 * limit above is re-checked here even though the AI was told about them (#3).
 *
 * @returns {{ok:boolean, reason?:string, detail?:string}}
 */
export function resolveSpend(state, op, { resource, spendId }) {
  const found = findSpend(state, op.playerId, resource, spendId);
  if (!found) return { ok: false, reason: `unknown spend "${resource}/${spendId}"` };
  const { def, spend, cost } = found;
  if ((spend.window || 'activation') !== 'activation') {
    return { ok: false, reason: `${spend.name || spendId} is not spent as an action` };
  }
  const blocked = spendBlocker(state, op, def, spend);
  if (blocked) return { ok: false, reason: blocked };

  const rng = Rng.fromState(state.rng);
  const detail = applySpendEffect(state, rng, op, def, spend);
  state.rng = rng.getState();
  if (!detail) return { ok: false, reason: `${spend.name || spendId} had no effect` };

  commitSpend(state, op, def, spend, detail);
  return { ok: true, detail };
}

/** Pay for a spend and record it against this activation's limits. */
function commitSpend(state, op, def, spend, detail) {
  changeResource(state, op, def.key, -(Number(spend.cost) || 1), {
    rule: spend.name || def.rule,
    detail: `${spend.name || spend.id}: ${detail}`,
  });
  if (!op.spendsThisActivation) op.spendsThisActivation = {};
  const tag = `spend:${spend.group || spend.id}`;
  op.spendsThisActivation[tag] = spendCount(op, tag) + 1;
  if (!spend.exempt) {
    const pool = `res:${def.key}`;
    op.spendsThisActivation[pool] = spendCount(op, pool) + 1;
  }
}

/**
 * @returns {string|null} what happened, for the log — null if nothing did.
 */
function applySpendEffect(state, rng, op, def, spend) {
  const effect = spend.effect || {};
  switch (effect.type) {
    case 'addApl': {
      const amount = Number(effect.amount) || 1;
      op.aplBonus = (op.aplBonus || 0) + amount;
      // APL rises mid-activation, so the point it buys is spendable now.
      if (op.apRemaining > 0 || (op.usedThisActivation || []).length) {
        op.apRemaining += amount;
      }
      return `+${amount} APL until the start of its next activation`;
    }
    case 'healWounds': {
      const lost = op.wounds - op.woundsRemaining;
      if (lost <= 0) return null;
      const rolled = rollExpression(rng, effect.dice || 'D3');
      const healed = Math.min(lost, rolled);
      if (healed <= 0) return null;
      op.woundsRemaining += healed;
      return `regains ${healed} lost wound(s) (rolled ${rolled})`;
    }
    case 'freeAction': {
      grantFreeAction(op, effect.action, {
        unrestricted: effect.unrestricted === true,
        rule: spend.name || def.rule,
      });
      return `gains a free ${effect.action}`;
    }
    case 'extraAction': {
      const action = effect.action;
      if (!op.spendExtraActions) op.spendExtraActions = {};
      op.spendExtraActions[action] = (op.spendExtraActions[action] || 0) + (Number(effect.count) || 1);
      if (effect.free) {
        grantFreeAction(op, action, { rule: spend.name || def.rule });
      }
      return `may perform ${action} again this activation${effect.free ? ', for free' : ''}`;
    }
    case 'weaponBoost': {
      if (!op.actionBoosts) op.actionBoosts = [];
      op.actionBoosts.push({
        kind: 'weapon',
        actions: effect.appliesTo || ['fight'],
        weaponType: effect.weaponType || null,
        atkBonus: Number(effect.atkBonus) || 0,
        damageNormal: Number(effect.damageNormal) || 0,
        damageCritical: Number(effect.damageCritical) || 0,
        rules: effect.rules || [],
        rule: spend.name || def.rule,
      });
      const parts = [];
      if (effect.atkBonus) parts.push(`+${effect.atkBonus} Atk`);
      if (effect.rules?.length) parts.push(effect.rules.join(', '));
      return `${parts.join(' and ') || 'a better profile'} for its next ` +
        `${(effect.appliesTo || ['fight']).join('/')}`;
    }
    case 'moveBonus': {
      if (!op.actionBoosts) op.actionBoosts = [];
      op.actionBoosts.push({
        kind: 'move',
        actions: effect.appliesTo || ['charge', 'reposition'],
        inches: Number(effect.inches) || 1,
        rule: spend.name || def.rule,
      });
      return `+${Number(effect.inches) || 1}" Move for its next ` +
        `${(effect.appliesTo || ['charge', 'reposition']).join('/')}`;
    }
    case 'inflictDamage': {
      const reach = Number(effect.within) || 0;
      const victim = liveOperatives(state)
        .filter((o) => o.playerId !== op.playerId)
        .filter((o) => withinControlRange(op, o) || (reach && baseDistance(op, o) <= reach))
        .sort((a, b) => a.woundsRemaining - b.woundsRemaining || (a.id < b.id ? -1 : 1))[0];
      if (!victim) return null;
      const amount = rollExpression(rng, effect.dice || 'D3');
      if (amount <= 0) return null;
      applyDamage(state, victim.id, amount, {
        kind: 'resource-spend', attackerId: op.id, rule: spend.name || def.rule,
      });
      return `inflicts ${amount} damage on ${victim.name}`;
    }
    case 'rerollDice':
      return null; // resolved inside the dice roll, never as an action
    default:
      warnUnsupported(state, `resource-spend:${effect.type}`,
        `${spend.name || spend.id} uses an unimplemented effect "${effect.type}"`);
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* What a spend leaves lying around for the action layer to read        */
/* ------------------------------------------------------------------ */

/** Extra uses of one action type bought with a resource this activation. */
export function extraActionsFromSpends(op, type) {
  return Number(op?.spendExtraActions?.[type]) || 0;
}

/** Inches a `moveBonus` spend adds to this particular move action. */
export function resourceMoveBonus(op, type) {
  let inches = 0;
  for (const boost of op?.actionBoosts || []) {
    if (boost.kind !== 'move') continue;
    if (!(boost.actions || []).includes(type)) continue;
    inches += Number(boost.inches) || 0;
  }
  return inches;
}

/**
 * Weapon deltas a `weaponBoost` spend adds for this action — Rage's +1 Atk.
 * Shaped like a `weaponRules` effect so `weaponAdjustments` can fold it in
 * next to everything else that bends a profile for one sequence.
 */
export function resourceWeaponBoosts(op, weapon, action) {
  const out = [];
  for (const boost of op?.actionBoosts || []) {
    if (boost.kind !== 'weapon') continue;
    if (action && !(boost.actions || []).includes(action)) continue;
    if (boost.weaponType && weapon?.type !== boost.weaponType) continue;
    out.push(boost);
  }
  return out;
}

/**
 * Spend-bought boosts last "until the end of that action", so the action that
 * used one takes it away again.
 */
export function consumeActionBoosts(op, type) {
  if (!op?.actionBoosts?.length) return;
  op.actionBoosts = op.actionBoosts.filter((b) => !(b.actions || []).includes(type));
}

/* ------------------------------------------------------------------ */
/* Validation support                                                  */
/* ------------------------------------------------------------------ */

/** Static check used by the pack validator; mirrors the runtime vocabulary. */
export function describeResource(key, def) {
  const problems = [];
  if (!def || typeof def !== 'object') return [`resources.${key} is not an object`];
  if (!def.name) problems.push(`resources.${key} has no display name`);
  if (!def.text) problems.push(`resources.${key} carries no printed wording in "text"`);
  const scope = def.scope || 'operative';
  if (scope !== 'operative' && scope !== 'player') {
    problems.push(`resources.${key} has an unknown scope "${scope}"`);
  }
  if (def.levels && !Array.isArray(def.levels)) {
    problems.push(`resources.${key}.levels must be an array of level names`);
  }
  if (Array.isArray(def.levels) && def.max !== undefined &&
      def.levels.length !== Number(def.max) + 1) {
    problems.push(`resources.${key} names ${def.levels.length} levels but caps at ${def.max}`);
  }

  for (const gain of def.gains || []) {
    if (!(gain.trigger in RESOURCE_GAIN_TRIGGERS)) {
      problems.push(`resources.${key} uses an unimplemented gain trigger "${gain.trigger}"`);
    }
  }

  const ids = new Set();
  for (const spend of def.spends || []) {
    const label = `resources.${key}.spends.${spend.id ?? '?'}`;
    if (!spend.id) { problems.push(`${label} has no id`); continue; }
    if (ids.has(spend.id)) problems.push(`${label} is declared twice`);
    ids.add(spend.id);
    if (!spend.text) problems.push(`${label} carries no printed wording in "text"`);
    const window = spend.window || 'activation';
    if (!(window in RESOURCE_SPEND_WINDOWS)) {
      problems.push(`${label} uses an unimplemented window "${window}"`);
    }
    const type = spend.effect?.type;
    if (!type) problems.push(`${label} declares no effect type`);
    else if (!(type in RESOURCE_SPEND_EFFECTS)) {
      problems.push(`${label} uses an unimplemented effect "${type}"`);
    }
    if (type === 'rerollDice' && window === 'activation') {
      problems.push(`${label} re-rolls dice but is declared in the activation window`);
    }
    for (const cond of Object.keys(spend.condition || {})) {
      if (!RESOURCE_CONDITIONS.includes(cond)) {
        problems.push(`${label} uses an unknown condition "${cond}"`);
      }
    }
    for (const other of spend.excludes || []) {
      if (!(def.spends || []).some((s) => s.id === other)) {
        problems.push(`${label} excludes "${other}", which this resource does not declare`);
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* Dice-window spends                                                  */
/* ------------------------------------------------------------------ */

/**
 * Stimulated Senses: "after rolling your attack or defence dice … you can
 * re-roll any of your dice results of one result".
 *
 * There is no action layer inside a dice roll, so this is the one place the
 * engine decides for itself. The policy: find the failing result the most dice
 * are showing, and take the re-roll when it is worth at least
 * `REROLL_THRESHOLD` of a success in expectation. At a 4+ that means two dice
 * or more; at a 2+ a single die is already worth it. It never re-rolls dice
 * that already succeeded, and it never spends the token on a roll it cannot
 * improve.
 *
 * @returns {{choose:Function, onUse:Function}|null} a policy for `rollAttack`
 *          / `rollDefence`, or null when nothing is available.
 */
const REROLL_THRESHOLD = 0.6;

export function diceRerollSpend(state, op, { kind }) {
  const window = kind === 'attack' ? 'attackDice' : 'defenceDice';
  const options = availableSpends(state, op, { window })
    .filter((o) => o.spend.effect?.type === 'rerollDice');
  if (!options.length) return null;
  const { def, spend } = options[0];
  const mode = spend.effect.mode || 'oneResult';

  return {
    /**
     * @param {number[]} rolls the dice as they landed
     * @param {{isFail:Function}} info how this roll reads a die
     * @returns {number[]} indices to re-roll
     */
    choose(rolls, info) {
      const failing = rolls.map((d, i) => ({ d, i })).filter(({ d }) => info.isFail(d));
      if (!failing.length) return [];
      const pSuccess = [1, 2, 3, 4, 5, 6].filter((v) => !info.isFail(v)).length / 6;
      if (pSuccess <= 0) return [];

      let group = failing.map(({ i }) => i);
      if (mode === 'oneResult') {
        const byValue = new Map();
        for (const { d, i } of failing) byValue.set(d, [...(byValue.get(d) || []), i]);
        group = [...byValue.values()].sort((a, b) => b.length - a.length)[0];
      }
      return group.length * pSuccess >= REROLL_THRESHOLD ? group : [];
    },
    onUse(indices) {
      commitSpend(state, op, def, spend,
        `re-rolls ${indices.length} ${kind} dice`);
    },
  };
}
