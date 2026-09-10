import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, weapon, melee } from './fixtures.mjs';
import {
  ployCatalogue, playablePloys, activatePloy, activePloyIds, expirePloys,
  ployBlocker, findPloy, reportUnsupportedPloys,
} from '../src/rules/ploys.js';
import { applyAttackHooks, applyDefenceHooks } from '../src/rules/hooks.js';
import { chooseStrategicPloys, valuePloy } from '../src/ai/ploys.js';
import { dispositionFor } from '../src/ai/tactics.js';
import { EVENTS } from '../src/state.js';

/** A team-wide melee buff, the commonest printed shape. */
const waaagh = {
  id: 'waaagh', name: 'WAAAGH!', cost: 1,
  description: "Friendly operatives' melee weapons have the Balanced weapon rule.",
  hooks: [{
    trigger: 'beforeAttackRoll',
    condition: { weaponType: 'melee' },
    effect: { type: 'grantWeaponRule', rules: ['balanced'] },
  }],
};

/** A ploy the engine cannot play: catalogued, costed, never usable. */
const unsupported = {
  id: 'kunnin', name: 'KUNNIN', cost: 1,
  description: 'Something this engine has no vocabulary for.',
};

function stateWith(ploys, { cp = 3, p1 = {}, p2 = {} } = {}) {
  const s = makeState({
    p1: { at: [{ x: 5, y: 11 }], strategicPloys: ploys, ...p1 },
    p2: { at: [{ x: 6, y: 11 }], ...p2 },
  });
  s.players.p1.cp = cp;
  return s;
}

/* --- Catalogue and support ------------------------------------------- */

test('a ploy with hooks is supported; one without is catalogued but not', () => {
  const s = stateWith([waaagh, unsupported]);
  const cat = ployCatalogue(s.teamPacks.p1, 'strategic');
  assert.deepEqual(cat.map((p) => [p.id, p.supported]),
    [['waaagh', true], ['kunnin', false]]);
});

test('an unsupported ploy is never playable, and says why', () => {
  const s = stateWith([waaagh, unsupported]);
  assert.deepEqual(playablePloys(s, 'p1').map((p) => p.id), ['waaagh']);
  assert.equal(ployBlocker(s, 'p1', findPloy(s.teamPacks.p1, 'kunnin')),
    'not simulated by this engine');
});

test('firefight ploys are catalogued but not playable in the strategy phase', () => {
  const s = makeState({
    p1: { at: [{ x: 5, y: 11 }], firefightPloys: [{ ...waaagh, id: 'ff' }] },
    p2: { at: [{ x: 6, y: 11 }] },
  });
  s.players.p1.cp = 3;
  assert.equal(playablePloys(s, 'p1').length, 0);
  assert.match(ployBlocker(s, 'p1', findPloy(s.teamPacks.p1, 'ff')), /used during an activation/);
});

test('every unplayable ploy and every equipment item is reported once', () => {
  const s = makeState({
    p1: { at: [{ x: 5, y: 11 }], strategicPloys: [unsupported], equipment: [{ id: 'e1', name: 'Dynamite' }] },
    p2: { at: [{ x: 6, y: 11 }] },
  });
  reportUnsupportedPloys(s);
  const ids = s.warnings.map((w) => w.ruleId);
  assert.ok(ids.includes('ploy:t1:kunnin'), 'each unplayable strategic ploy is named');
  assert.ok(ids.includes('equipment:t1'), 'equipment is counted, not listed one notice each');
});

/* --- Buying ----------------------------------------------------------- */

test('buying a ploy spends CP, records it and logs it', () => {
  const s = stateWith([waaagh], { cp: 2 });
  assert.equal(activatePloy(s, 'p1', 'waaagh').ok, true);
  assert.equal(s.players.p1.cp, 1);
  assert.deepEqual(activePloyIds(s, 'p1'), ['waaagh']);
  const log = s.eventLog.filter((e) => e.type === EVENTS.PLOY_USED);
  assert.equal(log.length, 1);
  assert.equal(log[0].ployName, 'WAAAGH!');
});

test('a ploy cannot be bought twice in one turning point', () => {
  const s = stateWith([waaagh], { cp: 3 });
  activatePloy(s, 'p1', 'waaagh');
  assert.deepEqual(activatePloy(s, 'p1', 'waaagh'),
    { ok: false, reason: 'already in force this turning point' });
  assert.equal(s.players.p1.cp, 2, 'the rejected purchase costs nothing');
});

test('a ploy cannot be bought without the CP', () => {
  const s = stateWith([waaagh], { cp: 0 });
  const r = activatePloy(s, 'p1', 'waaagh');
  assert.equal(r.ok, false);
  assert.match(r.reason, /costs 1 CP/);
});

test('oncePerBattle survives the turning point that used it', () => {
  const s = stateWith([{ ...waaagh, oncePerBattle: true }], { cp: 4 });
  activatePloy(s, 'p1', 'waaagh');
  expirePloys(s);
  assert.deepEqual(activePloyIds(s, 'p1'), []);
  assert.equal(activatePloy(s, 'p1', 'waaagh').reason, 'already used this battle');
});

/* --- Reaching the rules engine ---------------------------------------- */

test('a bought ploy grants its weapon rule; an unbought one does not', () => {
  const s = stateWith([waaagh], { cp: 2 });
  const [a] = opsOf(s, 'p1');
  const [d] = opsOf(s, 'p2');
  const blade = melee();

  const before = applyAttackHooks(s, a, blade, { target: d, action: 'fight' });
  assert.deepEqual(before.rules, [], 'no ploy in force');

  activatePloy(s, 'p1', 'waaagh');
  const after = applyAttackHooks(s, a, blade, { target: d, action: 'fight' });
  assert.deepEqual(after.rules, ['balanced']);
});

test('the effect lapses when the turning point does', () => {
  const s = stateWith([waaagh], { cp: 2 });
  const [a] = opsOf(s, 'p1');
  const [d] = opsOf(s, 'p2');
  activatePloy(s, 'p1', 'waaagh');
  expirePloys(s);
  assert.deepEqual(applyAttackHooks(s, a, melee(), { target: d, action: 'fight' }).rules, []);
});

test("a ploy only reaches its own team's operatives", () => {
  const s = stateWith([waaagh], { cp: 2 });
  activatePloy(s, 'p1', 'waaagh');
  const [d] = opsOf(s, 'p2');
  const [a] = opsOf(s, 'p1');
  assert.deepEqual(applyAttackHooks(s, d, melee(), { target: a, action: 'fight' }).rules, []);
});

test('the battle log names the ploy that paid for the effect', () => {
  const s = stateWith([waaagh], { cp: 2 });
  const [a] = opsOf(s, 'p1');
  const [d] = opsOf(s, 'p2');
  activatePloy(s, 'p1', 'waaagh');
  applyAttackHooks(s, a, melee(), { target: d, action: 'fight' });
  const applied = s.eventLog.filter((e) => e.type === EVENTS.RULE_APPLIED);
  assert.equal(applied.at(-1).rule, 'WAAAGH!');
});

/* --- Sequence conditions ---------------------------------------------- */

const closeRange = {
  id: 'close', name: 'CLOSE', cost: 1, description: 'within 6"',
  hooks: [{
    trigger: 'beforeAttackRoll',
    condition: { weaponType: 'ranged', targetWithin: 6 },
    effect: { type: 'grantWeaponRule', rules: ['balanced'] },
  }],
};

test('targetWithin applies the ploy only inside its range', () => {
  const near = stateWith([closeRange], { cp: 2, p2: { at: [{ x: 8, y: 11 }] } });
  activatePloy(near, 'p1', 'close');
  const [a] = opsOf(near, 'p1');
  const [d] = opsOf(near, 'p2');
  assert.deepEqual(
    applyAttackHooks(near, a, weapon(), { target: d, action: 'shoot' }).rules, ['balanced']);

  const far = stateWith([closeRange], { cp: 2, p2: { at: [{ x: 25, y: 11 }] } });
  activatePloy(far, 'p1', 'close');
  const [fa] = opsOf(far, 'p1');
  const [fd] = opsOf(far, 'p2');
  assert.deepEqual(
    applyAttackHooks(far, fa, weapon(), { target: fd, action: 'shoot' }).rules, []);
});

test('targetReady distinguishes a ready target from an expended one', () => {
  const ploy = {
    id: 'vengeance', name: 'VENGEANCE', cost: 1, description: 'expended targets',
    hooks: [{
      trigger: 'beforeAttackRoll',
      condition: { targetReady: false },
      effect: { type: 'grantWeaponRule', rules: ['punishing'] },
    }],
  };
  const s = stateWith([ploy], { cp: 2 });
  activatePloy(s, 'p1', 'vengeance');
  const [a] = opsOf(s, 'p1');
  const [d] = opsOf(s, 'p2');

  d.ready = true;
  assert.deepEqual(applyAttackHooks(s, a, weapon(), { target: d, action: 'shoot' }).rules, []);
  d.ready = false;
  assert.deepEqual(
    applyAttackHooks(s, a, weapon(), { target: d, action: 'shoot' }).rules, ['punishing']);
});

test('a defensive ploy reaches the defence roll', () => {
  const guard = {
    id: 'guard', name: 'GUARD', cost: 1, description: 're-roll a defence die',
    hooks: [{
      trigger: 'beforeDefenceRoll',
      condition: {},
      effect: { type: 'rerollDefenceDice', count: 1 },
    }],
  };
  const s = stateWith([guard], { cp: 2 });
  const [d] = opsOf(s, 'p1');
  const [a] = opsOf(s, 'p2');
  assert.equal(applyDefenceHooks(s, d, weapon(), { attacker: a, action: 'shoot' }).rerolls, 0);
  activatePloy(s, 'p1', 'guard');
  assert.equal(applyDefenceHooks(s, d, weapon(), { attacker: a, action: 'shoot' }).rerolls, 1);
});

/* --- The AI's choice --------------------------------------------------- */

test('the AI buys a ploy its roster can actually use', () => {
  const s = stateWith([waaagh], { cp: 1 });
  assert.deepEqual(chooseStrategicPloys(s, 'p1').map((p) => p.ployId), ['waaagh']);
});

test('the AI does not buy a ploy nothing on the roster can use', () => {
  const s = stateWith([{
    ...waaagh,
    hooks: [{
      trigger: 'beforeAttackRoll',
      condition: { keyword: 'nobody-has-this' },
      effect: { type: 'grantWeaponRule', rules: ['balanced'] },
    }],
  }], { cp: 1, p1: { at: [{ x: 5, y: 11 }] } });
  assert.deepEqual(chooseStrategicPloys(s, 'p1'), []);
});

test('the AI never proposes more than it can afford', () => {
  const three = [waaagh,
    { ...waaagh, id: 'b', name: 'B' },
    { ...waaagh, id: 'c', name: 'C' }];
  const s = stateWith(three, { cp: 2 });
  const picks = chooseStrategicPloys(s, 'p1');
  assert.ok(picks.length <= 2);
  assert.ok(picks.reduce((sum, p) => sum + p.cost, 0) <= 2);
});

test('a ranged team values a melee ploy below a melee team', () => {
  const gunners = stateWith([waaagh], {
    cp: 2, p1: { at: [{ x: 5, y: 11 }], weapons: [weapon()] },
  });
  const fighters = stateWith([waaagh], {
    cp: 2, p1: { at: [{ x: 5, y: 11 }], weapons: [melee()] },
  });
  const ploy = findPloy(gunners.teamPacks.p1, 'waaagh');
  const a = valuePloy(gunners, 'p1', ploy, dispositionFor(gunners, 'p1')).score;
  const b = valuePloy(fighters, 'p1', ploy, dispositionFor(fighters, 'p1')).score;
  assert.ok(b > a, `melee team should value it more (${b} vs ${a})`);
});

test('a narrowly conditional ploy is priced below the same ploy unconditional', () => {
  const wide = stateWith([waaagh], { cp: 2, p1: { at: [{ x: 5, y: 11 }], weapons: [melee()] } });
  const narrow = stateWith([{ ...waaagh, hooks: [{
    ...waaagh.hooks[0],
    condition: { weaponType: 'melee', targetWithin: 3 },
  }] }], { cp: 2, p1: { at: [{ x: 5, y: 11 }], weapons: [melee()] } });

  const w = valuePloy(wide, 'p1', findPloy(wide.teamPacks.p1, 'waaagh'),
    dispositionFor(wide, 'p1')).score;
  const n = valuePloy(narrow, 'p1', findPloy(narrow.teamPacks.p1, 'waaagh'),
    dispositionFor(narrow, 'p1')).score;
  assert.ok(n < w, `conditional should be cheaper to the AI (${n} vs ${w})`);
});
