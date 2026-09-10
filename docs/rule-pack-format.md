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

  // Ploys and equipment are [{id, name, description}]; ploys also carry `cost`
  // in CP. `factionRules` is [{id, name, description}] — reference text.
  // `ruleHooks` is what the engine actually acts on; see below.
  "factionRules": [],
  "strategicPloys": [], "firefightPloys": [], "equipment": [],
  "ruleHooks": []
}
```

### Roles

`assault`, `ranged`, `sniper`, `support`, `objective-runner`, `flexible`.
Roles change how the AI weighs damage, objectives, cover, exposure and closing
distance — they do not change what is legal.

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

`afterAttackRoll`, `onDamageApplied` and `onActivationEnd` are recognised
trigger names with no effects wired to them yet.

**Conditions** — all keys are ANDed, and all are optional:

`keyword`, `notKeyword`, `role`, `orderIs`, `weaponType`, `weaponIdIn`,
`weaponNameContains`, `weaponHasAnyRule`, `performedThisActivation`,
`notPerformedThisActivation`.

Conditions are evaluated **when the trigger fires**, not cached at activation
start, so `notPerformedThisActivation` correctly stops applying the moment the
operative moves.

**Effects**

| Effect | Fields | Does |
|---|---|---|
| `grantWeaponRule` | `rules[]` | Adds weapon rules for this sequence only |
| `ignoreWeaponRules` | `rules[]` | Strips rules before the defence roll |
| `modifyDefenceDice` | `delta` | Adds or removes defence dice |
| `rerollDefenceDice` | `count` | Re-rolls that many failed defence dice |
| `capDamage` | `max`, `perAction` | Caps damage from one action |
| `healWounds` | `dice` | Regains lost wounds, e.g. `"D3+1"` |
| `allowChargeWhileConceal` | — | Charge without an Engage order |
| `extraAction` | `action` or `oneOf[]`, `count` | Repeats an action |
| `freeAction` | `action` | One action per activation costing no AP |

`extraAction` with `oneOf` models the Astartes shape — *either* two Shoot
actions *or* two Fight actions: whichever is repeated first claims the grant.

### Support levels (§10)

| Level | Meaning | Badge |
|---|---|---|
| 0 | Metadata only, no playable data | Reference only |
| 1 | Core stats and basic weapons | Core compatible |
| 2 | Roster restrictions | Core compatible |
| 3 | Faction rules (via `ruleHooks`) and core operative abilities | Mostly supported |
| 4 | Team ploys and equipment | Mostly supported |
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

See `docs/implemented-rules.md` for the implemented list — every universal
weapon rule resolves; the team-specific ones printed with an asterisk do not.
Unknown rules load fine but are reported in the battle log and ignored during
resolution. Keep the printed wording in `rulesText` so an unimplemented rule is
still legible to a reader — the transcribed packs under `data/teams/` all do,
and the operative inspector shows it in preference to the tokens.

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

## Limits

Enforced so a broken or hostile file cannot wedge the simulator: 24 operatives
per team, 8 weapons per operative, 120 terrain pieces, 64 points per polygon,
12 objectives, board between 12" and 60" per side.
