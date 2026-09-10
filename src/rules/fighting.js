/**
 * Fight action resolution.
 *
 * Both fighters roll; successes are then resolved alternately, attacker first.
 * Each resolution is either a STRIKE (damage the opponent) or a PARRY
 * (cancel one of the opponent's pending successes).
 */
import { Rng } from '../rng.js';
import { EVENTS, logEvent, liveOperatives } from '../state.js';
import { rollAttack, validateWeaponRules, parseRule } from './dice.js';
import { noteWeaponUse, limitedExhausted } from './weapon-rules.js';
import { applyAttackHooks } from './hooks.js';
import { applyDamage, applyStun, hitModifierFor } from './effects.js';
import { withinControlRange } from './visibility.js';
import { findWeapon, meleeWeapons } from './shooting.js';

export function canFight(state, attackerId, targetId) {
  const attacker = state.operatives[attackerId];
  const target = state.operatives[targetId];
  if (!attacker?.alive || !target?.alive) return { ok: false, reason: 'operative down' };
  if (attacker.playerId === target.playerId) return { ok: false, reason: 'friendly target' };
  if (!withinControlRange(attacker, target)) {
    return { ok: false, reason: 'target not within control range' };
  }
  if (meleeWeapons(state, attacker).length === 0) {
    return { ok: false, reason: 'no melee weapon' };
  }
  return { ok: true };
}

function hasRule(weapon, name) {
  return (weapon.rules || []).some((r) => parseRule(r).name === name);
}

/**
 * Decide strike vs parry without consuming RNG — melee choices are
 * deterministic so a replay never diverges here.
 */
function chooseResolution(self, foe, selfPool, foePool, selfWeapon, foeWeapon) {
  const strikeDamage = selfPool.crits > 0 ? selfWeapon.damage.critical : selfWeapon.damage.normal;
  if (strikeDamage >= foe.woundsRemaining) return 'strike';

  const foeThreat = foePool.crits * foeWeapon.damage.critical + foePool.normals * foeWeapon.damage.normal;
  const canParry = foePool.crits + foePool.normals > 0 &&
    (!hasRule(foeWeapon, 'brutal') || selfPool.crits > 0);

  if (canParry && foeThreat >= self.woundsRemaining) return 'parry';
  return 'strike';
}

function takeSuccess(pool, preferCrit) {
  if (preferCrit && pool.crits > 0) { pool.crits--; return 'crit'; }
  if (!preferCrit && pool.normals > 0) { pool.normals--; return 'normal'; }
  if (pool.crits > 0) { pool.crits--; return 'crit'; }
  if (pool.normals > 0) { pool.normals--; return 'normal'; }
  return null;
}

export function resolveFight(state, attackerId, targetId, weaponId = null) {
  const attacker = state.operatives[attackerId];
  const target = state.operatives[targetId];

  const check = canFight(state, attackerId, targetId);
  if (!check.ok) return { ok: false, reason: check.reason };

  const attackerWeapon = weaponId
    ? findWeapon(state, attacker, weaponId)
    : meleeWeapons(state, attacker)[0];
  const targetWeapon = meleeWeapons(state, target)[0] || {
    id: 'unarmed', name: 'Unarmed', type: 'melee', atk: 2, hit: 5,
    damage: { normal: 1, critical: 2 }, rules: [],
  };
  if (!attackerWeapon) return { ok: false, reason: 'no melee weapon' };
  if (limitedExhausted(attacker, attackerWeapon)) {
    return { ok: false, reason: `${attackerWeapon.name} is spent (Limited)` };
  }

  validateWeaponRules(state, attackerWeapon);
  noteWeaponUse(attacker, attackerWeapon);
  const rng = Rng.fromState(state.rng);

  const aWeapon = applyAttackHooks(state, attacker, attackerWeapon, { target, action: 'fight' });
  const tWeapon = applyAttackHooks(state, target, targetWeapon, { target: attacker, action: 'fight' });
  const aRoll = rollAttack(rng, aWeapon, { hitModifier: hitModifierFor(attacker) });
  const dRoll = rollAttack(rng, tWeapon, { hitModifier: hitModifierFor(target) });
  state.rng = rng.getState();

  // Stun bites off the attack roll, so both fighters can stun each other.
  if (aRoll.crits > 0 && hasRule(aWeapon, 'stun')) {
    applyStun(state, target, { kind: 'fight', attackerId, weapon: attackerWeapon.name });
  }
  if (dRoll.crits > 0 && hasRule(tWeapon, 'stun')) {
    applyStun(state, attacker, { kind: 'fight', attackerId: targetId, weapon: targetWeapon.name });
  }

  logEvent(state, EVENTS.ATTACK_ROLLED, {
    attackerId, attackerName: attacker.name, targetId, targetName: target.name,
    weapon: attackerWeapon.name, kind: 'fight',
    rolls: aRoll.rolls, normals: aRoll.normals, crits: aRoll.crits, hitOn: aRoll.hitOn,
    defenderWeapon: targetWeapon.name, defenderRolls: dRoll.rolls,
    defenderNormals: dRoll.normals, defenderCrits: dRoll.crits,
  });

  const pools = {
    [attackerId]: { normals: aRoll.normals, crits: aRoll.crits },
    [targetId]: { normals: dRoll.normals, crits: dRoll.crits },
  };
  const weapons = { [attackerId]: attackerWeapon, [targetId]: targetWeapon };
  const sequence = [];
  let turn = attackerId;
  let damageDealt = { [attackerId]: 0, [targetId]: 0 };
  // Shock fires once per fighter per sequence, on their first critical strike.
  const shockSpent = { [attackerId]: false, [targetId]: false };
  let guard = 0;

  while (guard++ < 40) {
    const foeId = turn === attackerId ? targetId : attackerId;
    const selfPool = pools[turn];
    const foePool = pools[foeId];
    if (selfPool.normals + selfPool.crits === 0) {
      if (foePool.normals + foePool.crits === 0) break;
      turn = foeId;
      continue;
    }
    const self = state.operatives[turn];
    const foe = state.operatives[foeId];
    if (!self.alive || !foe.alive) break;

    const choice = chooseResolution(self, foe, selfPool, foePool, weapons[turn], weapons[foeId]);

    if (choice === 'strike') {
      const used = takeSuccess(selfPool, true);
      const dmg = used === 'crit' ? weapons[turn].damage.critical : weapons[turn].damage.normal;
      damageDealt[turn] += dmg;
      const res = applyDamage(state, foeId, dmg, {
        kind: 'fight', attackerId: turn, weapon: weapons[turn].name,
      });
      sequence.push({ actor: turn, action: 'strike', success: used, damage: dmg });

      // Shock: the first critical strike also costs the foe an unresolved
      // success — a normal one if they have any, otherwise a critical.
      if (used === 'crit' && !shockSpent[turn] && hasRule(weapons[turn], 'shock')) {
        shockSpent[turn] = true;
        let discarded = null;
        if (foePool.normals > 0) { foePool.normals--; discarded = 'normal'; }
        else if (foePool.crits > 0) { foePool.crits--; discarded = 'critical'; }
        if (discarded) {
          sequence.push({ actor: turn, action: 'shock', discarded });
          logEvent(state, EVENTS.RULE_APPLIED, {
            ruleId: 'weapon-rule:shock', rule: 'Shock',
            operativeId: foeId, operativeName: foe.name, playerId: foe.playerId,
            detail: `discards one ${discarded} success`,
          });
        }
      }
      if (res.incapacitated) break;
    } else {
      const used = takeSuccess(selfPool, foePool.crits > 0);
      // A parry cancels the opponent's best pending success.
      if (foePool.crits > 0) foePool.crits--;
      else if (foePool.normals > 0) foePool.normals--;
      sequence.push({ actor: turn, action: 'parry', success: used });
    }

    // Only swap turns if the opponent still has successes to resolve.
    const nextFoePool = pools[foeId];
    if (nextFoePool.normals + nextFoePool.crits > 0) turn = foeId;
  }

  return {
    ok: true,
    sequence,
    attackerWeapon: attackerWeapon.name,
    targetWeapon: targetWeapon.name,
    damageToTarget: damageDealt[attackerId],
    damageToAttacker: damageDealt[targetId],
    targetIncapacitated: !target.alive,
    attackerIncapacitated: !attacker.alive,
  };
}
