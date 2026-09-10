/**
 * Geometry service. Canonical unit: INCHES.
 *
 * The renderer converts inches -> pixels; nothing in here knows about pixels,
 * SVG, or the DOM (project invariant #1).
 *
 * Operatives are circles (base), terrain is polygons. Distances between
 * operatives are base-edge to base-edge, per the tabletop measuring rules.
 */

export const EPS = 1e-9;

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

/** Base-edge to base-edge distance; 0 when bases overlap. */
export function baseDistance(a, b) {
  const centres = dist(a.x, a.y, b.x, b.y);
  const edges = centres - a.baseDiameter / 2 - b.baseDiameter / 2;
  return Math.max(0, edges);
}

/** Shortest distance from point p to segment ab. */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return dist(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

/** Proper segment intersection test (touching endpoints count). */
export function segmentsIntersect(a1, a2, b1, b2) {
  const d = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
      ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }
  const onSeg = (p, q, r) =>
    Math.abs(d(p, q, r)) < 1e-7 &&
    r.x >= Math.min(p.x, q.x) - EPS && r.x <= Math.max(p.x, q.x) + EPS &&
    r.y >= Math.min(p.y, q.y) - EPS && r.y <= Math.max(p.y, q.y) + EPS;
  return onSeg(b1, b2, a1) || onSeg(b1, b2, a2) || onSeg(a1, a2, b1) || onSeg(a1, a2, b2);
}

export function pointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersects = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi + EPS) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function polygonEdges(points) {
  const edges = [];
  for (let i = 0; i < points.length; i++) {
    edges.push([points[i], points[(i + 1) % points.length]]);
  }
  return edges;
}

/** Does segment a1->a2 cross the polygon boundary or start/end inside it? */
export function segmentIntersectsPolygon(a1, a2, points) {
  // Bounding-box reject first: most sight lines miss most terrain.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (Math.max(a1.x, a2.x) < minX || Math.min(a1.x, a2.x) > maxX ||
      Math.max(a1.y, a2.y) < minY || Math.min(a1.y, a2.y) > maxY) {
    return false;
  }
  if (pointInPolygon(a1.x, a1.y, points)) return true;
  if (pointInPolygon(a2.x, a2.y, points)) return true;
  for (const [p, q] of polygonEdges(points)) {
    if (segmentsIntersect(a1, a2, p, q)) return true;
  }
  return false;
}

/** Shortest distance from a point to a polygon (0 if inside). */
export function pointPolygonDistance(px, py, points) {
  if (pointInPolygon(px, py, points)) return 0;
  let best = Infinity;
  for (const [p, q] of polygonEdges(points)) {
    best = Math.min(best, pointSegmentDistance(px, py, p.x, p.y, q.x, q.y));
  }
  return best;
}

/** Does a circle (operative base) overlap a polygon? */
export function circleIntersectsPolygon(cx, cy, radius, points) {
  return pointPolygonDistance(cx, cy, points) < radius - EPS;
}

export function polygonCentroid(points) {
  let x = 0, y = 0, area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const cross = p.x * q.y - q.x * p.y;
    area += cross;
    x += (p.x + q.x) * cross;
    y += (p.y + q.y) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < EPS) {
    const n = points.length;
    return {
      x: points.reduce((s, p) => s + p.x, 0) / n,
      y: points.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  return { x: x / (6 * area), y: y / (6 * area) };
}

export function polygonBounds(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

export function rectPolygon(x, y, w, h) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** Sample points on the rim of a base — used for line-of-sight fans. */
export function basePerimeterPoints(op, count = 8) {
  const r = op.baseDiameter / 2;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({ x: op.x + Math.cos(a) * r, y: op.y + Math.sin(a) * r });
  }
  return out;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** Move from `from` toward `to`, capped at `maxDistance`. */
export function stepToward(from, to, maxDistance) {
  const d = dist(from.x, from.y, to.x, to.y);
  if (d <= maxDistance || d < EPS) return { x: to.x, y: to.y };
  const t = maxDistance / d;
  return { x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) };
}
