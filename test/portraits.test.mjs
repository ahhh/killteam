/**
 * Portrait loading, driven against a hand-rolled DOM stub.
 *
 * The point of ui/portraits.js is a negative: 470 portraits, ~25MB, must NOT
 * be touched until a character sheet is opened. That is invisible in the UI
 * until someone loads the site on a phone, so it is asserted here — counting
 * fetches and <img> src assignments rather than looking at pictures.
 *
 * There is no browser in the test run and no jsdom in this project, so the stub
 * implements only what portraits.js actually touches (see setup-screen.test.mjs
 * for the same approach).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from './harness.mjs';

/* ------------------------------------------------------------------ */
/* A DOM and a network small enough to read                            */
/* ------------------------------------------------------------------ */

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.listeners = {};
    this.removed = false;
    this.classList = {
      add: (c) => { this.className = `${this.className} ${c}`.trim(); },
      contains: (c) => this.className.split(' ').includes(c),
    };
  }

  append(...nodes) { this.children.push(...nodes); }
  remove() { this.removed = true; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn({}); }

  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
}

/** Load a FRESH copy of the module, since its manifest cache is module-level. */
async function freshModule() {
  return import(`../src/ui/portraits.js?v=${Math.random()}`);
}

/**
 * Install the stubs, run `fn`, and hand back the fetch log.
 *
 * `manifest` may be an object (served as the manifest), or null to make the
 * request fail — the case where the art pipeline has never been run.
 */
async function withStubs(manifest, fn) {
  const previousDoc = globalThis.document;
  const previousFetch = globalThis.fetch;
  const fetched = [];
  globalThis.document = { createElement: (tag) => new StubNode(tag) };
  globalThis.fetch = async (url) => {
    fetched.push(url);
    if (!manifest) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => manifest };
  };
  try {
    return await fn(fetched, await freshModule());
  } finally {
    globalThis.document = previousDoc;
    globalThis.fetch = previousFetch;
  }
}

const PACK = readJson('data/teams/kommandos.json');
const PROFILE = PACK.operatives[0];
const MANIFEST = {
  version: 1,
  ext: '.webp',
  teams: { kommandos: [PROFILE.id] },
};

/** Every image URL the given subtree would actually request. */
function imageSources(node) {
  return [...node.walk()].filter((n) => n.tagName === 'IMG').map((n) => n.src);
}

/* ------------------------------------------------------------------ */

test('importing the module fetches nothing', async () => {
  await withStubs(MANIFEST, async (fetched) => {
    assert.deepEqual(fetched, [], 'module import must not touch the network');
  });
});

test('the manifest is fetched once, however many sheets are opened', async () => {
  await withStubs(MANIFEST, async (fetched, mod) => {
    for (let i = 0; i < 5; i += 1) mod.createPortrait(PACK, PROFILE);
    await mod.loadManifest();
    for (let i = 0; i < 5; i += 1) mod.createPortrait(PACK, PROFILE);
    assert.equal(fetched.length, 1, `expected one manifest fetch, got ${fetched.length}`);
    assert.match(fetched[0], /assets\/portraits\/manifest\.json$/);
  });
});

test('opening one sheet requests exactly one portrait', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    const figure = mod.createPortrait(PACK, PROFILE);
    const sources = imageSources(figure);
    assert.equal(sources.length, 1);
    assert.equal(sources[0],
      `./assets/portraits/kommandos/${PROFILE.id}.webp`);
  });
});

test('an operative missing from the manifest builds no image at all', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    const undrawn = PACK.operatives.find((p) => p.id !== PROFILE.id);
    assert.equal(mod.createPortrait(PACK, undrawn), null);
    assert.notEqual(mod.createPortrait(PACK, PROFILE), null);
  });
});

test('with no manifest, portraits are still attempted and 404s self-remove', async () => {
  await withStubs(null, async (_fetched, mod) => {
    await mod.loadManifest();
    const figure = mod.createPortrait(PACK, PROFILE);
    assert.notEqual(figure, null, 'a missing manifest must not hide all art');
    const img = figure.find((n) => n.tagName === 'IMG');
    img.dispatch('error');
    assert.equal(figure.removed, true, 'a 404 portrait must take itself off screen');
  });
});

test('a failed manifest fetch is not retried on every sheet', async () => {
  await withStubs(null, async (fetched, mod) => {
    await mod.loadManifest();
    for (let i = 0; i < 4; i += 1) mod.createPortrait(PACK, PROFILE);
    await mod.loadManifest();
    assert.equal(fetched.length, 1, 'one failure must not become one request per click');
  });
});

test('the image is marked lazy and reveals itself on load', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    const figure = mod.createPortrait(PACK, PROFILE);
    const img = figure.find((n) => n.tagName === 'IMG');
    assert.equal(img.loading, 'lazy');
    assert.equal(img.decoding, 'async');
    assert.equal(figure.classList.contains('loaded'), false);
    img.dispatch('load');
    assert.equal(figure.classList.contains('loaded'), true);
  });
});

test('ids with characters that need escaping produce a valid URL', async () => {
  await withStubs({ version: 1, ext: '.webp', teams: { 'a b': ['c d'] } },
    async (_fetched, mod) => {
      await mod.loadManifest();
      const figure = mod.createPortrait({ id: 'a b' }, { id: 'c d', name: 'C D' });
      assert.equal(imageSources(figure)[0], './assets/portraits/a%20b/c%20d.webp');
    });
});
