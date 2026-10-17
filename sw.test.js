'use strict';

// Checks the PWA wiring: every file the service worker caches exists, the
// manifest points at real icons of the right size, and index.html links them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SHELL_FILES, strategyFor } = require('./sw.js');

const root = __dirname;

function exists(file) { return fs.existsSync(path.join(root, file)); }

function pngSize(file) {
  const buf = fs.readFileSync(path.join(root, file));
  assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG', file + ' is not a PNG');
  return buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20);
}

test('every file the service worker precaches exists', () => {
  for (const file of SHELL_FILES) {
    if (file === './') continue;
    assert.ok(exists(file), 'missing from disk: ' + file);
  }
});

test('every script and stylesheet index.html loads is precached', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const used = [...html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|webmanifest|ico|png))"/g)].map((m) => m[1]);
  assert.ok(used.length > 5);
  for (const file of used) assert.ok(SHELL_FILES.includes(file), 'not precached: ' + file);
});

test('the manifest is installable: name, start_url, standalone, 192 and 512 icons', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.ok(m.name && m.short_name);
  assert.strictEqual(m.display, 'standalone');
  assert.strictEqual(m.start_url, './');
  assert.strictEqual(m.scope, './');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of m.icons) assert.strictEqual(pngSize(icon.src), icon.sizes, icon.src);
});

test('the home screen icon is 180x180 and index.html links manifest and icons', () => {
  assert.strictEqual(pngSize('icons/apple-touch-icon.png'), '180x180');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('rel="manifest" href="manifest.webmanifest"'));
  assert.ok(html.includes('rel="apple-touch-icon" href="icons/apple-touch-icon.png"'));
  assert.ok(html.includes('href="favicon.ico"'));
});

test('strategyFor caches the app and posters but never the TMDB API', () => {
  const own = 'https://aniketbrainstorms.github.io';
  assert.strictEqual(strategyFor('GET', own + '/queued/app.js', own), 'app');
  assert.strictEqual(strategyFor('GET', 'https://image.tmdb.org/t/p/w342/abc.jpg', own), 'image');
  assert.strictEqual(strategyFor('GET', 'https://api.themoviedb.org/3/search/multi?query=x', own), 'skip');
  assert.strictEqual(strategyFor('POST', own + '/queued/app.js', own), 'skip');
});
