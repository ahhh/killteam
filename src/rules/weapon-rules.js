/**
 * Weapon rules that bite OUTSIDE the dice maths.
 *
 * `dice.js` owns everything that changes an attack or defence roll. This file
 * owns the rest: which weapons an operative may still use this activation,
 * how many uses a weapon has left, whether a shot may be taken from Conceal,
 * what terrain a target may hide behind, and how wide an area attack spreads.
 *
 * Kept separate so the action layer can ask "may I?" without pulling in the
 * dice model, and so every rule below has one obvious home.
 */
import { ruleMap } from './dice.js';

/** Actions that count as "moving" for Heavy. */
export const MOVE_ACTIONS = ['reposition', 'dash', 'charge', 'fall_back'];

const MOVE_LABELS = {
  reposition: 'Reposition', dash: 'Dash', charge: 'Charge', fall_back: 'Fall Back',
};

/* ------------------------------------------------------------------ */
/* Heavy                                                               */
/* ------------------------------------------------------------------ */

/**
 * Heavy: an operative cannot use this weapon in an activation in which it
 * moved, and cannot move in an activation in which it used this weapon.
 * `Heavy (x only)` permits exactly one move action, named by the qualifier.
 *
 * @returns {undefined} if the weapon is not Heavy;
 *          {null} if it forbids every move; otherwise the one permitted action.
 */
export function heavyAllowedMove(weapon) {
  const info = ruleMap(weapon).get('heavy');
  if (!info) return undefined;
  return info.qualifier || null;
}

export function isHeavy(weapon) {
  return heavyAllowedMove(weapon) !== undefined;
}

/** Human-readable name of the rule, for log lines and rejection reasons. */
export function heavyLabel(weapon) {
  const allowed = heavyAllowedMove(weapon);
  if (allowed === undefined) return null;
  return allowed ? `Heavy (${MOVE_LABELS[allowed] || allowed} only)` : 'Heavy';
}

/**
 * Why a Heavy weapon may not be used right now, or null if it may.
 * @param {string[]} usedThisActivation action types already performed.
 */
export function heavyShootBlocker(weapon, usedThisActivation = []) {
  const allowed = heavyAllowedMove(weapon);
  if (allowed === undefined) return null;
  const moved = usedThisActivation.find((a) => MOVE_ACTIONS.includes(a) && a !== allowed);
  if (!moved) return null;
  return `${heavyLabel(weapon)}: already performed ${MOVE_LABELS[moved] || moved} this activation`;
}

/**
 * Record that a Heavy weapon was used, so the move half of the rule can bite
 * for the rest of the activation. Two Heavy weapons leave the stricter limit.
 */
export function noteHeavyUse(op, weapon) {
  const allowed = heavyAllowedMove(weapon);
  if (allowed === undefined) return;
  if (!op.heavyUsed) {
    op.heavyUsed = true;
    op.heavyMoveAllowed = allowed;
  } else if (op.heavyMoveAllowed !== allowed) {
    op.heavyMoveAllowed = null;
  }
}

/** Why this operative may not perform `moveType` right now, or null. */
export function heavyMoveBlocker(op, moveType) {
  if (!op?.heavyUsed) return null;
  if (op.heavyMoveAllowed && op.heavyMoveAllowed === moveType) return null;
  const label = op.heavyMoveAllowed
    ? `Heavy (${MOVE_LABELS[op.heavyMoveAllowed] || op.heavyMoveAllowed} only)`
    : 'Heavy';
  return `${label}: used a Heavy weapon this activation`;
}

/* ------------------------------------------------------------------ */
/* Limited x                                                           */
/* ------------------------------------------------------------------ */

/** Uses a Limited weapon gets for the whole battle, or null if unlimited. */
export function limitedUses(weapon) {
  const info = ruleMap(weapon).get('limited');
  if (!info) return null;
  return info.value ?? 1;
}

export function usesSpent(op, weapon) {
  return op.weaponUses?.[weapon.id] || 0;
}

export function limitedExhausted(op, weapon) {
  const max = limitedUses(weapon);
  return max !== null && usesSpent(op, weapon) >= max;
}

/** Count one use of a weapon. Called once per Shoot or Fight action. */
export function noteWeaponUse(op, weapon) {
  if (!op.weaponUses) op.weaponUses = {};
  op.weaponUses[weapon.id] = (op.weaponUses[weapon.id] || 0) + 1;
  noteHeavyUse(op, weapon);
}

/* ------------------------------------------------------------------ */
/* Silent                                                              */
/* ------------------------------------------------------------------ */

/** Silent: the Shoot action may be performed while on a Conceal order. */
export function isSilent(weapon) {
  return ruleMap(weapon).has('silent');
}

/* ------------------------------------------------------------------ */
/* Seek / Seek Light                                                   */
/* ------------------------------------------------------------------ */

/**
 * Seek: when selecting a valid target, the target cannot use terrain for
 * cover — so a concealed operative behind a wall can still be picked. It does
 * NOT remove the cover save itself; that is Saturate's job.
 *
 * @returns {'all'|'light'|'none'} which terrain is ignored for selection.
 */
export function seekMode(weapon) {
  const m = ruleMap(weapon);
  if (m.has('seek')) return 'all';
  if (m.has('seeklight')) return 'light';
  return 'none';
}

/* ------------------------------------------------------------------ */
/* Hot                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Hot: after an operative uses this weapon, roll a D6; if the result is less
 * than the weapon's Hit stat, the operative suffers twice the result.
 * Rolled once per Shoot action, after every sequence it caused.
 *
 * @returns {{rolled:number, damage:number}|null} null if the weapon isn't Hot.
 */
export function rollHot(rng, weapon) {
  if (!ruleMap(weapon).has('hot')) return null;
  const rolled = rng.d6();
  return { rolled, damage: rolled < weapon.hit ? rolled * 2 : 0 };
}

/* ------------------------------------------------------------------ */
/* Stun                                                                */
/* ------------------------------------------------------------------ */

/** Stun bites whenever the attack retained at least one critical success. */
export function stunTriggers(weapon, crits) {
  return crits > 0 && ruleMap(weapon).has('stun');
}

/* ------------------------------------------------------------------ */
/* Blast x" / Torrent x"                                               */
/* ------------------------------------------------------------------ */

/** Blast radius in inches, or null when the weapon is not Blast. */
export function blastRadius(weapon) {
  const info = ruleMap(weapon).get('blast');
  return info ? (info.value ?? 0) : null;
}

/** Torrent radius in inches, or null when the weapon is not Torrent. */
export function torrentRadius(weapon) {
  const info = ruleMap(weapon).get('torrent');
  return info ? (info.value ?? 0) : null;
}

export function isAreaWeapon(weapon) {
  return blastRadius(weapon) !== null || torrentRadius(weapon) !== null;
}
