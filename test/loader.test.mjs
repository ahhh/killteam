/**
 * `DataRepository` against a stubbed `fetch`.
 *
 * The repository is the one module the rest of the suite only ever stubs, so
 * until now nothing checked the code that actually puts data in front of the
 * engine. These tests serve the real bundled JSON through a fake `fetch`, so
 * the real validators run on the real packs.
 *
 * What they pin down is mostly ORDER and CONCURRENCY: `_loadMany` overlaps its
 * fetches, and the map picker is built by iterating `repo.maps` directly, so
 * registering in completion order would quietly reshuffle that dropdown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DataRepository, DataLoadError } from '../src/data/loader.js';
import { ROOT } from './harness.mjs';

/**
 * Serve ./data off the disk, recording what was asked for and how much of it
 * was in flight at once.
 */
function stubFetch({ delay = 0, fail = null } = {}) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const previous = globalThis.fetch;

  globalThis.fetch = async (url) => {
    calls.push(url);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const rel = String(url).replace(/^\.\//, '');
      if (fail && rel.includes(fail)) {
        return { ok: false, status: 404, statusText: 'Not Found' };
      }
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(text) };
    } finally {
      inFlight -= 1;
    }
  };

  return {
    calls,
    peak: () => peak,
    restore: () => { globalThis.fetch = previous; },
  };
}

const MAPS = ['industrial-001', 'spacehulk-001', 'jungle-temple-001'];

test('loadMaps registers in the order asked for, not the order they arrive', async () => {
  // Stagger the replies so completion order is the reverse of request order:
  // a repository that registered as they landed would fail this.
  const previous = globalThis.fetch;
  const delays = { 'industrial-001': 30, 'spacehulk-001': 15, 'jungle-temple-001': 1 };
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^\.\//, '');
    const id = path.basename(rel, '.json');
    await new Promise((r) => setTimeout(r, delays[id] ?? 0));
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) };
  };
  try {
    const repo = new DataRepository();
    await repo.loadMaps(MAPS);
    assert.deepEqual([...repo.maps.keys()], MAPS);
  } finally {
    globalThis.fetch = previous;
  }
});

test('loadMaps fetches concurrently rather than one at a time', async () => {
  const stub = stubFetch({ delay: 5 });
  try {
    const repo = new DataRepository();
    await repo.loadMaps(MAPS);
    assert.equal(stub.peak(), MAPS.length, 'every map should be in flight at once');
  } finally {
    stub.restore();
  }
});

test('loadMany skips ids already in the cache', async () => {
  const stub = stubFetch();
  try {
    const repo = new DataRepository();
    await repo.loadMaps(MAPS);
    const first = stub.calls.length;
    const again = await repo.loadMaps(MAPS);
    assert.equal(stub.calls.length, first, 'a cached id must not be refetched');
    assert.equal(again.length, MAPS.length, 'cached ids still come back');
    assert.deepEqual(again.map((m) => m.id), MAPS);
  } finally {
    stub.restore();
  }
});

test('loadMany returns the packs in the order asked for', async () => {
  const stub = stubFetch();
  try {
    const repo = new DataRepository();
    const maps = await repo.loadMaps(MAPS);
    assert.deepEqual(maps.map((m) => m.id), MAPS);
  } finally {
    stub.restore();
  }
});

test('a failed fetch surfaces as a DataLoadError', async () => {
  const stub = stubFetch({ fail: 'spacehulk-001' });
  try {
    const repo = new DataRepository();
    await assert.rejects(() => repo.loadMaps(MAPS), DataLoadError);
  } finally {
    stub.restore();
  }
});

test('the bundled catalogue loads every team it names', async () => {
  const stub = stubFetch();
  try {
    const repo = new DataRepository();
    await repo.loadCatalogue();
    const ids = repo.catalogueTeamIds();
    assert.ok(ids.length > 20, `catalogue should name the bundled teams (got ${ids.length})`);
    await repo.loadTeams(ids);
    for (const id of ids) {
      assert.ok(repo.teams.has(id), `${id} should be loaded`);
      assert.equal(repo.reportFor('team', id)?.ok, true, `${id} should validate`);
    }
    assert.equal(repo.customTeams.size, 0, 'bundled packs are not custom');
  } finally {
    stub.restore();
  }
});
