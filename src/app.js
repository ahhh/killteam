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
import {
  step as advanceBattle, turningPointLimit, isLastTeamStanding,
  isAwaitingOrders, pendingOrders, resolveTactic,
} from './rules/phases.js';
import { createControllers, AI_VERSION } from './ai/controller.js';
import { ENGINE_VERSION } from './rules/engine.js';
import { buildReplay, toBattleLogText, toJson, digestEvents } from './replay/recorder.js';
import { BattlefieldRenderer } from './ui/battlefield.js';
import { EffectsLayer } from './ui/effects.js';
import { renderRosterPanel, renderOperativeDetail } from './ui/inspector.js';
import { CombatLog } from './ui/combat-log.js';
import { SetupScreen } from './ui/setup.js';
import { TacticsPrompt } from './ui/tactics.js';
import { ResultScreen } from './ui/result.js';
import { PlaybackClock } from './ui/controls.js';

const PREFS_KEY = 'ktsim.prefs.v1';
const DEFAULT_MAP = 'industrial-001';
const DEFAULT_MISSION = 'secure-and-hold';
/** Every map and mission the app offers. Adding one is a data change (#5). */
const MAPS = [
  'industrial-001', 'spacehulk-001', 'jungle-temple-001',
  'hab-warren-001', 'cull-pit-001',
];
const MISSIONS = ['secure-and-hold', 'annihilation'];

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
      // Boot fetches the indexes, never the packs. The pickers need a name and
      // a faction for every team (10KB) and a whole pack only for the two a
      // player has selected; the same goes for the five maps, of which exactly
      // one is ever on the board. Both are fetched on demand below.
      await Promise.all([
        this.repo.loadCatalogue(),
        this.repo.loadIndex(),
        // MAPS, not `knowsMap`: these arguments are evaluated before
        // `loadIndex` above has resolved, so the index cannot be consulted yet.
        this.repo.loadMaps([MAPS.includes(this.prefs.map) ? this.prefs.map : DEFAULT_MAP]),
        this.repo.loadMissions(MISSIONS),
      ]);
    } catch (err) {
      this._fatal(err);
      return;
    }

    this.effects = new EffectsLayer();
    this.renderer = new BattlefieldRenderer($('board'), {
      onSelectOperative: (id) => this.selectOperative(id),
      effects: this.effects,
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
      missionRoot: $('missionChoice'),
      missionIds: MISSIONS,
      importEls: {
        box: $('importBox'), button: $('importBtn'),
        file: $('importFile'), result: $('importResult'),
      },
      // The setup screen and the toolbar are two views of one choice.
      onMissionChange: (id) => { $('missionSelect').value = id; },
      // Switching a side to semi-manual mid-battle would leave an activation
      // half-played by somebody else, so the choice only takes effect on the
      // next battle — which is the one the Start button is about to begin.
      onControlChange: (control) => this._savePrefs({ control }),
    });

    // The orders prompt. It is shown by `stepBattle` whenever the engine
    // suspends an activation, and it hands the answer straight back.
    this.tactics = new TacticsPrompt({
      root: $('tacticsBody'),
      overlay: $('tacticsOverlay'),
      onChoose: (optionId) => this.chooseTactic(optionId),
    });

    // …and the scoreboard at the end of it, which folds away the same way so
    // the final positions can be read.
    this.result = new ResultScreen({
      root: $('resultBody'),
      overlay: $('resultOverlay'),
      isDeathmatch: isLastTeamStanding,
      digest: digestEvents,
    });

    const teams = this.prefs.teams ?? {};
    const ids = this.repo.catalogueTeamIds();
    const p1 = this.repo.knowsTeam(teams.p1) ? teams.p1 : ids[0];
    const p2 = this.repo.knowsTeam(teams.p2) ? teams.p2 : ids[Math.min(3, ids.length - 1)];
    this.setup.setSelection(p1, p2);
    this.setup.setControl(this.prefs.control?.p1, this.prefs.control?.p2);
    this.setup.setMission(
      this.repo.missions.has(this.prefs.mission) ? this.prefs.mission : DEFAULT_MISSION
    );
    // `newBattle` is synchronous and reached from seven event handlers, so the
    // invariant is that the selected packs are always already loaded. Boot
    // loads the opening pair; the setup screen loads any later choice before
    // it reports the change.
    await this.repo.loadTeams([p1, p2]);
    await this.setup.render();

    // The reference list is the last thing in the setup overlay, below the
    // team columns, the mission picker and the import box. Nobody is reading
    // it in the first paint, so it is fetched alongside everything else and
    // fills itself in whenever it lands rather than holding the screen up.
    this.repo.loadReference()
      .then(() => this.setup.renderReference())
      .catch(() => {});

    this._populateMaps();
    this._populateMissions();
    this._wireControls();

    if (this.prefs.seed) $('seedInput').value = this.prefs.seed;
    if (this.prefs.speed !== undefined) this.clock.setSpeed(this.prefs.speed);
    this._syncSpeedButtons();
    this._syncEffects();

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
    const missionId = $('missionSelect').value || DEFAULT_MISSION;

    // Packs are fetched on selection rather than at boot, so a battle can only
    // start once both are in hand. The setup screen loads a pack before it
    // reports the change, which leaves one way to get here without one: that
    // fetch failed, and the screen is already showing the reason.
    const packs = { p1: this.repo.teams.get(selection.p1), p2: this.repo.teams.get(selection.p2) };
    for (const playerId of ['p1', 'p2']) {
      if (!packs[playerId]) {
        this._fatal(new Error(
          `The rule pack for "${selection[playerId] ?? playerId}" is not loaded, so no battle can start. ` +
          'Pick a different kill team, or reload the page.'
        ));
        return;
      }
    }
    const map = this.repo.maps.get(mapId);
    if (!map) {
      this._fatal(new Error(
        `The map "${mapId}" is not loaded, so no battle can start. Pick another map, or reload the page.`
      ));
      return;
    }

    this.state = createBattleState({
      seed: useSeed,
      map,
      mission: this.repo.missions.get(missionId),
      teams: packs,
      engineVersion: ENGINE_VERSION,
      aiVersion: AI_VERSION,
    });
    const control = this.setup.getControl();
    // The only thing the flag changes is that `rules/phases.js` stops and asks
    // instead of taking the top plan; the controller thinks the same either
    // way, so a semi-manual team still fights like itself.
    this.controllers = createControllers({
      p1: { manual: control.p1 === 'manual' },
      p2: { manual: control.p2 === 'manual' },
    });
    this.tactics?.hide();
    this.selectedId = null;
    this.activeId = null;
    this.renderer.selectedId = null;
    this.renderer.highlight = null;
    this.log.clear();

    // Warm only the sprite sheets these two packs can actually produce. The
    // set is usually about half of what ships, and a match-up with no flamers,
    // no psykers and no grenades fetches none of those three (ui/effects.js).
    this.effects.reset();
    this.effects.prepare(this.state.teamPacks);
    this._syncEffects();

    this._savePrefs({
      seed: useSeed, teams: selection, mission: missionId, map: mapId, control,
    });
    this.render();
    this._syncControls();
  }

  /** One engine step, then reflect whatever it produced. */
  stepBattle() {
    if (!this.state || this.state.phase === PHASES.COMPLETE) return { done: true };
    if (this.tactics?.open) return { done: false, kind: 'await-orders' };
    const result = advanceBattle(this.state, this.controllers);
    this._reflect(result);
    // The engine has opened an activation and stopped: a semi-manual player
    // has to say what this operative does before anything else happens. The
    // clock is stopped rather than the step being refused, so the board is
    // showing the operative that is being asked about while the player reads.
    if (isAwaitingOrders(this.state)) this._askForOrders();
    return result;
  }

  /**
   * Put the suspended activation in front of the player.
   *
   * Whether the clock was running is remembered here rather than inferred
   * later: answering should put playback back exactly as it was, and a player
   * who had paused to think does not want Play pressed for them.
   */
  _askForOrders() {
    this._resumeAfterOrders = this.clock.playing;
    this.clock.pause();
    this.tactics.show(pendingOrders(this.state), { colors: this.colors });
  }

  /**
   * The player has chosen. The engine resolves it exactly as it resolves an
   * AI plan — this method decides nothing about legality (#2).
   */
  chooseTactic(optionId) {
    if (!this.state) return;
    const result = resolveTactic(this.state, optionId, this.controllers);
    this._reflect(result);
    this._syncControls();

    // One choice can lead straight into the next: the other side may have no
    // ready operatives, so the same player is asked again for a counteraction.
    if (isAwaitingOrders(this.state)) { this._askForOrders(); return; }

    if (this.state.phase === PHASES.COMPLETE) { this.showResult(); return; }
    if (this._resumeAfterOrders) this.clock.play();
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
        // The ids ride along with the geometry: the renderer turns the
        // operatives involved to face each other (ui/battlefield.js).
        const who = { attackerId: attack.attackerId, targetId: attack.targetId };
        this.renderer.highlight = attack.kind === 'fight'
          ? { type: 'fight', at: { x: to.x, y: to.y }, ...who }
          : {
            type: 'shot', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
            hit: damage, ...who,
          };
      }
    } else if (move) {
      this.renderer.highlight = {
        type: 'path', path: move.path,
        color: move.playerId === 'p1' ? 'var(--p1)' : 'var(--p2)',
      };
    }

    // The animations read the same events the log does — a shot, a swing, a
    // ploy — and are pure drawing: the battle is identical without them.
    this.effects.handle(this.state, fresh);
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
    // A deathmatch has no meaningful clock — its turning point cap only exists
    // so two teams that cannot reach each other still stop — so it is shown as
    // an open-ended count rather than "3 of 12".
    const clock = isLastTeamStanding(s)
      ? `Turning Point ${Math.max(1, s.turningPoint)} · last team standing`
      : `Turning Point ${Math.max(1, s.turningPoint)} of ${turningPointLimit(s)}`;
    const phase = s.phase === PHASES.COMPLETE
      ? 'Battle complete'
      : `${clock} · ${s.phase} · initiative ${s.initiativePlayerId ?? '—'}`;
    $('phaseLabel').textContent = phase;
  }

  selectOperative(id) {
    this.selectedId = id;
    this.render();
    renderOperativeDetail($('inspectBody'), this.state, id);
    this._openOverlay('inspectOverlay');
  }

  showResult() {
    this.result.show(this.state);
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
    // MAPS, not `repo.maps`: only the map being played has been fetched, and
    // the picker still has to offer the other four by name.
    for (const id of MAPS) {
      const entry = this.repo.mapEntry(id);
      if (!entry) continue;
      const option = document.createElement('option');
      option.value = id;
      option.textContent = entry.name ?? id;
      if (entry.blurb) option.title = entry.blurb;
      select.append(option);
    }
    const saved = this.prefs.map;
    select.value = this.repo.knowsMap(saved) ? saved : DEFAULT_MAP;
    // Terrain is fetched on selection, so the new map has to be in hand before
    // `newBattle` — which is synchronous — goes looking for it.
    select.addEventListener('change', async () => {
      try {
        await this.repo.loadMaps([select.value]);
      } catch (err) {
        this._fatal(err);
        return;
      }
      this.newBattle();
    });
  }

  /**
   * The mission picker. "Secure and Hold" is the four-turning-point objective
   * game; "Annihilation" runs until one kill team is wiped out.
   */
  _populateMissions() {
    const select = $('missionSelect');
    select.replaceChildren();
    for (const id of MISSIONS) {
      const mission = this.repo.missions.get(id);
      if (!mission) continue;
      const option = document.createElement('option');
      option.value = id;
      option.textContent = mission.name ?? id;
      if (mission.blurb) option.title = mission.blurb;
      select.append(option);
    }
    const saved = this.prefs.mission;
    select.value = this.repo.missions.has(saved) ? saved : DEFAULT_MISSION;
    select.addEventListener('change', () => {
      this.setup.setMission(select.value);
      this.newBattle();
    });
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
        this._syncEffects();
      });
    }

    $('devLogToggle').addEventListener('change', () => this.log.rebuild(this.state.eventLog));
    $('clearLogBtn').addEventListener('click', () => this.log.clear());
    $('logToggleBtn').addEventListener('click', () => this._toggleLog());

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
      this.result.hide();
      this.newBattle();
      this.clock.play();
    });
    $('resultNewBtn').addEventListener('click', () => {
      this.result.hide();
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
      this._syncEffects();
    });

    // Close any overlay with Escape; keyboard shortcuts for playback (§32).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // The result FOLDS rather than closing. Dismissing it used to throw
        // the scoreboard away with no way back to it, and the board it was
        // covering is the last thing worth looking at.
        if (this.result?.open && !this.result.minimized) {
          this.result.minimize();
          return;
        }
        for (const id of ['inspectOverlay', 'aboutOverlay', 'setupOverlay']) {
          this._closeOverlay(id);
        }
        return;
      }
      // The orders prompt owns the keyboard while it is up: its own number
      // shortcuts are the only ones that should do anything. That holds while
      // it is folded away too — the activation is still unanswered, so Play and
      // Step have nothing to advance, and the prompt has muted its own number
      // keys for as long as the cards are off screen.
      if (this.tactics?.open) return;
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === ' ') { e.preventDefault(); $('playBtn').click(); }
      if (e.key === 's') $('stepBtn').click();
      if (e.key === 'r') $('resetBtn').click();
      if (e.key === 'l') $('logToggleBtn').click();
    });
  }

  /**
   * Raise the battle log, or drop it back.
   *
   * One class on the body, because the two ends of it are different sizes on
   * a phone and on a desktop and CSS is where that belongs. Raised, the log
   * covers most of the board; dropped, it is the strip it always was — except
   * on a phone, where dropped means the header alone, because a 130px strip
   * of scrollback is neither readable nor worth the board it costs.
   *
   * Remembered, like the speed and the theme: a player who wants the log up
   * wants it up next time too.
   */
  _toggleLog(open = !document.body.classList.contains('log-open')) {
    document.body.classList.toggle('log-open', open);
    $('logToggleBtn').setAttribute('aria-expanded', String(open));
    // Newly revealed scrollback starts at the top otherwise, which on a phone
    // is four turning points behind whatever just happened.
    if (open) $('logBody').scrollTop = $('logBody').scrollHeight;
    this._savePrefs({ logOpen: open });
  }

  _syncControls() {
    const done = this.state?.phase === PHASES.COMPLETE;
    $('playBtn').textContent = this.clock?.playing ? 'Pause' : 'Play';
    $('playBtn').disabled = done;
    $('stepBtn').disabled = done;
  }

  /**
   * Whether the battlefield animates, and how fast.
   *
   * Off entirely for Reduce motion, whether that is the app's own switch or
   * the one in the operating system — the sprites are the most motion on this
   * page by a wide margin — and off at instant speed, where the whole battle
   * resolves inside one synchronous loop and there is no frame to draw into.
   * Otherwise the durations are fitted to the step interval so nothing is
   * still burning when the next operative activates.
   */
  _syncEffects() {
    if (!this.effects) return;
    const asked = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const still = asked
      || document.body.classList.contains('no-motion')
      || this.clock.speed === 0;
    this.effects.setTempo(this.clock.delay);
    this.effects.setEnabled(!still);
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
    if (this.prefs.logOpen) {
      document.body.classList.add('log-open');
      $('logToggleBtn')?.setAttribute('aria-expanded', 'true');
    }
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
