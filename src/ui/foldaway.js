/**
 * Folding a dialog down to a pill, and putting it back.
 *
 * Two screens in this app cover the battlefield at exactly the moment the
 * player wants to look at it. The orders prompt asks what an operative should
 * do while hiding who is standing where; the result screen announces the
 * winner while hiding the board that produced them — the last positions, the
 * bodies, which markers were held at the end. Both want the same answer: fold
 * the dialog to a pill in the corner, leave the battle underneath live and
 * clickable, and keep the way back one tap away.
 *
 * Folding is a CSS state on the OVERLAY (`.minimized`), not a hidden dialog.
 * The overlay keeps `hidden = false` throughout, so nothing is torn down and
 * nothing has to be rebuilt to come back — which matters most for the orders
 * prompt, where the engine is stopped mid-activation the whole time it is
 * folded away.
 *
 * Nothing here knows what is being folded. It owns the eye, the pill and the
 * class; the caller owns the dialog and says what the pill should read.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The eye, open or struck through.
 *
 * Drawn rather than fetched or lettered: it sits on a button that is 28px
 * square in dialogs that already load no images, and an emoji renders as a
 * different picture on every platform this runs on.
 */
export function eyeIcon(open) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M1.8 12S5.6 5.2 12 5.2 22.2 12 22.2 12 18.4 18.8 12 18.8 1.8 12 1.8 12Z');
  svg.append(path);
  const pupil = document.createElementNS(SVG_NS, 'circle');
  pupil.setAttribute('cx', '12');
  pupil.setAttribute('cy', '12');
  pupil.setAttribute('r', '3.1');
  svg.append(pupil);
  if (!open) {
    const slash = document.createElementNS(SVG_NS, 'path');
    slash.setAttribute('d', 'M3.5 3.5 20.5 20.5');
    svg.append(slash);
  }
  return svg;
}

/**
 * The eye button that goes on a dialog's own header.
 *
 * Rebuilt per render rather than kept, because everything else in these
 * headers is rebuilt and a header that is half fresh and half reused is the
 * kind of thing that goes stale without anyone noticing.
 */
export function peekButton(onClick, label = 'Hide this and look at the battlefield') {
  const peek = h('button', 'fold-peek');
  peek.type = 'button';
  peek.append(eyeIcon(false));
  peek.title = label;
  peek.setAttribute('aria-label', label);
  peek.addEventListener('click', onClick);
  return peek;
}

export class Foldaway {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.overlay the overlay that carries `.minimized`
   * @param {() => HTMLElement|null} deps.dialog what to mark `aria-modal` on
   * @param {() => string} deps.caption what the pill should read right now
   * @param {() => string} [deps.restoreLabel] the pill's title and aria-label
   */
  constructor({ overlay, dialog, caption, restoreLabel }) {
    this.overlay = overlay;
    this._dialog = dialog;
    this._caption = caption;
    this._restoreLabel = restoreLabel ?? (() => 'Show this again');
    this.minimized = false;
    this.pill = null;
    /** Painted down the pill's leading edge — the team's colour, usually. */
    this.accent = null;
  }

  set(value) {
    this.minimized = value === true;
    const dialog = this._dialog?.() ?? null;
    if (this.minimized) {
      this.overlay.classList.add('minimized');
      dialog?.setAttribute('aria-modal', 'false');
      this._pill().hidden = false;
      this.pill.focus();
    } else {
      this.overlay.classList.remove('minimized');
      dialog?.setAttribute('aria-modal', 'true');
      if (this.pill) this.pill.hidden = true;
    }
  }

  toggle() { this.set(!this.minimized); }

  /**
   * The pill the folded dialog leaves behind, built once and reused.
   *
   * It lives on the overlay rather than inside the dialog, which is emptied
   * and rebuilt: the pill has to outlive a re-render and be the one thing on a
   * pass-through overlay that still takes a click.
   */
  _pill() {
    if (!this.pill) {
      this.pill = h('button', 'fold-pill');
      this.pill.type = 'button';
      this.pill.append(eyeIcon(true), h('span', 'fold-pill-text'));
      this.pill.addEventListener('click', () => this.set(false));
      this.overlay.append(this.pill);
    }
    const caption = this.pill.children[this.pill.children.length - 1];
    caption.textContent = this._caption();
    const label = this._restoreLabel();
    this.pill.title = label;
    this.pill.setAttribute('aria-label', label);
    if (this.accent) this.pill.style.borderLeftColor = this.accent;
    return this.pill;
  }
}
