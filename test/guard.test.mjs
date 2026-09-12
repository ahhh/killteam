import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, weapon, melee } from './fixtures.mjs';
import { getLegalActions, resolveAction } from '../src/rules/engine.js';
import {
  guardBlocker, hasGuard, resolveGuard, tryGuardInterrupt, GUARD_TOKEN,
} from '../src/rules/guard.js';
import { markTokenExpiryAtActivationStart } from '../src/rules/tokens.js';
import { guardValue } from '../src/ai/support.js';

/** A shooter and a target, well apart and in the open. */
function standoff(over = {}) {
  return makeState({
    p1: { at: [{ x: 8, y: 10 }], ...over.p1 },
    p2: { at: [{ x: 20, y: 10 }], ...over.p2 },
  });
}

test('Guard is on the menu for an operative on Engage with a weapon', () => {
  const state = standoff();
  const [op] = opsOf(state, 'p1');
  assert.equal(guardBlocker(state, op), null);
  assert.ok(getLegalActions(state, op.id).some((a) => a.type === 'guard'));
});

test('Guard needs Engage, the same way shooting does', () => {
  const state = standoff({ p1: { at: [{ x: 8, y: 10, order: 'conceal' }] } });
  const [op] = opsOf(state, 'p1');
  assert.match(guardBlocker(state, op), /Engage/);
  assert.equal(getLegalActions(state, op.id).some((a) => a.type === 'guard'), false);
});

test('an operative with no weapons has nothing to Guard with', () => {
  const state = makeState({
    p1: { weapons: [], at: [{ x: 8, y: 10 }] },
    p2: { at: [{ x: 20, y: 10 }] },
  });
  const [op] = opsOf(state, 'p1');
  assert.match(guardBlocker(state, op), /nothing to Guard with/);
});

test('Guard costs a point and hangs a token', () => {
  const state = standoff();
  const [op] = opsOf(state, 'p1');
  const result = resolveAction(state, { operativeId: op.id, type: 'guard' });
  assert.ok(result.ok, result.reason);
  assert.ok(hasGuard(op));
  assert.equal(op.apRemaining, op.apl - 1);
});

test('Guard is once per activation', () => {
  const state = standoff();
  const [op] = opsOf(state, 'p1');
  assert.ok(resolveAction(state, { operativeId: op.id, type: 'guard' }).ok);
  const again = resolveAction(state, { operativeId: op.id, type: 'guard' });
  assert.equal(again.ok, false);
});

test('a guard shoots the enemy that walks into its lane', () => {
  const state = standoff();
  const [guard] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');
  resolveGuard(state, guard);

  const before = state.eventLog.length;
  const fired = tryGuardInterrupt(state, foe, 'reposition');
  assert.ok(fired, 'the interrupt happened');
  assert.equal(fired.kind, 'shoot');
  assert.equal(hasGuard(guard), false, 'and the token is spent');
  const rolled = state.eventLog.slice(before)
    .filter((e) => e.type === 'ATTACK_ROLLED' && e.attackerId === guard.id);
  assert.equal(rolled.length, 1);
});

test('a guard swings instead when the enemy arrives in its face', () => {
  const state = makeState({
    p1: { weapons: [weapon(), melee()], at: [{ x: 10, y: 10 }] },
    p2: { at: [{ x: 11, y: 10 }] },
  });
  const [guard] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');
  resolveGuard(state, guard);
  const fired = tryGuardInterrupt(state, foe, 'charge');
  assert.ok(fired);
  assert.equal(fired.kind, 'fight');
});

test('nothing but a move triggers an interrupt', () => {
  const state = standoff();
  const [guard] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');
  resolveGuard(state, guard);
  assert.equal(tryGuardInterrupt(state, foe, 'shoot'), null);
  assert.equal(tryGuardInterrupt(state, foe, 'pass'), null);
  assert.ok(hasGuard(guard), 'the token is kept for a move that does come');
});

test('one interrupt per enemy activation, across the whole guarding team', () => {
  const state = makeState({
    p1: { count: 2, at: [{ x: 8, y: 10 }, { x: 8, y: 12 }] },
    p2: { at: [{ x: 20, y: 10 }] },
  });
  const [a, b] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');
  foe.activationCount = 1;
  resolveGuard(state, a);
  resolveGuard(state, b);

  assert.ok(tryGuardInterrupt(state, foe, 'reposition'));
  assert.equal(tryGuardInterrupt(state, foe, 'dash'), null,
    'the second guard does not also get to fire');
  // …but the next activation is a new window.
  foe.activationCount = 2;
  assert.ok(tryGuardInterrupt(state, foe, 'reposition'));
});

test('a guard holds its shot rather than taking a hopeless one', () => {
  const state = makeState({
    // Out of the gun's 24" range: there is no shot to take.
    board: { width: 60, height: 22, units: 'inches' },
    p1: { at: [{ x: 4, y: 10 }] },
    p2: { at: [{ x: 55, y: 10 }] },
  });
  const [guard] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');
  resolveGuard(state, guard);
  assert.equal(tryGuardInterrupt(state, foe, 'reposition'), null);
  assert.ok(hasGuard(guard), 'the token survives for somebody who comes closer');
});

test('the token lapses when its holder activates again', () => {
  const state = standoff();
  const [op] = opsOf(state, 'p1');
  resolveGuard(state, op);
  op.activationCount = (op.activationCount || 0) + 1;
  const shed = markTokenExpiryAtActivationStart(op);
  assert.equal(shed.some((t) => t.kind === GUARD_TOKEN), true);
  assert.equal(hasGuard(op), false);
});

test('an incapacitated guard takes its token with it', () => {
  const state = standoff();
  const [guard] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');
  resolveGuard(state, guard);
  guard.alive = false;
  assert.equal(tryGuardInterrupt(state, foe, 'reposition'), null);
});

test('the AI prices Guard above nothing when something can walk into it', () => {
  const state = standoff();
  const [op] = opsOf(state, 'p1');
  const enemies = opsOf(state, 'p2');
  assert.ok(guardValue(state, op, enemies) > 0);
});

test('…and at nothing when the board is empty of enemies', () => {
  const state = standoff();
  const [op] = opsOf(state, 'p1');
  assert.equal(guardValue(state, op, []), 0);
});

test('…and at nothing for an operative that cannot Guard at all', () => {
  const state = standoff({ p1: { at: [{ x: 8, y: 10, order: 'conceal' }] } });
  const [op] = opsOf(state, 'p1');
  assert.equal(guardValue(state, op, opsOf(state, 'p2')), 0);
});
