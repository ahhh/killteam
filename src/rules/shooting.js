/**
 * Shoot action resolution.
 * Target legality is decided here and by visibility.js — never by the UI or AI.
 */
import { Rng } from '../rng.js';
import { EVENTS, logEvent, liveOperatives } from '../state.js';
import { baseDistance } from '../maps/geometry.js';
import { canBeTargeted, traceSight, withinControlRange } from './visibility.js';
import {
  rollAttack, rollDefence, resolveSaves, validateWeaponRules, hasWeaponRule,
} from './dice.js';
import {
  heavyShootBlocker, limitedExhausted, limitedUses, isSilent,
  seekMode, rollHot, blastRadius, torrentRadius, noteWeaponUse,
} from './weapon-rules.js';
import { applyAttackHooks, applyDefenceHooks } from './hooks.js';
import { applyDamage, applyStun, hitModifierFor } from './effects.js';
import { enemiesInControlRange } from './visibility.js';

/**
 * Why an operative may or may not shoot a given target.
 * @returns {{ok:boolean, reason?:string, sight?:object, range?:number}}
 */
export function canShoot(state, attackerId, targetId, weapon) {
  const attacker = state.operatives[attackerId];
  const target = state.operatives[targetId];

  if (!attacker?.alive || !target?.alive) return { ok: false, reason: 'operative down' };
  if (attacker.playerId === target.playerId) return { ok: false, reason: 'friendly target' };
  if (weapon.type !== 'ranged') return { ok: false, reason: 'not a ranged weapon' };

  // Silent weapons may be fired from Conceal; everything else needs Engage.
  if (attacker.order !== 'engage' && !isSilent(weapon)) {
    return { ok: false, reason: 'must be on Engage order to shoot' };
  }
  const heavy = heavyShootBlocker(weapon, attacker.usedThisActivation);
  if (heavy) return { ok: false, reason: heavy };
  if (limitedExhausted(attacker, weapon)) {
    return {
      ok: false,
      reason: `${weapon.name} is spent (Limited ${limitedUses(weapon)})`,
    };
  }

  const others = liveOperatives(state).filter(
    (o) => o.id !== attackerId && o.id !== targetId
  );
  if (enemiesInControlRange(attacker, liveOperatives(state)).length > 0) {
    return { ok: false, reason: 'engaged in melee — cannot shoot' };
  }

  const range = baseDistance(attacker, target);
  if (weapon.range && range > weapon.range) {
    return { ok: false, reason: `out of range (${range.toFixed(1)}" > ${weapon.range}")` };
  }

  const targeting = canBeTargeted(attacker, target, state.map.terrain || [], others, {
    seek: seekMode(weapon),
  });
  if (!targeting.ok) return { ok: false, reason: targeting.reason, sight: targeting.sight };

  return { ok: true, sight: targeting.sight, range };
}

/**
 * Resolve a shooting attack. Mutates state; returns a structured result for
 * the log/UI. The RNG stream position is advanced on `state.rng`.
 *
 * One Shoot action can be more than one attack sequence: Blast and Torrent add
 * secondary targets, each rolled separately, and Hot burns the shooter once
 * after them all.
 */
export function resolveShoot(state, attackerId, targetId, weaponId) {
  const attacker = state.operatives[attackerId];
  const target = state.operatives[targetId];
  const weapon = findWeapon(state, attacker, weaponId);
  if (!weapon) return { ok: false, reason: `unknown weapon ${weaponId}` };

  const check = canShoot(state, attackerId, targetId, weapon);
  if (!check.ok) return { ok: false, reason: check.reason };

  validateWeaponRules(state, weapon);

  // Every target is selected before any dice are rolled, so a Blast that kills
  // its primary still catches the operatives standing next to it — and a
  // Limited weapon can still see the board while choosing them.
  const picks = secondaryTargets(state, attacker, target, weapon, check.sight.cover);

  // The weapon is spent whether or not anything is hit, so count it here.
  noteWeaponUse(attacker, weapon);

  const rng = Rng.fromState(state.rng);

  const primary = resolveSequence(state, rng, attacker, target, weapon, {
    inCover: check.sight.cover, range: check.range,
  });

  const secondary = [];
  for (const pick of picks) {
    if (!pick.operative.alive) continue;
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: `weapon-rule:${pick.rule}`,
      rule: pick.label,
      operativeId: attacker.id,
      operativeName: attacker.name,
      playerId: attacker.playerId,
      detail: `${weapon.name} also catches ${pick.operative.name}`,
    });
    secondary.push(resolveSequence(state, rng, attacker, pick.operative, weapon, {
      inCover: pick.inCover, splash: pick.rule,
    }));
  }

  // Hot: one D6 after the weapon has been used, however many targets it hit.
  const hot = rollHot(rng, weapon);
  state.rng = rng.getState();

  if (hot) {
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: 'weapon-rule:hot',
      rule: 'Hot',
      operativeId: attacker.id,
      operativeName: attacker.name,
      playerId: attacker.playerId,
      detail: hot.damage > 0
        ? `${weapon.name} overheats: rolled ${hot.rolled} under Hit ${weapon.hit}+, ${hot.damage} damage`
        : `${weapon.name} runs cool (rolled ${hot.rolled})`,
    });
    if (hot.damage > 0) {
      applyDamage(state, attackerId, hot.damage, { kind: 'hot', weapon: weapon.name });
    }
  }

  return {
    ok: true,
    attack: primary.attack,
    defence: primary.defence,
    inCover: primary.inCover,
    damage: primary.damage,
    incapacitated: primary.incapacitated,
    weaponName: weapon.name,
    secondary,
    hot,
    totalDamage: primary.damage + secondary.reduce((sum, s) => sum + s.damage, 0),
  };
}

/**
 * One attack sequence: attack dice, defence dice, saves, damage.
 * Shared by the primary target and every Blast/Torrent secondary.
 */
function resolveSequence(state, rng, attacker, target, weapon, opts = {}) {
  const { inCover = false, range = null, splash = null } = opts;

  // Attacker-side faction rules may add weapon rules for this sequence only.
  const attackWeapon = applyAttackHooks(state, attacker, weapon, { target, action: 'shoot' });
  const attack = rollAttack(rng, attackWeapon, { hitModifier: hitModifierFor(attacker) });
  logEvent(state, EVENTS.ATTACK_ROLLED, {
    attackerId: attacker.id, attackerName: attacker.name,
    targetId: target.id, targetName: target.name,
    weapon: weapon.name, rolls: attack.rolls, rerolled: attack.rerolled,
    weaponRules: attackWeapon.rules,
    hitOn: attack.hitOn, critOn: attack.critOn,
    normals: attack.normals, crits: attack.crits,
    range: range === null ? Number(baseDistance(attacker, target).toFixed(2)) : Number(range.toFixed(2)),
    splash,
  });

  // Defender-side faction rules may ignore weapon rules or change dice count.
  const def = applyDefenceHooks(state, target, attackWeapon, { attacker, action: 'shoot' });
  const defence = rollDefence(rng, target, def.weapon, {
    inCover, attackCrits: attack.crits, diceDelta: def.diceDelta, rerolls: def.rerolls,
  });
  logEvent(state, EVENTS.DEFENCE_ROLLED, {
    operativeId: target.id, operativeName: target.name,
    rolls: defence.rolls, rerolled: defence.rerolled, saveOn: defence.saveOn,
    normals: defence.normals, crits: defence.crits,
    inCover, coverSave: defence.coverSave,
  });

  const outcome = resolveSaves(attack, defence, attackWeapon);
  if (outcome.shockDiscarded) {
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: 'weapon-rule:shock',
      rule: 'Shock',
      operativeId: target.id, operativeName: target.name, playerId: target.playerId,
      detail: `discards one ${outcome.shockDiscarded} save`,
    });
  }
  if (attack.crits > 0 && hasWeaponRule(attackWeapon, 'stun')) {
    applyStun(state, target, { kind: 'shoot', attackerId: attacker.id, weapon: weapon.name });
  }

  const result = applyDamage(state, target.id, outcome.damage, {
    kind: 'shoot', attackerId: attacker.id, weapon: weapon.name, splash,
  });

  return {
    targetId: target.id,
    targetName: target.name,
    attack, defence, inCover,
    damage: outcome.damage,
    incapacitated: result.incapacitated,
    splash,
  };
}

/**
 * Everyone else caught by one Shoot action.
 *
 * Blast x": every OTHER operative — friendly ones included — visible to the
 * shooter and within x" of the primary target. A Conceal order is no
 * protection for a secondary, and they inherit the primary's cover.
 *
 * Torrent x": any other *valid target* within x" of the primary that is not
 * within control range of one of the shooter's own operatives. Those are
 * normal target selections, so cover and concealment work as usual.
 */
function secondaryTargets(state, attacker, primary, weapon, primaryInCover) {
  const blast = blastRadius(weapon);
  const torrent = torrentRadius(weapon);
  if (blast === null && torrent === null) return [];

  const terrain = state.map.terrain || [];
  const all = liveOperatives(state);
  const others = all.filter((o) => o.id !== attacker.id && o.id !== primary.id);
  const picked = new Map();

  if (blast !== null) {
    for (const op of others) {
      if (baseDistance(op, primary) > blast) continue;
      const bystanders = all.filter((o) => o.id !== attacker.id && o.id !== op.id);
      if (!traceSight(attacker, op, terrain, bystanders).visible) continue;
      picked.set(op.id, {
        operative: op, inCover: primaryInCover,
        rule: 'blast', label: `Blast ${blast}"`,
      });
    }
  }

  if (torrent !== null) {
    const friends = all.filter((o) => o.playerId === attacker.playerId);
    for (const op of others) {
      if (picked.has(op.id)) continue;
      if (op.playerId === attacker.playerId) continue;
      if (baseDistance(op, primary) > torrent) continue;
      if (friends.some((f) => withinControlRange(f, op))) continue;
      const check = canShoot(state, attacker.id, op.id, weapon);
      if (!check.ok) continue;
      picked.set(op.id, {
        operative: op, inCover: check.sight.cover,
        rule: 'torrent', label: `Torrent ${torrent}"`,
      });
    }
  }

  // Resolution order is the player's choice; pick a stable one so replays match.
  return [...picked.values()].sort((a, b) => (a.operative.id < b.operative.id ? -1 : 1));
}

export function findWeapon(state, operative, weaponId) {
  const profile = getProfile(state, operative);
  return profile.weapons.find((w) => w.id === weaponId);
}

export function getProfile(state, operative) {
  const team = state.teamPacks[operative.playerId];
  const profile = team.operatives.find((o) => o.id === operative.profileId);
  if (!profile) throw new Error(`missing profile ${operative.profileId}`);
  return profile;
}

export function rangedWeapons(state, operative) {
  return getProfile(state, operative).weapons.filter((w) => w.type === 'ranged');
}

export function meleeWeapons(state, operative) {
  return getProfile(state, operative).weapons
    .filter((w) => w.type === 'melee' && !limitedExhausted(operative, w));
}

/** Ranged weapons this operative could still use right now (Heavy, Limited). */
export function usableRangedWeapons(state, operative) {
  return rangedWeapons(state, operative).filter(
    (w) => !limitedExhausted(operative, w) &&
      !heavyShootBlocker(w, operative.usedThisActivation)
  );
}
