/**
 * Flavour text: coverage in the bundled packs, and the sanitising it gets.
 *
 * `lore` is the only pack field that exists purely to be read. It is never
 * parsed, never reaches the engine, and is the longest string a pack can
 * carry — which makes it the most attractive place to hide markup in an
 * imported file, and the easiest field to forget when a team is added. Both
 * are pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DataRepository } from '../src/data/loader.js';
import { LIMITS } from '../src/data/schema.js';
import { readJson, loadTeam, ROOT } from './harness.mjs';

const teamFiles = fs.readdirSync(path.join(ROOT, 'data/teams')).filter((f) => f.endsWith('.json'));

test('every bundled team has team lore, within the length budget', () => {
  for (const file of teamFiles) {
    const pack = readJson(`data/teams/${file}`);
    assert.ok(pack.lore, `${pack.id} has no team lore`);
    assert.ok(pack.lore.length <= LIMITS.maxLoreLength,
      `${pack.id} team lore is ${pack.lore.length} > ${LIMITS.maxLoreLength}`);
  }
});

test('every operative in every bundled team has lore', () => {
  for (const file of teamFiles) {
    const pack = readJson(`data/teams/${file}`);
    for (const op of pack.operatives) {
      assert.ok(op.lore, `${pack.id}/${op.id} has no lore`);
      assert.ok(op.lore.length <= LIMITS.maxLoreLength,
        `${pack.id}/${op.id} lore is ${op.lore.length} > ${LIMITS.maxLoreLength}`);
    }
  }
});

test('a variant keeps its base team\'s operatives but tells its own story', () => {
  const variants = teamFiles
    .map((f) => readJson(`data/teams/${f}`))
    .filter((p) => p.variantOf);
  assert.ok(variants.length, 'the bundle ships variants');
  for (const variant of variants) {
    const base = loadTeam(variant.variantOf);
    // Same datacards, so the same people, so the same operative lore.
    for (const op of variant.operatives) {
      const twin = base.operatives.find((o) => o.id === op.id);
      assert.equal(op.lore, twin.lore, `${variant.id}/${op.id} drifted from its base`);
    }
    // A different plan for those people, so a different paragraph about them.
    assert.ok(variant.lore, `${variant.id} has no team lore`);
    assert.notEqual(variant.lore, base.lore,
      `${variant.id} is showing ${base.id}'s team lore`);
  }
});

test('imported lore is stripped of markup and capped, like every shown string', () => {
  const repo = new DataRepository();
  const pack = loadTeam('kommandos');
  pack.id = 'lore-probe';
  pack.lore = `<script>alert(1)</script>${'x'.repeat(LIMITS.maxLoreLength * 2)}`;
  pack.operatives[0].lore = '<img src=x onerror=y>a nasty one';

  const registered = repo.registerTeam(pack);
  assert.ok(!registered.lore.includes('<') && !registered.lore.includes('>'));
  assert.equal(registered.lore.length, LIMITS.maxLoreLength);
  assert.equal(registered.operatives[0].lore, 'img src=x onerror=ya nasty one');
});
