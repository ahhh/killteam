/**
 * Semi-manual play: the mode that stops each activation and asks.
 *
 * Three things have to hold, and none of them shows up in any other test:
 *
 *  - the menu is a real choice — three options that do genuinely different
 *    things, named in the team's own vocabulary, priced against the AP the
 *    operative actually has;
 *  - suspending and resuming leaves the battle exactly as coherent as running
 *    it straight through, including the turn order and the kill tally;
 *  - a hand-played battle still reproduces, given the same seed AND the same
 *    answers — the choices are the other half of the inputs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattleState, EVENTS } from '../src/state.js';
import {
  step, runToCompletion, isAwaitingOrders, resolveTactic, AUTO_TACTIC,
} from '../src/rules/phases.js';
import { createControllers } from '../src/ai/controller.js';
import { BRANCHES, branchOf } from '../src/ai/options.js';
import { digestEvents } from '../src/replay/recorder.js';
import { TacticsPrompt } from '../src/ui/tactics.js';
import { loadTeam, loadMap, loadMission } from './harness.mjs';

const MATCHUPS = [
  ['kommandos', 'death-korps'],
  ['void-dancer-troupe', 'hierotek-circle'],
  ['blooded', 'phobos-strike-team'],
];

function battle({ p1 = 'kommandos', p2 = 'death-korps', seed = 'hive-1',
  mission = 'secure-and-hold', map = 'industrial-001' } = {}) {
  return createBattleState({
    seed,
    map: loadMap(map),
    mission: loadMission(mission),
    teams: { p1: loadTeam(p1), p2: loadTeam(p2) },
    engineVersion: 'test', aiVersion: 'test',
  });
}

/**
 * Play a whole battle, answering every prompt with `pick`.
 *
 * @param {(pending:object, n:number)=>string} pick returns the option id.
 */
function playByHand(state, controllers, pick, maxSteps = 800) {
  const asked = [];
  for (let i = 0; i < maxSteps && state.phase !== 'complete'; i++) {
    step(state, controllers);
    if (!isAwaitingOrders(state)) continue;
    asked.push(state.pending);
    resolveTactic(state, pick(state.pending, asked.length - 1), controllers);
  }
  return asked;
}

const manual = (side = 'p1') => createControllers({ [side]: { manual: true } });

/* ------------------------------------------------------------------ */
/* The menu                                                            */
/* ------------------------------------------------------------------ */

test('a semi-manual side is asked, and an automatic one never is', () => {
  const state = battle();
  const asked = playByHand(state, manual('p1'), (p) => p.options[0].id);

  assert.ok(asked.length > 5, `expected to be asked repeatedly, was asked ${asked.length} times`);
  assert.deepEqual([...new Set(asked.map((p) => p.playerId))], ['p1'],
    'only the semi-manual player should ever be asked for orders');
  assert.equal(state.phase, 'complete');
});

test('every prompt offers at least two genuinely different tactics', () => {
  for (const [p1, p2] of MATCHUPS) {
    const state = battle({ p1, p2 });
    const asked = playByHand(state, manual('p1'), (p) => p.options[0].id);
    assert.ok(asked.length, `${p1} was never asked anything`);

    for (const pending of asked) {
      assert.ok(pending.options.length >= 2 && pending.options.length <= 3,
        `${p1}/${pending.operativeName}: ${pending.options.length} options`);
      // Suspending for a menu of one is a delay, not a decision.
      const titles = new Set(pending.options.map((o) => o.title));
      assert.equal(titles.size, pending.options.length,
        `${p1}/${pending.operativeName}: two cards read identically — ${[...titles].join(' / ')}`);
    }
  }
});

test('the options come from different branches wherever the board allows it', () => {
  const state = battle();
  const asked = playByHand(state, manual('p1'), (p) => p.options[0].id);

  // Not every activation can offer three kinds of thing — an operative pinned
  // in a corridor with nothing in range genuinely cannot — but most can, and a
  // mode that never varies the shape of the choice is not offering one.
  const allDistinct = asked.filter(
    (p) => new Set(p.options.map((o) => o.branch)).size === p.options.length);
  assert.ok(allDistinct.length / asked.length > 0.8,
    `only ${allDistinct.length}/${asked.length} prompts had one branch per card`);

  const branches = new Set(asked.flatMap((p) => p.options.map((o) => o.branch)));
  assert.ok(branches.size >= 4,
    `a whole battle only ever offered ${[...branches].join(', ')}`);
  const known = new Set(BRANCHES.map((b) => b.id));
  for (const branch of branches) assert.ok(known.has(branch), `unknown branch "${branch}"`);
});

test('a card names the team’s own weapons and abilities, not generic actions', () => {
  const state = battle({ p1: 'kommandos' });
  const asked = playByHand(state, manual('p1'), (p) => p.options[0].id);
  const titles = asked.flatMap((p) => p.options.map((o) => o.title)).join('\n');

  // The point of the mode is agency over THIS kill team: if the menu reads
  // "Shoot" and "Move" it could be any team on the board.
  const pack = loadTeam('kommandos');
  const named = new Set();
  for (const profile of pack.operatives) {
    for (const weapon of profile.weapons || []) named.add(weapon.name);
    for (const ability of profile.abilities || []) if (ability.name) named.add(ability.name);
  }
  const hits = [...named].filter((n) => titles.includes(n));
  assert.ok(hits.length >= 3,
    `the whole battle's cards named ${hits.length} of this team's own things`);
});

test('a card is priced against the AP the operative actually has', () => {
  const state = battle();
  const asked = playByHand(state, manual('p1'), (p) => p.options[0].id);
  for (const pending of asked) {
    for (const option of pending.options) {
      const ap = option.chips.find((c) => c.endsWith(' AP'));
      assert.ok(ap, `${option.title} showed no AP cost`);
      const [used, total] = ap.replace(' AP', '').split('/').map(Number);
      assert.ok(used <= total, `${option.title} spends ${used} of ${total} AP`);
      assert.equal(total, pending.ap, 'the card is priced against a different budget');
    }
  }
});

test('branchOf reads the committal action, not the first one', () => {
  assert.equal(branchOf({ actions: [{ type: 'spend' }, { type: 'charge' }, { type: 'fight' }] }), 'melee');
  assert.equal(branchOf({ actions: [{ type: 'shoot' }] }), 'shoot');
  assert.equal(branchOf({ actions: [{ type: 'reposition' }, { type: 'shoot' }] }), 'move_shoot');
  assert.equal(branchOf({ actions: [{ type: 'shoot' }], estimate: { psychic: true } }), 'psychic');
  assert.equal(branchOf({ actions: [{ type: 'guard' }] }), 'reaction');
  assert.equal(branchOf({ actions: [{ type: 'spend' }] }), 'item');
  assert.equal(branchOf({ actions: [] }), 'hold');
  // A synthetic branch says what it is rather than being guessed at.
  assert.equal(branchOf({ branch: 'press', actions: [{ type: 'reposition' }] }), 'press');
});

/* ------------------------------------------------------------------ */
/* Suspending and resuming                                             */
/* ------------------------------------------------------------------ */

test('a suspended battle is plain, serializable state', () => {
  const state = battle();
  const controllers = manual('p1');
  while (!isAwaitingOrders(state) && state.phase !== 'complete') step(state, controllers);

  assert.ok(isAwaitingOrders(state));
  const round = JSON.parse(JSON.stringify(state.pending));
  assert.deepEqual(round, state.pending, 'the pending block must survive a round trip');
  assert.equal(round.kind, 'tactic');
  assert.ok(round.operativeName && round.teamName);
  assert.ok(round.options.every((o) => Array.isArray(o.actions)));
});

test('nothing steps past a suspended activation', () => {
  const state = battle();
  const controllers = manual('p1');
  while (!isAwaitingOrders(state)) step(state, controllers);

  const before = state.eventLog.length;
  for (let i = 0; i < 5; i++) {
    const result = step(state, controllers);
    assert.equal(result.kind, 'await-orders');
  }
  assert.equal(state.eventLog.length, before, 'stepping while suspended changed the battle');
  assert.ok(isAwaitingOrders(state));
});

test('the chosen option is what actually happens', () => {
  const state = battle();
  const controllers = manual('p1');
  while (!isAwaitingOrders(state)) step(state, controllers);

  // The last card, so this is never the plan the AI would have picked anyway.
  const picked = state.pending.options[state.pending.options.length - 1];
  const from = state.eventLog.length;
  resolveTactic(state, picked.id, controllers);

  const chosen = state.eventLog.slice(from).find((e) => e.type === EVENTS.TACTIC_CHOSEN);
  assert.ok(chosen, 'the choice was not recorded');
  assert.equal(chosen.optionId, picked.id);
  assert.equal(chosen.branch, picked.branch);
  assert.equal(state.tacticChoices.at(-1).optionId, picked.id);
});

test('the engine still refuses an illegal choice', () => {
  // The menu is a proposal like any other (#3). Handing the resolver an action
  // the rules forbid has to be rejected, not trusted because a human asked.
  const state = battle();
  const controllers = manual('p1');
  while (!isAwaitingOrders(state)) step(state, controllers);

  const pending = state.pending;
  const victim = Object.values(state.operatives).find((o) => o.playerId === 'p2');
  pending.options[0].actions = [
    // A Fight from across the board: legal in shape, impossible in fact.
    { type: 'fight', targetId: victim.id, weaponId: 'nope' },
  ];
  const from = state.eventLog.length;
  resolveTactic(state, pending.options[0].id, controllers);

  const rejected = state.eventLog.slice(from)
    .filter((e) => e.ruleId === 'illegal-action-rejected');
  assert.equal(rejected.length, 1, 'an impossible order should be rejected and logged');
  assert.equal(state.phase, 'firefight', 'and the battle should carry on regardless');
});

test('“let them decide” hands the activation back to the AI', () => {
  const state = battle();
  const controllers = manual('p1');
  while (!isAwaitingOrders(state)) step(state, controllers);

  const from = state.eventLog.length;
  resolveTactic(state, AUTO_TACTIC, controllers);
  const chosen = state.eventLog.slice(from).find((e) => e.type === EVENTS.TACTIC_CHOSEN);
  assert.equal(chosen.optionId, AUTO_TACTIC);
  assert.equal(chosen.branch, null);
  // The AI's own reasoning is what ran, so its plan is in the log.
  assert.ok(state.eventLog.slice(from).some((e) => e.type === EVENTS.AI_PLAN));
});

test('deferring every choice reproduces the battle the AI would have played', () => {
  // The sharpest check there is on the suspend/resume path: if stopping an
  // activation in the middle and picking it up again changed anything — the
  // turn order, the AP, the kill tally that feeds VP — these two would drift.
  for (const seed of ['hive-1', 'ash-2', 'drift-9']) {
    const auto = battle({ seed });
    runToCompletion(auto, createControllers());

    const hand = battle({ seed });
    playByHand(hand, manual('p1'), () => AUTO_TACTIC);

    assert.equal(hand.result.summary, auto.result.summary, `seed ${seed}`);
    assert.deepEqual(hand.result.victoryPoints, auto.result.victoryPoints,
      `seed ${seed}: kill credit drifted across the suspension`);
    assert.deepEqual(hand.result.survivors, auto.result.survivors, `seed ${seed}`);
  }
});

test('a hand-played battle finishes, scores and declares a winner', () => {
  for (const [p1, p2] of MATCHUPS) {
    for (const mission of ['secure-and-hold', 'annihilation']) {
      const state = battle({ p1, p2, mission });
      playByHand(state, manual('p1'), (p) => p.options.at(-1).id);
      assert.equal(state.phase, 'complete', `${p1} vs ${p2} (${mission}) never finished`);
      assert.ok(state.result?.summary, 'a finished battle must explain itself');
      assert.equal(state.pending, null, 'a finished battle is not waiting on anybody');
    }
  }
});

test('both sides can be played by hand at once', () => {
  const state = battle();
  const controllers = createControllers({ p1: { manual: true }, p2: { manual: true } });
  const asked = playByHand(state, controllers, (p) => p.options[0].id);
  assert.equal(state.phase, 'complete');
  assert.deepEqual([...new Set(asked.map((p) => p.playerId))].sort(), ['p1', 'p2']);
});

test('a batch run stops at the question rather than spinning on it', () => {
  // There is nobody to answer in a headless run, so `runToCompletion` has to
  // come back and say why instead of burning its step limit.
  const state = battle();
  runToCompletion(state, manual('p1'));
  assert.ok(isAwaitingOrders(state));
  assert.ok(state.warnings.some((w) => w.ruleId === 'awaiting-orders') ||
    state.eventLog.some((e) => e.ruleId === 'awaiting-orders'));
  assert.ok(!state.eventLog.some((e) => e.ruleId === 'step-limit'),
    'it should have returned, not run out of steps');
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

test('the same seed and the same answers reproduce the same battle', () => {
  const run = () => {
    const state = battle({ seed: 'ash-99' });
    // Answer by position, so the two runs make the same decisions without
    // sharing anything but the seed.
    playByHand(state, manual('p1'), (p, n) => p.options[n % p.options.length].id);
    return state;
  };
  const a = run();
  const b = run();
  assert.equal(digestEvents(a.eventLog), digestEvents(b.eventLog));
  assert.deepEqual(a.tacticChoices, b.tacticChoices);
  assert.equal(a.result.summary, b.result.summary);
});

test('different answers produce a different battle', () => {
  const run = (pick) => {
    const state = battle({ seed: 'ash-99' });
    playByHand(state, manual('p1'), pick);
    return digestEvents(state.eventLog);
  };
  assert.notEqual(run((p) => p.options[0].id), run((p) => p.options.at(-1).id),
    'the choices have to matter, or the mode is decoration');
});

test('putting a side under manual control changes nothing for an automatic battle', () => {
  // The flag must not leak into how the controller thinks. An all-automatic
  // battle has to be byte-identical whether or not the mode exists.
  const plain = battle({ seed: 'drift-4' });
  runToCompletion(plain, createControllers());
  const explicit = battle({ seed: 'drift-4' });
  runToCompletion(explicit, createControllers({ p1: { manual: false }, p2: { manual: false } }));
  assert.equal(digestEvents(plain.eventLog), digestEvents(explicit.eventLog));
});

/* ------------------------------------------------------------------ */
/* The prompt                                                          */
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
      contains: (c) => this.className.split(' ').includes(c),
    };
  }

  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  focus() { this.focused = true; }

  get firstElementChild() { return this.children[0] ?? null; }

  *walk() { yield this; for (const child of this.children) yield* child.walk(); }
  findAll(predicate) { return [...this.walk()].filter((n) => n !== this && predicate(n)); }
  get text() { return [...this.walk()].map((n) => n.textContent).filter(Boolean).join(' '); }
}

function withStubDom(fn) {
  const previousDoc = globalThis.document;
  const keys = [];
  globalThis.document = {
    createElement: (tag) => new StubNode(tag),
    addEventListener: (type, fn) => keys.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = keys.findIndex((k) => k.type === type && k.fn === fn);
      if (i >= 0) keys.splice(i, 1);
    },
  };
  try {
    return fn({ press: (key) => keys.forEach((k) => k.fn({ key, preventDefault() {}, stopPropagation() {} })) });
  } finally {
    globalThis.document = previousDoc;
  }
}

function livePending() {
  const state = battle();
  const controllers = manual('p1');
  while (!isAwaitingOrders(state)) step(state, controllers);
  return JSON.parse(JSON.stringify(state.pending));
}

test('the prompt renders one card per option, with its reasoning on it', () => {
  withStubDom(() => {
    const pending = livePending();
    const root = new StubNode('div');
    const overlay = new StubNode('div');
    overlay.hidden = true;
    const prompt = new TacticsPrompt({ root, overlay, onChoose: () => {} });
    prompt.show(pending);

    const cards = root.findAll((n) => n.classList.contains('tactic-card'));
    assert.equal(cards.length, pending.options.length);
    assert.equal(overlay.hidden, false);
    for (const option of pending.options) {
      assert.ok(root.text.includes(option.title), `card missing: ${option.title}`);
      assert.ok(root.text.includes(option.branchLabel), `pill missing: ${option.branchLabel}`);
    }
    // Who is being asked, and what it has to spend.
    assert.ok(root.text.includes(pending.operativeName));
    assert.ok(root.text.includes(String(pending.ap)));
  });
});

test('tapping a card reports that option and closes the prompt', () => {
  withStubDom(() => {
    const pending = livePending();
    const root = new StubNode('div');
    const overlay = new StubNode('div');
    const picked = [];
    const prompt = new TacticsPrompt({ root, overlay, onChoose: (id) => picked.push(id) });
    prompt.show(pending);

    const cards = root.findAll((n) => n.classList.contains('tactic-card'));
    cards[1].dispatch('click');
    assert.deepEqual(picked, [pending.options[1].id]);
    assert.equal(overlay.hidden, true);
    assert.equal(prompt.open, false);
  });
});

test('the number keys pick a card, and nothing else does', () => {
  withStubDom(({ press }) => {
    const pending = livePending();
    const root = new StubNode('div');
    const overlay = new StubNode('div');
    const picked = [];
    const prompt = new TacticsPrompt({ root, overlay, onChoose: (id) => picked.push(id) });

    prompt.show(pending);
    press('Escape');
    assert.equal(prompt.open, true, 'Escape must not dismiss an unanswered prompt');
    press('9');
    assert.deepEqual(picked, [], 'a key with no card behind it does nothing');
    press('1');
    assert.deepEqual(picked, [pending.options[0].id]);
    assert.equal(prompt.open, false);
  });
});

test('“let them decide” is always available', () => {
  withStubDom(() => {
    const pending = livePending();
    const root = new StubNode('div');
    const overlay = new StubNode('div');
    const picked = [];
    const prompt = new TacticsPrompt({ root, overlay, onChoose: (id) => picked.push(id) });
    prompt.show(pending);

    const auto = root.findAll((n) => n.classList.contains('tactics-auto'))[0];
    assert.ok(auto, 'there is no way out of a decision the player does not want to make');
    auto.dispatch('click');
    assert.deepEqual(picked, [AUTO_TACTIC]);
  });
});
