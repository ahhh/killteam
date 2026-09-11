/**
 * Spending team resources: the AI half of `rules/resources.js`.
 *
 * Earning a Pain token is the engine's business; deciding that *this* is the
 * activation to burn one on Dark Animus is a tactical judgement, and it belongs
 * next to the rest of the AI's judgements rather than buried in the rules.
 *
 * Everything here returns plain action lists the controller splices into a
 * plan. A spend costs no AP, so it never competes with an action — it competes
 * with the *other* spends, because the printed limits allow only one or two per
 * activation. That is what the priorities below are for.
 *
 * The rules layer re-checks every spend when it resolves (#3), so a bundle the
 * AI proposes optimistically is rejected harmlessly rather than cheating.
 */
import { availableSpends, declaredSpends, amountOf } from '../rules/resources.js';
import { effectiveMove, isInjured } from '../rules/effects.js';
import { baseDistance } from '../maps/geometry.js';

/** How far away an enemy can be and still be worth buying an extra AP for. */
const APL_REACH_BONUS = 12;
/** A D3 averages 2; used to price Rake without rolling it. */
const D3_AVERAGE = 2;

/**
 * Every spend the AI proposes is `optional`.
 *
 * The printed limits ("no more than two SANGUAVITAE rules per activation")
 * interact with what the operative has already bought this activation, and the
 * rules layer is the only place that knows. Rather than model the arithmetic
 * twice, the AI asks in value order and a spend that turns out to be one too
 * many is dropped silently instead of logged as a rejected action.
 */
function spendAction(option, extra = {}) {
  return {
    type: 'spend',
    resource: option.key,
    spendId: option.spend.id,
    spendName: option.spend.name || option.spend.id,
    optional: true,
    ...extra,
  };
}

/**
 * How many spends of one resource can actually land this activation: what the
 * printed limit allows, and what the operative can afford.
 */
function budgetFor(state, op, option) {
  const limit = Number(option.def.perActivation) || Infinity;
  const affordable = Math.floor(amountOf(state, op, option.key) / (option.cost || 1));
  return Math.min(limit, affordable);
}

function label(option) {
  return option.spend.name || option.spend.id;
}

function effectsOf(state, op, type, window = 'activation') {
  return availableSpends(state, op, { window })
    .filter((o) => o.spend.effect?.type === type);
}

/**
 * The spends worth making at the top of an activation, whatever the operative
 * then does with its AP.
 *
 * Two compete: wounds back, or an extra point of AP. The order is the one a
 * player would use — an operative that is Injured is losing a point of APL to
 * its wounds anyway, so healing buys the same AP *and* keeps it alive, while a
 * healthy operative would rather have the action.
 *
 * @returns {{always:Array, conditional:Array, apBonus:number, rationale:string[]}}
 *          `conditional` is spent only if the plan actually uses the AP.
 */
export function openingSpends(state, op, { enemies = [] } = {}) {
  const out = { always: [], conditional: [], apBonus: 0, rationale: [] };
  const lost = op.wounds - op.woundsRemaining;

  const heals = effectsOf(state, op, 'healWounds');
  const apls = effectsOf(state, op, 'addApl');

  // Worth healing at all? "Up to D3+1" wasted on a scratch is a token thrown
  // away, so the operative has to have actually lost something worth back.
  const healWorthIt = heals.length && (isInjured(op) ? lost >= 1 : lost >= 3);
  const nearest = enemies.length
    ? Math.min(...enemies.map((e) => baseDistance(op, e)))
    : Infinity;
  const aplWorthIt = apls.length &&
    nearest <= effectiveMove(op) + APL_REACH_BONUS &&
    !(isInjured(op) && healWorthIt);

  if (healWorthIt && !(aplWorthIt && !isInjured(op))) {
    const heal = heals[0];
    out.always.push(spendAction(heal));
    out.rationale.push(`Spends ${label(heal)} to close its wounds`);
  } else if (aplWorthIt) {
    const apl = apls[0];
    out.conditional.push(spendAction(apl));
    out.apBonus += Number(apl.spend.effect.amount) || 1;
    out.rationale.push(`Spends ${label(apl)} for an extra action`);
  }
  return out;
}

/**
 * Spends that only pay off in a melee plan, so they ride with the charge and
 * the fight rather than being bought up front.
 *
 * @returns {{before:Array, afterCharge:Array, atkBonus:number,
 *            moveBonus:number, extraFights:number, rationale:string[]}}
 */
export function meleeSpends(state, op) {
  const out = {
    before: [], afterCharge: [], atkBonus: 0, moveBonus: 0,
    extraFights: 0, extraDamage: 0, rationale: [],
  };
  // What is left in the budget as each is bought — a GORE TANK that starts at
  // half pays for exactly one of these, so asking for three would be a plan
  // built on damage the operative is never going to do.
  const spent = new Map();
  const take = (option) => {
    const used = spent.get(option.key) || 0;
    if (used >= budgetFor(state, op, option)) return false;
    spent.set(option.key, used + 1);
    return true;
  };

  // Ranked by what they are worth to a charge: more dice first, then a second
  // Fight, then the inch that decides whether the charge lands at all.
  for (const option of effectsOf(state, op, 'weaponBoost')) {
    const effect = option.spend.effect;
    if (effect.weaponType && effect.weaponType !== 'melee') continue;
    if (!take(option)) break;
    out.before.push(spendAction(option));
    out.atkBonus += Number(effect.atkBonus) || 0;
    out.rationale.push(`Spends ${label(option)} for a heavier swing`);
    break;
  }
  for (const option of effectsOf(state, op, 'extraAction')) {
    if (option.spend.effect.action !== 'fight') continue;
    if (!take(option)) break;
    out.before.push(spendAction(option));
    out.extraFights += Number(option.spend.effect.count) || 1;
    out.rationale.push(`Spends ${label(option)} for a second Fight action`);
    break;
  }
  for (const option of effectsOf(state, op, 'moveBonus')) {
    if (!(option.spend.effect.appliesTo || []).includes('charge')) continue;
    if (!take(option)) break;
    out.before.push(spendAction(option));
    out.moveBonus += Number(option.spend.effect.inches) || 1;
    out.rationale.push(`Spends ${label(option)} to close the last inch`);
    break;
  }
  // Rake is bought once the charge has landed — its condition is that the
  // operative has already performed the Charge action this activation.
  for (const option of effectsOf(state, op, 'inflictDamage')) {
    if (!take(option)) break;
    out.afterCharge.push(spendAction(option));
    out.extraDamage += D3_AVERAGE;
    out.rationale.push(`Spends ${label(option)} to open the enemy up on contact`);
    break;
  }
  return out;
}

/**
 * The mirror of `meleeSpends` for a plan that ends in a Shoot action.
 *
 * `meleeSpends` deliberately skips any `weaponBoost` that is not a melee one,
 * because a heavier swing is worth nothing to a plan that never reaches
 * contact. The reverse is just as true and had nowhere to be asked: ORK IT UP
 * is a whole faction economy spent before the attack dice of a *ranged*
 * weapon, and without this the Loot Points filled up and were never spent.
 *
 * One boost per activation, valued the way `ai/ploys.js` values the same
 * fields so a spend and a ploy that buy the same thing are priced alike.
 *
 * @returns {{actions:Array, atkBonus:number, damageMultiplier:number,
 *            rationale:string[]}}
 */
export function shootingSpends(state, op) {
  const out = { actions: [], atkBonus: 0, damageMultiplier: 1, rationale: [] };
  for (const option of effectsOf(state, op, 'weaponBoost')) {
    const effect = option.spend.effect;
    if (effect.weaponType === 'melee') continue;
    const applies = effect.appliesTo;
    if (Array.isArray(applies) && !applies.includes('shoot')) continue;
    if (budgetFor(state, op, option) < 1) break;
    out.actions.push(spendAction(option));
    out.atkBonus += Number(effect.atkBonus) || 0;
    out.damageMultiplier *= 1 + 0.12 * ((Number(effect.damageNormal) || 0) +
      (Number(effect.damageCritical) || 0));
    if (effect.rules?.length) out.damageMultiplier *= 1 + 0.1 * effect.rules.length;
    out.rationale.push(`Spends ${label(option)} on the shot`);
    break;
  }
  return out;
}

/**
 * The reaction a kill unlocks — Vitalised Surge's free Dash.
 *
 * Whether it fires depends on dice that have not been rolled, so both actions
 * are marked `optional`: if the target survives, the spend is illegal and the
 * pair is dropped without a word (see `runActivation`).
 *
 * @returns {{actions:Array, rationale:string[]}|null}
 */
export function postKillSpends(state, op, destination) {
  // Declared rather than available: the kill it keys off has not happened yet,
  // so the spend is not legal at planning time and never will be until it is.
  const options = declaredSpends(state, op, { window: 'activation' })
    .filter((o) => o.spend.effect?.type === 'freeAction');
  for (const option of options) {
    const effect = option.spend.effect;
    if (!option.spend.condition?.incapacitatedThisActivation) continue;
    if (effect.action !== 'dash' || !destination) continue;
    return {
      actions: [
        spendAction(option, { optional: true }),
        {
          type: 'dash', optional: true,
          destination: { x: destination.x, y: destination.y },
        },
      ],
      rationale: [`If the target drops, spends ${label(option)} to slip ${destination.length.toFixed(1)}" away`],
    };
  }
  return null;
}

/** True when a spend could put wounds back on this operative right now. */
export function canHealItself(state, op) {
  return effectsOf(state, op, 'healWounds').length > 0;
}

/** What the log says about the economy this operative is playing with. */
export function spendLabels(state, op) {
  const options = availableSpends(state, op, { window: 'activation' });
  if (!options.length) return [];
  const names = [...new Set(options.map(label))];
  return [`can spend: ${names.join(', ')}`];
}
