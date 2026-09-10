/**
 * Shoot action resolution.
 * Target legality is decided here and by visibility.js — never by the UI or AI.
 */
import { Rng } from '../rng.js';
import { EVENTS, logEvent, liveOperatives } from '../state.js';
import {
  baseDistance, pointSegmentDistance, segmentIntersectsPolygon, stepToward,
} from '../maps/geometry.js';
import { canBeTargeted, traceSight, withinControlRange } from './visibility.js';
import {
  rollAttack, rollDefence, resolveSaves, validateWeaponRules, hasWeaponRule,
} from './dice.js';
import {
  heavyShootBlocker, limitedExhausted, limitedUses, isSilent,
  seekMode, rollHot, blastRadius, torrentRadius, noteWeaponUse,
} from './weapon-rules.js';
import {
  teamRuleEffect, teamRuleBlocker, noteTeamRuleUse, damageBonusVsToken,
  aplDefenceRule, weaponAdjustments, withAdjustments, notePartialTeamRule,
} from './team-rules.js';
import { snapshotTokens, grantToken } from './tokens.js';
import { applyAttackHooks, applyDefenceHooks, rollExpression } from './hooks.js';
import { applyDamage, applyStun, hitModifierFor, effectiveApl } from './effects.js';
import { isPositionLegal } from './movement.js';
import { enemiesInControlRange } from './visibility.js';

/**
 * Weapons that pick their own primary target rather than being aimed at one:
 * Explosive and Wreathed go off in the operative's own hands, and the Imperial
 * Navy Breachers' Detonate fires through a friendly Gheistskull.
 *
 * @returns {{def:object, kind:'self'|'friendly'}|null}
 */
function selfDirectedRule(state, op, weapon) {
  const self = teamRuleEffect(state, op, weapon, 'selfPrimaryTarget');
  if (self) return { def: self, kind: 'self' };
  const friendly = teamRuleEffect(state, op, weapon, 'friendlyPrimaryTarget');
  if (friendly) return { def: friendly, kind: 'friendly' };
  return null;
}

/** Whether this weapon may be fired while an enemy is within control range. */
function firesWhileEngaged(directed) {
  return directed?.def?.effect?.allowWhileEngaged === true;
}

/**
 * Why an operative may or may not shoot a given target.
 * @returns {{ok:boolean, reason?:string, sight?:object, range?:number}}
 */
export function canShoot(state, attackerId, targetId, weapon) {
  const attacker = state.operatives[attackerId];
  const target = state.operatives[targetId];

  if (!attacker?.alive) return { ok: false, reason: 'operative down' };
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
  const teamBlocked = teamRuleBlocker(state, attacker, weapon, {
    counteraction: attacker.inCounteraction === true,
  });
  if (teamBlocked) return { ok: false, reason: teamBlocked };

  // A self-directed weapon never selects a valid target, so none of the
  // targeting checks below apply to it — including the melee lockout, which
  // Explosive and Wreathed explicitly override.
  const directed = selfDirectedRule(state, attacker, weapon);
  if (directed) {
    if (!firesWhileEngaged(directed) &&
        enemiesInControlRange(attacker, liveOperatives(state)).length > 0) {
      return { ok: false, reason: 'engaged in melee — cannot shoot' };
    }
    if (directed.kind === 'friendly' && !friendlyBearer(state, attacker, directed)) {
      return {
        ok: false,
        reason: `${weapon.name} needs a friendly ${directed.def.effect.keyword} in the killzone`,
      };
    }
    return { ok: true, sight: { cover: false }, range: 0, directed };
  }

  if (!target?.alive) return { ok: false, reason: 'operative down' };
  if (attacker.playerId === target.playerId) return { ok: false, reason: 'friendly target' };

  if (enemiesInControlRange(attacker, liveOperatives(state)).length > 0) {
    return { ok: false, reason: 'engaged in melee — cannot shoot' };
  }

  const range = baseDistance(attacker, target);
  if (weapon.range && range > weapon.range) {
    return { ok: false, reason: `out of range (${range.toFixed(1)}" > ${weapon.range}")` };
  }

  const terrain = state.map.terrain || [];
  const others = liveOperatives(state).filter(
    (o) => o.id !== attackerId && o.id !== targetId
  );
  const targeting = canBeTargeted(attacker, target, terrain, others, {
    seek: seekMode(weapon),
  });

  // Magnify: a second pair of eyes decides valid target, cover and obscured.
  const spotted = spotterTargeting(state, attacker, target, weapon, targeting);
  if (spotted) return { ok: true, sight: spotted.sight, range, spotter: spotted };

  if (!targeting.ok) return { ok: false, reason: targeting.reason, sight: targeting.sight };

  return { ok: true, sight: targeting.sight, range };
}

/**
 * Magnify: the shooter borrows a comrade's viewpoint.
 *
 * The printed rule is optional ("you can use this rule"), so the engine only
 * reaches for it when the shot is actually better through the spotter — the
 * target could not be picked at all, or was in cover. The target must still be
 * visible to the shooter itself, which is what keeps this from being a way to
 * shoot around a building.
 *
 * @returns {{sight:object, operative:object, def:object}|null}
 */
function spotterTargeting(state, attacker, target, weapon, direct) {
  const def = teamRuleEffect(state, attacker, weapon, 'spotterTargeting');
  if (!def) return null;
  if (direct.ok && !direct.sight.cover) return null; // nothing to gain

  const terrain = state.map.terrain || [];
  const all = liveOperatives(state);
  if (!traceSight(attacker, target, terrain, all.filter(
    (o) => o.id !== attacker.id && o.id !== target.id)).visible) return null;

  const keywords = def.effect.keywords || [];
  const candidates = liveOperatives(state, attacker.playerId)
    .filter((o) => o.id !== attacker.id)
    .filter((o) => !keywords.length ||
      keywords.some((k) => (getProfile(state, o).keywords || []).includes(k)))
    .filter((o) => o.order === 'engage')
    .filter((o) => enemiesInControlRange(o, all).length === 0)
    .filter((o) => traceSight(attacker, o, terrain, all.filter(
      (b) => b.id !== attacker.id && b.id !== o.id)).visible)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const spotter of candidates) {
    const others = all.filter((o) => o.id !== spotter.id && o.id !== target.id);
    const view = canBeTargeted(spotter, target, terrain, others, { seek: seekMode(weapon) });
    if (!view.ok) continue;
    if (direct.ok && view.sight.cover) continue; // no better than looking ourselves
    return { sight: view.sight, operative: spotter, def };
  }
  return null;
}

/** The friendly operative a `friendlyPrimaryTarget` rule fires through. */
function friendlyBearer(state, attacker, directed) {
  const keyword = directed.def.effect.keyword;
  return liveOperatives(state, attacker.playerId).find((o) => {
    const profile = getProfile(state, o);
    return (profile.keywords || []).includes(keyword);
  }) || null;
}

/**
 * Resolve a shooting attack. Mutates state; returns a structured result for
 * the log/UI. The RNG stream position is advanced on `state.rng`.
 *
 * One Shoot action can be many attack sequences. Salvo and Twin Torrent give
 * it two *primary* targets; Blast and Torrent add secondaries around each of
 * them; Hot burns the shooter once after them all.
 */
export function resolveShoot(state, attackerId, targetId, weaponId) {
  const attacker = state.operatives[attackerId];
  const target = state.operatives[targetId];
  const weapon = findWeapon(state, attacker, weaponId);
  if (!weapon) return { ok: false, reason: `unknown weapon ${weaponId}` };

  const check = canShoot(state, attackerId, targetId, weapon);
  if (!check.ok) return { ok: false, reason: check.reason };

  validateWeaponRules(state, weapon, attacker);
  noteTeamRuleUse(state, attacker, weapon);

  // Rules that read what an operative was carrying "at the start of that
  // action" — Toxic — must not see tokens this very action hangs on it.
  const tokensAtStart = snapshotTokens(liveOperatives(state));

  // Every target is selected before any dice are rolled, so a Blast that kills
  // its primary still catches the operatives standing next to it — and a
  // Limited weapon can still see the board while choosing them.
  const plan = planTargets(state, attacker, target, weapon, check);

  // The weapon is spent whether or not anything is hit, so count it here.
  noteWeaponUse(attacker, weapon);

  const rng = Rng.fromState(state.rng);
  const opts = { tokensAtStart, counteraction: attacker.inCounteraction === true };

  const primaries = [];
  for (const pick of plan.primaries) {
    if (!pick.shoot) continue;
    if (!pick.operative.alive) continue;
    if (pick.rule) {
      logEvent(state, EVENTS.RULE_APPLIED, {
        ruleId: `weapon-rule:${pick.rule.name}`,
        rule: pick.rule.rule || pick.rule.name,
        operativeId: attacker.id, operativeName: attacker.name, playerId: attacker.playerId,
        detail: `${weapon.name} is resolved against ${pick.operative.name}`,
      });
    }
    primaries.push(resolveSequence(state, rng, attacker, pick.operative, weapon, {
      ...opts, inCover: pick.inCover, range: pick.range ?? null, spotter: pick.spotter || null,
    }));
  }

  const secondary = [];
  for (const pick of plan.secondaries) {
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
      ...opts, inCover: pick.inCover, splash: pick.rule,
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

  // The first primary keeps the shape the log, UI and tests already read; the
  // extras a Salvo picked up ride along in `primaries` and `secondary`.
  const lead = primaries[0] || null;
  const extras = [...primaries.slice(1), ...secondary];

  return {
    ok: true,
    attack: lead?.attack ?? null,
    defence: lead?.defence ?? null,
    inCover: lead?.inCover ?? false,
    damage: lead?.damage ?? 0,
    incapacitated: lead?.incapacitated ?? false,
    weaponName: weapon.name,
    primaries,
    secondary: extras,
    hot,
    totalDamage: primaries.reduce((sum, s) => sum + s.damage, 0) +
      secondary.reduce((sum, s) => sum + s.damage, 0),
  };
}

/**
 * One attack sequence: attack dice, defence dice, saves, damage.
 * Shared by every primary and every Blast/Torrent secondary.
 */
function resolveSequence(state, rng, attacker, target, weapon, opts = {}) {
  const {
    inCover = false, range = null, splash = null,
    tokensAtStart = null, counteraction = false, spotter = null,
  } = opts;

  // Attacker-side faction rules may add weapon rules for this sequence only,
  // and so may this team's own asterisked rules — Bipod's Ceaseless when the
  // operative stood still, Force Impact's Brutal after a charge.
  const hooked = applyAttackHooks(state, attacker, weapon, { target, action: 'shoot' });
  const adjustments = weaponAdjustments(state, attacker, weapon,
    { counteraction, target, action: 'shoot' });
  if (spotter) {
    for (const rule of spotter.def.effect.grantRules || []) {
      if (!adjustments.rules.includes(rule)) adjustments.rules.push(rule);
    }
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: `weapon-rule:${spotter.def.name}`,
      rule: spotter.def.rule || spotter.def.name,
      operativeId: attacker.id, operativeName: attacker.name, playerId: attacker.playerId,
      detail: `sights ${target.name} through ${spotter.operative.name}`,
    });
  }
  const attackWeapon = withAdjustments(hooked, adjustments);

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
  const soulstrike = aplDefenceRule(state, attacker, weapon);
  const defence = rollDefence(rng, target, def.weapon, {
    inCover, attackCrits: attack.crits, diceDelta: def.diceDelta, rerolls: def.rerolls,
    aplDefence: soulstrike ? { apl: effectiveApl(target) } : null,
  });
  if (soulstrike) notePartialTeamRule(state, soulstrike);
  logEvent(state, EVENTS.DEFENCE_ROLLED, {
    operativeId: target.id, operativeName: target.name,
    rolls: defence.rolls, rerolled: defence.rerolled, saveOn: defence.saveOn,
    normals: defence.normals, crits: defence.crits,
    inCover, coverSave: defence.coverSave,
    aplDefence: defence.aplDefence,
  });

  const damageBonus = damageBonusVsToken(state, attacker, weapon, target, tokensAtStart);
  const outcome = resolveSaves(attack, defence, attackWeapon, { damageBonus });

  // Drag hauls the target in at the *start* of the Resolve Attack Dice step,
  // before a point of damage is inflicted.
  applyDrag(state, attacker, target, weapon, outcome);
  if (damageBonus.normal || damageBonus.critical) {
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: 'weapon-rule:damage-bonus',
      rule: 'Toxic',
      operativeId: target.id, operativeName: target.name, playerId: target.playerId,
      detail: `${weapon.name} hits harder against a poisoned target (+${damageBonus.normal}/+${damageBonus.critical})`,
    });
  }
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

  // Everything that keys off the *result* of the sequence resolves here, in
  // printed order: tokens hang on survivors, Beam burns down the line, and a
  // Stinger death sprays whoever was standing too close.
  applyTokenRules(state, attacker, target, weapon, { outcome, result });
  applyHealOnDamage(state, rng, attacker, weapon, attack, outcome);
  const beam = applyBeam(state, rng, attacker, target, weapon, attack);
  if (!result.incapacitated) {
    applyExecuteRoll(state, rng, attacker, target, weapon, { attack, outcome });
  }
  const killed = result.incapacitated || !target.alive;
  if (killed) applyKillReward(state, rng, attacker, weapon);
  const chain = killed
    ? applyChainOnIncapacitate(state, rng, attacker, target, weapon)
    : null;
  applyResourceGain(state, attacker, weapon, outcome);

  return {
    targetId: target.id,
    targetName: target.name,
    attack, defence, inCover,
    damage: outcome.damage,
    incapacitated: result.incapacitated,
    splash, beam, chain,
  };
}

/* ------------------------------------------------------------------ */
/* Token-inflicting rules                                              */
/* ------------------------------------------------------------------ */

/**
 * Poison, Blaze, Terrorchem, Neutron Fragment, Mindburn, Humbling Cruelty and
 * Flay all hang a token on something as a side effect of the sequence. Which
 * sequences qualify differs — some want damage from any success, some only
 * from a critical, some only care that dice were resolved and the target lived
 * — so the pack declares the trigger and this decides whether it fired.
 */
export function applyTokenRules(state, attacker, target, weapon, { outcome, result }) {
  const def = teamRuleEffect(state, attacker, weapon, 'inflictToken');
  if (!def) return;
  const effect = def.effect;
  notePartialTeamRule(state, def);

  if (!tokenTriggerFired(effect.trigger, outcome, result)) return;

  const recipient = effect.target === 'friendly'
    ? nearestFriend(state, attacker, effect.within)
    : target;
  if (!recipient) return;

  // "excluding friendly PLAGUE MARINE operatives" and its cousins.
  if (effect.excludeKeyword) {
    const profile = getProfile(state, recipient);
    if ((profile.keywords || []).includes(effect.excludeKeyword)) return;
  }

  grantToken(state, recipient, effect.token, {
    owner: attacker.playerId,
    rule: def.name,
    source: { weapon: weapon.name, attackerId: attacker.id },
  });
}

function tokenTriggerFired(trigger, outcome, result) {
  const damaged = (outcome?.damage || 0) > 0;
  switch (trigger) {
    case 'criticalSuccess':
      // Damage that got through off a critical — Devastating counts, which is
      // why Terrorchem's vial works at all: its Normal damage is 0.
      return damaged && (outcome.unsavedCrits > 0 || outcome.devastatingDamage > 0);
    case 'anyDiceResolved':
      return damaged && !result?.incapacitated;
    case 'anySuccess':
    default:
      return damaged;
  }
}

/** Flay hands its token to a friend, not the victim. */
function nearestFriend(state, attacker, within) {
  const radius = Number(within) || Infinity;
  const friends = liveOperatives(state, attacker.playerId)
    .filter((o) => o.id !== attacker.id && baseDistance(attacker, o) <= radius)
    .sort((a, b) => baseDistance(attacker, a) - baseDistance(attacker, b) ||
      (a.id < b.id ? -1 : 1));
  return friends[0] || attacker;
}

/* ------------------------------------------------------------------ */
/* Rewards, executions and shoving                                     */
/* ------------------------------------------------------------------ */

/**
 * Siphon Life: a nearby friend drinks what the weapon spills — 1 wound back
 * per damaging normal success, D3 per critical, once per turning point.
 */
function applyHealOnDamage(state, rng, attacker, weapon, attack, outcome) {
  const def = teamRuleEffect(state, attacker, weapon, 'healOnDamage');
  if (!def || outcome.damage <= 0) return;
  const effect = def.effect;

  if (effect.oncePerTurningPoint) {
    if (attacker.ruleUsedInTurningPoint?.[def.name] === state.turningPoint) return;
    if (!attacker.ruleUsedInTurningPoint) attacker.ruleUsedInTurningPoint = {};
    attacker.ruleUsedInTurningPoint[def.name] = state.turningPoint;
  }

  const within = Number(effect.within) || Infinity;
  const beneficiary = liveOperatives(state, attacker.playerId)
    .filter((o) => (effect.keyword
      ? (getProfile(state, o).keywords || []).includes(effect.keyword) : true))
    .filter((o) => o.woundsRemaining < o.wounds && baseDistance(attacker, o) <= within)
    .sort((a, b) => (b.wounds - b.woundsRemaining) - (a.wounds - a.woundsRemaining) ||
      (a.id < b.id ? -1 : 1))[0];
  if (!beneficiary) return;

  let healed = 0;
  for (let i = 0; i < outcome.unsavedNormals; i++) healed += rollExpression(rng, effect.perNormal || '1');
  for (let i = 0; i < outcome.unsavedCrits; i++) healed += rollExpression(rng, effect.perCritical || 'D3');
  healed = Math.min(healed, beneficiary.wounds - beneficiary.woundsRemaining);
  if (healed <= 0) return;

  beneficiary.woundsRemaining += healed;
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: `weapon-rule:${def.name}`,
    rule: def.rule || def.name,
    operativeId: beneficiary.id, operativeName: beneficiary.name, playerId: beneficiary.playerId,
    detail: `siphons ${healed} lost wound(s) back from ${weapon.name}`,
  });
}

/**
 * Dimensional Banishment: a target that survived is rolled for anyway, and a
 * high enough result folds it out of the killzone entirely.
 */
function applyExecuteRoll(state, rng, attacker, target, weapon, { attack, outcome }) {
  const def = teamRuleEffect(state, attacker, weapon, 'executeRoll');
  if (!def || !target.alive) return;
  if (outcome.damage <= 0 && attack.crits <= 0) return;

  const rolled = rollExpression(rng, def.effect.dice || '2D6');
  const beat = target.woundsRemaining;
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: `weapon-rule:${def.name}`,
    rule: def.rule || def.name,
    operativeId: target.id, operativeName: target.name, playerId: target.playerId,
    detail: rolled > beat
      ? `is banished (rolled ${rolled} against ${beat} remaining wounds)`
      : `holds together (rolled ${rolled} against ${beat} remaining wounds)`,
  });
  if (rolled > beat) applyDamage(state, target.id, target.woundsRemaining, {
    kind: 'banishment', attackerId: attacker.id, weapon: weapon.name,
  });
}

/**
 * Headtaker: a kill feeds the killer — wounds back now, and a skullcleaver
 * that bites deeper for the rest of the battle, capped as printed.
 */
export function applyKillReward(state, rng, attacker, weapon) {
  const def = teamRuleEffect(state, attacker, weapon, 'onIncapacitate');
  if (!def) return;
  const effect = def.effect;
  const rolled = rollExpression(rng, effect.dice || 'D3');
  if (rolled <= 0) return;

  const parts = [];
  if (effect.heal) {
    const healed = Math.min(rolled, attacker.wounds - attacker.woundsRemaining);
    if (healed > 0) {
      attacker.woundsRemaining += healed;
      parts.push(`regains ${healed} lost wound(s)`);
    }
  }
  if (effect.weaponCriticalBonus) {
    if (!attacker.weaponMods) attacker.weaponMods = {};
    const mod = attacker.weaponMods[weapon.id] || { normal: 0, critical: 0 };
    const cap = Number(effect.weaponCriticalBonus.max) || Infinity;
    const before = mod.critical;
    mod.critical = Math.min(cap - weapon.damage.critical, mod.critical + rolled);
    mod.critical = Math.max(0, mod.critical);
    attacker.weaponMods[weapon.id] = mod;
    if (mod.critical !== before) {
      parts.push(`${weapon.name} Critical Dmg now ${weapon.damage.critical + mod.critical}`);
    }
  }
  if (!parts.length) return;

  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: `weapon-rule:${def.name}`,
    rule: def.rule || def.name,
    operativeId: attacker.id, operativeName: attacker.name, playerId: attacker.playerId,
    detail: `${parts.join('; ')} (rolled ${rolled})`,
  });
}

/**
 * Drag: haul the target 2" per unblocked success towards the shooter.
 *
 * The printed rule also lets you discard successes afterwards, to pull an
 * operative in without killing it. The engine never does — it takes the full
 * drag and the full damage, which is the simple reading and is documented.
 */
function applyDrag(state, attacker, target, weapon, outcome) {
  const def = teamRuleEffect(state, attacker, weapon, 'dragTarget');
  if (!def) return;
  notePartialTeamRule(state, def);

  const successes = outcome.unsavedNormals + outcome.unsavedCrits;
  const distance = successes * (Number(def.effect.perSuccess) || 2);
  if (distance <= 0) return;

  const from = { x: target.x, y: target.y };
  let moved = 0;
  // Walk it in whole inches, stopping at the last spot it can legally stand.
  for (let step = 1; step <= distance; step++) {
    const next = stepToward(target, attacker, 1);
    if (!isPositionLegal(state, target.id, next.x, next.y).ok) break;
    target.x = next.x; target.y = next.y;
    moved = step;
    if (baseDistance(target, attacker) <= 0) break;
  }
  if (!moved) return;

  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: `weapon-rule:${def.name}`,
    rule: def.rule || def.name,
    operativeId: target.id, operativeName: target.name, playerId: target.playerId,
    detail: `is dragged ${moved}" towards ${attacker.name}`,
    from, to: { x: target.x, y: target.y },
  });
}

/**
 * Blood Offering, Ritual: the weapon feeds a team resource track. The engine
 * counts it so the log is honest about what was earned, but nothing spends it
 * — the ploys and abilities that would are not implemented.
 */
export function applyResourceGain(state, attacker, weapon, outcome) {
  const def = teamRuleEffect(state, attacker, weapon, 'gainResource');
  if (!def) return;
  notePartialTeamRule(state, def);
  const effect = def.effect;
  const fired = effect.trigger === 'criticalSuccess'
    ? outcome.unsavedCrits > 0
    : outcome.damage > 0;
  if (!fired) return;

  const holder = effect.scope === 'operative' ? attacker : state.players[attacker.playerId];
  if (!holder.resources) holder.resources = {};
  holder.resources[effect.resource] = (holder.resources[effect.resource] || 0) + 1;

  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: `weapon-rule:${def.name}`,
    rule: def.rule || def.name,
    operativeId: attacker.id, operativeName: attacker.name, playerId: attacker.playerId,
    detail: `gains 1 ${effect.resource} (now ${holder.resources[effect.resource]})`,
  });
}

/* ------------------------------------------------------------------ */
/* Beam                                                                */
/* ------------------------------------------------------------------ */

/**
 * Beam: each retained critical burns everyone standing behind the target.
 *
 * The printed rule lets the attacker pick "one (and only one) beam line". The
 * engine picks the line that catches the most enemies, breaking ties on the
 * lowest operative id so a replay is identical — a real player would weigh it
 * the same way most of the time, and the choice has to be deterministic.
 */
function applyBeam(state, rng, attacker, target, weapon, attack) {
  const def = teamRuleEffect(state, attacker, weapon, 'beamLine');
  if (!def || attack.crits <= 0) return null;
  notePartialTeamRule(state, def);

  const line = chooseBeamLine(state, attacker, target);
  if (!line.length) return null;

  const hits = [];
  for (const op of line) {
    if (!op.alive) continue;
    let total = 0;
    for (let i = 0; i < attack.crits; i++) total += rollExpression(rng, def.effect.damage || 'D3');
    if (total <= 0) continue;
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: `weapon-rule:${def.name}`,
      rule: def.rule || def.name,
      operativeId: op.id, operativeName: op.name, playerId: op.playerId,
      detail: `caught in the beam behind ${target.name}: ${total} damage`,
    });
    applyDamage(state, op.id, total, { kind: 'beam', attackerId: attacker.id, weapon: weapon.name });
    hits.push({ operativeId: op.id, damage: total });
  }
  return hits.length ? hits : null;
}

/** Operatives on the best single line from the shooter through the target. */
function chooseBeamLine(state, attacker, target) {
  const terrain = (state.map.terrain || []).filter((t) => !(t.traits || []).includes('light'));
  const candidates = liveOperatives(state)
    .filter((o) => o.id !== attacker.id && o.id !== target.id)
    .filter((o) => onBeamLine(attacker, target, o, terrain));

  let best = [];
  let bestScore = -1;
  for (const anchor of candidates) {
    const group = candidates.filter((o) => sharesBeam(attacker, anchor, o));
    const score = group.filter((o) => o.playerId !== attacker.playerId).length * 2 - group.length;
    if (score > bestScore || (score === bestScore && best[0] && anchor.id < best[0].id)) {
      bestScore = score;
      best = group.sort((a, b) => (a.id < b.id ? -1 : 1));
    }
  }
  return best;
}

/** A targeting line to `op` that crosses the target's base and no Heavy terrain. */
function onBeamLine(attacker, target, op, terrain) {
  const a = { x: attacker.x, y: attacker.y };
  const b = { x: op.x, y: op.y };
  const crossesTarget =
    pointSegmentDistance(target.x, target.y, a.x, a.y, b.x, b.y) <= target.baseDiameter / 2;
  if (!crossesTarget) return false;
  // The beam must reach past the target, not stop short of it.
  if (baseDistance(attacker, op) < baseDistance(attacker, target)) return false;
  return !terrain.some((piece) => segmentIntersectsPolygon(a, b, piece.shape.points));
}

/** Whether `op` also stands on the line drawn from the shooter to `anchor`. */
function sharesBeam(attacker, anchor, op) {
  if (op.id === anchor.id) return true;
  return pointSegmentDistance(op.x, op.y, attacker.x, attacker.y, anchor.x, anchor.y)
    <= op.baseDiameter / 2;
}

/* ------------------------------------------------------------------ */
/* Chain damage on an incapacitation                                   */
/* ------------------------------------------------------------------ */

/**
 * Stinger: whoever this weapon kills bursts, and anything it kills bursts too.
 * The loop is bounded by the number of operatives on the board, so a chain
 * across a huddled team terminates.
 */
function applyChainOnIncapacitate(state, rng, attacker, victim, weapon) {
  const def = teamRuleEffect(state, attacker, weapon, 'chainOnIncapacitate');
  if (!def) return null;
  notePartialTeamRule(state, def);

  const radius = Number(def.effect.range) || 0;
  const dice = def.effect.damage || 'D3';
  const bursts = [];
  const queue = [victim];
  const seen = new Set([victim.id]);

  while (queue.length) {
    const centre = queue.shift();
    const terrain = state.map.terrain || [];
    for (const op of liveOperatives(state)) {
      if (op.id === centre.id || baseDistance(op, centre) > radius) continue;
      const bystanders = liveOperatives(state).filter((o) => o.id !== op.id && o.id !== centre.id);
      if (!traceSight(centre, op, terrain, bystanders).visible) continue;
      const amount = rollExpression(rng, dice);
      logEvent(state, EVENTS.RULE_APPLIED, {
        ruleId: `weapon-rule:${def.name}`,
        rule: def.rule || def.name,
        operativeId: op.id, operativeName: op.name, playerId: op.playerId,
        detail: `caught by ${centre.name} bursting: ${amount} damage`,
      });
      const res = applyDamage(state, op.id, amount, {
        kind: 'chain', attackerId: attacker.id, weapon: weapon.name,
      });
      bursts.push({ operativeId: op.id, damage: amount });
      if (res.incapacitated && !seen.has(op.id)) {
        seen.add(op.id);
        queue.push(op);
      }
    }
  }
  return bursts.length ? bursts : null;
}

/* ------------------------------------------------------------------ */
/* Target selection                                                    */
/* ------------------------------------------------------------------ */

/**
 * Everyone one Shoot action resolves against, chosen before any dice are cast.
 *
 * @returns {{primaries:Array, secondaries:Array}}
 */
function planTargets(state, attacker, requested, weapon, check) {
  const primaries = [];
  const directed = check.directed || selfDirectedRule(state, attacker, weapon);

  if (directed?.kind === 'self') {
    // Explosive detonates on the operative itself; Wreathed uses it only as
    // the centre of the blast and leaves it unharmed.
    primaries.push({
      operative: attacker,
      inCover: false,
      range: 0,
      shoot: directed.def.effect.shootSelf !== false,
      rule: directed.def,
    });
  } else if (directed?.kind === 'friendly') {
    const bearer = friendlyBearer(state, attacker, directed);
    primaries.push({
      operative: bearer, inCover: false, shoot: true, rule: directed.def,
    });
  } else {
    primaries.push({
      operative: requested, inCover: check.sight.cover, range: check.range, shoot: true,
      spotter: check.spotter || null,
    });
    for (const extra of extraPrimaries(state, attacker, requested, weapon)) {
      primaries.push(extra);
    }
  }

  // Secondaries are measured from each primary in turn — a Salvo of blast
  // pistols sprays around both of them — and nobody is shot twice.
  const claimed = new Set(primaries.map((p) => p.operative?.id).filter(Boolean));
  const secondaries = [];
  for (const primary of primaries) {
    if (!primary.operative) continue;
    for (const pick of secondaryTargets(state, attacker, primary.operative, weapon, primary.inCover)) {
      if (claimed.has(pick.operative.id)) continue;
      claimed.add(pick.operative.id);
      secondaries.push(pick);
    }
  }

  return { primaries: primaries.filter((p) => p.operative), secondaries };
}

/**
 * Salvo and Twin Torrent: "select up to two different valid targets that
 * aren't within control range of friendly operatives".
 *
 * The second target is the player's choice; the engine takes the nearest legal
 * one, breaking ties on operative id so a replay never diverges.
 */
function extraPrimaries(state, attacker, requested, weapon) {
  const def = teamRuleEffect(state, attacker, weapon, 'extraPrimaryTargets');
  if (!def) return [];
  const wanted = (Number(def.effect.count) || 2) - 1;
  if (wanted <= 0) return [];

  const friends = liveOperatives(state, attacker.playerId);
  const options = liveOperatives(state)
    .filter((o) => o.playerId !== attacker.playerId && o.id !== requested.id)
    .filter((o) => !friends.some((f) => withinControlRange(f, o)))
    .map((o) => ({ op: o, check: canShoot(state, attacker.id, o.id, weapon) }))
    .filter((entry) => entry.check.ok)
    .sort((a, b) => (a.check.range - b.check.range) || (a.op.id < b.op.id ? -1 : 1));

  return options.slice(0, wanted).map((entry) => ({
    operative: entry.op,
    inCover: entry.check.sight.cover,
    range: entry.check.range,
    shoot: true,
    rule: def,
  }));
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

/** True when this operative carries no weapon at all and can never attack. */
export function isNonCombatant(state, operative) {
  return getProfile(state, operative).weapons.length === 0;
}

/**
 * Ranged weapons this operative could still use right now.
 * Heavy, Limited and the team-specific gates (Concealed Position, Aimed, and
 * the weapons the engine refuses outright) are all applied here.
 */
export function usableRangedWeapons(state, operative) {
  return rangedWeapons(state, operative).filter(
    (w) => !limitedExhausted(operative, w) &&
      !heavyShootBlocker(w, operative.usedThisActivation) &&
      !teamRuleBlocker(state, operative, w, {
        counteraction: operative.inCounteraction === true,
      })
  );
}

/** Ranged weapons that pick their own target rather than being aimed. */
export function selfDirectedWeapon(state, operative, weapon) {
  return selfDirectedRule(state, operative, weapon);
}
