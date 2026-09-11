/**
 * Marker control beyond the APL stat.
 *
 * A family of printed rules says "treat its APL as x when determining control
 * of markers" and then adds "this does not change its APL stat" — the Red
 * Thirst's Loss of Restraint, Heir of Azkaellon, Creed of Martyrdom, The Word
 * Made Flesh. Two things have to be true of all of them: they move the number
 * on the marker, and they leave the AP the operative gets to spend alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf } from './fixtures.mjs';
import {
  contestants, controlApl, controlValue, updateObjectiveControl,
} from '../src/rules/objectives.js';
import { effectiveApl } from '../src/rules/effects.js';
import { grantToken } from '../src/rules/tokens.js';
import { fireActivationStart, fireAfterAction } from '../src/rules/hooks.js';

const MARKER = [{ id: 'obj-1', x: 11, y: 11, controlRange: 1 }];

function scenario({ controlModifiers = [], keywords = ['spear'], p1At, p2At = [{ x: 25, y: 11 }] }) {
  return makeState({
    objectives: MARKER,
    p1: { at: p1At, count: p1At.length, keywords, apl: 3, controlModifiers },
    p2: { at: p2At, apl: 3 },
  });
}

/* --- a token that only the marker can see ------------------------------ */

test('a controlAplDelta token changes control without touching AP', () => {
  const s = scenario({ p1At: [{ x: 11, y: 11 }] });
  const [a] = opsOf(s, 'p1');
  assert.equal(controlApl(s, a), 3);

  grantToken(s, a, {
    kind: 'red-thirst', label: 'Red Thirst', whileHeld: { controlAplDelta: -2 },
  }, { owner: 'p1', rule: 'The Red Thirst' });

  assert.equal(controlApl(s, a), 1, 'contributes 1 to the marker');
  assert.equal(effectiveApl(a), 3, 'still gets all three of its actions');
});

test('control never falls below 1, however deep the penalty', () => {
  const s = scenario({ p1At: [{ x: 11, y: 11 }] });
  const [a] = opsOf(s, 'p1');
  grantToken(s, a, { kind: 'x', label: 'X', whileHeld: { controlAplDelta: -9 } },
    { owner: 'p1', rule: 'X' });
  assert.equal(controlApl(s, a), 1);
});

/* --- pack-declared modifiers ------------------------------------------- */

const HEIR = [{
  id: 'heir', rule: 'Heir of Azkaellon', delta: 1, cap: 4,
  condition: { keyword: 'guard', friendlyWithin: { inches: 3, keyword: 'leader' } },
}];

test('a proximity modifier applies only while the named friendly is near', () => {
  const s = scenario({
    controlModifiers: HEIR, keywords: ['spear', 'guard', 'leader'],
    p1At: [{ x: 11, y: 11 }, { x: 13, y: 11 }],
  });
  const [guard, captain] = opsOf(s, 'p1');
  assert.equal(controlApl(s, guard), 4, 'captain is within 3"');

  captain.x = 25;
  assert.equal(controlApl(s, guard), 3, 'captain has walked away');

  captain.x = 13;
  captain.alive = false;
  assert.equal(controlApl(s, guard), 3, 'a dead captain leads nobody');
});

test('a modifier respects its cap', () => {
  const mods = [{ id: 'big', rule: 'Big', delta: 3, cap: 4, condition: { keyword: 'guard' } }];
  const s = scenario({ controlModifiers: mods, keywords: ['spear', 'guard'], p1At: [{ x: 11, y: 11 }] });
  const [a] = opsOf(s, 'p1');
  assert.equal(controlApl(s, a), 4);
});

test('contestedWithKeyword reads the operatives on this marker, not the board', () => {
  const mods = [{
    id: 'word-made-flesh', rule: 'The Word Made Flesh', delta: 1,
    condition: { keyword: 'apostle', contestedWithKeyword: 'cultist' },
  }];
  const s = makeState({
    objectives: MARKER,
    p1: { at: [{ x: 11, y: 11 }, { x: 11.5, y: 11 }], count: 2, apl: 3,
          keywords: ['apostle', 'cultist'], controlModifiers: mods },
    p2: { at: [{ x: 25, y: 11 }] },
  });
  // The fixture gives both operatives one shared profile, so each is an
  // APOSTLE that sees a CULTIST beside it: 4 and 4 rather than 4 and 3. What
  // the test is pinning is the "beside it" half.
  const [apostle, cultist] = opsOf(s, 'p1');
  assert.equal(controlValue([apostle, cultist], s), 8, 'each has company on the marker');
  assert.equal(controlValue([apostle], s), 3, 'alone on the marker, no congregation');
  cultist.x = 25;
  const near = contestants(s, s.objectives[0]).p1;
  assert.deepEqual(near.map((o) => o.id), [apostle.id], 'only one is still on the marker');
  assert.equal(controlValue(near, s), 3,
    'standing elsewhere on the board is not contesting this marker');
});

test('an unknown control condition is reported and never applies', () => {
  const mods = [{ id: 'bogus', rule: 'Bogus', delta: 5, condition: { phaseOfTheMoon: 'full' } }];
  const s = scenario({ controlModifiers: mods, p1At: [{ x: 11, y: 11 }] });
  const [a] = opsOf(s, 'p1');
  assert.equal(controlApl(s, a), 3);
  assert.ok(s.warnings.some((w) => /phaseOfTheMoon/.test(w.detail)));
});

test('control of the marker itself reads the modified numbers', () => {
  const s = makeState({
    objectives: MARKER,
    p1: { at: [{ x: 11, y: 11 }], apl: 3, keywords: ['spear'], controlModifiers: [] },
    p2: { at: [{ x: 11.6, y: 11 }], apl: 3 },
  });
  const [a] = opsOf(s, 'p1');
  updateObjectiveControl(s);
  assert.equal(s.objectives[0].controlledBy, null, '3 against 3 is contested');

  grantToken(s, a, { kind: 'thirst', label: 'Thirst', whileHeld: { controlAplDelta: -2 } },
    { owner: 'p1', rule: 'Thirst' });
  updateObjectiveControl(s);
  assert.equal(s.objectives[0].controlledBy, 'p2', 'the blood-maddened Marine has lost it');
});

/* --- the hook that hangs one on its own operative ---------------------- */

test('inflictToken with target "self" reaches the operative that acted', () => {
  const hooks = [{
    id: 'red-thirst', rule: 'The Red Thirst', trigger: 'afterAction',
    condition: { keyword: 'spear', actionIs: 'charge' },
    effect: {
      type: 'inflictToken', target: 'self',
      token: { kind: 'red-thirst', label: 'Red Thirst', unique: true,
               whileHeld: { controlAplDelta: -2 },
               expiry: { startOfNextActivation: true } },
    },
  }];
  const s = makeState({
    objectives: MARKER,
    p1: { at: [{ x: 11, y: 11 }], apl: 3, keywords: ['spear'], ruleHooks: hooks },
    p2: { at: [{ x: 25, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const [foe] = opsOf(s, 'p2');

  fireAfterAction(s, a, 'reposition');
  assert.equal(controlApl(s, a), 3, 'only the Charge commits him');

  fireAfterAction(s, a, 'charge');
  assert.equal(controlApl(s, a), 1, 'given in to the Red Thirst');
  assert.equal(foe.tokens.length, 0, 'the enemy is untouched');
});
