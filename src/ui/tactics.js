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
 * and the engine is still stopped mid-activation until a card is picked. The
 * folding itself is `ui/foldaway.js`, shared with the result screen, which
 * covers the board at the other moment a player most wants to see it.
 */
import { Foldaway, peekButton } from './foldaway.js';

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
    this.fold = new Foldaway({
      overlay,
      // The dialog is whatever `root` was put inside, not "the overlay's first
      // child" — the pill is a child of the overlay too, and a folded prompt
      // must not end up marking the pill as the dialog.
      dialog: () => this.root.parentElement ?? null,
      caption: () => `${this.pending?.operativeName ?? 'this operative'} is waiting for orders`,
      restoreLabel: () => `Show the orders for ${this.pending?.operativeName ?? 'this operative'} again`,
    });
    this._onKey = (e) => this._key(e);
  }

  /** Folded away, with the activation still suspended underneath. */
  get minimized() { return this.fold.minimized; }

  /** The pill the fold leaves behind; null until the prompt has been folded. */
  get pill() { return this.fold.pill; }

  /** There is an unanswered activation. True while folded away, too. */
  get open() {
    return this.pending !== null;
  }

  /** Put a suspended activation in front of the player. */
  show(pending, { colors = {} } = {}) {
    this.pending = pending;
    this.accent = colors[pending.playerId] ?? null;
    this.fold.accent = this.accent;
    // A new operative is being asked about, so the fold from the last one does
    // not carry over: the player folded away a question that has been answered.
    this.fold.set(false);
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
    head.append(text, peekButton(() => this.minimize()));
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
    this.fold.set(false);
    this.overlay.hidden = true;
    this.root.replaceChildren();
    document.removeEventListener('keydown', this._onKey, true);
  }

  /** Fold the dialog down to its pill, leaving the battle underneath live. */
  minimize() {
    if (this.pending) this.fold.set(true);
  }

  /** Put the unanswered choice back in front of the player. */
  restore() {
    if (this.pending) this.fold.set(false);
  }

  toggleMinimized() {
    if (this.pending) this.fold.toggle();
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
