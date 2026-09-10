import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattleState, liveOperatives, allOperatives } from '../src/state.js';
import { runToCompletion } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { Rng } from '../src/rng.js';
import { loadTeam, loadMap, loadMission } from './harness.mjs';

const map = loadMap('industrial-001');
const mission = loadMission('secure-and-hold');

function battle(seed, a = 'vanguard-wardens', b = 'corsair-skirmishers') {
  const state = createBattleState({
    seed, map, mission,
    teams: { p1: loadTeam(a), p2: loadTeam(b) },
    engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
  });
  runToCompletion(state, createControllers());
  return state;
}

/** A digest of everything that must be reproducible. */
function digest(state) {
  return JSON.stringify({
    events: state.eventLog.map((e) => [e.seq, e.type, e.operativeId ?? null, e.rolls ?? null, e.amount ?? null]),
    result: state.result,
    rng: state.rng,
    positions: allOperatives(state).map((o) => [o.id, o.x.toFixed(4), o.y.toFixed(4), o.woundsRemaining]),
  });
}

test('the same seed produces an identical event log', () => {
  const a = battle('repeat-me');
  const b = battle('repeat-me');
  assert.equal(digest(a), digest(b));
  assert.equal(a.rng.index, b.rng.index, 'RNG streams must be consumed identically');
});

test('different seeds produce different battles', () => {
  const a = battle('seed-alpha');
  const b = battle('seed-bravo');
  assert.notEqual(digest(a), digest(b));
});

test('a battle always terminates and produces a result', () => {
  for (const seed of ['t1', 't2', 't3', 't4', 't5']) {
    const s = battle(seed);
    assert.equal(s.phase, 'complete', `seed ${seed} did not finish`);
    assert.ok(s.result, `seed ${seed} produced no result`);
    assert.ok(s.turningPoint <= 4);
    assert.ok(['p1', 'p2', null].includes(s.result.winner));
  }
});

test('the RNG stream position is a faithful resume point', () => {
  const s = battle('resume-check');
  const resumed = Rng.fromState(s.rng);
  const fresh = new Rng(s.seed);
  for (let i = 0; i < s.rng.index; i++) fresh.next();
  assert.equal(resumed.next(), fresh.next());
});

test('no unsupported rules are silently guessed in the shipped data', () => {
  const s = battle('warning-check');
  assert.deepEqual(s.warnings, [], `unexpected warnings: ${JSON.stringify(s.warnings)}`);
});
