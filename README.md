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
original interface artwork and machine-generated operative portraits, and
does not reproduce official miniature photography or illustrations. Rules references and compatibility information
are provided for identification and educational/simulation purposes only.
Where official rules data is required, users should consult the current
official Games Workshop sources.

**Bundled rules data.** Six teams (`vanguard-*`, `ash-cultists`,
`corsair-skirmishers`, `scrap-raiders`, `skycaste-marksmen`) are original
synthetic demo teams written for this engine — invented stat lines. Three more
— `crimson-spear`, `freebooter-boardin-krew` and `covenant-of-the-hidden-word`
— are **fan-made** kill teams written by the user as design briefs and
transcribed here; their stat lines, ploys and equipment are the author's
invention and no part of them comes from a published source. Another 48
under `data/teams/` were transcribed from [Wahapedia](https://wahapedia.ru/kill-team3/)
in September 2026 and carry their source URL in each pack's `source` block.
Those are reproduced for simulation and reference only; Games Workshop holds
the rights, and the official downloads are authoritative for actual play. This
goes further than the repository policy in `plan.md` §3, which anticipated that
real rule data would be loaded locally rather than committed.

`catachan-jungle-fighters` is another **fan-made** kill team, transcribed from
datasheet images supplied by the user rather than from any published source.
Its sheets are in the 2021 symbol notation, so the pack's `source.notes`
records the one conversion applied: distances are doubled to the scale the
other packs use, which turns the printed Move 3" into 6" and a printed Range
6" weapon into 12".

## Operative art

Each operative's character sheet shows a generated coloured-pencil portrait from
`assets/portraits/<team-id>/<operative-id>.webp`. The art is **generated, not
official** — no miniature photography or published illustration is reproduced.

Roster cards show the same art as a small head token from
`assets/tokens/<team-id>/<operative-id>.webp` — the portrait cropped to the
operative's face and shrunk to 128px, about 4.5KB against the portrait's 79KB.
That ratio is the whole reason a picture per card is affordable: the full set of
portraits is 38MB, the full set of tokens is 2.1MB, and a card that scrolls out
of the panel never loads at all.

The battlefield gets the same crop a third time, from
`assets/pips/<team-id>/<operative-id>.webp`: 64px, round, and about 1.4KB, so a
board of twenty faces costs 30KB and the whole set costs 738KB. It is round in
its own alpha channel rather than being clipped by the renderer, which is why
the SVG draws it as a plain `<image>` and the team-colour ring around the base
is the only edge. With a face in the base, the order ring moves out to the
base's own outline — dashed is still Conceal, solid is still Engage — and the
role glyph shrinks to a badge at the bottom of the base rather than being
painted over.

A **team variant** has no art of its own and never will: it fields its base
team's datacards, so it is the same operatives, drawn once, under the base
team's id. `artTeamId()` in `src/ui/portraits.js` is where that indirection
lives, and it is the reason nothing needs regenerating when a variant is added.

Everything is lazy. Nothing fetches a portrait until a sheet is actually opened,
tokens are `loading="lazy"` and reuse one element per operative across the
roster's rebuilds, and `assets/portraits/manifest.json` — the index of which
operatives have been drawn — is fetched once and answers for all three sizes, so
art that doesn't exist yet costs no request. See `src/ui/portraits.js`; `npm test`
asserts the laziness, since it is otherwise invisible until someone loads the
site on a phone.

One caveat, learned the hard way: the manifest is fetched with `no-cache`,
which revalidates rather than refetching, **not** `force-cache`. `force-cache`
returns whatever copy the browser already holds, fresh or stale, and never
asks again — and the manifest is precisely the file that changes on every
deploy that adds art. A returning visitor kept an index from before the newest
teams were drawn, `hasPortrait()` answered "no art" for teams whose art was
sitting on the server, and every base on the board fell back to a bare role
glyph. `hasPortrait()` now also fails open for a team the manifest has never
heard of, so a stale index cannot blank a whole team again; an operative
missing from a team the manifest *does* list is still answered honestly,
because that is a real gap. `assets/effects/manifest.json` had the identical
bug and the same fix.

Tokens and pips are derived from the portraits, in this repo — one crop, two
outputs:

```bash
pip install -r tools/requirements.txt             # opencv, pillow, numpy
python3 tools/make-tokens.py                      # rewrite assets/tokens/ and assets/pips/
python3 tools/make-tokens.py --contact-sheet /tmp/sheet.png   # eyeball it
```

Those are the only dependencies anywhere near this project, and the app itself
does not need them — committed tokens are what it loads.

Finding the head is the interesting part, and it takes two signals: YuNet face
detection, which is excellent on the bare human, ork and ratling faces but
knows nothing about helmets and will happily report the skull on a shoulder pad
as a face; and silhouette geometry, which reads the head as the first blob below
the crown wide enough not to be a raised weapon. The silhouette runs first and
vets the face detector's answer. The handful it still gets wrong — a banner held
high reads as a head — are pinned by hand in `tools/token-overrides.json`.

The portraits are produced by a separate pipeline that lives outside this repo,
`image_gen_pipeline/generate_killteam_art.py` (see its
`killteam_art/README.md`). To redraw one, drag it in from Finder and say what to
change:

```bash
python3 generate_killteam_art.py regen \
  ~/Programming/40k-sim/assets/portraits/kommandos/kommando-boy.webp \
  give him a much bigger hat and less green
```

The app works fine with any of the three directories empty or partly filled —
art that is missing takes itself off screen, and on the battlefield the plain
geometric token is what is left behind. After redrawing a portrait, re-run
`tools/make-tokens.py` so its token and pip match.

### Facing

Operatives on the battlefield show which way they are looking: a wedge off the
front of the base, turned by where the operative last walked and overridden by
whatever it last attacked (a fight turns both parties; being shot at does not
turn the target, since the point of a shot is that the target may never have
seen it). Facing is **not a rule** — nothing in `src/rules/` reads it and
nothing may. It is `src/ui/battlefield.js` remembering what it drew last frame,
which is why it is not on state and why a battle replays identically whether or
not anyone was watching.

## Battle animations

Attacks animate. A lasgun draws a line of light, a plasma gun throws a bottled
star with a comet tail, a bolter fires a rocket-propelled shell that goes off
inside the target, and an autogun sends a tracer round; a melta lays down a
short fat column of heat, a psychic power discharges in crooked violet
lightning, and a rokkit rides a parabola and detonates. A flamer lays a cone
sized to the range. A blade sweeps through whoever it caught, and the operative
it caught either swings back or blocks. A ploy leaves a mark — chevrons for an
offensive one, a hexagonal ward for a defensive one, vox rings for an order,
rings closing inwards for something worked on the enemy, a green cross for
wounds healed. And a shield, a team's area buff, an operative on fire or one
full of Terrorchem keeps looping for exactly as long as the state that caused
it lasts.

Like facing, **none of it is a rule**. Nothing in `src/rules/` can see it,
nothing is written to state, and a battle produces the same event digest
whether or not a single frame was ever drawn — `test/effects.test.mjs` asserts
both, including that no module under `rules/`, `ai/`, `replay/` or `data/`
imports anything from `ui/`.

### The sprites are drawn, not generated

`tools/make-effects.py` writes 21 RGBA sprite sheets with Pillow — 521KB for the
set — and `src/ui/effects.js` plays them back over the SVG board:

```bash
pip install -r tools/requirements.txt
python3 tools/make-effects.py                                  # rewrite assets/effects/
python3 tools/make-effects.py --contact-sheet /tmp/fx.png      # every frame, on its own
npm start && open http://localhost:8000/tools/effects-preview.html?t=380
```

A generated picture of an explosion arrives with a background, a light
direction and a style, and sixteen of them in sequence arrive with sixteen of
each. These are geometry — a ring, a falloff, a phase — so drawing them means
the alpha channel is exact, the looping sprites close on themselves without a
seam, the palette is the one in `styles.css`, and a frame that looks wrong
costs nothing to redraw.

One sprite is one nested `<svg>` whose `viewBox` selects a cell out of the
sheet, which makes advancing a frame a single attribute write and needs no
`<clipPath>` kept alive in `<defs>`. The renderer wipes the board on every
redraw; the effect nodes are simply re-appended to the fresh layer, so a shot
in flight is not restarted by somebody clicking an operative. There are two
layers, because an aura belongs under the figures and an explosion belongs over
them.

### Nothing is drawn, or loaded, that cannot happen

The generator **scans `data/teams/` before it draws anything**. Weapon names and
weapon rules decide which shot families exist, ploy hook effect types decide
which ploy marks exist, and the token kinds a pack declares decide which
persistent loops exist. A family nothing in the bundled data can produce is
never drawn and never shipped, so a sheet on disk is evidence that something
can fire it — and `manifest.json` records how many weapons or ploys asked for
each one, with examples.

Loading is narrower still. At battle start the app asks `src/ui/effect-map.js`
which families the **two packs actually being fielded** declare, and warms only
those: a Kasrkin mirror match fetches neither the warp, nor poison, nor fire on
an operative, nor the shield. Anything outside that set is refused at spawn
time as well, so a mis-scan costs a missing animation rather than a surprise
download mid-battle.

The classification table lives in the generator and is written **into** the
manifest, so `effect-map.js` sorts a weapon with the same table that decided
which sheets exist rather than with a second copy that can drift. Two tests
check it from both ends: every family the bundled packs ask for has been drawn,
and every sheet that ships is reachable from the bundled data.

Torrent is the interesting case. It is how this game writes "sweeping fire" as
well as "burning fuel", so a cone off a weapon whose name is not a flame weapon
is a fan of rounds rather than a jet of flame — a sweeping heavy bolter drawn
as a flamethrower is the one mistake that would be visible from across the
room. Blast is the other: it keeps the weapon's own projectile and detonates at
the end of it, so a plasma cannon is still plasma on the way in.

Everything switches off for **Reduce motion** — the app's own toggle or the
operating system's — and at instant playback speed, where the whole battle
resolves inside one synchronous loop and there is no frame to draw into.
Otherwise the durations are scaled to the playback speed, so nothing is still
burning when the next operative activates.

## Run it

The app loads its data with `fetch()`, which browsers block on `file://` URLs,
so serve the folder over HTTP:

```bash
npm start           # python3 -m http.server 8000
# then open http://localhost:8000
```

## Develop

```bash
npm test            # 655 unit, fixture, determinism, AI, replay, UI and team tests
npm run test:data   # validate every bundled team, map and mission
npm run smoke       # run one battle headlessly and print the result
npm run batch 60 vanguard-wardens scrap-raiders   # batch balance harness
npm run melee       # melee-leaning teams vs gunlines, both seats, three maps
npm run test:manifest   # regenerate the team capability lock (read the diff!)
npm run data:index      # regenerate the picker indexes after adding a team or map
```

Everything runs on plain Node ≥ 20. There are no dependencies.

### The team regression suite

Three files exist so a team's rules cannot quietly stop working.

`test/fixtures/team-capabilities.json` is an inventory of every playable thing
all 64 packs declare — rule hooks, resource economies and their spends,
performable unique actions, ploys carrying hooks, team weapon rules with an
implemented effect, marker-control modifiers, and each pack's support level.
`test/team-capabilities.test.mjs` asserts the live packs are a **superset** of
it. That asymmetry is the point: wiring a new rule is free (regenerate with
`npm run test:manifest` and commit the diff), while deleting a hook, renaming
it, retyping its effect, dropping an `action` block back to reference text or
lowering a support level fails loudly and names the team. The same file also
checks every declaration against the engine's own vocabulary, so a rule that
survives the manifest but whose effect the engine has stopped implementing
fails too — and it pins the four packs that wire nothing and the six whose
printed unique actions are all reference text, each with its reason, so those
lists can only shrink.

`test/team-faction-rules.test.mjs` drives the interesting rules against the
real packs: it fields the operative the printed rule names and asserts the rule
fires — and, just as importantly, that it does not fire for the operative the
printed wording excludes.

`test/team-battles.test.mjs` plays one complete battle for each of the 36 packs
that carry faction rules. It fails on a crash, on the AI proposing an action
the rules layer then rejects, and on any warning meaning "this pack declared
something the engine cannot read". A `hook-partial` warning is expected and
welcome — that is a pack being honest — and is deliberately not counted.

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
    resources.js      team resource economies: Pain tokens, GORE TANKs, Blooded
    ploys.js          the CP economy: strategic, in-activation and reactive ploys
    objectives.js     objective control and mission scoring
    effects.js        damage, incapacitation, injured and stunned states
    terrain.js        terrain traits
  ai/
    controller.js     utility AI: enumerates plans, scores, produces intent
    utility.js        analytic estimators (no RNG consumed while thinking)
    targeting.js      target selection from a hypothetical position
    movement.js       candidate destination generation
    tactics.js        faction disposition and per-unit tactics
    options.js        the three tactics a semi-manual player is offered
    spending.js       when to spend a team resource, and on what
    ploys.js          pricing a ploy for a team, and for one activation
    cp.js             the Command Point doctrine each team plays to
  data/               schema, validators, loader
  maps/geometry.js    all geometry, in inches
  replay/             replay capture, verification, batch harness
  ui/                 SVG battlefield, animation layer, panels, log, setup,
                      the semi-manual orders prompt
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

A battle played by hand has one more input: the answers. Those are recorded on
`state.tacticChoices` and in the event log, and the same seed plus the same
answers reproduces the same battle — `test/semi-manual.test.mjs` checks both
halves of that, including that different answers produce a different battle.

## The killzones are painted

Each bundled map ships a top-down render of its killzone, fetched when the map
is selected and drawn under the board. It is decoration and nothing else — no
battle reads it, the rules never see it, and a map without one renders as the
geometric board it always had (invariant #9 is unchanged: the app is complete
without art).

**The rules geometry still sits on top of it.** The art is a second,
hand-made description of the same killzone and it can drift from the data, so
the terrain polygons the engine actually collides against are drawn over the
picture as outlines rather than replaced by it. That also keeps the one cue the
art cannot express:

- **solid edge** — `blocking`: sight and movement both stop here
- **dashed edge** — `traversable`: blocks sight, but is walked straight through

The calibration lives in the asset, not the renderer: `tools/make-map-art.mjs`
crops each source render to exactly the 30 × 22" playing surface, so the board
places it at `0,0,30,22` with no per-map offsets to get wrong. Crop rectangles
were derived from the painted deployment zones (whose board coordinates the map
data already knows) or from the playable floor's own edges, then each was
verified by overlaying the map's terrain on the crop.

Where the art already paints the deployment zones and they agree with the data,
the map says so with `art.showsZones` and the engine does not draw its own. The
Temple of the Green Moon paints a narrower strip than it plays, so it keeps
them. Backdrops are 159–295 KB each, one per battle, and are never preloaded —
which map a player picks is a guess. Full detail, including the known
mismatches, in `docs/map-art.md`.

## Playing a kill team yourself

By default both kill teams fight themselves and you watch. **Teams… →
Semi-manual** puts one side (or both) under your control, and the setting is
per player, so the usual arrangement is one of each.

Under semi-manual control the turning-point machine stops in the middle of each
activation — after the operative is on the clock, its tokens have burned and
its AP is counted, but before anything is ordered — and offers **three
tactics**. You pick one, it resolves, and play carries on to the next decision.
Counteractions stop and ask in the same way.

### The three options are the AI's own reasoning, re-cut

The controller already enumerates every plan an operative could follow and
ranks them (`ai/controller.js`). Showing the top three would be three versions
of one idea, because the ranking is dominated by whichever branch happens to be
good this turn — six ways to shoot the same trooper. So the question the menu
asks is a different one: *what are the genuinely different things this operative
could do*, and the answer is the best plan of each **kind**:

| Branch | What it is |
| --- | --- |
| Close combat | charge into contact, or fight what is already there |
| Use a spell | a Shoot action with a PSYCHIC weapon |
| Move and shoot / Shoot | with or without breaking position first |
| Use an ability | one of the operative's own printed actions |
| Use a resource | patch up out of the team economy, and get off the skyline |
| Prepare a reaction | Guard: hold the shot for the enemy's turn |
| Advance / Take cover / Take ground | press the line, get behind something, or take the marker |
| Disengage | Fall Back out of contact |

The kinds are read off each plan's own actions (`branchOf`), not declared at
the twenty-odd places a plan is built, so a new branch in the controller cannot
forget to label itself.

Only the economies that buy *wounds back* get a card of their own. The ones
that buy attack dice or an extra swing are modifiers on an action, so they ride
the shooting and melee cards, where the plan that wants them pays for them —
and only two bundled teams declare a heal spend at all, so "Use a resource" is
a rare card by design rather than by accident.

Three of those branches never appear in the AI's enumeration at all, because it
only ever reaches them as openings or as leftovers: the operative's own printed
actions, a resource the team is offering, and Guard. A player should be able to
choose them outright, so `ai/options.js` builds them as plans in their own
right and scores them with the same function as everything else — an option you
pick is not a cheaper one.

### The cards are specific to the team

Every option is named in the team's own vocabulary, because that is the whole
point of playing this team rather than another one:

```
[ CLOSE COMBAT ]                  [ USE AN ABILITY ]           [ ADVANCE ]
Charge Death Korps Trooper        GET IT DUN! on Bomb Squig    Push 9.0" toward the enemy
~4.8 dmg · 7.3" move · 2/2 AP     ~5.4 value · 1/3 AP          9.0" move · 2/3 AP · ends Concealed
```

The AP on each card is the budget it is actually priced against — which is not
always the AP the operative is holding, because a resource spend can buy a
point and one of its own actions can have taken one off the top before you were
asked anything.

What the AI would have done is marked ("their pick") but never pre-selected,
and **Let them decide** hands any single activation back to the controller.

### It decides nothing

The prompt is a set of buttons with the reasoning printed on them. The options
were built against the state the engine had actually reached, and every action
in the one you choose is re-validated by the action layer when it resolves —
the same path an AI plan takes, and the same rejection. Invariants 2 and 3 hold
unchanged: the UI never decides whether an action is legal, and choosing is not
permission. `test/semi-manual.test.mjs` checks that directly by handing the
resolver an impossible order and asserting it is refused and logged.

### What is still automatic

Deployment, initiative, the Command Point doctrine and the strategic ploys
bought in the strategy phase are all still the controller's. Semi-manual is
about what each operative does on its activation; the turning-point scaffolding
around it is not offered as a choice.

### Running headless

`runToCompletion` has nobody to answer the question, so it returns at the first
suspension with an `awaiting-orders` warning rather than burning its step limit.
The batch harness and the sweep scripts are unaffected — they build automatic
controllers.

## Loading your own data

Adding a team, map or mission requires **no engine or UI changes**. Drop JSON
into `data/`, or import it at runtime through **Teams… → Load your own rule
pack**. Packs are validated before use and rejected loudly if malformed;
nothing in a pack is ever executed. See `docs/rule-pack-format.md`.

`data/reference-teams.json` is the catalogue: it maps every team name to its
bundled rule pack and its Wahapedia source URL. It carries no stats itself.

**Adding a bundled team or map means regenerating the indexes** — `npm run
data:index`. A team dropped into `data/teams/` and named in
`data/factions.json` will not appear in the picker until
`data/team-index.json` knows about it, and the same goes for a map and
`data/map-index.json`; `test/data-index.test.mjs` fails when either is stale,
so a forgotten run is caught by the suite rather than by a player. An *imported* pack needs
nothing: it is registered in full at import time and the picker reads its
fields off the pack itself.

### The pickers load an index, not the data

The setup screen needs a name, a faction and a support level for all 64 teams,
and the other 97% of a pack — operatives, weapons, rule hooks, ploys, lore —
only for the team a player has actually selected. The map picker has the same
shape: five names and blurbs, and the terrain polygons of only the one being
played. So boot fetches `data/team-index.json` (10.7KB) and
`data/map-index.json` (1.1KB), both generated by `tools/make-data-index.mjs`,
and the packs and maps are fetched on selection.

`index.html` carries a generated `modulepreload` hint per engine module. The
graph is 43 modules in four discovery waves — the browser cannot see
`rules/dice.js` until it has parsed `ai/controller.js`, which it cannot see
until it has parsed `app.js` — so without the hints `boot()` cannot issue its
first request until four serial round trips have gone by. `npm run data:index`
rewrites the block and `test/preload.test.mjs` fails when it drifts, since a
stale entry is a 404 on every page load and a missing one restores the
waterfall.

The boot JSON is deliberately *not* preloaded with `as="fetch"`: `loader.js`
fetches with `cache: 'no-cache'`, and whether a preload matches that request
or causes a second download has not been measured in a real browser.

The reference catalogue is fetched off the critical path entirely: it is the
last block of the setup overlay, below the team columns, the mission picker
and the import box, so it fills itself in when it lands rather than holding up
the first paint.

Boot used to load all 64 packs and all 5 maps with a sequential `await`:

| | requests | transferred | concurrency |
|---|---|---|---|
| before      | 73 | 1977KB | 1 at a time |
| concurrent  | 73 | 1977KB | overlapped |
| + indexes   |  8 |   96KB | overlapped |

`newBattle()` is synchronous and reached from seven event handlers, so the
invariant is that the two *selected* packs are always already loaded: boot
loads the opening pair, and the setup screen loads any later choice before it
reports the change. `DataRepository._loadMany` overlaps its fetches but
registers in the order asked for — the map picker is built by iterating
`repo.maps` directly, so completion order would reshuffle that dropdown
between page loads.

### Every team and every operative carries lore

Packs have two prose fields the engine never reads. `blurb` is the one-line
"what does this team do" the picker has always shown; `lore` is a paragraph
about who they are, shown under it on the setup screen, and every operative
has one of its own, shown on its character sheet between the portrait and the
stat table — where a datacard would print it. All 64 packs and all 581
operatives have both.

A variant inherits its base team's *operative* lore, because it fields the
same datacards and therefore the same people, but never its team lore: the
point of a variant is that it is a different idea about how to use them. Those
six paragraphs live with the rest of the variant specs in
`tools/make-variants.mjs`.

`lore` is the longest string a pack can carry (`LIMITS.maxLoreLength`, 1200
characters) and is sanitised on load like every other displayed string, since
an imported pack is untrusted input.

### The team picker is grouped by grand alliance

`data/factions.json` gives every faction a `group` — Imperium, Chaos, Aeldari,
Xenos, Demo teams — and lists the factions in group order, so every Aeldari
faction is adjacent to every other and the Chaos Legions sit beside their
cultists instead of being scattered through an alphabetical list. A `<select>`
has exactly one level of grouping, so the alliance is a prefix on the optgroup
label rather than a heading above it: **Aeldari · Craftworlds**, **Aeldari ·
Drukhari**, **Chaos · Chaos Space Marines**. A faction with no `group` — an
older catalogue, or one somebody wrote themselves — keeps its own name and
still loads. `test/setup-screen.test.mjs` asserts that no alliance is split
across the catalogue, since a run that is broken in two stops reading as a
group at all.

A group named in the catalogue's `bundledGroups` gets **one** heading instead
of one per faction. The demo teams are the case it exists for: eight invented
teams spread over five invented faction names, which produced five headings of
one or two entries apiece and a lot of scrolling past labels that told a
player nothing. They are now a single **Demo teams** group. Real factions stay
separate — Orks and T'au Empire is the distinction a player is actually
making — and which groups bundle is a data decision, not a UI one.

## Current status

Milestones 0–6 of `plan.md` are implemented and tested:

- ✅ Skeleton, state store, seeded RNG, battle log
- ✅ SVG board, terrain, movement, pathing, map loader
- ✅ Core combat: orders, shooting, fighting, wounds, LOS, cover, charge, fall back
- ✅ Turn engine: deployment, initiative, alternating activations, CP, Counteract
- ✅ Objectives, mission scoring, utility AI with explainable reasons
- ✅ Two mission modes: objective play, and a last-team-standing deathmatch
- ✅ Five maps: an industrial yard, a space-hulk corridor lattice, a jungle
  temple, and two killzones built to make the approach survivable
- ✅ Rule-pack loader, validators, compatibility badges, runtime import
- ✅ Replay capture and verification, batch balance harness
- ✅ Battlefield animations: shots, area effects, melee, ploys, persistent buffs

Not yet built: procedural map generation (Milestone 6's generator), the
Mapforge adapter (Milestone 7), equipment, and operative unique actions.

**Command Points are a real economy.** A team spends CP three ways — strategic
ploys in the strategy phase, firefight ploys bought mid-activation as a 0-AP
action, and reactions bought inside an attack somebody else declared — and each
team runs a CP *doctrine* (`src/ai/cp.js`) derived from the ploys its pack
declares and the way it fights. A vanguard team holds its point for the second
Fight action; a gunline commits it to the turning point it can shoot through; a
raider banks early and empties its hand when it commits; a bulwark team keeps
it to answer the shot that would kill an operative. 321 of the 415 printed
ploys are wired up; the rest are named at battle start as unsimulated.

Ploys that fire at a moment rather than across a sequence reach the engine
through four later triggers: `onIncapacitated` (the death-throe family — the
Gellerpox bursting, a Khorne Legionary's last swing), `afterAction`,
`afterRetaliation` and `onTargetSelection`. A firefight ploy may declare
`timing: "demise"`, bought as its own operative goes down out of the same
reserve a reaction uses.

Faction rules now run through a declarative `ruleHooks` layer — 51 rules across
34 teams. The other 24 transcribed teams carry their faction rules, ploys,
equipment and unique actions as reference data only and stay at
`supportLevel: 1`.

Six of those teams live on a **resource economy** rather than a hook, so
packs declare that as data too, in a `resources` block: Hand of the Archon earn
and spend Pain tokens on all four invigorations, Goremongers fill and drain a
three-level GORE TANK to pay for the six SANGUAVITAE rules, the Blooded
earn tokens, assign them, and hand one operative the Gaze of the Gods, the
Wrecka Krew pool Wrecka points off a bloodied enemy, and the Novitiates draw
Faith points in the Ready step. Earning is the engine's; deciding when to spend
is the AI's (`src/ai/spending.js`), and a spend is a 0-AP action the rules
layer validates like any other.

One trigger was added for the largest of them. `onWouldBeIncapacitated` fires
in `applyDamage` at the moment an operative's wounds run out and before it is
marked down, and its one effect — `surviveIncapacitation` — is the window
FELLGOR RAVAGER **Frenzy** needs and nothing else had: "it's not incapacitated
and it gains one of your Frenzy tokens". The token is what bounds it. A hook
that names one refuses to fire for an operative already holding it, so the
reprieve is once per operative per battle, and a real death clears it with
everything else the body was carrying.

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

### Team variants

Six bundled teams can be fielded a second way. A **variant** is not a new kill
team: it is the same pack's own datacards, a different half of them, and a
different plan for what to do with them — a different roster, a different
`aiDisposition`, a different CP doctrine, and a ploy list edited to match. The
Kommandos can take the field as a gunline that left its choppa boys at home;
the Novitiates as a melee host that detonates when it dies; Krieg as a
seven-strong specialist cadre rather than a fourteen-body line.

They are generated, not hand-written, so they cannot drift from the datacards
they come from — re-run `node tools/make-variants.mjs` after editing a base
pack. Each one carries `variantOf` and a `variantNote`, which is what the team
picker shows under the name, and each declares its own `source` block: the
profiles and weapons are the base team's, but the roster, the disposition, the
doctrine and any ploy of its own are this project's invention, not a published
list.

One rule is enforced by the generator and by a test: **a variant never fields
more operatives than its base.** Kill Team prices a bigger list with points and
this simulator has none, so "the same team but bigger" is not a variant, it is
a better list — a nine-strong Legionary Warband won 92% of its games against a
neutral pool where the six-strong base team won 51%, and trading its champions
for rank and file did not help. At six it wins 72%, splits its head-to-head
with the base 3–3, and is a different plan rather than a longer one.

Variants are not balanced against their bases, and are not meant to be. The
Penitent Host is a large improvement on the Novitiates (31% against the pool
against the base team's 8%); the Krieg Veteran Cadre is a clear step down from
the line it comes from (21% against 31%), because Krieg's strength is bodies
and a cadre gives them up. Those are findings, not defects.

### Missions score ground and blood at the same weight

Secure and Hold pays up to 3 VP a turning point for markers held and, until
recently, up to 2 for operatives killed. Only the first of those scales with
roster size — a team with spare bodies parks them on markers — so across a
2,970-battle round robin, roster size correlated **+0.76** with objective VP,
**+0.06** with kill VP, and **+0.19** with winning. Teams of 5–6 operatives won
43% of their games; teams of 12–14 won 58%.

The cap on kills was doing it. Raising it to 4 — which is in practice no cap,
since one side almost never takes more than four operatives off the board in a
turning point — lets a team that kills harder be paid for it, and that is the
half of the game a small elite roster is built to win. Re-scored over the same
battles, roster size's correlation with win rate falls from +0.100 to +0.019
and the win-rate gap between the smallest and largest rosters from 7.7 points
to 1.2. Re-run live over 976 fresh battles, the correlation came out at +0.037
and the win rate stopped sloping with size at all. Nothing about objective
control changed; it is still total APL within 1", as printed.

What did *not* work, recorded so nobody tries it twice: paying kill VP per
share of the enemy roster removed. It reads like the fix — a kill should hurt a
five-body team more than a fourteen-body one — and it makes the bias roughly
four times worse, because a horde also gives away less per body killed.

### Three fan-made teams

`crimson-spear` (Blood Angels), `freebooter-boardin-krew` (Ork pirates) and
`covenant-of-the-hidden-word` (Word Bearers and their cult) were written as
prose design briefs and transcribed into packs at `supportLevel` 4. Each
declares what it could not simulate, in the pack and in the battle log: the
Breacha's MAKE US A DOOR has no terrain to cut, the Cult Cell markers have no
marker to place, and every printed rule that hangs off Pick Up Marker or a
mission action has no action in this engine to modify.

Two things came out of building them that the engine kept:

**Marker control is now its own vocabulary.** All three lean on rules written
as "treat its APL as x when determining control of markers … this does not
change its APL stat" — the Red Thirst's Loss of Restraint, Heir of Azkaellon,
Creed of Martyrdom, The Word Made Flesh. A hook fires at a moment and control
is recomputed continuously, so those became a `controlModifiers` block on the
pack and a `controlAplDelta` on the token family. See
`docs/rule-pack-format.md`.

**The AI was ignoring two whole classes of free action.** ASTARTES — "either
two Shoot actions or two Fight actions" — is an always-on rule hook nobody pays
for, and the plan builder only ever counted repeats a resource spend or a
firefight ploy had bought. So every Space Marine team in the bundle walked into
contact and swung once: across nine battles the Crimson Spear charged seven
times and fought seven times. A granted free Dash was the same story, read only
by the action layer, which sees it after the plan is made. Both are now planned
(`freeRepeats`, `grantedDash` in `src/ai/controller.js`), which is worth about
twelve points of win rate to the Crimson Spear and lifts Angel of Death,
Deathwatch, Murderwing and Legionary with it. `AI_VERSION` was 0.3.0 for it,
and is **0.4.0** for the movement and concealment work described under
"Melee, and why this engine is still bad at it".

Where they land, over a 12-team round robin of 6 battles per pair on the three
maps that existed then, both seats:

| | |
|---|---|
| deathwatch | 83.3% |
| legionary | 72.0% |
| blooded | 71.2% |
| **crimson-spear** | **65.2%** |
| death-korps | 64.4% |
| murderwing | 56.8% |
| kommandos | 50.0% |
| wrecka-krew | 48.5% |
| novitiates | 28.8% |
| **freebooter-boardin-krew** | **26.5%** |
| **covenant-of-the-hidden-word** | **25.0%** |
| chaos-cult | 8.3% |

The Crimson Spear is where its brief asks for it: a notch above Murderwing, even
with Deathwatch and Legionary head to head, behind Angel of Death. The other
two are not, and the reason is the same one the harness has reported before —
**this engine rewards reach far more than the tabletop does**, and both are
written as short-ranged teams. The Freebooterz' printed guns all stopped inside
10", which is why three of them reach two inches further here than the brief
prints; that is recorded in the pack's own `source.notes` with the numbers
either side and the four fields to revert. The Covenant fields nine mortals
with 2/3-damage weapons. Both beat the horde teams they are built from —
the Covenant takes 8W 2D 2L off Chaos Cult — and both lose to elite marines,
which is the matchup their briefs describe losing.

### Melee, and why this engine is still bad at it

Over a 16-team round robin (16x15 pairings, both seats, the three maps that
existed then, 90 games per team) a team's **melee share** — how much of its roster's damage is
carried by melee weapons rather than guns — correlates **-0.71** with its win
rate, and average gun range correlates **+0.72**. The melee-leaning half of
that pool wins 40.3% of its games; the shooting half wins 59.7%. Before any of
the work below those figures were -0.73, +0.72, 40.6% and 59.4%.

Four things were fixed in the attempt, and all four were real:

- **Dash was 2".** It is 3" in the printed rules, and had been a third short
  for most of this project's life (`src/rules/movement.js`).
- **The AI could not see concealment as protection.** `exposureAt()` measured
  danger geometrically and ignored the target's own order, so a position where
  an operative would be Concealed in cover — and therefore cannot legally be
  selected as a target at all — scored exactly as dangerous as standing in the
  open. It now takes the order the plan ENDS on and prices such a position at
  zero, using the same predicate `canBeTargeted()` enforces.
- **Closing moves were being cut off before they were costed.**
  `generateDestinations()` proposed thirty ring positions against a budget of
  twenty-six, and proposed them *first*, so on a typical board 21 of 26 slots
  went to undifferentiated rings and the objective, closing and cover
  candidates never made the list. An operative that needed to close had no
  closing move among its options. Candidates are now proposed in priority
  order, rings last.
- **There were no covered approach routes.** The only cover positions the
  planner generated were on the *far* face of each piece as measured from the
  enemy — which is a retreat. Advancing along cover, which is the tabletop's
  whole answer to a gunline, was not something this AI could consider.

They did not move the balance. Measured over the same round robin the melee
correlation went from **-0.734 to -0.713** and the gap between the melee and
shooting halves from 18.8 points to 19.4 — noise at 90 games a team, in both
directions at once. Dash on its own was measurably the wrong way (-0.782),
because an extra inch is worth at least as much to a gunline keeping its
distance. All four are kept because each is independently correct, not because
any of them helped.

**The cause is the approach itself, and it is geometric.** Deployment zones
are 5" deep at opposite ends of a 30" board, so the two teams start 19-22"
apart, and a melee operative moves 6". Tracking a Goremonger warband against
Pathfinders turning point by turning point: TP1 ends 22" apart with 8 alive,
TP2 ends 12.7" apart with **4** alive, TP3 ends 4.7" apart with 3. They do
close — they simply arrive with half a team, having spent two turning points
being shot by a gunline that gets to fire every activation. Across 12 battles
the warband averaged **0.9 Fight actions per game** against 21 enemy Shoot
actions, and out-moved by two to one, because the side with guns is also the
side free to reposition.

#### What did move it: giving the melee teams their faction rules back

The four fixes above were all about the approach. The next pass was about what
the melee teams are *supposed to have* and did not: fourteen packs declared
`supportLevel` 3 or 4 — "faction rules and core operative abilities" — and
wired no `ruleHooks` and no `resources` at all, so their defining rule did
nothing. Raveners had no second Fight action. The Wrecka Krew had no Tanked Up.
The Fellgor Ravagers, a horde whose entire identity is *not dying to the first
hit*, had no Frenzy. Chaos Cult had no Accursed Gifts, Gellerpox no
Techno-Curse, Legionaries no Marks of Chaos.

Measured the same way both times — the six melee-leaning packs against three
gunlines, both seats, all three original maps, 432 games:

| | melee win rate | average VP | melee survivors |
|---|---|---|---|
| before | 16.9% | 8.25 – 16.12 | 0.79 |
| after | **26.9%** | 9.63 – 14.68 | **1.35** |

Ten points, and the survivor figure says where they came from: a melee warband
now arrives with something left. Frenzy alone fires about nine times a game for
an eleven-body Fellgor roster. This is still a gunline's engine — 26.9% is a
long way from even — but it is the first change in this section that moved the
number at all, and it did so by implementing printed rules rather than by
tuning anything.

No stat line was changed, and neither was any of the three maps: every figure
recorded above is measured on them and stands as measured. The killzone lever
was pulled by **adding** two maps rather than rewriting three, which is the
only version of that change that costs nothing already counted.

### Two killzones built for the approach

Each new map pulls one of the two levers the trace points at, so the comparison
between them says which lever did the work.

**`hab-warren-001` — Warren of the Broken Hab** keeps industrial-001's drop
zones down to the polygon, and a test asserts it: the terrain is the entire
difference between the two maps. Four hab blocks sit at the ends, a court of
collapsed floor sections surrounds the centre marker, and twenty-odd columns of
rubble stand between them. Almost none of it stops a base — the ruins are the
only solid pieces on the board, and the whole middle, y 4.2 to 17.8, is open to
the 2.95" bases in the bundled teams. What this map narrows is sight, not
movement.

**`cull-pit-001` — The Cull Pit** leaves sight alone and moves the teams. They
drop along the LONG edges, so the drop zones are 11" apart instead of 24" and
the crossing costs one turning point instead of two. All five markers sit on
the centre line, equidistant from both zones — also asserted — so neither side
has ground it can hold without walking toward the other.

Both are symmetric under a half turn about the board centre, piece for piece,
so neither seat faces easier geometry. `npm run killzone` measures what follows;
`-- --pool` adds the round robin, which is the slow half.

| killzone | sight lines clear | median | over 12" | drop zone to drop zone | melee share vs win rate | melee half wins |
|---|---|---|---|---|---|---|
| industrial-001 | 51.5% | 10.0" | 20.0% | 15.3% | **-0.667** | 31.0% |
| jungle-temple-001 | 52.8% | 9.5" | 18.4% | 11.2% | **-0.508** | 37.7% |
| spacehulk-001 | 32.8% | 7.2" | 5.6% | 0.1% | **-0.505** | 39.0% |
| **hab-warren-001** | **26.4%** | **6.3"** | **3.4%** | **0.0%** | **+0.159** | **51.0%** |
| **cull-pit-001** | **32.1%** | **7.1"** | **6.1%** | **3.1%** | **+0.103** | **50.4%** |

The left half is geometry — a lattice of standing positions, every third pair
traced for line of sight. The right half is the same 16-team round robin used
above, 90 battles a team, run per map. The sign flips.

And the matchup the trace follows, 16 seeds in both seats on each map:

| killzone | Fight attacks | enemy Shoot attacks | first contact | warband survivors | warband wins |
|---|---|---|---|---|---|
| industrial-001 | 0.22 | 24.0 | TP2.5, in 6 of 32 battles | 0.00 | 0.0% |
| jungle-temple-001 | 0.56 | 24.0 | TP2.9, in 13 of 32 | 0.03 | 0.0% |
| spacehulk-001 | 1.59 | 18.3 | TP2.5, in 30 of 32 | 1.97 | 3.1% |
| **hab-warren-001** | **4.31** | 19.0 | **TP2.0, in 32 of 32** | **2.03** | **37.5%** |
| **cull-pit-001** | **5.69** | 18.5 | **TP1.0, in 32 of 32** | 1.47 | **46.9%** |

Turning point by turning point, closest pair and warband still standing: on
industrial-001 the Goremongers go 10.6"/5.9 → 5.8"/2.8 → 6.2"/1.2, which is
the arriving-with-half-a-team the trace describes. On the warren they go
5.5"/7.6 → 1.6"/4.9 → 2.1"/3.3 → 2.1"/2.6, and on the pit they are in contact
at 1.1" before the first turning point is over.

Three things are worth saying plainly about that.

**Neither lever is a fix for the bias; both are a place where it does not
apply.** Nothing in the engine or the AI changed here. A gunline on
industrial-001 is exactly as dominant as it was, and the correlation on the
three original maps is where it always was. What the two new maps show is that
the -0.71 in the section above is a fact about twenty inches of open ground
rather than about close combat.

**Breaking the sight lines and shortening the walk do different things.** The
pit produces more melee — contact in every battle, in the first turning point,
nearly six Fight attacks a game — because the walk is short. The warren
produces less melee and about the same result, because a warband that crosses
under cover arrives with two operatives instead of one and a half. Contact and
advantage are not the same lever, and a map that only shortens the approach
hands the gunline a point-blank target as readily as it hands the warband a
charge.

**The traced matchup still loses on both.** Goremongers against Pathfinders is
37.5% and 46.9%, not 60%. The warband gets to fight; it does not get a
handicap. Whether that is the right place for it to land is a question about
the invented stat lines, and those were left alone here on purpose.

The older caveat still stands: the bundled `skycaste-marksmen` gunline beats
the melee-oriented demo teams around 90% of the time. That is a property of
the invented demo stat lines as well as of the bias above — not evidence about
any real game. Batch results are for catching regressions and map bias, as
`src/replay/batch.js` says in its own report.

### Rules data currency

The 48 transcribed packs were scraped from Wahapedia on 2026-09-10, and
Wahapedia tracks the balance dataslates, so they already carry the current
ones. Spot-checked against the live pages: Scout Squad has the April 2026
changes (nine operatives, combat blade at 4/5) and Hierotek Circle has the
June 2026 Reanimation Protocols wording. There was nothing outstanding to
apply. The January 2026 Breaching Charge is a piece of *universal equipment*,
and universal equipment is not modelled at all — see "Not yet built" above.
