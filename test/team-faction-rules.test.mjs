/**
 * The faction rules each bundled team actually plays with.
 *
 * `test/faction-rules.test.mjs` pins down the hook VOCABULARY against
 * hand-built fixtures. This file pins down the packs: it loads the real
 * `data/teams/*.json`, fields the operatives the printed rule names, and
 * asserts the rule fires — and, just as importantly, that it does not fire for
 * the operative the printed wording excludes.
 *
 * Each test names the faction rule it covers, so a failure says which team
 * stopped working rather than which function did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTeam, loadMap, loadMission } from './harness.mjs';
import { createBattleState, liveOperatives, EVENTS } from '../src/state.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { AI_VERSION } from '../src/ai/controller.js';
import {
  fireActivationStart, fireAfterAction, fireTurningPointStart, fireWouldBeIncapacitated,
  timesAllowed, applyAttackHooks, applyIncomingAttackHooks, applyDamageHooks,
} from '../src/rules/hooks.js';
import { applyDamage, effectiveApl, effectiveMove } from '../src/rules/effects.js';
import { hasToken } from '../src/rules/tokens.js';
import { resolveUniqueAction, findUniqueAction, uniqueActionTargets } from '../src/rules/unique-actions.js';
import { resourceReadyStep } from '../src/rules/resources.js';
import { Rng } from '../src/rng.js';

const MAP = loadMap('industrial-001');
const MISSION = loadMission('secure-and-hold');

/**
 * A battle between two real packs, with the operatives you name placed where
 * you put them. Everything else is parked far off in a corner so it cannot
 * wander into a radius under test.
 */
function field(p1Id, p2Id, placements = {}) {
  const state = createBattleState({
    seed: 'faction-rules', map: MAP, mission: MISSION,
    teams: { p1: loadTeam(p1Id), p2: loadTeam(p2Id) },
    engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
  });
  let parked = 0;
  for (const op of Object.values(state.operatives)) {
    op.placed = true;
    op.order = 'engage';
    op.apRemaining = op.apl;
    op.x = 100 + (parked++ * 5);
    op.y = 100;
  }
  state.phase = 'firefight';
  state.turningPoint = 1;
  for (const [profileId, pos] of Object.entries(placements)) {
    const op = Object.values(state.operatives).find(
      (o) => o.profileId === profileId && o.x >= 100);
    assert.ok(op, `no operative with profile "${profileId}" is on this roster`);
    Object.assign(op, pos);
  }
  return state;
}

const find = (state, profileId) =>
  Object.values(state.operatives).find((o) => o.profileId === profileId);

const weaponOf = (state, op, type) => {
  const pack = state.teamPacks[op.playerId];
  const profile = pack.operatives.find((o) => o.id === op.profileId);
  const w = profile.weapons.find((x) => x.type === type);
  assert.ok(w, `${profile.id} has no ${type} weapon`);
  return { ...w, rules: [...w.rules] };
};

/* ====================================================================== */
/* RAVENERS — Predatory Instincts                                         */
/* ====================================================================== */

test('Raveners: Predatory Instincts grants a second Fight action', () => {
  const s = field('raveners', 'kasrkin', { 'ravener-warrior': { x: 10, y: 11 } });
  const op = find(s, 'ravener-warrior');
  fireActivationStart(s, op);
  assert.equal(timesAllowed(s, op, 'fight'), 2);
});

test('Raveners: Predatory Instincts does not also hand out a second Shoot', () => {
  const s = field('raveners', 'kasrkin', { 'ravener-warrior': { x: 10, y: 11 } });
  const op = find(s, 'ravener-warrior');
  fireActivationStart(s, op);
  assert.equal(timesAllowed(s, op, 'shoot'), 1);
});

test('Raveners: TOXIC LUNGE inflicts damage on an enemy within 2"', () => {
  const s = field('raveners', 'kasrkin', {
    'ravener-felltalon': { x: 10, y: 11 },
    'kasrkin-trooper': { x: 11.2, y: 11 },
  });
  const actor = find(s, 'ravener-felltalon');
  const victim = find(s, 'kasrkin-trooper');
  const before = victim.woundsRemaining;
  const entry = findUniqueAction(s, actor, 'toxic-lunge');
  assert.ok(entry, 'TOXIC LUNGE declares no action block');
  const r = resolveUniqueAction(s, new Rng('lunge'), actor, {
    abilityId: 'toxic-lunge', targetId: victim.id,
  });
  assert.equal(r.ok, true, r.reason);
  assert.ok(victim.woundsRemaining < before, 'the lunge dealt no damage');
});

/* ====================================================================== */
/* WRECKA KREW — Tanked Up, Wrecka Rampage                                */
/* ====================================================================== */

test('Wrecka Krew: Tanked Up adds an AP to an Ork on an Engage order', () => {
  const s = field('wrecka-krew', 'kasrkin', { 'breaka-boy-fighter': { x: 10, y: 11 } });
  const op = find(s, 'breaka-boy-fighter');
  const base = op.apl;
  fireActivationStart(s, op);
  assert.equal(op.aplBonus, 1);
  assert.equal(effectiveApl(op), base + 1);
});

test('Wrecka Krew: Tanked Up gives nothing to an Ork on a Conceal order', () => {
  const s = field('wrecka-krew', 'kasrkin', {
    'breaka-boy-fighter': { x: 10, y: 11, order: 'conceal' },
  });
  const op = find(s, 'breaka-boy-fighter');
  fireActivationStart(s, op);
  assert.equal(op.aplBonus || 0, 0);
});

test('Wrecka Krew: Tanked Up excludes the Bomb Squig, as printed', () => {
  const s = field('wrecka-krew', 'kasrkin', { 'wrecka-bomb-squig': { x: 10, y: 11 } });
  const op = find(s, 'wrecka-bomb-squig');
  fireActivationStart(s, op);
  assert.equal(op.aplBonus || 0, 0);
});

test('Wrecka Krew: Wrecka Rampage declares a spendable pool', () => {
  const pack = loadTeam('wrecka-krew');
  const def = pack.resources?.wrecka;
  assert.ok(def, 'Wrecka Rampage declares no resource');
  assert.equal(def.scope, 'player');
  assert.ok(def.spends.some((sp) => sp.window === 'attackDice'),
    'Wrecka points can never be spent on an attack');
});

/* ====================================================================== */
/* GELLERPOX INFECTED — Techno-Curse, Revoltingly Resilient               */
/* ====================================================================== */

test('Gellerpox: Barrelwarp takes an attack die off a gun fired from within 2"', () => {
  const s = field('gellerpox-infected', 'kasrkin', {
    mutant: { x: 10, y: 11 },
    'kasrkin-trooper': { x: 11.2, y: 11 },
  });
  const defender = find(s, 'mutant');
  const attacker = find(s, 'kasrkin-trooper');
  const gun = weaponOf(s, attacker, 'ranged');
  const after = applyIncomingAttackHooks(s, defender, gun, { attacker, action: 'shoot' });
  assert.equal(after.atk, gun.atk - 1);
});

test('Gellerpox: Barrelwarp does not reach a gun fired from across the board', () => {
  const s = field('gellerpox-infected', 'kasrkin', {
    mutant: { x: 10, y: 11 },
    'kasrkin-trooper': { x: 25, y: 11 },
  });
  const defender = find(s, 'mutant');
  const attacker = find(s, 'kasrkin-trooper');
  const gun = weaponOf(s, attacker, 'ranged');
  assert.equal(applyIncomingAttackHooks(s, defender, gun, { attacker, action: 'shoot' }).atk, gun.atk);
});

test('Gellerpox: Barrelwarp leaves a blade alone — it corrodes barrels', () => {
  const s = field('gellerpox-infected', 'kasrkin', {
    mutant: { x: 10, y: 11 },
    'kasrkin-trooper': { x: 10.6, y: 11 },
  });
  const defender = find(s, 'mutant');
  const attacker = find(s, 'kasrkin-trooper');
  const blade = weaponOf(s, attacker, 'melee');
  assert.equal(
    applyIncomingAttackHooks(s, defender, blade, { attacker, action: 'fight' }).atk, blade.atk);
});

test('Gellerpox: Revoltingly Resilient shrugs a point off a Nightmare Hulk', () => {
  const s = field('gellerpox-infected', 'kasrkin', { bloatspawn: { x: 10, y: 11 } });
  const op = find(s, 'bloatspawn');
  assert.equal(applyDamageHooks(s, op, 5, { kind: 'shoot' }), 4);
});

test('Gellerpox: Revoltingly Resilient does not cover a Glitchling', () => {
  const s = field('gellerpox-infected', 'kasrkin', { glitchling: { x: 10, y: 11 } });
  const op = find(s, 'glitchling');
  assert.equal(applyDamageHooks(s, op, 5, { kind: 'shoot' }), 5);
});

/* ====================================================================== */
/* CHAOS CULT — Accursed Gifts                                            */
/* ====================================================================== */

test('Chaos Cult: Horned gores an enemy the Mutant charged into', () => {
  const s = field('chaos-cult', 'kasrkin', {
    'chaos-mutant': { x: 10, y: 11 },
    'kasrkin-trooper': { x: 10.8, y: 11 },
  });
  const op = find(s, 'chaos-mutant');
  const victim = find(s, 'kasrkin-trooper');
  op.usedThisActivation = ['charge'];
  const before = victim.woundsRemaining;
  fireAfterAction(s, op, 'charge');
  assert.ok(victim.woundsRemaining < before, 'the charge did no goring damage');
});

test('Chaos Cult: Horned does not fire on a Reposition', () => {
  const s = field('chaos-cult', 'kasrkin', {
    'chaos-mutant': { x: 10, y: 11 },
    'kasrkin-trooper': { x: 10.8, y: 11 },
  });
  const op = find(s, 'chaos-mutant');
  const victim = find(s, 'kasrkin-trooper');
  op.usedThisActivation = ['reposition'];
  const before = victim.woundsRemaining;
  fireAfterAction(s, op, 'reposition');
  assert.equal(victim.woundsRemaining, before);
});

test('Chaos Cult: Sinewed is wired for the TORMENT the cult can grow into', () => {
  // No TORMENT is on the roster — Mutation, which would make one, is not
  // simulated — so the secondary gift is pinned as a declaration rather than
  // driven. If Mutation is ever wired, the live test belongs here.
  const hooks = loadTeam('chaos-cult').ruleHooks;
  const sinewed = hooks.filter((h) => h.rule.startsWith('Accursed Gifts (Sinewed)'));
  assert.equal(sinewed.length, 2, 'Sinewed no longer declares both of its clauses');
  assert.ok(sinewed.every((h) => h.condition.keyword === 'torment'));
});

test('Chaos Cult: the cult fields the pair of Mutants Mutation would have turned', () => {
  const roster = loadTeam('chaos-cult').roster.operatives;
  const mutants = roster.find((e) => e.profileId === 'chaos-mutant');
  assert.ok(mutants && mutants.count >= 1,
    'no MUTANT is fielded, so the primary ACCURSED GIFT can never fire');
});

test('Chaos Cult: Sinewed is the secondary gift — a Devotee does not get it', () => {
  const s = field('chaos-cult', 'kasrkin', {
    'chaos-devotee': { x: 10, y: 11 },
    'kasrkin-trooper': { x: 10.8, y: 11 },
  });
  const op = find(s, 'chaos-devotee');
  const blade = weaponOf(s, op, 'melee');
  const after = applyAttackHooks(s, op, blade, {
    target: find(s, 'kasrkin-trooper'), action: 'fight',
  });
  assert.equal(after.rules.includes('brutal'), false);
});

/* ====================================================================== */
/* FELLGOR RAVAGERS — Frenzy                                              */
/* ====================================================================== */

for (const [packId, WARRIOR] of [['fellgor-ravager', 'fellgor-gorehorn'],
  ['fellgor-ravager-warherd', 'fellgor-warrior']]) {
  test(`${packId}: Frenzy keeps a Beastman standing the first time it drops`, () => {
    const s = field(packId, 'kasrkin', { [WARRIOR]: { x: 10, y: 11 } });
    const op = find(s, WARRIOR);
    applyDamage(s, op.id, op.wounds + 5, { kind: 'shoot' });
    assert.equal(op.alive, true, 'Frenzy did not save it');
    assert.equal(op.woundsRemaining, 1);
    assert.equal(hasToken(op, 'frenzy', op.playerId), true);
  });

  test(`${packId}: Frenzy forces a Conceal order to Engage`, () => {
    const s = field(packId, 'kasrkin', {
      [WARRIOR]: { x: 10, y: 11, order: 'conceal' },
    });
    const op = find(s, WARRIOR);
    applyDamage(s, op.id, op.wounds + 5, { kind: 'shoot' });
    assert.equal(op.order, 'engage');
  });

  test(`${packId}: Frenzy saves an operative once, never twice`, () => {
    const s = field(packId, 'kasrkin', { [WARRIOR]: { x: 10, y: 11 } });
    const op = find(s, WARRIOR);
    applyDamage(s, op.id, op.wounds + 5, { kind: 'shoot' });
    assert.equal(op.alive, true);
    applyDamage(s, op.id, 5, { kind: 'shoot' });
    assert.equal(op.alive, false, 'the second killing blow was shrugged off too');
  });
}

test('an operative whose pack has no such rule still goes down', () => {
  const s = field('kasrkin', 'raveners', { 'kasrkin-trooper': { x: 10, y: 11 } });
  const op = find(s, 'kasrkin-trooper');
  applyDamage(s, op.id, op.wounds + 5, { kind: 'shoot' });
  assert.equal(op.alive, false);
});

test('surviving a killing blow logs the rule that did it', () => {
  const s = field('fellgor-ravager', 'kasrkin', { 'fellgor-gorehorn': { x: 10, y: 11 } });
  const op = find(s, 'fellgor-gorehorn');
  applyDamage(s, op.id, op.wounds + 5, { kind: 'shoot' });
  const said = s.eventLog.filter(
    (e) => e.type === EVENTS.RULE_APPLIED && e.rule === 'Frenzy');
  assert.ok(said.length > 0, 'the battle log never mentions Frenzy');
});

test('Fellgor: SWEEPING BLOW cuts an enemy within 2"', () => {
  const s = field('fellgor-ravager', 'kasrkin', {
    'fellgor-vandal': { x: 10, y: 11 },
    'kasrkin-trooper': { x: 11.4, y: 11 },
  });
  const actor = find(s, 'fellgor-vandal');
  const victim = find(s, 'kasrkin-trooper');
  const before = victim.woundsRemaining;
  const r = resolveUniqueAction(s, new Rng('sweep'), actor, {
    abilityId: 'sweeping-blow', targetId: victim.id,
  });
  assert.equal(r.ok, true, r.reason);
  assert.ok(victim.woundsRemaining < before);
});

test('Fellgor: UNCOMPROMISING ATTACK buys the Gnarlscar a second Fight', () => {
  const s = field('fellgor-ravager', 'kasrkin', {
    'fellgor-gnarlscar': { x: 10, y: 11 },
    'kasrkin-trooper': { x: 10.8, y: 11 },
  });
  const actor = find(s, 'fellgor-gnarlscar');
  fireActivationStart(s, actor);
  const r = resolveUniqueAction(s, new Rng('fight'), actor, {
    abilityId: 'uncompromising-attack',
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(actor.spendExtraActions?.fight, 1);
});

/* ====================================================================== */
/* CELESTIAN INSIDIANTS — Inspiration, Weapons of the Witch Hunters       */
/* ====================================================================== */

test('Celestian Insidiants: a charge makes the blow that follows Severe', () => {
  const s = field('celestian-insidiants', 'kasrkin', {
    'insidiant-warrior': { x: 10, y: 11 },
    'kasrkin-trooper': { x: 10.8, y: 11 },
  });
  const op = find(s, 'insidiant-warrior');
  op.usedThisActivation = ['charge'];
  const blade = weaponOf(s, op, 'melee');
  const after = applyAttackHooks(s, op, blade, {
    target: find(s, 'kasrkin-trooper'), action: 'fight',
  });
  assert.ok(after.rules.includes('severe'));
});

test('Celestian Insidiants: without the charge there is no Severe', () => {
  const s = field('celestian-insidiants', 'kasrkin', {
    'kasrkin-trooper': { x: 10.8, y: 11 },
  });
  const op = liveOperatives(s, 'p1')[0];
  op.x = 10; op.y = 11;
  op.usedThisActivation = [];
  const blade = weaponOf(s, op, 'melee');
  const after = applyAttackHooks(s, op, blade, {
    target: find(s, 'kasrkin-trooper'), action: 'fight',
  });
  assert.equal(after.rules.includes('severe'), false);
});

/* ====================================================================== */
/* LEGIONARY — Marks of Chaos                                             */
/* ====================================================================== */

for (const [packId, KHORNE, SLAANESH, NURGLE] of [
  ['legionary', 'legionary-butcher', 'legionary-shrivetalon', 'legionary-anointed'],
  ['legionary-warband', 'legionary-aspiring-champion', null, null],
]) {
  test(`${packId}: the Khorne mark makes melee Severe`, () => {
    const s = field(packId, 'kasrkin', {
      [KHORNE]: { x: 10, y: 11 },
      'kasrkin-trooper': { x: 10.8, y: 11 },
    });
    const op = find(s, KHORNE);
    const blade = weaponOf(s, op, 'melee');
    const after = applyAttackHooks(s, op, blade, {
      target: find(s, 'kasrkin-trooper'), action: 'fight',
    });
    assert.ok(after.rules.includes('severe'), 'Wrathful Onslaught did not fire');
  });

  test(`${packId}: the Khorne mark does not reach a gun`, () => {
    const s = field(packId, 'kasrkin', {
      [KHORNE]: { x: 10, y: 11 },
      'kasrkin-trooper': { x: 16, y: 11 },
    });
    const op = find(s, KHORNE);
    const gun = weaponOf(s, op, 'ranged');
    const after = applyAttackHooks(s, op, gun, {
      target: find(s, 'kasrkin-trooper'), action: 'shoot',
    });
    assert.equal(after.rules.includes('severe'), false);
  });

  test(`${packId}: the Slaanesh mark adds an inch of Move`, { skip: !SLAANESH }, () => {
    const s = field(packId, 'kasrkin', { [SLAANESH]: { x: 10, y: 11 } });
    const op = find(s, SLAANESH);
    const base = op.move;
    fireActivationStart(s, op);
    assert.equal(effectiveMove(op), base + 1);
  });

  test(`${packId}: the Nurgle mark blunts a point of damage`, { skip: !NURGLE }, () => {
    const s = field(packId, 'kasrkin', { [NURGLE]: { x: 10, y: 11 } });
    const op = find(s, NURGLE);
    assert.equal(applyDamageHooks(s, op, 4, { kind: 'shoot' }), 3);
  });

  test(`${packId}: the Balefire Acolyte is never marked for Khorne, as printed`, () => {
    const acolyte = loadTeam(packId).operatives.find(
      (o) => o.id === 'legionary-balefire-acolyte');
    assert.ok(acolyte, 'no Balefire Acolyte in this pack');
    assert.equal(acolyte.keywords.includes('khorne'), false);
  });
}

/* ====================================================================== */
/* DEATH KORPS — Guardsmen Orders                                         */
/* ====================================================================== */

test('Death Korps: Fix Bayonets! reaches a trooper within 6" of the Watchmaster', () => {
  const s = field('death-korps', 'kasrkin', {
    'death-korps-watchmaster': { x: 10, y: 11 },
    'death-korps-trooper': { x: 14, y: 11 },
    'kasrkin-trooper': { x: 14.8, y: 11 },
  });
  const op = find(s, 'death-korps-trooper');
  const blade = weaponOf(s, op, 'melee');
  const after = applyAttackHooks(s, op, blade, {
    target: find(s, 'kasrkin-trooper'), action: 'fight',
  });
  assert.ok(after.rules.includes('ceaseless'));
});

test('Death Korps: a trooper out of the Watchmaster\'s earshot hears nothing', () => {
  const s = field('death-korps', 'kasrkin', {
    'death-korps-watchmaster': { x: 2, y: 2 },
    'death-korps-trooper': { x: 20, y: 18 },
    'kasrkin-trooper': { x: 20.8, y: 18 },
  });
  const op = find(s, 'death-korps-trooper');
  const blade = weaponOf(s, op, 'melee');
  const after = applyAttackHooks(s, op, blade, {
    target: find(s, 'kasrkin-trooper'), action: 'fight',
  });
  assert.equal(after.rules.includes('ceaseless'), false);
});

/* ====================================================================== */
/* SANCTIFIERS, NOVITIATES, EXACTION SQUAD, FARSTALKER, VESPID            */
/* ====================================================================== */

test('Sanctifiers: the Sermon blunts damage near the Confessor', () => {
  const s = field('sanctifiers', 'kasrkin', {
    'sanctifier-confessor': { x: 10, y: 11 },
    'sanctifier-preacher': { x: 13, y: 11 },
  });
  const op = find(s, 'sanctifier-preacher');
  assert.equal(applyDamageHooks(s, op, 5, { kind: 'shoot' }), 4);
});

test('Sanctifiers: out of earshot of the Confessor there is no Sermon', () => {
  const s = field('sanctifiers', 'kasrkin', {
    'sanctifier-confessor': { x: 2, y: 2 },
    'sanctifier-preacher': { x: 22, y: 18 },
  });
  const op = find(s, 'sanctifier-preacher');
  assert.equal(applyDamageHooks(s, op, 5, { kind: 'shoot' }), 5);
});

test('Novitiates: Acts of Faith fills a pool in the Ready step', () => {
  const s = field('novitiates', 'kasrkin', {});
  resourceReadyStep(s);
  assert.ok(s.players.p1.resources.faith > 0, 'no Faith points were gained');
});

test('Exaction Squad: Marked for Justice gives Punishing against a wounded enemy', () => {
  const s = field('exaction-squad', 'kasrkin', {
    'kasrkin-trooper': { x: 16, y: 11 },
  });
  const op = liveOperatives(s, 'p1')[0];
  op.x = 10; op.y = 11;
  const mark = find(s, 'kasrkin-trooper');
  mark.woundsRemaining = 1;
  const gun = weaponOf(s, op, 'ranged');
  const after = applyAttackHooks(s, op, gun, { target: mark, action: 'shoot' });
  assert.ok(after.rules.includes('punishing'));
});

test('Farstalker Kinband: the Ready step turns up to three of them to Engage', () => {
  const s = field('farstalker-kinband', 'kasrkin', {});
  const mine = liveOperatives(s, 'p1');
  for (const op of mine) { op.order = 'conceal'; op.x = 5 + mine.indexOf(op); op.y = 11; }
  fireTurningPointStart(s, new Rng('orders'), mine);
  const engaged = mine.filter((o) => o.order === 'engage').length;
  assert.equal(engaged, 3, `expected exactly three orders flipped, got ${engaged}`);
});

test('Vespid Stingwings: Neutron Charge arms a neutron weapon after a move', () => {
  const s = field('vespid-stingwings', 'kasrkin', {
    'vespid-strain-leader': { x: 10, y: 11 },
    'kasrkin-trooper': { x: 16, y: 11 },
  });
  const op = liveOperatives(s, 'p1').find(
    (o) => weaponOf(s, o, 'ranged').name.toLowerCase().includes('neutron'));
  assert.ok(op, 'nobody on this roster carries a neutron weapon');
  op.usedThisActivation = ['reposition'];
  const gun = weaponOf(s, op, 'ranged');
  const after = applyAttackHooks(s, op, gun, {
    target: find(s, 'kasrkin-trooper'), action: 'shoot',
  });
  assert.ok(after.rules.some((r) => String(r).startsWith('piercing')));
});

test('Vespid Stingwings: a neutron weapon that has not moved is unchanged', () => {
  const s = field('vespid-stingwings', 'kasrkin', { 'kasrkin-trooper': { x: 16, y: 11 } });
  const op = liveOperatives(s, 'p1').find(
    (o) => weaponOf(s, o, 'ranged').name.toLowerCase().includes('neutron'));
  op.x = 10; op.y = 11;
  op.usedThisActivation = [];
  const gun = weaponOf(s, op, 'ranged');
  const after = applyAttackHooks(s, op, gun, {
    target: find(s, 'kasrkin-trooper'), action: 'shoot',
  });
  assert.equal(after.rules.filter((r) => String(r).startsWith('piercing')).length,
    gun.rules.filter((r) => String(r).startsWith('piercing')).length);
});

/* ====================================================================== */
/* Unique actions wired in this pass                                      */
/* ====================================================================== */

test('Celestian Insidiants: SPIRITUAL MENTOR hands Severe to a nearby sister', () => {
  const s = field('celestian-insidiants', 'kasrkin', {
    'insidiant-superior': { x: 10, y: 11 },
    'insidiant-warrior': { x: 13, y: 11 },
  });
  const actor = find(s, 'insidiant-superior');
  const friend = find(s, 'insidiant-warrior');
  const r = resolveUniqueAction(s, new Rng('mentor'), actor, {
    abilityId: 'spiritual-mentor', targetId: friend.id,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(hasToken(friend, 'inspiring', actor.playerId), true);
});

test('Celestian Insidiants: SPIRITUAL MENTOR is once per turning point', () => {
  const s = field('celestian-insidiants', 'kasrkin', {
    'insidiant-superior': { x: 10, y: 11 },
    'insidiant-warrior': { x: 13, y: 11 },
    'insidiant-reliquarius': { x: 12, y: 12 },
  });
  const actor = find(s, 'insidiant-superior');
  resolveUniqueAction(s, new Rng('mentor'), actor, {
    abilityId: 'spiritual-mentor', targetId: find(s, 'insidiant-warrior').id,
  });
  const again = resolveUniqueAction(s, new Rng('mentor'), actor, {
    abilityId: 'spiritual-mentor', targetId: find(s, 'insidiant-reliquarius').id,
  });
  assert.equal(again.ok, false);
});

test('Vespid Stingwings: AERIAL GUIDANCE lends Lethal 5+ and Saturate', () => {
  const s = field('vespid-stingwings', 'kasrkin', {
    'oversight-drone': { x: 10, y: 11 },
    'vespid-warrior': { x: 13, y: 11 },
  });
  const drone = find(s, 'oversight-drone');
  const friend = find(s, 'vespid-warrior');
  const r = resolveUniqueAction(s, new Rng('guide'), drone, {
    abilityId: 'aerial-guidance', targetId: friend.id,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(hasToken(friend, 'aerial-guidance', drone.playerId), true);
});

test('Goremonger: TRANSFUSION RITUAL tops up a comrade\'s GORE TANK', () => {
  const s = field('goremonger', 'kasrkin', {
    'goremonger-bloodtaker': { x: 10, y: 11 },
    'goremonger-aspirant': { x: 14, y: 11 },
  });
  const actor = find(s, 'goremonger-bloodtaker');
  const friend = find(s, 'goremonger-aspirant');
  friend.resources = { 'gore-tank': 0 };
  const r = resolveUniqueAction(s, new Rng('blood'), actor, {
    abilityId: 'transfusion-ritual', targetId: friend.id,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(friend.resources['gore-tank'], 1);
});

test('Mandrakes: PAREIDOLIC PROJECTION slows the operative it fixes on', () => {
  const s = field('mandrakes', 'kasrkin', {
    'mandrake-dirgemaw': { x: 10, y: 11 },
    'kasrkin-trooper': { x: 14, y: 11 },
  });
  const actor = find(s, 'mandrake-dirgemaw');
  const victim = find(s, 'kasrkin-trooper');
  const before = effectiveMove(victim);
  const r = resolveUniqueAction(s, new Rng('scream'), actor, {
    abilityId: 'pareidolic-projection', targetId: victim.id,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(effectiveMove(victim), before - 2);
});

test('Angel of Death: OPTICS lets the Eliminator see past cover for one shot', () => {
  const s = field('angel-of-death', 'kasrkin', { 'eliminator-sniper': { x: 10, y: 11 } });
  const actor = find(s, 'eliminator-sniper');
  const r = resolveUniqueAction(s, new Rng('optics'), actor, { abilityId: 'optics' });
  assert.equal(r.ok, true, r.reason);
  assert.ok((actor.actionBoosts || []).some(
    (b) => b.kind === 'weapon' && b.rules.includes('seek')));
});

test('an action with nobody to point it at is not on the menu', () => {
  // A SPIRITUAL MENTOR with every sister parked across the board has no legal
  // target, and the AI must never be offered it.
  const s = field('celestian-insidiants', 'kasrkin', {
    'insidiant-superior': { x: 2, y: 2 },
  });
  const actor = find(s, 'insidiant-superior');
  const entry = findUniqueAction(s, actor, 'spiritual-mentor');
  assert.deepEqual(uniqueActionTargets(s, actor, entry), []);
});
