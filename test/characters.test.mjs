/**
 * The character layer: what an operative is, beyond its role and its guns.
 *
 * Three things have to hold:
 *
 *  - archetypes are DERIVED from the keywords the packs already print, and a
 *    pack that disagrees can say so in data;
 *  - what an operative hunts changes which enemy it goes for, without
 *    inflating what the plan claims it will do;
 *  - an operative's own printed actions and spells are worth more in its own
 *    hands than the same effect bolted to anything else — and each of them
 *    reaches the menu as its own card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, opsOf, weapon, melee } from './fixtures.mjs';
import {
  ARCHETYPES, characterForProfile, characterFor, huntBonus, isPsychicAbility,
} from '../src/ai/characters.js';
import { unitTacticsFor } from '../src/ai/tactics.js';
import { bestMeleeTarget } from '../src/ai/targeting.js';
import { uniqueActionValue, bestUniqueAction } from '../src/ai/support.js';
import { branchOf, branchKeyOf } from '../src/ai/options.js';
import { availableUniqueActions } from '../src/rules/unique-actions.js';
import { profileOf } from '../src/rules/hooks.js';

const profile = (over = {}) => ({
  id: 'p', name: 'Test', role: 'flexible', baseDiameter: 1.25,
  stats: { move: 6, apl: 2, save: 4, wounds: 10 },
  weapons: [weapon(), melee()], abilities: [], keywords: [], ...over,
});

/* ------------------------------------------------------------------ */
/* Reading the profile                                                 */
/* ------------------------------------------------------------------ */

test('an archetype is read off the keywords a pack already prints', () => {
  assert.deepEqual(characterForProfile(profile({ keywords: ['leader', 'ork'] })).archetypes,
    ['leader']);
  assert.deepEqual(characterForProfile(profile({ keywords: ['medic'] })).archetypes, ['medic']);
  assert.deepEqual(characterForProfile(profile({ keywords: ['ork', 'boy'] })).archetypes, []);
});

test('an operative can be more than one thing at once', () => {
  const c = characterForProfile(profile({ keywords: ['leader', 'psyker'] }));
  assert.deepEqual(c.archetypes, ['leader', 'adept']);
  // The multipliers compound rather than the last one winning: a leader who is
  // also a caster is cautious on both counts.
  assert.ok(c.mods.survival > ARCHETYPES.leader.mods.survival);
});

test('a profile that matches everything still only gets three archetypes', () => {
  const c = characterForProfile(profile({
    keywords: ['leader', 'psyker', 'medic', 'sniper', 'gunner', 'drone'],
  }));
  assert.equal(c.archetypes.length, 3);
});

test('a pack may name the character itself, in any of three shapes', () => {
  assert.deepEqual(
    characterForProfile(profile({ keywords: ['leader'], aiCharacter: 'champion' })).archetypes,
    ['champion'], 'a name overrides the keywords');
  assert.deepEqual(
    characterForProfile(profile({ aiCharacter: ['medic', 'herald'] })).archetypes,
    ['medic', 'herald']);
  const inline = characterForProfile(profile({
    keywords: ['leader'],
    aiCharacter: { label: 'Warlord', note: 'leads from the front', mods: { approach: 2 }, hunts: { leader: 3 } },
  }));
  assert.equal(inline.mods.approach, 2);
  assert.equal(inline.hunts.leader, 3);
  assert.match(inline.labels[0], /Warlord/);
});

test('an unknown archetype name is ignored rather than guessed at', () => {
  assert.deepEqual(
    characterForProfile(profile({ keywords: ['medic'], aiCharacter: 'warmaster' })).archetypes,
    ['medic']);
});

test('the character is named in the reasoning the log prints', () => {
  const state = makeState({
    p1: { keywords: ['leader'], at: [{ x: 5, y: 11 }] },
    p2: { at: [{ x: 15, y: 11 }] },
  });
  const [a] = opsOf(state, 'p1');
  assert.ok(unitTacticsFor(state, a).labels.some((l) => /Leader/.test(l)));
});

/* ------------------------------------------------------------------ */
/* What it hunts                                                       */
/* ------------------------------------------------------------------ */

test('huntBonus takes the strongest match, and 1 when there is none', () => {
  const hunts = { leader: 1.6, psyker: 1.3 };
  assert.equal(huntBonus(hunts, profile({ keywords: ['leader', 'psyker'] })), 1.6);
  assert.equal(huntBonus(hunts, profile({ keywords: ['psyker'] })), 1.3);
  assert.equal(huntBonus(hunts, profile({ keywords: ['trooper'] })), 1);
  assert.equal(huntBonus(null, profile({ keywords: ['leader'] })), 1);
});

/**
 * The behavioural half. A champion in contact with both the enemy leader and a
 * trooper should swing at the leader — even though the trooper is the better
 * target on the numbers: it carries the heavier gun, so it is the bigger
 * threat, and it has fewer wounds left, so it is the easier kill.
 */
function duelState() {
  const state = makeState({
    p1: { keywords: ['champion'], at: [{ x: 10, y: 11 }] },
    p2: { count: 2, save: 4, wounds: 10, at: [{ x: 10.9, y: 11 }, { x: 10, y: 11.9 }] },
  });
  // A second enemy profile on the same side. `makeState` fields one profile
  // per side, so the pack is handed the other one here.
  const base = state.teamPacks.p2.operatives[0];
  state.teamPacks.p2.operatives[0] = { ...base, keywords: ['leader'], name: 'Boss' };
  state.teamPacks.p2.operatives.push({
    ...base, id: 'grunt', name: 'Trooper', keywords: ['trooper'],
    weapons: [weapon({ atk: 4, hit: 3, damage: { normal: 4, critical: 5 } }), melee()],
    stats: { ...base.stats, wounds: 9 },
  });
  const [boss, grunt] = opsOf(state, 'p2');
  grunt.profileId = 'grunt';
  grunt.wounds = 9;
  grunt.woundsRemaining = 9;
  return { state, boss, grunt };
}

test('a champion swings at the enemy leader, not at the better target', () => {
  const { state, boss, grunt } = duelState();
  const [champion] = opsOf(state, 'p1');
  const engaged = [boss, grunt];
  const blade = melee();

  // On the numbers alone the trooper wins: more dangerous, and closer to dead.
  assert.equal(bestMeleeTarget(state, champion, engaged, blade, null).targetId, grunt.id);
  // With the character layer the champion goes for the one it came for.
  const tactics = unitTacticsFor(state, champion);
  assert.ok(tactics.hunts.leader > 1);
  assert.equal(bestMeleeTarget(state, champion, engaged, blade, tactics).targetId, boss.id);
});

test('an operative that hunts nothing is unmoved by the leader keyword', () => {
  const { state, grunt } = duelState();
  const [champion] = opsOf(state, 'p1');
  state.teamPacks.p1.operatives[0].keywords = ['warrior'];
  const tactics = unitTacticsFor(state, champion);
  assert.deepEqual(tactics.hunts, {});
  assert.equal(
    bestMeleeTarget(state, champion, opsOf(state, 'p2'), melee(), tactics).targetId, grunt.id);
});

/* ------------------------------------------------------------------ */
/* Its own printed actions                                             */
/* ------------------------------------------------------------------ */

const medikit = {
  id: 'medikit', name: 'MEDIKIT', cost: '1AP', description: 'the printed wording',
  action: {
    ap: 1,
    target: { scope: 'controlRange', side: 'friendly', wounded: true },
    effect: { type: 'healWounds', dice: '2D3' },
  },
};

const hex = {
  id: 'hex', name: 'WITHERING HEX', cost: '1AP',
  description: 'PSYCHIC. Select one enemy operative visible to this operative.',
  action: {
    ap: 1,
    target: { scope: 'visible', side: 'enemy' },
    effect: { type: 'subtractApl', amount: 1 },
  },
};

function carrierState(keywords, abilities = [medikit]) {
  const state = makeState({
    p1: { count: 2, keywords, abilities, at: [{ x: 4, y: 10 }, { x: 4.8, y: 10 }] },
    p2: { at: [{ x: 26, y: 10 }] },
  });
  const [carrier, patient] = opsOf(state, 'p1');
  patient.woundsRemaining = 3;
  return { state, carrier, patient };
}

test('the same action is worth more in the hands it was printed for', () => {
  const plain = carrierState(['trooper']);
  const medic = carrierState(['medic']);
  const value = ({ state, carrier, patient }) => uniqueActionValue(
    state, carrier, availableUniqueActions(state, carrier)[0], patient);
  assert.ok(value(medic) > value(plain),
    'a Medikit is a decision for a medic and an afterthought for anybody else');
});

test('an action whose text opens PSYCHIC is a spell', () => {
  assert.equal(isPsychicAbility(hex), true);
  assert.equal(isPsychicAbility(medikit), false);
  const { state, carrier } = carrierState(['psyker'], [hex]);
  assert.deepEqual([...characterFor(state, carrier).spells], ['hex']);
  // …and a caster whose only spell is an action still counts as one, which the
  // weapon-only reading of PSYCHIC missed entirely.
  assert.ok(unitTacticsFor(state, carrier).spellBonus > 0);
  assert.equal(bestUniqueAction(state, carrier)?.psychic, true);
});

test('a spell is filed under “use a spell”, an ability under “use an ability”', () => {
  const spell = { actions: [{ type: 'unique', abilityId: 'hex' }], estimate: { psychic: true } };
  const ability = { actions: [{ type: 'unique', abilityId: 'medikit' }], estimate: {} };
  assert.equal(branchOf(spell), 'psychic');
  assert.equal(branchOf(ability), 'support');
});

test('two printed actions compete for two cards, not one', () => {
  const a = { actions: [{ type: 'unique', abilityId: 'medikit' }], estimate: {} };
  const b = { actions: [{ type: 'unique', abilityId: 'signal' }], estimate: {} };
  assert.notEqual(branchKeyOf(a, 'support'), branchKeyOf(b, 'support'));
  // Two ways to shoot the same trooper are still one card.
  const x = { actions: [{ type: 'shoot', weaponId: 'gun', targetId: 't' }], estimate: {} };
  const y = { actions: [{ type: 'shoot', weaponId: 'gun', targetId: 'u' }], estimate: {} };
  assert.equal(branchKeyOf(x, 'shoot'), branchKeyOf(y, 'shoot'));
});

test('every bundled profile resolves to a character without throwing', async () => {
  const { loadTeam } = await import('./harness.mjs');
  const state = makeState({ p1: { at: [{ x: 5, y: 11 }] }, p2: { at: [{ x: 15, y: 11 }] } });
  const [op] = opsOf(state, 'p1');
  for (const id of ['warpcoven', 'kommandos', 'novitiates', 'hierotek-circle']) {
    const pack = loadTeam(id);
    state.teamPacks.p1 = pack;
    for (const p of pack.operatives) {
      op.profileId = p.id;
      const c = characterFor(state, op);
      assert.equal(profileOf(state, op).id, p.id);
      assert.ok(Array.isArray(c.archetypes));
      assert.ok(Number.isFinite(c.signature) && c.signature >= 1);
    }
  }
});
