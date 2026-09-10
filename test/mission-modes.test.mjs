/**
 * Mission modes: how a battle ends and who is judged to have won.
 *
 * `victoryPoints` is the default — four turning points, then compare VP.
 * `lastTeamStanding` is the deathmatch variant: no objectives, no meaningful
 * clock, and the battle runs until one kill team has nobody left.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf } from './fixtures.mjs';
import { readJson } from './harness.mjs';
import {
  step, runToCompletion, turningPointLimit, isLastTeamStanding, MAX_TURNING_POINTS,
} from '../src/rules/phases.js';
import { createControllers } from '../src/ai/controller.js';
import { validateMission } from '../src/data/validators.js';
import { PHASES, liveOperatives } from '../src/state.js';
import { applyDamage } from '../src/rules/effects.js';

const deathmatch = {
  id: 'test-deathmatch', name: 'Deathmatch', version: 1,
  victory: { type: 'lastTeamStanding', turningPointCap: 6 },
  ignoreObjectives: true,
  scoring: { kills: { vpPer: 1 } },
};

test('the bundled Annihilation mission is a valid last-team-standing mission', () => {
  const mission = readJson('data/missions/annihilation.json');
  const report = validateMission(mission);
  assert.equal(report.ok, true, report.errors.join('; '));
  assert.equal(mission.victory.type, 'lastTeamStanding');
  assert.equal(mission.ignoreObjectives, true);
});

test('a mission may only declare a victory condition the engine implements', () => {
  const bogus = validateMission({ ...deathmatch, victory: { type: 'sudden-death' } });
  assert.equal(bogus.ok, false);
  assert.ok(bogus.errors.some((e) => /unknown victory condition/.test(e)));
});

test('a last-team-standing mission may score nothing at all', () => {
  // Every other mission needs a way to earn VP or nobody could ever win; this
  // one wins by elimination, so an empty scoring block is legitimate.
  const noScoring = validateMission({ ...deathmatch, scoring: {} });
  assert.equal(noScoring.ok, true, noScoring.errors.join('; '));

  const objectiveGame = validateMission({ id: 'm', scoring: {} });
  assert.equal(objectiveGame.ok, false);
});

test('a deathmatch takes the objectives off the board entirely', () => {
  const objectives = [{ id: 'obj-1', x: 15, y: 11, controlRange: 1 }];
  const scored = makeState({ objectives, p1: { at: [{ x: 6, y: 11 }] }, p2: { at: [{ x: 20, y: 11 }] } });
  assert.equal(scored.objectives.length, 1);

  const fight = makeState({
    objectives, mission: deathmatch,
    p1: { at: [{ x: 6, y: 11 }] }, p2: { at: [{ x: 20, y: 11 }] },
  });
  assert.deepEqual(fight.objectives, [], 'nothing to hold, so nothing to run to');
});

test('the turning-point limit comes from the mission, not a fixed constant', () => {
  const standard = makeState({ p1: { at: [{ x: 6, y: 11 }] }, p2: { at: [{ x: 20, y: 11 }] } });
  assert.equal(isLastTeamStanding(standard), false);
  assert.equal(turningPointLimit(standard), MAX_TURNING_POINTS);

  const brawl = makeState({
    mission: deathmatch, p1: { at: [{ x: 6, y: 11 }] }, p2: { at: [{ x: 20, y: 11 }] },
  });
  assert.equal(isLastTeamStanding(brawl), true);
  assert.equal(turningPointLimit(brawl), 6, 'the cap only exists so a stalemate still stops');
});

test('a deathmatch is won outright by the side with anybody left standing', () => {
  const s = makeState({
    mission: deathmatch,
    p1: { count: 2, at: [{ x: 6, y: 11 }, { x: 7, y: 12 }], wounds: 10 },
    p2: { count: 2, at: [{ x: 20, y: 11 }, { x: 21, y: 12 }], wounds: 10 },
    seed: 'deathmatch',
  });
  // Wipe p2 out, then let the phase machine reach its scoring step.
  for (const op of opsOf(s, 'p2')) applyDamage(s, op.id, 99, { kind: 'test' });
  s.phase = PHASES.SCORE;
  s.killsThisTurn = { p1: 2, p2: 0 };

  const result = step(s, createControllers());
  assert.equal(result.done, true);
  assert.equal(s.result.winner, 'p1');
  assert.equal(s.result.victory, 'lastTeamStanding');
  assert.match(s.result.summary, /wipes out/);
  assert.equal(s.result.survivors.p2, 0);
});

test('a deathmatch that hits its cap is judged on who is left, then on wounds', () => {
  const s = makeState({
    mission: deathmatch,
    p1: { count: 2, at: [{ x: 6, y: 11 }, { x: 7, y: 12 }], wounds: 10 },
    p2: { count: 2, at: [{ x: 20, y: 11 }, { x: 21, y: 12 }], wounds: 10 },
    seed: 'capped',
  });
  s.turningPoint = 6;                    // the cap
  s.phase = PHASES.SCORE;
  s.killsThisTurn = { p1: 0, p2: 0 };
  // Level on bodies, so the tie has to break on wounds remaining.
  opsOf(s, 'p2').forEach((op) => { op.woundsRemaining = 3; });

  const result = step(s, createControllers());
  assert.equal(result.done, true);
  assert.equal(s.result.winner, 'p1');
  assert.equal(s.result.cappedOut, true);
  assert.deepEqual(s.result.woundsLeft, { p1: 20, p2: 6 });
  assert.match(s.result.summary, /Neither team was wiped out/);
});

test('a mutual wipeout in a deathmatch is an honest draw', () => {
  const s = makeState({
    mission: deathmatch,
    p1: { at: [{ x: 6, y: 11 }], wounds: 10 },
    p2: { at: [{ x: 20, y: 11 }], wounds: 10 },
    seed: 'mutual',
  });
  for (const op of [...opsOf(s, 'p1'), ...opsOf(s, 'p2')]) {
    applyDamage(s, op.id, 99, { kind: 'test' });
  }
  s.phase = PHASES.SCORE;
  s.killsThisTurn = { p1: 1, p2: 1 };

  step(s, createControllers());
  assert.equal(s.result.winner, null);
  assert.match(s.result.summary, /Mutual annihilation/);
});

test('an objective game still ends on its own clock with a VP result', () => {
  const s = makeState({
    p1: { count: 2, at: [{ x: 6, y: 11 }, { x: 7, y: 12 }], wounds: 40 },
    p2: { count: 2, at: [{ x: 20, y: 11 }, { x: 21, y: 12 }], wounds: 40 },
    seed: 'objective-game',
  });
  s.activePlayerId = 'p1';
  runToCompletion(s, createControllers());
  assert.equal(s.phase, PHASES.COMPLETE);
  assert.equal(s.result.victory, 'victoryPoints');
  assert.equal(s.turningPoint, MAX_TURNING_POINTS);
  assert.match(s.result.summary, /wins \d+–\d+|Draw \d+–\d+/);
});

test('a real deathmatch runs past the four turning points an objective game would stop at', () => {
  const map = readJson('data/maps/industrial-001.json');
  const s = makeState({
    mission: readJson('data/missions/annihilation.json'),
    board: map.board,
    terrain: map.terrain,
    p1: { count: 4, at: [{ x: 3, y: 6 }, { x: 3, y: 9 }, { x: 3, y: 12 }, { x: 3, y: 15 }], wounds: 14 },
    p2: { count: 4, at: [{ x: 27, y: 6 }, { x: 27, y: 9 }, { x: 27, y: 12 }, { x: 27, y: 15 }], wounds: 14 },
    seed: 'annihilation-run',
  });
  s.activePlayerId = 'p1';
  runToCompletion(s, createControllers(), 4000);

  assert.equal(s.phase, PHASES.COMPLETE);
  assert.equal(s.result.victory, 'lastTeamStanding');
  // It ends when a team is gone, or when the cap stops it — never on the
  // four-turning-point clock an objective mission uses.
  const wipedOut = liveOperatives(s, 'p1').length === 0 || liveOperatives(s, 'p2').length === 0;
  assert.ok(wipedOut || s.result.cappedOut,
    `ended at turning point ${s.turningPoint} with neither condition met`);
  if (wipedOut) assert.match(s.result.summary, /wipes out|Mutual annihilation/);
});

test('with no objectives to take, the AI closes on the enemy instead of standing still', () => {
  // Regression: "take ground" used to be scored purely on objective value, so
  // in a mission with no markers every destination tied at zero and the first
  // candidate — hold position — always won. Two kill teams then repositioned
  // zero inches for the whole battle and the cap had to stop them.
  const map = readJson('data/maps/industrial-001.json');
  const spec = {
    board: map.board, terrain: map.terrain,
    p1: { count: 4, at: [{ x: 3, y: 6 }, { x: 3, y: 9 }, { x: 3, y: 12 }, { x: 3, y: 15 }], wounds: 14 },
    p2: { count: 4, at: [{ x: 27, y: 6 }, { x: 27, y: 9 }, { x: 27, y: 12 }, { x: 27, y: 15 }], wounds: 14 },
    seed: 'closes-in',
  };
  const s = makeState({ ...spec, mission: readJson('data/missions/annihilation.json') });
  s.activePlayerId = 'p1';
  runToCompletion(s, createControllers(), 4000);

  const moves = s.eventLog.filter((e) => e.type === 'MOVE_RESOLVED');
  const walked = moves.reduce((total, e) => total + e.distance, 0);
  assert.ok(moves.length > 0, 'the AI moved at all');
  assert.ok(walked > 20, `operatives covered only ${walked.toFixed(1)}" across the battle`);
});
