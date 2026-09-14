/**
 * The battle log's fold, which is markup and CSS rather than a module.
 *
 * On a phone the log used to be a fixed 130px strip that could be neither
 * dismissed nor read: too short to follow a turning point in, and taking that
 * room permanently out of the only thing on the screen that has to be legible.
 * The fix is a chevron in its header, and the parts of it that can go wrong
 * silently are all here — a button with no handler, a handler with no button,
 * or a stylesheet that hides the log on a phone and never brings it back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

/** The stylesheet's narrow-screen block, where the phone layout lives. */
function narrowBlock() {
  const start = css.indexOf('@media (max-width: 980px)');
  assert.notEqual(start, -1, 'the narrow-screen breakpoint has moved');
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open, i);
  }
  throw new Error('unterminated media query');
}

test('the log header carries a toggle, wired to the log body', () => {
  assert.match(html, /id="logToggleBtn"/);
  assert.match(html, /aria-controls="logBody"/);
  assert.match(html, /aria-expanded="false"/);
  // It has to be inside the header, or it scrolls away with the scrollback.
  const head = html.slice(html.indexOf('<div class="log-head">'), html.indexOf('<div class="log-body"'));
  assert.ok(head.includes('logToggleBtn'), 'the toggle is not in the log header');
});

test('the toggle has a handler, and the handler reports its state', () => {
  assert.match(app, /\$\('logToggleBtn'\)\.addEventListener\('click'/);
  assert.match(app, /setAttribute\('aria-expanded'/);
  // Raised or dropped is remembered, like the speed and the theme.
  assert.match(app, /_savePrefs\(\{ logOpen/);
  assert.match(app, /this\.prefs\.logOpen/);
});

test('on a phone the log starts folded and the toggle is what opens it', () => {
  const narrow = narrowBlock();
  assert.match(narrow, /\.log-body\s*\{\s*display:\s*none/,
    'the log is not folded away by default on a narrow screen');
  assert.match(narrow, /body\.log-open\s+\.log-body\s*\{\s*display:\s*block/,
    'nothing in the phone layout brings the log back');
  assert.match(narrow, /body\.log-open\s+\.logbar\s*\{\s*height:/,
    'the raised log has no height of its own on a phone');
});

test('the chevron turns over when the log is raised', () => {
  assert.match(css, /\.log-toggle\[aria-expanded="true"\]\s+\.log-chevron\s*\{[^}]*rotate/);
});

test('a raised log never takes the whole screen', () => {
  // The point of raising it is to read it against what is on the table, so
  // the board has to survive.
  const raised = /body\.log-open\s+\.logbar\s*\{\s*height:\s*min\(([^)]*)\)/.exec(css);
  assert.ok(raised, 'the desktop raised height is not capped');
  assert.match(raised[1], /vh/);
});
