/**
 * The setup screen, driven against a hand-rolled DOM stub.
 *
 * There is no browser in the test run and no jsdom in this project, so the
 * stub implements only what `SetupScreen` actually touches. It is enough to
 * catch the things that would otherwise only break in front of a user: a
 * mission picker that renders nothing, or one that does not report the choice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SetupScreen } from '../src/ui/setup.js';
import { readJson, loadTeam } from './harness.mjs';

/* ------------------------------------------------------------------ */
/* A DOM small enough to read, large enough for this screen            */
/* ------------------------------------------------------------------ */

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.attributes = {};
    this.listeners = {};
    this.classList = {
      add: (c) => { this.className = `${this.className} ${c}`.trim(); },
      contains: (c) => this.className.split(' ').includes(c),
    };
  }

  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn({}); }

  /** Every node in the subtree, this one included. */
  *walk() {
    yield this;
    for (const child of this.children) yield* child.walk();
  }

  find(predicate) {
    for (const node of this.walk()) if (node !== this && predicate(node)) return node;
    return null;
  }

  findAll(predicate) {
    return [...this.walk()].filter((n) => n !== this && predicate(n));
  }

  get text() {
    return [...this.walk()].map((n) => n.textContent).filter(Boolean).join(' ');
  }

  /** `select.options` — the screen reads it to default the team choice. */
  get options() {
    return [...this.walk()].filter((n) => n.tagName === 'OPTION');
  }
}

function withStubDom(fn) {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new StubNode(tag) };
  const restore = () => { globalThis.document = previous; };
  try {
    const out = fn();
    // `render` is async, so the stub has to outlive the call that returns a
    // promise rather than being torn down the moment the body yields.
    return out instanceof Promise ? out.finally(restore) : (restore(), out);
  } catch (err) {
    restore();
    throw err;
  }
}

/** Just enough of DataRepository for the mission half of the screen. */
function stubRepo({ teams = [] } = {}) {
  const missions = new Map([
    ['secure-and-hold', readJson('data/missions/secure-and-hold.json')],
    ['annihilation', readJson('data/missions/annihilation.json')],
  ]);
  const packs = new Map(teams.map((id) => [id, loadTeam(id)]));
  return {
    missions,
    teams: packs,
    customTeams: new Set(),
    factions: { factions: teams.length ? [{ name: 'Test', teams }] : [] },
    catalogueTeamIds: () => teams,
    badgeFor: () => null,
  };
}

function makeScreen(overrides = {}) {
  const missionRoot = new StubNode('div');
  const screen = new SetupScreen({
    repo: stubRepo(),
    roots: { p1: new StubNode('div'), p2: new StubNode('div') },
    referenceRoot: null,
    importEls: {},
    missionRoot,
    missionIds: ['secure-and-hold', 'annihilation'],
    ...overrides,
  });
  return { screen, missionRoot };
}

/* ------------------------------------------------------------------ */

test('the setup screen offers every mission, named and described', () => {
  withStubDom(() => {
    const { screen, missionRoot } = makeScreen();
    screen.setMission('secure-and-hold');

    const options = missionRoot.findAll((n) => n.classList.contains('mission-option'));
    assert.equal(options.length, 2);
    assert.match(missionRoot.text, /Secure and Hold/);
    assert.match(missionRoot.text, /Annihilation/);
    // The blurb is what tells a player the two modes end differently.
    assert.match(missionRoot.text, /one kill team is the only one left standing/);
  });
});

test('exactly one mission is selected, and it is the one asked for', () => {
  withStubDom(() => {
    const { screen, missionRoot } = makeScreen();
    screen.setMission('annihilation');

    const selected = missionRoot.findAll((n) => n.classList.contains('selected'));
    assert.equal(selected.length, 1);
    assert.match(selected[0].text, /Annihilation/);
    assert.equal(screen.getMission(), 'annihilation');

    const checked = missionRoot.findAll((n) => n.tagName === 'INPUT' && n.checked);
    assert.equal(checked.length, 1);
    assert.equal(checked[0].value, 'annihilation');
  });
});

test('picking a mission reports the choice, so the toolbar can follow it', () => {
  withStubDom(() => {
    const seen = [];
    const { screen, missionRoot } = makeScreen({ onMissionChange: (id) => seen.push(id) });
    screen.setMission('secure-and-hold');

    const deathmatch = missionRoot.findAll(
      (n) => n.tagName === 'INPUT' && n.value === 'annihilation'
    )[0];
    deathmatch.checked = true;
    deathmatch.dispatch('change');

    assert.deepEqual(seen, ['annihilation']);
    assert.equal(screen.getMission(), 'annihilation');
    // …and the re-render moved the highlight with it.
    const selected = missionRoot.findAll((n) => n.classList.contains('selected'));
    assert.equal(selected.length, 1);
    assert.match(selected[0].text, /Annihilation/);
  });
});

test('an unknown mission id is ignored rather than blanking the picker', () => {
  withStubDom(() => {
    const { screen, missionRoot } = makeScreen();
    screen.setMission('secure-and-hold');
    screen.setMission('no-such-mission');

    assert.equal(screen.getMission(), 'secure-and-hold');
    assert.equal(missionRoot.findAll((n) => n.classList.contains('selected')).length, 1);
  });
});

/* --- What a team is, before you pick it -------------------------------- */

test('the team panel says how a team fights and what it spends CP on', async () => {
  await withStubDom(async () => {
    const roots = { p1: new StubNode('div'), p2: new StubNode('div') };
    const screen = new SetupScreen({
      repo: stubRepo({ teams: ['blades-of-khaine'] }),
      roots,
      referenceRoot: null,
      importEls: {},
      missionRoot: new StubNode('div'),
      missionIds: ['secure-and-hold'],
    });
    await screen.render();

    const text = roots.p1.text;
    // The two things a player cannot read off a roster: how it fights, and
    // what it does with the one resource both teams have.
    assert.match(text, /Aggressive/);
    assert.match(text, /Vanguard/);
    // …and the moves this engine will actually play for them.
    assert.match(text, /BLADEWIND/, 'names the firefight ploys it can use');
    assert.match(text, /FOREWARNED/, 'names the strategic ploys it can use');
    assert.match(text, /CONTEMPT/, 'names the reaction it holds CP for');
    assert.match(text, /not simulated/, 'and is honest about the rest');
  });
});
