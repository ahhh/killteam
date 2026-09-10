/**
 * Turning-point state machine.
 *
 * The battle advances one STEP at a time so the UI can animate it; a step is
 * the smallest unit that leaves the state coherent (a deployment, an
 * initiative roll, one full activation, one scoring pass).
 */
import { Rng } from '../rng.js';
import {
  PHASES, ORDERS, EVENTS, logEvent, liveOperatives, allOperatives,
  readyOperatives, opponentOf,
} from '../state.js';
import { pointInPolygon, polygonBounds, polygonCentroid } from '../maps/geometry.js';
import { isPositionLegal } from './movement.js';
import { resolveAction, getLegalActions } from './engine.js';
import { updateObjectiveControl, scoreTurningPoint, scoreEndOfBattle } from './objectives.js';
import { effectiveApl } from './effects.js';
import { fireTurningPointStart, fireActivationStart } from './hooks.js';

export const MAX_TURNING_POINTS = 4;
const CP_PER_TURNING_POINT = 1;

/* ------------------------------------------------------------------ */
/* Deployment                                                          */
/* ------------------------------------------------------------------ */

function zoneFor(state, playerId) {
  const zones = state.map.deploymentZones || [];
  const zone = zones.find((z) => z.playerId === playerId) || zones[0];
  if (!zone) throw new Error(`map ${state.map.id} has no deployment zone for ${playerId}`);
  return zone;
}

/** Deterministically scatter a team across its deployment zone. */
function deployTeam(state, playerId, rng) {
  const zone = zoneFor(state, playerId);
  const poly = zone.shape.points;
  const bounds = polygonBounds(poly);
  const centre = polygonCentroid(poly);
  const team = liveOperatives(state, null).filter((o) => o.playerId === playerId);
  const roster = allOperatives(state).filter((o) => o.playerId === playerId);

  for (const op of roster) {
    let placed = false;
    for (let attempt = 0; attempt < 400 && !placed; attempt++) {
      // Widen the search as attempts fail: start clustered, then use the zone.
      const spread = Math.min(1, 0.35 + attempt / 200);
      const x = centre.x + (rng.next() - 0.5) * (bounds.maxX - bounds.minX) * spread;
      const y = centre.y + (rng.next() - 0.5) * (bounds.maxY - bounds.minY) * spread;
      if (!pointInPolygon(x, y, poly)) continue;
      op.x = x; op.y = y; op.placed = true;
      if (isPositionLegal(state, op.id, x, y).ok) {
        placed = true;
      } else {
        op.placed = false;
      }
    }
    if (!placed) {
      // Fall back to a grid sweep so a tight zone never drops an operative.
      const step = 0.5;
      for (let y = bounds.minY; y <= bounds.maxY && !placed; y += step) {
        for (let x = bounds.minX; x <= bounds.maxX && !placed; x += step) {
          if (!pointInPolygon(x, y, poly)) continue;
          op.x = x; op.y = y; op.placed = true;
          if (isPositionLegal(state, op.id, x, y).ok) placed = true;
          else op.placed = false;
        }
      }
    }
    op.order = ORDERS.CONCEAL;
    if (placed) {
      logEvent(state, EVENTS.DEPLOYED, {
        operativeId: op.id, operativeName: op.name, playerId,
        x: Number(op.x.toFixed(2)), y: Number(op.y.toFixed(2)),
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Turning point plumbing                                              */
/* ------------------------------------------------------------------ */

function beginTurningPoint(state, rng) {
  state.turningPoint++;
  state.phase = PHASES.STRATEGY;
  logEvent(state, EVENTS.TURN_STARTED, { turningPoint: state.turningPoint });

  for (const playerId of ['p1', 'p2']) {
    state.players[playerId].cp += CP_PER_TURNING_POINT;
    logEvent(state, EVENTS.CP_GAINED, {
      playerId, amount: CP_PER_TURNING_POINT, total: state.players[playerId].cp,
    });
  }

  for (const op of allOperatives(state)) {
    op.ready = op.alive && op.placed;
    op.activatedThisTurningPoint = false;
    resetActivationFlags(op);
    op.counteracted = false;
  }

  // Initiative: roll off, re-roll ties. Winner chooses to go first.
  let a, b;
  do { a = rng.d6(); b = rng.d6(); } while (a === b);
  const winner = a > b ? 'p1' : 'p2';
  state.initiativePlayerId = winner;
  state.firstPlayerId = winner;
  state.activePlayerId = winner;
  logEvent(state, EVENTS.INITIATIVE_ROLLED, {
    rolls: { p1: a, p2: b }, winner, turningPoint: state.turningPoint,
  });

  // Ready step: faction rules that recur each turning point resolve here.
  fireTurningPointStart(state, rng, liveOperatives(state));

  state.killsThisTurn = { p1: 0, p2: 0 };
  state.phase = PHASES.FIREFIGHT;
}

/**
 * Per-activation bookkeeping. Heavy pins an operative only for the activation
 * in which it fired, and the Stun flag is remembered here so the activation
 * that pays for it is also the one that clears it.
 */
function resetActivationFlags(op) {
  op.usedThisActivation = [];
  op.heavyUsed = false;
  op.heavyMoveAllowed = null;
  op.stunnedAtActivationStart = op.stunned === true;
}

function startActivation(state, op) {
  resetActivationFlags(op);
  op.apRemaining = effectiveApl(op);
  fireActivationStart(state, op);
  op.ready = false;
  op.activatedThisTurningPoint = true;
  logEvent(state, EVENTS.OPERATIVE_ACTIVATED, {
    operativeId: op.id, operativeName: op.name, playerId: op.playerId,
    ap: op.apRemaining, order: op.order,
    stunned: op.stunned === true,
    woundsRemaining: op.woundsRemaining, wounds: op.wounds,
  });
}

function endActivation(state, op) {
  logEvent(state, EVENTS.ACTIVATION_ENDED, {
    operativeId: op.id, operativeName: op.name, playerId: op.playerId,
    apUnspent: op.apRemaining,
  });
  op.apRemaining = 0;
  // Stun lasts "until the end of its next activation" — this was it.
  if (op.stunnedAtActivationStart) {
    op.stunned = false;
    op.stunnedAtActivationStart = false;
  }
}

/** Credit kills to the player who inflicted them, for this turning point. */
function tallyKills(state, fromSeq) {
  for (let i = fromSeq; i < state.eventLog.length; i++) {
    const e = state.eventLog[i];
    if (e.type === EVENTS.OPERATIVE_INCAPACITATED) {
      const killer = opponentOf(e.playerId);
      state.killsThisTurn[killer] = (state.killsThisTurn[killer] || 0) + 1;
    }
  }
}

/**
 * Run one operative's whole activation, driven by its controller.
 * The controller only proposes intent; every action is validated here (#3).
 */
function runActivation(state, op, controller) {
  const seqBefore = state.eventLog.length;
  startActivation(state, op);

  const intent = controller.planActivation(state, op.id);
  if (intent?.rationale?.length) {
    logEvent(state, EVENTS.AI_PLAN, {
      operativeId: op.id, operativeName: op.name, playerId: op.playerId,
      rationale: intent.rationale,
      considered: intent.considered ?? null,
      score: intent.score ?? null,
    });
  }

  const actions = intent?.actions || [];
  for (const action of actions) {
    if (!op.alive) break;
    if (op.apRemaining <= 0 && (action.type !== 'change_order')) break;
    const result = resolveAction(state, { ...action, operativeId: op.id });
    if (!result.ok) {
      logEvent(state, EVENTS.WARNING, {
        ruleId: 'illegal-action-rejected',
        message: `Rejected ${action.type} for ${op.name}: ${result.reason}`,
        operativeId: op.id,
      });
    }
  }

  endActivation(state, op);
  tallyKills(state, seqBefore);
}

/**
 * Counteract: a player with no ready operatives may still make one 1-AP
 * action with an already-activated operative, once per turning point.
 */
function tryCounteract(state, playerId, controller) {
  const candidates = liveOperatives(state, playerId).filter((o) => !o.counteracted);
  if (!candidates.length) return false;

  for (const op of candidates) {
    op.apRemaining = 1;
    // A counteraction is not an activation, so Stun is not spent by it — but
    // Heavy applies to "an activation or counteraction", so those flags reset.
    op.usedThisActivation = [];
    op.heavyUsed = false;
    op.heavyMoveAllowed = null;
    fireActivationStart(state, op);
    const legal = getLegalActions(state, op.id).filter((a) => a.type !== 'pass');
    if (!legal.length) { op.apRemaining = 0; continue; }

    const intent = controller.planActivation(state, op.id, { counteract: true });
    const action = (intent?.actions || []).find((a) => a.type !== 'pass' && a.type !== 'change_order');
    if (!action) { op.apRemaining = 0; continue; }

    logEvent(state, EVENTS.OPERATIVE_ACTIVATED, {
      operativeId: op.id, operativeName: op.name, playerId,
      counteract: true, ap: 1, order: op.order,
    });
    const seqBefore = state.eventLog.length;
    const result = resolveAction(state, { ...action, operativeId: op.id });
    op.counteracted = true;
    op.apRemaining = 0;
    tallyKills(state, seqBefore);
    return result.ok;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Public stepping API                                                 */
/* ------------------------------------------------------------------ */

/**
 * Advance the battle by one step.
 * @returns {{done:boolean, kind:string, description:string, fromSeq:number}}
 */
export function step(state, controllers) {
  const fromSeq = state.eventLog.length;
  const rng = Rng.fromState(state.rng);
  const finish = (kind, description) => {
    state.rng = rng.getState();
    return { done: state.phase === PHASES.COMPLETE, kind, description, fromSeq };
  };

  if (state.phase === PHASES.COMPLETE) {
    return { done: true, kind: 'complete', description: 'Battle already finished.', fromSeq };
  }

  if (state.phase === PHASES.SETUP) {
    logEvent(state, EVENTS.BATTLE_STARTED, {
      seed: state.seed, mapId: state.map.id, missionId: state.mission.id,
      teams: { p1: state.players.p1.teamName, p2: state.players.p2.teamName },
    });
    deployTeam(state, 'p1', rng);
    deployTeam(state, 'p2', rng);
    updateObjectiveControl(state);
    beginTurningPoint(state, rng);
    return finish('deploy', 'Both teams deploy.');
  }

  if (state.phase === PHASES.FIREFIGHT) {
    const active = state.activePlayerId;
    const other = opponentOf(active);
    const mine = readyOperatives(state, active);
    const theirs = readyOperatives(state, other);

    if (!mine.length && !theirs.length) {
      state.phase = PHASES.SCORE;
      return finish('firefight-end', `Turning Point ${state.turningPoint}: all operatives activated.`);
    }

    if (!mine.length) {
      const did = tryCounteract(state, active, controllers[active]);
      state.activePlayerId = other;
      state.rng = rng.getState();
      return {
        done: false, kind: 'counteract', fromSeq,
        description: did
          ? `${state.players[active].teamName} counteracts.`
          : `${state.players[active].teamName} has no ready operatives.`,
      };
    }

    const controller = controllers[active];
    const chosen = controller.chooseActivation(state, mine.map((o) => o.id));
    const op = state.operatives[chosen] || mine[0];
    state.rng = rng.getState();
    runActivation(state, op, controller);
    state.activePlayerId = readyOperatives(state, other).length ? other : active;
    return { done: false, kind: 'activation', fromSeq, description: `${op.name} activates.` };
  }

  if (state.phase === PHASES.SCORE) {
    scoreTurningPoint(state, state.killsThisTurn || { p1: 0, p2: 0 });
    logEvent(state, EVENTS.TURN_ENDED, {
      turningPoint: state.turningPoint,
      vp: { p1: state.players.p1.victoryPoints, p2: state.players.p2.victoryPoints },
    });

    const wiped = ['p1', 'p2'].filter((p) => liveOperatives(state, p).length === 0);
    const lastTurn = state.turningPoint >= MAX_TURNING_POINTS;

    if (wiped.length || lastTurn) {
      scoreEndOfBattle(state);
      state.phase = PHASES.COMPLETE;
      state.result = buildResult(state, wiped);
      logEvent(state, EVENTS.GAME_ENDED, state.result);
      state.rng = rng.getState();
      return { done: true, kind: 'game-end', fromSeq, description: state.result.summary };
    }

    beginTurningPoint(state, rng);
    return finish('turn', `Turning Point ${state.turningPoint} begins.`);
  }

  return finish('noop', 'Nothing to do.');
}

function buildResult(state, wiped) {
  const p1 = state.players.p1;
  const p2 = state.players.p2;
  let winner = null;
  if (p1.victoryPoints > p2.victoryPoints) winner = 'p1';
  else if (p2.victoryPoints > p1.victoryPoints) winner = 'p2';

  const survivors = {
    p1: liveOperatives(state, 'p1').length,
    p2: liveOperatives(state, 'p2').length,
  };
  // VP ties break on surviving operatives; still tied means a draw.
  if (!winner) {
    if (survivors.p1 > survivors.p2) winner = 'p1';
    else if (survivors.p2 > survivors.p1) winner = 'p2';
  }

  const summary = winner
    ? `${state.players[winner].teamName} wins ${p1.victoryPoints}–${p2.victoryPoints}.`
    : `Draw ${p1.victoryPoints}–${p2.victoryPoints}.`;

  return {
    winner, summary, wiped,
    victoryPoints: { p1: p1.victoryPoints, p2: p2.victoryPoints },
    vpBreakdown: { p1: p1.vpBreakdown, p2: p2.vpBreakdown },
    survivors,
    turningPoints: state.turningPoint,
    seed: state.seed,
  };
}

/** Run to completion (instant mode / batch harness). */
export function runToCompletion(state, controllers, maxSteps = 2000) {
  let steps = 0;
  while (state.phase !== PHASES.COMPLETE && steps++ < maxSteps) {
    step(state, controllers);
  }
  if (steps >= maxSteps) {
    logEvent(state, EVENTS.WARNING, {
      ruleId: 'step-limit', message: 'Battle aborted: step limit reached.',
    });
  }
  return state;
}
