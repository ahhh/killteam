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
import {
  canShoot, resolveShoot, usableRangedWeapons, meleeWeapons, selfDirectedWeapon,
} from './shooting.js';
import { heavyMoveBlocker } from './weapon-rules.js';
import { canFight, resolveFight, resolveSweep } from './fighting.js';
import { effectiveApl, effectiveMove } from './effects.js';
import { moveLimitBlocker, moveLimitAfterUse } from './team-rules.js';
import { updateObjectiveControl } from './objectives.js';
import {
  timesAllowed, claimExtraAction, consumeFreeAction, chargeIgnoresOrder,
  hasFreeAction, freeActionIsUnrestricted, applyActivationStartHook,
} from './hooks.js';
import { playableFirefightPloys, useFirefightPloy } from './ploys.js';
import {
  availableSpends, resolveSpend, extraActionsFromSpends, resourceMoveBonus,
  consumeActionBoosts, applyPostActionResources,
} from './resources.js';

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
  // Spending a team resource — an invigoration, a SANGUAVITAE rule — is a
  // choice made "before or after it performs an action", not an action that
  // costs the operative anything (see rules/resources.js).
  spend: 0,
  // Paying CP for a firefight ploy is the same shape of choice: it is made
  // during the activation and costs AP nothing, only Command Points.
  ploy: 0,
};

/**
 * What `type` costs this operative right now.
 *
 * Normally the printed cost. A ploy or rule that reads "can perform the Fall
 * Back action for 1 less AP" is a discount held for the activation, which is
 * why the cost is asked for rather than looked up.
 */
export function actionCost(state, op, type) {
  const listed = ACTION_COST[type];
  if (listed === undefined) return undefined;
  return Math.max(0, listed - (Number(op?.actionDiscounts?.[type]) || 0));
}

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
  // Vitalised Surge's Dash is printed as usable "even if it's performed an
  // action that prevents it from performing the Dash action", so an
  // unrestricted grant answers this question before the tally does.
  if (freeActionIsUnrestricted(op, type)) return false;
  const used = op.usedThisActivation.filter((t) => t === type).length;
  return used >= timesAllowed(state, op, type) + extraActionsFromSpends(op, type);
}

/**
 * Movement allowance for a movement action, in inches.
 */
export function moveAllowance(state, op, type) {
  // Surge buys an inch of Move for the move action it was spent on.
  const move = effectiveMove(op) + resourceMoveBonus(op, type);
  switch (type) {
    case 'reposition': return move;
    case 'dash': return DASH_DISTANCE;
    case 'charge': return move + CHARGE_BONUS;
    case 'fall_back': return move;
    default: return 0;
  }
}

/**
 * The allowance an operative may actually spend on `type` right now.
 *
 * Aimed leaves a budget for the whole activation rather than forbidding the
 * action outright, so a Dragon Master that fired its stationary profile may
 * still shuffle the remainder of 3".
 */
export function usableMoveAllowance(state, op, type) {
  const allowance = moveAllowance(state, op, type);
  const limit = moveLimitAfterUse(op);
  if (limit === null) return allowance;
  return Math.max(0, Math.min(allowance, limit - (op.distanceMovedThisActivation || 0)));
}

/**
 * Enumerate legal action *types* with the constraints the AI needs to plan.
 * Destinations are the AI's job to propose; legality is re-checked on resolve.
 */
export function getLegalActions(state, operativeId) {
  const op = state.operatives[operativeId];
  const actions = [];
  if (!op || !op.alive || !op.placed) return actions;

  // Resource spends cost no AP and are legal "before or after" an action, so
  // they are on the menu even for an operative with nothing left to spend —
  // Rejuvenate after the last shot is a perfectly good use of a GORE TANK.
  for (const option of availableSpends(state, op, { window: 'activation' })) {
    actions.push({
      type: 'spend', cost: 0, resource: option.key, spendId: option.spend.id,
      spendName: option.spend.name || option.spend.id,
    });
  }

  // Firefight ploys are on the menu for the same reason resource spends are:
  // they cost no AP, and the decision is the AI's to make.
  for (const ploy of playableFirefightPloys(state, op)) {
    actions.push({
      type: 'ploy', cost: 0, ployId: ploy.id, ployName: ploy.name, cp: ploy.cost,
    });
  }

  if (op.apRemaining <= 0 && !(op.freeActions || []).length) {
    return [...actions, { type: 'pass', cost: 0 }];
  }

  const all = liveOperatives(state);
  const engaged = enemiesInControlRange(op, all);
  const isEngaged = engaged.length > 0;
  const fellBack = op.usedThisActivation.includes('fall_back');

  // --- Movement -----------------------------------------------------
  // Heavy also runs the other way; Aimed leaves a budget rather than a veto,
  // so a move only disappears once the budget cannot pay for any of it.
  const mayMove = (type) => !heavyMoveBlocker(op, type) && usableMoveAllowance(state, op, type) > 0;

  if (!isEngaged && mayMove('reposition') && !alreadyUsed(state, op, 'reposition')) {
    actions.push({ type: 'reposition', cost: actionCost(state, op, 'reposition'), allowance: usableMoveAllowance(state, op, 'reposition') });
  }
  if (!isEngaged && mayMove('dash') && !alreadyUsed(state, op, 'dash')) {
    actions.push({ type: 'dash', cost: actionCost(state, op, 'dash'), allowance: usableMoveAllowance(state, op, 'dash') });
  }
  if (isEngaged && mayMove('fall_back') && !alreadyUsed(state, op, 'fall_back')) {
    actions.push({ type: 'fall_back', cost: actionCost(state, op, 'fall_back'), allowance: usableMoveAllowance(state, op, 'fall_back') });
  }
  const mayCharge = op.order === ORDERS.ENGAGE || chargeIgnoresOrder(op);
  if (!isEngaged && !fellBack && mayCharge && mayMove('charge') && !alreadyUsed(state, op, 'charge')) {
    const allowance = usableMoveAllowance(state, op, 'charge');
    const reachable = all.filter(
      (e) => e.playerId !== op.playerId && baseDistance(op, e) <= allowance + 1
    );
    if (reachable.length) {
      actions.push({
        type: 'charge', cost: actionCost(state, op, 'charge'), allowance,
        targets: reachable.map((e) => e.id),
      });
    }
  }

  // --- Shooting -----------------------------------------------------
  // No blanket order check: `canShoot` decides per weapon, because Silent
  // weapons may be fired from Conceal and Heavy ones may be pinned by a move.
  // Nor a blanket melee lockout: Explosive and Wreathed are meant to go off
  // with an enemy in the operative's face.
  if (!fellBack && !alreadyUsed(state, op, 'shoot')) {
    for (const weapon of usableRangedWeapons(state, op)) {
      // A self-directed weapon selects no valid target, so it offers exactly
      // one "target": the operative holding it.
      if (selfDirectedWeapon(state, op, weapon)) {
        const check = canShoot(state, op.id, op.id, weapon);
        if (check.ok) {
          actions.push({
            type: 'shoot', cost: actionCost(state, op, 'shoot'), weaponId: weapon.id, weaponName: weapon.name,
            selfDirected: true,
            targets: [{ targetId: op.id, range: 0, inCover: false }],
          });
        }
        continue;
      }
      if (isEngaged) continue;
      const targets = [];
      for (const enemy of all) {
        if (enemy.playerId === op.playerId) continue;
        const check = canShoot(state, op.id, enemy.id, weapon);
        if (check.ok) {
          targets.push({ targetId: enemy.id, range: check.range, inCover: check.sight.cover });
        }
      }
      if (targets.length) {
        actions.push({ type: 'shoot', cost: actionCost(state, op, 'shoot'), weaponId: weapon.id, weaponName: weapon.name, targets });
      }
    }
  }

  // --- Fighting -----------------------------------------------------
  if (isEngaged && !fellBack && !alreadyUsed(state, op, 'fight') && meleeWeapons(state, op).length) {
    const targets = engaged
      .filter((e) => canFight(state, op.id, e.id).ok)
      .map((e) => ({ targetId: e.id }));
    if (targets.length) {
      actions.push({ type: 'fight', cost: actionCost(state, op, 'fight'), weaponId: meleeWeapons(state, op)[0].id, targets });
    }
  }

  actions.push({ type: 'pass', cost: 0 });
  return actions
    .map((a) => (hasFreeAction(op, a.type) && a.cost > op.apRemaining)
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

  const listedCost = actionCost(state, op, action.type);
  if (listedCost === undefined) {
    warnUnsupported(state, `action:${action.type}`, 'requested by AI');
    return { ok: false, reason: `unknown action "${action.type}"` };
  }
  // A granted free action is only worth spending when AP would otherwise stop
  // it, so check affordability first and fall back to the grant.
  const free = listedCost > op.apRemaining && hasFreeAction(op, action.type);
  const cost = free ? 0 : listedCost;
  if (cost > op.apRemaining) {
    return { ok: false, reason: `not enough AP (${op.apRemaining} left, needs ${cost})` };
  }
  if (alreadyUsed(state, op, action.type)) {
    return { ok: false, reason: `${action.type} already performed this activation` };
  }

  const seqBefore = state.eventLog.length;
  let result;
  switch (action.type) {
    case 'spend': result = resolveSpend(state, op, action); break;
    case 'ploy': result = resolvePloyAction(state, op, action); break;
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
    // Rage and Surge last "until the end of that action", and the action has
    // now ended.
    consumeActionBoosts(op, action.type);
  }
  // What the action earned: Power From Pain reads the enemy it left injured,
  // Gore Tanks the operative it left dead at its feet.
  if (action.type !== 'spend' && action.type !== 'ploy') {
    applyPostActionResources(state, op, seqBefore);
  }
  updateObjectiveControl(state);
  return result;
}

/**
 * Buy a firefight ploy mid-activation. `ploys.js` re-checks the CP, the limits
 * and the timing (#3), so an AI proposing one it cannot afford is rejected
 * rather than trusted; `applyActivationStartHook` is handed over so the grants
 * the ploy brings — an extra Fight, a free Dash — land immediately.
 */
function resolvePloyAction(state, op, action) {
  // A ploy that puts wounds back rolls dice, so the battle stream comes with it.
  const rng = Rng.fromState(state.rng);
  const result = useFirefightPloy(state, op, action.ployId, {
    applyStart: (s, o, hook) => applyActivationStartHook(s, o, hook, rng),
  });
  state.rng = rng.getState();
  if (!result.ok) return result;
  return { ok: true, ploy: result.ploy.id, detail: result.ploy.name };
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
  const allowance = usableMoveAllowance(state, op, action.type);
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

  const budgeted = moveLimitBlocker(op, plan.length);
  if (budgeted) return { ok: false, reason: budgeted };

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

  op.distanceMovedThisActivation = (op.distanceMovedThisActivation || 0) + plan.length;

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
  // Concealed Position counts Shoot *actions*, not sequences, so a Blast that
  // sprayed four operatives still only spends the one shot.
  if (result.ok) op.shootActionsTaken = (op.shootActionsTaken || 0) + 1;
  return result;
}

function doFight(state, op, action) {
  const result = resolveFight(state, op.id, action.targetId, action.weaponId);
  if (!result.ok) return result;
  // Phase Sweep keeps swinging for free until every enemy in reach has been
  // fought once. It takes precedence over the once-per-activation limit, so it
  // runs inside the action rather than asking the AP layer for another one.
  if (result.repeatFight) {
    const extra = resolveSweep(state, op.id, result.attackerWeaponId, action.targetId);
    if (extra.length) result.sweep = extra;
  }
  return result;
}
