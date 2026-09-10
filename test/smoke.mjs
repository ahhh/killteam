import { createBattleState, PHASES, liveOperatives } from '../src/state.js';
import { runToCompletion, step } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { loadTeam, loadMap, loadMission } from './harness.mjs';

const map = loadMap('industrial-001');
const mission = loadMission('secure-and-hold');

function battle(seed, a, b) {
  const state = createBattleState({
    seed, map, mission,
    teams: { p1: loadTeam(a), p2: loadTeam(b) },
    engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
  });
  runToCompletion(state, createControllers());
  return state;
}

const t0 = Date.now();
const s = battle('demo-1', 'vanguard-wardens', 'skycaste-marksmen');
const ms = Date.now() - t0;

console.log('phase:', s.phase, '| turning points:', s.turningPoint);
console.log('result:', s.result.summary);
console.log('VP:', JSON.stringify(s.result.victoryPoints), 'breakdown:', JSON.stringify(s.result.vpBreakdown));
console.log('survivors:', JSON.stringify(s.result.survivors));
console.log('events:', s.eventLog.length, '| warnings:', JSON.stringify(s.warnings));
console.log('elapsed:', ms + 'ms');

const rejected = s.eventLog.filter(e => e.ruleId === 'illegal-action-rejected');
console.log('illegal actions rejected:', rejected.length);
if (rejected.length) console.log('  sample:', rejected.slice(0,5).map(r=>r.message).join('\n  sample: '));
