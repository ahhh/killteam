/**
 * Terrain rules representation. Kept separate from how terrain is drawn
 * (project invariant: renderer can change without changing combat).
 */

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
