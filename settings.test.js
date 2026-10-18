// Run with: node --test
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const settings = require('./settings.js');

const V3 = '0123456789abcdef0123456789abcdef';
const V4 = 'eyJ' + 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.' + 'c'.repeat(40);

// A minimal in-memory localStorage.
function makeFakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data
  };
}

function installStorage(storage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true
  });
}

beforeEach(() => {
  installStorage(makeFakeStorage());
});

// ---------- classifyKey ----------

test('classifyKey recognises a v3 key', () => {
  assert.deepEqual(settings.classifyKey(V3), { type: 'v3', key: V3, reason: null });
  assert.equal(settings.classifyKey(V3.toUpperCase()).type, 'v3');
});

test('classifyKey recognises a v4 token', () => {
  const info = settings.classifyKey(V4);
  assert.equal(info.type, 'v4');
  assert.equal(info.key, V4);
});

test('classifyKey cleans spaces, quotes and a Bearer prefix', () => {
  assert.equal(settings.classifyKey('  ' + V3 + '\n').key, V3);
  assert.equal(settings.classifyKey('"' + V3 + '"').key, V3);
  assert.equal(settings.classifyKey('Bearer ' + V4).type, 'v4');
  assert.equal(settings.classifyKey('bearer   ' + V4).key, V4);
});

test('classifyKey rejects empty, short and malformed input', () => {
  assert.equal(settings.classifyKey('').reason, 'empty');
  assert.equal(settings.classifyKey('   ').reason, 'empty');
  assert.equal(settings.classifyKey(null).reason, 'empty');
  assert.equal(settings.classifyKey('abc123').reason, 'format');
  assert.equal(settings.classifyKey(V3 + 'f').reason, 'format');
  assert.equal(settings.classifyKey('z'.repeat(32)).reason, 'format');
  assert.equal(settings.classifyKey('eyJabc.def.ghi').reason, 'format');
});

// ---------- save / load / clear ----------

test('saveKey stores a valid key and loadStoredKey reads it back', () => {
  assert.deepEqual(settings.saveKey(V3), { ok: true, type: 'v3' });
  assert.deepEqual(settings.loadStoredKey(), { type: 'v3', key: V3 });
  assert.deepEqual(settings.saveKey('Bearer ' + V4), { ok: true, type: 'v4' });
  assert.deepEqual(settings.loadStoredKey(), { type: 'v4', key: V4 });
});

test('saveKey refuses an invalid key and stores nothing', () => {
  assert.deepEqual(settings.saveKey('nope'), { ok: false, reason: 'format' });
  assert.equal(settings.loadStoredKey(), null);
});

test('loadStoredKey is null with no key, and ignores a corrupted stored value', () => {
  assert.equal(settings.loadStoredKey(), null);
  localStorage.setItem(settings.KEY_STORAGE_NAME, 'garbage');
  assert.equal(settings.loadStoredKey(), null);
});

test('clearKey removes the key', () => {
  settings.saveKey(V3);
  assert.equal(settings.clearKey(), true);
  assert.equal(settings.loadStoredKey(), null);
});

test('storage failures are reported, not thrown', () => {
  const broken = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  };
  installStorage(broken);
  assert.deepEqual(settings.saveKey(V3), { ok: false, reason: 'storage' });
  assert.equal(settings.loadStoredKey(), null);
  assert.equal(settings.clearKey(), false);
});

test('missing localStorage is handled', () => {
  installStorage(undefined);
  assert.deepEqual(settings.saveKey(V3), { ok: false, reason: 'storage' });
  assert.equal(settings.loadStoredKey(), null);
});

test('the key is stored under queued.tmdb_key', () => {
  settings.saveKey(V3);
  assert.equal(localStorage.getItem('queued.tmdb_key'), V3);
});

// ---------- maskKey ----------

test('maskKey shows only the ends of a key', () => {
  assert.equal(settings.maskKey(V3), '0123…cdef');
  assert.equal(settings.maskKey('short'), '••••');
  assert.equal(settings.maskKey(undefined), '••••');
});

// ---------- currency symbol ----------

test('the currency symbol defaults to a dollar sign', () => {
  assert.equal(settings.loadCurrencySymbol(), '$');
  assert.equal(settings.DEFAULT_CURRENCY, '$');
});

test('a saved currency symbol is trimmed and loaded back', () => {
  assert.deepEqual(settings.saveCurrencySymbol('  \u20b9 '), { ok: true, symbol: '\u20b9' });
  assert.equal(settings.loadCurrencySymbol(), '\u20b9');
  assert.equal(settings.saveCurrencySymbol('CHF').ok, true);
  assert.equal(settings.loadCurrencySymbol(), 'CHF');
});

test('an empty or long currency symbol is refused and nothing changes', () => {
  settings.saveCurrencySymbol('\u20ac');
  assert.deepEqual(settings.saveCurrencySymbol('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(settings.saveCurrencySymbol('dollars'), { ok: false, reason: 'long' });
  assert.deepEqual(settings.saveCurrencySymbol(42), { ok: false, reason: 'empty' });
  assert.equal(settings.loadCurrencySymbol(), '\u20ac');
});

test('a bad stored currency symbol falls back to the default', () => {
  localStorage.setItem('queued.currency', 'way too long');
  assert.equal(settings.loadCurrencySymbol(), '$');
});

test('currency settings cope with missing storage', () => {
  installStorage(null);
  assert.equal(settings.loadCurrencySymbol(), '$');
  assert.deepEqual(settings.saveCurrencySymbol('\u20ac'), { ok: false, reason: 'storage' });
});
