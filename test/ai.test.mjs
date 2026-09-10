import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattleState, allOperatives, liveOperatives, EVENTS } from '../src/state.js';
import { runToCompletion } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { loadTeam, loadMap, loadMission } from './harness.mjs';
import { makeState, opsOf } from './fixtures.mjs';
import { UtilityController } from '../src/ai/controller.js';

const map = loadMap('industrial-001');
const mission = loadMission('secure-and-hold');
const TEAMS = ['vanguard-wardens', 'vanguard-breachers', 'ash-cultists',
               'corsair-skirmishers', 'scrap-raiders', 'skycaste-marksmen'];

function battle(seed, a, b) {
  const state = createBattleState({
    seed, map, mission,
    teams: { p1: loadTeam(a), p2: loadTeam(b) },
    engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
  });
  runToCompletion(state, createControllers());
  return state;
}

test('the AI never has an action rejected as illegal', () => {
  for (const [i, seed] of ['a1', 'a2', 'a3', 'a4'].entries()) {
    const s = battle(seed, TEAMS[i % TEAMS.length], TEAMS[(i + 3) % TEAMS.length]);
    const rejected = s.eventLog.filter((e) => e.ruleId === 'illegal-action-rejected');
    assert.deepEqual(
      rejected.map((r) => r.message), [],
      `seed ${seed} produced rejected actions`
    );
  }
});

test('operatives always stay on the board', () => {
  const s = battle('bounds', 'corsair-skirmishers', 'scrap-raiders');
  const { width, height } = s.map.board;
  for (const op of allOperatives(s)) {
    if (!op.placed) continue;
    const r = op.baseDiameter / 2;
    assert.ok(op.x - r >= -1e-6 && op.x + r <= width + 1e-6, `${op.id} off board in x at ${op.x}`);
    assert.ok(op.y - r >= -1e-6 && op.y + r <= height + 1e-6, `${op.id} off board in y at ${op.y}`);
  }
});

test('no operative acts after being incapacitated', () => {
  const s = battle('dead-men', 'ash-cultists', 'vanguard-breachers');
  const downAt = new Map();
  for (const e of s.eventLog) {
    if (e.type === EVENTS.OPERATIVE_INCAPACITATED) downAt.set(e.operativeId, e.seq);
    const actor = e.operativeId ?? e.attackerId;
    if (!actor || !downAt.has(actor)) continue;
    const acting = [EVENTS.MOVE_RESOLVED, EVENTS.ATTACK_ROLLED, EVENTS.OPERATIVE_ACTIVATED];
    assert.ok(
      !acting.includes(e.type) || e.seq < downAt.get(actor),
      `${actor} performed ${e.type} after being incapacitated`
    );
  }
});

test('the AI prefers a reachable objective over aimless movement', () => {
  // One operative, no enemies in sight, one objective 4" away.
  const s = makeState({
    objectives: [{ id: 'obj-1', x: 9, y: 11, controlRange: 1 }],
    p1: { at: [{ x: 5, y: 11 }] },
    p2: { at: [{ x: 28, y: 2 }] },
  });
  const ai = new UtilityController('p1');
  const [op] = opsOf(s, 'p1');
  const intent = ai.planActivation(s, op.id);
  const move = intent.actions.find((a) => a.type === 'reposition' || a.type === 'dash');
  assert.ok(move, 'expected the AI to move');
  const d = Math.hypot(move.destination.x - 9, move.destination.y - 11);
  assert.ok(d <= 1.5, `expected to end on the objective, ended ${d.toFixed(2)}" away`);
});

test('every AI decision carries an explanation', () => {
  const s = battle('explain', 'skycaste-marksmen', 'scrap-raiders');
  const plans = s.eventLog.filter((e) => e.type === EVENTS.AI_PLAN);
  assert.ok(plans.length > 10, 'expected many recorded plans');
  for (const p of plans) {
    assert.ok(Array.isArray(p.rationale) && p.rationale.length, 'plan without rationale');
    assert.ok(p.considered > 0, 'plan without a candidate count');
  }
});

test('all six shipped teams can complete a battle against each other', () => {
  for (let i = 0; i < TEAMS.length; i++) {
    const a = TEAMS[i];
    const b = TEAMS[(i + 1) % TEAMS.length];
    const s = battle(`matrix-${i}`, a, b);
    assert.equal(s.phase, 'complete', `${a} vs ${b} failed to finish`);
    assert.deepEqual(s.warnings, [], `${a} vs ${b} produced warnings`);
  }
});
