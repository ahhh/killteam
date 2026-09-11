/**
 * Choosing ploys: the AI half of `rules/ploys.js`.
 *
 * Two decisions live here, and they are different in kind.
 *
 * A STRATEGIC ploy is a *team* decision made once a turning point, before
 * anyone has activated, so it cannot be folded into the per-operative planner
 * the way a resource spend is (`spending.js`). It also cannot be a fixed
 * priority list: the same ploy is worth very different amounts to different
 * teams, and to the same team at different moments.
 *
 *   WAAAGH! grants Balanced to melee weapons. To a team that reaches melee it
 *   is most of an extra hit per fight; to a gunline holding a firing line it
 *   is a wasted CP, and the gunline should be saving for something else.
 *
 * A FIREFIGHT ploy is the opposite: one operative, one activation, decided
 * with the board in front of it. It is priced for the plan being built — a
 * second Fight action is worth nothing to an operative that is about to shoot
 * — and bought as a 0-AP `{type:'ploy'}` action the engine re-checks (#3).
 *
 * Both are priced by what their hooks actually *do*, measured against the
 * roster (or the operative) that would benefit and the disposition the team
 * fights with. Nothing here is hand-tuned per team, and a pack that adds a
 * ploy gets a sensible valuation without an AI change.
 *
 * What is NOT decided here is how much CP to let go of at all. That is the
 * doctrine in `cp.js`, which sets the bar every score below is measured
 * against and the reserve this module is not allowed to touch.
 */
import { playablePloys, playableFirefightPloys } from '../rules/ploys.js';
import { liveOperatives } from '../state.js';
import { dispositionFor } from './tactics.js';
import { getProfile } from '../rules/shooting.js';
import { isInjured } from '../rules/effects.js';

/** Below this score a ploy is not worth its CP; the doctrine may raise it. */
const WORTH_BUYING = 1.0;

/* ------------------------------------------------------------------ */
/* Pricing one ploy                                                    */
/* ------------------------------------------------------------------ */

/**
 * Could this hook apply to this operative at all?
 *
 * Only the conditions that are settled before the sequence starts — what the
 * operative is, what it carries, what order it is on. The rest are charged a
 * likelihood in `situationalDiscount`.
 */
function hookCouldReach(state, op, cond = {}) {
  const profile = getProfile(state, op);
  const keywords = profile?.keywords || [];
  const weapons = profile?.weapons || [];

  if (cond.keyword && !keywords.includes(cond.keyword)) return false;
  if (cond.notKeyword) {
    const excluded = Array.isArray(cond.notKeyword) ? cond.notKeyword : [cond.notKeyword];
    if (excluded.some((k) => keywords.includes(k))) return false;
  }
  if (cond.role && profile?.role !== cond.role) return false;
  if (cond.orderIs && op.order !== cond.orderIs) return false;
  if (cond.weaponType && !weapons.some((w) => w.type === cond.weaponType)) return false;
  if (cond.weaponIdIn && !weapons.some((w) => cond.weaponIdIn.includes(w.id))) return false;
  if (cond.weaponNameContains) {
    const hit = weapons.some((w) => cond.weaponNameContains
      .some((frag) => (w.name || '').toLowerCase().includes(frag)));
    if (!hit) return false;
  }
  if (cond.weaponHasAnyRule) {
    const names = weapons.flatMap((w) => (w.rules || [])
      .map((r) => String(r).toLowerCase().replace(/\d+$/, '')));
    if (!cond.weaponHasAnyRule.some((r) => names.includes(r))) return false;
  }
  if (cond.selfWounded !== undefined && isInjured(op) !== cond.selfWounded) return false;
  return true;
}

/**
 * How much of this team is in a position to use a hook right now.
 *
 * A hook that wants melee weapons is priced by the operatives that *have*
 * melee weapons and are close enough to swing them; one that wants Conceal
 * orders is priced by the operatives actually on Conceal. This is what stops
 * every team from buying every ploy every turning point.
 *
 * @returns {number} 0..1, the share of the living roster the hook can reach
 */
function reach(state, playerId, hook) {
  const live = liveOperatives(state, playerId);
  if (!live.length) return 0;
  const cond = hook.condition || {};
  const eligible = live.filter((op) => hookCouldReach(state, op, cond)).length;
  return (eligible / live.length) * situationalDiscount(cond) *
    triggerLikelihood(hook.trigger);
}

/**
 * Some triggers are always in force; others wait on an event that may not
 * happen. A rule that fires when an operative is incapacitated is worth real
 * CP — but not the CP of one that applies to every attack of the turning
 * point, and pricing the two the same would have every team buying its death
 * throes first.
 */
function triggerLikelihood(trigger) {
  switch (trigger) {
    case 'onIncapacitated': return 0.5;
    case 'afterRetaliation': return 0.45;
    case 'afterAction': return 0.5;
    default: return 1;
  }
}

/**
 * Conditions about the *other* half of an attack cannot be counted over the
 * roster, because they depend on a sequence that has not happened yet. Rather
 * than ignore them — which would price a narrow ploy like a team-wide one —
 * each is charged a flat likelihood of coming up.
 */
function situationalDiscount(cond) {
  let d = 1;
  if (cond.action) d *= 0.6;                    // half the sequences are the other kind
  if (cond.targetWithin !== undefined) d *= cond.targetWithin >= 6 ? 0.5 : 0.3;
  if (cond.targetBeyond !== undefined) d *= 0.5;
  if (cond.targetOrderIs) d *= 0.5;
  if (cond.targetKeyword) d *= 0.4;
  if (cond.targetWounded !== undefined) d *= 0.35;
  if (cond.targetReady !== undefined) d *= 0.5;
  if (cond.selfReady !== undefined) d *= 0.5;
  if (cond.awayFromFriends !== undefined) d *= 0.35;
  if (cond.friendlyWithin !== undefined) d *= 0.7;
  if (cond.nearObjective !== undefined) d *= 0.5;
  if (cond.performedThisActivation) d *= 0.4;
  if (cond.notPerformedThisActivation) d *= 0.6;
  if (cond.withinShadow !== undefined) d *= 0.4;
  if (cond.awayFromEnemies !== undefined) d *= 0.6;
  if (cond.counteracting !== undefined) d *= 0.3;
  if (cond.actionIs !== undefined) d *= 0.4;
  if (cond.actionCountAtMost !== undefined) d *= 0.6;
  return d;
}

/** The mean of a dice expression — "D3" is 2, "D3+1" is 3, "1" is 1. */
function expectedRoll(expr) {
  const text = String(expr ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const m = /^(?:(\d*)[Dd](\d+))?\s*(?:([+-])\s*(\d+))?$/.exec(text);
  if (!m) return 0;
  let total = m[2] ? (m[1] ? Number(m[1]) : 1) * (Number(m[2]) + 1) / 2 : 0;
  if (m[4]) total += (m[3] === '-' ? -1 : 1) * Number(m[4]);
  return Math.max(0, total);
}

/**
 * What one hook is worth per operative it reaches, before disposition.
 *
 * These are deliberately coarse. The point is to rank a team's own ploys
 * against each other and against holding the CP, not to price them exactly —
 * an ordering that is roughly right beats a number that is precisely wrong.
 */
function hookValue(hook) {
  const effect = hook.effect || {};
  switch (effect.type) {
    case 'grantWeaponRule':
      // Roughly a tenth of a hit per rule, per attack, across the sequence.
      return 1.2 * (effect.rules?.length || 1);
    case 'ignoreWeaponRules':
      return 1.0 * (effect.rules?.length || 1);
    case 'modifyWeapon':
      return 1.2 * (Math.abs(Number(effect.atkBonus) || 0) +
        Math.abs(Number(effect.damageNormal) || 0) * 0.8 +
        Math.abs(Number(effect.damageCritical) || 0) * 0.6 +
        Math.abs(Number(effect.hitBonus) || 0) * 1.2);
    case 'modifyDefenceDice':
      return 1.4 * Math.abs(effect.delta ?? 1);
    case 'rerollDefenceDice':
      return 1.3 * Math.abs(effect.count ?? 1);
    case 'modifySave':
      return 1.5 * Math.abs(effect.delta ?? 1);
    case 'capDamage':
      return 1.6;
    case 'reduceDamage':
      return 1.2 * (Number(effect.amount) || 1);
    case 'healWounds':
      return 1.1;
    case 'freeAction':
    case 'extraAction':
      // A whole extra action a turning point is the most valuable thing on
      // this list; it is an AP the opponent does not have.
      return 2.4;
    case 'addApl':
      return 2.2 * (Number(effect.amount) || 1);
    case 'discountAction':
      return 1.6 * (Number(effect.amount) || 1);
    case 'modifyMove':
      return 0.45 * (Number(effect.inches) || 1);
    case 'ignoreInjured':
      return 1.4;
    case 'clearTokens':
      return 1.3;
    case 'allowChargeWhileConceal':
      return 1.8;
    case 'grantAllyApl':
      return 2.0;
    case 'inflictDamage':
      // Damage nobody had to roll attack dice for, so it is priced off the
      // wounds it deals rather than off a hit rate. `each` reaches a crowd.
      return 0.7 * expectedRoll(effect.dice || 'D3') *
        (effect.scope === 'each' ? 1.6 : 1);
    case 'inflictToken':
      // A token that costs its holder an action is worth roughly what buying
      // ourselves one is; anything else is a lesser nuisance.
      return effect.token?.whileHeld?.aplDelta ? 1.8 : 1.0;
    case 'changeOrder':
      return 0.9;
    case 'denyTargeting':
      // Not being shootable at all is the strongest defensive line there is,
      // discounted by needing Conceal and cover to stand up.
      return 2.0;
    default:
      return 0;
  }
}

/**
 * Disposition decides what a team *wants*. An aggressive team pays over the
 * odds for anything that helps it close and swing; a gunline pays for staying
 * alive at range. Mirrors the multipliers in `tactics.js`.
 */
function dispositionWeight(disposition, hook) {
  const effect = hook.effect || {};
  const cond = hook.condition || {};
  const offensive = ['grantWeaponRule', 'ignoreWeaponRules', 'allowChargeWhileConceal',
    'freeAction', 'extraAction', 'grantAllyApl', 'modifyWeapon', 'addApl',
    'discountAction', 'modifyMove', 'inflictDamage', 'inflictToken'].includes(effect.type);
  const defensive = ['modifyDefenceDice', 'rerollDefenceDice', 'modifySave',
    'capDamage', 'reduceDamage', 'healWounds', 'ignoreInjured',
    'denyTargeting'].includes(effect.type);
  const melee = cond.weaponType === 'melee' || effect.type === 'allowChargeWhileConceal';

  const mods = disposition.mods || {};
  let w = 1;
  if (offensive) w *= mods.damage ?? 1;
  if (defensive) w *= mods.survival ?? 1;
  // A team told to close values a melee buff more than its raw damage
  // multiplier suggests, because closing is the plan the buff pays off.
  if (melee) w *= Math.max(1, (mods.approach ?? 1) * 0.8);
  return w;
}

/**
 * What this ploy is worth to this team, right now, per CP spent.
 * @returns {{score:number, reason:string}}
 */
export function valuePloy(state, playerId, ploy, disposition) {
  let total = 0;
  const parts = [];
  for (const hook of ploy.hooks) {
    const share = reach(state, playerId, hook);
    if (share <= 0) continue;
    const base = hookValue(hook);
    if (base <= 0) continue;
    const weighted = base * share * dispositionWeight(disposition, hook);
    total += weighted;
    parts.push(`${Math.round(share * 100)}% of the team`);
  }
  const score = total / Math.max(1, ploy.cost);
  return {
    score,
    reason: parts.length ? `${ploy.name}: reaches ${parts[0]}` : `${ploy.name}: nothing to apply it to`,
  };
}

/* ------------------------------------------------------------------ */
/* Choosing a turning point's strategic ploys                          */
/* ------------------------------------------------------------------ */

/**
 * Which strategic ploys to buy at the start of this turning point.
 *
 * Greedy by value per CP, which is right here because the budget is tiny
 * (1-4 CP) and ploys do not combine — there is no pair worth more than the
 * sum of its parts to search for.
 *
 * The budget is not the whole purse. `cp.js` decides how much of it this team
 * refuses to commit before the shooting starts, and that reserve is the CP a
 * Banshee pays for a second swing three activations from now, or that answers
 * the shot that would otherwise kill the sniper.
 *
 * @param {object} [plan] the turning point's CP plan; recomputed if omitted
 * @returns {{ployId:string, score:number, reason:string}[]} in purchase order
 */
export function chooseStrategicPloys(state, playerId, plan = null) {
  const disposition = dispositionFor(state, playerId);
  // No plan means no doctrine — a scripted test, or a controller that does not
  // run one. The old flat bar is the right default there.
  const cpPlan = plan || state.players[playerId].cpPlan;
  const picks = [];

  const reserve = Math.max(0, Number(cpPlan?.reserve) || 0);
  let budget = Math.max(0, state.players[playerId].cp - reserve);
  const bar = Number.isFinite(cpPlan?.strategicBar) ? cpPlan.strategicBar : WORTH_BUYING;

  const taken = new Set();
  for (;;) {
    const options = playablePloys(state, playerId)
      .filter((p) => !taken.has(p.id) && p.cost <= budget)
      .map((p) => ({ ploy: p, ...valuePloy(state, playerId, p, disposition) }))
      .sort((a, b) => b.score - a.score || (a.ploy.id < b.ploy.id ? -1 : 1));

    const best = options[0];
    if (!best || best.score < bar) break;

    taken.add(best.ploy.id);
    budget -= best.ploy.cost;
    picks.push({
      ployId: best.ploy.id, cost: best.ploy.cost,
      score: Number(best.score.toFixed(2)), reason: best.reason,
    });
    if (budget <= 0) break;
  }
  return picks;
}

/* ------------------------------------------------------------------ */
/* Firefight ploys: CP spent inside an activation                      */
/* ------------------------------------------------------------------ */

/**
 * What a firefight ploy is worth to THIS operative in THIS kind of plan.
 *
 * The mode is the plan being built — `melee`, `shoot` or `move`. It is the
 * difference between a ploy that is the best CP a team will spend all game and
 * one that does nothing at all: "this operative can perform two Fight actions"
 * is worth 2.4 to a Banshee about to charge and zero to the sniper on the roof.
 *
 * @returns {{score:number, buffs:object}}
 */
export function valueFirefightPloy(state, op, ploy, disposition, mode, context = {}) {
  const buffs = emptyBuffs();
  let total = 0;
  for (const hook of ploy.hooks) {
    const cond = hook.condition || {};
    if (!hookCouldReach(state, op, cond)) continue;
    const effect = hook.effect || {};
    const relevance = modeRelevance(mode, hook, context);
    if (relevance <= 0) continue;

    total += hookValue(hook) * relevance * planAwareDiscount(cond, mode) *
      dispositionWeight(disposition, hook);
    foldIntoBuffs(buffs, effect, mode);
  }
  return { score: total / Math.max(1, ploy.cost), buffs };
}

/**
 * `situationalDiscount` charges a condition a likelihood because a strategic
 * ploy is bought before anyone knows what the turning point holds. A firefight
 * ploy is not: it is bought for a plan that is about to be performed, and the
 * planner knows whether that plan charges, fights or shoots. Conditions the
 * plan itself settles are therefore not discounted — which is the difference
 * between buying Shock Assault for the charge that is happening and pricing it
 * as a one-in-three chance.
 */
function planAwareDiscount(cond, mode) {
  const settled = { ...cond };
  if (mode === 'melee') {
    if (settled.action === 'fight') delete settled.action;
    if (Array.isArray(settled.performedThisActivation) &&
        settled.performedThisActivation.every((a) => a === 'charge' || a === 'fight')) {
      delete settled.performedThisActivation;
    }
  }
  if (mode === 'shoot' && settled.action === 'shoot') delete settled.action;
  return situationalDiscount(settled);
}

/**
 * How much this hook matters to the plan being built.
 *
 * Zero means "this ploy does nothing for this plan", which is a stronger claim
 * than "not much" — it is what keeps the AI from paying a CP for a melee buff
 * on a shooting activation. A defensive hook is priced low rather than zero,
 * because an operative that is about to stand in the open will be shot at.
 */
function modeRelevance(mode, hook, context = {}) {
  const effect = hook.effect || {};
  const cond = hook.condition || {};
  const weaponType = cond.weaponType || null;
  const action = cond.action || null;

  // An extra AP is worth the same whatever the operative then does with it, so
  // it is bought up front, once, in the `opening` pass — and nowhere else, or
  // a melee plan and a shooting plan would each buy their own copy.
  const opening = effect.type === 'addApl' || effect.type === 'discountAction';
  if (mode === 'opening') {
    if (effect.type === 'addApl') return 1;
    // A discount is only worth paying for on an action this operative is
    // actually going to perform: Fall Back for 1 less AP is a dead CP unless
    // there is an enemy in its face right now.
    if (effect.type === 'discountAction') {
      const action = effect.action;
      if (action === 'fall_back') return context.engaged ? 1 : 0;
      if (action === 'fight' || action === 'charge') return context.engaged ? 1 : 0.6;
      return 0.8;
    }
    return 0;
  }
  if (opening) return 0;

  switch (effect.type) {
    case 'extraAction':
    case 'freeAction': {
      const granted = effect.action || (effect.oneOf || [])[0];
      if (granted === 'fight') return mode === 'melee' ? 1 : 0;
      if (granted === 'shoot') return mode === 'shoot' ? 1 : 0;
      if (granted === 'charge') return mode === 'melee' ? 1 : 0;
      // A free Dash is only ever worth buying for a plan that has somewhere to
      // walk to; anywhere else the grant expires unused and the CP is gone.
      return mode === 'move' ? 0.9 : 0;
    }
    case 'grantWeaponRule':
    case 'modifyWeapon':
    case 'ignoreWeaponRules':
      if (weaponType === 'melee' || action === 'fight') return mode === 'melee' ? 1 : 0;
      if (weaponType === 'ranged' || action === 'shoot') return mode === 'shoot' ? 1 : 0;
      return mode === 'move' ? 0 : 0.8;
    case 'allowChargeWhileConceal':
      return mode === 'melee' ? 1 : 0;
    case 'modifyMove':
      return mode === 'melee' ? 1 : (mode === 'move' ? 0.7 : 0);
    case 'modifyDefenceDice':
    case 'rerollDefenceDice':
    case 'modifySave':
    case 'capDamage':
    case 'reduceDamage':
    case 'ignoreInjured':
    case 'clearTokens':
    case 'healWounds':
    case 'denyTargeting':
      // Defensive hooks belong on a reactive ploy; bought as an action they
      // are a gamble on being shot at, so they are worth a fraction.
      return 0.3;
    case 'inflictDamage':
    case 'inflictToken':
      // Neither needs an attack roll, so neither cares which plan is running.
      return 0.7;
    case 'changeOrder':
      return mode === 'melee' ? 0.6 : 0.4;
    default:
      return 0.4;
  }
}

function emptyBuffs() {
  return {
    extraFights: 0, extraShoots: 0, atkBonus: 0, moveBonus: 0, apBonus: 0,
    chargeFromConceal: false, freeDash: false, damageMultiplier: 1,
  };
}

/** Translate one hook effect into the numbers the plan builder works in. */
function foldIntoBuffs(buffs, effect, mode) {
  switch (effect.type) {
    case 'extraAction': {
      const action = effect.action || (effect.oneOf || []).find(
        (a) => (mode === 'melee' ? a === 'fight' : a === 'shoot'));
      const count = Number(effect.count) || 1;
      if (action === 'fight') buffs.extraFights += count;
      if (action === 'shoot') buffs.extraShoots += count;
      break;
    }
    case 'freeAction':
      if (effect.action === 'fight') buffs.extraFights += 1;
      else if (effect.action === 'shoot') buffs.extraShoots += 1;
      else if (effect.action === 'dash') buffs.freeDash = true;
      break;
    case 'modifyWeapon':
      buffs.atkBonus += Number(effect.atkBonus) || 0;
      buffs.damageMultiplier *= 1 + 0.12 * ((Number(effect.damageNormal) || 0) +
        (Number(effect.damageCritical) || 0) * 0.6);
      break;
    case 'grantWeaponRule':
      // Re-rolls and retained successes do not change the profile the planner
      // reads, so they are carried as a multiplier on the estimate instead.
      buffs.damageMultiplier *= 1 + 0.1 * (effect.rules?.length || 1);
      break;
    case 'addApl':
      buffs.apBonus += Number(effect.amount) || 1;
      break;
    case 'modifyMove':
      buffs.moveBonus += Number(effect.inches) || 0;
      break;
    case 'allowChargeWhileConceal':
      buffs.chargeFromConceal = true;
      break;
    default:
      break;
  }
}

/**
 * The firefight ploys worth buying for one activation, for one kind of plan.
 *
 * Returns the actions to splice in front of the plan and the plan-level
 * numbers they buy, in exactly the shape `spending.js` returns for resource
 * spends — the controller then treats a CP and a Pain token the same way, and
 * a plan that is not chosen never pays for either.
 *
 * @param {string} mode 'melee' | 'shoot' | 'move'
 * @returns {{actions:Array, rationale:string[], cpSpent:number, …buffs}}
 */
export function firefightPloysFor(state, op, mode, { plan = null, context = {} } = {}) {
  const out = { actions: [], rationale: [], cpSpent: 0, ...emptyBuffs() };
  // No plan means no doctrine has run — a scripted test, or a controller that
  // does not keep one. Spending a team's CP on its behalf without the plan
  // that says what the CP is for would be worse than not spending it.
  const cpPlan = plan || state.players[op.playerId].cpPlan;
  if (!cpPlan) return out;

  const cp = state.players[op.playerId].cp;
  // The reaction budget is not this activation's to spend: it is the CP the
  // doctrine is holding for somebody else's turn.
  const budget = Math.max(0, cp - (Number(cpPlan.reactionBudget) || 0));
  if (budget <= 0) return out;

  const bar = Number.isFinite(cpPlan.firefightBar) ? cpPlan.firefightBar : WORTH_BUYING;
  const maxPloys = Math.max(1, Number(cpPlan.maxPerActivation) || 1);
  const disposition = dispositionFor(state, op.playerId);

  const options = playableFirefightPloys(state, op)
    .map((ploy) => ({ ploy, ...valueFirefightPloy(state, op, ploy, disposition, mode, context) }))
    .filter((o) => o.score >= bar)
    .sort((a, b) => b.score - a.score || (a.ploy.id < b.ploy.id ? -1 : 1));

  let left = budget;
  for (const option of options) {
    if (out.actions.length >= maxPloys) break;
    if (option.ploy.cost > left) continue;
    left -= option.ploy.cost;
    out.cpSpent += option.ploy.cost;
    // Optional, like a resource spend: if the plan that carries it is rejected
    // or the moment has passed, the CP is never paid (see `runActivation`).
    out.actions.push({ type: 'ploy', ployId: option.ploy.id, optional: true });
    out.rationale.push(`Spends ${option.ploy.cost} CP on ${option.ploy.name}`);
    mergeBuffs(out, option.buffs);
  }
  return out;
}

function mergeBuffs(target, buffs) {
  target.extraFights += buffs.extraFights;
  target.extraShoots += buffs.extraShoots;
  target.atkBonus += buffs.atkBonus;
  target.moveBonus += buffs.moveBonus;
  target.apBonus += buffs.apBonus;
  target.damageMultiplier *= buffs.damageMultiplier;
  target.chargeFromConceal = target.chargeFromConceal || buffs.chargeFromConceal;
  target.freeDash = target.freeDash || buffs.freeDash;
}
