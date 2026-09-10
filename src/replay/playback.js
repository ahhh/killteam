/**
 * Replay verification and playback.
 *
 * Playback re-runs the recorded inputs through the engine and checks the
 * result matches. If it doesn't, something that must be deterministic isn't —
 * so we report the divergence rather than quietly showing a different battle.
 */
import { createBattleState } from '../state.js';
import { runToCompletion } from '../rules/phases.js';
import { createControllers } from '../ai/controller.js';
import { ENGINE_VERSION } from '../rules/engine.js';
import { AI_VERSION } from '../ai/controller.js';
import { digestEvents } from './recorder.js';

/** Rebuild the battle a replay describes. */
export function rerun(replay) {
  const state = createBattleState({
    seed: replay.seed,
    map: replay.map,
    mission: replay.mission,
    teams: replay.teams,
    engineVersion: replay.engineVersion,
    aiVersion: replay.aiVersion,
  });
  runToCompletion(state, createControllers());
  return state;
}

/**
 * @returns {{ok:boolean, expected:string, actual:string, divergedAt:number|null, notes:string[]}}
 */
export function verify(replay) {
  const notes = [];
  if (replay.engineVersion !== ENGINE_VERSION) {
    notes.push(`Recorded with engine ${replay.engineVersion}; this build is ${ENGINE_VERSION}.`);
  }
  if (replay.aiVersion !== AI_VERSION) {
    notes.push(`Recorded with AI ${replay.aiVersion}; this build is ${AI_VERSION}.`);
  }

  const state = rerun(replay);
  const expected = digestEvents(replay.events);
  const actual = digestEvents(state.eventLog);

  let divergedAt = null;
  if (expected !== actual) {
    const n = Math.min(replay.events.length, state.eventLog.length);
    for (let i = 0; i < n; i++) {
      const a = replay.events[i];
      const b = state.eventLog[i];
      if (a.type !== b.type || JSON.stringify(a.rolls) !== JSON.stringify(b.rolls)) {
        divergedAt = i;
        break;
      }
    }
    if (divergedAt === null) divergedAt = n;
  }

  return { ok: expected === actual, expected, actual, divergedAt, notes, state };
}

/** Staleness notice for the replay panel (§29). */
export function stalenessNotice(replay, currentPacks = {}) {
  const messages = [];
  for (const playerId of ['p1', 'p2']) {
    const recorded = replay.dataVersions?.[playerId];
    const current = currentPacks[recorded?.id];
    if (!recorded || !current) continue;
    if (current.dataVersion !== recorded.dataVersion) {
      messages.push(
        `This battle used ${recorded.id} v${recorded.dataVersion}. ` +
        `A newer data version (v${current.dataVersion}) is available.`
      );
    }
  }
  return messages;
}
