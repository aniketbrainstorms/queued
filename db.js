// db.js: IndexedDB access for Queued. The only file that talks to IndexedDB.
// Loads as a classic browser script and as a CommonJS module for the Node tests
// (which use fake-indexeddb).
//
// Stores
//   titles     key 'movie:<id>' | 'tv:<id>'   one record per movie or series
//   progress   key = title key                series only: season, episode, seasons
//   watch_log  auto id, append-only           { titleKey, season, episode, at }
//   lists      auto id                        { id, name, createdAt }
//   list_items auto id                        { id, listId, titleKey, position }
//   cache      key                            TMDB responses with an expiry
//
// Style: flat top-level functions. IndexedDB's event callbacks are attached
// with .bind() so no function is defined inside another function.
// Every function that fails throws a DbError with a short .code.

'use strict';

var DB_NAME = 'queued-db';
var DB_VERSION = 1;
var STATUSES = ['watchlist', 'watching', 'watched'];
var TITLE_KEY_PATTERN = /^(movie|tv):[1-9][0-9]*$/;

var dbPromise = null;

class DbError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DbError';
    this.code = code;
  }
}

// ---------- plumbing ----------

// IndexedDB error names mapped to codes the UI can act on.
function wrapError(err) {
  var name = err && err.name ? err.name : '';
  var message = err && err.message ? err.message : 'IndexedDB error';
  if (name === 'ConstraintError') return new DbError('CONSTRAINT', message);
  if (name === 'QuotaExceededError') return new DbError('QUOTA', message);
  return new DbError('IDB_ERROR', message);
}

function onRequestSuccess(resolve, event) {
  resolve(event.target.result);
}

function onRequestFail(reject, event) {
  reject(wrapError(event.target.error));
}

function requestExecutor(request, resolve, reject) {
  request.onsuccess = onRequestSuccess.bind(null, resolve);
  request.onerror = onRequestFail.bind(null, reject);
}

function requestToPromise(request) {
  return new Promise(requestExecutor.bind(null, request));
}

function onTxComplete(resolve) {
  resolve();
}

function txExecutor(tx, resolve, reject) {
  tx.oncomplete = onTxComplete.bind(null, resolve);
  tx.onerror = onRequestFail.bind(null, reject);
  tx.onabort = onRequestFail.bind(null, reject);
}

// Resolves when the transaction has committed, rejects if it fails or aborts.
// Call it before issuing requests, then await it at the end.
function txDone(tx) {
  return new Promise(txExecutor.bind(null, tx));
}

function handleUpgradeNeeded(event) {
  // Version 1 creates everything. Future versions: branch on event.oldVersion.
  var db = event.target.result;

  var titles = db.createObjectStore('titles', { keyPath: 'key' });
  titles.createIndex('status', 'status');
  titles.createIndex('type', 'type');

  db.createObjectStore('progress', { keyPath: 'key' });

  var log = db.createObjectStore('watch_log', { keyPath: 'id', autoIncrement: true });
  log.createIndex('titleKey', 'titleKey');
  log.createIndex('at', 'at');

  db.createObjectStore('lists', { keyPath: 'id', autoIncrement: true });

  var items = db.createObjectStore('list_items', { keyPath: 'id', autoIncrement: true });
  items.createIndex('listId', 'listId');
  items.createIndex('titleKey', 'titleKey');

  var cache = db.createObjectStore('cache', { keyPath: 'key' });
  cache.createIndex('expiresAt', 'expiresAt');
}

// Another tab wants to upgrade or delete the database: let go of it.
function handleVersionChange(event) {
  event.target.close();
  dbPromise = null;
}

function onOpenSuccess(resolve, event) {
  var db = event.target.result;
  db.onversionchange = handleVersionChange;
  resolve(db);
}

function onOpenFail(reject, event) {
  dbPromise = null;
  reject(wrapError(event.target.error));
}

function onOpenBlocked(reject) {
  dbPromise = null;
  reject(new DbError('BLOCKED', 'Close other tabs using Queued and try again.'));
}

function openExecutor(resolve, reject) {
  var request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = handleUpgradeNeeded;
  request.onsuccess = onOpenSuccess.bind(null, resolve);
  request.onerror = onOpenFail.bind(null, reject);
  request.onblocked = onOpenBlocked.bind(null, reject);
}

function openDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new DbError('UNAVAILABLE', 'IndexedDB is not available.'));
  }
  dbPromise = new Promise(openExecutor);
  return dbPromise;
}

async function closeDb() {
  if (!dbPromise) return;
  var db = await dbPromise;
  db.close();
  dbPromise = null;
}

function onDeleteSuccess(resolve) {
  resolve();
}

function onDeleteFail(reject, event) {
  reject(wrapError(event.target.error));
}

function onDeleteBlocked(reject) {
  reject(new DbError('BLOCKED', 'Close other tabs using Queued and try again.'));
}

function deleteExecutor(resolve, reject) {
  var request = indexedDB.deleteDatabase(DB_NAME);
  request.onsuccess = onDeleteSuccess.bind(null, resolve);
  request.onerror = onDeleteFail.bind(null, reject);
  request.onblocked = onDeleteBlocked.bind(null, reject);
}

// Erases the whole library. For "erase all data" and for tests.
async function deleteDb() {
  await closeDb();
  await new Promise(deleteExecutor);
}

// Asks the browser not to evict our data. May be refused; returns true/false.
async function requestPersistentStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage) return false;
  if (typeof navigator.storage.persist !== 'function') return false;
  try {
    return await navigator.storage.persist();
  } catch (err) {
    return false;
  }
}

// ---------- title keys and validation ----------

function makeTitleKey(type, tmdbId) {
  if (type !== 'movie' && type !== 'tv') {
    throw new DbError('INVALID', 'type must be "movie" or "tv"');
  }
  if (!Number.isInteger(tmdbId) || tmdbId < 1) {
    throw new DbError('INVALID', 'tmdbId must be a positive integer');
  }
  return type + ':' + tmdbId;
}

function isValidStatus(status) {
  return STATUSES.indexOf(status) !== -1;
}

function validateTitleRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new DbError('INVALID', 'title record is required');
  }
  if (typeof record.key !== 'string' || !TITLE_KEY_PATTERN.test(record.key)) {
    throw new DbError('INVALID', 'key must look like "movie:123" or "tv:123"');
  }
  if (record.key.split(':')[0] !== record.type) {
    throw new DbError('INVALID', 'type does not match key');
  }
  if (!isValidStatus(record.status)) {
    throw new DbError('INVALID', 'status must be watchlist, watching or watched');
  }
}

function nowIso() {
  return new Date().toISOString();
}

// ---------- titles ----------

async function getTitle(key) {
  var db = await openDb();
  var tx = db.transaction('titles', 'readonly');
  var record = await requestToPromise(tx.objectStore('titles').get(key));
  return record || null;
}

async function getAllTitles() {
  var db = await openDb();
  var tx = db.transaction('titles', 'readonly');
  return requestToPromise(tx.objectStore('titles').getAll());
}

async function getTitlesByStatus(status) {
  if (!isValidStatus(status)) throw new DbError('INVALID', 'unknown status');
  var db = await openDb();
  var tx = db.transaction('titles', 'readonly');
  return requestToPromise(tx.objectStore('titles').index('status').getAll(status));
}

// Adds a new title. Throws DUPLICATE if the key is already in the library.
async function addTitle(record) {
  validateTitleRecord(record);
  var now = nowIso();
  var full = Object.assign({}, record, {
    addedAt: record.addedAt || now,
    updatedAt: now
  });
  var db = await openDb();
  var tx = db.transaction('titles', 'readwrite');
  var done = txDone(tx);
  tx.objectStore('titles').add(full);
  try {
    await done;
  } catch (err) {
    if (err.code === 'CONSTRAINT') {
      throw new DbError('DUPLICATE', 'Already in your library: ' + record.key);
    }
    throw err;
  }
  return full;
}

// Merges changes into an existing title. key, type and addedAt cannot change.
async function updateTitle(key, changes) {
  if (changes && changes.status !== undefined && !isValidStatus(changes.status)) {
    throw new DbError('INVALID', 'status must be watchlist, watching or watched');
  }
  var db = await openDb();
  var tx = db.transaction('titles', 'readwrite');
  var done = txDone(tx);
  var store = tx.objectStore('titles');
  var existing = await requestToPromise(store.get(key));
  if (!existing) {
    await done;
    throw new DbError('NOT_FOUND', 'No such title: ' + key);
  }
  var merged = Object.assign({}, existing, changes, {
    key: existing.key,
    type: existing.type,
    addedAt: existing.addedAt,
    updatedAt: nowIso()
  });
  store.put(merged);
  await done;
  return merged;
}

function setStatus(key, status) {
  return updateTitle(key, { status: status });
}

// Removes a title and everything that hangs off it: progress, log entries and
// its place in any lists. Returns true if the title existed.
async function removeTitle(key) {
  var db = await openDb();
  var names = ['titles', 'progress', 'watch_log', 'list_items'];
  var tx = db.transaction(names, 'readwrite');
  var done = txDone(tx);
  var titles = tx.objectStore('titles');
  var log = tx.objectStore('watch_log');
  var items = tx.objectStore('list_items');

  var existing = await requestToPromise(titles.get(key));
  titles.delete(key);
  tx.objectStore('progress').delete(key);

  var logIds = await requestToPromise(log.index('titleKey').getAllKeys(key));
  for (var i = 0; i < logIds.length; i++) log.delete(logIds[i]);

  var itemIds = await requestToPromise(items.index('titleKey').getAllKeys(key));
  for (var j = 0; j < itemIds.length; j++) items.delete(itemIds[j]);

  await done;
  return !!existing;
}

// ---------- progress and watch log ----------

async function getProgress(key) {
  var db = await openDb();
  var tx = db.transaction('progress', 'readonly');
  var record = await requestToPromise(tx.objectStore('progress').get(key));
  return record || null;
}

function makeProgressRecord(key, pointer, seasons) {
  return {
    key: key,
    season: pointer.season,
    episode: pointer.episode,
    seasons: Array.isArray(seasons) ? seasons : [],
    updatedAt: nowIso()
  };
}

// Saves the pointer without logging (initial progress, stepper edits, undo).
// seasons = [{ number, episodeCount }] in the shape progress.js uses.
async function saveProgress(key, pointer, seasons) {
  var db = await openDb();
  var tx = db.transaction('progress', 'readwrite');
  var done = txDone(tx);
  tx.objectStore('progress').put(makeProgressRecord(key, pointer, seasons));
  await done;
}

// "Next episode" tap: saves the new pointer and appends a dated log entry,
// atomically (both happen or neither).
async function commitEpisode(key, pointer, seasons) {
  var db = await openDb();
  var tx = db.transaction(['progress', 'watch_log'], 'readwrite');
  var done = txDone(tx);
  tx.objectStore('progress').put(makeProgressRecord(key, pointer, seasons));
  tx.objectStore('watch_log').add({
    titleKey: key,
    season: pointer.season,
    episode: pointer.episode,
    at: nowIso()
  });
  await done;
}

// Sets status to watched. A movie also gets a log entry (season and episode
// null); a series' episodes are already in the log from commitEpisode.
async function markWatched(key) {
  var db = await openDb();
  var tx = db.transaction(['titles', 'watch_log'], 'readwrite');
  var done = txDone(tx);
  var titles = tx.objectStore('titles');
  var existing = await requestToPromise(titles.get(key));
  if (!existing) {
    await done;
    throw new DbError('NOT_FOUND', 'No such title: ' + key);
  }
  var now = nowIso();
  var updated = Object.assign({}, existing, { status: 'watched', updatedAt: now });
  titles.put(updated);
  if (existing.type === 'movie') {
    tx.objectStore('watch_log').add({ titleKey: key, season: null, episode: null, at: now });
  }
  await done;
  return updated;
}

// Log entries, oldest first. Pass a title key to get just that title's.
async function getWatchLog(titleKey) {
  var db = await openDb();
  var tx = db.transaction('watch_log', 'readonly');
  var store = tx.objectStore('watch_log');
  if (titleKey === undefined) return requestToPromise(store.getAll());
  return requestToPromise(store.index('titleKey').getAll(titleKey));
}

// ---------- lists ----------

function compareByPosition(a, b) {
  return a.position - b.position;
}

async function createList(name) {
  var clean = typeof name === 'string' ? name.trim() : '';
  if (clean === '') throw new DbError('INVALID', 'List name is required');
  var db = await openDb();
  var tx = db.transaction('lists', 'readwrite');
  var done = txDone(tx);
  var record = { name: clean, createdAt: nowIso() };
  var request = tx.objectStore('lists').add(record);
  var id = await requestToPromise(request);
  await done;
  return Object.assign({ id: id }, record);
}

async function getLists() {
  var db = await openDb();
  var tx = db.transaction('lists', 'readonly');
  return requestToPromise(tx.objectStore('lists').getAll());
}

async function renameList(listId, name) {
  var clean = typeof name === 'string' ? name.trim() : '';
  if (clean === '') throw new DbError('INVALID', 'List name is required');
  var db = await openDb();
  var tx = db.transaction('lists', 'readwrite');
  var done = txDone(tx);
  var store = tx.objectStore('lists');
  var existing = await requestToPromise(store.get(listId));
  if (!existing) {
    await done;
    throw new DbError('NOT_FOUND', 'No such list');
  }
  var updated = Object.assign({}, existing, { name: clean });
  store.put(updated);
  await done;
  return updated;
}

// Deletes a list and its items. The titles themselves stay in the library.
async function deleteList(listId) {
  var db = await openDb();
  var tx = db.transaction(['lists', 'list_items'], 'readwrite');
  var done = txDone(tx);
  var items = tx.objectStore('list_items');
  var itemIds = await requestToPromise(items.index('listId').getAllKeys(listId));
  for (var i = 0; i < itemIds.length; i++) items.delete(itemIds[i]);
  tx.objectStore('lists').delete(listId);
  await done;
}

// Items of a list, in their saved order.
async function getListItems(listId) {
  var db = await openDb();
  var tx = db.transaction('list_items', 'readonly');
  var items = await requestToPromise(tx.objectStore('list_items').index('listId').getAll(listId));
  items.sort(compareByPosition);
  return items;
}

// Ids of the lists that contain this title (for the "Add to list" sheet).
async function getListIdsForTitle(titleKey) {
  var db = await openDb();
  var tx = db.transaction('list_items', 'readonly');
  var items = await requestToPromise(tx.objectStore('list_items').index('titleKey').getAll(titleKey));
  var ids = [];
  for (var i = 0; i < items.length; i++) ids.push(items[i].listId);
  return ids;
}

// Adds a title (already in the library) to the end of a list.
// Throws NOT_FOUND for an unknown list or title, DUPLICATE if already in it.
async function addToList(listId, titleKey) {
  var db = await openDb();
  var tx = db.transaction(['lists', 'titles', 'list_items'], 'readwrite');
  var done = txDone(tx);
  var list = await requestToPromise(tx.objectStore('lists').get(listId));
  var title = await requestToPromise(tx.objectStore('titles').get(titleKey));
  var items = tx.objectStore('list_items');
  var current = await requestToPromise(items.index('listId').getAll(listId));
  var error = null;
  var next = 0;
  if (!list) {
    error = new DbError('NOT_FOUND', 'No such list');
  } else if (!title) {
    error = new DbError('NOT_FOUND', 'No such title: ' + titleKey);
  } else {
    for (var i = 0; i < current.length; i++) {
      if (current[i].titleKey === titleKey) error = new DbError('DUPLICATE', 'Already in this list');
      if (current[i].position >= next) next = current[i].position + 1;
    }
  }
  if (error) {
    await done;
    throw error;
  }
  var record = { listId: listId, titleKey: titleKey, position: next };
  var id = await requestToPromise(items.add(record));
  await done;
  return Object.assign({ id: id }, record);
}

async function removeFromList(listId, titleKey) {
  var db = await openDb();
  var tx = db.transaction('list_items', 'readwrite');
  var done = txDone(tx);
  var items = tx.objectStore('list_items');
  var current = await requestToPromise(items.index('listId').getAll(listId));
  for (var i = 0; i < current.length; i++) {
    if (current[i].titleKey === titleKey) items.delete(current[i].id);
  }
  await done;
}

// Reorders a list. orderedKeys goes first, in that order; any items it does not
// mention keep their relative order after them. Positions are renumbered 0..n-1.
async function reorderList(listId, orderedKeys) {
  var db = await openDb();
  var tx = db.transaction('list_items', 'readwrite');
  var done = txDone(tx);
  var store = tx.objectStore('list_items');
  var items = await requestToPromise(store.index('listId').getAll(listId));
  items.sort(compareByPosition);

  var byKey = {};
  for (var i = 0; i < items.length; i++) byKey[items[i].titleKey] = items[i];

  var seen = {};
  var ordered = [];
  var wanted = Array.isArray(orderedKeys) ? orderedKeys : [];
  for (var j = 0; j < wanted.length; j++) {
    if (byKey[wanted[j]] && !seen[wanted[j]]) {
      ordered.push(byKey[wanted[j]]);
      seen[wanted[j]] = true;
    }
  }
  for (var k = 0; k < items.length; k++) {
    if (!seen[items[k].titleKey]) ordered.push(items[k]);
  }
  for (var m = 0; m < ordered.length; m++) {
    ordered[m].position = m;
    store.put(ordered[m]);
  }
  await done;
  return ordered;
}

// ---------- cache (TMDB responses for people and franchises) ----------

// Returns the cached data, or null if missing or expired.
async function getCache(key) {
  var db = await openDb();
  var tx = db.transaction('cache', 'readonly');
  var record = await requestToPromise(tx.objectStore('cache').get(key));
  if (!record) return null;
  if (record.expiresAt <= Date.now()) return null;
  return record.data;
}

async function putCache(key, data, ttlMs) {
  var db = await openDb();
  var tx = db.transaction('cache', 'readwrite');
  var done = txDone(tx);
  var now = Date.now();
  tx.objectStore('cache').put({
    key: key,
    data: data,
    fetchedAt: now,
    expiresAt: now + ttlMs
  });
  await done;
}

// Deletes expired entries. Returns how many were removed.
async function purgeExpiredCache() {
  var db = await openDb();
  var tx = db.transaction('cache', 'readwrite');
  var done = txDone(tx);
  var store = tx.objectStore('cache');
  var expired = await requestToPromise(
    store.index('expiresAt').getAllKeys(IDBKeyRange.upperBound(Date.now()))
  );
  for (var i = 0; i < expired.length; i++) store.delete(expired[i]);
  await done;
  return expired.length;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STATUSES: STATUSES,
    DbError: DbError,
    openDb: openDb,
    closeDb: closeDb,
    deleteDb: deleteDb,
    requestPersistentStorage: requestPersistentStorage,
    makeTitleKey: makeTitleKey,
    getTitle: getTitle,
    getAllTitles: getAllTitles,
    getTitlesByStatus: getTitlesByStatus,
    addTitle: addTitle,
    updateTitle: updateTitle,
    setStatus: setStatus,
    removeTitle: removeTitle,
    getProgress: getProgress,
    saveProgress: saveProgress,
    commitEpisode: commitEpisode,
    markWatched: markWatched,
    getWatchLog: getWatchLog,
    createList: createList,
    getLists: getLists,
    renameList: renameList,
    deleteList: deleteList,
    getListItems: getListItems,
    getListIdsForTitle: getListIdsForTitle,
    addToList: addToList,
    removeFromList: removeFromList,
    reorderList: reorderList,
    getCache: getCache,
    putCache: putCache,
    purgeExpiredCache: purgeExpiredCache
  };
}
