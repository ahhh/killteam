/**
 * `data/team-index.json` and `data/map-index.json` are generated, and the
 * pickers are built from them, so a forgotten `npm run data:index` does not
 * fail loudly — it just quietly leaves a team or map out of a dropdown, or
 * shows it under a stale name. This is the check that turns that into a test
 * failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex, buildMapIndex, TEAM_OUT, MAP_OUT } from '../tools/make-data-index.mjs';
import { ROOT, readJson } from './harness.mjs';

const committed = readJson(TEAM_OUT);
const fresh = buildIndex();
const committedMaps = readJson(MAP_OUT);
const freshMaps = buildMapIndex();

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
    `data/team-index.json is stale — run: npm run data:index\n  ${stale.join('\n  ')}`);
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
  const indexBytes = fs.statSync(path.join(ROOT, TEAM_OUT)).size;
  const dir = path.join(ROOT, 'data/teams');
  const packBytes = fs.readdirSync(dir)
    .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  // Not a micro-benchmark — a tripwire. If the index ever grows to a
  // meaningful share of the packs, it has stopped being an index and the boot
  // saving has gone with it.
  assert.ok(indexBytes * 20 < packBytes,
    `index is ${(indexBytes / 1024).toFixed(1)}KB against ${(packBytes / 1024).toFixed(0)}KB of packs`);
});

/* --- The map index ----------------------------------------------------- */

test('the committed map index matches the maps on disk', () => {
  assert.deepEqual(committedMaps.maps, freshMaps.maps,
    'data/map-index.json is stale — run: npm run data:index');
});

test('every map the app offers is in the index', () => {
  // The app's MAPS constant is the list the picker walks; an id missing from
  // the index is a blank row in the dropdown.
  const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  const block = app.match(/const MAPS = \[([^\]]*)\]/s);
  assert.ok(block, 'could not find the MAPS constant in src/app.js');
  const ids = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.length, 'MAPS should name at least one map');
  for (const id of ids) {
    assert.ok(committedMaps.maps[id], `${id} is offered by the app but absent from the map index`);
    assert.ok(committedMaps.maps[id].name, `${id} has no name, so the picker would show a raw id`);
  }
});

test('the map index is a fraction of the maps it stands in for', () => {
  const indexBytes = fs.statSync(path.join(ROOT, MAP_OUT)).size;
  const dir = path.join(ROOT, 'data/maps');
  const mapBytes = fs.readdirSync(dir)
    .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(indexBytes * 20 < mapBytes,
    `index is ${(indexBytes / 1024).toFixed(1)}KB against ${(mapBytes / 1024).toFixed(0)}KB of maps`);
});
