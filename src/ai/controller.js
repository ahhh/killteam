/**
 * Utility AI controller.
 *
 * Produces an INTENT (a list of actions plus the reasoning behind them).
 * It never mutates state (#3) and never touches the battle RNG stream — ties
 * are broken with a derived stream so replays stay identical.
 */
import { Rng } from '../rng.js';
import { liveOperatives, ORDERS } from '../state.js';
import { baseDistance } from '../maps/geometry.js';
import { enemiesInControlRange, withinControlRange, CONTROL_RANGE } from '../rules/visibility.js';
import { effectiveApl, isInjured } from '../rules/effects.js';
import { meleeWeapons } from '../rules/shooting.js';
import { DASH_DISTANCE, CHARGE_BONUS } from '../rules/movement.js';
import { generateDestinations, chargeDestination } from './movement.js';
import { bestShotFrom, bestMeleeTarget } from './targeting.js';
import {
  objectiveValueAt, exposureAt, coverQualityAt, expectedDamage,
  killPressure, threatValue,
} from './utility.js';

export const AI_VERSION = '0.1.0';

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
const SHOOT_EVAL_DESTINATIONS = 8;
/** Fidelity the rules engine uses; the chosen plan is re-checked at this level. */
const FULL_SAMPLES = 6;

function weightsFor(op) {
  return ROLE_WEIGHTS[op.role] || ROLE_WEIGHTS.flexible;
}

export class UtilityController {
  constructor(playerId, { personality = 'balanced' } = {}) {
    this.playerId = playerId;
    this.personality = personality;
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

  _exposure(state, op, x, y, enemies) {
    return this._memo('exp', op, x, y, () => exposureAt(state, op, x, y, enemies));
  }

  _cover(state, op, x, y, enemies) {
    return this._memo('cov', op, x, y, () => coverQualityAt(state, op, x, y, enemies));
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
        (o) => baseDistance(op, { x: o.x, y: o.y, baseDiameter: 0 }) < op.move + 2
      )) urgency += 1;
      if (isInjured(op)) urgency -= 0.5;
      if (!best || urgency > best.urgency) best = { id, urgency };
    }
    return best?.id ?? readyIds[0];
  }

  /**
   * @returns {{actions:Array, rationale:string[], considered:number, score:number}}
   */
  planActivation(state, operativeId, { counteract = false } = {}) {
    const op = state.operatives[operativeId];
    this._cache.clear();
    const ap = counteract ? 1 : (op.apRemaining || effectiveApl(op));
    const enemies = liveOperatives(state).filter((o) => o.playerId !== op.playerId);
    const engaged = enemiesInControlRange(op, liveOperatives(state));
    const w = weightsFor(op);

    const plans = engaged.length
      ? this._engagedPlans(state, op, ap, enemies, engaged)
      : this._freePlans(state, op, ap, enemies);

    plans.push({ actions: [], rationale: ['No useful action found; holds position.'], estimate: {} });

    for (const plan of plans) this._score(state, op, plan, enemies, w, ap);

    plans.sort((a, b) => b.score - a.score);

    // The ranking pass traces sight lines cheaply; the engine will re-check at
    // full fidelity. Re-validate before committing so we never burn AP on a
    // shot the rules engine is going to reject.
    let chosen = null;
    for (const plan of plans.slice(0, 6)) {
      if (this._planIsValid(state, op, plan, enemies)) { chosen = plan; break; }
    }
    if (!chosen) chosen = plans[plans.length - 1];

    const tied = plans.filter(
      (p) => Math.abs(p.score - chosen.score) < 1e-6 && this._planIsValid(state, op, p, enemies)
    );
    if (tied.length > 1) {
      // Derived stream: deterministic, but doesn't disturb the battle dice.
      const tieRng = new Rng(`${state.seed}:ai:${state.eventLog.length}:${op.id}`);
      chosen = tieRng.pick(tied);
    }

    return {
      operativeId,
      actions: chosen.actions,
      rationale: [...chosen.rationale, this._explain(chosen)],
      considered: plans.length,
      score: Number(chosen.score.toFixed(2)),
    };
  }

  /**
   * Re-check a plan's shoot action with the same LOS fidelity the engine uses.
   * Movement and melee are already checked exactly during enumeration.
   */
  _planIsValid(state, op, plan, enemies) {
    const shoot = plan.actions.find((a) => a.type === 'shoot');
    if (!shoot) return true;
    const at = plan.estimate?.endsAt || { x: op.x, y: op.y };
    const confirmed = bestShotFrom(state, op, at, enemies, {
      samples: FULL_SAMPLES, moved: plan.estimate?.movedBefore ?? null,
    });
    if (!confirmed) return false;
    // Keep the plan, but shoot at whatever is actually targetable from there.
    shoot.targetId = confirmed.targetId;
    shoot.weaponId = confirmed.weaponId;
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

  _engagedPlans(state, op, ap, enemies, engaged) {
    const plans = [];
    const melee = meleeWeapons(state, op)[0];

    if (melee) {
      const target = bestMeleeTarget(state, op, engaged, melee);
      if (target) {
        plans.push({
          actions: [
            { type: 'change_order', order: ORDERS.ENGAGE },
            { type: 'fight', targetId: target.targetId, weaponId: melee.id },
          ],
          rationale: [`Fights ${target.targetName} (expects ${target.expected.toFixed(1)} damage)`],
          estimate: { damage: target.expected, target: target.targetId, apUsed: 1, endsAt: { x: op.x, y: op.y } },
        });
      }
    }

    // Disengage: worth it when melee is going badly.
    const destinations = generateDestinations(state, op, op.move, { towardEnemies: false })
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

  _freePlans(state, op, ap, enemies) {
    const plans = [];
    const melee = meleeWeapons(state, op)[0];

    // --- Shoot without moving -------------------------------------
    const shotHere = bestShotFrom(state, op, op, enemies);
    if (shotHere) {
      const base = [
        this._orderForShot(shotHere),
        { type: 'shoot', targetId: shotHere.targetId, weaponId: shotHere.weaponId },
      ];
      plans.push({
        actions: base,
        rationale: [
          `Shoots ${shotHere.targetName} with ${shotHere.weaponName} from cover of current position`,
          ...(shotHere.silent ? ['Stays on Conceal — the weapon is Silent'] : []),
        ],
        estimate: { damage: shotHere.expected, target: shotHere.targetId, apUsed: 1, endsAt: { x: op.x, y: op.y } },
      });

      // Shoot, then reposition into safety with the spare AP — unless the
      // weapon is Heavy, which pins the operative for the rest of the turn.
      const mayMoveAfter = shotHere.heavyAllows === undefined || shotHere.heavyAllows === 'reposition';
      if (ap >= 2 && mayMoveAfter) {
        const retreats = generateDestinations(state, op, op.move, { towardEnemies: false });
        const safest = this._bestBy(retreats, (d) =>
          this._cover(state, op, d.x, d.y, enemies) * 2 - this._exposure(state, op, d.x, d.y, enemies));
        if (safest && safest.length > 0.2) {
          plans.push({
            actions: [...base, { type: 'reposition', destination: { x: safest.x, y: safest.y } }],
            rationale: [
              `Shoots ${shotHere.targetName} with ${shotHere.weaponName}`,
              `Then breaks ${safest.length.toFixed(1)}" to a safer position`,
            ],
            estimate: {
              damage: shotHere.expected, target: shotHere.targetId,
              apUsed: 2, endsAt: safest, moved: safest.length,
            },
          });
        }
      }
    }

    // --- Move, then shoot -----------------------------------------
    if (ap >= 2) {
      const destinations = generateDestinations(state, op, op.move);
      const ranked = destinations
        .map((d) => ({
          d,
          quick: objectiveValueAt(state, op, d.x, d.y) * 2 - this._exposure(state, op, d.x, d.y, enemies),
        }))
        .sort((a, b) => b.quick - a.quick)
        .slice(0, SHOOT_EVAL_DESTINATIONS)
        .map((r) => r.d);

      for (const dest of ranked) {
        // A Heavy weapon cannot follow a Reposition, so ask for the best shot
        // that would still be legal after the move.
        const shot = bestShotFrom(state, op, dest, enemies, { moved: 'reposition' });
        if (!shot) continue;
        plans.push({
          actions: [
            this._orderForShot(shot),
            { type: 'reposition', destination: { x: dest.x, y: dest.y } },
            { type: 'shoot', targetId: shot.targetId, weaponId: shot.weaponId },
          ],
          rationale: [
            `Repositions ${dest.length.toFixed(1)}" (${dest.tag})`,
            `Shoots ${shot.targetName} with ${shot.weaponName}${shot.inCover ? ' (in cover)' : ''}`,
          ],
          estimate: {
            damage: shot.expected, target: shot.targetId,
            apUsed: 2, endsAt: dest, moved: dest.length, movedBefore: 'reposition',
          },
        });
      }
    }

    // --- Charge and fight -----------------------------------------
    if (melee && ap >= 2) {
      const allowance = op.move + CHARGE_BONUS;
      for (const enemy of enemies) {
        if (baseDistance(op, enemy) > allowance) continue;
        // Ask for a *legal* contact point rather than assuming one exists.
        const dest = chargeDestination(state, op, enemy, allowance);
        if (!dest) continue;
        const expected = expectedDamage(op, melee, enemy, { inCover: false });
        plans.push({
          actions: [
            { type: 'change_order', order: ORDERS.ENGAGE },
            { type: 'charge', destination: { x: dest.x, y: dest.y }, targetId: enemy.id },
            { type: 'fight', targetId: enemy.id, weaponId: melee.id },
          ],
          rationale: [
            `Charges ${enemy.name} across ${dest.length.toFixed(1)}"`,
            `Fights for an expected ${expected.toFixed(1)} damage`,
          ],
          estimate: {
            damage: expected, target: enemy.id, apUsed: 2,
            endsAt: dest, moved: dest.length, charge: true,
          },
        });
      }
    }

    // --- Take ground ----------------------------------------------
    const moveDests = generateDestinations(state, op, op.move);
    const objectiveDest = this._bestBy(moveDests, (d) => objectiveValueAt(state, op, d.x, d.y));
    if (objectiveDest) {
      const staysHidden = !bestShotFrom(state, op, objectiveDest, enemies);
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

      // Reposition + Dash: the longest legal move in the game.
      if (ap >= 2) {
        const after = { ...op, x: objectiveDest.x, y: objectiveDest.y };
        const dashDests = generateDestinations(
          { ...state, operatives: { ...state.operatives, [op.id]: after } },
          after, DASH_DISTANCE, { towardEnemies: false }
        );
        const dashTo = this._bestBy(dashDests, (d) => objectiveValueAt(state, op, d.x, d.y));
        if (dashTo && dashTo.length > 0.2) {
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
      }
    }

    return plans;
  }

  /* --------------------------------------------------------------- */
  /* Scoring                                                          */
  /* --------------------------------------------------------------- */

  _score(state, op, plan, enemies, w, ap) {
    const e = plan.estimate || {};
    const at = e.endsAt || { x: op.x, y: op.y };

    const damage = e.damage || 0;
    const target = e.target ? state.operatives[e.target] : null;
    const killBonus = target
      ? killPressure(damage, target) * threatValue(state, target) * 1.2
      : 0;

    const objective = objectiveValueAt(state, op, at.x, at.y);
    const cover = this._cover(state, op, at.x, at.y, enemies);
    const exposure = this._exposure(state, op, at.x, at.y, enemies);
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

    plan.score =
      w.damage * damage +
      killBonus +
      w.objective * objective +
      w.cover * cover +
      w.survival * survival +
      (w.approach ?? 0) * approach -
      w.exposure * exposure -
      w.waste * wasted -
      chargeRisk;

    plan.breakdown = {
      damage: Number((w.damage * damage).toFixed(2)),
      kill: Number(killBonus.toFixed(2)),
      objective: Number((w.objective * objective).toFixed(2)),
      cover: Number((w.cover * cover).toFixed(2)),
      survival: Number((w.survival * survival).toFixed(2)),
      approach: Number(((w.approach ?? 0) * approach).toFixed(2)),
      exposure: Number((-w.exposure * exposure).toFixed(2)),
      waste: Number((-w.waste * wasted).toFixed(2)),
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
