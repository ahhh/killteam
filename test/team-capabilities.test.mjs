/**
 * The regression lock on what every bundled team can actually DO.
 *
 * `test/fixtures/team-capabilities.json` is an inventory of every playable
 * thing the 64 packs declare — rule hooks, resource economies and their
 * spends, performable unique actions, ploys that carry hooks, team weapon
 * rules with an implemented effect, and marker-control modifiers. The tests
 * below assert that the live packs are a SUPERSET of it.
 *
 * That asymmetry is the point. Wiring a new rule is free: add it, regenerate
 * the manifest with `node tools/make-team-manifest.mjs`, commit the diff.
 * Losing one is not: deleting a hook, renaming it, retyping its effect,
 * dropping an `action` block back to reference text or lowering a pack's
 * supportLevel all fail here, loudly, naming the team and the capability.
 *
 * Every entry is also checked against the ENGINE's own vocabulary rather than
 * against a copy of it, so a hook that survives the manifest but whose effect
 * the engine has stopped implementing fails too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTeam, readJson, ROOT } from './harness.mjs';
import { capabilitiesOf } from '../tools/team-capabilities.mjs';
import { describeHook, HOOK_TRIGGERS, HOOK_CONDITIONS, HOOK_EFFECTS } from '../src/rules/hooks.js';
import {
  UNIQUE_EFFECTS, TARGET_SCOPES, TARGET_CONDITIONS, uniqueActionSupport,
} from '../src/rules/unique-actions.js';
import {
  RESOURCE_GAIN_TRIGGERS, RESOURCE_SPEND_WINDOWS, RESOURCE_SPEND_EFFECTS,
  describeResource,
} from '../src/rules/resources.js';
import { validateTeamPack } from '../src/data/validators.js';

const MANIFEST = readJson('test/fixtures/team-capabilities.json');
const TEAM_IDS = fs.readdirSync(path.join(ROOT, 'data/teams'))
  .filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort();

const REGEN = 'regenerate with `node tools/make-team-manifest.mjs` if this was deliberate';

/* ====================================================================== */
/* The lock itself                                                        */
/* ====================================================================== */

test('every bundled team is covered by the manifest', () => {
  const missing = TEAM_IDS.filter((id) => !(id in MANIFEST.teams));
  assert.deepEqual(missing, [],
    `these packs have no regression coverage — ${REGEN}`);
});

test('the manifest names no team that has been removed', () => {
  const gone = Object.keys(MANIFEST.teams).filter((id) => !TEAM_IDS.includes(id));
  assert.deepEqual(gone, [], `the manifest locks teams that no longer exist — ${REGEN}`);
});

const FIELDS = [
  'ruleHooks', 'resources', 'resourceSpends', 'uniqueActions',
  'ployHooks', 'weaponRules', 'controlModifiers',
];

for (const id of Object.keys(MANIFEST.teams).filter((t) => TEAM_IDS.includes(t))) {
  const expected = MANIFEST.teams[id];

  test(`${id} keeps every capability it had`, () => {
    const actual = capabilitiesOf(loadTeam(id));
    for (const field of FIELDS) {
      const have = new Set(actual[field]);
      const lost = expected[field].filter((entry) => !have.has(entry));
      assert.deepEqual(lost, [],
        `${id} no longer declares ${field}: ${lost.join(', ')} — ${REGEN}`);
    }
  });

  test(`${id} does not drop its support level`, () => {
    const actual = capabilitiesOf(loadTeam(id));
    assert.ok(actual.supportLevel >= expected.supportLevel,
      `${id} fell from supportLevel ${expected.supportLevel} to ${actual.supportLevel} — ${REGEN}`);
  });
}

/* ====================================================================== */
/* …and that the engine still implements what the packs declare            */
/* ====================================================================== */

test('every rule hook in every pack speaks the engine vocabulary', () => {
  const problems = [];
  for (const id of TEAM_IDS) {
    for (const hook of loadTeam(id).ruleHooks || []) {
      for (const p of describeHook(hook)) problems.push(`${id}/${hook.id}: ${p}`);
      if (!HOOK_TRIGGERS.includes(hook.trigger)) {
        problems.push(`${id}/${hook.id}: trigger "${hook.trigger}" is never fired`);
      }
      if (!(hook.effect?.type in HOOK_EFFECTS)) {
        problems.push(`${id}/${hook.id}: effect "${hook.effect?.type}" is not implemented`);
      }
      for (const cond of Object.keys(hook.condition || {})) {
        if (!HOOK_CONDITIONS.includes(cond)) {
          problems.push(`${id}/${hook.id}: condition "${cond}" fails closed`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every ploy hook in every pack speaks the engine vocabulary', () => {
  const problems = [];
  for (const id of TEAM_IDS) {
    const pack = loadTeam(id);
    for (const field of ['strategicPloys', 'firefightPloys']) {
      for (const ploy of pack[field] || []) {
        for (const hook of ploy.hooks || []) {
          for (const p of describeHook(hook)) problems.push(`${id}/${ploy.id}: ${p}`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every performable unique action declares an implemented effect and a reachable target', () => {
  const problems = [];
  for (const id of TEAM_IDS) {
    for (const profile of loadTeam(id).operatives || []) {
      for (const ability of profile.abilities || []) {
        const def = ability.action;
        if (!def) continue;
        const where = `${id}/${profile.id}/${ability.id}`;
        if (!UNIQUE_EFFECTS.includes(def.effect?.type)) {
          problems.push(`${where}: effect "${def.effect?.type}" is not implemented`);
        }
        const target = def.target;
        if (!target) continue;
        if (!TARGET_SCOPES.includes(target.scope || 'self')) {
          problems.push(`${where}: target scope "${target.scope}" is unknown`);
        }
        for (const key of Object.keys(target)) {
          if (['scope', 'inches', 'visible'].includes(key)) continue;
          if (!TARGET_CONDITIONS.includes(key)) {
            problems.push(`${where}: target condition "${key}" is unknown`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every resource economy speaks the engine vocabulary', () => {
  const problems = [];
  for (const id of TEAM_IDS) {
    for (const [key, def] of Object.entries(loadTeam(id).resources || {})) {
      for (const p of describeResource(key, def)) problems.push(`${id}: ${p}`);
      for (const gain of def.gains || []) {
        if (!(gain.trigger in RESOURCE_GAIN_TRIGGERS)) {
          problems.push(`${id}/${key}: gain trigger "${gain.trigger}" is not implemented`);
        }
      }
      for (const spend of def.spends || []) {
        if (!((spend.window || 'activation') in RESOURCE_SPEND_WINDOWS)) {
          problems.push(`${id}/${key}/${spend.id}: window "${spend.window}" is not implemented`);
        }
        if (!(spend.effect?.type in RESOURCE_SPEND_EFFECTS)) {
          problems.push(`${id}/${key}/${spend.id}: effect "${spend.effect?.type}" is not implemented`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

/* ====================================================================== */
/* Data validity, for every pack, every run                                */
/* ====================================================================== */

test('every bundled team pack validates without errors', () => {
  const failures = [];
  for (const id of TEAM_IDS) {
    const report = validateTeamPack(loadTeam(id));
    if (!report.ok) failures.push(`${id}: ${report.errors.join('; ')}`);
  }
  assert.deepEqual(failures, []);
});

test('a pack claiming faction rules wires at least one of them', () => {
  // The same check the validator warns about, pinned here as a list so the
  // remaining gaps are visible and shrink rather than grow. Any pack NOT on
  // this list must carry a hook or a resource economy.
  const KNOWN_GAPS = new Set([
    'battleclade',            // NETWORK COUNTERACT: no second counteraction exists
    'blades-of-khaine',       // ASPECT TECHNIQUEs are not transcribed into the pack
    'elucidian-starstrider',  // Warrant of Trade / support assets are pre-battle picks
    'inquisitorial-agent',    // Inquisitorial Requisition is a roster rule, not a runtime one
  ]);
  const unexpected = [];
  for (const id of TEAM_IDS) {
    const pack = loadTeam(id);
    if ((pack.supportLevel ?? 0) < 3) continue;
    const wired = (pack.ruleHooks || []).length || Object.keys(pack.resources || {}).length;
    if (!wired && !KNOWN_GAPS.has(id)) unexpected.push(id);
  }
  assert.deepEqual(unexpected, [],
    'these packs claim faction-rule support but wire nothing; add a hook or add them to KNOWN_GAPS with a reason');
});

test('a pack claiming operative abilities performs at least one of them', () => {
  const KNOWN_GAPS = new Set([
    'blades-of-khaine',    // no abilities transcribed at all
    'deathwatch',          // no abilities transcribed at all
    'gellerpox-infected',  // no abilities transcribed at all
    'legionary',           // GRISLY MARK places a floor marker; no marker vocabulary
    'legionary-warband',
    'wrecka-krew',         // BREAK STUFF rewrites a terrain feature
  ]);
  const unexpected = [];
  for (const id of TEAM_IDS) {
    const pack = loadTeam(id);
    if ((pack.supportLevel ?? 0) < 3) continue;
    const { declared, performable } = uniqueActionSupport(pack);
    if (declared && !performable && !KNOWN_GAPS.has(id)) unexpected.push(id);
  }
  assert.deepEqual(unexpected, [],
    'these packs print unique actions but none carry an "action" block; wire one or add them to KNOWN_GAPS with a reason');
});
