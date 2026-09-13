/**
 * SVG battlefield renderer.
 *
 * Reads state and draws it. It never decides anything about the rules (#1/#2):
 * if a token is somewhere, it is because the engine put it there.
 *
 * All tokens and terrain are original geometric artwork — abstract shapes
 * keyed to role and team, never reproductions of any published design. The
 * face on a base is the same generated illustration the roster panel and the
 * character sheet use, cropped small and round (see ui/portraits.js).
 */
import { PHASES } from '../state.js';
import { operativePipUrl } from './portraits.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Margin around the board, in inches. */
const MARGIN = 1.2;

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Role glyphs: simple, distinguishable, and legible at token size. */
function rolePath(role) {
  switch (role) {
    case 'assault':           return 'M -0.20 0.22 L 0 -0.24 L 0.20 0.22 Z';       // spearhead
    case 'ranged':            return 'M -0.22 -0.08 L 0.22 -0.08 L 0.22 0.06 L -0.22 0.06 Z'; // barrel
    case 'sniper':            return 'M -0.24 0 L 0.24 0 M 0 -0.24 L 0 0.24';       // crosshair
    case 'support':           return 'M -0.20 0 L 0 -0.20 L 0.20 0 L 0 0.20 Z';     // diamond
    case 'objective-runner':  return 'M -0.18 0.18 L 0.18 -0.18 M -0.18 -0.18 L 0.18 0.18';
    default:                  return 'M -0.16 -0.16 L 0.16 -0.16 L 0.16 0.16 L -0.16 0.16 Z';
  }
}

/**
 * A wedge off the front of a base, from its rim outwards: where an operative
 * is looking. Purely a drawing — the rules have no facing (see _trackFacing).
 */
function facingCone(r, angle, spread = 0.48, reach = 0.62) {
  const at = (radius, a) => `${Math.cos(a) * radius} ${Math.sin(a) * radius}`;
  const a0 = angle - spread;
  const a1 = angle + spread;
  const outer = r + reach;
  return `M ${at(r, a0)} L ${at(outer, a0)} A ${outer} ${outer} 0 0 1 ${at(outer, a1)} `
    + `L ${at(r, a1)} A ${r} ${r} 0 0 0 ${at(r, a0)} Z`;
}

export class BattlefieldRenderer {
  constructor(svg, { onSelectOperative, effects = null } = {}) {
    this.svg = svg;
    this.onSelectOperative = onSelectOperative;
    /**
     * The animation layer (ui/effects.js), or null.
     *
     * It is handed the two groups below, re-homed on every redraw, and asked
     * to reconcile its loops with the state. Like facing, it is drawing and
     * not rules: nothing here reads it back and the engine cannot see it.
     */
    this.effects = effects;
    this.selectedId = null;
    this.highlight = null;   // { type:'path'|'shot', ... }
    this.view = { scale: 1, x: 0, y: 0 };
    /**
     * Which way each operative is looking, in radians, and where it was
     * standing when that was last decided.
     *
     * Facing is not a rule in this game — nothing in `rules/` reads it and
     * nothing may (#1/#2). It is the renderer remembering which way each
     * figure walked or shot, so a board of twenty circles reads as a board of
     * twenty people who are up to something. That is why it lives here and not
     * on state: a battle replays identically whether or not anyone drew it.
     */
    this.facing = new Map();
    this.facingFrom = new Map();
    this.facingKey = null;
    this.facingEvents = 0;
    this._setupPanZoom();
  }

  _setupPanZoom() {
    let dragging = false;
    let last = null;
    this.svg.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-operative]')) return;
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.view.x += e.clientX - last.x;
      this.view.y += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      this._applyView();
    });
    const stop = () => { dragging = false; };
    this.svg.addEventListener('pointerup', stop);
    this.svg.addEventListener('pointercancel', stop);
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.view.scale = Math.min(4, Math.max(0.4, this.view.scale * factor));
      this._applyView();
    }, { passive: false });
  }

  _applyView() {
    if (!this.root) return;
    const { scale, x, y } = this.view;
    this.root.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
  }

  resetView() {
    this.view = { scale: 1, x: 0, y: 0 };
    this._applyView();
  }

  /** Full redraw. Cheap enough at this object count (§33). */
  render(state, { colors }) {
    const { width, height } = state.map.board;
    this.svg.setAttribute('viewBox', `${-MARGIN} ${-MARGIN} ${width + MARGIN * 2} ${height + MARGIN * 2}`);
    this.svg.replaceChildren();

    const defs = el('defs', {}, this.svg);
    this._hatch(defs, 'hatch-terrain', 'var(--terrain-edge)');
    // Matches what the roster card does to a downed operative's token in CSS.
    const grey = el('filter', { id: 'pip-down' }, defs);
    el('feColorMatrix', { type: 'saturate', values: 0 }, grey);

    this._trackFacing(state);

    this.root = el('g', {}, this.svg);
    this._applyView();

    this._drawBoard(this.root, state);
    const art = this._drawArt(this.root, state);
    // The art already paints the zones on four of the five bundled killzones,
    // and painting ours on top of them is two dashed rectangles saying the
    // same thing. A map whose art does NOT show them (the temple draws a
    // narrower strip than it plays) keeps the engine's own (#5: that is a
    // property of the data, not of this module).
    if (!(art && state.map.art?.showsZones)) {
      this._drawDeploymentZones(this.root, state, colors);
    }
    this._drawTerrain(this.root, state, { art });
    this._drawObjectives(this.root, state, colors);
    this._drawHighlight(this.root, state);
    // Two animation layers, because an aura belongs under the figures and an
    // explosion belongs over them.
    const fxUnder = el('g', {}, this.root);
    this._drawOperatives(this.root, state, colors);
    const fxOver = el('g', {}, this.root);
    this.effects?.sync(state);
    this.effects?.attach(fxUnder, fxOver);
  }

  _hatch(defs, id, stroke) {
    const pattern = el('pattern', {
      id, width: 0.7, height: 0.7, patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)',
    }, defs);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 0.7, stroke, 'stroke-width': 0.09, opacity: 0.5 }, pattern);
  }

  /**
   * The painted killzone, if the map ships one.
   *
   * The image is cropped to exactly the playing surface at build time, so it
   * lands on the board rectangle with no per-map offsets to carry — the only
   * calibration is in the crop, and it is done once (`tools/make-map-art.mjs`).
   * `preserveAspectRatio="none"` because the art is not drawn to the board's
   * 30:22 exactly and stretching a background by a couple of percent is
   * invisible, whereas letterboxing it is not.
   *
   * Nothing here is load-bearing: the board underneath is drawn either way, a
   * fetch that fails leaves the geometric map exactly as it was, and the rules
   * never read it. High contrast turns it off outright — the whole point of
   * that mode is that nothing competes with the tokens.
   *
   * @returns {boolean} whether art was drawn.
   */
  _drawArt(g, state) {
    const art = state.map.art;
    if (!art?.href) return false;
    if (typeof document !== 'undefined' &&
        document.body?.classList.contains('high-contrast')) return false;

    const { width, height } = state.map.board;
    const image = el('image', {
      href: art.href, x: 0, y: 0, width, height,
      preserveAspectRatio: 'none',
      // Decoded off the main thread; the board is already on screen by then.
      decoding: 'async',
    }, g);
    // SVG 1.1 user agents only know the namespaced attribute.
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', art.href);
    return true;
  }

  _drawBoard(g, state) {
    const { width, height } = state.map.board;
    el('rect', { x: 0, y: 0, width, height, fill: 'var(--board)', stroke: 'var(--line)', 'stroke-width': 0.08 }, g);

    const grid = el('g', { opacity: 0.5 }, g);
    for (let x = 6; x < width; x += 6) {
      el('line', { x1: x, y1: 0, x2: x, y2: height, stroke: 'var(--board-grid)', 'stroke-width': 0.04 }, grid);
    }
    for (let y = 6; y < height; y += 6) {
      el('line', { x1: 0, y1: y, x2: width, y2: y, stroke: 'var(--board-grid)', 'stroke-width': 0.04 }, grid);
    }
    // A discreet scale bar so distances stay readable.
    const bar = el('g', { transform: `translate(0.2 ${height + 0.75})` }, g);
    el('line', { x1: 0, y1: 0, x2: 6, y2: 0, stroke: 'var(--text-faint)', 'stroke-width': 0.06 }, bar);
    el('line', { x1: 0, y1: -0.15, x2: 0, y2: 0.15, stroke: 'var(--text-faint)', 'stroke-width': 0.06 }, bar);
    el('line', { x1: 6, y1: -0.15, x2: 6, y2: 0.15, stroke: 'var(--text-faint)', 'stroke-width': 0.06 }, bar);
    const label = el('text', {
      x: 6.3, y: 0.16, fill: 'var(--text-faint)', 'font-size': 0.45, 'font-family': 'var(--mono)',
    }, bar);
    label.textContent = '6 inches';
  }

  _drawDeploymentZones(g, state, colors) {
    for (const zone of state.map.deploymentZones || []) {
      const points = zone.shape.points.map((p) => `${p.x},${p.y}`).join(' ');
      el('polygon', {
        points,
        fill: colors[zone.playerId],
        'fill-opacity': 0.05,
        stroke: colors[zone.playerId],
        'stroke-opacity': 0.28,
        'stroke-width': 0.06,
        'stroke-dasharray': '0.4 0.3',
      }, g);
    }
  }

  /**
   * Terrain, as the RULES see it.
   *
   * Over painted art this is drawn as an outline only. The art is a second,
   * hand-made description of the same killzone and it can disagree with the
   * data — so the polygons the engine actually collides against stay visible
   * on top of it rather than being replaced by a picture of them. It is also
   * the only place the one distinction the art cannot express survives:
   *
   *   solid edge  — blocking: sight AND movement stop here
   *   dashed edge — traversable: blocks sight, but is walked straight through
   *
   * Without art the polygons are filled as before, because then they are the
   * only thing describing the board.
   */
  _drawTerrain(g, state, { art = false } = {}) {
    const layer = el('g', {}, g);
    for (const piece of state.map.terrain || []) {
      const points = piece.shape.points.map((p) => `${p.x},${p.y}`).join(' ');
      const traversable = (piece.traits || []).includes('traversable');
      const obscuring = (piece.traits || []).includes('obscuring');

      const shape = el('polygon', {
        points,
        fill: art ? 'none' : (obscuring ? 'var(--terrain)' : 'url(#hatch-terrain)'),
        'fill-opacity': art ? 0 : (obscuring ? 0.95 : 0.6),
        stroke: 'var(--terrain-edge)',
        // Heavier over art: a hairline that reads fine on the flat board
        // disappears against a photograph of rubble.
        'stroke-width': art ? (traversable ? 0.07 : 0.12) : (traversable ? 0.05 : 0.09),
        'stroke-opacity': art ? 0.85 : 1,
        'stroke-dasharray': traversable ? '0.3 0.2' : null,
        'stroke-linejoin': 'round',
      }, layer);
      shape.setAttribute('data-terrain', piece.id);

      const title = el('title', {}, shape);
      title.textContent = `${piece.id} — ${(piece.traits || []).join(', ') || 'no traits'}`;
    }
  }

  _drawObjectives(g, state, colors) {
    const layer = el('g', {}, g);
    for (const objective of state.objectives) {
      const holder = objective.controlledBy;
      const colour = holder ? colors[holder] : 'var(--text-faint)';
      const range = objective.controlRange ?? 1;

      el('circle', {
        cx: objective.x, cy: objective.y, r: range,
        fill: holder ? colour : 'none', 'fill-opacity': 0.09,
        stroke: colour, 'stroke-opacity': 0.5, 'stroke-width': 0.05,
        'stroke-dasharray': '0.25 0.2',
      }, layer);

      // Original marker: an octagon, filled when held.
      const r = 0.42;
      const pts = Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        return `${objective.x + Math.cos(a) * r},${objective.y + Math.sin(a) * r}`;
      }).join(' ');
      const marker = el('polygon', {
        points: pts, fill: holder ? colour : 'var(--bg-raised)',
        stroke: colour, 'stroke-width': 0.07,
      }, layer);
      const t = el('title', {}, marker);
      t.textContent = `${objective.id} — ${holder ? `held by ${holder}` : 'contested'}` +
        (objective.control ? ` (APL ${objective.control.p1} v ${objective.control.p2})` : '');
    }
  }

  /** Movement paths and shot lines from the event currently being shown. */
  _drawHighlight(g, state) {
    const h = this.highlight;
    if (!h) return;
    const layer = el('g', {}, g);

    if (h.type === 'path' && h.path?.length > 1) {
      const d = h.path.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
      el('path', {
        d, fill: 'none', stroke: h.color || 'var(--accent)',
        'stroke-width': 0.12, 'stroke-dasharray': '0.35 0.25',
        'stroke-linecap': 'round', opacity: 0.9,
      }, layer);
      const end = h.path[h.path.length - 1];
      el('circle', { cx: end.x, cy: end.y, r: 0.18, fill: h.color || 'var(--accent)' }, layer);
    }

    if (h.type === 'shot' && h.from && h.to) {
      el('line', {
        x1: h.from.x, y1: h.from.y, x2: h.to.x, y2: h.to.y,
        stroke: h.hit ? 'var(--bad)' : 'var(--text-faint)',
        'stroke-width': h.hit ? 0.11 : 0.06,
        'stroke-dasharray': h.hit ? null : '0.2 0.2',
        opacity: 0.85,
      }, layer);
    }

    if (h.type === 'fight' && h.at) {
      el('circle', {
        cx: h.at.x, cy: h.at.y, r: 1.1, fill: 'none',
        stroke: 'var(--bad)', 'stroke-width': 0.1, opacity: 0.8,
      }, layer);
    }
  }

  /**
   * Update who is looking where, from the difference between this frame and
   * the last one.
   *
   * Walking sets your facing; attacking overrides it, because an operative
   * that just shot is looking down its barrel rather than along the path it
   * took to get there. A fight turns BOTH parties to each other — they are in
   * each other's control range by definition — while being shot at does not
   * spin the target round, since the whole point of a shot is that the target
   * may never have seen it.
   *
   * The memory is dropped when the seed and map say this is a different
   * battle, or when the event log gets shorter, which is a restart.
   */
  _trackFacing(state) {
    const key = `${state.seed}|${state.mapId}`;
    if (key !== this.facingKey || state.eventLog.length < this.facingEvents) {
      this.facingKey = key;
      this.facing.clear();
      this.facingFrom.clear();
    }
    this.facingEvents = state.eventLog.length;

    for (const op of Object.values(state.operatives)) {
      if (!op.placed) continue;
      const was = this.facingFrom.get(op.id);
      if (!was) { this.facingFrom.set(op.id, { x: op.x, y: op.y }); continue; }
      const dx = op.x - was.x;
      const dy = op.y - was.y;
      // A shove or a pile-in of a few tenths is not a decision to turn.
      if (Math.hypot(dx, dy) < 0.25) continue;
      this.facing.set(op.id, Math.atan2(dy, dx));
      this.facingFrom.set(op.id, { x: op.x, y: op.y });
    }

    const h = this.highlight;
    const attacker = h && state.operatives[h.attackerId];
    const target = h && state.operatives[h.targetId];
    if (attacker && target) {
      this._look(attacker, target);
      if (h.type === 'fight') this._look(target, attacker);
    }
  }

  _look(self, other) {
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    if (dx || dy) this.facing.set(self.id, Math.atan2(dy, dx));
  }

  /**
   * Which way this operative is looking, falling back — once, and then
   * remembered — to the enemy it deployed against. Everyone on the board has
   * an opinion about where the enemy is, even before they have moved.
   */
  _facingOf(op, state) {
    const known = this.facing.get(op.id);
    if (known !== undefined) return known;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const other of Object.values(state.operatives)) {
      if (!other.placed || other.playerId === op.playerId) continue;
      sx += other.x; sy += other.y; n += 1;
    }
    if (!n) return null;
    const dx = sx / n - op.x;
    const dy = sy / n - op.y;
    if (!dx && !dy) return null;
    const angle = Math.atan2(dy, dx);
    this.facing.set(op.id, angle);
    return angle;
  }

  _drawOperatives(g, state, colors) {
    const layer = el('g', {}, g);
    for (const op of Object.values(state.operatives)) {
      if (!op.placed) continue;
      const colour = colors[op.playerId];
      const r = op.baseDiameter / 2;
      const selected = this.selectedId === op.id;

      const group = el('g', {
        transform: `translate(${op.x} ${op.y})`,
        opacity: op.alive ? 1 : 0.32,
        tabindex: 0,
        role: 'button',
      }, layer);
      group.setAttribute('data-operative', op.id);
      group.style.cursor = 'pointer';

      const label = el('title', {}, group);
      label.textContent = `${op.name} — ${op.alive
        ? `${op.woundsRemaining}/${op.wounds} wounds, ${op.order}`
        : 'incapacitated'}`;

      // Which way this one is looking — a beam off the front of the base, and
      // the first thing drawn, so the art and the rings sit on top of it.
      const angle = op.alive ? this._facingOf(op, state) : null;
      if (angle !== null) el('path', { d: facingCone(r, angle), fill: colour, opacity: 0.22 }, group);

      // Control range ring, shown for the selected operative only.
      if (selected && op.alive) {
        el('circle', {
          r: r + 1, fill: 'none', stroke: 'var(--accent)', 'stroke-opacity': 0.45,
          'stroke-width': 0.05, 'stroke-dasharray': '0.2 0.2',
        }, group);
      }

      const pip = operativePipUrl(state.teamPacks[op.playerId], op.profileId);

      // Order is dashed = Conceal, solid = Engage — shape, not just colour, and
      // the tell a player reads fastest. On a bare token it is a ring inside
      // the base; where a face fills the base instead, the same dashes move out
      // to the base's own outline, which is the one edge the art cannot
      // swallow. Either way there is exactly one dashed circle to read.
      const concealed = op.alive && op.order === 'conceal';
      el('circle', {
        r, fill: 'var(--bg-raised)', stroke: colour,
        'stroke-width': selected ? 0.16 : 0.1,
        'stroke-dasharray': pip && concealed ? '0.24 0.2' : null,
      }, group);

      // The operative's face, where it has been drawn. The pip is round in its
      // own alpha channel, so it needs no clip path — it drops straight into
      // the base, just inside the outline.
      if (pip) {
        const inset = r - 0.1;
        const image = el('image', {
          href: pip, x: -inset, y: -inset, width: inset * 2, height: inset * 2,
          filter: op.alive ? null : 'url(#pip-down)',
        }, group);
        // The whole group is the click target; the picture must not eat it.
        image.style.pointerEvents = 'none';
        // Art that 404s (never drawn, or a stale manifest) leaves the plain
        // geometric token behind rather than a broken-image glyph.
        image.addEventListener('error', () => image.remove());
      } else if (op.alive) {
        el('circle', {
          r: r - 0.16, fill: 'none', stroke: colour, 'stroke-opacity': 0.75,
          'stroke-width': 0.07,
          'stroke-dasharray': concealed ? '0.18 0.16' : null,
        }, group);
      }

      // The role glyph owns the middle of a bare token, but a face has the
      // better claim on it: where there is art, the glyph shrinks to a badge
      // at the bottom of the base and keeps its meaning.
      const badge = pip ? el('g', { transform: `translate(0 ${r * 0.55})` }, group) : group;
      if (pip) {
        el('circle', { r: r * 0.36, fill: 'var(--bg-raised)', 'fill-opacity': 0.92 }, badge);
      }
      el('path', {
        d: rolePath(op.role),
        transform: `scale(${op.baseDiameter * (pip ? 0.45 : 1)})`,
        fill: op.role === 'sniper' || op.role === 'objective-runner' ? 'none' : colour,
        stroke: colour,
        'stroke-width': pip ? 0.09 : 0.06,
        'stroke-linecap': 'round',
      }, badge);

      if (!op.alive) {
        el('path', {
          d: `M ${-r * 0.7} ${-r * 0.7} L ${r * 0.7} ${r * 0.7} M ${r * 0.7} ${-r * 0.7} L ${-r * 0.7} ${r * 0.7}`,
          stroke: 'var(--bad)', 'stroke-width': 0.12, 'stroke-linecap': 'round', fill: 'none',
        }, group);
      } else if (op.woundsRemaining < op.wounds) {
        // Wound arc around the base: fuller arc = healthier.
        const frac = op.woundsRemaining / op.wounds;
        const ring = r + 0.18;
        const a0 = -Math.PI / 2;
        const a1 = a0 + Math.PI * 2 * frac;
        const large = frac > 0.5 ? 1 : 0;
        const d = `M ${Math.cos(a0) * ring} ${Math.sin(a0) * ring} ` +
          `A ${ring} ${ring} 0 ${large} 1 ${Math.cos(a1) * ring} ${Math.sin(a1) * ring}`;
        el('path', {
          d, fill: 'none',
          stroke: frac > 0.5 ? 'var(--good)' : frac > 0.25 ? 'var(--warn)' : 'var(--bad)',
          'stroke-width': 0.1, 'stroke-linecap': 'round',
        }, group);
      }

      const activate = () => this.onSelectOperative?.(op.id);
      group.addEventListener('click', activate);
      group.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
    }
  }
}
