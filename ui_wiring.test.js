// Run with: node --test
// The viewings screens are built from strings in diary.js and viewing_sheet.js,
// and wired up in app.js. These tests check the page, the icons and the styles
// have what those scripts expect, so a missing id or class shows up here.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const html = read('index.html');
const app = read('app.js');
const css = read('styles.css');

test('the page has the elements the viewings screens use', () => {
  for (const id of ['diary-panel', 'rule-label', 'viewing-dialog', 'viewing-content', 'log-prompt-dialog', 'log-prompt-content', 'currency-symbol']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
});

test('the bottom bar has a Diary tab and five columns', () => {
  assert.match(html, /data-view="diary"/);
  assert.equal((html.match(/<nav class="bottom-bar"[\s\S]*?<\/nav>/)[0].match(/<button/g) || []).length, 5);
  assert.match(css, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
});

test('the new scripts load in the right order', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const at = (name) => scripts.indexOf(name);
  assert.ok(at('html.js') > -1 && at('html.js') < at('viewings.js'));
  assert.ok(at('diary.js') > at('viewings.js') && at('diary.js') < at('app.js'));
  assert.ok(at('viewing_sheet.js') > at('db.js') && at('viewing_sheet.js') < at('app.js'));
});

test('every icon the stubs, the sheet and the Diary tab use is defined', () => {
  const block = app.match(/var ICON_PATHS = \{([\s\S]*?)\n\};/)[1];
  const defined = [...block.matchAll(/^  '?([a-z-]+)'?: '</gm)].map((m) => m[1]);
  for (const name of ['ticket', 'map-pin', 'screen', 'users', 'coin', 'play', 'device', 'film', 'plus', 'x']) {
    assert.ok(defined.includes(name), name);
  }
});

test('the styles cover the classes the builders write', () => {
  for (const selector of ['.stub-cinema', '.stub-side', '.stub-compact', '.chips', '.chip.selected', '.segmented', '.form-grid', '.star-fill', '.half.left', '.diary-month', '.viewings-block', '.grid[hidden]']) {
    assert.ok(css.includes(selector), selector);
  }
});
