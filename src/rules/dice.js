/**
 * Attack and defence dice resolution — shared by shooting and fighting.
 *
 * Kill Team dice model:
 *   - Roll ATK dice, each >= Hit is a success; a 6 is a CRITICAL success.
 *   - Defender rolls defence dice against its Save; 6s are critical saves.
 *   - Normal saves cancel normal hits 1:1.
 *   - Critical saves cancel a critical hit, or two normal hits.
 *   - Survivors deal Normal / Critical damage.
 */
import { warnUnsupported } from '../state.js';

export const DEFENCE_DICE = 3;

/**
 * Weapon rules this engine actually implements. Anything else warns (#7).
 *
 * Keys are the rule NAME without its value, so one entry covers every x —
 * `lethal4` and `lethal5` both resolve here, as do `piercing1` and `piercing2`.
 * `parseRule` splits the trailing number off; `ruleSet` keys by name and keeps
 * the value, so nothing needs a per-value entry.
 */
export const WEAPON_RULES = {
  accurate: 'Retain x attack dice as normal successes without rolling them.',
  balanced: 'Re-roll one attack die.',
  ceaseless: 'Re-roll any attack dice that rolled 1.',
  relentless: 'Re-roll any attack dice.',
  lethal: 'Successes of x or more are critical successes (Lethal x+). Default 5.',
  rending: 'If you retain a critical hit, one normal hit becomes critical.',
  punishing: 'If you retain a critical hit, one failed die becomes a normal hit.',
  ap: 'The defender collects x fewer defence dice. Default 1.',
  piercing: 'The defender collects x fewer defence dice. Default 1.',
  piercingcrits: 'As Piercing x, but only if you retain a critical hit. Default 1.',
  brutal: 'Defender may only parry with critical successes.',
  severe: 'If no critical hits are retained, one normal hit becomes critical.',
  devastating: 'Each retained critical hit immediately inflicts x damage, ignoring saves.',
  saturate: 'Target cannot retain cover saves.',
  shock: 'The first critical success you strike with also discards one of the defender\'s successes.',
  stun: 'If you retain any critical successes, the target loses 1 APL until the end of its next activation.',
  blast: 'Also resolved against every other operative visible to the attacker and within x" of the target.',
  torrent: 'Also resolved against any other valid target within x" of the primary target.',
  heavy: 'Cannot be used in an activation in which the operative moved, and vice versa. `heavy:dash` / `heavy:reposition` permit that one move.',
  hot: 'After use, roll a D6; below the weapon\'s Hit stat the operative suffers twice the result.',
  limited: 'Usable x times per battle. Defaults to 1.',
  silent: 'The Shoot action may be performed with this weapon while on a Conceal order.',
  seek: 'The target cannot use terrain for cover when being selected.',
  seeklight: 'The target cannot use Light terrain for cover when being selected.',
  psychic: 'Marks the weapon as PSYCHIC. No effect on its own; rules that key off it are not implemented.',
};

/**
 * Parse a rule token into {name, value, qualifier}.
 *
 * `devastating3` -> value 3. `heavy:dash` -> qualifier "dash", for the rules
 * whose printed wording names an action rather than a number.
 */
export function parseRule(rule) {
  const m = /^([a-z]+?)(\d+)?(?::([a-z_]+))?$/.exec(String(rule).toLowerCase());
  if (!m) return { name: String(rule).toLowerCase(), value: null, qualifier: null };
  return { name: m[1], value: m[2] ? Number(m[2]) : null, qualifier: m[3] || null };
}

/** Every rule on a weapon, keyed by name, with its value and qualifier. */
export function ruleMap(weapon) {
  const map = new Map();
  for (const r of weapon.rules || []) {
    const { name, value, qualifier } = parseRule(r);
    map.set(name, { value, qualifier });
  }
  return map;
}

export function hasWeaponRule(weapon, name) {
  return ruleMap(weapon).has(name);
}

function ruleSet(weapon) {
  const map = new Map();
  for (const [name, info] of ruleMap(weapon)) map.set(name, info.value);
  return map;
}

export function validateWeaponRules(state, weapon) {
  for (const r of weapon.rules || []) {
    const { name, value } = parseRule(r);
    const key = value !== null && WEAPON_RULES[`${name}${value}`] ? `${name}${value}` : name;
    if (!(key in WEAPON_RULES)) {
      warnUnsupported(state, `weapon-rule:${r}`, `${weapon.name} has unimplemented rule "${r}"`);
    }
  }
}

/**
 * Roll and retain attack dice.
 * @returns {{rolls:number[], rerolled:number[], normals:number, crits:number, misses:number}}
 */
export function rollAttack(rng, weapon, { hitModifier = 0 } = {}) {
  const rules = ruleSet(weapon);
  const hitOn = Math.max(2, Math.min(6, weapon.hit + hitModifier));
  // ruleSet keys by name, so "lethal4" and "lethal5" both land on `lethal`.
  const critOn = rules.has('lethal') ? (rules.get('lethal') || 5) : 6;

  // Accurate x: keep x dice aside as automatic normal successes and roll the
  // rest. Taking the retention is always at least as good as rolling for it.
  const accurate = Math.min(rules.get('accurate') || (rules.has('accurate') ? 1 : 0), weapon.atk);
  let rolls = rng.rollDice(weapon.atk - accurate);
  const rerolled = [];

  const reroll = (predicate, limit = Infinity) => {
    let used = 0;
    rolls = rolls.map((d) => {
      if (used >= limit || !predicate(d)) return d;
      used++;
      const nd = rng.d6();
      rerolled.push({ from: d, to: nd });
      return nd;
    });
  };

  if (rules.has('relentless')) reroll((d) => d < hitOn);
  else if (rules.has('ceaseless')) reroll((d) => d === 1);
  if (rules.has('balanced')) reroll((d) => d < hitOn, 1);

  // A die must be a success before it can be a critical success, so a weapon
  // with Lethal 4+ fired at Hit 5+ still crits only on 5s and 6s.
  const critAt = Math.max(critOn, hitOn);
  let crits = rolls.filter((d) => d >= critAt).length;
  let normals = rolls.filter((d) => d >= hitOn && d < critAt).length + accurate;
  let misses = rolls.length - crits - (normals - accurate);

  if (rules.has('rending') && crits >= 1 && normals >= 1) { normals--; crits++; }

  // Severe only fires when nothing critted, so Rending above can never have
  // run first. Punishing and Rending explicitly do not trigger off the
  // critical that Severe creates — Devastating and Piercing Crits still do.
  let severeUsed = false;
  if (rules.has('severe') && crits === 0 && normals >= 1) {
    normals--; crits++; severeUsed = true;
  }
  if (rules.has('punishing') && !severeUsed && crits >= 1 && misses >= 1) {
    misses--; normals++;
  }

  return { rolls, rerolled, normals, crits, misses, hitOn, critOn: critAt, accurate };
}

/**
 * Roll defence dice.
 *
 * Piercing x always removes dice; Piercing Crits x only bites when the attack
 * actually retained a critical hit, so the caller must pass `attackCrits` from
 * the attack roll it just made. The two are separate rules and can co-exist on
 * one weapon.
 *
 * @param {boolean} inCover retains one normal save without rolling.
 * @param {number} attackCrits critical hits retained by the attack roll.
 */
export function rollDefence(rng, defender, weapon,
  { inCover = false, saveModifier = 0, attackCrits = 0, diceDelta = 0, rerolls = 0 } = {}) {
  const rules = ruleSet(weapon);
  let dice = DEFENCE_DICE + diceDelta;
  if (rules.has('ap')) dice -= rules.get('ap') || 1;
  if (rules.has('piercing')) dice -= rules.get('piercing') || 1;
  if (rules.has('piercingcrits') && attackCrits > 0) {
    dice -= rules.get('piercingcrits') || 1;
  }
  dice = Math.max(0, dice);

  const coverApplies = inCover && !rules.has('saturate');
  const rolledCount = coverApplies ? Math.max(0, dice - 1) : dice;
  const rolls = rng.rollDice(rolledCount);
  const saveOn = Math.max(2, Math.min(6, defender.save + saveModifier));

  // A granted re-roll is only ever spent on a die that failed to save.
  const rerolled = [];
  for (let i = 0, spent = 0; i < rolls.length && spent < rerolls; i++) {
    if (rolls[i] >= saveOn) continue;
    const nd = rng.d6();
    rerolled.push({ from: rolls[i], to: nd });
    rolls[i] = nd;
    spent++;
  }

  let crits = rolls.filter((d) => d === 6).length;
  let normals = rolls.filter((d) => d >= saveOn && d < 6).length;
  if (coverApplies && dice > 0) normals++; // retained cover save

  return { rolls, rerolled, normals, crits, saveOn, dice, coverSave: coverApplies && dice > 0 };
}

/**
 * Cancel hits with saves and total the damage that gets through.
 */
export function resolveSaves(attack, defence, weapon) {
  const rules = ruleSet(weapon);
  let normalHits = attack.normals;
  let critHits = attack.crits;
  let normalSaves = defence.normals;
  let critSaves = defence.crits;

  // Shock: the first critical success the attacker strikes with also discards
  // one of the defender's unresolved successes — a normal one where there is
  // one. The attacker resolves first, so it lands before anything is blocked.
  let shockDiscarded = null;
  if (rules.has('shock') && critHits > 0) {
    if (normalSaves > 0) { normalSaves--; shockDiscarded = 'normal'; }
    else if (critSaves > 0) { critSaves--; shockDiscarded = 'critical'; }
  }

  // Critical saves cancel a critical hit first, else two normal hits.
  while (critSaves > 0 && critHits > 0) { critSaves--; critHits--; }
  while (critSaves > 0 && normalHits >= 2) { critSaves--; normalHits -= 2; }
  while (critSaves > 0 && normalHits > 0) { critSaves--; normalHits--; }
  while (normalSaves > 0 && normalHits > 0) { normalSaves--; normalHits--; }

  const devastating = rules.has('devastating') ? (rules.get('devastating') || 0) : 0;

  const damage =
    normalHits * weapon.damage.normal +
    critHits * weapon.damage.critical +
    attack.crits * devastating; // devastating ignores saves

  return {
    damage,
    unsavedNormals: normalHits,
    unsavedCrits: critHits,
    devastatingDamage: attack.crits * devastating,
    shockDiscarded,
  };
}
