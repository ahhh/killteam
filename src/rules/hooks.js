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
import { warnUnsupported, EVENTS, logEvent, ORDERS } from '../state.js';
import { isWithinShadow } from './terrain.js';
import { liveOperatives } from '../state.js';
import { baseDistance } from '../maps/geometry.js';
import { traceSight, CONTROL_RANGE } from './visibility.js';
import { hasToken } from './tokens.js';
import { grantToken } from './tokens.js';
// effects.js imports this module in turn. The cycle resolves because
// `isInjured` and `applyDamage` are hoisted function declarations; keep them so.
import { isInjured, applyDamage } from './effects.js';
import { activePloyHooks, reactiveDefenceHooks, demiseHooks } from './ploys.js';
import { Rng } from '../rng.js';

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
  // Sequence-aware conditions. Most printed ploys are not team-wide buffs but
  // buffs that apply *in a situation* — "shooting an operative within 6\"",
  // "fighting a ready operative", "more than 5\" from other friendly
  // operatives". Without these a pack can only express the unconditional
  // minority, and authoring the rest would silently drop the condition and
  // make every one of them stronger than printed.
  'action',                     // 'shoot' | 'fight' — which sequence this is
  'targetWithin',               // target is within x" (base to base)
  'targetBeyond',               // target is more than x" away
  'targetOrderIs',              // 'engage' | 'conceal'
  'targetKeyword',
  'targetNotKeyword',
  'selfWounded',                // this operative is wounded (or is not)
  'targetWounded',
  'awayFromFriends',            // more than x" from every other friendly
  'targetReady',                // target is yet to activate (expended = false)
  'selfReady',
  'hasToken',                   // this operative holds one of our own tokens
  'notHasToken',                // …and the mirror: it does not
  'targetHasToken',             // the other operative holds one of our tokens
  'friendlyWithin',             // another friendly is within x", or {inches, keyword}
  'awayFromEnemies',            // more than x" from every enemy operative
  'nearObjective',              // this operative is within x" of an objective
  'turningPointAtLeast',        // the battle has reached turning point x
  'counteracting',              // this is a counteraction, not an activation
  // About the action that just finished, for `afterAction`.
  'actionIs',                   // 'charge' | 'shoot' | …
  'actionCountAtMost',          // …and it was the operative's first, second, …
];

/** Effect types the engine knows how to apply. */
export const HOOK_EFFECTS = {
  grantWeaponRule: 'Add weapon rules to the attack for this sequence only.',
  ignoreWeaponRules: 'Strip weapon rules from the attack before the defence roll.',
  modifyDefenceDice: 'Add or remove defence dice.',
  modifySave: 'Improve or worsen the Save stat for this defence roll.',
  capDamage: 'Cap the damage a single action may inflict on this operative.',
  reduceDamage: 'Subtract from the damage a single action inflicts on this operative.',
  healWounds: 'Regain lost wounds, up to a dice expression.',
  allowChargeWhileConceal: 'Charge without needing an Engage order.',
  allowChargeAfterFallBack: 'Charge later in an activation that already fell back.',
  extraAction: 'Allow one action type to be performed more than once per activation.',
  freeAction: 'Grant one action per activation that costs no AP.',
  grantAllyApl: 'Add APL to a friendly operative when this one is activated.',
  rerollDefenceDice: 'Re-roll failed defence dice.',
  modifyWeapon: 'Bend the weapon profile for this sequence: Atk, Damage, Hit.',
  addApl: 'Add APL to this operative for its activation.',
  discountAction: 'One action type costs x less AP this activation (never below 0).',
  modifyMove: 'Add inches to the Move stat for this activation.',
  ignoreInjured: 'The operative does not suffer the effects of being injured.',
  clearTokens: 'Strip the tokens an opponent has hung on this operative.',
  inflictDamage: 'Deal damage to enemies around this operative.',
  inflictToken: 'Hang a token on enemies around this operative.',
  changeOrder: 'Set this operative\'s order.',
  denyTargeting: 'This operative cannot be selected as a valid target.',
};

/** Triggers, in the order the engine fires them. */
export const HOOK_TRIGGERS = [
  'onTurningPointStart',
  'onActivationStart',
  'onActionLegality',
  'onTargetSelection',
  'onIncomingAttack',
  'beforeAttackRoll',
  'afterAttackRoll',
  'beforeDefenceRoll',
  'beforeDamageApplied',
  'onDamageApplied',
  'afterRetaliation',
  'afterAction',
  'onIncapacitated',
  'onActivationEnd',
];

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

export function profileOf(state, op) {
  const pack = state.teamPacks[op.playerId];
  return pack?.operatives.find((o) => o.id === op.profileId) || null;
}

function hooksOf(state, playerId, trigger, operative = null) {
  const pack = state.teamPacks[playerId];
  const own = (pack?.ruleHooks || []).filter((h) => h.trigger === trigger);
  // A ploy in force is just a hook the player paid CP for, so it enters here
  // and inherits every condition and effect below. A strategic ploy reaches
  // the whole team; a firefight ploy was bought for one operative's activation
  // and `activePloyHooks` filters it against the operative asking.
  return own.concat(activePloyHooks(state, playerId, trigger, operative));
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
  // A list, because a printed exclusion is often plural — "GELLERPOX INFECTED
  // (excluding MUTOID VERMIN)", "RATLING (excluding OGRYN or BULLGRYN)".
  if (cond.notKeyword) {
    const excluded = Array.isArray(cond.notKeyword) ? cond.notKeyword : [cond.notKeyword];
    if (excluded.some((k) => keywords.includes(k))) return false;
  }
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

  // Sequence conditions need the other half of the attack, which both
  // `applyAttackHooks` and `applyDefenceHooks` already pass through ctx.
  const other = ctx.target || ctx.attacker || null;

  if (cond.action && ctx.action !== cond.action) return false;

  if (cond.targetWithin !== undefined || cond.targetBeyond !== undefined) {
    if (!other || !operative) return false;
    const gap = baseDistance(operative, other);
    if (cond.targetWithin !== undefined && gap > cond.targetWithin) return false;
    if (cond.targetBeyond !== undefined && gap <= cond.targetBeyond) return false;
  }
  if (cond.targetOrderIs && other?.order !== cond.targetOrderIs) return false;
  if (cond.targetKeyword || cond.targetNotKeyword) {
    if (!other) return false;
    const theirs = profileOf(state, other)?.keywords || [];
    if (cond.targetKeyword && !theirs.includes(cond.targetKeyword)) return false;
    if (cond.targetNotKeyword && theirs.includes(cond.targetNotKeyword)) return false;
  }
  if (cond.selfWounded !== undefined && operative &&
      isInjured(operative) !== cond.selfWounded) return false;
  if (cond.selfReady !== undefined && operative &&
      (operative.ready === true) !== cond.selfReady) return false;
  if (cond.targetReady !== undefined) {
    if (!other) return false;
    if ((other.ready === true) !== cond.targetReady) return false;
  }
  if (cond.targetWounded !== undefined) {
    if (!other) return false;
    if (isInjured(other) !== cond.targetWounded) return false;
  }
  // Token conditions: "whenever a friendly operative that has one of YOUR
  // tokens…". Ownership matters — two teams can be poisoning the same
  // operative — so both sides are asked about this team's own tokens.
  if (cond.hasToken && operative &&
      !hasToken(operative, cond.hasToken, operative.playerId)) return false;
  if (cond.notHasToken && operative &&
      hasToken(operative, cond.notHasToken, operative.playerId)) return false;
  if (cond.targetHasToken) {
    if (!other || !operative) return false;
    if (!hasToken(other, cond.targetHasToken, operative.playerId)) return false;
  }
  if (cond.friendlyWithin !== undefined && operative) {
    // Two forms. A bare number is "another friendly operative within x\"".
    // The object form names WHICH friendly — "within 6\" of your DARK
    // APOSTLE", "within 3\" of your Sanguinary Captain" — which is how a
    // printed leash around one named model is written.
    const spec = typeof cond.friendlyWithin === 'object'
      ? cond.friendlyWithin : { inches: cond.friendlyWithin };
    const reach = Number(spec.inches) || 0;
    const near = liveOperatives(state, operative.playerId).some((o) => {
      if (o.id === operative.id) return false;
      if (baseDistance(operative, o) > reach) return false;
      if (!spec.keyword) return true;
      return (profileOf(state, o)?.keywords || []).includes(spec.keyword);
    });
    if (!near) return false;
  }
  if (cond.awayFromEnemies !== undefined && operative) {
    const near = liveOperatives(state)
      .some((o) => o.playerId !== operative.playerId &&
        baseDistance(operative, o) <= cond.awayFromEnemies);
    if (near) return false;
  }
  if (cond.counteracting !== undefined &&
      (operative?.inCounteraction === true) !== cond.counteracting) return false;
  // `afterAction` carries the action that has just finished, and how many the
  // operative had performed by the time it did — which is how a pack says
  // "if the FIRST action it performs is the Charge action".
  if (cond.actionIs !== undefined && ctx.actionPerformed !== cond.actionIs) return false;
  if (cond.actionCountAtMost !== undefined &&
      (ctx.actionCount ?? Infinity) > cond.actionCountAtMost) return false;

  if (cond.nearObjective !== undefined && operative) {
    const markers = state.objectives || [];
    const near = markers.some(
      (m) => baseDistance(operative, { x: m.x, y: m.y, baseDiameter: 0 }) <= cond.nearObjective);
    if (!near) return false;
  }
  if (cond.turningPointAtLeast !== undefined &&
      (state.turningPoint || 0) < cond.turningPointAtLeast) return false;
  if (cond.awayFromFriends !== undefined && operative) {
    const near = liveOperatives(state, operative.playerId)
      .some((o) => o.id !== operative.id && baseDistance(operative, o) <= cond.awayFromFriends);
    if (near) return false;
  }

  const used = operative?.usedThisActivation || [];
  if (cond.notPerformedThisActivation &&
      cond.notPerformedThisActivation.some((a) => used.includes(a))) return false;
  if (cond.performedThisActivation &&
      !cond.performedThisActivation.every((a) => used.includes(a))) return false;

  return true;
}

/** Every hook on this operative's team that fires for `trigger` and `ctx`. */
function activeHooks(state, operative, trigger, ctx = {}) {
  return hooksOf(state, operative.playerId, trigger, operative)
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
  // "…up to D3 friendly operatives": a budget that belongs to the HOOK, not
  // to any one operative, so it is rolled once and drawn down as the sweep
  // walks the roster. Keyed by hook id, which is unique within a pack.
  const budgets = new Map();
  const budgetLeft = (hook) => {
    if (hook.effect?.count === undefined) return Infinity;
    if (!budgets.has(hook.id)) budgets.set(hook.id, rollExpression(rng, hook.effect.count));
    return budgets.get(hook.id);
  };

  for (const op of operatives) {
    for (const hook of activeHooks(state, op, 'onTurningPointStart')) {
    notePartial(state, hook);
      const effect = hook.effect || {};
      if (effect.type === 'healWounds') {
        const lost = op.wounds - op.woundsRemaining;
        if (lost <= 0) continue;
        // A medic treats one patient a turning point; LIVING METAL repairs the
        // whole phalanx. `count` is what tells the two apart.
        if (budgetLeft(hook) <= 0) continue;
        const rolled = rollExpression(rng, effect.dice);
        const healed = Math.min(lost, rolled);
        if (healed <= 0) continue;
        op.woundsRemaining += healed;
        if (budgets.has(hook.id)) budgets.set(hook.id, budgets.get(hook.id) - 1);
        noteEffect(state, hook, op, `regains ${healed} lost wound(s) (rolled ${rolled})`);
      } else if (effect.type === 'changeOrder') {
        if (budgetLeft(hook) <= 0) continue;
        if (!setOrder(state, hook, op, effect.order)) continue;
        if (budgets.has(hook.id)) budgets.set(hook.id, budgets.get(hook.id) - 1);
      } else if (effect.type === 'inflictDamage' || effect.type === 'inflictToken') {
        // "Select ONE enemy operative within 3\" of a friendly operative": the
        // budget is what makes that a single pick rather than one per friend.
        if (budgetLeft(hook) <= 0) continue;
        const aux = auxRng(state);
        const did = applyAreaEffect(state, aux, hook, op, {});
        commitAux(state, aux);
        if (!did) continue;
        if (budgets.has(hook.id)) budgets.set(hook.id, budgets.get(hook.id) - 1);
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
export function fireActivationStart(state, op, rng = null) {
  op.freeActions = [];
  op.chargeWhileConceal = false;
  op.chargeAfterFallBack = false;
  op.extraActionChoice = null;
  // Allowances a ploy or a rule can buy for one activation. Reset here so a
  // firefight ploy bought last activation cannot leak into this one.
  op.actionDiscounts = {};
  op.moveBonusThisActivation = 0;
  op.ignoresInjured = false;

  for (const hook of activeHooks(state, op, 'onActivationStart')) {
    applyActivationStartHook(state, op, hook, rng);
  }
}

/**
 * One activation-start effect, applied to one operative.
 *
 * Split out of `fireActivationStart` because a FIREFIGHT PLOY is bought in the
 * middle of an activation that has already started: the hooks it brings with
 * it have missed the trigger, so `rules/ploys.js` replays this for them at the
 * moment the CP is paid. Both paths therefore grant the same things in the
 * same way — the only difference is when the player decided to pay.
 */
export function applyActivationStartHook(state, op, hook, rng = null) {
  notePartial(state, hook);
  const effect = hook.effect || {};
  switch (effect.type) {
    case 'healWounds': {
      // Needs dice, and therefore needs the battle stream: an activation-start
      // heal without one would either be silent or non-deterministic, and both
      // are worse than declining it.
      if (!rng) return false;
      const lost = op.wounds - op.woundsRemaining;
      if (lost <= 0) return false;
      const rolled = rollExpression(rng, effect.dice || 'D3');
      const healed = Math.min(lost, rolled);
      if (healed <= 0) return false;
      op.woundsRemaining += healed;
      noteEffect(state, hook, op, `regains ${healed} lost wound(s) (rolled ${rolled})`);
      return true;
    }
    case 'freeAction':
      grantFreeAction(op, effect.action, {
        unrestricted: effect.unrestricted === true,
        rule: hook.rule || hook.id,
      });
      noteEffect(state, hook, op, `gains a free ${effect.action}`);
      return true;
    case 'allowChargeAfterFallBack':
      op.chargeAfterFallBack = true;
      noteEffect(state, hook, op, 'can charge after falling back');
      return true;
    case 'allowChargeWhileConceal':
      op.chargeWhileConceal = true;
      noteEffect(state, hook, op, 'may Charge from a Conceal order');
      return true;
    case 'grantAllyApl': {
      const ally = bestAllyForApl(state, op, effect);
      if (!ally) return false;
      const amount = Number(effect.amount) || 1;
      ally.aplBonus = (ally.aplBonus || 0) + amount;
      // An ally that has already begun its activation spends the point now;
      // one that has not gets it when `apRemaining` is set at activation start.
      if (ally.apRemaining > 0) ally.apRemaining += amount;
      noteEffect(state, hook, op, `orders ${ally.name} forward: +${amount} APL`);
      return true;
    }
    case 'addApl': {
      const amount = Number(effect.amount) || 1;
      op.aplBonus = (op.aplBonus || 0) + amount;
      // Bought mid-activation, the point has to be spendable now — otherwise
      // an action ploy that reads "+1 APL" buys an AP the operative can never
      // reach, because `apRemaining` was fixed when the activation began.
      if (op.apRemaining > 0 || (op.usedThisActivation || []).length) {
        op.apRemaining += amount;
      }
      noteEffect(state, hook, op, `+${amount} APL for this activation`);
      return true;
    }
    case 'discountAction': {
      const action = effect.action;
      if (!action) return false;
      const amount = Number(effect.amount) || 1;
      if (!op.actionDiscounts) op.actionDiscounts = {};
      op.actionDiscounts[action] = (op.actionDiscounts[action] || 0) + amount;
      noteEffect(state, hook, op, `${action} costs ${amount} less AP this activation`);
      return true;
    }
    case 'modifyMove': {
      const inches = Number(effect.inches) || 0;
      if (!inches) return false;
      op.moveBonusThisActivation = (op.moveBonusThisActivation || 0) + inches;
      noteEffect(state, hook, op, `+${inches}" Move this activation`);
      return true;
    }
    case 'clearTokens': {
      // "Remove one rules effect your opponent has applied to it" — in this
      // engine an opponent's lasting effect on an operative is a token.
      const before = (op.tokens || []).length;
      if (!before) return false;
      op.tokens = (op.tokens || []).filter(
        (t) => t.owner === op.playerId || (effect.kind && t.kind !== effect.kind));
      const shed = before - op.tokens.length;
      if (!shed) return false;
      noteEffect(state, hook, op, `sheds ${shed} enemy token(s)`);
      return true;
    }
    case 'ignoreInjured':
      if (op.ignoresInjured) return false;
      op.ignoresInjured = true;
      noteEffect(state, hook, op, 'ignores the effects of being injured');
      return true;
    case 'changeOrder':
      return setOrder(state, hook, op, effect.order);
    case 'inflictDamage':
    case 'inflictToken': {
      const aux = auxRng(state);
      const did = applyAreaEffect(state, aux, hook, op, {});
      commitAux(state, aux);
      return did;
    }
    default:
      unknownEffect(state, hook);
      return false;
  }
}

/**
 * Flip an operative's order, and say so.
 *
 * A separate helper because three different triggers want it: the Deathwatch
 * change it as they counteract, the Mandrakes slip back to Conceal as their
 * activation ends, and the Scouts re-order the squad in the Strategy phase.
 */
function setOrder(state, hook, op, order) {
  const want = order === ORDERS.ENGAGE ? ORDERS.ENGAGE : ORDERS.CONCEAL;
  if (op.order === want) return false;
  op.order = want;
  logEvent(state, EVENTS.ORDER_SELECTED, {
    operativeId: op.id, operativeName: op.name, playerId: op.playerId, order: want,
  });
  noteEffect(state, hook, op, `changes order to ${want}`);
  return true;
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

/** RELENTLESS ASSAULT: the Fall Back no longer closes the door on a Charge. */
export function chargeIgnoresFallBack(op) {
  return op.chargeAfterFallBack === true;
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
    } else if (effect.type === 'modifyWeapon') {
      // A copy for this sequence only; the pack's profile is never touched.
      const atk = Number(effect.atkBonus) || 0;
      const normal = Number(effect.damageNormal) || 0;
      const critical = Number(effect.damageCritical) || 0;
      // "Improve the Hit stat by 1" means a lower number to roll, so a pack
      // says -1 the way `modifySave` does.
      const hit = Number(effect.hitBonus) || 0;
      if (!atk && !normal && !critical && !hit) continue;
      effective = {
        ...effective,
        atk: Math.max(1, effective.atk + atk),
        hit: Math.max(2, Math.min(6, effective.hit + hit)),
        damage: {
          ...effective.damage,
          normal: Math.max(0, effective.damage.normal + normal),
          critical: Math.max(0, effective.damage.critical + critical),
        },
      };
      const parts = [];
      if (atk) parts.push(`${atk > 0 ? '+' : ''}${atk} Atk`);
      if (hit) parts.push(`Hit ${effective.hit}+`);
      if (normal || critical) parts.push(`damage ${effective.damage.normal}/${effective.damage.critical}`);
      noteEffect(state, hook, attacker, `${effective.name}: ${parts.join(', ')}`);
    } else {
      unknownEffect(state, hook);
    }
  }
  return effective;
}

/* ------------------------------------------------------------------ */
/* Trigger: onIncomingAttack                                           */
/* ------------------------------------------------------------------ */

/**
 * The DEFENDER's say in the attack about to be rolled against it.
 *
 * `beforeAttackRoll` belongs to the attacker, and by the time the defence roll
 * comes around the attack dice have already been rolled and re-rolled — so a
 * rule that reads "your opponent cannot re-roll their attack dice" has no
 * window there at all. This is that window: it fires immediately before the
 * attack dice are rolled, reads the defender's hooks, and hands back the
 * weapon as the attack should see it.
 *
 * It is also where a REACTIVE firefight ploy is bought, because that is the
 * moment a player looks at what is coming and decides whether to pay for it.
 * The purchase registers for the whole sequence, so a ploy that also adds
 * defence dice is picked up later by `applyDefenceHooks` without paying twice.
 */
export function applyIncomingAttackHooks(state, defender, weapon, ctx = {}) {
  if (!defender?.alive) return weapon;
  // Buying comes first, for its effect on this sequence: the purchase registers
  // the ploy for the rest of the sequence, so `activeHooks` below — and every
  // later trigger in the same sequence — reads it like any other hook.
  reactiveDefenceHooks(state, defender, { weapon, ...ctx });
  const hooks = activeHooks(state, defender, 'onIncomingAttack', { weapon, ...ctx });

  let effective = weapon;
  for (const hook of hooks) {
    notePartial(state, hook);
    const effect = hook.effect || {};
    if (effect.type === 'ignoreWeaponRules') {
      const drop = effect.rules || [];
      const kept = effective.rules.filter((r) => !drop.includes(ruleName(r)));
      if (kept.length === effective.rules.length) continue;
      const removed = effective.rules.filter((r) => drop.includes(ruleName(r)));
      effective = { ...effective, rules: kept };
      noteEffect(state, hook, defender, `${effective.name} loses ${removed.join(', ')}`);
    } else if (effect.type === 'grantWeaponRule') {
      // Granted to the ATTACKER's weapon, which is only ever worth doing with
      // a rule that hurts to carry: Gellerpox make a lasgun overheat.
      const added = (effect.rules || []).filter((r) => !effective.rules.includes(r));
      if (!added.length) continue;
      effective = { ...effective, rules: [...effective.rules, ...added] };
      noteEffect(state, hook, defender, `${effective.name} is fouled: ${added.join(', ')}`);
    } else if (effect.type === 'modifyWeapon') {
      const atk = Number(effect.atkBonus) || 0;
      const hit = Number(effect.hitBonus) || 0;
      const normal = Number(effect.damageNormal) || 0;
      const critical = Number(effect.damageCritical) || 0;
      if (!atk && !hit && !normal && !critical) continue;
      effective = {
        ...effective,
        atk: Math.max(1, effective.atk + atk),
        hit: Math.max(2, Math.min(6, effective.hit + hit)),
        damage: {
          ...effective.damage,
          normal: Math.max(0, effective.damage.normal + normal),
          critical: Math.max(0, effective.damage.critical + critical),
        },
      };
      noteEffect(state, hook, defender,
        `the attack is blunted: ${effective.atk} dice, Hit ${effective.hit}+, ` +
        `damage ${effective.damage.normal}/${effective.damage.critical}`);
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
  // The other window where a team may spend CP on somebody else's turn — for
  // a reaction with nothing to say before the attack dice are rolled. The
  // purchase registers the ploy, which `activeHooks` then reads.
  reactiveDefenceHooks(state, defender, { weapon, ...ctx });
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
    } else if (effect.type === 'reduceDamage') {
      if (effect.perAction && effect.perAction !== source.kind) continue;
      const amount = Number(effect.amount) || 0;
      if (amount <= 0 || result <= 0) continue;
      const after = Math.max(0, result - amount);
      noteEffect(state, hook, defender, `shrugs off ${result - after} damage (was ${result})`);
      result = after;
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

/* ------------------------------------------------------------------ */
/* Area effects: damage and tokens spilling off one operative          */
/* ------------------------------------------------------------------ */

/**
 * A second, independent dice stream.
 *
 * `applyDamage` is called from the middle of an attack sequence, and that
 * sequence is holding a checked-out `Rng` it will write back when it finishes.
 * A death-throe that drew from `state.rng` there would have its rolls
 * overwritten — the same dice handed out twice. So the rules that fire outside
 * a sequence's own dice roll draw from a stream forked off the battle seed,
 * exactly as map generation does (see `Rng.fork`). Deterministic, serializable,
 * and it cannot collide with the attack that provoked it.
 */
function auxRng(state) {
  if (!state.rngAux) state.rngAux = { seed: `${state.seed}:aux`, index: 0 };
  return Rng.fromState(state.rngAux);
}

function commitAux(state, rng) {
  state.rngAux = rng.getState();
}

/**
 * Who an area effect reaches.
 *
 * `target: "attacker"` is the other operative in the sequence — the one that
 * struck the killing blow, which is what "strike the enemy operative in that
 * sequence" amounts to once the dice are gone. Everything else is a radius
 * around this operative, either every enemy in it (`scope: "each"`) or the
 * single best one (the default), which is the one closest to dying.
 */
function areaRecipients(state, op, effect, ctx) {
  // "that operative" — a rule that hangs something on the operative whose own
  // action triggered it. The Red Thirst is the case this exists for: giving in
  // is a state the Marine puts on himself, not something done to an enemy.
  if (effect.target === 'self') return op.alive ? [op] : [];
  if (effect.target === 'attacker') {
    const foe = ctx.attacker || ctx.target || null;
    return foe && foe.alive && foe.playerId !== op.playerId ? [foe] : [];
  }
  const radius = effect.controlRangeOnly
    ? CONTROL_RANGE
    : (Number(effect.within) || CONTROL_RANGE);
  const terrain = state.map.terrain || [];
  const all = liveOperatives(state);

  let found = all.filter((o) => o.playerId !== op.playerId && baseDistance(op, o) <= radius);
  if (effect.requireVisible) {
    found = found.filter((o) => traceSight(op, o, terrain,
      all.filter((b) => b.id !== op.id && b.id !== o.id)).visible);
  }
  if (effect.scope === 'each') return found;
  // One target, and the choice is not arbitrary: the operative this is most
  // likely to finish. Ties break on id so a replay is identical.
  return found.sort((a, b) => a.woundsRemaining - b.woundsRemaining ||
    (a.id < b.id ? -1 : 1)).slice(0, 1);
}

/** `inflictDamage` / `inflictToken`, shared by every trigger that offers them. */
function applyAreaEffect(state, rng, hook, op, ctx) {
  const effect = hook.effect || {};
  const recipients = areaRecipients(state, op, effect, ctx);
  if (!recipients.length) return false;

  let did = false;
  for (const victim of recipients) {
    if (!victim.alive) continue;
    if (effect.type === 'inflictDamage') {
      const amount = rollExpression(rng, effect.dice || 'D3');
      if (amount <= 0) continue;
      noteEffect(state, hook, op, `inflicts ${amount} damage on ${victim.name}`);
      applyDamage(state, victim.id, amount, {
        kind: effect.kind || 'rule', rule: hook.rule || hook.id, attackerId: op.id,
      });
      did = true;
    } else if (effect.type === 'inflictToken') {
      if (grantToken(state, victim, effect.token, {
        owner: op.playerId, rule: hook.rule || hook.id, source: { operativeId: op.id },
      })) did = true;
    }
  }
  return did;
}

/* ------------------------------------------------------------------ */
/* Trigger: onIncapacitated                                            */
/* ------------------------------------------------------------------ */

/**
 * Death throes — "when this operative is incapacitated, before it's removed
 * from the killzone".
 *
 * A whole family of printed rules lives here and nowhere else: the Gellerpox
 * bursting, the Blooded's spite, a Khorne Legionary getting one last swing in.
 * They were the largest single group of ploys this engine could not play.
 *
 * The operative is still standing where it fell — nothing is ever spliced out
 * of `state.operatives` — so the radius is measured from the body, which is
 * what the printed timing asks for.
 *
 * `demiseFired` bounds the chain: throes that kill somebody whose own team has
 * throes do cascade, but each operative contributes at most once, so a huddled
 * roster cannot loop.
 */
export function fireIncapacitated(state, op, ctx = {}) {
  if (!op || op.demiseFired) return;
  op.demiseFired = true;

  // The CP window: a firefight ploy printed for this moment is bought here,
  // for the same reason a reaction is bought inside an attack — there is no
  // action layer to ask, and the moment does not come round again.
  const bought = demiseHooks(state, op, ctx);
  const hooks = activeHooks(state, op, 'onIncapacitated', ctx)
    .concat(bought.filter((h) => h.trigger === 'onIncapacitated')
      .filter((h) => matches(state, h, { operative: op, ...ctx })));
  if (!hooks.length) return;

  const rng = auxRng(state);
  for (const hook of hooks) {
    notePartial(state, hook);
    const effect = hook.effect || {};
    if (effect.type === 'inflictDamage' || effect.type === 'inflictToken') {
      applyAreaEffect(state, rng, hook, op, ctx);
    } else {
      unknownEffect(state, hook);
    }
  }
  commitAux(state, rng);
}

/* ------------------------------------------------------------------ */
/* Trigger: afterAction                                                */
/* ------------------------------------------------------------------ */

/**
 * What an action leaves behind once it has resolved — the Nemesis Claw
 * crashing into a charge target hard enough to hurt it.
 *
 * `ctx.actionPerformed` and `ctx.actionCount` let a pack say "if the first
 * action it performs during that activation is the Charge action" without a
 * bespoke condition per rule.
 */
export function fireAfterAction(state, op, actionType) {
  if (!op?.alive) return;
  const ctx = {
    actionPerformed: actionType,
    actionCount: (op.usedThisActivation || []).length,
  };
  const hooks = activeHooks(state, op, 'afterAction', ctx);
  if (!hooks.length) return;

  const rng = auxRng(state);
  for (const hook of hooks) {
    notePartial(state, hook);
    const effect = hook.effect || {};
    if (effect.type === 'inflictDamage' || effect.type === 'inflictToken') {
      applyAreaEffect(state, rng, hook, op, ctx);
    } else if (effect.type === 'changeOrder') {
      setOrder(state, hook, op, effect.order);
    } else {
      unknownEffect(state, hook);
    }
  }
  commitAux(state, rng);
}

/* ------------------------------------------------------------------ */
/* Trigger: afterRetaliation                                           */
/* ------------------------------------------------------------------ */

/**
 * "Whenever a friendly operative finishes retaliating…" — the Wolf Scouts'
 * parting bite. Fired on the operative that was fought AGAINST, with the
 * attacker as the other half of the sequence, and only while both are still
 * standing and still in each other's faces.
 */
export function fireRetaliation(state, rng, retaliator, attacker) {
  if (!retaliator?.alive || !attacker?.alive) return;
  const ctx = { attacker, target: attacker, action: 'fight' };
  for (const hook of activeHooks(state, retaliator, 'afterRetaliation', ctx)) {
    notePartial(state, hook);
    const effect = hook.effect || {};
    if (effect.type === 'inflictDamage' || effect.type === 'inflictToken') {
      applyAreaEffect(state, rng, hook, retaliator, ctx);
    } else {
      unknownEffect(state, hook);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Trigger: onActivationEnd                                            */
/* ------------------------------------------------------------------ */

/** The other end of `fireActivationStart`: what lapses, or slips away. */
export function fireActivationEnd(state, op) {
  if (!op?.alive) return;
  for (const hook of activeHooks(state, op, 'onActivationEnd')) {
    notePartial(state, hook);
    const effect = hook.effect || {};
    if (effect.type === 'changeOrder') setOrder(state, hook, op, effect.order);
    else unknownEffect(state, hook);
  }
}

/* ------------------------------------------------------------------ */
/* Trigger: onTargetSelection                                          */
/* ------------------------------------------------------------------ */

/**
 * The defender's veto over being picked at all.
 *
 * SHIFTY, IN POSITION and COVERT POSITION all print the same sentence: a
 * concealed operative in cover cannot be selected, "taking precedence over all
 * other rules (e.g. Seek, Vantage terrain) except being within 2\"". That
 * precedence is the whole point of the rule and it cannot be expressed as a
 * weapon-rule tweak, so it is asked here — before Seek or a spotter get their
 * say — and answered from the target's own team pack.
 *
 * @param {object} sight the raw trace, BEFORE any Seek allowance
 * @returns {string|null} why this operative may not be selected, or null
 */
export function targetingDenied(state, target, sight, ctx = {}) {
  if (!target?.alive) return null;
  for (const hook of activeHooks(state, target, 'onTargetSelection', ctx)) {
    const effect = hook.effect || {};
    if (effect.type !== 'denyTargeting') { unknownEffect(state, hook); continue; }
    notePartial(state, hook);
    if (effect.requireConceal !== false && target.order !== ORDERS.CONCEAL) continue;
    if (effect.requireCover !== false && !sight?.cover) continue;
    const except = Number(effect.exceptWithin) || 0;
    if (except > 0 && ctx.attacker && baseDistance(ctx.attacker, target) <= except) continue;
    noteEffect(state, hook, target, 'cannot be selected as a valid target');
    return `${hook.rule || hook.id}: cannot be selected as a valid target`;
  }
  return null;
}
