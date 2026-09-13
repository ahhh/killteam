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
import { DataRepository } from '../src/data/loader.js';
import { indexEntry } from '../tools/make-data-index.mjs';

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

/**
 * A real `DataRepository`, seeded off the disk instead of over `fetch`.
 *
 * This used to be a hand-rolled object with the four methods the screen
 * happened to call, which meant the screen could grow a fifth and the tests
 * would still pass until someone opened a browser. Using the real class costs
 * nothing here and makes the picker tests fail when the repository contract
 * moves under them.
 *
 * `lazy` seeds only the index, leaving the packs to be fetched on demand —
 * the state a player is actually in when the setup screen first paints.
 */
function stubRepo({ teams = [], lazy = false } = {}) {
  const repo = new DataRepository();
  for (const id of ['secure-and-hold', 'annihilation']) {
    repo.registerMission(readJson(`data/missions/${id}.json`));
  }
  for (const id of teams) {
    const pack = loadTeam(id);
    repo.teamIndex.set(id, indexEntry(pack));
    if (!lazy) repo.registerTeam(pack, { source: 'bundled' });
  }
  repo.factions = { factions: teams.length ? [{ name: 'Test', teams }] : [] };
  return repo;
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
    // …and who they are, which is the only thing on this panel the engine
    // never reads.
    assert.match(text, /Aspect Warrior/, 'shows the team lore under the blurb');
  });
});

/* --- Grand-alliance grouping in the picker ----------------------------- */
//
// A `<select>` has one level of grouping, so the alliance is a prefix on the
// optgroup label rather than a heading above it (see `_renderColumn`), which
// only reads as grouping if data/factions.json keeps an alliance's factions
// in one unbroken run. That is what this pins.

/* --- Bundled groups ---------------------------------------------------- */

test('a bundled group gets one heading in the picker, not one per faction', async () => {
  const catalogue = readJson('data/factions.json');
  const bundled = catalogue.bundledGroups ?? [];
  assert.deepEqual(bundled, ['Demo teams'],
    'the demo teams are the group this feature exists for');

  const demoFactions = catalogue.factions.filter((f) => f.group === 'Demo teams');
  assert.ok(demoFactions.length > 1,
    'bundling is only meaningful where a group holds several factions');
  const demoTeams = demoFactions.flatMap((f) => f.teams);

  await withStubDom(async () => {
    const repo = stubRepo({ teams: demoTeams });
    // The picker renders the WHOLE catalogue, so every pack it names has to be
    // loadable — not just the demo ones this test is about.
    repo.factions = catalogue;
    repo.catalogueTeamIds = () => catalogue.factions.flatMap((f) => f.teams);
    for (const f of catalogue.factions) {
      for (const id of f.teams) if (!repo.teams.has(id)) repo.teams.set(id, loadTeam(id));
    }
    const { screen } = makeScreen({ repo });
    await screen.render();

    const labels = [];
    for (const root of [screen.roots.p1]) {
      for (const node of root.walk()) {
        if (node.tagName === 'OPTGROUP') labels.push(node.label);
      }
    }
    const demoLabels = labels.filter((l) => l.startsWith('Demo teams'));
    assert.deepEqual(demoLabels, ['Demo teams'],
      `expected one bundled heading, got ${JSON.stringify(demoLabels)}`);

    // ...and every demo team is still reachable underneath it.
    const bundle = [...screen.roots.p1.walk()]
      .find((n) => n.tagName === 'OPTGROUP' && n.label === 'Demo teams');
    const values = bundle.children.map((o) => o.value).sort();
    assert.deepEqual(values, [...demoTeams].sort());

    // A real faction is still its own heading: "Orks" and "T'au Empire" are
    // the distinction a player is actually making.
    assert.ok(labels.some((l) => l === 'Xenos · Orks'),
      `real factions must stay separate, got ${JSON.stringify(labels)}`);
  });
});

test('the bundled catalogue groups every faction and lists the alliances together', () => {
  const catalogue = readJson('data/factions.json');
  const groups = catalogue.factions.map((f) => f.group);
  for (const [i, f] of catalogue.factions.entries()) {
    assert.ok(f.group, `faction "${f.id}" has no group`);
    assert.ok(catalogue.groups.includes(f.group),
      `faction "${f.id}" is in "${f.group}", which is not a declared group`);
    // Adjacency is the whole point: once an alliance has been left behind it
    // must not come round again further down the list.
    assert.equal(groups.indexOf(f.group) <= i && groups.lastIndexOf(f.group) >= i, true);
    assert.equal(groups.slice(groups.indexOf(f.group), groups.lastIndexOf(f.group) + 1)
      .every((g) => g === f.group), true, `"${f.group}" is split across the catalogue`);
  }
});

/* --- Lazy pack loading ------------------------------------------------- */
//
// The picker is built from `data/team-index.json` (10KB) and fetches a whole
// pack (1.9MB across the bundled teams) only for the team a player selected.
// These pin the half of that contract the screen owns: names come from the
// index, and a pack is fetched once, on selection.

test('the picker names every team with no pack loaded', async () => {
  const catalogue = readJson('data/factions.json');
  const ids = catalogue.factions.flatMap((f) => f.teams);

  await withStubDom(async () => {
    const repo = stubRepo({ teams: ids, lazy: true });
    repo.factions = catalogue;
    assert.equal(repo.teams.size, 0, 'no pack should be loaded yet');

    const { screen } = makeScreen({ repo });
    screen.setSelection(ids[0], ids[1]);
    await screen.render();

    const options = [];
    for (const node of screen.roots.p1.walk()) {
      if (node.tagName === 'OPTION') options.push(node.textContent);
    }
    assert.equal(options.length, ids.length, 'every catalogued team is offered');
    for (const name of options) {
      assert.ok(name && !/^[a-z0-9-]+$/.test(name),
        `"${name}" fell back to a raw id, so the index did not supply a name`);
    }
  });
});

test('selecting a team loads that pack and no others', async () => {
  const catalogue = readJson('data/factions.json');
  const ids = catalogue.factions.flatMap((f) => f.teams);

  await withStubDom(async () => {
    const repo = stubRepo({ teams: ids, lazy: true });
    repo.factions = catalogue;

    // Serve the pack off the disk, counting what the screen asks for.
    const fetched = [];
    repo.loadTeam = async (id) => {
      fetched.push(id);
      return repo.registerTeam(loadTeam(id), { source: 'bundled' });
    };

    const { screen } = makeScreen({ repo });
    screen.setSelection(ids[0], ids[1]);
    await screen.render();

    assert.deepEqual(fetched, [ids[0], ids[1]],
      'exactly the two selected packs, in column order');
    assert.equal(repo.teams.size, 2, `${ids.length - 2} packs should still be unfetched`);

    // …and the panel really did render from the pack, not the index.
    assert.match(screen.roots.p1.text, /Fights as|Command points/);
  });
});

test('a pack that fails to load says so instead of rendering a blank panel', async () => {
  await withStubDom(async () => {
    const repo = stubRepo({ teams: ['blades-of-khaine'], lazy: true });
    repo.loadTeam = async () => { throw new Error('Failed to load: 404 Not Found'); };

    const { screen } = makeScreen({ repo });
    screen.setSelection('blades-of-khaine', 'blades-of-khaine');
    await screen.render();

    const text = screen.roots.p1.text;
    assert.match(text, /Could not load/, 'the player is told the pack is missing');
    assert.match(text, /404/, 'and what went wrong');
  });
});
