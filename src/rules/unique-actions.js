/**
 * Unique actions: the thing an operative is *for*, when it isn't a gun.
 *
 * Nearly every transcribed profile prints one or two actions of its own — a
 * Medikit, a Signal, a Spot, a Veriscant — and until now they were carried as
 * reference text and nothing else. That left a measurable hole rather than a
 * cosmetic one: across the bundled roster 21% of all AP was going unspent, and
 * two fifths of that sat on operatives whose only printed job was an action
 * this engine could not perform. The Vox-Relay Beacon has Move 0, no weapons
 * and one action, so it had literally nothing to do with its activation.
 *
 * So a pack may attach an `action` block to any ability, and this module owns
 * what that block means. It is data, never code (#5): an ability with no
 * `action` block stays reference text and is named once at battle start as
 * unperformable, never guessed at (#7).
 *
 * The effect vocabulary is deliberately the same shape as a resource spend's
 * (`rules/resources.js`) with one addition — a unique action usually points at
 * somebody *else*, so every effect carries a target selector.
 */
import { EVENTS, logEvent, liveOperatives, warnUnsupported } from '../state.js';
import { baseDistance } from '../maps/geometry.js';
import {
  withinControlRange, enemiesInControlRange, canBeTargeted, traceSight,
} from './visibility.js';
import { profileOf, rollExpression, grantFreeAction } from './hooks.js';
import { applyDamage, isInjured } from './effects.js';
import { grantToken, hasToken, removeTokens } from './tokens.js';
import { changeResource, resourceDef } from './resources.js';
import { bestAttackOption } from './guard.js';
import { resolveShoot } from './shooting.js';
import { resolveFight } from './fighting.js';

/** How a target is reached. Anything else is reported, not guessed. */
export const TARGET_SCOPES = [
  'self',          // the operative performing the action
  'controlRange',  // within its control range
  'within',        // within `inches`, optionally `visible`
  'visible',       // visible at any distance
  'validTarget',   // a legal shooting target — visible, and not concealed in cover
];

/** Filters a `target` block may carry. All are ANDed, all optional. */
export const TARGET_CONDITIONS = [
  'side', 'keyword', 'notKeyword', 'excludeSelf', 'wounded', 'ready',
  'hasToken', 'notHasToken',
];

/** Effects a unique action's `effect` block may declare. */
export const UNIQUE_EFFECTS = [
  'healWounds', 'addApl', 'subtractApl', 'freeAction', 'extraAction',
  'weaponBoost', 'moveBonus', 'inflictDamage', 'changeOrder', 'mark',
  'gainResource', 'gainCp', 'discardToken',
];

/* ------------------------------------------------------------------ */
/* Reading the pack                                                    */
/* ------------------------------------------------------------------ */

/** The AP an ability's printed `cost` string asks for — "1AP" is 1. */
function printedCost(ability) {
  const m = /(\d+)\s*AP/i.exec(String(ability?.cost ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Every ability on this operative's profile that declares a performable
 * action, as `{ability, def, ap}`.
 */
export function uniqueActionsOf(state, op) {
  const out = [];
  for (const ability of profileOf(state, op)?.abilities || []) {
    const def = ability?.action;
    if (!def || typeof def !== 'object') continue;
    const ap = def.ap ?? printedCost(ability) ?? 1;
    out.push({ ability, def, ap: Math.max(0, Number(ap) || 0) });
  }
  return out;
}

export function findUniqueAction(state, op, abilityId) {
  return uniqueActionsOf(state, op).find((u) => u.ability.id === abilityId) || null;
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

function useCount(op, abilityId, scope) {
  return Number(op?.uniqueUses?.[scope]?.[abilityId]) || 0;
}

function recordUse(state, op, abilityId) {
  if (!op.uniqueUses) op.uniqueUses = { battle: {}, turningPoint: {} };
  for (const scope of ['battle', 'turningPoint']) {
    if (!op.uniqueUses[scope]) op.uniqueUses[scope] = {};
    op.uniqueUses[scope][abilityId] = useCount(op, abilityId, scope) + 1;
  }
}

/** Called in the Ready step: "no more than once per turning point" resets. */
export function resetUniqueTurningPointUses(op) {
  if (op.uniqueUses) op.uniqueUses.turningPoint = {};
}

/**
 * Why this operative may not perform this unique action right now.
 * @returns {string|null}
 */
export function uniqueActionBlocker(state, op, { ability, def }) {
  const limits = def.limits || {};
  const name = ability.name || ability.id;

  if (limits.perBattle !== undefined &&
      useCount(op, ability.id, 'battle') >= Number(limits.perBattle)) {
    return `${name} may only be performed ${limits.perBattle}× per battle`;
  }
  if (limits.perTurningPoint !== undefined &&
      useCount(op, ability.id, 'turningPoint') >= Number(limits.perTurningPoint)) {
    return `${name} may only be performed ${limits.perTurningPoint}× per turning point`;
  }
  if (limits.notFirstTurningPoint && state.turningPoint <= 1) {
    return `${name} cannot be performed during the first turning point`;
  }
  if (limits.notEngaged &&
      enemiesInControlRange(op, liveOperatives(state)).length > 0) {
    return `${name} cannot be performed within control range of an enemy`;
  }
  if (limits.requiresToken &&
      !hasToken(op, limits.requiresToken, op.playerId)) {
    return `${name} needs a ${limits.requiresToken} token`;
  }
  if (limits.requiresResource) {
    const key = limits.requiresResource;
    const def2 = resourceDef(state, op.playerId, key);
    if (!def2) return `${name} needs a "${key}" resource this team does not have`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

/**
 * The token an effect hangs on its target, if it hangs one.
 *
 * Worth knowing in the legality layer rather than only at resolution: every
 * one of these tokens is "if it doesn't already have one", so an operative
 * that already holds it is not a legal target and the AI should never be
 * offered it. Without this the plan builder cheerfully spends a point
 * re-Signalling somebody who is already Signalled, and the action layer
 * rejects it after the fact.
 */
function tokenKindFor(ability, effect) {
  switch (effect?.type) {
    case 'addApl': return effect.token || `apl-boost:${ability.id}`;
    case 'subtractApl': return effect.token || `apl-drain:${ability.id}`;
    case 'mark': return effect.token || `mark:${ability.id}`;
    case 'weaponBoost': return effect.token || `boost:${ability.id}`;
    case 'moveBonus': return effect.token || `stride:${ability.id}`;
    default: return null;
  }
}

/**
 * Could this candidate actually use the effect?
 *
 * Only asked where the answer is knowable up front and the alternative is a
 * wasted point: a LOAD WEAPON pointed at a comrade with nothing in its sights
 * resolves to nothing, so it is not a legal target and the AI is never shown
 * it. Everything else is the resolver's business.
 */
function canReceive(state, actor, candidate, effect) {
  if (effect?.type !== 'freeAction') return true;
  if (candidate.id === actor.id) return true;
  if (effect.action !== 'shoot' && effect.action !== 'fight') return true;
  const foes = liveOperatives(state).filter((o) => o.playerId !== candidate.playerId);
  // The order the rule is allowed to change is the order the check is made on.
  const restore = candidate.order;
  if (effect.allowOrderChange && effect.action === 'shoot') candidate.order = 'engage';
  const option = bestAttackOption(state, candidate, foes);
  candidate.order = restore;
  return Boolean(option) && option.kind === effect.action;
}

function conditionsHold(state, actor, candidate, target) {
  if (target.excludeSelf !== false && candidate.id === actor.id &&
      target.scope !== 'self') return false;
  const keywords = profileOf(state, candidate)?.keywords || [];
  if (target.keyword) {
    const wanted = Array.isArray(target.keyword) ? target.keyword : [target.keyword];
    if (!wanted.some((k) => keywords.includes(k))) return false;
  }
  if (target.notKeyword) {
    const barred = Array.isArray(target.notKeyword) ? target.notKeyword : [target.notKeyword];
    if (barred.some((k) => keywords.includes(k))) return false;
  }
  if (target.wounded === true && candidate.woundsRemaining >= candidate.wounds) return false;
  if (target.wounded === false && candidate.woundsRemaining < candidate.wounds) return false;
  if (target.ready === true && !candidate.ready) return false;
  if (target.hasToken && !hasToken(candidate, target.hasToken, actor.playerId)) return false;
  if (target.notHasToken && hasToken(candidate, target.notHasToken, actor.playerId)) return false;
  return true;
}

/**
 * "Visible to this operative" is a weaker test than "a valid target for this
 * operative", and the printed actions use both deliberately.
 *
 * Visibility is a line-of-sight question. Being a valid target additionally
 * fails against a concealed operative in cover — which is the thing a SPOT is
 * for. Conflating them made the whole mark family unusable: a Spotter could
 * only mark an enemy its own team could already shoot at, and so never marked
 * anything worth marking.
 */
function inScope(state, actor, candidate, target) {
  const terrain = state.map.terrain || [];
  const others = liveOperatives(state).filter(
    (o) => o.id !== actor.id && o.id !== candidate.id);
  switch (target.scope) {
    case 'self':
      return candidate.id === actor.id;
    case 'controlRange':
      return withinControlRange(actor, candidate);
    case 'within': {
      const reach = Number(target.inches) || 0;
      if (baseDistance(actor, candidate) > reach + 1e-9) return false;
      if (!target.visible) return true;
      return traceSight(actor, candidate, terrain, others).visible;
    }
    case 'visible':
      return traceSight(actor, candidate, terrain, others).visible;
    case 'validTarget':
      return canBeTargeted(actor, candidate, terrain, others).ok;
    default:
      return false;
  }
}

/**
 * Who this unique action could be performed on, cheapest filter first.
 *
 * An action with no `target` block acts on the operative performing it, which
 * is what BOOST and CONSPIRE and INTO SHADOW all do.
 */
export function uniqueActionTargets(state, op, { ability, def }, { from = null } = {}) {
  const target = def.target || { scope: 'self' };
  if (!TARGET_SCOPES.includes(target.scope || 'self')) {
    warnUnsupported(state, `unique-target:${target.scope}`,
      `${ability.name || ability.id} selects targets by an unknown scope "${target.scope}"`);
    return [];
  }
  for (const key of Object.keys(target)) {
    if (['scope', 'inches', 'visible'].includes(key)) continue;
    if (TARGET_CONDITIONS.includes(key)) continue;
    warnUnsupported(state, `unique-target-condition:${key}`,
      `${ability.name || ability.id} uses an unknown target condition "${key}"`);
    return [];
  }

  // A mark or a buff that is already in place cannot be placed again, and a
  // self-targeted one is no different — BOOST on a Gheistskull that already
  // has it is the same wasted point as a second Signal.
  const held = tokenKindFor(ability, def.effect);
  const free = (candidate) =>
    !held || !hasToken(candidate, held, op.playerId);

  if ((target.scope || 'self') === 'self') return free(op) ? [op] : [];

  // `from` asks the question from somewhere the operative is not standing yet:
  // "who could I Medikit if I walked over there". Only the geometry moves —
  // the operative's own state, and everyone else's, is unchanged.
  const actor = from ? { ...op, x: from.x, y: from.y } : op;
  const side = target.side || 'friendly';
  return liveOperatives(state).filter((candidate) => {
    if (side === 'friendly' && candidate.playerId !== op.playerId) return false;
    if (side === 'enemy' && candidate.playerId === op.playerId) return false;
    if (!free(candidate)) return false;
    if (!conditionsHold(state, actor, candidate, target)) return false;
    if (!inScope(state, actor, candidate, target)) return false;
    return canReceive(state, op, candidate, def.effect);
  });
}

/**
 * The unique actions this operative could perform right now, each with the
 * targets it could be performed on. The AI picks; the action layer re-checks.
 */
export function availableUniqueActions(state, op, { from = null } = {}) {
  const out = [];
  for (const entry of uniqueActionsOf(state, op)) {
    if (uniqueActionBlocker(state, op, entry)) continue;
    const targets = uniqueActionTargets(state, op, entry, { from });
    // An action with nobody to point it at is not on the menu — a Medikit with
    // no wounded friend in reach is exactly the AP the AI should keep.
    if (!targets.length) continue;
    out.push({ ...entry, targets });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Perform one unique action. `rng` is the battle stream: a Medikit rolls dice.
 * @returns {{ok:boolean, reason?:string, detail?:string}}
 */
export function resolveUniqueAction(state, rng, op, { abilityId, targetId }) {
  const entry = findUniqueAction(state, op, abilityId);
  if (!entry) return { ok: false, reason: `unknown unique action "${abilityId}"` };

  const blocked = uniqueActionBlocker(state, op, entry);
  if (blocked) return { ok: false, reason: blocked };

  const candidates = uniqueActionTargets(state, op, entry);
  const target = targetId
    ? candidates.find((c) => c.id === targetId)
    : (entry.def.target?.scope ? candidates[0] : op);
  if (!target) {
    return { ok: false, reason: `${entry.ability.name || abilityId} has no legal target` };
  }

  const detail = applyUniqueEffect(state, rng, op, target, entry);
  if (!detail) {
    return { ok: false, reason: `${entry.ability.name || abilityId} had no effect` };
  }

  recordUse(state, op, abilityId);
  logEvent(state, EVENTS.RULE_APPLIED, {
    ruleId: `unique-action:${op.profileId}:${abilityId}`,
    rule: entry.ability.name || abilityId,
    operativeId: op.id, operativeName: op.name, playerId: op.playerId,
    targetId: target.id === op.id ? null : target.id,
    detail,
  });
  return { ok: true, detail, targetId: target.id };
}

/**
 * @returns {string|null} what happened, for the log — null if nothing did.
 */
function applyUniqueEffect(state, rng, op, target, { ability, def }) {
  const effect = def.effect || {};
  const rule = ability.name || ability.id;
  const who = target.id === op.id ? 'itself' : target.name;

  switch (effect.type) {
    case 'healWounds': {
      const lost = target.wounds - target.woundsRemaining;
      if (lost <= 0) return null;
      const rolled = rollExpression(rng, effect.dice || '2D3');
      const healed = Math.min(lost, rolled);
      if (healed <= 0) return null;
      target.woundsRemaining += healed;
      return `${who} regains ${healed} lost wound(s) (rolled ${rolled})`;
    }

    case 'addApl': {
      const amount = Number(effect.amount) || 1;
      // "until the end of that operative's next activation" is a token, not a
      // flag: the operative may not be the one activating, and the extra AP
      // has to survive until it is.
      //
      // The token also answers "that isn't currently benefitting from the
      // effects of this action", which WHIP INTO FRENZY prints and which is
      // `grantToken`'s default: it refuses a second one, and refusing the
      // grant refuses the action rather than charging AP for nothing.
      const landed = grantToken(state, target, {
        kind: effect.token || `apl-boost:${ability.id}`,
        label: rule,
        whileHeld: { aplDelta: amount },
        expiry: effect.expiry || { endOfNextActivation: true },
      }, { owner: op.playerId, rule });
      if (!landed) return null;
      // …unless it is the operative acting right now, in which case the point
      // it bought is spendable immediately, exactly as Dark Animus is.
      if (target.id === op.id && (op.apRemaining > 0 || op.usedThisActivation.length)) {
        op.apRemaining += amount;
      }
      return `+${amount} APL for ${who} until the end of its next activation`;
    }

    case 'subtractApl': {
      const amount = Number(effect.amount) || 1;
      const landed = grantToken(state, target, {
        kind: effect.token || `apl-drain:${ability.id}`,
        label: rule,
        whileHeld: { aplDelta: -amount },
        expiry: effect.expiry || { endOfNextActivation: true },
      }, { owner: op.playerId, rule });
      if (!landed) return null;
      return `-${amount} APL for ${who} until the end of its next activation`;
    }

    case 'mark': {
      // SPOT, VERISCANT, APPREHEND: the mark sits on the enemy and improves
      // what this team's shots do to it. The weapon rules it hands out are the
      // published universal ones, so nothing new has to resolve them —
      // "cannot be obscured" is Seek, "cannot retain cover" is Saturate.
      const landed = grantToken(state, target, {
        kind: effect.token || `mark:${ability.id}`,
        label: rule,
        unique: effect.unique !== false,
        whileHeld: {
          incomingWeaponRules: effect.weaponRules || ['seek'],
          incomingKeyword: effect.keyword || null,
          incomingWeaponType: effect.weaponType || null,
        },
        expiry: effect.expiry || { endOfTurningPoint: true },
      }, { owner: op.playerId, rule });
      if (!landed) return null;
      const rules = (effect.weaponRules || ['seek']).join(', ');
      return `marks ${who} — friendly attacks against it gain ${rules}`;
    }

    // The three cases below all turn on one thing, so it is worth stating
    // once: an allowance parked on `actionBoosts`, `spendExtraActions` or
    // `freeActions` is wiped at the start of every activation (see
    // `resetSpendLimits` and `fireActivationStart`). That is right for an
    // operative buffing itself mid-activation and silently useless for one
    // buffing a comrade who has not activated yet. So a gift to somebody else
    // either lands *now* or rides a token, which is the subsystem built to
    // outlive an activation — and anything neither shape can carry is
    // reported rather than quietly dropped (#7).

    case 'freeAction': {
      if (target.id === op.id) {
        grantFreeAction(op, effect.action, {
          unrestricted: effect.unrestricted === true, rule,
        });
        return `gains a free ${effect.action}`;
      }
      // "That friendly operative can IMMEDIATELY perform a free Shoot action"
      // — a LOAD WEAPON, an ENFORCE. The friend is not activating and has no
      // AI turn of its own to ask, so the engine picks the best shot it has
      // the same way a Guard interrupt does (see rules/guard.js).
      if (effect.action === 'shoot' || effect.action === 'fight') {
        return fireImmediately(state, op, target, effect, rule);
      }
      warnUnsupported(state, `unique-effect:freeAction:${effect.action}`,
        `${rule} grants another operative a free ${effect.action}, which this ` +
        'engine can only resolve immediately for Shoot and Fight');
      return null;
    }

    case 'extraAction': {
      if (target.id !== op.id) {
        warnUnsupported(state, 'unique-effect:extraAction:other',
          `${rule} grants another operative an extra ${effect.action}, which ` +
          'cannot be held until that operative activates');
        return null;
      }
      if (!op.spendExtraActions) op.spendExtraActions = {};
      const count = Number(effect.count) || 1;
      op.spendExtraActions[effect.action] =
        (op.spendExtraActions[effect.action] || 0) + count;
      if (effect.free) grantFreeAction(op, effect.action, { rule });
      return `may perform ${effect.action} again this activation`;
    }

    case 'weaponBoost': {
      const parts = [];
      if (effect.atkBonus) parts.push(`+${effect.atkBonus} Atk`);
      if (effect.rules?.length) parts.push(effect.rules.join(', '));
      const label = parts.join(' and ') || 'a better profile';

      if (target.id === op.id) {
        if (!op.actionBoosts) op.actionBoosts = [];
        op.actionBoosts.push({
          kind: 'weapon',
          actions: effect.appliesTo || ['shoot'],
          weaponType: effect.weaponType || null,
          atkBonus: Number(effect.atkBonus) || 0,
          damageNormal: Number(effect.damageNormal) || 0,
          damageCritical: Number(effect.damageCritical) || 0,
          rules: effect.rules || [],
          rule,
        });
        return `${label} for its next ${(effect.appliesTo || ['shoot']).join('/')}`;
      }
      // A token can carry weapon *rules* to a comrade, but not extra attack
      // dice or better damage — `whileHeld` has no vocabulary for those.
      if (!effect.rules?.length || effect.atkBonus ||
          effect.damageNormal || effect.damageCritical) {
        warnUnsupported(state, 'unique-effect:weaponBoost:other',
          `${rule} improves another operative's profile by more than a weapon ` +
          'rule, which cannot be held until that operative activates');
        return null;
      }
      const landed = grantToken(state, target, {
        kind: effect.token || `boost:${ability.id}`,
        label: rule,
        whileHeld: { weaponRules: effect.rules, weaponType: effect.weaponType || null },
        expiry: effect.expiry || { endOfNextActivation: true },
      }, { owner: op.playerId, rule });
      if (!landed) return null;
      return `${who}'s weapons gain ${effect.rules.join(', ')}`;
    }

    case 'moveBonus': {
      const inches = Number(effect.inches) || 2;
      if (target.id === op.id) {
        if (!op.actionBoosts) op.actionBoosts = [];
        op.actionBoosts.push({
          kind: 'move',
          actions: effect.appliesTo || ['charge'],
          inches, rule,
        });
        return `+${inches}" for its next ${(effect.appliesTo || ['charge']).join('/')}`;
      }
      // On somebody else it has to survive until they move, so it is a token
      // on the Move stat rather than an allowance on the action.
      const landed = grantToken(state, target, {
        kind: effect.token || `stride:${ability.id}`,
        label: rule,
        whileHeld: { moveDelta: inches },
        expiry: effect.expiry || { endOfNextActivation: true },
      }, { owner: op.playerId, rule });
      if (!landed) return null;
      return `+${inches}" Move for ${who} until the end of its next activation`;
    }

    case 'inflictDamage': {
      const amount = rollExpression(rng, effect.dice || 'D3');
      if (amount <= 0) return null;
      applyDamage(state, target.id, amount, {
        kind: 'unique-action', attackerId: op.id, rule,
      });
      return `inflicts ${amount} damage on ${who}`;
    }

    case 'changeOrder': {
      const to = target.order === 'engage' ? 'conceal' : 'engage';
      target.order = to;
      logEvent(state, EVENTS.ORDER_SELECTED, {
        operativeId: target.id, operativeName: target.name,
        playerId: target.playerId, order: to,
      });
      return `${who} changes order to ${to}`;
    }

    case 'gainResource': {
      const key = effect.resource;
      if (!resourceDef(state, op.playerId, key)) return null;
      const amount = Number(effect.amount) || 1;
      const before = target.resources?.[key] ?? state.players[op.playerId].resources?.[key] ?? 0;
      changeResource(state, target, key, amount, { rule, detail: rule });
      const after = target.resources?.[key] ?? state.players[op.playerId].resources?.[key] ?? 0;
      if (after === before) return null;
      return `gains ${after - before} ${key}`;
    }

    case 'gainCp': {
      const amount = Number(effect.amount) || 1;
      state.players[op.playerId].cp += amount;
      logEvent(state, EVENTS.CP_GAINED, {
        playerId: op.playerId, amount, total: state.players[op.playerId].cp, rule,
      });
      return `gains ${amount}CP`;
    }

    case 'discardToken': {
      const gone = removeTokens(target, effect.token, effect.owner === 'enemy' ? null : op.playerId);
      if (!gone) return null;
      return `removes ${gone} ${effect.token} token(s) from ${who}`;
    }

    default:
      warnUnsupported(state, `unique-effect:${effect.type}`,
        `${rule} uses an unimplemented effect "${effect.type}"`);
      return null;
  }
}

/**
 * Resolve a free attack somebody else's action just handed out.
 *
 * `allowOrderChange` is printed wording, not a liberty: LOAD WEAPON says "and
 * you can change its order to do so", so a concealed friend is flipped to
 * Engage rather than being handed a shot it cannot legally take.
 *
 * @returns {string|null} what happened, for the log.
 */
function fireImmediately(state, actor, target, effect, rule) {
  const foes = liveOperatives(state).filter((o) => o.playerId !== target.playerId);
  if (!foes.length) return null;

  const restore = target.order;
  if (effect.allowOrderChange && effect.action === 'shoot' && target.order !== 'engage') {
    target.order = 'engage';
  }
  const option = bestAttackOption(state, target, foes);
  if (!option || option.kind !== effect.action) {
    target.order = restore;
    return null;
  }
  const victim = state.operatives[option.targetId];
  const result = option.kind === 'fight'
    ? resolveFight(state, target.id, option.targetId, option.weaponId)
    : resolveShoot(state, target.id, option.targetId, option.weaponId);
  if (!result.ok) {
    target.order = restore;
    return null;
  }
  const note = target.order !== restore ? ', changing order to do so' : '';
  return `${target.name} immediately ${option.kind === 'fight' ? 'fights' : 'shoots'} ` +
    `${victim.name}${note}`;
}

/* ------------------------------------------------------------------ */
/* Honesty                                                             */
/* ------------------------------------------------------------------ */

/**
 * Name every printed unique action this engine still cannot perform, once per
 * battle, next to the team's support badge (#7).
 *
 * An ability that costs AP and declares no `action` block is a specific,
 * fillable gap — somebody can sit down and author it — so it is named rather
 * than lumped into a count.
 */
export function reportUnsupportedUniqueActions(state) {
  for (const playerId of ['p1', 'p2']) {
    const pack = state.teamPacks?.[playerId];
    if (!pack) continue;
    const fielded = new Set(
      liveOperatives(state, playerId).map((o) => o.profileId));
    const missing = [];
    for (const profile of pack.operatives || []) {
      if (!fielded.has(profile.id)) continue;
      for (const ability of profile.abilities || []) {
        if (ability.action) continue;
        if (printedCost(ability) === null) continue; // not an action at all
        missing.push(`${profile.name}: ${ability.name || ability.id}`);
      }
    }
    if (!missing.length) continue;
    warnUnsupported(state, `unique-actions:${pack.id}`,
      `${pack.displayName || pack.id}: ${missing.length} printed unique action(s) ` +
      `declare no effect and cannot be performed (${missing.join('; ')})`);
  }
}

/**
 * What a pack's `action` blocks declare, for the compatibility badge and the
 * validator. Returns `{declared, performable}` counts.
 */
export function uniqueActionSupport(pack) {
  let declared = 0;
  let performable = 0;
  for (const profile of pack?.operatives || []) {
    for (const ability of profile.abilities || []) {
      if (printedCost(ability) === null) continue;
      declared++;
      if (ability.action) performable++;
    }
  }
  return { declared, performable };
}
