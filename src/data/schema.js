/**
 * Rule-pack schema constants and limits.
 *
 * Imported JSON is DATA, never code (§34). Nothing here evals, and every
 * limit exists so a hostile or broken file cannot wedge the simulator.
 */

export const SCHEMA_VERSION = 1;

export const LIMITS = {
  maxOperativesPerTeam: 24,
  maxWeaponsPerOperative: 16,   // real datacards reach 10 wargear profiles
  maxTerrainPieces: 120,
  maxPolygonPoints: 64,
  maxObjectives: 12,
  minBoard: 12,
  maxBoard: 60,
  maxTextLength: 400,
  /** Flavour prose (`lore`) is displayed, never parsed, so it gets more room
   *  than a rules string — but still a ceiling, because an imported pack is
   *  untrusted input and the sheet has to stay readable. */
  maxLoreLength: 1200,
};

export const STAT_RANGES = {
  move: [0, 20],               // some operatives are immobile (Move 0")
  apl: [1, 5],
  save: [2, 6],
  wounds: [1, 40],
};

export const WEAPON_RANGES = {
  atk: [1, 12],
  hit: [2, 6],
  range: [1, 48],
  'damage.normal': [0, 20],
  'damage.critical': [0, 30],
};

/** Support levels a pack may declare (§10). */
export const SUPPORT_LEVELS = {
  0: { key: 'metadata', label: 'Metadata only', badge: 'Reference only' },
  1: { key: 'core-stats', label: 'Core stats and basic weapons', badge: 'Core compatible' },
  2: { key: 'roster', label: 'Roster restrictions', badge: 'Core compatible' },
  3: { key: 'abilities', label: 'Faction rules and core operative abilities', badge: 'Mostly supported' },
  4: { key: 'ploys', label: 'Team ploys and equipment', badge: 'Mostly supported' },
  5: { key: 'full', label: 'Full supported team behaviour', badge: 'Full engine support' },
};

/**
 * Rule-hook triggers the engine knows how to fire. Others are reported.
 * The effect vocabulary that goes with them lives in `src/rules/hooks.js`.
 */
export const KNOWN_HOOK_TRIGGERS = [
  'beforeAttackRoll',
  'afterAttackRoll',
  'beforeDefenceRoll',
  'beforeDamageApplied',
  'onActivationStart',
  'onActionLegality',
  'onTargetSelection',
  'onIncomingAttack',
  'onActivationEnd',
  'onTurningPointStart',
  'onDamageApplied',
  'onWouldBeIncapacitated',
  'afterAction',
  'afterRetaliation',
  'onIncapacitated',
];

/**
 * Strip anything that could be interpreted as markup before display.
 * The UI also sets textContent rather than innerHTML; this is belt and braces.
 */
export function sanitizeText(value, max = LIMITS.maxTextLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>]/g, '').slice(0, max);
}
