import test from 'node:test';
import assert from 'node:assert/strict';
import { rollAttack, rollDefence, resolveSaves, WEAPON_RULES, parseRule } from '../src/rules/dice.js';

/** A stand-in for Rng that deals a scripted sequence, so results are exact. */
function scripted(...faces) {
  let i = 0;
  const next = () => {
    if (i >= faces.length) throw new Error('scripted rng ran out of dice');
    return faces[i++];
  };
  return { d6: next, rollDice: (n) => Array.from({ length: n }, next) };
}

const gun = (rules, over = {}) => ({
  id: 'w', name: 'Test gun', type: 'ranged', range: 12,
  atk: 4, hit: 3, damage: { normal: 3, critical: 4 }, rules, ...over,
});

const defender = { save: 3 };

/* --- Lethal x+ ---------------------------------------------------------- */

test('without Lethal, only 6s are critical hits', () => {
  const a = rollAttack(scripted(4, 5, 6, 2), gun([]));
  assert.equal(a.critOn, 6);
  assert.deepEqual([a.crits, a.normals, a.misses], [1, 2, 1]);
});

test('Lethal 5+ makes 5s and 6s critical', () => {
  const a = rollAttack(scripted(4, 5, 6, 2), gun(['lethal5']));
  assert.equal(a.critOn, 5);
  assert.deepEqual([a.crits, a.normals, a.misses], [2, 1, 1]);
});

test('Lethal 4+ makes 4s, 5s and 6s critical', () => {
  const a = rollAttack(scripted(4, 5, 6, 2), gun(['lethal4']));
  assert.equal(a.critOn, 4);
  assert.deepEqual([a.crits, a.normals, a.misses], [3, 0, 1]);
});

test('Lethal never promotes a die that missed the Hit stat', () => {
  // Hit 5+ with Lethal 4+: a 4 is not a success, so it cannot be a crit.
  const a = rollAttack(scripted(4, 4, 5, 6), gun(['lethal4'], { hit: 5 }));
  assert.deepEqual([a.crits, a.normals, a.misses], [2, 0, 2]);
});

/* --- Piercing x --------------------------------------------------------- */

test('Piercing x removes defence dice whether or not the attack critted', () => {
  for (const attackCrits of [0, 2]) {
    const d = rollDefence(scripted(6), defender, gun(['piercing2']), { attackCrits });
    assert.equal(d.dice, 1, `attackCrits=${attackCrits}`);
    assert.equal(d.rolls.length, 1);
  }
});

test('Piercing 1 is the default when no value is given', () => {
  const d = rollDefence(scripted(6, 6), defender, gun(['piercing']), {});
  assert.equal(d.dice, 2);
});

/* --- Piercing Crits x --------------------------------------------------- */

test('Piercing Crits x does nothing when no critical hit was retained', () => {
  const d = rollDefence(scripted(6, 6, 6), defender, gun(['piercingcrits2']), { attackCrits: 0 });
  assert.equal(d.dice, 3);
});

test('Piercing Crits x removes dice once a critical hit is retained', () => {
  const d = rollDefence(scripted(6), defender, gun(['piercingcrits2']), { attackCrits: 1 });
  assert.equal(d.dice, 1);
});

test('Piercing and Piercing Crits stack on the same weapon', () => {
  const w = gun(['piercing1', 'piercingcrits1']);
  assert.equal(rollDefence(scripted(6, 6), defender, w, { attackCrits: 0 }).dice, 2);
  assert.equal(rollDefence(scripted(6), defender, w, { attackCrits: 1 }).dice, 1);
});

test('defence dice never go below zero', () => {
  const d = rollDefence(scripted(), defender, gun(['piercing2', 'piercingcrits2']), { attackCrits: 1 });
  assert.equal(d.dice, 0);
  assert.deepEqual([d.normals, d.crits], [0, 0]);
});

/* --- Lethal 4+ with Piercing 2, together ------------------------------- */

test('Lethal 4+ and Piercing 2 combine: easier crits, fewer defence dice', () => {
  const w = gun(['lethal4', 'piercing2']);
  const a = rollAttack(scripted(4, 4, 2, 2), w);
  assert.deepEqual([a.crits, a.normals], [2, 0]);

  const d = rollDefence(scripted(3), defender, w, { attackCrits: a.crits });
  assert.equal(d.dice, 1);
  assert.deepEqual([d.normals, d.crits], [1, 0]);

  // One normal save cannot cancel a critical hit, so both crits land.
  const out = resolveSaves(a, d, w);
  assert.equal(out.unsavedCrits, 2);
  assert.equal(out.damage, 8);
});

/* --- Severe's interaction with Punishing and Devastating --------------- */

test('Punishing does not trigger off the critical that Severe created', () => {
  // Two normal hits, two misses, nothing critical: Severe promotes one hit.
  const a = rollAttack(scripted(3, 4, 1, 2), gun(['severe', 'punishing']));
  assert.deepEqual([a.crits, a.normals, a.misses], [1, 1, 2]);
});

test('Punishing still turns a miss into a hit off a natural critical', () => {
  const a = rollAttack(scripted(6, 4, 1, 2), gun(['punishing']));
  assert.deepEqual([a.crits, a.normals, a.misses], [1, 2, 1]);
});

test('Devastating damage is dealt by every retained critical, ignoring saves', () => {
  const w = gun(['devastating3']);
  const a = rollAttack(scripted(6, 6, 1, 1), w);
  const d = rollDefence(scripted(6, 6, 6), defender, w, { attackCrits: a.crits });
  const out = resolveSaves(a, d, w);
  assert.equal(out.devastatingDamage, 6);   // 2 crits x 3, saves notwithstanding
  assert.equal(out.unsavedCrits, 0);        // ...though the hits themselves were saved
  assert.equal(out.damage, 6);
});

/* --- Validation surface ------------------------------------------------- */

test('every value of a numbered rule resolves to its implemented entry', () => {
  for (const rule of ['lethal4', 'lethal5', 'piercing1', 'piercing2',
                      'piercingcrits1', 'devastating3', 'ap2']) {
    const { name } = parseRule(rule);
    assert.ok(name in WEAPON_RULES, `${rule} -> ${name} should be implemented`);
  }
});
