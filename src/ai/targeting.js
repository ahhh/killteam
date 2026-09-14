/**
 * Target selection — evaluated from a hypothetical position so the AI can
 * compare "shoot from here" against "move there, then shoot".
 */
import { baseDistance } from '../maps/geometry.js';
import { canBeTargeted, withinControlRange, QUICK_SAMPLES } from '../rules/visibility.js';
import { expectedDamage, killPressure, threatValue } from './utility.js';
import { rangedWeapons, selfDirectedWeapon } from '../rules/shooting.js';
import {
  heavyShootBlocker, heavyAllowedMove, limitedExhausted, isSilent, seekMode,
  blastRadius, torrentRadius,
} from '../rules/weapon-rules.js';
import { teamRuleBlocker, weaponMoveLimit } from '../rules/team-rules.js';
import { liveOperatives } from '../state.js';
import { profileOf } from '../rules/hooks.js';
import { huntBonus } from './characters.js';

/** Blast catches friends as readily as enemies; weight that heavily. */
const FRIENDLY_FIRE_WEIGHT = 3;
/** Blowing yourself up is a cost, but a cheap delivery system is the point. */
const SELF_DETONATION_COST = 0.4;

/**
 * Best ranged shot available from a hypothetical position.
 *
 * @param {string|null} options.moved the move action taken before shooting,
 *   so Heavy weapons drop out of the running for that plan.
 * @param {object|null} options.tactics per-unit tactics, so an area weapon
 *   values what it catches and a psyker values casting (see ai/tactics.js).
 * @returns {{weaponId,targetId,expected,score,inCover,range,silent,heavyAllows}|null}
 */
export function bestShotFrom(state, op, position, enemies,
  { samples = QUICK_SAMPLES, moved = null, movedDistance = 0, tactics = null } = {}) {
  // The ghost stands where the plan would end, having walked that far — Aimed
  // reads the distance, not just which action was used.
  const ghost = {
    ...op, x: position.x, y: position.y, order: 'engage',
    distanceMovedThisActivation: (op.distanceMovedThisActivation || 0) + (movedDistance || 0),
  };

  // Cannot shoot a target while an enemy is within control range — but an
  // Explosive weapon is allowed to go off in exactly that situation, so this is
  // a per-weapon question rather than an early exit.
  const engaged = enemies.some((e) => withinControlRange(ghost, e));

  const terrain = state.map.terrain || [];
  // Friendly bodies grant cover too — the engine counts them, so we must.
  const bystanders = liveOperatives(state).filter((o) => o.id !== op.id);
  const wouldHaveUsed = moved ? [...(op.usedThisActivation || []), moved] : (op.usedThisActivation || []);
  let best = null;

  for (const weapon of rangedWeapons(state, op)) {
    // Rules the engine will enforce at resolve time; don't plan around them.
    if (limitedExhausted(op, weapon)) continue;
    if (heavyShootBlocker(weapon, wouldHaveUsed)) continue;
    // Team rules that gate the weapon entirely: a spent Concealed Position
    // shot, a weapon whose enabling action the engine does not have, or an
    // Aimed profile after the operative has already walked too far.
    if (teamRuleBlocker(state, ghost, weapon, { counteraction: op.inCounteraction === true })) continue;

    // Explosive and Wreathed select no target: the bearer is the centre of the
    // blast, so the only question is what is standing around it. Without this
    // the AI could never reach for a demolition charge at all — every plan it
    // builds asks for an enemy to aim at, and these weapons have none.
    const directed = selfDirectedWeapon(state, op, weapon);
    if (directed) {
      if (directed.kind !== 'self') continue;  // fired through a friendly: not planned yet
      if (engaged && directed.def?.effect?.allowWhileEngaged !== true) continue;
      const blast = detonationShot(state, op, ghost, weapon, directed, tactics);
      if (blast && (!best || blast.score > best.score)) best = blast;
      continue;
    }
    if (engaged) continue;

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
      // A marksman picks the enemy leader out of a line of troopers; without
      // this the choice is made on expected damage, and the trooper wins it
      // because a trooper is easier to hurt. It scales the SCORE and not the
      // estimate, so the plan still claims only the damage it will do.
      const wanted = huntBonus(tactics?.hunts, profileOf(state, enemy));
      const score = (
        expected + splash.enemy * 0.9 * (tactics?.splashWeight ?? 1) +
        killPressure(expected, enemy) * threatValue(state, enemy) * 0.8 -
        splash.friendly * FRIENDLY_FIRE_WEIGHT
      ) * wanted +
        (isPsychic(weapon) ? (tactics?.spellBonus ?? 0) : 0);
      if (!best || score > best.score) {
        best = {
          weaponId: weapon.id, weaponName: weapon.name, targetId: enemy.id,
          targetName: enemy.name, expected, score,
          inCover, range,
          psychic: isPsychic(weapon),
          silent: isSilent(weapon),
          heavyAllows: heavyAllowedMove(weapon),
          // Aimed and its cousins cap any move made after this shot.
          moveLimit: weaponMoveLimit(state, op, weapon),
          splash,
        };
      }
    }
  }
  return best;
}

/** PSYCHIC weapons are the "big spell" a caster is on the board to cast. */
export function isPsychic(weapon) {
  return (weapon.rules || []).includes('psychic');
}

/**
 * A self-directed detonation from a hypothetical position.
 *
 * The bearer is the primary target and takes the hit itself, so the trade is
 * "what the blast catches" against "what we lose" — a bomb squig is a delivery
 * system, and spending it on one lone trooper is a waste of the only charge it
 * has (Explosive is always Limited).
 *
 * @returns {object|null} a shot shaped like `bestShotFrom`'s, or null when
 *   nothing worth detonating on is in reach.
 */
function detonationShot(state, op, ghost, weapon, directed, tactics) {
  // `splashEstimate` measures from the target outwards and skips the target
  // itself, so centring it on the ghost counts exactly the bystanders.
  const splash = splashEstimate(state, op, weapon, { ...op, x: ghost.x, y: ghost.y }, false);
  if (splash.enemy <= 0) return null;

  // Explosive wounds the bearer; Wreathed uses it only as the blast centre.
  const harmsBearer = directed.def?.effect?.shootSelf !== false;
  const selfDamage = harmsBearer ? expectedDamage(op, weapon, op, { inCover: false }) : 0;
  const score =
    splash.enemy * (tactics?.splashWeight ?? 1) -
    splash.friendly * FRIENDLY_FIRE_WEIGHT -
    selfDamage * SELF_DETONATION_COST;

  return {
    weaponId: weapon.id, weaponName: weapon.name,
    targetId: op.id, targetName: op.name,
    // The damage all lands as splash; keeping `expected` at zero stops the
    // caller from crediting a kill against the operative blowing itself up.
    expected: 0, score,
    inCover: false, range: 0,
    psychic: isPsychic(weapon),
    silent: isSilent(weapon),
    heavyAllows: heavyAllowedMove(weapon),
    moveLimit: weaponMoveLimit(state, op, weapon),
    selfDirected: true,
    splash,
  };
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

/**
 * Best melee target among enemies already within control range.
 *
 * `tactics` carries what this operative hunts (see `ai/characters.js`): a
 * champion in contact with a leader and a trooper at once is on the board to
 * swing at the leader, and the damage numbers alone say otherwise.
 */
export function bestMeleeTarget(state, op, enemies, meleeWeapon, tactics = null) {
  let best = null;
  for (const enemy of enemies) {
    if (!withinControlRange(op, enemy)) continue;
    const expected = expectedDamage(op, meleeWeapon, enemy, { inCover: false });
    // Melee is a two-way exchange; discount by what they hit back with.
    const score = (expected + killPressure(expected, enemy) * threatValue(state, enemy) * 0.8) *
      huntBonus(tactics?.hunts, profileOf(state, enemy));
    if (!best || score > best.score) {
      best = { targetId: enemy.id, targetName: enemy.name, expected, score };
    }
  }
  return best;
}
