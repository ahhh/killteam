/**
 * Battle state: plain, serializable, the single source of truth.
 *
 * Invariants:
 *  - The UI renders this; it never edits it (#2).
 *  - Anything the engine needs to resume a battle lives here, including the
 *    RNG stream position, so a state snapshot replays identically.
 */

export const STATE_VERSION = 1;

export const PHASES = {
  SETUP: 'setup',
  STRATEGY: 'strategy',
  FIREFIGHT: 'firefight',
  SCORE: 'score',
  COMPLETE: 'complete',
};

export const ORDERS = { ENGAGE: 'engage', CONCEAL: 'conceal' };

let uidCounter = 0;
/** Deterministic-per-battle ids (reset on each battle creation). */
function resetUid() { uidCounter = 0; }
function uid(prefix) { return `${prefix}-${++uidCounter}`; }

/**
 * Build the initial state. Operatives are created from the team packs but
 * are NOT yet placed on the board — deployment is a phase, not a constructor.
 */
export function createBattleState({ seed, map, mission, teams, engineVersion, aiVersion }) {
  resetUid();
  const operatives = {};
  const players = {};

  for (const playerId of ['p1', 'p2']) {
    const team = teams[playerId];
    players[playerId] = {
      id: playerId,
      teamId: team.id,
      teamName: team.displayName,
      factionId: team.factionId,
      cp: 0,
      victoryPoints: 0,
      vpBreakdown: {},
      colorId: playerId === 'p1' ? 'a' : 'b',
    };

    for (const entry of team.roster.operatives) {
      const profile = team.operatives.find((o) => o.id === entry.profileId);
      if (!profile) {
        throw new Error(`Team ${team.id}: roster references unknown profile "${entry.profileId}"`);
      }
      const count = entry.count ?? 1;
      for (let i = 0; i < count; i++) {
        const id = uid(`${playerId}-op`);
        operatives[id] = {
          id,
          playerId,
          profileId: profile.id,
          teamId: team.id,
          name: profile.name,
          role: profile.role || 'flexible',
          x: 0,
          y: 0,
          baseDiameter: profile.baseDiameter ?? 1.25,
          placed: false,
          alive: true,
          woundsRemaining: profile.stats.wounds,
          wounds: profile.stats.wounds,
          apl: profile.stats.apl,
          apRemaining: 0,
          move: profile.stats.move,
          save: profile.stats.save,
          order: ORDERS.CONCEAL,
          ready: true,
          activatedThisTurningPoint: false,
          statuses: [],
          stunned: false,
          stunnedAtActivationStart: false,
          /** Heavy: set when a Heavy weapon is used, cleared each activation. */
          heavyUsed: false,
          heavyMoveAllowed: null,
          /** Limited x: uses spent per weapon id, for the whole battle. */
          weaponUses: {},
          usedThisActivation: [],
          extraActions: {},
          freeActions: [],
          chargeWhileConceal: false,
          carriedMarkers: [],
        };
      }
    }
  }

  return {
    version: STATE_VERSION,
    engineVersion,
    aiVersion,
    seed: String(seed),
    rng: { seed: String(seed), index: 0 },

    mapId: map.id,
    map,
    mission,
    /** Team packs are kept on state so replays are self-contained (§27). */
    teamPacks: { p1: teams.p1, p2: teams.p2 },

    turningPoint: 0,
    phase: PHASES.SETUP,
    initiativePlayerId: null,
    activePlayerId: null,
    firstPlayerId: null,

    players,
    operatives,
    objectives: (map.objectives || []).map((o) => ({
      ...o,
      controlledBy: null,
    })),

    effects: [],
    eventLog: [],
    warnings: [],
    result: null,
  };
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

export function allOperatives(state) {
  return Object.values(state.operatives);
}

export function liveOperatives(state, playerId = null) {
  return allOperatives(state).filter(
    (o) => o.alive && o.placed && (playerId === null || o.playerId === playerId)
  );
}

export function enemiesOf(state, playerId) {
  return liveOperatives(state).filter((o) => o.playerId !== playerId);
}

export function opponentOf(playerId) {
  return playerId === 'p1' ? 'p2' : 'p1';
}

export function readyOperatives(state, playerId) {
  return liveOperatives(state, playerId).filter((o) => o.ready);
}

export function isBattleOver(state) {
  return state.phase === PHASES.COMPLETE;
}

/* ------------------------------------------------------------------ */
/* Event log                                                           */
/* ------------------------------------------------------------------ */

export const EVENTS = {
  BATTLE_STARTED: 'BATTLE_STARTED',
  DEPLOYED: 'DEPLOYED',
  TURN_STARTED: 'TURN_STARTED',
  INITIATIVE_ROLLED: 'INITIATIVE_ROLLED',
  CP_GAINED: 'CP_GAINED',
  OPERATIVE_ACTIVATED: 'OPERATIVE_ACTIVATED',
  ORDER_SELECTED: 'ORDER_SELECTED',
  MOVE_RESOLVED: 'MOVE_RESOLVED',
  ATTACK_ROLLED: 'ATTACK_ROLLED',
  DEFENCE_ROLLED: 'DEFENCE_ROLLED',
  DAMAGE_APPLIED: 'DAMAGE_APPLIED',
  OPERATIVE_INCAPACITATED: 'OPERATIVE_INCAPACITATED',
  ACTIVATION_ENDED: 'ACTIVATION_ENDED',
  OBJECTIVE_SCORED: 'OBJECTIVE_SCORED',
  VP_AWARDED: 'VP_AWARDED',
  TURN_ENDED: 'TURN_ENDED',
  GAME_ENDED: 'GAME_ENDED',
  RULE_APPLIED: 'RULE_APPLIED',
  WARNING: 'WARNING',
  AI_PLAN: 'AI_PLAN',
};

export function logEvent(state, type, payload = {}) {
  const event = {
    seq: state.eventLog.length,
    turningPoint: state.turningPoint,
    phase: state.phase,
    type,
    ...payload,
  };
  state.eventLog.push(event);
  return event;
}

/**
 * Record an encountered-but-unimplemented rule. Never silently guessed (#7).
 */
export function warnUnsupported(state, ruleId, detail = '') {
  const existing = state.warnings.find((w) => w.ruleId === ruleId);
  if (existing) {
    existing.count++;
    return;
  }
  state.warnings.push({ ruleId, detail, count: 1 });
  logEvent(state, EVENTS.WARNING, {
    ruleId,
    message: `Unsupported rule: ${ruleId}. Simulation continued without this modifier.`,
    detail,
  });
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}
