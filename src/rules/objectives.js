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
import { effectiveApl } from './effects.js';

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

export function controlValue(operatives) {
  return operatives.reduce((sum, op) => sum + effectiveApl(op), 0);
}

/** Recompute `controlledBy` for every objective. Returns changes for logging. */
export function updateObjectiveControl(state) {
  const changes = [];
  for (const objective of state.objectives) {
    const c = contestants(state, objective);
    const v1 = controlValue(c.p1);
    const v2 = controlValue(c.p2);
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
