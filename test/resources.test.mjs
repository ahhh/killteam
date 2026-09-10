import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, weapon, melee, rect } from './fixtures.mjs';
import { getLegalActions, resolveAction, moveAllowance } from '../src/rules/engine.js';
import {
  applyPostActionResources, availableSpends, amountOf, resourceReadyStep,
  changeResource, describeResource, diceRerollSpend,
} from '../src/rules/resources.js';
import { applyDamage, effectiveApl } from '../src/rules/effects.js';
import { grantToken, resolveActivationTokens } from '../src/rules/tokens.js';
import { isWithinShadow } from '../src/rules/terrain.js';
import { weaponAdjustments } from '../src/rules/team-rules.js';
import { rollAttack } from '../src/rules/dice.js';
import { openingSpends, meleeSpends } from '../src/ai/spending.js';
import { DASH_DISTANCE } from '../src/rules/movement.js';
import { Rng } from '../src/rng.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Power From Pain, cut down to what a test needs. */
function painResource(over = {}) {
  return {
    pain: {
      name: 'Pain token', rule: 'Power From Pain', text: 'the printed wording',
      scope: 'operative', keyword: 'kabalite', perActivation: 1,
      gains: [
        { trigger: 'enemyInjured', amount: 1 },
        { trigger: 'enemyIncapacitated', amount: 1, bonusIfWoundsAtLeast: { wounds: 12, amount: 2 } },
      ],
      spends: [
        {
          id: 'dark-animus', name: 'Dark Animus', text: 'printed', window: 'activation',
          cost: 1, effect: { type: 'addApl', amount: 1 },
        },
        {
          id: 'rejuvenation', name: 'Accelerated Rejuvenation', text: 'printed',
          window: 'activation', cost: 1, condition: { wounded: true },
          effect: { type: 'healWounds', dice: 'D3+1' },
        },
        {
          id: 'vitalised-surge', name: 'Vitalised Surge', text: 'printed',
          window: 'activation', cost: 1, condition: { incapacitatedThisActivation: true },
          effect: { type: 'freeAction', action: 'dash', unrestricted: true },
        },
        {
          id: 'senses', name: 'Stimulated Senses', text: 'printed', group: 'senses',
          exempt: true, window: 'attackDice', cost: 1,
          effect: { type: 'rerollDice', mode: 'oneResult' },
        },
      ],
      ...over,
    },
  };
}

/** Gore Tanks and the SANGUAVITAE rules they pay for. */
function goreResource() {
  return {
    'gore-tank': {
      name: 'GORE TANK', rule: 'Gore Tanks', text: 'the printed wording',
      scope: 'operative', keyword: 'goremonger', start: 1, max: 2,
      levels: ['empty', 'half', 'full'], perActivation: 2,
      gains: [{ trigger: 'killWithin', within: 2, amount: 1 }],
      spends: [
        {
          id: 'mania', name: 'Mania', text: 'printed', window: 'activation', cost: 1,
          excludes: ['fury'], effect: { type: 'addApl', amount: 1 },
        },
        {
          id: 'fury', name: 'Fury', text: 'printed', window: 'activation', cost: 1,
          excludes: ['mania'], condition: { actionAvailable: 'fight' },
          effect: { type: 'extraAction', action: 'fight', count: 1, free: true },
        },
        {
          id: 'rage', name: 'Rage', text: 'printed', window: 'activation', cost: 1,
          condition: { actionAvailable: 'fight' },
          effect: { type: 'weaponBoost', weaponType: 'melee', atkBonus: 1, appliesTo: ['fight'] },
        },
        {
          id: 'surge', name: 'Surge', text: 'printed', window: 'activation', cost: 1,
          effect: { type: 'moveBonus', inches: 1, appliesTo: ['charge', 'reposition'] },
        },
        {
          id: 'rake', name: 'Rake', text: 'printed', window: 'activation', cost: 1,
          condition: { performedThisActivation: ['charge'], enemyWithinControlRange: true },
          effect: { type: 'inflictDamage', dice: 'D3' },
        },
      ],
    },
  };
}

function painState(over = {}) {
  return makeState({
    p1: {
      at: [{ x: 6, y: 11 }], keywords: ['kabalite'], resources: painResource(),
      ...over.p1,
    },
    p2: { at: [{ x: 16, y: 11 }], wounds: 10, ...over.p2 },
    seed: over.seed ?? 'pain',
  });
}

/** Run a block and hand back the resource gains it produced. */
function afterAction(state, op, fn) {
  const from = state.eventLog.length;
  fn();
  applyPostActionResources(state, op, from);
}

const spendIds = (s, op) =>
  availableSpends(s, op, { window: 'activation' }).map((o) => o.spend.id);

/* ------------------------------------------------------------------ */
/* Gains                                                               */
/* ------------------------------------------------------------------ */

test('Power From Pain pays out for an enemy left injured but alive', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');

  afterAction(s, a, () => applyDamage(s, victim.id, 3,
    { kind: 'shoot', attackerId: a.id }));
  assert.equal(amountOf(s, a, 'pain'), 0, 'a scratch is not an injury');

  afterAction(s, a, () => applyDamage(s, victim.id, 3,
    { kind: 'shoot', attackerId: a.id }));
  assert.equal(amountOf(s, a, 'pain'), 1, 'half wounds or fewer earns a Pain token');
});

test('a kill earns one Pain token, or two for something big enough', () => {
  const small = painState();
  const [a] = opsOf(small, 'p1');
  const [victim] = opsOf(small, 'p2');
  afterAction(small, a, () => applyDamage(small, victim.id, 99,
    { kind: 'shoot', attackerId: a.id }));
  assert.equal(amountOf(small, a, 'pain'), 1);

  const big = painState({ p2: { wounds: 14 } });
  const [b] = opsOf(big, 'p1');
  const [monster] = opsOf(big, 'p2');
  afterAction(big, b, () => applyDamage(big, monster.id, 99,
    { kind: 'shoot', attackerId: b.id }));
  assert.equal(amountOf(big, b, 'pain'), 2, 'a Wounds 12+ kill is worth two');
});

test('a kill someone else made earns this operative nothing', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');
  afterAction(s, a, () => applyDamage(s, victim.id, 99,
    { kind: 'shoot', attackerId: 'someone-else' }));
  assert.equal(amountOf(s, a, 'pain'), 0);
});

test('a GORE TANK cannot rise above full or fall below empty', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], keywords: ['goremonger'], resources: goreResource() },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  assert.equal(amountOf(s, a, 'gore-tank'), 1, 'it starts at half');
  assert.equal(changeResource(s, a, 'gore-tank', 1), 1);
  assert.equal(changeResource(s, a, 'gore-tank', 1), 0, 'already full');
  assert.equal(changeResource(s, a, 'gore-tank', -2), -2);
  assert.equal(changeResource(s, a, 'gore-tank', -1), 0, 'already empty');
});

test('a Gore Tank fills when its owner kills something at its feet', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], keywords: ['goremonger'], resources: goreResource() },
    p2: { at: [{ x: 6.8, y: 11 }, { x: 25, y: 3 }], count: 2 },
  });
  const [a] = opsOf(s, 'p1');
  const [near, far] = opsOf(s, 'p2');

  afterAction(s, a, () => applyDamage(s, far.id, 99, { kind: 'shoot', attackerId: a.id }));
  assert.equal(amountOf(s, a, 'gore-tank'), 1, 'a kill across the board feeds nothing');

  afterAction(s, a, () => applyDamage(s, near.id, 99, { kind: 'fight', attackerId: a.id }));
  assert.equal(amountOf(s, a, 'gore-tank'), 2, 'one within control range does');
});

/* ------------------------------------------------------------------ */
/* Spending: limits                                                    */
/* ------------------------------------------------------------------ */

test('a spend is a legal 0-AP action while the operative holds the resource', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  assert.equal(getLegalActions(s, a.id).some((x) => x.type === 'spend'), false,
    'nothing to spend yet');

  changeResource(s, a, 'pain', 2);
  const spend = getLegalActions(s, a.id).find((x) => x.type === 'spend');
  assert.ok(spend, 'the menu appears once a token is held');
  assert.equal(spend.cost, 0, 'and it costs no AP');
});

test('only one invigoration lands per activation — the exempt one aside', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  changeResource(s, a, 'pain', 4);
  a.woundsRemaining = 4;

  assert.ok(spendIds(s, a).includes('dark-animus'));
  assert.equal(resolveAction(s, { operativeId: a.id, type: 'spend', resource: 'pain', spendId: 'dark-animus' }).ok, true);

  const second = resolveAction(s, {
    operativeId: a.id, type: 'spend', resource: 'pain', spendId: 'rejuvenation',
  });
  assert.equal(second.ok, false, 'the second invigoration is refused');
  assert.match(second.reason, /already used 1/);

  // Stimulated Senses is declared exempt, so it is still on the table.
  assert.ok(availableSpends(s, a, { window: 'attackDice' }).length,
    'the exempt spend is unaffected');
});

test('Mania and Fury cannot be used in the same activation', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], keywords: ['goremonger'], resources: goreResource() },
    p2: { at: [{ x: 6.8, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  changeResource(s, a, 'gore-tank', 1);
  assert.equal(resolveAction(s, { operativeId: a.id, type: 'spend', resource: 'gore-tank', spendId: 'mania' }).ok, true);
  const fury = resolveAction(s, { operativeId: a.id, type: 'spend', resource: 'gore-tank', spendId: 'fury' });
  assert.equal(fury.ok, false);
  assert.match(fury.reason, /cannot follow mania/);
});

test('a spend the operative cannot pay for is refused', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  const result = resolveAction(s, {
    operativeId: a.id, type: 'spend', resource: 'pain', spendId: 'dark-animus',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not enough Pain token/);
});

/* ------------------------------------------------------------------ */
/* Spending: effects                                                   */
/* ------------------------------------------------------------------ */

test('Dark Animus buys a point of APL and the AP that goes with it', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  changeResource(s, a, 'pain', 1);
  a.apRemaining = 2;
  a.usedThisActivation = [];

  resolveAction(s, { operativeId: a.id, type: 'spend', resource: 'pain', spendId: 'dark-animus' });
  assert.equal(a.apRemaining, 3, 'the extra point is spendable now');
  assert.equal(effectiveApl(a), a.apl + 1, 'and the APL stat reads one higher');
  assert.equal(amountOf(s, a, 'pain'), 0, 'the token is gone');
});

test('Accelerated Rejuvenation is refused on an operative at full wounds', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  changeResource(s, a, 'pain', 1);
  assert.equal(spendIds(s, a).includes('rejuvenation'), false);

  a.woundsRemaining = 4;
  assert.equal(spendIds(s, a).includes('rejuvenation'), true);
  resolveAction(s, { operativeId: a.id, type: 'spend', resource: 'pain', spendId: 'rejuvenation' });
  assert.ok(a.woundsRemaining > 4, 'wounds come back');
  assert.ok(a.woundsRemaining <= a.wounds, 'but never above the printed profile');
});

test('Vitalised Surge waits for a kill, then grants a Dash the rules would refuse', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');
  changeResource(s, a, 'pain', 1);
  assert.equal(spendIds(s, a).includes('vitalised-surge'), false, 'nothing killed yet');

  // A Charge normally spends the operative's one move; the kill buys another.
  a.usedThisActivation = ['charge'];
  afterAction(s, a, () => applyDamage(s, victim.id, 99, { kind: 'fight', attackerId: a.id }));
  assert.equal(a.killsThisActivation, 1);
  assert.equal(spendIds(s, a).includes('vitalised-surge'), true);

  resolveAction(s, { operativeId: a.id, type: 'spend', resource: 'pain', spendId: 'vitalised-surge' });
  a.apRemaining = 0;
  const dash = getLegalActions(s, a.id).find((x) => x.type === 'dash');
  assert.ok(dash, 'the Dash is offered even with no AP left');
  assert.equal(dash.cost, 0, 'and it is free');
});

test('Rage adds an attack die to the Fight it was bought for, then lapses', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }], keywords: ['goremonger'], resources: goreResource(),
      weapons: [weapon(), melee({ atk: 4 })],
    },
    p2: { at: [{ x: 6.8, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const blade = melee({ atk: 4 });
  changeResource(s, a, 'gore-tank', 1);

  assert.equal(weaponAdjustments(s, a, blade, { action: 'fight' }).atk, 0);
  resolveAction(s, { operativeId: a.id, type: 'spend', resource: 'gore-tank', spendId: 'rage' });
  assert.equal(weaponAdjustments(s, a, blade, { action: 'fight' }).atk, 1, '+1 Atk in melee');
  assert.equal(weaponAdjustments(s, a, weapon(), { action: 'shoot' }).atk, 0,
    'and nothing for the gun');

  resolveAction(s, { operativeId: a.id, type: 'fight', targetId: opsOf(s, 'p2')[0].id, weaponId: blade.id });
  assert.equal(weaponAdjustments(s, a, blade, { action: 'fight' }).atk, 0,
    'the boost ends with the action it paid for');
});

test('Surge adds an inch to the move action it was bought for', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], keywords: ['goremonger'], resources: goreResource(), move: 6 },
    p2: { at: [{ x: 20, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  changeResource(s, a, 'gore-tank', 1);
  const before = moveAllowance(s, a, 'charge');
  resolveAction(s, { operativeId: a.id, type: 'spend', resource: 'gore-tank', spendId: 'surge' });
  assert.equal(moveAllowance(s, a, 'charge'), before + 1);
  assert.equal(moveAllowance(s, a, 'dash'), DASH_DISTANCE,
    'a Dash is a flat distance whatever the Move stat');
});

test('Rake only comes off a charge that ended in contact', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], keywords: ['goremonger'], resources: goreResource() },
    p2: { at: [{ x: 6.8, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');
  changeResource(s, a, 'gore-tank', 1);

  assert.equal(spendIds(s, a).includes('rake'), false, 'it has not charged');
  a.usedThisActivation = ['charge'];
  assert.equal(spendIds(s, a).includes('rake'), true);

  const before = victim.woundsRemaining;
  resolveAction(s, { operativeId: a.id, type: 'spend', resource: 'gore-tank', spendId: 'rake' });
  assert.ok(victim.woundsRemaining < before, 'the enemy in its control range is opened up');
});

/* ------------------------------------------------------------------ */
/* Dice-window spends                                                  */
/* ------------------------------------------------------------------ */

test('Stimulated Senses re-rolls the biggest group of failures, and pays for it', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  changeResource(s, a, 'pain', 1);

  const policy = diceRerollSpend(s, a, { kind: 'attack' });
  assert.ok(policy, 'a token in hand puts the re-roll on the table');

  // A seed whose five dice land 5,2,1,1,1 at Hit 4+: three 1s are the group
  // worth buying back, and the lone 2 is left alone.
  const rng = new Rng('a');
  const roll = rollAttack(rng, weapon({ atk: 5, hit: 4 }), { extraReroll: policy });
  const granted = roll.rerolled.filter((r) => r.granted);
  assert.ok(granted.length >= 2, 'it only bites when two or more dice share a failing result');
  assert.ok(granted.every((r) => r.from === granted[0].from),
    'and only on dice showing one result, as printed');
  assert.equal(amountOf(s, a, 'pain'), 0, 'the token is spent');
});

test('a hopeless re-roll is declined rather than wasted', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  changeResource(s, a, 'pain', 1);
  const policy = diceRerollSpend(s, a, { kind: 'attack' });
  // One attack die can never clear the threshold at Hit 4+.
  const rng = new Rng('single');
  rollAttack(rng, weapon({ atk: 1, hit: 4 }), { extraReroll: policy });
  assert.equal(amountOf(s, a, 'pain'), 1, 'the token stays in hand');
});

/* ------------------------------------------------------------------ */
/* Pooled resources and assignment                                     */
/* ------------------------------------------------------------------ */

function bloodedResource() {
  return {
    blooded: {
      name: 'Blooded token', rule: 'Blooded', text: 'the printed wording',
      scope: 'player', keyword: 'blooded',
      gains: [
        { trigger: 'readyStep', amount: 1 },
        { trigger: 'firstKillEachTurningPoint', amount: 1 },
      ],
      assign: {
        trigger: 'readyStep', toKeyword: 'blooded', maxPerOperative: 1,
        token: { kind: 'blooded', label: 'Blooded', whileHeld: { weaponRules: ['accurate1'] } },
        elevate: {
          atLeast: 2, label: 'Gaze of the Gods',
          token: {
            kind: 'gaze', label: 'Gaze of the Gods',
            whileHeld: { weaponRules: ['accuratecrits1'] },
            expiry: { endOfTurningPoint: true },
          },
        },
      },
      spends: [],
    },
  };
}

test('a pooled resource accrues to the team and is assigned to its operatives', () => {
  const s = makeState({
    p1: {
      at: [{ x: 5, y: 9 }, { x: 5, y: 12 }], count: 2,
      keywords: ['blooded'], resources: bloodedResource(),
    },
    p2: { at: [{ x: 20, y: 11 }] },
  });
  const [a, b] = opsOf(s, 'p1');

  s.players.p1.resources.blooded = 2;
  resourceReadyStep(s);
  // One more from the Ready step, then all three assigned — two land, because
  // each operative may hold only one.
  assert.equal(a.tokens.some((t) => t.kind === 'blooded'), true);
  assert.equal(b.tokens.some((t) => t.kind === 'blooded'), true);
  assert.equal(s.players.p1.resources.blooded, 1, 'the third has nobody to go to');

  const granted = weaponAdjustments(s, a, weapon(), { action: 'shoot' });
  assert.ok(granted.rules.includes('accurate1'), 'a held token arms its weapons');
});

test('enough marked operatives puts one of them under the Gaze of the Gods', () => {
  const s = makeState({
    p1: {
      at: [{ x: 5, y: 9 }, { x: 5, y: 12 }], count: 2,
      keywords: ['blooded'], resources: bloodedResource(),
    },
    p2: { at: [{ x: 20, y: 11 }] },
  });
  s.players.p1.resources.blooded = 2;
  resourceReadyStep(s);

  const chosen = opsOf(s, 'p1').find((o) => o.tokens.some((t) => t.kind === 'gaze'));
  assert.ok(chosen, 'one is elevated once the threshold is met');
  const rules = weaponAdjustments(s, chosen, weapon(), { action: 'shoot' }).rules;
  assert.deepEqual(rules, ['accurate1', 'accuratecrits1']);
});

test('the first kill of a turning point pays the pool once, not once per kill', () => {
  const s = makeState({
    p1: { at: [{ x: 5, y: 11 }], keywords: ['blooded'], resources: bloodedResource() },
    p2: { at: [{ x: 15, y: 11 }, { x: 17, y: 11 }], count: 2 },
  });
  const [a] = opsOf(s, 'p1');
  const [first, second] = opsOf(s, 'p2');

  afterAction(s, a, () => applyDamage(s, first.id, 99, { kind: 'shoot', attackerId: a.id }));
  assert.equal(s.players.p1.resources.blooded, 1);
  afterAction(s, a, () => applyDamage(s, second.id, 99, { kind: 'shoot', attackerId: a.id }));
  assert.equal(s.players.p1.resources.blooded, 1, 'the second kill this turning point pays nothing');

  s.turningPoint = 2;
  const [third] = opsOf(s, 'p2');
  third.alive = true;
  third.woundsRemaining = third.wounds;
  afterAction(s, a, () => applyDamage(s, third.id, 99, { kind: 'shoot', attackerId: a.id }));
  assert.equal(s.players.p1.resources.blooded, 2, 'a new turning point pays again');
});

/* ------------------------------------------------------------------ */
/* The AI's side of it                                                 */
/* ------------------------------------------------------------------ */

test('an injured operative heals rather than buying an extra action', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  changeResource(s, a, 'pain', 1);
  a.woundsRemaining = 3;

  const plan = openingSpends(s, a, { enemies: opsOf(s, 'p2') });
  assert.equal(plan.always.length, 1);
  assert.equal(plan.always[0].spendId, 'rejuvenation');
  assert.equal(plan.apBonus, 0);
});

test('a healthy operative in reach of the enemy buys the extra action instead', () => {
  const s = painState();
  const [a] = opsOf(s, 'p1');
  changeResource(s, a, 'pain', 1);

  const plan = openingSpends(s, a, { enemies: opsOf(s, 'p2') });
  assert.equal(plan.conditional[0].spendId, 'dark-animus');
  assert.equal(plan.apBonus, 1);
  assert.equal(plan.always.length, 0, 'and pays only if the plan uses the AP');
});

test('the melee bundle never asks for more than the tank can pay for', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], keywords: ['goremonger'], resources: goreResource() },
    p2: { at: [{ x: 6.8, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  assert.equal(amountOf(s, a, 'gore-tank'), 1, 'half a tank');
  const bundle = meleeSpends(s, a);
  assert.equal(bundle.before.length + bundle.afterCharge.length, 1,
    'one level buys exactly one SANGUAVITAE rule');
  assert.equal(bundle.atkBonus, 1, 'and it picks the one that adds dice');
});

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

test('a resource declaring something the engine cannot do is reported', () => {
  const problems = describeResource('pain', {
    name: 'Pain token', text: 'printed', scope: 'operative',
    gains: [{ trigger: 'whenTheMoonIsFull' }],
    spends: [
      { id: 'x', text: 'printed', effect: { type: 'summonDaemon' } },
      { id: 'y', text: 'printed', window: 'activation', effect: { type: 'rerollDice' } },
      { id: 'z', text: 'printed', effect: { type: 'addApl' }, excludes: ['nobody'] },
    ],
  });
  assert.ok(problems.some((p) => /whenTheMoonIsFull/.test(p)));
  assert.ok(problems.some((p) => /summonDaemon/.test(p)));
  assert.ok(problems.some((p) => /re-rolls dice but is declared in the activation window/.test(p)));
  assert.ok(problems.some((p) => /excludes "nobody"/.test(p)));
});

test('a levelled track whose names do not match its cap is reported', () => {
  const problems = describeResource('gore-tank', {
    name: 'GORE TANK', text: 'printed', scope: 'operative',
    max: 2, levels: ['empty', 'full'],
  });
  assert.ok(problems.some((p) => /names 2 levels but caps at 2/.test(p)));
});

/* ------------------------------------------------------------------ */
/* Choices the engine used to default on                               */
/* ------------------------------------------------------------------ */

test('a Blaze token is smothered with an APL when the next burn could kill', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], wounds: 12, apl: 3 },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const blaze = {
    kind: 'blaze', label: 'Blaze',
    onActivation: { damage: 'D3', removal: { d6: 3, aplCost: 1 } },
  };

  // Healthy: take the free roll and keep the action.
  grantToken(s, a, blaze, { owner: 'p2', rule: 'Blaze' });
  resolveActivationTokens(s, new Rng('blaze-healthy'), a, applyDamage);
  assert.equal(a.aplPenaltyThisActivation, 0, 'no APL is given up while it can take the hit');

  // One D3 from death: pay the point and be certain of it.
  const s2 = makeState({
    p1: { at: [{ x: 6, y: 11 }], wounds: 12, apl: 3 },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [b] = opsOf(s2, 'p1');
  b.woundsRemaining = 4;
  grantToken(s2, b, blaze, { owner: 'p2', rule: 'Blaze' });
  resolveActivationTokens(s2, new Rng('blaze-hurt'), b, applyDamage);
  assert.equal(b.aplPenaltyThisActivation, 1, 'the action is worth less than the risk');
  assert.equal(b.tokens.length, 0, 'and the token is gone for certain');
});

test('WITHIN SHADOW is Heavy terrain within an inch, or a base under Vantage', () => {
  const s = makeState({
    terrain: [
      { id: 'wall', shape: { type: 'polygon', points: rect(10, 10, 4, 4) }, traits: ['cover', 'obscuring'] },
      { id: 'rail', shape: { type: 'polygon', points: rect(20, 10, 4, 4) }, traits: ['cover', 'light'] },
    ],
    p1: { at: [{ x: 9.4, y: 12 }] },
    p2: { at: [{ x: 19.4, y: 12 }] },
  });
  const [inShadow] = opsOf(s, 'p1');
  const [beside] = opsOf(s, 'p2');
  assert.equal(isWithinShadow(s, inShadow), true, 'Heavy terrain casts a shadow');
  assert.equal(isWithinShadow(s, beside), false, 'Light terrain does not');

  inShadow.x = 4;
  assert.equal(isWithinShadow(s, inShadow), false, 'and only within an inch of it');
});
