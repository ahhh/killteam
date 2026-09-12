/**
 * Guard: the universal action that gives leftover AP somewhere to go.
 *
 * The transcribed packs reference it constantly — "two Shoot actions
 * (excluding Guard)", "you cannot interrupt each enemy operative's activation
 * more than once per activation (including Guard)", "follow the rules for a
 * point-blank shot from the Guard action" — so the edition's universal action
 * list has it, and a dozen printed rules in `data/teams/` hang off it. It is
 * also the only sink most operatives have for a spare point: across the
 * bundled roster three fifths of all wasted AP sat on operatives with no
 * printed action of their own, which is to say ordinary troopers who had
 * already moved and already shot.
 *
 * What this engine implements, stated plainly because it is an approximation
 * of the printed action rather than a transcription of it:
 *
 *  - 1 AP, once per activation, Engage order, and only for an operative that
 *    has some weapon it could actually use. Guarding with nothing to guard
 *    with is exactly the wasted AP this is meant to remove.
 *  - The operative gains a Guard token, held until its next activation.
 *  - While it holds one, it may interrupt an enemy activation: after that
 *    enemy resolves an action, the guard discards the token to perform a free
 *    Shoot at it — or a Fight, if the enemy has walked into its face.
 *  - One interrupt per enemy activation, across the whole guarding team, which
 *    is the published limit.
 *
 * The choice of whether to take the interrupt is the engine's, not the AI's:
 * there is no action layer inside somebody else's activation to ask, the same
 * position `resources.js` is in for a mid-roll re-roll. The policy is one
 * line and stated below.
 */
import { EVENTS, logEvent, liveOperatives } from '../state.js';
import { withinControlRange, enemiesInControlRange } from './visibility.js';
import { canShoot, resolveShoot, usableRangedWeapons, meleeWeapons } from './shooting.js';
import { canFight, resolveFight } from './fighting.js';

export const GUARD_TOKEN = 'guard';

/** Actions that bring an enemy into a guard's field of fire. */
const INTERRUPT_TRIGGERS = new Set(['reposition', 'dash', 'charge', 'fall_back']);

/**
 * Why this operative may not Guard right now.
 * @returns {string|null}
 */
export function guardBlocker(state, op) {
  if (op.order !== 'engage') return 'Guard requires Engage order';
  if (hasGuard(op)) return 'already on Guard';
  const engaged = enemiesInControlRange(op, liveOperatives(state)).length > 0;
  // Engaged, a guard can only ever swing, so it needs something to swing with.
  if (engaged) {
    return meleeWeapons(state, op).length ? null : 'nothing to Guard with';
  }
  return usableRangedWeapons(state, op).length ? null : 'nothing to Guard with';
}

export function hasGuard(op) {
  return (op?.tokens || []).some((t) => t.kind === GUARD_TOKEN);
}

/** Perform the Guard action: hold the shot for somebody else's turn. */
export function resolveGuard(state, op) {
  const blocked = guardBlocker(state, op);
  if (blocked) return { ok: false, reason: blocked };
  if (!op.tokens) op.tokens = [];
  op.tokens.push({
    kind: GUARD_TOKEN,
    label: 'Guard',
    rule: 'Guard',
    owner: op.playerId,
    onActivation: null,
    whileHeld: null,
    grantedOnActivation: op.activationCount ?? 0,
    // Held until this operative activates again, which is when it would be
    // choosing a new order anyway.
    expiry: { startOfNextActivation: true },
  });
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: 'universal-action:guard',
    rule: 'Guard',
    operativeId: op.id, operativeName: op.name, playerId: op.playerId,
    detail: 'holds its shot, ready to interrupt an enemy activation',
  });
  return { ok: true, guard: true };
}

/**
 * The window: an enemy operative has just finished an action during its own
 * activation. Offer it to whichever guard has the best answer.
 *
 * Policy — the guard that takes the shot is the one with the highest expected
 * damage, and it only fires when the shot can actually land. A guard whose
 * only option is a hopeless shot keeps its token for the next enemy to walk
 * past, which is what a player would do.
 *
 * @returns {object|null} what the interrupt did, for the log.
 */
export function tryGuardInterrupt(state, activeOp, actionType) {
  if (!INTERRUPT_TRIGGERS.has(actionType)) return null;
  if (!activeOp?.alive) return null;
  // One interrupt per enemy activation, for the whole guarding team.
  const key = `${activeOp.id}:${activeOp.activationCount ?? 0}`;
  if (!state.guardInterrupts) state.guardInterrupts = {};
  if (state.guardInterrupts[key]) return null;

  const guards = liveOperatives(state)
    .filter((o) => o.playerId !== activeOp.playerId && hasGuard(o));
  if (!guards.length) return null;

  let best = null;
  for (const guard of guards) {
    const option = bestInterruptFor(state, guard, activeOp);
    if (!option) continue;
    if (!best || option.value > best.value ||
        (option.value === best.value && option.guard.id < best.guard.id)) {
      best = option;
    }
  }
  if (!best) return null;

  state.guardInterrupts[key] = true;
  discardGuard(best.guard);
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: 'universal-action:guard',
    rule: 'Guard',
    operativeId: best.guard.id, operativeName: best.guard.name,
    playerId: best.guard.playerId,
    targetId: activeOp.id,
    detail: `interrupts ${activeOp.name} after its ${actionType.replace('_', ' ')}`,
  });

  const result = best.kind === 'fight'
    ? resolveFight(state, best.guard.id, best.targetId, best.weaponId)
    : resolveShoot(state, best.guard.id, best.targetId, best.weaponId);
  return { ok: result.ok, guardId: best.guard.id, kind: best.kind, result };
}

function bestInterruptFor(state, guard, activeOp) {
  const option = bestAttackOption(state, guard, [activeOp]);
  return option ? { ...option, guard } : null;
}

/**
 * The best attack this operative could make on one of `targets` right now, or
 * null — `{kind, weaponId, targetId, value}`.
 *
 * `value` is deliberately crude, Atk dice times damage, because the choice is
 * between one operative's own weapons rather than between plans. The real dice
 * are rolled by the ordinary shooting and fighting code.
 *
 * Shared with `rules/unique-actions.js`, where a printed action that reads
 * "that friendly operative can immediately perform a free Shoot action" has
 * the same question to answer and no AI turn in which to ask it.
 */
export function bestAttackOption(state, op, targets) {
  const engaged = targets.filter((t) => t.alive && withinControlRange(op, t));
  if (engaged.length) {
    const weapon = meleeWeapons(state, op)[0];
    if (!weapon) return null;
    let best = null;
    for (const target of engaged) {
      if (!canFight(state, op.id, target.id).ok) continue;
      const value = weapon.atk * (weapon.damage?.normal || 0);
      if (!best || value > best.value) {
        best = { kind: 'fight', weaponId: weapon.id, targetId: target.id, value };
      }
    }
    return best;
  }
  let best = null;
  for (const weapon of usableRangedWeapons(state, op)) {
    for (const target of targets) {
      if (!target.alive) continue;
      if (!canShoot(state, op.id, target.id, weapon).ok) continue;
      const value = weapon.atk * (weapon.damage?.normal || 0);
      if (!best || value > best.value) {
        best = { kind: 'shoot', weaponId: weapon.id, targetId: target.id, value };
      }
    }
  }
  return best;
}

function discardGuard(op) {
  op.tokens = (op.tokens || []).filter((t) => t.kind !== GUARD_TOKEN);
}
