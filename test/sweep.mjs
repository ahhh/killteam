/** Developer sweep: run every bundled team against a fixed opponent set, so a
 *  crash or a flood of rejected actions in any pack's rules shows up early. */
import fs from 'node:fs';
import { createBattleState } from '../src/state.js';
import { runToCompletion } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { loadTeam, loadMap, loadMission, ROOT } from './harness.mjs';

const map = loadMap('industrial-001');
const mission = loadMission(process.argv[3] || 'secure-and-hold');
const ids = fs.readdirSync(`${ROOT}/data/teams`).map((f) => f.replace('.json', '')).sort();
const foes = process.argv[2] ? [process.argv[2]] : ['vanguard-wardens', 'kommandos'];

let rejected = 0;
let crashed = 0;
const warnings = new Map();

for (const id of ids) {
  for (const foe of foes) {
    if (id === foe) continue;
    try {
      const state = createBattleState({
        seed: `sweep-${id}-${foe}`, map, mission,
        teams: { p1: loadTeam(id), p2: loadTeam(foe) },
        engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
      });
      runToCompletion(state, createControllers());
      const bad = state.eventLog.filter((e) => e.ruleId === 'illegal-action-rejected');
      if (bad.length) {
        rejected += bad.length;
        console.log(`  ${id} vs ${foe}: ${bad.length} rejected — ${bad[0].message}`);
      }
      for (const w of state.warnings) {
        warnings.set(w.ruleId, (warnings.get(w.ruleId) || 0) + w.count);
      }
    } catch (err) {
      crashed++;
      console.log(`CRASH ${id} vs ${foe}: ${err.message}\n${err.stack.split('\n')[1]}`);
    }
  }
}

console.log(`\n${ids.length} teams × ${foes.length} opponents`);
console.log(`crashes: ${crashed} | rejected actions: ${rejected}`);
console.log('warnings raised:');
for (const [id, n] of [...warnings].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)} ${id}`);
