/**
 * The battlefield animation layer.
 *
 * Three things are worth asserting here and nothing else is:
 *
 *  1. CLASSIFICATION. A lasgun is a las and a heavy bolter firing Torrent is
 *     not a flamethrower. The manifest's pattern tables are what decided which
 *     sheets exist, so if src/ui/effect-map.js reads them differently from
 *     tools/make-effects.py, a sprite ships for a weapon that never asks for
 *     it and a weapon asks for a sprite that was never drawn. Both directions
 *     are checked against the whole bundled data set.
 *
 *  2. LAZINESS. 521KB of sprites ship; a battle must fetch only the families
 *     the two packs on the board can produce. That is invisible in the UI
 *     until someone loads the site on a phone, so it is counted here.
 *
 *  3. THAT IT IS ONLY DRAWING. The engine must not be able to see any of it
 *     (#1/#2). Playing a whole activation's worth of events through the layer
 *     must not touch state by so much as a byte.
 *
 * There is no browser in the test run and no jsdom in this project, so the DOM
 * is stubbed down to what effects.js actually touches — the same approach
 * portraits.test.mjs and setup-screen.test.mjs take.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, ROOT } from './harness.mjs';
import {
  weaponEffects, rangedFamily, aoeKind, ployFamily, tokenFamily,
  familiesForPack, familiesForPacks, normaliseName,
} from '../src/ui/effect-map.js';

const manifest = readJson('assets/effects/manifest.json');
const teamIds = fs.readdirSync(path.join(ROOT, 'data/teams'))
  .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const packs = teamIds.map((id) => readJson(`data/teams/${id}.json`));

/* ------------------------------------------------------------------ */
/* 1. Classification                                                   */
/* ------------------------------------------------------------------ */

test('a weapon name is normalised before it is matched', () => {
  // Several packs spell "hot-shot" with a non-breaking hyphen, which is why
  // no pattern may rely on the punctuation it was typed with.
  assert.equal(normaliseName('Hot‑shot long‑las (mobile)'), 'hot shot long las mobile');
  assert.equal(normaliseName('APM launcher (armour piercing)'), 'apm launcher armour piercing');
});

test('shot families are told apart by name', () => {
  const cases = {
    Lasgun: 'las', 'Hot-shot volley gun (focused)': 'las', 'Dark lance': 'las',
    'Plasma gun (standard)': 'plasma', 'Pulse carbine': 'plasma',
    Boltgun: 'bolt', 'Heavy bolt pistol': 'bolt',
    Autogun: 'solid', 'Shuriken catapult': 'solid', 'Sniper rifle (mobile)': 'solid',
    Meltagun: 'melta', 'Fusion pistol': 'melta',
    Doombolt: 'psychic', 'Infernal gaze': 'psychic',
    'Rokkit launcha': 'rocket', 'Frag grenade': 'rocket',
    Flamer: 'flame', 'Plague spewer': 'flame',
  };
  for (const [name, family] of Object.entries(cases)) {
    assert.equal(rangedFamily(manifest, name), family, name);
  }
});

test('a bolt weapon with "inferno" in its name is still a bolt weapon', () => {
  // The generator orders this pattern above the melta one on purpose: an
  // inferno PISTOL is a melta, an inferno BOLT pistol is not.
  assert.equal(rangedFamily(manifest, 'Inferno bolt pistol'), 'bolt');
  assert.equal(rangedFamily(manifest, 'Inferno pistol'), 'melta');
});

test('Torrent lays down a cone — of fire only when it is a flame weapon', () => {
  assert.equal(aoeKind(manifest, ['torrent2']), 'cone');
  assert.deepEqual(weaponEffects(manifest, { type: 'ranged', name: 'Flamer', rules: ['torrent2'] }),
    { projectile: null, aoe: 'flame', melee: null });
  // Torrent is also how this game writes "sweeping fire". A heavy bolter drawn
  // as a flamethrower would be the one mistake visible from across the room.
  assert.deepEqual(
    weaponEffects(manifest, { type: 'ranged', name: 'Heavy bolter (sweeping)', rules: ['torrent2'] }),
    { projectile: null, aoe: 'spray', melee: null });
});

test('Blast keeps its projectile and detonates at the end of it', () => {
  assert.deepEqual(
    weaponEffects(manifest, { type: 'ranged', name: 'Frag grenade', rules: ['blast2'] }),
    { projectile: 'rocket', aoe: 'blast', melee: null });
  // A numbered rule is matched on its name, not on the number it carries.
  assert.equal(aoeKind(manifest, ['blast1']), aoeKind(manifest, ['blast3']));
});

test('a flamer with no Torrent rule printed is still a flamer', () => {
  const spec = weaponEffects(manifest, { type: 'ranged', name: 'Burning censer', rules: [] });
  assert.equal(spec.aoe, 'flame');
  assert.equal(spec.projectile, null);
});

test('every melee weapon swings, whatever it is called', () => {
  assert.deepEqual(weaponEffects(manifest, { type: 'melee', name: 'Chainsword' }),
    { projectile: null, aoe: null, melee: 'strike' });
  assert.deepEqual(weaponEffects(manifest, { type: 'melee', name: 'Ankle Bite' }),
    { projectile: null, aoe: null, melee: 'strike' });
});

test('a ploy is classified by what its hooks do', () => {
  const family = (type) => ployFamily(manifest, { hooks: [{ effect: { type } }] });
  assert.equal(family('grantWeaponRule'), 'warcry');
  assert.equal(family('reduceDamage'), 'ward');
  assert.equal(family('freeAction'), 'comms');
  assert.equal(family('inflictDamage'), 'hex');
  assert.equal(family('healWounds'), 'mend');
  // An effect the manifest has no mark for animates as nothing, rather than
  // as the wrong thing (#7 in spirit: never silently guessed).
  assert.equal(family('somethingTheEngineGrewLater'), null);
  assert.equal(ployFamily(manifest, { hooks: [] }), null);
});

test('token loops are keyed to the token kinds the packs declare', () => {
  assert.equal(tokenFamily(manifest, { kind: 'blaze' }), 'blaze');
  assert.equal(tokenFamily(manifest, { kind: 'terrorchem' }), 'toxin');
  assert.equal(tokenFamily(manifest, { kind: 'not-a-token' }), null);
});

/* ------------------------------------------------------------------ */
/* Sheets and data agree in both directions                            */
/* ------------------------------------------------------------------ */

test('every family any bundled pack asks for has been drawn', () => {
  const missing = new Set();
  for (const pack of packs) {
    for (const family of familiesForPack(manifest, pack)) {
      if (!manifest.families[family]) missing.add(`${pack.id}: ${family}`);
    }
  }
  assert.deepEqual([...missing], [], 're-run tools/make-effects.py');
});

test('every sheet that ships is reachable from the bundled data', () => {
  // The other direction: a sprite on disk is evidence that something in
  // data/teams/ can fire it. A weapon rename that orphans a family should
  // fail here rather than ship 60KB nothing will ever request.
  const reachable = new Set();
  for (const pack of packs) {
    for (const family of familiesForPack(manifest, pack)) reachable.add(family);
  }
  const orphans = Object.keys(manifest.families).filter((f) => !reachable.has(f));
  assert.deepEqual(orphans, [], 'drawn but unreachable');
});

test('every declared sheet is actually on disk, at the size the manifest claims', () => {
  for (const [family, entry] of Object.entries(manifest.families)) {
    const file = path.join(ROOT, 'assets/effects', entry.sheet);
    assert.ok(fs.existsSync(file), `${family}: ${entry.sheet} missing`);
    assert.equal(fs.statSync(file).size, entry.bytes, family);
    assert.ok(Object.keys(entry.parts).length > 0, family);
    for (const part of Object.values(entry.parts)) {
      assert.ok(part.frames > 0 && part.ms > 0, family);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 2. Laziness                                                         */
/* ------------------------------------------------------------------ */

test('a match-up loads only the families its two packs can produce', () => {
  const kasrkin = readJson('data/teams/kasrkin.json');
  const wanted = familiesForPacks(manifest, { p1: kasrkin, p2: kasrkin });
  // Kasrkin have no psykers, no poison and no shield-shaped firefight ploy.
  for (const absent of ['psychic', 'toxin', 'blaze', 'shield']) {
    assert.ok(!wanted.has(absent), `should not load ${absent}`);
  }
  assert.ok(wanted.has('las') && wanted.has('plasma') && wanted.has('blast'));
  assert.ok(wanted.size < Object.keys(manifest.families).length,
    'a single team should never need every sheet');
});

test('no bundled match-up needs the whole sheet set, and none needs none of it', () => {
  let widest = 0;
  for (const pack of packs) {
    const families = familiesForPack(manifest, pack);
    assert.ok(families.size > 0, `${pack.id} animates nothing at all`);
    widest = Math.max(widest, families.size);
  }
  assert.ok(widest < Object.keys(manifest.families).length,
    'some team is somehow asking for every family that exists');
});

/* ------------------------------------------------------------------ */
/* 3. Playback, against a DOM small enough to read                     */
/* ------------------------------------------------------------------ */

class StubNode {
  constructor(tag) {
    this.tagName = String(tag);
    this.parent = null;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.listeners = {};
    this.removed = false;
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  // appendChild MOVES a node, as the real DOM does — the whole re-homing
  // trick in attach() depends on it.
  appendChild(n) {
    if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
    n.parent = this;
    this.children.push(n);
    n.removed = false;
    return n;
  }
  remove() {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
  all(tag) { return [...this.walk()].filter((n) => n.tagName === tag); }
}

/** Install just enough globals for ui/effects.js, run `fn`, tear them down. */
async function withDom(fn) {
  const requested = [];
  const saved = {};
  const globals = {
    document: { createElementNS: (_ns, tag) => new StubNode(tag) },
    Image: class { set src(v) { requested.push(v); } },
    fetch: (url) => {
      requested.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(manifest) });
    },
    // Frames are pumped by hand so a test is not at the mercy of a clock.
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    performance: { now: () => 0 },
  };
  for (const [k, v] of Object.entries(globals)) { saved[k] = globalThis[k]; globalThis[k] = v; }
  try {
    // A FRESH copy: the manifest cache in effects.js is module-level.
    const mod = await import(`../src/ui/effects.js?v=${Math.random()}`);
    return await fn(mod, requested);
  } finally {
    for (const [k] of Object.entries(globals)) globalThis[k] = saved[k];
  }
}

/** A layer with the real manifest already in place and nothing to fetch. */
function ready(mod, families) {
  const layer = new mod.EffectsLayer();
  layer.manifest = manifest;
  layer.allowed = new Set(families);
  layer.setTempo(450);
  return layer;
}

function board(layer) {
  const under = new StubNode('g');
  const over = new StubNode('g');
  layer.attach(under, over);
  return { under, over, sprites: () => [...under.walk(), ...over.walk()].filter((n) => n.tagName === 'image') };
}

/** Two operatives, ten inches apart, and nothing else. */
function twoUp() {
  return {
    teamPacks: { p1: {}, p2: {} },
    players: { p1: { ploys: {} }, p2: { ploys: {} } },
    operatives: {
      a: { id: 'a', playerId: 'p1', x: 5, y: 5, alive: true, placed: true, tokens: [] },
      b: { id: 'b', playerId: 'p2', x: 15, y: 5, alive: true, placed: true, tokens: [] },
    },
  };
}

const shot = (weapon, rules = []) => ([
  { type: 'ATTACK_ROLLED', attackerId: 'a', targetId: 'b', weapon, weaponRules: rules },
  { type: 'DAMAGE_APPLIED', amount: 3, source: { kind: 'shoot', attackerId: 'a' } },
]);

test('prepare() fetches the index once, then only the sheets in play', async () => {
  await withDom(async (mod, requested) => {
    const kasrkin = readJson('data/teams/kasrkin.json');
    const layer = new mod.EffectsLayer();
    const wanted = await layer.prepare({ p1: kasrkin, p2: kasrkin });

    assert.equal(requested.filter((u) => u.endsWith('manifest.json')).length, 1);
    const sheets = requested.filter((u) => u.endsWith('.webp'));
    assert.equal(sheets.length, wanted.size);
    assert.ok(sheets.length < Object.keys(manifest.families).length);
    // The families this pack cannot produce are never asked for.
    for (const absent of ['psychic', 'toxin', 'blaze', 'shield']) {
      assert.ok(!sheets.some((u) => u.endsWith(`/${absent}.webp`)), absent);
    }

    // A second battle with the same manifest does not fetch the index again.
    const before = requested.length;
    await layer.prepare({ p1: kasrkin, p2: kasrkin });
    assert.equal(requested.filter((u) => u.endsWith('manifest.json')).length, 1);
    assert.ok(requested.length > before, 'sheets are still warmed');
  });
});

test('a shot leaves a muzzle flash, something in flight, and an impact', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['las']);
    const state = twoUp();
    layer.handle(state, shot('Lasgun'));
    const { sprites } = board(layer);
    assert.equal(layer.live.length, 3);
    assert.deepEqual(layer.live.map((fx) => fx.part), ['muzzle', 'tracer', 'impact']);
    assert.ok(sprites().every((n) => n.attrs.href.endsWith('/las.webp')),
      'all three parts come off one sheet, so it is fetched once');
  });
});

test('a miss goes past the target and leaves no impact', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['las']);
    const events = [{ type: 'ATTACK_ROLLED', attackerId: 'a', targetId: 'b', weapon: 'Lasgun', weaponRules: [] }];
    layer.handle(twoUp(), events);
    assert.deepEqual(layer.live.map((fx) => fx.part), ['muzzle', 'tracer']);
    const tracer = layer.live[1];
    assert.notEqual(tracer.to.x, 15, 'a missed shot does not stop at the target');
  });
});

test('a Torrent weapon lays a cone from the shooter to the target instead of a shot', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['flame']);
    layer.handle(twoUp(), shot('Flamer', ['torrent2']));
    assert.deepEqual(layer.live.map((fx) => fx.part), ['cone']);
    const cone = layer.live[0];
    // Hinged on the shooter and stretched towards the target — but only so
    // far: an unclamped cone across a 30" board covers a quarter of it.
    assert.equal(cone.node.attrs.transform, 'translate(5 5) rotate(0)');
    assert.equal(Number(cone.view.attrs.width), 8);
  });
});

test('a cone at point-blank range is still big enough to see', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['flame']);
    const state = twoUp();
    state.operatives.b.x = 5.8;
    layer.handle(state, shot('Flamer', ['torrent2']));
    assert.ok(Number(layer.live[0].view.attrs.width) > 1);
  });
});

test('a Blast weapon detonates where it lands rather than leaving a bullet hole', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['rocket', 'blast']);
    layer.handle(twoUp(), shot('Frag grenade', ['blast2']));
    assert.deepEqual(layer.live.map((fx) => fx.family), ['rocket', 'rocket', 'blast']);
    assert.ok(layer.live[1].arc > 0, 'a lobbed shot rides a parabola');
  });
});

test('a fight where the defender hits back draws two strikes', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['strike', 'parry']);
    layer.handle(twoUp(), [
      { type: 'ATTACK_ROLLED', kind: 'fight', attackerId: 'a', targetId: 'b', weapon: 'Chainsword' },
      { type: 'DAMAGE_APPLIED', amount: 4, source: { kind: 'fight', attackerId: 'a' } },
      { type: 'DAMAGE_APPLIED', amount: 3, source: { kind: 'fight', attackerId: 'b' } },
    ]);
    assert.deepEqual(layer.live.map((fx) => fx.family), ['strike', 'strike']);
    // The counter-attack lands a beat after the blow it answers.
    assert.ok(layer.live[1].startAt > layer.live[0].startAt);
  });
});

test('a fight the attacker got nothing out of draws a block', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['strike', 'parry']);
    layer.handle(twoUp(), [
      { type: 'ATTACK_ROLLED', kind: 'fight', attackerId: 'a', targetId: 'b', weapon: 'Chainsword' },
    ]);
    assert.deepEqual(layer.live.map((fx) => fx.family), ['strike', 'parry']);
    // The block faces the operative it is blocking.
    assert.equal(layer.live[1].deg, 180);
  });
});

test('several attacks in one activation are staggered, not stacked', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['las']);
    const state = twoUp();
    layer.handle(state, [...shot('Lasgun'), ...shot('Lasgun'), ...shot('Lasgun')]);
    const muzzles = layer.live.filter((fx) => fx.part === 'muzzle').map((fx) => fx.startAt);
    assert.equal(muzzles.length, 3);
    assert.ok(muzzles[0] < muzzles[1] && muzzles[1] < muzzles[2]);
  });
});

test('a family this match-up did not load is never spawned', async () => {
  await withDom(async (mod) => {
    // The classifier says `psychic`; the allow-list says this battle has no
    // psykers in it. Nothing is drawn and, crucially, nothing is fetched.
    const layer = ready(mod, ['las']);
    layer.handle(twoUp(), shot('Doombolt'));
    assert.equal(layer.live.length, 0);
  });
});

test('a strategic ploy with no operative named sends the order round the team', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['warcry']);
    const state = twoUp();
    state.teamPacks.p1 = {
      strategicPloys: [{ id: 'push', name: 'PUSH', hooks: [{ effect: { type: 'grantWeaponRule' } }] }],
    };
    layer.handle(state, [{ type: 'PLOY_USED', playerId: 'p1', ployId: 'push', operativeId: null }]);
    assert.equal(layer.live.length, 1, 'p1 has one operative on the board');
    assert.equal(layer.live[0].family, 'warcry');
  });
});

test('Reduce motion draws nothing at all', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['las', 'blaze']);
    layer.setEnabled(false);
    const state = twoUp();
    state.operatives.a.tokens = [{ kind: 'blaze' }];
    layer.handle(state, shot('Lasgun'));
    layer.sync(state);
    assert.equal(layer.live.length, 0);
    assert.equal(layer.persistent.size, 0);
  });
});

test('instant playback turns the animations off rather than speeding them up', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['las']);
    layer.setTempo(0);
    assert.equal(layer.scale, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Persistent effects follow the state that caused them                */
/* ------------------------------------------------------------------ */

test('a Blaze token hangs a loop on its holder, and losing it takes the loop away', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['blaze']);
    const state = twoUp();
    state.operatives.a.tokens = [{ kind: 'blaze' }];
    layer.sync(state);
    assert.deepEqual([...layer.persistent.keys()], ['a:blaze']);

    const node = layer.persistent.get('a:blaze').node;
    state.operatives.a.x = 9;
    layer.sync(state);
    assert.equal(layer.persistent.get('a:blaze').node, node,
      'a loop that is still wanted keeps its node, and so keeps its phase');
    assert.equal(node.attrs.transform, 'translate(9 5)');

    state.operatives.a.tokens = [];
    layer.sync(state);
    assert.equal(layer.persistent.size, 0);
    assert.ok(node.removed);
  });
});

test('a defensive firefight ploy in force shows as a shield on the operative holding it', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['shield']);
    const state = twoUp();
    state.teamPacks.p1 = {
      firefightPloys: [{ id: 'brace', name: 'BRACE', hooks: [{ effect: { type: 'reduceDamage' } }] }],
    };
    state.players.p1.ploys = { firefight: [{ ployId: 'brace', operativeId: 'a' }] };
    layer.sync(state);
    assert.deepEqual([...layer.persistent.keys()], ['a:shield']);

    // "…during that activation": when the ploy lapses, so does the shield.
    state.players.p1.ploys.firefight = [];
    layer.sync(state);
    assert.equal(layer.persistent.size, 0);
  });
});

test('a strategic ploy in force auras the whole team, in team colour, under the figures', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['aura']);
    const state = twoUp();
    state.players.p1.ploys = { active: ['doctrine'] };
    layer.sync(state);
    assert.deepEqual([...layer.persistent.keys()], ['a:aura'], 'only the team that bought it');
    const fx = layer.persistent.get('a:aura');
    assert.equal(fx.node.attrs.filter, 'url(#fx-tint-p1)');
    assert.ok(fx.below, 'an aura belongs under the figure, not over its face');
  });
});

test('a dead operative carries nothing', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['blaze']);
    const state = twoUp();
    state.operatives.a.tokens = [{ kind: 'blaze' }];
    layer.sync(state);
    state.operatives.a.alive = false;
    layer.sync(state);
    assert.equal(layer.persistent.size, 0);
  });
});

test('the board cannot fill up with loops', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['aura', 'blaze']);
    const state = twoUp();
    for (let i = 0; i < 40; i++) {
      state.operatives[`x${i}`] = {
        id: `x${i}`, playerId: 'p1', x: i, y: 2, alive: true, placed: true, tokens: [],
      };
    }
    state.operatives.x0.tokens = [{ kind: 'blaze' }];
    state.players.p1.ploys = { active: ['doctrine'] };
    layer.sync(state);
    assert.ok(layer.persistent.size <= 24);
    // What is happening TO an operative outranks what its team bought, so the
    // cap sheds auras before it sheds a burning operative.
    assert.ok(layer.persistent.has('x0:blaze'));
  });
});

/* ------------------------------------------------------------------ */
/* It is drawing, and only drawing                                     */
/* ------------------------------------------------------------------ */

test('playing a whole activation through the layer does not touch state', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['las', 'strike', 'parry', 'blaze', 'aura']);
    const state = twoUp();
    state.operatives.a.tokens = [{ kind: 'blaze' }];
    state.players.p1.ploys = { active: ['doctrine'] };
    const before = JSON.stringify(state);

    layer.handle(state, [
      ...shot('Lasgun'),
      { type: 'ATTACK_ROLLED', kind: 'fight', attackerId: 'a', targetId: 'b', weapon: 'Chainsword' },
    ]);
    layer.sync(state);
    board(layer);
    layer.tick(0);
    layer.tick(400);

    assert.equal(JSON.stringify(state), before);
  });
});

test('the engine cannot reach the animation layer', () => {
  // #1: the engine never reads the DOM. An import from rules/ or ai/ into the
  // UI would be the first way that stops being true.
  for (const dir of ['src/rules', 'src/ai', 'src/replay', 'src/data']) {
    for (const file of fs.readdirSync(path.join(ROOT, dir))) {
      if (!file.endsWith('.js')) continue;
      const source = fs.readFileSync(path.join(ROOT, dir, file), 'utf8');
      assert.ok(!/from\s+['"][^'"]*ui\//.test(source), `${dir}/${file} imports the UI`);
    }
  }
});

test('a redraw re-homes live sprites without restarting them', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['las', 'blaze']);
    const state = twoUp();
    state.operatives.a.tokens = [{ kind: 'blaze' }];
    layer.handle(state, shot('Lasgun'));
    layer.sync(state);
    const first = board(layer);
    assert.ok(first.sprites().length >= 4);
    const node = layer.live[0].node;

    // ui/battlefield.js wipes the SVG on every render and hands over two new
    // groups; nothing may be recreated, or every shot would restart on every
    // action anyone took.
    const second = board(layer);
    assert.equal(layer.live[0].node, node);
    assert.equal(node.parent, second.over);
    assert.ok(second.sprites().length >= 4);
  });
});

test('a frame advance walks the sheet one cell at a time', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['las']);
    layer.handle(twoUp(), shot('Lasgun'));
    board(layer);
    const muzzle = layer.live[0];
    const cell = muzzle.cell;
    layer.tick(0);
    assert.equal(muzzle.view.attrs.viewBox, `0 0 ${cell} ${cell}`);
    layer.tick(muzzle.ms / muzzle.frames + 1);
    assert.equal(muzzle.view.attrs.viewBox, `${cell} 0 ${cell} ${cell}`);
    // Played once, then retired — a muzzle flash does not loop.
    layer.tick(muzzle.ms + 50);
    assert.ok(!layer.live.includes(muzzle));
  });
});

test('a loop never retires and never leaves its row of the sheet', async () => {
  await withDom(async (mod) => {
    const layer = ready(mod, ['blaze']);
    const state = twoUp();
    state.operatives.a.tokens = [{ kind: 'blaze' }];
    layer.sync(state);
    board(layer);
    const fx = layer.persistent.get('a:blaze');
    const row = fx.info.row * fx.cell;
    for (const now of [0, 500, 5000, 50000]) {
      layer.tick(now);
      assert.equal(fx.view.attrs.viewBox.split(' ')[1], String(row));
      assert.ok(Number(fx.view.attrs.viewBox.split(' ')[0]) < fx.cell * fx.frames);
    }
    assert.equal(layer.persistent.size, 1);
  });
});
