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
npm test            # 348 unit, fixture, determinism, AI, replay and UI tests
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
    spending.js       when to spend a team resource, and on what
    ploys.js          pricing a ploy for a team, and for one activation
    cp.js             the Command Point doctrine each team plays to
  data/               schema, validators, loader
  maps/geometry.js    all geometry, in inches
  replay/             replay capture, verification, batch harness
  ui/                 SVG battlefield, animation layer, panels, log, setup
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
- ✅ Three maps: an industrial yard, a space-hulk corridor lattice, a jungle temple
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

Faction rules now run through a declarative `ruleHooks` layer — 16 rules across
14 teams, which declare `supportLevel: 3`. The other 40 transcribed teams carry
their faction rules, ploys, equipment and unique actions as reference data only
and stay at `supportLevel: 1`.

Three of those teams live on a **resource economy** rather than a hook, so
packs declare that as data too, in a `resources` block: Hand of the Archon earn
and spend Pain tokens on all four invigorations, Goremongers fill and drain a
three-level GORE TANK to pay for the six SANGUAVITAE rules, and the Blooded
earn tokens, assign them, and hand one operative the Gaze of the Gods. Earning
is the engine's; deciding when to spend is the AI's (`src/ai/spending.js`), and
a spend is a 0-AP action the rules layer validates like any other.

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

Where they land, over a 12-team round robin of 6 battles per pair on all three
maps, both seats:

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

Over a 16-team round robin (16x15 pairings, both seats, all three maps, 90
games per team) a team's **melee share** — how much of its roster's damage is
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

No stat line was changed. The remaining lever is the killzone rather than the
teams — shallower separation between drop zones, or denser terrain — and that
rewrites all three maps and invalidates every balance figure recorded above,
so it is left as a decision rather than taken.

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
