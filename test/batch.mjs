/** Developer batch harness. Usage: node test/batch.mjs [games] [teamA] [teamB] */
import { runBatch, formatBatchReport } from '../src/replay/batch.js';
import { loadTeam, loadMap, loadMission } from './harness.mjs';

const games = Number(process.argv[2] ?? 60);
const a = process.argv[3] ?? 'vanguard-wardens';
const b = process.argv[4] ?? 'scrap-raiders';

const seeds = Array.from({ length: games }, (_, i) => `batch-${i + 1}`);
const t0 = Date.now();
const report = runBatch({
  teams: { p1: loadTeam(a), p2: loadTeam(b) },
  maps: [loadMap('industrial-001')],
  mission: loadMission('secure-and-hold'),
  seeds,
});
console.log(formatBatchReport(report));
console.log(`\n${games} games in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
  `(${((Date.now() - t0) / games).toFixed(0)}ms per battle)`);
