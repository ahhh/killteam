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
import { TERRAIN_TRAITS } from '../rules/terrain.js';

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
      if (w.type === 'ranged') checkRange(report, `${wl} range`, w.range, WEAPON_RANGES.range);
      if (!w.damage) {
        report.error(`${wl} missing damage profile`);
      } else {
        checkRange(report, `${wl} damage.normal`, w.damage.normal, WEAPON_RANGES['damage.normal']);
        checkRange(report, `${wl} damage.critical`, w.damage.critical, WEAPON_RANGES['damage.critical']);
      }

      for (const rule of w.rules || []) {
        const { name, value } = parseRule(rule);
        const key = value !== null && WEAPON_RULES[`${name}${value}`] ? `${name}${value}` : name;
        if (!(key in WEAPON_RULES)) {
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

  // A pack claiming faction-rule support must actually wire some up.
  if (level >= 3 && !(pack.ruleHooks || []).length) {
    report.warn('supportLevel claims faction rules but the pack defines no ruleHooks');
  }

  // --- Declared level vs implemented content (§28) -------------------
  if (level >= 4 && !(pack.strategicPloys?.length || pack.firefightPloys?.length)) {
    report.warn('supportLevel claims ploys/equipment but the pack defines none');
  }
  if (level >= 3 && !operatives.some((o) => (o.abilities || []).length)) {
    report.warn('supportLevel claims operative abilities but the pack defines none');
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

export function validateMission(mission) {
  const report = new Report(`mission:${mission?.id ?? 'unknown'}`);
  if (!mission || typeof mission !== 'object') return report.error('mission is not an object');
  if (!mission.id) report.error('missing id');
  const scoring = mission.scoring;
  if (!scoring || !Object.keys(scoring).length) {
    report.error('mission defines no scoring rules — no one could ever win');
  }
  if (mission.turningPoints !== undefined &&
      (!Number.isInteger(mission.turningPoints) || mission.turningPoints < 1 || mission.turningPoints > 10)) {
    report.error('turningPoints must be an integer between 1 and 10');
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
