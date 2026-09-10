/**
 * In-memory batch simulation (§31).
 *
 * Detects broken adapters, map bias, AI regressions and rules mistakes.
 * It is NOT evidence that the underlying teams are balanced — AI quality and
 * incomplete rule support dominate these numbers, and the report says so.
 */
import { createBattleState } from '../state.js';
import { runToCompletion } from '../rules/phases.js';
import { createControllers, AI_VERSION } from '../ai/controller.js';
import { ENGINE_VERSION } from '../rules/engine.js';

/**
 * @param {{teams:{p1:object,p2:object}, maps:object[], mission:object,
 *          seeds:(string|number)[], onProgress?:Function}} spec
 */
export function runBatch(spec) {
  const { teams, maps, mission, seeds, onProgress } = spec;
  const tally = {
    games: 0, p1Wins: 0, p2Wins: 0, draws: 0,
    vp: { p1: 0, p2: 0 },
    survivors: { p1: 0, p2: 0 },
    turningPoints: 0,
    warnings: new Map(),
    byMap: new Map(),
    errors: [],
  };

  for (const seed of seeds) {
    for (const map of maps) {
      let state;
      try {
        state = createBattleState({
          seed: `${seed}`, map, mission, teams,
          engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
        });
        runToCompletion(state, createControllers());
      } catch (err) {
        tally.errors.push({ seed, mapId: map.id, message: err.message });
        continue;
      }

      const r = state.result;
      tally.games++;
      if (r.winner === 'p1') tally.p1Wins++;
      else if (r.winner === 'p2') tally.p2Wins++;
      else tally.draws++;
      tally.vp.p1 += r.victoryPoints.p1;
      tally.vp.p2 += r.victoryPoints.p2;
      tally.survivors.p1 += r.survivors.p1;
      tally.survivors.p2 += r.survivors.p2;
      tally.turningPoints += r.turningPoints;

      const perMap = tally.byMap.get(map.id) ?? { games: 0, p1Wins: 0, p2Wins: 0, draws: 0 };
      perMap.games++;
      if (r.winner === 'p1') perMap.p1Wins++;
      else if (r.winner === 'p2') perMap.p2Wins++;
      else perMap.draws++;
      tally.byMap.set(map.id, perMap);

      for (const w of state.warnings) {
        tally.warnings.set(w.ruleId, (tally.warnings.get(w.ruleId) ?? 0) + w.count);
      }
      onProgress?.(tally);
    }
  }

  return summarise(tally, teams);
}

function pct(n, total) {
  return total ? Number(((n / total) * 100).toFixed(1)) : 0;
}

function summarise(tally, teams) {
  const g = tally.games || 1;
  return {
    games: tally.games,
    teams: { p1: teams.p1.displayName, p2: teams.p2.displayName },
    winRate: {
      p1: pct(tally.p1Wins, tally.games),
      p2: pct(tally.p2Wins, tally.games),
      draw: pct(tally.draws, tally.games),
    },
    averageVp: {
      p1: Number((tally.vp.p1 / g).toFixed(2)),
      p2: Number((tally.vp.p2 / g).toFixed(2)),
    },
    averageSurvivors: {
      p1: Number((tally.survivors.p1 / g).toFixed(2)),
      p2: Number((tally.survivors.p2 / g).toFixed(2)),
    },
    averageTurningPoints: Number((tally.turningPoints / g).toFixed(2)),
    byMap: [...tally.byMap.entries()].map(([mapId, m]) => ({
      mapId, games: m.games,
      p1: pct(m.p1Wins, m.games), p2: pct(m.p2Wins, m.games), draw: pct(m.draws, m.games),
    })),
    unsupportedRules: [...tally.warnings.entries()].map(([ruleId, count]) => ({ ruleId, count })),
    errors: tally.errors,
    caveat:
      'AI quality and incomplete rule support affect these results more than team design. ' +
      'Use this to catch regressions and map bias, not to judge tabletop balance.',
  };
}

export function formatBatchReport(report) {
  const lines = [
    `${report.teams.p1} vs ${report.teams.p2}`,
    `Games: ${report.games}`,
    `  ${report.teams.p1} wins: ${report.winRate.p1}%`,
    `  ${report.teams.p2} wins: ${report.winRate.p2}%`,
    `  Draws:  ${report.winRate.draw}%`,
    `Average VP: ${report.averageVp.p1} – ${report.averageVp.p2}`,
    `Average survivors: ${report.averageSurvivors.p1} – ${report.averageSurvivors.p2}`,
  ];
  if (report.byMap.length > 1) {
    lines.push('By map:');
    for (const m of report.byMap) {
      lines.push(`  ${m.mapId}: ${m.p1}% / ${m.p2}% / ${m.draw}% draw  (${m.games} games)`);
    }
  }
  if (report.unsupportedRules.length) {
    lines.push('Unsupported rules encountered:');
    for (const w of report.unsupportedRules) lines.push(`  ${w.ruleId} x${w.count}`);
  }
  if (report.errors.length) {
    lines.push(`ERRORS: ${report.errors.length}`);
    for (const e of report.errors.slice(0, 5)) lines.push(`  seed ${e.seed}: ${e.message}`);
  }
  lines.push('', report.caveat);
  return lines.join('\n');
}
