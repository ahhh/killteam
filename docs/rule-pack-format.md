# Rule pack format

A rule pack is plain JSON. It is **data, never code** — nothing in a pack is
evaluated, and packs are validated before a battle can start (plan §28, §34).

Load one through **Teams… → Load your own rule pack**. Imported packs stay in
your browser; they are not uploaded and are not committed to this repository.
The packs bundled under `data/teams/` follow the same format — see the
provenance note in `README.md` for where their data came from.

## Team pack

```jsonc
{
  "id": "my-team",                 // unique, required
  "factionId": "my-faction",       // required
  "displayName": "My Team",        // required
  "blurb": "One line of flavour.",
  "supportLevel": 1,               // 0-5, see below — must be honest
  "dataVersion": "2026-09-10",
  "source": {                      // required: where this data came from
    "publisher": "…",
    "url": "https://…",
    "checkedAt": "2026-09-10",
    "notes": "…"
  },
  "colors": { "primary": "#4a7fb5", "accent": "#d8e3ef" },

  "roster": {
    "maxOperatives": 5,
    "selectionRules": [],          // verbatim selection text, for humans only
    "operatives": [                // which profiles are fielded, and how many
      { "profileId": "sergeant", "count": 1 },
      { "profileId": "trooper",  "count": 4 }
    ]
  },

  "operatives": [
    {
      "id": "trooper",
      "name": "Trooper",
      "role": "flexible",          // drives AI weighting, see below
      "baseDiameter": 1.25,        // inches
      "stats": { "move": 6, "apl": 2, "save": 3, "wounds": 12 },
      "weapons": [
        {
          "id": "rifle", "name": "Rifle", "type": "ranged",
          "range": 12, "atk": 4, "hit": 3,
          "damage": { "normal": 3, "critical": 4 },
          "rules": ["balanced"],   // engine keys; unknown ones are ignored
          "rulesText": "Balanced"  // optional: the rules as printed
        },
        {
          "id": "fists", "name": "Fists", "type": "melee",
          "atk": 3, "hit": 4, "damage": { "normal": 3, "critical": 4 }, "rules": []
        }
      ],
      "abilities": [],             // [{id, name, cost, description}] — data only
      "keywords": ["leader"]
    }
  ],

  // `factionRules` is [{id, name, description}] — reference text.
  // Ploys are [{id, name, description, cost}]; a strategic ploy also carries
  // `hooks`, which is what makes it playable. Equipment is [{id, name,
  // description}]. `ruleHooks` is the always-on half. See below.
  "factionRules": [],
  "strategicPloys": [], "firefightPloys": [], "equipment": [],
  "ruleHooks": [],
  "weaponRules": {},
  "resources": {}                  // team resource economies; see below
}
```

### Roles

`assault`, `ranged`, `sniper`, `support`, `objective-runner`, `flexible`.
Roles change how the AI weighs damage, objectives, cover, exposure and closing
distance — they do not change what is legal.

### Disposition (`aiDisposition`, optional)

A role says how one operative plays; a disposition says how the whole kill team
plays. Packs inherit one from their `factionId` (Orks press forward, Astra
Militarum hold a firing line) and may override it:

```jsonc
"aiDisposition": "aggressive",      // balanced | aggressive | patient | skirmish | relentless
```

or inline a custom one, as multipliers over the role weights:

```jsonc
"aiDisposition": {
  "label": "Fanatical",             // shown in the combat log
  "note": "ignores the odds",
  "mods": { "damage": 1.3, "exposure": 0.6, "approachFloor": 3.5 }
}
```

Keys are the weights in `src/ai/controller.js` (`damage`, `objective`, `cover`,
`exposure`, `waste`, `survival`, `approach`); unknown keys are ignored.
`approachFloor` is the exception to the multipliers: it raises the drive to
close to at least that value, whatever the role would otherwise have wanted.

Per-unit tactics need no data: they are read off the profile's own weapons.
Blast and Torrent make an operative hunt for clustered targets, a
`selfPrimaryTarget` weapon (Explosive) makes it hunt for a crowd to stand in,
and a `psychic` weapon makes it value getting the cast off. See
`src/ai/tactics.js`.

### Rule hooks

`factionRules` is prose for a reader. `ruleHooks` is the machine-readable half:
a trigger, an optional condition, and an effect from a fixed vocabulary. Hooks
are **data** — nothing in one is evaluated as code, and an unknown trigger,
condition or effect is reported in the battle log and then ignored, never
guessed.

```jsonc
{
  "id": "living-metal",          // required, unique within the pack
  "rule": "Living Metal",        // the faction rule this implements, for the log
  "trigger": "onTurningPointStart",
  "condition": { "keyword": "hierotek-circle" },
  "effect": { "type": "healWounds", "dice": "D3+1" },

  "partial": true,               // optional: this is only half the printed rule
  "notes": "the Save bonus WITHIN SHADOW is not simulated"
}
```

A `partial` hook must say what is missing in `notes`. The engine raises that
text once per battle as an unsupported-rule warning, so a half-implemented rule
is visible rather than silently wrong.

**Triggers**

| Trigger | Fires |
|---|---|
| `onTurningPointStart` | Ready step of each Strategy phase |
| `onActivationStart` | when an operative is activated (and on counteract) |
| `onActionLegality` | whenever the action layer asks what is still allowed |
| `beforeAttackRoll` | after the weapon is chosen, before dice are rolled |
| `beforeDefenceRoll` | on the defender's team, before defence dice |
| `beforeDamageApplied` | on the damaged operative, before wounds are lost |
| `onTargetSelection` | on a would-be target, before Seek or a spotter get a say |
| `afterAction` | on the operative, once an action has fully resolved |
| `afterRetaliation` | on the operative that was fought against, sequence over |
| `onIncapacitated` | on the operative that just went down, before it is removed |
| `onActivationEnd` | as an activation closes, before its ploys lapse |

`afterAttackRoll` and `onDamageApplied` are recognised trigger names with no
effects wired to them yet.

**Conditions** — all keys are ANDed, and all are optional:

*About this operative:* `keyword`, `notKeyword`, `role`, `orderIs`,
`selfWounded`, `selfReady`, `awayFromFriends`, `awayFromEnemies`,
`withinShadow`, `counteracting`, `performedThisActivation`,
`notPerformedThisActivation`.

*About the action that just finished* (`afterAction` only): `actionIs`,
`actionCountAtMost` — together these say "if the FIRST action it performs
during that activation is the Charge action".

*About the weapon:* `weaponType`, `weaponIdIn`, `weaponNameContains`,
`weaponHasAnyRule`.

*About the sequence and the other operative in it:* `action` (`"shoot"` or
`"fight"`), `targetWithin`, `targetBeyond`, `targetOrderIs`, `targetKeyword`,
`targetNotKeyword`, `targetWounded`, `targetReady`.

The sequence conditions exist because most printed ploys are not team-wide
buffs but buffs that apply *in a situation* — "shooting an operative within
6\"", "fighting a ready enemy operative", "more than 5\" from other friendly
operatives". Without them a pack can only express the unconditional minority,
and authoring the rest anyway would silently drop the condition and make every
one of those rules stronger than printed.

`notKeyword` also takes a list, because a printed exclusion is often plural:
`"notKeyword": ["ogryn", "bullgryn"]`. `awayFromEnemies: 4` is the mirror of
`awayFromFriends` — more than 4" from every enemy operative.

`targetReady` is `false` for an *expended* operative (one that has already
activated this turning point). `awayFromFriends: 5` means more than 5" from
every other friendly operative. `selfWounded`/`targetWounded` use the Injured
threshold: half wounds or fewer.

`withinShadow` is the Mandrakes' terrain state: within 1" of Heavy terrain, or
a base underneath Vantage terrain. Heavy is every piece that is neither `light`
nor `insignificant`, so no map needs a new trait.

Conditions are evaluated **when the trigger fires**, not cached at activation
start, so `notPerformedThisActivation` correctly stops applying the moment the
operative moves.

**Effects**

| Effect | Fields | Does |
|---|---|---|
| `grantWeaponRule` | `rules[]` | Adds weapon rules for this sequence only |
| `ignoreWeaponRules` | `rules[]` | Strips rules before the defence roll |
| `modifyDefenceDice` | `delta` | Adds or removes defence dice |
| `modifySave` | `delta` | Improves (negative) or worsens the Save stat for this roll |
| `rerollDefenceDice` | `count` | Re-rolls that many failed defence dice |
| `capDamage` | `max`, `perAction` | Caps damage from one action |
| `healWounds` | `dice` | Regains lost wounds, e.g. `"D3+1"` |
| `allowChargeWhileConceal` | — | Charge without an Engage order |
| `extraAction` | `action` or `oneOf[]`, `count` | Repeats an action |
| `freeAction` | `action` | One action per activation costing no AP |
| `grantAllyApl` | `amount`, `within`, `keyword` | Hands APL to a friendly operative when this one activates |
| `inflictDamage` | `dice`, `within`/`controlRangeOnly`, `requireVisible`, `scope`, `target`, `count` | Damages enemies around this operative |
| `inflictToken` | `token`, `within`/`controlRangeOnly`, `requireVisible`, `scope`, `target`, `count` | Hangs a token on them instead |
| `changeOrder` | `order`, `count` | Flips this operative's order |
| `denyTargeting` | `requireConceal`, `requireCover`, `exceptWithin` | This operative cannot be selected as a valid target |

`scope: "each"` reaches every enemy in the radius; the default picks the single
one closest to dying. `target: "attacker"` reaches the other operative in the
sequence instead of a radius — which is how "strike the enemy operative in that
sequence" is modelled once the dice are gone. `count` is a budget for the whole
hook rather than per operative, rolled once (`"D3"`) and drawn down as the
Strategy-phase sweep walks the roster, so "select ONE enemy operative" and "up
to D3 friendly operatives" both come out right.

`inflictToken` takes the same `token` block weapon rules use (see
`rules/tokens.js`): `{kind, label, onActivation, whileHeld, expiry}`.
`whileHeld.aplDelta` is what a printed "subtract 1 from its APL stat" becomes,
and `expiry.endOfNextActivation` is what makes it lapse when it should.

`extraAction` with `oneOf` models the Astartes shape — *either* two Shoot
actions *or* two Fight actions: whichever is repeated first claims the grant.

### Team resource economies (`resources`)

Some teams run an economy: they earn a countable *something* — a Pain token, a
level of GORE TANK, a Blooded token — from what their operatives do, and spend
it again on a menu of effects. Three parts, declared as data, with nothing
evaluated and every unknown trigger, window, condition or effect reported and
ignored rather than guessed.

```jsonc
"resources": {
  "pain": {
    "name": "Pain token",             // shown on the roster card
    "rule": "Power From Pain",        // the faction rule, for the log
    "text": "…the printed wording…",
    "scope": "operative",             // or "player" — a pool the team shares
    "keyword": "hand-of-the-archon",  // who may hold and spend it
    "start": 0,                       // GORE TANKs start at half, so: 1
    "max": 2,                         // optional cap
    "levels": ["empty", "half", "full"],   // optional: a track, not a count
    "perActivation": 1,               // spends per activation or counteraction

    "gains": [
      { "trigger": "enemyInjured", "amount": 1 },
      { "trigger": "enemyIncapacitated", "amount": 1,
        "bonusIfWoundsAtLeast": { "wounds": 12, "amount": 2 } }
    ],
    "spends": [
      { "id": "dark-animus", "name": "Dark Animus", "text": "…",
        "window": "activation", "cost": 1,
        "effect": { "type": "addApl", "amount": 1 } }
    ]
  }
}
```

**Gain triggers**

| Trigger | Fields | Pays out when |
|---|---|---|
| `readyStep` | `amount` | The Ready step of each turning point |
| `enemyInjured` | `amount` | The holder's action left an enemy Injured and alive |
| `enemyIncapacitated` | `amount`, `bonusIfWoundsAtLeast` | The holder's action killed an enemy |
| `killWithin` | `within`, `amount` | The holder killed something within x" (control range always counts) |
| `firstKillEachTurningPoint` | `amount` | The team's first kill of the turning point |
| `firstLossNearEnemyEachTurningPoint` | `within`, `amount` | The team's first loss within x" of an enemy |

Gains are read off the events the action produced, so they cannot drift out of
step with what the rules actually did. `enemyInjured` uses the **Injured**
keyword — half wounds or fewer — not "took any damage".

**Spend windows**

| Window | Spent as |
|---|---|
| `activation` | A 0-AP action the AI proposes, legal before or after any action |
| `attackDice` | Inside the attack roll, by the engine's own policy |
| `defenceDice` | Inside the defence roll, by the engine's own policy |

**Spend effects**

| Effect | Fields | Does |
|---|---|---|
| `addApl` | `amount` | +APL until the start of the next activation, and the AP now |
| `healWounds` | `dice` | Regains lost wounds |
| `freeAction` | `action`, `unrestricted` | One action costing no AP; `unrestricted` also lifts the once-per-activation limits |
| `extraAction` | `action`, `count`, `free` | Repeats an action this activation |
| `weaponBoost` | `weaponType`, `atkBonus`, `damageNormal`, `damageCritical`, `rules[]`, `appliesTo[]` | A better profile for the next action of that type |
| `moveBonus` | `inches`, `appliesTo[]` | Adds to the Move stat for the next such move |
| `inflictDamage` | `dice`, `within` | Damages an enemy the operative is standing over |
| `rerollDice` | `mode` (`oneResult` / `any`) | Re-rolls dice in a dice window |

**Spend limits**, all optional and all enforced by the rules layer:
`cost` (default 1), `perActivation` on the spend (default 1) and on the
resource (a cap across all its spends), `exempt` (this spend does not count
against the resource's cap — Stimulated Senses), `group` (two declarations of
one printed rule sharing an allowance, as the attack and defence halves of
Stimulated Senses do), and `excludes[]` (Mania and Fury in one activation).

**Spend conditions** — ANDed, all optional: `keyword`, `wounded`, `injured`,
`incapacitatedThisActivation`, `actionAvailable`, `performedThisActivation[]`,
`notPerformedThisActivation[]`, `enemyWithinControlRange`.

**Assignment** (`assign`) turns a shared pool into per-operative tokens in the
Ready step — the Blooded STRATEGIC GAMBIT:

```jsonc
"assign": {
  "trigger": "readyStep", "toKeyword": "blooded", "maxPerOperative": 1,
  "token": { "kind": "blooded", "label": "Blooded",
             "whileHeld": { "weaponRules": ["accurate1"] } },
  "elevate": { "atLeast": 4, "label": "Gaze of the Gods",
               "token": { "kind": "gaze", "label": "Gaze of the Gods",
                          "whileHeld": { "weaponRules": ["accuratecrits1"] },
                          "expiry": { "endOfTurningPoint": true } } }
}
```

Who spends, and when: `activation` spends are chosen by the AI (`src/ai/
spending.js`) and validated by the action layer like any other action, so a
spend the AI asks for out of turn is refused rather than applied. Dice-window
spends have no action layer to ask, so `rules/resources.js` applies one
documented policy: re-roll the failing result the most dice are showing, when
that is worth at least 0.6 of a success in expectation.

### Ploys (`strategicPloys`, `firefightPloys`)

Every ploy is `{id, name, description, cost}` — `cost` in CP, defaulting to 1.
`description` is the printed wording, kept so a reader can check the engine
against the page.

A **strategic ploy** becomes playable by adding `hooks`, which are `ruleHooks`
in every respect except who pays for them: same triggers, same conditions, same
effects, same `partial`/`notes` discipline. The player buys the ploy in the
strategy phase and its hooks are in force until the end of that turning point.

```jsonc
{
  "id": "waaagh",
  "name": "WAAAGH!",
  "cost": 1,
  "description": "Friendly KOMMANDO operatives' melee weapons have the Balanced weapon rule.",
  "hooks": [{
    "trigger": "beforeAttackRoll",
    "condition": { "keyword": "kommando", "weaponType": "melee" },
    "effect": { "type": "grantWeaponRule", "rules": ["balanced"] }
  }],
  "oncePerBattle": false          // optional; most ploys may recur each turning point
}
```

A ploy with **no** `hooks` is not an error — it is one this engine cannot play.
It stays in the catalogue, and `rules/ploys.js` reports it once at battle start
so an absent rule is visible rather than silently missing.

A **firefight ploy** is bought during the fighting rather than before it, and
says which window it belongs to with `timing`:

| `timing` | When it is bought | Which triggers still fire |
|---|---|---|
| `activation` (default) | During a friendly operative's activation, as a 0-AP `{"type":"ploy"}` action the AI plans and the action layer validates | `onActivationStart` (replayed at purchase), `onActionLegality`, and every attack trigger for the rest of the activation |
| `defence` | When that operative is attacked — a reaction, bought inside somebody else's sequence | `onIncomingAttack`, `beforeDefenceRoll`, `beforeDamageApplied` |
| `demise` | When that operative is incapacitated, before it is removed | `onIncapacitated` |

```jsonc
{
  "id": "bladewind",
  "name": "BLADEWIND",
  "cost": 1,
  "timing": "activation",         // default; "defence" for a reaction
  "scope": "operative",           // default; "team" buffs the whole team for that activation
  "oncePerTurningPoint": false,   // optional, alongside oncePerBattle
  "description": "During that activation, that operative can perform two Fight actions.",
  "hooks": [{
    "trigger": "onActionLegality",
    "effect": { "type": "extraAction", "action": "fight", "count": 1 }
  }]
}
```

An activation ploy's hooks are scoped to the operative that paid for it and
lapse when its activation ends. A reaction lasts the sequence it was bought
against, so one ploy may both add defence dice and blunt the damage that gets
through.

A `demise` ploy is the death-throe family — the Gellerpox bursting, a Khorne
Legionary getting one last swing in. It is bought the way a reaction is, out of
the same `reactionBudget`, but with no judgement about whether the moment is
worth it: an operative that is already down has nothing left to protect, and
the ploy expires with it, so the only questions are whether the team kept CP
back and whether the throes have anybody to reach.

A reaction has no action layer to ask — there is no AI turn inside an attack —
so `rules/ploys.js` follows one published policy: at most one reaction per
sequence, funded by the `reactionBudget` the controller's CP doctrine wrote
onto the player, and taken only when the attack clears the doctrine's
`reactionTrigger` (`always`, `wounded`, or `lethal`, which projects the
attack's damage against the defender's remaining wounds).

**Equipment is not simulated**: it is chosen before the battle, and the engine
has no pre-battle selection step. Each item is reported at battle start.

The AI values a ploy by what its hooks do, weighted by the share of the roster
that can use them and the team's disposition (`src/ai/ploys.js`), so a melee
buff is bought by a team that reaches melee and skipped by a gunline. A
firefight ploy is priced for the plan it would buy — a second Fight action is
worth a CP to an operative that is charging and nothing to one about to shoot.
Nothing there is tuned per team: a new ploy gets a sensible valuation from its
data.

### Command Point doctrine (`aiCpDoctrine`)

How much CP a team is willing to let go of, and when, is chosen by
`src/ai/cp.js`. It is derived from the ploys a pack declares and the team's
disposition, so a pack needs no field at all; `aiCpDoctrine` overrides it with
a name (`vanguard`, `gunline`, `raider`, `bulwark`, `tactician`) or an inline
block of the same knobs.

| Doctrine | Plays CP as |
|---|---|
| `vanguard` | Holds it for the fight: a strategic ploy has to beat the second Fight action the same point could buy mid-charge |
| `gunline` | Buys the turning point it can shoot through, and keeps a point in hand |
| `raider` | Banks early, empties its hand on the turning point it commits |
| `bulwark` | Keeps CP to answer the attack that would take an operative off the board |
| `tactician` | Takes the best buy each turning point |

The doctrine is re-planned every turning point and stored on the player as
`cpPlan`, which is what lets the rules layer spend a reaction's CP without an
AI in the loop.

### Support levels (§10)

| Level | Meaning | Badge |
|---|---|---|
| 0 | Metadata only, no playable data | Reference only |
| 1 | Core stats and basic weapons | Core compatible |
| 2 | Roster restrictions | Core compatible |
| 3 | Faction rules (via `ruleHooks` or `resources`) and core operative abilities | Mostly supported |
| 4 | Ploys wired up via `hooks` — strategic, and firefight ploys with a `timing` | Mostly supported |
| 5 | Full supported team behaviour | Full engine support |

Declare the level you actually implement. The validator warns when a pack
claims a level whose content it doesn't contain, and the badge is shown on the
setup screen so nobody is misled about fidelity.

### Weapon rules

A rule token is a lowercase name, optionally carrying a number (`devastating3`,
`piercing1`, `blast2`, `limited1`) or, where the printed rule names an action
rather than a number, a `:qualifier` (`heavy:dash`, `heavy:reposition` for
`Heavy (Dash only)` and `Heavy (Reposition only)`). Bare `heavy` is the
unqualified rule, which forbids every move.

See `docs/implemented-rules.md` for the implemented list. Every **universal**
weapon rule resolves from the engine's own table, because those mean the same
thing on every datasheet. The **team-specific** ones — the asterisked rules —
do not, and are declared by the pack itself in `weaponRules` (below).

Unknown rules load fine but are reported in the battle log and ignored during
resolution. Keep the printed wording in `rulesText` so an unimplemented rule is
still legible to a reader — the transcribed packs under `data/teams/` all do,
and the operative inspector shows it in preference to the tokens.

### Team-specific weapon rules (`weaponRules`)

The asterisked rules cannot live in the engine, because the same printed name
means different things on different datasheets: Poison inflicts 1 damage per
activation for Plague Marines and D3 for Raveners, and Detonate is three
unrelated rules on three teams. So a pack declares what *its* rules do, keyed
by the bare lowercase rule token:

```jsonc
"weaponRules": {
  "poison": {
    "rule": "Poison",                 // the printed name, for the log
    "text": "In the Resolve Attack Dice step, if you inflict damage …",
    "effect": {
      "type": "inflictToken",
      "trigger": "anySuccess",
      "excludeKeyword": "plague-marine",
      "token": { "kind": "poison", "label": "Poison", "onActivation": { "damage": "1" } }
    },
    "partial": false,                 // optional, with `notes` when true
    "notes": ""
  }
}
```

`text` is the printed wording, kept for the same reason `rulesText` is kept on
a weapon: a reader can check the engine against the page. A rule token with no
declaration is reported as unimplemented, exactly as before — declaring one is
what makes it resolve.

**Effect types**

| Effect | Key fields | Does |
|---|---|---|
| `inflictToken` | `trigger`, `token`, `target`, `within`, `excludeKeyword` | Hangs a token on the operative the weapon was used against |
| `damageBonusVsToken` | `token`, `normal`, `critical` | Adds to both Dmg stats against a token holder |
| `aplDefence` | — | Defence dice succeed at or under the target's APL |
| `firstShootActionOnly` | — | Usable only on the operative's first Shoot action of the battle |
| `moveLimit` | `inches` | A movement budget the weapon enforces in both directions |
| `grantRuleIf` | `rules[]`, `atkBonus`, `damageNormal`, `damageCritical` + a condition | Adds rules or stats when the condition holds |
| `fixedUpgrade` | `rules[]`, `damageNormal`, `damageCritical` | A pre-battle loadout choice, applied all battle |
| `meleeModifier` | `blockMultiplier`, `defenderResolvesFirst`, `push`, `repeatFight`, `riposte`, `crush`, `doubleStrikeVsExpended` | Bends the fight sequence |
| `extraPrimaryTargets` | `count` | More than one primary target for one Shoot action |
| `selfPrimaryTarget` | `shootSelf`, `allowWhileEngaged` | The weapon goes off in the operative's own hands |
| `friendlyPrimaryTarget` | `keyword` | A named friendly operative is the primary target |
| `spotterTargeting` | `keywords[]`, `grantRules[]` | Target, cover and obscured measured from a friendly spotter |
| `chainOnIncapacitate` | `damage`, `range` | Damage everyone near an operative this weapon kills |
| `beamLine` | `damage` | Each retained critical burns everyone behind the target |
| `healOnDamage` | `keyword`, `within`, `perNormal`, `perCritical`, `oncePerTurningPoint` | A friendly regains wounds per damaging die |
| `executeRoll` | `dice` | A roll that can finish off a target that survived |
| `onIncapacitate` | `dice`, `heal`, `weaponCriticalBonus` | Rewards the wielder for a kill |
| `dragTarget` | `perSuccess` | Hauls the target towards the shooter before damage |
| `retaliationRoll` | `dice`, `threshold`, `damage` | A fighter hurt but not put down rolls to hurt back |
| `gainResource` | `resource`, `scope`, `trigger`, `target`, `within`, `amount` | Pays into a team resource economy (see that section) |
| `recognised` | — | The engine knows the rule and deliberately does nothing (needs `partial`) |
| `unusable` | `reason` | The weapon needs a subsystem the engine lacks, so it never fires |

**`grantRuleIf` conditions** — all optional, all ANDed:

`action` (`"shoot"` / `"fight"`), `performedThisActivation[]`,
`notMovedThisActivation` (with `orCounteraction`), `targetKeyword`,
`targetWounded`, `targetExpended`, `targetWithin` (inches),
`terrainWithinControlRange`.

**`inflictToken` triggers**: `anySuccess` (damage from any retained success),
`criticalSuccess` (damage from a critical, Devastating included), and
`anyDiceResolved` (dice resolved and the target survived).

**Token shape**: `{kind, label, stacks, unique, onActivation: {damage, removal:
{d6}}, whileHeld: {moveDelta, hitPenalty, notCumulativeWithInjured,
weaponRules[], weaponType}, expiry: {endOfNextActivation, endOfTurningPoint}}`.
Damage expressions are `"1"`, `"D3"`, `"2D6"`, `"D3+1"`. A token is usually
something stuck to an enemy, but `whileHeld.weaponRules` runs the other way: a
Blooded token assigned to one of your own gives its weapons Accurate 1.

Marking a rule `partial` (with `notes`) raises it once per battle in the
warnings, exactly as a `partial` rule hook does — so a rule that is only half
simulated says so instead of implying full fidelity.

Kill Team ranged weapons have no printed range stat unless they carry a `Range
N"` rule, but the engine requires a number. The transcribed packs use `48` for
the unlimited case, which spans any legal board.

## Map

```jsonc
{
  "id": "my-map",
  "name": "My Map",
  "version": 1,
  "board": { "width": 30, "height": 22, "units": "inches" },
  "terrain": [
    {
      "id": "ruin-01",
      "shape": { "type": "polygon", "points": [{ "x": 8, "y": 6 }, …] },
      "height": 2.5,
      "traits": ["obscuring", "cover", "blocking"],   // "light" = Light terrain
      "render": { "styleId": "industrial-wall" }
    }
  ],
  "objectives": [{ "id": "obj-1", "x": 15, "y": 11, "controlRange": 1 }],
  "deploymentZones": [
    { "id": "dz-p1", "playerId": "p1", "shape": { "type": "polygon", "points": [ … ] } },
    { "id": "dz-p2", "playerId": "p2", "shape": { "type": "polygon", "points": [ … ] } }
  ],
  "metadata": { "author": "", "license": "", "sourceUrl": "" }
}
```

Terrain geometry is rules-authoritative; `render` is cosmetic only. A map never
depends on a background image to determine terrain behaviour.

Terrain traits: `obscuring`, `cover`, `traversable`, `blocking`,
`insignificant`, `vantage`, and `light`. A piece traited `light` still grants
cover; the trait exists so `Seek Light` weapons can ignore exactly that class
of terrain when selecting a target. Anything untraited counts as Heavy.

## Mission

```jsonc
{
  "id": "my-mission",
  "name": "My Mission",
  "turningPoints": 4,
  "scoring": {
    "objectives": { "vpPer": 1, "maxPerTurningPoint": 3 },
    "kills":      { "vpPer": 1, "maxPerTurningPoint": 2 },
    "endOfBattle": { "wipeoutVp": 3, "survivorVpPer": 0 }
  }
}
```

### Victory conditions

A mission wins by victory points unless it says otherwise:

| `victory.type` | Ends when | Winner |
|---|---|---|
| `victoryPoints` (default) | `turningPoints` have been played, or a team is wiped out | Most VP; ties break on survivors |
| `lastTeamStanding` | One team has nobody left | The team still standing |

```jsonc
{
  "id": "deathmatch",
  "victory": { "type": "lastTeamStanding", "turningPointCap": 12 },
  "ignoreObjectives": true,
  "scoring": { "kills": { "vpPer": 1 } }
}
```

`turningPointCap` is a stop, not a clock: two teams that never find each other
would otherwise run forever. If it is reached with both teams alive, the result
is decided on surviving operatives and then on total wounds remaining, and says
so. `ignoreObjectives` drops the map's objective markers for the battle, so a
deathmatch is fought over nothing but each other. A `lastTeamStanding` mission
is the only one allowed to define no scoring at all.

## Limits

Enforced so a broken or hostile file cannot wedge the simulator: 24 operatives
per team, 8 weapons per operative, 120 terrain pieces, 64 points per polygon,
12 objectives, board between 12" and 60" per side.
