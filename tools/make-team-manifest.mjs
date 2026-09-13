/**
 * Regenerate `test/fixtures/team-capabilities.json` — the inventory the
 * regression suite locks in.
 *
 * `test/team-capabilities.test.mjs` asserts the live packs are a superset of
 * that file, so a rule can be added freely but never silently disappears. Run
 * this only when you MEANT to change what a pack supports, and read the diff
 * before committing it: every removed line is a rule that stopped working.
 *
 * Usage: node tools/make-team-manifest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTeam, ROOT } from '../test/harness.mjs';
import { capabilitiesOf } from './team-capabilities.mjs';

const OUT = path.join(ROOT, 'test/fixtures/team-capabilities.json');

const ids = fs.readdirSync(path.join(ROOT, 'data/teams'))
  .filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort();

const teams = {};
for (const id of ids) teams[id] = capabilitiesOf(loadTeam(id));

const totals = Object.values(teams).reduce((acc, t) => ({
  ruleHooks: acc.ruleHooks + t.ruleHooks.length,
  uniqueActions: acc.uniqueActions + t.uniqueActions.length,
  ployHooks: acc.ployHooks + t.ployHooks.length,
  resourceSpends: acc.resourceSpends + t.resourceSpends.length,
  weaponRules: acc.weaponRules + t.weaponRules.length,
}), { ruleHooks: 0, uniqueActions: 0, ployHooks: 0, resourceSpends: 0, weaponRules: 0 });

fs.writeFileSync(OUT, `${JSON.stringify({ teams }, null, 2)}\n`);
console.log(`wrote ${ids.length} teams to ${path.relative(ROOT, OUT)}`);
console.log(totals);
