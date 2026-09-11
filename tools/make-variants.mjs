/**
 * Build the bundled team VARIANTS.
 *
 * A variant is a second way to field a kill team that is already in the
 * catalogue: the same datacards, a different half of them, and a different
 * plan for what to do with them. It exists because the interesting question in
 * this simulator is rarely "which team is better" but "which *shape* of team
 * is better here" — and until now every pack could only be fielded one way.
 *
 * Everything a variant changes is data the engine already reads:
 *
 *   roster          which of the pack's own profiles take the field, and how
 *                   many — no new datacards, so nothing is invented
 *   aiDisposition   how the whole team fights (tactics.js)
 *   aiCpDoctrine    what it is willing to spend CP on, and when (ai/cp.js)
 *   ploys           which of the base team's ploys it brings, plus at most one
 *                   of its own, written against the published hook vocabulary
 *
 * ONE HARD RULE, and it was learned the expensive way: a variant never fields
 * MORE operatives than its base. Kill Team prices a bigger list with points;
 * this simulator has none, so "the same team but bigger" is not a variant, it
 * is a better list. The Legionary Warband began as the squad plus three more
 * and won 92% of its games against a neutral pool where the base team won 51%.
 * Trading the champions for rank and file did not help — nine marines beat six
 * marines whoever they are. It is now six, and the variant is the shape of the
 * six, which is the only comparison this simulator can make fairly.
 *
 * Generated rather than hand-written so a variant cannot drift from the
 * datacards it is derived from: re-run this after editing a base pack.
 *
 *   node tools/make-variants.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEAMS = path.join(ROOT, 'data', 'teams');
const TODAY = '2026-09-11';

/**
 * Each variant: which pack it comes from, who takes the field, how they play,
 * and the one ploy that makes them play that way.
 *
 * `note` is the sentence the team picker shows under the name. It has one job:
 * tell a player what is different before they commit to it.
 */
const VARIANTS = [
  {
    id: 'kommandos-dakka',
    base: 'kommandos',
    displayName: 'Dakka Kommandos',
    blurb: 'Every gun the mob owns, and nobody to carry them into melee.',
    note: 'A Kommando mob built round its guns: the choppa boys stay home, and '
      + 'the ones that are left hide rather than charge.',
    faction: 'orks',
    roster: [
      'kommando-boss-nob', 'kommando-dakka-boy', 'kommando-snipa-boy',
      'kommando-rokkit-boy', 'kommando-burna-boy', 'kommando-comms-boy',
      'kommando-boy', 'kommando-bomb-squig',
    ],
    disposition: 'patient',
    doctrine: 'gunline',
    // WAAAGH! is a melee buff on a team that no longer reaches melee.
    dropStrategic: ['waaagh'],
    dropFirefight: ['krump-em'],
    factionRule: {
      id: 'more-dakka', name: 'More Dakka',
      description: "Whenever a friendly KOMMANDO operative is shooting during an activation "
        + 'in which it has not moved, its ranged weapons have the Balanced weapon rule.',
      hook: {
        trigger: 'beforeAttackRoll',
        condition: {
          keyword: 'kommando', weaponType: 'ranged',
          notPerformedThisActivation: ['reposition', 'charge', 'dash', 'fall_back'],
        },
        effect: { type: 'grantWeaponRule', rules: ['balanced'] },
      },
    },
  },
  {
    id: 'novitiates-penitent',
    base: 'novitiates',
    displayName: 'Penitent Host',
    blurb: 'Eviscerators and zeal. The shooting is somebody else\'s problem.',
    note: 'Novitiates fielded as a melee host — blades and flame instead of '
      + 'autoguns — and they take somebody with them when they fall.',
    faction: 'adepta-sororitas',
    roster: [
      'novitiate-superior', 'novitiate-penitent', 'novitiate-duellist',
      'novitiate-preceptor', 'novitiate-exactor', 'novitiate-dialogus',
      'novitiate-militant', 'novitiate-purgatus', 'novitiate-hospitaller',
      'novitiate-condemnor',
    ],
    disposition: 'relentless',
    doctrine: 'vanguard',
    dropStrategic: ['blessed-rejuvenation'],
    // GLORIOUS MARTYRDOM is the base team's death-throe, bought a CP at a time.
    // The Host's whole design is that it does not have to buy it.
    dropFirefight: ['glorious-martyrdom'],
    factionRule: {
      id: 'the-pyre-of-the-faithful', name: 'The Pyre of the Faithful',
      description: 'Whenever a friendly NOVITIATE operative is incapacitated, before it is '
        + 'removed from the killzone, inflict D3 damage on each enemy operative visible to '
        + 'and within 2" of it.',
      hook: {
        trigger: 'onIncapacitated',
        condition: { keyword: 'novitiate' },
        effect: {
          type: 'inflictDamage', dice: 'D3', within: 2, requireVisible: true, scope: 'each',
        },
      },
    },
  },
  {
    id: 'corsair-voidscarred-coven',
    base: 'corsair-voidscarred',
    displayName: 'Voidscarred Coven',
    blurb: 'Specialists only. They shoot from the dark and step back into it.',
    note: 'The Voidscarred\'s rarest hands — a Way-Seeker, a sniper, a fusion '
      + 'duellist — fielded seven strong, and slipping back onto Conceal the '
      + 'moment each of them is done.',
    faction: 'corsairs',
    roster: [
      'voidscarred-felarch', 'voidscarred-way-seeker', 'voidscarred-fate-dealer',
      'voidscarred-starstorm-duellist', 'voidscarred-heavy-gunner',
      'voidscarred-shade-runner', 'voidscarred-gunner',
    ],
    disposition: 'skirmish',
    // Raider banks CP for one big turning point; the Coven's whole plan is a
    // small spend every activation, so it takes the best buy each time instead.
    doctrine: 'tactician',
    dropStrategic: ['plunderers'],
    addFirefight: [{
      id: 'step-into-shadow', name: 'STEP INTO SHADOW', cost: 1,
      description: 'Use this firefight ploy during a friendly CORSAIR VOIDSCARRED '
        + "operative's activation. At the end of that activation, change its order to Conceal.",
      hooks: [{
        trigger: 'onActivationEnd',
        condition: { keyword: 'corsair-voidscarred' },
        effect: { type: 'changeOrder', order: 'conceal' },
      }],
    }],
  },
  {
    id: 'fellgor-ravager-warherd',
    base: 'fellgor-ravager',
    displayName: 'Fellgor Warherd',
    blurb: 'No pistols worth the name. They arrive all at once and at speed.',
    note: 'The Ravagers stripped to their horns and cleavers: a pure charging '
      + 'herd that does damage by arriving, before a blow is struck.',
    faction: 'beastmen',
    roster: [
      'fellgor-ironhorn', 'fellgor-mangler', 'fellgor-vandal', 'fellgor-fluxbray',
      'fellgor-gorehorn', 'fellgor-gnarlscar', 'fellgor-toxhorn', 'fellgor-deathknell',
      'fellgor-warrior', 'fellgor-warrior',
    ],
    disposition: {
      label: 'Stampede', note: 'measures a turning point in inches closed',
      mods: { damage: 1.2, approach: 1.8, approachFloor: 4, exposure: 0.5, cover: 0.75 },
    },
    doctrine: 'vanguard',
    dropStrategic: ['pelting-firepower'],
    factionRule: {
      id: 'death-bellow', name: 'Death Bellow',
      description: 'Whenever a friendly FELLGOR RAVAGER operative ends a Charge action, '
        + 'inflict D3 damage on one enemy operative within its control range.',
      hook: {
        trigger: 'afterAction',
        condition: { keyword: 'fellgor-ravager', actionIs: 'charge' },
        effect: { type: 'inflictDamage', dice: 'D3', controlRangeOnly: true },
      },
    },
  },
  {
    id: 'death-korps-cadre',
    base: 'death-korps',
    displayName: 'Krieg Veteran Cadre',
    blurb: 'Ten men where there were fourteen, and not a plain trooper among them.',
    note: 'The same regiment fielded as a cadre rather than a line: every '
      + 'specialist on the sheet, none of the rank and file, and no intention '
      + 'of giving ground.',
    faction: 'astra-militarum',
    roster: [
      'death-korps-watchmaster', 'death-korps-sniper', 'death-korps-sapper',
      'death-korps-gunner', 'death-korps-spotter', 'death-korps-medic',
      'death-korps-confidant', 'death-korps-veteran', 'death-korps-vox-operator',
      'death-korps-bruiser',
    ],
    disposition: 'patient',
    doctrine: 'bulwark',
    factionRule: {
      id: 'unflinching', name: 'Unflinching',
      description: 'Ignore any changes to the stats of friendly DEATH KORPS operatives '
        + "from being injured (including their weapons' stats).",
      hook: {
        trigger: 'onActivationStart',
        condition: { keyword: 'death-korps' },
        effect: { type: 'ignoreInjured' },
      },
    },
  },
  {
    id: 'legionary-warband',
    base: 'legionary',
    displayName: 'Legionary Warband',
    blurb: 'No champions. Six of the rank and file, and a single Mark between them.',
    note: 'The same six-strong squad with the champions traded for rank and '
      + 'file: no Chosen, no Shrivetalon, no Balefire Acolyte — one Mark rather '
      + 'than four, and none of the ploys the champions brought with them.',
    faction: 'chaos-space-marines',
    // Not the squad plus three more: the squad's champions traded away FOR
    // three more. Keeping them and adding bodies is not a variant, it is a
    // bigger list — and with no points cost in this simulator, bigger wins.
    roster: [
      'legionary-aspiring-champion', 'legionary-gunner',
      'legionary-warrior', 'legionary-warrior',
      'legionary-warrior', 'legionary-warrior',
    ],
    disposition: 'aggressive',
    doctrine: 'tactician',
    dropStrategic: ['quicksilver-speed', 'fickle-fates'],
    addStrategic: [{
      id: 'hateful-recompense', name: 'HATEFUL RECOMPENSE', cost: 1,
      description: 'Whenever a friendly LEGIONARY operative finishes retaliating, if it was '
        + 'not incapacitated, inflict D3 damage on the enemy operative in that sequence.',
      hooks: [{
        trigger: 'afterRetaliation',
        condition: { keyword: 'legionary' },
        effect: { type: 'inflictDamage', dice: 'D3', target: 'attacker' },
      }],
    }],
  },
];

/** Profiles the base pack has but the variant's roster does not name. */
function buildRoster(base, spec) {
  if (spec.roster) {
    const counts = new Map();
    for (const id of spec.roster) counts.set(id, (counts.get(id) || 0) + 1);
    return [...counts].map(([profileId, count]) => ({ profileId, count }));
  }

  const entries = base.roster.operatives.map((e) => ({ ...e }));
  if (spec.rosterLimit) {
    const total = entries.reduce((s, e) => s + (e.count ?? 1), 0);
    if (total > spec.rosterLimit) {
      // Trim to a cadre, keeping the leader and then whichever profiles the
      // variant says it is built around.
      const rank = (e) => {
        const p = base.operatives.find((o) => o.id === e.profileId);
        if ((p?.keywords || []).includes('leader')) return -1;
        const i = (spec.preferRoles || []).indexOf(p?.role);
        return i === -1 ? 99 : i;
      };
      entries.sort((a, b) => rank(a) - rank(b) || (a.profileId < b.profileId ? -1 : 1));
      const kept = [];
      let left = spec.rosterLimit;
      for (const e of entries) {
        if (left <= 0) break;
        const take = Math.min(e.count ?? 1, left);
        kept.push({ profileId: e.profileId, count: take });
        left -= take;
      }
      return kept;
    }
    if (total < spec.rosterLimit && spec.padWith) {
      const pad = entries.find((e) => e.profileId === spec.padWith);
      const extra = spec.rosterLimit - total;
      if (pad) pad.count = (pad.count ?? 1) + extra;
      else entries.push({ profileId: spec.padWith, count: extra });
    }
  }
  return entries;
}

function pick(list, drop, add) {
  const kept = (list || []).filter((p) => !(drop || []).includes(p.id));
  return [...kept, ...(add || [])];
}

let written = 0;
const catalogue = [];
for (const spec of VARIANTS) {
  const base = JSON.parse(fs.readFileSync(path.join(TEAMS, `${spec.base}.json`), 'utf8'));
  const roster = buildRoster(base, spec);

  for (const entry of roster) {
    if (!base.operatives.some((o) => o.id === entry.profileId)) {
      throw new Error(`${spec.id}: base pack has no profile "${entry.profileId}"`);
    }
  }
  const fielded = roster.reduce((s, e) => s + (e.count ?? 1), 0);
  const baseline = base.roster.operatives.reduce((s, e) => s + (e.count ?? 1), 0);
  if (fielded > baseline) {
    throw new Error(`${spec.id} fields ${fielded} against the base team's ${baseline}. `
      + 'With no points cost, a bigger list is not a variant — see the note above.');
  }

  const pack = {
    ...base,
    id: spec.id,
    displayName: spec.displayName,
    blurb: spec.blurb,
    /** What this is a variant OF, and how it differs — shown in the picker. */
    variantOf: base.id,
    variantOfName: base.displayName,
    variantNote: spec.note,
    dataVersion: TODAY,
    source: {
      publisher: 'Original synthetic data (this project)',
      checkedAt: TODAY,
      notes: `A variant roster assembled from the ${base.displayName} pack's own datacards. `
        + 'The profiles and weapons are unchanged; the roster, the disposition, the CP '
        + 'doctrine and the ploy list are this project\'s, not a published list.',
    },
    aiDisposition: spec.disposition,
    roster: {
      ...base.roster,
      maxOperatives: roster.reduce((s, e) => s + (e.count ?? 1), 0),
      operatives: roster,
    },
    strategicPloys: pick(base.strategicPloys, spec.dropStrategic, spec.addStrategic),
    firefightPloys: pick(base.firefightPloys, spec.dropFirefight, spec.addFirefight),
  };
  if (spec.doctrine) pack.aiCpDoctrine = spec.doctrine;

  // A signature that is always on is a FACTION RULE, not a ploy: it is not a
  // thing this team buys, it is the reason the variant exists. It goes in both
  // halves — the prose a reader checks against, and the hook the engine fires.
  if (spec.factionRule) {
    const { id, name, description, hook } = spec.factionRule;
    pack.factionRules = [...(base.factionRules || []), { id, name, description }];
    pack.ruleHooks = [...(base.ruleHooks || []), { id, rule: name, ...hook }];
  }

  fs.writeFileSync(path.join(TEAMS, `${spec.id}.json`), `${JSON.stringify(pack, null, 2)}\n`);
  written++;
  catalogue.push({ faction: spec.faction, id: spec.id, base: base.id });
}

// Each variant sits in the catalogue next to the team it came from, so the
// picker shows the two side by side rather than in a "variants" ghetto.
const factionsPath = path.join(ROOT, 'data', 'factions.json');
const factions = JSON.parse(fs.readFileSync(factionsPath, 'utf8'));
for (const { id, base } of catalogue) {
  const faction = factions.factions.find((f) => f.teams.includes(base));
  if (!faction) throw new Error(`no faction lists "${base}"`);
  if (!faction.teams.includes(id)) faction.teams.splice(faction.teams.indexOf(base) + 1, 0, id);
}
fs.writeFileSync(factionsPath, `${JSON.stringify(factions, null, 2)}\n`);

console.log(`wrote ${written} variants and listed them in the catalogue`);
