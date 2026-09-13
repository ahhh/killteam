/**
 * The preload hints in index.html are generated, and wrong ones cost more than
 * no hints at all: a stale entry is a 404 on every page load, and a missing
 * one restores the import waterfall the hints exist to flatten. Neither shows
 * up in any other test, or in any battle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { moduleGraph, preloadTags } from '../tools/make-data-index.mjs';
import { ROOT } from './harness.mjs';

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const hinted = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);

test('every preloaded module exists on disk', () => {
  const missing = hinted.filter((h) => !fs.existsSync(path.join(ROOT, h)));
  assert.deepEqual(missing, [], 'these would 404 on every page load');
});

test('the hints name exactly what app.js imports', () => {
  const expected = moduleGraph().filter((m) => m !== 'src/app.js');
  const extra = hinted.filter((h) => !expected.includes(h));
  const absent = expected.filter((e) => !hinted.includes(e));
  assert.deepEqual(extra, [], 'preloaded but never imported — wasted bytes on every load');
  assert.deepEqual(absent, [], 'imported but not preloaded — run: npm run data:index');
});

test('index.html carries the generated block verbatim', () => {
  assert.ok(html.includes(preloadTags()),
    'index.html preload block is stale — run: npm run data:index');
});

test('the entry module is not preloaded', () => {
  // <script type="module" src="src/app.js"> already fetches it; a hint would
  // be a second request for the same file on some browsers.
  assert.ok(!hinted.includes('src/app.js'));
  assert.match(html, /<script type="module" src="src\/app\.js">/);
});

test('no as="fetch" preloads, until one has been measured', () => {
  // `data/loader.js` fetches with `cache: 'no-cache'`. A preload that fails to
  // match that request is not free — it is a second download of a file we are
  // trying to get faster. See the comment in index.html.
  const fetched = [...html.matchAll(/<link rel="preload" as="fetch" href="([^"]+)">/g)];
  assert.deepEqual(fetched.map((m) => m[1]), []);
});

test('chosen data is never preloaded', () => {
  // Packs, maps and art depend on what the player picks. Preloading them
  // would be a guess, and a wrong guess costs a wasted download.
  assert.ok(!/rel="preload"[^>]*data\/teams\//.test(html), 'packs must not be preloaded');
  assert.ok(!/rel="preload"[^>]*data\/maps\//.test(html), 'maps must not be preloaded');
  assert.ok(!/rel="preload"[^>]*assets\//.test(html), 'art must not be preloaded');
});

test('the module graph is flat enough for the hints to matter', () => {
  // If this ever collapses to one wave on its own, the hints are dead weight.
  assert.ok(moduleGraph().length > 20,
    'the hint list only earns its place while the graph is deep');
});
