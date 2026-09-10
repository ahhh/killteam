import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattleState } from '../src/state.js';
import { runToCompletion } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { buildReplay, digestEvents, toBattleLogText } from '../src/replay/recorder.js';
import { verify } from '../src/replay/playback.js';
import { loadTeam, loadMap, loadMission } from './harness.mjs';

function battle(seed) {
  const state = createBattleState({
    seed, map: loadMap('industrial-001'), mission: loadMission('secure-and-hold'),
    teams: { p1: loadTeam('scrap-raiders'), p2: loadTeam('skycaste-marksmen') },
    engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
  });
  runToCompletion(state, createControllers());
  return state;
}

test('an exported replay reproduces the original battle exactly', () => {
  const original = battle('replay-me');
  const replay = buildReplay(original);
  const check = verify(replay);
  assert.equal(check.ok, true, `diverged at event ${check.divergedAt}`);
  assert.equal(check.expected, check.actual);
  assert.deepEqual(check.state.result, original.result);
});

test('a replay survives a JSON round trip', () => {
  const replay = buildReplay(battle('json-trip'));
  const restored = JSON.parse(JSON.stringify(replay));
  assert.equal(verify(restored).ok, true);
  assert.equal(digestEvents(restored.events), digestEvents(replay.events));
});

test('replays snapshot team data rather than referencing it', () => {
  const replay = buildReplay(battle('snapshot'));
  assert.ok(replay.teams.p1.operatives.length, 'team pack must be embedded');
  assert.ok(replay.dataVersions.p1.dataVersion, 'data version must be stamped');
  // Mutating the live pack must not change the recorded battle.
  const before = digestEvents(replay.events);
  loadTeam('scrap-raiders').operatives[0].stats.wounds = 99;
  assert.equal(digestEvents(replay.events), before);
});

test('the battle log exports as readable text', () => {
  const text = toBattleLogText(buildReplay(battle('log-text')));
  assert.match(text, /Turning Point 1/);
  assert.match(text, /RESULT:/);
  assert.ok(text.split('\n').length > 50);
});
