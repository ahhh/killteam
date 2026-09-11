/**
 * Art loading, driven against a hand-rolled DOM stub.
 *
 * The point of ui/portraits.js is a negative: 484 portraits, ~38MB, must NOT
 * be touched until a character sheet is opened, and the roster's head tokens
 * must stay on the cheap side of that line. Both are invisible in the UI until
 * someone loads the site on a phone, so they are asserted here — counting
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
    this.parent = null;
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

  append(...nodes) {
    for (const n of nodes) {
      // Appending MOVES a node, as the real DOM does — ui/portraits.js reuses
      // one token element across roster rebuilds and relies on it.
      if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
      n.parent = this;
      this.children.push(n);
    }
  }
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

/* ------------------------------------------------------------------ */
/* Roster head tokens                                                  */
/* ------------------------------------------------------------------ */

test('a roster token points at the cropped art, not the full portrait', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    const figure = mod.createOperativeToken(PACK, PROFILE, 'p1-op1');
    assert.equal(imageSources(figure)[0],
      `./assets/tokens/kommandos/${PROFILE.id}.webp`);
  });
});

test('a token is lazy, and decorative to a screen reader', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    const img = mod.createOperativeToken(PACK, PROFILE, 'p1-op1')
      .find((n) => n.tagName === 'IMG');
    assert.equal(img.loading, 'lazy');
    assert.equal(img.decoding, 'async');
    // The card prints the name already; a second announcement is noise.
    assert.equal(img.alt, '');
  });
});

test('an operative missing from the manifest gets no token', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    const undrawn = PACK.operatives.find((p) => p.id !== PROFILE.id);
    assert.equal(mod.createOperativeToken(PACK, undrawn, 'p1-op2'), null);
  });
});

test('rebuilding the roster reuses one element per operative', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    const first = mod.createOperativeToken(PACK, PROFILE, 'p1-op1');
    for (let i = 0; i < 20; i += 1) {
      assert.equal(mod.createOperativeToken(PACK, PROFILE, 'p1-op1'), first,
        'a fresh <img> per render would restart the fade on every action');
    }
    // Two operatives sharing one profile must NOT share one element, or the
    // second card would steal the first card's picture.
    assert.notEqual(mod.createOperativeToken(PACK, PROFILE, 'p1-op2'), first);
  });
});

test('a 404 token self-removes and is not handed out again', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    const figure = mod.createOperativeToken(PACK, PROFILE, 'p1-op1');
    figure.find((n) => n.tagName === 'IMG').dispatch('error');
    assert.equal(figure.removed, true);
    assert.notEqual(mod.createOperativeToken(PACK, PROFILE, 'p1-op1'), figure,
      'the removed element must not be served from cache');
  });
});

test('building a whole roster of tokens fetches only the manifest', async () => {
  await withStubs(MANIFEST, async (fetched, mod) => {
    for (let i = 0; i < 12; i += 1) {
      mod.createOperativeToken(PACK, PROFILE, `p1-op${i}`);
    }
    await mod.loadManifest();
    assert.equal(fetched.length, 1, 'tokens must not each trigger a fetch()');
  });
});

/* ------------------------------------------------------------------ */
/* Battlefield pips, and the art a variant borrows                     */
/* ------------------------------------------------------------------ */

test('a battlefield pip is its own, smaller set of files', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    assert.equal(mod.operativePipUrl(PACK, PROFILE.id),
      `./assets/pips/kommandos/${PROFILE.id}.webp`);
  });
});

test('an operative missing from the manifest gets no pip', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    const undrawn = PACK.operatives.find((p) => p.id !== PROFILE.id);
    assert.equal(mod.operativePipUrl(PACK, undrawn.id), null);
  });
});

test('a whole board of pips costs one fetch, for the manifest', async () => {
  await withStubs(MANIFEST, async (fetched, mod) => {
    for (let i = 0; i < 20; i += 1) mod.operativePipUrl(PACK, PROFILE.id);
    await mod.loadManifest();
    assert.equal(fetched.length, 1);
  });
});

/**
 * A variant fields its base team's datacards, so it is the same operatives and
 * the same pictures — drawn once, under the base team's id. Nothing generates
 * a second copy of the art for the variant, and the manifest never lists it.
 */
const VARIANT = readJson('data/teams/kommandos-dakka.json');

test('a variant draws its base team\'s art at all three sizes', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    assert.equal(VARIANT.variantOf, 'kommandos', 'fixture must be a kommandos variant');
    assert.equal(mod.artTeamId(VARIANT), 'kommandos');

    const portrait = mod.createPortrait(VARIANT, PROFILE);
    assert.equal(imageSources(portrait)[0],
      `./assets/portraits/kommandos/${PROFILE.id}.webp`);

    const token = mod.createOperativeToken(VARIANT, PROFILE, 'p2-op1');
    assert.equal(imageSources(token)[0], `./assets/tokens/kommandos/${PROFILE.id}.webp`);

    assert.equal(mod.operativePipUrl(VARIANT, PROFILE.id),
      `./assets/pips/kommandos/${PROFILE.id}.webp`);
  });
});

test('a variant is not treated as an undrawn team', async () => {
  await withStubs(MANIFEST, async (_fetched, mod) => {
    await mod.loadManifest();
    // The manifest lists `kommandos` and nothing else. Asking about the variant
    // by its own id is exactly the bug this indirection exists to prevent.
    assert.equal(mod.hasPortrait(VARIANT.id, PROFILE.id), false);
    assert.notEqual(mod.createOperativeToken(VARIANT, PROFILE, 'p2-op9'), null);
  });
});
