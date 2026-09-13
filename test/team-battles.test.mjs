/**
 * Every team with faction rules still plays a whole battle.
 *
 * The capability manifest (`team-capabilities.test.mjs`) proves the rules are
 * still DECLARED, and `team-faction-rules.test.mjs` proves the interesting
 * ones still fire. This file proves they survive contact: each pack that
 * carries rule hooks or a resource economy plays one complete battle against a
 * fixed opponent, and the battle must finish without
 *
 *   - throwing,
 *   - having the AI propose an action the rules layer then rejects, or
 *   - raising an "unsupported" warning of a kind that means a DECLARATION the
 *     engine cannot read — an unknown trigger, condition, effect, scope or
 *     window. Those are the failures that make a wired rule silently inert.
 *
 * A `hook-partial:` warning is expected and welcome: it is a pack being honest
 * about a clause it only half implements, and the count of them is not
 * asserted here so that adding an honest note never fails a test.
 *
 * One battle per team, not thirty: this is a smoke test for rule plumbing, not
 * a balance measurement. `node test/sweep.mjs` is the wider net.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTeam, loadMap, loadMission, ROOT } from './harness.mjs';
import { createBattleState } from '../src/state.js';
import { runToCompletion } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';

const OPPONENT = 'vanguard-wardens';
const MAP = loadMap('industrial-001');
const MISSION = loadMission('secure-and-hold');

/** Warning prefixes that mean "this pack declared something unreadable". */
const BROKEN_DECLARATION = [
  'hook-condition:', 'hook-effect:', 'hook-trigger:',
  'unique-effect:', 'unique-target:', 'unique-target-condition:',
  'resource-gain:', 'resource-spend:', 'resource-window:',
  'weapon-rule-effect:',
];

const withRules = fs.readdirSync(path.join(ROOT, 'data/teams'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''))
  .filter((id) => {
    const pack = loadTeam(id);
    return (pack.ruleHooks || []).length || Object.keys(pack.resources || {}).length;
  })
  .sort();

test('the set of teams carrying faction rules has not shrunk', () => {
  // A floor, not an equality: wiring another team's rules should never fail
  // here, but un-wiring one should.
  assert.ok(withRules.length >= 36,
    `only ${withRules.length} packs still carry rule hooks or a resource economy`);
});

for (const id of withRules) {
  test(`${id} plays a clean battle`, () => {
    const foe = id === OPPONENT ? 'kommandos' : OPPONENT;
    const state = createBattleState({
      seed: `battle-${id}`, map: MAP, mission: MISSION,
      teams: { p1: loadTeam(id), p2: loadTeam(foe) },
      engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
    });
    runToCompletion(state, createControllers());

    assert.ok(state.result, `${id} never reached a result`);

    const rejected = state.eventLog.filter((e) => e.ruleId === 'illegal-action-rejected');
    assert.deepEqual(rejected.map((e) => e.message), [],
      `${id} proposed actions the rules layer refused`);

    const unreadable = state.warnings
      .map((w) => w.ruleId)
      .filter((r) => BROKEN_DECLARATION.some((p) => String(r).startsWith(p)));
    assert.deepEqual(unreadable, [],
      `${id} declares rules the engine cannot read, so they never take effect`);
  });
}
