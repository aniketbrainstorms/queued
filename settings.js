// settings.js: saves, reads and classifies the user's TMDB key (localStorage).
// The key never leaves this device except in requests to TMDB (see tmdb.js).
// Loads as a classic browser script and as a CommonJS module for the Node tests.

'use strict';

var KEY_STORAGE_NAME = 'queued.tmdb_key';

// The symbol shown beside cinema ticket prices ($, EUR, a rupee sign...). It is
// only a label: prices are never converted.
var CURRENCY_STORAGE_NAME = 'queued.currency';
var DEFAULT_CURRENCY = '$';
var CURRENCY_MAX_LENGTH = 3;

// v3 API key: 32 hex characters. v4 read access token: a long JWT (three
// base64url parts, starts with "eyJ").
var V3_KEY_PATTERN = /^[a-f0-9]{32}$/i;
var V4_TOKEN_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
var V4_TOKEN_MIN_LENGTH = 100;

// localStorage can be missing or throw (private mode, blocked storage).
function getKeyStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (err) {
    return null;
  }
  return null;
}

// Tidy what people actually paste: spaces, newlines, surrounding quotes, and a
// leading "Bearer ".
function cleanKeyInput(raw) {
  if (typeof raw !== 'string') return '';
  var key = raw.trim();
  key = key.replace(/^bearer\s+/i, '');
  key = key.replace(/^["'`]+|["'`]+$/g, '');
  return key.trim();
}

// Returns { type: 'v3' | 'v4' | 'invalid', key, reason }.
// reason is null for valid keys, else 'empty' or 'format'.
function classifyKey(raw) {
  var key = cleanKeyInput(raw);
  if (key === '') return { type: 'invalid', key: '', reason: 'empty' };
  if (V3_KEY_PATTERN.test(key)) return { type: 'v3', key: key, reason: null };
  if (key.length >= V4_TOKEN_MIN_LENGTH && V4_TOKEN_PATTERN.test(key)) {
    return { type: 'v4', key: key, reason: null };
  }
  return { type: 'invalid', key: key, reason: 'format' };
}

// The saved key as { type, key }, or null if there is none (or it is unusable).
function loadStoredKey() {
  var storage = getKeyStorage();
  if (!storage) return null;
  var raw = null;
  try {
    raw = storage.getItem(KEY_STORAGE_NAME);
  } catch (err) {
    return null;
  }
  if (raw === null) return null;
  var info = classifyKey(raw);
  if (info.type === 'invalid') return null;
  return { type: info.type, key: info.key };
}

// Validates the format, then stores it. Format only; use tmdb.verifyKey to test
// it against TMDB.
function saveKey(raw) {
  var info = classifyKey(raw);
  if (info.type === 'invalid') return { ok: false, reason: info.reason };
  var storage = getKeyStorage();
  if (!storage) return { ok: false, reason: 'storage' };
  try {
    storage.setItem(KEY_STORAGE_NAME, info.key);
  } catch (err) {
    return { ok: false, reason: 'storage' };
  }
  return { ok: true, type: info.type };
}

function clearKey() {
  var storage = getKeyStorage();
  if (!storage) return false;
  try {
    storage.removeItem(KEY_STORAGE_NAME);
  } catch (err) {
    return false;
  }
  return true;
}

// The saved currency symbol, or the default if none is saved or it is unusable.
function loadCurrencySymbol() {
  var storage = getKeyStorage();
  if (!storage) return DEFAULT_CURRENCY;
  var raw = null;
  try {
    raw = storage.getItem(CURRENCY_STORAGE_NAME);
  } catch (err) {
    return DEFAULT_CURRENCY;
  }
  var symbol = typeof raw === 'string' ? raw.trim() : '';
  if (symbol === '' || symbol.length > CURRENCY_MAX_LENGTH) return DEFAULT_CURRENCY;
  return symbol;
}

// Returns { ok: true, symbol } or { ok: false, reason: 'empty' | 'long' | 'storage' }.
function saveCurrencySymbol(raw) {
  var symbol = typeof raw === 'string' ? raw.trim() : '';
  if (symbol === '') return { ok: false, reason: 'empty' };
  if (symbol.length > CURRENCY_MAX_LENGTH) return { ok: false, reason: 'long' };
  var storage = getKeyStorage();
  if (!storage) return { ok: false, reason: 'storage' };
  try {
    storage.setItem(CURRENCY_STORAGE_NAME, symbol);
  } catch (err) {
    return { ok: false, reason: 'storage' };
  }
  return { ok: true, symbol: symbol };
}

// For showing a saved key in Settings without exposing all of it.
function maskKey(key) {
  if (typeof key !== 'string' || key.length <= 8) return '••••';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KEY_STORAGE_NAME: KEY_STORAGE_NAME,
    classifyKey: classifyKey,
    loadStoredKey: loadStoredKey,
    saveKey: saveKey,
    clearKey: clearKey,
    maskKey: maskKey,
    DEFAULT_CURRENCY: DEFAULT_CURRENCY,
    loadCurrencySymbol: loadCurrencySymbol,
    saveCurrencySymbol: saveCurrencySymbol
  };
}
