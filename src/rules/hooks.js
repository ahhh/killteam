/**
 * Declarative rule hooks: how faction rules reach the engine.
 *
 * A hook is DATA (§34) — a trigger, an optional condition, and an effect drawn
 * from a fixed vocabulary. Nothing here evaluates strings as code; an unknown
 * trigger, condition key or effect type is reported through `warnUnsupported`
 * and then ignored, never guessed (#7).
 *
 * Hooks live on a team pack's `ruleHooks` array. Each one names the faction
 * rule it implements in `rule`, so the battle log can say *why* something
 * happened rather than just that it did.
 */
import { warnUnsupported, EVENTS, logEvent } from '../state.js';
import { isWithinShadow } from './terrain.js';
import { liveOperatives } from '../state.js';
import { baseDistance } from '../maps/geometry.js';
import { traceSight } from './visibility.js';

/** Condition keys a hook may use. Anything else is reported and fails closed. */
export const HOOK_CONDITIONS = [
  'keyword',                    // operative profile has this keyword
  'notKeyword',
  'role',
  'orderIs',                    // 'engage' | 'conceal'
  'weaponType',                 // 'ranged' | 'melee'
  'weaponIdIn',                 // [weapon ids]
  'weaponNameContains',         // [lowercase substrings]
  'weaponHasAnyRule',           // [rule names, value-stripped]
  'performedThisActivation',    // [action types] — all must have happened
  'notPerformedThisActivation', // [action types] — none may have happened
  'withinShadow',               // WITHIN SHADOW, as terrain.js defines it
];

/** Effect types the engine knows how to apply. */
export const HOOK_EFFECTS = {
  grantWeaponRule: 'Add weapon rules to the attack for this sequence only.',
  ignoreWeaponRules: 'Strip weapon rules from the attack before the defence roll.',
  modifyDefenceDice: 'Add or remove defence dice.',
  modifySave: 'Improve or worsen the Save stat for this defence roll.',
  capDamage: 'Cap the damage a single action may inflict on this operative.',
  healWounds: 'Regain lost wounds, up to a dice expression.',
  allowChargeWhileConceal: 'Charge without needing an Engage order.',
  extraAction: 'Allow one action type to be performed more than once per activation.',
  freeAction: 'Grant one action per activation that costs no AP.',
  grantAllyApl: 'Add APL to a friendly operative when this one is activated.',
  rerollDefenceDice: 'Re-roll failed defence dice.',
};

/** Triggers, in the order the engine fires them. */
export const HOOK_TRIGGERS = [
  'onTurningPointStart',
  'onActivationStart',
  'onActionLegality',
  'beforeAttackRoll',
  'afterAttackRoll',
  'beforeDefenceRoll',
  'beforeDamageApplied',
  'onDamageApplied',
  'onActivationEnd',
];

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

export function profileOf(state, op) {
  const pack = state.teamPacks[op.playerId];
  return pack?.operatives.find((o) => o.id === op.profileId) || null;
}

function hooksOf(state, playerId, trigger) {
  const pack = state.teamPacks[playerId];
  return (pack?.ruleHooks || []).filter((h) => h.trigger === trigger);
}

/** Strip a trailing value so `piercing2` matches a `piercing` condition. */
function ruleName(rule) {
  return String(rule).toLowerCase().replace(/\d+$/, '');
}

/* ------------------------------------------------------------------ */
/* Conditions                                                          */
/* ------------------------------------------------------------------ */

function matches(state, hook, ctx) {
  const cond = hook.condition;
  if (!cond) return true;

  for (const key of Object.keys(cond)) {
    if (!HOOK_CONDITIONS.includes(key)) {
      warnUnsupported(state, `hook-condition:${key}`,
        `${hook.rule || hook.id} uses an unknown condition "${key}"`);
      return false;
    }
  }

  const { operative, weapon } = ctx;
  const profile = operative ? profileOf(state, operative) : null;
  const keywords = profile?.keywords || [];

  if (cond.keyword && !keywords.includes(cond.keyword)) return false;
  if (cond.notKeyword && keywords.includes(cond.notKeyword)) return false;
  if (cond.role && profile?.role !== cond.role) return false;
  if (cond.orderIs && operative?.order !== cond.orderIs) return false;

  if (cond.weaponType && weapon?.type !== cond.weaponType) return false;
  if (cond.weaponIdIn && !(weapon && cond.weaponIdIn.includes(weapon.id))) return false;
  if (cond.weaponNameContains) {
    const name = (weapon?.name || '').toLowerCase();
    if (!cond.weaponNameContains.some((frag) => name.includes(frag))) return false;
  }
  if (cond.weaponHasAnyRule) {
    const names = (weapon?.rules || []).map(ruleName);
    if (!cond.weaponHasAnyRule.some((r) => names.includes(r))) return false;
  }

  if (cond.withinShadow !== undefined && operative &&
      isWithinShadow(state, operative) !== cond.withinShadow) return false;

  const used = operative?.usedThisActivation || [];
  if (cond.notPerformedThisActivation &&
      cond.notPerformedThisActivation.some((a) => used.includes(a))) return false;
  if (cond.performedThisActivation &&
      !cond.performedThisActivation.every((a) => used.includes(a))) return false;

  return true;
}

/** Every hook on this operative's team that fires for `trigger` and `ctx`. */
function activeHooks(state, operative, trigger, ctx = {}) {
  return hooksOf(state, operative.playerId, trigger)
    .filter((h) => matches(state, h, { operative, ...ctx }));
}

function noteEffect(state, hook, operative, detail) {
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: hook.id,
    rule: hook.rule || hook.name || hook.id,
    operativeId: operative?.id ?? null,
    operativeName: operative?.name ?? null,
    playerId: operative?.playerId ?? null,
    detail,
  });
}

function notePartial(state, hook) {
  if (!hook.partial) return;
  warnUnsupported(state, `hook-partial:${hook.id}`,
    `${hook.rule || hook.id}: ${hook.notes || 'only partly simulated'}`);
}

function unknownEffect(state, hook) {
  warnUnsupported(state, `hook-effect:${hook.effect?.type}`,
    `${hook.rule || hook.id} uses an unimplemented effect "${hook.effect?.type}"`);
}

/* ------------------------------------------------------------------ */
/* Dice expressions (for healWounds and friends)                       */
/* ------------------------------------------------------------------ */

/** Roll "D3+1", "D6", "2" and so on. Returns 0 for anything unparseable. */
export function rollExpression(rng, expr) {
  const text = String(expr).trim();
  // A flat amount with no dice at all — Plague Marine Poison is "1 damage".
  if (/^\d+$/.test(text)) return Number(text);
  const m = /^(?:(\d*)[Dd](\d+))?\s*(?:([+-])\s*(\d+))?$/.exec(text);
  if (!m || (!m[2] && !m[4])) return 0;
  let total = 0;
  if (m[2]) {
    const count = m[1] ? Number(m[1]) : 1;
    const sides = Number(m[2]);
    for (let i = 0; i < count; i++) total += 1 + Math.floor(rng.next() * sides);
  }
  if (m[4]) total += (m[3] === '-' ? -1 : 1) * Number(m[4]);
  return Math.max(0, total);
}

/* ------------------------------------------------------------------ */
/* Trigger: onTurningPointStart                                        */
/* ------------------------------------------------------------------ */

export function fireTurningPointStart(state, rng, operatives) {
  for (const op of operatives) {
    for (const hook of activeHooks(state, op, 'onTurningPointStart')) {
    notePartial(state, hook);
      const effect = hook.effect || {};
      if (effect.type === 'healWounds') {
        const lost = op.wounds - op.woundsRemaining;
        if (lost <= 0) continue;
        const rolled = rollExpression(rng, effect.dice);
        const healed = Math.min(lost, rolled);
        if (healed <= 0) continue;
        op.woundsRemaining += healed;
        noteEffect(state, hook, op, `regains ${healed} lost wound(s) (rolled ${rolled})`);
      } else {
        unknownEffect(state, hook);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Trigger: onActivationStart                                          */
/* ------------------------------------------------------------------ */

/**
 * Set up the per-activation allowances a hook grants. Stored on the operative
 * so the action layer can read them without re-evaluating conditions, and so a
 * serialized state replays identically.
 */
export function fireActivationStart(state, op) {
  op.freeActions = [];
  op.chargeWhileConceal = false;
  op.extraActionChoice = null;

  for (const hook of activeHooks(state, op, 'onActivationStart')) {
    notePartial(state, hook);
    const effect = hook.effect || {};
    switch (effect.type) {
      case 'freeAction':
        grantFreeAction(op, effect.action, { rule: hook.rule || hook.id });
        noteEffect(state, hook, op, `gains a free ${effect.action}`);
        break;
      case 'allowChargeWhileConceal':
        op.chargeWhileConceal = true;
        break;
      case 'grantAllyApl': {
        const ally = bestAllyForApl(state, op, effect);
        if (!ally) break;
        ally.aplBonus = (ally.aplBonus || 0) + (Number(effect.amount) || 1);
        noteEffect(state, hook, op,
          `orders ${ally.name} forward: +${Number(effect.amount) || 1} APL`);
        break;
      }
      default:
        unknownEffect(state, hook);
    }
  }
}

/**
 * "Let's Move!": the leader spends its own activation handing a point of APL to
 * somebody else. Who benefits is a judgement, so it goes to the friend that
 * can still spend it — one that has not activated yet — nearest the enemy,
 * which is where an extra action is worth most. Ties break on operative id so
 * a replay is identical.
 */
function bestAllyForApl(state, op, effect) {
  const reach = Number(effect.within) || 6;
  const enemies = liveOperatives(state).filter((o) => o.playerId !== op.playerId);
  const nearestEnemy = (o) => (enemies.length
    ? Math.min(...enemies.map((e) => baseDistance(o, e)))
    : Infinity);
  const terrain = state.map.terrain || [];
  const all = liveOperatives(state);

  return liveOperatives(state, op.playerId)
    .filter((o) => o.id !== op.id && o.ready)
    .filter((o) => !effect.keyword ||
      (profileOf(state, o)?.keywords || []).includes(effect.keyword))
    .filter((o) => baseDistance(op, o) <= reach)
    .filter((o) => traceSight(op, o, terrain,
      all.filter((b) => b.id !== op.id && b.id !== o.id)).visible)
    .sort((a, b) => nearestEnemy(a) - nearestEnemy(b) || (a.id < b.id ? -1 : 1))[0] || null;
}

/**
 * How many times `type` may be performed this activation (default 1).
 *
 * Evaluated live rather than cached at activation start, because the rules
 * that grant a repeat depend on what the operative has already done — Kasrkin
 * Rapid Fire only applies while the operative hasn't moved.
 *
 * `oneOf` models the Astartes shape, "either two Shoot actions or two Fight
 * actions": the first of the pair to be repeated claims the grant, and the
 * other is left at its normal single use.
 */
export function timesAllowed(state, op, type) {
  let extra = 0;
  for (const hook of activeHooks(state, op, 'onActionLegality')) {
    const effect = hook.effect || {};
    if (effect.type !== 'extraAction') { unknownEffect(state, hook); continue; }
    const count = Number(effect.count) || 1;

    if (Array.isArray(effect.oneOf)) {
      if (!effect.oneOf.includes(type)) continue;
      const chosen = op.extraActionChoice;
      if (chosen && chosen !== type) continue;
      extra += count;
    } else if (effect.action === type) {
      extra += count;
    }
  }
  return 1 + extra;
}

/** Record which half of an `oneOf` grant an operative has now committed to. */
export function claimExtraAction(state, op, type) {
  if (op.extraActionChoice) return;
  const used = op.usedThisActivation.filter((t) => t === type).length;
  if (used < 2) return;
  const claims = activeHooks(state, op, 'onActionLegality')
    .some((h) => Array.isArray(h.effect?.oneOf) && h.effect.oneOf.includes(type));
  if (claims) op.extraActionChoice = type;
}

/**
 * Free-action grants.
 *
 * A grant is `{action, unrestricted, rule}` rather than a bare action name,
 * because one of them — Vitalised Surge's Dash after a kill — is printed as
 * usable "even if it's performed an action that prevents it from performing
 * the Dash action". Plain strings are still read, so an older serialized
 * state replays.
 */
export function grantFreeAction(op, action, { unrestricted = false, rule = null } = {}) {
  if (!action) return;
  if (!op.freeActions) op.freeActions = [];
  op.freeActions.push({ action, unrestricted, rule });
}

function grantName(entry) {
  return typeof entry === 'string' ? entry : entry?.action;
}

/** The grant covering `type`, or null. */
export function freeActionGrant(op, type) {
  return (op?.freeActions || []).find((f) => grantName(f) === type) || null;
}

export function hasFreeAction(op, type) {
  return Boolean(freeActionGrant(op, type));
}

/** True when the grant also lifts the once-per-activation restrictions. */
export function freeActionIsUnrestricted(op, type) {
  const grant = freeActionGrant(op, type);
  return typeof grant === 'object' && grant?.unrestricted === true;
}

/** True if a free grant covers this action, so it should cost no AP. */
export function consumeFreeAction(op, type) {
  const i = (op.freeActions || []).findIndex((f) => grantName(f) === type);
  if (i < 0) return false;
  op.freeActions.splice(i, 1);
  return true;
}

export function chargeIgnoresOrder(op) {
  return op.chargeWhileConceal === true;
}

/* ------------------------------------------------------------------ */
/* Trigger: beforeAttackRoll                                           */
/* ------------------------------------------------------------------ */

/**
 * Returns the weapon the attack should actually use. The pack's own profile is
 * never mutated — hooks hand back a copy for this sequence only.
 */
export function applyAttackHooks(state, attacker, weapon, ctx = {}) {
  let effective = weapon;
  for (const hook of activeHooks(state, attacker, 'beforeAttackRoll', { weapon, ...ctx })) {
      notePartial(state, hook);
    const effect = hook.effect || {};
    if (effect.type === 'grantWeaponRule') {
      const added = (effect.rules || []).filter((r) => !effective.rules.includes(r));
      if (!added.length) continue;
      effective = { ...effective, rules: [...effective.rules, ...added] };
      noteEffect(state, hook, attacker, `${effective.name} gains ${added.join(', ')}`);
    } else {
      unknownEffect(state, hook);
    }
  }
  return effective;
}

/* ------------------------------------------------------------------ */
/* Trigger: beforeDefenceRoll                                          */
/* ------------------------------------------------------------------ */

/**
 * Defender-side hooks. Returns the weapon as the defence should see it plus a
 * defence-dice delta. The defender's own team pack supplies these hooks.
 */
export function applyDefenceHooks(state, defender, weapon, ctx = {}) {
  let effective = weapon;
  let diceDelta = 0;
  let rerolls = 0;
  let saveModifier = 0;
  for (const hook of activeHooks(state, defender, 'beforeDefenceRoll', { weapon, ...ctx })) {
      notePartial(state, hook);
    const effect = hook.effect || {};
    switch (effect.type) {
      case 'ignoreWeaponRules': {
        const drop = (effect.rules || []);
        const kept = effective.rules.filter((r) => !drop.includes(ruleName(r)));
        if (kept.length === effective.rules.length) continue;
        const removed = effective.rules.filter((r) => drop.includes(ruleName(r)));
        effective = { ...effective, rules: kept };
        noteEffect(state, hook, defender, `ignores ${removed.join(', ')} on ${effective.name}`);
        break;
      }
      case 'modifyDefenceDice':
        diceDelta += Number(effect.delta) || 0;
        noteEffect(state, hook, defender, `defence dice ${effect.delta > 0 ? '+' : ''}${effect.delta}`);
        break;
      case 'rerollDefenceDice':
        rerolls += Number(effect.count) || 1;
        noteEffect(state, hook, defender, `may re-roll ${rerolls} defence dice`);
        break;
      case 'modifySave': {
        // "Improve its Save stat by 1" means a lower number, so the pack says
        // -1 and the dice layer adds it to the stat.
        const delta = Number(effect.delta) || 0;
        if (!delta) break;
        saveModifier += delta;
        noteEffect(state, hook, defender,
          `Save ${delta < 0 ? 'improved' : 'worsened'} by ${Math.abs(delta)}`);
        break;
      }
      default:
        unknownEffect(state, hook);
    }
  }
  return { weapon: effective, diceDelta, rerolls, saveModifier };
}

/* ------------------------------------------------------------------ */
/* Trigger: beforeDamageApplied                                        */
/* ------------------------------------------------------------------ */

/** Let the defender's hooks reduce incoming damage from one action. */
export function applyDamageHooks(state, defender, amount, source = {}) {
  let result = amount;
  for (const hook of activeHooks(state, defender, 'beforeDamageApplied', { source })) {
      notePartial(state, hook);
    const effect = hook.effect || {};
    if (effect.type === 'capDamage') {
      if (effect.perAction && effect.perAction !== source.kind) continue;
      const max = Number(effect.max);
      if (!Number.isFinite(max) || result <= max) continue;
      noteEffect(state, hook, defender, `damage capped at ${max} (was ${result})`);
      result = max;
    } else {
      unknownEffect(state, hook);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Validation support                                                  */
/* ------------------------------------------------------------------ */

/** Static check used by the pack validator; mirrors the runtime vocabulary. */
export function describeHook(hook) {
  const problems = [];
  if (!hook.trigger || !HOOK_TRIGGERS.includes(hook.trigger)) {
    problems.push(`unknown trigger "${hook.trigger}"`);
  }
  if (!hook.effect || !HOOK_EFFECTS[hook.effect.type]) {
    problems.push(`unimplemented effect "${hook.effect?.type}"`);
  }
  for (const key of Object.keys(hook.condition || {})) {
    if (!HOOK_CONDITIONS.includes(key)) problems.push(`unknown condition "${key}"`);
  }
  return problems;
}
