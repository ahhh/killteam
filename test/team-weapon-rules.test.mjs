/**
 * Team-specific weapon rules — the ones printed with an asterisk, whose text
 * lives on a team's own datasheet rather than in the universal appendix.
 *
 * Each rule reaches the engine as a `weaponRules` declaration on the pack (see
 * docs/rule-pack-format.md), so every test here declares the rule the way a
 * real pack does and then pins down the clause it is claiming to implement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, rect, melee, weapon } from './fixtures.mjs';
import { resolveAction, getLegalActions } from '../src/rules/engine.js';
import {
  canShoot, resolveShoot, applyTokenRules, applyKillReward, applyResourceGain,
} from '../src/rules/shooting.js';
import { resolveFight } from '../src/rules/fighting.js';
import { rollDefence, resolveSaves, rollAttack } from '../src/rules/dice.js';
import {
  teamRuleBlocker, meleeModifiers, weaponAdjustments, withAdjustments,
  moveLimitBlocker, noteTeamRuleUse,
} from '../src/rules/team-rules.js';
import {
  grantToken, hasToken, countTokens, tokensOf, resolveActivationTokens,
  markTokenExpiryAtActivationStart, expireTokensAtActivationEnd,
} from '../src/rules/tokens.js';
import { applyDamage, hitModifierFor, effectiveMove, isInjured } from '../src/rules/effects.js';

/** A stand-in for Rng that deals a scripted sequence, so results are exact. */
function scripted(...faces) {
  let i = 0;
  const next = () => {
    if (i >= faces.length) throw new Error('scripted rng ran out of dice');
    return faces[i++];
  };
  return { d6: next, rollDice: (n) => Array.from({ length: n }, next), next: () => (next() - 1) / 6 };
}

const gun = (rules, over = {}) => weapon({ id: 'w', rules, ...over });
const blade = (rules, over = {}) => melee({ id: 'w-melee', rules, ...over });

/* ====================================================================== */
/* Gating rules: may this weapon be used at all?                          */
/* ====================================================================== */

const concealedPosition = {
  concealedposition: {
    rule: 'Concealed Position',
    text: "This operative can only use this weapon the first time it's performing the Shoot action during the battle.",
    effect: { type: 'firstShootActionOnly' },
  },
};

test('Concealed Position allows the first Shoot action of the battle and no other', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['concealedposition']), melee()],
      weaponRules: concealedPosition,
    },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
  });
  const [shooter] = opsOf(s, 'p1');
  const [target] = opsOf(s, 'p2');

  assert.equal(canShoot(s, shooter.id, target.id, gun(['concealedposition'])).ok, true);

  // It is Shoot *actions* that are counted, so the action layer is what spends it.
  assert.equal(resolveAction(s, {
    type: 'shoot', operativeId: shooter.id, targetId: target.id, weaponId: 'w',
  }).ok, true);
  assert.equal(shooter.shootActionsTaken, 1);

  const blocked = canShoot(s, shooter.id, target.id, gun(['concealedposition']));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /Concealed Position/);
});

test('a weapon the engine deliberately refuses says so instead of firing', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['skytorch']), melee()],
      weaponRules: {
        skytorch: {
          rule: 'Skytorch',
          text: 'An operative can only use this weapon during the Skytorch Assault action.',
          effect: { type: 'unusable', reason: 'the Skytorch Assault action is not implemented' },
        },
      },
    },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [shooter] = opsOf(s, 'p1');
  const [target] = opsOf(s, 'p2');

  const check = canShoot(s, shooter.id, target.id, gun(['skytorch']));
  assert.equal(check.ok, false);
  assert.match(check.reason, /Skytorch: the Skytorch Assault action is not implemented/);

  // And it never appears among the legal actions, so nothing plans around it.
  const shoots = getLegalActions(s, shooter.id).filter((a) => a.type === 'shoot');
  assert.deepEqual(shoots, []);
});

test('Aimed leaves a 3" budget for the whole activation, in both directions', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }], move: 6,
      weapons: [gun(['aimed']), melee()],
      weaponRules: {
        aimed: {
          rule: 'Aimed',
          text: 'This operative cannot use this weapon during an activation in which it moved more than 3", and it cannot move more than 3" during an activation in which it used this weapon.',
          effect: { type: 'moveLimit', inches: 3 },
        },
      },
    },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
  });
  const [shooter] = opsOf(s, 'p1');
  const [target] = opsOf(s, 'p2');
  const w = gun(['aimed']);

  // Having walked 4", the weapon is out of the question.
  shooter.distanceMovedThisActivation = 4;
  assert.match(teamRuleBlocker(s, shooter, w), /already moved more than 3"/);

  // Under the budget it fires, and firing then caps the rest of the activation.
  shooter.distanceMovedThisActivation = 2;
  assert.equal(teamRuleBlocker(s, shooter, w), null);
  noteTeamRuleUse(s, shooter, w);
  assert.equal(shooter.moveLimitThisActivation, 3);
  assert.equal(moveLimitBlocker(shooter, 0.9), null);          // 2" + 0.9" fits
  assert.match(moveLimitBlocker(shooter, 2), /may move at most 3"/); // 2" + 2" does not

  // The action layer offers only what the budget can still pay for.
  const reposition = getLegalActions(s, shooter.id).find((a) => a.type === 'reposition');
  assert.ok(reposition.allowance <= 1 + 1e-9, `allowance was ${reposition.allowance}`);
});

/* ====================================================================== */
/* Dice-shape rules                                                       */
/* ====================================================================== */

test('Soulstrike reads defence dice against APL, with 1 critical and 6 always a fail', () => {
  const w = gun(['soulstrike']);
  const defender = { save: 3 };
  // APL 2: a 1 crits, a 2 saves, 3-6 fail — including the 6.
  const d = rollDefence(scripted(1, 2, 6), defender, w, { aplDefence: { apl: 2 } });
  assert.deepEqual([d.crits, d.normals], [1, 1]);
  assert.deepEqual(d.aplDefence, { apl: 2 });

  // The same dice under the normal reading would be a very different result.
  const normal = rollDefence(scripted(1, 2, 6), defender, w, {});
  assert.deepEqual([normal.crits, normal.normals], [1, 0]);
});

test('Soulstrike makes a high-APL target harder to hurt, not easier', () => {
  const w = gun(['soulstrike']);
  const rolls = [3, 3, 3];
  const apl1 = rollDefence(scripted(...rolls), { save: 3 }, w, { aplDefence: { apl: 1 } });
  const apl3 = rollDefence(scripted(...rolls), { save: 3 }, w, { aplDefence: { apl: 3 } });
  assert.equal(apl1.normals + apl1.crits, 0);
  assert.equal(apl3.normals + apl3.crits, 3);
});

test('Toxic adds 1 to both Dmg stats, and only against a target already poisoned', () => {
  const w = gun([], { damage: { normal: 3, critical: 4 } });
  const attack = rollAttack(scripted(6, 5, 1, 1), w);   // 1 crit, 1 normal
  const defence = rollDefence(scripted(1, 1, 1), { save: 3 }, w);

  const plain = resolveSaves(attack, defence, w);
  const toxic = resolveSaves(attack, defence, w, { damageBonus: { normal: 1, critical: 1 } });
  assert.equal(plain.damage, 7);
  assert.equal(toxic.damage, 9);
});

test('Bipod grants Ceaseless only while the operative has stood still', () => {
  const bipod = {
    bipod: {
      rule: 'Bipod',
      text: "…if it hasn't moved during the activation, or if it's a counteraction, this weapon has the Ceaseless weapon rule.",
      effect: {
        type: 'grantRuleIf', rules: ['ceaseless'],
        notMovedThisActivation: true, orCounteraction: true,
      },
    },
  };
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], weapons: [gun(['bipod']), melee()], weaponRules: bipod },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [op] = opsOf(s, 'p1');
  const w = gun(['bipod']);

  assert.deepEqual(weaponAdjustments(s, op, w, { action: 'shoot' }).rules, ['ceaseless']);

  op.distanceMovedThisActivation = 3;
  assert.deepEqual(weaponAdjustments(s, op, w, { action: 'shoot' }).rules, []);

  // "…or if it's a counteraction" — a counteraction has no prior move to undo.
  assert.deepEqual(
    weaponAdjustments(s, op, w, { action: 'shoot', counteraction: true }).rules,
    ['ceaseless']
  );
});

test('Force Impact grants Brutal only after a Charge', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }],
      weapons: [gun([]), blade(['forceimpact'])],
      weaponRules: {
        forceimpact: {
          rule: 'Force Impact',
          text: "…if it's performed the Charge action during the activation, this weapon has the Brutal weapon rule.",
          effect: { type: 'grantRuleIf', rules: ['brutal'], performedThisActivation: ['charge'] },
        },
      },
    },
    p2: { at: [{ x: 11, y: 11 }] },
  });
  const [op] = opsOf(s, 'p1');
  const w = blade(['forceimpact']);

  assert.deepEqual(weaponAdjustments(s, op, w, { action: 'fight' }).rules, []);
  op.usedThisActivation = ['charge'];
  assert.deepEqual(weaponAdjustments(s, op, w, { action: 'fight' }).rules, ['brutal']);
});

test('Anti-PSYKER only bites against an operative with the PSYKER keyword', () => {
  const antipsyker = {
    antipsyker: {
      rule: 'Anti-PSYKER',
      text: '…add 1 to both Dmg stats of this weapon and it has the Lethal 5+ weapon rule.',
      effect: {
        type: 'grantRuleIf', targetKeyword: 'psyker',
        rules: ['lethal5'], damageNormal: 1, damageCritical: 1,
      },
    },
  };
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], weapons: [gun(['antipsyker']), melee()], weaponRules: antipsyker },
    p2: { count: 1, at: [{ x: 16, y: 11 }], keywords: ['psyker'] },
  });
  const [op] = opsOf(s, 'p1');
  const [psyker] = opsOf(s, 'p2');
  const w = gun(['antipsyker']);

  const none = weaponAdjustments(s, op, w, { action: 'shoot', target: op });
  assert.deepEqual([none.rules, none.normal], [[], 0]);

  const vs = weaponAdjustments(s, op, w, { action: 'shoot', target: psyker });
  assert.deepEqual(vs.rules, ['lethal5']);
  const boosted = withAdjustments(w, vs);
  assert.deepEqual(boosted.damage, { normal: 4, critical: 5 });
});

test('Feast adds an attack die and Lethal 5+ against an operative that has lost wounds', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }],
      weapons: [gun([]), blade(['feast'])],
      weaponRules: {
        feast: {
          rule: 'Feast',
          text: '…against a wounded operative, add 1 to the Atk stat of this weapon and it has the Lethal 5+ weapon rule.',
          effect: { type: 'grantRuleIf', targetWounded: true, rules: ['lethal5'], atkBonus: 1 },
        },
      },
    },
    p2: { at: [{ x: 11, y: 11 }], wounds: 12 },
  });
  const [op] = opsOf(s, 'p1');
  const [prey] = opsOf(s, 'p2');
  const w = blade(['feast']);

  assert.deepEqual(weaponAdjustments(s, op, w, { action: 'fight', target: prey }).rules, []);

  // "Wounded" is any wound lost at all — not the same as Injured.
  prey.woundsRemaining = 11;
  assert.equal(isInjured(prey), false);
  const adj = weaponAdjustments(s, op, w, { action: 'fight', target: prey });
  assert.deepEqual(adj.rules, ['lethal5']);
  assert.equal(withAdjustments(w, adj).atk, w.atk + 1);
});

test('Stalk needs terrain within control range before it grants Lethal 5+', () => {
  const stalk = {
    stalk: {
      rule: 'Stalk',
      text: '…if Light or Heavy terrain is within its control range, this weapon has the Lethal 5+ weapon rule.',
      effect: {
        type: 'grantRuleIf', action: 'fight',
        terrainWithinControlRange: true, rules: ['lethal5'],
      },
    },
  };
  const terrain = [{
    id: 'wall', shape: { type: 'polygon', points: rect(12, 10, 3, 3) },
    height: 2, traits: ['cover', 'obscuring'],
  }];
  const s = makeState({
    terrain,
    p1: {
      count: 2, at: [{ x: 4, y: 4 }, { x: 11.2, y: 11 }],
      weapons: [gun([]), blade(['stalk'])], weaponRules: stalk,
    },
    p2: { at: [{ x: 20, y: 20 }] },
  });
  const [inTheOpen, byTheWall] = opsOf(s, 'p1');
  const w = blade(['stalk']);

  assert.deepEqual(weaponAdjustments(s, inTheOpen, w, { action: 'fight' }).rules, []);
  assert.deepEqual(weaponAdjustments(s, byTheWall, w, { action: 'fight' }).rules, ['lethal5']);
});

/* ====================================================================== */
/* Tokens                                                                 */
/* ====================================================================== */

const poisonRule = (damage) => ({
  poison: {
    rule: 'Poison',
    text: '…the operative this weapon is being used against gains one of your Poison tokens.',
    effect: {
      type: 'inflictToken', trigger: 'anySuccess',
      token: { kind: 'poison', label: 'Poison', onActivation: { damage } },
    },
  },
});

test('Poison hangs a token that burns its holder at the start of each activation', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], weapons: [gun(['poison']), melee()], weaponRules: poisonRule('1') },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
  });
  const [shooter] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');

  // Trigger the rule directly with a known outcome, so no dice are involved.
  applyTokenRules(s, shooter, victim, gun(['poison']), {
    outcome: { damage: 4, unsavedCrits: 0, devastatingDamage: 0 },
    result: { incapacitated: false },
  });
  assert.equal(hasToken(victim, 'poison', 'p1'), true);

  // "if it doesn't already have one" — a second hit adds nothing.
  applyTokenRules(s, shooter, victim, gun(['poison']), {
    outcome: { damage: 4, unsavedCrits: 0, devastatingDamage: 0 },
    result: { incapacitated: false },
  });
  assert.equal(countTokens(victim, 'poison'), 1);

  const before = victim.woundsRemaining;
  resolveActivationTokens(s, scripted(), victim, applyDamage);
  assert.equal(victim.woundsRemaining, before - 1);
});

test('a token that inflicts no damage is never hung when nothing got through', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], weapons: [gun(['poison']), melee()], weaponRules: poisonRule('1') },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
  });
  const [shooter] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');

  applyTokenRules(s, shooter, victim, gun(['poison']), {
    outcome: { damage: 0, unsavedCrits: 0, devastatingDamage: 0 },
    result: { incapacitated: false },
  });
  assert.equal(hasToken(victim, 'poison'), false);
});

test('a criticalSuccess trigger ignores damage that came from normal hits alone', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }], weapons: [gun(['terrorchem']), melee()],
      weaponRules: {
        terrorchem: {
          rule: 'Terrorchem',
          text: '…if you inflict damage with any critical successes (including as a result of the Devastating weapon rule)…',
          effect: {
            type: 'inflictToken', trigger: 'criticalSuccess',
            token: { kind: 'terrorchem', label: 'Terrorchem', onActivation: { damage: 'D3' } },
          },
        },
      },
    },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
  });
  const [shooter] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');
  const w = gun(['terrorchem']);

  applyTokenRules(s, shooter, victim, w, {
    outcome: { damage: 6, unsavedCrits: 0, devastatingDamage: 0 },
    result: { incapacitated: false },
  });
  assert.equal(hasToken(victim, 'terrorchem'), false);

  // Devastating damage counts as inflicted by a critical, exactly as printed —
  // which is the only way the Terrorchem vial's 2/0 profile ever triggers.
  applyTokenRules(s, shooter, victim, w, {
    outcome: { damage: 3, unsavedCrits: 0, devastatingDamage: 3 },
    result: { incapacitated: false },
  });
  assert.equal(hasToken(victim, 'terrorchem'), true);
});

test('Neutron Fragment stacks, and each token rolls its own damage', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }] },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
  });
  const [victim] = opsOf(s, 'p2');
  const spec = {
    kind: 'neutron-fragment', label: 'Neutron Fragment', stacks: true,
    onActivation: { damage: 'D3' },
  };
  grantToken(s, victim, spec, { owner: 'p1', rule: 'neutronfragment' });
  grantToken(s, victim, spec, { owner: 'p1', rule: 'neutronfragment' });
  assert.equal(countTokens(victim, 'neutron-fragment'), 2);

  const before = victim.woundsRemaining;
  // Two separate D3 rolls: a 3 and a 1 on a D3 drawn from d6 halves.
  resolveActivationTokens(s, scripted(6, 2), victim, applyDamage);
  assert.equal(before - victim.woundsRemaining, 4);
});

test('Blaze burns the holder and then rolls a D6 to shake the token off', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }] },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
  });
  const [victim] = opsOf(s, 'p2');
  const spec = {
    kind: 'blaze', label: 'Blaze',
    onActivation: { damage: 'D3', removal: { d6: 3 } },
  };

  grantToken(s, victim, spec, { owner: 'p1', rule: 'blaze' });
  // D3 of 2 (a 4 on the d6 halves), then a 2 on the removal roll: it holds.
  resolveActivationTokens(s, scripted(4, 2), victim, applyDamage);
  assert.equal(hasToken(victim, 'blaze'), true);

  // A 3 sheds it.
  resolveActivationTokens(s, scripted(2, 3), victim, applyDamage);
  assert.equal(hasToken(victim, 'blaze'), false);
});

test('Mindburn and Humbling Cruelty worsen Hit but never stack with Injured', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }] },
    p2: { at: [{ x: 16, y: 11 }], wounds: 10, move: 6 },
  });
  const [victim] = opsOf(s, 'p2');
  assert.equal(hitModifierFor(victim), 0);

  grantToken(s, victim, {
    kind: 'humbling-cruelty', label: 'Humbling Cruelty',
    whileHeld: { moveDelta: -2, hitPenalty: 1, notCumulativeWithInjured: true },
    expiry: { endOfNextActivation: true },
  }, { owner: 'p1', rule: 'humblingcruelty' });

  assert.equal(hitModifierFor(victim), 1);
  assert.equal(effectiveMove(victim), 4);

  // "This isn't cumulative with being injured": halved wounds must not add a second pip.
  victim.woundsRemaining = 5;
  assert.equal(isInjured(victim), true);
  assert.equal(hitModifierFor(victim), 1);
});

test('a token that expires at the end of the next activation survives the one it landed in', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }] },
    p2: { at: [{ x: 16, y: 11 }], wounds: 20 },
  });
  const [victim] = opsOf(s, 'p2');
  grantToken(s, victim, {
    kind: 'mindburn', label: 'Mindburn',
    whileHeld: { hitPenalty: 1, notCumulativeWithInjured: true },
    expiry: { endOfNextActivation: true },
  }, { owner: 'p1', rule: 'mindburn' });

  // The activation it was gained during does not spend it…
  expireTokensAtActivationEnd(s, victim);
  assert.equal(hasToken(victim, 'mindburn'), true);

  // …but the next one, which starts holding it, does.
  markTokenExpiryAtActivationStart(victim);
  expireTokensAtActivationEnd(s, victim);
  assert.equal(hasToken(victim, 'mindburn'), false);
});

test('a unique token moves rather than multiplies when the weapon fires again', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }] },
    p2: { count: 2, at: [{ x: 16, y: 11 }, { x: 18, y: 11 }], wounds: 20 },
  });
  const [first, second] = opsOf(s, 'p2');
  const spec = { kind: 'mindburn', label: 'Mindburn', unique: true };

  grantToken(s, first, spec, { owner: 'p1', rule: 'mindburn' });
  assert.equal(hasToken(first, 'mindburn'), true);

  grantToken(s, second, spec, { owner: 'p1', rule: 'mindburn' });
  assert.equal(hasToken(second, 'mindburn'), true);
  assert.equal(hasToken(first, 'mindburn'), false, 'the earlier token comes off');
});

test('an incapacitated operative takes its tokens with it', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }] },
    p2: { at: [{ x: 16, y: 11 }], wounds: 4 },
  });
  const [victim] = opsOf(s, 'p2');
  grantToken(s, victim, { kind: 'poison', label: 'Poison', onActivation: { damage: '1' } },
    { owner: 'p1', rule: 'poison' });

  applyDamage(s, victim.id, 99, { kind: 'test' });
  assert.equal(victim.alive, false);
  assert.deepEqual(tokensOf(victim), []);
});

/* ====================================================================== */
/* Target selection                                                       */
/* ====================================================================== */

test('Salvo resolves the weapon against two different primary targets', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['salvo'], { range: 24 }), melee()],
      weaponRules: {
        salvo: {
          rule: 'Salvo',
          text: "Select up to two different valid targets that aren't within control range of friendly operatives.",
          effect: { type: 'extraPrimaryTargets', count: 2 },
        },
      },
    },
    p2: { count: 3, at: [{ x: 14, y: 11 }, { x: 16, y: 11 }, { x: 20, y: 11 }], wounds: 60 },
    seed: 'salvo',
  });
  const [shooter] = opsOf(s, 'p1');
  const [near, mid] = opsOf(s, 'p2');

  const result = resolveShoot(s, shooter.id, mid.id, 'w');
  assert.equal(result.ok, true);
  assert.equal(result.primaries.length, 2, 'two primary sequences');
  // The chosen target plus the nearest other legal one — never the same twice.
  assert.deepEqual(result.primaries.map((p) => p.targetId).sort(), [mid.id, near.id].sort());
});

test('Explosive makes the operative its own primary target, even in melee', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }],
      weapons: [gun(['explosive', 'blast2'], { range: 6 }), melee()],
      weaponRules: {
        explosive: {
          rule: 'Explosive',
          text: 'This operative can perform the Shoot action with this weapon while within control range of an enemy operative. Don\'t select a valid target. Instead, this operative is always the primary target.',
          effect: { type: 'selfPrimaryTarget', shootSelf: true, allowWhileEngaged: true },
        },
      },
    },
    // Standing base to base, which normally forbids shooting outright.
    p2: { at: [{ x: 11.1, y: 11 }], wounds: 60 },
    seed: 'explosive',
  });
  const [bomber] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');

  const shoot = getLegalActions(s, bomber.id).find((a) => a.type === 'shoot');
  assert.ok(shoot, 'the Shoot action is offered while engaged');
  assert.equal(shoot.selfDirected, true);
  assert.deepEqual(shoot.targets.map((t) => t.targetId), [bomber.id]);

  const result = resolveShoot(s, bomber.id, bomber.id, 'w');
  assert.equal(result.ok, true);
  assert.equal(result.primaries[0].targetId, bomber.id, 'the bomb goes off in its own hands');
  assert.ok(result.secondary.some((sq) => sq.targetId === victim.id), 'and catches the enemy beside it');
});

test('Wreathed centres the blast on the operative but leaves it unharmed', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }],
      weapons: [gun(['wreathed', 'blast2'], { range: 6 }), melee()],
      weaponRules: {
        wreathed: {
          rule: 'Wreathed',
          text: "…this operative is always the primary target, but only shoot against secondary targets… (in other words, determine Blast from this operative, but this operative isn't affected).",
          effect: { type: 'selfPrimaryTarget', shootSelf: false, allowWhileEngaged: true },
        },
      },
    },
    p2: { at: [{ x: 11.1, y: 11 }], wounds: 60 },
    seed: 'wreathed',
  });
  const [zealot] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');
  const before = zealot.woundsRemaining;

  const result = resolveShoot(s, zealot.id, zealot.id, 'w');
  assert.equal(result.ok, true);
  assert.equal(result.primaries.length, 0, 'no sequence is resolved against the wielder');
  assert.deepEqual(result.secondary.map((sq) => sq.targetId), [victim.id]);
  assert.equal(zealot.woundsRemaining, before);
});

test('Detonate fires through a friendly bearer, and is refused without one', () => {
  const detonate = {
    detonate: {
      rule: 'Detonate',
      text: 'Don\'t select a valid target. Instead, a friendly GHEISTSKULL operative is always the primary target.',
      effect: { type: 'friendlyPrimaryTarget', keyword: 'gheistskull' },
    },
  };
  const s = makeState({
    p1: {
      count: 2, at: [{ x: 16, y: 11 }, { x: 6, y: 11 }],
      weapons: [gun(['detonate', 'blast2'], { range: 24 }), melee()],
      keywords: ['gheistskull'], weaponRules: detonate,
    },
    // Standing beside the bearer, well out of reach of the operative that
    // actually pulls the trigger.
    p2: { at: [{ x: 17.3, y: 11 }], wounds: 60 },
    seed: 'detonate',
  });
  const [bearer, trigger] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');

  const result = resolveShoot(s, trigger.id, trigger.id, 'w');
  assert.equal(result.ok, true);
  // The bearer is the primary, not the operative that fired.
  assert.equal(result.primaries[0].targetId, bearer.id);
  assert.ok(
    result.secondary.some((sq) => sq.targetId === victim.id),
    'the blast reaches the enemy beside the bearer'
  );

  // With no bearer left in the killzone the weapon cannot be selected at all.
  const bare = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['detonate'], { range: 24 }), melee()],
      keywords: [], weaponRules: detonate,
    },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [lonely] = opsOf(bare, 'p1');
  const check = canShoot(bare, lonely.id, lonely.id, gun(['detonate'], { range: 24 }));
  assert.equal(check.ok, false);
  assert.match(check.reason, /needs a friendly gheistskull/);
});

/* ====================================================================== */
/* Melee shape                                                            */
/* ====================================================================== */

test('Shield, Tangle and Repress all block two successes with one block', () => {
  for (const [name, extra] of [['shield', {}], ['tangle', {}], ['repress', { defenderResolvesFirst: true }]]) {
    const s = makeState({
      p1: {
        at: [{ x: 10, y: 11 }],
        weapons: [gun([]), blade([name])],
        weaponRules: {
          [name]: {
            rule: name,
            text: 'each of your blocks can be allocated to block two unresolved successes (instead of one).',
            effect: { type: 'meleeModifier', blockMultiplier: 2, ...extra },
          },
        },
      },
      p2: { at: [{ x: 11, y: 11 }] },
    });
    const [op] = opsOf(s, 'p1');
    const mods = meleeModifiers(s, op, blade([name]));
    assert.equal(mods.blockMultiplier, 2, name);
    assert.equal(mods.defenderResolvesFirst, Boolean(extra.defenderResolvesFirst), name);
  }
});

test('Repress lets the retaliating operative resolve the first attack dice', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], weapons: [gun([]), blade([])], wounds: 40 },
    p2: {
      at: [{ x: 11, y: 11 }], wounds: 40,
      weapons: [gun([]), blade(['repress'])],
      weaponRules: {
        repress: {
          rule: 'Repress',
          text: 'If this operative is retaliating, you resolve the first attack dice (i.e. defender instead of attacker).',
          effect: { type: 'meleeModifier', blockMultiplier: 2, defenderResolvesFirst: true },
        },
      },
    },
    seed: 'repress',
  });
  const [attacker] = opsOf(s, 'p1');
  const [defender] = opsOf(s, 'p2');

  const result = resolveFight(s, attacker.id, defender.id, 'w-melee');
  assert.equal(result.ok, true);
  assert.equal(result.sequence[0].actor, defender.id,
    'the defender, not the attacker, resolves first');
});

test('Smash shoves the enemy back an inch and follows it in', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }], wounds: 40,
      weapons: [gun([]), blade(['smash'], { damage: { normal: 1, critical: 1 } })],
      weaponRules: {
        smash: {
          rule: 'Smash',
          text: 'Whenever you strike, you can move the enemy operative in a straight line increment of up to 1"…',
          effect: { type: 'meleeModifier', push: { distance: 1 } },
        },
      },
    },
    p2: { at: [{ x: 11.5, y: 11 }], wounds: 40, weapons: [gun([]), blade([])] },
    seed: 'smash',
  });
  const [smasher] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');
  const startX = { smasher: smasher.x, victim: victim.x };

  const result = resolveFight(s, smasher.id, victim.id, 'w-melee');
  assert.equal(result.ok, true);
  assert.ok(result.sequence.some((step) => step.action === 'push'), 'a push was resolved');
  assert.ok(victim.x > startX.victim, 'the enemy is shoved further away');
  assert.ok(smasher.x > startX.smasher, 'and the smasher follows it in');
});

test('Phase Sweep keeps fighting until every enemy in reach has been fought once', () => {
  const s = makeState({
    p1: {
      at: [{ x: 11, y: 11 }], wounds: 60,
      weapons: [gun([]), blade(['phasesweep'])],
      weaponRules: {
        phasesweep: {
          rule: 'Phase Sweep',
          text: '…it can immediately perform a free Fight action afterwards… until it has fought against every enemy operative within its control range.',
          effect: { type: 'meleeModifier', repeatFight: true },
        },
      },
    },
    p2: { count: 3, at: [{ x: 12, y: 11 }, { x: 11, y: 12 }, { x: 22, y: 20 }], wounds: 60 },
    seed: 'sweep',
  });
  const [sweeper] = opsOf(s, 'p1');
  const [a, b, faraway] = opsOf(s, 'p2');

  const result = resolveAction(s, {
    type: 'fight', operativeId: sweeper.id, targetId: a.id, weaponId: 'w-melee',
  });
  assert.equal(result.ok, true);
  assert.equal(result.sweep?.length, 1, 'one extra free Fight, against the second enemy');
  assert.equal(result.sweep[0].ok, true);
  // Only enemies within control range are swept; the one across the board is not.
  const fought = [a.id, ...result.sweep.map(() => b.id)];
  assert.ok(fought.includes(b.id));
  assert.equal(faraway.woundsRemaining, faraway.wounds);
});

test('an operative with no weapons at all cannot fight and never fights back', () => {
  const s = makeState({
    p1: { at: [{ x: 10, y: 11 }], wounds: 40, weapons: [gun([]), blade([])] },
    // A Vox-Relay Beacon shape: on the board, but carrying nothing.
    p2: { at: [{ x: 11, y: 11 }], wounds: 40, weapons: [] },
    seed: 'noncombatant',
  });
  const [soldier] = opsOf(s, 'p1');
  const [beacon] = opsOf(s, 'p2');
  const before = soldier.woundsRemaining;

  // It cannot start a fight…
  const itsTurn = resolveFight(s, beacon.id, soldier.id);
  assert.equal(itsTurn.ok, false);
  assert.match(itsTurn.reason, /no melee weapon/);
  assert.deepEqual(getLegalActions(s, beacon.id).filter((a) => a.type === 'fight'), []);
  assert.deepEqual(getLegalActions(s, beacon.id).filter((a) => a.type === 'shoot'), []);

  // …and it rolls nothing when fought, rather than being handed phantom fists.
  const result = resolveFight(s, soldier.id, beacon.id, 'w-melee');
  assert.equal(result.ok, true);
  assert.equal(result.targetWeapon, 'no weapon');
  assert.equal(result.damageToAttacker, 0);
  assert.equal(soldier.woundsRemaining, before);
});

test('Riposte turns a critical block into damage of its own', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }], wounds: 40,
      weapons: [gun([]), blade(['riposte'])],
      weaponRules: {
        riposte: {
          rule: 'Riposte',
          text: "Whenever you block with a critical success, you can also inflict damage equal to the weapon's Critical Dmg stat on the enemy operative in that sequence.",
          effect: { type: 'meleeModifier', riposte: true },
        },
      },
    },
    p2: { at: [{ x: 11, y: 11 }], wounds: 40, weapons: [gun([]), blade([])] },
  });
  const [duellist] = opsOf(s, 'p1');
  const mods = meleeModifiers(s, duellist, blade(['riposte']));
  assert.equal(mods.riposte.rule, 'Riposte');
});

test('Tactual Hunter only unlocks its extra strike against an expended operative', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }], wounds: 40,
      weapons: [gun([]), blade(['tactualhunter'])],
      weaponRules: {
        tactualhunter: {
          rule: 'Tactual Hunter',
          text: '…against an expended operative, the first time you strike with a critical success during that sequence, you can immediately resolve another of your successes as a strike (before your opponent).',
          effect: { type: 'meleeModifier', doubleStrikeVsExpended: true },
        },
      },
    },
    p2: { at: [{ x: 11, y: 11 }], wounds: 40, weapons: [gun([]), blade([])] },
  });
  const [hunter] = opsOf(s, 'p1');
  const [prey] = opsOf(s, 'p2');
  assert.equal(meleeModifiers(s, hunter, blade(['tactualhunter'])).doubleStrikeVsExpended.rule,
    'Tactual Hunter');
  // "Expended" is the engine's already-activated flag, nothing more exotic.
  assert.equal(prey.activatedThisTurningPoint, false);
});

test('Crush adds the margin of a roll-off, capped, and nothing when it loses', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }], wounds: 40,
      weapons: [gun([]), blade(['crush'], { damage: { normal: 2, critical: 2 } })],
      weaponRules: {
        crush: {
          rule: 'Crush',
          text: 'Whenever you strike, you and your opponent roll-off, adding 1 to your result if the operative this weapon is being used against has a Wounds stat of 9 or less…',
          effect: { type: 'meleeModifier', crush: { bonusIfWoundsAtMost: 9, maxExtra: 3 } },
        },
      },
    },
    p2: { at: [{ x: 11, y: 11 }], wounds: 40, weapons: [gun([]), blade([])] },
  });
  const [crusher] = opsOf(s, 'p1');
  const mods = meleeModifiers(s, crusher, blade(['crush']));
  assert.deepEqual(
    [mods.crush.bonusIfWoundsAtMost, mods.crush.maxExtra],
    [9, 3]
  );
});

test('Dimensional Banishment finishes off a survivor when the roll beats its wounds', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['dimensionalbanishment'], { range: 24, damage: { normal: 1, critical: 1 } }), melee()],
      weaponRules: {
        dimensionalbanishment: {
          rule: 'Dimensional Banishment',
          text: "…roll 2D6: if the result is higher than the target's remaining wounds, the target is incapacitated.",
          effect: { type: 'executeRoll', dice: '2D6' },
        },
      },
    },
    // Two wounds left is well within reach of 2D6.
    p2: { at: [{ x: 16, y: 11 }], wounds: 2 },
    seed: 'banish',
  });
  const [isolator] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');
  victim.woundsRemaining = 2;

  const result = resolveShoot(s, isolator.id, victim.id, 'w');
  assert.equal(result.ok, true);
  // Either the shot killed it outright or the banishment roll did; what must
  // never happen is a survivor that was never rolled for.
  const rolled = s.eventLog.filter((e) => e.rule === 'Dimensional Banishment');
  assert.equal(rolled.length, 1, 'a target that survived the damage is rolled for');
  assert.match(rolled[0].detail, /banished|holds together/);
});

test('a fixed loadout upgrade applies for the whole battle, unconditionally', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['custom']), melee()],
      weaponRules: {
        custom: {
          rule: 'Custom',
          text: 'At the end of the Select Operatives step… select up to two of the following weapon rules for this weapon to have for the battle.',
          partial: true,
          notes: 'the pack fixes the two rules; a player cannot pick them',
          effect: { type: 'fixedUpgrade', rules: ['lethal5', 'balanced'] },
        },
      },
    },
    p2: { at: [{ x: 16, y: 11 }] },
  });
  const [op] = opsOf(s, 'p1');
  const adj = weaponAdjustments(s, op, gun(['custom']), { action: 'shoot' });
  assert.deepEqual(adj.rules, ['lethal5', 'balanced']);
  // It is only half the printed rule, so the battle log has to say so.
  assert.ok(s.warnings.some((w) => w.ruleId === 'weapon-rule-partial:custom'));
});

test('Headtaker pays a kill in wounds back and a permanently sharper edge', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }], wounds: 20,
      weapons: [gun([]), blade(['headtaker'], { damage: { normal: 4, critical: 5 } })],
      weaponRules: {
        headtaker: {
          rule: 'Headtaker',
          text: '…roll one D3: this operative regains that many lost wounds, and adds the result to the Critical Dmg stat of its skullcleaver (to a maximum of 8).',
          effect: { type: 'onIncapacitate', dice: 'D3', heal: true, weaponCriticalBonus: { max: 8 } },
        },
      },
    },
    p2: { at: [{ x: 11, y: 11 }] },
  });
  const [butcher] = opsOf(s, 'p1');
  butcher.woundsRemaining = 15;

  // A D3 of 2 comes off a d6 half of 4.
  applyKillReward(s, scripted(4), butcher, blade(['headtaker'], { damage: { normal: 4, critical: 5 } }));
  assert.equal(butcher.woundsRemaining, 17);
  assert.equal(butcher.weaponMods['w-melee'].critical, 2);

  // The cap is on the total, not the bonus: 5 + 3 is capped at 8, not 5 + 2 + 3.
  applyKillReward(s, scripted(6), butcher, blade(['headtaker'], { damage: { normal: 4, critical: 5 } }));
  assert.equal(butcher.weaponMods['w-melee'].critical, 3, 'Critical Dmg tops out at 8');
});

test('Siphon Life feeds the most wounded friend in range, once per turning point', () => {
  const s = makeState({
    p1: {
      count: 3, at: [{ x: 6, y: 11 }, { x: 8, y: 11 }, { x: 24, y: 20 }],
      wounds: 20,
      weapons: [gun(['siphonlife', 'piercing3'], { range: 24 }), melee()],
      keywords: ['legionary'],
      weaponRules: {
        siphonlife: {
          rule: 'Siphon Life',
          text: '…select one friendly LEGIONARY operative visible to and within 6" of this operative. For each attack dice you resolve during that step that inflicts damage, that friendly operative regains 1 lost wound, or D3 lost wounds if it was a critical success.',
          partial: true,
          notes: 'the engine always uses the rule and picks the most wounded friend in range',
          effect: {
            type: 'healOnDamage', keyword: 'legionary', within: 6,
            perNormal: '1', perCritical: 'D3', oncePerTurningPoint: true,
          },
        },
      },
    },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
    seed: 'siphon',
  });
  const [acolyte, nearby, faraway] = opsOf(s, 'p1');
  nearby.woundsRemaining = 10;
  faraway.woundsRemaining = 1;   // more hurt, but far out of the 6"

  const [victim] = opsOf(s, 'p2');
  const before = { nearby: nearby.woundsRemaining, faraway: faraway.woundsRemaining };
  resolveShoot(s, acolyte.id, victim.id, 'w');

  assert.equal(faraway.woundsRemaining, before.faraway,
    'the friend outside 6" is never chosen, however badly hurt');
  assert.ok(nearby.woundsRemaining >= before.nearby);
  // Piercing 3 leaves the target no defence dice, so damage is certain and
  // the rule has to have fired.
  assert.ok(victim.woundsRemaining < victim.wounds);
  assert.ok(nearby.woundsRemaining > before.nearby, 'the wounds it spilled came back');
  assert.equal(acolyte.ruleUsedInTurningPoint?.siphonlife, s.turningPoint);
});

test('Stinger bursts an operative it kills, and the burst can chain', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['stinger'], { range: 24, damage: { normal: 20, critical: 20 } }), melee()],
      weaponRules: {
        stinger: {
          rule: 'Stinger',
          text: 'Whenever an enemy operative is incapacitated by this weapon, before it\'s removed from the killzone, inflict D3 damage on each other operative visible to and within 2" of it.',
          effect: { type: 'chainOnIncapacitate', damage: 'D3', range: 2 },
        },
      },
    },
    p2: { count: 2, at: [{ x: 16, y: 11 }, { x: 17.2, y: 11 }], wounds: 4 },
    seed: 'stinger',
  });
  const [shooter] = opsOf(s, 'p1');
  const [primary, neighbour] = opsOf(s, 'p2');

  const result = resolveShoot(s, shooter.id, primary.id, 'w');
  assert.equal(result.ok, true);
  assert.equal(result.incapacitated, true, '20 damage against 4 wounds is a kill');
  assert.ok(neighbour.woundsRemaining < neighbour.wounds,
    'the operative standing beside the kill is caught by the burst');
  assert.deepEqual(result.primaries[0].chain.map((b) => b.operativeId), [neighbour.id]);
});

test('Beam burns the operatives standing behind the target, but not the target', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['beam', 'lethal2'], { range: 30, damage: { normal: 1, critical: 1 } }), melee()],
      weaponRules: {
        beam: {
          rule: 'Beam',
          text: "…each retained critical success immediately inflicts D3 damage on each other operative along one (and only one) beam line, but the target isn't affected.",
          partial: true,
          notes: 'the engine picks the beam line that catches the most enemies',
          effect: { type: 'beamLine', damage: 'D3' },
        },
      },
    },
    // Three enemies in a straight line away from the shooter.
    p2: { count: 3, at: [{ x: 14, y: 11 }, { x: 18, y: 11 }, { x: 22, y: 11 }], wounds: 60 },
    seed: 'beam',
  });
  const [shooter] = opsOf(s, 'p1');
  const [target, behind, further] = opsOf(s, 'p2');

  const result = resolveShoot(s, shooter.id, target.id, 'w');
  assert.equal(result.ok, true);
  const beam = result.primaries[0].beam;
  assert.ok(beam?.length, 'the beam caught somebody');
  const burned = beam.map((b) => b.operativeId).sort();
  assert.deepEqual(burned, [behind.id, further.id].sort(),
    'everyone on the line behind the target, and only them');
});

test('Magnify borrows a spotter\'s view to pick a target that is otherwise in cover', () => {
  const terrain = [{
    id: 'block', shape: { type: 'polygon', points: rect(11, 9, 1.5, 4) },
    height: 2, traits: ['cover'],
  }];
  const s = makeState({
    terrain,
    p1: {
      count: 2, at: [{ x: 6, y: 11 }, { x: 16, y: 16 }],
      weapons: [gun(['magnify'], { range: 30 }), melee()],
      keywords: ['cryptek'],
      weaponRules: {
        magnify: {
          rule: 'Magnify',
          text: '…treat that operative as the active operative for the purposes of determining a valid target, cover and obscured. If you do, this weapon has the Ceaseless weapon rule until the end of that action.',
          partial: true,
          notes: 'the engine uses the spotter only when it improves the shot',
          effect: { type: 'spotterTargeting', keywords: ['cryptek'], grantRules: ['ceaseless'] },
        },
      },
    },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
    seed: 'magnify',
  });
  const [shooter, spotter] = opsOf(s, 'p1');
  const [target] = opsOf(s, 'p2');
  spotter.order = 'engage';

  const check = canShoot(s, shooter.id, target.id, gun(['magnify'], { range: 30 }));
  assert.equal(check.ok, true);
  assert.equal(check.spotter.operative.id, spotter.id);
  assert.equal(check.sight.cover, false, 'the spotter sees it out of cover');

  // Without a spotter on Engage the shot is back to being taken through cover.
  spotter.order = 'conceal';
  const alone = canShoot(s, shooter.id, target.id, gun(['magnify'], { range: 30 }));
  assert.equal(alone.spotter, undefined);
  assert.equal(alone.sight.cover, true);
});

test('Drag hauls the target towards the shooter, two inches per unblocked success', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['drag', 'piercing3'], { range: 24, damage: { normal: 1, critical: 1 } }), melee()],
      weaponRules: {
        drag: {
          rule: 'Drag',
          text: '…you can move the target up to x". X is your total number of successful unblocked attack dice, multiplied by 2.',
          partial: true,
          notes: 'the engine always drags the full distance and never discards attack dice',
          effect: { type: 'dragTarget', perSuccess: 2 },
        },
      },
    },
    p2: { at: [{ x: 18, y: 11 }], wounds: 60, save: 6 },
    seed: 'drag',
  });
  const [impaler] = opsOf(s, 'p1');
  const [victim] = opsOf(s, 'p2');
  const startX = victim.x;

  const result = resolveShoot(s, impaler.id, victim.id, 'w');
  assert.equal(result.ok, true);
  const successes = result.attack.normals + result.attack.crits;
  assert.ok(successes > 0 && result.damage > 0, 'Piercing 3 guarantees something gets through');
  assert.ok(victim.x < startX, 'the target is hauled towards the shooter');
  assert.ok(startX - victim.x <= successes * 2 + 1e-9, 'and never further than the rule allows');
});

test('a resource-feeding weapon pays into the economy its pack declares', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['bloodoffering'], { range: 24 }), melee()],
      weaponRules: {
        bloodoffering: {
          rule: 'Blood Offering',
          text: '…the first time you strike with a critical success during that sequence, you gain one Blooded token.',
          effect: {
            type: 'gainResource', resource: 'blooded', scope: 'player',
            trigger: 'criticalSuccess',
          },
        },
      },
      resources: {
        blooded: { name: 'Blooded token', rule: 'Blooded', scope: 'player', gains: [], spends: [] },
      },
    },
    p2: { at: [{ x: 16, y: 11 }], wounds: 60 },
    seed: 'blood',
  });
  const [op] = opsOf(s, 'p1');

  applyResourceGain(s, op, gun(['bloodoffering']), { damage: 5, unsavedCrits: 0 });
  assert.equal(s.players.p1.resources.blooded, undefined, 'a normal hit earns nothing');

  applyResourceGain(s, op, gun(['bloodoffering']), { damage: 5, unsavedCrits: 1 });
  assert.equal(s.players.p1.resources.blooded, 1, 'a critical strike pays into the pool');
});

test('a weapon feeding a resource its pack never declared is reported, not guessed', () => {
  const s = makeState({
    p1: {
      at: [{ x: 6, y: 11 }],
      weapons: [gun(['bloodoffering'], { range: 24 }), melee()],
      weaponRules: {
        bloodoffering: {
          rule: 'Blood Offering',
          text: '…you gain one Blooded token.',
          effect: {
            type: 'gainResource', resource: 'blooded', scope: 'player',
            trigger: 'criticalSuccess',
          },
        },
      },
    },
    p2: { at: [{ x: 16, y: 11 }] },
    seed: 'blood',
  });
  const [op] = opsOf(s, 'p1');

  applyResourceGain(s, op, gun(['bloodoffering']), { damage: 5, unsavedCrits: 1 });
  assert.equal(s.players.p1.resources.blooded, undefined, 'nothing is invented');
  assert.ok(s.warnings.some((w) => w.ruleId === 'resource:blooded'),
    'and the missing declaration is reported');
});

/* ====================================================================== */
/* First Blood: hurting the thing that hurt you                           */
/* ====================================================================== */

const firstBlood = {
  firstblood: {
    rule: 'First Blood',
    text: 'Each time after this operative fights in combat, if it lost any wounds in that combat but was not incapacitated, you can roll one D6: on a 4+, the enemy operative that fought it suffers 2 mortal wounds.',
    effect: { type: 'retaliationRoll', dice: 'D6', threshold: 4, damage: 2 },
  },
};

function marboState(seed) {
  return makeState({
    p1: {
      at: [{ x: 10, y: 11 }], wounds: 20,
      weapons: [blade(['firstblood'], { atk: 4, hit: 3 })],
      weaponRules: firstBlood,
    },
    p2: { at: [{ x: 10.9, y: 11 }], wounds: 20, weapons: [melee({ atk: 4, hit: 3 })] },
    seed,
  });
}

test('First Blood cuts back at the operative that drew blood', () => {
  // Seeds are scanned rather than guessed: the rule only fires in a fight that
  // actually cost the wielder wounds, which the dice have to produce.
  let fired = null;
  for (let i = 0; i < 40 && !fired; i++) {
    const s = marboState(`fb-${i}`);
    const [marbo] = opsOf(s, 'p1');
    const [foe] = opsOf(s, 'p2');
    resolveFight(s, marbo.id, foe.id, 'w-melee');
    const event = s.eventLog.find((e) => e.rule === 'First Blood');
    if (event && marbo.woundsRemaining < marbo.wounds && marbo.alive) fired = { s, event, foe };
  }
  assert.ok(fired, 'a fight that hurt the wielder rolls for it');
  assert.match(fired.event.detail, /cuts back for 2 damage|fails to cut back/);
});

test('First Blood stays quiet when the fight cost the wielder nothing', () => {
  const s = makeState({
    p1: {
      at: [{ x: 10, y: 11 }], wounds: 20,
      weapons: [blade(['firstblood'], { atk: 6, hit: 2 })],
      weaponRules: firstBlood,
    },
    // A weaponless operative rolls no dice at all, so it can never hurt back.
    p2: { at: [{ x: 10.9, y: 11 }], weapons: [] },
    seed: 'fb-quiet',
  });
  const [marbo] = opsOf(s, 'p1');
  const [foe] = opsOf(s, 'p2');
  resolveFight(s, marbo.id, foe.id, 'w-melee');
  assert.equal(s.eventLog.some((e) => e.rule === 'First Blood'), false);
});

/* ====================================================================== */
/* Get Some!: a rule that only applies up close                           */
/* ====================================================================== */

const getSome = {
  getsome: {
    rule: 'Get Some!',
    text: 'Each time this operative makes a shooting attack with this weapon, if the target is within 6" of it, you can re-roll any or all of your attack dice.',
    effect: { type: 'grantRuleIf', action: 'shoot', targetWithin: 12, rules: ['relentless'] },
  },
};

test('Get Some! grants its re-roll only inside the range it prints', () => {
  const s = makeState({
    p1: { at: [{ x: 6, y: 11 }], weapons: [gun(['getsome'], { range: 24 }), melee()], weaponRules: getSome },
    p2: { at: [{ x: 14, y: 11 }, { x: 26, y: 11 }], count: 2 },
    seed: 'getsome',
  });
  const [harker] = opsOf(s, 'p1');
  const [near, far] = opsOf(s, 'p2');
  const weapon = gun(['getsome'], { range: 24 });

  const close = weaponAdjustments(s, harker, weapon, { action: 'shoot', target: near });
  assert.deepEqual(close.rules, ['relentless'], 'within 12" the dice come back');

  const distant = weaponAdjustments(s, harker, weapon, { action: 'shoot', target: far });
  assert.deepEqual(distant.rules, [], 'beyond it they do not');
});
