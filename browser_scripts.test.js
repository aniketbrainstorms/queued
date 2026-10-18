// Run with: node --test
// The app's scripts are plain <script> tags that share one global scope. These
// tests load them the way the browser does (no require, no module) so a name
// clash or a missing global shows up here instead of on a phone.
'use strict';

require('fake-indexeddb/auto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const SCRIPTS = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
// app.js touches the page the moment it loads, so it is not loaded here.
const DATA_SCRIPTS = SCRIPTS.filter((name) => name !== 'app.js');

function topLevelNames(source) {
  const names = [];
  for (const m of source.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) names.push(m[1]);
  for (const m of source.matchAll(/^(?:var|let|const|class)\s+([A-Za-z0-9_$]+)/gm)) names.push(m[1]);
  return names;
}

test('index.html loads viewings.js before db.js', () => {
  assert.ok(SCRIPTS.includes('viewings.js'));
  assert.ok(SCRIPTS.indexOf('viewings.js') < SCRIPTS.indexOf('db.js'));
});

test('no two scripts declare the same top-level name', () => {
  const owner = new Map();
  for (const file of SCRIPTS) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    for (const name of topLevelNames(source)) {
      assert.ok(!owner.has(name), name + ' is declared in both ' + owner.get(name) + ' and ' + file);
      owner.set(name, file);
    }
  }
});

test('the data scripts work as plain browser scripts', async () => {
  const context = vm.createContext({ indexedDB: indexedDB, console: console, Date: Date, Math: Math });
  for (const file of DATA_SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
  }
  const program = `(async function () {
    await deleteDb();
    await addTitle({ key: 'movie:1', type: 'movie', title: 'X', status: 'watchlist' });
    await markWatched('movie:1');
    const bare = await getViewings('movie:1');
    const saved = await addViewing({ titleKey: 'movie:1', watchedOn: bare[0].watchedOn, rating: 4 });
    const title = await getTitle('movie:1');
    return { bare: bare.length, saved: saved.rating, filmRating: title.rating, all: (await getAllViewings()).length };
  })()`;
  const out = await vm.runInContext(program, context);
  assert.deepEqual({ ...out }, { bare: 1, saved: 4, filmRating: 4, all: 2 });
});
