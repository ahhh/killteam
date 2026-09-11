/**
 * Team variants: a second way to field a team that is already in the
 * catalogue. The engine has no idea these exist — a variant is data — so what
 * is worth testing is that each one is still honestly derived from its base
 * and still actually different from it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readJson, loadTeam, ROOT } from './harness.mjs';
import { validateTeamPack } from '../src/data/validators.js';
import { dispositionForPack } from '../src/ai/tactics.js';

const ids = fs.readdirSync(`${ROOT}/data/teams`)
  .map((f) => f.replace('.json', ''))
  .filter((id) => loadTeam(id).variantOf);

const size = (pack) => pack.roster.operatives.reduce((s, e) => s + (e.count ?? 1), 0);
const ployIds = (pack) => [
  ...(pack.strategicPloys || []), ...(pack.firefightPloys || []),
].map((p) => p.id).sort();

test('the catalogue ships variants at all', () => {
  assert.ok(ids.length >= 6, `expected variants, found ${ids.length}`);
});

for (const id of ids) {
  const pack = loadTeam(id);
  const base = loadTeam(pack.variantOf);

  test(`${id} is a valid pack`, () => {
    const report = validateTeamPack(pack);
    assert.equal(report.ok, true, report.errors.join('; '));
  });

  test(`${id} fields only profiles its base pack prints`, () => {
    for (const entry of pack.roster.operatives) {
      assert.ok(base.operatives.some((o) => o.id === entry.profileId),
        `${entry.profileId} is not a ${base.id} datacard`);
    }
    // The datacards themselves must be untouched — a variant is a roster and a
    // plan, never a stat change, or it is a new team pretending to be one.
    assert.deepEqual(pack.operatives, base.operatives);
  });

  test(`${id} tells a player what it changed`, () => {
    assert.ok(pack.variantNote && pack.variantNote.length > 20, 'needs a variant note');
    assert.ok(pack.variantOfName, 'needs the base team name for the picker');
    assert.match(pack.source.publisher, /this project/,
      'a variant roster is this project\'s invention and must say so');
  });

  test(`${id} actually fights differently from ${base.id}`, () => {
    const differences = [
      size(pack) !== size(base),
      JSON.stringify(pack.roster.operatives) !== JSON.stringify(base.roster.operatives),
      dispositionForPack(pack).label !== dispositionForPack(base).label,
      (pack.aiCpDoctrine ?? null) !== (base.aiCpDoctrine ?? null),
      JSON.stringify(ployIds(pack)) !== JSON.stringify(ployIds(base)),
      (pack.ruleHooks || []).length !== (base.ruleHooks || []).length,
    ].filter(Boolean).length;
    // Roster alone is not enough: a variant the AI plays identically is just a
    // shorter list, and the picker would be promising something it cannot show.
    assert.ok(differences >= 3,
      `${id} differs from its base in only ${differences} way(s)`);
  });
}

test('no variant fields more operatives than the team it came from', () => {
  // Kill Team prices a bigger list with points and this simulator has none, so
  // "the same team but bigger" is not a variant — it is a better list, and it
  // would poison every batch result it appeared in. Measured: a nine-strong
  // Legionary Warband won 92% against a pool where the six-strong base won 51%.
  for (const id of ids) {
    const pack = loadTeam(id);
    assert.ok(size(pack) <= size(loadTeam(pack.variantOf)),
      `${id} fields ${size(pack)} against its base's ${size(loadTeam(pack.variantOf))}`);
  }
});

test('every variant is listed in the catalogue, next to the team it came from', () => {
  const factions = readJson('data/factions.json').factions;
  for (const id of ids) {
    const pack = loadTeam(id);
    const faction = factions.find((f) => f.teams.includes(id));
    assert.ok(faction, `${id} is in no faction`);
    assert.ok(faction.teams.includes(pack.variantOf),
      `${id} should sit alongside ${pack.variantOf}`);
  }
});

test('every operative a variant fields is already drawn, under its base team', () => {
  // A variant owns no art and never will: it fields its base team's datacards,
  // so ui/portraits.js asks the manifest about the BASE id (artTeamId). What
  // that leaves worth checking is the other half — that the base team really
  // has a picture, at all three sizes, for every profile the variant fields.
  const manifest = readJson('assets/portraits/manifest.json');
  for (const id of ids) {
    const pack = loadTeam(id);
    const drawn = manifest.teams[pack.variantOf] || [];
    for (const entry of pack.roster.operatives) {
      assert.ok(drawn.includes(entry.profileId),
        `${id} fields ${entry.profileId}, which ${pack.variantOf} has no art for`);
      for (const dir of ['portraits', 'tokens', 'pips']) {
        const file = `${ROOT}/assets/${dir}/${pack.variantOf}/${entry.profileId}.webp`;
        assert.ok(fs.existsSync(file), `missing ${dir} art: ${file}`);
      }
    }
  }
});
