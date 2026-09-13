/**
 * The painted killzone backdrops.
 *
 * Art is decoration — no battle reads it — so the things worth testing are the
 * ways it could quietly go wrong: a map pointing at a file that is not there,
 * a picture that has drifted out of register with the terrain it is supposed
 * to be showing, or a renderer that stops drawing the rules geometry because
 * there is now a photograph of it underneath.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, loadMap, ROOT } from './harness.mjs';
import { validateMap } from '../src/data/validators.js';
import { CROPS } from '../tools/make-map-art.mjs';

const MAP_IDS = fs.readdirSync(`${ROOT}/data/maps`).map((f) => f.replace('.json', '')).sort();
const withArt = MAP_IDS.filter((id) => loadMap(id).art);

test('every bundled map ships a backdrop', () => {
  assert.deepEqual(withArt, MAP_IDS, 'a map without art renders as bare geometry');
});

test('the file a map points at actually exists', () => {
  for (const id of withArt) {
    const { href } = loadMap(id).art;
    assert.ok(fs.existsSync(path.join(ROOT, href)), `${id}: missing ${href}`);
  }
});

test('backdrops stay small enough to fetch on selection', () => {
  // One is fetched per battle, on the same on-demand path as the map itself.
  // A team pack is ~30KB; this is the heaviest thing a map choice pulls, so it
  // is worth a ceiling rather than a hope.
  for (const id of withArt) {
    const kb = fs.statSync(path.join(ROOT, loadMap(id).art.href)).size / 1024;
    assert.ok(kb < 400, `${id}: backdrop is ${kb.toFixed(0)}KB`);
  }
});

test('art is local, never a third-party request', () => {
  // The href goes straight into an SVG <image>. A remote one would turn
  // picking a map into a call to somebody else's server (#8).
  for (const id of withArt) {
    const { href } = loadMap(id).art;
    assert.ok(!/^[a-z]+:|^\/\//i.test(href), `${id}: ${href} is not a local path`);
    assert.ok(!href.startsWith('/'), `${id}: ${href} must be relative`);
  }
});

test('a malformed art block is a warning, never a broken map', () => {
  const map = loadMap('industrial-001');
  for (const art of [{}, { href: '' }, { href: 'x.webp', showsZones: 'yes' }, 'nonsense']) {
    const report = validateMap({ ...map, art });
    assert.equal(report.errors.length, 0,
      `art ${JSON.stringify(art)} should not stop the map loading`);
  }
  // A remote href is the one exception: it is refused rather than fetched.
  assert.ok(validateMap({ ...map, art: { href: 'https://example.com/a.webp' } }).errors.length,
    'a remote backdrop must be rejected');
});

test('the crop table covers every map that declares art', () => {
  // `tools/make-map-art.mjs` is the only calibration there is: the images are
  // cropped to exactly the playing surface so the renderer needs no offsets.
  // A map with art but no crop entry cannot be regenerated from source.
  for (const id of withArt) {
    assert.ok(CROPS[id], `${id} has art but no crop rectangle to rebuild it from`);
  }
  for (const [id, rect] of Object.entries(CROPS)) {
    assert.ok(MAP_IDS.includes(id), `crop table names unknown map "${id}"`);
    const [, x0, y0, x1, y1] = rect;
    assert.ok(x1 > x0 && y1 > y0, `${id}: crop rectangle is inside out`);
    // The crop is the board, so its aspect has to be close to the board's.
    const map = loadMap(id);
    const want = map.board.width / map.board.height;
    const got = (x1 - x0) / (y1 - y0);
    assert.ok(Math.abs(got - want) / want < 0.12,
      `${id}: crop aspect ${got.toFixed(2)} is too far from the board's ${want.toFixed(2)} — ` +
      'the backdrop would be visibly stretched');
  }
});

test('a map only suppresses its own zones when its art really draws them', () => {
  // The temple's art paints a narrower deployment strip than the map plays, so
  // it must keep the engine's own zones. Getting this backwards would show a
  // player a strip they cannot actually deploy across.
  assert.equal(loadMap('jungle-temple-001').art.showsZones, false);
  for (const id of ['industrial-001', 'hab-warren-001', 'cull-pit-001', 'spacehulk-001']) {
    assert.equal(loadMap(id).art.showsZones, true, `${id}`);
  }
});

/* ------------------------------------------------------------------ */
/* The renderer                                                        */
/* ------------------------------------------------------------------ */

class SvgStub {
  constructor(name) {
    this.tagName = name; this.children = []; this.attrs = {}; this.listeners = {};
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  setAttributeNS(_ns, k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(n) { this.children.push(n); return n; }
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = [...n]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
  all(name) { return [...this.walk()].filter((n) => n.tagName === name); }
}

function renderStub(mapId, { highContrast = false } = {}) {
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElementNS: (_ns, name) => new SvgStub(name),
    createElement: (name) => new SvgStub(name),
    body: { classList: { contains: () => highContrast } },
  };
  try {
    // Imported lazily so the stub is in place before the module reads document.
    return import('../src/ui/battlefield.js').then(({ BattlefieldRenderer }) => {
      const svg = new SvgStub('svg');
      const r = new BattlefieldRenderer(svg, {});
      const map = loadMap(mapId);
      r.render({
        map, mapId, objectives: [], operatives: {}, phase: 'firefight',
        players: { p1: {}, p2: {} }, eventLog: [], effects: [],
      }, { colors: { p1: '#1', p2: '#2' } });
      return svg;
    }).finally(() => { globalThis.document = prevDoc; });
  } catch (err) { globalThis.document = prevDoc; throw err; }
}

test('the backdrop is drawn once, under the terrain, at board size', async () => {
  const svg = await renderStub('hab-warren-001');
  const images = svg.all('image');
  assert.equal(images.length, 1, 'exactly one backdrop');
  const img = images[0];
  const map = loadMap('hab-warren-001');
  assert.equal(img.attrs.href, map.art.href);
  // Cropped to the playing surface at build time, so it goes on at 0,0.
  assert.equal(img.attrs.x, '0');
  assert.equal(img.attrs.y, '0');
  assert.equal(img.attrs.width, String(map.board.width));
  assert.equal(img.attrs.height, String(map.board.height));
  assert.equal(img.attrs.preserveAspectRatio, 'none');
  // Old SVG user agents only know the namespaced href.
  assert.equal(img.attrs['xlink:href'], map.art.href);
});

test('terrain stays visible over the art, as outlines', async () => {
  const svg = await renderStub('hab-warren-001');
  const map = loadMap('hab-warren-001');
  const polys = svg.all('polygon').filter((p) => p.attrs.fill !== undefined);
  const terrain = polys.filter((p) => p.attrs.stroke === 'var(--terrain-edge)');
  assert.equal(terrain.length, map.terrain.length,
    'every rules polygon is still drawn — the picture does not replace them');
  for (const p of terrain) {
    assert.equal(p.attrs.fill, 'none', 'over art the polygons are outline only');
  }
  // The one cue the art cannot express: solid edge = blocking, dashed = walk through.
  const dashed = terrain.filter((p) => p.attrs['stroke-dasharray']);
  const solid = terrain.filter((p) => !p.attrs['stroke-dasharray']);
  const traversable = map.terrain.filter((t) => (t.traits || []).includes('traversable'));
  assert.equal(dashed.length, traversable.length);
  assert.equal(solid.length, map.terrain.length - traversable.length);
  assert.ok(dashed.length && solid.length, 'this map has both kinds');
});

test('high contrast drops the backdrop entirely', async () => {
  const svg = await renderStub('hab-warren-001', { highContrast: true });
  assert.equal(svg.all('image').length, 0,
    'nothing should compete with the tokens in high contrast');
  // …and the terrain goes back to being filled, because it is all there is.
  const filled = svg.all('polygon').filter((p) => p.attrs.fill === 'var(--terrain)');
  assert.ok(filled.length, 'terrain must be readable without the art');
});

test('a map whose art draws the zones does not draw them twice', async () => {
  const warren = await renderStub('hab-warren-001');
  const temple = await renderStub('jungle-temple-001');
  const zonesOf = (svg) => svg.all('polygon').filter((p) => p.attrs['stroke-dasharray'] === '0.4 0.3');
  assert.equal(zonesOf(warren).length, 0, 'the warren art already paints its zones');
  assert.equal(zonesOf(temple).length, 2, 'the temple art does not, so the engine draws them');
});

test('art changes nothing about how a map plays', () => {
  // The rules layer must never have grown an opinion about the picture.
  const src = ['rules', 'ai'].flatMap((dir) =>
    fs.readdirSync(path.join(ROOT, 'src', dir))
      .map((f) => [`src/${dir}/${f}`, fs.readFileSync(path.join(ROOT, 'src', dir, f), 'utf8')]));
  for (const [file, text] of src) {
    assert.ok(!/\bmap\.art\b|\bart\.href\b/.test(text),
      `${file} reads the map art — decoration must not reach the engine (#1)`);
  }
});
