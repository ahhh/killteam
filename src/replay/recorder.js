/**
 * Replay capture (§27).
 *
 * Because the simulation is deterministic, a replay is really just the inputs
 * plus a recorded event stream to verify against. We store both: the inputs
 * so the battle can be re-run, and the events so we can prove the re-run
 * matched. Data versions are snapshotted, never referenced by id, so an
 * updated team pack cannot silently rewrite an old battle (§29).
 */
import { ENGINE_VERSION } from '../rules/engine.js';
import { AI_VERSION } from '../ai/controller.js';

export const REPLAY_VERSION = 1;

export function buildReplay(state) {
  return {
    replayVersion: REPLAY_VERSION,
    engineVersion: state.engineVersion ?? ENGINE_VERSION,
    aiVersion: state.aiVersion ?? AI_VERSION,
    seed: state.seed,
    recordedAt: new Date().toISOString(),
    map: state.map,
    mission: state.mission,
    teams: { p1: state.teamPacks.p1, p2: state.teamPacks.p2 },
    dataVersions: {
      p1: dataStamp(state.teamPacks.p1),
      p2: dataStamp(state.teamPacks.p2),
      map: state.map.version ?? null,
      mission: state.mission.version ?? null,
    },
    result: state.result,
    warnings: state.warnings,
    events: state.eventLog,
  };
}

function dataStamp(pack) {
  return {
    id: pack.id,
    dataVersion: pack.dataVersion ?? null,
    supportLevel: pack.supportLevel ?? null,
    checkedAt: pack.source?.checkedAt ?? null,
  };
}

/** A compact fingerprint of everything that must reproduce exactly. */
export function digestEvents(events) {
  let h = 2166136261 >>> 0;
  for (const e of events) {
    // `rolls` is an array on attacks but an object on the initiative roll-off.
    const rolls = Array.isArray(e.rolls)
      ? e.rolls.join(',')
      : e.rolls ? Object.entries(e.rolls).map(([k, v]) => `${k}=${v}`).join(',') : '';
    const s = `${e.seq}|${e.type}|${e.operativeId ?? ''}|${e.attackerId ?? ''}|` +
      `${rolls}|${e.amount ?? ''}|${e.to ? `${e.to.x.toFixed(3)},${e.to.y.toFixed(3)}` : ''}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

export function toJson(replay) {
  return JSON.stringify(replay, null, 2);
}

/** Plain-text battle log, for the "Export battle log" control (§26). */
export function toBattleLogText(replay) {
  const lines = [
    `Kill Team Battle Simulator — battle log`,
    `Seed:    ${replay.seed}`,
    `Map:     ${replay.map.name} (${replay.map.id})`,
    `Mission: ${replay.mission.name}`,
    `Teams:   ${replay.teams.p1.displayName} vs ${replay.teams.p2.displayName}`,
    `Engine:  ${replay.engineVersion} / AI ${replay.aiVersion}`,
    `Digest:  ${digestEvents(replay.events)}`,
    '',
  ];
  let tp = null;
  for (const e of replay.events) {
    if (e.turningPoint !== tp) {
      tp = e.turningPoint;
      lines.push('', `--- Turning Point ${tp} ---`);
    }
    lines.push(`  ${describeEvent(e)}`);
  }
  if (replay.result) lines.push('', `RESULT: ${replay.result.summary}`);
  if (replay.warnings?.length) {
    lines.push('', 'Unsupported rules encountered:');
    for (const w of replay.warnings) lines.push(`  - ${w.ruleId} (x${w.count}) ${w.detail}`);
  }
  return lines.join('\n');
}

/** One human-readable line per event — shared by the log panel and export. */
export function describeEvent(e) {
  switch (e.type) {
    case 'BATTLE_STARTED': return `Battle begins on ${e.mapId} (seed ${e.seed}).`;
    case 'DEPLOYED': return `${e.operativeName} deploys at ${e.x}", ${e.y}".`;
    case 'TURN_STARTED': return `Turning Point ${e.turningPoint} begins.`;
    case 'INITIATIVE_ROLLED':
      return `Initiative: ${e.rolls.p1} vs ${e.rolls.p2} — ${e.winner} goes first.`;
    case 'CP_GAINED': return `${e.playerId} gains ${e.amount} CP (${e.total} total).`;
    case 'OPERATIVE_ACTIVATED':
      return `${e.operativeName} activates${e.counteract ? ' (Counteract)' : ''} with ${e.ap} AP.`;
    case 'ORDER_SELECTED': return `${e.operativeName} switches to ${e.order}.`;
    case 'MOVE_RESOLVED':
      return `${e.operativeName} ${e.action.replace('_', ' ')}s ${e.distance}" ` +
        `to ${e.to.x.toFixed(1)}", ${e.to.y.toFixed(1)}".`;
    case 'ATTACK_ROLLED':
      return e.kind === 'fight'
        ? `${e.attackerName} fights ${e.targetName}: [${e.rolls.join(' ')}] vs [${e.defenderRolls.join(' ')}].`
        : `${e.attackerName} shoots ${e.targetName} with ${e.weapon} at ${e.range}": ` +
          `[${e.rolls.join(' ')}] hit on ${e.hitOn}+ → ${e.normals} normal, ${e.crits} crit.`;
    case 'DEFENCE_ROLLED':
      return `${e.operativeName} defends: [${e.rolls.join(' ')}] save on ${e.saveOn}+` +
        `${e.rerolled?.length ? ` (re-rolled ${e.rerolled.map((r) => `${r.from}→${r.to}`).join(', ')})` : ''}` +
        `${e.coverSave ? ' (+1 retained for cover)' : ''} → ${e.normals} normal, ${e.crits} crit.`;
    case 'DAMAGE_APPLIED':
      return `${e.operativeName} takes ${e.amount} damage (${e.woundsRemaining} wounds left).`;
    case 'OPERATIVE_INCAPACITATED': return `${e.operativeName} is incapacitated.`;
    case 'ACTIVATION_ENDED':
      return e.apUnspent ? `${e.operativeName} ends activation with ${e.apUnspent} AP unspent.` : '';
    case 'OBJECTIVE_SCORED':
      return `${e.playerId} holds ${e.objectives.join(', ')} for ${e.vp} VP.`;
    case 'VP_AWARDED': return `${e.playerId} scores ${e.amount} VP (${e.reason}) — ${e.total} total.`;
    case 'TURN_ENDED':
      return `Turning Point ${e.turningPoint} ends. VP ${e.vp.p1}–${e.vp.p2}.`;
    case 'GAME_ENDED': return e.summary;
    case 'RULE_APPLIED':
      return `${e.rule}: ${e.operativeName ? `${e.operativeName} ` : ''}${e.detail}.`;
    case 'AI_PLAN': return `${e.operativeName} plans: ${e.rationale.join(' · ')}`;
    case 'WARNING': return `[WARN] ${e.message}`;
    default: return e.type;
  }
}
