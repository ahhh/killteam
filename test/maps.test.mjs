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
import { isLight } from '../src/rules/terrain.js';

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
