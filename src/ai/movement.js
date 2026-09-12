/**
 * Candidate destination generation.
 *
 * The board is continuous, so we never search every point (see the
 * performance targets): we propose a small set of *interesting* positions —
 * objectives, cover, firing angles, closing moves — and let the engine
 * validate each one.
 */
import { dist, polygonCentroid, stepToward } from '../maps/geometry.js';
import { planMove, nearestLegalPosition, isPositionLegal } from '../rules/movement.js';
import { liveOperatives } from '../state.js';
import { isCover } from '../rules/terrain.js';
import { withinControlRange } from '../rules/visibility.js';

const MAX_CANDIDATES = 26;
const SNAP = 0.5;

function key(p) {
  return `${Math.round(p.x / SNAP)}:${Math.round(p.y / SNAP)}`;
}

/**
 * @returns {{x,y,path,length}[]} legal destinations reachable within `allowance`.
 *
 * Candidates are proposed in PRIORITY ORDER, because the list is capped and
 * the cap is reached: rings are thirty positions on their own, against a
 * budget of twenty-six. They used to be proposed first, so on a typical board
 * twenty-one of the twenty-six slots went to undifferentiated ring positions
 * and the objective, closing and cover candidates were cut off before they
 * were ever costed. An operative that needed to close simply had no closing
 * move on its list of options: advancing was not judged to be a bad idea, it
 * was never among the things the AI got to judge.
 *
 * Fixing it did NOT fix this engine's bias against close combat — that
 * survived all of it, and the README says where it actually comes from — but
 * a search that discards its best candidates before scoring them is wrong
 * regardless of what the scoreboard says.
 *
 * So the purposeful destinations go in first — the ones that exist because
 * something on the board is worth walking to — and the rings fill whatever
 * budget is left over as the general-purpose fallback they were meant to be.
 */
export function generateDestinations(state, op, allowance,
  { towardEnemies = true, alsoToward = [] } = {}) {
  const raw = [];
  const enemies = liveOperatives(state).filter((o) => o.playerId !== op.playerId);

  // Straight at each objective marker.
  for (const objective of state.objectives) {
    raw.push({ ...stepToward(op, objective, allowance), tag: `obj:${objective.id}` });
  }

  // Somewhere the caller has its own reason to want to stand: the wounded
  // friend a Medikit has to reach, which is nothing like an objective and
  // nothing like an enemy, and so had no candidate on this list at all.
  for (const point of alsoToward) {
    raw.push({ ...stepToward(op, point, allowance), tag: `toward:${point.id ?? 'point'}` });
  }

  // Closing moves toward each enemy (charges and firing lanes).
  if (towardEnemies) {
    for (const enemy of enemies) {
      raw.push({ ...stepToward(op, enemy, allowance), tag: `close:${enemy.id}` });
      // Stop just short — useful for staying out of control range.
      const d = dist(op.x, op.y, enemy.x, enemy.y);
      if (d > 2) {
        raw.push({ ...stepToward(op, enemy, Math.min(allowance, d - 2)), tag: `near:${enemy.id}` });
      }
    }
  }

  // Positions tucked against cover, on the side away from the enemy centre.
  const enemyCentre = enemies.length
    ? {
        x: enemies.reduce((s, e) => s + e.x, 0) / enemies.length,
        y: enemies.reduce((s, e) => s + e.y, 0) / enemies.length,
      }
    : null;
  if (enemyCentre) {
    for (const piece of (state.map.terrain || []).filter(isCover)) {
      const c = polygonCentroid(piece.shape.points);
      const dx = c.x - enemyCentre.x;
      const dy = c.y - enemyCentre.y;
      const len = Math.hypot(dx, dy) || 1;
      const spot = { x: c.x + (dx / len) * 1.3, y: c.y + (dy / len) * 1.3 };
      if (dist(op.x, op.y, spot.x, spot.y) <= allowance * 1.5) {
        raw.push({ ...spot, tag: `cover:${piece.id}` });
      }
      // ...and the SAME piece approached from our own side of it, which is a
      // different place and a different idea: ground gained with something
      // solid still between us and the guns.
      //
      // Only the first kind existed, and it is a retreat — it is defined as
      // the far face of the terrain, measured from the enemy. So every covered
      // destination the planner could see was behind it, every forward
      // destination was in the open, and an operative that has to cross the
      // board to fight was choosing between falling back into cover and
      // walking into a gunline. Advancing along cover is the tabletop's answer
      // to a gunline and was not among this AI's options at all.
      //
      // It is among them now and is still not chosen often enough to change
      // the balance — a Goremonger warband against Pathfinders went from 0.8
      // Fight actions per battle to 0.9. The option belongs here anyway; what
      // is missing is further up, in what the score does with it.
      if (towardEnemies) {
        const near = { x: c.x - (dx / len) * 1.3, y: c.y - (dy / len) * 1.3 };
        if (dist(op.x, op.y, near.x, near.y) <= allowance * 1.5) {
          raw.push({ ...near, tag: `advance:${piece.id}` });
        }
      }
    }
  }

  // Rings around the current position — general-purpose repositioning, and
  // last in the queue: every one of these is a guess, and each one it displaces
  // was a position something on the board gave a reason for.
  for (const frac of [0.45, 0.8, 1.0]) {
    const r = allowance * frac;
    if (r < 0.3) continue;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      raw.push({ x: op.x + Math.cos(a) * r, y: op.y + Math.sin(a) * r, tag: 'ring' });
    }
  }

  // Staying put is always a candidate.
  const out = [{ x: op.x, y: op.y, path: [{ x: op.x, y: op.y }], length: 0, tag: 'hold' }];
  const seen = new Set([key(op)]);

  for (const cand of raw) {
    if (out.length >= MAX_CANDIDATES) break;
    const snapped = nearestLegalPosition(state, op.id, cand.x, cand.y, 2);
    if (!snapped) continue;
    const k = key(snapped);
    if (seen.has(k)) continue;
    const plan = planMove(state, op.id, snapped.x, snapped.y, allowance);
    if (!plan.ok) continue;
    seen.add(k);
    out.push({ x: snapped.x, y: snapped.y, path: plan.path, length: plan.length, tag: cand.tag });
  }

  return out;
}

/**
 * A legal spot to finish a Charge: within control range of `enemy`, clear of
 * terrain and other bases, and reachable inside `allowance`.
 *
 * Interpolating straight at the target is not enough — the point in front of
 * an enemy is frequently inside a wall or under another operative's base, and
 * the engine (correctly) rejects the charge. We fan out around the target and
 * take the cheapest legal contact point instead.
 *
 * @returns {{x,y,path,length}|null}
 */
export function chargeDestination(state, op, enemy, allowance) {
  // Sit 0.6" of base gap apart: comfortably inside the 1" control range.
  const contact = op.baseDiameter / 2 + enemy.baseDiameter / 2 + 0.6;
  const facing = Math.atan2(op.y - enemy.y, op.x - enemy.x);
  const steps = 16;
  let best = null;

  for (let i = 0; i < steps; i++) {
    // Fan outwards from the side we are approaching from.
    const offset = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * ((Math.PI * 2) / steps);
    const angle = facing + offset;
    const x = enemy.x + Math.cos(angle) * contact;
    const y = enemy.y + Math.sin(angle) * contact;

    if (!isPositionLegal(state, op.id, x, y).ok) continue;
    if (!withinControlRange({ ...op, x, y }, enemy)) continue;
    const plan = planMove(state, op.id, x, y, allowance);
    if (!plan.ok) continue;
    if (!best || plan.length < best.length) {
      best = { x, y, path: plan.path, length: plan.length };
    }
  }
  return best;
}
