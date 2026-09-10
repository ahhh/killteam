import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, rect, weapon, melee } from './fixtures.mjs';
import { getLegalActions, resolveAction } from '../src/rules/engine.js';
import { canShoot } from '../src/rules/shooting.js';
import { traceSight, withinControlRange } from '../src/rules/visibility.js';
import { isPositionLegal, findPath } from '../src/rules/movement.js';
import { updateObjectiveControl } from '../src/rules/objectives.js';
import { Rng } from '../src/rng.js';

const wall = (id, x, y, w, h) => ({
  id, shape: { type: 'polygon', points: rect(x, y, w, h) },
  height: 3, traits: ['obscuring', 'cover', 'blocking'], render: {},
});

test('shooter in the open can see and shoot a target in the open', () => {
  const s = makeState({ p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 15, y: 11 }] } });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  const sight = traceSight(a, b, s.map.terrain);
  assert.equal(sight.visible, true);
  assert.equal(sight.cover, false);
  assert.equal(canShoot(s, a.id, b.id, weapon()).ok, true);
});

test('an obscuring wall blocks line of sight entirely', () => {
  const s = makeState({
    terrain: [wall('w1', 9.5, 8, 1, 6)],
    p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 15, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  assert.equal(traceSight(a, b, s.map.terrain).visible, false);
  const check = canShoot(s, a.id, b.id, weapon());
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'no line of sight');
});

test('a concealed operative in cover cannot be selected as a target', () => {
  const s = makeState({
    terrain: [{ id: 'c1', shape: { type: 'polygon', points: rect(13.5, 10.4, 2, 1.2) },
               height: 1, traits: ['cover'], render: {} }],
    p1: { at: [{ x: 5, y: 11 }] },
    p2: { at: [{ x: 17, y: 11, order: 'conceal' }] },
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  const sight = traceSight(a, b, s.map.terrain);
  assert.equal(sight.visible, true, 'cover terrain does not block sight');
  assert.equal(sight.cover, true);
  assert.equal(canShoot(s, a.id, b.id, weapon()).reason, 'concealed in cover');

  // The same operative on Engage IS targetable.
  b.order = 'engage';
  assert.equal(canShoot(s, a.id, b.id, weapon()).ok, true);
});

test('shooting requires the Engage order', () => {
  const s = makeState({
    p1: { at: [{ x: 5, y: 11, order: 'conceal' }] }, p2: { at: [{ x: 15, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  assert.equal(canShoot(s, a.id, b.id, weapon()).reason, 'must be on Engage order to shoot');
});

test('weapon range is enforced', () => {
  const s = makeState({ p1: { at: [{ x: 2, y: 11 }] }, p2: { at: [{ x: 25, y: 11 }] } });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  assert.match(canShoot(s, a.id, b.id, weapon({ range: 10 })).reason, /out of range/);
  assert.equal(canShoot(s, a.id, b.id, weapon({ range: 30 })).ok, true);
});

test('operatives cannot move off the board or into blocking terrain', () => {
  const s = makeState({
    terrain: [wall('w1', 10, 10, 3, 3)],
    p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 25, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  assert.equal(isPositionLegal(s, a.id, -1, 11).ok, false);
  assert.equal(isPositionLegal(s, a.id, 31, 11).ok, false);
  assert.equal(isPositionLegal(s, a.id, 11.5, 11.5).ok, false, 'inside the wall');
  assert.equal(isPositionLegal(s, a.id, 5, 5).ok, true);

  const move = resolveAction(s, { operativeId: a.id, type: 'reposition', destination: { x: 100, y: 100 } });
  assert.equal(move.ok, false);
});

test('bases may not overlap each other', () => {
  const s = makeState({ p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 6, y: 11 }] } });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  assert.equal(isPositionLegal(s, a.id, b.x, b.y).ok, false);
});

test('movement distance is measured along the walked path, not centre to centre', () => {
  const s = makeState({
    terrain: [wall('w1', 8, 6, 1, 10)],
    p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 25, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const route = findPath(s, a.id, 12, 11);
  assert.equal(route.ok, true);
  assert.ok(route.length > 7, `path around the wall should exceed the 7" straight line, got ${route.length.toFixed(2)}`);
  assert.ok(route.path.length > 2, 'path should bend around the wall');
});

test('an engaged operative must Fall Back, not Reposition', () => {
  const s = makeState({ p1: { at: [{ x: 10, y: 11 }] }, p2: { at: [{ x: 11.5, y: 11 }] } });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  assert.equal(withinControlRange(a, b), true);

  const types = getLegalActions(s, a.id).map((x) => x.type);
  assert.ok(!types.includes('reposition'), 'Reposition must not be offered while engaged');
  assert.ok(!types.includes('dash'), 'Dash must not be offered while engaged');
  assert.ok(types.includes('fall_back'));
  assert.ok(types.includes('fight'));

  const bad = resolveAction(s, { operativeId: a.id, type: 'reposition', destination: { x: 5, y: 11 } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /control range/);
});

test('Fall Back must end outside enemy control range', () => {
  const s = makeState({ p1: { at: [{ x: 10, y: 11 }] }, p2: { at: [{ x: 11.5, y: 11 }] } });
  const [a] = opsOf(s, 'p1');
  const tooShort = resolveAction(s, { operativeId: a.id, type: 'fall_back', destination: { x: 10.2, y: 11 } });
  assert.equal(tooShort.ok, false);
  const ok = resolveAction(s, { operativeId: a.id, type: 'fall_back', destination: { x: 5, y: 11 } });
  assert.equal(ok.ok, true);
});

test('Charge must reach control range, and is rejected when out of reach', () => {
  const s = makeState({ p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 25, y: 11 }] } });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  const far = resolveAction(s, {
    operativeId: a.id, type: 'charge', targetId: b.id, destination: { x: 12, y: 11 },
  });
  assert.equal(far.ok, false, 'ending short of the target is not a legal charge');

  const s2 = makeState({ p1: { at: [{ x: 12, y: 11 }] }, p2: { at: [{ x: 17, y: 11 }] } });
  const [c] = opsOf(s2, 'p1');
  const [d] = opsOf(s2, 'p2');
  const near = resolveAction(s2, {
    operativeId: c.id, type: 'charge', targetId: d.id, destination: { x: 15.6, y: 11 },
  });
  assert.equal(near.ok, true, near.reason);
  assert.equal(withinControlRange(s2.operatives[c.id], d), true);
});

test('Charge requires the Engage order', () => {
  const s = makeState({
    p1: { at: [{ x: 12, y: 11, order: 'conceal' }] }, p2: { at: [{ x: 16, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  const r = resolveAction(s, {
    operativeId: a.id, type: 'charge', targetId: b.id, destination: { x: 14.8, y: 11 },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Engage/);
});

test('action points are spent and each action is once per activation', () => {
  const s = makeState({ p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 15, y: 11 }] } });
  const [a] = opsOf(s, 'p1');
  assert.equal(a.apRemaining, 2);

  assert.equal(resolveAction(s, { operativeId: a.id, type: 'reposition', destination: { x: 8, y: 11 } }).ok, true);
  assert.equal(a.apRemaining, 1);

  const second = resolveAction(s, { operativeId: a.id, type: 'reposition', destination: { x: 9, y: 11 } });
  assert.equal(second.ok, false);
  assert.match(second.reason, /already performed/);

  assert.equal(resolveAction(s, { operativeId: a.id, type: 'dash', destination: { x: 9.5, y: 11 } }).ok, true);
  assert.equal(a.apRemaining, 0);

  const noAp = resolveAction(s, { operativeId: a.id, type: 'shoot', targetId: opsOf(s, 'p2')[0].id, weaponId: 'w-test' });
  assert.equal(noAp.ok, false);
  assert.match(noAp.reason, /not enough AP/);
});

test('objective control is decided by total APL within control range', () => {
  const s = makeState({
    objectives: [{ id: 'obj-1', x: 15, y: 11, controlRange: 1 }],
    p1: { count: 1, at: [{ x: 14.2, y: 11 }] },
    p2: { count: 1, at: [{ x: 15.8, y: 11 }] },
  });
  updateObjectiveControl(s);
  assert.equal(s.objectives[0].controlledBy, null, 'equal APL is contested');

  // Give p1 a third action point: it now out-controls p2.
  opsOf(s, 'p1')[0].apl = 3;
  updateObjectiveControl(s);
  assert.equal(s.objectives[0].controlledBy, 'p1');

  // Move p1 away entirely.
  opsOf(s, 'p1')[0].x = 5;
  updateObjectiveControl(s);
  assert.equal(s.objectives[0].controlledBy, 'p2');
});

test('an incapacitated operative can take no further actions', () => {
  const s = makeState({ p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 15, y: 11 }] } });
  const [a] = opsOf(s, 'p1');
  a.alive = false;
  assert.deepEqual(getLegalActions(s, a.id), []);
  const r = resolveAction(s, { operativeId: a.id, type: 'reposition', destination: { x: 6, y: 11 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /incapacitated/);
});

test('unknown actions are rejected and recorded as unsupported', () => {
  const s = makeState({ p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 15, y: 11 }] } });
  const [a] = opsOf(s, 'p1');
  const r = resolveAction(s, { operativeId: a.id, type: 'teleport', destination: { x: 20, y: 11 } });
  assert.equal(r.ok, false);
  assert.ok(s.warnings.some((w) => w.ruleId === 'action:teleport'));
});
