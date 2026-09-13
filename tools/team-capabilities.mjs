/**
 * What a team pack can actually DO, as a set of stable strings.
 *
 * A pure reader, deliberately free of side effects: `make-team-manifest.mjs`
 * writes the inventory with it and `test/team-capabilities.test.mjs` reads the
 * live packs with it, and the test would be worthless if importing it rewrote
 * the file it is checking against.
 *
 * Only playable things are listed. A rule a pack carries as reference text —
 * printed prose with no hook, no `action` block, no effect — is deliberately
 * absent, because this inventory exists to stop implemented behaviour from
 * disappearing, not to count transcription.
 */

/** A hook as one stable string: what fires it, and what it does. */
function hookKey(hook) {
  return `${hook.id}|${hook.trigger}|${hook.effect?.type}`;
}

export function capabilitiesOf(pack) {
  const uniqueActions = [];
  for (const profile of pack.operatives || []) {
    for (const ability of profile.abilities || []) {
      if (!ability.action) continue;
      uniqueActions.push(`${profile.id}/${ability.id}|${ability.action.effect?.type}`);
    }
  }

  const ployHooks = [];
  for (const field of ['strategicPloys', 'firefightPloys']) {
    for (const ploy of pack[field] || []) {
      for (const hook of ploy.hooks || []) {
        ployHooks.push(`${ploy.id}|${hook.trigger}|${hook.effect?.type}`);
      }
    }
  }

  const resourceSpends = [];
  for (const [key, def] of Object.entries(pack.resources || {})) {
    for (const spend of def.spends || []) {
      resourceSpends.push(`${key}/${spend.id}|${spend.window || 'activation'}|${spend.effect?.type}`);
    }
  }

  const weaponRules = Object.entries(pack.weaponRules || {})
    .filter(([, rule]) => rule?.effect?.type)
    .map(([name, rule]) => `${name}|${rule.effect.type}`);

  return {
    supportLevel: pack.supportLevel ?? 0,
    ruleHooks: (pack.ruleHooks || []).map(hookKey).sort(),
    resources: Object.keys(pack.resources || {}).sort(),
    resourceSpends: resourceSpends.sort(),
    uniqueActions: uniqueActions.sort(),
    ployHooks: ployHooks.sort(),
    weaponRules: weaponRules.sort(),
    controlModifiers: (pack.controlModifiers || []).map((m) => m.id).sort(),
  };
}
