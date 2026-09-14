/**
 * Utility AI controller.
 *
 * Produces an INTENT (a list of actions plus the reasoning behind them).
 * It never mutates state (#3) and never touches the battle RNG stream — ties
 * are broken with a derived stream so replays stay identical.
 */
import { Rng } from '../rng.js';
import { liveOperatives, ORDERS } from '../state.js';
import { profileOf } from '../rules/hooks.js';
import { baseDistance } from '../maps/geometry.js';
import { enemiesInControlRange, withinControlRange, CONTROL_RANGE } from '../rules/visibility.js';
import { effectiveApl, isInjured, effectiveMove } from '../rules/effects.js';
import { usableMoveAllowance } from '../rules/engine.js';
import { isLastTeamStanding } from '../rules/phases.js';
import { meleeWeapons } from '../rules/shooting.js';
import { timesAllowed, hasFreeAction } from '../rules/hooks.js';
import { DASH_DISTANCE, CHARGE_BONUS } from '../rules/movement.js';
import { generateDestinations, chargeDestination } from './movement.js';
import { bestShotFrom, bestMeleeTarget } from './targeting.js';
import { huntBonus } from './characters.js';
import {
  objectiveValueAt, exposureAt, coverQualityAt, expectedDamage,
  killPressure, threatValue, sightLinesAt, splashOpportunityAt,
  detonationOpportunityAt, endOrderOf,
} from './utility.js';
import { dispositionFor, unitTacticsFor, applyTactics } from './tactics.js';
import {
  openingSpends, meleeSpends, shootingSpends, postKillSpends, canHealItself,
} from './spending.js';
import {
  bestUniqueAction, guardValue, openingSupport, supportDestinationsFor,
} from './support.js';
import { chooseStrategicPloys, firefightPloysFor } from './ploys.js';
import { planCommandPoints } from './cp.js';
import { buildTacticOptions } from './options.js';

export const AI_VERSION = '0.4.0';

/**
 * Per-role weightings for the utility score.
 *
 * `approach` is what stops close-combat operatives from dithering: without a
 * positive drive to close, the exposure penalty alone keeps them at range,
 * where a gunline simply shoots them to pieces over four turning points.
 * Shooters get a negative weight — for them, distance is an asset.
 */
export const ROLE_WEIGHTS = {
  flexible:           { damage: 3.0, objective: 4.0, cover: 1.5, exposure: 2.5, waste: 0.5, survival: 2.0, approach: 0.8 },
  assault:            { damage: 4.0, objective: 3.0, cover: 0.8, exposure: 1.0, waste: 0.5, survival: 1.0, approach: 5.0 },
  ranged:             { damage: 3.4, objective: 2.6, cover: 2.0, exposure: 3.0, waste: 0.5, survival: 2.0, approach: 0.0 },
  sniper:             { damage: 3.8, objective: 1.6, cover: 2.6, exposure: 3.6, waste: 0.5, survival: 2.4, approach: -1.0 },
  support:            { damage: 2.2, objective: 4.0, cover: 2.2, exposure: 3.0, waste: 0.5, survival: 2.6, approach: 0.0 },
  'objective-runner': { damage: 1.8, objective: 6.0, cover: 1.6, exposure: 2.0, waste: 0.5, survival: 1.8, approach: 0.3 },
};

/** Distance at which "closing in" stops earning credit. */
const APPROACH_HORIZON = 24;

/** How many destinations get the expensive "can I shoot from here" pass. */
const SHOOT_EVAL_DESTINATIONS = 10;
/** What a sight line is worth when choosing which of those to spend it on. */
const SIGHT_LINE_BONUS = 3;
/** Catching our own operatives in a blast is never worth the trade. */
const FRIENDLY_FIRE_PENALTY = 4;
/** How many shoot-and-scoot variants to plan; each one costs a move search. */
const SCOOT_VARIANTS = 3;
/** Fidelity the rules engine uses; the chosen plan is re-checked at this level. */
const FULL_SAMPLES = 6;

/**
 * Role weights, adjusted for what the mission actually rewards.
 *
 * In an objective game, a sniper that sits still and shoots is playing well —
 * its team wins on ground held elsewhere. In a last-team-standing deathmatch
 * there is no ground and no clock, so the same behaviour is two gunlines
 * refusing to meet until the safety cap stops them. With nothing to contest,
 * every role has to be willing to close: the drive to approach gets a floor
 * and the fear of exposure is halved.
 */
function weightsFor(state, op, disposition, tactics) {
  const role = ROLE_WEIGHTS[op.role] || ROLE_WEIGHTS.flexible;
  const base = isLastTeamStanding(state)
    ? {
        ...role,
        objective: 0,
        approach: Math.max(role.approach, 2.5),
        exposure: role.exposure * 0.5,
      }
    : role;
  // Faction first, then what this particular operative carries: a bomb squig is
  // reckless whichever kill team it belongs to.
  return applyTactics(base, disposition.mods, tactics.mods);
}

/**
 * One line of rationale for a shot, so the combat log reads as what the
 * operative is actually doing — a detonation has no target to name.
 */
function shotLine(shot, suffix = '') {
  if (shot.selfDirected) {
    return `Detonates ${shot.weaponName} for an expected ` +
      `${shot.splash.enemy.toFixed(1)} damage across the blast${suffix}`;
  }
  const splash = shot.splash?.enemy > 0
    ? `, spilling ${shot.splash.enemy.toFixed(1)} more damage into the ` +
      `${shot.splash.radius}" splash`
    : '';
  return `Shoots ${shot.targetName} with ${shot.weaponName}${splash}${suffix}`;
}

/** The estimate every shoot plan shares; a detonation's damage is all splash. */
function shotEstimate(shot, extra = {}) {
  return {
    damage: shot.expected,
    splash: shot.splash,
    psychic: shot.psychic === true,
    // Nothing is "killed" by an operative blowing itself up, so a self-directed
    // shot names no target for the kill-pressure bonus to read.
    target: shot.selfDirected ? null : shot.targetId,
    ...extra,
  };
}

/**
 * A melee profile as it will read once the resource spends the AI is planning
 * have landed — Rage's extra attack die. The pack's profile is never touched;
 * this is a copy for the estimate, and the engine folds the same bonus in for
 * real when the Fight resolves.
 */
function buffed(weapon, buffs) {
  if (!weapon || !buffs?.atkBonus) return weapon;
  return { ...weapon, atk: weapon.atk + buffs.atkBonus };
}

/**
 * Fold the firefight ploys bought for a plan into the resource spends already
 * planned for it.
 *
 * The two economies buy the same kinds of thing — another swing, a heavier
 * one, the inch that makes a charge land — and the plan builder should not
 * care which one paid. Both are `optional`, so a plan that loses the ranking
 * never spends the token or the CP.
 */
/**
 * Repeats of one action type this operative gets for FREE, beyond the first.
 *
 * ASTARTES — "it can perform either two Shoot actions or two Fight actions" —
 * is an always-on rule hook, not something anybody pays for, and the plan
 * builder only ever counted the repeats a resource spend or a firefight ploy
 * had bought. So every Space Marine team in the bundle walked into contact and
 * swung once: across nine battles the Crimson Spear charged seven times and
 * fought seven times, with the second swing its faction rule grants never
 * planned at all. The legality layer had always allowed it; nothing asked.
 *
 * The AP still has to be there, and the engine re-checks legality when the
 * repeat resolves, so a grant the conditions have since withdrawn is refused
 * rather than trusted.
 */
function freeRepeats(state, op, type, ap, apAlreadyUsed) {
  const allowed = timesAllowed(state, op, type) - 1;
  if (allowed <= 0) return 0;
  return Math.max(0, Math.min(allowed, ap - apAlreadyUsed));
}

function withPloys(spendBuffs, ployBuffs) {
  const base = spendBuffs || {
    before: [], afterCharge: [], atkBonus: 0, moveBonus: 0,
    extraFights: 0, extraDamage: 0, rationale: [],
  };
  if (!ployBuffs || !ployBuffs.actions.length) {
    return { ...base, damageMultiplier: 1 };
  }
  return {
    ...base,
    // The ploy is paid for before the spends, so an extra Fight it grants is
    // already legal when the rest of the plan is checked.
    before: [...ployBuffs.actions, ...(base.before || [])],
    atkBonus: (base.atkBonus || 0) + ployBuffs.atkBonus,
    moveBonus: (base.moveBonus || 0) + ployBuffs.moveBonus,
    extraFights: (base.extraFights || 0) + ployBuffs.extraFights,
    damageMultiplier: ployBuffs.damageMultiplier,
    rationale: [...(base.rationale || []), ...ployBuffs.rationale],
  };
}

/**
 * Put the order at the very front of the intent, where the rules want it.
 *
 * An order is chosen at the start of an activation, before the operative acts
 * (`orderChangeBlocker`), and the composed intent does not naturally arrive in
 * that shape: `_compose` prepends the openings, and one of them — the
 * operative's own printed action — is a real action that costs AP. So a plan
 * that reads "Signal, then break cover and shoot" would have asked to break
 * cover after it had already acted, and been refused for it.
 *
 * Only the first is kept. Two orders in one intent is a planner disagreeing
 * with itself, and the engine would refuse the second anyway.
 */
function hoistOrder(actions) {
  const order = actions.find((a) => a.type === 'change_order');
  if (!order || actions[0] === order) return actions;
  return [order, ...actions.filter((a) => a.type !== 'change_order')];
}

/** What the log says about why this operative plays the way it does. */
function tacticNote(state, op, disposition, tactics) {
  const team = state.teamPacks[op.playerId]?.displayName ?? op.teamId;
  const parts = [`${team}: ${disposition.label} — ${disposition.note}`];
  if (tactics.labels.length) parts.push(tactics.labels.join('; '));
  return parts.join(' · ');
}

export class UtilityController {
  /**
   * `manual` does not change how this controller thinks. A semi-manual player
   * still gets the same enumeration, the same scoring and the same team
   * tactics — the flag only tells `rules/phases.js` to suspend the activation
   * and ask, rather than to take the top plan and go.
   */
  constructor(playerId, { personality = 'balanced', manual = false } = {}) {
    this.playerId = playerId;
    this.personality = personality;
    this.manual = manual === true;
    this.version = AI_VERSION;
    /** Positional estimates are re-asked constantly while ranking plans, and
     *  enemies cannot move during our own activation — so cache per activation. */
    this._cache = new Map();
  }

  _memo(kind, op, x, y, compute) {
    const k = `${kind}:${op.id}:${Math.round(x * 4)}:${Math.round(y * 4)}`;
    if (this._cache.has(k)) return this._cache.get(k);
    const v = compute();
    this._cache.set(k, v);
    return v;
  }

  /**
   * What standing here would cost, on the order this plan would arrive under.
   *
   * The order is part of the key, not just the query: Conceal in cover is not
   * targetable at all, so the same square is worth two different numbers
   * depending on which order the plan ends on, and a shared cache entry would
   * hand the first answer to the second question.
   */
  _exposure(state, op, x, y, enemies, order = null) {
    const actual = order ?? op.order;
    return this._memo(`exp|${actual}`, op, x, y,
      () => exposureAt(state, op, x, y, enemies, { order: actual }));
  }

  _cover(state, op, x, y, enemies) {
    return this._memo('cov', op, x, y, () => coverQualityAt(state, op, x, y, enemies));
  }

  _sightLines(state, op, x, y, enemies) {
    return this._memo('los', op, x, y, () => sightLinesAt(state, op, x, y, enemies));
  }

  /**
   * How promising a destination looks to the thing that makes this operative
   * special — the question the expensive shot search gets asked on its behalf.
   */
  _opportunity(state, op, dest, enemies, tactics) {
    // Both multipliers count operatives rather than damage, so they are scaled
    // to outweigh the ground and cover terms they are added to: a crowd is the
    // whole reason these two profiles move at all.
    if (tactics.detonator !== null) {
      return this._memo('det', op, dest.x, dest.y, () =>
        detonationOpportunityAt(state, op, dest.x, dest.y, enemies, tactics.detonator)) * 4;
    }
    if (tactics.multiHit !== null) {
      return this._memo('spl', op, dest.x, dest.y, () =>
        splashOpportunityAt(state, op, dest.x, dest.y, enemies, tactics.multiHit)) * 1.6;
    }
    return this._sightLines(state, op, dest.x, dest.y, enemies) > 0 ? SIGHT_LINE_BONUS : 0;
  }

  /**
   * What a destination is worth as *ground*.
   *
   * Normally that means objectives. A deathmatch has none, and then every
   * destination scores zero — so "take ground" picked the first candidate,
   * which is always "stay exactly where I am", and two kill teams spent twelve
   * turning points repositioning zero inches. With no markers to hold, the only
   * ground worth taking is ground closer to the enemy.
   */
  _groundValue(state, op, x, y, enemies) {
    if (state.objectives.length) return objectiveValueAt(state, op, x, y);
    if (!enemies.length) return 0;
    const ghost = { ...op, x, y };
    const nearest = Math.min(...enemies.map((e) => baseDistance(ghost, e)));
    return Math.max(0, 1 - nearest / APPROACH_HORIZON);
  }

  /**
   * What this team means to do with its CP this turning point. Called once per
   * player at the top of the strategy phase, before anything is bought; the
   * plan is stored on the player so the rules layer can read the reserve when
   * an attack lands (see `cp.js`).
   */
  planCommandPoints(state, playerId) {
    return planCommandPoints(state, playerId);
  }

  /**
   * Which strategic ploys to buy this turning point. Called once per player
   * in the strategy phase; the rules layer re-checks every pick (#3).
   */
  chooseStrategicPloys(state, playerId) {
    return chooseStrategicPloys(state, playerId, state.players[playerId].cpPlan);
  }

  /** Cheap urgency heuristic — full planning for every operative is wasteful. */
  chooseActivation(state, readyIds) {
    const enemies = liveOperatives(state).filter((o) => o.playerId !== this.playerId);
    let best = null;
    for (const id of readyIds) {
      const op = state.operatives[id];
      let urgency = 0;
      if (enemiesInControlRange(op, liveOperatives(state)).length) urgency += 3;
      const nearest = enemies.reduce(
        (m, e) => Math.min(m, baseDistance(op, e)), Infinity
      );
      if (nearest < 12) urgency += 2;
      if (state.objectives.some(
        (o) => baseDistance(op, { x: o.x, y: o.y, baseDiameter: 0 }) < effectiveMove(op) + 2
      )) urgency += 1;
      // A wounded operative usually wants to wait; one that can heal itself
      // with a resource has less reason to.
      if (isInjured(op)) urgency -= canHealItself(state, op) ? 0.1 : 0.5;
      // A demolition charge is spent the moment its carrier is shot, so a squig
      // already standing in a crowd goes now rather than hoping to survive.
      const tactics = unitTacticsFor(state, op);
      if (tactics.detonator !== null && nearest <= tactics.detonator + effectiveMove(op)) urgency += 2;
      if (tactics.psyker && nearest < 18) urgency += 1;
      if (!best || urgency > best.urgency) best = { id, urgency };
    }
    return best?.id ?? readyIds[0];
  }

  /**
   * @returns {{actions:Array, rationale:string[], considered:number, score:number}}
   */
  planActivation(state, operativeId, { counteract = false } = {}) {
    const ctx = this._context(state, operativeId, { counteract });
    const plans = this._enumerate(ctx);
    return this._compose(ctx, this._choose(ctx, plans), plans.length);
  }

  /**
   * Up to `count` tactics to put in front of a human player, each from a
   * different branch of the plan space.
   *
   * The same enumeration the AI ranks for itself, re-cut: instead of "which
   * plan scores highest", the question is "what are the genuinely different
   * things this operative could do", and the best plan of each kind is the
   * answer (see `ai/options.js`). Nothing here mutates state, and the actions
   * a player picks are re-checked by the action layer exactly like the AI's
   * (#3) — choosing is not the same as being allowed.
   *
   * `ap` is the budget the cards are priced against, which is not always the
   * AP the operative is holding: a resource spend can buy a point, and one of
   * its own printed actions can have taken one off the top before the player
   * is asked anything.
   *
   * @returns {{ap:number, held:number, options:Array}}
   */
  offerTactics(state, operativeId, { count = 3, counteract = false } = {}) {
    const ctx = this._context(state, operativeId, { counteract });
    const plans = this._enumerate(ctx);
    return {
      ap: ctx.ap,
      held: ctx.baseAp,
      options: buildTacticOptions(this, ctx, plans, { count }),
    };
  }

  /**
   * Everything an activation is planned against, worked out once.
   *
   * Split out of `planActivation` because a human menu needs the identical
   * footing: the same AP budget, the same resource and CP openings, the same
   * per-team tactics. Two code paths deriving that separately is two places
   * for them to disagree about what the operative can afford.
   */
  _context(state, operativeId, { counteract = false } = {}) {
    const op = state.operatives[operativeId];
    this._cache.clear();
    const baseAp = counteract ? 1 : (op.apRemaining || effectiveApl(op));
    const enemies = liveOperatives(state).filter((o) => o.playerId !== op.playerId);
    const engaged = enemiesInControlRange(op, liveOperatives(state));
    const disposition = dispositionFor(state, op.playerId);
    const tactics = unitTacticsFor(state, op);
    const w = weightsFor(state, op, disposition, tactics);

    // What the team's resource economy is willing to pay for this activation.
    // A counteraction is one AP whatever the APL, so an APL invigoration buys
    // nothing there and is not offered.
    const spending = counteract
      ? { always: [], conditional: [], apBonus: 0, rationale: [] }
      : openingSpends(state, op, { enemies });

    // …and what the team's CP doctrine is willing to pay for it. A firefight
    // ploy is priced for the plan it would buy, so each branch asks for its
    // own: a second Fight is worth a CP to an operative that is charging and
    // nothing to the one about to shoot from a rooftop.
    const ployContext = { engaged: engaged.length > 0 };
    const ployOpening = counteract
      ? null
      : firefightPloysFor(state, op, 'opening', { context: ployContext });
    // The operative's own printed actions come off the top, like a resource
    // spend but the other way round: they cost AP rather than buying it, and
    // the rest of the activation is planned with what is left. A counteraction
    // is a single action, so there is no "rest" to plan and no opening.
    const support = counteract
      ? { actions: [], rationale: [], apCost: 0 }
      : openingSupport(state, op, {
          ap: baseAp + spending.apBonus + (ployOpening?.apBonus || 0),
        });
    const ap = Math.max(0,
      baseAp + spending.apBonus + (ployOpening?.apBonus || 0) - support.apCost);
    const buffs = withPloys(meleeSpends(state, op),
      counteract ? null : firefightPloysFor(state, op, 'melee', { context: ployContext }));
    const ployPlans = counteract ? null : {
      shoot: firefightPloysFor(state, op, 'shoot', { context: ployContext }),
      move: firefightPloysFor(state, op, 'move', { context: ployContext }),
    };
    // …and what the economy will pay for a shot. `meleeSpends` skips every
    // boost that is not a melee one, which left a ranged economy — ORK IT UP —
    // with no caller at all.
    const shootBuffs = counteract ? null : shootingSpends(state, op);

    return {
      state, op, operativeId, counteract, baseAp, ap, enemies, engaged,
      disposition, tactics, w, spending, ployOpening, support, buffs,
      ployPlans, shootBuffs,
    };
  }

  /** Every plan this operative could follow, scored and ranked. */
  _enumerate(ctx) {
    const { state, op, ap, enemies, engaged, tactics, w, buffs, ployPlans, shootBuffs, support } = ctx;

    const plans = engaged.length
      ? this._engagedPlans(state, op, ap, enemies, engaged, buffs, tactics)
      : this._freePlans(state, op, ap, enemies, tactics, buffs, ployPlans, shootBuffs);

    // Walking over to the operative that needs the medic. A short-ranged
    // support action has no target from where its carrier is standing, so it
    // never appeared in the opening above and the carrier had no reason to
    // close the gap.
    plans.push(...this._supportApproachPlans(state, op, ap, enemies, engaged,
      new Set(support.actions.map((a) => a.abilityId))));

    plans.push({ actions: [], rationale: ['No useful action found; holds position.'], estimate: {} });

    for (const plan of plans) this._score(state, op, plan, enemies, w, ap, tactics);

    plans.sort((a, b) => b.score - a.score);
    return plans;
  }

  /** The plan the AI would follow: highest-scoring, re-validated, ties broken. */
  _choose(ctx, plans) {
    const { state, op, enemies, tactics } = ctx;

    // The ranking pass traces sight lines cheaply; the engine will re-check at
    // full fidelity. Re-validate before committing so we never burn AP on a
    // shot the rules engine is going to reject.
    let chosen = null;
    for (const plan of plans.slice(0, 6)) {
      if (this._planIsValid(state, op, plan, enemies, tactics)) { chosen = plan; break; }
    }
    if (!chosen) chosen = plans[plans.length - 1];

    const tied = plans.filter(
      (p) => Math.abs(p.score - chosen.score) < 1e-6 && this._planIsValid(state, op, p, enemies, tactics)
    );
    if (tied.length > 1) {
      // Derived stream: deterministic, but doesn't disturb the battle dice.
      const tieRng = new Rng(`${state.seed}:ai:${state.eventLog.length}:${op.id}`);
      chosen = tieRng.pick(tied);
    }
    return chosen;
  }

  /**
   * Turn a ranked plan into the intent the engine runs: the conditional tails
   * it earns, and the 0-AP openings that paid for it.
   */
  _compose(ctx, chosen, considered) {
    const {
      state, op, operativeId, counteract, baseAp, ap, enemies,
      disposition, tactics, spending, ployOpening, support,
    } = ctx;

    // The opening spends go in front of the plan that was chosen with them in
    // mind. The conditional one — an extra point of AP — is only paid for if
    // the plan actually spends it, so a quiet activation keeps its token.
    // A kill unlocks a free Dash for some teams; the tail is conditional, so
    // it is appended to whatever plan won rather than shaping the ranking.
    this._appendPostKill(state, op, chosen, enemies);
    // …and whatever the winning plan could not think of to do with its last
    // point. This is where the wasted AP actually went.
    this._appendSpareAp(state, op, chosen, ap, enemies, counteract, support);

    const apUsed = (chosen.estimate?.apUsed || 0) + support.apCost;
    const usesBonus = apUsed > baseAp;
    // The CP that buys an extra AP is only paid if the plan reaches past the
    // AP the operative already had — and past the one a token bought first,
    // because the token is the cheaper of the two.
    const usesPloyAp = (ployOpening?.apBonus || 0) > 0 &&
      apUsed > baseAp + (usesBonus ? spending.apBonus : 0);
    const opening = [
      ...(usesPloyAp ? ployOpening.actions : []),
      ...spending.always,
      ...(usesBonus ? spending.conditional : []),
      // After the 0-AP openings, because those are what pay for the AP this
      // one is about to spend.
      ...support.actions,
    ];
    const openingNotes = [
      ...(usesPloyAp ? ployOpening.rationale : []),
      ...(spending.always.length || (usesBonus && spending.conditional.length)
        ? spending.rationale : []),
      ...support.rationale,
    ];
    if (opening.length) chosen.actions = [...opening, ...chosen.actions];
    chosen.actions = hoistOrder(chosen.actions);

    return {
      operativeId,
      actions: chosen.actions,
      rationale: [
        ...openingNotes,
        ...chosen.rationale,
        tacticNote(state, op, disposition, tactics),
        this._explain(chosen),
      ],
      considered,
      score: Number(chosen.score.toFixed(2)),
    };
  }

  /**
   * Reposition into reach of a support action, then perform it.
   *
   * The destination is judged by the action it unlocks rather than by the
   * ground, because that is the whole reason for the walk; cover and exposure
   * still count, so a medic does not cross open ground to save two wounds.
   */
  _supportApproachPlans(state, op, ap, enemies, engaged, spent = new Set()) {
    // Engaged, the only legal move is Fall Back, and a medic in a melee has
    // more pressing problems than the medikit.
    if (engaged.length || ap < 2) return [];
    const wanted = supportDestinationsFor(state, op, { exclude: spent });
    if (!wanted.length) return [];

    const allowance = usableMoveAllowance(state, op, 'reposition');
    if (allowance <= 0) return [];
    const dests = generateDestinations(state, op, allowance, {
      towardEnemies: false, alsoToward: wanted,
    });

    let best = null;
    for (const dest of dests) {
      if (dest.length <= 0) continue;
      const reach = bestUniqueAction(state, op, { from: dest, exclude: spent });
      if (!reach || reach.ap > ap - 1) continue;
      const score = reach.value +
        this._cover(state, op, dest.x, dest.y, enemies) * 0.5 -
        this._exposure(state, op, dest.x, dest.y, enemies) * 0.3;
      if (!best || score > best.score) best = { dest, reach, score };
    }
    if (!best) return [];

    return [{
      actions: [
        { type: 'reposition', destination: { x: best.dest.x, y: best.dest.y } },
        // The walk is judged from a destination the move planner validated,
        // but the engine re-measures from wherever the operative actually
        // ends up (#3) — and an inch short of a one-inch control range is
        // short. The ground is worth having either way, so the action is a
        // conditional tail rather than a claim.
        { ...best.reach.action, optional: true },
      ],
      rationale: [
        `Moves ${best.dest.length.toFixed(1)}" to reach ${best.reach.targetName}`,
        `${best.reach.name} on ${best.reach.targetName}`,
      ],
      estimate: {
        apUsed: 1 + best.reach.ap,
        support: best.reach.value,
        endsAt: { x: best.dest.x, y: best.dest.y },
        moved: best.dest.length,
      },
    }];
  }

  /**
   * The last point, and what to do with it.
   *
   * Called on the plan that already won, so nothing here can change which plan
   * is chosen — it only stops the leftovers evaporating. In order of
   * preference: the operative's own action, then Guard, which is what a spare
   * point is for once there is nothing left to shoot at.
   *
   * Every appended action is `optional`: the plan's own estimate may be wrong
   * about how much AP it spends, and a tail the engine refuses should be
   * dropped without a warning rather than reported as a bug (see phases.js).
   */
  _appendSpareAp(state, op, plan, ap, enemies, counteract, support) {
    // A counteraction is one action, full stop; a tail would be a second.
    if (counteract) return;
    let spare = ap - (plan.estimate?.apUsed || 0);
    if (spare <= 0) return;

    // `ap` is already net of the support opening, but the abilities it used
    // are not available a second time.
    const planned = new Set([
      ...plan.actions.filter((a) => a.type === 'unique').map((a) => a.abilityId),
      ...(support?.actions || []).map((a) => a.abilityId),
    ]);
    for (let i = 0; i < 2 && spare > 0; i++) {
      const extra = bestUniqueAction(state, op, { exclude: planned });
      if (!extra || extra.ap > spare) break;
      plan.actions = [...plan.actions, { ...extra.action, optional: true }];
      plan.rationale = [...plan.rationale,
        `${extra.name} on ${extra.targetName} with the spare AP`];
      planned.add(extra.action.abilityId);
      spare -= extra.ap;
    }

    if (spare <= 0) return;
    // Guard is priced, not automatic: an operative with nothing that could
    // ever walk into its lane keeps the point rather than posing with it.
    if (guardValue(state, op, enemies) <= 0) return;
    // Guard needs Engage, and an operative that has spent its activation
    // hiding should not give that up for a shot it may never take.
    if (op.order !== 'engage') return;
    if (plan.actions.some((a) => a.type === 'guard')) return;
    plan.actions = [...plan.actions, { type: 'guard', optional: true }];
    plan.rationale = [...plan.rationale, 'Holds the last point on Guard'];
  }

  /**
   * Vitalised Surge: an operative that kills something may spend a Pain token
   * on a free Dash. Only worth planning for when the plan expects a kill —
   * and it is planned as `optional`, because expecting one is not having one.
   */
  _appendPostKill(state, op, plan, enemies) {
    const e = plan.estimate || {};
    const target = e.target ? state.operatives[e.target] : null;
    if (!target || (e.damage || 0) < target.woundsRemaining) return;

    const from = e.endsAt || { x: op.x, y: op.y };
    const after = { ...op, x: from.x, y: from.y };
    const candidates = generateDestinations(
      { ...state, operatives: { ...state.operatives, [op.id]: after } },
      after, DASH_DISTANCE, { towardEnemies: false }
    );
    const retreat = this._bestBy(candidates, (d) =>
      this._cover(state, op, d.x, d.y, enemies) * 2 - this._exposure(state, op, d.x, d.y, enemies));
    if (!retreat || retreat.length < 0.5) return;

    const bundle = postKillSpends(state, op, retreat);
    if (!bundle) return;
    plan.actions = [...plan.actions, ...bundle.actions];
    plan.rationale = [...plan.rationale, ...bundle.rationale];
  }

  /**
   * Re-check a plan's shoot action with the same LOS fidelity the engine uses.
   * Movement and melee are already checked exactly during enumeration.
   */
  _planIsValid(state, op, plan, enemies, tactics) {
    // A plan may carry more than one Shoot — a firefight ploy buys a second —
    // and they all fire at the target this re-check confirms.
    const shoots = plan.actions.filter((a) => a.type === 'shoot');
    const shoot = shoots[0];
    if (!shoot) return true;
    // Where the shot is taken from, which is not always where the plan ends: a
    // "shoot, then break for cover" plan fires before it moves. Validating from
    // `endsAt` confirmed a target visible from the *retreat* spot and wrote it
    // into the shoot action, which the engine then rejected for no line of
    // sight — the operative had not moved yet.
    const at = plan.estimate?.shootsFrom || plan.estimate?.endsAt || { x: op.x, y: op.y };
    const confirmed = bestShotFrom(state, op, at, enemies, {
      samples: FULL_SAMPLES, moved: plan.estimate?.movedBefore ?? null,
      movedDistance: plan.estimate?.movedBefore ? (plan.estimate?.moved ?? 0) : 0,
      tactics,
    });
    if (!confirmed) return false;
    // Keep the plan, but shoot at whatever is actually targetable from there.
    for (const action of shoots) {
      action.targetId = confirmed.targetId;
      action.weaponId = confirmed.weaponId;
    }
    // The re-check may have swapped weapons; a weapon without Silent still
    // needs the Engage order the plan may have skipped.
    if (!confirmed.silent) {
      const order = plan.actions.find((a) => a.type === 'change_order');
      if (order) order.order = ORDERS.ENGAGE;
      else plan.actions.unshift({ type: 'change_order', order: ORDERS.ENGAGE });
    }
    return true;
  }

  /**
   * Silent weapons fire from Conceal, so a sniper never has to break cover to
   * use one — and staying concealed is what keeps it un-targetable.
   */
  _orderForShot(shot) {
    return { type: 'change_order', order: shot.silent ? ORDERS.CONCEAL : ORDERS.ENGAGE };
  }

  /* --------------------------------------------------------------- */
  /* Plan enumeration                                                 */
  /* --------------------------------------------------------------- */

  _engagedPlans(state, op, ap, enemies, engaged, buffs = null, tactics = null) {
    const plans = [];
    const melee = meleeWeapons(state, op)[0];

    if (melee) {
      const target = bestMeleeTarget(state, op, engaged, buffed(melee, buffs), tactics);
      if (target) {
        // Rage buys attack dice and Fury a second swing, so the plan that pays
        // for them is a different plan from the plain Fight — worth ranking as
        // its own option rather than assuming the buffed version is free.
        // Paid-for repeats (Fury, BLADEWIND) plus the ones a faction rule
        // simply grants (Astartes). One Fight has been planned already, so a
        // free repeat costs the AP for the second one and nothing else.
        // A repeat is `optional`: the first swing may have put the target
        // down, and there is nothing left to fight. The engine would refuse it
        // anyway — this drops it silently instead of logging a rejection.
        const swings = (buffs?.extraFights || 0) +
          freeRepeats(state, op, 'fight', ap, 1 + (buffs?.extraFights || 0));
        const extra = Array.from({ length: swings }, () => (
          { type: 'fight', targetId: target.targetId, weaponId: melee.id, optional: true }));
        plans.push({
          actions: [
            { type: 'change_order', order: ORDERS.ENGAGE },
            ...(buffs?.before || []),
            { type: 'fight', targetId: target.targetId, weaponId: melee.id },
            ...extra,
          ],
          rationale: [
            ...(buffs?.rationale || []),
            `Fights ${target.targetName} (expects ${target.expected.toFixed(1)} damage)`,
          ],
          estimate: {
            damage: target.expected * (1 + (extra.length ? 0.8 : 0)) *
              (buffs?.damageMultiplier ?? 1),
            target: target.targetId,
            apUsed: 1 + extra.length,
            endsAt: { x: op.x, y: op.y },
          },
        });
      }
    }

    // Disengage: worth it when melee is going badly.
    const destinations = generateDestinations(state, op, usableMoveAllowance(state, op, 'reposition'), { towardEnemies: false })
      .filter((d) => !enemies.some((e) => withinControlRange({ ...op, x: d.x, y: d.y }, e)));

    for (const dest of destinations.slice(0, 6)) {
      const shot = ap >= 2 ? null : null; // Falling back forbids shooting this activation.
      plans.push({
        actions: [{ type: 'fall_back', destination: { x: dest.x, y: dest.y } }],
        rationale: [`Falls back ${dest.length.toFixed(1)}" out of control range`],
        estimate: { damage: 0, apUsed: 1, endsAt: dest, moved: dest.length },
      });
    }
    return plans;
  }

  _freePlans(state, op, ap, enemies, tactics, buffs = null, ployPlans = null,
    shootBuffs = null) {
    const plans = [];
    // A Dash an always-on rule already handed over — CLEAR DA ROOM, FORLORN
    // FURY — is worth exactly what a ploy-bought one is worth, and was being
    // read only by the action layer, which sees it after the plan is made. So
    // the operative planned as though it had the AP it had, and the grant was
    // spent only when a plan happened to run out of AP on its own.
    const grantedDash = hasFreeAction(op, 'dash');
    const melee = meleeWeapons(state, op)[0];
    // CP the doctrine will pay for a second Shoot action, and for the free
    // Dash that takes an objective-runner the last few inches onto a marker.
    const shootPloys = ployPlans?.shoot || null;
    const movePloys = ployPlans?.move || null;

    // --- Shoot without moving -------------------------------------
    const shotHere = bestShotFrom(state, op, op, enemies, { tactics });
    if (shotHere) {
      const base = [
        this._orderForShot(shotHere),
        { type: 'shoot', targetId: shotHere.targetId, weaponId: shotHere.weaponId },
      ];
      plans.push({
        actions: base,
        rationale: [
          shotLine(shotHere, ' from the current position'),
          ...(shotHere.silent ? ['Stays on Conceal — the weapon is Silent'] : []),
        ],
        estimate: shotEstimate(shotHere, { apUsed: 1, endsAt: { x: op.x, y: op.y } }),
      });

      // Pay CP for a second Shoot action. Worth its own plan rather than a
      // free upgrade: the second shot costs an AP the operative might have
      // spent breaking for cover, so the ranking decides which it wants.
      const extraShoots = (shootPloys?.extraShoots || 0) +
        freeRepeats(state, op, 'shoot', ap, 1 + (shootPloys?.extraShoots || 0));
      if (extraShoots > 0 && ap >= 2) {
        const repeats = Array.from({ length: extraShoots }, () => (
          { type: 'shoot', targetId: shotHere.targetId, weaponId: shotHere.weaponId,
            optional: true }));
        plans.push({
          actions: [...(shootPloys?.actions || []), ...base, ...repeats],
          rationale: [
            ...(shootPloys?.rationale || []),
            shotLine(shotHere, ` ${repeats.length + 1} times without moving`),
          ],
          estimate: shotEstimate(shotHere, {
            damage: shotHere.expected * (1 + 0.8 * repeats.length) *
              (shootPloys?.damageMultiplier ?? 1),
            apUsed: 1 + repeats.length,
            endsAt: { x: op.x, y: op.y },
          }),
        });
      }

      // Shoot, then reposition into safety with the spare AP — unless the
      // weapon is Heavy, which pins the operative for the rest of the turn.
      const mayMoveAfter = shotHere.heavyAllows === undefined || shotHere.heavyAllows === 'reposition';
      if (ap >= 2 && mayMoveAfter) {
        // The move comes after the shot, so it is sized against the budget the
        // shot leaves behind — Aimed clamps it to 3" however far the operative
        // could otherwise have walked.
        const afterShot = Math.min(
          usableMoveAllowance(state, op, 'fall_back'),
          shotHere.moveLimit ?? Infinity
        );
        const retreats = generateDestinations(state, op, afterShot, { towardEnemies: false });
        const safest = this._bestBy(retreats, (d) =>
          this._cover(state, op, d.x, d.y, enemies) * 2 - this._exposure(state, op, d.x, d.y, enemies));
        if (safest && safest.length > 0.2) {
          plans.push({
            actions: [...base, { type: 'reposition', destination: { x: safest.x, y: safest.y } }],
            rationale: [
              shotLine(shotHere),
              `Then breaks ${safest.length.toFixed(1)}" to a safer position`,
            ],
            estimate: shotEstimate(shotHere, {
              apUsed: 2, endsAt: safest, moved: safest.length,
              shootsFrom: { x: op.x, y: op.y },
            }),
          });
        }
      }
    }

    // --- Move, then shoot -----------------------------------------
    if (ap >= 2) {
      const destinations = generateDestinations(state, op, usableMoveAllowance(state, op, 'reposition'));
      // Only a handful of destinations can afford the full target-selection
      // pass, so the pre-filter decides what this branch is even able to find.
      // It therefore has to rank by what *shooting* wants: a sight line first,
      // then cover and ground, with exposure as a tie-breaker rather than a
      // veto. Ranking on `-exposure` alone sorted every hidden position to the
      // top — and a position nothing can see is a position nothing can be shot
      // from, so the pass reliably came back empty and shooters spent whole
      // games holding position in cover.
      const ranked = destinations
        .map((d) => ({
          d,
          quick: this._opportunity(state, op, d, enemies, tactics) +
            this._groundValue(state, op, d.x, d.y, enemies) * 2 +
            this._cover(state, op, d.x, d.y, enemies) * 1.5 -
            this._exposure(state, op, d.x, d.y, enemies) * 0.25,
        }))
        .sort((a, b) => b.quick - a.quick)
        .slice(0, SHOOT_EVAL_DESTINATIONS)
        .map((r) => r.d);

      let scootsPlanned = 0;
      for (const dest of ranked) {
        // A Heavy weapon cannot follow a Reposition, so ask for the best shot
        // that would still be legal after the move.
        const shot = bestShotFrom(state, op, dest, enemies,
          { moved: 'reposition', movedDistance: dest.length, tactics });
        if (!shot) continue;
        plans.push({
          actions: [
            this._orderForShot(shot),
            { type: 'reposition', destination: { x: dest.x, y: dest.y } },
            { type: 'shoot', targetId: shot.targetId, weaponId: shot.weaponId },
          ],
          rationale: [
            `Repositions ${dest.length.toFixed(1)}" (${dest.tag})`,
            shotLine(shot, shot.inCover ? ' (in cover)' : ''),
          ],
          estimate: shotEstimate(shot, {
            apUsed: 2, endsAt: dest, moved: dest.length, movedBefore: 'reposition',
          }),
        });

        // Move, shoot, and duck back: the only plan shape a three-AP operative
        // can fill, and without it a Sorcerer cast its spell and then stood in
        // the open holding an action it had no way to spend.
        if (ap >= 3 && scootsPlanned < SCOOT_VARIANTS) {
          const scoot = this._scootAfterShot(state, op, dest, shot, enemies);
          if (scoot) {
            scootsPlanned++;
            plans.push({
              actions: [
                this._orderForShot(shot),
                { type: 'reposition', destination: { x: dest.x, y: dest.y } },
                { type: 'shoot', targetId: shot.targetId, weaponId: shot.weaponId },
                { type: 'dash', destination: { x: scoot.x, y: scoot.y } },
              ],
              rationale: [
                `Repositions ${dest.length.toFixed(1)}" (${dest.tag})`,
                shotLine(shot, shot.inCover ? ' (in cover)' : ''),
                `Dashes ${scoot.length.toFixed(1)}" back into cover`,
              ],
              estimate: shotEstimate(shot, {
                apUsed: 3, endsAt: scoot, shootsFrom: dest,
                moved: dest.length + scoot.length, movedBefore: 'reposition',
              }),
            });
          }
        }
      }
    }

    // --- Charge and fight -----------------------------------------
    if (melee && ap >= 2) {
      // Surge buys the inch that decides whether the charge reaches at all, so
      // it is part of the allowance the plan is built against.
      const allowance = usableMoveAllowance(state, op, 'charge') + (buffs?.moveBonus || 0);
      const weapon = buffed(melee, buffs);
      for (const enemy of enemies) {
        if (baseDistance(op, enemy) > allowance) continue;
        // Ask for a *legal* contact point rather than assuming one exists.
        const dest = chargeDestination(state, op, enemy, allowance);
        if (!dest) continue;
        const paidSwings = 1 + (buffs?.extraFights || 0);
        const swings = paidSwings +
          freeRepeats(state, op, 'fight', ap, 1 + paidSwings);
        const expected = expectedDamage(op, weapon, enemy, { inCover: false }) *
          (swings > 1 ? 1.8 : 1) * (buffs?.damageMultiplier ?? 1) +
          (buffs?.extraDamage || 0);
        plans.push({
          actions: [
            { type: 'change_order', order: ORDERS.ENGAGE },
            ...(buffs?.before || []),
            { type: 'charge', destination: { x: dest.x, y: dest.y }, targetId: enemy.id },
            ...(buffs?.afterCharge || []),
            ...Array.from({ length: swings }, (_, i) => (
              { type: 'fight', targetId: enemy.id, weaponId: melee.id,
                ...(i > 0 ? { optional: true } : {}) })),
          ],
          rationale: [
            `Charges ${enemy.name} across ${dest.length.toFixed(1)}"`,
            ...(buffs?.rationale || []),
            `Fights for an expected ${expected.toFixed(1)} damage`,
          ],
          estimate: {
            damage: expected, target: enemy.id, apUsed: 1 + swings,
            endsAt: dest, moved: dest.length, charge: true,
          },
        });
      }
    }

    // A resource spent on the attack dice rides with whichever shooting plan
    // wins, rather than forking every one of them into a spent and an unspent
    // copy: the spend costs no AP, it is `optional`, and the rules layer drops
    // it silently if the plan it was attached to never fires. Applied here,
    // once, so each branch above stays about where to stand and what to hit.
    if (shootBuffs?.actions.length) {
      for (const plan of plans) {
        if (!plan.actions.some((a) => a.type === 'shoot')) continue;
        plan.actions = [...shootBuffs.actions, ...plan.actions];
        plan.rationale = [...plan.rationale, ...shootBuffs.rationale];
        plan.estimate = {
          ...plan.estimate,
          damage: (plan.estimate.damage || 0) * shootBuffs.damageMultiplier *
            (1 + 0.18 * shootBuffs.atkBonus),
        };
      }
    }

    // --- Take ground ----------------------------------------------
    const moveDests = generateDestinations(state, op, usableMoveAllowance(state, op, 'reposition'));
    const objectiveDest = this._bestBy(moveDests,
      (d) => this._groundValue(state, op, d.x, d.y, enemies));
    if (objectiveDest) {
      const staysHidden = !bestShotFrom(state, op, objectiveDest, enemies, { tactics });
      const order = staysHidden ? ORDERS.CONCEAL : ORDERS.ENGAGE;
      const actions = [
        { type: 'change_order', order },
        { type: 'reposition', destination: { x: objectiveDest.x, y: objectiveDest.y } },
      ];
      const rationale = [
        `Moves ${objectiveDest.length.toFixed(1)}" to press objectives (${objectiveDest.tag})`,
        staysHidden ? 'Stays on Conceal — no shot available' : 'Switches to Engage',
      ];
      plans.push({
        actions, rationale,
        estimate: { damage: 0, apUsed: 1, endsAt: objectiveDest, moved: objectiveDest.length, concealed: staysHidden },
      });

      // The same ground, taken quietly, when a shot happens to be available
      // from it. Switching to Engage to take a shot also makes this operative
      // selectable by everything that can see it, and for an operative whose
      // business is the charge two turning points from now that is a bad
      // trade — but it was not a trade the planner could offer. It only built
      // the Engage version whenever any shot at all existed, so a melee team
      // crossing open ground surrendered concealment for a pistol shot every
      // time. Both are now on the table and _score() prices them against each
      // other: the shot's damage on one side, an exposure of literally zero on
      // the other, wherever the destination is in cover.
      if (!staysHidden) {
        plans.push({
          actions: [
            { type: 'change_order', order: ORDERS.CONCEAL },
            { type: 'reposition', destination: { x: objectiveDest.x, y: objectiveDest.y } },
          ],
          rationale: [
            `Moves ${objectiveDest.length.toFixed(1)}" to press objectives (${objectiveDest.tag})`,
            'Holds Conceal rather than trade cover for the shot',
          ],
          estimate: {
            damage: 0, apUsed: 1, endsAt: objectiveDest,
            moved: objectiveDest.length, concealed: true,
          },
        });
      }

      // A firefight ploy that grants a free Dash is the cheapest ground in the
      // game: the same two moves for one AP. Only planned when the Reposition
      // itself ends clear of an enemy, because a Dash then becomes illegal.
      // Reposition + Dash: the longest legal move in the game.
      // A Dash is illegal once an enemy is within control range, so the pair
      // is only worth planning when the Reposition keeps clear of one.
      const afterIsFree = !enemies.some(
        (e) => withinControlRange({ ...op, x: objectiveDest.x, y: objectiveDest.y }, e)
      );
      const freeDash = movePloys?.freeDash === true || grantedDash;
      if ((ap >= 2 || freeDash) && afterIsFree) {
        const after = { ...op, x: objectiveDest.x, y: objectiveDest.y };
        const dashDests = generateDestinations(
          { ...state, operatives: { ...state.operatives, [op.id]: after } },
          after, DASH_DISTANCE, { towardEnemies: false }
        );
        const dashTo = this._bestBy(dashDests,
          (d) => this._groundValue(state, op, d.x, d.y, enemies));
        if (dashTo && dashTo.length > 0.2) {
          if (ap >= 2) {
            plans.push({
              actions: [...actions, { type: 'dash', destination: { x: dashTo.x, y: dashTo.y } }],
              rationale: [
                ...rationale,
                `Dashes a further ${dashTo.length.toFixed(1)}"`,
              ],
              estimate: {
                damage: 0, apUsed: 2, endsAt: dashTo,
                moved: objectiveDest.length + dashTo.length, concealed: staysHidden,
              },
            });
          }
          // The same ground for one AP, bought with CP. Ranked as its own plan
          // so a one-AP operative can reach a marker it otherwise cannot.
          if (freeDash) {
            const bought = movePloys?.freeDash === true;
            plans.push({
              actions: [
                ...(bought ? movePloys.actions : []), ...actions,
                { type: 'dash', destination: { x: dashTo.x, y: dashTo.y }, optional: true },
              ],
              rationale: [
                ...(bought ? movePloys.rationale : []),
                ...rationale,
                `Dashes a further ${dashTo.length.toFixed(1)}" on the free action`,
              ],
              estimate: {
                damage: 0, apUsed: 1, endsAt: dashTo,
                moved: objectiveDest.length + dashTo.length, concealed: staysHidden,
              },
            });
          }
        }
      }
    }

    return plans;
  }

  /**
   * Somewhere to go with the third AP once the shot is away: a Dash that ends
   * behind cover, measured from where the shot was fired.
   *
   * Returns null when the weapon pins the operative (Heavy), when the budget a
   * capped profile leaves cannot pay for a step, or when the move is legal but
   * buys nothing — an operative stepping 0.2" is pure noise in the log.
   */
  _scootAfterShot(state, op, from, shot, enemies) {
    if (shot.heavyAllows !== undefined && shot.heavyAllows !== 'dash') return null;
    // A Dash is illegal with an enemy within control range.
    if (enemies.some((e) => withinControlRange({ ...op, x: from.x, y: from.y }, e))) return null;

    const budget = Math.min(
      DASH_DISTANCE,
      Math.max(0, (shot.moveLimit ?? Infinity) - from.length)
    );
    if (budget < 0.5) return null;

    const after = { ...op, x: from.x, y: from.y };
    const candidates = generateDestinations(
      { ...state, operatives: { ...state.operatives, [op.id]: after } },
      after, budget, { towardEnemies: false }
    );
    const best = this._bestBy(candidates, (d) =>
      this._cover(state, op, d.x, d.y, enemies) * 2 - this._exposure(state, op, d.x, d.y, enemies));
    return best && best.length > 0.5 ? best : null;
  }

  /* --------------------------------------------------------------- */
  /* Scoring                                                          */
  /* --------------------------------------------------------------- */

  _score(state, op, plan, enemies, w, ap, tactics) {
    const e = plan.estimate || {};
    const at = e.endsAt || { x: op.x, y: op.y };

    const damage = e.damage || 0;
    // Splash used to be weighed only while picking a weapon and then dropped
    // from the plan, so a flamer rated a crowd exactly as highly as one lone
    // trooper and never moved to line two of them up.
    const splash = e.splash?.enemy || 0;
    const friendlyFire = e.splash?.friendly || 0;
    const target = e.target ? state.operatives[e.target] : null;
    // Who this operative in particular came for (`ai/characters.js`). Applied
    // to the kill bonus rather than to the damage, because wanting a target
    // dead does not make the weapon hit any harder — but it does decide which
    // of two reachable enemies gets charged, and whether crossing the board
    // for the enemy leader beats shooting the trooper in front of you.
    const wanted = target ? huntBonus(tactics?.hunts, profileOf(state, target)) : 1;
    const killBonus = target
      ? killPressure(damage, target) * threatValue(state, target) * 1.2 * wanted
      : 0;

    const objective = objectiveValueAt(state, op, at.x, at.y);
    const cover = this._cover(state, op, at.x, at.y, enemies);
    // A plan is judged on the order it ENDS on, which is the order the
    // operative will be standing in when the enemy activates. Read off the
    // plan's own actions rather than a per-branch flag, so a branch that
    // forgets to declare it cannot be scored as something it is not: a charge
    // flips to Engage and must be priced as exposed, a Conceal advance must
    // not be.
    const exposure = this._exposure(state, op, at.x, at.y, enemies, endOrderOf(plan, op));
    const wasted = Math.max(0, ap - (e.apUsed || 0));

    // Concealment is only worth something where there is cover to hide in.
    const survival = (e.concealed && cover > 0.5 ? 1 : 0) *
      (op.woundsRemaining / op.wounds < 0.5 ? 1.5 : 1);

    // Charging into a gunline is worse than the melee estimate suggests.
    const chargeRisk = e.charge ? exposure * 0.4 : 0;

    // Closing the distance: 1 when in contact, 0 beyond the horizon.
    const ghost = { ...op, x: at.x, y: at.y };
    const nearestEnemy = enemies.length
      ? Math.min(...enemies.map((en) => baseDistance(ghost, en)))
      : Infinity;
    const approach = enemies.length
      ? Math.max(0, 1 - nearestEnemy / APPROACH_HORIZON)
      : 0;

    // The spell is what a psyker is on the board for; a small bonus for getting
    // one off stops it trading the big cast away for a safer sidearm shot.
    const spell = e.psychic ? (tactics?.spellBonus ?? 0) : 0;

    // A support action is priced in expected wounds (see ai/support.js), so it
    // rides the same weight a shot does and a heal can out-rank a poor shot.
    const support = e.support || 0;

    plan.score =
      w.damage * damage +
      w.damage * splash * (tactics?.splashWeight ?? 1) +
      w.damage * support +
      spell +
      killBonus +
      w.objective * objective +
      w.cover * cover +
      w.survival * survival +
      (w.approach ?? 0) * approach -
      w.exposure * exposure -
      w.waste * wasted -
      FRIENDLY_FIRE_PENALTY * friendlyFire -
      chargeRisk;

    plan.breakdown = {
      damage: Number((w.damage * damage).toFixed(2)),
      support: Number((w.damage * support).toFixed(2)),
      splash: Number((w.damage * splash * (tactics?.splashWeight ?? 1)).toFixed(2)),
      spell: Number(spell.toFixed(2)),
      kill: Number(killBonus.toFixed(2)),
      objective: Number((w.objective * objective).toFixed(2)),
      cover: Number((w.cover * cover).toFixed(2)),
      survival: Number((w.survival * survival).toFixed(2)),
      approach: Number(((w.approach ?? 0) * approach).toFixed(2)),
      exposure: Number((-w.exposure * exposure).toFixed(2)),
      waste: Number((-w.waste * wasted).toFixed(2)),
      friendlyFire: Number((-FRIENDLY_FIRE_PENALTY * friendlyFire).toFixed(2)),
    };
    return plan.score;
  }

  _explain(plan) {
    const b = plan.breakdown || {};
    const parts = Object.entries(b)
      .filter(([, v]) => Math.abs(v) >= 0.05)
      .sort((a, c) => Math.abs(c[1]) - Math.abs(a[1]))
      .slice(0, 4)
      .map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${k}`);
    return `Score ${plan.score?.toFixed(2)} (${parts.join(', ')})`;
  }

  _bestBy(items, fn) {
    let best = null;
    let bestVal = -Infinity;
    for (const item of items) {
      const v = fn(item);
      if (v > bestVal) { bestVal = v; best = item; }
    }
    return best;
  }
}

export function createControllers(options = {}) {
  return {
    p1: new UtilityController('p1', options.p1),
    p2: new UtilityController('p2', options.p2),
  };
}
