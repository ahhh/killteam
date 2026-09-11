/**
 * Rule-pack, map and mission validation (§28).
 *
 * Fails loudly rather than letting bad profiles corrupt a simulation.
 * Returns structured results so the UI can show exactly what is wrong.
 */
import {
  LIMITS, STAT_RANGES, WEAPON_RANGES, SUPPORT_LEVELS, KNOWN_HOOK_TRIGGERS, sanitizeText,
} from './schema.js';
import { WEAPON_RULES, parseRule } from '../rules/dice.js';
import { describeHook } from '../rules/hooks.js';
import { describeTeamRule, TEAM_RULE_EFFECTS } from '../rules/team-rules.js';
import { describeResource } from '../rules/resources.js';
import { TERRAIN_TRAITS } from '../rules/terrain.js';
import { DISPOSITIONS } from '../ai/tactics.js';

class Report {
  constructor(subject) {
    this.subject = subject;
    this.errors = [];
    this.warnings = [];
  }
  error(msg) { this.errors.push(msg); return this; }
  warn(msg) { this.warnings.push(msg); return this; }
  get ok() { return this.errors.length === 0; }
  toJSON() {
    return { subject: this.subject, ok: this.ok, errors: this.errors, warnings: this.warnings };
  }
}

function checkRange(report, label, value, [min, max]) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    report.error(`${label} must be a number (got ${JSON.stringify(value)})`);
    return;
  }
  if (value < min || value > max) {
    report.error(`${label} = ${value} is outside the legal range ${min}–${max}`);
  }
}

/** The range every weapon gets when its datacard prints no Range rule. On a
 *  30x22" board this is unlimited, so a shorter range is a real restriction. */
export const UNLIMITED_RANGE = 48;

/**
 * A ranged weapon is only allowed to be short if its datacard says so.
 *
 * Six project-authored teams were once written against a different reading of
 * `range` — main guns capped at 10-18" while all 49 transcribed packs leave
 * theirs unlimited — and it cost them the game before they could fire: average
 * roster range correlated +0.81 with win rate across a 3,960-battle sweep,
 * far ahead of team size, APL or wounds. Short range is a legitimate design
 * (pistols, flamers, breaching shotguns all keep theirs); silently short
 * range is not. So a sub-48" weapon has to carry the printed rule that earns
 * it, which also keeps the field and the rules text from drifting apart.
 *
 * `Rng n"` is the 2021 symbol notation, whose distances are doubled to this
 * engine's scale — see the Catachan pack's source notes.
 */
function checkShortRangeIsPrinted(report, wl, w) {
  if (typeof w.range !== 'number' || w.range >= UNLIMITED_RANGE) return;
  const text = `${w.rulesText || ''} ${(w.rules || []).join(' ')}`;
  const printed = /Range\s+(\d+)/i.exec(text);
  if (printed) {
    if (Number(printed[1]) !== w.range) {
      report.error(`${wl} range ${w.range}" contradicts its printed Range ${printed[1]}"`);
    }
    return;
  }
  const legacy = /Rng\s+(\d+)/i.exec(text);
  if (legacy) {
    if (Number(legacy[1]) * 2 !== w.range) {
      report.error(
        `${wl} range ${w.range}" does not match its printed Rng ${legacy[1]}" doubled to this engine's scale`);
    }
    return;
  }
  report.error(
    `${wl} is limited to ${w.range}" but prints no Range rule — either add the rule or ` +
    `leave it at ${UNLIMITED_RANGE}" like every unlimited weapon`);
}

export function validateTeamPack(pack) {
  const report = new Report(`team:${pack?.id ?? 'unknown'}`);
  if (!pack || typeof pack !== 'object') return report.error('pack is not an object');

  for (const field of ['id', 'factionId', 'displayName']) {
    if (!pack[field]) report.error(`missing required field "${field}"`);
  }

  // --- Source metadata (§29) ---------------------------------------
  if (!pack.source) {
    report.error('missing source metadata — every pack must record where its data came from');
  } else {
    if (!pack.source.publisher) report.warn('source.publisher is empty');
    if (!pack.source.checkedAt) report.warn('source.checkedAt is empty — staleness cannot be assessed');
  }
  if (!pack.dataVersion) report.warn('missing dataVersion');

  // --- Support level (§10) -----------------------------------------
  const level = pack.supportLevel;
  if (level === undefined || !(level in SUPPORT_LEVELS)) {
    report.error(`supportLevel must be one of ${Object.keys(SUPPORT_LEVELS).join(', ')}`);
  }

  // --- Operatives ---------------------------------------------------
  const operatives = pack.operatives || [];
  if (!operatives.length && level > 0) {
    report.error('pack declares a support level above metadata but has no operatives');
  }
  if (operatives.length > LIMITS.maxOperativesPerTeam) {
    report.error(`too many operative profiles (${operatives.length} > ${LIMITS.maxOperativesPerTeam})`);
  }

  const profileIds = new Set();
  for (const op of operatives) {
    const label = `operative "${op.id ?? '?'}"`;
    if (!op.id) { report.error(`${label} missing id`); continue; }
    if (profileIds.has(op.id)) report.error(`duplicate operative id "${op.id}"`);
    profileIds.add(op.id);
    if (!op.name) report.warn(`${label} has no display name`);

    if (!op.stats) { report.error(`${label} missing stats`); continue; }
    for (const [stat, range] of Object.entries(STAT_RANGES)) {
      checkRange(report, `${label} stats.${stat}`, op.stats[stat], range);
    }

    const weapons = op.weapons || [];
    if (!weapons.length) report.warn(`${label} has no weapons and can never attack`);
    if (weapons.length > LIMITS.maxWeaponsPerOperative) {
      report.error(`${label} has too many weapons (${weapons.length})`);
    }

    const weaponIds = new Set();
    for (const w of weapons) {
      const wl = `${label} weapon "${w.id ?? '?'}"`;
      if (!w.id) { report.error(`${wl} missing id`); continue; }
      if (weaponIds.has(w.id)) report.error(`${label} has duplicate weapon id "${w.id}"`);
      weaponIds.add(w.id);

      if (w.type !== 'ranged' && w.type !== 'melee') {
        report.error(`${wl} type must be "ranged" or "melee"`);
      }
      checkRange(report, `${wl} atk`, w.atk, WEAPON_RANGES.atk);
      checkRange(report, `${wl} hit`, w.hit, WEAPON_RANGES.hit);
      if (w.type === 'ranged') {
        checkRange(report, `${wl} range`, w.range, WEAPON_RANGES.range);
        checkShortRangeIsPrinted(report, wl, w);
      }
      if (!w.damage) {
        report.error(`${wl} missing damage profile`);
      } else {
        checkRange(report, `${wl} damage.normal`, w.damage.normal, WEAPON_RANGES['damage.normal']);
        checkRange(report, `${wl} damage.critical`, w.damage.critical, WEAPON_RANGES['damage.critical']);
      }

      for (const rule of w.rules || []) {
        const { name, value } = parseRule(rule);
        const key = value !== null && WEAPON_RULES[`${name}${value}`] ? `${name}${value}` : name;
        // A rule is known if the universal appendix covers it, or if this pack
        // declares its own reading of it in `weaponRules`.
        const declared = TEAM_RULE_EFFECTS[pack.weaponRules?.[name]?.effect?.type];
        if (!(key in WEAPON_RULES) && !declared) {
          report.warn(`${wl} has unimplemented rule "${rule}" — it will be ignored and logged during play`);
        }
      }
    }
  }

  // --- Roster -------------------------------------------------------
  const roster = pack.roster?.operatives || [];
  if (level >= 1 && !roster.length) {
    report.error('roster lists no operatives');
  }
  let total = 0;
  for (const entry of roster) {
    if (!profileIds.has(entry.profileId)) {
      report.error(`roster references unknown profile "${entry.profileId}"`);
    }
    const count = entry.count ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      report.error(`roster entry "${entry.profileId}" has invalid count ${count}`);
    }
    total += count;
  }
  if (total > LIMITS.maxOperativesPerTeam) {
    report.error(`roster fields ${total} operatives (limit ${LIMITS.maxOperativesPerTeam})`);
  }
  if (level >= 1 && total < 2) {
    report.warn(`roster fields only ${total} operative(s)`);
  }

  // --- Rule hooks ---------------------------------------------------
  const seenHooks = new Set();
  for (const hook of pack.ruleHooks || []) {
    if (typeof hook.effect === 'string' && /function|=>/.test(hook.effect)) {
      report.error('rule hooks must be declarative data — executable code is never run from a pack');
    }
    if (!hook.id) report.error('rule hook is missing an id');
    if (!KNOWN_HOOK_TRIGGERS.includes(hook.trigger)) {
      report.warn(`unknown hook trigger "${hook.trigger}" — it will never fire`);
    }
    // The effect vocabulary is the engine's, so check against it directly
    // rather than duplicating the list here.
    for (const problem of describeHook(hook)) {
      report.warn(`hook "${hook.id ?? '?'}" (${hook.rule ?? 'unnamed rule'}): ${problem}`);
    }
    if (hook.partial && !hook.notes) {
      report.warn(`hook "${hook.id}" is marked partial but says nothing about what is missing`);
    }
    const key = `${hook.trigger}:${hook.id ?? JSON.stringify(hook.condition)}`;
    if (seenHooks.has(key)) report.error(`duplicate rule hook "${key}"`);
    seenHooks.add(key);
  }

  // --- Ploys and equipment ------------------------------------------
  // A ploy's `hooks` are ruleHooks in every respect except who pays for them,
  // so they are held to the same standard. A ploy with no hooks is not an
  // error: it is simply one the engine cannot play, and `rules/ploys.js`
  // reports it at battle start rather than failing the pack.
  const seenPloys = new Set();
  for (const [field, label] of [['strategicPloys', 'strategic ploy'], ['firefightPloys', 'firefight ploy']]) {
    for (const ploy of pack[field] || []) {
      if (!ploy?.id) { report.error(`${label} is missing an id`); continue; }
      if (seenPloys.has(ploy.id)) report.error(`duplicate ploy id "${ploy.id}"`);
      seenPloys.add(ploy.id);
      if (ploy.cost !== undefined && (!Number.isInteger(ploy.cost) || ploy.cost < 0)) {
        report.error(`${label} "${ploy.id}" has invalid cost ${ploy.cost}`);
      }
      if (!ploy.description) report.warn(`${label} "${ploy.id}" has no printed wording to check against`);
      // A firefight ploy says when it may be bought: during a friendly
      // operative's activation (the default), as a reaction to an attack, or
      // on the way out, as the operative that paid for it is incapacitated.
      if (field === 'firefightPloys' && ploy.timing !== undefined &&
          !['activation', 'defence', 'demise'].includes(ploy.timing)) {
        report.warn(`firefight ploy "${ploy.id}" has unknown timing "${ploy.timing}" ` +
          '— expected "activation", "defence" or "demise"');
      }
      if (field === 'strategicPloys' && ploy.timing !== undefined) {
        report.warn(`strategic ploy "${ploy.id}" declares a timing; strategic ploys are always bought in the strategy phase`);
      }
      if (ploy.scope !== undefined && !['operative', 'team'].includes(ploy.scope)) {
        report.warn(`${label} "${ploy.id}" has unknown scope "${ploy.scope}"`);
      }
      if (!Array.isArray(ploy.hooks)) continue;
      // A reaction is bought inside somebody else's attack sequence, so the
      // only triggers it can still catch are the defender's own.
      if (field === 'firefightPloys' && ploy.timing === 'defence') {
        const usable = ['onIncomingAttack', 'beforeDefenceRoll', 'beforeDamageApplied', 'onDamageApplied'];
        for (const hook of ploy.hooks) {
          if (hook.trigger && !usable.includes(hook.trigger)) {
            report.warn(`firefight ploy "${ploy.id}" is a reaction but hooks "${hook.trigger}", ` +
              'which has already fired by the time it is bought');
          }
        }
      }
      // A demise ploy is bought at one instant — the moment the operative that
      // paid for it goes down — so `onIncapacitated` is the only trigger left
      // for it to catch.
      if (field === 'firefightPloys' && ploy.timing === 'demise') {
        for (const hook of ploy.hooks) {
          if (hook.trigger && hook.trigger !== 'onIncapacitated') {
            report.warn(`firefight ploy "${ploy.id}" is bought on an incapacitation but hooks ` +
              `"${hook.trigger}", which that operative will never reach`);
          }
        }
      }
      for (const hook of ploy.hooks) {
        if (typeof hook.effect === 'string' && /function|=>/.test(hook.effect)) {
          report.error('ploy hooks must be declarative data — executable code is never run from a pack');
        }
        for (const problem of describeHook(hook)) {
          report.warn(`${label} "${ploy.id}": ${problem}`);
        }
        if (hook.partial && !hook.notes) {
          report.warn(`${label} "${ploy.id}" is marked partial but says nothing about what is missing`);
        }
      }
    }
  }
  for (const item of pack.equipment || []) {
    if (!item?.id) report.error('equipment entry is missing an id');
  }

  // --- Team-specific weapon rules -----------------------------------
  const weaponRules = pack.weaponRules || {};
  if (typeof weaponRules !== 'object' || Array.isArray(weaponRules)) {
    report.error('weaponRules must be an object keyed by rule token');
  } else {
    for (const [name, def] of Object.entries(weaponRules)) {
      if (!/^[a-z]+$/.test(name)) {
        report.warn(`weaponRules key "${name}" should be the bare lowercase rule token`);
      }
      if (typeof def?.effect === 'string' && /function|=>/.test(def.effect)) {
        report.error('weapon rules must be declarative data — executable code is never run from a pack');
      }
      if (!def?.text) {
        report.warn(`weaponRules.${name} carries no printed wording in "text"`);
      }
      for (const problem of describeTeamRule(name, def)) report.warn(problem);
    }
    // A declared rule nothing uses is dead weight; a used rule nothing
    // declares is the one that actually costs fidelity, so both are called out.
    const used = new Set();
    for (const op of operatives) {
      for (const w of op.weapons || []) {
        for (const token of w.rules || []) used.add(String(token).replace(/\d+$/, '').split(':')[0]);
      }
    }
    for (const name of Object.keys(weaponRules)) {
      if (!used.has(name)) report.warn(`weaponRules.${name} is declared but no weapon uses it`);
    }
  }

  // --- Team resource economies (Power From Pain and friends) --------
  const resources = pack.resources || {};
  if (typeof resources !== 'object') {
    report.error('resources must be an object keyed by resource id');
  } else {
    for (const [key, def] of Object.entries(resources)) {
      for (const problem of describeResource(key, def)) report.warn(problem);
    }
    // A resource a weapon rule feeds but the pack never declares is a rule
    // that silently does nothing, so it is called out here rather than only
    // at runtime.
    for (const [name, rule] of Object.entries(pack.weaponRules || {})) {
      const fed = rule?.effect?.type === 'gainResource' ? rule.effect.resource : null;
      if (fed && !(fed in resources)) {
        report.warn(`weaponRules.${name} feeds a "${fed}" resource the pack does not declare`);
      }
    }
  }

  // A pack claiming faction-rule support must actually wire some up.
  if (level >= 3 && !(pack.ruleHooks || []).length && !Object.keys(resources).length) {
    report.warn('supportLevel claims faction rules but the pack defines no ruleHooks or resources');
  }

  // --- Declared level vs implemented content (§28) -------------------
  // Level 4 means the ploys are *playable*, not merely transcribed — every
  // pack carries the prose already, so listing it proves nothing.
  if (level >= 4 && !(pack.strategicPloys || []).some((p) => p.hooks?.length)) {
    report.warn('supportLevel claims ploys but no strategic ploy declares hooks the engine can play');
  }
  if (level >= 3 && !operatives.some((o) => (o.abilities || []).length)) {
    report.warn('supportLevel claims operative abilities but the pack defines none');
  }

  // A misspelled disposition would silently fall back to the faction default,
  // so say so rather than letting the pack think it took effect.
  const disposition = pack.aiDisposition;
  if (typeof disposition === 'string' && !(disposition in DISPOSITIONS)) {
    report.warn(
      `unknown aiDisposition "${disposition}" — expected one of ` +
      `${Object.keys(DISPOSITIONS).join(', ')}, or an inline block of multipliers`
    );
  }

  return report;
}

export function validateMap(map) {
  const report = new Report(`map:${map?.id ?? 'unknown'}`);
  if (!map || typeof map !== 'object') return report.error('map is not an object');
  if (!map.id) report.error('missing id');

  const board = map.board;
  if (!board) {
    report.error('missing board dimensions');
  } else {
    for (const dim of ['width', 'height']) {
      const v = board[dim];
      if (typeof v !== 'number' || v < LIMITS.minBoard || v > LIMITS.maxBoard) {
        report.error(`board.${dim} must be between ${LIMITS.minBoard} and ${LIMITS.maxBoard} inches (got ${v})`);
      }
    }
  }

  const terrain = map.terrain || [];
  if (terrain.length > LIMITS.maxTerrainPieces) {
    report.error(`too many terrain pieces (${terrain.length} > ${LIMITS.maxTerrainPieces})`);
  }
  const ids = new Set();
  for (const piece of terrain) {
    if (!piece.id) { report.error('terrain piece missing id'); continue; }
    if (ids.has(piece.id)) report.error(`duplicate terrain id "${piece.id}"`);
    ids.add(piece.id);

    const points = piece.shape?.points;
    if (!Array.isArray(points) || points.length < 3) {
      report.error(`terrain "${piece.id}" needs at least 3 points`);
      continue;
    }
    if (points.length > LIMITS.maxPolygonPoints) {
      report.error(`terrain "${piece.id}" has too many points (${points.length})`);
    }
    for (const p of points) {
      if (typeof p.x !== 'number' || typeof p.y !== 'number' ||
          !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        report.error(`terrain "${piece.id}" has a non-numeric point`);
        break;
      }
    }
    for (const trait of piece.traits || []) {
      if (!(trait in TERRAIN_TRAITS)) {
        report.warn(`terrain "${piece.id}" has unknown trait "${trait}" — it will be ignored`);
      }
    }
  }

  const objectives = map.objectives || [];
  if (objectives.length > LIMITS.maxObjectives) {
    report.error(`too many objectives (${objectives.length})`);
  }
  const objIds = new Set();
  for (const o of objectives) {
    if (!o.id) report.error('objective missing id');
    if (objIds.has(o.id)) report.error(`duplicate objective id "${o.id}"`);
    objIds.add(o.id);
    if (board && (o.x < 0 || o.y < 0 || o.x > board.width || o.y > board.height)) {
      report.error(`objective "${o.id}" lies off the board`);
    }
  }

  const zones = map.deploymentZones || [];
  for (const playerId of ['p1', 'p2']) {
    if (!zones.some((z) => z.playerId === playerId)) {
      report.error(`no deployment zone defined for ${playerId}`);
    }
  }

  return report;
}

/** Ways a mission can be won. Anything else is rejected rather than guessed. */
export const VICTORY_CONDITIONS = ['victoryPoints', 'lastTeamStanding'];

export function validateMission(mission) {
  const report = new Report(`mission:${mission?.id ?? 'unknown'}`);
  if (!mission || typeof mission !== 'object') return report.error('mission is not an object');
  if (!mission.id) report.error('missing id');
  const scoring = mission.scoring;
  const victory = mission.victory?.type ?? 'victoryPoints';
  if (!VICTORY_CONDITIONS.includes(victory)) {
    report.error(`unknown victory condition "${victory}"`);
  }
  // A last-team-standing mission wins by elimination, so it is allowed to
  // score nothing at all; every other mission needs a way to earn VP.
  if (victory === 'victoryPoints' && (!scoring || !Object.keys(scoring).length)) {
    report.error('mission defines no scoring rules — no one could ever win');
  }
  if (mission.turningPoints !== undefined &&
      (!Number.isInteger(mission.turningPoints) || mission.turningPoints < 1 || mission.turningPoints > 10)) {
    report.error('turningPoints must be an integer between 1 and 10');
  }
  const cap = mission.victory?.turningPointCap;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1 || cap > 40)) {
    report.error('victory.turningPointCap must be an integer between 1 and 40');
  }
  return report;
}

/** Age of a pack's data in days, or null if it never recorded a check date. */
export function dataAgeDays(pack, now = new Date()) {
  const checked = pack?.source?.checkedAt;
  if (!checked) return null;
  const then = new Date(checked);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now - then) / 86400000);
}

export function isStale(pack, maxAgeDays = 120, now = new Date()) {
  const age = dataAgeDays(pack, now);
  return age !== null && age > maxAgeDays;
}
