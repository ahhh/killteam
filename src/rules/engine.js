/**
 * The action layer: what an operative may legally do, and how it resolves.
 *
 * The resolver rejects illegal actions even when the AI asks for them (#3).
 * Nothing here reads the DOM (#1).
 */
import { Rng } from '../rng.js';
import {
  EVENTS, logEvent, liveOperatives, ORDERS, warnUnsupported,
} from '../state.js';
import { baseDistance } from '../maps/geometry.js';
import {
  planMove, nearestLegalPosition, DASH_DISTANCE, CHARGE_BONUS,
} from './movement.js';
import {
  withinControlRange, enemiesInControlRange, canBeTargeted,
} from './visibility.js';
import { canShoot, resolveShoot, usableRangedWeapons, meleeWeapons } from './shooting.js';
import { heavyMoveBlocker } from './weapon-rules.js';
import { canFight, resolveFight } from './fighting.js';
import { effectiveApl } from './effects.js';
import { updateObjectiveControl } from './objectives.js';
import { timesAllowed, claimExtraAction, consumeFreeAction, chargeIgnoresOrder } from './hooks.js';

export const ENGINE_VERSION = '0.1.0';

/** Action costs in AP. */
export const ACTION_COST = {
  reposition: 1,
  dash: 1,
  charge: 1,
  fall_back: 1,
  shoot: 1,
  fight: 1,
  pass: 0,
  change_order: 0,
};

/** Actions an operative may only perform once per activation. */
const ONCE_PER_ACTIVATION = new Set([
  'reposition', 'dash', 'charge', 'fall_back', 'shoot', 'fight',
]);

/**
 * Once per activation — unless a faction rule grants extra uses (Astartes lets
 * an operative Shoot or Fight twice, for instance).
 */
function alreadyUsed(state, op, type) {
  if (!ONCE_PER_ACTIVATION.has(type)) return false;
  const used = op.usedThisActivation.filter((t) => t === type).length;
  return used >= timesAllowed(state, op, type);
}

/**
 * Movement allowance for a movement action, in inches.
 */
export function moveAllowance(state, op, type) {
  switch (type) {
    case 'reposition': return op.move;
    case 'dash': return DASH_DISTANCE;
    case 'charge': return op.move + CHARGE_BONUS;
    case 'fall_back': return op.move;
    default: return 0;
  }
}

/**
 * Enumerate legal action *types* with the constraints the AI needs to plan.
 * Destinations are the AI's job to propose; legality is re-checked on resolve.
 */
export function getLegalActions(state, operativeId) {
  const op = state.operatives[operativeId];
  const actions = [];
  if (!op || !op.alive || !op.placed) return actions;
  if (op.apRemaining <= 0 && !(op.freeActions || []).length) {
    return [{ type: 'pass', cost: 0 }];
  }

  const all = liveOperatives(state);
  const engaged = enemiesInControlRange(op, all);
  const isEngaged = engaged.length > 0;
  const fellBack = op.usedThisActivation.includes('fall_back');

  // --- Movement -----------------------------------------------------
  // Heavy also runs the other way: having fired one pins the operative.
  const mayMove = (type) => !heavyMoveBlocker(op, type);

  if (!isEngaged && mayMove('reposition') && !alreadyUsed(state, op, 'reposition')) {
    actions.push({ type: 'reposition', cost: 1, allowance: moveAllowance(state, op, 'reposition') });
  }
  if (!isEngaged && mayMove('dash') && !alreadyUsed(state, op, 'dash')) {
    actions.push({ type: 'dash', cost: 1, allowance: DASH_DISTANCE });
  }
  if (isEngaged && mayMove('fall_back') && !alreadyUsed(state, op, 'fall_back')) {
    actions.push({ type: 'fall_back', cost: 1, allowance: moveAllowance(state, op, 'fall_back') });
  }
  const mayCharge = op.order === ORDERS.ENGAGE || chargeIgnoresOrder(op);
  if (!isEngaged && !fellBack && mayCharge && mayMove('charge') && !alreadyUsed(state, op, 'charge')) {
    const allowance = moveAllowance(state, op, 'charge');
    const reachable = all.filter(
      (e) => e.playerId !== op.playerId && baseDistance(op, e) <= allowance + 1
    );
    if (reachable.length) {
      actions.push({
        type: 'charge', cost: 1, allowance,
        targets: reachable.map((e) => e.id),
      });
    }
  }

  // --- Shooting -----------------------------------------------------
  // No blanket order check: `canShoot` decides per weapon, because Silent
  // weapons may be fired from Conceal and Heavy ones may be pinned by a move.
  if (!isEngaged && !fellBack && !alreadyUsed(state, op, 'shoot')) {
    for (const weapon of usableRangedWeapons(state, op)) {
      const targets = [];
      for (const enemy of all) {
        if (enemy.playerId === op.playerId) continue;
        const check = canShoot(state, op.id, enemy.id, weapon);
        if (check.ok) {
          targets.push({ targetId: enemy.id, range: check.range, inCover: check.sight.cover });
        }
      }
      if (targets.length) {
        actions.push({ type: 'shoot', cost: 1, weaponId: weapon.id, weaponName: weapon.name, targets });
      }
    }
  }

  // --- Fighting -----------------------------------------------------
  if (isEngaged && !fellBack && !alreadyUsed(state, op, 'fight') && meleeWeapons(state, op).length) {
    const targets = engaged
      .filter((e) => canFight(state, op.id, e.id).ok)
      .map((e) => ({ targetId: e.id }));
    if (targets.length) {
      actions.push({ type: 'fight', cost: 1, weaponId: meleeWeapons(state, op)[0].id, targets });
    }
  }

  actions.push({ type: 'pass', cost: 0 });
  return actions
    .map((a) => ((op.freeActions || []).includes(a.type) && a.cost > op.apRemaining)
      ? { ...a, cost: 0, free: true } : a)
    .filter((a) => a.cost <= op.apRemaining);
}

/**
 * Resolve one action. Returns {ok, reason?, ...detail}.
 * Every rejection is a bug in the caller, not in the player's input.
 */
export function resolveAction(state, action) {
  const op = state.operatives[action.operativeId];
  if (!op) return { ok: false, reason: 'unknown operative' };
  if (!op.alive) return { ok: false, reason: 'operative is incapacitated' };

  const listedCost = ACTION_COST[action.type];
  if (listedCost === undefined) {
    warnUnsupported(state, `action:${action.type}`, 'requested by AI');
    return { ok: false, reason: `unknown action "${action.type}"` };
  }
  // A granted free action is only worth spending when AP would otherwise stop
  // it, so check affordability first and fall back to the grant.
  const free = listedCost > op.apRemaining && (op.freeActions || []).includes(action.type);
  const cost = free ? 0 : listedCost;
  if (cost > op.apRemaining) {
    return { ok: false, reason: `not enough AP (${op.apRemaining} left, needs ${cost})` };
  }
  if (alreadyUsed(state, op, action.type)) {
    return { ok: false, reason: `${action.type} already performed this activation` };
  }

  let result;
  switch (action.type) {
    case 'change_order': result = doChangeOrder(state, op, action); break;
    case 'reposition':
    case 'dash':
    case 'charge':
    case 'fall_back': result = doMove(state, op, action); break;
    case 'shoot': result = doShoot(state, op, action); break;
    case 'fight': result = doFight(state, op, action); break;
    case 'pass': result = { ok: true, passed: true }; break;
    default: result = { ok: false, reason: 'unhandled action' };
  }

  if (!result.ok) return result;

  if (free) consumeFreeAction(op, action.type);
  op.apRemaining -= cost;
  if (ONCE_PER_ACTIVATION.has(action.type)) {
    op.usedThisActivation.push(action.type);
    claimExtraAction(state, op, action.type);
  }
  updateObjectiveControl(state);
  return result;
}

function doChangeOrder(state, op, action) {
  const order = action.order === ORDERS.ENGAGE ? ORDERS.ENGAGE : ORDERS.CONCEAL;
  const changed = op.order !== order;
  op.order = order;
  if (changed) {
    logEvent(state, EVENTS.ORDER_SELECTED, {
      operativeId: op.id, operativeName: op.name, playerId: op.playerId, order,
    });
  }
  return { ok: true, order };
}

function doMove(state, op, action) {
  const allowance = moveAllowance(state, op, action.type);
  const all = liveOperatives(state);
  const engagedBefore = enemiesInControlRange(op, all);

  if (action.type === 'fall_back' && engagedBefore.length === 0) {
    return { ok: false, reason: 'not engaged — use Reposition' };
  }
  if ((action.type === 'reposition' || action.type === 'dash' || action.type === 'charge') &&
      engagedBefore.length > 0) {
    return { ok: false, reason: 'within enemy control range — must Fall Back' };
  }
  if (action.type === 'charge' && op.order !== ORDERS.ENGAGE && !chargeIgnoresOrder(op)) {
    return { ok: false, reason: 'Charge requires Engage order' };
  }
  const pinned = heavyMoveBlocker(op, action.type);
  if (pinned) return { ok: false, reason: pinned };

  let dest = { x: action.destination.x, y: action.destination.y };
  let plan = planMove(state, op.id, dest.x, dest.y, allowance);
  if (!plan.ok) {
    const snapped = nearestLegalPosition(state, op.id, dest.x, dest.y);
    if (snapped) {
      const retry = planMove(state, op.id, snapped.x, snapped.y, allowance);
      if (retry.ok) { dest = snapped; plan = retry; }
    }
  }
  if (!plan.ok) return { ok: false, reason: plan.reason };

  const from = { x: op.x, y: op.y };
  op.x = dest.x;
  op.y = dest.y;

  // Post-move legality that depends on the destination.
  if (action.type === 'charge') {
    const target = action.targetId ? state.operatives[action.targetId] : null;
    const nowEngaged = target
      ? withinControlRange(op, target)
      : enemiesInControlRange(op, liveOperatives(state)).length > 0;
    if (!nowEngaged) {
      op.x = from.x; op.y = from.y;
      return { ok: false, reason: 'Charge must end within control range of the target' };
    }
  }
  if (action.type === 'fall_back') {
    if (enemiesInControlRange(op, liveOperatives(state)).length > 0) {
      op.x = from.x; op.y = from.y;
      return { ok: false, reason: 'Fall Back must end outside enemy control range' };
    }
  }

  logEvent(state, EVENTS.MOVE_RESOLVED, {
    operativeId: op.id, operativeName: op.name, playerId: op.playerId,
    action: action.type,
    from, to: { x: op.x, y: op.y },
    path: plan.path,
    distance: Number(plan.length.toFixed(2)),
    allowance,
  });

  return { ok: true, distance: plan.length, path: plan.path };
}

function doShoot(state, op, action) {
  const result = resolveShoot(state, op.id, action.targetId, action.weaponId);
  return result;
}

function doFight(state, op, action) {
  return resolveFight(state, op.id, action.targetId, action.weaponId);
}
