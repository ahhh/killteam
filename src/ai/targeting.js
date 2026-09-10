/**
 * Target selection — evaluated from a hypothetical position so the AI can
 * compare "shoot from here" against "move there, then shoot".
 */
import { baseDistance } from '../maps/geometry.js';
import { canBeTargeted, withinControlRange, QUICK_SAMPLES } from '../rules/visibility.js';
import { expectedDamage, killPressure, threatValue } from './utility.js';
import { rangedWeapons } from '../rules/shooting.js';
import {
  heavyShootBlocker, heavyAllowedMove, limitedExhausted, isSilent, seekMode,
  blastRadius, torrentRadius,
} from '../rules/weapon-rules.js';
import { liveOperatives } from '../state.js';

/** Blast catches friends as readily as enemies; weight that heavily. */
const FRIENDLY_FIRE_WEIGHT = 3;

/**
 * Best ranged shot available from a hypothetical position.
 *
 * @param {string|null} options.moved the move action taken before shooting,
 *   so Heavy weapons drop out of the running for that plan.
 * @returns {{weaponId,targetId,expected,score,inCover,range,silent,heavyAllows}|null}
 */
export function bestShotFrom(state, op, position, enemies, { samples = QUICK_SAMPLES, moved = null } = {}) {
  const ghost = { ...op, x: position.x, y: position.y, order: 'engage' };

  // Cannot shoot while an enemy is within control range.
  if (enemies.some((e) => withinControlRange(ghost, e))) return null;

  const terrain = state.map.terrain || [];
  // Friendly bodies grant cover too — the engine counts them, so we must.
  const bystanders = liveOperatives(state).filter((o) => o.id !== op.id);
  const wouldHaveUsed = moved ? [...(op.usedThisActivation || []), moved] : (op.usedThisActivation || []);
  let best = null;

  for (const weapon of rangedWeapons(state, op)) {
    // Rules the engine will enforce at resolve time; don't plan around them.
    if (limitedExhausted(op, weapon)) continue;
    if (heavyShootBlocker(weapon, wouldHaveUsed)) continue;

    for (const enemy of enemies) {
      const range = baseDistance(ghost, enemy);
      if (weapon.range && range > weapon.range) continue;

      const others = bystanders.filter((o) => o.id !== enemy.id);
      const targeting = canBeTargeted(ghost, enemy, terrain, others, {
        samples, seek: seekMode(weapon),
      });
      if (!targeting.ok) continue;

      const inCover = targeting.sight.cover;
      const expected = expectedDamage(op, weapon, enemy, { inCover });
      const splash = splashEstimate(state, op, weapon, enemy, inCover);
      const score =
        expected + splash.enemy * 0.9 +
        killPressure(expected, enemy) * threatValue(state, enemy) * 0.8 -
        splash.friendly * FRIENDLY_FIRE_WEIGHT;
      if (!best || score > best.score) {
        best = {
          weaponId: weapon.id, weaponName: weapon.name, targetId: enemy.id,
          targetName: enemy.name, expected, score,
          inCover, range,
          silent: isSilent(weapon),
          heavyAllows: heavyAllowedMove(weapon),
          splash,
        };
      }
    }
  }
  return best;
}

/**
 * What else a Blast or Torrent shot would catch, in expected damage.
 *
 * Blast reaches friendly operatives; Torrent only picks valid targets, so it
 * never does. Secondary targets of a Blast inherit the primary's cover.
 */
export function splashEstimate(state, op, weapon, target, inCover) {
  const blast = blastRadius(weapon);
  const torrent = torrentRadius(weapon);
  if (blast === null && torrent === null) return { enemy: 0, friendly: 0, radius: 0 };

  const radius = blast !== null ? blast : torrent;
  let enemy = 0;
  let friendly = 0;
  for (const other of liveOperatives(state)) {
    if (other.id === op.id || other.id === target.id) continue;
    if (baseDistance(other, target) > radius) continue;
    const mine = other.playerId === op.playerId;
    if (mine && blast === null) continue;
    const damage = expectedDamage(op, weapon, other, { inCover });
    if (mine) friendly += damage + killPressure(damage, other) * 2;
    else enemy += damage;
  }
  return { enemy, friendly, radius };
}

/** Best melee target among enemies already within control range. */
export function bestMeleeTarget(state, op, enemies, meleeWeapon) {
  let best = null;
  for (const enemy of enemies) {
    if (!withinControlRange(op, enemy)) continue;
    const expected = expectedDamage(op, meleeWeapon, enemy, { inCover: false });
    // Melee is a two-way exchange; discount by what they hit back with.
    const score = expected + killPressure(expected, enemy) * threatValue(state, enemy) * 0.8;
    if (!best || score > best.score) {
      best = { targetId: enemy.id, targetName: enemy.name, expected, score };
    }
  }
  return best;
}
