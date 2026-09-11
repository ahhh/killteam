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
synthetic demo teams written for this engine — invented stat lines. Another 48
under `data/teams/` were transcribed from [Wahapedia](https://wahapedia.ru/kill-team3/)
in September 2026 and carry their source URL in each pack's `source` block.
Those are reproduced for simulation and reference only; Games Workshop holds
the rights, and the official downloads are authoritative for actual play. This
goes further than the repository policy in `plan.md` §3, which anticipated that
real rule data would be loaded locally rather than committed.

`catachan-jungle-fighters` is a **fan-made** kill team, transcribed from
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

Everything is lazy. Nothing fetches a portrait until a sheet is actually opened,
tokens are `loading="lazy"` and reuse one element per operative across the
roster's rebuilds, and `assets/portraits/manifest.json` — the index of which
operatives have been drawn — is fetched once and answers for both sizes, so art
that doesn't exist yet costs no request. See `src/ui/portraits.js`; `npm test`
asserts the laziness, since it is otherwise invisible until someone loads the
site on a phone.

Tokens are derived from the portraits, in this repo:

```bash
pip install -r tools/requirements.txt             # opencv, pillow, numpy
python3 tools/make-tokens.py                      # rewrite assets/tokens/
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

The app works fine with either directory empty or partly filled. After redrawing
a portrait, re-run `tools/make-tokens.py` so its token matches.

## Run it

The app loads its data with `fetch()`, which browsers block on `file://` URLs,
so serve the folder over HTTP:

```bash
npm start           # python3 -m http.server 8000
# then open http://localhost:8000
```

## Develop

```bash
npm test            # 205 unit, fixture, determinism, AI and replay tests
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
Mapforge adapter (Milestone 7), equipment, and operative unique actions.

**Command Points are a real economy.** A team spends CP three ways — strategic
ploys in the strategy phase, firefight ploys bought mid-activation as a 0-AP
action, and reactions bought inside an attack somebody else declared — and each
team runs a CP *doctrine* (`src/ai/cp.js`) derived from the ploys its pack
declares and the way it fights. A vanguard team holds its point for the second
Fight action; a gunline commits it to the turning point it can shoot through; a
raider banks early and empties its hand when it commits; a bulwark team keeps
it to answer the shot that would kill an operative. 300 of the 415 printed
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

### Known balance caveat

The batch harness reports that the bundled `skycaste-marksmen` gunline beats
the melee-oriented demo teams around 90% of the time. That is a property of the
invented demo stat lines and of AI passivity at long range — not evidence about
any real game. Batch results are for catching regressions and map bias, as
`src/replay/batch.js` says in its own report.
