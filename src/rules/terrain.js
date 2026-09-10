/**
 * Terrain rules representation. Kept separate from how terrain is drawn
 * (project invariant: renderer can change without changing combat).
 */
import { pointPolygonDistance, pointInPolygon } from '../maps/geometry.js';

/** Every trait the engine understands. Unknown traits are reported, not guessed. */
export const TERRAIN_TRAITS = {
  obscuring: 'Blocks line of sight through the piece.',
  cover: 'Grants a cover save to an operative behind it.',
  traversable: 'Operatives may move across it.',
  blocking: 'Operatives may not end a move overlapping it.',
  insignificant: 'Ignored for both visibility and movement.',
  vantage: 'Operatives on it are treated as elevated.',
  light: 'Light terrain: gives cover, but Seek Light weapons ignore it when selecting a target.',
};

export function traitsOf(piece) {
  return piece.traits || [];
}

export function hasTrait(piece, trait) {
  return traitsOf(piece).includes(trait);
}

export function isObscuring(piece) {
  return hasTrait(piece, 'obscuring') && !hasTrait(piece, 'insignificant');
}

export function isCover(piece) {
  return (hasTrait(piece, 'cover') || hasTrait(piece, 'obscuring')) &&
    !hasTrait(piece, 'insignificant');
}

/**
 * Light terrain — thin walls, railings, barricades. It still grants cover;
 * the trait exists so `Seek Light` can ignore exactly this class of piece.
 * Terrain without the trait counts as Heavy.
 */
export function isLight(piece) {
  return hasTrait(piece, 'light');
}

/** Can an operative's base end its move overlapping this piece? */
export function isPassable(piece) {
  if (hasTrait(piece, 'insignificant')) return true;
  if (hasTrait(piece, 'traversable')) return true;
  return !hasTrait(piece, 'blocking');
}

/** Traits present in data but not implemented by this engine version. */
export function unknownTraits(piece) {
  return traitsOf(piece).filter((t) => !(t in TERRAIN_TRAITS));
}

/**
 * Heavy terrain: everything that is not Light and not insignificant. The
 * printed rules define Heavy by exclusion in exactly this way, so the engine
 * does too rather than asking maps for a second trait.
 */
export function isHeavy(piece) {
  return !isLight(piece) && !hasTrait(piece, 'insignificant');
}

/**
 * WITHIN SHADOW (Mandrakes): "within 1" of Heavy terrain that's not lower than
 * it, or any part of its base underneath Vantage terrain".
 *
 * The height clause cannot be checked — this engine stores terrain `height`
 * but gives operatives no elevation of their own, so every operative is at
 * ground level and no piece is ever "lower than it". Shadow Portal markers are
 * the third route in and markers are not implemented; both gaps are declared
 * `partial` by the pack that uses this.
 */
export function isWithinShadow(state, op) {
  const reach = 1 + (op.baseDiameter || 0) / 2;
  return (state.map.terrain || []).some((piece) => {
    const points = piece.shape?.points;
    if (!points) return false;
    if (hasTrait(piece, 'vantage') && pointInPolygon(op.x, op.y, points)) return true;
    return isHeavy(piece) && pointPolygonDistance(op.x, op.y, points) <= reach;
  });
}
