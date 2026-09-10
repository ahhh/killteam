# Kill Team Battle Simulator

A deterministic, data-driven skirmish battle simulator that runs as a **static
single-page app** — no backend, no build step, no framework.

Pick two kill teams, pick a battlefield, enter a seed, and watch a complete
four-turning-point battle play out with legal movement, shooting, fighting,
objectives and scoring. The same seed always produces the same battle, so any
result can be reproduced, shared and audited.

## Disclaimer

This is an unofficial, non-commercial fan-made simulation project. It is not
affiliated with, sponsored by, endorsed by, or approved by Games Workshop.
Warhammer 40,000, Kill Team, faction names, and related marks and game
materials are the property of their respective owners. The project uses
original interface artwork and does not reproduce official miniature
photography or illustrations. Rules references and compatibility information
are provided for identification and educational/simulation purposes only.
Where official rules data is required, users should consult the current
official Games Workshop sources.

**Bundled rules data.** Six teams (`vanguard-*`, `ash-cultists`,
`corsair-skirmishers`, `scrap-raiders`, `skycaste-marksmen`) are original
synthetic demo teams written for this engine — invented stat lines. The other
48 under `data/teams/` were transcribed from [Wahapedia](https://wahapedia.ru/kill-team3/)
in September 2026 and carry their source URL in each pack's `source` block.
Those are reproduced for simulation and reference only; Games Workshop holds
the rights, and the official downloads are authoritative for actual play. This
goes further than the repository policy in `plan.md` §3, which anticipated that
real rule data would be loaded locally rather than committed.

## Run it

The app loads its data with `fetch()`, which browsers block on `file://` URLs,
so serve the folder over HTTP:

```bash
npm start           # python3 -m http.server 8000
# then open http://localhost:8000
```

## Develop

```bash
npm test            # 31 unit, fixture, determinism, AI and replay tests
npm run test:data   # validate every bundled team, map and mission
npm run smoke       # run one battle headlessly and print the result
npm run batch 60 vanguard-wardens scrap-raiders   # batch balance harness
```

Everything runs on plain Node ≥ 20. There are no dependencies.

## How it fits together

```
src/
  rng.js              seeded PRNG — the only source of randomness
  state.js            serializable battle state + event log
  rules/
    engine.js         legal action generation and the action resolver
    phases.js         turning-point state machine (deploy → TP1-4 → result)
    movement.js       legality, collision, visibility-graph pathing
    visibility.js     line of sight, cover, control range
    shooting.js       ranged attack resolution
    fighting.js       melee resolution (strike / parry)
    dice.js           attack + defence dice, dice-level weapon rules
    weapon-rules.js   Heavy, Limited, Silent, Seek, Hot, Blast, Torrent, Stun
    team-rules.js     the asterisked, team-specific weapon rules
    tokens.js         Poison, Blaze, Mindburn and the rest of the token family
    objectives.js     objective control and mission scoring
    effects.js        damage, incapacitation, injured and stunned states
    terrain.js        terrain traits
  ai/
    controller.js     utility AI: enumerates plans, scores, produces intent
    utility.js        analytic estimators (no RNG consumed while thinking)
    targeting.js      target selection from a hypothetical position
    movement.js       candidate destination generation
  data/               schema, validators, loader
  maps/geometry.js    all geometry, in inches
  replay/             replay capture, verification, batch harness
  ui/                 SVG battlefield, roster panels, log, setup, controls
  app.js              the only module that touches the DOM
```

### Architectural invariants

These are enforced by tests, not just convention:

1. The engine never reads the DOM.
2. The UI never decides whether an action is legal.
3. The AI never mutates state directly — it produces intent, the engine validates it.
4. All randomness goes through the seeded RNG.
5. Maps and teams are data, not UI code.
6. Every imported rule reference carries source and version metadata.
7. Unsupported rules are reported, never silently guessed.
8. Third-party integrations are optional adapters.
9. Official artwork is not required for the app to look complete.
10. A battle can be serialized and replayed.

## Determinism

Every die roll comes from one `mulberry32` stream seeded by a stable string
hash. The AI scores plans with closed-form expectation so that *thinking*
never consumes dice, and breaks ties on a derived stream so tie-breaks can't
disturb the battle sequence. A battle reproduces exactly given identical
engine version, AI version, data versions, map and seed — verified by
`test/determinism.test.mjs` and `test/replay.test.mjs`.

## Loading your own data

Adding a team, map or mission requires **no engine or UI changes**. Drop JSON
into `data/`, or import it at runtime through **Teams… → Load your own rule
pack**. Packs are validated before use and rejected loudly if malformed;
nothing in a pack is ever executed. See `docs/rule-pack-format.md`.

`data/reference-teams.json` is the catalogue: it maps every team name to its
bundled rule pack and its Wahapedia source URL. It carries no stats itself.

## Current status

Milestones 0–6 of `plan.md` are implemented and tested:

- ✅ Skeleton, state store, seeded RNG, battle log
- ✅ SVG board, terrain, movement, pathing, map loader
- ✅ Core combat: orders, shooting, fighting, wounds, LOS, cover, charge, fall back
- ✅ Turn engine: deployment, initiative, alternating activations, CP, Counteract
- ✅ Objectives, mission scoring, utility AI with explainable reasons
- ✅ Two mission modes: objective play, and a last-team-standing deathmatch
- ✅ Three maps: an industrial yard, a space-hulk corridor lattice, a jungle temple
- ✅ Rule-pack loader, validators, compatibility badges, runtime import
- ✅ Replay capture and verification, batch balance harness

Not yet built: procedural map generation (Milestone 6's generator), the
Mapforge adapter (Milestone 7), and ploys/equipment/operative abilities.

Faction rules now run through a declarative `ruleHooks` layer — 13 rules across
11 teams, which declare `supportLevel: 3`. The other 37 transcribed teams carry
their faction rules, ploys, equipment and unique actions as reference data only
and stay at `supportLevel: 1`.

Weapon rules resolve in two layers. Every **universal** rule from the appendix
is the engine's own, because those mean the same thing on every datasheet. The
**asterisked, team-specific** ones cannot be — *Poison* costs 1 damage per
activation for Plague Marines and D3 for Raveners — so each pack declares its
own reading in a `weaponRules` block, from a fixed effect vocabulary. Every
rule token in every bundled pack is now either universal or declared: 46
distinct team rules across 34 teams.

Rules that are only half-implemented are marked `partial` in the pack and say
so in the battle log; three weapons whose enabling markers or actions do not
exist refuse to fire at all, with a stated reason, rather than guessing. See
`docs/implemented-rules.md` for the exact inventory.

### Known balance caveat

The batch harness reports that the bundled `skycaste-marksmen` gunline beats
the melee-oriented demo teams around 90% of the time. That is a property of the
invented demo stat lines and of AI passivity at long range — not evidence about
any real game. Batch results are for catching regressions and map bias, as
`src/replay/batch.js` says in its own report.
