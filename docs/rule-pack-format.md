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
  "lore": "A paragraph about who they are. Shown under the blurb on the setup
            screen; never read by the engine. Max 1200 chars, sanitised on load.",
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
      "lore": "A sentence or two about this one. Shown on its character sheet
                between the portrait and the stats. Same limit as team lore.",
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
      // [{id, name, cost, description}]. An ability that costs AP may also
      // carry an `action` block, which is what makes it performable rather
      // than reference text — see "Unique actions" below.
      "abilities": [],
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

### Character (`operatives[].aiCharacter`, optional)

A disposition says how the kill team plays; a **character** says how one
operative on it plays, which for a specialist is most of what it is. It needs
no data either: it is read off the keywords the profile already prints.

| Archetype | Keywords that select it | What changes |
| --- | --- | --- |
| `leader` | `leader` | values surviving to give the next order; its own actions are worth more |
| `champion` | `champion`, `boss-nob`, `exarch`, `butcher`, `superior`, `sergeant`, `aspirant`, `assault-intercessor` | closes hard, and goes for the enemy leader |
| `adept` | `psyker`, `sorcerer`, `cryptek`, `magus`, `primaris-psyker` | its printed spells are the repertoire; hunts enemy casters |
| `medic` | `medic`, `apothecary`, `reliquarius`, `chirurgeon` | stays behind the line; the Medikit beats the point it costs |
| `marksman` | `sniper`, `marksman`, `sharpshooter` | holds a lane; picks leaders, casters, medics and heavy gunners |
| `herald` | `vox-operator`, `spotter`, `surveyor`, `icon-bearer`, `horn-bearer`, `comms`, `standard-bearer`, `tracker` | the printed action *is* the contribution |
| `gunner` | `heavy-gunner`, `gunner`, `grenadier` | finds a firing position and stays in it |
| `infiltrator` | `infiltrator`, `scout`, `ranger`, `incursor`, `sicarian`, `mandrake`, `stalker` | works the flanks, stays off the skyline |
| `outrider` | `jump-pack`, `mounted`, `grav-chute`, `wings` | covers ground nobody else can |
| `expendable` | `servitor`, `drone`, `mutoid-vermin`, `bomb-squig`, `canoptek` | worth more used than preserved |

An operative takes up to three, in the order its keywords are printed, and
their multipliers compound. A pack that disagrees says so on the profile:

```jsonc
"aiCharacter": "champion"                      // one archetype by name
"aiCharacter": ["medic", "herald"]             // several
"aiCharacter": {                               // or spelled out
  "label": "Warlord",                          // shown in the combat log
  "note": "leads from the front",
  "mods":  { "approach": 2.0 },                // as `aiDisposition`, above
  "hunts": { "leader": 1.6 },                  // enemy keywords to go for
  "signature": 1.5                             // what its own actions are worth
}
```

`hunts` scales how much this operative wants a given enemy dead; it steers
target selection without changing what a plan claims it will do. `signature`
scales what the operative's own printed actions are worth against a point of
its AP. An action whose `description` opens with `PSYCHIC` is treated as a
spell wherever a `psychic` weapon would be — including on the semi-manual
menu, where it is offered under "Use a spell" and gets a card of its own.
See `src/ai/characters.js`.

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
`friendlyWithin`, `hasToken`, `notHasToken`, `nearObjective`,
`turningPointAtLeast`, `withinShadow`, `counteracting`,
`performedThisActivation`, `notPerformedThisActivation`.

`friendlyWithin` takes two forms. A bare number is "another friendly operative
within x\"". The object form names *which* friendly — `{"inches": 6, "keyword":
"dark-apostle"}` is "visible to and within 6\" of your DARK APOSTLE", which is
how a printed leash around one named model is written. `notHasToken` is the
mirror of `hasToken`, for a rule that only applies while the operative has
*not* picked something up.

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
| `allowChargeAfterFallBack` | — | Charge later in an activation that already fell back |
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

`target: "self"` is the third option alongside `"attacker"` and a radius: the
rule hangs something on the operative whose own action triggered it. The Red
Thirst is the case it exists for — giving in is a state a Marine puts on
himself, not something done to an enemy.

`inflictToken` takes the same `token` block weapon rules use (see
`rules/tokens.js`): `{kind, label, onActivation, whileHeld, expiry}`.
`whileHeld.aplDelta` is what a printed "subtract 1 from its APL stat" becomes,
and `expiry.endOfNextActivation` is what makes it lapse when it should.

`extraAction` with `oneOf` models the Astartes shape — *either* two Shoot
actions *or* two Fight actions: whichever is repeated first claims the grant.

### Unique actions (`abilities[].action`)

Nearly every printed profile has one or two actions of its own — a Medikit, a
Signal, a Spot, a Veriscant. A pack that only transcribes the wording gets
reference text and nothing else, and for a support operative that is the whole
of its activation: across the bundled roster 21% of all AP went unspent, and
two fifths of that sat on operatives whose only printed job was an action this
engine could not perform.

An `action` block on an ability says what it **does**, and that is what makes
it performable. Like everything else here it is data: an unknown scope,
condition or effect is reported once in the battle log and the action is not
offered, never guessed at.

```jsonc
{
  "id": "medikit",
  "name": "MEDIKIT",
  "cost": "1AP",                      // the printed cost, for a reader
  "description": "…the printed wording…",

  "action": {
    "ap": 1,                          // defaults to the number in `cost`
    "target": {
      "scope": "controlRange",        // see below
      "side": "friendly",             // "friendly" (default) or "enemy"
      "keyword": "death-korps",       // must be a keyword the pack actually uses
      "wounded": true
    },
    "effect": { "type": "healWounds", "dice": "2D3" },
    "limits": { "notEngaged": true, "perTurningPoint": 1 },
    "notes": "…what was approximated…"
  }
}
```

Every unique action is **once per activation per ability**: an operative that
prints two may perform either, but neither twice. An action whose target block
finds nobody is not on the menu at all, which is what keeps a medic from
spending a point on an empty medikit.

**Target scopes**

| Scope | Means |
|---|---|
| `self` | the operative performing the action; the default when no `target` is given |
| `controlRange` | within its control range (1") |
| `within` | within `inches`; add `"visible": true` for "visible to and within x\"" |
| `visible` | visible to it, at any distance |
| `validTarget` | a *valid target* for it — which additionally fails against a concealed operative in cover |

`visible` and `validTarget` are deliberately different, because the printed
actions use both: "select one enemy operative **visible to** this operative" is
a line-of-sight question a Spot can answer about somebody hiding, and "select
one enemy operative **that's a valid target for** this operative" cannot.

**Target conditions** — ANDed, all optional: `side`, `keyword`, `notKeyword`,
`excludeSelf`, `wounded`, `ready`, `hasToken`, `notHasToken`.

**Effects**

| Effect | Fields | Does |
|---|---|---|
| `healWounds` | `dice` | The target regains up to that many lost wounds, capped at what it lost |
| `addApl` | `amount`, `token`, `expiry` | +APL, carried on a token so it survives until the target activates. Bought mid-activation for itself, the point is spendable now |
| `subtractApl` | `amount`, `token`, `expiry` | The same, the other way |
| `mark` | `weaponRules[]`, `keyword`, `weaponType`, `expiry` | A mark on an enemy: this team's attacks against it gain those weapon rules. Read when the target is *selected* as well as when the dice are rolled |
| `freeAction` | `action`, `immediate`, `allowOrderChange`, `unrestricted` | A free action. On somebody else it must be `shoot` or `fight` and resolves immediately |
| `extraAction` | `action`, `count`, `free` | Another use of an action, this activation. Self only |
| `weaponBoost` | `rules[]`, `weaponType`, `atkBonus`, `damageNormal`, `damageCritical`, `appliesTo[]` | A better profile. On somebody else, only the `rules` half can be carried |
| `moveBonus` | `inches`, `appliesTo[]` | Extra inches for a move action |
| `inflictDamage` | `dice` | Damage on the target, credited to the operative that acted |
| `changeOrder` | — | Flips the target's order |
| `gainResource` | `resource`, `amount` | Adds to a resource the pack declares |
| `gainCp` | `amount` | Command Points, unconditionally |
| `discardToken` | `token`, `owner` | Removes a token |

One thing to know before writing an effect that points at **another**
operative: an allowance parked on an operative for "this activation" is wiped
when that operative next activates, which is right for a self-buff and
silently useless for a gift. So a gift either lands immediately or rides a
token. `addApl`, `subtractApl`, `mark`, and the rules half of `weaponBoost` and
`moveBonus` ride tokens; a `freeAction` resolves there and then; `extraAction`,
and extra attack dice or damage on somebody else, are **reported as
unsupported** rather than quietly dropped.

The token-carried effects are all "if it doesn't already have one": an
operative that is already Signalled is not a legal target for another Signal.

**Limits**

| Limit | Means |
|---|---|
| `notEngaged` | "cannot perform this action while within control range of an enemy operative" |
| `perTurningPoint` | uses per turning point; reset in the Ready step |
| `perBattle` | uses for the whole battle |
| `notFirstTurningPoint` | "cannot perform it during the first turning point" |
| `requiresToken` | the operative must be holding one of its own team's tokens of that kind |
| `requiresResource` | the pack must declare that resource |

`notes` is for an approximation, and works like a hook's: say what the block
leaves out, and the engine raises it on the operative's character sheet. An
ability that costs AP and declares **no** `action` block is named individually
in the battle log at setup, because it is a specific, fillable gap.

**What the AI does with them.** `src/ai/support.js` prices every unique action
in *expected wounds*, the same unit a shot is priced in, and performs it before
the rest of the activation is planned when it is worth more than a point of
that operative's own AP — so a Boss Nob keeps its point for the power klaw and
a weaponless C.A.T. unit always Spots. Where the scope is short-ranged, the
planner will also walk the operative into reach first, which is the difference
between a medic that heals and a medic that stands two inches away from the
casualty for four turning points.

### Marker-control modifiers (`controlModifiers`)

Kill Team writes a surprising number of rules as "treat its APL as one higher
when determining control of markers", and then goes out of its way to add "this
does not change its APL stat". They cannot be rule hooks: a hook fires at a
moment, and control is recomputed continuously from wherever everyone happens
to be standing. So a pack declares them as their own block, and
`rules/objectives.js` reads it when it works out who holds what.

```jsonc
"controlModifiers": [
  {
    "id": "heir-of-azkaellon",          // required, unique within the pack
    "rule": "Heir of Azkaellon",        // the printed rule, for the log
    "text": "…the printed wording…",
    "delta": 1,                         // required, non-zero
    "cap": 4,                           // optional ceiling on the result
    "condition": {
      "keyword": "sanguinary-guard",
      "friendlyWithin": { "inches": 3, "keyword": "leader" }
    }
  }
]
```

**Conditions** — ANDed, all optional, all about the operative contesting the
marker: `keyword`, `notKeyword`, `hasToken`, `notHasToken`, `wounded`,
`friendlyWithin` (a number, or `{inches, keyword}`), and
`contestedWithKeyword`, which asks about the other friendly operatives *on this
same marker* — "whenever this operative contests a marker alongside at least
one friendly CULTIST operative".

An unknown condition is reported once and the modifier never applies, the same
way an unknown hook condition fails closed. The total a contesting operative
contributes never falls below 1, matching the floor `effectiveApl` already has.
A token's `whileHeld.controlAplDelta` is added first, then every modifier that
matches, then the cap and the floor.

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
    "gainsPerTurningPoint": 1,        // optional cap across ALL of its gains

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
| `readyStep` | `amount`, `requireObjectiveControl` | The Ready step of each turning point; with `requireObjectiveControl` only while the team still holds a marker |
| `enemyInjured` | `amount` | The holder's action left an enemy Injured and alive |
| `enemyIncapacitated` | `amount`, `bonusIfWoundsAtLeast` | The holder's action killed an enemy |
| `killWithin` | `within`, `amount` | The holder killed something within x" (control range always counts) |
| `killNearObjective` | `within`, `amount` | The holder killed something while either of them was within x" of a marker |
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
{d6}}, whileHeld: {aplDelta, controlAplDelta, moveDelta, hitPenalty,
notCumulativeWithInjured, weaponRules[], weaponType}, expiry:
{startOfNextActivation, endOfNextActivation, endOfTurningPoint}}`.

`whileHeld.controlAplDelta` is a different number from `aplDelta`: it moves
what the operative is worth **on a marker** and never touches the AP it gets to
spend, which is exactly what "treat its APL as 1 when determining control of
markers … this does not change its APL stat" asks for. `expiry.
startOfNextActivation` is the shorter of the two activation spans, for a rule
that lapses as the operative comes to its senses rather than after it has
acted.
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
  "blurb": "One line about how it plays.",    // optional; shown on the map picker
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

Two things about map geometry are worth knowing before you draw one, because
both are easy to get wrong and neither fails loudly:

- **A corridor has to fit the widest base that will walk it** — 2.95" in the
  bundled teams. Pathing pushes its waypoints out by the base radius, so a gap
  narrower than that is not merely tight, it is impassable, and an operative
  with nowhere legal to stand is dropped from deployment with a warning rather
  than an error. `test/maps.test.mjs` deploys the widest-based bundled team on
  every map for exactly this reason.
- **Sight-blocking clutter should usually be `traversable`.** `obscuring` plus
  `traversable` breaks a firing lane without narrowing the corridor it sits in,
  which is how both the space hulk and the two melee-leaning killzones keep
  their lanes short without becoming mazes. Reserve `blocking` for the
  structures the map is actually built from; it is also what feeds the pathing
  graph, which is capped at 64 waypoints — roughly sixteen blocking pieces.

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
