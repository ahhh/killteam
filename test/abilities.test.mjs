/**
 * Ability text: coverage in the bundled packs, and the sanitising it gets.
 *
 * An operative's abilities are the half of a character sheet the stat table
 * cannot say. The sheet prints each one's `description` in full, which makes
 * it a displayed string like `lore` — so it is pinned the same way: every
 * ability must have one, and an imported one is scrubbed and capped before it
 * is ever shown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DataRepository } from '../src/data/loader.js';
import { LIMITS } from '../src/data/schema.js';
import { readJson, loadTeam, ROOT } from './harness.mjs';

const teamFiles = fs.readdirSync(path.join(ROOT, 'data/teams')).filter((f) => f.endsWith('.json'));

function abilitiesOf(pack) {
  return pack.operatives.flatMap((op) =>
    (op.abilities || []).map((ability) => ({ op, ability })));
}

test('every ability in every bundled team says what it does', () => {
  for (const file of teamFiles) {
    const pack = readJson(`data/teams/${file}`);
    for (const { op, ability } of abilitiesOf(pack)) {
      const where = `${pack.id}/${op.id}/${ability.name ?? ability.id ?? '?'}`;
      assert.equal(typeof ability, 'object', `${where} is not an ability object`);
      assert.ok(ability.name, `${where} has no name`);
      const text = (ability.description || '').trim();
      assert.ok(text, `${where} has no description`);
      assert.ok(text.length <= LIMITS.maxRuleTextLength,
        `${where} description is ${text.length} > ${LIMITS.maxRuleTextLength}`);
    }
  }
});

test('the bundle actually exercises this — abilities exist to describe', () => {
  const total = teamFiles
    .map((f) => readJson(`data/teams/${f}`))
    .reduce((n, pack) => n + abilitiesOf(pack).length, 0);
  assert.ok(total > 200, `only ${total} abilities in the bundle`);
});

test('a variant shows the same ability text as the team it came from', () => {
  const variants = teamFiles
    .map((f) => readJson(`data/teams/${f}`))
    .filter((p) => p.variantOf);
  assert.ok(variants.length, 'the bundle ships variants');
  for (const variant of variants) {
    const base = loadTeam(variant.variantOf);
    for (const op of variant.operatives) {
      const twin = base.operatives.find((o) => o.id === op.id);
      if (!twin) continue;
      for (const ability of op.abilities || []) {
        const match = (twin.abilities || []).find((a) => a.id === ability.id);
        if (!match) continue;
        assert.equal(ability.description, match.description,
          `${variant.id}/${op.id}/${ability.id} drifted from ${base.id}`);
      }
    }
  }
});

test('imported ability text is stripped of markup and capped, like every shown string', () => {
  const repo = new DataRepository();
  const pack = loadTeam('kommandos');
  const victim = pack.operatives.find((op) => (op.abilities || []).length);
  assert.ok(victim, 'the fixture team has an ability to work with');
  victim.abilities[0].description = `<img src=x onerror=alert(1)>${'x'.repeat(4000)}`;

  const registered = repo.registerTeam(pack, { source: 'imported' });
  const text = registered.operatives.find((op) => op.id === victim.id).abilities[0].description;
  assert.ok(!text.includes('<') && !text.includes('>'), 'markup survived import');
  assert.equal(text.length, LIMITS.maxRuleTextLength, 'over-long ability text was not capped');
});
