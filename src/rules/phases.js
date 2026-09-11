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
  readyOperatives, opponentOf, warnUnsupported,
} from '../state.js';
import { pointInPolygon, polygonBounds, polygonCentroid } from '../maps/geometry.js';
import { isPositionLegal } from './movement.js';
import { resolveAction, getLegalActions, ACTION_COST } from './engine.js';
import { updateObjectiveControl, scoreTurningPoint, scoreEndOfBattle } from './objectives.js';
import { effectiveApl, applyDamage } from './effects.js';
import {
  resolveActivationTokens, markTokenExpiryAtActivationStart, expireTokensAtActivationEnd,
  expireTokensAtTurningPointEnd,
} from './tokens.js';
import {
  fireTurningPointStart, fireActivationStart, fireActivationEnd, hasFreeAction,
} from './hooks.js';
import { resourceReadyStep, resetSpendLimits } from './resources.js';
import {
  expirePloys, activatePloy, reportUnsupportedPloys, expireActivationPloys,
} from './ploys.js';

export const MAX_TURNING_POINTS = 4;
const CP_PER_TURNING_POINT = 1;

/**
 * How a mission decides who won.
 *
 * `victoryPoints` is the default and the published shape: four turning points,
 * then compare VP. `lastTeamStanding` is the deathmatch variant — no scoring
 * worth the name, no fixed clock, and the battle runs until one side has
 * nobody left. It still carries a cap so two gunlines that cannot see each
 * other cannot run forever.
 */
export function victoryCondition(state) {
  return state.mission.victory?.type ?? 'victoryPoints';
}

export function isLastTeamStanding(state) {
  return victoryCondition(state) === 'lastTeamStanding';
}

/** The last turning point this mission will play. */
export function turningPointLimit(state) {
  if (isLastTeamStanding(state)) {
    return state.mission.victory?.turningPointCap ?? 12;
  }
  return state.mission.turningPoints ?? MAX_TURNING_POINTS;
}

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
    } else {
      // A tight map and a large base can leave nowhere legal to stand. That
      // silently costs a player an operative, so it is reported rather than
      // shrugged off — usually it means the map's corridors are narrower than
      // the widest base in the team.
      warnUnsupported(state, 'deployment:no-legal-position',
        `${op.name} (${op.baseDiameter}" base) found no legal position in its deployment zone`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Turning point plumbing                                              */
/* ------------------------------------------------------------------ */

function beginTurningPoint(state, rng, controllers) {
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

  // Last turning point's ploys lapse before this one's are bought.
  expirePloys(state);
  planCommandPoints(state, controllers);
  buyStrategicPloys(state, controllers);

  // Ready step: faction rules that recur each turning point resolve here.
  fireTurningPointStart(state, rng, liveOperatives(state));
  // …including the team resource economies: what the turning point pays out,
  // and the STRATEGIC GAMBIT that assigns a pooled resource to operatives.
  expireTokensAtTurningPointEnd(state, liveOperatives(state));
  resourceReadyStep(state);

  state.killsThisTurn = { p1: 0, p2: 0 };
  state.phase = PHASES.FIREFIGHT;
}

/**
 * The strategy phase: each player converts CP into rules for this turning
 * point. The initiative winner buys first, which is the printed order and the
 * one that matters — it knows it is activating first when it decides.
 *
 * The AI only proposes; `activatePloy` re-checks cost and legality (#3), and a
 * rejected pick is logged rather than silently dropped, because unlike an
 * optional resource spend there is nothing conditional about a ploy purchase.
 */
/**
 * Before anything is bought: what each player intends to do with its CP this
 * turning point.
 *
 * The plan is DATA on the player — a doctrine name, a reserve, a trigger — and
 * it is what lets the CP economy be a strategy rather than a reflex. The
 * reserve keeps CP back from the strategy phase so an operative can pay for a
 * firefight ploy mid-fight, and `rules/ploys.js` reads the same block when it
 * decides whether to react to an attack. A controller that offers no plan
 * (an old replay, a scripted test) simply has none, and every reserve is zero.
 */
function planCommandPoints(state, controllers) {
  for (const playerId of ['p1', 'p2']) {
    const plan = controllers?.[playerId]?.planCommandPoints?.(state, playerId) || null;
    state.players[playerId].cpPlan = plan;
    if (!plan) continue;
    logEvent(state, EVENTS.CP_PLAN, {
      playerId, turningPoint: state.turningPoint,
      doctrine: plan.doctrine, label: plan.label,
      reserve: plan.reserve, cp: state.players[playerId].cp,
      rationale: plan.rationale,
    });
  }
}

function buyStrategicPloys(state, controllers) {
  const order = [state.initiativePlayerId, opponentOf(state.initiativePlayerId)];
  for (const playerId of order) {
    const picks = controllers?.[playerId]?.chooseStrategicPloys?.(state, playerId) || [];
    for (const pick of picks) {
      const result = activatePloy(state, playerId, pick.ployId);
      if (!result.ok) {
        logEvent(state, EVENTS.WARNING, {
          ruleId: 'illegal-ploy-rejected',
          message: `Rejected ploy ${pick.ployId} for ${state.players[playerId].teamName}: ${result.reason}`,
          playerId,
        });
      }
    }
  }
}

/**
 * Per-activation bookkeeping. Heavy pins an operative only for the activation
 * in which it fired, and the Stun flag is remembered here so the activation
 * that pays for it is also the one that clears it.
 */
function resetActivationFlags(op) {
  op.usedThisActivation = [];
  resetSpendLimits(op);
  op.heavyUsed = false;
  op.heavyMoveAllowed = null;
  op.distanceMovedThisActivation = 0;
  op.moveLimitThisActivation = null;
  op.moveLimitRule = null;
  op.aplPenaltyThisActivation = 0;
  op.inCounteraction = false;
  op.stunnedAtActivationStart = op.stunned === true;
}

function startActivation(state, op, rng) {
  resetActivationFlags(op);
  // "…until the start of the operative's next activation": this is that
  // moment, so an APL an invigoration bought lapses here — before the new AP
  // total is worked out, and not merely because a turning point rolled over.
  op.aplBonus = 0;

  // "Whenever an operative that has one of your X tokens is activated…" — the
  // burn lands before the operative gets to do anything, and can kill it, so
  // AP is only counted afterwards.
  markTokenExpiryAtActivationStart(op);
  resolveActivationTokens(state, rng, op, applyDamage);
  if (!op.alive) {
    op.apRemaining = 0;
    return;
  }

  op.apRemaining = effectiveApl(op);
  fireActivationStart(state, op, rng);
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
  // Last call before the ploys that paid for this activation lapse: a Mandrake
  // slips back into Conceal here, which it could not do while still acting.
  fireActivationEnd(state, op);
  logEvent(state, EVENTS.ACTIVATION_ENDED, {
    operativeId: op.id, operativeName: op.name, playerId: op.playerId,
    apUnspent: op.apRemaining,
  });
  op.apRemaining = 0;
  // Stun lasts "until the end of its next activation" — this was it. Tokens
  // with the same wording (Humbling Cruelty, Mindburn) come off here too.
  if (op.stunnedAtActivationStart) {
    op.stunned = false;
    op.stunnedAtActivationStart = false;
  }
  op.aplPenaltyThisActivation = 0;
  // "During that activation" — the firefight ploys this operative's team paid
  // for now lapse, along with the allowances they bought.
  expireActivationPloys(state, op);
  op.actionDiscounts = {};
  op.moveBonusThisActivation = 0;
  op.ignoresInjured = false;
  expireTokensAtActivationEnd(state, op);
}

/**
 * Credit kills to the player who inflicted them, for this turning point.
 *
 * Not every operative that goes down was killed by the other side. A Hot
 * weapon that overheats, an Explosive one that goes off in its bearer's hands,
 * a stray Blast catching a friend — those are self-inflicted, and crediting
 * them to the opponent paid a team VP for a mistake it had nothing to do with.
 * Rare (three deaths in six hundred), but a mission that scores kills should
 * count the ones that were earned.
 *
 * A token's damage is the exception that proves it: a Poison token belongs to
 * the player that hung it there, so those deaths stay with the opponent, which
 * is where the fallback puts them.
 */
export function tallyKills(state, fromSeq) {
  for (let i = fromSeq; i < state.eventLog.length; i++) {
    const e = state.eventLog[i];
    if (e.type !== EVENTS.OPERATIVE_INCAPACITATED) continue;
    const attacker = e.source?.attackerId ? state.operatives[e.source.attackerId] : null;
    if (attacker && attacker.playerId === e.playerId) continue; // its own side did this
    const killer = attacker ? attacker.playerId : opponentOf(e.playerId);
    state.killsThisTurn[killer] = (state.killsThisTurn[killer] || 0) + 1;
  }
}

/**
 * Run one operative's whole activation, driven by its controller.
 * The controller only proposes intent; every action is validated here (#3).
 */
function runActivation(state, op, controller) {
  const seqBefore = state.eventLog.length;
  const rng = Rng.fromState(state.rng);
  startActivation(state, op, rng);
  state.rng = rng.getState();
  if (!op.alive) {
    // A token burned the last wound off it before it could act.
    tallyKills(state, seqBefore);
    return;
  }

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
    // A free action granted mid-activation — the Dash a kill just paid for —
    // outlives the AP, so an empty AP pool is not the end of the plan.
    if (op.apRemaining <= 0 && ACTION_COST[action.type] > 0 &&
        !hasFreeAction(op, action.type)) break;
    const result = resolveAction(state, { ...action, operativeId: op.id });
    if (!result.ok) {
      // A plan may carry a tail it only wants *if* a rule pays for it — the
      // free Dash Vitalised Surge grants for a kill that may not happen. That
      // is a conditional, not a mistake, so it is dropped without complaint.
      if (action.optional) continue;
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
    op.distanceMovedThisActivation = 0;
    op.moveLimitThisActivation = null;
    op.moveLimitRule = null;
    op.inCounteraction = true;
    // The printed limits are "per activation or counteraction", so a
    // counteraction gets its own allowance of invigorations.
    resetSpendLimits(op);
    // A start-of-activation hook may roll dice (a ploy that heals), so the
    // counteraction borrows the battle stream the same way an activation does.
    const rng = Rng.fromState(state.rng);
    fireActivationStart(state, op, rng);
    state.rng = rng.getState();
    const legal = getLegalActions(state, op.id).filter((a) => a.type !== 'pass');
    if (!legal.length) { op.apRemaining = 0; op.inCounteraction = false; continue; }

    const intent = controller.planActivation(state, op.id, { counteract: true });
    const proposed = intent?.actions || [];
    // A ploy and a resource spend both cost 0 AP, so neither is "the action"
    // a counteraction gets — they pay for it.
    const action = proposed.find(
      (a) => !['pass', 'change_order', 'spend', 'ploy'].includes(a.type));
    if (!action) { op.apRemaining = 0; op.inCounteraction = false; continue; }

    logEvent(state, EVENTS.OPERATIVE_ACTIVATED, {
      operativeId: op.id, operativeName: op.name, playerId,
      counteract: true, ap: 1, order: op.order,
    });
    const seqBefore = state.eventLog.length;
    // A counteraction is one action, but the invigorations that go with it are
    // not actions — Rejuvenate is legal here too.
    for (const paid of proposed.filter((a) => a.type === 'spend' || a.type === 'ploy')) {
      resolveAction(state, { ...paid, operativeId: op.id });
    }
    const result = resolveAction(state, { ...action, operativeId: op.id });
    op.counteracted = true;
    op.apRemaining = 0;
    op.inCounteraction = false;
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
    reportUnsupportedPloys(state);
    deployTeam(state, 'p1', rng);
    deployTeam(state, 'p2', rng);
    updateObjectiveControl(state);
    beginTurningPoint(state, rng, controllers);
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
      // Uncapped, so a mission being tuned can see what its caps threw away.
      scored: state.lastTurningPointScoring ?? null,
      alive: { p1: liveOperatives(state, 'p1').length, p2: liveOperatives(state, 'p2').length },
    });

    const wiped = ['p1', 'p2'].filter((p) => liveOperatives(state, p).length === 0);
    const lastTurn = state.turningPoint >= turningPointLimit(state);

    if (wiped.length || lastTurn) {
      scoreEndOfBattle(state);
      state.phase = PHASES.COMPLETE;
      state.result = buildResult(state, wiped);
      logEvent(state, EVENTS.GAME_ENDED, state.result);
      state.rng = rng.getState();
      return { done: true, kind: 'game-end', fromSeq, description: state.result.summary };
    }

    beginTurningPoint(state, rng, controllers);
    return finish('turn', `Turning Point ${state.turningPoint} begins.`);
  }

  return finish('noop', 'Nothing to do.');
}

function buildResult(state, wiped) {
  const p1 = state.players.p1;
  const p2 = state.players.p2;
  const survivors = {
    p1: liveOperatives(state, 'p1').length,
    p2: liveOperatives(state, 'p2').length,
  };
  const shared = {
    wiped,
    victoryPoints: { p1: p1.victoryPoints, p2: p2.victoryPoints },
    vpBreakdown: { p1: p1.vpBreakdown, p2: p2.vpBreakdown },
    survivors,
    turningPoints: state.turningPoint,
    victory: victoryCondition(state),
    seed: state.seed,
  };

  if (isLastTeamStanding(state)) return { ...shared, ...lastTeamStandingResult(state, survivors) };

  let winner = null;
  if (p1.victoryPoints > p2.victoryPoints) winner = 'p1';
  else if (p2.victoryPoints > p1.victoryPoints) winner = 'p2';

  // VP ties break on surviving operatives; still tied means a draw.
  if (!winner) {
    if (survivors.p1 > survivors.p2) winner = 'p1';
    else if (survivors.p2 > survivors.p1) winner = 'p2';
  }

  const summary = winner
    ? `${state.players[winner].teamName} wins ${p1.victoryPoints}–${p2.victoryPoints}.`
    : `Draw ${p1.victoryPoints}–${p2.victoryPoints}.`;

  return { ...shared, winner, summary };
}

/**
 * Deathmatch: the side with anybody left wins outright.
 *
 * If the cap is reached with both teams still on the board nobody has won by
 * the mission's own terms, so it is called on who is left standing — operatives
 * first, then total wounds remaining, which is the closest thing to "who was
 * winning". A dead heat on both is an honest draw.
 */
function lastTeamStandingResult(state, survivors) {
  const woundsLeft = {
    p1: liveOperatives(state, 'p1').reduce((sum, o) => sum + o.woundsRemaining, 0),
    p2: liveOperatives(state, 'p2').reduce((sum, o) => sum + o.woundsRemaining, 0),
  };

  if (survivors.p1 === 0 && survivors.p2 === 0) {
    return { winner: null, summary: 'Mutual annihilation — both kill teams are wiped out.', woundsLeft };
  }
  if (survivors.p2 === 0) {
    return {
      winner: 'p1', woundsLeft,
      summary: `${state.players.p1.teamName} wipes out ${state.players.p2.teamName}, ` +
        `${survivors.p1} operative(s) left standing.`,
    };
  }
  if (survivors.p1 === 0) {
    return {
      winner: 'p2', woundsLeft,
      summary: `${state.players.p2.teamName} wipes out ${state.players.p1.teamName}, ` +
        `${survivors.p2} operative(s) left standing.`,
    };
  }

  let winner = null;
  if (survivors.p1 !== survivors.p2) winner = survivors.p1 > survivors.p2 ? 'p1' : 'p2';
  else if (woundsLeft.p1 !== woundsLeft.p2) winner = woundsLeft.p1 > woundsLeft.p2 ? 'p1' : 'p2';

  const tally = `${survivors.p1}–${survivors.p2} operatives, ${woundsLeft.p1}–${woundsLeft.p2} wounds`;
  return {
    winner, woundsLeft, cappedOut: true,
    summary: winner
      ? `Neither team was wiped out by Turning Point ${state.turningPoint}; ` +
        `${state.players[winner].teamName} is left in the better shape (${tally}).`
      : `Neither team was wiped out by Turning Point ${state.turningPoint}, and they end level (${tally}).`,
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
