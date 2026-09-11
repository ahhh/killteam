/**
 * Command Point doctrine: what a team means to *do* with its CP.
 *
 * CP is the one resource every team has and no team earns differently: 1 per
 * turning point, 4 or so across a battle. What separates teams is not how much
 * they get but when they are willing to let go of it, and on what. Before this
 * file the AI answered that question the same way for everybody — price every
 * strategic ploy in the strategy phase, buy anything over the bar, and never
 * think about CP again — which made the economy a rounding error and made
 * every team's CP play identical.
 *
 * A DOCTRINE is the answer to four questions, asked fresh each turning point:
 *
 *   1. How picky am I about strategic ploys right now?     (`strategicBar`)
 *   2. How much do I trust the other two uses of the same  (`actionWeight`,
 *      point — the action ploy, and the reaction?           `reactionWeight`)
 *   3. What is an in-activation firefight ploy worth to me (`firefightBar`,
 *      when the moment comes?                               `maxPerActivation`)
 *   4. How much am I holding for somebody else's turn,     (`reactionBudget`,
 *      and what kind of attack is worth spending it on?     `reactionTrigger`)
 *
 * Question 2 is the one that makes the rest work. The strategy phase asks for
 * CP first, every turning point, and at one point of income a turning point
 * whoever asks first would get all of it — so a strategic buy is measured
 * against what the same point would buy in the fighting, priced by the very
 * functions that will price it for real when the moment comes.
 *
 * The answers move with the battle, not just with the team. A raider banks
 * three turning points of CP and spends the lot on the turning point it
 * commits; a gunline holds one point back all game for the shot that would
 * otherwise kill its sniper; a vanguard team has no interest in either and
 * spends every point the moment a charge is on. The last turning point of a
 * scoring mission empties everyone's hand, because unspent CP scores nothing.
 *
 * Which doctrine a team runs is DERIVED, not hand-maintained: from the ploys
 * the pack actually declares (a team whose firefight ploys are all reactive
 * wants a reserve; a team with none wants no reserve at all) and from the
 * disposition it fights with (`tactics.js`). A pack may override it with
 * `aiCpDoctrine`, and a handful of teams whose identity is their CP play are
 * named below — the same escape hatch `TEAM_DISPOSITIONS` uses.
 *
 * The plan this produces is plain data, written onto the player by
 * `phases.js`. That matters: `rules/ploys.js` reads `reactionBudget` and
 * `reactionTrigger` when an attack lands, which is a window with no AI in it.
 * The judgement is still made here; the rules layer only spends what the
 * judgement set aside.
 */
import { ployCatalogue } from '../rules/ploys.js';
import { dispositionFor, dispositionForPack } from './tactics.js';
import { valuePloy, valueFirefightPloy } from './ploys.js';
import { isLastTeamStanding, turningPointLimit } from '../rules/phases.js';
import { liveOperatives } from '../state.js';
import { baseDistance } from '../maps/geometry.js';

/**
 * The doctrines. Every number is a bar in "value per CP" as `valuePloy`
 * measures it, except the reserves, which are CP.
 *
 * `spikeBar` is what the doctrine becomes on the turning point it has been
 * saving for — the moment a banked economy is supposed to convert. A doctrine
 * with no interest in banking sets it near its normal bar and simply plays the
 * same way throughout.
 *
 * `actionWeight` and `reactionWeight` are how much the doctrine TRUSTS the
 * other two uses of a Command Point. They price the opportunity cost of
 * spending in the strategy phase: a vanguard team believes the second Fight
 * action will happen and prices its CP accordingly, so a merely decent
 * team-wide buff is not worth committing to; a bulwark team believes it will
 * be shot at. This is what stops the strategy phase — which always asks first
 * — from quietly consuming an economy that the doctrine wanted for the fight.
 */
export const CP_DOCTRINES = {
  vanguard: {
    label: 'Vanguard',
    note: 'spends CP the moment a charge is on, and never banks it',
    // The high bar is the whole doctrine: a team-wide buff has to be worth
    // more than the second Fight action this CP could buy in three
    // activations' time, or the point stays in hand for the fight.
    strategicBar: 1.6,
    firefightBar: 0.7,
    maxPerActivation: 2,
    reactionBudget: 0,
    reactionTrigger: 'lethal',
    actionWeight: 0.95,
    reactionWeight: 0.3,
    spikeBar: 0.5,
  },
  gunline: {
    label: 'Gunline',
    note: 'buys the turning point it can shoot through, and keeps a point in hand',
    strategicBar: 1.0,
    firefightBar: 1.1,
    maxPerActivation: 1,
    reactionBudget: 1,
    reactionTrigger: 'lethal',
    actionWeight: 0.55,
    reactionWeight: 0.75,
    spikeBar: 0.7,
  },
  raider: {
    label: 'Raider',
    note: 'banks CP early and empties its hand on the turning point it commits',
    strategicBar: 2.0,
    firefightBar: 1.6,
    maxPerActivation: 2,
    reactionBudget: 0,
    reactionTrigger: 'lethal',
    actionWeight: 0.85,
    reactionWeight: 0.4,
    spikeBar: 0.55,
  },
  bulwark: {
    label: 'Bulwark',
    note: 'keeps CP for the attack that would take an operative off the board',
    strategicBar: 1.25,
    firefightBar: 1.3,
    maxPerActivation: 1,
    reactionBudget: 2,
    reactionTrigger: 'lethal',
    actionWeight: 0.5,
    reactionWeight: 1.0,
    spikeBar: 0.8,
  },
  tactician: {
    label: 'Tactician',
    note: 'takes the best buy each turning point and keeps one point for the fight',
    strategicBar: 1.0,
    firefightBar: 1.0,
    maxPerActivation: 1,
    reactionBudget: 1,
    reactionTrigger: 'lethal',
    actionWeight: 0.65,
    reactionWeight: 0.6,
    spikeBar: 0.7,
  },
};

/**
 * Teams whose CP play is part of their identity rather than a consequence of
 * their disposition. Kept short on purpose: everything not named here is
 * derived from the pack's own ploys, so a new team needs no entry.
 */
export const TEAM_CP_DOCTRINES = {
  // Ambushers: the whole plan is one turning point of violence, paid for out
  // of CP saved while they were still hidden.
  mandrakes: 'raider',
  'hand-of-the-archon': 'raider',
  'void-dancer-troupe': 'raider',
  'phobos-strike-team': 'raider',
  'wolf-scouts': 'raider',
  kommandos: 'raider',
  // Elite bodies, few of them: a point of CP that saves one is worth more than
  // a point that buys a re-roll.
  'angel-of-death': 'bulwark',
  murderwing: 'bulwark',
  deathwatch: 'bulwark',
  'plague-marines': 'bulwark',
  'hierotek-circle': 'bulwark',
  'canoptek-circle': 'bulwark',
  // Teams that live at knife range and would rather buy a second swing.
  goremonger: 'vanguard',
  'blades-of-khaine': 'vanguard',
  raveners: 'vanguard',
  'wrecka-krew': 'vanguard',
  'chaos-cult': 'vanguard',
  'fellgor-ravager': 'vanguard',
};

/** Disposition → doctrine, when the pack's own ploys do not say otherwise. */
const BY_DISPOSITION = {
  aggressive: 'vanguard',
  patient: 'gunline',
  skirmish: 'raider',
  relentless: 'bulwark',
  balanced: 'tactician',
};

/* ------------------------------------------------------------------ */
/* What this pack's ploys make possible                                */
/* ------------------------------------------------------------------ */

/**
 * The shape of a team's CP options, read off its own pack.
 *
 * A reaction budget is only worth holding if the pack declares a reaction to
 * spend it on, and a doctrine derived from temperament alone would hold one
 * anyway. That is a question about the data rather than about the team, so it
 * is answered here and used to correct the doctrine.
 *
 * @returns {{strategic:number, action:number, reactive:number, total:number}}
 *          counts of *supported* ploys the engine can actually play
 */
export function ployProfile(pack) {
  const all = ployCatalogue(pack).filter((p) => p.supported);
  const strategic = all.filter((p) => p.kind === 'strategic').length;
  const action = all.filter((p) => p.kind === 'firefight' && p.timing === 'activation').length;
  const reactive = all.filter((p) => p.kind === 'firefight' && p.timing === 'defence').length;
  return { strategic, action, reactive, total: all.length };
}

/* ------------------------------------------------------------------ */
/* Choosing a doctrine                                                 */
/* ------------------------------------------------------------------ */

/**
 * The doctrine this team runs.
 * @returns {{name:string, label:string, note:string, …}} a CP_DOCTRINES entry
 */
export function doctrineFor(state, playerId) {
  return doctrineForPack(state.teamPacks?.[playerId]);
}

/**
 * The same answer from the pack alone. The setup screen uses it to say what a
 * team will do with its Command Points before a battle starts, which is half
 * of what choosing between two kill teams is about.
 */
export function doctrineForPack(pack) {
  const override = pack?.aiCpDoctrine;
  if (override && typeof override === 'object') {
    return { name: 'custom', ...CP_DOCTRINES.tactician, ...override };
  }
  if (typeof override === 'string' && CP_DOCTRINES[override]) {
    return { name: override, ...CP_DOCTRINES[override] };
  }

  const named = TEAM_CP_DOCTRINES[pack?.id];
  if (named) return { name: named, ...CP_DOCTRINES[named] };

  const profile = ployProfile(pack);
  const disposition = dispositionForPack(pack);

  // A pack whose firefight ploys are mostly reactive is telling us what its CP
  // is for, whatever its temperament: holding a point back is the only way to
  // ever use them.
  if (profile.reactive >= 2 && profile.reactive >= profile.action) {
    return { name: 'bulwark', ...CP_DOCTRINES.bulwark };
  }
  // …and one with plenty of action ploys wants CP in hand during activations
  // rather than committed in the strategy phase.
  if (profile.action >= 2 && profile.action > profile.strategic &&
      disposition.name !== 'patient') {
    return { name: 'vanguard', ...CP_DOCTRINES.vanguard };
  }

  const name = BY_DISPOSITION[disposition.name] || 'tactician';
  return { name, ...CP_DOCTRINES[name] };
}

/* ------------------------------------------------------------------ */
/* What the same CP would buy during the fighting                      */
/* ------------------------------------------------------------------ */

/** How often a team can expect to actually be attacked in a turning point. */
const REACTION_LIKELIHOOD = 0.7;

/** How often each kind of plan is the one an activation actually commits to. */
const MODE_LIKELIHOOD = [['melee', 1], ['shoot', 1], ['opening', 0.9], ['move', 0.5]];

/**
 * The best use this team could make of one CP once the shooting starts.
 *
 * The strategy phase asks for CP first, every turning point, and at one point
 * of income a turning point whoever asks first gets everything. So the
 * strategy phase has to be told what it is spending: the value of the action
 * ploy some operative could buy three activations from now, and the value of
 * the reaction that could save an operative on the opponent's turn.
 *
 * Both are priced with the same functions that will price them for real when
 * the moment comes (`ai/ploys.js`), so a doctrine cannot drift away from what
 * the AI actually does.
 *
 * @returns {{action:number, reactive:number, actionPloy:object|null}}
 */
function inFightOpportunity(state, playerId) {
  const pack = state.teamPacks?.[playerId];
  const disposition = dispositionFor(state, playerId);
  const live = liveOperatives(state, playerId);
  const out = { action: 0, reactive: 0, actionPloy: null, reactivePloy: null };
  if (!pack) return out;

  for (const ploy of ployCatalogue(pack, 'firefight')) {
    if (!ploy.supported) continue;
    if (ploy.timing === 'defence') {
      // A reaction is a defensive buy priced over the whole roster, discounted
      // by the chance of being attacked at all.
      const score = valuePloy(state, playerId, ploy, disposition).score * REACTION_LIKELIHOOD;
      if (score > out.reactive) { out.reactive = score; out.reactivePloy = ploy; }
      continue;
    }
    for (const op of live) {
      // Weighted by how often the plan shape that would buy the ploy is the
      // one that wins. A second Fight is bought by the melee plan an assault
      // operative reaches for constantly; a free Dash is only ever bought by a
      // take-ground plan, so pricing it as a certainty would let a ploy the AI
      // rarely buys hold the whole economy hostage.
      for (const [mode, likelihood] of MODE_LIKELIHOOD) {
        const { score } = valueFirefightPloy(state, op, ploy, disposition, mode,
          { engaged: false });
        const weighted = score * likelihood;
        if (weighted > out.action) { out.action = weighted; out.actionPloy = ploy; }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The turning point's plan                                            */
/* ------------------------------------------------------------------ */

/**
 * Is this the turning point the doctrine has been saving for?
 *
 * In a scoring mission it is a clock: the turning points that decide the game
 * are the late ones, when both teams are on the markers and the VP are being
 * counted. In a deathmatch there is no clock and no ground, so the spike is
 * contact — the moment the two teams are close enough that a bought advantage
 * turns into dead operatives rather than into nothing.
 */
function isSpike(state, playerId) {
  const limit = turningPointLimit(state);
  if (!isLastTeamStanding(state)) {
    // A four turning point game is decided from the second onward: banking
    // past that is banking into a battle that has already been lost.
    return state.turningPoint >= Math.max(2, limit - 2);
  }
  const mine = liveOperatives(state, playerId);
  const theirs = liveOperatives(state).filter((o) => o.playerId !== playerId);
  if (!mine.length || !theirs.length) return false;
  const nearest = Math.min(...mine.map((m) => Math.min(...theirs.map((t) => baseDistance(m, t)))));
  return nearest <= 12;
}

/**
 * The CP plan for this turning point: what the doctrine means right now,
 * corrected for what the team can actually spend CP on and for what the
 * mission rewards.
 *
 * @returns {{doctrine:string, label:string, note:string, reserve:number,
 *            strategicBar:number, firefightBar:number, maxPerActivation:number,
 *            reactionBudget:number, reactionTrigger:string, reactionRatio:number,
 *            spike:boolean, rationale:string}}
 */
export function planCommandPoints(state, playerId) {
  const doctrine = doctrineFor(state, playerId);
  const pack = state.teamPacks?.[playerId];
  const profile = ployProfile(pack);
  const cp = state.players[playerId].cp;
  const limit = turningPointLimit(state);
  const spike = isSpike(state, playerId);
  // Unspent CP scores nothing, so the last turning point of a mission with a
  // clock is the end of every doctrine: buy whatever is better than nothing.
  const lastCall = !isLastTeamStanding(state) && state.turningPoint >= limit;

  let strategicBar = spike ? doctrine.spikeBar : doctrine.strategicBar;
  let reactionBudget = profile.reactive ? doctrine.reactionBudget : 0;

  // What the same point of CP is worth if it is NOT spent here — the action
  // ploy an operative could buy mid-activation, or the reaction that answers
  // an attack. The strategy phase has to clear the better of the two, or it is
  // spending CP the doctrine wanted for the fight.
  const opportunity = inFightOpportunity(state, playerId);
  const actionCost = opportunity.action * doctrine.actionWeight;
  const reactionCost = opportunity.reactive * doctrine.reactionWeight;
  let opportunityCost = Math.max(actionCost, reactionCost);
  // A team already sitting on three points can afford both, so the opportunity
  // stops being a reason to hold: whatever it was waiting for has had three
  // turning points to happen.
  if (cp >= 3) opportunityCost *= 0.5;
  if (!lastCall) strategicBar = Math.max(strategicBar, opportunityCost);

  // Hoarding has a ceiling. A deathmatch can run twelve turning points, and a
  // doctrine that banks CP against a spike that never comes would sit on six
  // points while being shot to pieces; past four the bar comes down.
  if (cp >= 4) strategicBar *= 0.6;

  // The reserve is a hard lock on the strategy phase, and the bar above has
  // already made the comparison the doctrine cares about — so it only exists
  // for the CP a reaction needs to still be there on the opponent's turn, and
  // only when reacting is what this team's doctrine actually wants.
  let reserve = 0;
  if (reactionBudget > 0 && reactionCost >= actionCost && reactionCost >= doctrine.strategicBar) {
    reserve = Math.min(reactionBudget, cp);
  }

  if (lastCall) {
    // Nothing carries over, so the only CP worth holding is CP something can
    // still be done with: one point for a reaction, the rest spent now.
    strategicBar = 0.01;
    reserve = reactionBudget > 0 ? Math.min(1, cp) : 0;
  }
  reactionBudget = Math.max(0, Math.min(reactionBudget, reserve, cp));

  return {
    doctrine: doctrine.name,
    label: doctrine.label,
    note: doctrine.note,
    reserve,
    strategicBar,
    firefightBar: spike ? Math.min(doctrine.firefightBar, doctrine.spikeBar) : doctrine.firefightBar,
    maxPerActivation: doctrine.maxPerActivation,
    reactionBudget,
    // CP that is piling up is CP being wasted, so a team sitting on three
    // points stops waiting for the shot that would kill an operative and
    // answers the one that merely hurts.
    reactionTrigger: (lastCall || cp >= 3) && profile.reactive
      ? 'wounded'
      : doctrine.reactionTrigger,
    /** How much of the defender's remaining wounds a shot must threaten. */
    reactionRatio: doctrine.reactionRatio ?? 0.6,
    spike,
    rationale: rationaleFor(doctrine, {
      cp, spike, lastCall, reserve, reactionBudget, profile, opportunity,
      actionCost, reactionCost, strategicBar,
    }),
  };
}

function rationaleFor(doctrine, {
  cp, spike, lastCall, reserve, reactionBudget, profile, opportunity, actionCost, reactionCost,
}) {
  const parts = [`${doctrine.label} doctrine — ${doctrine.note}`, `${cp} CP in hand`];
  if (lastCall) parts.push('last turning point: unspent CP scores nothing');
  else if (spike) parts.push('this is the turning point it has been saving for');

  if (actionCost > 0 && actionCost >= reactionCost) {
    parts.push(`a strategic ploy has to beat ${opportunity.actionPloy?.name ?? 'an action ploy'} in the fight`);
  } else if (reactionCost > 0) {
    parts.push(`holding ${reserve} to answer an attack with ${opportunity.reactivePloy?.name ?? 'a reaction'}`);
  } else if (!profile.action && !profile.reactive) {
    parts.push('nothing to spend CP on but strategic ploys');
  }
  if (reactionBudget > 0) parts.push(`${reactionBudget} CP of reaction budget`);
  return parts.join('; ');
}
