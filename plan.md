# Kill Team Battle Simulator — Implementation Plan

## 1. Project goal

Build a **single-page, static HTML/JavaScript application** that can simulate Warhammer 40,000: Kill Team battles between preconfigured teams.

The app should:

- Let the user choose a **faction**, then a **Kill Team / sub-team** within that faction.
- Show the roster and operative profiles for both sides.
- Load a battlefield from a modular map system.
- Auto-play a complete battle using deterministic dice and a basic AI.
- Follow the current Kill Team rules as closely as the implemented rules engine allows.
- Explain what the simulator is doing through a battle log and inspectable game state.
- Be easy to extend with new teams, balance updates, missions, terrain sets, and maps.
- Use **original UI, tokens, terrain graphics, and visual design** rather than Games Workshop artwork.

This is a simulation/reference project, not a replacement for the official game, books, app, miniatures, or downloadable rules.

---

## 2. Non-goals for the first version

Do **not** make the MVP depend on:

- Multiplayer networking.
- User accounts or a backend.
- A full 3D renderer.
- Every Kill Team ever released.
- Every team-specific ploy, equipment option, mission rule, FAQ, and edge case on day one.
- Scraping Games Workshop pages/PDFs at runtime.
- Any undocumented third-party map API.
- Games Workshop illustrations, miniature photos, card layouts, backgrounds, or other official art assets.

The first target is a trustworthy, deterministic simulator for a curated subset of teams using a clearly defined rules subset.

---

## 3. IP guardrails

### Repository policy

The public project should contain:

- Original code.
- Original UI graphics.
- Original geometric/symbolic unit tokens.
- Original/generated terrain graphics that do not imitate protected GW artwork.
- Team/faction names only as needed to identify compatibility/reference subject to trademark rules.
- Source URLs and version metadata.
- A generic rule-pack schema.
- Optional locally loaded rule packs.

During development, the application can use manually entered test data sourced from the current official rules.

### Preferred production data strategy

Separate **the engine** from **the rule data**.

The engine should be capable of:

1. Shipping with synthetic/demo data.
2. Loading local JSON rule packs.
3. Loading a separately maintained, legally approved rules dataset if one is available.
4. Linking users to the official current source for each team.

This prevents the application architecture from depending on redistributing Games Workshop content.

### Suggested disclaimer

> This is an unofficial, non-commercial fan-made simulation project. It is not affiliated with, sponsored by, endorsed by, or approved by Games Workshop. Warhammer 40,000, Kill Team, faction names, and related marks and game materials are the property of their respective owners. The project uses original interface artwork and does not reproduce official miniature photography or illustrations. Rules references and compatibility information are provided for identification and educational/simulation purposes only. Where official rules data is required, users should consult the current official Games Workshop sources. 

Have this disclaimer visible in an **About** modal and linked from the footer.

---

## 4. Verified reference sources

Use the official rules pages as the primary source of truth and record the source/version for every imported rule pack.

Current useful references:

- Official Kill Team downloads:
  https://www.warhammer-community.com/en-gb/downloads/kill-team/
- Official Kill Team Lite Rules:
  https://assets.warhammer-community.com/rules-downloads/kill-team/key-downloads/kill-team-lite-rules/killteam_keydownloads_literules_eng_02.10.24.pdf
- Warhammer Community Terms of Use:
  https://www.warhammer-community.com/en-gb/terms-of-use/
- Experimental procedural map source:
  https://maps.dnd5e.lockboxx.org/

The official Kill Team download page should be checked whenever team data is updated, because Games Workshop publishes balance/rules updates online.

---

## 5. Recommended technology

Keep the application deployable as a static site.

### Core

- `index.html`
- modern ES modules
- vanilla JavaScript for the first implementation
- CSS custom properties for theming
- SVG for the battlefield and tokens
- JSON for rule packs and maps
- `localStorage` for preferences, last teams, seeds, and saved custom maps

A build tool is optional. The project should still be understandable without a framework.

### Why SVG for the battlefield

SVG is a good fit because the board contains a relatively small number of objects and needs:

- exact coordinates in inches
- terrain polygons
- objective circles
- token labels
- movement paths
- line-of-sight rays
- range indicators
- easy click/hover inspection
- pan/zoom transforms

If performance later becomes a problem, the renderer can be swapped for Canvas while keeping the simulation engine unchanged.

---

## 6. Suggested project structure

```text
/
├─ index.html
├─ plan.md
├─ README.md
├─ src/
│  ├─ app.js
│  ├─ state.js
│  ├─ rng.js
│  ├─ rules/
│  │  ├─ engine.js
│  │  ├─ phases.js
│  │  ├─ movement.js
│  │  ├─ shooting.js
│  │  ├─ fighting.js
│  │  ├─ visibility.js
│  │  ├─ terrain.js
│  │  ├─ objectives.js
│  │  └─ effects.js
│  ├─ ai/
│  │  ├─ controller.js
│  │  ├─ utility.js
│  │  ├─ movement.js
│  │  └─ targeting.js
│  ├─ data/
│  │  ├─ schema.js
│  │  ├─ loader.js
│  │  └─ validators.js
│  ├─ maps/
│  │  ├─ loader.js
│  │  ├─ generator.js
│  │  ├─ geometry.js
│  │  └─ adapters/
│  │     └─ mapforge.js
│  ├─ ui/
│  │  ├─ setup.js
│  │  ├─ battlefield.js
│  │  ├─ inspector.js
│  │  ├─ combat-log.js
│  │  └─ controls.js
│  └─ replay/
│     ├─ recorder.js
│     └─ playback.js
├─ data/
│  ├─ teams/
│  ├─ factions.json
│  ├─ missions/
│  └─ maps/
└─ assets/
   ├─ tokens/
   └─ terrain/
```

The UI is still one browser page; these are implementation modules, not separate pages.

---

## 7. Main user flow

1. Open the app.
2. Select **Player A faction**.
3. Select one of that faction's available **Kill Teams**.
4. Select **Player B faction** and Kill Team.
5. Open either team in the inspector to view/edit:
   - roster composition
   - operative stats
   - weapons
   - supported abilities
   - rules-source/version metadata
6. Choose a mission/map:
   - built-in map
   - generated map
   - seeded map
   - imported map JSON
   - optional Mapforge-derived map
7. Enter or randomize a battle seed.
8. Click **Simulate**.
9. Watch the battle animate step by step, or run at 1x/4x/instant.
10. Inspect:
    - current turning point/phase
    - initiative
    - CP
    - operative status
    - objectives
    - dice
    - chosen AI action and reason
    - combat log
11. End on a result screen with victory points, casualties, seed, and replay/export controls.

---

## 8. Factions and Kill Teams

Represent faction and team as separate concepts.

Example initial catalog, subject to checking the latest official rules before implementation:

```text
Imperium
├─ Space Marines
│  └─ Angels of Death
├─ Astra Militarum
│  └─ Kasrkin
└─ Imperial Agents
   └─ Inquisitorial Agents

Chaos
├─ Heretic Astartes
│  └─ Legionaries
└─ Traitor Guard
   └─ Blooded

Aeldari
├─ Corsairs
│  └─ Corsair Voidscarred
└─ Aspect Warriors
   └─ Blades of Khaine

Orks
└─ Kommandos

T'au Empire
└─ Pathfinders
```

This list is a seed catalog, not a claim that every listed team remains tournament-classified at the time of implementation.

Each faction entry should be data-driven so adding a team requires no UI code changes.

---

## 9. Rule-pack data model

Do not hard-code team rules into the simulator engine.

Example shape:

```js
{
  id: "kasrkin",
  factionId: "astra-militarum",
  displayName: "Kasrkin",
  edition: "current",
  dataVersion: "2026-09-checked",
  source: {
    publisher: "Games Workshop",
    url: "https://...",
    checkedAt: "2026-09-09",
    notes: "Official Kill Team download"
  },

  roster: {
    maxOperatives: 0,
    selectionRules: []
  },

  operatives: [
    {
      id: "operative-id",
      name: "Operative",
      stats: {
        move: 0,
        apl: 0,
        save: 0,
        wounds: 0
      },
      weapons: [],
      abilities: [],
      keywords: []
    }
  ],

  strategicPloys: [],
  firefightPloys: [],
  equipment: [],
  ruleHooks: []
}
```

Numeric values above are placeholders, not official stats.

### Why `ruleHooks` exists

Special team rules will eventually need executable behavior.

Use declarative hooks where possible:

```js
{
  trigger: "beforeAttackRoll",
  condition: { /* declarative predicate */ },
  effect: { /* declarative effect */ }
}
```

Only use custom JavaScript rule handlers for mechanics that cannot be represented declaratively.

---

## 10. Rule support levels

Every team/rule pack should declare its compatibility level.

```text
0 = metadata only
1 = core stats and basic weapons
2 = roster restrictions
3 = core operative abilities
4 = team ploys/equipment
5 = full supported team behavior
```

The setup screen should show a badge such as:

- `Core compatible`
- `Mostly supported`
- `Full engine support`
- `Experimental`

This is better than silently simulating unsupported rules incorrectly.

---

## 11. Core battle state

Keep all simulation state serializable.

```js
{
  version: 1,
  seed: "user-seed",
  rngIndex: 0,

  turningPoint: 1,
  phase: "strategy",
  initiativePlayerId: "p1",

  players: {
    p1: {
      teamId: "...",
      cp: 0,
      victoryPoints: 0
    },
    p2: {
      teamId: "...",
      cp: 0,
      victoryPoints: 0
    }
  },

  operatives: {
    "p1-op-1": {
      profileId: "...",
      x: 0,
      y: 0,
      woundsRemaining: 0,
      order: "conceal",
      ready: true,
      statuses: []
    }
  },

  objectives: [],
  effects: [],
  eventLog: []
}
```

Never let the UI become the source of truth. The UI renders this state.

---

## 12. Deterministic random number generator

A seeded RNG is essential.

Use a small deterministic PRNG such as `mulberry32`, `sfc32`, or similar, seeded through a stable string hash.

Every random result must pass through one RNG service:

```js
rng.d6()
rng.pick(array)
rng.shuffle(array)
```

Do not call `Math.random()` inside the game engine.

Benefits:

- reproduce a battle exactly
- share a seed
- debug incorrect rules
- compare AI versions on the same battle
- replay simulations
- batch-run thousands of matches for balance analysis

Store both:

- `battleSeed`
- ordered RNG/event sequence

---

## 13. Rules engine

Implement the engine as a deterministic state machine.

### Initial supported loop

```text
SETUP
  ↓
TURNING POINT 1
  ├─ Strategy phase
  └─ Firefight phase
       ├─ choose operative
       ├─ choose order
       ├─ spend AP on legal actions
       ├─ resolve action
       └─ alternate players
  ↓
TURNING POINT 2
  ...
  ↓
TURNING POINT 4
  ↓
SCORE / RESULT
```

### MVP core mechanics

Implement first:

- operative placement
- initiative
- turning points
- ready/expended state
- Engage/Conceal
- action points
- Reposition
- Dash
- Charge
- Fall Back
- Shoot
- Fight
- simple objective control
- attack dice
- defense dice
- normal/critical results
- wounds/incapacitation
- cover
- basic visibility/line of sight
- command re-roll
- CP tracking
- Counteract
- mission scoring

Keep each mechanic isolated behind functions such as:

```js
getLegalActions(state, operativeId)
resolveAction(state, action)
resolveShoot(state, attackerId, targetId, weaponId)
resolveFight(state, attackerId, targetId, weaponId)
```

The action resolver should reject illegal actions even if the AI asks for them.

---

## 14. Rules fidelity strategy

Trying to reproduce the entire tabletop ruleset immediately will make the project brittle.

Build in layers.

### Phase A — Lite/core rules

Use the official Lite Rules as the implementation baseline.

Goal:

> A battle using simple profiles and weapons can complete correctly and deterministically.

### Phase B — terrain and missions

Add:

- terrain categories
- visibility
- cover
- movement around/over terrain
- deployment zones
- objective markers
- victory-point scoring

### Phase C — team rules

Add team-specific behavior one team at a time.

Every special rule gets:

1. a fixture
2. a rules-engine test
3. a source/version note
4. an AI usage rule if it requires a decision

### Unsupported mechanics

Never invent an outcome silently.

If a rule is encountered but not implemented:

```text
[WARN] Unsupported rule: <rule-id>.
Simulation continued without this modifier.
```

Optionally let the user configure:

- `continue with warning`
- `stop on unsupported rule`

---

## 15. Geometry model

Use **inches as the engine's canonical coordinate unit**.

The renderer maps inches to SVG pixels.

Example:

```js
const board = {
  width: 30,
  height: 22,
  units: "inches"
};
```

Keep board dimensions configurable for missions that use another size.

### Base model

Each operative has:

```js
{
  x: 12.5,
  y: 7.25,
  baseDiameter: 1.25
}
```

Movement and control range should use base-edge geometry, not token-center-only approximations.

---

## 16. Visibility / line of sight

Create one geometry service instead of scattering LOS checks throughout combat code.

Responsibilities:

- line segment intersection
- base-to-base distance
- terrain polygon intersection
- cover checks
- visibility tests
- control range
- path collision
- nearest legal destination

Expose functions such as:

```js
distanceBetweenBases(a, b)
hasLineOfSight(state, observerId, targetId)
hasCover(state, targetId, attackerId)
isPositionLegal(state, operativeId, x, y)
```

Keep terrain traits in data rather than special-casing visual asset names.

---

## 17. Terrain model

Each terrain object should have a simple physics/rules representation separate from its appearance.

```js
{
  id: "ruin-01",
  shape: {
    type: "polygon",
    points: [...]
  },
  height: 2.5,
  traits: [
    "heavy",
    "obscuring",
    "traversable"
  ],
  render: {
    styleId: "industrial-wall"
  }
}
```

The terrain renderer can change without changing combat behavior.

---

## 18. Map format

Define a first-party JSON format.

```js
{
  id: "industrial-001",
  name: "Industrial Crossfire",
  version: 1,
  seed: "optional-seed",

  board: {
    width: 30,
    height: 22
  },

  terrain: [],
  objectives: [],
  deploymentZones: [],
  metadata: {
    author: "",
    license: "",
    sourceUrl: ""
  }
}
```

Maps can be:

- hand-authored JSON
- generated from a seed
- imported
- exported
- converted by adapters

The simulation should never depend on a background image to determine terrain rules.

---

## 19. Built-in procedural map generator

Create a simple deterministic generator so the project always has a reliable map source.

Input:

```js
generateMap({
  seed: "hive-7782",
  theme: "industrial",
  width: 30,
  height: 22,
  density: 0.55,
  symmetry: "soft"
})
```

Generation steps:

1. Seed RNG.
2. Place deployment zones.
3. Reserve objective areas.
4. Place several large LOS blockers.
5. Place medium cover.
6. Place light/traversable pieces.
7. Validate paths between deployment areas/objectives.
8. Reject obviously trapped or overlapping terrain.
9. Score map symmetry and objective accessibility.
10. Retry deterministically if validation fails.

The visual theme should be independent of collision/rules geometry.

---

## 20. Mapforge / `maps.dnd5e.lockboxx.org` integration

The currently visible Mapforge UI supports:

- theme
- seed
- map size
- generation
- save/load
- link
- grid
- export

Do **not** assume a public API exists until one is documented or inspected and its use is permitted.

Implement a `MapAdapter` interface:

```js
class MapAdapter {
  canImport(input) {}
  async import(input) {}
  export(map) {}
}
```

Potential Mapforge integration paths, in preferred order:

1. Import a documented share/export format.
2. Accept a user-pasted Mapforge share link and decode documented parameters.
3. Import an exported image as a **visual background only**, while the user separately defines terrain geometry.
4. Add a direct API adapter only if a stable, permitted API is identified.

The core simulator must still work when Mapforge is offline.

---

## 21. AI design

Start with a **utility AI**, not a neural network.

For every activation:

1. Generate legal actions.
2. Generate candidate targets/destinations.
3. Score each candidate.
4. Choose the highest score.
5. Break close ties with seeded RNG.

Example utility model:

```text
score =
  expectedDamage * 3.0
+ objectiveGain * 4.0
+ survivalGain * 2.0
+ coverGain * 1.5
+ allySupport * 1.0
- exposureRisk * 2.5
- distanceWaste * 0.5
```

Different operative roles can use different weights.

### Basic roles

Infer or declare:

- assault
- ranged
- support
- objective runner
- sniper
- flexible

### AI priorities

In rough order:

1. perform legal actions only
2. complete mission objectives
3. attack high-value exposed enemies
4. preserve wounded/high-value operatives
5. seek useful cover
6. avoid wasting AP
7. use ploys/equipment when expected value is positive

---

## 22. AI action planning

Do not let AI directly mutate game state.

AI produces an intent:

```js
{
  operativeId: "p1-op-3",
  actions: [
    {
      type: "reposition",
      destination: { x: 8.2, y: 13.4 }
    },
    {
      type: "shoot",
      targetId: "p2-op-2",
      weaponId: "weapon-a"
    }
  ],
  rationale: [
    "Moves onto objective 2",
    "Maintains cover",
    "Target has highest expected damage value"
  ]
}
```

The rules engine validates and resolves that intent.

This makes AI bugs much easier to diagnose.

---

## 23. Explainability

The simulator should show why an action occurred.

Example log:

```text
TP2 / Firefight
Kasrkin Trooper activates.
AI considered 7 legal plans.
Selected: Reposition → Shoot.
Reason: +4 objective pressure, +3.2 expected damage, -1.1 exposure.
Trooper moves 4.7".
Trooper fires at Enemy Operative.
Attack dice: [...]
Defense dice: [...]
Result: 5 damage.
```

Do not reveal internal debugging noise by default. Add a **Developer log** toggle for detailed utility scores and geometry checks.

---

## 24. UI layout

Desktop layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ Top bar: Teams | Map | Seed | Speed | Simulate | Reset      │
├──────────────┬───────────────────────────────┬───────────────┤
│ Team A       │                               │ Team B        │
│ roster       │        Battlefield SVG        │ roster        │
│ CP / VP      │                               │ CP / VP       │
│ statuses     │                               │ statuses      │
├──────────────┴───────────────────────────────┴───────────────┤
│ Battle log / current action / dice                           │
└──────────────────────────────────────────────────────────────┘
```

Mobile/tablet:

- battlefield first
- side panels become drawers
- battle log becomes bottom sheet

---

## 25. Team/stat inspector

Selecting an operative opens a side panel.

Show only data the application's legal/data policy permits.

Possible fields:

- operative name
- core stats
- wounds remaining
- order
- AP state
- weapons
- weapon profiles
- implemented abilities
- implementation-support badge
- official source link
- data version / last checked date

Never recreate the visual layout of official datacards.

Use an original table/card design.

---

## 26. Simulation controls

Provide:

- Play
- Pause
- Step one action
- Step one activation
- 1x
- 2x
- 4x
- Instant
- Reset same seed
- New seed
- Copy replay seed
- Export battle log

A deterministic replay should reproduce the same game as long as:

- engine version
- data versions
- map
- AI version
- seed

are identical.

---

## 27. Replay format

```js
{
  replayVersion: 1,
  engineVersion: "0.1.0",
  aiVersion: "0.1.0",
  seed: "...",
  map: {...},
  teams: [...],
  dataVersions: {...},
  events: [...]
}
```

Prefer event replay over saving a screenshot/video.

Events might include:

```text
TURN_STARTED
OPERATIVE_ACTIVATED
ORDER_SELECTED
MOVE_RESOLVED
ATTACK_ROLLED
DAMAGE_APPLIED
OBJECTIVE_SCORED
OPERATIVE_INCAPACITATED
TURN_ENDED
GAME_ENDED
```

---

## 28. Rule-data validation

Every rule pack must be validated before a simulation starts.

Check:

- unique IDs
- required source metadata
- legal stat types/ranges
- roster references point to existing operatives
- weapon references exist
- every executable rule hook is known
- no duplicate hooks
- declared support level matches implemented features

Fail loudly on invalid data rather than letting bad profiles corrupt simulations.

---

## 29. Versioning and balance updates

Rules change.

Every team pack needs:

```text
dataVersion
sourceUrl
sourceDate
checkedAt
engineCompatibility
```

Never overwrite old data in replays.

A replay should say:

> This battle used Team Pack v2026-09-01. A newer data version is available.

If this becomes a public project, update data only after verifying the current official download.

---

## 30. Testing strategy

### Unit tests

Test:

- seeded RNG repeatability
- dice resolution
- damage
- movement distance
- control range
- collision
- LOS
- cover
- legal action generation
- AP spending
- turning-point transitions
- initiative
- scoring

### Rules fixtures

Store small scenarios:

```text
shooter-in-open-vs-target-in-open
shooter-vs-covered-target
charge-within-range
charge-out-of-range
fall-back-from-control-range
objective-contested
counteract-eligibility
```

Each fixture states expected legal actions and result constraints.

### Determinism test

```text
same engine + same data + same map + same seed
= identical event log
```

This should run automatically.

### AI sanity tests

Examples:

- AI should not walk off the board.
- AI should not choose illegal targets.
- AI should not charge when Charge is illegal.
- AI should prefer a reachable unclaimed objective over meaningless movement when no attack is available.
- AI should not continue using an incapacitated operative.

---

## 31. Simulation/balance test harness

Even though the product is a single-page app, add a developer mode that can run many battles in memory.

Example:

```text
Kasrkin vs Kommandos
Map set: balanced-01..05
Seeds: 1..1000
Result:
  Team A wins: 48.7%
  Team B wins: 49.9%
  Draw: 1.4%
```

This is primarily for detecting:

- broken team adapters
- map bias
- AI regressions
- rules-engine mistakes

It is **not** proof that the tabletop teams themselves are balanced because AI quality and incomplete rule support strongly affect results.

---

## 32. Accessibility

Include:

- keyboard-accessible controls
- visible focus states
- text labels in addition to color
- high-contrast mode
- reduced-motion option
- speed controls
- readable combat log
- semantic buttons
- SVG elements with accessible labels where practical

Do not rely on faction color alone to identify teams.

---

## 33. Performance targets

The first version should comfortably handle:

- 20–30 operative tokens
- 50–100 terrain shapes
- hundreds of logged events
- 4 turning points
- instant simulation without visible UI animation

Avoid expensive exhaustive pathfinding for every possible point on the board.

Use:

- candidate movement points
- spatial pruning
- cached geometry
- simple A*/visibility graph only when needed

---

## 34. Security / robustness

Because custom JSON can be loaded:

- never execute code from imported rule packs/maps
- use declarative data
- validate JSON schemas
- sanitize displayed text
- cap terrain/object counts
- cap polygon point counts
- reject impossible board dimensions
- do not fetch arbitrary remote JavaScript

If remote map/rule sources are supported later, explicitly allow-list formats and origins.

---

## 35. Milestones

### Milestone 0 — Skeleton

Deliver:

- `index.html`
- page layout
- module structure
- state store
- seeded RNG
- battle log
- original placeholder tokens

Acceptance:

- app loads from static hosting
- no backend required
- same seed produces same RNG output

### Milestone 1 — Board and movement

Deliver:

- SVG board
- terrain polygons
- token placement
- distance measurement
- Reposition/Dash
- deployment zones
- map JSON loader

Acceptance:

- tokens cannot leave board
- tokens cannot occupy illegal terrain/positions
- exact movement is logged

### Milestone 2 — Core combat

Deliver:

- Engage/Conceal
- shooting
- fighting
- wounds
- incapacitation
- basic LOS/cover
- charges/fall back

Acceptance:

- two synthetic teams can fight until one is eliminated

### Milestone 3 — Turn engine

Deliver:

- setup
- initiative
- Strategy/Firefight phases
- alternating activations
- CP
- rerolls
- Counteract
- four turning points

Acceptance:

- complete deterministic battle finishes without user input

### Milestone 4 — Objectives and AI

Deliver:

- objectives
- mission scoring
- utility AI
- role weights
- explainable action reasons

Acceptance:

- AI moves toward objectives and attacks legal targets
- match produces a winner and VP total

### Milestone 5 — Real team adapter

Deliver:

- generic rule-pack loader
- source/version metadata
- first legally approved/current team datasets
- team inspector
- compatibility badges

Acceptance:

- swapping team JSON requires no engine/UI modification

### Milestone 6 — Procedural maps

Deliver:

- built-in seeded generator
- validation
- map save/load
- map export/import

Acceptance:

- same seed/theme generates identical map
- generated map passes basic path/accessibility checks

### Milestone 7 — Mapforge adapter

Deliver only after confirming a stable permitted format:

- link/export importer
- background-image support if useful
- graceful fallback

Acceptance:

- simulator still works when third-party source is unavailable

### Milestone 8 — Replay and batch simulation

Deliver:

- event replay
- export/import replay
- instant mode
- batch test harness

Acceptance:

- imported replay reproduces the original outcome

---

## 36. Definition of MVP

The MVP is complete when a user can:

1. Open one static web page.
2. Choose from at least **4 factions** and at least **6 team presets**.
3. Inspect both selected teams.
4. Choose a built-in or seeded battlefield.
5. Enter a battle seed.
6. Start a fully automatic battle.
7. Watch legal movement, shooting, fighting, objectives, and turn progression.
8. See unsupported-rule warnings.
9. Review the final score and battle log.
10. Replay the exact battle from the same seed.
11. Load a new map JSON without changing application code.

For a public release, requirement #2 means either legally approved real rule data or metadata/presets that load user-supplied/local rule packs.

---

## 37. First implementation order

Recommended order for actual coding:

```text
1. RNG + serializable state
2. SVG board + geometry
3. map schema + one hand-built map
4. movement legality
5. attack/damage resolver
6. turning-point state machine
7. synthetic test teams
8. objectives/scoring
9. basic utility AI
10. replay/event log
11. team rule-pack schema
12. current real-data adapter after legal/source review
13. procedural seeded maps
14. optional Mapforge integration
15. special team rules one by one
```

This order avoids getting stuck on team-specific rules before the simulation core is trustworthy.

---

## 38. Architectural rules to keep

These should be treated as project invariants:

1. **The engine never reads the DOM.**
2. **The UI never decides whether an action is legal.**
3. **The AI never mutates state directly.**
4. **All randomness goes through the seeded RNG.**
5. **Maps and teams are data, not UI code.**
6. **Every imported official-rule reference has source/version metadata.**
7. **Unsupported rules are visible, never silently guessed.**
8. **Third-party integrations are optional adapters.**
9. **Official artwork is not required for the app to look complete.**
10. **A battle can be serialized and replayed.**

---

## 39. Nice-to-have features after MVP

- Human-vs-AI mode.
- AI-vs-AI tournament bracket.
- Side-by-side expected-damage calculator.
- Heat maps showing movement/threat ranges.
- LOS debugging overlay.
- Objective-pressure overlay.
- Multiple AI personalities.
- Custom roster builder.
- Custom operative editor.
- Community rule-pack import.
- Community map browser using openly licensed content.
- PWA/offline mode.
- Shareable URL containing team IDs, map ID, and seed.
- Screenshot/export of the final battlefield.
- Statistical matchup dashboard.
- Automated “rules pack is stale” warning based on version metadata.

---

## 40. Open questions / decisions for implementation

These do not block the architecture, but should be decided before polishing:

- Is the project strictly non-commercial?
- Which exact Kill Team edition/revision is the target?
- Which 6–10 teams should receive full support first?
- Will published builds include real transcribed stats, or require locally loaded rule packs?
- Will the project seek permission for faction icons, or use original text/symbol identifiers only?
- Which mission pack is the first scoring target?
- Does the first release need human-vs-AI, or AI-vs-AI only?
- Should generated maps prioritize tournament-style balance or visual variety?
- What third-party map export/share format, if any, is stable enough to support?

---

## 41. Immediate next coding task

Build a minimal vertical slice with **synthetic rules data**:

- 30" × 22" SVG board
- 2 teams
- 3 operatives per team
- one weapon each
- 5 terrain rectangles
- 3 objectives
- seeded RNG
- Reposition
- Shoot
- wounds
- 4 turning points
- simple “move to objective, otherwise shoot nearest legal target” AI
- event log
- replay by seed

Once that slice is deterministic and testable, replace the synthetic team data through the rule-pack loader and add official-source/version metadata.

That gives the project a stable engine before the legally and mechanically harder rule-content work begins.
