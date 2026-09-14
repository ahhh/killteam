/**
 * What makes an operative *itself*.
 *
 * Two layers already sat above the role weights: a **disposition** per kill
 * team, and **unit tactics** read off the profile's own weapons (see
 * `ai/tactics.js`). Between them they cover how a faction fights and what a
 * gun wants, and they miss the thing a player would name first — the operative
 * on the card. A Boss Nob and the Ork Boy beside it carry the same disposition
 * and, absent a Blast weapon, identical tactics, so the AI played them the
 * same way and the menu offered them the same three cards. So did a medic and
 * the trooper it was there to patch up; so did a Sorcerer and a Rubric Marine.
 *
 * That is a real hole rather than a cosmetic one, because a kill team is
 * mostly its specialists: 78 of the 581 bundled operatives carry `leader`, and
 * 97 printed actions belong to somebody in particular. This layer is what
 * reads them.
 *
 * It is **derived, not hand-maintained** — the same rule the dispositions
 * follow. An archetype is a set of keywords the packs already print, and an
 * operative is whatever archetypes its keywords match; nothing here names an
 * operative, and adding a team adds no code. A pack that disagrees says so in
 * data with `aiCharacter` on the profile (#5).
 *
 * What comes out:
 *
 *  - `mods` — multipliers folded over the role weights alongside the
 *    disposition's, so the scoring function stays one readable sum;
 *  - `hunts` — the enemy keywords this operative goes looking for, which is
 *    how a champion picks the enemy leader out of a crowd rather than
 *    swinging at whatever is closest;
 *  - `signature` — how much more its OWN printed actions are worth than a
 *    generic one, which is what gets a medic to use the Medikit and a leader
 *    to give the order;
 *  - `labels` — one line for the battle log, so the reasoning still explains
 *    itself.
 *
 * Nothing here mutates state and nothing here touches the RNG (#3).
 */
import { profileOf } from '../rules/hooks.js';

/**
 * The archetypes, keyed by the keywords the packs already print.
 *
 * `signature` multiplies what this operative's own printed actions are worth
 * (1 = a generic action). `hunts` multiplies the score of an enemy carrying
 * that keyword when a target is being picked.
 *
 * Deliberately conservative: every entry is a nudge over the role weights that
 * already exist, not a replacement for them, and an operative that matches
 * three archetypes should still be recognisably its role.
 */
export const ARCHETYPES = {
  leader: {
    label: 'Leader',
    note: 'gives the orders and expects to still be standing to give the next one',
    keywords: ['leader'],
    // A leader's own actions are the reason the team can act at all, and
    // losing it costs the team more than the wounds on its card.
    signature: 1.6,
    mods: { survival: 1.25, cover: 1.15, objective: 1.15, exposure: 1.1 },
  },

  champion: {
    label: 'Champion',
    note: 'looks for the enemy’s best and goes at it',
    keywords: [
      'champion', 'boss-nob', 'exarch', 'butcher', 'superior', 'sergeant',
      'aspirant', 'assault-intercessor',
    ],
    hunts: { leader: 1.6, champion: 1.3 },
    mods: { damage: 1.2, approach: 1.4, approachFloor: 2.5, exposure: 0.85 },
  },

  // The spell layer already lives in `unitTacticsFor`, which reads PSYCHIC off
  // the weapons. This is the other half of it: a caster's printed actions are
  // usually the rest of its repertoire, and it is a priority target.
  adept: {
    label: 'Adept',
    note: 'the repertoire is the point, not the sidearm',
    keywords: ['psyker', 'sorcerer', 'cryptek', 'magus', 'primaris-psyker'],
    signature: 1.5,
    hunts: { psyker: 1.4, leader: 1.2 },
    mods: { survival: 1.15, approach: 0.8 },
  },

  medic: {
    label: 'Medic',
    note: 'keeps the specialists on their feet and stays behind them',
    keywords: ['medic', 'apothecary', 'reliquarius', 'chirurgeon'],
    signature: 1.7,
    mods: { survival: 1.4, exposure: 1.2, approach: 0.6, damage: 0.85 },
  },

  marksman: {
    label: 'Marksman',
    note: 'holds a lane and shoots what matters',
    keywords: ['sniper', 'marksman', 'sharpshooter'],
    hunts: { leader: 1.5, psyker: 1.3, medic: 1.3, 'heavy-gunner': 1.2 },
    mods: { cover: 1.3, exposure: 1.2, approach: 0.5 },
  },

  // The specialists whose whole job is a printed action somebody else spends:
  // a Spot, a Signal, a banner that hands out an AP.
  herald: {
    label: 'Herald',
    note: 'the action is the contribution',
    keywords: [
      'vox-operator', 'spotter', 'surveyor', 'icon-bearer', 'horn-bearer',
      'comms', 'standard-bearer', 'tracker',
    ],
    signature: 1.7,
    mods: { survival: 1.2, objective: 1.1, approach: 0.7 },
  },

  gunner: {
    label: 'Gunner',
    note: 'finds a firing position and stays in it',
    keywords: ['heavy-gunner', 'gunner', 'grenadier'],
    mods: { cover: 1.2, exposure: 1.15, approach: 0.65, damage: 1.1 },
  },

  infiltrator: {
    label: 'Infiltrator',
    note: 'works the flanks and stays off the skyline',
    keywords: [
      'infiltrator', 'scout', 'ranger', 'incursor', 'sicarian', 'mandrake',
      'stalker',
    ],
    mods: { cover: 1.25, survival: 1.3, objective: 1.2 },
  },

  // Fast, and meant to be spent reaching something.
  outrider: {
    label: 'Outrider',
    note: 'covers ground nobody else can',
    keywords: ['jump-pack', 'mounted', 'grav-chute', 'wings'],
    mods: { approach: 1.35, approachFloor: 2.0, exposure: 0.85, objective: 1.1 },
  },

  // Cheap, replaceable, and worth more used than preserved.
  expendable: {
    label: 'Expendable',
    note: 'costs the team almost nothing to lose',
    keywords: ['servitor', 'drone', 'mutoid-vermin', 'bomb-squig', 'canoptek'],
    mods: { survival: 0.5, exposure: 0.6, cover: 0.8, approach: 1.15 },
  },
};

/** The keyword → archetype index, built once. */
const BY_KEYWORD = new Map();
for (const [id, archetype] of Object.entries(ARCHETYPES)) {
  for (const keyword of archetype.keywords) {
    if (!BY_KEYWORD.has(keyword)) BY_KEYWORD.set(keyword, []);
    BY_KEYWORD.get(keyword).push(id);
  }
}

/**
 * At most this many archetypes are folded together.
 *
 * A profile that matches five of them ends up with the average of five nudges,
 * which is no nudge at all. Keywords are read in the order the pack prints
 * them, which puts the specific ones first on every bundled profile.
 */
const MAX_ARCHETYPES = 3;

/** An ability whose text opens "PSYCHIC" is a spell, whatever else it does. */
const PSYCHIC_TEXT = /^\s*PSYCHIC\b/i;

/**
 * Is this printed action a spell?
 *
 * Read off the ability's own description, the way `unitTacticsFor` reads
 * PSYCHIC off a weapon's rules: the packs transcribe the keyword at the head
 * of the text, and 21 of the bundled performable actions carry it. A spell an
 * operative *performs* is no less its repertoire than one it shoots, and until
 * this existed a Sorcerer's TELEPATHIC OVERLOAD was priced identically to a
 * Medikit.
 */
export function isPsychicAbility(ability) {
  return PSYCHIC_TEXT.test(String(ability?.description ?? ''));
}

/**
 * Fold a list of archetypes into one block of multipliers.
 *
 * `approachFloor` is a floor rather than a factor (see `applyTactics`), so it
 * takes the strongest claim; `signature` and each `hunts` entry likewise. The
 * plain multipliers compound, which is what makes a leader who is also a
 * psyker cautious twice over.
 */
function foldArchetypes(ids) {
  const mods = {};
  const hunts = {};
  let signature = 1;
  for (const id of ids) {
    const a = ARCHETYPES[id];
    if (!a) continue;
    for (const [key, value] of Object.entries(a.mods || {})) {
      mods[key] = key === 'approachFloor'
        ? Math.max(mods[key] ?? 0, value)
        : (mods[key] ?? 1) * value;
    }
    for (const [key, value] of Object.entries(a.hunts || {})) {
      hunts[key] = Math.max(hunts[key] ?? 1, value);
    }
    signature = Math.max(signature, a.signature ?? 1);
  }
  return { mods, hunts, signature };
}

/**
 * The archetypes named by a pack override, or read off the keywords.
 *
 * `aiCharacter` may be a single archetype name, a list of them, or an inline
 * block — the same three shapes `aiDisposition` accepts, for the same reason:
 * a pack that has an opinion should be able to state it without a code change.
 */
function archetypesOf(profile) {
  const override = profile?.aiCharacter;
  if (typeof override === 'string' && ARCHETYPES[override]) return [override];
  if (Array.isArray(override)) return override.filter((id) => ARCHETYPES[id]);

  const found = [];
  for (const keyword of profile?.keywords || []) {
    for (const id of BY_KEYWORD.get(keyword) || []) {
      if (!found.includes(id)) found.push(id);
    }
    if (found.length >= MAX_ARCHETYPES) break;
  }
  return found.slice(0, MAX_ARCHETYPES);
}

/**
 * Everything derived from one profile, cached against the profile object.
 *
 * `characterFor` is asked once per plan per candidate target while an
 * activation is being ranked, and the answer cannot change during a battle —
 * a profile is pack data. Keyed on the object rather than on the id so two
 * teams that both field a "sergeant" never collide, and so an imported pack is
 * collected with the battle it was imported for.
 */
const CACHE = new WeakMap();

/**
 * What this operative is, beyond its role and its guns.
 *
 * @returns {{archetypes:string[], labels:string[], mods:object,
 *            hunts:Record<string,number>, signature:number,
 *            spells:string[], actions:string[]}}
 */
export function characterFor(state, op) {
  const profile = profileOf(state, op);
  if (!profile) return EMPTY;
  const cached = CACHE.get(profile);
  if (cached) return cached;
  const built = characterForProfile(profile);
  CACHE.set(profile, built);
  return built;
}

/**
 * The same answer from the profile alone, for callers with no battle in front
 * of them — the setup screen, and the tests that check the table itself.
 */
export function characterForProfile(profile) {
  const archetypes = archetypesOf(profile);
  const inline = (profile?.aiCharacter && typeof profile.aiCharacter === 'object' &&
    !Array.isArray(profile.aiCharacter)) ? profile.aiCharacter : null;

  const folded = foldArchetypes(archetypes);
  const mods = { ...folded.mods, ...(inline?.mods ?? (inline && !inline.mods ? inline : {})) };
  const hunts = { ...folded.hunts, ...(inline?.hunts ?? {}) };
  const signature = Number(inline?.signature) || folded.signature;

  // The operative's own performable actions, and which of them are spells.
  const actions = [];
  const spells = [];
  for (const ability of profile?.abilities || []) {
    if (!ability?.action || typeof ability.action !== 'object') continue;
    actions.push(ability.id);
    if (isPsychicAbility(ability)) spells.push(ability.id);
  }

  const labels = [];
  const named = inline?.label
    ? [inline.label]
    : archetypes.map((id) => ARCHETYPES[id].label);
  if (named.length) {
    const note = inline?.note ?? (archetypes.length ? ARCHETYPES[archetypes[0]].note : null);
    labels.push(note ? `${named.join('/')} — ${note}` : named.join('/'));
  }
  if (spells.length) labels.push(`${spells.length} printed spell${spells.length > 1 ? 's' : ''}`);

  return {
    archetypes, labels, mods, hunts, signature,
    spells: new Set(spells), actions,
  };
}

const EMPTY = {
  archetypes: [], labels: [], mods: {}, hunts: {}, signature: 1,
  spells: new Set(), actions: [],
};

/**
 * How much more this operative wants to attack `enemy` than the numbers alone
 * suggest.
 *
 * A champion that is one inch from the enemy leader and one inch from a
 * trooper picks by expected damage, and the trooper usually wins that
 * comparison — it is easier to hurt. The whole point of a champion is that it
 * does not care. Applied as a multiplier on the target's score rather than on
 * its threat, so it steers the choice between targets without inflating what
 * the plan claims it will do (see `ai/targeting.js`).
 *
 * @returns {number} 1 when this operative is hunting nothing the enemy is.
 */
export function huntBonus(hunts, enemyProfile) {
  if (!hunts) return 1;
  let best = 1;
  for (const keyword of enemyProfile?.keywords || []) {
    const weight = hunts[keyword];
    if (weight > best) best = weight;
  }
  return best;
}
