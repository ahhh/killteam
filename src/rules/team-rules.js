/**
 * Team-specific weapon rules — the ones printed with an asterisk.
 *
 * The universal appendix rules in `dice.js` and `weapon-rules.js` mean the
 * same thing on every datasheet, so the engine can own them outright. The
 * asterisked ones cannot: "Poison" inflicts 1 damage per activation for Plague
 * Marines and D3 for Raveners, and "Detonate" is three different rules on
 * three different teams. Hard-coding one of those readings would silently make
 * the other teams wrong.
 *
 * So a pack declares what its own asterisked rules do, in a `weaponRules`
 * section, choosing from the fixed effect vocabulary below. It is data in
 * exactly the way `ruleHooks` is data (§34): nothing here is evaluated, and an
 * effect type the engine doesn't know is reported and ignored, never guessed.
 *
 *   "weaponRules": {
 *     "poison": {
 *       "rule": "Poison",
 *       "text": "…the printed wording…",
 *       "effect": { "type": "inflictToken", "trigger": "anySuccess", … }
 *     }
 *   }
 *
 * `text` is the printed wording, kept for the same reason `rulesText` is kept
 * on a weapon: a reader can check the engine against the page.
 */
import { warnUnsupported } from '../state.js';
import { parseRule, ruleMap } from './dice.js';
import { CONTROL_RANGE } from './visibility.js';
import { pointPolygonDistance, baseDistance } from '../maps/geometry.js';
import { tokenWeaponRules } from './tokens.js';
import { resourceWeaponBoosts } from './resources.js';

/** Effect types the engine knows how to apply. Anything else fails closed. */
export const TEAM_RULE_EFFECTS = {
  inflictToken: 'Hang a token on the operative this weapon was used against.',
  damageBonusVsToken: 'Add to both Dmg stats against an operative holding a token.',
  aplDefence: "Defence dice succeed on results at or under the target's APL.",
  firstShootActionOnly: 'Usable only on the first Shoot action of the battle.',
  moveLimit: 'Cannot be used in an activation that moved more than x", and vice versa.',
  grantRuleIf: 'Add weapon rules or Atk/Dmg when a condition holds.',
  fixedUpgrade: 'A loadout choice made before the battle, applied for the whole battle.',
  meleeModifier: 'Change how the fight sequence resolves for this weapon.',
  extraPrimaryTargets: 'Select more than one primary target for one Shoot action.',
  selfPrimaryTarget: 'This operative is the primary target — the weapon goes off in its hands.',
  friendlyPrimaryTarget: 'A named friendly operative is the primary target.',
  spotterTargeting: 'Target, cover and obscured are measured from a friendly spotter.',
  chainOnIncapacitate: 'Damage everyone near an operative this weapon incapacitates.',
  beamLine: 'Each retained critical also burns everyone behind the target.',
  healOnDamage: 'A friendly operative regains wounds for each damaging attack die.',
  executeRoll: 'A roll after the sequence can finish off a target that survived.',
  onIncapacitate: 'The wielder is rewarded for a kill — wounds back, or a lasting buff.',
  dragTarget: 'Haul the target towards the shooter before damage is inflicted.',
  retaliationRoll: 'A fighter that survived being hurt rolls to hurt its attacker back.',
  gainResource: 'Feed a team resource economy — see rules/resources.js.',
  recognised: 'The engine knows this rule and deliberately does nothing for it.',
  unusable: 'The weapon needs a subsystem this engine does not have, so it never fires.',
};

/** Where an `inflictToken` rule looks to decide whether the token lands. */
export const TOKEN_TRIGGERS = [
  'anySuccess',        // damage inflicted by any retained success
  'criticalSuccess',   // damage inflicted by a retained critical
  'anyDiceResolved',   // attack dice resolved and the target survived
];

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

/** The `weaponRules` block of the pack this operative belongs to. */
export function packRuleDefs(state, op) {
  return state.teamPacks?.[op?.playerId]?.weaponRules || {};
}

/**
 * The declaration for one rule token, or null if this operative's pack does
 * not define it. Values and qualifiers are stripped, so `wreathed1` finds the
 * `wreathed` declaration the way `piercing2` finds `piercing`.
 */
export function teamRuleDef(state, op, ruleToken) {
  const { name } = parseRule(ruleToken);
  const def = packRuleDefs(state, op)[name];
  if (!def) return null;
  return { name, ...def };
}

/**
 * Every declared team rule carried by this weapon, in the order printed.
 * Undeclared tokens are skipped here and reported by `validateWeaponRules`.
 */
export function teamRulesOn(state, op, weapon) {
  const out = [];
  for (const token of weapon?.rules || []) {
    const def = teamRuleDef(state, op, token);
    if (def) out.push({ ...def, token });
  }
  return out;
}

/**
 * The first declared effect of `type` on this weapon, or null.
 *
 * Most rules are alone in their slot — one weapon never carries two Poisons —
 * so "first match wins" is enough, and keeps callers free of array handling.
 */
export function teamRuleEffect(state, op, weapon, type) {
  for (const def of teamRulesOn(state, op, weapon)) {
    if (def.effect?.type === type) return def;
  }
  return null;
}

/** Every declared effect of `type`, for the rules that can legitimately stack. */
export function teamRuleEffects(state, op, weapon, type) {
  return teamRulesOn(state, op, weapon).filter((d) => d.effect?.type === type);
}

/**
 * True if this rule token is one the operative's pack declares and the engine
 * implements. `validateWeaponRules` uses it to decide what to warn about.
 */
export function isDeclaredTeamRule(state, op, ruleToken) {
  const def = teamRuleDef(state, op, ruleToken);
  return Boolean(def && TEAM_RULE_EFFECTS[def.effect?.type]);
}

/**
 * Raise a pack's `partial` note once per battle, so a rule that is only half
 * simulated says so in the warnings rather than implying full fidelity.
 */
export function notePartialTeamRule(state, def) {
  if (!def?.partial) return;
  warnUnsupported(state, `weapon-rule-partial:${def.name}`,
    `${def.rule || def.name}: ${def.notes || 'only partly simulated'}`);
}

/* ------------------------------------------------------------------ */
/* Eligibility: may this weapon be used at all?                        */
/* ------------------------------------------------------------------ */

/**
 * Why a team-specific rule forbids using this weapon right now, or null.
 *
 * Covers the three shapes that gate a weapon rather than change its dice:
 * Concealed Position (one shot, ever), Aimed (a movement budget both ways),
 * and the rules the engine deliberately refuses because they need a subsystem
 * it does not have.
 */
export function teamRuleBlocker(state, op, weapon, { counteraction = false } = {}) {
  for (const def of teamRulesOn(state, op, weapon)) {
    const effect = def.effect || {};
    const label = def.rule || def.name;

    if (effect.type === 'unusable') {
      return `${label}: ${effect.reason || 'not simulated by this engine'}`;
    }

    if (effect.type === 'firstShootActionOnly' && (op.shootActionsTaken || 0) > 0) {
      return `${label}: only on this operative's first Shoot action of the battle`;
    }

    if (effect.type === 'moveLimit') {
      const limit = Number(effect.inches) || 0;
      if (!counteraction && (op.distanceMovedThisActivation || 0) > limit + 1e-9) {
        return `${label}: already moved more than ${limit}" this activation`;
      }
    }
  }
  return null;
}

/**
 * The movement budget this weapon will impose once it has been fired, in
 * inches, or null if it imposes none. The AI needs this up front: a plan that
 * shoots and *then* moves has to size the move against the budget the shot
 * leaves behind, not the one it had before pulling the trigger.
 */
export function weaponMoveLimit(state, op, weapon) {
  let limit = null;
  for (const def of teamRulesOn(state, op, weapon)) {
    if (def.effect?.type !== 'moveLimit') continue;
    const inches = Number(def.effect.inches) || 0;
    limit = limit === null ? inches : Math.min(limit, inches);
  }
  return limit;
}

/**
 * The tightest movement budget any Aimed-shaped rule leaves this operative
 * for the rest of the activation, or null when nothing constrains it.
 */
export function moveLimitAfterUse(op) {
  return op?.moveLimitThisActivation ?? null;
}

/** Record that a weapon with a movement budget has been fired. */
export function noteTeamRuleUse(state, op, weapon) {
  for (const def of teamRulesOn(state, op, weapon)) {
    const effect = def.effect || {};
    notePartialTeamRule(state, def);
    if (effect.type === 'moveLimit') {
      const limit = Number(effect.inches) || 0;
      const current = op.moveLimitThisActivation;
      op.moveLimitThisActivation = current === null || current === undefined
        ? limit
        : Math.min(current, limit);
      op.moveLimitRule = def.rule || def.name;
    }
  }
}

/**
 * Why a movement budget forbids moving `distance"` further, or null.
 * The budget counts the whole activation, so two short moves add up.
 */
export function moveLimitBlocker(op, distance) {
  const limit = moveLimitAfterUse(op);
  if (limit === null) return null;
  const already = op.distanceMovedThisActivation || 0;
  if (already + distance <= limit + 1e-9) return null;
  return `${op.moveLimitRule || 'Aimed'}: may move at most ${limit}" in an activation it used this weapon`;
}

/* ------------------------------------------------------------------ */
/* Dice-facing helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Everything a team rule changes about the weapon profile for this sequence:
 * extra universal rules (Bipod's Ceaseless, Force Impact's Brutal), extra
 * attack dice (Feast) and better Dmg stats (Anti-PSYKER on a Novitiate).
 *
 * The pack's own profile is never mutated — this returns the deltas, and the
 * caller folds them into a copy.
 *
 * @returns {{rules:string[], atk:number, normal:number, critical:number}}
 */
export function weaponAdjustments(state, op, weapon, ctx = {}) {
  const out = { rules: [], atk: 0, normal: 0, critical: 0 };

  const fold = (effect) => {
    for (const rule of effect.rules || []) {
      if (!(weapon.rules || []).includes(rule) && !out.rules.includes(rule)) out.rules.push(rule);
    }
    out.atk += Number(effect.atkBonus) || 0;
    out.normal += Number(effect.damageNormal) || 0;
    out.critical += Number(effect.damageCritical) || 0;
  };

  // A loadout picked before the battle applies unconditionally, all battle.
  for (const def of teamRuleEffects(state, op, weapon, 'fixedUpgrade')) {
    notePartialTeamRule(state, def);
    fold(def.effect);
  }
  for (const def of teamRuleEffects(state, op, weapon, 'grantRuleIf')) {
    if (!grantConditionHolds(state, op, def.effect, ctx)) continue;
    notePartialTeamRule(state, def);
    fold(def.effect);
  }

  // A token the operative is *holding* can improve its weapons too — a
  // Blooded token is Accurate 1 for as long as it is carried.
  for (const rule of tokenWeaponRules(op, weapon)) fold({ rules: [rule] });

  // …and so can something bought with a team resource for this one action:
  // Rage adds an attack die to the Fight it was spent on.
  for (const boost of resourceWeaponBoosts(op, weapon, ctx.action)) fold(boost);

  // Headtaker's skullcleaver keeps the Critical Dmg it has earned.
  const earned = op.weaponMods?.[weapon.id];
  if (earned) {
    out.normal += earned.normal || 0;
    out.critical += earned.critical || 0;
  }
  return out;
}

/** Apply the deltas above to a weapon, returning a copy for this sequence. */
export function withAdjustments(weapon, adjustments) {
  if (!adjustments) return weapon;
  const { rules, atk, normal, critical } = adjustments;
  if (!rules.length && !atk && !normal && !critical) return weapon;
  return {
    ...weapon,
    rules: rules.length ? [...(weapon.rules || []), ...rules] : weapon.rules,
    atk: Math.max(0, weapon.atk + atk),
    damage: {
      normal: Math.max(0, weapon.damage.normal + normal),
      critical: Math.max(0, weapon.damage.critical + critical),
    },
  };
}

/** Backwards-compatible view for callers that only want the rule tokens. */
export function grantedRules(state, op, weapon, ctx = {}) {
  return weaponAdjustments(state, op, weapon, ctx).rules;
}

function grantConditionHolds(state, op, effect, ctx) {
  const used = op.usedThisActivation || [];
  if (effect.action && effect.action !== ctx.action) return false;
  if (effect.performedThisActivation &&
      !effect.performedThisActivation.every((a) => used.includes(a))) return false;
  if (effect.notMovedThisActivation) {
    const moved = (op.distanceMovedThisActivation || 0) > 0;
    // "…or if it's a counteraction": a counteraction has no prior move to undo.
    if (moved && !(effect.orCounteraction && ctx.counteraction)) return false;
  }
  if (effect.targetKeyword) {
    const profile = ctx.target ? profileOfOperative(state, ctx.target) : null;
    if (!(profile?.keywords || []).includes(effect.targetKeyword)) return false;
  }
  // "a wounded operative" is one that has lost any wounds at all — not the
  // same thing as Injured, which is half or fewer.
  if (effect.targetWounded &&
      !(ctx.target && ctx.target.woundsRemaining < ctx.target.wounds)) return false;
  // "an expended operative" is one that has already been activated.
  if (effect.targetExpended && !ctx.target?.activatedThisTurningPoint) return false;
  // "if the target is within x" of it" — Get Some! only re-rolls up close.
  if (effect.targetWithin !== undefined) {
    if (!ctx.target) return false;
    if (baseDistance(op, ctx.target) > Number(effect.targetWithin)) return false;
  }
  if (effect.terrainWithinControlRange && !terrainInControlRange(state, op)) return false;
  return true;
}

function profileOfOperative(state, op) {
  const pack = state.teamPacks?.[op.playerId];
  return pack?.operatives.find((o) => o.id === op.profileId) || null;
}

/** Stalk: is any piece of terrain close enough to fight from cover? */
function terrainInControlRange(state, op) {
  const reach = CONTROL_RANGE + op.baseDiameter / 2;
  return (state.map.terrain || []).some(
    (piece) => pointPolygonDistance(op.x, op.y, piece.shape.points) <= reach
  );
}

/**
 * Extra damage from a rule that keys off a token the target is holding —
 * Toxic, which reads the token the target had when the action began.
 */
export function damageBonusVsToken(state, attacker, weapon, target, snapshot) {
  let normal = 0;
  let critical = 0;
  for (const def of teamRuleEffects(state, attacker, weapon, 'damageBonusVsToken')) {
    const effect = def.effect;
    const held = (snapshot?.[target.id] || []).includes(`${attacker.playerId}:${effect.token}`);
    if (!held) continue;
    normal += Number(effect.normal) || 0;
    critical += Number(effect.critical) || 0;
  }
  return { normal, critical };
}

/**
 * First Blood: a fighter that was hurt but not put down rolls to hurt back.
 *
 * Printed as an ability rather than a weapon rule, but it keys off a weapon's
 * fight sequence and reads its result, so it is declared on the weapon like
 * every other sequence-shaped rule.
 *
 * @returns {{def:object, dice:string, threshold:number, damage:number}|null}
 */
export function retaliationRule(state, op, weapon) {
  const def = teamRuleEffect(state, op, weapon, 'retaliationRoll');
  if (!def) return null;
  return {
    def,
    dice: def.effect.dice || 'D6',
    threshold: Number(def.effect.threshold) || 4,
    damage: Number(def.effect.damage) || 1,
  };
}

/** Soulstrike: defence dice are read against the target's APL, not its Save. */
export function aplDefenceRule(state, attacker, weapon) {
  return teamRuleEffect(state, attacker, weapon, 'aplDefence');
}

/* ------------------------------------------------------------------ */
/* Melee shape                                                         */
/* ------------------------------------------------------------------ */

/**
 * How a team rule bends the fight sequence for one weapon.
 * Shield, Tangle and Repress all block two; Repress also reverses who resolves
 * first; Smash shoves; Phase Sweep keeps fighting.
 */
export function meleeModifiers(state, op, weapon) {
  const out = {
    blockMultiplier: 1,
    defenderResolvesFirst: false,
    push: null,
    repeatFight: false,
    riposte: null,
    doubleStrikeVsExpended: null,
    crush: null,
    rule: null,
  };
  for (const def of teamRuleEffects(state, op, weapon, 'meleeModifier')) {
    const effect = def.effect;
    if (effect.blockMultiplier) {
      out.blockMultiplier = Math.max(out.blockMultiplier, Number(effect.blockMultiplier));
      out.rule = def.rule || def.name;
    }
    if (effect.defenderResolvesFirst) out.defenderResolvesFirst = true;
    if (effect.push) out.push = { distance: Number(effect.push.distance) || 1, rule: def.rule || def.name };
    if (effect.repeatFight) out.repeatFight = { rule: def.rule || def.name };
    if (effect.riposte) out.riposte = { rule: def.rule || def.name };
    if (effect.doubleStrikeVsExpended) out.doubleStrikeVsExpended = { rule: def.rule || def.name };
    if (effect.crush) {
      out.crush = {
        rule: def.rule || def.name,
        bonusIfWoundsAtMost: Number(effect.crush.bonusIfWoundsAtMost) || 0,
        maxExtra: Number(effect.crush.maxExtra) || 0,
      };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Validation support                                                  */
/* ------------------------------------------------------------------ */

/** Static check used by the pack validator; mirrors the runtime vocabulary. */
export function describeTeamRule(name, def) {
  const problems = [];
  if (!def || typeof def !== 'object') return [`weaponRules.${name} is not an object`];
  const type = def.effect?.type;
  if (!type) problems.push(`weaponRules.${name} declares no effect type`);
  else if (!TEAM_RULE_EFFECTS[type]) {
    problems.push(`weaponRules.${name} uses an unimplemented effect "${type}"`);
  }
  if (type === 'inflictToken') {
    if (!def.effect.token?.kind) problems.push(`weaponRules.${name} inflicts a token with no kind`);
    if (def.effect.trigger && !TOKEN_TRIGGERS.includes(def.effect.trigger)) {
      problems.push(`weaponRules.${name} uses an unknown token trigger "${def.effect.trigger}"`);
    }
  }
  if (type === 'recognised' && !def.partial) {
    problems.push(`weaponRules.${name} does nothing but is not marked partial`);
  }
  if (def.partial && !def.notes) {
    problems.push(`weaponRules.${name} is marked partial but says nothing about what is missing`);
  }
  return problems;
}

/** True when a weapon carries any rule token this pack declares. */
export function weaponHasTeamRule(state, op, weapon) {
  return teamRulesOn(state, op, weapon).length > 0;
}

/** Convenience for callers that only have a rule name to hand. */
export function hasRuleToken(weapon, name) {
  return ruleMap(weapon).has(name);
}
