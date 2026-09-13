/**
 * Roster panels and the operative/team inspector (§25).
 *
 * Uses an original table/card layout. It deliberately does not imitate the
 * visual arrangement of any published datacard, and shows only what the loaded
 * pack's data policy permits, along with its source and version metadata.
 */
import { effectiveApl, isInjured, effectiveMove } from '../rules/effects.js';
import { activePloyIds, findPloy } from '../rules/ploys.js';
import { tokensOf } from '../rules/tokens.js';
import {
  operativeResources, playerResources, levelLabel, resourceDef, availableSpends,
} from '../rules/resources.js';
import { SUPPORT_LEVELS } from '../data/schema.js';
import { createPortrait, createOperativeToken } from './portraits.js';

/** Build an element with text set safely — never innerHTML for pack content. */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badgeClass(level) {
  if (level >= 5) return 'support-badge full';
  if (level >= 3) return 'support-badge partial';
  return 'support-badge';
}

export function renderRosterPanel(container, state, playerId, { colors, selectedId, activeId, onSelect }) {
  container.replaceChildren();
  const player = state.players[playerId];
  const pack = state.teamPacks[playerId];

  const head = h('div', 'team-head');
  const name = h('div', 'team-name');
  const swatch = h('span', 'team-swatch');
  swatch.style.background = colors[playerId];
  name.append(swatch, h('span', null, player.teamName));
  head.append(name);
  head.append(h('div', 'team-sub', `${playerId.toUpperCase()} · ${pack.factionId}`));
  container.append(head);

  const score = h('div', 'scoreline');
  for (const [key, value] of [['VP', player.victoryPoints], ['CP', player.cp],
                              ['Alive', Object.values(state.operatives)
                                .filter((o) => o.playerId === playerId && o.alive).length]]) {
    const chip = h('div', 'stat-chip');
    chip.append(h('div', 'k', key), h('div', 'v', String(value)));
    score.append(chip);
  }

  // A shared pool — Blooded tokens — belongs with the team's other counters,
  // because it is spent on the team's behalf rather than any one operative's.
  for (const pool of playerResources(state, playerId)) {
    const chip = h('div', 'stat-chip');
    chip.append(h('div', 'k', pool.label), h('div', 'v', String(pool.amount)));
    score.append(chip);
  }
  container.append(score);

  // What the CP actually bought. Ploys last one turning point, so this is the
  // only place a reader can see why a weapon gained a rule this turn.
  const ploys = activePloyIds(state, playerId)
    .map((id) => findPloy(pack, id))
    .filter(Boolean);
  if (ploys.length) {
    const row = h('div', 'ploy-row');
    row.append(h('span', 'ploy-label', 'In force'));
    for (const ploy of ploys) {
      const tag = h('span', 'ploy-tag', ploy.name);
      tag.title = ploy.description;
      row.append(tag);
    }
    container.append(row);
  }

  container.append(h('div', 'section-title', 'Operatives'));

  const ops = Object.values(state.operatives).filter((o) => o.playerId === playerId);
  for (const op of ops) {
    const card = h('button', 'op-card');
    card.style.borderLeftColor = colors[playerId];
    if (!op.alive) card.classList.add('down');
    if (op.id === selectedId) card.classList.add('selected');
    if (op.id === activeId) card.classList.add('active-now');
    card.setAttribute('aria-pressed', op.id === selectedId ? 'true' : 'false');

    const row = h('div', 'op-row');
    // The head token, where the art pipeline has drawn this operative. It is a
    // 4.5KB crop rather than the 79KB sheet portrait, which is the only reason
    // a face per card is affordable at all (see ui/portraits.js).
    const profile = pack.operatives.find((p) => p.id === op.profileId);
    const token = createOperativeToken(pack, profile, op.id);
    if (token) {
      row.append(token);
      card.classList.add('with-token');
    }
    row.append(h('span', 'op-name', op.name));
    const order = h('span', `badge ${op.alive ? op.order : 'down'}`,
      op.alive ? (op.order === 'engage' ? 'Engage' : 'Conceal') : 'Down');
    row.append(order);
    card.append(row);

    const meta = h('div', 'op-meta');
    meta.append(h('span', null, `${op.woundsRemaining}/${op.wounds} W`));
    meta.append(h('span', null, `APL ${effectiveApl(op)}`));
    meta.append(h('span', null, `Sv ${op.save}+`));
    const move = effectiveMove(op);
    meta.append(h('span', move !== op.move ? 'stat-changed' : null, `M ${move}"`));
    if (isInjured(op) && op.alive) meta.append(h('span', null, '· injured'));
    if (op.stunned && op.alive) meta.append(h('span', null, '· stunned'));
    card.append(meta);

    // Poison, Blaze and the rest are the whole point of the weapons that hang
    // them, so an operative carrying one says so on its card.
    const tokens = op.alive ? tokensOf(op) : [];
    // What this operative is personally holding — Pain tokens, a GORE TANK —
    // is read the same way, because both change what it can do this activation.
    const held = op.alive ? operativeResources(state, op).filter((r) => r.amount > 0) : [];
    if (tokens.length || held.length) {
      const strip = h('div', 'token-strip');
      const counts = new Map();
      for (const t of tokens) counts.set(t.label, (counts.get(t.label) || 0) + 1);
      for (const [label, n] of counts) {
        strip.append(h('span', 'token-chip', n > 1 ? `${label} ×${n}` : label));
      }
      for (const r of held) {
        const def = resourceDef(state, playerId, r.key);
        const text = def?.levels ? `${r.label}: ${r.text}` : `${r.label} ×${r.amount}`;
        strip.append(h('span', 'token-chip resource-chip', text));
      }
      card.append(strip);
    }

    const track = h('div', 'wound-track');
    const frac = Math.max(0, op.woundsRemaining / op.wounds);
    const fill = h('div', `wound-fill${frac <= 0.25 ? ' critical' : frac <= 0.5 ? ' hurt' : ''}`);
    fill.style.width = `${frac * 100}%`;
    track.append(fill);
    card.append(track);

    card.addEventListener('click', () => onSelect?.(op.id));
    container.append(card);
  }

  // Data provenance is always visible, never buried (§29).
  container.append(h('div', 'section-title', 'Data source'));
  const src = h('div', 'muted');
  const level = SUPPORT_LEVELS[pack.supportLevel] ?? SUPPORT_LEVELS[0];
  const badge = h('div', badgeClass(pack.supportLevel), level.badge);
  src.append(badge);
  src.append(h('div', null, `${pack.source?.publisher || 'unknown publisher'}`));
  src.append(h('div', null, `v${pack.dataVersion || '—'} · checked ${pack.source?.checkedAt || '—'}`));
  if (pack.source?.url) {
    const link = document.createElement('a');
    link.href = pack.source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Official source';
    src.append(link);
  }
  container.append(src);
}

/** Detail view for one operative, shown in the inspector modal. */
export function renderOperativeDetail(container, state, operativeId) {
  const op = state.operatives[operativeId];
  const pack = state.teamPacks[op.playerId];
  const profile = pack.operatives.find((p) => p.id === op.profileId);
  container.replaceChildren();

  const title = h('h2', null, op.name);
  title.id = 'inspectTitle';

  // The portrait is fetched here and nowhere else — opening a sheet is the only
  // thing in the app that loads art (see ui/portraits.js).
  const portrait = createPortrait(pack, profile);
  const sheetHead = h('div', portrait ? 'sheet-head with-portrait' : 'sheet-head');
  const heading = h('div', 'sheet-heading');
  heading.append(title, h('p', 'muted',
    `${pack.displayName} · role: ${op.role} · ${op.alive ? 'active' : 'incapacitated'}`));
  if (portrait) sheetHead.append(portrait);
  sheetHead.append(heading);
  container.append(sheetHead);

  // Who this one is, before what it can do. The sheet opens on a picture and a
  // stat table, which says everything about the operative as a piece and
  // nothing about it as a person — so the pack's own flavour line goes between
  // them, where a datacard would print it. Packs written before the field
  // existed simply have no paragraph here.
  if (profile?.lore) container.append(h('p', 'lore', profile.lore));

  const stats = document.createElement('table');
  stats.className = 'stats';
  const head = stats.createTHead().insertRow();
  for (const label of ['Move', 'APL', 'Save', 'Wounds', 'Order', 'AP left']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const body = stats.createTBody().insertRow();
  for (const value of [`${op.move}"`, effectiveApl(op), `${op.save}+`,
                       `${op.woundsRemaining}/${op.wounds}`, op.order, op.apRemaining]) {
    const td = body.insertCell();
    td.className = 'num';
    td.textContent = String(value);
  }
  container.append(stats);

  container.append(h('h3', null, 'Weapons'));
  const weapons = document.createElement('table');
  weapons.className = 'stats';
  const wh = weapons.createTHead().insertRow();
  for (const label of ['Weapon', 'Type', 'Range', 'ATK', 'Hit', 'Damage', 'Rules']) {
    const th = document.createElement('th');
    th.textContent = label;
    wh.append(th);
  }
  const wb = weapons.createTBody();
  for (const w of profile?.weapons || []) {
    const row = wb.insertRow();
    const cells = [
      w.name, w.type, w.type === 'ranged' ? `${w.range}"` : '—',
      w.atk, `${w.hit}+`, `${w.damage.normal}/${w.damage.critical}`,
      w.rulesText || (w.rules || []).join(', ') || '—',
    ];
    for (const value of cells) {
      const td = row.insertCell();
      td.textContent = String(value);
    }
  }
  container.append(weapons);

  // The economy this operative is playing with, and what it could buy now.
  const held = operativeResources(state, op);
  const spends = op.alive ? availableSpends(state, op, { window: 'activation' }) : [];
  if (held.length || spends.length) {
    container.append(h('h3', null, 'Team resources'));
    for (const r of held) {
      const def = resourceDef(state, op.playerId, r.key);
      container.append(h('p', null,
        `${r.label}: ${def?.levels ? levelLabel(def, r.amount) : r.amount}` +
        (def?.rule ? ` (${def.rule})` : '')));
    }
    if (spends.length) {
      const list = document.createElement('ul');
      for (const option of spends) {
        list.append(h('li', null, option.spend.name || option.spend.id));
      }
      container.append(h('p', 'muted', 'Can spend now:'));
      container.append(list);
    }
  }

  if (profile?.abilities?.length) {
    container.append(h('h3', null, 'Abilities'));
    const list = document.createElement('ul');
    list.className = 'ability-list';
    for (const ability of profile.abilities) {
      if (typeof ability === 'string') {
        list.append(h('li', null, ability));
        continue;
      }
      // An ability the engine can perform is a different thing from one it
      // only prints, and the card should not make them look alike: this is
      // where a player finds out whether the medic will ever use the medikit.
      const cost = ability.action
        ? `${ability.action.ap ?? 1} AP`
        : (ability.cost && ability.cost !== '-' ? String(ability.cost) : null);
      const item = h('li', ability.action ? 'performable' : null);
      const head = h('div', 'ability-head',
        `${ability.name}${cost ? ` — ${cost}` : ''}`);
      if (!ability.action && cost) {
        head.append(h('span', 'muted', ' (not performed by this engine)'));
      } else if (ability.action?.notes) {
        head.append(h('span', 'muted', ` (${ability.action.notes})`));
      }
      item.append(head);
      // And what it actually does. A name and a price is not a rule: "SIGNAL —
      // 1 AP" tells a reader nothing about what the AP buys, and the pack has
      // carried the printed text all along — the sheet simply never showed it.
      const text = String(ability.description ?? ability.text ?? '').trim();
      if (text) item.append(h('p', 'ability-text', text));
      list.append(item);
    }
    container.append(list);
  }

  container.append(h('h3', null, 'Rules support'));
  const level = SUPPORT_LEVELS[pack.supportLevel] ?? SUPPORT_LEVELS[0];
  container.append(h('div', badgeClass(pack.supportLevel), level.badge));
  container.append(h('p', 'muted',
    `${level.label}. Anything this pack declares beyond that level is reported in the battle ` +
    `log as an unsupported rule rather than guessed at.`));
  container.append(h('p', 'muted',
    `Data version ${pack.dataVersion || '—'}, checked ${pack.source?.checkedAt || '—'}, ` +
    `published by ${pack.source?.publisher || '—'}.`));
}
