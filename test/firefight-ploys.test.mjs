/**
 * Firefight ploys: the CP a team spends after the strategy phase.
 *
 * Two windows, and they are different in kind. An ACTION ploy is bought during
 * a friendly operative's activation and is a 0-AP action like a resource
 * spend. A REACTION is bought inside somebody else's attack, where there is no
 * action layer to ask — so it follows the published policy in `rules/ploys.js`,
 * funded by the budget the controller's doctrine set aside.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, weapon, melee } from './fixtures.mjs';
import { loadTeam, loadMap, loadMission } from './harness.mjs';
import {
  playableFirefightPloys, firefightBlocker, findPloy, useFirefightPloy,
  expireActivationPloys, expireSequencePloys, cpSpentBreakdown,
} from '../src/rules/ploys.js';
import {
  resolveAction, getLegalActions, actionCost, ACTION_COST,
} from '../src/rules/engine.js';
import {
  applyActivationStartHook, applyDefenceHooks, applyIncomingAttackHooks, timesAllowed,
} from '../src/rules/hooks.js';
import { firefightPloysFor, valueFirefightPloy } from '../src/ai/ploys.js';
import { planCommandPoints, doctrineForPack, ployProfile } from '../src/ai/cp.js';
import { dispositionFor } from '../src/ai/tactics.js';
import { createBattleState, EVENTS, PHASES } from '../src/state.js';
import { runToCompletion, step } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';

/** "That operative can perform two Fight actions" — the commonest shape. */
const bladewind = {
  id: 'bladewind', name: 'BLADEWIND', cost: 1,
  description: 'During that activation, that operative can perform two Fight actions.',
  hooks: [{ trigger: 'onActionLegality', effect: { type: 'extraAction', action: 'fight', count: 1 } }],
};

/** A reaction: "your opponent cannot re-roll their attack dice". */
const contempt = {
  id: 'contempt', name: 'CONTEMPT', cost: 1, timing: 'defence',
  description: 'Until the end of the sequence, your opponent cannot re-roll their attack dice.',
  hooks: [{
    trigger: 'onIncomingAttack',
    effect: { type: 'ignoreWeaponRules', rules: ['balanced', 'ceaseless', 'relentless'] },
  }],
};

function stateWith(ploys, { cp = 3, plan = { reactionBudget: 0 }, p1 = {}, p2 = {} } = {}) {
  const s = makeState({
    p1: { at: [{ x: 5, y: 11 }], firefightPloys: ploys, ...p1 },
    p2: { at: [{ x: 5.9, y: 11 }], ...p2 },
  });
  s.players.p1.cp = cp;
  s.players.p1.cpPlan = plan;
  return s;
}

/* --- Buying one during an activation ---------------------------------- */

test('an action ploy is on the menu during an activation, and costs no AP', () => {
  const s = stateWith([bladewind]);
  const [op] = opsOf(s, 'p1');
  assert.deepEqual(playableFirefightPloys(s, op).map((p) => p.id), ['bladewind']);
  const offered = getLegalActions(s, op.id).filter((a) => a.type === 'ploy');
  assert.deepEqual(offered, [{ type: 'ploy', cost: 0, ployId: 'bladewind', ployName: 'BLADEWIND', cp: 1 }]);
});

test('buying one spends CP, logs it against the operative, and grants the action', () => {
  const s = stateWith([bladewind]);
  const [op] = opsOf(s, 'p1');
  assert.equal(timesAllowed(s, op, 'fight'), 1);

  const result = resolveAction(s, { type: 'ploy', ployId: 'bladewind', operativeId: op.id });
  assert.equal(result.ok, true);
  assert.equal(s.players.p1.cp, 2);
  assert.equal(op.apRemaining, op.apl, 'a ploy costs AP nothing');
  assert.equal(timesAllowed(s, op, 'fight'), 2);

  const log = s.eventLog.filter((e) => e.type === EVENTS.PLOY_USED);
  assert.equal(log.length, 1);
  assert.equal(log[0].operativeName, op.name);
  assert.equal(log[0].timing, 'activation');
  assert.deepEqual(cpSpentBreakdown(s, 'p1'), { strategic: 0, firefight: 1, reactive: 0 });
});

test('an action ploy reaches only the operative it was bought for', () => {
  const s = stateWith([bladewind], { p1: { count: 2, at: [{ x: 5, y: 11 }, { x: 7, y: 14 }] } });
  const [first, second] = opsOf(s, 'p1');
  useFirefightPloy(s, first, 'bladewind');
  assert.equal(timesAllowed(s, first, 'fight'), 2);
  assert.equal(timesAllowed(s, second, 'fight'), 1, 'the other operative paid for nothing');
});

test('it lapses when the activation it was bought for ends', () => {
  const s = stateWith([bladewind]);
  const [op] = opsOf(s, 'p1');
  useFirefightPloy(s, op, 'bladewind');
  expireActivationPloys(s, op);
  assert.equal(timesAllowed(s, op, 'fight'), 1);
});

test('a ploy the team cannot afford is rejected rather than trusted', () => {
  const s = stateWith([bladewind], { cp: 0 });
  const [op] = opsOf(s, 'p1');
  const blocked = firefightBlocker(s, op, findPloy(s.teamPacks.p1, 'bladewind'));
  assert.match(blocked, /costs 1 CP/);
  const result = resolveAction(s, { type: 'ploy', ployId: 'bladewind', operativeId: op.id });
  assert.equal(result.ok, false);
  assert.equal(s.players.p1.cp, 0);
});

test('a reaction cannot be bought as an action — it has its own window', () => {
  const s = stateWith([contempt]);
  const [op] = opsOf(s, 'p1');
  assert.deepEqual(playableFirefightPloys(s, op), []);
  assert.match(firefightBlocker(s, op, findPloy(s.teamPacks.p1, 'contempt')),
    /when this operative is attacked/);
});

/* --- What the effects do ----------------------------------------------- */

test('an APL ploy bought mid-activation buys AP the operative can still spend', () => {
  const s = stateWith([{
    id: 'surge', name: 'SURGE', cost: 1, description: '+1 APL',
    hooks: [{ trigger: 'onActivationStart', effect: { type: 'addApl', amount: 1 } }],
  }]);
  const [op] = opsOf(s, 'p1');
  op.apRemaining = 1;
  op.usedThisActivation = ['reposition'];
  resolveAction(s, { type: 'ploy', ployId: 'surge', operativeId: op.id });
  assert.equal(op.apRemaining, 2);
});

test('a discount makes one action cheaper, and only that action', () => {
  const s = stateWith([{
    id: 'fade', name: 'FADE', cost: 1, description: 'Fall Back for 1 less AP',
    hooks: [{
      trigger: 'onActivationStart',
      effect: { type: 'discountAction', action: 'fall_back', amount: 1 },
    }],
  }]);
  const [op] = opsOf(s, 'p1');
  assert.equal(actionCost(s, op, 'fall_back'), ACTION_COST.fall_back);
  resolveAction(s, { type: 'ploy', ployId: 'fade', operativeId: op.id });
  assert.equal(actionCost(s, op, 'fall_back'), 0);
  assert.equal(actionCost(s, op, 'reposition'), 1, 'other actions still cost what they cost');
});

/* --- Reactions ---------------------------------------------------------- */

test('a reaction is bought when the doctrine set a budget aside', () => {
  const s = stateWith([contempt], { plan: { reactionBudget: 1, reactionTrigger: 'always' } });
  const [defender] = opsOf(s, 'p1');
  const [attacker] = opsOf(s, 'p2');

  const incoming = weapon({ rules: ['balanced'] });
  const after = applyIncomingAttackHooks(s, defender, incoming, { attacker, action: 'shoot' });
  assert.deepEqual(after.rules, [], 'the attack loses its re-roll');
  assert.equal(s.players.p1.cp, 2);
  assert.deepEqual(cpSpentBreakdown(s, 'p1'), { strategic: 0, firefight: 0, reactive: 1 });
});

test('with no reaction budget the attack goes through untouched', () => {
  const s = stateWith([contempt], { plan: { reactionBudget: 0 } });
  const [defender] = opsOf(s, 'p1');
  const [attacker] = opsOf(s, 'p2');
  const after = applyIncomingAttackHooks(s, defender, weapon({ rules: ['balanced'] }),
    { attacker, action: 'shoot' });
  assert.deepEqual(after.rules, ['balanced']);
  assert.equal(s.players.p1.cp, 3, 'nothing was paid');
});

test('a reaction is bought once per sequence, and lapses with it', () => {
  const shield = {
    id: 'shield', name: 'SHIELD', cost: 1, timing: 'defence',
    description: 'One additional defence dice, and the damage is capped.',
    hooks: [
      { trigger: 'beforeDefenceRoll', effect: { type: 'modifyDefenceDice', delta: 1 } },
      { trigger: 'beforeDamageApplied', effect: { type: 'reduceDamage', amount: 2 } },
    ],
  };
  const s = stateWith([shield], { plan: { reactionBudget: 2, reactionTrigger: 'always' } });
  const [defender] = opsOf(s, 'p1');
  const [attacker] = opsOf(s, 'p2');

  const first = applyDefenceHooks(s, defender, weapon(), { attacker, action: 'shoot' });
  assert.equal(first.diceDelta, 1);
  assert.equal(s.players.p1.cp, 2, 'one CP, once');

  // Still in force for the rest of the same sequence — the damage window too.
  const second = applyDefenceHooks(s, defender, weapon(), { attacker, action: 'shoot' });
  assert.equal(second.diceDelta, 1);
  assert.equal(s.players.p1.cp, 2, 'no second purchase inside one sequence');

  expireSequencePloys(s);
  const later = applyDefenceHooks(s, defender, weapon(), { attacker, action: 'shoot' });
  assert.equal(later.diceDelta, 1, 'a fresh sequence may buy it again');
  assert.equal(s.players.p1.cp, 1);
});

test('the "lethal" trigger holds the CP for an attack that could actually kill', () => {
  const s = stateWith([contempt], { plan: { reactionBudget: 1, reactionTrigger: 'lethal' } });
  const [defender] = opsOf(s, 'p1');
  const [attacker] = opsOf(s, 'p2');

  const pistol = weapon({ atk: 1, damage: { normal: 1, critical: 1 }, rules: ['balanced'] });
  applyIncomingAttackHooks(s, defender, pistol, { attacker, action: 'shoot' });
  assert.equal(s.players.p1.cp, 3, 'a scratch is not worth a Command Point');

  const cannon = weapon({ atk: 6, damage: { normal: 5, critical: 6 }, rules: ['balanced'] });
  const after = applyIncomingAttackHooks(s, defender, cannon, { attacker, action: 'shoot' });
  assert.equal(s.players.p1.cp, 2);
  assert.deepEqual(after.rules, []);
});

/* --- The AI's choice ---------------------------------------------------- */

test('a second Fight is worth a CP to a melee plan and nothing to a shooting one', () => {
  const s = stateWith([bladewind], { p1: { at: [{ x: 5, y: 11 }], weapons: [weapon(), melee()] } });
  const [op] = opsOf(s, 'p1');
  const ploy = findPloy(s.teamPacks.p1, 'bladewind');
  const disposition = dispositionFor(s, 'p1');

  const inMelee = valueFirefightPloy(s, op, ploy, disposition, 'melee').score;
  const shooting = valueFirefightPloy(s, op, ploy, disposition, 'shoot').score;
  assert.ok(inMelee > 0, 'the charge plan wants it');
  assert.equal(shooting, 0, 'the shooting plan has nothing to do with it');
});

test('the AI plans the ploy as an optional action, and keeps the reaction budget back', () => {
  const s = stateWith([bladewind], {
    cp: 2,
    plan: { reactionBudget: 1, firefightBar: 0.5, maxPerActivation: 1 },
    p1: { at: [{ x: 5, y: 11 }], weapons: [melee()] },
  });
  const [op] = opsOf(s, 'p1');
  const bought = firefightPloysFor(s, op, 'melee');
  assert.deepEqual(bought.actions, [{ type: 'ploy', ployId: 'bladewind', optional: true }]);
  assert.equal(bought.extraFights, 1);
  assert.equal(bought.cpSpent, 1, 'the other point is held for the reaction');

  const broke = firefightPloysFor(s, op, 'melee', { plan: { reactionBudget: 2, firefightBar: 0.5 } });
  assert.deepEqual(broke.actions, [], 'nothing left to spend');
});

/* --- Doctrine ----------------------------------------------------------- */

test('teams run the doctrine their ploys and disposition imply', () => {
  const seen = new Map();
  for (const id of ['blades-of-khaine', 'skycaste-marksmen', 'angel-of-death', 'mandrakes']) {
    seen.set(id, doctrineForPack(loadTeam(id)).name);
  }
  assert.equal(seen.get('blades-of-khaine'), 'vanguard');
  assert.equal(seen.get('skycaste-marksmen'), 'gunline');
  assert.equal(seen.get('angel-of-death'), 'bulwark');
  assert.equal(seen.get('mandrakes'), 'raider');
  assert.ok(new Set(seen.values()).size >= 3, 'teams do not all play CP the same way');
});

test('a pack override names the doctrine', () => {
  const pack = { ...loadTeam('kommandos'), aiCpDoctrine: 'bulwark' };
  assert.equal(doctrineForPack(pack).name, 'bulwark');
});

test('a team with no reactive ploys holds no reaction budget', () => {
  const s = stateWith([bladewind], { cp: 3, plan: null });
  s.players.p1.cpPlan = null;
  const plan = planCommandPoints(s, 'p1');
  assert.equal(plan.reactionBudget, 0);
  assert.equal(ployProfile(s.teamPacks.p1).reactive, 0);
});

test('a reactive team holds a point back, and the strategy phase is told why', () => {
  const s = stateWith([contempt], { cp: 3, plan: null });
  s.players.p1.cpPlan = null;
  s.teamPacks.p1.aiCpDoctrine = 'bulwark';
  const plan = planCommandPoints(s, 'p1');
  assert.ok(plan.reserve >= 1, `expected a reserve, got ${plan.reserve}`);
  assert.ok(plan.reactionBudget >= 1);
  assert.match(plan.rationale, /CONTEMPT/);
});

test('the last turning point spends what it has: unspent CP scores nothing', () => {
  const s = stateWith([bladewind], { cp: 2, plan: null });
  s.turningPoint = s.mission.turningPoints;
  const plan = planCommandPoints(s, 'p1');
  assert.ok(plan.strategicBar < 0.1, `bar should collapse, got ${plan.strategicBar}`);
});

/* --- End to end --------------------------------------------------------- */

test('a whole battle puts its Command Points to work', () => {
  const map = loadMap('industrial-001');
  const mission = loadMission('secure-and-hold');
  const kinds = new Set();
  let spent = 0;
  let games = 0;

  for (const [a, b] of [['blades-of-khaine', 'angel-of-death'], ['kommandos', 'sanctifiers']]) {
    for (const seed of ['cp-a', 'cp-b']) {
      const state = createBattleState({
        seed, map, mission,
        teams: { p1: loadTeam(a), p2: loadTeam(b) },
        engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
      });
      runToCompletion(state, createControllers());
      games++;
      for (const playerId of ['p1', 'p2']) {
        const used = cpSpentBreakdown(state, playerId);
        spent += used.strategic + used.firefight + used.reactive;
        for (const [kind, amount] of Object.entries(used)) if (amount) kinds.add(kind);
        assert.ok(state.players[playerId].cp <= 2,
          `${playerId} finished sitting on ${state.players[playerId].cp} CP`);
      }
      const rejected = state.eventLog.filter((e) => e.ruleId === 'illegal-ploy-rejected');
      assert.deepEqual(rejected, [], 'the AI never proposes a ploy it cannot pay for');
    }
  }

  assert.ok(spent / games >= 4, `teams spent only ${(spent / games).toFixed(1)} CP per battle`);
  assert.ok(kinds.size >= 2, `CP went to only one kind of ploy: ${[...kinds]}`);
});

test('a counteraction runs its start-of-activation hooks like an activation', () => {
  // The counteraction path is rarely reached in a whole battle — one side has
  // to run out of ready operatives first — so it is driven directly here. A
  // start-of-activation hook may roll dice, and this is the path that had no
  // dice stream to roll with.
  const s = makeState({
    p1: { at: [{ x: 5, y: 11 }], weapons: [weapon(), melee()] },
    p2: { at: [{ x: 6, y: 11 }], weapons: [weapon(), melee()] },
  });
  s.phase = PHASES.FIREFIGHT;
  s.activePlayerId = 'p1';
  const [mine] = opsOf(s, 'p1');
  const [theirs] = opsOf(s, 'p2');
  mine.ready = false;            // nothing of ours left to activate
  mine.counteracted = false;
  theirs.ready = true;

  const outcome = step(s, createControllers());
  assert.equal(outcome.kind, 'counteract');
  assert.match(outcome.description, /counteracts|no ready operatives/);
});
