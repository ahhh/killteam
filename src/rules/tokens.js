/**
 * Tokens: the "something is stuck to this operative" subsystem.
 *
 * A whole family of team-specific weapon rules — Poison, Blaze, Terrorchem,
 * Neutron Fragment, Mindburn, Humbling Cruelty — share one shape. The weapon
 * hangs a token on whatever it hurt, and the token then does something to that
 * operative later: burns it when it activates, or worsens its stats while it
 * is held. Nothing in the core rules did that before, so it lives here rather
 * than being smeared across shooting, fighting and the phase machine.
 *
 * A token is plain data on `op.tokens`, carrying its own behaviour, so a
 * serialized state replays without consulting the pack that granted it:
 *
 *   { kind, label, rule, owner, onActivation, whileHeld, expiry }
 *
 * Whose token it is matters: Toxic reads "an operative that had one of *your*
 * Poison tokens", and two players can both be poisoning the same operative.
 */
import { EVENTS, logEvent } from '../state.js';
import { rollExpression } from './hooks.js';

/** Every token an operative is carrying, oldest first. */
export function tokensOf(op) {
  return op?.tokens || [];
}

/**
 * @param {string|null} owner restrict to one player's tokens, or null for any.
 */
export function hasToken(op, kind, owner = null) {
  return tokensOf(op).some((t) => t.kind === kind && (owner === null || t.owner === owner));
}

export function countTokens(op, kind, owner = null) {
  return tokensOf(op).filter((t) => t.kind === kind && (owner === null || t.owner === owner)).length;
}

/** A snapshot for rules that ask what an operative held "at the start of that action". */
export function snapshotTokens(operatives) {
  const snap = {};
  for (const op of operatives) {
    snap[op.id] = tokensOf(op).map((t) => `${t.owner}:${t.kind}`);
  }
  return snap;
}

export function heldAtSnapshot(snapshot, op, kind, owner) {
  return (snapshot?.[op.id] || []).includes(`${owner}:${kind}`);
}

/**
 * Hang a token on an operative.
 *
 * @param {object} spec the `token` half of an `inflictToken` effect:
 *        {kind, label, stacks, unique, onActivation, whileHeld, expiry}
 * @returns {boolean} whether a token was actually added.
 */
export function grantToken(state, op, spec, { owner, rule, source = {} } = {}) {
  if (!op?.alive || !spec?.kind) return false;

  // "if it doesn't already have one" — the default. `stacks` opts out, which
  // Neutron Fragment needs because its damage is per token held.
  if (!spec.stacks && hasToken(op, spec.kind, owner)) return false;

  // Mindburn holds "until a friendly operative uses this weapon again": one
  // token of this kind on the board per player, so the old one comes off.
  if (spec.unique) {
    for (const other of Object.values(state.operatives)) {
      if (other.id === op.id) removeTokens(other, spec.kind, owner);
      else if (removeTokens(other, spec.kind, owner)) {
        logEvent(state, EVENTS.RULE_APPLIED, {
          ruleId: `weapon-rule:${rule}`,
          rule: spec.label || spec.kind,
          operativeId: other.id, operativeName: other.name, playerId: other.playerId,
          detail: `loses its ${spec.label || spec.kind} token — the weapon has been used again`,
        });
      }
    }
  }

  if (!op.tokens) op.tokens = [];
  op.tokens.push({
    kind: spec.kind,
    label: spec.label || spec.kind,
    rule: rule || spec.kind,
    owner,
    onActivation: spec.onActivation || null,
    whileHeld: spec.whileHeld || null,
    expiry: spec.expiry || null,
  });

  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: `weapon-rule:${rule}`,
    rule: spec.label || spec.kind,
    operativeId: op.id, operativeName: op.name, playerId: op.playerId,
    detail: `gains a ${spec.label || spec.kind} token`,
    source,
  });
  return true;
}

/** Remove every token of `kind` (optionally only one player's). Returns how many went. */
export function removeTokens(op, kind, owner = null) {
  const before = tokensOf(op).length;
  if (!before) return 0;
  op.tokens = op.tokens.filter(
    (t) => !(t.kind === kind && (owner === null || t.owner === owner))
  );
  return before - op.tokens.length;
}

/* ------------------------------------------------------------------ */
/* Stat effects while held                                             */
/* ------------------------------------------------------------------ */

/**
 * How much worse this operative's Hit stat is because of tokens.
 *
 * Both printed rules that do this say "this isn't cumulative with being
 * injured", so the caller combines with `Math.max` rather than adding —
 * see `hitModifierFor` in effects.js.
 */
export function tokenHitPenalty(op) {
  let worst = 0;
  for (const t of tokensOf(op)) {
    const n = Number(t.whileHeld?.hitPenalty) || 0;
    if (n > worst) worst = n;
  }
  return worst;
}

/** True when the Hit penalty above is the "not cumulative with Injured" kind. */
export function tokenHitPenaltyIsCapped(op) {
  return tokensOf(op).some(
    (t) => (Number(t.whileHeld?.hitPenalty) || 0) > 0 && t.whileHeld?.notCumulativeWithInjured
  );
}

/** Inches added to (or, being negative, taken off) the Move stat. */
export function tokenMoveDelta(op) {
  let delta = 0;
  for (const t of tokensOf(op)) delta += Number(t.whileHeld?.moveDelta) || 0;
  return delta;
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * "Whenever an operative that has one of your X tokens is activated…"
 *
 * Called at the top of an activation, before the operative spends any AP.
 * Damage is rolled per token so Neutron Fragment's stacking reads right, and
 * a token that offers its holder a way out resolves that choice here too.
 *
 * @returns {Array} what each token did, for the log.
 */
export function resolveActivationTokens(state, rng, op, applyDamage) {
  const results = [];
  if (!op?.alive) return results;

  // Snapshot first: a token removed mid-loop must not disturb the iteration,
  // and a token that kills its holder stops the rest.
  for (const token of [...tokensOf(op)]) {
    if (!op.alive) break;
    if (!token.onActivation) continue;
    if (!tokensOf(op).includes(token)) continue; // already removed by an earlier one

    const spec = token.onActivation;
    const amount = spec.damage ? rollExpression(rng, spec.damage) : 0;
    if (amount > 0) {
      logEvent(state, EVENTS.RULE_APPLIED, {
        ruleId: `weapon-rule:${token.rule}`,
        rule: token.label,
        operativeId: op.id, operativeName: op.name, playerId: op.playerId,
        detail: `${token.label} inflicts ${amount} damage on activation`,
      });
      applyDamage(state, op.id, amount, { kind: 'token', token: token.kind, rule: token.rule });
    }
    results.push({ token: token.kind, damage: amount });

    if (!op.alive) break;
    if (spec.removal) resolveRemovalChoice(state, rng, op, token, spec.removal, results);
  }

  return results;
}

/**
 * Blaze's escape clause: after the burn, the holder's controlling player picks
 * either a D6 (3+ sheds the token) or −1 APL for this activation to shed it
 * for certain.
 *
 * The engine always takes the free roll. Spending APL is sometimes the better
 * play — an operative one bad roll from death would rather pay — but modelling
 * that is a judgement call the AI layer does not make yet, so the simple,
 * deterministic branch is the one taken and is documented as such.
 */
function resolveRemovalChoice(state, rng, op, token, removal, results) {
  if (removal.d6) {
    const rolled = rng.d6();
    const removed = rolled >= removal.d6;
    if (removed) removeOne(op, token);
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: `weapon-rule:${token.rule}`,
      rule: token.label,
      operativeId: op.id, operativeName: op.name, playerId: op.playerId,
      detail: removed
        ? `shakes off the ${token.label} token (rolled ${rolled}, needed ${removal.d6}+)`
        : `fails to shake off the ${token.label} token (rolled ${rolled}, needed ${removal.d6}+)`,
    });
    results.push({ token: token.kind, removalRoll: rolled, removed });
  }
}

function removeOne(op, token) {
  const i = op.tokens.indexOf(token);
  if (i >= 0) op.tokens.splice(i, 1);
}

/**
 * Mark tokens that expire "at the end of its next activation", so the
 * activation that is starting is the one that sheds them. Mirrors how Stun
 * is handled, and for the same reason: an operative that gains the token
 * during its own activation still carries it into the next one.
 */
export function markTokenExpiryAtActivationStart(op) {
  for (const t of tokensOf(op)) {
    if (t.expiry?.endOfNextActivation) t.expiresThisActivation = true;
  }
}

export function expireTokensAtActivationEnd(state, op) {
  const expiring = tokensOf(op).filter((t) => t.expiresThisActivation);
  if (!expiring.length) return;
  op.tokens = op.tokens.filter((t) => !t.expiresThisActivation);
  for (const t of expiring) {
    logEvent(state, EVENTS.RULE_APPLIED, {
      ruleId: `weapon-rule:${t.rule}`,
      rule: t.label,
      operativeId: op.id, operativeName: op.name, playerId: op.playerId,
      detail: `${t.label} token expires`,
    });
  }
}

/** An incapacitated operative takes its tokens with it. */
export function clearTokens(op) {
  op.tokens = [];
}
