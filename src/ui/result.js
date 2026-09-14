/**
 * The end of the battle.
 *
 * Who won, on what, and the audit line that lets the whole thing be
 * reproduced. It renders `state.result`, which the rules layer built — nothing
 * here decides anything (#1, #2).
 *
 * It folds away. The moment the result appears is the moment a player most
 * wants to look at the board behind it: where everyone finished, who is left
 * standing, which markers were held when the clock ran out. A modal that
 * covers that and offers only "new battle" throws away the last thing worth
 * seeing. So the eye drops this to a pill, exactly as the orders prompt does
 * (`ui/foldaway.js`), and the pill puts it back — the battle is over either
 * way, so there is nothing to lose and nothing to resume except the reading.
 */
import { Foldaway, peekButton } from './foldaway.js';

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class ResultScreen {
  /**
   * @param {{root:HTMLElement, overlay:HTMLElement,
   *          isDeathmatch:(state:object)=>boolean,
   *          digest:(events:Array)=>string}} deps
   */
  constructor({ root, overlay, isDeathmatch, digest }) {
    this.root = root;
    this.overlay = overlay;
    this.isDeathmatch = isDeathmatch;
    this.digest = digest;
    this.state = null;
    this.fold = new Foldaway({
      overlay,
      dialog: () => this.root.parentElement ?? null,
      caption: () => this._headline(),
      restoreLabel: () => 'Show the result again',
    });
  }

  /** The result is on screen — folded down to its pill counts as on screen. */
  get open() {
    return this.overlay.hidden !== true;
  }

  get minimized() { return this.fold.minimized; }

  /** The pill the fold leaves behind; null until it has been folded once. */
  get pill() { return this.fold.pill; }

  /** Fold down to the pill so the final board can be read. */
  minimize() {
    if (this.open) this.fold.set(true);
  }

  restore() {
    if (this.open) this.fold.set(false);
  }

  toggleMinimized() {
    if (this.open) this.fold.toggle();
  }

  hide() {
    this.fold.set(false);
    this.overlay.hidden = true;
  }

  /** Who won, in the few words the pill has room for. */
  _headline() {
    const result = this.state?.result;
    if (!result) return 'Battle complete';
    return result.winner
      ? `${this.state.players[result.winner].teamName} wins`
      : 'Battle complete — draw';
  }

  /**
   * Render and show. Re-rendered from scratch each time rather than patched:
   * it is shown once per battle, and a half-updated scoreboard is worse than
   * a slow one.
   */
  show(state) {
    if (!state?.result) return;
    this.state = state;
    this.fold.set(false);
    this.root.replaceChildren();

    const deathmatch = this.isDeathmatch(state);
    this.root.append(this._head(state, deathmatch));
    this.root.append(h('p', null, state.result.summary));
    this.root.append(this._table(state, deathmatch));
    this.root.append(this._meta(state));
    const warnings = this._warnings(state);
    if (warnings) this.root.append(warnings);

    this.overlay.hidden = false;
  }

  _head(state, deathmatch) {
    const head = h('div', 'result-head');
    const text = h('div', 'result-headtext');
    const title = h('h2', null, 'Battle complete');
    title.id = 'resultTitle';
    text.append(title);
    text.append(h('div', 'winner', state.result.winner
      ? `${state.players[state.result.winner].teamName} wins`
      : 'Draw'));
    // A deathmatch is decided by who is left standing, not by VP, so the big
    // number is the survivor count — showing VP there would be misleading.
    text.append(h('div', 'score', deathmatch
      ? `${state.result.survivors.p1} – ${state.result.survivors.p2}`
      : `${state.result.victoryPoints.p1} – ${state.result.victoryPoints.p2}`));
    head.append(text, peekButton(
      () => this.minimize(), 'Hide this and look at the final battlefield'));
    return head;
  }

  _table(state, deathmatch) {
    const table = h('div', 'vp-table');
    const addRow = (label, a, b, cls = '') => {
      table.append(h('div', cls, label), h('div', cls, String(a)), h('div', cls, String(b)));
    };
    addRow('', state.players.p1.teamName, state.players.p2.teamName, 'hdr');
    const reasons = new Set([
      ...Object.keys(state.result.vpBreakdown.p1),
      ...Object.keys(state.result.vpBreakdown.p2),
    ]);
    for (const reason of reasons) {
      addRow(reason,
        state.result.vpBreakdown.p1[reason] ?? 0,
        state.result.vpBreakdown.p2[reason] ?? 0);
    }
    addRow('Survivors', state.result.survivors.p1, state.result.survivors.p2);
    if (deathmatch && state.result.woundsLeft) {
      addRow('Wounds left', state.result.woundsLeft.p1, state.result.woundsLeft.p2);
    }
    return table;
  }

  _meta(state) {
    return h('p', 'muted mono',
      `seed ${state.seed} · engine ${state.engineVersion} · AI ${state.aiVersion} · ` +
      `map ${state.map.id} · mission ${state.mission.id} · digest ${this.digest(state.eventLog)}`);
  }

  /** Rules the engine met and could not simulate, named rather than hidden (#7). */
  _warnings(state) {
    if (!state.warnings.length) return null;
    const notice = h('div', 'notice');
    notice.append(h('div', null, 'Unsupported rules encountered during this battle:'));
    const ul = h('ul');
    for (const w of state.warnings) {
      ul.append(h('li', null, `${w.ruleId} (×${w.count}) — ${w.detail}`));
    }
    notice.append(ul);
    return notice;
  }
}
