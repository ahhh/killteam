/**
 * Battle log panel (§23).
 *
 * Shows what happened and, for AI decisions, why. Utility scores and geometry
 * detail stay behind the Developer log toggle so the default read is clean.
 */
import { describeEvent } from '../replay/recorder.js';

const DEV_ONLY = new Set(['AI_PLAN', 'ACTIVATION_ENDED', 'CP_GAINED', 'DEPLOYED']);

function classFor(event) {
  switch (event.type) {
    case 'TURN_STARTED':
    case 'TURN_ENDED': return 'turn';
    case 'OPERATIVE_INCAPACITATED': return 'kill';
    case 'ATTACK_ROLLED':
    case 'DEFENCE_ROLLED':
    case 'DAMAGE_APPLIED': return 'hit';
    case 'VP_AWARDED':
    case 'OBJECTIVE_SCORED': return 'score';
    case 'WARNING': return 'warn';
    case 'AI_PLAN': return 'plan';
    case 'RULE_APPLIED': return 'rule';
    default: return event.playerId || '';
  }
}

export class CombatLog {
  constructor(container, { devToggle } = {}) {
    this.container = container;
    this.devToggle = devToggle;
    this.rendered = 0;
    this.events = [];
  }

  get showDev() {
    return !!this.devToggle?.checked;
  }

  clear() {
    this.container.replaceChildren();
    this.rendered = 0;
    this.events = [];
  }

  /** Append everything not yet shown. */
  append(events) {
    this.events = events;
    const frag = document.createDocumentFragment();
    for (let i = this.rendered; i < events.length; i++) {
      const line = this._line(events[i]);
      if (line) frag.append(line);
    }
    this.rendered = events.length;
    if (frag.childNodes.length) {
      this.container.append(frag);
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  /** Rebuild from scratch — used when the dev toggle changes. */
  rebuild(events = this.events) {
    this.container.replaceChildren();
    this.rendered = 0;
    this.append(events);
  }

  _line(event) {
    if (!this.showDev && DEV_ONLY.has(event.type)) return null;
    const text = describeEvent(event);
    if (!text) return null;

    const row = document.createElement('div');
    row.className = `log-line ${classFor(event)}`;

    const tp = document.createElement('span');
    tp.className = 'tp';
    tp.textContent = event.turningPoint ? `TP${event.turningPoint}` : '—';

    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = text;

    row.append(tp, msg);
    return row;
  }
}
