/**
 * `data/team-index.json` is generated, and the picker is built from it, so a
 * forgotten `node tools/make-team-index.mjs` does not fail loudly — it just
 * quietly leaves a team out of the dropdown, or shows it under a stale name.
 * This is the check that turns that into a test failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex, OUT } from '../tools/make-team-index.mjs';
import { ROOT, readJson } from './harness.mjs';

const committed = readJson(OUT);
const fresh = buildIndex();

test('the committed team index matches the packs on disk', () => {
  const stale = [];
  for (const [id, entry] of Object.entries(fresh.teams)) {
    const have = committed.teams[id];
    if (!have) { stale.push(`${id}: missing from the index`); continue; }
    if (JSON.stringify(have) !== JSON.stringify(entry)) {
      stale.push(`${id}: ${JSON.stringify(have)} != ${JSON.stringify(entry)}`);
    }
  }
  for (const id of Object.keys(committed.teams)) {
    if (!fresh.teams[id]) stale.push(`${id}: in the index but has no pack`);
  }
  assert.deepEqual(stale, [],
    `data/team-index.json is stale — run: node tools/make-team-index.mjs\n  ${stale.join('\n  ')}`);
});

test('every team the catalogue offers is in the index', () => {
  const catalogue = readJson('data/factions.json');
  const missing = catalogue.factions
    .flatMap((f) => f.teams)
    .filter((id) => !committed.teams[id]);
  assert.deepEqual(missing, [],
    'the picker would show these as raw ids, or fail to load them at all');
});

test('every pack on disk carries the fields the picker reads', () => {
  const dir = path.join(ROOT, 'data/teams');
  const bad = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!pack.displayName) bad.push(`${file}: no displayName`);
    if (!pack.factionId) bad.push(`${file}: no factionId`);
    if (pack.id !== file.replace(/\.json$/, '')) {
      bad.push(`${file}: id "${pack.id}" does not match its filename, so the picker cannot fetch it`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the index is a fraction of the packs it stands in for', () => {
  const indexBytes = fs.statSync(path.join(ROOT, OUT)).size;
  const dir = path.join(ROOT, 'data/teams');
  const packBytes = fs.readdirSync(dir)
    .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  // Not a micro-benchmark — a tripwire. If the index ever grows to a
  // meaningful share of the packs, it has stopped being an index and the boot
  // saving has gone with it.
  assert.ok(indexBytes * 20 < packBytes,
    `index is ${(indexBytes / 1024).toFixed(1)}KB against ${(packBytes / 1024).toFixed(0)}KB of packs`);
});
