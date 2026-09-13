/**
 * Analytic estimators used to score candidate plans.
 *
 * These must NOT consume the battle RNG — scoring happens many times per
 * activation, and burning dice while thinking would desync every replay.
 * Everything here is closed-form expectation.
 */
import { baseDistance } from '../maps/geometry.js';
import { parseRule, DEFENCE_DICE } from '../rules/dice.js';
import {
  traceSight, coverForSelection, CONTROL_RANGE, QUICK_SAMPLES,
} from '../rules/visibility.js';
import { effectiveApl, isInjured } from '../rules/effects.js';

/**
 * The order an operative will be on once this plan has played out.
 *
 * Orders only change through a `change_order` action, so the last one in the
 * plan wins and an absent one means the operative keeps the order it has.
 * Both the scorer and the card the player reads have to agree on this, or the
 * card describes an activation the engine is not about to run.
 */
export function endOrderOf(plan, op) {
  let order = op.order;
  for (const action of plan.actions || []) {
    if (action.type === 'change_order' && action.order) order = action.order;
  }
  return order;
}

function rules(weapon) {
  const m = new Map();
  for (const r of weapon.rules || []) {
    const { name, value } = parseRule(r);
    m.set(name, value);
  }
  return m;
}

/** Expected damage of one attack sequence, before any dice are rolled. */
export function expectedDamage(attacker, weapon, defender, { inCover = false } = {}) {
  const rs = rules(weapon);
  const hitOn = Math.max(2, Math.min(6, weapon.hit + (isInjured(attacker) ? 1 : 0)));
  const critOn = rs.has('lethal') ? (rs.get('lethal') || 5) : (rs.has('lethal5') ? 5 : 6);

  let pCrit = (7 - critOn) / 6;
  let pHit = (7 - hitOn) / 6;
  let pNormal = Math.max(0, pHit - pCrit);

  // Re-rolls raise the effective hit chance.
  if (rs.has('relentless')) { pNormal += (1 - pHit) * pNormal; pCrit += (1 - pHit) * pCrit; }
  else if (rs.has('ceaseless')) { const p1 = 1 / 6; pNormal += p1 * pNormal; pCrit += p1 * pCrit; }

  let eNormals = weapon.atk * pNormal;
  let eCrits = weapon.atk * pCrit;
  if (rs.has('balanced')) {
    const miss = weapon.atk * (1 - pHit);
    if (miss > 0) { eNormals += Math.min(1, miss) * pNormal; eCrits += Math.min(1, miss) * pCrit; }
  }
  if (rs.has('rending') && eCrits >= 1 && eNormals >= 1) { eNormals -= 1; eCrits += 1; }

  let dice = DEFENCE_DICE - (rs.get('ap') || 0) - (rs.get('piercing') || 0);
  dice = Math.max(0, dice);
  const coverApplies = inCover && !rs.has('saturate');
  const rolled = coverApplies ? Math.max(0, dice - 1) : dice;
  const saveOn = Math.max(2, Math.min(6, defender.save));
  let eCritSaves = rolled * (1 / 6);
  let eNormalSaves = rolled * Math.max(0, (7 - saveOn) / 6 - 1 / 6) + (coverApplies && dice > 0 ? 1 : 0);

  // Shock discards one of the defender's successes off the first critical.
  if (rs.has('shock') && eCrits > 0) {
    const discard = Math.min(1, eCrits);
    if (eNormalSaves >= discard) eNormalSaves -= discard;
    else eCritSaves = Math.max(0, eCritSaves - discard);
  }

  const critsLeft = Math.max(0, eCrits - eCritSaves);
  const spareCritSaves = Math.max(0, eCritSaves - eCrits);
  const normalsLeft = Math.max(0, eNormals - eNormalSaves - spareCritSaves * 2);

  const devastating = rs.get('devastating') || 0;
  const raw = critsLeft * weapon.damage.critical +
    normalsLeft * weapon.damage.normal +
    eCrits * devastating;

  // Damage beyond what kills the target is wasted; cap it for ranking.
  return Math.min(raw, defender.woundsRemaining);
}

/** How close this attack comes to removing the target outright. */
export function killPressure(expected, defender) {
  if (defender.woundsRemaining <= 0) return 0;
  return Math.min(1, expected / defender.woundsRemaining);
}

/** A rough "worth killing" weight: leaders and gunners first. */
export function threatValue(state, op) {
  const profile = state.teamPacks[op.playerId].operatives.find((o) => o.id === op.profileId);
  const best = (profile?.weapons || []).reduce(
    (m, w) => Math.max(m, w.atk * (7 - w.hit) / 6 * w.damage.normal), 0
  );
  const leader = (profile?.keywords || []).includes('leader') ? 1.6 : 1;
  return best * leader;
}

/**
 * Enemies that could see and shoot a position — the cost of standing there.
 *
 * `order` is the order the operative will be ON when it arrives, which is a
 * property of the PLAN rather than of the operative's current state. It
 * matters because a Concealed operative in cover cannot be selected as a
 * target at all (see rules/visibility.js), so such a position is not merely
 * safer — it is not shootable, and its exposure is zero.
 *
 * This used to be measured geometrically, ignoring the order entirely, and
 * that single omission was most of the engine's bias against close combat.
 * The AI could not see concealment as protection, so it never traded a poor
 * shot for it, and a team that has to cross the board to fight was scored as
 * being in equal danger whether it used the terrain or walked over it. A
 * Goremonger warband managed 1.1 Fight actions per battle against Pathfinders
 * while being shot at 21 times. The rule was always in the engine; the AI just
 * wasn't allowed to know about it.
 *
 * The check mirrors canBeTargeted() rather than re-deriving it, so the plan is
 * scored against the same predicate the shooting code will enforce. Seek is
 * assumed absent: a weapon that ignores the terrain is the exception, and
 * assuming the exception everywhere would put us straight back to geometry.
 */
export function exposureAt(state, op, x, y, enemies, { order = null } = {}) {
  const ghost = { ...op, x, y, order: order ?? op.order };
  let exposure = 0;
  for (const enemy of enemies) {
    const sight = traceSight(enemy, ghost, state.map.terrain || [], [], { samples: QUICK_SAMPLES });
    if (!sight.visible) continue;
    if (ghost.order === 'conceal' && coverForSelection(sight)) continue;
    const range = baseDistance(enemy, ghost);
    const profile = state.teamPacks[enemy.playerId].operatives.find((o) => o.id === enemy.profileId);
    const guns = (profile?.weapons || []).filter((w) => w.type === 'ranged' && (w.range ?? 99) >= range);
    if (!guns.length) continue;
    const worst = Math.max(...guns.map((w) => expectedDamage(enemy, w, ghost, { inCover: sight.cover })));
    exposure += worst;
  }
  return exposure;
}

/**
 * The enemies with a clear sight line to a position.
 *
 * Shooting needs a sight line, so this is the cheap test for "could anything
 * be shot from here" — used to pick which destinations are worth the full
 * target-selection pass. It deliberately ignores weapon ranges, unlike
 * `exposureAt`: a position can be a firing position without being a dangerous
 * one, and vice versa.
 */
export function visibleEnemiesAt(state, op, x, y, enemies) {
  const ghost = { ...op, x, y };
  return enemies.filter(
    (enemy) => traceSight(enemy, ghost, state.map.terrain || [], [], { samples: QUICK_SAMPLES }).visible
  );
}

/** How many enemies have a clear sight line to a position. */
export function sightLinesAt(state, op, x, y, enemies) {
  return visibleEnemiesAt(state, op, x, y, enemies).length;
}

/**
 * The most operatives an area weapon fired from this position could catch:
 * the best crowd standing around any enemy we can actually see from here.
 *
 * Blast and Torrent measure their radius from the *target*, not the shooter,
 * so a flamer looking for a crowd is looking for a clustered target — which is
 * a different question from "where are the enemies thickest".
 */
export function splashOpportunityAt(state, op, x, y, enemies, radius) {
  const visible = visibleEnemiesAt(state, op, x, y, enemies);
  let best = 0;
  for (const centre of visible) {
    const caught = enemies.filter((e) => baseDistance(e, centre) <= radius).length;
    if (caught > best) best = caught;
  }
  return best;
}

/**
 * How many enemies a blast centred on the *operative itself* would catch.
 *
 * This is the bomb squig's question: an Explosive weapon needs no sight line
 * and no target, only a crowd to walk into.
 */
export function detonationOpportunityAt(state, op, x, y, enemies, radius) {
  const ghost = { ...op, x, y };
  return enemies.filter((e) => baseDistance(ghost, e) <= radius).length;
}

/** Does a position benefit from cover against the current enemy positions? */
export function coverQualityAt(state, op, x, y, enemies) {
  if (!enemies.length) return 0;
  const ghost = { ...op, x, y };
  let covered = 0;
  let seen = 0;
  for (const enemy of enemies) {
    const sight = traceSight(enemy, ghost, state.map.terrain || [], [], { samples: QUICK_SAMPLES });
    if (!sight.visible) { covered++; seen++; continue; }
    seen++;
    if (sight.cover) covered++;
  }
  return seen ? covered / seen : 0;
}

/**
 * Objective value of standing at a position: contest what we don't hold,
 * reinforce what's close, ignore what's already safe.
 */
export function objectiveValueAt(state, op, x, y) {
  const ghost = { x, y, baseDiameter: op.baseDiameter };

  // An operative can only stand on ONE marker, so the value of a position is
  // the best marker it reaches — not the sum of every marker on the board.
  // Summing made objective play worth ~5-8 against ~2-4 for a good shot, and
  // the AI simply stopped fighting.
  let best = 0;
  let runnerUp = 0;

  for (const objective of state.objectives) {
    const marker = { x: objective.x, y: objective.y, baseDiameter: 0 };
    const d = baseDistance(ghost, marker);
    const range = objective.controlRange ?? CONTROL_RANGE;
    const holder = objective.controlledBy;
    const mine = holder === op.playerId;
    const contested = holder === null;

    let value;
    if (d <= range) {
      if (mine) value = 1.0;          // maintain
      else if (contested) value = 2.5; // claim
      else value = 3.0;                // steal
    } else {
      // Partial credit for closing on a marker we don't already hold.
      const proximity = Math.max(0, 1 - d / 12);
      value = proximity * (mine ? 0.3 : 1.4);
    }

    if (value > best) { runnerUp = best; best = value; }
    else if (value > runnerUp) { runnerUp = value; }
  }

  // A little credit for standing where a second marker is also in reach.
  return best + runnerUp * 0.25;
}
