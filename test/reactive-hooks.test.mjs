/**
 * The triggers that fire outside an attacker's own dice roll: death throes, a
 * parting bite after a retaliation, what an action leaves behind, and the
 * defender's veto over being selected at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, rect, weapon, melee } from './fixtures.mjs';
import { applyDamage, effectiveApl } from '../src/rules/effects.js';
import {
  fireAfterAction, fireActivationEnd, fireActivationStart, fireTurningPointStart,
} from '../src/rules/hooks.js';
import { canShoot } from '../src/rules/shooting.js';
import { resolveFight } from '../src/rules/fighting.js';
import { Rng } from '../src/rng.js';
import { EVENTS, liveOperatives, ORDERS } from '../src/state.js';

const bursts = (dice, over = {}) => ({
  id: 'burst', rule: 'Putrescent Demise', trigger: 'onIncapacitated',
  effect: { type: 'inflictDamage', dice, within: 2, ...over },
});

function damageTo(state, id) {
  return state.eventLog
    .filter((e) => e.type === EVENTS.DAMAGE_APPLIED && e.operativeId === id)
    .reduce((n, e) => n + e.amount, 0);
}

/* --- onIncapacitated -------------------------------------------------- */

test('death throes damage the enemies standing over the body', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], wounds: 4, ruleHooks: [bursts('3')] },
    p2: { at: [{ x: 11, y: 11 }, { x: 11.5, y: 11 }], count: 2, wounds: 12 },
  });
  const [victim] = liveOperatives(s, 'p1');
  const near = liveOperatives(s, 'p2');

  applyDamage(s, victim.id, 4, { kind: 'shoot', attackerId: near[0].id });

  assert.equal(victim.alive, false);
  // One target by default: the enemy closest to dying, not the whole crowd.
  assert.equal(damageTo(s, near[0].id) + damageTo(s, near[1].id), 3);
});

test('scope "each" catches every enemy in the radius', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], wounds: 4, ruleHooks: [bursts('2', { scope: 'each' })] },
    p2: { at: [{ x: 11, y: 11 }, { x: 11.5, y: 11 }], count: 2, wounds: 12 },
  });
  const [victim] = liveOperatives(s, 'p1');
  const near = liveOperatives(s, 'p2');

  applyDamage(s, victim.id, 4, { kind: 'shoot', attackerId: near[0].id });

  assert.equal(damageTo(s, near[0].id), 2);
  assert.equal(damageTo(s, near[1].id), 2);
});

test('throes reach nobody outside the radius', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], wounds: 4, ruleHooks: [bursts('3')] },
    p2: { at: [{ x: 20, y: 11 }], wounds: 12 },
  });
  const [victim] = liveOperatives(s, 'p1');
  const far = liveOperatives(s, 'p2')[0];

  applyDamage(s, victim.id, 4, { kind: 'shoot', attackerId: far.id });
  assert.equal(damageTo(s, far.id), 0);
});

test('a chain of throes terminates — each operative fires at most once', () => {
  const throe = { ...bursts('20', { scope: 'each' }), id: 'chain' };
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }, { x: 10.5, y: 11 }], count: 2, wounds: 4, ruleHooks: [throe] },
    p2: { at: [{ x: 11, y: 11 }, { x: 11.5, y: 11 }], count: 2, wounds: 4, ruleHooks: [throe] },
  });
  const [victim] = liveOperatives(s, 'p1');
  applyDamage(s, victim.id, 4, { kind: 'shoot' });
  // Everyone dies, and the call returns rather than recursing forever.
  assert.equal(liveOperatives(s).length, 0);
});

test('a throe printed for a melee death does not fire on a shot', () => {
  const hook = { ...bursts('3'), condition: { action: 'fight' } };
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], wounds: 4, ruleHooks: [hook] },
    p2: { at: [{ x: 11, y: 11 }], wounds: 12 },
  });
  const [victim] = liveOperatives(s, 'p1');
  const foe = liveOperatives(s, 'p2')[0];

  applyDamage(s, victim.id, 4, { kind: 'shoot', attackerId: foe.id });
  assert.equal(damageTo(s, foe.id), 0);
});

test('target "attacker" strikes the operative that landed the blow', () => {
  const hook = {
    id: 'last-swing', rule: 'Unending Bloodshed', trigger: 'onIncapacitated',
    condition: { action: 'fight' },
    effect: { type: 'inflictDamage', dice: '3', target: 'attacker' },
  };
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], wounds: 4, ruleHooks: [hook] },
    // Out of the 2" radius, so only the `attacker` route can reach it.
    p2: { at: [{ x: 20, y: 11 }], wounds: 12 },
  });
  const [victim] = liveOperatives(s, 'p1');
  const killer = liveOperatives(s, 'p2')[0];

  applyDamage(s, victim.id, 4, { kind: 'fight', attackerId: killer.id });
  assert.equal(damageTo(s, killer.id), 3);
});

test('a token hung by a death throe outlives its owner', () => {
  const hook = {
    id: 'poisonous', rule: 'Poisonous Demise', trigger: 'onIncapacitated',
    effect: {
      type: 'inflictToken', within: 3, scope: 'each',
      token: { kind: 'poison', label: 'Poison', onActivation: { damage: '1' } },
    },
  };
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], wounds: 4, ruleHooks: [hook] },
    p2: { at: [{ x: 11, y: 11 }], wounds: 12 },
  });
  const [victim] = liveOperatives(s, 'p1');
  const foe = liveOperatives(s, 'p2')[0];

  applyDamage(s, victim.id, 4, { kind: 'shoot', attackerId: foe.id });
  assert.deepEqual(foe.tokens.map((t) => t.kind), ['poison']);
  assert.equal(foe.tokens[0].owner, 'p1');
});

test('death throes draw from their own dice stream, not the sequence\'s', () => {
  // A sequence checks out `state.rng` and writes it back when it finishes. A
  // throe rolling from the same stream mid-sequence would have its dice
  // handed out a second time.
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], wounds: 4, ruleHooks: [bursts('D3')] },
    p2: { at: [{ x: 11, y: 11 }], wounds: 12 },
  });
  const before = { ...s.rng };
  const [victim] = liveOperatives(s, 'p1');
  applyDamage(s, victim.id, 4, { kind: 'shoot', attackerId: liveOperatives(s, 'p2')[0].id });

  assert.deepEqual(s.rng, before, 'the battle stream is untouched');
  assert.ok(s.rngAux.index > 0, 'the auxiliary stream advanced instead');
});

/* --- afterAction ------------------------------------------------------ */

test('afterAction fires for the action named, and only for it', () => {
  const hook = {
    id: 'crash', rule: 'We Have Come For You', trigger: 'afterAction',
    condition: { actionIs: 'charge', actionCountAtMost: 1 },
    effect: { type: 'inflictDamage', dice: '3', controlRangeOnly: true },
  };
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], ruleHooks: [hook] },
    p2: { at: [{ x: 10.8, y: 11 }], wounds: 12 },
  });
  const [op] = liveOperatives(s, 'p1');
  const foe = liveOperatives(s, 'p2')[0];

  op.usedThisActivation = ['reposition'];
  fireAfterAction(s, op, 'reposition');
  assert.equal(damageTo(s, foe.id), 0, 'wrong action');

  op.usedThisActivation = ['charge'];
  fireAfterAction(s, op, 'charge');
  assert.equal(damageTo(s, foe.id), 3);

  // Second time round the charge is no longer the operative's first action.
  op.usedThisActivation = ['reposition', 'charge'];
  fireAfterAction(s, op, 'charge');
  assert.equal(damageTo(s, foe.id), 3);
});

/* --- afterRetaliation ------------------------------------------------- */

test('an operative that survives being fought bites back', () => {
  const hook = {
    id: 'savage', rule: 'Savage Fighters', trigger: 'afterRetaliation',
    effect: { type: 'inflictDamage', dice: '2', target: 'attacker' },
  };
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], wounds: 40, weapons: [melee({ atk: 1, hit: 6 })] },
    p2: { at: [{ x: 10.8, y: 11 }], wounds: 40, weapons: [melee({ atk: 1, hit: 6 })],
      ruleHooks: [hook] },
  });
  const attacker = liveOperatives(s, 'p1')[0];
  const defender = liveOperatives(s, 'p2')[0];

  const before = damageTo(s, attacker.id);
  resolveFight(s, attacker.id, defender.id, 'w-melee');
  const throes = s.eventLog.filter(
    (e) => e.type === EVENTS.RULE_APPLIED && e.rule === 'Savage Fighters');
  assert.equal(throes.length, 1, 'the retaliator gets exactly one parting bite');
  assert.equal(damageTo(s, attacker.id) - before >= 2, true);
});

/* --- onTargetSelection ------------------------------------------------ */

const hidden = {
  id: 'shifty', rule: 'Shifty', trigger: 'onTargetSelection',
  effect: { type: 'denyTargeting', requireConceal: true, requireCover: true, exceptWithin: 2 },
};

function concealedInCover(extra = {}) {
  return makeState({
    terrain: [{
      id: 'wall', name: 'Wall', traits: ['cover'],
      shape: { type: 'polygon', points: rect(14, 9, 1, 4) },
    }],
    p1: { at: [{ x: 5, y: 11 }], weapons: [weapon({ rules: ['seeklight'] })] },
    p2: { at: [{ x: 20, y: 11 }], ruleHooks: [hidden], ...extra },
  });
}

test('a concealed operative in cover cannot be selected, Seek or no Seek', () => {
  const s = concealedInCover();
  const shooter = liveOperatives(s, 'p1')[0];
  const target = liveOperatives(s, 'p2')[0];
  shooter.order = ORDERS.ENGAGE;
  target.order = ORDERS.CONCEAL;

  const check = canShoot(s, shooter.id, target.id, shooter.weapons ?? weapon({ rules: ['seeklight'] }));
  assert.equal(check.ok, false);
  assert.match(check.reason, /cannot be selected/);
});

test('the veto lapses the moment the operative takes an Engage order', () => {
  const s = concealedInCover();
  const shooter = liveOperatives(s, 'p1')[0];
  const target = liveOperatives(s, 'p2')[0];
  shooter.order = ORDERS.ENGAGE;
  target.order = ORDERS.ENGAGE;

  assert.equal(canShoot(s, shooter.id, target.id, weapon()).ok, true);
});

/* --- changeOrder ------------------------------------------------------ */

test('a turning-point order change spends a rolled budget across the roster', () => {
  const hook = {
    id: 'adaptable', rule: 'Adaptable Training', trigger: 'onTurningPointStart',
    condition: { awayFromEnemies: 4 },
    effect: { type: 'changeOrder', order: 'engage', count: '2' },
  };
  const s = makeState({
    p1: { at: [{ x: 5, y: 8 }, { x: 5, y: 11 }, { x: 5, y: 14 }], count: 3, ruleHooks: [hook] },
    p2: { at: [{ x: 25, y: 11 }] },
  });
  const ours = liveOperatives(s, 'p1');
  for (const op of ours) op.order = ORDERS.CONCEAL;

  fireTurningPointStart(s, new Rng('t'), ours);
  assert.equal(ours.filter((o) => o.order === ORDERS.ENGAGE).length, 2);
});

test('an operative close to the enemy is not re-ordered', () => {
  const hook = {
    id: 'adaptable', rule: 'Adaptable Training', trigger: 'onTurningPointStart',
    condition: { awayFromEnemies: 4 },
    effect: { type: 'changeOrder', order: 'engage' },
  };
  const s = makeState({
    p1: { at: [{ x: 24, y: 11 }], ruleHooks: [hook] },
    p2: { at: [{ x: 25, y: 11 }] },
  });
  const [op] = liveOperatives(s, 'p1');
  op.order = ORDERS.CONCEAL;
  fireTurningPointStart(s, new Rng('t'), [op]);
  assert.equal(op.order, ORDERS.CONCEAL);
});

test('an end-of-activation hook slips the operative back into Conceal', () => {
  const hook = {
    id: 'slither', rule: 'Slither Out Of Sight', trigger: 'onActivationEnd',
    condition: { orderIs: 'engage' },
    effect: { type: 'changeOrder', order: 'conceal' },
  };
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], ruleHooks: [hook] },
    p2: { at: [{ x: 25, y: 11 }] },
  });
  const [op] = liveOperatives(s, 'p1');
  op.order = ORDERS.ENGAGE;
  fireActivationEnd(s, op);
  assert.equal(op.order, ORDERS.CONCEAL);
});

/* --- APL tokens ------------------------------------------------------- */

test('a token carrying aplDelta costs its holder an action', () => {
  const hook = {
    id: 'captivation', rule: 'Sickening Captivation', trigger: 'onActivationStart',
    effect: {
      type: 'inflictToken', within: 4,
      token: {
        kind: 'captivation', label: 'Sickening Captivation',
        whileHeld: { aplDelta: -1 }, expiry: { endOfNextActivation: true },
      },
    },
  };
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], ruleHooks: [hook] },
    p2: { at: [{ x: 12, y: 11 }], apl: 3 },
  });
  const [op] = liveOperatives(s, 'p1');
  const foe = liveOperatives(s, 'p2')[0];

  assert.equal(effectiveApl(foe), 3);
  fireActivationStart(s, op, new Rng('t'));
  assert.equal(effectiveApl(foe), 2);
});
