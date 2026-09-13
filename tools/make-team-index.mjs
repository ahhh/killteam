/**
 * Regenerate `data/team-index.json` — the picker's index of the bundled packs.
 *
 * The team picker needs a name, a faction and a support level for all 64
 * bundled teams; it needs the other 97% of a pack (operatives, weapons, rule
 * hooks, ploys, lore) only for the one team a player has actually selected.
 * Loading every pack up front to fill in a dropdown cost 1.9MB before the
 * screen could paint, so the index carries the picker's half and the packs
 * are fetched on selection (`ui/setup.js`).
 *
 * This file is GENERATED. Run it after adding or renaming a team, or after
 * changing a displayName, blurb, supportLevel or variant note:
 *
 *   node tools/make-team-index.mjs
 *
 * `test/team-index.test.mjs` fails if it is stale, so CI catches a forgotten
 * run rather than shipping a picker that is missing a team.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../test/harness.mjs';

export const OUT = 'data/team-index.json';

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

// Only write when run directly, so the test can import `buildIndex` and
// compare without rewriting the file it is checking.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const index = buildIndex();
  const out = path.join(ROOT, OUT);
  fs.writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`);
  const bytes = fs.statSync(out).size;
  const packs = fs.readdirSync(path.join(ROOT, 'data/teams'))
    .reduce((n, f) => n + fs.statSync(path.join(ROOT, 'data/teams', f)).size, 0);
  console.log(`wrote ${Object.keys(index.teams).length} teams to ${OUT}`);
  console.log(`  index ${(bytes / 1024).toFixed(1)}KB vs ${(packs / 1024).toFixed(0)}KB of packs`);
}
