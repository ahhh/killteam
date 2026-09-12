/**
 * Every bundled map has to be playable, not merely well-formed.
 *
 * The validator checks shape; these tests check that a battle can actually be
 * fought on it — every operative finds somewhere to stand, both teams can
 * reach each other and the objectives, and nothing is walled off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readJson, loadTeam, loadMap, loadMission, ROOT } from './harness.mjs';
import { createBattleState, EVENTS, PHASES, allOperatives, liveOperatives } from '../src/state.js';
import { runToCompletion } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { validateMap } from '../src/data/validators.js';
import { planMove, isPositionLegal } from '../src/rules/movement.js';
import { isLight, isPassable } from '../src/rules/terrain.js';
import { traceSight } from '../src/rules/visibility.js';
import { circleIntersectsPolygon, pointInPolygon, polygonCentroid, dist } from '../src/maps/geometry.js';

const MAP_IDS = fs.readdirSync(`${ROOT}/data/maps`).map((f) => f.replace('.json', '')).sort();

/** The widest base in any bundled team — the map has to fit it. */
const WIDEST_BASE = Math.max(...fs.readdirSync(`${ROOT}/data/teams`).flatMap((f) =>
  readJson(`data/teams/${f}`).operatives.map((o) => o.baseDiameter ?? 1.25)));

test('every bundled map is valid', () => {
  assert.ok(MAP_IDS.length >= 3, 'the bundled set has at least three maps');
  for (const id of MAP_IDS) {
    const report = validateMap(loadMap(id));
    assert.equal(report.ok, true, `${id}: ${report.errors.join('; ')}`);
  }
});

for (const id of MAP_IDS) {
  test(`${id}: every objective can be stood next to`, () => {
    const map = loadMap(id);
    // A marker nobody can reach is a marker nobody can score, which quietly
    // breaks the mission rather than failing loudly.
    const state = battleOn(map);
    const probe = allOperatives(state)[0];
    for (const objective of map.objectives) {
      const reach = (objective.controlRange ?? 1) + probe.baseDiameter / 2;
      const spot = ringSearch(state, probe, objective, reach);
      assert.ok(spot, `${id}: no legal position within control range of ${objective.id}`);
    }
  });

  test(`${id}: a full battle deploys and finishes with nobody stranded`, () => {
    const state = battleOn(loadMap(id), 'exodite-dragon-masters', 'kommandos');
    runToCompletion(state, createControllers(), 4000);

    assert.equal(state.phase, PHASES.COMPLETE);
    const stranded = state.warnings.find((w) => w.ruleId === 'deployment:no-legal-position');
    assert.equal(stranded, undefined,
      `${id}: ${stranded?.detail} — corridors are narrower than the ${WIDEST_BASE}" base`);
    assert.equal(allOperatives(state).every((o) => o.placed), true);

    // Both sides have to be able to find each other, or the map is two boxes.
    const attacks = state.eventLog.filter((e) => e.type === EVENTS.ATTACK_ROLLED);
    assert.ok(attacks.length > 0, `${id}: the two teams never engaged at all`);
  });

  test(`${id}: an operative can cross from one deployment zone to the other`, () => {
    const map = loadMap(id);
    const state = battleOn(map);
    const [from, to] = map.deploymentZones.map(centreOf);
    const walker = allOperatives(state)[0];

    const start = ringSearch(state, walker, from, 0) || from;
    walker.x = start.x; walker.y = start.y; walker.placed = true;
    const finish = ringSearch(state, walker, to, 0) || to;

    // One long move rather than a whole battle: this is about connectivity,
    // not about what an operative could do in a single activation.
    const plan = planMove(state, walker.id, finish.x, finish.y, 200);
    assert.equal(plan.ok, true, `${id}: no path from one deployment zone to the other`);
  });
}

test('the jungle temple is the map that gives Seek Light something to ignore', () => {
  const jungle = loadMap('jungle-temple-001');
  const light = jungle.terrain.filter(isLight);
  assert.ok(light.length > 0, 'the canopy is traited light');
  // …and it is the canopy, not some incidental piece.
  assert.ok(light.some((p) => p.id.startsWith('canopy')));
});

test('the space hulk breaks its own firing lanes', () => {
  // The corridors run the full width of the board, so without sight-blocking
  // wreckage in them the map is three thirty-inch shooting galleries — the
  // opposite of what a hulk should play like.
  const hulk = loadMap('spacehulk-001');
  const debris = hulk.terrain.filter((p) => p.id.startsWith('debris-'));
  assert.ok(debris.length >= 5, 'the corridors are interrupted');
  for (const piece of debris) {
    assert.ok(piece.traits.includes('obscuring'), `${piece.id} blocks sight`);
    // It must not block movement: a 5" corridor cannot spare the width.
    assert.ok(piece.traits.includes('traversable'), `${piece.id} is pushed through, not walked around`);
  }
});

/* ------------------------------------------------------------------ */
/* The two melee-leaning killzones                                     */
/*                                                                     */
/* These maps exist for one reason, recorded in the README's melee      */
/* section: on the original three a Goremonger warband crosses twenty   */
/* inches of open board under fire and arrives with half a team. Both   */
/* pull a different lever — the warren shortens the sight lines, the    */
/* pit shortens the walk — so each test below is written against the    */
/* lever, not against a win rate the AI could move on its own.          */
/* ------------------------------------------------------------------ */

/** The melee-leaning maps, and the lever each one pulls. */
const MELEE_MAPS = ['hab-warren-001', 'cull-pit-001'];

test('the warren\'s rubble breaks sight without narrowing a corridor', () => {
  // The warren keeps industrial-001's drop zones on purpose: the terrain is
  // the entire difference between them, so the comparison is controlled. That
  // only works if the rubble doing the work is walkable — sixteen columns of
  // blocking terrain would be a different map for a different reason.
  const warren = loadMap('hab-warren-001');
  const industrial = loadMap('industrial-001');
  assert.deepEqual(
    warren.deploymentZones.map((z) => z.shape.points),
    industrial.deploymentZones.map((z) => z.shape.points),
    'the warren deploys exactly as the industrial yard does');

  const rubble = warren.terrain.filter((p) => p.id.startsWith('rubble-'));
  assert.ok(rubble.length >= 12, 'there is enough of it to cut every lane');
  for (const piece of rubble) {
    assert.ok(piece.traits.includes('obscuring'), `${piece.id} blocks sight`);
    assert.ok(piece.traits.includes('traversable'), `${piece.id} is walked over, not around`);
  }

  // And the only things on the map that stop a base at all are the four hab
  // blocks at the ends. An earlier draft split the middle with walls, which
  // left the widest bundled base one 1"-wide crossing and two sealed pockets.
  const solid = warren.terrain.filter((p) => !isPassable(p)).map((p) => p.id);
  assert.deepEqual(solid.sort(), ['ruin-ne', 'ruin-nw', 'ruin-se', 'ruin-sw']);
});

test('nothing in the warren can be shot at from the far drop zone', () => {
  // This is the whole map. If a gunline can see the other drop zone from its
  // own, it spends the approach shooting and the warren is industrial-001
  // with more scenery on it.
  const warren = loadMap('hab-warren-001');
  const [a, b] = warren.deploymentZones.map((z) => standingSpots(warren, z));
  assert.ok(a.length > 10 && b.length > 10, 'both zones have room to stand in');

  const seen = a.flatMap((p) => b.filter((q) => traceSight(p, q, warren.terrain).visible));
  assert.equal(seen.length, 0,
    `${seen.length} of ${a.length * b.length} drop-zone pairs have line of sight`);
});

test('the cull pit halves the walk instead', () => {
  // The pit's drop zones run the long edges, so the teams start eleven inches
  // apart rather than twenty-two. A Move 6" operative crosses that in one
  // turning point, which is the point of the map.
  const pit = loadMap('cull-pit-001');
  const [p1, p2] = pit.deploymentZones.map((z) => polygonCentroid(z.shape.points));
  const separation = dist(p1.x, p1.y, p2.x, p2.y);
  assert.ok(separation <= 12, `drop zones are ${separation.toFixed(1)}" apart, not 12" or less`);

  // Deployment scatters around the zone centroid, so a marker that is nearer
  // one centroid than the other is a marker one side can hold without moving.
  for (const marker of pit.objectives) {
    const toP1 = dist(marker.x, marker.y, p1.x, p1.y);
    const toP2 = dist(marker.x, marker.y, p2.x, p2.y);
    assert.ok(Math.abs(toP1 - toP2) < 0.01,
      `${marker.id} is ${toP1.toFixed(1)}" from one drop zone and ${toP2.toFixed(1)}" from the other`);
  }
});

for (const id of MELEE_MAPS) {
  test(`${id}: the two drop zones face identical geometry`, () => {
    // Both maps deploy the teams symmetrically, so any asymmetry in the
    // terrain is a thumb on the scale for whichever seat it favours. Every
    // piece must be its own twin under a half turn about the board centre.
    const map = loadMap(id);
    const { width, height } = map.board;
    const key = (points) => points
      .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).sort().join(' ');
    const byShape = new Map(map.terrain.map((p) => [key(p.shape.points), p]));

    for (const piece of map.terrain) {
      const rotated = piece.shape.points.map((p) => ({ x: width - p.x, y: height - p.y }));
      const twin = byShape.get(key(rotated));
      assert.ok(twin, `${piece.id} has no opposite number`);
      assert.deepEqual(twin.traits, piece.traits, `${piece.id} and ${twin.id} play differently`);
      assert.equal(twin.height, piece.height, `${piece.id} and ${twin.id} differ in height`);
    }
  });

  test(`${id}: the widest bundled base can reach all of it`, () => {
    // Terrain that narrows a route below a base's width does not fail, it just
    // quietly walls a region off — and a marker or a flank nobody can enter is
    // invisible until a battle plays wrong. Both these maps get their density
    // from walkable terrain precisely so this cannot happen; this is the test
    // that says so.
    const map = loadMap(id);
    const reachable = floodFill(map, WIDEST_BASE);
    const legal = legalLattice(map, WIDEST_BASE);
    const sealed = legal.filter((k) => !reachable.has(k));
    assert.deepEqual(sealed, [],
      `${id}: ${sealed.length} positions a ${WIDEST_BASE}" base could stand in but never walk to`);
  });

  test(`${id}: a melee team reaches the enemy and fights`, () => {
    // The matchup the README traces. On industrial-001 it produces 0.13 Fight
    // actions a battle; the assertion here is only that contact happens at
    // all, because how MUCH melee follows is the AI's business and moves with
    // it, while whether the killzone permits any is the map's.
    const state = battleOn(loadMap(id), 'goremonger', 'pathfinders');
    runToCompletion(state, createControllers(), 4000);

    const melee = state.eventLog.filter((e) => e.type === EVENTS.ATTACK_ROLLED && e.kind === 'fight');
    assert.ok(melee.length > 0, `${id}: nobody reached anybody — the approach is still unsurvivable`);
  });
}

/* ------------------------------------------------------------------ */

/** Lattice keys for every place a base of `diameter` could legally stand. */
function legalLattice(map, diameter, step = 0.5) {
  const r = diameter / 2;
  const blocking = (map.terrain || []).filter((p) => !isPassable(p));
  const keys = [];
  for (let y = r; y <= map.board.height - r; y += step) {
    for (let x = r; x <= map.board.width - r; x += step) {
      if (blocking.some((p) => circleIntersectsPolygon(x, y, r, p.shape.points))) continue;
      keys.push(`${Math.round(x / step)}:${Math.round(y / step)}`);
    }
  }
  return keys;
}

/** Everything walkable from the first deployment zone, on the same lattice. */
function floodFill(map, diameter, step = 0.5) {
  const legal = new Set(legalLattice(map, diameter, step));
  const zone = map.deploymentZones[0].shape.points;
  const seen = new Set();
  const queue = [...legal].filter((k) => {
    const [i, j] = k.split(':').map(Number);
    return pointInPolygon(i * step, j * step, zone);
  });
  queue.forEach((k) => seen.add(k));

  while (queue.length) {
    const [i, j] = queue.pop().split(':').map(Number);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${i + di}:${j + dj}`;
      if (seen.has(key) || !legal.has(key)) continue;
      seen.add(key);
      queue.push(key);
    }
  }
  return seen;
}

/** Grid of places a 1.25" base could stand inside a deployment zone. */
function standingSpots(map, zone, step = 1.5) {
  const radius = 0.625;
  const blocking = (map.terrain || []).filter((p) => !isPassable(p));
  const spots = [];
  for (let y = radius; y <= map.board.height - radius; y += step) {
    for (let x = radius; x <= map.board.width - radius; x += step) {
      if (!pointInPolygon(x, y, zone.shape.points)) continue;
      if (blocking.some((p) => circleIntersectsPolygon(x, y, radius, p.shape.points))) continue;
      spots.push({ x, y, baseDiameter: 1.25 });
    }
  }
  return spots;
}

function battleOn(map, p1 = 'exodite-dragon-masters', p2 = 'kommandos') {
  return createBattleState({
    seed: `map-${map.id}`, map, mission: loadMission('secure-and-hold'),
    teams: { p1: loadTeam(p1), p2: loadTeam(p2) },
    engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
  });
}

function centreOf(zone) {
  const pts = zone.shape.points;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

/** The nearest legal spot to `target`, searched outwards in rings. */
function ringSearch(state, op, target, maxDistance) {
  for (let r = 0; r <= Math.max(maxDistance, 6); r += 0.25) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = target.x + Math.cos(a) * r;
      const y = target.y + Math.sin(a) * r;
      if (isPositionLegal(state, op.id, x, y).ok) {
        if (maxDistance === 0 || r <= maxDistance + 1e-9) return { x, y };
      }
    }
    if (maxDistance > 0 && r > maxDistance) break;
  }
  return null;
}
