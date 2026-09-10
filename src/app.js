/**
 * Application wiring.
 *
 * This module owns the DOM. The engine, AI and data layers below it never
 * touch the document (#1), and this module never decides whether an action is
 * legal (#2) — it renders whatever the engine produced and asks for the next
 * step.
 */
import { DataRepository } from './data/loader.js';
import { createBattleState, PHASES } from './state.js';
import { step as advanceBattle, MAX_TURNING_POINTS } from './rules/phases.js';
import { createControllers, AI_VERSION } from './ai/controller.js';
import { ENGINE_VERSION } from './rules/engine.js';
import { buildReplay, toBattleLogText, toJson, digestEvents } from './replay/recorder.js';
import { BattlefieldRenderer } from './ui/battlefield.js';
import { renderRosterPanel, renderOperativeDetail } from './ui/inspector.js';
import { CombatLog } from './ui/combat-log.js';
import { SetupScreen } from './ui/setup.js';
import { PlaybackClock } from './ui/controls.js';

const PREFS_KEY = 'ktsim.prefs.v1';
const DEFAULT_MAP = 'industrial-001';
const DEFAULT_MISSION = 'secure-and-hold';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.repo = new DataRepository({ baseUrl: './data' });
    this.state = null;
    this.controllers = null;
    this.selectedId = null;
    this.activeId = null;
    this.colors = { p1: 'var(--p1)', p2: 'var(--p2)' };
    this.prefs = this._loadPrefs();
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  async boot() {
    this._applyPrefs();

    try {
      await this.repo.loadCatalogue();
      await this.repo.loadReference();
      for (const id of this.repo.catalogueTeamIds()) await this.repo.loadTeam(id);
      await this.repo.loadMap(DEFAULT_MAP);
      await this.repo.loadMission(DEFAULT_MISSION);
    } catch (err) {
      this._fatal(err);
      return;
    }

    this.renderer = new BattlefieldRenderer($('board'), {
      onSelectOperative: (id) => this.selectOperative(id),
    });
    this.log = new CombatLog($('logBody'), { devToggle: $('devLogToggle') });

    this.clock = new PlaybackClock({
      onStep: () => this.stepBattle(),
      onFinish: () => this.showResult(),
      onTick: () => this._syncControls(),
    });

    this.setup = new SetupScreen({
      repo: this.repo,
      roots: { p1: $('setupP1'), p2: $('setupP2') },
      referenceRoot: $('referenceList'),
      importEls: {
        box: $('importBox'), button: $('importBtn'),
        file: $('importFile'), result: $('importResult'),
      },
    });

    const teams = this.prefs.teams ?? {};
    const ids = this.repo.catalogueTeamIds();
    this.setup.setSelection(
      this.repo.teams.has(teams.p1) ? teams.p1 : ids[0],
      this.repo.teams.has(teams.p2) ? teams.p2 : ids[Math.min(3, ids.length - 1)]
    );
    await this.setup.render();

    this._populateMaps();
    this._wireControls();

    if (this.prefs.seed) $('seedInput').value = this.prefs.seed;
    if (this.prefs.speed !== undefined) this.clock.setSpeed(this.prefs.speed);
    this._syncSpeedButtons();

    this.newBattle();
    this._openOverlay('setupOverlay');
  }

  _fatal(err) {
    const body = document.body;
    body.replaceChildren();
    const box = document.createElement('div');
    box.style.cssText = 'padding:40px;font-family:system-ui;color:#e6eaf2;background:#10131a;height:100vh';
    const h = document.createElement('h1');
    h.textContent = 'Could not start';
    const p = document.createElement('p');
    p.textContent = String(err.message ?? err);
    const hint = document.createElement('p');
    hint.style.color = '#9aa4b8';
    hint.textContent =
      'This app loads its data with fetch(), which browsers block on file:// URLs. ' +
      'Serve the folder over HTTP instead — for example: python3 -m http.server 8000';
    box.append(h, p, hint);
    body.append(box);
  }

  /* ---------------------------------------------------------------- */
  /* Battle lifecycle                                                  */
  /* ---------------------------------------------------------------- */

  newBattle({ seed = null } = {}) {
    this.clock?.pause();
    const selection = this.setup.getSelection();
    const useSeed = seed ?? ($('seedInput').value.trim() || 'default');
    $('seedInput').value = useSeed;

    const mapId = $('mapSelect').value || DEFAULT_MAP;

    this.state = createBattleState({
      seed: useSeed,
      map: this.repo.maps.get(mapId),
      mission: this.repo.missions.get(DEFAULT_MISSION),
      teams: {
        p1: this.repo.teams.get(selection.p1),
        p2: this.repo.teams.get(selection.p2),
      },
      engineVersion: ENGINE_VERSION,
      aiVersion: AI_VERSION,
    });
    this.controllers = createControllers();
    this.selectedId = null;
    this.activeId = null;
    this.renderer.selectedId = null;
    this.renderer.highlight = null;
    this.log.clear();

    this._savePrefs({ seed: useSeed, teams: selection });
    this.render();
    this._syncControls();
  }

  /** One engine step, then reflect whatever it produced. */
  stepBattle() {
    if (!this.state || this.state.phase === PHASES.COMPLETE) return { done: true };
    const result = advanceBattle(this.state, this.controllers);
    this._reflect(result);
    return result;
  }

  /** Turn the events a step produced into log lines and board highlights. */
  _reflect(result) {
    const events = this.state.eventLog;
    const fresh = events.slice(result.fromSeq);

    const activation = [...fresh].reverse().find((e) => e.type === 'OPERATIVE_ACTIVATED');
    this.activeId = activation?.operativeId ?? null;

    const move = [...fresh].reverse().find((e) => e.type === 'MOVE_RESOLVED');
    const attack = [...fresh].reverse().find((e) => e.type === 'ATTACK_ROLLED');
    const damage = fresh.some((e) => e.type === 'DAMAGE_APPLIED');

    this.renderer.highlight = null;
    if (attack) {
      const from = this.state.operatives[attack.attackerId];
      const to = this.state.operatives[attack.targetId];
      if (from && to) {
        this.renderer.highlight = attack.kind === 'fight'
          ? { type: 'fight', at: { x: to.x, y: to.y } }
          : { type: 'shot', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, hit: damage };
      }
    } else if (move) {
      this.renderer.highlight = {
        type: 'path', path: move.path,
        color: move.playerId === 'p1' ? 'var(--p1)' : 'var(--p2)',
      };
    }

    this.log.append(events);
    this.render();
  }

  render() {
    if (!this.state) return;
    this.renderer.selectedId = this.selectedId;
    this.renderer.render(this.state, { colors: this.colors });
    renderRosterPanel($('panelP1'), this.state, 'p1', {
      colors: this.colors, selectedId: this.selectedId, activeId: this.activeId,
      onSelect: (id) => this.selectOperative(id),
    });
    renderRosterPanel($('panelP2'), this.state, 'p2', {
      colors: this.colors, selectedId: this.selectedId, activeId: this.activeId,
      onSelect: (id) => this.selectOperative(id),
    });

    const s = this.state;
    const phase = s.phase === PHASES.COMPLETE
      ? 'Battle complete'
      : `Turning Point ${Math.max(1, s.turningPoint)} of ${MAX_TURNING_POINTS} · ` +
        `${s.phase} · initiative ${s.initiativePlayerId ?? '—'}`;
    $('phaseLabel').textContent = phase;
  }

  selectOperative(id) {
    this.selectedId = id;
    this.render();
    renderOperativeDetail($('inspectBody'), this.state, id);
    this._openOverlay('inspectOverlay');
  }

  showResult() {
    const state = this.state;
    if (!state?.result) return;
    const body = $('inspectBody') && $('resultBody');
    body.replaceChildren();

    const head = document.createElement('div');
    head.className = 'result-head';
    const title = document.createElement('h2');
    title.id = 'resultTitle';
    title.textContent = 'Battle complete';
    const winner = document.createElement('div');
    winner.className = 'winner';
    winner.textContent = state.result.winner
      ? `${state.players[state.result.winner].teamName} wins`
      : 'Draw';
    const score = document.createElement('div');
    score.className = 'score';
    score.textContent = `${state.result.victoryPoints.p1} – ${state.result.victoryPoints.p2}`;
    head.append(title, winner, score);
    body.append(head);

    const table = document.createElement('div');
    table.className = 'vp-table';
    const addRow = (label, a, b, cls = '') => {
      const l = document.createElement('div'); l.className = cls; l.textContent = label;
      const x = document.createElement('div'); x.className = cls; x.textContent = String(a);
      const y = document.createElement('div'); y.className = cls; y.textContent = String(b);
      table.append(l, x, y);
    };
    addRow('', state.players.p1.teamName, state.players.p2.teamName, 'hdr');
    const reasons = new Set([
      ...Object.keys(state.result.vpBreakdown.p1),
      ...Object.keys(state.result.vpBreakdown.p2),
    ]);
    for (const reason of reasons) {
      addRow(reason, state.result.vpBreakdown.p1[reason] ?? 0, state.result.vpBreakdown.p2[reason] ?? 0);
    }
    addRow('Survivors', state.result.survivors.p1, state.result.survivors.p2);
    body.append(table);

    const meta = document.createElement('p');
    meta.className = 'muted mono';
    meta.textContent =
      `seed ${state.seed} · engine ${state.engineVersion} · AI ${state.aiVersion} · ` +
      `map ${state.map.id} · digest ${digestEvents(state.eventLog)}`;
    body.append(meta);

    if (state.warnings.length) {
      const notice = document.createElement('div');
      notice.className = 'notice';
      const head2 = document.createElement('div');
      head2.textContent = 'Unsupported rules encountered during this battle:';
      notice.append(head2);
      const ul = document.createElement('ul');
      for (const w of state.warnings) {
        const li = document.createElement('li');
        li.textContent = `${w.ruleId} (×${w.count}) — ${w.detail}`;
        ul.append(li);
      }
      notice.append(ul);
      body.append(notice);
    }

    this._openOverlay('resultOverlay');
  }

  /* ---------------------------------------------------------------- */
  /* Export                                                            */
  /* ---------------------------------------------------------------- */

  _download(filename, text, type = 'application/json') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  exportReplay() {
    if (!this.state) return;
    const replay = buildReplay(this.state);
    this._download(`battle-${this.state.seed}.replay.json`, toJson(replay));
  }

  exportLog() {
    if (!this.state) return;
    const replay = buildReplay(this.state);
    this._download(`battle-${this.state.seed}.log.txt`, toBattleLogText(replay), 'text/plain');
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  _populateMaps() {
    const select = $('mapSelect');
    select.replaceChildren();
    for (const [id, map] of this.repo.maps) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = map.name ?? id;
      select.append(option);
    }
    select.value = DEFAULT_MAP;
    select.addEventListener('change', () => this.newBattle());
  }

  _wireControls() {
    $('playBtn').addEventListener('click', () => {
      if (this.state?.phase === PHASES.COMPLETE) return;
      this.clock.playing ? this.clock.pause() : this.clock.play();
    });
    $('stepBtn').addEventListener('click', () => {
      this.clock.pause();
      this.clock.stepOnce();
    });
    $('resetBtn').addEventListener('click', () => this.newBattle());
    $('newSeedBtn').addEventListener('click', () => {
      this.newBattle({ seed: this._randomSeed() });
    });
    $('seedInput').addEventListener('change', () => this.newBattle());

    for (const button of document.querySelectorAll('button.speed')) {
      button.addEventListener('click', () => {
        this.clock.setSpeed(Number(button.dataset.speed));
        this._savePrefs({ speed: Number(button.dataset.speed) });
        this._syncSpeedButtons();
      });
    }

    $('devLogToggle').addEventListener('change', () => this.log.rebuild(this.state.eventLog));
    $('clearLogBtn').addEventListener('click', () => this.log.clear());

    $('setupBtn').addEventListener('click', () => this._openOverlay('setupOverlay'));
    $('setupCancelBtn').addEventListener('click', () => this._closeOverlay('setupOverlay'));
    $('setupStartBtn').addEventListener('click', () => {
      this._closeOverlay('setupOverlay');
      this.newBattle();
    });

    $('exportBtn').addEventListener('click', () => this.exportReplay());
    $('inspectCloseBtn').addEventListener('click', () => this._closeOverlay('inspectOverlay'));
    $('resultLogBtn').addEventListener('click', () => this.exportLog());
    $('resultReplayBtn').addEventListener('click', () => {
      this._closeOverlay('resultOverlay');
      this.newBattle();
      this.clock.play();
    });
    $('resultNewBtn').addEventListener('click', () => {
      this._closeOverlay('resultOverlay');
      this._openOverlay('setupOverlay');
    });

    const openAbout = (e) => { e?.preventDefault(); this._openOverlay('aboutOverlay'); };
    $('aboutBtn').addEventListener('click', openAbout);
    $('footerAbout').addEventListener('click', openAbout);
    $('aboutCloseBtn').addEventListener('click', () => this._closeOverlay('aboutOverlay'));

    $('contrastToggle').addEventListener('change', (e) => {
      document.body.classList.toggle('high-contrast', e.target.checked);
      this._savePrefs({ highContrast: e.target.checked });
    });
    $('motionToggle').addEventListener('change', (e) => {
      document.body.classList.toggle('no-motion', e.target.checked);
      this._savePrefs({ reduceMotion: e.target.checked });
    });

    // Close any overlay with Escape; keyboard shortcuts for playback (§32).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        for (const id of ['inspectOverlay', 'resultOverlay', 'aboutOverlay', 'setupOverlay']) {
          this._closeOverlay(id);
        }
        return;
      }
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === ' ') { e.preventDefault(); $('playBtn').click(); }
      if (e.key === 's') $('stepBtn').click();
      if (e.key === 'r') $('resetBtn').click();
    });
  }

  _syncControls() {
    const done = this.state?.phase === PHASES.COMPLETE;
    $('playBtn').textContent = this.clock?.playing ? 'Pause' : 'Play';
    $('playBtn').disabled = done;
    $('stepBtn').disabled = done;
  }

  _syncSpeedButtons() {
    for (const button of document.querySelectorAll('button.speed')) {
      button.classList.toggle('active', Number(button.dataset.speed) === this.clock.speed);
      button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === this.clock.speed));
    }
  }

  _openOverlay(id) { $(id).hidden = false; }
  _closeOverlay(id) { $(id).hidden = true; }

  _randomSeed() {
    const words = ['hive', 'ash', 'void', 'spire', 'rift', 'forge', 'drift', 'ember'];
    const pick = words[Math.floor(Math.random() * words.length)];
    return `${pick}-${Math.floor(Math.random() * 9000 + 1000)}`;
  }

  /* ---------------------------------------------------------------- */
  /* Preferences                                                       */
  /* ---------------------------------------------------------------- */

  _loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
    } catch {
      return {};
    }
  }

  _savePrefs(patch) {
    this.prefs = { ...this.prefs, ...patch };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // Storage can be unavailable (private mode); preferences are optional.
    }
  }

  _applyPrefs() {
    if (this.prefs.highContrast) {
      document.body.classList.add('high-contrast');
      const box = $('contrastToggle');
      if (box) box.checked = true;
    }
    if (this.prefs.reduceMotion) {
      document.body.classList.add('no-motion');
      const box = $('motionToggle');
      if (box) box.checked = true;
    }
  }
}

const app = new App();
app.boot();
export default app;
