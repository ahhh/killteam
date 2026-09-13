#!/usr/bin/env node
/**
 * Crop, resize and encode the painted killzone backdrops.
 *
 * The source images are full battle-mat renders: the playing surface sits
 * inside a decorative frame, with a scale bar and a title outside it. The
 * renderer wants none of that — it wants a picture of exactly the 30x22"
 * board, so it can drop it onto the board rectangle with no offsets to carry.
 *
 * So the calibration lives HERE, once, as a crop rectangle per map, rather
 * than as a transform every caller has to apply. `CROPS` was derived by
 * detecting each image's playable floor and checking the result against the
 * map's own terrain polygons (see docs/map-art.md); re-running this tool
 * reproduces the bundled assets exactly.
 *
 * Usage:  node tools/make-map-art.mjs [sourceDir]
 * Needs:  cwebp (brew install webp)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'maps');

/** file stem → [x0, y0, x1, y1] of the playing surface, in source pixels. */
export const CROPS = {
  'industrial-001':    ['Industrial_Crossfire', 43, 13, 1405, 1001],
  'spacehulk-001':     ['Derelic_Hulk', 15, 20, 1423, 1005],
  'jungle-temple-001': ['Temple_of_the_Green_Moon', 12, 18, 1451, 992],
  'hab-warren-001':    ['Warren_Of_The_Broken_Hab', 30, 24, 1415, 997],
  'cull-pit-001':      ['The_Cull_Pit', 7, 7, 1440, 1031],
};

/** Wide enough to stay sharp zoomed in, small enough to fetch on selection. */
const WIDTH = 1380;
const HEIGHT = 1012;
const QUALITY = 80;

function main() {
  const src = process.argv[2] || path.join(process.env.HOME, 'Desktop', 'new_maps');
  if (!fs.existsSync(src)) {
    console.error(`source directory not found: ${src}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  for (const [mapId, [stem, x0, y0, x1, y1]] of Object.entries(CROPS)) {
    const from = path.join(src, `${stem}.png`);
    if (!fs.existsSync(from)) { console.warn(`skip ${mapId}: no ${stem}.png`); continue; }
    const to = path.join(OUT, `${mapId}.webp`);
    execFileSync('cwebp', [
      '-quiet', '-q', String(QUALITY),
      '-crop', String(x0), String(y0), String(x1 - x0), String(y1 - y0),
      '-resize', String(WIDTH), String(HEIGHT),
      from, '-o', to,
    ]);
    const kb = (fs.statSync(to).size / 1024).toFixed(0);
    console.log(`${mapId.padEnd(20)} ${kb.padStart(4)} KB  ${path.relative(ROOT, to)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
