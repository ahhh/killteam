/**
 * Movement legality and pathing.
 *
 * Movement is measured along the path actually walked, not centre-to-centre,
 * so going around a wall costs what it should.
 */
import {
  dist, circleIntersectsPolygon, segmentIntersectsPolygon,
  pointPolygonDistance, polygonCentroid, clamp, stepToward,
} from '../maps/geometry.js';
import { isPassable } from './terrain.js';
import { liveOperatives } from '../state.js';

export const DASH_DISTANCE = 2;
export const CHARGE_BONUS = 2;
/** Bases may not overlap; a hair of clearance avoids float jitter. */
const BASE_CLEARANCE = 0.02;
/** Cap on visibility-graph nodes, per the performance targets. */
const MAX_PATH_NODES = 64;

function blockingTerrain(map) {
  return (map.terrain || []).filter((p) => !isPassable(p));
}

/** Is this a legal place for the operative's base to come to rest? */
export function isPositionLegal(state, operativeId, x, y, { ignoreOperatives = false } = {}) {
  const op = state.operatives[operativeId];
  const r = op.baseDiameter / 2;
  const { width, height } = state.map.board;

  if (x - r < 0 || y - r < 0 || x + r > width || y + r > height) {
    return { ok: false, reason: 'off board' };
  }
  for (const piece of blockingTerrain(state.map)) {
    if (circleIntersectsPolygon(x, y, r, piece.shape.points)) {
      return { ok: false, reason: `blocked by ${piece.id}` };
    }
  }
  if (!ignoreOperatives) {
    for (const other of liveOperatives(state)) {
      if (other.id === operativeId) continue;
      const minGap = r + other.baseDiameter / 2 + BASE_CLEARANCE;
      if (dist(x, y, other.x, other.y) < minGap) {
        return { ok: false, reason: `base overlaps ${other.id}` };
      }
    }
  }
  return { ok: true };
}

/** Can the base sweep from a to b without clipping blocking terrain? */
function segmentWalkable(state, op, a, b) {
  const r = op.baseDiameter / 2;
  for (const piece of blockingTerrain(state.map)) {
    if (segmentIntersectsPolygon(a, b, piece.shape.points)) return false;
    // Also reject brushing past a corner closer than the base radius.
    if (pointPolygonDistance(a.x, a.y, piece.shape.points) < r - 0.05) return false;
    if (pointPolygonDistance(b.x, b.y, piece.shape.points) < r - 0.05) return false;
  }
  return true;
}

/**
 * The corner-to-corner visibility graph depends only on static terrain and the
 * operative's base size — never on where anyone is standing — so it is built
 * once per (map, base diameter) and reused for every path query.
 */
const graphCache = new Map();

function waypointGraph(state, op) {
  const key = `${state.map.id}:${op.baseDiameter}`;
  const cached = graphCache.get(key);
  if (cached) return cached;

  const nodes = cornerWaypoints(state, op);
  const edges = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (segmentWalkable(state, op, nodes[i], nodes[j])) {
        const d = dist(nodes[i].x, nodes[i].y, nodes[j].x, nodes[j].y);
        edges[i].push([j, d]);
        edges[j].push([i, d]);
      }
    }
  }
  const graph = { nodes, edges };
  graphCache.set(key, graph);
  return graph;
}

/** Drop cached graphs — call when a map's terrain changes (editor, generator). */
export function invalidatePathCache(mapId = null) {
  if (mapId === null) { graphCache.clear(); return; }
  for (const key of [...graphCache.keys()]) {
    if (key.startsWith(`${mapId}:`)) graphCache.delete(key);
  }
}

/** Polygon corners pushed outward by the base radius, as pathing waypoints. */
function cornerWaypoints(state, op) {
  const r = op.baseDiameter / 2 + 0.12;
  const nodes = [];
  for (const piece of blockingTerrain(state.map)) {
    const pts = piece.shape.points;
    const c = polygonCentroid(pts);
    for (const p of pts) {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      const node = { x: p.x + (dx / len) * r, y: p.y + (dy / len) * r };
      node.x = clamp(node.x, r, state.map.board.width - r);
      node.y = clamp(node.y, r, state.map.board.height - r);
      if (isPositionLegal(state, op.id, node.x, node.y, { ignoreOperatives: true }).ok) {
        nodes.push(node);
      }
    }
  }
  return nodes.slice(0, MAX_PATH_NODES);
}

/**
 * Shortest walkable path from the operative to (x, y).
 * @returns {{ok:boolean, path:{x,y}[], length:number, reason?:string}}
 */
export function findPath(state, operativeId, destX, destY) {
  const op = state.operatives[operativeId];
  const start = { x: op.x, y: op.y };
  const goal = { x: destX, y: destY };

  if (segmentWalkable(state, op, start, goal)) {
    return { ok: true, path: [start, goal], length: dist(start.x, start.y, goal.x, goal.y) };
  }

  // Reuse the static terrain graph; only the two endpoints need linking in.
  const graph = waypointGraph(state, op);
  const nodes = [start, goal, ...graph.nodes];
  const n = nodes.length;
  const visible = Array.from({ length: n }, () => []);

  // Static corner-to-corner edges, shifted past the two endpoint nodes.
  for (let i = 0; i < graph.edges.length; i++) {
    for (const [j, d] of graph.edges[i]) {
      if (i < j) {
        visible[i + 2].push([j + 2, d]);
        visible[j + 2].push([i + 2, d]);
      }
    }
  }
  // Link start and goal to everything they can see.
  for (const endpoint of [0, 1]) {
    for (let j = endpoint + 1; j < n; j++) {
      if (segmentWalkable(state, op, nodes[endpoint], nodes[j])) {
        const d = dist(nodes[endpoint].x, nodes[endpoint].y, nodes[j].x, nodes[j].y);
        visible[endpoint].push([j, d]);
        visible[j].push([endpoint, d]);
      }
    }
  }

  // Dijkstra from node 0 (start) to node 1 (goal).
  const distTo = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);
  distTo[0] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && distTo[i] < best) { best = distTo[i]; u = i; }
    }
    if (u === -1 || u === 1) break;
    done[u] = true;
    for (const [v, w] of visible[u]) {
      if (distTo[u] + w < distTo[v]) { distTo[v] = distTo[u] + w; prev[v] = u; }
    }
  }

  if (!isFinite(distTo[1])) {
    return { ok: false, path: [], length: Infinity, reason: 'no walkable path' };
  }
  const path = [];
  for (let at = 1; at !== -1; at = prev[at]) path.unshift(nodes[at]);
  return { ok: true, path, length: distTo[1] };
}

/**
 * Validate a move of at most `allowance` inches.
 * @returns {{ok:boolean, path?:Array, length?:number, reason?:string}}
 */
export function planMove(state, operativeId, destX, destY, allowance) {
  const legal = isPositionLegal(state, operativeId, destX, destY);
  if (!legal.ok) return { ok: false, reason: legal.reason };

  const route = findPath(state, operativeId, destX, destY);
  if (!route.ok) return { ok: false, reason: route.reason };
  if (route.length > allowance + 1e-6) {
    return {
      ok: false,
      reason: `distance ${route.length.toFixed(2)}" exceeds ${allowance.toFixed(2)}" allowance`,
    };
  }
  return { ok: true, path: route.path, length: route.length };
}

/**
 * Nearest legal resting spot to (x, y), spiralling outward.
 * Used so the AI's ideal destination degrades gracefully instead of failing.
 */
export function nearestLegalPosition(state, operativeId, x, y, maxSearch = 4) {
  if (isPositionLegal(state, operativeId, x, y).ok) return { x, y };
  const step = 0.35;
  for (let radius = step; radius <= maxSearch; radius += step) {
    const samples = Math.max(8, Math.round(radius * 10));
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * Math.PI * 2;
      const px = x + Math.cos(a) * radius;
      const py = y + Math.sin(a) * radius;
      if (isPositionLegal(state, operativeId, px, py).ok) return { x: px, y: py };
    }
  }
  return null;
}

/** How far along a path an operative gets on a limited allowance. */
export function truncatePath(path, allowance) {
  let remaining = allowance;
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const seg = dist(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y);
    if (seg <= remaining) {
      out.push(path[i]);
      remaining -= seg;
    } else {
      out.push(stepToward(path[i - 1], path[i], remaining));
      remaining = 0;
      break;
    }
  }
  return { path: out, length: allowance - remaining };
}
