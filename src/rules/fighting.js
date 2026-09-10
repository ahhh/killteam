/**
 * Fight action resolution.
 *
 * Both fighters roll; successes are then resolved alternately, attacker first.
 * Each resolution is either a STRIKE (damage the opponent) or a BLOCK (cancel
 * one of the opponent's pending successes — two of them, for the shield-shaped
 * team rules that say so).
 */
import { Rng } from '../rng.js';
import { EVENTS, logEvent, liveOperatives } from '../state.js';
import { baseDistance } from '../maps/geometry.js';
import { rollAttack, validateWeaponRules, parseRule } from './dice.js';
import { rollExpression } from './hooks.js';
import { noteWeaponUse, limitedExhausted } from './weapon-rules.js';
import {
  meleeModifiers, weaponAdjustments, withAdjustments, damageBonusVsToken,
  teamRuleEffect, notePartialTeamRule, retaliationRule,
} from './team-rules.js';
import { snapshotTokens } from './tokens.js';
import { diceRerollSpend } from './resources.js';
import { applyAttackHooks } from './hooks.js';
import { applyDamage, applyStun, hitModifierFor } from './effects.js';
import { withinControlRange } from './visibility.js';
import { isPositionLegal } from './movement.js';
import {
  findWeapon, meleeWeapons, applyTokenRules, applyKillReward, applyResourceGain,
} from './shooting.js';

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
 * Decide strike vs block without consuming RNG — melee choices are
 * deterministic so a replay never diverges here.
 *
 * `blockMultiplier` is how many of the opponent's successes one block takes
 * off. At 2 a block is worth roughly twice as much, which is exactly what
 * Shield, Tangle and Repress are for, so the threat comparison uses it.
 */
function chooseResolution(self, foe, selfPool, foePool, selfWeapon, foeWeapon, blockMultiplier) {
  const strikeDamage = selfPool.crits > 0 ? selfWeapon.damage.critical : selfWeapon.damage.normal;
  if (strikeDamage >= foe.woundsRemaining) return 'strike';

  const foeThreat = foePool.crits * foeWeapon.damage.critical + foePool.normals * foeWeapon.damage.normal;
  const canBlock = foePool.crits + foePool.normals > 0 &&
    (!hasRule(foeWeapon, 'brutal') || selfPool.crits > 0);

  if (canBlock && foeThreat >= self.woundsRemaining) return 'parry';
  // A shield that soaks two successes is worth using before the last wound.
  if (canBlock && blockMultiplier > 1 && foeThreat >= self.woundsRemaining / 2) return 'parry';
  return 'strike';
}

function takeSuccess(pool, preferCrit) {
  if (preferCrit && pool.crits > 0) { pool.crits--; return 'crit'; }
  if (!preferCrit && pool.normals > 0) { pool.normals--; return 'normal'; }
  if (pool.crits > 0) { pool.crits--; return 'crit'; }
  if (pool.normals > 0) { pool.normals--; return 'normal'; }
  return null;
}

/**
 * An operative with no weapon at all — the Spectre Vox-Relay Beacon is the
 * bundled example — has nothing to hit back with. It rolls no dice rather
 * than being handed a phantom pair of fists.
 */
const NO_RETALIATION = {
  id: 'none', name: 'no weapon', type: 'melee', atk: 0, hit: 6,
  damage: { normal: 0, critical: 0 }, rules: [],
};

export function resolveFight(state, attackerId, targetId, weaponId = null) {
  const attacker = state.operatives[attackerId];
  const target = state.operatives[targetId];

  const check = canFight(state, attackerId, targetId);
  if (!check.ok) return { ok: false, reason: check.reason };

  const attackerWeapon = weaponId
    ? findWeapon(state, attacker, weaponId)
    : meleeWeapons(state, attacker)[0];
  const targetWeapon = meleeWeapons(state, target)[0] || NO_RETALIATION;
  if (!attackerWeapon) return { ok: false, reason: 'no melee weapon' };
  if (limitedExhausted(attacker, attackerWeapon)) {
    return { ok: false, reason: `${attackerWeapon.name} is spent (Limited)` };
  }

  validateWeaponRules(state, attackerWeapon, attacker);
  noteWeaponUse(attacker, attackerWeapon);

  // Toxic reads the tokens its target held when the action began, so the
  // snapshot is taken before a single die is rolled.
  const tokensAtStart = snapshotTokens(liveOperatives(state));
  const rng = Rng.fromState(state.rng);

  const aWeapon = withGrantedRules(state, attacker, attackerWeapon,
    applyAttackHooks(state, attacker, attackerWeapon, { target, action: 'fight' }), target);
  const tWeapon = withGrantedRules(state, target, targetWeapon,
    applyAttackHooks(state, target, targetWeapon, { target: attacker, action: 'fight' }), attacker);

  // Both fighters roll attack dice, so both may spend on a second look.
  const aRoll = rollAttack(rng, aWeapon, {
    hitModifier: hitModifierFor(attacker),
    extraReroll: diceRerollSpend(state, attacker, { kind: 'attack' }),
  });
  const dRoll = targetWeapon.atk > 0
    ? rollAttack(rng, tWeapon, {
      hitModifier: hitModifierFor(target),
      extraReroll: diceRerollSpend(state, target, { kind: 'attack' }),
    })
    : { rolls: [], rerolled: [], normals: 0, crits: 0, misses: 0, hitOn: 6, critOn: 6 };

  // Stun bites off the attack roll, so both fighters can stun each other.
  if (aRoll.crits > 0 && hasRule(aWeapon, 'stun')) {
    applyStun(state, target, { kind: 'fight', attackerId, weapon: attackerWeapon.name });
  }
  if (dRoll.crits > 0 && hasRule(tWeapon, 'stun')) {
    applyStun(state, attacker, { kind: 'fight', attackerId: targetId, weapon: targetWeapon.name });
  }

  const mods = {
    [attackerId]: meleeModifiers(state, attacker, attackerWeapon),
    [targetId]: meleeModifiers(state, target, targetWeapon),
  };
  const damageBonus = {
    [attackerId]: damageBonusVsToken(state, attacker, attackerWeapon, target, tokensAtStart),
    [targetId]: damageBonusVsToken(state, target, targetWeapon, attacker, tokensAtStart),
  };

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
  // Strikes use the adjusted profiles, so a granted Dmg bonus actually lands.
  const weapons = { [attackerId]: aWeapon, [targetId]: tWeapon };
  const sequence = [];

  // Repress reverses the order when its holder is the one retaliating: the
  // defender resolves the first attack dice instead of the attacker.
  let turn = mods[targetId].defenderResolvesFirst ? targetId : attackerId;
  if (turn === targetId) {
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: 'weapon-rule:repress', rule: mods[targetId].rule || 'Repress',
      operativeId: targetId, operativeName: target.name, playerId: target.playerId,
      detail: 'retaliates first — the defender resolves the first attack dice',
    });
  }

  const damageDealt = { [attackerId]: 0, [targetId]: 0 };
  const critStrikes = { [attackerId]: 0, [targetId]: 0 };
  // Shock and Tactual Hunter each fire once per fighter per sequence.
  const shockSpent = { [attackerId]: false, [targetId]: false };
  const huntSpent = { [attackerId]: false, [targetId]: false };
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

    const blockMultiplier = mods[turn].blockMultiplier;
    const choice = chooseResolution(
      self, foe, selfPool, foePool, weapons[turn], weapons[foeId], blockMultiplier
    );

    if (choice === 'strike') {
      const used = takeSuccess(selfPool, true);
      const bonus = damageBonus[turn];
      const dmg = used === 'crit'
        ? weapons[turn].damage.critical + (bonus.critical || 0)
        : weapons[turn].damage.normal + (bonus.normal || 0);
      damageDealt[turn] += dmg;
      if (used === 'crit') critStrikes[turn]++;
      const crushed = mods[turn].crush
        ? rollCrush(state, rng, self, foe, mods[turn].crush)
        : 0;
      const res = applyDamage(state, foeId, dmg + crushed, {
        kind: 'fight', attackerId: turn, weapon: weapons[turn].name,
      });
      damageDealt[turn] += crushed;
      sequence.push({ actor: turn, action: 'strike', success: used, damage: dmg + crushed });

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
      if (mods[turn].push) applyPush(state, self, foe, mods[turn].push, sequence);

      // Tactual Hunter: catching an already-expended operative off guard buys
      // a second strike before the opponent gets to answer, once per sequence.
      if (used === 'crit' && !huntSpent[turn] && mods[turn].doubleStrikeVsExpended &&
          foe.activatedThisTurningPoint && selfPool.normals + selfPool.crits > 0) {
        huntSpent[turn] = true;
        const followUp = takeSuccess(selfPool, true);
        const extraDmg = followUp === 'crit'
          ? weapons[turn].damage.critical + (damageBonus[turn].critical || 0)
          : weapons[turn].damage.normal + (damageBonus[turn].normal || 0);
        damageDealt[turn] += extraDmg;
        if (followUp === 'crit') critStrikes[turn]++;
        const extraRes = applyDamage(state, foeId, extraDmg, {
          kind: 'fight', attackerId: turn, weapon: weapons[turn].name,
        });
        sequence.push({ actor: turn, action: 'strike', success: followUp, damage: extraDmg, followUp: true });
        logEvent(state, EVENTS.RULE_APPLIED, {
          ruleId: 'weapon-rule:tactualhunter', rule: mods[turn].doubleStrikeVsExpended.rule,
          operativeId: foe.id, operativeName: foe.name, playerId: foe.playerId,
          detail: `${self.name} strikes twice before it can answer`,
        });
        if (extraRes.incapacitated) break;
      }
    } else {
      const used = takeSuccess(selfPool, foePool.crits > 0);
      // A block cancels the opponent's best pending successes — one normally,
      // two behind a shield.
      let blocked = 0;
      for (let i = 0; i < blockMultiplier; i++) {
        if (foePool.crits > 0) foePool.crits--;
        else if (foePool.normals > 0) foePool.normals--;
        else break;
        blocked++;
      }
      sequence.push({ actor: turn, action: 'parry', success: used, blocked });

      // Riposte: a block made with a critical success cuts back for the
      // weapon's Critical Dmg on the way past.
      if (used === 'crit' && mods[turn].riposte) {
        const back = weapons[turn].damage.critical;
        damageDealt[turn] += back;
        logEvent(state, EVENTS.RULE_APPLIED, {
          ruleId: 'weapon-rule:riposte', rule: mods[turn].riposte.rule,
          operativeId: foe.id, operativeName: foe.name, playerId: foe.playerId,
          detail: `${self.name} ripostes for ${back} damage`,
        });
        const riposted = applyDamage(state, foeId, back, {
          kind: 'fight', attackerId: turn, weapon: weapons[turn].name,
        });
        sequence.push({ actor: turn, action: 'riposte', damage: back });
        if (riposted.incapacitated) break;
      }
      if (blocked > 1) {
        logEvent(state, EVENTS.RULE_APPLIED, {
          ruleId: `weapon-rule:${(mods[turn].rule || 'shield').toLowerCase()}`,
          rule: mods[turn].rule || 'Shield',
          operativeId: turn, operativeName: self.name, playerId: self.playerId,
          detail: `one block stops ${blocked} of ${foe.name}'s successes`,
        });
      }
    }

    // Only swap turns if the opponent still has successes to resolve.
    const nextFoePool = pools[foeId];
    if (nextFoePool.normals + nextFoePool.crits > 0) turn = foeId;
  }

  // First Blood: whoever was hurt and lived can cut back on the way out. Both
  // fighters get the chance, because either may be the one carrying the rule.
  applyRetaliationRoll(state, rng, attacker, attackerWeapon, target, damageDealt[targetId]);
  applyRetaliationRoll(state, rng, target, targetWeapon, attacker, damageDealt[attackerId]);

  // Rewards for a kill, and the resource tracks a weapon feeds, settle here.
  if (!target.alive) applyKillReward(state, rng, attacker, attackerWeapon);
  applyResourceGain(state, attacker, attackerWeapon, {
    damage: damageDealt[attackerId], unsavedCrits: critStrikes[attackerId],
  });

  // Tokens hang on whatever survived, in the same "Resolve Attack Dice" step.
  applyTokenRules(state, attacker, target, attackerWeapon, {
    outcome: { damage: damageDealt[attackerId], unsavedCrits: critStrikes[attackerId], devastatingDamage: 0 },
    result: { incapacitated: !target.alive },
  });
  if (targetWeapon.atk > 0) {
    applyTokenRules(state, target, attacker, targetWeapon, {
      outcome: { damage: damageDealt[targetId], unsavedCrits: critStrikes[targetId], devastatingDamage: 0 },
      result: { incapacitated: !attacker.alive },
    });
  }

  state.rng = rng.getState();

  return {
    ok: true,
    sequence,
    attackerWeapon: attackerWeapon.name,
    attackerWeaponId: attackerWeapon.id,
    targetWeapon: targetWeapon.name,
    damageToTarget: damageDealt[attackerId],
    damageToAttacker: damageDealt[targetId],
    targetIncapacitated: !target.alive,
    attackerIncapacitated: !attacker.alive,
    repeatFight: mods[attackerId].repeatFight || null,
  };
}

/**
 * First Blood: "if it lost any wounds in that combat but was not
 * incapacitated, roll one D6: on a 4+, the enemy operative that fought it
 * suffers 2 mortal wounds".
 *
 * Both halves of the condition are read off the sequence that just ran, so the
 * rule cannot fire for a fighter that walked away untouched.
 */
function applyRetaliationRoll(state, rng, op, weapon, foe, woundsTaken) {
  const rule = retaliationRule(state, op, weapon);
  if (!rule) return;
  if (!op.alive || !foe.alive || woundsTaken <= 0) return;
  notePartialTeamRule(state, rule.def);

  const rolled = rollExpression(rng, rule.dice);
  const hit = rolled >= rule.threshold;
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: `weapon-rule:${rule.def.name}`,
    rule: rule.def.rule || rule.def.name,
    operativeId: foe.id, operativeName: foe.name, playerId: foe.playerId,
    detail: hit
      ? `${op.name} cuts back for ${rule.damage} damage (rolled ${rolled}, needed ${rule.threshold}+)`
      : `${op.name} fails to cut back (rolled ${rolled}, needed ${rule.threshold}+)`,
  });
  if (hit) {
    applyDamage(state, foe.id, rule.damage, {
      kind: 'fight', attackerId: op.id, rule: rule.def.rule || rule.def.name,
    });
  }
}

/**
 * Fold in what a team rule changes about this weapon for this fight — Force
 * Impact's Brutal, Vicious Blows' Ceaseless, Anti-PSYKER's extra damage.
 */
function withGrantedRules(state, op, printed, effective, target) {
  return withAdjustments(effective, weaponAdjustments(state, op, printed, {
    counteraction: op.inCounteraction === true, action: 'fight', target,
  }));
}

/**
 * Crush: both players roll off on every strike, the crusher adding 1 against
 * a small target, and the margin becomes extra damage up to the printed cap.
 *
 * @returns {number} additional damage from this strike.
 */
function rollCrush(state, rng, self, foe, crush) {
  const mine = rng.d6() + (foe.wounds <= crush.bonusIfWoundsAtMost ? 1 : 0);
  const theirs = rng.d6();
  if (mine <= theirs) return 0;
  const extra = Math.min(mine - theirs, crush.maxExtra);
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: 'weapon-rule:crush', rule: crush.rule,
    operativeId: foe.id, operativeName: foe.name, playerId: foe.playerId,
    detail: `crushed for ${extra} extra damage (${mine} against ${theirs})`,
  });
  return extra;
}

/**
 * Smash: a strike can shove the enemy a straight inch away, with the smasher
 * stepping after it to stay in its face.
 *
 * Both halves must land in a legal spot or neither moves, exactly as printed.
 */
function applyPush(state, self, foe, push, sequence) {
  const distance = push.distance;
  const dx = foe.x - self.x;
  const dy = foe.y - self.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  const foeTo = { x: foe.x + ux * distance, y: foe.y + uy * distance };
  if (!isPositionLegal(state, foe.id, foeTo.x, foeTo.y).ok) return;

  const selfTo = { x: self.x + ux * distance, y: self.y + uy * distance };
  const from = { x: foe.x, y: foe.y };
  foe.x = foeTo.x; foe.y = foeTo.y;
  if (!isPositionLegal(state, self.id, selfTo.x, selfTo.y).ok ||
      !withinControlRange({ ...self, ...selfTo }, foe)) {
    foe.x = from.x; foe.y = from.y;
    return;
  }
  self.x = selfTo.x; self.y = selfTo.y;

  sequence.push({ actor: self.id, action: 'push', distance });
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: 'weapon-rule:smash', rule: push.rule || 'Smash',
    operativeId: foe.id, operativeName: foe.name, playerId: foe.playerId,
    detail: `is shoved ${distance}" back by ${self.name}, who follows it in`,
  });
}

/**
 * Phase Sweep: after the Fight action, the operative keeps fighting for free
 * until it has fought every enemy within its control range once, or dies.
 *
 * The printed rule says this takes precedence over the once-per-activation
 * action restriction, so it runs here rather than through the AP layer.
 *
 * @returns {Array} the extra fights, in resolution order.
 */
export function resolveSweep(state, attackerId, weaponId, firstTargetId) {
  const attacker = state.operatives[attackerId];
  const weapon = findWeapon(state, attacker, weaponId);
  if (!weapon) return [];
  const def = teamRuleEffect(state, attacker, weapon, 'meleeModifier');
  const mods = meleeModifiers(state, attacker, weapon);
  if (!mods.repeatFight) return [];
  notePartialTeamRule(state, def);

  const fought = new Set([firstTargetId]);
  const extra = [];
  let guard = 0;

  while (attacker.alive && guard++ < 12) {
    const next = liveOperatives(state)
      .filter((o) => o.playerId !== attacker.playerId && !fought.has(o.id))
      .filter((o) => withinControlRange(attacker, o))
      .sort((a, b) => baseDistance(attacker, a) - baseDistance(attacker, b) ||
        (a.id < b.id ? -1 : 1))[0];
    if (!next) break;

    fought.add(next.id);
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: 'weapon-rule:phasesweep', rule: mods.repeatFight.rule,
      operativeId: attacker.id, operativeName: attacker.name, playerId: attacker.playerId,
      detail: `sweeps on into ${next.name} with a free Fight action`,
    });
    const result = resolveFight(state, attackerId, next.id, weaponId);
    if (!result.ok) break;
    extra.push(result);
  }
  return extra;
}
