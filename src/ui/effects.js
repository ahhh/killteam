/**
 * Battlefield animation layer.
 *
 * Sprite sheets drawn by tools/make-effects.py are played back over the SVG
 * board: a shot leaves a muzzle flash, crosses to its target and hits; a
 * flamer lays down a cone sized to the range; a blade sweeps; a ploy leaves a
 * mark; and a shield, an aura, a Blaze token or a lungful of Terrorchem keep
 * looping for as long as the state that caused them is still true.
 *
 * WHAT THIS IS NOT
 *
 * It is not a rule and it is not state (#1/#2). Nothing here is read by the
 * engine, nothing here is written to `state`, and a battle replays to the same
 * digest whether or not a single frame was ever drawn — the same standing the
 * renderer's facing memory has. It is fed the event log the engine already
 * produced and draws what it finds there.
 *
 * HOW A SPRITE IS DRAWN
 *
 * One nested <svg> per effect, with `viewBox` selecting one cell out of the
 * sheet and `overflow:hidden` clipping to it. Advancing a frame is one
 * attribute write, there is no <clipPath> to keep alive in <defs>, and the
 * node survives the renderer's full redraw — it is simply re-appended to the
 * fresh layer each frame (see attach()).
 *
 * WHAT IS LOADED
 *
 * The manifest, once. Then only the sheets the two packs on the board can
 * actually produce: prepare() asks effect-map.js which families those packs
 * declare and warms exactly those. A game with no flamers never fetches the
 * cone; a game with no psykers never fetches the warp. Anything outside that
 * set is refused at spawn time too, so a mis-scan costs a missing animation
 * rather than a surprise download mid-battle.
 */
import {
  weaponEffects, ployFamily, tokenFamily, findPloyInPack, familiesForPacks,
} from './effect-map.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BASE = './assets/effects';
const MANIFEST_URL = `${BASE}/manifest.json`;

/** How far apart the attacks inside one activation are played. */
const STAGGER_MS = 150;
const STAGGER_CAP_MS = 700;
/** A cone is stretched to the shot; these bound how silly that can get. */
const CONE_MIN_IN = 1.6;
const CONE_MAX_IN = 8;
const CONE_ASPECT = 0.72;
/** Where along the attacker-to-target line a melee swing lands. */
const SWING_AT = 0.62;
/** At most this many loops on the board at once, cheapest dropped first. */
const PERSISTENT_CAP = 24;

/**
 * A local element helper. ui/battlefield.js has its own; sharing one would
 * mean the renderer importing from here and this importing from there.
 */
function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ */
/* The manifest                                                        */
/* ------------------------------------------------------------------ */

let manifest = null;
let pendingManifest = null;

/**
 * Fetch the sprite index, at most once per session.
 *
 * A failure is cached as `false` rather than retried: the file either shipped
 * with the build or it didn't, and the app is required to look finished
 * without it (#9) — no manifest simply means no animations.
 */
export function loadEffectManifest() {
  if (manifest !== null) return Promise.resolve(manifest);
  if (pendingManifest) return pendingManifest;
  pendingManifest = fetch(MANIFEST_URL, { cache: 'force-cache' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((data) => {
      manifest = data && data.families && data.match ? data : false;
      return manifest;
    })
    .catch(() => { manifest = false; return manifest; })
    .finally(() => { pendingManifest = null; });
  return pendingManifest;
}

/* ------------------------------------------------------------------ */
/* The layer                                                           */
/* ------------------------------------------------------------------ */

export class EffectsLayer {
  constructor() {
    this.manifest = null;
    /** Families the packs on the board can produce. Nothing else may spawn. */
    this.allowed = new Set();
    this.enabled = true;
    /** Durations are scaled to fit the playback speed, so nothing outlives its step. */
    this.scale = 1;
    /** One-shots and things in flight. */
    this.live = [];
    /** Loops, keyed by what in the state is keeping them alive. */
    this.persistent = new Map();
    this.frame = null;
    this.seq = 0;
    this.under = null;
    this.over = null;
  }

  /**
   * Load the manifest and warm the sheets these two packs can use.
   *
   * Returns the family set so a caller (or a test) can assert exactly what a
   * given match-up costs.
   */
  async prepare(packs) {
    const loaded = await loadEffectManifest();
    this.manifest = loaded || null;
    this.allowed = loaded ? familiesForPacks(loaded, packs) : new Set();
    for (const family of this.allowed) {
      const url = this.sheetUrl(family);
      // A bare Image() puts the bytes in the HTTP cache without putting a node
      // in the document, so the first shot of the battle is not a blank frame.
      if (url && typeof Image === 'function') new Image().src = url;
    }
    return this.allowed;
  }

  /** Where one family's sheet lives, or null if it was never drawn. */
  sheetUrl(family) {
    const entry = this.manifest?.families?.[family];
    return entry ? `${BASE}/${entry.sheet}` : null;
  }

  /** A new battle: drop everything on the board. */
  reset() {
    for (const fx of this.live) fx.node.remove();
    for (const fx of this.persistent.values()) fx.node.remove();
    this.live = [];
    this.persistent.clear();
    this._stop();
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.reset();
  }

  /**
   * Fit the animations to the clock.
   *
   * At 900ms a step there is room for a shot to travel and a fireball to
   * bloom; at 200ms there is not, and an explosion still burning three
   * activations later reads as a bug rather than as an explosion.
   */
  setTempo(stepDelayMs) {
    this.scale = stepDelayMs > 0 ? clamp(stepDelayMs / 700, 0.5, 1.15) : 0;
  }

  /* ---------------------------------------------------------------- */
  /* Spawning                                                          */
  /* ---------------------------------------------------------------- */

  _family(name) {
    if (!this.enabled || !this.manifest || !this.allowed.has(name)) return null;
    return this.manifest.families[name] || null;
  }

  /**
   * Build the node for one part of one family.
   *
   * The whole sheet goes in as a single <image>; the nested <svg>'s viewBox
   * picks the cell, in the sheet's own pixels.
   */
  _build(family, partName) {
    const fam = this._family(family);
    const part = fam?.parts?.[partName];
    if (!part) return null;

    const rows = Object.keys(fam.parts).length;
    const cols = Math.max(...Object.values(fam.parts).map((p) => p.frames));
    const node = el('g');
    node.setAttribute('pointer-events', 'none');
    const view = el('svg', {
      overflow: 'hidden',
      preserveAspectRatio: 'none',
      viewBox: `0 ${part.row * fam.cell} ${fam.cell} ${fam.cell}`,
    }, node);
    const image = el('image', {
      href: this.sheetUrl(family),
      x: 0, y: 0, width: fam.cell * cols, height: fam.cell * rows,
    }, view);
    // A sheet that 404s takes its effect off the board rather than leaving a
    // broken-image glyph over the battlefield.
    image.addEventListener('error', () => { node.remove(); });

    return {
      id: `fx${++this.seq}`,
      family, part: partName, fam, info: part,
      node, view, cell: fam.cell,
      frames: part.frames,
      ms: Math.max(60, part.ms * (this.scale || 1)),
      shown: -1,
    };
  }

  _push(fx) {
    if (!fx) return null;
    this.live.push(fx);
    if (this.under || this.over) (fx.below ? this.under : this.over)?.appendChild(fx.node);
    this._start();
    return fx;
  }

  /** A sprite pinned to one spot, played once. */
  _spawnAt(family, part, { x, y, deg = 0, size, delay = 0, below = false }) {
    const fx = this._build(family, part);
    if (!fx) return null;
    const fam = fx.fam;
    const s = size ?? fam.inches ?? 2;
    fx.kind = 'static';
    fx.below = below;
    fx.x = x; fx.y = y; fx.deg = deg; fx.size = s;
    fx.startAt = delay;
    fx.node.setAttribute('transform', `translate(${x} ${y}) rotate(${deg})`);
    fx.view.setAttribute('x', -s / 2);
    fx.view.setAttribute('y', -s / 2);
    fx.view.setAttribute('width', s);
    fx.view.setAttribute('height', s);
    return this._push(fx);
  }

  /** A cone, hinged on the shooter and stretched to reach the target. */
  _spawnCone(family, { from, to, delay = 0 }) {
    const fx = this._build(family, 'cone');
    if (!fx) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = clamp(Math.hypot(dx, dy), CONE_MIN_IN, CONE_MAX_IN);
    const h = len * CONE_ASPECT;
    fx.kind = 'static';
    fx.below = false;
    fx.startAt = delay;
    fx.node.setAttribute('transform',
      `translate(${from.x} ${from.y}) rotate(${(Math.atan2(dy, dx) * 180) / Math.PI})`);
    // The sprite's apex sits a fraction in from its left edge; back the
    // viewport up by that much so the fire starts at the muzzle.
    fx.view.setAttribute('x', -0.02 * len);
    fx.view.setAttribute('y', -h / 2);
    fx.view.setAttribute('width', len);
    fx.view.setAttribute('height', h);
    return this._push(fx);
  }

  /** Something in flight, from one point to another. */
  _spawnTravel(family, { from, to, delay = 0, arc = false }) {
    const fx = this._build(family, 'tracer');
    if (!fx) return null;
    const fam = fx.fam;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const travel = fam.travel || { msPerInch: 13, min: 110, max: 520 };
    const s = fam.inches ?? 1.7;
    fx.kind = 'travel';
    fx.below = false;
    fx.from = from; fx.to = to;
    fx.arc = arc ? Math.min(1.7, dist * 0.16) : 0;
    fx.size = s;
    fx.startAt = delay;
    fx.travelMs = clamp(dist * travel.msPerInch, travel.min, travel.max) * (this.scale || 1);
    // A tracer loops its own flicker for as long as the flight lasts; the
    // flight itself is what retires it (see tick()).
    fx.loop = true;
    fx.view.setAttribute('x', -s / 2);
    fx.view.setAttribute('y', -s / 2);
    fx.view.setAttribute('width', s);
    fx.view.setAttribute('height', s);
    return this._push(fx);
  }

  /** A loop that follows an operative for as long as the state holds. */
  _spawnLoop(family, key, { x, y, below = false, tint = null }) {
    const fx = this._build(family, 'loop');
    if (!fx) return null;
    const s = fx.fam.inches ?? 2;
    fx.kind = 'loop';
    fx.loop = true;
    fx.below = below;
    fx.size = s;
    fx.startAt = 0;
    fx.key = key;
    fx.view.setAttribute('x', -s / 2);
    fx.view.setAttribute('y', -s / 2);
    fx.view.setAttribute('width', s);
    fx.view.setAttribute('height', s);
    if (tint) fx.node.setAttribute('filter', `url(#fx-tint-${tint})`);
    fx.node.setAttribute('transform', `translate(${x} ${y})`);
    fx.x = x; fx.y = y;
    fx.born = null;
    this.persistent.set(key, fx);
    if (this.under || this.over) (below ? this.under : this.over)?.appendChild(fx.node);
    this._start();
    return fx;
  }

  /* ---------------------------------------------------------------- */
  /* Reading the event log                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Turn the events one engine step produced into animations.
   *
   * A step is a whole activation, so it can carry a move, three shots and a
   * fight. They are played in order with a small stagger rather than all at
   * once, which is what makes a burst of fire read as a burst of fire.
   */
  handle(state, events) {
    if (!this.enabled || !this.manifest) return;

    // Damage is attributed to the attack it followed, which is how a hit is
    // told from a miss: the engine says who rolled, and who then bled.
    const beats = [];
    let attack = null;
    for (const event of events) {
      if (event.type === 'ATTACK_ROLLED') {
        attack = { attack: event, damage: new Map() };
        beats.push(attack);
      } else if (event.type === 'DAMAGE_APPLIED' && attack) {
        const by = event.source?.attackerId;
        if (by) attack.damage.set(by, (attack.damage.get(by) || 0) + (event.amount || 0));
      } else if (event.type === 'PLOY_USED') {
        beats.push({ ploy: event });
      }
    }

    let delay = 0;
    for (const beat of beats) {
      if (beat.ploy) this._playPloy(state, beat.ploy, delay);
      else this._playAttack(state, beat, delay);
      delay = Math.min(delay + STAGGER_MS * (this.scale || 1), STAGGER_CAP_MS);
    }
  }

  _playAttack(state, { attack, damage }, delay) {
    const from = state.operatives[attack.attackerId];
    const to = state.operatives[attack.targetId];
    if (!from?.placed || !to?.placed) return;

    if (attack.kind === 'fight') return this._playFight(from, to, damage, delay);

    const spec = weaponEffects(this.manifest, {
      type: 'ranged', name: attack.weapon, rules: attack.weaponRules,
    });
    const hit = (damage.get(from.id) || 0) > 0;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;

    // A cone replaces the shot: there is nothing in flight to draw.
    if (spec.aoe === 'flame' || spec.aoe === 'spray') {
      return this._spawnCone(spec.aoe, { from, to, delay });
    }
    if (!spec.projectile) return null;

    this._spawnAt(spec.projectile, 'muzzle', { x: from.x, y: from.y, deg, delay });

    // A miss goes past the target rather than through it, so a shot that did
    // nothing does not look like a shot that was ignored.
    const len = Math.hypot(dx, dy) || 1;
    const end = hit ? { x: to.x, y: to.y } : {
      x: to.x + (dx / len) * 0.7 - (dy / len) * 0.55,
      y: to.y + (dy / len) * 0.7 + (dx / len) * 0.55,
    };
    const arc = !!this.manifest.families[spec.projectile]?.arc;
    const flight = this._spawnTravel(spec.projectile, { from, to: end, delay, arc });
    const landed = delay + (flight?.travelMs ?? 0);

    if (spec.aoe === 'blast') this._spawnAt('blast', 'burst', { x: to.x, y: to.y, delay: landed });
    else if (hit) this._spawnAt(spec.projectile, 'impact', { x: to.x, y: to.y, deg, delay: landed });
    return flight;
  }

  /**
   * A fight is both fighters at once, which is what the sprites say.
   *
   * The attacker always swings. If the defender drew blood it swung back, and
   * gets a strike of its own a beat later; if nobody drew blood on the
   * attacker's side, the defender blocked, and gets a parry instead. Those
   * three cases are exactly what rules/fighting.js resolves as strike, strike
   * and parry — read back off the damage rather than off its private sequence.
   */
  _playFight(from, to, damage, delay) {
    const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    this._spawnAt('strike', 'swing', {
      x: lerp(from.x, to.x, SWING_AT), y: lerp(from.y, to.y, SWING_AT), deg, delay,
    });

    const struckBack = (damage.get(to.id) || 0) > 0;
    const gotThrough = (damage.get(from.id) || 0) > 0;
    const back = (deg + 180) % 360;
    if (struckBack) {
      this._spawnAt('strike', 'swing', {
        x: lerp(to.x, from.x, SWING_AT), y: lerp(to.y, from.y, SWING_AT),
        deg: back, delay: delay + 170 * (this.scale || 1),
      });
    } else if (!gotThrough) {
      this._spawnAt('parry', 'swing', {
        x: to.x, y: to.y, deg: back, delay: delay + 110 * (this.scale || 1),
      });
    }
  }

  /**
   * A ploy's mark.
   *
   * One with an operative named goes on that operative. A strategic ploy has
   * none — it is bought for the team in the strategy phase — so the order
   * goes out to a handful of them in turn, which is what it looks like from
   * the board. (The mark always plays over the team that BOUGHT the ploy,
   * including `hex`: the event says who spent the CP, never who it lands on.)
   */
  _playPloy(state, event, delay) {
    const pack = state.teamPacks?.[event.playerId];
    const { ploy } = findPloyInPack(pack, event.ployId);
    const family = ployFamily(this.manifest, ploy);
    if (!family) return;

    const named = event.operativeId ? state.operatives[event.operativeId] : null;
    const anchors = named ? [named] : Object.values(state.operatives)
      .filter((op) => op.playerId === event.playerId && op.alive && op.placed)
      .slice(0, 5);
    anchors.forEach((op, i) => {
      if (!op?.alive || !op.placed) return;
      this._spawnAt(family, 'mark', {
        x: op.x, y: op.y, delay: delay + i * 70 * (this.scale || 1),
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Persistent effects                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Reconcile the loops on the board with what the state now says.
   *
   * Called on every render, so a shield appears the moment the CP is spent and
   * is gone the moment the ploy lapses, without anything having to tell this
   * layer that it did. Loops that are still wanted keep their node — and so
   * their phase — and are simply moved to where their operative now stands.
   */
  sync(state) {
    if (!this.enabled || !this.manifest || !state) {
      for (const fx of this.persistent.values()) fx.node.remove();
      this.persistent.clear();
      return;
    }

    // Ordered: what is happening TO an operative outranks what its team bought,
    // so the cap sheds auras before it sheds a burning operative.
    const wanted = [];
    const seen = new Set();
    const want = (family, op, extra = {}) => {
      const key = `${op.id}:${family}`;
      if (seen.has(key) || !this.allowed.has(family)) return;
      seen.add(key);
      wanted.push({ key, family, op, ...extra });
    };

    for (const op of Object.values(state.operatives)) {
      if (!op.alive || !op.placed) continue;
      for (const token of op.tokens || []) {
        const family = tokenFamily(this.manifest, token);
        if (family) want(family, op, { below: family === 'toxin' });
      }
    }

    for (const playerId of ['p1', 'p2']) {
      const ploys = state.players?.[playerId]?.ploys;
      const pack = state.teamPacks?.[playerId];
      for (const held of ploys?.firefight || []) {
        const { ploy } = findPloyInPack(pack, held.ployId);
        if (ployFamily(this.manifest, ploy) !== 'ward') continue;
        const op = state.operatives[held.operativeId];
        if (op?.alive && op.placed) want('shield', op);
      }
      if ((ploys?.active || []).length) {
        for (const op of Object.values(state.operatives)) {
          if (op.playerId === playerId && op.alive && op.placed) {
            want('aura', op, { below: true, tint: playerId });
          }
        }
      }
    }

    const keep = wanted.slice(0, PERSISTENT_CAP);
    const keepKeys = new Set(keep.map((w) => w.key));
    for (const [key, fx] of this.persistent) {
      if (!keepKeys.has(key)) { fx.node.remove(); this.persistent.delete(key); }
    }
    for (const { key, family, op, below, tint } of keep) {
      const existing = this.persistent.get(key);
      if (existing) {
        if (existing.x !== op.x || existing.y !== op.y) {
          existing.x = op.x; existing.y = op.y;
          existing.node.setAttribute('transform', `translate(${op.x} ${op.y})`);
        }
        continue;
      }
      this._spawnLoop(family, key, { x: op.x, y: op.y, below: !!below, tint });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Drawing                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Re-home every live node into the layers of a freshly drawn board.
   *
   * ui/battlefield.js wipes the SVG on every render; appendChild MOVES a node
   * rather than copying it, so an effect keeps its identity, its phase and its
   * start time straight through the redraw.
   */
  attach(under, over) {
    this.under = under;
    this.over = over;
    if (under) this._tintFilters(under);
    for (const fx of this.persistent.values()) (fx.below ? under : over)?.appendChild(fx.node);
    for (const fx of this.live) (fx.below ? under : over)?.appendChild(fx.node);
    if (this.live.length || this.persistent.size) this._start();
  }

  /**
   * Team colour for the aura, as a filter rather than as a second sprite.
   *
   * `flood-color` is read as CSS, so the board's own --p1/--p2 reach it and a
   * high-contrast palette swap is picked up for free. Compositing the flood
   * against SourceAlpha keeps the sprite's soft edges and throws away its own
   * colour, which is why the aura is drawn white.
   */
  _tintFilters(parent) {
    const defs = el('defs', {}, parent);
    for (const playerId of ['p1', 'p2']) {
      const filter = el('filter', {
        id: `fx-tint-${playerId}`,
        x: '-20%', y: '-20%', width: '140%', height: '140%',
      }, defs);
      const flood = el('feFlood', { 'flood-opacity': 1 }, filter);
      flood.style.floodColor = `var(--${playerId})`;
      el('feComposite', { in2: 'SourceAlpha', operator: 'in' }, filter);
    }
  }

  _start() {
    if (this.frame !== null || !this.enabled) return;
    const step = () => {
      this.frame = null;
      this.tick(this._now());
      if (this.live.length || this.persistent.size) this._start();
    };
    this.frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(step) : setTimeout(step, 33);
  }

  _stop() {
    if (this.frame === null) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame);
    else clearTimeout(this.frame);
    this.frame = null;
  }

  _now() {
    return typeof performance === 'object' ? performance.now() : Date.now();
  }

  /** One animation frame: advance everything, retire whatever has finished. */
  tick(now) {
    const alive = [];
    for (const fx of this.live) {
      if (fx.born === undefined || fx.born === null) fx.born = now;
      const age = now - fx.born - fx.startAt;
      if (age < 0) { fx.node.setAttribute('visibility', 'hidden'); alive.push(fx); continue; }
      fx.node.removeAttribute('visibility');

      if (fx.kind === 'travel') {
        const p = clamp(age / fx.travelMs, 0, 1);
        let x = lerp(fx.from.x, fx.to.x, p);
        let y = lerp(fx.from.y, fx.to.y, p);
        let deg = (Math.atan2(fx.to.y - fx.from.y, fx.to.x - fx.from.x) * 180) / Math.PI;
        if (fx.arc) {
          // A lobbed shot rides a parabola, and points along its own tangent.
          y -= fx.arc * 4 * p * (1 - p);
          const dy = (fx.to.y - fx.from.y) - fx.arc * 4 * (1 - 2 * p);
          deg = (Math.atan2(dy, fx.to.x - fx.from.x) * 180) / Math.PI;
        }
        fx.node.setAttribute('transform', `translate(${x} ${y}) rotate(${deg})`);
        if (p >= 1) { fx.node.remove(); continue; }
      }

      const span = fx.ms / fx.frames;
      let index = Math.floor(age / span);
      if (fx.loop) index %= fx.frames;
      else if (index >= fx.frames) { fx.node.remove(); continue; }
      if (index !== fx.shown) {
        fx.shown = index;
        fx.view.setAttribute('viewBox',
          `${index * fx.cell} ${fx.info.row * fx.cell} ${fx.cell} ${fx.cell}`);
      }
      alive.push(fx);
    }
    this.live = alive;

    for (const fx of this.persistent.values()) {
      if (fx.born === null || fx.born === undefined) fx.born = now;
      const index = Math.floor(((now - fx.born) / (fx.ms / fx.frames))) % fx.frames;
      if (index !== fx.shown) {
        fx.shown = index;
        fx.view.setAttribute('viewBox',
          `${index * fx.cell} ${fx.info.row * fx.cell} ${fx.cell} ${fx.cell}`);
      }
    }
  }
}
