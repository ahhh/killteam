import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, weapon, melee, rect } from './fixtures.mjs';
import { getLegalActions, resolveAction, ACTION_COST } from '../src/rules/engine.js';
import {
  availableUniqueActions, uniqueActionBlocker, uniqueActionTargets,
  reportUnsupportedUniqueActions, uniqueActionSupport, resetUniqueTurningPointUses,
} from '../src/rules/unique-actions.js';
import { applyDamage, effectiveApl } from '../src/rules/effects.js';
import { hasToken } from '../src/rules/tokens.js';
import { weaponAdjustments } from '../src/rules/team-rules.js';
import { canShoot } from '../src/rules/shooting.js';
import { openingSupport, uniqueActionValue } from '../src/ai/support.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A Medikit, cut down to what a test needs. */
function medikit(over = {}) {
  return {
    id: 'medikit', name: 'MEDIKIT', cost: '1AP',
    description: 'the printed wording',
    action: {
      ap: 1,
      target: { scope: 'controlRange', side: 'friendly', wounded: true },
      effect: { type: 'healWounds', dice: '2D3' },
      limits: { notEngaged: true },
      ...over,
    },
  };
}

function signal(over = {}) {
  return {
    id: 'signal', name: 'SIGNAL', cost: '1AP', description: 'the printed wording',
    action: {
      ap: 1,
      target: { scope: 'within', side: 'friendly', inches: 6, excludeSelf: true },
      effect: { type: 'addApl', amount: 1 },
      ...over,
    },
  };
}

function spot(over = {}) {
  return {
    id: 'spot', name: 'SPOT', cost: '1AP', description: 'the printed wording',
    action: {
      ap: 1,
      target: { scope: 'visible', side: 'enemy' },
      effect: { type: 'mark', weaponRules: ['seeklight'] },
      ...over,
    },
  };
}

/** Two friendlies side by side, one of them hurt, and an enemy far away. */
function medicState(spec = {}) {
  return makeState({
    p1: {
      count: 2, abilities: [spec.ability ?? medikit()],
      at: [{ x: 4, y: 10 }, { x: 4.8, y: 10 }],
      ...spec.p1,
    },
    p2: { at: [{ x: 26, y: 10 }] },
    ...spec.state,
  });
}

/* ------------------------------------------------------------------ */
/* The action layer                                                    */
/* ------------------------------------------------------------------ */

test('an ability with an action block becomes a legal action', () => {
  const state = medicState();
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 4);

  const legal = getLegalActions(state, medic.id);
  const unique = legal.find((a) => a.type === 'unique');
  assert.ok(unique, 'the Medikit is on the menu');
  assert.equal(unique.abilityId, 'medikit');
  assert.equal(unique.cost, 1);
  assert.deepEqual(unique.targets, [{ targetId: patient.id }]);
});

test('an ability with no action block is reference text, not an action', () => {
  const state = medicState({
    ability: { id: 'medikit', name: 'MEDIKIT', cost: '1AP', description: 'printed' },
  });
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 4);
  assert.equal(getLegalActions(state, medic.id).some((a) => a.type === 'unique'), false);
});

test('a Medikit puts wounds back and costs the AP', () => {
  const state = medicState();
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 6);
  const before = patient.woundsRemaining;

  const result = resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  });
  assert.ok(result.ok, result.reason);
  assert.ok(patient.woundsRemaining > before, 'the patient is better off');
  assert.ok(patient.woundsRemaining <= patient.wounds, 'never above its starting wounds');
  assert.equal(medic.apRemaining, medic.apl - 1);
});

test('a heal never exceeds the wounds actually lost', () => {
  const state = medicState();
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 1);
  resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  });
  assert.equal(patient.woundsRemaining, patient.wounds);
});

test('an untouched friend is not a legal target for a heal', () => {
  const state = medicState();
  const [medic, patient] = opsOf(state, 'p1');
  assert.equal(availableUniqueActions(state, medic).length, 0);
  const result = resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  });
  assert.equal(result.ok, false);
  assert.equal(medic.apRemaining, medic.apl, 'a refused action costs nothing');
});

test('the same unique action cannot be performed twice in one activation', () => {
  const state = medicState();
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 8);
  const action = {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  };
  assert.ok(resolveAction(state, action).ok);
  applyDamage(state, patient.id, 4);
  const second = resolveAction(state, action);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already performed/);
});

test('two different unique actions are each available once', () => {
  const state = medicState({ ability: medikit() });
  const [medic, patient] = opsOf(state, 'p1');
  // A second ability on the same profile.
  state.teamPacks.p1.operatives[0].abilities.push(signal());
  applyDamage(state, patient.id, 6);
  medic.apRemaining = 3;

  assert.ok(resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  }).ok);
  assert.ok(resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'signal', targetId: patient.id,
  }).ok, 'a different ability is not blocked by the first');
});

/* ------------------------------------------------------------------ */
/* Limits                                                             */
/* ------------------------------------------------------------------ */

test('notEngaged blocks an action while an enemy is in control range', () => {
  const state = medicState({ state: { p2: { at: [{ x: 4.9, y: 10 }] } } });
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 6);
  // The enemy stands on top of the medic.
  opsOf(state, 'p2')[0].x = 4.8;
  opsOf(state, 'p2')[0].y = 10;
  assert.match(uniqueActionBlocker(state, medic, {
    ability: medikit(), def: medikit().action,
  }), /control range/);
});

test('perTurningPoint holds across activations and resets in the Ready step', () => {
  const state = medicState({ ability: medikit({ limits: { perTurningPoint: 1 } }) });
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 8);
  assert.ok(resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  }).ok);

  // A fresh activation, same turning point.
  medic.usedThisActivation = [];
  medic.apRemaining = 2;
  applyDamage(state, patient.id, 4);
  const again = resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  });
  assert.equal(again.ok, false);
  assert.match(again.reason, /per turning point/);

  resetUniqueTurningPointUses(medic);
  medic.usedThisActivation = [];
  assert.ok(resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  }).ok, 'the leash comes off in the Ready step');
});

test('perBattle survives the Ready step', () => {
  const state = medicState({ ability: medikit({ limits: { perBattle: 1 } }) });
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 8);
  assert.ok(resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  }).ok);
  resetUniqueTurningPointUses(medic);
  medic.usedThisActivation = [];
  medic.apRemaining = 2;
  applyDamage(state, patient.id, 4);
  const again = resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  });
  assert.equal(again.ok, false);
  assert.match(again.reason, /per battle/);
});

test('notFirstTurningPoint keeps an action off the menu until turning point 2', () => {
  const state = medicState({ ability: medikit({ limits: { notFirstTurningPoint: true } }) });
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 6);
  assert.equal(availableUniqueActions(state, medic).length, 0);
  state.turningPoint = 2;
  assert.equal(availableUniqueActions(state, medic).length, 1);
});

/* ------------------------------------------------------------------ */
/* Targets                                                            */
/* ------------------------------------------------------------------ */

test('a keyword on the target block excludes friends that do not carry it', () => {
  const state = medicState({
    ability: medikit({
      target: { scope: 'controlRange', side: 'friendly', wounded: true, keyword: 'astartes' },
    }),
  });
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 6);
  assert.equal(availableUniqueActions(state, medic).length, 0);

  state.teamPacks.p1.operatives[0].keywords = ['astartes'];
  assert.equal(availableUniqueActions(state, medic).length, 1);
});

test('excludeSelf keeps a Signal off its own carrier', () => {
  const state = medicState({ ability: signal() });
  const [commsman] = opsOf(state, 'p1');
  const targets = uniqueActionTargets(state, commsman, {
    ability: signal(), def: signal().action,
  });
  assert.equal(targets.some((t) => t.id === commsman.id), false);
});

test('a "within" scope measures in inches from the operative', () => {
  const state = medicState({ ability: signal() });
  const [commsman, friend] = opsOf(state, 'p1');
  assert.equal(availableUniqueActions(state, commsman).length, 1);
  friend.x = commsman.x + 12;
  assert.equal(availableUniqueActions(state, commsman).length, 0);
});

test('`from` asks the question from somewhere the operative is not standing', () => {
  const state = medicState();
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 6);
  medic.x = 14; // out of control range
  assert.equal(availableUniqueActions(state, medic).length, 0);
  assert.equal(
    availableUniqueActions(state, medic, { from: { x: 4, y: 10 } }).length, 1,
    'it could reach the patient from over there');
});

/* ------------------------------------------------------------------ */
/* Effects                                                            */
/* ------------------------------------------------------------------ */

test('a Signal hands a friend APL that survives until it activates', () => {
  const state = medicState({ ability: signal() });
  const [commsman, friend] = opsOf(state, 'p1');
  const before = effectiveApl(friend);

  assert.ok(resolveAction(state, {
    operativeId: commsman.id, type: 'unique', abilityId: 'signal', targetId: friend.id,
  }).ok);
  assert.equal(effectiveApl(friend), before + 1);
  assert.ok(hasToken(friend, 'apl-boost:signal', 'p1'));
});

test('a Signal is not worth spending on a friend that already has one', () => {
  const state = medicState({ ability: signal() });
  const [commsman, friend] = opsOf(state, 'p1');
  commsman.apRemaining = 3;
  assert.ok(resolveAction(state, {
    operativeId: commsman.id, type: 'unique', abilityId: 'signal', targetId: friend.id,
  }).ok);
  // Same activation is already blocked; the point is that the target is gone
  // from the menu entirely, so no plan ever proposes it.
  commsman.usedThisActivation = [];
  assert.equal(availableUniqueActions(state, commsman).length, 0);
});

test('an APL buff on the acting operative hands over the point immediately', () => {
  const state = medicState({
    ability: signal({ target: { scope: 'self' }, effect: { type: 'addApl', amount: 1 } }),
  });
  const [op] = opsOf(state, 'p1');
  op.apRemaining = 1;
  op.usedThisActivation = ['reposition'];
  assert.ok(resolveAction(state, {
    operativeId: op.id, type: 'unique', abilityId: 'signal',
  }).ok);
  // One spent on the action, one handed back by it.
  assert.equal(op.apRemaining, 1);
});

test('a mark gives this team — and only this team — Seek Light against its holder', () => {
  const state = makeState({
    p1: { count: 2, abilities: [spot()], at: [{ x: 6, y: 10 }, { x: 7, y: 10 }] },
    p2: { at: [{ x: 18, y: 10 }] },
  });
  const [spotter, shooter] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');

  assert.ok(resolveAction(state, {
    operativeId: spotter.id, type: 'unique', abilityId: 'spot', targetId: foe.id,
  }).ok);

  const gun = weapon();
  const mine = weaponAdjustments(state, shooter, gun, { target: foe, action: 'shoot' });
  assert.ok(mine.rules.includes('seeklight'), 'the mark reaches our own shooters');

  const theirs = weaponAdjustments(state, foe, gun, { target: shooter, action: 'shoot' });
  assert.equal(theirs.rules.includes('seeklight'), false,
    'a mark is not a general weakness');
});

test('a mark lets a concealed target behind light terrain be selected at all', () => {
  const state = makeState({
    // Cover and Light, but NOT obscuring: Seek Light lets a concealed target
    // be selected past cover, and nothing lets it be selected through a wall.
    terrain: [{
      id: 'canopy', shape: { type: 'polygon', points: rect(11, 8, 2, 4) },
      traits: ['cover', 'light'],
    }],
    p1: { count: 2, abilities: [spot()], at: [{ x: 6, y: 10 }, { x: 7, y: 10 }] },
    p2: { at: [{ x: 14, y: 10, order: 'conceal' }] },
  });
  const [spotter, shooter] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');
  const gun = weapon();

  // Concealed in cover cannot be picked — that is the rule the mark answers.
  const before = canShoot(state, shooter.id, foe.id, gun);
  assert.equal(before.ok, false, before.reason);
  assert.match(before.reason, /concealed/);

  resolveAction(state, {
    operativeId: spotter.id, type: 'unique', abilityId: 'spot', targetId: foe.id,
  });
  assert.ok(canShoot(state, shooter.id, foe.id, gun).ok,
    'Seek Light from the mark is read when the target is selected, not only after');
});

test('a free Shoot handed to a comrade is resolved there and then', () => {
  const loader = {
    id: 'load', name: 'LOAD WEAPON', cost: '1AP', description: 'printed',
    action: {
      ap: 1,
      target: { scope: 'controlRange', side: 'friendly' },
      effect: { type: 'freeAction', action: 'shoot', immediate: true, unrestricted: true },
    },
  };
  const state = makeState({
    p1: { count: 2, abilities: [loader], at: [{ x: 6, y: 10 }, { x: 6.9, y: 10 }] },
    p2: { at: [{ x: 16, y: 10 }] },
  });
  const [lder, gunner] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');
  const before = state.eventLog.length;

  const result = resolveAction(state, {
    operativeId: lder.id, type: 'unique', abilityId: 'load', targetId: gunner.id,
  });
  assert.ok(result.ok, result.reason);
  const rolled = state.eventLog.slice(before)
    .filter((e) => e.type === 'ATTACK_ROLLED' && e.attackerId === gunner.id);
  assert.equal(rolled.length, 1, 'the comrade actually shot');
  assert.equal(gunner.apRemaining, gunner.apl, 'and it cost the comrade nothing');
});

test('an inflictDamage action can kill, and the kill is credited', () => {
  const smite = {
    id: 'smite', name: 'SMITE', cost: '1AP', description: 'printed',
    action: {
      ap: 1,
      target: { scope: 'within', side: 'enemy', inches: 6 },
      effect: { type: 'inflictDamage', dice: '20' },
    },
  };
  const state = makeState({
    p1: { abilities: [smite], at: [{ x: 10, y: 10 }] },
    p2: { at: [{ x: 13, y: 10 }] },
  });
  const [psyker] = opsOf(state, 'p1');
  const [foe] = opsOf(state, 'p2');
  assert.ok(resolveAction(state, {
    operativeId: psyker.id, type: 'unique', abilityId: 'smite', targetId: foe.id,
  }).ok);
  assert.equal(foe.alive, false);
});

/* ------------------------------------------------------------------ */
/* Honesty                                                            */
/* ------------------------------------------------------------------ */

test('a printed action with no effect block is named at battle start', () => {
  const state = medicState({
    ability: { id: 'medikit', name: 'MEDIKIT', cost: '1AP', description: 'printed' },
  });
  reportUnsupportedUniqueActions(state);
  const warned = state.warnings.find((w) => w.ruleId.startsWith('unique-actions:'));
  assert.ok(warned, 'the gap is reported rather than guessed at');
  assert.match(warned.detail, /MEDIKIT/);
});

test('an ability with no AP cost is not reported as a missing action', () => {
  const state = medicState({
    ability: { id: 'stalwart', name: 'STALWART', cost: '-', description: 'always on' },
  });
  reportUnsupportedUniqueActions(state);
  assert.equal(state.warnings.some((w) => w.ruleId.startsWith('unique-actions:')), false);
});

test('uniqueActionSupport counts what a pack declares against what it prints', () => {
  const support = uniqueActionSupport({
    operatives: [{
      abilities: [medikit(), { id: 'x', name: 'X', cost: '1AP' }, { id: 'y', cost: '-' }],
    }],
  });
  assert.deepEqual(support, { declared: 2, performable: 1 });
});

test('an unknown effect type is reported, not applied', () => {
  const state = medicState({
    ability: medikit({ effect: { type: 'teleportEveryone' } }),
  });
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 6);
  const result = resolveAction(state, {
    operativeId: medic.id, type: 'unique', abilityId: 'medikit', targetId: patient.id,
  });
  assert.equal(result.ok, false);
  assert.ok(state.warnings.some((w) => w.ruleId === 'unique-effect:teleportEveryone'));
  assert.equal(medic.apRemaining, medic.apl);
});

/* ------------------------------------------------------------------ */
/* What the AI does with them                                         */
/* ------------------------------------------------------------------ */

test('a heal is priced by the wounds it puts back', () => {
  const state = medicState();
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 8);
  const entry = { ability: medikit(), def: medikit().action, ap: 1 };
  const heavy = uniqueActionValue(state, medic, entry, patient);

  patient.woundsRemaining = patient.wounds - 1;
  const light = uniqueActionValue(state, medic, entry, patient);
  assert.ok(heavy > light, 'a badly hurt patient is worth more than a scratched one');
});

test('the AI spends AP on a support action worth more than the point it costs', () => {
  const state = medicState({ p1: { weapons: [melee()] } });
  const [medic, patient] = opsOf(state, 'p1');
  applyDamage(state, patient.id, 8);
  const opening = openingSupport(state, medic, { ap: 2 });
  assert.equal(opening.actions.length, 1);
  assert.equal(opening.actions[0].abilityId, 'medikit');
  assert.equal(opening.apCost, 1);
});

test('…and keeps it when there is nothing worth doing with it', () => {
  const state = medicState();
  const [medic] = opsOf(state, 'p1');
  // Nobody is hurt, so the Medikit has no target at all.
  assert.deepEqual(openingSupport(state, medic, { ap: 2 }),
    { actions: [], rationale: [], apCost: 0 });
});

test('a unique action type is known to the cost table', () => {
  assert.ok('unique' in ACTION_COST);
});
