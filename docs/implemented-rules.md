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
- **Dash** — move 2"
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
  save itself — that is Saturate. Bundled maps do not yet classify any piece as
  `light`, so `seeklight` currently has nothing to see past on them.
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
- **PSYCHIC** — recognised as a weapon keyword with no effect of its own. Rules
  that key off it (`Anti-PSYKER` and similar) are team-specific and remain
  unimplemented.

All targets of one Shoot action are selected before any dice are rolled, so a
Blast that kills its primary still catches the operatives beside it. Secondary
sequences are resolved in a fixed order so a replay is identical. One
simplification: kill VP is credited by side, so a friendly operative killed by
your own Blast counts towards the opponent's kill tally.

### Visibility and terrain
- Line of sight traced as a fan of rays between base rims
- `obscuring` blocks sight; `cover` grants a cover save; `light` marks a piece
  as Light terrain for `Seek Light`; `traversable`, `blocking`,
  `insignificant`, `vantage` recognised
- A **concealed** operative in cover cannot be selected as a target at all
- Intervening operatives (friendly or enemy) grant cover
- Terrain an operative is standing in or beside does not block its own view

### Faction rules

Faction rules reach the engine as declarative `ruleHooks` on a team pack (see
`docs/rule-pack-format.md`). Thirteen are implemented across eleven teams:

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
| Mandrakes | Umbral Entities | Piercing and Piercing Crits ignored against them | the Save bonus WITHIN SHADOW |
| Imperial Navy Breacher | Void Armour | Defence re-roll vs Blast/Torrent, two for a Grenadier | sweeping-profile exclusion; splash-Devastating immunity |

Rules marked "not simulated" are declared `partial` in the pack and reported
once per battle in the warnings, so the log never implies more fidelity than
there is.

The other 37 teams' faction rules are carried as reference text only — they
need engine subsystems that do not exist yet (markers and tokens, operative
transformation, area effects, per-operative resource tracks, order
manipulation, terrain concepts such as WITHIN SHADOW). Those packs stay at
`supportLevel: 1`.

### Objectives and scoring
- Control by total APL within an objective's control range; equal totals are contested
- Data-driven mission scoring: per-objective VP with a per-turning-point cap,
  kill VP with a cap, and end-of-battle survivor/wipeout bonuses

## Not implemented

These are recognised and reported, not simulated:

- Strategic and firefight ploys, and command point spending
- Equipment
- Operative abilities (unique actions are carried as data but not performable)
- The 37 teams' faction rules listed as reference-only above
- Vantage points and elevation — `height` is stored but does not affect LOS
- Overwatch, Guard, Pick Up Marker, Operate Hatch and other mission actions
- Injured/Incapacitated special cases beyond the APL and hit modifiers above
- Universal actions beyond the list above
- Team-specific weapon rules — the ones printed with an asterisk, whose text
  lives on each team's own datasheet rather than in the universal appendix:
  `poison`, `blaze`, `concealedposition`, `antipsyker`, `soulstrike`, `shield`,
  `magnify`, `salvo`, `bipod`, `detonate` and about forty more, each on one or
  two weapons. The bundled packs carry their printed wording in `rulesText` but
  not the rule text itself, so the engine reports them rather than guessing.
- Splash `Devastating` (`2" Devastating 1`), which needs the same area
  machinery as Blast plus a damage-only variant of it.

## Rules fidelity note

This is a simulation of a rules *subset* chosen so the core loop is trustworthy
and deterministic. It is not a substitute for the official rules, and where a
real game's rules are required, consult the current official source.
