import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, weapon, melee } from './fixtures.mjs';
import { getLegalActions, resolveAction } from '../src/rules/engine.js';
import { fireActivationStart, fireTurningPointStart, timesAllowed } from '../src/rules/hooks.js';
import { applyDamage, effectiveApl } from '../src/rules/effects.js';
import { EVENTS } from '../src/state.js';
import { Rng } from '../src/rng.js';

/** A state whose p1 team carries the given hooks and keywords. */
function withHooks(hooks, { keywords = ['test'], p1 = {}, p2 = {} } = {}) {
  return makeState({
    p1: { at: [{ x: 5, y: 11 }], keywords, ruleHooks: hooks, ...p1 },
    p2: { at: [{ x: 15, y: 11 }], ...p2 },
  });
}

const ruleEvents = (s) => s.eventLog.filter((e) => e.type === EVENTS.RULE_APPLIED);

/* --- Throat Slittas: Charge while Concealed ---------------------------- */

const throatSlittas = [{
  id: 'throat-slittas', rule: 'Throat Slittas', trigger: 'onActivationStart',
  condition: { keyword: 'kommando', notKeyword: 'bomb-squig' },
  effect: { type: 'allowChargeWhileConceal' },
}];

test('Charge normally requires an Engage order', () => {
  const s = withHooks([], { p1: { at: [{ x: 12, y: 11, order: 'conceal' }] } });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  assert.equal(getLegalActions(s, a.id).some((x) => x.type === 'charge'), false);
});

test('Throat Slittas lets a Concealed Kommando Charge', () => {
  const s = withHooks(throatSlittas, {
    keywords: ['kommando'], p1: { at: [{ x: 12, y: 11, order: 'conceal' }] },
  });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  assert.equal(a.chargeWhileConceal, true);
  assert.equal(getLegalActions(s, a.id).some((x) => x.type === 'charge'), true);
});

test('Throat Slittas excludes the Bomb Squig', () => {
  const s = withHooks(throatSlittas, {
    keywords: ['kommando', 'bomb-squig'], p1: { at: [{ x: 12, y: 11, order: 'conceal' }] },
  });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  assert.equal(a.chargeWhileConceal, false);
  assert.equal(getLegalActions(s, a.id).some((x) => x.type === 'charge'), false);
});

/* --- Astartes: two Shoot actions OR two Fight actions ------------------ */

const astartes = [{
  id: 'astartes-double-action', rule: 'Astartes', trigger: 'onActionLegality',
  condition: { keyword: 'legionary' },
  effect: { type: 'extraAction', oneOf: ['shoot', 'fight'], count: 1 },
  partial: true, notes: 'weapon-selection clause not enforced',
}];

test('an operative may normally Shoot only once per activation', () => {
  const s = withHooks([], { p1: { apl: 3 } });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  assert.equal(timesAllowed(s, a, 'shoot'), 1);
});

test('Astartes allows a second Shoot', () => {
  const s = withHooks(astartes, { keywords: ['legionary'], p1: { apl: 3 } });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  assert.equal(timesAllowed(s, a, 'shoot'), 2);
  assert.equal(timesAllowed(s, a, 'fight'), 2);
});

test('Astartes is either/or: repeating Shoot forfeits the second Fight', () => {
  const s = withHooks(astartes, { keywords: ['legionary'], p1: { apl: 3 } });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  a.apRemaining = 3;
  resolveAction(s, { operativeId: a.id, type: 'shoot', targetId: opsOf(s, 'p2')[0].id, weaponId: 'w-test' });
  resolveAction(s, { operativeId: a.id, type: 'shoot', targetId: opsOf(s, 'p2')[0].id, weaponId: 'w-test' });
  assert.equal(a.usedThisActivation.filter((t) => t === 'shoot').length, 2);
  assert.equal(a.extraActionChoice, 'shoot');
  assert.equal(timesAllowed(s, a, 'fight'), 1, 'the Fight repeat is no longer available');
});

/* --- Rapid Fire: conditional on not having moved ----------------------- */

const rapidFire = [{
  id: 'rapid-fire', rule: 'Rapid Fire', trigger: 'onActionLegality',
  condition: { keyword: 'kasrkin', notPerformedThisActivation: ['reposition', 'dash', 'charge', 'fall_back'] },
  effect: { type: 'extraAction', action: 'shoot', count: 1 },
  partial: true, notes: 'weapon-selection clause not enforced',
}];

test('Rapid Fire grants a second Shoot while the operative has not moved', () => {
  const s = withHooks(rapidFire, { keywords: ['kasrkin'], p1: { apl: 3 } });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  assert.equal(timesAllowed(s, a, 'shoot'), 2);
});

test('Rapid Fire is lost once the operative Repositions', () => {
  const s = withHooks(rapidFire, { keywords: ['kasrkin'], p1: { apl: 3 } });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  a.usedThisActivation.push('reposition');
  assert.equal(timesAllowed(s, a, 'shoot'), 1,
    'the grant is re-evaluated live, not cached at activation start');
});

/* --- Aeldari Raiders: a free Dash -------------------------------------- */

const raiders = [{
  id: 'aeldari-raiders', rule: 'Aeldari Raiders', trigger: 'onActivationStart',
  condition: { keyword: 'corsair-voidscarred' },
  effect: { type: 'freeAction', action: 'dash' },
}];

test('a free Dash is usable with no AP left, and only once', () => {
  const s = withHooks(raiders, { keywords: ['corsair-voidscarred'] });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  a.apRemaining = 0;

  assert.equal(getLegalActions(s, a.id).some((x) => x.type === 'dash'), true);
  const first = resolveAction(s, { operativeId: a.id, type: 'dash', destination: { x: 6.5, y: 11 } });
  assert.equal(first.ok, true);
  assert.equal(a.apRemaining, 0, 'the free Dash cost no AP');
  assert.deepEqual(a.freeActions, [], 'the grant is spent');
  assert.equal(getLegalActions(s, a.id).some((x) => x.type === 'dash'), false);
});

test('a free action is not spent while AP could pay for it', () => {
  const s = withHooks(raiders, { keywords: ['corsair-voidscarred'] });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  a.apRemaining = 2;
  resolveAction(s, { operativeId: a.id, type: 'dash', destination: { x: 6.5, y: 11 } });
  assert.equal(a.apRemaining, 1, 'AP paid for the Dash');
  assert.deepEqual(a.freeActions.map((f) => f.action), ['dash'], 'the grant is still in hand');
});

/* --- Runes of Khorne: damage cap --------------------------------------- */

const runes = [{
  id: 'runes-of-khorne', rule: 'Runes of Khorne', trigger: 'beforeDamageApplied',
  condition: { keyword: 'goremonger' },
  effect: { type: 'capDamage', max: 8, perAction: 'shoot' },
}];

test('Runes of Khorne caps a Shoot action at 8 wounds', () => {
  const s = withHooks(runes, { keywords: ['goremonger'], p1: { wounds: 20 } });
  const [a] = opsOf(s, 'p1');
  applyDamage(s, a.id, 14, { kind: 'shoot' });
  assert.equal(a.woundsRemaining, 12, '20 - 8, not 20 - 14');
  assert.match(ruleEvents(s).at(-1).detail, /capped at 8/);
});

test('Runes of Khorne does not cap a Fight action', () => {
  const s = withHooks(runes, { keywords: ['goremonger'], p1: { wounds: 20 } });
  const [a] = opsOf(s, 'p1');
  applyDamage(s, a.id, 14, { kind: 'fight' });
  assert.equal(a.woundsRemaining, 6);
});

/* --- Living Metal: regain lost wounds each turning point ---------------- */

const livingMetal = [{
  id: 'living-metal', rule: 'Living Metal', trigger: 'onTurningPointStart',
  condition: { keyword: 'hierotek-circle' },
  effect: { type: 'healWounds', dice: 'D3+1' },
}];

test('Living Metal regains between 2 and 4 lost wounds', () => {
  const s = withHooks(livingMetal, { keywords: ['hierotek-circle'], p1: { wounds: 14 } });
  const [a] = opsOf(s, 'p1');
  a.woundsRemaining = 4;
  fireTurningPointStart(s, Rng.fromState(s.rng), [a]);
  assert.ok(a.woundsRemaining >= 6 && a.woundsRemaining <= 8,
    `expected 6-8 wounds, got ${a.woundsRemaining}`);
});

test('Living Metal never heals past the Wounds stat, and skips undamaged operatives', () => {
  const s = withHooks(livingMetal, { keywords: ['hierotek-circle'], p1: { wounds: 14 } });
  const [a] = opsOf(s, 'p1');
  a.woundsRemaining = 13;
  fireTurningPointStart(s, Rng.fromState(s.rng), [a]);
  assert.equal(a.woundsRemaining, 14);

  const before = ruleEvents(s).length;
  fireTurningPointStart(s, Rng.fromState(s.rng), [a]);
  assert.equal(ruleEvents(s).length, before, 'a full-health operative logs nothing');
});

/* --- Rifles: Accurate 1 while the operative has not moved -------------- */

const rifles = [{
  id: 'rifles-accurate', rule: 'Rifles', trigger: 'beforeAttackRoll',
  condition: {
    keyword: 'corsair-voidscarred', weaponType: 'ranged',
    weaponNameContains: ['shuriken rifle', 'ranger long rifle'],
    notPerformedThisActivation: ['charge', 'fall_back', 'reposition'],
  },
  effect: { type: 'grantWeaponRule', rules: ['accurate1'] },
}];

function shotWith(hooks, keywords, weaponName, prior = []) {
  const s = makeState({
    p1: { at: [{ x: 5, y: 11 }], keywords, ruleHooks: hooks,
          weapons: [weapon({ name: weaponName, atk: 4, hit: 6 }), melee()] },
    p2: { at: [{ x: 15, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  fireActivationStart(s, a);
  a.usedThisActivation.push(...prior);
  a.apRemaining = 2;
  resolveAction(s, { operativeId: a.id, type: 'shoot', targetId: opsOf(s, 'p2')[0].id, weaponId: 'w-test' });
  return { s, attack: s.eventLog.find((e) => e.type === EVENTS.ATTACK_ROLLED) };
}

test('Rifles grants Accurate 1 to the named weapon before it has moved', () => {
  const { s, attack } = shotWith(rifles, ['corsair-voidscarred'], 'Shuriken rifle');
  assert.ok(attack.weaponRules.includes('accurate1'));
  assert.match(ruleEvents(s).at(-1).detail, /gains accurate1/);
  // Accurate 1 retains one die without rolling: 3 rolled, 1 automatic success.
  assert.equal(attack.rolls.length, 3);
  assert.ok(attack.normals >= 1, 'the retained die is a normal success');
});

test('Rifles does not apply after the operative Repositioned', () => {
  const { attack } = shotWith(rifles, ['corsair-voidscarred'], 'Shuriken rifle', ['reposition']);
  assert.equal(attack.weaponRules.includes('accurate1'), false);
  assert.equal(attack.rolls.length, 4);
});

test('Rifles does not apply to a weapon it does not name', () => {
  const { attack } = shotWith(rifles, ['corsair-voidscarred'], 'Lasblaster');
  assert.equal(attack.weaponRules.includes('accurate1'), false);
});

/* --- Umbral Entities: ignore Piercing ---------------------------------- */

const umbral = [{
  id: 'umbral-entities-piercing', rule: 'Umbral Entities', trigger: 'beforeDefenceRoll',
  condition: { keyword: 'mandrake' },
  effect: { type: 'ignoreWeaponRules', rules: ['piercing', 'piercingcrits'] },
  partial: true, notes: 'WITHIN SHADOW save bonus not simulated',
}];

test('Umbral Entities restores the defence dice Piercing would have removed', () => {
  const s = makeState({
    p1: { at: [{ x: 5, y: 11 }], keywords: ['mandrake'], ruleHooks: umbral },
    p2: { at: [{ x: 15, y: 11 }], weapons: [weapon({ rules: ['piercing2'] }), melee()] },
  });
  const [defender] = opsOf(s, 'p1');
  const [shooter] = opsOf(s, 'p2');
  shooter.apRemaining = 2;
  resolveAction(s, { operativeId: shooter.id, type: 'shoot', targetId: defender.id, weaponId: 'w-test' });
  const roll = s.eventLog.find((e) => e.type === EVENTS.DEFENCE_ROLLED);
  assert.equal(roll.rolls.length, 3, 'all three defence dice are rolled');
  assert.match(ruleEvents(s).at(-1).detail, /ignores piercing2/);
});

test('Piercing still bites a team without the rule', () => {
  const s = makeState({
    p1: { at: [{ x: 5, y: 11 }] },
    p2: { at: [{ x: 15, y: 11 }], weapons: [weapon({ rules: ['piercing2'] }), melee()] },
  });
  const [defender] = opsOf(s, 'p1');
  const [shooter] = opsOf(s, 'p2');
  shooter.apRemaining = 2;
  resolveAction(s, { operativeId: shooter.id, type: 'shoot', targetId: defender.id, weaponId: 'w-test' });
  assert.equal(s.eventLog.find((e) => e.type === EVENTS.DEFENCE_ROLLED).rolls.length, 1);
});

/* --- Void Armour: re-roll defence dice against Blast/Torrent ----------- */

const voidArmour = [{
  id: 'void-armour', rule: 'Void Armour', trigger: 'beforeDefenceRoll',
  condition: { keyword: 'imperial-navy-breacher', weaponHasAnyRule: ['blast', 'torrent'] },
  effect: { type: 'rerollDefenceDice', count: 1 },
  partial: true, notes: 'sweeping-profile exclusion not simulated',
}];

function shotAtBreacher(attackerRules) {
  const s = makeState({
    seed: 'void',
    p1: { at: [{ x: 5, y: 11 }], keywords: ['imperial-navy-breacher'], ruleHooks: voidArmour, save: 6 },
    p2: { at: [{ x: 15, y: 11 }], weapons: [weapon({ rules: attackerRules }), melee()] },
  });
  const [defender] = opsOf(s, 'p1');
  const [shooter] = opsOf(s, 'p2');
  shooter.apRemaining = 2;
  resolveAction(s, { operativeId: shooter.id, type: 'shoot', targetId: defender.id, weaponId: 'w-test' });
  return s;
}

test('Void Armour re-rolls a failed defence die against a Blast weapon', () => {
  const s = shotAtBreacher(['blast2']);
  const roll = s.eventLog.find((e) => e.type === EVENTS.DEFENCE_ROLLED);
  assert.equal(roll.rerolled.length, 1);
  assert.ok(roll.rerolled[0].from < 6, 'only a failed die is re-rolled');
  assert.match(ruleEvents(s).at(-1).detail, /re-roll 1 defence dice/);
});

test('Void Armour does nothing against a weapon with neither Blast nor Torrent', () => {
  const s = shotAtBreacher([]);
  assert.equal(s.eventLog.find((e) => e.type === EVENTS.DEFENCE_ROLLED).rerolled.length, 0);
  assert.equal(ruleEvents(s).length, 0);
});

/* --- Partial implementations announce themselves ----------------------- */

test('a hook marked partial reports what it does not simulate', () => {
  const s = shotAtBreacher(['torrent1']);
  const warn = s.warnings.find((w) => w.ruleId === 'hook-partial:void-armour');
  assert.ok(warn, 'the partial implementation is recorded in the battle warnings');
  assert.match(warn.detail, /sweeping-profile/);
});

/* --- Let's Move!: a leader hands an ally a point of APL ---------------- */

const letsMove = [{
  id: 'lets-move', rule: "Let's Move!", trigger: 'onActivationStart',
  condition: { keyword: 'leader' },
  effect: { type: 'grantAllyApl', amount: 1, within: 12, keyword: 'catachan' },
}];

test("Let's Move! adds APL to a friend that has yet to activate", () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }, { x: 8, y: 11 }], count: 2,
      keywords: ['catachan', 'leader'], ruleHooks: letsMove,
    },
    p2: { at: [{ x: 20, y: 11 }] },
  });
  const [leader, trooper] = opsOf(s, 'p1');
  trooper.ready = true;

  fireActivationStart(s, leader);
  assert.equal(trooper.aplBonus, 1, 'the order lands on the friend, not the leader');
  assert.equal(leader.aplBonus ?? 0, 0);
  assert.equal(effectiveApl(trooper), trooper.apl + 1);
});

test("Let's Move! passes over an operative that has already gone", () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }, { x: 8, y: 11 }], count: 2,
      keywords: ['catachan', 'leader'], ruleHooks: letsMove,
    },
    p2: { at: [{ x: 20, y: 11 }] },
  });
  const [leader, trooper] = opsOf(s, 'p1');
  trooper.ready = false;

  fireActivationStart(s, leader);
  assert.equal(trooper.aplBonus ?? 0, 0, 'an expended operative cannot spend the AP');
});

/* --- Frenzy: the blow that does not land ------------------------------- */

const frenzy = [{
  id: 'frenzy', rule: 'Frenzy', trigger: 'onWouldBeIncapacitated',
  condition: { keyword: 'fellgor-ravager' },
  effect: { type: 'surviveIncapacitation', token: 'frenzy', wounds: 1, order: 'engage' },
  partial: true, notes: 'the operative lingers on 1 wound rather than dying to the next crit',
}];

test('an operative with no such rule is incapacitated by a killing blow', () => {
  const s = withHooks([], { keywords: ['fellgor-ravager'] });
  const [a] = opsOf(s, 'p1');
  applyDamage(s, a.id, a.wounds + 4, { kind: 'shoot' });
  assert.equal(a.alive, false);
});

test('Frenzy leaves the operative standing on a sliver of wounds', () => {
  const s = withHooks(frenzy, { keywords: ['fellgor-ravager'] });
  const [a] = opsOf(s, 'p1');
  applyDamage(s, a.id, a.wounds + 4, { kind: 'shoot' });
  assert.equal(a.alive, true);
  assert.equal(a.woundsRemaining, 1);
});

test('Frenzy fires once per operative — the token is what stops the second', () => {
  const s = withHooks(frenzy, { keywords: ['fellgor-ravager'] });
  const [a] = opsOf(s, 'p1');
  applyDamage(s, a.id, a.wounds + 4, { kind: 'shoot' });
  applyDamage(s, a.id, 3, { kind: 'shoot' });
  assert.equal(a.alive, false, 'the second killing blow was shrugged off too');
});

test('Frenzy drags a Concealed operative out into the open', () => {
  const s = withHooks(frenzy, {
    keywords: ['fellgor-ravager'], p1: { at: [{ x: 5, y: 11, order: 'conceal' }] },
  });
  const [a] = opsOf(s, 'p1');
  applyDamage(s, a.id, a.wounds + 4, { kind: 'shoot' });
  assert.equal(a.order, 'engage');
});

test('Frenzy does not reach an operative the condition excludes', () => {
  const s = withHooks(frenzy, { keywords: ['something-else'] });
  const [a] = opsOf(s, 'p1');
  applyDamage(s, a.id, a.wounds + 4, { kind: 'shoot' });
  assert.equal(a.alive, false);
});

test('a survived killing blow is not reported as a kill', () => {
  const s = withHooks(frenzy, { keywords: ['fellgor-ravager'] });
  const [a] = opsOf(s, 'p1');
  const result = applyDamage(s, a.id, a.wounds + 4, { kind: 'shoot' });
  assert.equal(result.incapacitated, false);
  assert.equal(
    s.eventLog.some((e) => e.type === EVENTS.OPERATIVE_INCAPACITATED), false);
});
