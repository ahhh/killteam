#!/usr/bin/env python3
"""Draw the battlefield's animation sprites, and only the ones the data needs.

    python3 tools/make-effects.py                        # write assets/effects/
    python3 tools/make-effects.py --all                  # every family, used or not
    python3 tools/make-effects.py --contact-sheet out.png  # eyeball the result

The battlefield is SVG on a dark board. Everything here is therefore an RGBA
sprite sheet with a real alpha channel — a strip of frames the renderer walks
with one <image> and a clip, laid over the board without touching it. Nothing
is baked against a background colour, so a sprite reads the same over the
board, over terrain, and over an operative's base.

WHY PILLOW AND NOT A DIFFUSION MODEL

A generated picture of an explosion arrives with a background, a light
direction and a style, and fifteen of them in sequence arrive with fifteen of
each. These are geometry: a ring, a falloff, a phase. Drawing them means the
alpha is exact, the loop closes, the palette matches styles.css, and a frame
costs nothing to redraw when it looks wrong.

WHAT GETS DRAWN

A family is one visual idea — `las`, `plasma`, `flame`, `blast`, `strike`.
Every family is scanned for before it is drawn: the weapon names and weapon
rules in data/teams/*.json decide which shot families exist, the ploy hook
effect types decide which ploy families exist, and the token kinds decide which
persistent loops exist. A family nothing in the bundled data can produce is
never drawn and never shipped, so a sprite on disk is evidence that something
can fire it. `--all` overrides that for previewing.

The scan's own answer is written into assets/effects/manifest.json, together
with the pattern table that produced it, so ui/effect-map.js classifies a
weapon with exactly the table used here rather than a second copy that can
drift. See src/ui/effects.js for the playback side.
"""
import argparse
import json
import math
import re
import shutil
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
TEAMS = ROOT / "data" / "teams"
OUT = ROOT / "assets" / "effects"

MANIFEST_VERSION = 1
#: Supersampling factor. Everything is drawn large and shrunk once, which is
#: what keeps a 0.02-wide arc from turning into a staircase.
SS = 3
#: Lossy WebP keeps the alpha channel and costs about a fifth of lossless here.
WEBP = dict(format="WEBP", lossless=False, quality=82, method=6)


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------
#
# A weapon name is matched against an ORDERED list: first pattern wins, so the
# specific entries sit above the general ones ("inferno bolt pistol" is a bolt
# weapon, "inferno pistol" is a melta). Names are normalised to lowercase words
# before matching — several packs spell "hot-shot" with a non-breaking hyphen —
# which is also why every pattern can rely on \b.

def normalise(name):
    """`Hot‑shot long‑las (mobile)` -> `hot shot long las mobile`."""
    return re.sub(r"[^a-z0-9]+", " ", str(name).lower()).strip()


#: (regex, family) for ranged weapons, in priority order.
RANGED_PATTERNS = [
    # Thermal lances. Ordered above `bolt` so "inferno bolt pistol" stays a
    # bolt weapon while "inferno pistol" becomes a melta.
    (r"\binferno bolt|\binferno boltgun", "bolt"),
    (r"\bmelta|\bfusion\b|\binferno pistol|\blascutter|\bmining laser|\bthermal",
     "melta"),
    # Lobbed and launched: anything that arrives at a spot rather than along a
    # line. Above the energy families so "neutron grenade" is a grenade.
    (r"\brokkit|\bmissile|\bgrenade\b|\bgrenade launcher|\bgrenadier|\bmortar"
     r"|\bdemolition|\bbomb\b|\bdynamite|\bcharge\b|\bdetonator|\bapm launcher"
     r"|\bl7\b|\bexplosiv|\brocket|\bmine\b|\bfrag cannon", "rocket"),
    # Plasma, and the pulse and ion guns that read as the same bottled star.
    (r"\bplasma|\bion (blaster|pistol|rifle)|\bpulse|\bphosphor", "plasma"),
    (r"\bbolt|\bbolter|\bboltgun", "bolt"),
    # Flame projectors, before the beams — "brazier of holy fire" is not a las.
    (r"\bflamer|\bburna|\bspewer|\bpyregut|\bigniter|\bsprayer|\bcenser"
     r"|\bbrazier|\bfirestorm|\bfireblast|\bwreathe in fire|\bburning"
     r"|\bskinner|\bspit\b|\beffluence|\bwreathed|\bskytorch"
     r"|\bpyreblaster|\bpurifying flame|\bflame\b", "flame"),
    # The warp: psychic powers, daemonic gifts and miracles. These are not
    # guns, and drawing them as tracer fire is the one thing that would look
    # wrong on every faction that has them.
    (r"\bdoombolt|\bbaleblast|\bbalesurge|\bfluxblast|\binfernal gaze|\bwarpflame"
     r"|\btech curse|\bplague wind|\bhorrif|\bfreezing grasp|\blife siphon"
     r"|\bentropy\b|\bmindburn|\bthunderclap|\bvoice of condemnation|\bholy light"
     r"|\bgaze of the emperor|\bjaws of the world wolf|\bdiabolical stave"
     r"|\barcane conduit|\baeonstave|\bfaolch|\bcaress|\bembrace|\bicon of khorne"
     r"|\bdimensional|\btransdimensional|\bneuro disruptor|\bwarp spite", "psychic"),
    # Beam and coil weapons, drawn as one clean line of light.
    (r"\blas\b|\blas[a-z]|\blong las|\bhot shot|\bvolley gun|\blance\b|\bblaster\b"
     r"|\bblast pistol|\barc (pistol|rifle)|\bheavy arc|\bvoltaic|\bstaff of light"
     r"|\brail\b|\brail rifle|\bmagna coil|\btransuranic|\bwraithcannon|\bseismic"
     r"|\bgalvanic|\bgauss|\btesla|\batomiser|\bsolar carbine|\bsynaptic"
     r"|\bneutron (blaster|sting)|\blightning|\bspark\b", "las"),
]
#: Anything with no tell in its name is a solid round: autoguns, shotguns,
#: shuriken, splinter, needles, thrown blades.
RANGED_FALLBACK = "solid"

#: Weapon RULES that make an attack an area effect, whatever it is fired from.
#: A Torrent weapon replaces its projectile with a CONE; a Blast weapon keeps
#: its projectile and detonates at the end of it.
AOE_RULES = {
    "torrent": "cone",
    "twintorrent": "cone",
    "skytorch": "cone",
    "blast": "blast",
    "explosive": "blast",
    "detonate": "blast",
    "neutronbombardment": "blast",
    "splash": "blast",
}

#: Which cone. Torrent is how this game writes "sweeping fire" as well as
#: "burning fuel", and a sweeping heavy bolter drawn as a jet of flame is the
#: one mistake that would be visible from across the room — so a cone off a
#: weapon that is not a flame weapon is a fan of rounds instead.
CONE_FAMILIES = {"flame": "flame", "default": "spray"}

#: Ploy hook effect type -> family. The vocabulary is closed: every effect type
#: any bundled pack declares appears here, and rules/hooks.js is where it is
#: defined. An unlisted type animates as nothing rather than as the wrong thing.
PLOY_EFFECTS = {
    "grantWeaponRule": "warcry",
    "modifyWeapon": "warcry",
    "addApl": "warcry",
    "modifyDefenceDice": "ward",
    "rerollDefenceDice": "ward",
    "reduceDamage": "ward",
    "modifySave": "ward",
    "ignoreInjured": "ward",
    "ignoreWeaponRules": "ward",
    "freeAction": "comms",
    "extraAction": "comms",
    "discountAction": "comms",
    "modifyMove": "comms",
    "changeOrder": "comms",
    "allowChargeWhileConceal": "comms",
    "inflictDamage": "hex",
    "inflictToken": "hex",
    "denyTargeting": "hex",
    "clearTokens": "hex",
    "healWounds": "mend",
}

#: Token kind -> the loop that hangs on an operative carrying it.
TOKEN_EFFECTS = {
    "blaze": "blaze",
    "poison": "toxin",
    "toxic": "toxin",
    "terrorchem": "toxin",
    "mindburn": "toxin",
    "humbling-cruelty": "toxin",
    "neutron-fragment": "toxin",
}


def classify_ranged(name):
    text = normalise(name)
    for pattern, family in RANGED_PATTERNS:
        if re.search(pattern, text):
            return family
    return RANGED_FALLBACK


def rule_name(rule):
    """`blast2` -> `blast`. Weapon rules carry their value in the token."""
    return re.sub(r"[0-9]+$", "", str(rule).lower())


def classify_aoe(rules):
    for rule in rules or []:
        family = AOE_RULES.get(rule_name(rule))
        if family:
            return family
    return None


def effects_for_weapon(weapon):
    """What one weapon puts on the board: {projectile, aoe, melee}.

    This is the whole contract between the generator and the renderer, and
    src/ui/effect-map.js implements it again from the manifest's own tables —
    so if you change the shape here, change it there.
    """
    if weapon.get("type") == "melee":
        return {"projectile": None, "aoe": None, "melee": "strike"}

    base = classify_ranged(weapon.get("name"))
    aoe = classify_aoe(weapon.get("rules"))
    if aoe == "cone":
        return {"projectile": None,
                "aoe": CONE_FAMILIES.get(base, CONE_FAMILIES["default"]),
                "melee": None}
    # A flamer with no Torrent rule printed is still a flamer.
    if base == "flame":
        return {"projectile": None, "aoe": "flame", "melee": None}
    return {"projectile": base, "aoe": "blast" if aoe == "blast" else None,
            "melee": None}


# --------------------------------------------------------------------------
# What the bundled data can actually produce
# --------------------------------------------------------------------------

def scan_usage():
    """Which families the bundled packs can fire, and what asked for each.

    A family with no user is not drawn. The examples ride along into the
    manifest so the file says why each sprite exists.
    """
    usage = defaultdict(lambda: {"count": 0, "examples": []})

    def note(family, example):
        if not family:
            return
        entry = usage[family]
        entry["count"] += 1
        if example and example not in entry["examples"] and len(entry["examples"]) < 4:
            entry["examples"].append(example)

    for path in sorted(TEAMS.glob("*.json")):
        pack = json.loads(path.read_text())
        for operative in pack.get("operatives", []):
            for weapon in operative.get("weapons", []):
                spec = effects_for_weapon(weapon)
                if spec["melee"]:
                    note("strike", weapon.get("name"))
                    note("parry", weapon.get("name"))
                    continue
                note(spec["projectile"], weapon.get("name"))
                note(spec["aoe"], weapon.get("name"))

        for key in ("strategicPloys", "firefightPloys"):
            for ploy in pack.get(key, []):
                seen = set()
                for hook in ploy.get("hooks") or []:
                    family = PLOY_EFFECTS.get((hook.get("effect") or {}).get("type"))
                    if family and family not in seen:
                        seen.add(family)
                        note(family, ploy.get("name"))
                    # A defensive ploy bought for an activation hangs a shield
                    # on the operative for as long as it is in force.
                    if family == "ward" and key == "firefightPloys":
                        note("shield", ploy.get("name"))
                # A strategic ploy is in force over a whole team for a whole
                # turning point, which is the definition of an area buff.
                if key == "strategicPloys" and ploy.get("hooks"):
                    note("aura", ploy.get("name"))

        for name, definition in (pack.get("weaponRules") or {}).items():
            blob = json.dumps(definition)
            for kind, family in TOKEN_EFFECTS.items():
                if f'"{kind}"' in blob:
                    note(family, f"{pack['id']}: {name}")

    return dict(usage)


# --------------------------------------------------------------------------
# Drawing
# --------------------------------------------------------------------------
#
# Every sprite is built the same way: a stack of LAYERS, each one drawn on its
# own transparent canvas at SS times the final size, optionally blurred, and
# then either ADDED to the frame (light — fire, plasma, muzzle flash) or laid
# OVER it (matter — smoke, a bolt shell). Additive light is what makes a glow
# read as a glow over a dark board; smoke has to occlude instead, or it looks
# like coloured fog.
#
# Coordinates are normalised: 0..1 across the cell, centre (0.5, 0.5), and +X
# is the direction the effect points. The renderer rotates the whole sprite, so
# every projectile is drawn firing to the right and every cone opens to the
# right.


def lerp(a, b, t):
    return a + (b - a) * t


def bezier(a, c, b, q):
    """A point on the quadratic Bezier a -> b with control point c."""
    k = 1 - q
    return (k * k * a[0] + 2 * k * q * c[0] + q * q * b[0],
            k * k * a[1] + 2 * k * q * c[1] + q * q * b[1])


def mix(c0, c1, t):
    """Blend two RGB colours."""
    t = max(0.0, min(1.0, t))
    return tuple(int(round(lerp(c0[i], c1[i], t))) for i in range(3))


def clamp01(v):
    return max(0.0, min(1.0, v))


def premultiply(img):
    """Scale a layer's colour by its own alpha.

    Additive compositing adds raw channel values, so an unpremultiplied layer
    contributes its FULL colour wherever alpha is non-zero — stack three
    orange discs at a third opacity each and you get white, not a fireball.
    Premultiplying first is also what keeps a blur from fringing, so it runs
    before the blur rather than after.
    """
    r, g, b, a = img.split()
    return Image.merge("RGBA", (ImageChops.multiply(r, a), ImageChops.multiply(g, a),
                                ImageChops.multiply(b, a), a))


def fade(img, k, mode):
    """Scale a layer's strength: all channels for light, alpha only for matter."""
    k = clamp01(k)
    if mode == "add":
        return img.point(lambda v: int(v * k))
    r, g, b, a = img.split()
    return Image.merge("RGBA", (r, g, b, a.point(lambda v: int(v * k))))


class Pen:
    """ImageDraw in normalised cell coordinates."""

    def __init__(self, draw, n):
        self.d = draw
        self.n = n

    def _xy(self, x, y):
        return (x * self.n, y * self.n)

    def _w(self, w):
        return max(1, int(round(w * self.n)))

    def dot(self, x, y, r, color, a=255):
        rr = r * self.n
        cx, cy = self._xy(x, y)
        self.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                       fill=(*color, int(clamp01(a / 255) * 255)))

    def ring(self, x, y, r, w, color, a=255):
        rr = r * self.n
        cx, cy = self._xy(x, y)
        self.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                       outline=(*color, int(clamp01(a / 255) * 255)), width=self._w(w))

    def ellipse(self, x, y, rx, ry, w, color, a=255):
        cx, cy = self._xy(x, y)
        rx *= self.n
        ry *= self.n
        if rx < 1 or ry < 1:
            return
        self.d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                       outline=(*color, int(clamp01(a / 255) * 255)), width=self._w(w))

    def arc(self, x, y, r, deg0, deg1, w, color, a=255):
        rr = r * self.n
        cx, cy = self._xy(x, y)
        self.d.arc([cx - rr, cy - rr, cx + rr, cy + rr], deg0, deg1,
                   fill=(*color, int(clamp01(a / 255) * 255)), width=self._w(w))

    def line(self, x0, y0, x1, y1, w, color, a=255):
        self.d.line([self._xy(x0, y0), self._xy(x1, y1)],
                    fill=(*color, int(clamp01(a / 255) * 255)), width=self._w(w))

    def path(self, points, w, color, a=255):
        self.d.line([self._xy(x, y) for x, y in points],
                    fill=(*color, int(clamp01(a / 255) * 255)), width=self._w(w),
                    joint="curve")

    def ray(self, x, y, angle, r0, r1, w, color, a=255):
        """A line along `angle` (radians) between two radii from (x, y)."""
        self.line(x + math.cos(angle) * r0, y + math.sin(angle) * r0,
                  x + math.cos(angle) * r1, y + math.sin(angle) * r1, w, color, a)

    def dashed_ring(self, x, y, r, w, color, a=255, dashes=8, span=26, spin=0.0):
        step = 360 / dashes
        for i in range(dashes):
            start = i * step + spin
            self.arc(x, y, r, start, start + span, w, color, a)


class Frame:
    """One sprite frame: layers in, a downsampled RGBA cell out."""

    def __init__(self, px):
        self.px = px
        self.n = px * SS
        self.img = Image.new("RGBA", (self.n, self.n), (0, 0, 0, 0))

    def layer(self, paint, blur=0.0, mode="add", opacity=1.0):
        if opacity <= 0.002:
            return self
        buf = Image.new("RGBA", (self.n, self.n), (0, 0, 0, 0))
        paint(Pen(ImageDraw.Draw(buf), self.n))
        if mode == "add":
            buf = premultiply(buf)
        if blur > 0:
            buf = buf.filter(ImageFilter.GaussianBlur(blur * self.n))
        if opacity < 1.0:
            buf = fade(buf, opacity, mode)
        self.img = (ImageChops.add(self.img, buf) if mode == "add"
                    else Image.alpha_composite(self.img, buf))
        return self

    def out(self):
        return self.img.resize((self.px, self.px), Image.LANCZOS)


# --------------------------------------------------------------------------
# The families
# --------------------------------------------------------------------------
#
# `cell` is the sprite's pixel size; `inches` is how wide it is drawn on the
# board, which is in inches like everything else in this project. A cone sizes
# itself to the shot instead, so it declares no width.

SMOKE = (86, 84, 92)
STEEL = (214, 228, 248)

FAMILIES = {
    # Shots ------------------------------------------------------------
    "las": dict(kind="projectile", cell=72, inches=1.8, style="beam", impact="burn",
                hue=(255, 92, 68), core=(255, 232, 214),
                about="A single clean line of coherent light."),
    "plasma": dict(kind="projectile", cell=72, inches=1.9, style="orb", impact="splash",
                   hue=(96, 196, 255), core=(232, 250, 255),
                   about="A bottled star with a comet tail."),
    "bolt": dict(kind="projectile", cell=72, inches=1.8, style="shell", impact="detonate",
                 hue=(255, 176, 78), core=(255, 240, 210),
                 about="A rocket-propelled shell that goes off inside the target."),
    "solid": dict(kind="projectile", cell=72, inches=1.6, style="tracer", impact="spark",
                  hue=(255, 214, 138), core=(255, 248, 228),
                  about="A tracer round: autoguns, stubbers, shuriken, splinters."),
    "melta": dict(kind="projectile", cell=72, inches=1.7, style="lance", impact="burn",
                  hue=(255, 138, 44), core=(255, 246, 222),
                  about="A short, fat column of heat."),
    "psychic": dict(kind="projectile", cell=72, inches=1.9, style="warp", impact="splash",
                    hue=(178, 126, 255), core=(240, 226, 255),
                    about="The warp: powers, miracles and daemonic gifts."),
    "rocket": dict(kind="projectile", cell=72, inches=1.7, style="rocket", impact="detonate",
                   hue=(255, 150, 70), core=(255, 236, 200), arc=True,
                   about="Lobbed: rokkits, missiles, grenades, demolition charges."),
    # Areas ------------------------------------------------------------
    "flame": dict(kind="cone", cell=160, style="fire",
                  hue=(255, 138, 38), core=(255, 244, 186),
                  about="A jet of burning fuel, sized to the target."),
    "spray": dict(kind="cone", cell=160, style="rounds",
                  hue=(255, 206, 128), core=(255, 250, 232),
                  about="Sweeping fire: the Torrent rule on a weapon that isn't a flamer."),
    "blast": dict(kind="burst", cell=144, inches=3.6,
                  hue=(255, 146, 52), core=(255, 248, 224),
                  about="A detonation: fireball, shockwave, debris and smoke."),
    # Melee ------------------------------------------------------------
    "strike": dict(kind="melee", cell=104, inches=2.5, hue=(150, 194, 255), core=STEEL,
                   about="A blade sweeping through the target."),
    "parry": dict(kind="melee", cell=104, inches=2.3, hue=(140, 188, 255), core=STEEL,
                  about="A block: the counter-attack that cancels a strike."),
    # Ploys ------------------------------------------------------------
    "warcry": dict(kind="marker", cell=104, inches=2.7, hue=(255, 178, 66), core=(255, 238, 196),
                   about="An offensive ploy: chevrons rising off the operative."),
    "ward": dict(kind="marker", cell=104, inches=2.7, hue=(110, 210, 255), core=(226, 248, 255),
                 about="A defensive ploy: a hexagonal ward snapping shut."),
    "comms": dict(kind="marker", cell=104, inches=3.1, hue=(94, 222, 206), core=(226, 252, 246),
                  about="Orders and tempo: vox rings going out."),
    "hex": dict(kind="marker", cell=104, inches=2.7, hue=(186, 118, 255), core=(238, 220, 255),
                about="A ploy worked on the enemy: rings closing inwards."),
    "mend": dict(kind="marker", cell=104, inches=2.5, hue=(110, 224, 160), core=(228, 252, 238),
                 about="Wounds healed."),
    # Persistent -------------------------------------------------------
    "shield": dict(kind="loop", cell=96, inches=2.2, hue=(120, 206, 255), core=(226, 246, 255),
                   about="A defensive ploy still in force, turning around its holder."),
    "aura": dict(kind="loop", cell=112, inches=2.6, hue=(236, 244, 255), core=(255, 255, 255),
                 tint=True,
                 about="A strategic ploy in force over a whole team, in team colour."),
    "blaze": dict(kind="loop", cell=72, inches=1.8, hue=(255, 134, 40), core=(255, 240, 186),
                  about="An operative carrying a Blaze token is on fire."),
    "toxin": dict(kind="loop", cell=72, inches=1.8, hue=(132, 214, 96), core=(220, 250, 198),
                  about="Poison, Terrorchem, Mindburn: something is eating this one."),
}

#: Frames per part, and how long the whole part runs at normal speed.
TIMING = {
    "muzzle": (5, 130),
    "tracer": (4, 240),
    "impact": (9, 340),
    "cone": (14, 620),
    "burst": (16, 780),
    "swing": (8, 300),
    "mark": (14, 720),
    "loop": (16, 1500),
}
#: How long a projectile takes to cross the gap, per inch, before clamping.
TRAVEL_MS_PER_INCH = 13
TRAVEL_MS_RANGE = (110, 520)


def rand_for(name):
    """A stable stream per family, so regenerating never reshuffles a sprite."""
    import random
    return random.Random(f"killteam-effects:{name}")


# --------------------------------------------------------------------------
# Shots: muzzle flash, the thing in flight, and what it does on arrival
# --------------------------------------------------------------------------

def muzzle_frames(spec, rnd):
    px, hue, core = spec["cell"], spec["hue"], spec["core"]
    style = spec["style"]
    count, _ = TIMING["muzzle"]
    # A muzzle flash is brightest on the first frame and decays; it never
    # "grows in", which is the usual tell of a badly drawn one.
    spread = {"beam": 0.5, "lance": 0.6, "orb": 0.8, "warp": 1.0,
              "shell": 0.75, "rocket": 0.9, "tracer": 0.65}[style]
    petals = [(-1.0, 0.62), (-0.5, 0.85), (0.0, 1.0), (0.5, 0.85), (1.0, 0.62)]
    out = []
    for i in range(count):
        t = i / (count - 1)
        amp = (1 - t) ** 0.8
        f = Frame(px)
        f.layer(lambda p, a=amp: p.dot(0.5, 0.5, 0.21 * a, hue, 160), blur=0.05)
        f.layer(lambda p, a=amp: [
            p.ray(0.5, 0.5, ang * spread, 0.01, (0.10 + 0.15 * m) * a,
                  0.035 * a * m, mix(core, hue, 0.4), 235 * m)
            for ang, m in petals], blur=0.012)
        f.layer(lambda p, a=amp: p.dot(0.5, 0.5, 0.058 * a, core, 255), blur=0.006)
        if style in ("shell", "rocket"):
            # Propellant gas rolls backwards off the barrel.
            f.layer(lambda p, a=amp: [
                p.dot(0.5 - 0.05 - 0.06 * k, 0.5 + (k - 1) * 0.03,
                      (0.05 + 0.02 * k) * a, SMOKE, 70 * a)
                for k in range(3)], blur=0.03, mode="over")
        out.append(f.out())
    return out


def tracer_frames(spec, rnd):
    px, hue, core = spec["cell"], spec["hue"], spec["core"]
    style = spec["style"]
    count, _ = TIMING["tracer"]
    # Frame-to-frame jitter is precomputed so the flicker is stable art rather
    # than noise that changes every time the file is regenerated.
    jitter = [[(rnd.uniform(-1, 1)) for _ in range(6)] for _ in range(count)]
    out = []
    for i in range(count):
        t = i / count
        j = jitter[i]
        f = Frame(px)

        if style in ("beam", "lance"):
            wide = 0.16 if style == "lance" else 0.105
            mid = 0.075 if style == "lance" else 0.048
            hot = 0.030 if style == "lance" else 0.017
            flick = 0.88 + 0.12 * math.sin(t * math.tau + j[0])
            f.layer(lambda p, w=wide: p.line(0.05, 0.5, 0.95, 0.5, w, hue, 120),
                    blur=0.045, opacity=flick)
            f.layer(lambda p, w=mid: p.line(0.05, 0.5, 0.96, 0.5, w, hue, 225), blur=0.014)
            f.layer(lambda p, w=hot: p.line(0.06, 0.5, 0.96, 0.5, w, core, 255), blur=0.004)
            f.layer(lambda p: p.dot(0.94, 0.5, 0.052, core, 255), blur=0.012)
            if style == "lance":
                # Heat haze standing off the column, not beads along it.
                f.layer(lambda p, jj=j: [
                    p.line(0.12 + 0.30 * k, 0.5 - 0.10 - 0.02 * jj[k],
                           0.34 + 0.30 * k, 0.5 - 0.10 - 0.02 * jj[k],
                           0.012, hue, 90) for k in range(2)], blur=0.03)
                f.layer(lambda p, jj=j: [
                    p.line(0.12 + 0.30 * k, 0.5 + 0.10 + 0.02 * jj[k + 2],
                           0.34 + 0.30 * k, 0.5 + 0.10 + 0.02 * jj[k + 2],
                           0.012, hue, 90) for k in range(2)], blur=0.03)

        elif style == "orb":
            f.layer(lambda p: [
                p.dot(0.78 - 0.085 * k, 0.5 + 0.006 * j[k % 6] * k,
                      0.075 - 0.009 * k, hue, 190 - 24 * k)
                for k in range(7)], blur=0.03)
            f.layer(lambda p: p.dot(0.80, 0.5, 0.135, hue, 170), blur=0.05)
            f.layer(lambda p, tt=t: p.ring(0.80, 0.5, 0.105 + 0.012 * math.sin(tt * math.tau),
                                           0.012, mix(core, hue, 0.5), 200), blur=0.01)
            f.layer(lambda p: p.dot(0.80, 0.5, 0.058, core, 255), blur=0.008)

        elif style == "warp":
            # A crooked discharge: the same spine every frame, re-kinked.
            spine = [(0.10 + 0.16 * k, 0.5 + 0.055 * j[k] * math.sin(k * 1.7 + t * 6))
                     for k in range(6)]
            f.layer(lambda p, s=spine: p.path(s, 0.075, hue, 130), blur=0.04)
            f.layer(lambda p, s=spine: p.path(s, 0.030, mix(core, hue, 0.45), 220), blur=0.012)
            f.layer(lambda p, s=spine: p.path(s, 0.012, core, 255), blur=0.004)
            f.layer(lambda p, s=spine: [
                p.dot(x, y + 0.05 * j[k], 0.018, core, 200)
                for k, (x, y) in enumerate(s[1:5])], blur=0.02)

        elif style in ("shell", "rocket"):
            plume = 6 if style == "rocket" else 4
            f.layer(lambda p, n=plume: [
                p.dot(0.66 - 0.085 * k, 0.5 + 0.012 * j[k % 6] * k,
                      0.035 + 0.016 * k, SMOKE, 95 - 11 * k)
                for k in range(n)], blur=0.028, mode="over")
            f.layer(lambda p: p.dot(0.70, 0.5, 0.085, hue, 175), blur=0.035)
            f.layer(lambda p, tt=t: p.line(0.60 + 0.02 * math.sin(tt * math.tau), 0.5,
                                           0.76, 0.5, 0.055, mix(core, hue, 0.5), 240),
                    blur=0.012)
            # The round itself: matter, so it occludes rather than glows.
            f.layer(lambda p: p.line(0.76, 0.5, 0.88, 0.5, 0.062, (46, 50, 60), 255),
                    blur=0.002, mode="over")
            if style == "rocket":
                f.layer(lambda p: [p.line(0.77, 0.5, 0.73, 0.5 + s * 0.055, 0.020,
                                          (60, 64, 76), 255) for s in (-1, 1)],
                        blur=0.002, mode="over")
            f.layer(lambda p: p.dot(0.885, 0.5, 0.022, core, 220), blur=0.006)

        else:  # tracer
            # Tapered: three overlapping runs, each shorter, fatter and
            # brighter than the last, which is how a tracer round reads.
            f.layer(lambda p: p.line(0.28, 0.5, 0.90, 0.5, 0.008, hue, 85), blur=0.020)
            f.layer(lambda p: p.line(0.60, 0.5, 0.90, 0.5, 0.017, hue, 180), blur=0.010)
            f.layer(lambda p, tt=t: p.line(0.76, 0.5, 0.905, 0.5,
                                           0.026 + 0.003 * math.sin(tt * math.tau),
                                           core, 250), blur=0.006)
            f.layer(lambda p: p.dot(0.905, 0.5, 0.026, core, 255), blur=0.012)

        out.append(f.out())
    return out


def impact_frames(spec, rnd):
    px, hue, core = spec["cell"], spec["hue"], spec["core"]
    style = spec["impact"]
    count, _ = TIMING["impact"]
    sparks = [(rnd.uniform(0, math.tau), rnd.uniform(0.55, 1.4), rnd.uniform(0.5, 1.6))
              for _ in range(9)]
    puffs = [(rnd.uniform(0, math.tau), rnd.uniform(0.7, 1.3)) for _ in range(6)]
    out = []
    for i in range(count):
        t = i / (count - 1)
        f = Frame(px)
        # Shockwave ring, on every impact: it is what makes a hit read as a hit.
        f.layer(lambda p, tt=t: p.ring(0.5, 0.5, 0.07 + 0.33 * tt ** 0.6,
                                       0.05 * (1 - tt) + 0.008,
                                       mix(core, hue, 0.6), 255 * (1 - tt) ** 1.4),
                blur=0.016)
        f.layer(lambda p, tt=t: p.dot(0.5, 0.5, 0.105 * (1 - tt) ** 1.4, core,
                                      225 * (1 - tt) ** 0.9), blur=0.038)

        if style == "burn":
            f.layer(lambda p, tt=t: p.dot(0.5, 0.5, 0.09 + 0.10 * tt, hue,
                                          200 * (1 - tt) ** 1.3), blur=0.06)
            f.layer(lambda p, tt=t: [
                p.ray(0.5, 0.5, ang, 0.04, 0.09 + 0.26 * tt ** 0.7 * m, 0.013,
                      mix(core, hue, 0.5), 220 * (1 - tt) ** 1.4)
                for ang, m, w in sparks[:6]], blur=0.01)
        elif style == "splash":
            f.layer(lambda p, tt=t: [
                p.dot(0.5 + math.cos(ang) * (0.07 + 0.27 * tt * m),
                      0.5 + math.sin(ang) * (0.07 + 0.27 * tt * m),
                      0.055 * (1 - tt) * m + 0.008, hue, 215 * (1 - tt) ** 1.2)
                for ang, m, w in sparks[:7]], blur=0.025)
        elif style == "detonate":
            f.layer(lambda p, tt=t: p.dot(0.5, 0.5, 0.10 + 0.20 * tt ** 0.5,
                                          mix(hue, (196, 58, 34), tt),
                                          235 * max(0.0, 1 - 1.35 * tt)), blur=0.045)
            f.layer(lambda p, tt=t: [
                p.ray(0.5, 0.5, ang, 0.08 + 0.10 * tt, 0.13 + 0.36 * tt ** 0.8 * m,
                      0.009 * w, mix(core, hue, 0.7), 230 * (1 - tt) ** 1.2)
                for ang, m, w in sparks], blur=0.008)
            f.layer(lambda p, tt=t: [
                p.dot(0.5 + math.cos(ang) * (0.08 + 0.24 * tt) * m,
                      0.5 + math.sin(ang) * (0.08 + 0.24 * tt) * m - 0.05 * tt,
                      (0.05 + 0.09 * tt) * m, SMOKE, 150 * math.sin(math.pi * min(1, tt * 1.1)))
                for ang, m in puffs], blur=0.035, mode="over")
        else:  # spark — a solid round throws chips, not light
            f.layer(lambda p, tt=t: [
                p.ray(0.5, 0.5, ang, 0.03 + 0.06 * tt, 0.07 + 0.34 * tt ** 0.65 * m,
                      0.009 * w, mix(core, hue, 0.35), 245 * (1 - tt) ** 1.6)
                for ang, m, w in sparks], blur=0.006)
        out.append(f.out())
    return out


# --------------------------------------------------------------------------
# Areas: the cone and the detonation
# --------------------------------------------------------------------------

def cone_frames(spec, rnd):
    """A cone with its apex at the left edge, opening to the right.

    The renderer scales the cell so its width is the distance to the target,
    which is what makes one sprite fit an 8" flamer and a 2" point-blank burst.
    """
    px, hue, core = spec["cell"], spec["hue"], spec["core"]
    fire = spec["style"] == "fire"
    count, _ = TIMING["cone"]
    n = 60 if fire else 26
    grains = [(rnd.random(), rnd.uniform(-1, 1), rnd.uniform(0.6, 1.3)) for _ in range(n)]
    out = []
    for i in range(count):
        t = i / (count - 1)
        # The jet reaches out fast, holds, then gutters.
        reach = min(1.0, t * 2.8)
        gutter = 1.0 if t < 0.60 else max(0.0, (1 - t) / 0.40)
        f = Frame(px)

        def place(s, lat, size, speed=1.15):
            u = (s + t * speed) % 1.0
            x = 0.02 + u * 0.90
            half = 0.40 * u ** 0.85
            return u, x, 0.5 + lat * half

        # A cone is dense down its axis and ragged at its edges, and it has to
        # thin out to nothing before the cell ends — the renderer puts the far
        # edge ON the target, so anything still burning there is clipped square.
        def edge(lat, u):
            return (1.0 - 0.62 * lat * lat) * min(1.0, (1.0 - u) / 0.22)

        if fire:
            # Smoke first, so the fire sits in front of its own exhaust.
            f.layer(lambda p: [
                (lambda u, x, y: p.dot(x, y, (0.035 + 0.075 * u) * size, SMOKE,
                                       34 * max(0.0, u - 0.55) / 0.45 * gutter * edge(lat, u))
                 if 0.55 < u <= reach else None)(*place(s, lat, size, 1.0))
                for s, lat, size in grains], blur=0.05, mode="over")
            f.layer(lambda p: [
                (lambda u, x, y: p.dot(x, y, (0.026 + 0.070 * u) * size,
                                       mix(mix(core, hue, min(1, u * 2.2)),
                                           (206, 66, 30), max(0.0, u - 0.6) / 0.4),
                                       (95 + 175 * (1 - u * 0.65)) * gutter * edge(lat, u))
                 if u <= reach else None)(*place(s, lat, size))
                for s, lat, size in grains], blur=0.020)
            # The root of the jet, where the fuel is still white.
            f.layer(lambda p: p.line(0.03, 0.5, 0.30, 0.5, 0.075, mix(core, hue, 0.35), 225),
                    blur=0.045, opacity=gutter * min(1.0, reach * 3))
            f.layer(lambda p: p.dot(0.05, 0.5, 0.070 * gutter, core, 250), blur=0.028)
        else:
            # Sweeping fire: a fan of rounds, not a jet of fuel.
            f.layer(lambda p: [
                (lambda u, x, y: p.line(x - 0.12 * size, y, x, y, 0.020 * size, hue,
                                        210 * gutter * edge(lat, u))
                 if u <= reach else None)(*place(s, lat, size, 1.45))
                for s, lat, size in grains], blur=0.016)
            f.layer(lambda p: [
                (lambda u, x, y: p.line(x - 0.075 * size, y, x, y, 0.009 * size, core,
                                        250 * gutter * edge(lat, u))
                 if u <= reach else None)(*place(s, lat, size, 1.45))
                for s, lat, size in grains], blur=0.004)
            f.layer(lambda p: p.dot(0.05, 0.5, 0.055 * gutter, core, 235), blur=0.035)
        out.append(f.out())
    return out


def burst_frames(spec, rnd):
    px, hue, core = spec["cell"], spec["hue"], spec["core"]
    count, _ = TIMING["burst"]
    debris = [(rnd.uniform(0, math.tau), rnd.uniform(0.55, 1.35), rnd.uniform(0.6, 1.4))
              for _ in range(11)]
    smoke = [(rnd.uniform(0, math.tau), rnd.uniform(0.65, 1.35), rnd.uniform(0.7, 1.3))
             for _ in range(9)]
    # A fireball is lobed, not round. These are the lobes.
    lobes = [(rnd.uniform(0, math.tau), rnd.uniform(0.25, 0.75), rnd.uniform(0.45, 0.85))
             for _ in range(7)]
    out = []
    for i in range(count):
        t = i / (count - 1)
        f = Frame(px)
        grow = 1 - (1 - t) ** 2
        heat = clamp01(1.15 - 1.5 * t)
        colour = mix(hue, (170, 46, 28), t)
        r = 0.09 + 0.29 * grow

        # Shockwave: the fastest thing in the frame and the first to leave.
        f.layer(lambda p, tt=t: p.ring(0.5, 0.5, 0.12 + 0.35 * tt ** 0.65,
                                       0.030 * (1 - tt) + 0.005, (255, 248, 236),
                                       200 * (1 - tt) ** 1.7), blur=0.012)
        # The fireball, as three softening shells plus lobes — one hard-edged
        # disc reads as a gear wheel, which is exactly what this must not be.
        for scale, alpha, soft in ((1.00, 0.50, 0.10), (0.72, 0.70, 0.055), (0.44, 0.92, 0.03)):
            f.layer(lambda p, rr=r * scale, a=alpha: p.dot(0.5, 0.5, rr, colour, 255 * a),
                    blur=soft, opacity=heat)
        f.layer(lambda p, rr=r: [
            p.dot(0.5 + math.cos(ang) * rr * off, 0.5 + math.sin(ang) * rr * off,
                  rr * size, colour, 175)
            for ang, off, size in lobes], blur=0.05, opacity=heat)
        # The initial flash, and only the initial flash, is white.
        f.layer(lambda p, tt=t: p.dot(0.5, 0.5, 0.04 + 0.11 * min(1, tt * 5), core,
                                      230 * clamp01(1 - tt * 4.2)), blur=0.04)
        f.layer(lambda p, tt=t: [
            p.ray(0.5, 0.5, ang, 0.10 + 0.20 * tt, 0.14 + 0.40 * tt ** 0.8 * m,
                  0.008 * w, mix(core, hue, 0.7), 255 * (1 - tt) ** 1.4)
            for ang, m, w in debris], blur=0.009)
        # Smoke outlives the fire and drifts up, which is what sells the scale.
        f.layer(lambda p, tt=t: [
            p.dot(0.5 + math.cos(ang) * (0.09 + 0.30 * tt) * m,
                  0.5 + math.sin(ang) * (0.09 + 0.30 * tt) * m - 0.07 * tt,
                  (0.05 + 0.12 * tt) * size, SMOKE,
                  100 * math.sin(math.pi * min(1.0, 0.02 + tt * 0.88)))
            for ang, m, size in smoke], blur=0.045, mode="over")
        out.append(f.out())
    return out


# --------------------------------------------------------------------------
# Melee: the swing and the block
# --------------------------------------------------------------------------

def melee_frames(spec, rnd, block=False):
    """+X points from the attacker to the target for a strike, and from the
    defender to whoever it is blocking for a parry — so both sprites are drawn
    hitting, or catching, something off to the right."""
    px, hue, core = spec["cell"], spec["hue"], spec["core"]
    count, _ = TIMING["swing"]
    ticks = [(rnd.uniform(-0.9, 0.9), rnd.uniform(0.7, 1.3)) for _ in range(7)]
    out = []
    for i in range(count):
        t = i / (count - 1)
        f = Frame(px)

        if not block:
            # A cut drawn as a ribbon along a curved spine, revealed from one
            # end to the other. An arc swept by its tip reads as a comet, not
            # as a blade, which is why the whole cut is on screen at once and
            # it is the TAIL that catches up rather than the head that leads.
            spine = [bezier((0.06, 0.14), (0.88, 0.24), (0.90, 0.92), q / 30)
                     for q in range(31)]
            reveal = min(1.0, t ** 0.7 * 1.45)
            leave = clamp01((t - 0.55) / 0.45)
            body = []
            for k, (x, y) in enumerate(spine):
                q = k / 30
                if q > reveal:
                    break
                age = (reveal - q) / 0.62
                if age > 1:
                    continue
                thick = 0.085 * math.sin(math.pi * q) ** 0.55 * (1 - age) ** 0.8
                body.append((x, y, thick, (1 - age) ** 1.2 * (1 - leave), age))
            f.layer(lambda p, b=body: [
                p.dot(x, y, w, mix(core, hue, 0.35 + 0.5 * age), 190 * a)
                for x, y, w, a, age in b], blur=0.03)
            f.layer(lambda p, b=body: [
                p.dot(x, y, w * 0.34, core, 250 * a) for x, y, w, a, age in b],
                blur=0.008)
            if body:
                tip = body[-1]
                f.layer(lambda p, pt=tip: p.dot(pt[0], pt[1], 0.045, core, 255),
                        blur=0.02, opacity=1 - leave)
                f.layer(lambda p, pt=tip, tt=t: [
                    p.ray(pt[0], pt[1], math.radians(lerp(-150, 150, (o + 1) / 2)),
                          0.02, 0.05 + 0.14 * m * tt, 0.010, mix(core, hue, 0.3),
                          230 * (1 - tt) ** 1.3)
                    for o, m in ticks], blur=0.006)

        else:
            # A block: the incoming attack stopped dead and thrown back.
            appear = min(1.0, t * 5)
            decay = (1 - t) ** 1.2
            f.layer(lambda p, tt=t: p.arc(0.02, 0.5, 0.62, -42 + 6 * tt, 42 - 6 * tt,
                                          0.055, hue, 200 * decay), blur=0.022,
                    opacity=appear)
            f.layer(lambda p, tt=t: p.arc(0.02, 0.5, 0.62, -34 + 6 * tt, 34 - 6 * tt,
                                          0.018, core, 250 * decay), blur=0.006,
                    opacity=appear)
            f.layer(lambda p, tt=t: p.dot(0.64, 0.5, 0.085 * (1 - tt) + 0.02, core,
                                          250 * decay), blur=0.03)
            f.layer(lambda p, tt=t: [
                # Sparks fly back past the defender, not on towards it.
                p.ray(0.64, 0.5, math.radians(140 + 80 * o), 0.02,
                      0.06 + 0.30 * m * tt ** 0.7, 0.011, mix(core, hue, 0.3),
                      250 * (1 - tt) ** 1.4)
                for o, m in ticks], blur=0.006)
        out.append(f.out())
    return out


# --------------------------------------------------------------------------
# Ploys: one mark per kind of thing a ploy does
# --------------------------------------------------------------------------

def marker_frames(name, spec, rnd):
    px, hue, core = spec["cell"], spec["hue"], spec["core"]
    count, _ = TIMING["mark"]
    motes = [(rnd.uniform(-0.22, 0.22), rnd.uniform(0.7, 1.3)) for _ in range(7)]
    out = []
    for i in range(count):
        t = i / (count - 1)
        f = Frame(px)

        if name == "warcry":
            f.layer(lambda p, tt=t: p.ring(0.5, 0.62, 0.13 + 0.28 * tt,
                                           0.032 * (1 - tt) + 0.005, hue,
                                           200 * (1 - tt) ** 1.2), blur=0.014)
            for k in range(3):
                u = clamp01((t - k * 0.13) / 0.62)
                if u <= 0:
                    continue
                y = 0.74 - 0.50 * u
                a = 235 * math.sin(math.pi * u) ** 0.7
                f.layer(lambda p, y=y, a=a: p.path(
                    [(0.34, y + 0.10), (0.5, y - 0.04), (0.66, y + 0.10)],
                    0.038, mix(core, hue, 0.5), a), blur=0.012)
                f.layer(lambda p, y=y, a=a: p.path(
                    [(0.34, y + 0.10), (0.5, y - 0.04), (0.66, y + 0.10)],
                    0.08, hue, a * 0.45), blur=0.035)

        elif name == "ward":
            # A hexagon snapping shut around its holder, then letting go.
            scale = 1.0 + 0.34 * math.exp(-7 * t)
            alpha = min(1.0, t * 6) * clamp01((1 - t) / 0.45)
            hexa = [(0.5 + math.cos(math.tau * k / 6) * 0.40 * scale,
                     0.5 + math.sin(math.tau * k / 6) * 0.40 * scale) for k in range(7)]
            f.layer(lambda p, h=hexa: p.path(h, 0.10, hue, 120), blur=0.045, opacity=alpha)
            f.layer(lambda p, h=hexa: p.path(h, 0.028, mix(core, hue, 0.4), 240),
                    blur=0.008, opacity=alpha)
            f.layer(lambda p, h=hexa: [p.dot(x, y, 0.024, core, 250) for x, y in h[:6]],
                    blur=0.010, opacity=alpha)
            f.layer(lambda p, s=scale: p.path(
                [(0.5 + math.cos(math.tau * k / 6 + 0.52) * 0.24 * s,
                  0.5 + math.sin(math.tau * k / 6 + 0.52) * 0.24 * s) for k in range(7)],
                0.014, hue, 150), blur=0.012, opacity=alpha * 0.8)

        elif name == "comms":
            for k in range(3):
                u = clamp01((t - k * 0.17) / 0.72)
                if u <= 0:
                    continue
                a = 235 * min(1.0, u * 6) * (1 - u) ** 1.3
                f.layer(lambda p, u=u, a=a, k=k: p.dashed_ring(
                    0.5, 0.5, 0.11 + 0.35 * u, 0.026 * (1 - u) + 0.005,
                    mix(core, hue, 0.35), a, dashes=9, span=24, spin=k * 13 + u * 40),
                    blur=0.010)
            f.layer(lambda p, tt=t: p.dot(0.5, 0.5, 0.045 + 0.012 * math.sin(tt * 12),
                                          core, 250 * (1 - tt * 0.5)), blur=0.018)

        elif name == "hex":
            for k in range(3):
                u = clamp01((t - k * 0.15) / 0.70)
                if u <= 0:
                    continue
                a = 230 * min(1.0, u * 5) * (1 - u) ** 0.7
                f.layer(lambda p, u=u, a=a: p.ring(0.5, 0.5, 0.47 - 0.35 * u,
                                                   0.022 + 0.02 * u, hue, a), blur=0.014)
            arms = [[(0.5 + math.cos(math.tau * k / 4 + 2.4 * q - 2.2 * t) * (0.46 - 0.33 * q),
                      0.5 + math.sin(math.tau * k / 4 + 2.4 * q - 2.2 * t) * (0.46 - 0.33 * q))
                     for q in [j / 7 for j in range(8)]] for k in range(4)]
            f.layer(lambda p, ar=arms: [p.path(a, 0.020, mix(core, hue, 0.6), 190)
                                        for a in ar], blur=0.012)
            if t > 0.55:
                # It closes on something: a dark pulse, laid over rather than added.
                u = (t - 0.55) / 0.45
                f.layer(lambda p, u=u: p.dot(0.5, 0.5, 0.12 + 0.16 * u, (24, 10, 38),
                                             170 * math.sin(math.pi * u)), blur=0.05,
                        mode="over")

        else:  # mend
            arm = 0.17 * min(1.0, t * 4)
            alpha = min(1.0, t * 5) * clamp01((1 - t) / 0.42)
            f.layer(lambda p, r=arm: [p.line(0.5 - r, 0.5, 0.5 + r, 0.5, 0.10, hue, 110),
                                      p.line(0.5, 0.5 - r, 0.5, 0.5 + r, 0.10, hue, 110)],
                    blur=0.04, opacity=alpha)
            f.layer(lambda p, r=arm: [p.line(0.5 - r, 0.5, 0.5 + r, 0.5, 0.048, core, 250),
                                      p.line(0.5, 0.5 - r, 0.5, 0.5 + r, 0.048, core, 250)],
                    blur=0.008, opacity=alpha)
            f.layer(lambda p, tt=t: [
                (lambda u: p.dot(0.5 + off, 0.62 - 0.34 * u, 0.020 * (1 - u) + 0.006,
                                 mix(core, hue, 0.5), 230 * math.sin(math.pi * u))
                 if u > 0 else None)(clamp01((tt - abs(off) * 1.6) / 0.70))
                for off, m in motes], blur=0.014)
        out.append(f.out())
    return out


# --------------------------------------------------------------------------
# Persistent: loops that have to close on themselves
# --------------------------------------------------------------------------
#
# These run for as long as the state that spawned them lasts, so frame N-1 has
# to hand over to frame 0 without a seam. Everything below is therefore built
# out of phases that wrap: an angle that advances by exactly one period of the
# pattern's own symmetry, or a value that is a function of (f / N) alone.

def loop_frames(name, spec, rnd):
    px, hue, core = spec["cell"], spec["hue"], spec["core"]
    count, _ = TIMING["loop"]
    tongues = [(0.30 + 0.40 * rnd.random(), rnd.uniform(0.55, 1.25), rnd.random())
               for _ in range(8)]
    bubbles = [(rnd.random(), rnd.uniform(0.10, 0.34), rnd.uniform(0.5, 1.3))
               for _ in range(9)]
    out = []
    for i in range(count):
        ph = i / count          # wraps: ph=1 is ph=0
        f = Frame(px)

        if name == "shield":
            # A wireframe sphere. Six meridians turned through exactly 30° over
            # the loop map the set back onto itself, so the rotation is seamless.
            f.layer(lambda p: p.dot(0.5, 0.5, 0.42, hue, 16), blur=0.06)
            f.layer(lambda p: p.ring(0.5, 0.5, 0.44, 0.014, hue, 120), blur=0.008)
            for k in range(6):
                lon = math.pi * k / 6 + math.pi * ph / 6
                rx = 0.44 * abs(math.cos(lon))
                f.layer(lambda p, rx=rx: p.ellipse(0.5, 0.5, rx, 0.44, 0.010, hue, 70),
                        blur=0.006)
            for lat in (0.17, 0.32):
                f.layer(lambda p, la=lat: p.ellipse(0.5, 0.5, 0.44 * math.cos(
                    math.asin(min(0.99, la / 0.44))), la, 0.008, hue, 52), blur=0.006)
            f.layer(lambda p: p.ring(0.5, 0.5, 0.44, 0.03, core, 90), blur=0.03,
                    opacity=0.55 + 0.45 * (0.5 + 0.5 * math.sin(math.tau * ph)))

        elif name == "aura":
            # Two rings half a period apart, so one is always on its way out.
            for k in range(2):
                u = (ph + k * 0.5) % 1.0
                f.layer(lambda p, u=u: p.ring(0.5, 0.5, 0.12 + 0.33 * u,
                                              0.030 * (1 - u) + 0.007, hue,
                                              165 * math.sin(math.pi * u)), blur=0.012)
            f.layer(lambda p: p.dashed_ring(0.5, 0.5, 0.46, 0.009, hue, 45,
                                            dashes=8, span=26, spin=45 * ph), blur=0.006)

        elif name == "blaze":
            f.layer(lambda p: p.dot(0.5, 0.66, 0.20, hue, 60 + 30 * math.sin(math.tau * ph)),
                    blur=0.07)
            for bx, size, off in tongues:
                u = (ph + off) % 1.0
                y = 0.70 - 0.40 * u
                colour = mix(mix(core, hue, min(1.0, u * 1.8)), (188, 42, 24),
                             max(0.0, u - 0.6) / 0.4)
                a = 235 * math.sin(math.pi * u) ** 0.65
                f.layer(lambda p, bx=bx, y=y, s=size, c=colour, a=a:
                        p.dot(bx, y, (0.062 * (1 - u) + 0.012) * s, c, a), blur=0.022)
            f.layer(lambda p: [
                (lambda u: p.dot(bx, 0.66 - 0.56 * u, 0.010 * s, core,
                                 200 * math.sin(math.pi * u)))((ph + off * 0.7) % 1.0)
                for bx, s, off in tongues[:4]], blur=0.010)

        else:  # toxin
            f.layer(lambda p: [
                p.dot(0.5 + math.cos(math.tau * (ph + k / 6)) * 0.15,
                      0.5 + math.sin(math.tau * (ph + k / 6)) * 0.15, 0.15, hue, 30)
                for k in range(6)], blur=0.08)
            f.layer(lambda p: [
                p.dot(0.5 + math.cos(math.tau * ((ph + off) % 1.0)) * orb,
                      0.5 + math.sin(math.tau * ((ph + off) % 1.0)) * orb * 0.75,
                      0.020 * size + 0.006, mix(core, hue, 0.55),
                      110 + 70 * math.sin(math.tau * (ph + off)))
                for off, orb, size in bubbles], blur=0.012)
            f.layer(lambda p: p.dashed_ring(0.5, 0.5, 0.41, 0.009, hue, 60,
                                            dashes=8, span=22, spin=45 * ph), blur=0.006)
        out.append(f.out())
    return out


# --------------------------------------------------------------------------
# Sheets and manifest
# --------------------------------------------------------------------------

def build_family(name):
    """The parts of one family, as an ordered {part: [frames]}."""
    spec = FAMILIES[name]
    rnd = rand_for(name)
    kind = spec["kind"]
    if kind == "projectile":
        return {"muzzle": muzzle_frames(spec, rnd),
                "tracer": tracer_frames(spec, rnd),
                "impact": impact_frames(spec, rnd)}
    if kind == "cone":
        return {"cone": cone_frames(spec, rnd)}
    if kind == "burst":
        return {"burst": burst_frames(spec, rnd)}
    if kind == "melee":
        return {"swing": melee_frames(spec, rnd, block=(name == "parry"))}
    if kind == "marker":
        return {"mark": marker_frames(name, spec, rnd)}
    if kind == "loop":
        return {"loop": loop_frames(name, spec, rnd)}
    raise ValueError(f"unknown kind {kind!r} for family {name!r}")


def pack_sheet(parts):
    """Lay the parts out as rows of frames. Unused cells stay transparent."""
    rows = list(parts.items())
    px = rows[0][1][0].width
    cols = max(len(frames) for _, frames in rows)
    sheet = Image.new("RGBA", (px * cols, px * len(rows)), (0, 0, 0, 0))
    layout = {}
    for r, (part, frames) in enumerate(rows):
        for c, frame in enumerate(frames):
            sheet.paste(frame, (c * px, r * px))
        layout[part] = {"row": r, "frames": len(frames), "ms": TIMING[part][1]}
    return sheet, layout


def write_family(name, usage):
    spec = FAMILIES[name]
    parts = build_family(name)
    sheet, layout = pack_sheet(parts)
    path = OUT / f"{name}.webp"
    sheet.save(path, **WEBP)

    entry = {
        "kind": spec["kind"],
        "sheet": path.name,
        "cell": spec["cell"],
        "parts": layout,
        "about": spec["about"],
        "bytes": path.stat().st_size,
    }
    if "inches" in spec:
        entry["inches"] = spec["inches"]
    if spec.get("arc"):
        entry["arc"] = True
    if spec.get("tint"):
        entry["tint"] = True
    if spec["kind"] == "projectile":
        entry["travel"] = {"msPerInch": TRAVEL_MS_PER_INCH,
                           "min": TRAVEL_MS_RANGE[0], "max": TRAVEL_MS_RANGE[1]}
    if name in usage:
        entry["used"] = usage[name]
    return entry


def write_manifest(families, usage):
    manifest = {
        "version": MANIFEST_VERSION,
        "note": ("Written by tools/make-effects.py. The match tables below are the "
                 "ones the generator used to decide which sheets exist, so "
                 "src/ui/effect-map.js classifies with the same table rather than "
                 "a second copy of it."),
        "match": {
            "ranged": [[pattern, family] for pattern, family in RANGED_PATTERNS],
            "rangedFallback": RANGED_FALLBACK,
            "aoeRules": AOE_RULES,
            "cone": CONE_FAMILIES,
            "ployEffects": PLOY_EFFECTS,
            "tokens": TOKEN_EFFECTS,
        },
        "families": families,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def contact_sheet(path, families):
    """Every frame of every generated family, over the board colour."""
    board = (23, 26, 32)
    rows = []
    for name in families:
        sheet = Image.open(OUT / f"{name}.webp").convert("RGBA")
        rows.append((name, sheet))
    label = 16
    width = max(s.width for _, s in rows) + 8
    height = sum(s.height + label + 10 for _, s in rows) + 10
    out = Image.new("RGB", (width, height), board)
    draw = ImageDraw.Draw(out)
    y = 6
    for name, sheet in rows:
        draw.text((6, y), f"{name}  {FAMILIES[name]['about']}", fill=(154, 164, 184))
        y += label
        out.paste(sheet, (4, y), sheet)
        y += sheet.height + 10
    out.save(path)
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true",
                    help="draw every family, including ones nothing in data/ can fire")
    ap.add_argument("--only", help="comma-separated family names to redraw")
    ap.add_argument("--contact-sheet", metavar="PATH",
                    help="also write one PNG with every frame of every family")
    args = ap.parse_args()

    usage = scan_usage()
    unknown = sorted(set(usage) - set(FAMILIES))
    if unknown:
        raise SystemExit(f"data asks for families that have no art: {unknown}")

    wanted = sorted(FAMILIES if args.all else usage)
    if args.only:
        picked = {n.strip() for n in args.only.split(",") if n.strip()}
        bad = picked - set(FAMILIES)
        if bad:
            raise SystemExit(f"no such family: {sorted(bad)}")
        wanted = [n for n in wanted if n in picked] or sorted(picked)

    OUT.mkdir(parents=True, exist_ok=True)
    # Keep whatever is already on disk for families this run is not redrawing,
    # so `--only` is a patch rather than a truncation of the manifest.
    previous = {}
    manifest_path = OUT / "manifest.json"
    if manifest_path.exists():
        try:
            previous = json.loads(manifest_path.read_text()).get("families", {})
        except json.JSONDecodeError:
            previous = {}

    families = {}
    for name in sorted(FAMILIES):
        if name in wanted:
            families[name] = write_family(name, usage)
            entry = families[name]
            print(f"  {name:8s} {entry['kind']:10s} {entry['cell']:>4}px "
                  f"{entry['bytes'] / 1024:6.1f}KB  "
                  f"{usage.get(name, {}).get('count', 0)} users")
        elif name in previous and (OUT / f"{name}.webp").exists():
            families[name] = previous[name]

    write_manifest(families, usage)

    # A sheet on disk for a family nothing can fire is stale: a weapon was
    # renamed, or a pattern changed. Take it with us rather than shipping it.
    if not args.only:
        for stale in OUT.glob("*.webp"):
            if stale.stem not in families:
                stale.unlink()
                print(f"  removed stale {stale.name}")

    total = sum(e["bytes"] for e in families.values())
    print(f"\n{len(families)} families, {total / 1024:.0f}KB total -> {OUT}")
    skipped = sorted(set(FAMILIES) - set(families))
    if skipped:
        print(f"not drawn (nothing in data/ can fire them): {', '.join(skipped)}")

    if args.contact_sheet:
        print(f"contact sheet -> {contact_sheet(Path(args.contact_sheet), sorted(families))}")


if __name__ == "__main__":
    main()
