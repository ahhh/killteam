/**
 * Objective control and mission scoring.
 *
 * Control is by total APL within control range of the marker, matching the
 * tabletop rule that tougher/multi-action operatives contest harder.
 * Scoring itself is data-driven so a new mission needs no engine change (#5).
 */
import { baseDistance } from '../maps/geometry.js';
import { CONTROL_RANGE } from './visibility.js';
import { EVENTS, logEvent, liveOperatives, opponentOf, warnUnsupported } from '../state.js';
import { effectiveApl, isInjured } from './effects.js';
import { hasToken, tokenControlAplDelta } from './tokens.js';
import { profileOf } from './hooks.js';

/**
 * Conditions a `controlModifiers` entry may carry. All are ANDed, all optional.
 *
 * Kill Team writes a surprising number of rules as "treat its APL as one
 * higher when determining control of markers… this does not change its APL
 * stat". They cannot be rule hooks: a hook fires at a moment, and control is
 * recomputed continuously, from wherever the operatives happen to be standing.
 * So a pack declares them as their own block and this module reads it — data,
 * never code, and an unknown key is reported once and then ignored.
 */
export const CONTROL_CONDITIONS = [
  'keyword',                 // the contesting operative's profile has this
  'notKeyword',
  'hasToken',                // it holds one of its own team's tokens
  'notHasToken',
  'friendlyWithin',          // {inches, keyword} — a named friendly is near it
  'contestedWithKeyword',    // another friendly on the SAME marker has this
  'wounded',                 // it is Injured (or, false, is not)
];

/** Operatives contesting a marker, split by player. */
export function contestants(state, objective) {
  const marker = { x: objective.x, y: objective.y, baseDiameter: 0 };
  const out = { p1: [], p2: [] };
  for (const op of liveOperatives(state)) {
    if (baseDistance(op, marker) <= (objective.controlRange ?? CONTROL_RANGE) + 1e-9) {
      out[op.playerId].push(op);
    }
  }
  return out;
}

/** Does one `controlModifiers` entry apply to this operative on this marker? */
function modifierApplies(state, mod, op, alliesOnMarker) {
  const cond = mod.condition || {};
  for (const key of Object.keys(cond)) {
    if (!CONTROL_CONDITIONS.includes(key)) {
      warnUnsupported(state, `control-condition:${key}`,
        `${mod.rule || mod.id} uses an unknown control condition "${key}"`);
      return false;
    }
  }
  const keywords = profileOf(state, op)?.keywords || [];
  if (cond.keyword && !keywords.includes(cond.keyword)) return false;
  if (cond.notKeyword) {
    const excluded = Array.isArray(cond.notKeyword) ? cond.notKeyword : [cond.notKeyword];
    if (excluded.some((k) => keywords.includes(k))) return false;
  }
  if (cond.hasToken && !hasToken(op, cond.hasToken, op.playerId)) return false;
  if (cond.notHasToken && hasToken(op, cond.notHasToken, op.playerId)) return false;
  if (cond.wounded !== undefined && isInjured(op) !== cond.wounded) return false;
  if (cond.friendlyWithin !== undefined) {
    const spec = typeof cond.friendlyWithin === 'object'
      ? cond.friendlyWithin : { inches: cond.friendlyWithin };
    const reach = Number(spec.inches) || 0;
    const near = liveOperatives(state, op.playerId).some((o) => {
      if (o.id === op.id || baseDistance(op, o) > reach) return false;
      if (!spec.keyword) return true;
      return (profileOf(state, o)?.keywords || []).includes(spec.keyword);
    });
    if (!near) return false;
  }
  if (cond.contestedWithKeyword) {
    const withHim = alliesOnMarker.some((o) => o.id !== op.id &&
      (profileOf(state, o)?.keywords || []).includes(cond.contestedWithKeyword));
    if (!withHim) return false;
  }
  return true;
}

/**
 * The APL this operative contributes to control of THIS marker.
 *
 * `effectiveApl` is what it can act with; this is what it counts for on a
 * marker, and the two deliberately differ — Loss of Restraint makes a
 * blood-maddened Marine a poor scorer without taking an action off him.
 */
export function controlApl(state, op, alliesOnMarker = []) {
  let apl = effectiveApl(op) + tokenControlAplDelta(op);
  const mods = state.teamPacks?.[op.playerId]?.controlModifiers || [];
  for (const mod of mods) {
    if (!modifierApplies(state, mod, op, alliesOnMarker)) continue;
    apl += Number(mod.delta) || 0;
    if (mod.cap !== undefined) apl = Math.min(apl, Number(mod.cap));
  }
  return Math.max(1, apl);
}

export function controlValue(operatives, state = null) {
  if (!state) return operatives.reduce((sum, op) => sum + effectiveApl(op), 0);
  return operatives.reduce((sum, op) => sum + controlApl(state, op, operatives), 0);
}

/** Recompute `controlledBy` for every objective. Returns changes for logging. */
export function updateObjectiveControl(state) {
  const changes = [];
  for (const objective of state.objectives) {
    const c = contestants(state, objective);
    const v1 = controlValue(c.p1, state);
    const v2 = controlValue(c.p2, state);
    let controller = null;
    if (v1 > v2) controller = 'p1';
    else if (v2 > v1) controller = 'p2';
    // Equal (including 0-0) leaves control with nobody: contested.

    if (controller !== objective.controlledBy) {
      changes.push({ objectiveId: objective.id, from: objective.controlledBy, to: controller });
      objective.controlledBy = controller;
    }
    objective.control = { p1: v1, p2: v2 };
  }
  return changes;
}

export function objectivesControlledBy(state, playerId) {
  return state.objectives.filter((o) => o.controlledBy === playerId);
}

function award(state, playerId, amount, reason) {
  if (amount <= 0) return;
  const player = state.players[playerId];
  player.victoryPoints += amount;
  player.vpBreakdown[reason] = (player.vpBreakdown[reason] || 0) + amount;
  logEvent(state, EVENTS.VP_AWARDED, {
    playerId, amount, reason, total: player.victoryPoints,
  });
}

/**
 * End-of-turning-point mission scoring.
 * @param {object} state
 * @param {{[playerId:string]:number}} killsThisTurn
 */
export function scoreTurningPoint(state, killsThisTurn) {
  updateObjectiveControl(state);
  const rules = state.mission.scoring || {};
  // What each side actually did this turning point, before any cap bites.
  // Reported whether or not it scored, because "held two markers and was paid
  // for none of them" is the interesting case when a mission is being tuned.
  const raw = { held: { p1: 0, p2: 0 }, kills: { p1: 0, p2: 0 } };

  for (const playerId of ['p1', 'p2']) {
    if (rules.objectives) {
      const held = objectivesControlledBy(state, playerId);
      raw.held[playerId] = held.length;
      const per = rules.objectives.vpPer ?? 1;
      const cap = rules.objectives.maxPerTurningPoint ?? Infinity;
      const vp = Math.min(held.length * per, cap);
      if (vp > 0) {
        logEvent(state, EVENTS.OBJECTIVE_SCORED, {
          playerId, objectives: held.map((o) => o.id), vp,
        });
      }
      award(state, playerId, vp, 'objectives');
    }

    if (rules.kills) {
      const kills = killsThisTurn[playerId] || 0;
      raw.kills[playerId] = kills;
      const per = rules.kills.vpPer ?? 1;
      const cap = rules.kills.maxPerTurningPoint ?? Infinity;
      award(state, playerId, Math.min(kills * per, cap), 'kills');
    }
  }
  state.lastTurningPointScoring = raw;

  for (const key of Object.keys(rules)) {
    if (!['objectives', 'kills', 'endOfBattle'].includes(key)) {
      warnUnsupported(state, `mission-scoring:${key}`, `${state.mission.id} uses unimplemented scoring "${key}"`);
    }
  }
}

/** Scoring that only happens once, after the final turning point. */
export function scoreEndOfBattle(state) {
  const rules = state.mission.scoring?.endOfBattle;
  if (!rules) return;
  for (const playerId of ['p1', 'p2']) {
    if (rules.survivorVpPer) {
      const survivors = liveOperatives(state, playerId).length;
      award(state, playerId, survivors * rules.survivorVpPer, 'survivors');
    }
    if (rules.wipeoutVp) {
      const foes = liveOperatives(state, opponentOf(playerId)).length;
      if (foes === 0) award(state, playerId, rules.wipeoutVp, 'wipeout');
    }
  }
}
