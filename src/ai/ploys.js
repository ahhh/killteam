/**
 * Choosing strategic ploys: the AI half of `rules/ploys.js`.
 *
 * Buying a ploy is a *team* decision made once a turning point, before anyone
 * has activated, so it cannot be folded into the per-operative planner the way
 * a resource spend is (`spending.js`). It also cannot be a fixed priority
 * list: the same ploy is worth very different amounts to different teams, and
 * to the same team at different moments.
 *
 *   WAAAGH! grants Balanced to melee weapons. To a team that reaches melee it
 *   is most of an extra hit per fight; to a gunline holding a firing line it
 *   is a wasted CP, and the gunline should be saving for something else.
 *
 * So a ploy is priced by what its hooks actually *do*, measured against the
 * roster that would benefit and the disposition the team fights with — the
 * same two layers `tactics.js` already uses to shape an activation. Nothing
 * here is hand-tuned per team, and a pack that adds a ploy gets a sensible
 * valuation without an AI change.
 *
 * The engine re-checks every purchase (#3), so an unaffordable or illegal pick
 * proposed here is rejected rather than trusted.
 */
import { playablePloys } from '../rules/ploys.js';
import { liveOperatives } from '../state.js';
import { dispositionFor } from './tactics.js';
import { getProfile } from '../rules/shooting.js';
import { isInjured } from '../rules/effects.js';

/** Below this score a ploy is not worth its CP and the AI passes. */
const WORTH_BUYING = 1.0;

/* ------------------------------------------------------------------ */
/* Pricing one ploy                                                    */
/* ------------------------------------------------------------------ */

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

  let eligible = 0;
  for (const op of live) {
    const profile = getProfile(state, op);
    const keywords = profile?.keywords || [];
    const weapons = profile?.weapons || [];

    if (cond.keyword && !keywords.includes(cond.keyword)) continue;
    if (cond.notKeyword && keywords.includes(cond.notKeyword)) continue;
    if (cond.role && profile?.role !== cond.role) continue;
    if (cond.orderIs && op.order !== cond.orderIs) continue;
    if (cond.weaponType && !weapons.some((w) => w.type === cond.weaponType)) continue;
    if (cond.weaponIdIn && !weapons.some((w) => cond.weaponIdIn.includes(w.id))) continue;
    if (cond.weaponNameContains) {
      const hit = weapons.some((w) => cond.weaponNameContains
        .some((frag) => (w.name || '').toLowerCase().includes(frag)));
      if (!hit) continue;
    }
    if (cond.selfWounded !== undefined && isInjured(op) !== cond.selfWounded) continue;
    eligible++;
  }
  return (eligible / live.length) * situationalDiscount(cond);
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
  if (cond.performedThisActivation) d *= 0.4;
  if (cond.notPerformedThisActivation) d *= 0.6;
  if (cond.withinShadow !== undefined) d *= 0.4;
  return d;
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
    case 'modifyDefenceDice':
      return 1.4 * Math.abs(effect.delta ?? 1);
    case 'rerollDefenceDice':
      return 1.3 * Math.abs(effect.count ?? 1);
    case 'modifySave':
      return 1.5 * Math.abs(effect.delta ?? 1);
    case 'capDamage':
      return 1.6;
    case 'healWounds':
      return 1.1;
    case 'freeAction':
    case 'extraAction':
      // A whole extra action a turning point is the most valuable thing on
      // this list; it is an AP the opponent does not have.
      return 2.4;
    case 'allowChargeWhileConceal':
      return 1.8;
    case 'grantAllyApl':
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
    'freeAction', 'extraAction', 'grantAllyApl'].includes(effect.type);
  const defensive = ['modifyDefenceDice', 'rerollDefenceDice', 'modifySave',
    'capDamage', 'healWounds'].includes(effect.type);
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
/* Choosing a turning point's ploys                                    */
/* ------------------------------------------------------------------ */

/**
 * Which strategic ploys to buy at the start of this turning point.
 *
 * Greedy by value per CP, which is right here because the budget is tiny
 * (1-4 CP) and ploys do not combine — there is no pair worth more than the
 * sum of its parts to search for.
 *
 * @returns {{ployId:string, score:number, reason:string}[]} in purchase order
 */
export function chooseStrategicPloys(state, playerId) {
  const disposition = dispositionFor(state, playerId);
  const picks = [];
  let budget = state.players[playerId].cp;

  // The last turning point is the last chance to convert CP into anything at
  // all — unspent CP scores nothing — so the bar drops to "better than zero".
  const lastChance = state.turningPoint >= (state.mission?.turningPoints ?? 4);
  const bar = lastChance ? 0.01 : WORTH_BUYING;

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
