/**
 * Faction dispositions and per-unit tactics.
 *
 * The controller's role weights describe how a *job* is played — a sniper
 * hangs back, an assault operative closes. They say nothing about who the
 * operative fights for, and nothing about the one weapon that makes a profile
 * special. So every team fought the same careful fight, a flamer picked the
 * same lone target a lasgun would, and a bomb squig walked up and bit people.
 *
 * Two layers sit on top, both derived rather than hand-maintained per
 * operative:
 *
 *  - a **disposition** per kill team (falling back to its faction): Orks press
 *    forward and discount the danger, Astra Militarum hold a firing line.
 *  - **unit tactics** read off the profile's own weapons: area weapons hunt for
 *    crowds, Explosive weapons hunt for a crowd to stand inside, psykers value
 *    getting the big spell off over plinking with a sidearm.
 *  - a **character** read off the profile's own keywords and printed actions
 *    (`ai/characters.js`): a leader expects to survive to give the next order,
 *    a champion goes looking for the enemy's best, a medic values the Medikit
 *    over the point of AP it costs.
 *
 * A fourth layer, the team resource economies, does not scale weights at all —
 * an invigoration is a decision rather than a disposition — so it lives in
 * `spending.js` and only reports here, in the plan rationale.
 *
 * Both produce plain multipliers over the role weights, so the scoring function
 * stays one readable sum and a plan's breakdown still explains itself.
 *
 * A rule pack can override its team's disposition with an `aiDisposition`
 * field: either a name from `DISPOSITIONS` or an inline block of multipliers.
 */
import { getProfile, selfDirectedWeapon } from '../rules/shooting.js';
import { blastRadius, torrentRadius } from '../rules/weapon-rules.js';
import { spendLabels } from './spending.js';
import { characterFor } from './characters.js';

/**
 * Multipliers over the role weights. `approachFloor` is the exception: it
 * raises the drive to close to at least that value, which is how a disposition
 * makes a gunline profile fight like a berserker rather than merely caring a
 * little more about damage.
 */
export const DISPOSITIONS = {
  balanced: {
    label: 'Balanced',
    note: 'takes the fight as it comes',
    mods: {},
  },
  aggressive: {
    label: 'Aggressive',
    note: 'closes hard and discounts the risk',
    mods: { damage: 1.25, approach: 1.6, approachFloor: 3.5, exposure: 0.65, cover: 0.8 },
  },
  patient: {
    label: 'Gunline',
    note: 'holds firing positions and trades at range',
    mods: { damage: 1.1, cover: 1.3, exposure: 1.2, survival: 1.15, approach: 0.6 },
  },
  skirmish: {
    label: 'Skirmishers',
    note: 'works the flanks and stays behind cover',
    mods: { cover: 1.2, survival: 1.25, exposure: 1.05, approach: 0.9, objective: 1.1 },
  },
  relentless: {
    label: 'Relentless',
    note: 'walks through fire rather than around it',
    mods: { exposure: 0.55, cover: 0.85, survival: 0.9, approach: 1.25, approachFloor: 2.5 },
  },
};

/** Faction-level default. Teams inherit this unless listed below. */
export const FACTION_DISPOSITIONS = {
  orks: 'aggressive',
  'scrap-horde': 'aggressive',
  'world-eaters': 'aggressive',
  tyranids: 'aggressive',
  'chaos-daemons': 'aggressive',
  cultists: 'aggressive',
  exodites: 'aggressive',
  harlequins: 'aggressive',
  'vanguard-compact': 'aggressive',

  'astra-militarum': 'patient',
  't-au-empire': 'patient',
  'sky-caste': 'patient',
  'leagues-of-votann': 'patient',
  'adeptus-mechanicus': 'patient',
  'agents-of-the-imperium': 'patient',

  drukhari: 'skirmish',
  corsairs: 'skirmish',
  'kindred-corsairs': 'skirmish',
  craftworlds: 'skirmish',
  'genestealer-cults': 'skirmish',
  'ash-legion': 'skirmish',

  necrons: 'relentless',
  'death-guard': 'relentless',

  'space-marines': 'balanced',
  'chaos-space-marines': 'balanced',
  'adepta-sororitas': 'balanced',
  'thousand-sons': 'balanced',
};

/** Teams that do not play the way their faction usually does. */
export const TEAM_DISPOSITIONS = {
  'blades-of-khaine': 'aggressive',   // Banshees exist to reach melee
  'void-dancer-troupe': 'aggressive',
  'vespid-stingwings': 'aggressive',
  goremonger: 'aggressive',
  raveners: 'aggressive',
  'phobos-strike-team': 'skirmish',
  'wolf-scouts': 'skirmish',
  'scout-squad': 'skirmish',
  'celestian-insidiants': 'skirmish',
  'xv26-stealth-battlesuits': 'skirmish',
  mandrakes: 'skirmish',
  ratlings: 'patient',
  'skycaste-marksmen': 'patient',
  'canoptek-circle': 'patient',       // gun platforms, not a melee swarm
};

/**
 * The disposition a player's kill team fights with.
 * @returns {{name:string, label:string, note:string, mods:object}}
 */
export function dispositionFor(state, playerId) {
  return dispositionForPack(state.teamPacks?.[playerId]);
}

/**
 * The same answer from the pack alone, for callers with no battle in front of
 * them — the setup screen, which tells a player how a team fights before they
 * pick it.
 */
export function dispositionForPack(pack) {
  const override = pack?.aiDisposition;

  if (override && typeof override === 'object') {
    return {
      name: 'custom',
      label: override.label ?? 'Custom',
      note: override.note ?? 'disposition set by the rule pack',
      mods: override.mods ?? override,
    };
  }
  const name = (typeof override === 'string' && DISPOSITIONS[override])
    ? override
    : TEAM_DISPOSITIONS[pack?.id] ?? FACTION_DISPOSITIONS[pack?.factionId] ?? 'balanced';
  return { name, ...DISPOSITIONS[name] };
}

/** Radius an area weapon throws damage around its target, or null. */
function areaRadius(weapon) {
  const blast = blastRadius(weapon);
  return blast !== null ? blast : torrentRadius(weapon);
}

/**
 * What makes this operative special, read off its own profile.
 *
 * Two things are folded together here: what its **weapons** want (a Blast
 * hunting a crowd, a demolition charge hunting a crowd to stand inside), and
 * what the **operative** is (`ai/characters.js` — a leader, a champion, a
 * medic). The weapons came first and for a long time were the whole of it,
 * which is why a Boss Nob and the Ork Boy next to it planned identically.
 *
 * @returns {{labels:string[], mods:object, multiHit:number|null,
 *            detonator:number|null, psyker:boolean, spellBonus:number,
 *            splashWeight:number, hunts:object, signature:number,
 *            spells:Set<string>, character:object}}
 */
export function unitTacticsFor(state, op) {
  const profile = getProfile(state, op);
  const weapons = profile.weapons || [];
  const keywords = profile.keywords || [];

  const labels = [];
  const mods = {};
  let multiHit = null;
  let detonator = null;
  let splashWeight = 1;
  let spellBonus = 0;

  // Explosive / Wreathed: the operative is its own target, so the tactic is to
  // walk into the crowd. Nothing else in the AI wants to do that, which is why
  // this needs its own handling rather than a nudged weight.
  for (const weapon of weapons) {
    if (weapon.type !== 'ranged') continue;
    if (!selfDirectedWeapon(state, op, weapon)) continue;
    const radius = areaRadius(weapon) ?? 0;
    detonator = Math.max(detonator ?? 0, radius);
  }
  if (detonator !== null) {
    labels.push(`demolition charge (${detonator}" detonation)`);
    Object.assign(mods, {
      damage: 1.3, exposure: 0.25, cover: 0.4, survival: 0.3,
      approach: 1.8, approachFloor: 3.0, waste: 1.5,
    });
    splashWeight = 1.5;
  }

  // Blast and Torrent: worth steering toward clustered targets, and worth
  // scoring the splash at all — the plan estimate used to drop it, so a flamer
  // rated a crowd exactly as highly as one lone trooper.
  for (const weapon of weapons) {
    if (weapon.type !== 'ranged') continue;
    if (selfDirectedWeapon(state, op, weapon)) continue;
    const radius = areaRadius(weapon);
    if (radius === null) continue;
    multiHit = Math.max(multiHit ?? 0, radius);
  }
  if (multiHit !== null) {
    labels.push(`area weapon (${multiHit}" splash)`);
    splashWeight = Math.max(splashWeight, 1.3);
    mods.damage = (mods.damage ?? 1) * 1.1;
  }

  // Psykers: the spell is the reason the operative is on the board. Their
  // psychic weapons are their best ones, so the job is to make them willing to
  // take a sight line and cast rather than sit in cover all battle.
  const spells = weapons.filter((w) => (w.rules || []).includes('psychic'));
  const psyker = keywords.includes('psyker') || spells.length > 0;
  if (psyker && spells.length) {
    labels.push(`psyker (${spells.map((s) => s.name).join(', ')})`);
    spellBonus = 1.4;
    mods.cover = (mods.cover ?? 1) * 0.85;
    mods.exposure = (mods.exposure ?? 1) * 0.85;
    mods.damage = (mods.damage ?? 1) * 1.15;
  }

  // Who this is, as opposed to what it carries. Folded last so a character
  // multiplier compounds over whatever its guns already asked for, and so an
  // archetype cannot silently overwrite a weapon's claim on the same weight.
  const character = characterFor(state, op);
  for (const [key, value] of Object.entries(character.mods)) {
    mods[key] = key === 'approachFloor'
      ? Math.max(mods[key] ?? 0, value)
      : (mods[key] ?? 1) * value;
  }
  labels.push(...character.labels);
  // A caster whose spells are printed *actions* rather than weapons — a Magus'
  // TELEPATHIC OVERLOAD — is still a caster, and `spells` above only ever
  // looked at the weapon list.
  if (character.spells.size && spellBonus === 0) spellBonus = 1.4;

  // What the team's resource economy is offering this operative right now.
  // It changes no weight — the spends are chosen in `spending.js`, plan by
  // plan — but the log should say what was on the table when it chose.
  labels.push(...spendLabels(state, op));

  return {
    labels, mods, multiHit, detonator, psyker, spellBonus, splashWeight,
    hunts: character.hunts, signature: character.signature,
    spells: character.spells, character,
  };
}

/**
 * Fold multiplier blocks over a set of role weights, left to right.
 * `approachFloor` applies after the multipliers so a disposition can guarantee
 * a minimum drive to close regardless of the role it is modifying.
 */
export function applyTactics(base, ...blocks) {
  const out = { ...base };
  let floor = 0;
  for (const block of blocks) {
    if (!block) continue;
    for (const [key, value] of Object.entries(block)) {
      if (key === 'approachFloor') { floor = Math.max(floor, value); continue; }
      if (typeof value !== 'number' || !(key in out)) continue;
      out[key] = out[key] * value;
    }
  }
  if (floor) out.approach = Math.max(out.approach ?? 0, floor);
  return out;
}
