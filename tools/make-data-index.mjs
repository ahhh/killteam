/**
 * Regenerate the pickers' indexes — `data/team-index.json` and
 * `data/map-index.json`.
 *
 * The team picker needs a name, a faction and a support level for all 64
 * bundled teams; it needs the other 97% of a pack (operatives, weapons, rule
 * hooks, ploys, lore) only for the one team a player has actually selected.
 * Loading every pack up front to fill in a dropdown cost 1.9MB before the
 * screen could paint, so the index carries the picker's half and the packs
 * are fetched on selection (`ui/setup.js`).
 *
 * The map picker has the same shape and the same problem, at a smaller scale:
 * it needs a name and a blurb for five maps and the terrain polygons of only
 * the one being played.
 *
 * These files are GENERATED. Run this after adding or renaming a team or map,
 * or after changing a displayName, name, blurb, supportLevel or variant note:
 *
 *   npm run data:index
 *
 * `test/data-index.test.mjs` fails if either is stale, so CI catches a
 * forgotten run rather than shipping a picker that is missing an entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../test/harness.mjs';

export const TEAM_OUT = 'data/team-index.json';
export const MAP_OUT = 'data/map-index.json';

/** The fields the picker reads before a team is selected — and no more. */
export function indexEntry(pack) {
  const entry = {
    id: pack.id,
    displayName: pack.displayName ?? pack.id,
    factionId: pack.factionId ?? null,
    supportLevel: pack.supportLevel ?? 0,
  };
  // Variant fields are what the dropdown uses to sit a variant under the team
  // it came from, so they belong in the index rather than the pack fetch.
  if (pack.variantOf) entry.variantOf = pack.variantOf;
  if (pack.variantOfName) entry.variantOfName = pack.variantOfName;
  return entry;
}

/** The fields the map picker reads before a map is loaded — and no more. */
export function mapEntry(map) {
  const entry = { id: map.id, name: map.name ?? map.id };
  if (map.blurb) entry.blurb = map.blurb;
  return entry;
}

export function buildIndex(root = ROOT) {
  const dir = path.join(root, 'data/teams');
  const ids = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

  const teams = {};
  for (const id of ids) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    teams[pack.id ?? id] = indexEntry(pack);
  }
  return { schemaVersion: 1, teams };
}

/**
 * Every module reachable from `src/app.js`, in the order the browser would
 * discover them. The preload hints in index.html must name exactly this set:
 * a stale entry is a 404 on every page load, a missing one restores the
 * four-wave import waterfall those hints exist to flatten.
 */
export function moduleGraph(root = ROOT, entry = 'src/app.js') {
  const seen = new Set();
  const order = [];
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    order.push(rel);
    const dir = path.dirname(rel);
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      walk(path.normalize(path.join(dir, m[1])));
    }
  };
  walk(entry);
  return order;
}

/** The `<link rel="modulepreload">` block index.html should carry. */
export function preloadTags(root = ROOT) {
  return moduleGraph(root)
    .filter((m) => m !== 'src/app.js')
    .map((m) => `<link rel="modulepreload" href="${m}">`)
    .join('\n');
}

// Explicit markers, not prose: the generated block used to be delimited by
// the wording of the comment after it, which meant editing that comment broke
// the generator.
const PRELOAD_START = '<!-- BEGIN modulepreload (generated) -->';
const PRELOAD_END = '<!-- END modulepreload -->';

/** Rewrite the generated hint block in index.html, leaving the rest alone. */
export function writePreloads(root = ROOT) {
  const file = path.join(root, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const from = html.indexOf(PRELOAD_START);
  const to = html.indexOf(PRELOAD_END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error('index.html preload block not found — did its comments change?');
  }
  const next = `${html.slice(0, from)}${PRELOAD_START}\n${preloadTags(root)}\n${html.slice(to)}`;
  fs.writeFileSync(file, next);
  return next;
}

export function buildMapIndex(root = ROOT) {
  const dir = path.join(root, 'data/maps');
  const maps = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const map = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    maps[map.id ?? file.replace(/\.json$/, '')] = mapEntry(map);
  }
  return { schemaVersion: 1, maps };
}

// Only write when run directly, so the tests can import the builders and
// compare without rewriting the files they are checking.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dirBytes = (rel) => fs.readdirSync(path.join(ROOT, rel))
    .reduce((n, f) => n + fs.statSync(path.join(ROOT, rel, f)).size, 0);

  for (const [out, index, source, count] of [
    [TEAM_OUT, buildIndex(), 'data/teams', 'teams'],
    [MAP_OUT, buildMapIndex(), 'data/maps', 'maps'],
  ]) {
    fs.writeFileSync(path.join(ROOT, out), `${JSON.stringify(index, null, 2)}\n`);
    const bytes = fs.statSync(path.join(ROOT, out)).size;
    console.log(`wrote ${Object.keys(index[count]).length} ${count} to ${out}`);
    console.log(`  index ${(bytes / 1024).toFixed(1)}KB vs ${(dirBytes(source) / 1024).toFixed(0)}KB of ${count}`);
  }

  writePreloads();
  console.log(`rewrote ${moduleGraph().length - 1} modulepreload hints in index.html`);
}
