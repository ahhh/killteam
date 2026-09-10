/**
 * SVG battlefield renderer.
 *
 * Reads state and draws it. It never decides anything about the rules (#1/#2):
 * if a token is somewhere, it is because the engine put it there.
 *
 * All tokens and terrain are original geometric artwork — abstract shapes
 * keyed to role and team, never reproductions of any published design.
 */
import { PHASES } from '../state.js';

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

export class BattlefieldRenderer {
  constructor(svg, { onSelectOperative } = {}) {
    this.svg = svg;
    this.onSelectOperative = onSelectOperative;
    this.selectedId = null;
    this.highlight = null;   // { type:'path'|'shot', ... }
    this.view = { scale: 1, x: 0, y: 0 };
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

    this.root = el('g', {}, this.svg);
    this._applyView();

    this._drawBoard(this.root, state);
    this._drawDeploymentZones(this.root, state, colors);
    this._drawTerrain(this.root, state);
    this._drawObjectives(this.root, state, colors);
    this._drawHighlight(this.root, state);
    this._drawOperatives(this.root, state, colors);
  }

  _hatch(defs, id, stroke) {
    const pattern = el('pattern', {
      id, width: 0.7, height: 0.7, patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)',
    }, defs);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 0.7, stroke, 'stroke-width': 0.09, opacity: 0.5 }, pattern);
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

  _drawTerrain(g, state) {
    const layer = el('g', {}, g);
    for (const piece of state.map.terrain || []) {
      const points = piece.shape.points.map((p) => `${p.x},${p.y}`).join(' ');
      const traversable = (piece.traits || []).includes('traversable');
      const obscuring = (piece.traits || []).includes('obscuring');

      const shape = el('polygon', {
        points,
        fill: obscuring ? 'var(--terrain)' : 'url(#hatch-terrain)',
        'fill-opacity': obscuring ? 0.95 : 0.6,
        stroke: 'var(--terrain-edge)',
        'stroke-width': traversable ? 0.05 : 0.09,
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

      // Control range ring, shown for the selected operative only.
      if (selected && op.alive) {
        el('circle', {
          r: r + 1, fill: 'none', stroke: 'var(--accent)', 'stroke-opacity': 0.45,
          'stroke-width': 0.05, 'stroke-dasharray': '0.2 0.2',
        }, group);
      }

      el('circle', {
        r, fill: 'var(--bg-raised)', stroke: colour,
        'stroke-width': selected ? 0.16 : 0.1,
      }, group);

      // Order ring: dashed = Conceal, solid = Engage. Shape, not just colour.
      if (op.alive) {
        el('circle', {
          r: r - 0.16, fill: 'none', stroke: colour, 'stroke-opacity': 0.75,
          'stroke-width': 0.07,
          'stroke-dasharray': op.order === 'conceal' ? '0.18 0.16' : null,
        }, group);
      }

      const glyph = el('path', {
        d: rolePath(op.role),
        transform: `scale(${op.baseDiameter})`,
        fill: op.role === 'sniper' || op.role === 'objective-runner' ? 'none' : colour,
        stroke: colour,
        'stroke-width': 0.06,
        'stroke-linecap': 'round',
      }, group);

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
