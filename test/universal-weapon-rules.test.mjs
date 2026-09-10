/**
 * The universal weapon rules that reach past the dice: Heavy, Hot, Limited,
 * Silent, Seek, Seek Light, Shock, Stun, Blast and Torrent.
 *
 * Wording follows the Kill Team weapon rules appendix; each test names the
 * clause it is pinning down so a future rules revision is easy to re-check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, rect, melee } from './fixtures.mjs';
import { resolveAction, getLegalActions } from '../src/rules/engine.js';
import { canShoot, resolveShoot } from '../src/rules/shooting.js';
import { rollAttack, rollDefence, resolveSaves, parseRule } from '../src/rules/dice.js';
import {
  heavyAllowedMove, heavyShootBlocker, heavyMoveBlocker, noteHeavyUse,
  noteWeaponUse, limitedExhausted, isSilent, seekMode, rollHot,
  blastRadius, torrentRadius,
} from '../src/rules/weapon-rules.js';
import { effectiveApl, isStunned } from '../src/rules/effects.js';

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

/* --- Shock -------------------------------------------------------------- */

test('Shock discards one of the defender\'s normal successes off a crit', () => {
  const w = gun(['shock']);
  const a = rollAttack(scripted(6, 4, 1, 1), w);          // 1 crit, 1 normal
  const d = rollDefence(scripted(3, 4, 2), defender, w);  // 2 normal saves
  assert.deepEqual([d.normals, d.crits], [2, 0]);

  const out = resolveSaves(a, d, w);
  assert.equal(out.shockDiscarded, 'normal');
  // One save is gone, so the surviving one cancels the normal hit and the
  // critical lands: 4 damage rather than nothing.
  assert.equal(out.unsavedCrits, 1);
  assert.equal(out.damage, 4);
});

test('Shock takes a critical save when the defender has no normal ones', () => {
  const w = gun(['shock']);
  const a = rollAttack(scripted(6, 1, 1, 1), w);
  const d = rollDefence(scripted(6, 2, 2), defender, w);
  assert.deepEqual([d.normals, d.crits], [0, 1]);

  const out = resolveSaves(a, d, w);
  assert.equal(out.shockDiscarded, 'critical');
  assert.equal(out.damage, 4);
});

test('Shock does nothing when the attack retained no critical success', () => {
  const w = gun(['shock']);
  const a = rollAttack(scripted(3, 4, 1, 1), w);
  const d = rollDefence(scripted(3, 4, 2), defender, w);
  const out = resolveSaves(a, d, w);
  assert.equal(out.shockDiscarded, null);
  assert.equal(out.damage, 0);
});

/* --- Heavy -------------------------------------------------------------- */

test('a rule token carries its qualifier: heavy:dash', () => {
  assert.deepEqual(parseRule('heavy:dash'), { name: 'heavy', value: null, qualifier: 'dash' });
  assert.equal(heavyAllowedMove(gun(['heavy:dash'])), 'dash');
  assert.equal(heavyAllowedMove(gun(['heavy'])), null);
  assert.equal(heavyAllowedMove(gun([])), undefined);
});

test('Heavy forbids the weapon after any move; Heavy (Dash only) permits a Dash', () => {
  assert.equal(heavyShootBlocker(gun(['heavy']), []), null);
  assert.match(heavyShootBlocker(gun(['heavy']), ['dash']), /already performed Dash/);

  assert.equal(heavyShootBlocker(gun(['heavy:dash']), ['dash']), null);
  assert.match(heavyShootBlocker(gun(['heavy:dash']), ['reposition']), /Reposition/);

  assert.equal(heavyShootBlocker(gun(['heavy:reposition']), ['reposition']), null);
  assert.match(heavyShootBlocker(gun(['heavy:reposition']), ['dash']), /Dash/);
});

test('Heavy runs the other way too: having fired it pins the operative', () => {
  const op = { heavyUsed: false, heavyMoveAllowed: null };
  assert.equal(heavyMoveBlocker(op, 'reposition'), null);

  noteHeavyUse(op, gun(['heavy:dash']));
  assert.equal(heavyMoveBlocker(op, 'dash'), null);
  assert.match(heavyMoveBlocker(op, 'reposition'), /Heavy \(Dash only\)/);

  // A second, stricter Heavy weapon leaves the tighter of the two limits.
  noteHeavyUse(op, gun(['heavy']));
  assert.match(heavyMoveBlocker(op, 'dash'), /Heavy/);
});

test('the engine rejects a Reposition after a Heavy weapon has fired', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], weapons: [gun(['heavy']), melee()] },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');

  assert.equal(resolveAction(s, { operativeId: a.id, type: 'shoot', targetId: b.id, weaponId: 'w' }).ok, true);
  assert.equal(a.heavyUsed, true);

  const move = resolveAction(s, { operativeId: a.id, type: 'reposition', destination: { x: 8, y: 11 } });
  assert.equal(move.ok, false);
  assert.match(move.reason, /Heavy/);
  assert.ok(!getLegalActions(s, a.id).some((x) => x.type === 'reposition'));
});

test('the engine rejects a Heavy shot taken after moving', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], weapons: [gun(['heavy:dash']), melee()] },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');

  assert.equal(resolveAction(s, { operativeId: a.id, type: 'reposition', destination: { x: 11, y: 11 } }).ok, true);
  const shot = resolveAction(s, { operativeId: a.id, type: 'shoot', targetId: b.id, weaponId: 'w' });
  assert.equal(shot.ok, false);
  assert.match(shot.reason, /Heavy \(Dash only\)/);
});

test('Heavy (Dash only) still allows a Dash and then the shot', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], apl: 3, weapons: [gun(['heavy:dash']), melee()] },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  a.apRemaining = 3;

  assert.equal(resolveAction(s, { operativeId: a.id, type: 'dash', destination: { x: 11, y: 11 } }).ok, true);
  assert.equal(resolveAction(s, { operativeId: a.id, type: 'shoot', targetId: b.id, weaponId: 'w' }).ok, true);
});

/* --- Limited x ---------------------------------------------------------- */

test('Limited x retires the weapon after x uses, for the whole battle', () => {
  const w = gun(['limited1']);
  const op = { weaponUses: {} };
  assert.equal(limitedExhausted(op, w), false);
  noteWeaponUse(op, w);
  assert.equal(limitedExhausted(op, w), true);

  const twice = gun(['limited2'], { id: 'w2' });
  noteWeaponUse(op, twice);
  assert.equal(limitedExhausted(op, twice), false);
  noteWeaponUse(op, twice);
  assert.equal(limitedExhausted(op, twice), true);
});

test('a spent Limited weapon drops out of the legal actions', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], apl: 3, weapons: [gun(['limited1']), melee()] },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  a.apRemaining = 3;

  assert.equal(resolveShoot(s, a.id, b.id, 'w').ok, true);
  const again = canShoot(s, a.id, b.id, gun(['limited1']));
  assert.equal(again.ok, false);
  assert.match(again.reason, /Limited/);
  assert.ok(!getLegalActions(s, a.id).some((x) => x.type === 'shoot'));
});

/* --- Silent ------------------------------------------------------------- */

test('Silent lets the Shoot action happen from a Conceal order', () => {
  const build = (rules) => {
    const s = makeState({
      p1: { at: [{ x: 10, y: 11, order: 'conceal' }], weapons: [gun(rules), melee()] },
      p2: { at: [{ x: 16, y: 11 }] },
    });
    const [a] = opsOf(s, 'p1');
    const [b] = opsOf(s, 'p2');
    return canShoot(s, a.id, b.id, gun(rules));
  };

  assert.equal(isSilent(gun(['silent'])), true);
  assert.equal(build(['silent']).ok, true);

  const loud = build([]);
  assert.equal(loud.ok, false);
  assert.match(loud.reason, /Engage order/);
});

/* --- Seek and Seek Light ------------------------------------------------ */

/** A concealed enemy tucked behind one piece of cover-granting terrain. */
function concealedBehindCover(traits, rules) {
  const s = makeState({
    terrain: [{
      id: 'wall', shape: { type: 'polygon', points: rect(13, 9, 1, 4) },
      height: 2, traits,
    }],
    p1: { at: [{ x: 6, y: 11 }], weapons: [gun(rules), melee()] },
    p2: { at: [{ x: 18, y: 11, order: 'conceal' }] },
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  return canShoot(s, a.id, b.id, gun(rules, { range: 24 }));
}

test('a concealed operative in cover cannot normally be selected', () => {
  const check = concealedBehindCover(['cover'], []);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'concealed in cover');
});

test('Seek ignores terrain when selecting a target', () => {
  assert.equal(seekMode(gun(['seek'])), 'all');
  assert.equal(concealedBehindCover(['cover'], ['seek']).ok, true);
});

test('Seek Light only ignores terrain marked Light', () => {
  assert.equal(seekMode(gun(['seeklight'])), 'light');
  assert.equal(concealedBehindCover(['cover', 'light'], ['seeklight']).ok, true);
  // Heavy terrain still hides a concealed operative from a Seek Light weapon.
  assert.equal(concealedBehindCover(['cover'], ['seeklight']).ok, false);
});

test('Seek governs selection only — the cover save survives it', () => {
  const check = concealedBehindCover(['cover'], ['seek']);
  assert.equal(check.ok, true);
  assert.equal(check.sight.cover, true);
});

/* --- Hot ---------------------------------------------------------------- */

test('Hot burns the shooter for twice the roll when it comes up under Hit', () => {
  const w = gun(['hot'], { hit: 4 });
  assert.deepEqual(rollHot(scripted(3), w), { rolled: 3, damage: 6 });
  assert.deepEqual(rollHot(scripted(4), w), { rolled: 4, damage: 0 });
  assert.equal(rollHot(scripted(3), gun([])), null);
});

test('a Hot weapon can wound its own operative during a Shoot action', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], weapons: [gun(['hot'], { hit: 6 }), melee()] },
    p2: { at: [{ x: 16, y: 11 }] },
    seed: 'hot-fixture',
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  const result = resolveShoot(s, a.id, b.id, 'w');
  assert.equal(result.ok, true);
  assert.ok(result.hot, 'the shot should have rolled for Hot');
  assert.equal(result.hot.damage, result.hot.rolled < 6 ? result.hot.rolled * 2 : 0);
  assert.equal(a.woundsRemaining, a.wounds - result.hot.damage);
});

/* --- Stun --------------------------------------------------------------- */

test('Stun costs the target 1 APL until the end of its next activation', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], weapons: [gun(['stun', 'lethal3'], { atk: 6 }), melee()] },
    p2: { at: [{ x: 16, y: 11 }], wounds: 40 },
    seed: 'stun-fixture',
  });
  const [a] = opsOf(s, 'p1');
  const [b] = opsOf(s, 'p2');
  const before = effectiveApl(b);

  const result = resolveShoot(s, a.id, b.id, 'w');
  assert.ok(result.attack.crits > 0, 'fixture should retain a critical success');
  assert.equal(isStunned(b), true);
  assert.equal(effectiveApl(b), before - 1);
});

test('a stunned operative shrugs it off at the end of the activation it paid for', () => {
  const s = makeState({ p1: { at: [{ x: 10, y: 11 }] }, p2: { at: [{ x: 16, y: 11 }] } });
  const [b] = opsOf(s, 'p2');
  b.stunned = true;

  // Mirrors what phases.js does around one activation.
  b.stunnedAtActivationStart = b.stunned;
  assert.equal(effectiveApl(b), b.apl - 1);
  if (b.stunnedAtActivationStart) { b.stunned = false; b.stunnedAtActivationStart = false; }
  assert.equal(effectiveApl(b), b.apl);
});

/* --- Blast and Torrent -------------------------------------------------- */

test('Blast x" catches every other operative near the primary, friendly ones too', () => {
  assert.equal(blastRadius(gun(['blast2'])), 2);
  const s = makeState({
    p1: {
      count: 2, at: [{ x: 10, y: 11 }, { x: 16.5, y: 12 }],
      weapons: [gun(['blast2'], { range: 24 }), melee()],
    },
    p2: { count: 2, at: [{ x: 16, y: 11 }, { x: 17, y: 11.5 }], wounds: 40 },
    seed: 'blast-fixture',
  });
  const [shooter, bystander] = opsOf(s, 'p1');
  const [primary, neighbour] = opsOf(s, 'p2');

  const result = resolveShoot(s, shooter.id, primary.id, 'w');
  assert.equal(result.ok, true);
  const caught = result.secondary.map((x) => x.targetId).sort();
  assert.deepEqual(caught, [bystander.id, neighbour.id].sort());
  assert.ok(result.secondary.every((x) => x.splash === 'blast'));
});

test('Torrent x" only picks valid targets, so it never catches a friendly', () => {
  assert.equal(torrentRadius(gun(['torrent2'])), 2);
  const s = makeState({
    // The friendly stands inside the Torrent radius but well clear of the
    // second enemy, so only the "not a valid target" clause can exclude it.
    p1: {
      count: 2, at: [{ x: 10, y: 11 }, { x: 16, y: 13.2 }],
      weapons: [gun(['torrent2'], { range: 24 }), melee()],
    },
    p2: { count: 2, at: [{ x: 16, y: 11 }, { x: 17.6, y: 10.2 }], wounds: 40 },
    seed: 'torrent-fixture',
  });
  const [shooter] = opsOf(s, 'p1');
  const [primary, neighbour] = opsOf(s, 'p2');

  const result = resolveShoot(s, shooter.id, primary.id, 'w');
  assert.deepEqual(result.secondary.map((x) => x.targetId), [neighbour.id]);
  assert.equal(result.secondary[0].splash, 'torrent');
});

test('Torrent skips a target standing within control range of our own operatives', () => {
  const s = makeState({
    p1: {
      count: 2, at: [{ x: 10, y: 11 }, { x: 17.4, y: 11.5 }],
      weapons: [gun(['torrent2'], { range: 24 }), melee()],
    },
    p2: { count: 2, at: [{ x: 16, y: 11 }, { x: 17, y: 11.5 }], wounds: 40 },
    seed: 'torrent-guard',
  });
  const [shooter] = opsOf(s, 'p1');
  const [primary] = opsOf(s, 'p2');

  const result = resolveShoot(s, shooter.id, primary.id, 'w');
  assert.deepEqual(result.secondary, []);
});
