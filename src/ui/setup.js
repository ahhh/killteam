/**
 * Setup screen: faction/team selection, rule-pack import, reference catalogue.
 *
 * Adding a team is a data change, never a UI change (#5) — this screen is
 * built entirely from the catalogue and whatever packs the user has imported.
 */
import { DataLoadError } from '../data/loader.js';
import { ployCatalogue } from '../rules/ploys.js';
import { dispositionForPack } from '../ai/tactics.js';
import { doctrineForPack, ployProfile } from '../ai/cp.js';

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One "label: value" row of the team strategy panel. */
function line(label, value) {
  const row = h('div', 'strategy-line');
  row.append(h('span', 'strategy-label', label), h('span', 'strategy-value', value));
  return row;
}

export class SetupScreen {
  /**
   * @param {{repo:DataRepository, roots:{p1:HTMLElement,p2:HTMLElement},
   *          referenceRoot:HTMLElement, importEls:object}} deps
   */
  constructor({ repo, roots, referenceRoot, importEls, missionRoot, missionIds = [], onChange, onMissionChange }) {
    this.repo = repo;
    this.roots = roots;
    this.referenceRoot = referenceRoot;
    this.importEls = importEls;
    this.missionRoot = missionRoot;
    this.missionIds = missionIds;
    this.onChange = onChange;
    this.onMissionChange = onMissionChange;
    this.selection = { p1: null, p2: null };
    this.missionId = missionIds[0] ?? null;
    this._wireImport();
  }

  /** @returns {{p1:string,p2:string}} the chosen team ids */
  getSelection() {
    return { ...this.selection };
  }

  setSelection(p1, p2) {
    this.selection = { p1, p2 };
  }

  getMission() {
    return this.missionId;
  }

  setMission(missionId) {
    if (missionId && this.repo.missions.has(missionId)) this.missionId = missionId;
    this._renderMissions();
  }

  async render() {
    for (const playerId of ['p1', 'p2']) {
      await this._renderColumn(playerId);
    }
    this._renderMissions();
    this._renderReference();
  }

  /**
   * How the battle is won, picked alongside the teams because it changes what
   * a good match-up even means: an objective game rewards holding ground for
   * four turning points, a deathmatch only rewards being the last one alive.
   */
  _renderMissions() {
    const root = this.missionRoot;
    if (!root) return;
    root.replaceChildren();

    for (const id of this.missionIds) {
      const mission = this.repo.missions.get(id);
      if (!mission) continue;

      const label = h('label', 'mission-option');
      if (id === this.missionId) label.classList.add('selected');

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'mission';
      input.value = id;
      input.checked = id === this.missionId;
      input.addEventListener('change', () => {
        this.missionId = id;
        this._renderMissions();
        this.onMissionChange?.(id);
      });

      const name = h('span', 'mission-name', mission.name ?? id);
      label.append(input, name);
      if (mission.blurb) label.append(h('span', 'mission-blurb', mission.blurb));
      root.append(label);
    }
  }

  async _renderColumn(playerId) {
    const root = this.roots[playerId];
    root.replaceChildren();
    root.append(h('h3', null, playerId === 'p1' ? 'Player 1' : 'Player 2'));

    const factions = this.repo.factions?.factions ?? [];
    const teamIds = new Set(this.repo.catalogueTeamIds());
    for (const id of this.repo.customTeams) teamIds.add(id);

    const select = document.createElement('select');
    select.setAttribute('aria-label', `${playerId} kill team`);

    // Groups the catalogue asks to be shown as ONE heading rather than one per
    // faction. The demo teams are the case it exists for: eight invented teams
    // spread over five invented faction names, which produced five headings of
    // one or two entries apiece and a lot of scrolling past labels that told
    // the player nothing. Real factions stay separate — "Orks" and "T'au
    // Empire" are the distinction a player is actually choosing between.
    const bundled = new Set(this.repo.factions?.bundledGroups ?? []);

    const addOption = (group, teamId) => {
      const pack = this.repo.teams.get(teamId);
      const option = document.createElement('option');
      option.value = teamId;
      // A variant sits directly under the team it came from, and says so —
      // two entries called "Kommandos" and "Dakka Kommandos" are otherwise
      // indistinguishable until you have already picked one.
      option.textContent = pack?.variantOfName
        ? `${pack.displayName} — ${pack.variantOfName} variant`
        : (pack?.displayName ?? teamId);
      group.append(option);
    };

    // One pass, in catalogue order, so a bundled group's single heading lands
    // exactly where its first faction would have — the catalogue is already
    // sorted by group, so the members are contiguous.
    let openBundle = null;
    for (const faction of factions) {
      if (faction.group && bundled.has(faction.group)) {
        if (!openBundle || openBundle.label !== faction.group) {
          openBundle = document.createElement('optgroup');
          openBundle.label = faction.group;
          select.append(openBundle);
        }
        for (const teamId of faction.teams) addOption(openBundle, teamId);
        continue;
      }
      openBundle = null;
      const group = document.createElement('optgroup');
      // A `<select>` has exactly one level of grouping, so the grand alliance
      // goes in front of the faction name rather than above it: the catalogue
      // is already ordered by group, so every Aeldari faction is adjacent and
      // the shared prefix is what says so. A faction with no group — an older
      // catalogue, or one somebody wrote themselves — just keeps its own name.
      group.label = faction.group ? `${faction.group} · ${faction.name}` : faction.name;
      for (const teamId of faction.teams) addOption(group, teamId);
      select.append(group);
    }

    if (this.repo.customTeams.size) {
      const group = document.createElement('optgroup');
      group.label = 'Imported';
      for (const teamId of this.repo.customTeams) {
        const pack = this.repo.teams.get(teamId);
        const option = document.createElement('option');
        option.value = teamId;
        option.textContent = `${pack?.displayName ?? teamId} (imported)`;
        group.append(option);
      }
      select.append(group);
    }

    select.value = this.selection[playerId] ?? select.options[0]?.value;
    this.selection[playerId] = select.value;

    select.addEventListener('change', async () => {
      this.selection[playerId] = select.value;
      await this._renderColumn(playerId);
      this.onChange?.(this.getSelection());
    });
    root.append(select);

    const detail = h('div');
    root.append(detail);
    this._renderTeamDetail(detail, this.selection[playerId]);
  }

  _renderTeamDetail(container, teamId) {
    container.replaceChildren();
    const pack = this.repo.teams.get(teamId);
    if (!pack) {
      container.append(h('p', 'muted', 'Team data not loaded.'));
      return;
    }

    const badge = this.repo.badgeFor(teamId);
    if (badge) {
      const cls = badge.level >= 5 ? 'support-badge full'
        : badge.badge.startsWith('Experimental') ? 'support-badge experimental'
        : badge.level >= 3 ? 'support-badge partial' : 'support-badge';
      container.append(h('div', cls, badge.badge));
    }

    // What a variant changes, before the player commits to it: the roster
    // below is the *what*, and this is the why.
    if (pack.variantNote) {
      const note = h('div', 'variant-note');
      note.append(h('strong', null, `Variant of ${pack.variantOfName ?? pack.variantOf}`));
      note.append(h('span', null, ` — ${pack.variantNote}`));
      container.append(note);
    }

    if (pack.blurb) container.append(h('p', 'muted', pack.blurb));
    // The blurb says what the team DOES, in a sentence, because the picker
    // needs to be skimmable. The lore says who they are, and sits below it for
    // the player who has stopped to read.
    if (pack.lore) container.append(h('p', 'lore', pack.lore));

    this._renderStrategy(container, pack);

    const list = document.createElement('ul');
    list.className = 'roster-preview';
    for (const entry of pack.roster.operatives) {
      const profile = pack.operatives.find((o) => o.id === entry.profileId);
      const count = entry.count ?? 1;
      list.append(h('li', null,
        `${count}× ${profile?.name ?? entry.profileId} — ` +
        `M ${profile?.stats.move}" · APL ${profile?.stats.apl} · ` +
        `Sv ${profile?.stats.save}+ · W ${profile?.stats.wounds}`));
    }
    container.append(list);

    if (badge?.warnings?.length) {
      const notice = h('div', 'notice');
      notice.append(h('div', null, 'This pack loaded with warnings:'));
      const ul = document.createElement('ul');
      for (const w of badge.warnings.slice(0, 5)) ul.append(h('li', null, w));
      notice.append(ul);
      container.append(notice);
    }
    if (badge?.stale) {
      container.append(h('div', 'notice',
        `This data was last checked ${badge.ageDays} days ago. Check the official source for updates.`));
    }
  }

  /**
   * How this team plays, and what of it this engine actually runs.
   *
   * Picking a kill team is a choice between two ways of fighting, and until
   * now the screen showed only a roster: five lines of stats that say nothing
   * about whether the team wants to close or hold, or what it does with its
   * Command Points. Both answers already exist — the AI derives them from the
   * pack (`ai/tactics.js`, `ai/cp.js`) — so they are shown here rather than
   * left for the player to infer from four turning points of battle log.
   *
   * The ploys listed are the SUPPORTED ones only, and the count of the rest is
   * shown plainly: a player should know which of a team's printed tricks the
   * simulator will actually play before they pick it, not afterwards.
   */
  _renderStrategy(container, pack) {
    const disposition = dispositionForPack(pack);
    const doctrine = doctrineForPack(pack);
    const box = h('div', 'team-strategy');

    box.append(line('Fights as', `${disposition.label} — ${disposition.note}`));
    box.append(line('Command points', `${doctrine.label} — ${doctrine.note}`));

    const ploys = ployCatalogue(pack);
    const supported = ploys.filter((p) => p.supported);
    const strategic = supported.filter((p) => p.kind === 'strategic');
    const action = supported.filter((p) => p.kind === 'firefight' && p.timing === 'activation');
    const reactive = supported.filter((p) => p.kind === 'firefight' && p.timing === 'defence');

    const names = (list) => list.map((p) => p.name).join(', ');
    if (strategic.length) box.append(line('Strategic ploys', names(strategic)));
    if (action.length) box.append(line('In the fight', names(action)));
    if (reactive.length) box.append(line('Held in reserve', names(reactive)));

    // Faction rules and team economies are the other half of what makes a team
    // feel like itself, and they are named in the pack.
    const rules = [...new Set((pack.ruleHooks || []).map((r) => r.rule).filter(Boolean))];
    if (rules.length) box.append(line('Faction rules', rules.join(', ')));
    const resources = Object.values(pack.resources || {})
      .map((r) => r.name || r.rule).filter(Boolean);
    if (resources.length) box.append(line('Economy', resources.join(', ')));

    const unplayed = ploys.length - supported.length;
    if (unplayed > 0) {
      box.append(h('div', 'muted', `${unplayed} of ${ploys.length} printed ploys are not simulated.`));
    } else if (!ploys.length) {
      box.append(h('div', 'muted', 'This pack declares no ploys, so its CP is spent on nothing.'));
    }
    container.append(box);
  }

  _renderReference() {
    const root = this.referenceRoot;
    if (!root) return;
    root.replaceChildren();
    const catalogue = this.repo.reference;
    if (!catalogue) return;

    root.append(h('p', 'muted', catalogue.note));

    // Same grouping the picker uses, so the provenance list reads in the same
    // order somebody just chose a team from.
    let shown = null;
    for (const faction of catalogue.factions) {
      if (faction.group && faction.group !== shown) {
        shown = faction.group;
        root.append(h('h4', 'reference-group', shown));
      }
      const line = h('div');
      line.append(h('strong', null, `${faction.name}: `));
      line.append(h('span', null, faction.teams.map((t) => t.name).join(', ')));
      root.append(line);
    }

    const link = document.createElement('a');
    link.href = catalogue.officialSource.downloads;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Official downloads (current rules)';
    const p = h('p');
    p.append(link);
    root.append(p);
  }

  _wireImport() {
    const { box, button, file, result } = this.importEls;

    const report = (node) => {
      result.replaceChildren();
      result.append(node);
    };

    const doImport = async (text) => {
      try {
        const outcome = this.repo.importJsonText(text);
        const items = Array.isArray(outcome) ? outcome : [outcome];
        const notice = h('div', 'notice');
        notice.style.borderColor = '#2f6f4f';
        notice.style.color = 'var(--good)';
        notice.style.background = '#101a14';
        for (const item of items) {
          notice.append(h('div', null,
            `Imported ${item.kind}: ${item.value.displayName ?? item.value.name ?? item.value.id}`));
          const warnings = this.repo.reportFor(item.kind, item.value.id)?.warnings ?? [];
          if (warnings.length) {
            const ul = document.createElement('ul');
            for (const w of warnings.slice(0, 6)) ul.append(h('li', null, w));
            notice.append(ul);
          }
        }
        report(notice);
        await this.render();
        this.onChange?.(this.getSelection());
      } catch (err) {
        const notice = h('div', 'notice error');
        notice.append(h('div', null, err instanceof DataLoadError
          ? 'This file was rejected:' : 'Import failed:'));
        for (const line of String(err.message).split('\n')) {
          notice.append(h('div', 'mono', line));
        }
        report(notice);
      }
    };

    button?.addEventListener('click', () => {
      const text = box.value.trim();
      if (!text) return;
      doImport(text);
    });

    file?.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      doImport(await chosen.text());
    });

    // Drag and drop straight onto the textarea.
    box?.addEventListener('dragover', (e) => { e.preventDefault(); });
    box?.addEventListener('drop', async (e) => {
      e.preventDefault();
      const dropped = e.dataTransfer?.files?.[0];
      if (dropped) doImport(await dropped.text());
    });
  }
}
