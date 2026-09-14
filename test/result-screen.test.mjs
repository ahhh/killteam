/**
 * The end of the battle, and the two things a player wants from it.
 *
 * It has to say who won and on what — the scoreboard is the only place the VP
 * breakdown and the reproducibility line ever appear. And it has to get out of
 * the way: the board behind it is the last state of the battle, and until the
 * result folded there was no way to look at it that did not throw the
 * scoreboard away for good.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattleState } from '../src/state.js';
import { runToCompletion, isLastTeamStanding } from '../src/rules/phases.js';
import { createControllers } from '../src/ai/controller.js';
import { digestEvents } from '../src/replay/recorder.js';
import { ResultScreen } from '../src/ui/result.js';
import { loadTeam, loadMap, loadMission } from './harness.mjs';

/* ------------------------------------------------------------------ */
/* A DOM small enough to assert against                                */
/* ------------------------------------------------------------------ */

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.style = {};
    this.classList = {
      add: (c) => { this.className = `${this.className} ${c}`.trim(); },
      remove: (c) => {
        this.className = this.className.split(' ').filter((x) => x && x !== c).join(' ');
      },
      contains: (c) => this.className.split(' ').includes(c),
    };
  }

  append(...nodes) {
    this.children.push(...nodes);
    for (const node of nodes) node.parentElement = this;
  }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  focus() { this.focused = true; }

  *walk() { yield this; for (const child of this.children) yield* child.walk(); }
  findAll(p) { return [...this.walk()].filter((n) => n !== this && p(n)); }
  get text() { return [...this.walk()].map((n) => n.textContent).filter(Boolean).join(' '); }
}

function withStubDom(fn) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new StubNode(tag),
    createElementNS: (_ns, tag) => new StubNode(tag),
  };
  try {
    return fn();
  } finally {
    globalThis.document = previous;
  }
}

function finished({ mission = 'secure-and-hold' } = {}) {
  const state = createBattleState({
    seed: 'result-1',
    map: loadMap('industrial-001'),
    mission: loadMission(mission),
    teams: { p1: loadTeam('kommandos'), p2: loadTeam('death-korps') },
    engineVersion: 'test', aiVersion: 'test',
  });
  runToCompletion(state, createControllers());
  return state;
}

/** A result screen on a stub overlay, plus the handles the fold tests need. */
function mounted(state) {
  const root = new StubNode('div');
  const overlay = new StubNode('div');
  overlay.hidden = true;
  const dialog = new StubNode('div');
  dialog.append(root);
  overlay.append(dialog);
  const screen = new ResultScreen({
    root, overlay, isDeathmatch: isLastTeamStanding, digest: digestEvents,
  });
  screen.show(state);
  return {
    root, overlay, screen,
    eye: () => root.findAll((n) => n.classList.contains('fold-peek'))[0],
    pill: () => overlay.findAll((n) => n.classList.contains('fold-pill'))[0],
  };
}

/* ------------------------------------------------------------------ */

test('the scoreboard names the winner, the score and the way back to it', () => {
  withStubDom(() => {
    const state = finished();
    const { root, overlay, screen } = mounted(state);

    assert.equal(overlay.hidden, false);
    assert.equal(screen.open, true);
    const text = root.text;
    assert.match(text, /Battle complete/);
    if (state.result.winner) {
      assert.ok(text.includes(state.players[state.result.winner].teamName),
        'the winning team is not named on its own scoreboard');
    } else {
      assert.match(text, /Draw/);
    }
    // The audit line: a result nobody can reproduce is an anecdote.
    assert.ok(text.includes(state.seed));
    assert.ok(text.includes(digestEvents(state.eventLog)));
  });
});

test('every reason a team scored is broken out, for both sides', () => {
  withStubDom(() => {
    const state = finished();
    const { root } = mounted(state);
    const text = root.text;
    assert.ok(text.includes(state.players.p1.teamName));
    assert.ok(text.includes(state.players.p2.teamName));
    for (const reason of Object.keys(state.result.vpBreakdown.p1)) {
      assert.ok(text.includes(reason), `the scoreboard hides "${reason}"`);
    }
    assert.match(text, /Survivors/);
  });
});

test('a deathmatch is scored on who is left standing, not on VP', () => {
  withStubDom(() => {
    const state = finished({ mission: 'annihilation' });
    const { root } = mounted(state);
    assert.ok(root.text.includes(
      `${state.result.survivors.p1} – ${state.result.survivors.p2}`),
      'the big number is victory points in a mission that awards none');
  });
});

test('the eye folds the scoreboard away and leaves the final board readable', () => {
  withStubDom(() => {
    const { overlay, screen, eye, pill } = mounted(finished());

    assert.ok(eye(), 'the scoreboard has no way to get at the board behind it');
    assert.equal(pill(), undefined, 'the pill is only there once it is folded');

    eye().dispatch('click');
    assert.equal(screen.minimized, true);
    // Still mounted, so nothing has to be rebuilt to come back — it just stops
    // being a wall between the player and the last state of the battle.
    assert.equal(overlay.hidden, false);
    assert.ok(overlay.classList.contains('minimized'));
    assert.equal(overlay.children[0].attributes['aria-modal'], 'false');
  });
});

test('the pill says who won, and puts the scoreboard back', () => {
  withStubDom(() => {
    const state = finished();
    const { overlay, screen, eye, pill } = mounted(state);
    eye().dispatch('click');

    assert.ok(pill(), 'nothing was left on screen to fold it back open with');
    const expected = state.result.winner
      ? state.players[state.result.winner].teamName : 'draw';
    assert.ok(pill().text.includes(expected), 'the pill does not say how it ended');

    pill().dispatch('click');
    assert.equal(screen.minimized, false);
    assert.ok(!overlay.classList.contains('minimized'));
    assert.equal(pill().hidden, true, 'the pill outstayed the fold');
    assert.equal(overlay.children[0].attributes['aria-modal'], 'true');
  });
});

test('a new battle’s scoreboard opens face up, however the last one was left', () => {
  withStubDom(() => {
    const { screen, eye } = mounted(finished());
    eye().dispatch('click');
    assert.equal(screen.minimized, true);

    screen.show(finished({ mission: 'annihilation' }));
    assert.equal(screen.minimized, false);
    assert.equal(screen.pill.hidden, true);
  });
});

test('closing it is closing it: hidden, and unfolded for next time', () => {
  withStubDom(() => {
    const { overlay, screen, eye } = mounted(finished());
    eye().dispatch('click');
    screen.hide();
    assert.equal(overlay.hidden, true);
    assert.equal(screen.open, false);
    assert.equal(screen.minimized, false);
  });
});

test('folding is a no-op before there is a result to fold', () => {
  withStubDom(() => {
    const root = new StubNode('div');
    const overlay = new StubNode('div');
    overlay.hidden = true;
    const screen = new ResultScreen({
      root, overlay, isDeathmatch: () => false, digest: () => 'x',
    });
    screen.minimize();
    screen.toggleMinimized();
    assert.equal(screen.minimized, false);
    assert.equal(screen.pill, null);
    // And a state with no result is not rendered at all rather than half.
    screen.show({});
    assert.equal(overlay.hidden, true);
  });
});
