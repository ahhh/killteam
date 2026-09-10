/** Builders for small, hand-placed rules scenarios (§30). */
import { createBattleState } from '../src/state.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { AI_VERSION } from '../src/ai/controller.js';

export function rect(x, y, w, h) {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

export function weapon(over = {}) {
  return {
    id: 'w-test', name: 'Test Gun', type: 'ranged', atk: 4, hit: 4, range: 24,
    damage: { normal: 3, critical: 4 }, rules: [], ...over,
  };
}

export function melee(over = {}) {
  return {
    id: 'w-melee', name: 'Test Blade', type: 'melee', atk: 4, hit: 4,
    damage: { normal: 3, critical: 4 }, rules: [], ...over,
  };
}

function pack(id, profile) {
  return {
    id, factionId: 'test', displayName: id, supportLevel: profile.ruleHooks ? 3 : 1,
    dataVersion: 'test', source: { publisher: 'test', checkedAt: '2026-09-10' },
    roster: { maxOperatives: 1, operatives: [{ profileId: 'p', count: profile.count ?? 1 }] },
    operatives: [{
      id: 'p', name: profile.name ?? id, role: profile.role ?? 'flexible',
      baseDiameter: 1.25,
      stats: { move: profile.move ?? 6, apl: profile.apl ?? 2, save: profile.save ?? 4, wounds: profile.wounds ?? 10 },
      weapons: profile.weapons ?? [weapon(), melee()],
      abilities: [], keywords: profile.keywords ?? [],
    }],
    strategicPloys: profile.strategicPloys ?? [],
    firefightPloys: profile.firefightPloys ?? [],
    equipment: profile.equipment ?? [],
    ruleHooks: profile.ruleHooks ?? [],
    // Team-specific weapon rules, declared exactly as a real pack declares
    // them — see docs/rule-pack-format.md.
    weaponRules: profile.weaponRules ?? {},
    // Team resource economies — Pain tokens and their like.
    resources: profile.resources ?? {},
  };
}

/**
 * A minimal battle state with operatives placed exactly where you ask.
 * @param {{terrain?:Array, objectives?:Array, p1:object, p2:object}} spec
 */
export function makeState(spec) {
  const board = spec.board ?? { width: 30, height: 22, units: 'inches' };
  const map = {
    id: 'fixture', name: 'Fixture', version: 1, board,
    terrain: spec.terrain ?? [],
    objectives: spec.objectives ?? [],
    deploymentZones: [
      { id: 'dz-p1', playerId: 'p1', shape: { type: 'polygon', points: rect(0.5, 1, 5, 20) } },
      { id: 'dz-p2', playerId: 'p2', shape: { type: 'polygon', points: rect(24.5, 1, 5, 20) } },
    ],
    metadata: {},
  };
  const mission = spec.mission ?? {
    id: 'fixture-mission', name: 'Fixture', turningPoints: 4,
    scoring: { objectives: { vpPer: 1, maxPerTurningPoint: 3 }, kills: { vpPer: 1, maxPerTurningPoint: 2 } },
  };

  const state = createBattleState({
    seed: spec.seed ?? 'fixture',
    map, mission,
    teams: { p1: pack('t1', spec.p1), p2: pack('t2', spec.p2) },
    engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
  });

  // Place operatives exactly as the fixture asks.
  for (const playerId of ['p1', 'p2']) {
    const positions = spec[playerId].at ?? [];
    const ops = Object.values(state.operatives).filter((o) => o.playerId === playerId);
    ops.forEach((op, i) => {
      const pos = positions[i] ?? positions[0] ?? { x: 1, y: 1 };
      op.x = pos.x; op.y = pos.y; op.placed = true;
      op.order = pos.order ?? 'engage';
      op.apRemaining = op.apl;
    });
  }
  state.phase = 'firefight';
  state.turningPoint = 1;
  return state;
}

export function opsOf(state, playerId) {
  return Object.values(state.operatives).filter((o) => o.playerId === playerId);
}
