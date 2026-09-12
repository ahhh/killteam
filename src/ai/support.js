/**
 * What an operative's own printed action is worth, and what Guard is worth.
 *
 * These are the two things the plan builder had no opinion about, and between
 * them they were most of the AP the AI threw away: a Medikit-carrier with a
 * bleeding squadmate two inches away would Dash instead, because Dash was the
 * only thing on the menu that had a number attached.
 *
 * Everything here is priced in **expected wounds**, the same unit
 * `expectedDamage` returns, so a support plan can be ranked against a shooting
 * plan by the existing `w.damage` weight rather than a parallel scale nobody
 * can calibrate. A heal really is worth its wounds; the softer effects are
 * pinned to what they buy the operative that receives them.
 */
import { baseDistance } from '../maps/geometry.js';
import { liveOperatives } from '../state.js';
import {
  availableUniqueActions, uniqueActionsOf, uniqueActionTargets, uniqueActionBlocker,
} from '../rules/unique-actions.js';
import { guardBlocker } from '../rules/guard.js';
import { canShoot, usableRangedWeapons, meleeWeapons } from '../rules/shooting.js';
import { effectiveMove, isInjured } from '../rules/effects.js';
import { withinControlRange } from '../rules/visibility.js';
import { expectedDamage, threatValue } from './utility.js';

/**
 * A point of AP in the hands of a given operative, in expected wounds.
 *
 * Anchored on what that operative's best weapon does with a Shoot action,
 * because that is what the extra point will most often buy. Floored so that
 * handing AP to a support operative is still worth something — it buys another
 * heal, or a marker held.
 */
function apValue(state, op) {
  return Math.max(0.6, threatValue(state, op) * 0.45);
}

/** An operative worth spending a support action on: injured, and dangerous. */
function patientValue(state, target) {
  return apValue(state, target) / 1.2;
}

/**
 * What this unique action, on this target, is worth right now.
 *
 * An effect the engine can't price returns 0.25 rather than 0: performing it
 * is still better than letting the AP evaporate, but it will lose to anything
 * with a real number behind it.
 */
export function uniqueActionValue(state, op, entry, target) {
  const effect = entry.def.effect || {};
  switch (effect.type) {
    case 'healWounds': {
      const lost = target.wounds - target.woundsRemaining;
      if (lost <= 0) return 0;
      // 2D3 averages 4; the heal is capped by what was actually lost, and a
      // wound put back on something dangerous is worth more than on a drone.
      const dice = /^(\d*)D(\d+)/i.exec(String(effect.dice || '2D3'));
      const average = dice
        ? (Number(dice[1] || 1) * (Number(dice[2]) + 1)) / 2
        : 4;
      const healed = Math.min(lost, average);
      // Pulling somebody back out of Injured is worth more than the wounds:
      // it hands back the APL and the hit modifier too.
      const unInjures = isInjured(target) &&
        target.woundsRemaining + healed > Math.floor(target.wounds / 2);
      return healed * 0.55 + (unInjures ? apValue(state, target) : 0);
    }

    case 'addApl':
      // A point of AP for somebody who has not activated yet. One that has
      // already been spent this turning point gets it next turning point,
      // which is worth having but worth less.
      return apValue(state, target) * (target.ready ? 1 : 0.45);

    case 'subtractApl':
      return apValue(state, target) * (target.ready ? 0.8 : 0.3);

    case 'mark': {
      // Worth what it buys the friends who can actually shoot the thing.
      const shooters = liveOperatives(state, op.playerId).filter((friend) => {
        if (friend.id === op.id) return false;
        return usableRangedWeapons(state, friend)
          .some((w) => canShoot(state, friend.id, target.id, w).ok);
      });
      if (!shooters.length) {
        // Nobody can see it yet — but a mark that lasts the turning point is
        // placed for the friends who are about to arrive, not only the ones
        // already in position.
        return 0.4;
      }
      return Math.min(1.6, 0.5 * shooters.length);
    }

    case 'freeAction':
    case 'extraAction': {
      // The whole point is that somebody else gets an action out of it.
      const given = effect.action === 'shoot' || effect.action === 'fight'
        ? apValue(state, target)
        : apValue(state, target) * 0.5;
      return target.id === op.id ? given * 0.8 : given;
    }

    case 'inflictDamage': {
      const dice = /^(\d*)D(\d+)\s*(?:\+\s*(\d+))?/i.exec(String(effect.dice || 'D3'));
      const average = dice
        ? (Number(dice[1] || 1) * (Number(dice[2]) + 1)) / 2 + Number(dice[3] || 0)
        : 2;
      return Math.min(average, target.woundsRemaining);
    }

    case 'weaponBoost':
      return 0.7 + (Number(effect.atkBonus) || 0) * 0.4;

    case 'moveBonus':
      return 0.5;

    case 'changeOrder':
      // Slipping back into Conceal where there is something to hide behind.
      return target.order === 'engage' ? 0.5 : 0.2;

    case 'gainCp':
      return (Number(effect.amount) || 1) * 0.8;

    case 'gainResource':
      return 0.6;

    default:
      return 0.25;
  }
}

/**
 * A point of AP in this operative's own hands, in expected wounds. Exported
 * because it is the yardstick a support action has to beat.
 */
export function apValueOf(state, op) {
  return apValue(state, op);
}

/**
 * The best unique action available to this operative, as `{action, value}`.
 *
 * @param {Set<string>} [exclude] ability ids already planned this activation.
 */
export function bestUniqueAction(state, op, { exclude = new Set(), from = null } = {}) {
  let best = null;
  for (const entry of availableUniqueActions(state, op, { from })) {
    if (exclude.has(entry.ability.id)) continue;
    for (const target of entry.targets) {
      const value = uniqueActionValue(state, op, entry, target);
      if (value <= 0) continue;
      if (best && value <= best.value) continue;
      best = {
        value,
        ap: entry.ap,
        name: entry.ability.name || entry.ability.id,
        targetName: target.id === op.id ? 'itself' : target.name,
        action: {
          type: 'unique', abilityId: entry.ability.id, targetId: target.id,
        },
      };
    }
  }
  return best;
}

/**
 * Somewhere worth walking to, for an operative whose action cannot reach from
 * where it stands.
 *
 * A Medikit selects a friend "within this operative's control range", which is
 * one inch of base-to-base, and a medic is almost never already standing there
 * — so the action was legal roughly never, and the medic spent four turning
 * points repositioning next to nobody. These are the operatives it would like
 * to be beside.
 *
 * @returns {Array} the candidates, as points `generateDestinations` can aim at.
 */
export function supportDestinationsFor(state, op, { exclude = new Set() } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of uniqueActionsOf(state, op)) {
    if (exclude.has(entry.ability.id)) continue;
    const scope = entry.def.target?.scope;
    // Only the short-ranged scopes: `visible` and `validTarget` reach as far
    // as the operative can see, so if they have no target now, walking three
    // inches will not find one.
    if (scope !== 'controlRange' && scope !== 'within') continue;
    if (uniqueActionBlocker(state, op, entry)) continue;
    // Who it could point at if distance were no object.
    const reachable = uniqueActionTargets(state, op, entry);
    for (const candidate of uniqueActionTargets(
      state, op, { ...entry, def: { ...entry.def, target: { ...entry.def.target, scope: 'visible' } } }
    )) {
      if (reachable.some((r) => r.id === candidate.id)) continue; // already in reach
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * The unique actions worth performing *before* the rest of the activation is
 * planned, and the AP they take off the budget.
 *
 * This is the shape resource spends already use (`openingSpends`), and it is
 * the right one: a Medikit is not an alternative to the medic's activation, it
 * is the first thing the medic does and then it gets on with the rest. Built
 * the other way — as a plan competing with shooting — a support operative
 * spends one point on its action and lets the other two evaporate, because
 * nothing downstream knows there is AP left to use.
 *
 * The test each action has to pass is the honest one: is it worth more than a
 * point of this operative's own AP? A Kommando Boss Nob's point buys a swing
 * with a power klaw, so it keeps it unless the Signal is worth more; a
 * weaponless C.A.T. unit's point buys almost nothing, so it always Spots.
 *
 * @returns {{actions:Array, rationale:string[], apCost:number}}
 */
export function openingSupport(state, op, { ap = 0 } = {}) {
  const out = { actions: [], rationale: [], apCost: 0 };
  if (ap <= 0) return out;

  const threshold = apValue(state, op);
  const planned = new Set();
  // At most two: past that an operative is doing nothing but support, and the
  // printed once-per-activation limits mean there is rarely a third anyway.
  for (let i = 0; i < 2; i++) {
    const best = bestUniqueAction(state, op, { exclude: planned });
    if (!best) break;
    if (best.ap > ap - out.apCost) break;
    // The last point is never worth giving up for a marginal gain: an
    // operative that spends everything on support has no activation left.
    if (best.value <= threshold * (i === 0 ? 1 : 1.5)) break;
    out.actions.push(best.action);
    out.rationale.push(
      `${best.name} on ${best.targetName} — worth more than the point it costs`);
    out.apCost += best.ap;
    planned.add(best.action.abilityId);
  }
  return out;
}

/**
 * What holding a shot is worth: the damage it would do, discounted by the
 * chance anything walks into it.
 *
 * A guard only ever fires if an enemy moves within reach during the opponent's
 * turn, so the estimate is the best shot it could take today against the
 * nearest enemy that could plausibly close, scaled down hard. Deliberately
 * modest: Guard should win a spare point that has nothing better to do, and
 * lose to an actual shot or an objective.
 */
export function guardValue(state, op, enemies) {
  if (guardBlocker(state, op)) return 0;
  if (!enemies.length) return 0;

  const engaged = enemies.filter((e) => withinControlRange(op, e));
  if (engaged.length) {
    const weapon = meleeWeapons(state, op)[0];
    if (!weapon) return 0;
    return Math.max(...engaged.map((e) => expectedDamage(op, weapon, e))) * 0.3;
  }

  const weapons = usableRangedWeapons(state, op);
  if (!weapons.length) return 0;

  let best = 0;
  for (const enemy of enemies) {
    // Could it get here? A Reposition plus a Dash is the usual approach.
    const closing = baseDistance(op, enemy) - effectiveMove(enemy) - 3;
    const reach = Math.max(...weapons.map((w) => w.range || 48));
    if (closing > reach) continue;
    // Something already in the lane is far more likely to be shot at than
    // something that has to cross the board to get into it.
    const likelihood = closing <= 0 ? 0.35 : 0.2;
    for (const weapon of weapons) {
      if (!canShoot(state, op.id, enemy.id, weapon).ok && closing > 0) continue;
      best = Math.max(best, expectedDamage(op, weapon, enemy) * likelihood);
    }
  }
  return best;
}
