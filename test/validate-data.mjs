import fs from 'node:fs';
import path from 'node:path';
import { validateTeamPack, validateMap, validateMission } from '../src/data/validators.js';
import { readJson, ROOT } from './harness.mjs';

let failures = 0;
const show = (r) => {
  const tag = r.ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${r.subject}`);
  for (const e of r.errors) { console.log(`      error:   ${e}`); failures++; }
  for (const w of r.warnings) console.log(`      warning: ${w}`);
};

for (const f of fs.readdirSync(path.join(ROOT, 'data/teams'))) {
  show(validateTeamPack(readJson(`data/teams/${f}`)));
}
for (const f of fs.readdirSync(path.join(ROOT, 'data/maps'))) {
  show(validateMap(readJson(`data/maps/${f}`)));
}
for (const f of fs.readdirSync(path.join(ROOT, 'data/missions'))) {
  show(validateMission(readJson(`data/missions/${f}`)));
}

// Catalogue integrity: every referenced team must exist.
const factions = readJson('data/factions.json');
for (const faction of factions.factions) {
  for (const id of faction.teams) {
    if (!fs.existsSync(path.join(ROOT, `data/teams/${id}.json`))) {
      console.log(`FAIL  factions.json references missing team "${id}"`);
      failures++;
    }
  }
}
console.log(failures ? `\n${failures} error(s).` : '\nAll data valid.');
process.exit(failures ? 1 : 0);
