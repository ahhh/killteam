/**
 * Damage application and operative status effects.
 * Everything that can remove an operative from play funnels through here.
 */
import { EVENTS, logEvent } from '../state.js';
import { applyDamageHooks } from './hooks.js';
import { clearTokens, tokenHitPenalty, tokenHitPenaltyIsCapped, tokenMoveDelta } from './tokens.js';

export function applyDamage(state, operativeId, amount, source = {}) {
  const op = state.operatives[operativeId];
  if (!op || !op.alive || amount <= 0) return { incapacitated: false, dealt: 0 };

  // Faction rules that blunt incoming damage bite here, before any is lost.
  amount = applyDamageHooks(state, op, amount, source);
  if (amount <= 0) return { incapacitated: false, dealt: 0 };

  const dealt = Math.min(amount, op.woundsRemaining);
  op.woundsRemaining -= amount;

  logEvent(state, EVENTS.DAMAGE_APPLIED, {
    operativeId,
    operativeName: op.name,
    playerId: op.playerId,
    amount,
    woundsRemaining: Math.max(0, op.woundsRemaining),
    source,
  });

  if (op.woundsRemaining <= 0) {
    op.woundsRemaining = 0;
    op.alive = false;
    op.ready = false;
    clearTokens(op); // an incapacitated operative takes its tokens with it
    logEvent(state, EVENTS.OPERATIVE_INCAPACITATED, {
      operativeId,
      operativeName: op.name,
      playerId: op.playerId,
      source,
    });
    return { incapacitated: true, dealt };
  }
  return { incapacitated: false, dealt };
}

/** An operative on half wounds or fewer is Injured: -1 APL, worse hit rolls. */
export function isInjured(op) {
  return op.alive && op.woundsRemaining <= Math.floor(op.wounds / 2);
}

export function effectiveApl(op) {
  return Math.max(1, op.apl
    - (isInjured(op) ? 1 : 0)
    - (isStunned(op) ? 1 : 0)
    - (op.aplPenaltyThisActivation || 0));
}

/**
 * Stun x: the target loses 1 APL until the end of its NEXT activation.
 *
 * The flag is cleared by the activation that started with it set, so an
 * operative stunned during its own activation still pays for it next time.
 */
export function isStunned(op) {
  return op?.stunned === true;
}

export function applyStun(state, op, source = {}) {
  if (!op || !op.alive || op.stunned) return false;
  op.stunned = true;
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: 'weapon-rule:stun',
    rule: 'Stun',
    operativeId: op.id,
    operativeName: op.name,
    playerId: op.playerId,
    detail: 'is stunned: -1 APL until the end of its next activation',
    source,
  });
  return true;
}

/**
 * How much worse this operative's hit rolls are, in pips of Hit stat.
 *
 * Being Injured costs 1. Mindburn and Humbling Cruelty each cost 1 too, but
 * both print "this isn't cumulative with being injured" — so a burned, injured
 * operative is still only 1 worse, and the two combine with `max`, not `+`.
 */
export function hitModifierFor(op) {
  const injured = isInjured(op) ? 1 : 0;
  const fromTokens = tokenHitPenalty(op);
  if (!fromTokens) return injured;
  return tokenHitPenaltyIsCapped(op)
    ? Math.max(injured, fromTokens)
    : injured + fromTokens;
}

/**
 * The operative's Move stat as the board should read it. Humbling Cruelty
 * takes 2" off it for as long as its token is held.
 */
export function effectiveMove(op) {
  return Math.max(0, op.move + tokenMoveDelta(op));
}

export function addStatus(op, status) {
  if (!op.statuses.includes(status)) op.statuses.push(status);
}

export function removeStatus(op, status) {
  op.statuses = op.statuses.filter((s) => s !== status);
}

export function hasStatus(op, status) {
  return op.statuses.includes(status);
}
