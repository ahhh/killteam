/**
 * Which animation a weapon, a ploy or a token asks for.
 *
 * Everything here is a pure function of the EFFECTS MANIFEST — the file
 * tools/make-effects.py writes next to the sprite sheets. The manifest carries
 * the same pattern tables the generator classified with, so a weapon is sorted
 * into the same family on both sides and a sheet can never exist for a weapon
 * that no longer maps to it. Nothing in this module touches the DOM, the
 * engine or the state store, which is what makes it testable without either.
 *
 * The contract is one function — weaponEffects() — returning up to three
 * families for one weapon:
 *
 *   projectile   what flies from the shooter to the target
 *   aoe          what happens at the far end, or instead of a projectile
 *   melee        a swing, for anything with type "melee"
 *
 * See src/ui/effects.js for playback, and tools/make-effects.py for the art.
 */

/** `Hot‑shot long‑las (mobile)` -> `hot shot long las mobile`. */
export function normaliseName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** `blast2` -> `blast`. A weapon rule carries its value in the token. */
export function ruleName(rule) {
  return String(rule ?? '').toLowerCase().replace(/[0-9]+$/, '');
}

/**
 * Compile the manifest's ranged patterns once per manifest.
 *
 * Held on a WeakMap rather than a module variable so a test can hand in two
 * different manifests without either poisoning the other.
 */
const compiledCache = new WeakMap();

function compiled(manifest) {
  let table = compiledCache.get(manifest);
  if (!table) {
    table = (manifest?.match?.ranged || []).map(([source, family]) => ({
      re: new RegExp(source), family,
    }));
    compiledCache.set(manifest, table);
  }
  return table;
}

/** The family a ranged weapon's NAME puts it in, before its rules are read. */
export function rangedFamily(manifest, name) {
  const text = normaliseName(name);
  for (const { re, family } of compiled(manifest)) {
    if (re.test(text)) return family;
  }
  return manifest?.match?.rangedFallback ?? null;
}

/** `cone`, `blast` or null: what this weapon's RULES make of the attack. */
export function aoeKind(manifest, rules) {
  const table = manifest?.match?.aoeRules || {};
  for (const rule of rules || []) {
    const family = table[ruleName(rule)];
    if (family) return family;
  }
  return null;
}

const NOTHING = { projectile: null, aoe: null, melee: null };

/**
 * What one weapon puts on the board.
 *
 * Torrent replaces the shot with a cone — of fire for a flamer, of rounds for
 * everything else, because Torrent is also how this game writes "sweeping
 * fire" and a heavy bolter drawn as a flamethrower would be a lie. Blast keeps
 * the shot and detonates at the end of it.
 */
export function weaponEffects(manifest, weapon) {
  if (!manifest || !weapon) return NOTHING;
  if (weapon.type === 'melee') return { projectile: null, aoe: null, melee: 'strike' };

  const base = rangedFamily(manifest, weapon.name);
  const aoe = aoeKind(manifest, weapon.rules);
  const cone = manifest.match?.cone || {};
  if (aoe === 'cone') {
    return { projectile: null, aoe: cone[base] || cone.default || null, melee: null };
  }
  // A flamer with no Torrent rule printed is still a flamer.
  if (base === 'flame') return { projectile: null, aoe: 'flame', melee: null };
  return { projectile: base, aoe: aoe === 'blast' ? 'blast' : null, melee: null };
}

/** The mark a ploy makes, from the first hook effect the manifest knows. */
export function ployFamily(manifest, ploy) {
  const table = manifest?.match?.ployEffects || {};
  for (const hook of ploy?.hooks || []) {
    const family = table[hook?.effect?.type];
    if (family) return family;
  }
  return null;
}

/** The loop an operative carrying this token wears. */
export function tokenFamily(manifest, token) {
  const kind = typeof token === 'string' ? token : token?.kind;
  return (manifest?.match?.tokens || {})[kind] || null;
}

/** One ploy out of a pack, by id, whichever list it is in. */
export function findPloyInPack(pack, ployId) {
  for (const field of ['strategicPloys', 'firefightPloys']) {
    const found = (pack?.[field] || []).find((p) => p.id === ployId);
    if (found) return { ploy: found, field };
  }
  return { ploy: null, field: null };
}

/**
 * Every family this ONE team pack could ever put on the board.
 *
 * This is the whole point of the feature's budget: a battle fetches the sheets
 * for the two packs actually being fielded and no others. A Kasrkin/Kommandos
 * game never asks for `psychic`, and a game with no flamers on either side
 * never pays for the cone.
 *
 * It mirrors scan_usage() in tools/make-effects.py — that decides which sheets
 * exist at all, this decides which of them this battle loads.
 */
export function familiesForPack(manifest, pack) {
  const out = new Set();
  if (!manifest || !pack) return out;
  const add = (family) => { if (family) out.add(family); };

  for (const operative of pack.operatives || []) {
    for (const weapon of operative.weapons || []) {
      const spec = weaponEffects(manifest, weapon);
      if (spec.melee) { add('strike'); add('parry'); continue; }
      add(spec.projectile);
      add(spec.aoe);
    }
  }

  for (const field of ['strategicPloys', 'firefightPloys']) {
    for (const ploy of pack[field] || []) {
      const family = ployFamily(manifest, ploy);
      add(family);
      // A defensive ploy bought for an activation stays visible while it lasts.
      if (family === 'ward' && field === 'firefightPloys') add('shield');
      // A strategic ploy is in force over a whole team for a whole turning
      // point, which is the definition of an area buff.
      if (field === 'strategicPloys' && (ploy.hooks || []).length) add('aura');
    }
  }

  // Token loops are declared inside the pack's own weapon-rule readings.
  const declared = JSON.stringify(pack.weaponRules || {});
  for (const kind of Object.keys(manifest.match?.tokens || {})) {
    if (declared.includes(`"${kind}"`)) add(manifest.match.tokens[kind]);
  }

  return out;
}

/** The union over both teams on the board. */
export function familiesForPacks(manifest, packs) {
  const out = new Set();
  for (const pack of Object.values(packs || {})) {
    for (const family of familiesForPack(manifest, pack)) out.add(family);
  }
  return out;
}
