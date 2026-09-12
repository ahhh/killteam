/**
 * Developer killzone audit.
 *
 *   node test/killzone.mjs [games] [melee] [guns]
 *   node test/killzone.mjs [games] [melee] [guns] --pool[=gamesPerPairing]
 *   node test/killzone.mjs --map=<id>          # one killzone, not all of them
 *
 * A map's effect on the melee/shooting balance is geometric, so this measures
 * the geometry directly and then checks it against play:
 *
 *   - how much of the board can see how much of the board, and how far;
 *   - whether one drop zone can be shot at from the other at all;
 *   - and, for one melee team against one gunline, how long the approach
 *     takes, how many survive it, and how much fighting it buys.
 *
 * `--pool` adds the measure the README's melee section is built on: a 16-team
 * round robin per map, correlating each team's melee share against its win
 * rate. It is the slow one — a few minutes a map — so it is opt-in.
 *
 * It is the harness behind the killzone table in the README. Like every batch
 * number in this project it measures THIS engine and THIS AI, not the game.
 */
import fs from 'node:fs';
import { readJson, loadTeam, loadMap, loadMission, ROOT } from './harness.mjs';
import { createBattleState, EVENTS, PHASES, liveOperatives, allOperatives } from '../src/state.js';
import { step, runToCompletion } from '../src/rules/phases.js';
import { createControllers, AI_VERSION } from '../src/ai/controller.js';
import { ENGINE_VERSION } from '../src/rules/engine.js';
import { traceSight } from '../src/rules/visibility.js';
import { isPassable } from '../src/rules/terrain.js';
import { circleIntersectsPolygon, pointInPolygon, baseDistance, dist } from '../src/maps/geometry.js';

const args = process.argv.slice(2);
const poolFlag = args.find((a) => a.startsWith('--pool'));
const positional = args.filter((a) => !a.startsWith('--'));
const games = Number(positional[0] ?? 16);
const meleeId = positional[1] ?? 'goremonger';
const gunId = positional[2] ?? 'pathfinders';
/** Three games a pairing over sixteen teams is 90 battles per team. */
const poolGames = poolFlag ? Number(poolFlag.split('=')[1] ?? 3) : 0;

/**
 * A spread of rosters from all-melee to all-gun. Sixteen is enough for the
 * correlation to mean something and few enough to finish in minutes.
 */
const POOL = [
  'goremonger', 'chaos-cult', 'void-dancer-troupe', 'raveners', 'blades-of-khaine',
  'wrecka-krew', 'legionary', 'kommandos', 'novitiates', 'death-korps',
  'pathfinders', 'skycaste-marksmen', 'kasrkin', 'ratlings', 'hearthkyn-salvager',
  'vanguard-wardens',
];

const mapFlag = args.find((a) => a.startsWith('--map='))?.split('=')[1];
const MAP_IDS = fs.readdirSync(`${ROOT}/data/maps`)
  .map((f) => f.replace('.json', ''))
  .filter((id) => !mapFlag || id === mapFlag)
  .sort();
if (!MAP_IDS.length) throw new Error(`no bundled map matches "${mapFlag}"`);
const mission = loadMission('secure-and-hold');
const melee = loadTeam(meleeId);
const gun = loadTeam(gunId);

/** A 1.25" base is the common case; the audit is about lanes, not big models. */
const PROBE_BASE = 1.25;

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** Every place on a 1" lattice where a probe base could legally stand. */
function standingSpots(map, step = 1) {
  const r = PROBE_BASE / 2;
  const blocking = (map.terrain || []).filter((p) => !isPassable(p));
  const spots = [];
  for (let y = r; y <= map.board.height - r; y += step) {
    for (let x = r; x <= map.board.width - r; x += step) {
      if (blocking.some((p) => circleIntersectsPolygon(x, y, r, p.shape.points))) continue;
      spots.push({ x, y, baseDiameter: PROBE_BASE });
    }
  }
  return spots;
}

function sightProfile(map) {
  const spots = standingSpots(map);
  const lengths = [];
  let pairs = 0;

  // Every third pair: the lattice is ~500 positions and the shape of the
  // distribution is what matters, not the third decimal place.
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j += 3) {
      const d = dist(spots[i].x, spots[i].y, spots[j].x, spots[j].y);
      if (d < 2) continue;
      pairs++;
      if (traceSight(spots[i], spots[j], map.terrain, [], { samples: 2 }).visible) lengths.push(d);
    }
  }
  lengths.sort((a, b) => a - b);

  const inZone = (z) => spots.filter((s) => pointInPolygon(s.x, s.y, z.shape.points));
  const [a, b] = map.deploymentZones.map(inZone);
  let exposed = 0;
  let closest = Infinity;
  for (const p of a) {
    for (const q of b) {
      closest = Math.min(closest, dist(p.x, p.y, q.x, q.y));
      if (traceSight(p, q, map.terrain, [], { samples: 2 }).visible) exposed++;
    }
  }

  return {
    visible: lengths.length / pairs,
    median: lengths[Math.floor(lengths.length / 2)] ?? 0,
    long: lengths.filter((l) => l > 12).length / pairs,
    dropZoneExposure: exposed / (a.length * b.length),
    dropZoneGap: closest,
  };
}

/* ------------------------------------------------------------------ */
/* Play                                                                */
/* ------------------------------------------------------------------ */

function playProfile(map) {
  const tally = {
    battles: 0, wins: 0, fight: 0, shoot: 0, survivors: 0,
    contact: [], gap: [0, 0, 0, 0], alive: [0, 0, 0, 0], seen: [0, 0, 0, 0],
  };

  for (let i = 0; i < games; i++) {
    for (const seat of ['p1', 'p2']) {
      const foe = seat === 'p1' ? 'p2' : 'p1';
      const state = createBattleState({
        seed: `killzone-${map.id}-${i}`, map, mission,
        teams: { [seat]: melee, [foe]: gun },
        engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
      });
      const controllers = createControllers();

      // Stepped rather than run to completion, so the state can be read at the
      // end of each turning point — the approach is the thing being measured.
      let turningPoint = 0;
      for (let guard = 0; guard < 4000 && state.phase !== PHASES.COMPLETE; guard++) {
        step(state, controllers);
        if (state.turningPoint !== turningPoint) {
          snapshot(state, seat, foe, turningPoint, tally);
          turningPoint = state.turningPoint;
        }
      }
      snapshot(state, seat, foe, turningPoint, tally);

      tally.battles++;
      if (state.result.winner === seat) tally.wins++;
      tally.survivors += state.result.survivors[seat];

      const ours = new Set(allOperatives(state).filter((o) => o.playerId === seat).map((o) => o.id));
      let first = null;
      for (const e of state.eventLog) {
        if (e.type !== EVENTS.ATTACK_ROLLED) continue;
        if (e.kind === 'fight' && ours.has(e.attackerId)) {
          tally.fight++;
          if (first === null) first = e.turningPoint;
        } else if (e.kind !== 'fight' && !ours.has(e.attackerId)) {
          tally.shoot++;
        }
      }
      if (first !== null) tally.contact.push(first);
    }
  }
  return tally;
}

/** Closest the two teams stand, and how many of the melee team are left. */
function snapshot(state, seat, foe, turningPoint, tally) {
  if (turningPoint < 1 || turningPoint > 4) return;
  const mine = liveOperatives(state).filter((o) => o.playerId === seat);
  const theirs = liveOperatives(state).filter((o) => o.playerId === foe);
  if (!mine.length || !theirs.length) return;
  let closest = Infinity;
  for (const a of mine) for (const b of theirs) closest = Math.min(closest, baseDistance(a, b));
  tally.gap[turningPoint - 1] += closest;
  tally.alive[turningPoint - 1] += mine.length;
  tally.seen[turningPoint - 1]++;
}

/* ------------------------------------------------------------------ */

const pct = (v) => `${(v * 100).toFixed(1)}%`.padStart(7);
const pad = (s, n) => String(s).padEnd(n);

console.log(`Geometry — what can be shot at, from where\n`);
console.log(pad('map', 22), 'sight lines  median  over 12"  drop zone to drop zone   nearest');
const geometry = new Map();
for (const id of MAP_IDS) {
  const g = sightProfile(loadMap(id));
  geometry.set(id, g);
  console.log(pad(id, 22), pct(g.visible), `${g.median.toFixed(1)}"`.padStart(9),
    pct(g.long), pct(g.dropZoneExposure).padStart(20), `${g.dropZoneGap.toFixed(1)}"`.padStart(10));
}

console.log(`\n${meleeId} against ${gunId} — ${games} seeds in both seats\n`);
console.log(pad('map', 22), 'fight/game  shoot/game  first contact  survivors  win rate');
const play = new Map();
for (const id of MAP_IDS) {
  const t = playProfile(loadMap(id));
  play.set(id, t);
  const contact = t.contact.length
    ? `TP${(t.contact.reduce((a, b) => a + b, 0) / t.contact.length).toFixed(1)} ` +
      `(${t.contact.length}/${t.battles})`
    : 'never';
  console.log(pad(id, 22),
    (t.fight / t.battles).toFixed(2).padStart(10),
    (t.shoot / t.battles).toFixed(1).padStart(12),
    contact.padStart(14),
    (t.survivors / t.battles).toFixed(2).padStart(10),
    pct(t.wins / t.battles));
}

console.log('\nThe approach, turning point by turning point (closest pair / warband alive)\n');
console.log(pad('map', 22), ['TP1', 'TP2', 'TP3', 'TP4'].map((s) => pad(s, 15)).join(''));
for (const id of MAP_IDS) {
  const t = play.get(id);
  const cell = (i) => pad(t.seen[i]
    ? `${(t.gap[i] / t.seen[i]).toFixed(1)}" / ${(t.alive[i] / t.seen[i]).toFixed(1)}`
    : '—', 15);
  console.log(pad(id, 22), [0, 1, 2, 3].map(cell).join(''));
}

/* ------------------------------------------------------------------ */
/* The pool                                                            */
/* ------------------------------------------------------------------ */

if (poolGames) {
  console.log(`\nRound robin — ${POOL.length} teams, ` +
    `${poolGames * (POOL.length - 1) * 2} battles per team per map\n`);
  console.log(pad('map', 22), 'melee share vs win rate   melee half   shooting half');

  const packs = new Map(POOL.map((id) => [id, loadTeam(id)]));
  const shares = new Map(POOL.map((id) => [id, meleeShare(packs.get(id))]));
  const ranked = [...POOL].sort((a, b) => shares.get(b) - shares.get(a));
  const meleeHalf = new Set(ranked.slice(0, POOL.length / 2));

  for (const id of MAP_IDS) {
    const map = loadMap(id);
    const wins = new Map(POOL.map((t) => [t, 0]));
    const played = new Map(POOL.map((t) => [t, 0]));

    // Both orderings of every pairing, so the seats cancel out.
    for (const a of POOL) {
      for (const b of POOL) {
        if (a === b) continue;
        for (let g = 0; g < poolGames; g++) {
          const state = createBattleState({
            seed: `pool-${id}-${a}-${b}-${g}`, map, mission,
            teams: { p1: packs.get(a), p2: packs.get(b) },
            engineVersion: ENGINE_VERSION, aiVersion: AI_VERSION,
          });
          runToCompletion(state, createControllers());
          played.set(a, played.get(a) + 1);
          played.set(b, played.get(b) + 1);
          if (state.result.winner === 'p1') wins.set(a, wins.get(a) + 1);
          else if (state.result.winner === 'p2') wins.set(b, wins.get(b) + 1);
          else { wins.set(a, wins.get(a) + 0.5); wins.set(b, wins.get(b) + 0.5); }
        }
      }
    }

    const rate = (t) => wins.get(t) / played.get(t);
    const mean = (ids) => ids.reduce((s, t) => s + rate(t), 0) / ids.length;
    const corr = pearson(POOL.map((t) => shares.get(t)), POOL.map(rate));
    console.log(pad(id, 22),
      (corr >= 0 ? `+${corr.toFixed(3)}` : corr.toFixed(3)).padStart(21),
      pct(mean([...meleeHalf])).padStart(13),
      pct(mean(POOL.filter((t) => !meleeHalf.has(t)))).padStart(15));
  }
}

/**
 * Melee share: the fraction of a roster's expected damage output carried by
 * melee weapons. Expectation only — no dice, so it is a property of the pack.
 */
function meleeShare(pack) {
  let melee = 0;
  let total = 0;
  for (const op of pack.operatives) {
    for (const w of op.weapons || []) {
      const expected = w.atk * ((7 - w.hit) / 6) *
        ((w.damage.normal + w.damage.critical) / 2);
      total += expected;
      if (w.type === 'melee') melee += expected;
    }
  }
  return total ? melee / total : 0;
}

function pearson(xs, ys) {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let top = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    top += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return top / Math.sqrt(dx * dy);
}
