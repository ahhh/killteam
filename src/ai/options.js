/**
 * Tactics offered to a human player.
 *
 * Semi-manual mode does not replace the AI — it re-cuts what the AI already
 * worked out. `UtilityController._enumerate` builds every plan an operative
 * could follow and ranks them; taking the top three would hand a player three
 * versions of the same idea, because the ranking is dominated by whichever
 * branch happens to be good this turn (six ways to shoot the same trooper).
 *
 * So the question here is not "which plan is best" but "what are the
 * genuinely different things this operative could do right now", and the
 * answer is the best plan of each KIND. The kinds are read off the plan's own
 * actions rather than declared at each of the twenty-odd places a plan is
 * built, so a new branch in the controller cannot forget to label itself.
 *
 * Three of those branches never appear in the enumeration at all, because the
 * AI only ever reaches them as openings or as tails: the operative's own
 * printed actions, a resource the team economy is offering, and Guard. A
 * player should be able to choose them outright, so they are built here as
 * plans in their own right and scored by the same function as everything else
 * — an option the player picks is not a cheaper one.
 *
 * Nothing here mutates state (#3). Every action a player chooses is re-checked
 * by the action layer exactly like the AI's, so choosing is not permission.
 */
import { liveOperatives } from '../state.js';
import { baseDistance } from '../maps/geometry.js';
import { getProfile } from '../rules/shooting.js';
import { findUniqueAction } from '../rules/unique-actions.js';
import { availableSpends } from '../rules/resources.js';
import { guardBlocker } from '../rules/guard.js';
import { usableMoveAllowance } from '../rules/engine.js';
import { DASH_DISTANCE } from '../rules/movement.js';
import { withinControlRange } from '../rules/visibility.js';
import { endOrderOf } from './utility.js';
import { generateDestinations } from './movement.js';
import { bestUniqueAction, guardValue } from './support.js';
import { isLastTeamStanding } from '../rules/phases.js';

/**
 * The branches, in the order they break ties when two score the same.
 *
 * `label` is the pill on the card — what KIND of thing this is — and is
 * deliberately generic, because the card's title is already specific to the
 * team ("Cast Witchfire at Ork Boy" under a "Use a spell" pill).
 */
export const BRANCHES = [
  { id: 'melee', label: 'Close combat' },
  { id: 'psychic', label: 'Use a spell' },
  { id: 'move_shoot', label: 'Move and shoot' },
  { id: 'shoot', label: 'Shoot' },
  { id: 'support', label: 'Use an ability' },
  { id: 'item', label: 'Use a resource' },
  { id: 'reaction', label: 'Prepare a reaction' },
  { id: 'ground', label: 'Take ground' },
  { id: 'press', label: 'Advance' },
  { id: 'cover', label: 'Take cover' },
  { id: 'withdraw', label: 'Disengage' },
  { id: 'hold', label: 'Hold' },
];

const BRANCH_ORDER = new Map(BRANCHES.map((b, i) => [b.id, i]));
const BRANCH_LABEL = new Map(BRANCHES.map((b) => [b.id, b.label]));

const MOVES = new Set(['reposition', 'dash', 'charge', 'fall_back']);

/**
 * Which branch a plan belongs to, from its actions alone.
 *
 * Read in priority order: what an operative spends its activation on is the
 * most committal thing in the plan, not the first thing in it. A charge that
 * opens with a resource spend is a melee plan, not an item plan.
 */
export function branchOf(plan) {
  // The synthetic branches below say what they are; everything the controller
  // enumerated is read off its actions.
  if (plan.branch) return plan.branch;
  const actions = plan.actions || [];
  const has = (type) => actions.some((a) => a.type === type);

  if (has('charge') || has('fight')) return 'melee';
  if (has('shoot')) {
    if (plan.estimate?.psychic) return 'psychic';
    return actions.some((a) => MOVES.has(a.type)) ? 'move_shoot' : 'shoot';
  }
  // A spell an operative PERFORMS is still a spell. Half the casters in the
  // bundle cast by printed action rather than by weapon, and filing those
  // under "Use an ability" put a Sorcerer's repertoire on the same card as a
  // Medikit (see `isPsychicAbility` in ai/characters.js).
  if (has('unique')) return plan.estimate?.psychic ? 'psychic' : 'support';
  if (has('guard')) return 'reaction';
  if (has('spend')) return 'item';
  if (has('fall_back')) return 'withdraw';
  if (actions.some((a) => MOVES.has(a.type))) return 'ground';
  return 'hold';
}

/**
 * Which *card slot* a plan competes for.
 *
 * Normally the branch, because two ways to shoot the same trooper are one
 * card. The exception is what an operative can do that nothing else on the
 * board can: its own printed actions and its spells. A Sorcerer of Destiny
 * prints two, a Magus prints two more, and the branch-per-card rule threw the
 * second one away every time — so the menu could tell a player that this
 * operative had a repertoire, and then offer one of it.
 *
 * Keyed by the ability or the weapon, so both reach the ranking. They still
 * have to earn their slot against everything else; nothing here is a
 * reservation.
 */
export function branchKeyOf(plan, branch) {
  const actions = plan.actions || [];
  if (branch === 'support' || branch === 'psychic') {
    const unique = actions.find((a) => a.type === 'unique');
    if (unique) return `${branch}:${unique.abilityId}`;
    const shoot = actions.find((a) => a.type === 'shoot');
    if (shoot) return `${branch}:${shoot.weaponId}`;
  }
  return branch;
}

/* ------------------------------------------------------------------ */
/* The branches the enumeration never builds                           */
/* ------------------------------------------------------------------ */

/**
 * Hold the shot for the enemy's turn.
 *
 * The AI only ever reaches Guard with a spare point it had nothing else to do
 * with (`_appendSpareAp`), so it is never a plan it weighed — and "cover that
 * doorway instead of taking a bad shot now" is exactly the sort of call a
 * player wants to make. Priced by the same estimate the AI uses for it, which
 * is deliberately modest: a held shot only ever fires if somebody walks into
 * the lane.
 */
function guardPlan(state, op, enemies) {
  if (guardBlocker(state, op)) return null;
  const value = guardValue(state, op, enemies);
  if (value <= 0) return null;
  return {
    actions: [
      // Guard needs Engage, and the operative may be sitting on Conceal.
      { type: 'change_order', order: 'engage' },
      { type: 'guard' },
    ],
    rationale: [
      'Holds the shot for the enemy’s turn, covering the approach',
    ],
    estimate: {
      damage: 0, apUsed: 1, support: value, endsAt: { x: op.x, y: op.y },
    },
  };
}

/**
 * The operative's own printed actions, as choices rather than as an opening.
 *
 * `openingSupport` already takes any action worth more than a point of this
 * operative's AP, and that one rides along with every option — it is not a
 * decision, it is arithmetic the player would make the same way. What is left
 * is the marginal ones: a Spot that is worth about a point, a Signal that
 * might be better spent shooting. Those are worth asking about.
 */
function uniquePlans(state, op, taken) {
  const plans = [];
  const planned = new Set(taken);
  // Three, not two: an operative that prints three actions has three, and the
  // ranking below is what decides whether any of them reaches a card.
  for (let i = 0; i < 3; i++) {
    const best = bestUniqueAction(state, op, { exclude: planned });
    if (!best) break;
    planned.add(best.action.abilityId);
    plans.push({
      actions: [best.action],
      rationale: [`${best.name} on ${best.targetName}`],
      estimate: {
        damage: 0, apUsed: best.ap, support: best.value,
        psychic: best.psychic === true,
        endsAt: { x: op.x, y: op.y },
      },
    });
  }
  return plans;
}

/**
 * Spend a team resource on staying alive, then get off the skyline.
 *
 * The economies that buy attack dice already ride the shooting and melee
 * plans, because a spend costs no AP and there is nothing to decide — it is
 * bought when the plan that wants it wins. The ones that buy wounds back are
 * different: patching up and pulling into cover is a whole activation, and a
 * player with a wounded specialist should be able to choose it over one more
 * shot. That is the plan this builds.
 */
function recoverPlan(controller, ctx, taken) {
  const { state, op, enemies, ap } = ctx;
  // `healWounds` only. The other spend effects — attack dice, an extra swing,
  // an inch of Move — are modifiers on an action, and a card offering one
  // without the action would be offering nothing; those ride the shooting and
  // melee plans instead, where the plan that wants them pays for them.
  const spend = availableSpends(state, op, { window: 'activation' })
    .filter((o) => !taken.has(o.spend.id))
    .find((o) => o.spend.effect?.type === 'healWounds');
  if (!spend) return null;

  const name = spend.spend.name || spend.spend.id;
  const action = {
    type: 'spend', resource: spend.key, spendId: spend.spend.id,
    spendName: name, optional: true,
  };

  // Somewhere safer to do it. A spend costs no AP, so the whole budget is
  // still there for the walk; without one this is just the spend, which is a
  // perfectly good answer for an operative already behind a wall.
  const allowance = ap > 0 ? usableMoveAllowance(state, op, 'reposition') : 0;
  const retreat = allowance > 0
    ? controller._bestBy(
        generateDestinations(state, op, allowance, { towardEnemies: false }),
        (d) => controller._cover(state, op, d.x, d.y, enemies) * 2 -
          controller._exposure(state, op, d.x, d.y, enemies))
    : null;

  if (!retreat || retreat.length <= 0.2) {
    return {
      actions: [action],
      rationale: [`Spends ${name} where it stands`],
      estimate: { damage: 0, apUsed: 0, endsAt: { x: op.x, y: op.y } },
    };
  }
  return {
    actions: [
      action,
      { type: 'change_order', order: 'conceal' },
      { type: 'reposition', destination: { x: retreat.x, y: retreat.y } },
    ],
    rationale: [
      `Spends ${name}`,
      `Breaks ${retreat.length.toFixed(1)}" into cover and drops to Conceal`,
    ],
    estimate: {
      damage: 0, apUsed: 1, endsAt: retreat, moved: retreat.length,
      concealed: true,
    },
  };
}

/**
 * How much ground a covered move is allowed to give up before it stops being a
 * covered advance and starts being a retreat, in inches.
 *
 * Not zero, because the terrain does not oblige: the wall worth standing
 * behind is rarely exactly perpendicular to the enemy, and a half-inch of
 * slack is the difference between "work along the cover" and "there is no
 * covered move on this board".
 */
const RING_TOLERANCE = 1.5;

/**
 * Two ways to spend an activation walking that the enumeration never separates.
 *
 * `_freePlans` builds exactly one movement plan — the destination with the
 * best objective value — because for the AI that is the only question worth
 * asking. For a player it is three: press toward the enemy, get behind
 * something, or go stand on the marker. On the first turning point of most
 * battles those are the ONLY tactics available to anyone, and a menu that
 * offered "advance" twice and "hold position" was a menu with one real choice
 * on it.
 *
 * Both are Conceal: an operative crossing open ground with nothing to shoot at
 * has no reason to be targetable while it does it.
 *
 * The covered move is a covered *advance*. Scored on cover alone it was the
 * far face of the nearest terrain measured from the enemy — which is, by
 * construction, backwards — so the menu's two walking options were "press into
 * the open" and "retreat behind something", and a player who wanted to cross
 * the board the way the tabletop crosses it had neither. So the candidates are
 * filtered to the ones that close the distance or hold it (a ring around the
 * enemy, within `RING_TOLERANCE`), and only if the board offers nothing at all
 * on that side does it fall back to the best cover anywhere in reach — a card
 * that disappears is worse than a card that retreats.
 */
function movementPlans(controller, ctx) {
  const { state, op, enemies, ap } = ctx;
  if (!enemies.length || ap < 1) return [];
  const allowance = usableMoveAllowance(state, op, 'reposition');
  if (allowance <= 0) return [];
  const dests = generateDestinations(state, op, allowance);
  if (!dests.length) return [];

  const nearestFrom = (d) => Math.min(...enemies.map((e) => baseDistance({ ...op, x: d.x, y: d.y }, e)));
  const nearestNow = nearestFrom(op);

  const build = (dest, branch, rationale, extra = {}) => {
    if (!dest || dest.length <= 0.2) return null;
    const actions = [
      { type: 'change_order', order: 'conceal' },
      { type: 'reposition', destination: { x: dest.x, y: dest.y } },
    ];
    const estimate = {
      damage: 0, apUsed: 1, endsAt: dest, moved: dest.length, concealed: true,
      ...extra,
    };
    // A Dash is illegal once an enemy is within control range, so the second
    // leg is only planned when the first one keeps clear of one.
    const clear = !enemies.some((e) => withinControlRange({ ...op, x: dest.x, y: dest.y }, e));
    if (branch === 'press' && ap >= 2 && clear) {
      const after = { ...op, x: dest.x, y: dest.y };
      const onward = controller._bestBy(
        generateDestinations(
          { ...state, operatives: { ...state.operatives, [op.id]: after } },
          after, DASH_DISTANCE),
        (d) => -Math.min(...enemies.map((e) => baseDistance({ ...op, x: d.x, y: d.y }, e))));
      if (onward && onward.length > 0.2) {
        actions.push({ type: 'dash', destination: { x: onward.x, y: onward.y }, optional: true });
        estimate.apUsed = 2;
        estimate.endsAt = onward;
        estimate.moved = dest.length + onward.length;
        rationale = [...rationale, `Dashes a further ${onward.length.toFixed(1)}"`];
      }
    }
    return { branch, actions, rationale, estimate };
  };

  const plans = [];
  const press = controller._bestBy(dests, (d) => -nearestFrom(d));

  // What a covered position is worth to somebody who still has to get across
  // the board: the cover itself, what standing there costs, and the ground it
  // gains. Concealment is only protection where there is something to hide
  // behind, so a position with no cover scores nothing for the order it keeps.
  const shelterValue = (d) => {
    const gained = Math.max(0, nearestNow - nearestFrom(d));
    return controller._cover(state, op, d.x, d.y, enemies) * 2 -
      controller._exposure(state, op, d.x, d.y, enemies, 'conceal') +
      Math.min(1, gained / Math.max(1, allowance)) * 1.5;
  };
  // A "take cover" card that ends in the open is a lie on the card, and the
  // press option already covers walking into the open — so a pool with no
  // cover in it produces no card rather than a mislabelled one.
  const shelterOf = (pool) => {
    const best = controller._bestBy(pool, shelterValue);
    return best && controller._cover(state, op, best.x, best.y, enemies) > 0.2 ? best : null;
  };
  // The enemy's side of the board first — closing the distance, or holding it
  // on a ring around them. Only if there is genuinely no cover on that side
  // does the card fall back to the best cover anywhere in reach, and then it
  // says on the card that it is giving ground for it.
  const forward = shelterOf(
    dests.filter((d) => nearestFrom(d) <= nearestNow + RING_TOLERANCE));
  const advancing = forward !== null;
  const sheltered = forward ?? shelterOf(dests);

  const pressPlan = build(press, 'press', [
    `Moves ${press?.length.toFixed(1) ?? '0'}" straight at the enemy line, staying Concealed`,
  ]);
  if (pressPlan) plans.push(pressPlan);

  // Only worth a card if it is somewhere else: on an open board the safest
  // square and the closest one are regularly the same square.
  const samePlace = press && sheltered &&
    Math.hypot(press.x - sheltered.x, press.y - sheltered.y) < 1;
  if (sheltered && !samePlace) {
    const far = sheltered.length.toFixed(1);
    const closes = advancing && nearestFrom(sheltered) < nearestNow - 0.5;
    let opening;
    if (closes) opening = `Works ${far}" forward under cover, holding Conceal`;
    else if (advancing) opening = `Shifts ${far}" into cover without giving ground`;
    else opening = `Falls ${far}" back into the best cover in reach`;
    const coverPlan = build(sheltered, 'cover', [
      opening,
      advancing
        ? 'Keeps the terrain between itself and the enemy line'
        : 'Nothing covered lies forward of here — this one gives ground for it',
    ], { advancing: closes });
    if (coverPlan) plans.push(coverPlan);
  }
  return plans;
}

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

function weaponName(state, op, weaponId) {
  const weapon = (getProfile(state, op).weapons || []).find((w) => w.id === weaponId);
  return weapon?.name ?? weaponId ?? 'its weapon';
}

function targetName(state, id) {
  return state.operatives[id]?.name ?? 'the enemy';
}

/**
 * The card's headline: what the player is actually ordering, in the team's own
 * vocabulary — its weapon names, its ability names, its resource names.
 */
function titleFor(state, op, plan, branch) {
  const actions = plan.actions || [];
  const find = (type) => actions.find((a) => a.type === type);

  switch (branch) {
    case 'melee': {
      const charge = find('charge');
      const fight = find('fight');
      const who = targetName(state, charge?.targetId ?? fight?.targetId);
      const swings = actions.filter((a) => a.type === 'fight').length;
      const blows = swings > 1 ? ` (${swings} attacks)` : '';
      return charge ? `Charge ${who}${blows}` : `Fight ${who}${blows}`;
    }
    case 'psychic': {
      const shoot = find('shoot');
      if (shoot) {
        return `Cast ${weaponName(state, op, shoot.weaponId)} at ${targetName(state, shoot.targetId)}`;
      }
      // A spell that is a printed action rather than a weapon.
      const unique = find('unique');
      const entry = unique ? findUniqueAction(state, op, unique.abilityId) : null;
      const name = entry?.ability.name || entry?.ability.id || unique?.abilityId || 'the spell';
      const who = unique?.targetId === op.id ? 'itself' : targetName(state, unique?.targetId);
      return `Cast ${name} on ${who}`;
    }
    case 'move_shoot': {
      const shoot = find('shoot');
      return `Move up and fire ${weaponName(state, op, shoot?.weaponId)} ` +
        `at ${targetName(state, shoot?.targetId)}`;
    }
    case 'shoot': {
      const shoot = find('shoot');
      const shots = actions.filter((a) => a.type === 'shoot').length;
      if (shoot?.targetId === op.id) return `Detonate ${weaponName(state, op, shoot.weaponId)}`;
      const volley = shots > 1 ? `Volley ${shots}× ` : 'Fire ';
      return `${volley}${weaponName(state, op, shoot?.weaponId)} at ${targetName(state, shoot?.targetId)}`;
    }
    case 'support': {
      const unique = find('unique');
      const entry = unique ? findUniqueAction(state, op, unique.abilityId) : null;
      const name = entry?.ability.name || entry?.ability.id || unique?.abilityId || 'ability';
      const who = unique?.targetId === op.id ? 'itself' : targetName(state, unique?.targetId);
      return `${name} on ${who}`;
    }
    case 'item':
      return `Spend ${find('spend')?.spendName ?? 'a resource'}`;
    case 'reaction':
      return 'Hold Guard and cover the approach';
    case 'ground': {
      const far = plan.estimate?.moved;
      const how = far ? ` ${far.toFixed(1)}"` : '';
      return isLastTeamStanding(state)
        ? `Close the distance${how}` : `Advance${how} onto the objectives`;
    }
    case 'press':
      return `Push ${(plan.estimate?.moved ?? 0).toFixed(1)}" toward the enemy`;
    case 'cover': {
      const far = (plan.estimate?.moved ?? 0).toFixed(1);
      // Named for what it does with the ground, because that is the whole
      // difference between this card and Disengage.
      return plan.estimate?.advancing
        ? `Advance ${far}" under cover` : `Break ${far}" into cover`;
    }
    case 'withdraw':
      return 'Fall back out of reach';
    default:
      return 'Hold position';
  }
}

/**
 * The two or three numbers a player actually decides on, short enough to read
 * on a phone: what it expects to do, and what it costs.
 */
function chipsFor(state, op, plan, ap) {
  const e = plan.estimate || {};
  const chips = [];
  if (e.damage > 0.05) chips.push(`~${e.damage.toFixed(1)} dmg`);
  if (e.splash?.enemy > 0.05) chips.push(`+${e.splash.enemy.toFixed(1)} splash`);
  if (e.support > 0.05) chips.push(`~${e.support.toFixed(1)} value`);
  if (e.moved > 0.2) chips.push(`${e.moved.toFixed(1)}" move`);
  const used = Math.min(ap, e.apUsed || 0);
  chips.push(`${used}/${ap} AP`);
  // The order the operative is LEFT on, which is the half of the choice the
  // opponent's turn is played against — and the one thing on the card the
  // player cannot work out from the title.
  //
  // Both sides are printed, not just Conceal. Every card used to be silent
  // about breaking cover, so an option that traded concealment for a pistol
  // shot looked exactly like one that kept it, and the trade was invisible at
  // the moment it was being made. Read off the plan's own actions rather than
  // off `estimate.concealed`, which only some builders set — a chip that
  // disagrees with the activation the engine is about to run is worse than no
  // chip.
  chips.push(endOrderOf(plan, op) === 'engage' ? 'ends on Engage' : 'ends on Conceal');
  return chips;
}

/**
 * Two plans are "the same idea" when they spend the activation on the same
 * things in the same place. Used only to fill the menu out when an operative
 * has fewer than three branches available — a second way to shoot beats a
 * blank card, but a second way to shoot the same target from the same rooftop
 * does not.
 */
function signatureOf(plan) {
  return (plan.actions || []).map((a) => {
    const where = a.destination
      ? `@${a.destination.x.toFixed(0)},${a.destination.y.toFixed(0)}`
      : '';
    return `${a.type}:${a.targetId ?? a.abilityId ?? a.spendId ?? a.order ?? ''}${where}`;
  }).join('|');
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

/**
 * Up to `count` options, each a complete intent the engine can run.
 *
 * @param {UtilityController} controller the controller that built `plans`
 * @param {object} ctx  its activation context (`_context`)
 * @param {Array}  plans the ranked enumeration (`_enumerate`)
 * @returns {Array<{id:string, branch:string, branchLabel:string, title:string,
 *                  detail:string[], chips:string[], score:number,
 *                  recommended:boolean, actions:Array, rationale:string[]}>}
 */
export function buildTacticOptions(controller, ctx, plans, { count = 3 } = {}) {
  const { state, op, enemies, ap, w, tactics, counteract, support } = ctx;

  // The branches the enumeration cannot produce. A counteraction is a single
  // action with no room for an opening or a tail, so only the ones that fit in
  // one action are offered there.
  const extras = [];
  const guard = guardPlan(state, op, enemies);
  if (guard) extras.push(guard);
  const taken = new Set((support?.actions || []).map((a) => a.abilityId));
  extras.push(...uniquePlans(state, op, taken));
  extras.push(...movementPlans(controller, ctx));
  if (!counteract) {
    const spentAlready = new Set(
      [...(ctx.spending?.always || []), ...(ctx.spending?.conditional || [])]
        .map((a) => a.spendId));
    const recover = recoverPlan(controller, ctx, spentAlready);
    if (recover) extras.push(recover);
  }
  for (const plan of extras) controller._score(state, op, plan, enemies, w, ap, tactics);

  // One pool, ranked together, so a synthetic branch has to earn its card the
  // same way a shooting plan does.
  const pool = [...plans, ...extras].sort((a, b) => b.score - a.score);

  // The best VALID plan for each card slot. Validation is the expensive step
  // (it re-traces sight lines at engine fidelity), so it only runs on a plan
  // that is about to become the front-runner for its slot. A slot is normally
  // the branch; a spell or a printed action gets one of its own, so a
  // repertoire is not collapsed to one card (see `branchKeyOf`).
  const best = new Map();
  const rest = [];
  for (const plan of pool) {
    const branch = branchOf(plan);
    const slot = branchKeyOf(plan, branch);
    if (best.has(slot)) { rest.push(plan); continue; }
    if (!controller._planIsValid(state, op, plan, enemies, tactics)) continue;
    best.set(slot, { branch, plan });
  }

  // Holding position is the enumeration's fallback, not a tactic: it is the
  // plan that exists so ranking always has an answer. It goes last whatever it
  // scores, so it only ever reaches a card when there is genuinely nothing
  // else this operative can do.
  const ranked = [...best.values()]
    .map(({ branch, plan }) => [branch, plan])
    .sort((a, b) => b[1].score - a[1].score ||
      BRANCH_ORDER.get(a[0]) - BRANCH_ORDER.get(b[0]));

  const chosen = [];
  const titles = new Set();
  const signatures = new Set();
  /**
   * Two cards that read the same are one card and a wasted slot.
   *
   * Different branches regularly arrive at the same answer — the square that
   * is closest to the enemy is often also the one with the best objective
   * value — and a player cannot tell those two cards apart, whatever the
   * pills on them say. The title is the test because the title is what they
   * read.
   */
  const take = (branch, plan) => {
    if (chosen.length >= count) return false;
    const title = titleFor(state, op, plan, branch);
    const sig = signatureOf(plan);
    if (titles.has(title) || signatures.has(sig)) return false;
    titles.add(title);
    signatures.add(sig);
    chosen.push({ branch, plan, title });
    return true;
  };

  for (const [branch, plan] of ranked) {
    if (branch === 'hold') continue;
    take(branch, plan);
  }

  // An operative pinned in a corridor may only have one branch open to it.
  // Rather than show one card, fill up with the next materially different plan
  // — a different target, or the same shot from somewhere else.
  for (const plan of rest) {
    if (chosen.length >= count) break;
    if (!controller._planIsValid(state, op, plan, enemies, tactics)) continue;
    take(branchOf(plan), plan);
  }

  // Last of all, and only if there is still a gap: standing still.
  for (const [branch, plan] of ranked) {
    if (branch === 'hold') take(branch, plan);
  }

  const topScore = chosen.length ? Math.max(...chosen.map((c) => c.plan.score)) : 0;

  return chosen.map(({ branch, plan, title }, i) => {
    const chips = chipsFor(state, op, plan, ap);
    // Composed last: `_compose` folds in the openings and the conditional
    // tails, and it mutates the plan it is given — so the title and the chips
    // are read off the branch's own actions first, before an opening spend can
    // put itself at the front of the list.
    const intent = controller._compose(ctx, plan, plans.length);
    return {
      id: `${op.id}:${branch}:${i}`,
      branch,
      branchLabel: BRANCH_LABEL.get(branch) ?? branch,
      title,
      detail: intent.rationale.slice(0, 4),
      chips,
      score: Number(plan.score.toFixed(2)),
      // What the AI would have done, marked rather than pre-selected: the
      // point of the mode is that the player decides.
      recommended: plan.score === topScore,
      actions: intent.actions,
      rationale: intent.rationale,
    };
  });
}
