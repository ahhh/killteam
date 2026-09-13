/** A/B probe: melee-leaning teams against gunlines, both seats, three maps. */
import { runBatch } from '../src/replay/batch.js';
import { loadTeam, loadMap, loadMission } from './harness.mjs';

const MELEE = ['fellgor-ravager', 'raveners', 'wrecka-krew', 'chaos-cult', 'gellerpox-infected', 'goremonger'];
const GUNS = ['kasrkin', 'pathfinders', 'death-korps'];
const maps = ['industrial-001', 'hab-warren-001', 'cull-pit-001'].map(loadMap);
const mission = loadMission('secure-and-hold');
const seeds = Array.from({ length: 4 }, (_, i) => `ab-${i + 1}`);

let wins = 0, games = 0, vpFor = 0, vpAgainst = 0, survFor = 0;
for (const m of MELEE) {
  for (const g of GUNS) {
    for (const [a, b] of [[m, g], [g, m]]) {
      const t = runBatch({ teams: { p1: loadTeam(a), p2: loadTeam(b) }, maps, mission, seeds });
      const me = a === m ? 'p1' : 'p2';
      const you = me === 'p1' ? 'p2' : 'p1';
      games += t.games;
      wins += Math.round((t.winRate[me] / 100) * t.games);
      vpFor += t.averageVp[me] * t.games;
      vpAgainst += t.averageVp[you] * t.games;
      survFor += t.averageSurvivors[me] * t.games;
    }
  }
}
console.log(`melee win rate: ${(100 * wins / games).toFixed(1)}%  (${wins}/${games})`);
console.log(`average VP: ${(vpFor / games).toFixed(2)} - ${(vpAgainst / games).toFixed(2)}`);
console.log(`average melee survivors: ${(survFor / games).toFixed(2)}`);
