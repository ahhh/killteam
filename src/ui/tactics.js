/**
 * The semi-manual orders prompt.
 *
 * When a player has put a kill team under their own control, the turning-point
 * machine stops mid-activation and hands this screen a `pending` block (see
 * `rules/phases.js`). It renders the options and reports which one was picked.
 *
 * It decides nothing. The options were built by the AI layer against the state
 * the engine had actually reached, and every action in the one the player
 * chooses is re-validated by the action layer when it resolves (#2, #3) — this
 * module is a set of buttons with the reasoning printed on them.
 *
 * Built for a phone first: the cards are the tap targets, they stack in one
 * column below 560px, and nothing here needs a hover to be discoverable. The
 * number keys are a shortcut for the people playing at a desk, not the way in.
 *
 * The prompt folds away. Half of what a player needs in order to choose is on
 * the board behind this dialog — who is where, what the log just said, what
 * that operative's sheet actually reads — so the eye button drops the dialog to
 * a pill in the corner and lets the battle underneath be read and clicked. It
 * is NOT an answer and not a dismissal: `pending` survives, `open` stays true,
 * and the engine is still stopped mid-activation until a card is picked.
 */

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The eye, open or struck through.
 *
 * Drawn rather than fetched or lettered: it sits on a button that is 28px
 * square in a dialog that already loads no images, and an emoji renders as a
 * different picture on every platform this runs on.
 */
function eyeIcon(open) {
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

export class TacticsPrompt {
  /**
   * @param {{root:HTMLElement, overlay:HTMLElement,
   *          onChoose:(optionId:string)=>void}} deps
   */
  constructor({ root, overlay, onChoose }) {
    this.root = root;
    this.overlay = overlay;
    this.onChoose = onChoose;
    this.pending = null;
    this.minimized = false;
    this.pill = null;
    this._onKey = (e) => this._key(e);
  }

  /** There is an unanswered activation. True while folded away, too. */
  get open() {
    return this.pending !== null;
  }

  /** Put a suspended activation in front of the player. */
  show(pending, { colors = {} } = {}) {
    this.pending = pending;
    this.accent = colors[pending.playerId] ?? null;
    // A new operative is being asked about, so the fold from the last one does
    // not carry over: the player folded away a question that has been answered.
    this._setMinimized(false);
    this.root.replaceChildren();

    const head = h('div', 'tactics-head');
    const text = h('div', 'tactics-headtext');
    const who = h('div', 'tactics-who');
    who.append(h('span', 'tactics-name', pending.operativeName));
    const badge = h('span', 'tactics-team', pending.teamName);
    badge.style.color = colors[pending.playerId] ?? 'var(--accent)';
    who.append(badge);
    text.append(who);

    // What the operative has to spend, which is the constraint every card on
    // the screen is priced against — and the reason a card can be cheaper than
    // the one above it without being worse.
    const spent = (pending.held ?? pending.ap) - pending.ap;
    const budget = spent > 0
      // Its own printed action came off the top before the menu was built, so
      // the cards are priced against what is left rather than what it started
      // with — saying only "2 AP" would look like a mistake next to a 3 AP
      // profile.
      ? `${pending.ap} of ${pending.held} AP left to spend`
      : `${pending.ap} AP to spend`;
    const sub = pending.counteract
      ? 'Counteraction — one action only'
      : `${budget} · choose this operative’s orders`;
    text.append(h('div', 'tactics-sub', sub));
    head.append(text, this._peekButton());
    this.root.append(head);

    const list = h('div', 'tactics-options');
    pending.options.forEach((option, i) => {
      list.append(this._card(option, i));
    });
    this.root.append(list);

    const foot = h('div', 'tactics-foot');
    const auto = h('button', 'tactics-auto', 'Let them decide');
    auto.addEventListener('click', () => this._choose('auto'));
    foot.append(auto);
    this.root.append(foot);

    this.overlay.hidden = false;
    document.addEventListener('keydown', this._onKey, true);
    // Focus the first card so a keyboard or screen-reader user lands on the
    // choice rather than somewhere behind the dialog.
    list.firstElementChild?.focus();
  }

  hide() {
    this.pending = null;
    this._setMinimized(false);
    this.overlay.hidden = true;
    this.root.replaceChildren();
    document.removeEventListener('keydown', this._onKey, true);
  }

  /** Fold the dialog down to its pill, leaving the battle underneath live. */
  minimize() {
    if (this.pending) this._setMinimized(true);
  }

  /** Put the unanswered choice back in front of the player. */
  restore() {
    if (this.pending) this._setMinimized(false);
  }

  toggleMinimized() {
    if (this.pending) this._setMinimized(!this.minimized);
  }

  /**
   * The eye, on the dialog's own header.
   *
   * A rebuilt button per prompt rather than a kept one, because everything
   * else in `show` is rebuilt and a header that is half fresh and half reused
   * is the kind of thing that goes stale without anyone noticing.
   */
  _peekButton() {
    const peek = h('button', 'tactics-peek');
    peek.type = 'button';
    peek.append(eyeIcon(false));
    const label = 'Hide this and look at the battlefield';
    peek.title = label;
    peek.setAttribute('aria-label', label);
    peek.addEventListener('click', () => this.minimize());
    return peek;
  }

  /**
   * The pill the folded dialog leaves behind, built once and reused.
   *
   * It lives on the overlay rather than in `root`, which `show` empties — the
   * pill has to outlive a re-render and be the one thing on a pass-through
   * overlay that still takes a click.
   */
  _restorePill() {
    if (!this.pill) {
      this.pill = h('button', 'tactics-pill');
      this.pill.type = 'button';
      this.pill.append(eyeIcon(true), h('span', 'tactics-pill-text'));
      this.pill.addEventListener('click', () => this.restore());
      this.overlay.append(this.pill);
    }
    const who = this.pending?.operativeName ?? 'this operative';
    const caption = this.pill.children[this.pill.children.length - 1];
    caption.textContent = `${who} is waiting for orders`;
    this.pill.title = 'Show the orders again';
    this.pill.setAttribute('aria-label', `Show the orders for ${who} again`);
    if (this.accent) this.pill.style.borderLeftColor = this.accent;
    return this.pill;
  }

  /**
   * Folded or not, in one place.
   *
   * The overlay keeps its `hidden = false` either way. Folding is a CSS state
   * on the overlay — no backdrop, no pointer target — rather than a hidden
   * dialog, so the answer is always one click away and the dialog never has to
   * be rebuilt to come back.
   */
  _setMinimized(value) {
    this.minimized = value;
    // The dialog is whatever `root` was put inside, not "the overlay's first
    // child" — the pill is a child of the overlay too, and a folded prompt
    // must not end up marking the pill as the dialog.
    const dialog = this.root.parentElement ?? null;
    if (value) {
      this.overlay.classList.add('minimized');
      dialog?.setAttribute('aria-modal', 'false');
      this._restorePill().hidden = false;
      this.pill.focus();
    } else {
      this.overlay.classList.remove('minimized');
      dialog?.setAttribute('aria-modal', 'true');
      if (this.pill) this.pill.hidden = true;
    }
  }

  _card(option, i) {
    const card = h('button', `tactic-card branch-${option.branch}`);
    card.type = 'button';
    card.setAttribute('aria-label', `${option.branchLabel}: ${option.title}`);

    const top = h('div', 'tactic-top');
    top.append(h('span', 'tactic-key', String(i + 1)));
    top.append(h('span', 'tactic-branch', option.branchLabel));
    if (option.recommended) {
      // Marked, never pre-selected: the whole point of the mode is that the
      // player decides, and a highlighted default is an answer.
      const star = h('span', 'tactic-pick', 'their pick');
      star.title = 'What this kill team would have done on its own';
      top.append(star);
    }
    card.append(top);

    card.append(h('div', 'tactic-title', option.title));

    if (option.chips?.length) {
      const chips = h('div', 'tactic-chips');
      for (const chip of option.chips) chips.append(h('span', 'tactic-chip', chip));
      card.append(chips);
    }

    const detail = h('ul', 'tactic-detail');
    for (const line of option.detail || []) detail.append(h('li', null, line));
    card.append(detail);

    card.addEventListener('click', () => this._choose(option.id));
    return card;
  }

  _choose(optionId) {
    const handler = this.onChoose;
    this.hide();
    handler?.(optionId);
  }

  _key(e) {
    if (!this.pending) return;
    // Escape does NOT dismiss this one: there is no battle to go back to until
    // the operative has its orders, and a closed dialog over a stopped clock
    // is a game that looks broken.
    //
    // Folded away, the number keys go quiet as well. The cards they refer to
    // are off screen, the player is reading the board, and a stray keypress
    // must not spend an operative's whole activation on an option nobody could
    // see. The pill is the only way back in.
    if (this.minimized) return;
    const index = Number(e.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < this.pending.options.length) {
      e.preventDefault();
      e.stopPropagation();
      this._choose(this.pending.options[index].id);
    }
  }
}
