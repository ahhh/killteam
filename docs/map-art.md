# Killzone backdrops

Each bundled map ships a painted top-down render of its killzone. It is
decoration: no battle reads it, and a map without one renders as the geometric
board it always had.

## How it fits together

```
data/maps/<id>.json     "art": { "href": "assets/maps/<id>.webp", "showsZones": true }
assets/maps/<id>.webp   the playing surface, cropped and encoded
tools/make-map-art.mjs   the crop rectangles, and the only calibration there is
src/ui/battlefield.js    draws it under everything, then the rules geometry on top
```

The image is fetched by the browser when the board first renders it, on the
same on-demand path as the map JSON — nothing is preloaded, because which map
a player picks is a guess (`test/preload.test.mjs`).

## The calibration lives in the crop

The source renders put the playing surface inside a decorative frame, with a
scale bar and a title outside it, and the frames differ per image. Rather than
carry a per-map transform into the renderer, `make-map-art.mjs` crops each
source to exactly the 30×22" board. The runtime then places it at `0,0,30,22`
with `preserveAspectRatio="none"` and has no offsets to get wrong.

Crop rectangles were derived two ways and checked against each map's own
terrain polygons:

- **From the painted deployment zones**, whose board coordinates the map data
  already knows — used for Industrial Crossfire, the Warren and the Cull Pit.
- **From the playable floor's own edges**, where a colour search for the zones
  was swamped by the art itself — the Derelict Hulk's blue-grey decking and the
  Temple's foliage both defeat it.

Each result was then verified by overlaying the map's terrain on the crop and
looking at whether the polygons land on the painted obstacles. They do.

## What the art is NOT allowed to decide

The terrain polygons are still drawn over the top, as outlines. The art is a
second, hand-made description of the same killzone and it *can* drift from the
data; the outlines are what keep the geometry the engine actually collides
against visible. They also carry the one distinction the art cannot express:

- **solid edge** — `blocking`: sight and movement both stop here
- **dashed edge** — `traversable`: blocks sight, but is walked straight through

High contrast mode drops the backdrop entirely and the polygons go back to
being filled, because then they are the only thing describing the board.

## Known mismatches

The art was drawn from each map's layout rather than generated from its
coordinates, so a few details are placed by eye:

| Map | Note |
| --- | --- |
| Temple of the Green Moon | The painted deployment strips are narrower than the zones the map actually plays, so it sets `showsZones: false` and the engine draws its own. Both are visible. |
| The Cull Pit | The five painted objective discs do not sit where the mission's markers are — up to ~1.5" out. The live markers are drawn on top; the painted ones read as floor detail. |
| Warren of the Broken Hab | Same, milder: the lower pair of painted discs are ~0.7" out. |

Every other map's zones agree with the data closely enough to use directly,
which is what `art.showsZones` records.

## Regenerating

```sh
npm run map:art -- /path/to/source/renders
```

Requires `cwebp` (`brew install webp`). Output is deterministic, so a clean
checkout plus this command reproduces the bundled assets byte for byte.
