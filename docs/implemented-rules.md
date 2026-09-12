# Implemented rules subset

The engine implements a documented **core rules subset**, built in layers
(plan §14). This file is the honest inventory: what actually resolves, and what
does not. Anything a rule pack declares that isn't listed here is reported in
the battle log as an unsupported rule — never silently guessed (invariant #7).

## Implemented

### Turn structure
- Four turning points, each with a Strategy and a Firefight phase
- Initiative roll-off each turning point (ties re-rolled); winner activates first
- Alternating activations; ready / expended tracking
- Counteract: a player with no ready operatives may take one 1 AP action with an
  already-activated operative, once per turning point
- +1 CP per player per turning point (CP is tracked; spending is not yet implemented)

### Orders and actions
- Engage / Conceal orders, chosen freely at the start of an activation
- Action points from APL, reduced by 1 while Injured (minimum 1)
- Each action once per activation
- **Reposition** — move up to Move
- **Dash** — move 3"
- **Charge** — move Move + 2", must end within control range of the target
- **Fall Back** — move up to Move, must end outside enemy control range;
  forbids Shoot, Fight and Charge for the rest of that activation
- **Shoot** — requires Engage unless the weapon is Silent; forbidden while
  within enemy control range, and by Heavy after the wrong kind of move
- **Fight** — requires an enemy within control range
- **Pass**

### Movement and geometry
- Inches are the canonical unit; the renderer converts to pixels
- Base-edge to base-edge measurement, not centre-to-centre
- Bases may not overlap each other, terrain, or leave the board
- Movement is measured along the walked path, so going around a wall costs
  what it should (visibility-graph pathing)

### Shooting and fighting
- ATK dice vs Hit; 6s are critical, or x+ with `lethal<x>`
- A die must first be a success to be a critical success, so `lethal4` on a
  Hit 5+ weapon still crits only on 5s and 6s
- 3 defence dice vs Save; 6s are critical saves; AP/Piercing remove dice
- Normal saves cancel normal hits 1:1; critical saves cancel a critical hit or
  two normal hits
- Cover retains one normal save without rolling
- Melee resolves alternately, attacker first, choosing Strike or Parry
- Injured (half wounds or fewer): −1 APL and worse hit rolls
- Stunned (from the Stun weapon rule): a further −1 APL for one activation

### Weapon rules

Every **universal** weapon rule in the Kill Team appendix now resolves. The
rules that only change dice live in `src/rules/dice.js`; the ones that change
what an operative may do, or how many targets a shot has, live in
`src/rules/weapon-rules.js`.

Value-free: `balanced`, `ceaseless`, `relentless`, `rending`, `punishing`,
`severe`, `brutal`, `saturate`, `shock`, `stun`, `silent`, `hot`, `seek`,
`seeklight`, `psychic`. With any value of x:

| Rule | Effect |
|---|---|
| `lethal<x>` | Successes of x or more are critical successes. Defaults to 5. |
| `piercing<x>` | The defender collects x fewer defence dice, always. Defaults to 1. |
| `piercingcrits<x>` | The same, but only when the attack retained a critical hit. |
| `ap<x>` | As `piercing<x>`; kept for packs written against older wording. |
| `devastating<x>` | Each retained critical hit inflicts x damage, ignoring saves. |
| `accurate<x>` | Retain x attack dice as normal successes without rolling them. |
| `accuratecrits<x>` | x of the dice Accurate retained are critical successes instead. Nothing prints this; the Gaze of the Gods grants it. |
| `limited<x>` | Usable x times per battle, per operative. Defaults to 1. |
| `blast<x>` | Also resolved against everyone within x" of the target. |
| `torrent<x>` | Also resolved against other valid targets within x" of the target. |
| `heavy`, `heavy:dash`, `heavy:reposition` | See below. |

`piercing` and `piercingcrits` are separate rules and stack on a weapon that
carries both. Note that `devastating<x>` may be printed with a leading splash
distance (`2" Devastating 1`), meaning the damage also hits operatives near the
target; the engine applies the single-target half only, and the transcribed
packs keep the full printed wording in the weapon's `rulesText`.

Severe creates a critical success when nothing critted. `devastating` and
`piercingcrits` trigger off that critical; `punishing` and `rending` do not.

#### Where each rule bites

- **Heavy** — the weapon cannot be used in an activation (or counteraction) in
  which the operative moved, and the operative cannot move in one in which it
  used the weapon. `Heavy (Dash only)` and `Heavy (Reposition only)` permit
  exactly that one move action, and reach the engine as `heavy:dash` and
  `heavy:reposition`. Both halves are enforced: the shot is refused after the
  wrong move, and the move disappears from the legal actions after the shot.
- **Hot** — after the weapon is used, one D6 is rolled; below the weapon's Hit
  stat the operative suffers twice the result. Rolled once per Shoot action,
  after every sequence that action caused.
- **Limited x** — counted per operative per weapon, for the whole battle. A
  spent weapon stops appearing in the legal actions and `canShoot` refuses it.
- **Silent** — the Shoot action may be performed while on a Conceal order. The
  AI uses this: an operative holding a Silent weapon stays concealed to fire,
  which is what keeps it un-targetable in cover.
- **Seek / Seek Light** — the target cannot use terrain (Seek), or terrain
  traited `light` (Seek Light), for cover **when it is being selected**, so a
  concealed operative behind a wall can be picked. Neither removes the cover
  save itself — that is Saturate. The jungle temple's canopy and the hulk's
  pipework are traited `light`, so `seeklight` has something to see past on
  both; the industrial map still has none.
- **Shock** — the first critical success struck with in a sequence also
  discards one of the opponent's unresolved normal successes, or a critical one
  if they have no normals. In shooting that is a defence die; in a fight it is
  one of the opponent's pending attack dice, once per fighter per fight.
- **Stun** — any retained critical success costs the target 1 APL until the end
  of its next activation. The flag is cleared by the activation that paid for
  it, so an operative stunned during its own activation still pays next time.
- **Blast x"** — after the primary sequence, a separate sequence is resolved
  against every *other* operative visible to the shooter and within x" of the
  primary target. Friendly operatives are caught too, a Conceal order is no
  protection for a secondary, and secondaries inherit the primary's cover.
- **Torrent x"** — the same shape, but secondaries must each be a *valid
  target* in their own right and must not be within control range of one of the
  shooter's own operatives, so a Torrent weapon never hits a friendly.
- **PSYCHIC** — recognised as a weapon keyword with no effect of its own. The
  team-specific rules that key off it (`Anti-PSYKER`) are declared by their own
  packs; see below.

All targets of one Shoot action are selected before any dice are rolled, so a
Blast that kills its primary still catches the operatives beside it. Secondary
sequences are resolved in a fixed order so a replay is identical. One
simplification: kill VP is credited by side, so a friendly operative killed by
your own Blast counts towards the opponent's kill tally.

### Team-specific weapon rules

The asterisked rules — the ones whose text lives on a team's own datasheet
rather than in the universal appendix — now resolve too, but they reach the
engine differently. They have to: the same printed name means different things
on different sheets. *Poison* costs a Plague Marine's victim 1 damage per
activation and a Ravener's victim D3; *Detonate* is three unrelated rules on
three teams. Hard-coding one reading would have quietly made the others wrong.

So each pack declares what **its** asterisked rules do, in a `weaponRules`
block, choosing from a fixed effect vocabulary (see `docs/rule-pack-format.md`).
A rule token no pack declares is still reported as unimplemented, exactly as
before — declaring it is what makes it resolve.

Every rule token carried by every bundled pack is now either universal or
declared — forty-six distinct rules across thirty-four teams, several of them
(Poison, Detonate, Shield, Salvo, Anti-PSYKER, Explosive) declared differently
by each team that prints them:

| Rule | Teams | What resolves |
|---|---|---|
| `concealedposition` | 9 sniper teams | The profile is usable on the operative's first Shoot action of the battle and no other |
| `poison` | Plague Marines, Raveners | A token that burns its holder on activation — 1 damage or D3, as each team prints it |
| `toxic` | Plague Marines | +1 to both Dmg stats against an operative that held a Poison token when the action began |
| `blaze` | Sanctifiers | A token: D3 on activation, then a D6 to shake it off — or a point of APL to smother it for certain, which the holder pays when the next burn could kill it |
| `terrorchem` | Nemesis Claw | A token off a critical (Devastating included), D3 on activation |
| `neutronfragment` | Vespid Stingwings | A stacking token, D3 per token held |
| `mindburn` | Warpcoven | One token per player at a time; worsens Hit by 1 |
| `humblingcruelty` | Void-Dancer Troupe | −2" Move and worse Hit until the end of the holder's next activation |
| `flay` | Hand of the Archon | A Pain token on a nearby friend |
| `soulstrike` | Mandrakes | Defence dice succeed at or *under* the target's APL; 1 crits, 6 always fails |
| `salvo`, `twintorrent` | 4 teams | Two primary targets in one Shoot action |
| `explosive`, `wreathed` | Kommandos, Wrecka Krew, Sanctifiers | The weapon goes off on the operative itself, usable in melee; Wreathed leaves the wielder unharmed |
| `detonate` | Imperial Navy Breachers | Fires through a friendly GHEISTSKULL, which becomes the primary target |
| `detonate` | Death Korps, Phobos Strike Team | Refused: needs a Mine / Explosives marker |
| `skytorch` | Vespid Stingwings | Refused: only usable during the Skytorch Assault action |
| `stinger` | Hand of the Archon | A kill bursts for D3 on everyone within 2", and the burst chains |
| `beam` | Hearthkyn Salvagers | Each retained critical burns D3 down one line behind the target |
| `shield`, `tangle`, `repress` | 7 teams | One block cancels two successes; Repress also has the defender resolve first |
| `smash` | Wrecka Krew | A strike shoves the enemy 1" and the smasher follows |
| `phasesweep`, `swipe` | Deathwatch, Gellerpox | Free Fight actions until every enemy in reach has been fought once |
| `riposte` | Novitiates | A critical block also deals the weapon's Critical Dmg |
| `crush` | Raveners | A roll-off on each strike adds up to 3 damage |
| `tactualhunter` | Fellgor Ravagers | A second strike before the opponent answers, against an expended operative |
| `headtaker` | Fellgor Ravagers | A kill returns D3 wounds and permanently sharpens the skullcleaver, capped at 8 |
| `bipod`, `forceimpact`, `viciousblows`, `zealousrage`, `stalk`, `feast`, `antipsyker`, `hypersense` | 8 teams | Universal rules and stat bonuses granted when a printed condition holds |
| `aimed` | Exodite Dragon Masters | A 3" movement budget the weapon enforces in both directions |
| `magnify` | Hierotek Circle | Target, cover and obscured measured from a friendly spotter, plus Ceaseless |
| `siphonlife` | Legionary | A nearby friend regains wounds per damaging die, once per turning point |
| `dimensionalbanishment` | Canoptek Circle | 2D6 against remaining wounds finishes off a survivor |
| `drag` | Goremonger | The target is hauled 2" per unblocked success towards the shooter |
| `firstblood` | Catachan Jungle Fighters | A fighter hurt but not put down rolls a D6 to cut back for 2 |
| `getsome`, `targetacquired`, `hammerup` | Catachan Jungle Fighters | Re-rolls up close, re-rolls when it stood still, and Lethal 5+ after a charge |
| `engineered`, `custom` | Gellerpox, Phobos Strike Team | The pack's fixed pre-battle loadout choice, applied all battle |
| `bloodoffering`, `ritual`, `flay` | Blooded, Goremonger, Hand of the Archon | Pays into the team's resource economy (below) |
| `neutronbombardment` | Vespid Stingwings | The weapon fires normally; the Neutron Fallout marker is not placed |

#### What is deliberately half-done

These are declared `partial` in their packs and reported once per battle, so
the log never implies more fidelity than there is:

- **Magnify**, **Siphon Life**, **Drag** — each is printed as optional ("you
  can use this rule"). The engine takes them whenever they help, and takes
  them fully: Drag never discards attack dice to spare a target.
- **Beam** — the attacker picks "one and only one beam line". The engine picks
  the line that catches the most enemies, so a replay is identical.
- **Headtaker** — the Frenzy token that would suppress the healing half does
  not exist, so the wounds always come back.
- **Engineered**, **Custom** — the pack fixes the two improvements rather than
  a player picking them before the battle.
- **Hypersense** — the engine folds "obscured" into cover, so it is applied as
  Seek.
- **Neutron Bombardment**, **Skytorch**, **Detonate** (Mine / Explosives) —
  markers and the actions that place them are not implemented. Skytorch and the
  marker Detonates therefore refuse to fire at all, with a stated reason, which
  is the honest outcome rather than a guess.

### Tokens

Six of the rules above hang a **token** on an operative, which is a subsystem
the core rules did not need. A token is data on the operative — whose it is,
what it does on activation, what it does while held, and when it expires — so
a serialized state replays without consulting the pack that granted it.

- Damage lands at the *start* of an activation, before the operative spends AP,
  and can kill it outright.
- "If it doesn't already have one" is the default; Neutron Fragment opts into
  stacking and rolls its damage per token.
- Stat penalties that print "this isn't cumulative with being injured" combine
  with `max`, not addition.
- A token that expires "at the end of its next activation" survives the
  activation it landed in, exactly as Stun does; one that expires "at the end
  of the turning point" comes off in the next Ready step.
- A token that offers its holder a way out (Blaze) makes the choice rather than
  defaulting to it: an operative the next burn could kill spends the APL to be
  certain, and a healthy one takes the free roll.
- An incapacitated operative takes its tokens with it.

Tokens an operative is carrying are shown on its roster card, because they
change what happens the moment it activates.

### Team resource economies

Three teams live on an economy: they earn a countable thing from what their
operatives do, and spend it again on a menu of effects with their own windows
and limits. A pack declares all of it as data in a `resources` block (see
`docs/rule-pack-format.md`); the engine owns the counting, the limits and the
spending, and `src/ai/spending.js` owns the decision.

| Team | Rule | Earned by | Spent on |
|---|---|---|---|
| Hand of the Archon | Power From Pain | An action that leaves an enemy Injured, or kills one — two Pain tokens for a Wounds 12+ kill; Flay hands one to a friend within 6" | **Dark Animus** (+1 APL, and the AP now), **Accelerated Rejuvenation** (D3+1 wounds back), **Vitalised Surge** (a free Dash after a kill, even after an action that forbids one), **Stimulated Senses** (re-roll one result, attack or defence) |
| Goremonger | Gore Tanks / Sanguavitae | Killing something in control range or within 2"; Ritual's first damage in a sequence. Starts at half, capped at full | **Rejuvenate**, **Mania** (+1 APL), **Fury** (a second, free Fight), **Rake** (D3 on contact after a charge), **Surge** (+1" Move), **Rage** (+1 Atk in melee) |
| Blooded | Blooded tokens | The Ready step, the first enemy killed each turning point, the first friendly lost within 6" of an enemy, and Blood Offering | Assigned to operatives as a STRATEGIC GAMBIT: a held token gives that operative's weapons Accurate 1, and four or more assigned puts one under the **Gaze of the Gods** (its Accurate retention is a critical success) until the end of the turning point |

How the limits work: "no more than one invigoration per activation or
counteraction, except Stimulated Senses" and "no more than two SANGUAVITAE
rules, and not Mania and Fury together" are declared per spend and enforced by
the rules layer, so an AI that asks for one too many is refused rather than
allowed to cheat.

Who decides:

- An `activation` spend is a **0-AP action**. The AI proposes it as part of a
  plan and the action layer validates it like any other action, which is what
  puts the choice in front of the same scoring that picks the plan.
- A dice-window spend (Stimulated Senses) happens in the middle of a roll,
  where there is no action layer to ask. The engine applies one documented
  policy: re-roll the failing result the most dice are showing, when doing so
  is worth at least 0.6 of a success in expectation — so two failed dice at 4+
  buy the re-roll and one never does.
- Vitalised Surge is a reaction to a kill that has not happened yet at planning
  time, so the AI appends it, and the Dash it pays for, as **optional** actions:
  if the target survives, both are dropped without a word.

Two readings worth stating, because the printed wording is ambiguous:

- "an enemy operative was **injured** during that action" is read as the
  Injured keyword — half wounds or fewer — rather than "took any damage".
- Dark Animus and Mania add APL "until the start of the operative's next
  activation". Bought mid-activation, they hand over the extra AP immediately.

### Non-combatant operatives

An operative can carry no weapons at all — the Spectre Vox-Relay Beacon, the
Navis C.A.T. unit, the Gheistskull and the Tome Skull all do. Such an operative
cannot Shoot, cannot Fight, and — the part that used to be wrong — rolls **no
dice when it is fought**, rather than being handed a phantom pair of fists. The
pack validator names every weaponless operative it loads.

### Visibility and terrain
- Line of sight traced as a fan of rays between base rims
- `obscuring` blocks sight; `cover` grants a cover save; `light` marks a piece
  as Light terrain for `Seek Light`; `traversable`, `blocking`,
  `insignificant`, `vantage` recognised
- An operative that finds nowhere legal to stand in its deployment zone is
  **reported**, not silently left off the board — usually it means a map's
  corridors are narrower than the widest base in the team (2.95")
- A **concealed** operative in cover cannot be selected as a target at all
- Intervening operatives (friendly or enemy) grant cover
- Terrain an operative is standing in or beside does not block its own view

### Faction rules

Faction rules reach the engine as declarative `ruleHooks` on a team pack (see
`docs/rule-pack-format.md`), or — for the three teams whose faction rule is an
economy — as a `resources` block. Eighteen are implemented across fifteen teams:

| Team | Rule | Simulated | Not simulated |
|---|---|---|---|
| Kommandos | Throat Slittas | Charge while Concealed, Bomb Squig excluded | — |
| Legionary, Murderwing, Nemesis Claw | Astartes | Two Shoot **or** two Fight per activation | the bolt-weapon selection clause |
| Angel of Death | Astartes | as above | bolt-weapon clause; extra AP for a second heavy-weapon Shoot |
| Deathwatch | Veteran Astartes | as above | extra AP clause; the bonus free counteract action |
| Kasrkin | Rapid Fire | Second Shoot while the operative has not moved | the hot-shot/bolt pistol selection clause |
| Corsair Voidscarred | Rifles | Accurate 1 on shuriken rifle / ranger long rifle before moving | — |
| Corsair Voidscarred | Aeldari Raiders | A free Dash each activation | — |
| Hand of the Archon | Rifles | Accurate 1 on the splinter rifle before moving | — |
| Goremonger | Runes of Khorne | Damage capped at 8 per Shoot action | — |
| Hierotek Circle | Living Metal | D3+1 lost wounds regained each Ready step | — |
| Mandrakes | Umbral Entities | Piercing and Piercing Crits ignored against them, and Save improved WITHIN SHADOW | the "not lower than it" clause, which needs operative elevation |
| Imperial Navy Breacher | Void Armour | Defence re-roll vs Blast/Torrent, two for a Grenadier | sweeping-profile exclusion; splash-Devastating immunity |
| Hand of the Archon | Power From Pain, Invigorations | Pain tokens earned and spent on all four invigorations | — |
| Goremonger | Gore Tanks, Sanguavitae | The three-level tank and all six SANGUAVITAE rules | — |
| Blooded | Blooded | Tokens earned, assigned, and the Gaze of the Gods | the player's choice of who to assign them to |
| Catachan Jungle Fighters | Green Vipers | Charge while Concealed | — |
| Catachan Jungle Fighters | Let's Move! | The leader hands 1 APL to a friend within range and sight | the player's choice of who receives it |

Rules marked "not simulated" are declared `partial` in the pack and reported
once per battle in the warnings, so the log never implies more fidelity than
there is.

The other 40 teams' faction rules are carried as reference text only — they
need engine subsystems that do not exist yet (markers, operative
transformation, area effects, order manipulation, terrain concepts such as
WITHIN SHADOW). Those packs stay at `supportLevel: 1`.

### Objectives and scoring
- Control by total APL within an objective's control range; equal totals are contested
- Data-driven mission scoring: per-objective VP with a per-turning-point cap,
  kill VP with a cap, and end-of-battle survivor/wipeout bonuses
- A kill is credited to whoever inflicted it. A Hot weapon overheating in its
  bearer's hands, or a Blast catching a friend, is nobody's victory point; a
  Poison token's damage is still the player's that hung it there
- `TURN_ENDED` carries the turning point's raw numbers — markers held and
  operatives killed, before any cap — so a mission's caps can be tuned against
  what they actually threw away. Secure and Hold's kill cap was raised from 2
  to 4 on that evidence; see the mission file's own note and the README

### Maps

Three bundled maps, all 30" × 22". Terrain geometry is rules-authoritative;
`render.styleId` is cosmetic and the engine never reads it.

| Map | Shape | Plays like |
|---|---|---|
| **Industrial Crossfire** | Ruins and crates around open lanes | The baseline: 10.2" mean shot range, 16% of attacks in melee, 6% taken in cover |
| **Derelict Hulk** | A lattice of bulkheads leaving 5" corridors, cut by collapsed decking | Close and ugly: 8.1" mean shot range, 32% melee, 21% in cover |
| **Temple of the Green Moon** | A walled ziggurat in jungle canopy | Cover-heavy and contested: 11.2" mean shot range, 11% melee, 12% in cover |

Two details are load-bearing rather than decorative:

- The hulk's corridors are **5" wide** because the widest base in any bundled
  team is 2.95". Anything narrower and that operative cannot deploy or move,
  which is why the engine now reports a failed deployment instead of quietly
  dropping the model.
- Those corridors run the full width of the board, so on their own they are
  three thirty-inch firing lanes. The collapsed decking that interrupts them is
  `obscuring` **and** `traversable` — it blocks sight but is shoved through,
  because a 5" corridor has no room for anything you must walk around. That one
  choice is what turns the map from a shooting gallery into a hulk.

The jungle canopy is `obscuring`, `cover`, `light` and `traversable`: it hides
you, it is pushed through, and being Light terrain it is exactly what a Seek
Light weapon ignores.

### Mission modes

A mission declares how it is won, and the choice is made on the setup screen
alongside the teams.

| Mode | Mission | Ends when | Winner |
|---|---|---|---|
| `victoryPoints` | **Secure and Hold** | Four turning points are played, or a team is wiped out | Most VP; ties break on survivors |
| `lastTeamStanding` | **Annihilation** | One team has nobody left | The team still standing |

**Annihilation** is a deathmatch: `ignoreObjectives` takes the markers off the
board entirely, so there is nothing to hold and nothing to run to, and there is
no four-turning-point clock. It carries a turning-point *cap* only so two teams
that never find each other still stop; if the cap is reached with both teams
alive, the result is decided on surviving operatives and then on total wounds
remaining, and says so plainly rather than pretending someone won cleanly.

The AI is told which game it is playing. With no markers to hold, "take
ground" means ground closer to the enemy, and every role gets a floor under its
drive to close and half its usual fear of exposure — otherwise two gunlines
simply never meet. Across the 53 bundled teams fought against Kommandos, 41
deathmatches end in a wipeout and 12 reach the cap, at a mean of 7.5 turning
points.

Annihilation is not a published mission. It is a variant this simulator
provides for comparing team match-ups without objective play, and its data file
says so.

### AI tactics

The AI scores candidate plans with per-role weights, then two layers on top
(`src/ai/tactics.js`):

- a **disposition** per kill team, inherited from its faction and overridable by
  the pack (see `aiDisposition` in the rule-pack format). It scales the role
  weights: `aggressive` closes and discounts exposure, `patient` holds firing
  positions, `skirmish` works cover, `relentless` walks through fire.
- **unit tactics** read off the profile: Blast and Torrent carriers steer toward
  clustered targets and score what the splash catches, `selfPrimaryTarget`
  weapons (Explosive — the bomb squigs) walk into a crowd and detonate, and
  psykers value getting a `psychic` weapon off over a safer sidearm shot.

- **resource spending** (`src/ai/spending.js`), for the teams that run an
  economy. It scales no weights — an invigoration is a decision, not a
  disposition — but it prefixes the plan with what it wants to buy: wounds back
  on an operative that is Injured, an extra point of AP on one that is not and
  has a target in reach, and the melee upgrades that only pay off in a charge.
  The extra AP is only paid for if the plan it enabled actually spends it.

All three show up in the combat log's plan rationale, alongside the score
breakdown.

## Ploys and CP

CP accrues at 1 per turning point, and a team can spend it in three places.
Each ploy becomes playable when its pack gives it `hooks` — the same trigger/
condition/effect data `ruleHooks` uses.

- **Strategic ploys** are bought in the strategy phase and last the turning
  point, reaching the whole team. The initiative winner buys first.
- **Firefight ploys with `timing: "activation"`** are bought during one
  operative's activation as a 0-AP action, and their hooks are scoped to that
  operative until its activation ends. This is the CP that buys a second Fight
  action, a heavier swing, an extra point of APL, or a free Dash.
- **Firefight ploys with `timing: "defence"`** are reactions, bought inside the
  attack they answer. There is no action layer in the middle of a dice roll, so
  these follow one published policy (`rules/ploys.js`): at most one per
  sequence, paid out of the reaction budget the team's doctrine set aside, and
  only against an attack that clears the doctrine's trigger. `onIncomingAttack`
  exists for them — it fires before the attack dice are rolled, which is the
  only window in which "your opponent cannot re-roll their attack dice" means
  anything.
- **Firefight ploys with `timing: "demise"`** are bought as the operative that
  pays for them goes down, out of the same reserve a reaction uses. There is no
  judgement about whether the moment is worth it, the way there is for a
  reaction: an operative that is already down has nothing left to protect and
  the ploy expires with it, so the only questions are whether the team kept CP
  back and whether the throes have anybody to reach.

Four triggers exist for ploys that fire at a *moment* rather than across a
sequence: `onIncapacitated` (the death-throe family), `afterAction`,
`afterRetaliation`, and `onTargetSelection` — the last of which is a defender's
veto over being picked at all, asked before Seek or a spotter get their say,
because SHIFTY and IN POSITION both print that precedence explicitly.

Every purchase is re-checked by the rules layer, so an unaffordable, duplicate
or mistimed pick proposed by the AI is rejected and logged rather than trusted.

### Deciding what CP is for

Pricing one ploy is `src/ai/ploys.js`: what its hooks do, scaled by the share
of the living roster that can use them and by the team's disposition, with
conditional ploys discounted by how often the condition is likely to hold.

Deciding whether to spend at all is `src/ai/cp.js`, and it is a per-team
DOCTRINE — `vanguard`, `gunline`, `raider`, `bulwark` or `tactician` — derived
from the ploys a pack actually declares plus its disposition, overridable with
`aiCpDoctrine`. The doctrine answers four questions each turning point: how
picky to be about strategic ploys, how much to hold back for the fighting, what
an in-activation ploy has to be worth, and how much is reserved to answer an
attack.

The strategy phase asks for CP first every turning point, and at one point of
income that means it would get everything — so the doctrine prices the
opportunity cost: a strategic ploy has to beat the action ploy some operative
could buy three activations from now, or the reaction that could save an
operative on the opponent's turn. That is what makes a Blades of Khaine team
hold a point for BLADEWIND while a Death Korps team commits it to a team-wide
buff, and why the last turning point of a scoring mission empties every hand.

The plan is written onto the player as `cpPlan` and logged (developer log), so
the battle log says what each team meant to do with its CP and why.

## Not implemented

These are recognised and reported, not simulated:

- Ploys whose printed wording has no expression in the hook vocabulary —
  swapping two operatives' positions, interrupting an opponent's activation,
  cancelling an opponent's ploy, redirecting a shot onto a bodyguard, chaining
  a second friendly activation, skipping one. Each is named once at battle
  start rather than approximated.

  The bodyguard shape ("select one other friendly operative to become the valid
  target instead") is the largest remaining group — eight teams print a version
  of it — and is the obvious next thing to build.
- Equipment — chosen before the battle, and there is no pre-battle selection
  step. Catalogued and reported.
- Board state several ploys are printed against — the OBELISK NODE MATRIX, the
  STORM, a TUNNEL, a Claim or Attack Order marker. Where a ploy leans on one,
  the hook is marked `partial` and its `notes` say what was approximated (an
  objective marker standing in for a placed marker, for instance); the notice
  appears in the battle log's warnings.
- Operative abilities (unique actions are carried as data but not performable)
- The 40 teams' faction rules listed as reference-only above
- Vantage points and elevation — `height` is stored but does not affect LOS
- Overwatch, Guard, Pick Up Marker, Operate Hatch and other mission actions
- Injured/Incapacitated special cases beyond the APL and hit modifiers above
- Universal actions beyond the list above
- Splash `Devastating` (`2" Devastating 1`), which needs the same area
  machinery as Blast plus a damage-only variant of it.
- Markers and the actions that place them (Mine, Explosives, Neutron Fallout,
  Skytorch), which is why three weapons refuse to fire rather than guessing.
- The Frenzy token, the "obscured" state as distinct from cover, and the
  pre-battle loadout choices `Engineered` and `Custom` offer.
- The rest of the Blooded gambit's shape — tokens are assigned automatically in
  the Ready step, nearest the enemy first, rather than being placed by a player.

## Rules fidelity note

This is a simulation of a rules *subset* chosen so the core loop is trustworthy
and deterministic. It is not a substitute for the official rules, and where a
real game's rules are required, consult the current official source.
