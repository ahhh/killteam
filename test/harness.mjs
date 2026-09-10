/** Shared node-side loader so tests and the batch harness read the same data. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

export function loadTeam(id) { return readJson(`data/teams/${id}.json`); }
export function loadMap(id) { return readJson(`data/maps/${id}.json`); }
export function loadMission(id) { return readJson(`data/missions/${id}.json`); }
export const ROOT = root;
