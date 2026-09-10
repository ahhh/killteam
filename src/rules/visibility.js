/**
 * Line of sight, cover, and control range.
 *
 * One service, so combat code never re-derives LOS with its own rules.
 * All geometry is base-edge aware and measured in inches.
 */
import {
  baseDistance, basePerimeterPoints, segmentIntersectsPolygon,
  pointPolygonDistance, dist, pointSegmentDistance,
} from '../maps/geometry.js';
import { isObscuring, isCover, isLight } from './terrain.js';

/** Kill Team control range: 1" from base edge. */
export const CONTROL_RANGE = 1;

/** Rays are cast between rim samples; more samples = smoother, slower. */
const RIM_SAMPLES = 6;
/** The AI traces speculative sight lines far more often, so it uses fewer. */
export const QUICK_SAMPLES = 2;

function sightPoints(op, samples) {
  const rim = samples > 0 ? basePerimeterPoints(op, samples) : [];
  return [{ x: op.x, y: op.y }, ...rim];
}

/** Terrain the operative is standing in/next to doesn't block its own view. */
function ignoresPiece(op, piece) {
  return pointPolygonDistance(op.x, op.y, piece.shape.points) <
    op.baseDiameter / 2 + 0.25;
}

/**
 * Trace line of sight and cover between two operatives.
 *
 * Cover is reported three ways so `Seek` and `Seek Light` can ignore terrain
 * when a target is SELECTED without also removing the target's cover save —
 * those rules govern selection only, Saturate is what removes the save.
 *
 * @returns {{visible:boolean, cover:boolean, coverIgnoringTerrain:boolean,
 *   coverIgnoringLightTerrain:boolean, blockedBy:string[], coverFrom:string[],
 *   rays:number, clearRays:number}}
 */
export function traceSight(observer, target, terrain, otherOperatives = [], options = {}) {
  const samples = options.samples ?? RIM_SAMPLES;
  const from = sightPoints(observer, samples);
  const to = sightPoints(target, samples);

  const relevant = terrain.filter(
    (p) => !ignoresPiece(observer, p) && !ignoresPiece(target, p)
  );
  const obscuring = relevant.filter(isObscuring);
  const covering = relevant.filter(isCover);

  const blockedBy = new Set();
  const coverFrom = new Set();
  let clearRays = 0;
  let coveredRays = 0;
  // Rays crossing terrain that is NOT Light — what Seek Light cannot ignore.
  let heavyCoveredRays = 0;
  // Cover from bodies rather than terrain; neither Seek rule touches it.
  let operativeCoveredRays = 0;
  let total = 0;

  for (const a of from) {
    for (const b of to) {
      total++;
      let blocked = false;
      for (const piece of obscuring) {
        if (segmentIntersectsPolygon(a, b, piece.shape.points)) {
          blocked = true;
          blockedBy.add(piece.id);
          break;
        }
      }
      if (blocked) continue;
      clearRays++;
      let anyCover = false;
      let heavyCover = false;
      for (const piece of covering) {
        if (!segmentIntersectsPolygon(a, b, piece.shape.points)) continue;
        coverFrom.add(piece.id);
        anyCover = true;
        if (!isLight(piece)) { heavyCover = true; break; }
      }
      if (anyCover) coveredRays++;
      if (heavyCover) heavyCoveredRays++;
    }
  }

  // Intervening operatives also grant cover (but never block outright).
  const centreA = { x: observer.x, y: observer.y };
  const centreB = { x: target.x, y: target.y };
  for (const other of otherOperatives) {
    const d = pointSegmentDistance(other.x, other.y, centreA.x, centreA.y, centreB.x, centreB.y);
    if (d < other.baseDiameter / 2 + 0.1) {
      // Must actually be between them, not off the end of the segment.
      const span = dist(centreA.x, centreA.y, centreB.x, centreB.y);
      if (dist(centreA.x, centreA.y, other.x, other.y) < span &&
          dist(centreB.x, centreB.y, other.x, other.y) < span) {
        coverFrom.add(other.id);
        operativeCoveredRays += total * 0.5;
      }
    }
  }

  const visible = clearRays > 0;
  // Majority of clear sight lines crossing cover => the target is in cover.
  const threshold = clearRays * 0.5;
  const cover = visible && coveredRays + operativeCoveredRays >= threshold;

  return {
    visible,
    cover,
    coverIgnoringTerrain: visible && operativeCoveredRays >= threshold,
    coverIgnoringLightTerrain: visible && heavyCoveredRays + operativeCoveredRays >= threshold,
    blockedBy: [...blockedBy],
    coverFrom: [...coverFrom],
    rays: total,
    clearRays,
  };
}

/**
 * Is the target in cover for the purposes of SELECTING it as a target?
 * @param {'none'|'light'|'all'} seek which terrain the weapon ignores.
 */
export function coverForSelection(sight, seek = 'none') {
  if (seek === 'all') return sight.coverIgnoringTerrain;
  if (seek === 'light') return sight.coverIgnoringLightTerrain;
  return sight.cover;
}

/**
 * Can `observer` pick `target` as a shooting target?
 * A CONCEALED operative in cover cannot be selected at all — unless the
 * weapon Seeks past the terrain it is hiding behind.
 *
 * @param {'none'|'light'|'all'} options.seek terrain the weapon ignores here.
 */
export function canBeTargeted(observer, target, terrain, otherOperatives = [], options = {}) {
  const sight = traceSight(observer, target, terrain, otherOperatives, options);
  if (!sight.visible) {
    return { ok: false, reason: 'no line of sight', sight };
  }
  if (target.order === 'conceal' && coverForSelection(sight, options.seek)) {
    return { ok: false, reason: 'concealed in cover', sight };
  }
  return { ok: true, sight };
}

export function withinControlRange(a, b) {
  return baseDistance(a, b) <= CONTROL_RANGE + 1e-9;
}

/** Enemies whose control range this operative is inside (i.e. engaged). */
export function enemiesInControlRange(op, allOperatives) {
  return allOperatives.filter(
    (o) => o.alive && o.playerId !== op.playerId && withinControlRange(op, o)
  );
}
