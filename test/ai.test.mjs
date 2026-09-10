import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattleState, allOperatives, liveOperatives, EVENTS } from '../src/state.js';
import { runToCompletion } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { loadTeam, loadMap, loadMission, readJson, ROOT } from './harness.mjs';
import { makeState, opsOf, rect, weapon } from './fixtures.mjs';
import { UtilityController } from '../src/ai/controller.js';
import {
  dispositionFor, unitTacticsFor, applyTactics, DISPOSITIONS,
  TEAM_DISPOSITIONS, FACTION_DISPOSITIONS,
} from '../src/ai/tactics.js';
import fs from 'node:fs';
import path from 'node:path';

const map = loadMap('industrial-001');
const mission = loadMission('secure-and-hold');
const TEAMS = ['vanguard-wardens', 'vanguard-breachers', 'ash-cultists',
               'corsair-skirmishers', 'scrap-raiders', 'skycaste-marksmen'];

function battle(seed, a, b) {
  const state = createBattleState({
    seed, map, mission,
    teams: { p1: loadTeam(a), p2: loadTeam(b) },
    engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
  });
  runToCompletion(state, createControllers());
  return state;
}

test('the AI never has an action rejected as illegal', () => {
  for (const [i, seed] of ['a1', 'a2', 'a3', 'a4'].entries()) {
    const s = battle(seed, TEAMS[i % TEAMS.length], TEAMS[(i + 3) % TEAMS.length]);
    const rejected = s.eventLog.filter((e) => e.ruleId === 'illegal-action-rejected');
    assert.deepEqual(
      rejected.map((r) => r.message), [],
      `seed ${seed} produced rejected actions`
    );
  }
});

test('operatives always stay on the board', () => {
  const s = battle('bounds', 'corsair-skirmishers', 'scrap-raiders');
  const { width, height } = s.map.board;
  for (const op of allOperatives(s)) {
    if (!op.placed) continue;
    const r = op.baseDiameter / 2;
    assert.ok(op.x - r >= -1e-6 && op.x + r <= width + 1e-6, `${op.id} off board in x at ${op.x}`);
    assert.ok(op.y - r >= -1e-6 && op.y + r <= height + 1e-6, `${op.id} off board in y at ${op.y}`);
  }
});

test('no operative acts after being incapacitated', () => {
  const s = battle('dead-men', 'ash-cultists', 'vanguard-breachers');
  const downAt = new Map();
  for (const e of s.eventLog) {
    if (e.type === EVENTS.OPERATIVE_INCAPACITATED) downAt.set(e.operativeId, e.seq);
    const actor = e.operativeId ?? e.attackerId;
    if (!actor || !downAt.has(actor)) continue;
    const acting = [EVENTS.MOVE_RESOLVED, EVENTS.ATTACK_ROLLED, EVENTS.OPERATIVE_ACTIVATED];
    assert.ok(
      !acting.includes(e.type) || e.seq < downAt.get(actor),
      `${actor} performed ${e.type} after being incapacitated`
    );
  }
});

test('the AI prefers a reachable objective over aimless movement', () => {
  // One operative, no enemies in sight, one objective 4" away.
  const s = makeState({
    objectives: [{ id: 'obj-1', x: 9, y: 11, controlRange: 1 }],
    p1: { at: [{ x: 5, y: 11 }] },
    p2: { at: [{ x: 28, y: 2 }] },
  });
  const ai = new UtilityController('p1');
  const [op] = opsOf(s, 'p1');
  const intent = ai.planActivation(s, op.id);
  const move = intent.actions.find((a) => a.type === 'reposition' || a.type === 'dash');
  assert.ok(move, 'expected the AI to move');
  const d = Math.hypot(move.destination.x - 9, move.destination.y - 11);
  assert.ok(d <= 1.5, `expected to end on the objective, ended ${d.toFixed(2)}" away`);
});

test('every AI decision carries an explanation', () => {
  const s = battle('explain', 'skycaste-marksmen', 'scrap-raiders');
  const plans = s.eventLog.filter((e) => e.type === EVENTS.AI_PLAN);
  assert.ok(plans.length > 10, 'expected many recorded plans');
  for (const p of plans) {
    assert.ok(Array.isArray(p.rationale) && p.rationale.length, 'plan without rationale');
    assert.ok(p.considered > 0, 'plan without a candidate count');
  }
});

test('all six shipped teams can complete a battle against each other', () => {
  for (let i = 0; i < TEAMS.length; i++) {
    const a = TEAMS[i];
    const b = TEAMS[(i + 1) % TEAMS.length];
    const s = battle(`matrix-${i}`, a, b);
    assert.equal(s.phase, 'complete', `${a} vs ${b} failed to finish`);
    assert.deepEqual(s.warnings, [], `${a} vs ${b} produced warnings`);
  }
});

/* ------------------------------------------------------------------ */
/* Firing positions                                                    */
/* ------------------------------------------------------------------ */

/** A wall between two operatives, with clear ground to step around it. */
function blockedLaneState(extra = {}) {
  return makeState({
    terrain: [{
      id: 'wall', shape: { type: 'polygon', points: rect(13, 3, 2, 2) },
      height: 3, traits: ['obscuring', 'cover', 'blocking'], render: {},
    }],
    p1: { at: [{ x: 10, y: 4 }], role: 'ranged', ...(extra.p1 ?? {}) },
    p2: { at: [{ x: 18, y: 4 }], role: 'ranged', ...(extra.p2 ?? {}) },
  });
}

test('a shooter steps out to a firing position rather than holding in cover', () => {
  // The candidate destinations that offer a shot are, by definition, the ones
  // an enemy can see — so a pre-filter that ranks on safety alone hands the
  // shot search nothing but blind spots, and the operative holds all game.
  const s = blockedLaneState();
  const [op] = opsOf(s, 'p1');
  const intent = new UtilityController('p1').planActivation(s, op.id);

  assert.ok(
    intent.actions.some((a) => a.type === 'shoot'),
    `expected a shot to be planned, got: ${intent.rationale.join(' | ')}`
  );
});

test('operatives spend the AP they have', () => {
  // A whole team holding position with full AP is the symptom that says plan
  // enumeration came back empty.
  const s = battle('spend', 'skycaste-marksmen', 'ash-cultists');
  const plans = s.eventLog.filter((e) => e.type === EVENTS.AI_PLAN);
  const idle = plans.filter((p) => p.rationale.some((r) => /No useful action/.test(r)));
  assert.ok(
    idle.length / plans.length < 0.3,
    `${idle.length} of ${plans.length} activations did nothing at all`
  );
});

/* ------------------------------------------------------------------ */
/* Faction disposition                                                 */
/* ------------------------------------------------------------------ */

test('a disposition is resolved from the team, then its faction, then balanced', () => {
  const state = { teamPacks: { p1: { id: 'kommandos', factionId: 'orks' } } };
  assert.equal(dispositionFor(state, 'p1').name, 'aggressive');

  state.teamPacks.p1 = { id: 'ratlings', factionId: 'astra-militarum' };
  assert.equal(dispositionFor(state, 'p1').name, 'patient');

  state.teamPacks.p1 = { id: 'made-up', factionId: 'also-made-up' };
  assert.equal(dispositionFor(state, 'p1').name, 'balanced');
});

test('a rule pack can name or inline its own disposition', () => {
  const named = { teamPacks: { p1: { id: 'x', factionId: 'y', aiDisposition: 'relentless' } } };
  assert.equal(dispositionFor(named, 'p1').name, 'relentless');

  const inline = {
    teamPacks: { p1: { id: 'x', factionId: 'y', aiDisposition: { label: 'Mad', mods: { damage: 2 } } } },
  };
  const custom = dispositionFor(inline, 'p1');
  assert.equal(custom.label, 'Mad');
  assert.equal(custom.mods.damage, 2);
});

test('dispositions scale the role weights and can floor the drive to close', () => {
  const base = { damage: 3, approach: 0.5, exposure: 2 };
  const out = applyTactics(base, DISPOSITIONS.aggressive.mods);
  assert.ok(out.damage > base.damage, 'aggressive should value damage more');
  assert.ok(out.exposure < base.exposure, 'aggressive should fear exposure less');
  assert.ok(out.approach >= 3.5, 'aggressive should floor the approach weight');
  // Unknown keys are ignored rather than invented.
  assert.deepEqual(Object.keys(applyTactics(base, { nonsense: 9 })).sort(),
                   Object.keys(base).sort());
});

test('an aggressive kill team closes harder than a gunline one', () => {
  const distanceClosedBy = (disposition) => {
    const s = blockedLaneState();
    s.teamPacks.p1.aiDisposition = disposition;
    const [op] = opsOf(s, 'p1');
    const [enemy] = opsOf(s, 'p2');
    const before = Math.hypot(enemy.x - op.x, enemy.y - op.y);
    const intent = new UtilityController('p1').planActivation(s, op.id);
    const end = [...intent.actions].reverse().find((a) => a.destination)?.destination
      ?? { x: op.x, y: op.y };
    return before - Math.hypot(enemy.x - end.x, enemy.y - end.y);
  };
  assert.ok(
    distanceClosedBy('aggressive') > distanceClosedBy('patient'),
    'aggressive should end the activation closer to the enemy than a gunline'
  );
});

/* ------------------------------------------------------------------ */
/* Per-unit tactics                                                    */
/* ------------------------------------------------------------------ */

const EXPLOSIVE_RULES = {
  explosive: {
    rule: 'Explosive', text: 'The bearer is always the primary target.',
    effect: { type: 'selfPrimaryTarget', shootSelf: true, allowWhileEngaged: true },
  },
};

test('unit tactics are read off the profile', () => {
  const s = makeState({
    p1: {
      name: 'Squig', role: 'assault', wounds: 5,
      weapons: [weapon({ id: 'w-bomb', name: 'Explosives', rules: ['blast1', 'explosive'], range: 6 })],
      weaponRules: EXPLOSIVE_RULES,
      at: [{ x: 10, y: 11 }],
    },
    p2: {
      name: 'Caster', role: 'ranged',
      weapons: [weapon({ id: 'w-spell', name: 'Doomhowl', rules: ['psychic'] }),
                weapon({ id: 'w-flame', name: 'Flamer', rules: ['torrent2'] })],
      keywords: ['psyker'],
      at: [{ x: 20, y: 11 }],
    },
  });
  const [squig] = opsOf(s, 'p1');
  const [caster] = opsOf(s, 'p2');

  const bomb = unitTacticsFor(s, squig);
  assert.equal(bomb.detonator, 1, 'Explosive weapons make an operative a detonator');
  assert.ok(bomb.mods.exposure < 1, 'a delivery system should stop fearing exposure');

  const spells = unitTacticsFor(s, caster);
  assert.ok(spells.psyker && spells.spellBonus > 0, 'a psyker should value casting');
  assert.equal(spells.multiHit, 2, 'Torrent 2" makes an operative a multi-hit shooter');
  assert.equal(spells.detonator, null, 'nothing here detonates on itself');
});

test('a bomb squig walks into the crowd and detonates', () => {
  const s = makeState({
    p1: {
      name: 'Squig', role: 'assault', wounds: 5, apl: 3,
      weapons: [weapon({ id: 'w-bomb', name: 'Explosives', rules: ['blast1', 'explosive'], range: 6 })],
      weaponRules: EXPLOSIVE_RULES,
      at: [{ x: 12, y: 11 }],
    },
    // Three enemies in a tight knot, 4" away: exactly what a charge is for.
    p2: { count: 3, at: [{ x: 16, y: 11 }, { x: 16.9, y: 11.7 }, { x: 16.9, y: 10.3 }] },
  });
  const [squig] = opsOf(s, 'p1');
  const intent = new UtilityController('p1').planActivation(s, squig.id);

  const shoot = intent.actions.find((a) => a.type === 'shoot');
  assert.ok(shoot, `expected a detonation, got: ${intent.rationale.join(' | ')}`);
  assert.equal(shoot.targetId, squig.id, 'an Explosive weapon targets its own bearer');

  const move = intent.actions.find((a) => a.destination);
  assert.ok(move, 'expected the squig to close on the crowd first');
  const reach = Math.hypot(move.destination.x - 16.5, move.destination.y - 11);
  assert.ok(reach < 3, `expected to end up in the crowd, ended ${reach.toFixed(1)}" away`);
});

test('an area weapon picks the target with company', () => {
  const s = makeState({
    p1: {
      name: 'Burna', role: 'ranged',
      weapons: [weapon({ id: 'w-burna', name: 'Burna', rules: ['torrent2'], range: 18 })],
      at: [{ x: 10, y: 11 }],
    },
    p2: { count: 3, at: [{ x: 16, y: 4 }, { x: 16, y: 16 }, { x: 16.8, y: 16.6 }] },
  });
  const ai = new UtilityController('p1');
  const [op] = opsOf(s, 'p1');
  const intent = ai.planActivation(s, op.id);
  const shoot = intent.actions.find((a) => a.type === 'shoot');
  assert.ok(shoot, 'expected a shot');

  const target = s.operatives[shoot.targetId];
  const crowded = opsOf(s, 'p2').filter(
    (e) => e.id !== target.id && Math.hypot(e.x - target.x, e.y - target.y) <= 2
  );
  assert.ok(crowded.length >= 1, 'expected the flamer to pick a clustered target');
});

test('a psyker casts rather than reaching for its sidearm', () => {
  const s = makeState({
    p1: {
      name: 'Caster', role: 'ranged', keywords: ['psyker'],
      weapons: [
        weapon({ id: 'w-spell', name: 'Doomhowl', rules: ['psychic'], atk: 4, hit: 4 }),
        // A marginally better gun on paper: only the value of the spell itself
        // should decide this.
        weapon({ id: 'w-pistol', name: 'Pistol', atk: 4, hit: 4, damage: { normal: 3, critical: 5 } }),
      ],
      at: [{ x: 10, y: 11 }],
    },
    p2: { at: [{ x: 18, y: 11 }] },
  });
  const [op] = opsOf(s, 'p1');
  const intent = new UtilityController('p1').planActivation(s, op.id);
  const shoot = intent.actions.find((a) => a.type === 'shoot');
  assert.ok(shoot, 'expected the psyker to attack');
  assert.equal(shoot.weaponId, 'w-spell', 'expected the spell, not the sidearm');
});

test('the AI never catches its own operatives in a blast it chooses', () => {
  const s = battle('blast-discipline', 'scrap-raiders', 'ash-cultists');
  const friendlyHits = s.eventLog.filter(
    (e) => e.type === EVENTS.DAMAGE_APPLIED && e.splash &&
      s.operatives[e.operativeId]?.playerId === s.operatives[e.attackerId]?.playerId
  );
  assert.deepEqual(friendlyHits.map((e) => e.message ?? e.operativeId), []);
});

test('every disposition table key names a team or faction that ships', () => {
  const dir = path.join(ROOT, 'data', 'teams');
  const packs = fs.readdirSync(dir).map((f) => readJson(path.join('data', 'teams', f)));
  const teamIds = new Set(packs.map((p) => p.id));
  const factionIds = new Set(packs.map((p) => p.factionId));

  for (const id of Object.keys(TEAM_DISPOSITIONS)) {
    assert.ok(teamIds.has(id), `TEAM_DISPOSITIONS has no such team: ${id}`);
  }
  for (const id of Object.keys(FACTION_DISPOSITIONS)) {
    assert.ok(factionIds.has(id), `FACTION_DISPOSITIONS has no such faction: ${id}`);
  }
  for (const name of [...Object.values(TEAM_DISPOSITIONS), ...Object.values(FACTION_DISPOSITIONS)]) {
    assert.ok(name in DISPOSITIONS, `unknown disposition "${name}"`);
  }
});
