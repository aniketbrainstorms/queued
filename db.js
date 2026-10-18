// db.js: IndexedDB access for Queued. The only file that talks to IndexedDB.
// Loads as a classic browser script and as a CommonJS module for the Node tests
// (which use fake-indexeddb).
//
// Stores
//   titles     key 'movie:<id>' | 'tv:<id>'   one record per movie or series
//   progress   key = title key                series only: season, episode, seasons
//   watch_log  auto id, append-only           { titleKey, season, episode, at }
//   viewings   key = id ('v_...')             one record per time a movie was watched (see viewings.js)
//   lists      auto id                        { id, name, createdAt }
//   list_items auto id                        { id, listId, titleKey, position }
//   cache      key                            TMDB responses with an expiry
//
// Style: flat top-level functions. IndexedDB's event callbacks are attached
// with .bind() so no function is defined inside another function.
// Every function that fails throws a DbError with a short .code.

'use strict';

var DB_NAME = 'queued-db';
var DB_VERSION = 2;
var STATUSES = ['watchlist', 'watching', 'watched'];
var TITLE_KEY_PATTERN = /^(movie|tv):[1-9][0-9]*$/;

// Backup file format. Bump EXPORT_VERSION when the file shape changes.
var EXPORT_APP = 'queued';
var EXPORT_VERSION = 2;

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

// Reaches viewings.js in both environments: require() under Node, the globals
// defined by the earlier <script> tag in the browser.
function viewingsLib() {
  if (typeof module !== 'undefined' && module.exports) return require('./viewings.js');
  return {
    cleanViewing: cleanViewing,
    makeBareViewing: makeBareViewing,
    makeViewingId: makeViewingId,
    localDateString: localDateString,
    filmRatingFromViewings: filmRatingFromViewings,
    compareViewingsNewestFirst: compareViewingsNewestFirst
  };
}

function handleUpgradeNeeded(event) {
  var db = event.target.result;
  if (event.oldVersion < 1) createVersion1Stores(db);
  if (event.oldVersion < 2) {
    var viewings = db.createObjectStore('viewings', { keyPath: 'id' });
    viewings.createIndex('titleKey', 'titleKey');
    viewings.createIndex('watchedOn', 'watchedOn');
    // A brand new database has no films to carry over.
    if (event.oldVersion >= 1) startViewingsMigration(event.target.transaction);
  }
}

function createVersion1Stores(db) {
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

// ----- version 2: one bare viewing for each film already marked watched -----

// Runs inside the upgrade transaction. If anything fails the transaction is
// aborted, so the upgrade fails as a whole and the database stays at version 1.
function startViewingsMigration(tx) {
  addMissingBareViewings(tx).catch(abortQuietly.bind(null, tx));
}

// The latest log date for each movie: { 'movie:1': '2026-04-10T12:00:00.000Z' }.
function latestMovieLogDates(entries) {
  var latest = Object.create(null);
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.season !== null || entry.episode !== null) continue;
    if (!latest[entry.titleKey] || timeOf(entry.at) > timeOf(latest[entry.titleKey])) {
      latest[entry.titleKey] = entry.at;
    }
  }
  return latest;
}

// The day a watched film was probably watched: its latest log entry, else when
// the title was last updated. Never later than today.
function guessWatchedOn(title, latest, today) {
  var source = latest[title.key] || title.updatedAt || title.addedAt;
  if (!isValidDate(source)) return today;
  var day = viewingsLib().localDateString(new Date(source));
  return day > today ? today : day;
}

// Gives every watched movie that has no viewing one bare viewing. Used by the
// version 2 upgrade and after an import. Runs inside the caller's transaction
// (titles, watch_log and viewings). Returns how many it added.
async function addMissingBareViewings(tx) {
  var lib = viewingsLib();
  var titles = await requestToPromise(tx.objectStore('titles').index('status').getAll('watched'));
  var held = await requestToPromise(tx.objectStore('viewings').getAll());
  var entries = await requestToPromise(tx.objectStore('watch_log').getAll());
  var hasViewing = Object.create(null);
  for (var i = 0; i < held.length; i++) hasViewing[held[i].titleKey] = true;
  var latest = latestMovieLogDates(entries);
  var store = tx.objectStore('viewings');
  var now = nowIso();
  var today = lib.localDateString(new Date());
  var added = 0;
  for (var j = 0; j < titles.length; j++) {
    if (titles[j].type !== 'movie' || hasViewing[titles[j].key]) continue;
    var day = guessWatchedOn(titles[j], latest, today);
    var id = lib.makeViewingId(Date.now(), Math.random());
    store.add(lib.makeBareViewing(titles[j].key, id, { today: day, now: now }));
    added++;
  }
  return added;
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

// Milliseconds for an ISO date string; 0 when it is missing or unreadable.
function timeOf(iso) {
  var ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function isValidDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// Oldest first by date. Ties keep insertion order (the auto id).
function compareLogEntries(a, b) {
  var diff = timeOf(a.at) - timeOf(b.at);
  if (diff !== 0) return diff;
  return a.id - b.id;
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
  var tx = db.transaction(['titles', 'viewings'], 'readwrite');
  var done = txDone(tx);
  tx.objectStore('titles').add(full);
  if (full.type === 'movie' && full.status === 'watched') addBareViewing(tx, full.key, now);
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
  var tx = db.transaction(['titles', 'viewings'], 'readwrite');
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
  var becameWatched = existing.type === 'movie' && existing.status !== 'watched' && merged.status === 'watched';
  if (becameWatched) addBareViewing(tx, key, merged.updatedAt);
  await done;
  return merged;
}

function setStatus(key, status) {
  return updateTitle(key, { status: status });
}

// Removes a title and everything that hangs off it: progress, log entries,
// viewings and its place in any lists. Returns true if the title existed.
async function removeTitle(key) {
  var db = await openDb();
  var names = ['titles', 'progress', 'watch_log', 'list_items', 'viewings'];
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

  var viewingStore = tx.objectStore('viewings');
  var viewingIds = await requestToPromise(viewingStore.index('titleKey').getAllKeys(key));
  for (var k = 0; k < viewingIds.length; k++) viewingStore.delete(viewingIds[k]);

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

// Undo of a "Next episode" tap: saves the earlier pointer and removes the log
// entry that tap made, atomically. The newest log entry is removed only when it
// matches the position being undone, so a pointer moved by the stepper (which
// logs nothing) never costs an unrelated log entry.
// Returns { removedLogEntry: true | false }.
async function undoEpisode(key, pointer, seasons) {
  var db = await openDb();
  var tx = db.transaction(['progress', 'watch_log'], 'readwrite');
  var done = txDone(tx);
  var progress = tx.objectStore('progress');
  var log = tx.objectStore('watch_log');
  var current = await requestToPromise(progress.get(key));
  var entries = await requestToPromise(log.index('titleKey').getAll(key));
  entries.sort(compareLogEntries);
  var latest = entries.length > 0 ? entries[entries.length - 1] : null;
  var removed = false;
  if (current && latest && latest.season === current.season && latest.episode === current.episode) {
    log.delete(latest.id);
    removed = true;
  }
  progress.put(makeProgressRecord(key, pointer, seasons));
  await done;
  return { removedLogEntry: removed };
}

// Sets status to watched. A movie also gets a log entry (season and episode
// null) and, unless it was already watched, a bare viewing dated today; a
// series' episodes are already in the log from commitEpisode.
async function markWatched(key) {
  var db = await openDb();
  var tx = db.transaction(['titles', 'watch_log', 'viewings'], 'readwrite');
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
    if (existing.status !== 'watched') addBareViewing(tx, key, now);
  }
  await done;
  return updated;
}

// Log entries, oldest first by date (an import can add older entries after
// newer ones, so the auto id alone is not a safe order). Pass a title key to
// get just that title's.
async function getWatchLog(titleKey) {
  var db = await openDb();
  var tx = db.transaction('watch_log', 'readonly');
  var store = tx.objectStore('watch_log');
  var entries;
  if (titleKey === undefined) {
    entries = await requestToPromise(store.getAll());
  } else {
    entries = await requestToPromise(store.index('titleKey').getAll(titleKey));
  }
  entries.sort(compareLogEntries);
  return entries;
}

// ---------- viewings ----------

// Sets the film's own rating to the rating on its latest rated viewing (or
// null). Runs inside the caller's transaction, after its viewing write.
async function syncFilmRating(tx, titleKey, now) {
  var titles = tx.objectStore('titles');
  var title = await requestToPromise(titles.get(titleKey));
  if (!title) return;
  var list = await requestToPromise(tx.objectStore('viewings').index('titleKey').getAll(titleKey));
  var rating = viewingsLib().filmRatingFromViewings(list);
  var current = title.rating === undefined ? null : title.rating;
  if (current === rating) return;
  titles.put(Object.assign({}, title, { rating: rating, updatedAt: now }));
}

function viewingContext(now) {
  return { today: viewingsLib().localDateString(new Date()), now: now };
}

// Adds a viewing with no details, dated today, inside the caller's transaction
// (which must include the viewings store). Made whenever a movie becomes
// Watched, so every watched film is counted even if the user skips the details.
function addBareViewing(tx, titleKey, now) {
  var lib = viewingsLib();
  var id = lib.makeViewingId(Date.now(), Math.random());
  tx.objectStore('viewings').add(lib.makeBareViewing(titleKey, id, viewingContext(now)));
}

// input: the viewing's fields without id, createdAt and updatedAt (the id and
// both dates are made here). The film must be in the library.
async function addViewing(input) {
  var lib = viewingsLib();
  var now = nowIso();
  var raw = Object.assign({}, input, {
    id: lib.makeViewingId(Date.now(), Math.random()),
    createdAt: now,
    updatedAt: now
  });
  var clean = lib.cleanViewing(raw, viewingContext(now));
  if (clean.error) throw new DbError('INVALID', clean.error);

  var db = await openDb();
  var tx = db.transaction(['titles', 'viewings'], 'readwrite');
  var done = txDone(tx);
  var title = await requestToPromise(tx.objectStore('titles').get(clean.value.titleKey));
  if (!title) {
    await done;
    throw new DbError('NOT_FOUND', 'No such title: ' + clean.value.titleKey);
  }
  tx.objectStore('viewings').add(clean.value);
  await syncFilmRating(tx, clean.value.titleKey, now);
  await done;
  return clean.value;
}

// Merges changes into a viewing. id, titleKey and createdAt cannot change.
// Changing where drops the fields that belong to the other place.
async function updateViewing(id, changes) {
  var lib = viewingsLib();
  var now = nowIso();
  var db = await openDb();
  var tx = db.transaction(['titles', 'viewings'], 'readwrite');
  var done = txDone(tx);
  var store = tx.objectStore('viewings');
  var existing = await requestToPromise(store.get(id));
  if (!existing) {
    await done;
    throw new DbError('NOT_FOUND', 'No such viewing: ' + id);
  }
  var merged = Object.assign({}, existing, changes, {
    id: existing.id,
    titleKey: existing.titleKey,
    createdAt: existing.createdAt,
    updatedAt: now
  });
  var clean = lib.cleanViewing(merged, viewingContext(now));
  if (clean.error) {
    abortQuietly(tx);
    await settleQuietly(done);
    throw new DbError('INVALID', clean.error);
  }
  store.put(clean.value);
  await syncFilmRating(tx, existing.titleKey, now);
  await done;
  return clean.value;
}

// Returns true if the viewing existed. The film's status is not touched.
async function deleteViewing(id) {
  var db = await openDb();
  var tx = db.transaction(['titles', 'viewings'], 'readwrite');
  var done = txDone(tx);
  var store = tx.objectStore('viewings');
  var existing = await requestToPromise(store.get(id));
  if (existing) {
    store.delete(id);
    await syncFilmRating(tx, existing.titleKey, nowIso());
  }
  await done;
  return !!existing;
}

// A film's viewings, newest first.
async function getViewings(titleKey) {
  var db = await openDb();
  var tx = db.transaction('viewings', 'readonly');
  var list = await requestToPromise(tx.objectStore('viewings').index('titleKey').getAll(titleKey));
  return list.sort(viewingsLib().compareViewingsNewestFirst);
}

// One viewing by id, or null.
async function getViewing(id) {
  var db = await openDb();
  var tx = db.transaction('viewings', 'readonly');
  var found = await requestToPromise(tx.objectStore('viewings').get(id));
  return found || null;
}

// Every viewing, newest first.
async function getAllViewings() {
  var db = await openDb();
  var tx = db.transaction('viewings', 'readonly');
  var list = await requestToPromise(tx.objectStore('viewings').getAll());
  return list.sort(viewingsLib().compareViewingsNewestFirst);
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

// ---------- export and import (backup file) ----------
//
// File shape (JSON):
//   { app: 'queued', version, exportedAt,
//     titles:    [titles records],
//     progress:  [progress records],
//     watchLog:  [{ titleKey, season, episode, at }]        (no ids)
//     lists:     [{ id, name, createdAt }]                  (id only links items)
//     listItems: [{ listId, titleKey, position }],
//     viewings:  [viewing records, see viewings.js]          (version 2 and later)
//   }
//   viewings  matched by id: new ids are added, existing ones are left alone. A
//             viewing that is invalid, or whose film is in neither the file nor
//             the library, is skipped (counted in summary.skipped). Afterwards
//             every watched movie with no viewing gets one bare viewing, which is
//             how a version 1 backup becomes complete.
// The cache is not exported, and neither is the TMDB key (it is not in this
// database at all).
//
// Import merges into the library; it never deletes anything.
//   titles    new key: added. Same key: the newer updatedAt wins, and addedAt
//             keeps the earlier of the two.
//   progress  the furthest (season, episode) wins; the seasons list comes from
//             whichever record is newer.
//   watchLog  entries are added unless an identical one (title, season,
//             episode, time) is already there.
//   lists     matched by name (ignoring case and outer spaces). Missing titles
//             are appended to the end of the matching list, in the file's order.
//             Unmatched lists are created.
// Progress, log entries and list items that point at a title that is in neither
// the file nor the library are skipped (counted in summary.skipped).
// The whole file is checked before anything is written, and the merge runs in
// one transaction: it all lands or none of it does.

async function exportAll() {
  var db = await openDb();
  var tx = db.transaction(['titles', 'progress', 'watch_log', 'lists', 'list_items', 'viewings'], 'readonly');
  // Every request gets its handler at once (inside requestToPromise), so no
  // result can arrive before something is listening.
  var parts = await Promise.all([
    requestToPromise(tx.objectStore('titles').getAll()),
    requestToPromise(tx.objectStore('progress').getAll()),
    requestToPromise(tx.objectStore('watch_log').getAll()),
    requestToPromise(tx.objectStore('lists').getAll()),
    requestToPromise(tx.objectStore('list_items').getAll()),
    requestToPromise(tx.objectStore('viewings').getAll())
  ]);

  var log = parts[2];
  log.sort(compareLogEntries);
  var watchLog = [];
  for (var i = 0; i < log.length; i++) {
    watchLog.push({
      titleKey: log[i].titleKey,
      season: log[i].season,
      episode: log[i].episode,
      at: log[i].at
    });
  }

  var items = parts[4];
  items.sort(compareByPosition);
  var listItems = [];
  for (var j = 0; j < items.length; j++) {
    listItems.push({ listId: items[j].listId, titleKey: items[j].titleKey, position: items[j].position });
  }

  return {
    app: EXPORT_APP,
    version: EXPORT_VERSION,
    exportedAt: nowIso(),
    titles: parts[0],
    progress: parts[1],
    watchLog: watchLog,
    lists: parts[3],
    listItems: listItems,
    viewings: parts[5].sort(viewingsLib().compareViewingsNewestFirst)
  };
}

// ----- reading and checking the file -----

function parseBackup(input) {
  var data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (err) {
      throw new DbError('INVALID', 'That file is not valid JSON.');
    }
  }
  if (!data || typeof data !== 'object' || data.app !== EXPORT_APP) {
    throw new DbError('INVALID', 'That file is not a Queued backup.');
  }
  if (!Number.isInteger(data.version) || data.version < 1) {
    throw new DbError('INVALID', 'The backup has no valid version.');
  }
  if (data.version > EXPORT_VERSION) {
    throw new DbError('INVALID', 'This backup was made by a newer version of Queued.');
  }
  return data;
}

function readBackupArray(data, name) {
  var value = data[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DbError('INVALID', 'Backup field "' + name + '" must be a list.');
  }
  return value;
}

function badRecord(name, index, detail) {
  return new DbError('INVALID', 'Backup ' + name + ' #' + (index + 1) + ': ' + detail);
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function isTitleKey(value) {
  return typeof value === 'string' && TITLE_KEY_PATTERN.test(value);
}

function cleanImportedTitle(raw, index, now) {
  if (!raw || typeof raw !== 'object') throw badRecord('titles', index, 'not a record');
  try {
    validateTitleRecord(raw);
  } catch (err) {
    throw badRecord('titles', index, err.message);
  }
  var addedAt = isValidDate(raw.addedAt) ? raw.addedAt : now;
  var updatedAt = isValidDate(raw.updatedAt) ? raw.updatedAt : addedAt;
  return Object.assign({}, raw, { addedAt: addedAt, updatedAt: updatedAt });
}

function cleanImportedProgress(raw, index, now) {
  if (!raw || typeof raw !== 'object') throw badRecord('progress', index, 'not a record');
  if (!isTitleKey(raw.key) || raw.key.indexOf('tv:') !== 0) {
    throw badRecord('progress', index, 'key must look like "tv:123"');
  }
  if (!isCount(raw.season) || !isCount(raw.episode)) {
    throw badRecord('progress', index, 'season and episode must be whole numbers');
  }
  return {
    key: raw.key,
    season: raw.season,
    episode: raw.episode,
    seasons: Array.isArray(raw.seasons) ? raw.seasons : [],
    updatedAt: isValidDate(raw.updatedAt) ? raw.updatedAt : now
  };
}

function cleanImportedLogEntry(raw, index) {
  if (!raw || typeof raw !== 'object') throw badRecord('watchLog', index, 'not a record');
  if (!isTitleKey(raw.titleKey)) throw badRecord('watchLog', index, 'titleKey is not a valid key');
  if (!isValidDate(raw.at)) throw badRecord('watchLog', index, 'at must be a date');
  var season = raw.season === undefined ? null : raw.season;
  var episode = raw.episode === undefined ? null : raw.episode;
  var bothEmpty = season === null && episode === null;
  if (!bothEmpty && !(isCount(season) && isCount(episode))) {
    throw badRecord('watchLog', index, 'season and episode must both be whole numbers, or both empty');
  }
  // Canonical date text, so the same moment always compares equal.
  return { titleKey: raw.titleKey, season: season, episode: episode, at: new Date(raw.at).toISOString() };
}

function cleanImportedList(raw, index, now) {
  if (!raw || typeof raw !== 'object') throw badRecord('lists', index, 'not a record');
  if (!Number.isInteger(raw.id)) throw badRecord('lists', index, 'id must be a whole number');
  var name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '') throw badRecord('lists', index, 'name is required');
  return { id: raw.id, name: name, createdAt: isValidDate(raw.createdAt) ? raw.createdAt : now };
}

function cleanImportedListItem(raw, index) {
  if (!raw || typeof raw !== 'object') throw badRecord('listItems', index, 'not a record');
  if (!Number.isInteger(raw.listId)) throw badRecord('listItems', index, 'listId must be a whole number');
  if (!isTitleKey(raw.titleKey)) throw badRecord('listItems', index, 'titleKey is not a valid key');
  var position = typeof raw.position === 'number' && Number.isFinite(raw.position) ? raw.position : 0;
  return { listId: raw.listId, titleKey: raw.titleKey, position: position };
}

// A viewing that fails the checks is skipped, not fatal: the rest of the file
// still imports. Returns the clean record or null.
function cleanImportedViewing(raw, now) {
  var out = viewingsLib().cleanViewing(raw, viewingContext(now));
  return out.error ? null : out.value;
}

// Checks the whole file and returns cleaned copies. Throws INVALID on the first
// problem, before anything is written. clean.badViewings counts viewings that
// were left out because they were invalid.
function cleanBackup(input) {
  var data = parseBackup(input);
  var now = nowIso();
  var clean = { titles: [], progress: [], watchLog: [], lists: [], listItems: [], viewings: [], badViewings: 0 };
  var titles = readBackupArray(data, 'titles');
  for (var a = 0; a < titles.length; a++) clean.titles.push(cleanImportedTitle(titles[a], a, now));
  var progress = readBackupArray(data, 'progress');
  for (var b = 0; b < progress.length; b++) clean.progress.push(cleanImportedProgress(progress[b], b, now));
  var log = readBackupArray(data, 'watchLog');
  for (var c = 0; c < log.length; c++) clean.watchLog.push(cleanImportedLogEntry(log[c], c));
  var lists = readBackupArray(data, 'lists');
  for (var d = 0; d < lists.length; d++) clean.lists.push(cleanImportedList(lists[d], d, now));
  var items = readBackupArray(data, 'listItems');
  for (var e = 0; e < items.length; e++) clean.listItems.push(cleanImportedListItem(items[e], e));
  var viewings = readBackupArray(data, 'viewings');
  for (var f = 0; f < viewings.length; f++) {
    var viewing = cleanImportedViewing(viewings[f], now);
    if (viewing) clean.viewings.push(viewing);
    else clean.badViewings++;
  }
  return clean;
}

// ----- merge rules (pure) -----

// The record to write for a title that exists on both sides, or null if the
// library's record should stay exactly as it is.
function mergeTitleRecords(existing, incoming) {
  var incomingWins = timeOf(incoming.updatedAt) > timeOf(existing.updatedAt);
  var winner = incomingWins ? incoming : existing;
  var addedAt = timeOf(incoming.addedAt) < timeOf(existing.addedAt) ? incoming.addedAt : existing.addedAt;
  if (!incomingWins && addedAt === existing.addedAt) return null;
  return Object.assign({}, winner, { addedAt: addedAt });
}

function comparePointers(a, b) {
  if (a.season !== b.season) return a.season - b.season;
  return a.episode - b.episode;
}

// The furthest pointer wins; the seasons list comes from the newer record
// (it is the fresher copy of TMDB's data). null means nothing to change.
function mergeProgressRecords(existing, incoming) {
  var incomingFurther = comparePointers(incoming, existing) > 0;
  var furthest = incomingFurther ? incoming : existing;
  var newer = timeOf(incoming.updatedAt) > timeOf(existing.updatedAt) ? incoming : existing;
  if (!incomingFurther && newer === existing) return null;
  return {
    key: existing.key,
    season: furthest.season,
    episode: furthest.episode,
    seasons: newer.seasons,
    updatedAt: newer.updatedAt
  };
}

function logEntryId(entry) {
  return entry.titleKey + '|' + entry.season + '|' + entry.episode + '|' + entry.at;
}

function listNameKey(name) {
  return name.trim().toLowerCase();
}

function getListState(states, listId) {
  if (!states[listId]) states[listId] = { keys: {}, next: 0 };
  return states[listId];
}

function emptyImportSummary() {
  return {
    titlesAdded: 0,
    titlesUpdated: 0,
    titlesKept: 0,
    progressWritten: 0,
    logAdded: 0,
    listsAdded: 0,
    listItemsAdded: 0,
    viewingsAdded: 0,
    viewingsCreated: 0,
    skipped: 0
  };
}

// ----- merge steps (inside the import transaction) -----

// Returns { 'movie:1': true, ... } for every title in the library afterwards.
async function mergeImportedTitles(tx, incoming, summary) {
  var store = tx.objectStore('titles');
  var existingList = await requestToPromise(store.getAll());
  var byKey = {};
  var known = {};
  for (var i = 0; i < existingList.length; i++) {
    byKey[existingList[i].key] = existingList[i];
    known[existingList[i].key] = true;
  }
  for (var j = 0; j < incoming.length; j++) {
    var rec = incoming[j];
    var existing = byKey[rec.key];
    if (!existing) {
      await requestToPromise(store.put(rec));
      byKey[rec.key] = rec;
      known[rec.key] = true;
      summary.titlesAdded++;
      continue;
    }
    var merged = mergeTitleRecords(existing, rec);
    if (merged) {
      await requestToPromise(store.put(merged));
      byKey[rec.key] = merged;
      summary.titlesUpdated++;
    } else {
      summary.titlesKept++;
    }
  }
  return known;
}

async function mergeImportedProgress(tx, incoming, known, summary) {
  var store = tx.objectStore('progress');
  var existingList = await requestToPromise(store.getAll());
  var byKey = {};
  for (var i = 0; i < existingList.length; i++) byKey[existingList[i].key] = existingList[i];
  for (var j = 0; j < incoming.length; j++) {
    var rec = incoming[j];
    if (!known[rec.key]) {
      summary.skipped++;
      continue;
    }
    var existing = byKey[rec.key];
    var toWrite = existing ? mergeProgressRecords(existing, rec) : rec;
    if (toWrite) {
      await requestToPromise(store.put(toWrite));
      byKey[rec.key] = toWrite;
      summary.progressWritten++;
    }
  }
}

async function mergeImportedLog(tx, incoming, known, summary) {
  var store = tx.objectStore('watch_log');
  var existingList = await requestToPromise(store.getAll());
  var seen = {};
  for (var i = 0; i < existingList.length; i++) seen[logEntryId(existingList[i])] = true;
  for (var j = 0; j < incoming.length; j++) {
    var entry = incoming[j];
    if (!known[entry.titleKey]) {
      summary.skipped++;
      continue;
    }
    var id = logEntryId(entry);
    if (seen[id]) continue;
    seen[id] = true;
    await requestToPromise(store.add(entry));
    summary.logAdded++;
  }
}

async function mergeImportedLists(tx, lists, listItems, known, summary) {
  var listStore = tx.objectStore('lists');
  var itemStore = tx.objectStore('list_items');
  var existingLists = await requestToPromise(listStore.getAll());
  var existingItems = await requestToPromise(itemStore.getAll());

  // Library lists by name (first one wins if the user has two with one name).
  var idByName = Object.create(null);
  for (var i = 0; i < existingLists.length; i++) {
    var nameKey = listNameKey(existingLists[i].name);
    if (idByName[nameKey] === undefined) idByName[nameKey] = existingLists[i].id;
  }

  // What each library list already holds, and where its next item goes.
  var states = {};
  for (var j = 0; j < existingItems.length; j++) {
    var held = getListState(states, existingItems[j].listId);
    held.keys[existingItems[j].titleKey] = true;
    if (existingItems[j].position >= held.next) held.next = existingItems[j].position + 1;
  }

  // File list id -> library list id, creating lists that do not exist yet.
  var targetIds = {};
  for (var k = 0; k < lists.length; k++) {
    var key = listNameKey(lists[k].name);
    if (idByName[key] === undefined) {
      idByName[key] = await requestToPromise(listStore.add({ name: lists[k].name, createdAt: lists[k].createdAt }));
      summary.listsAdded++;
    }
    targetIds[lists[k].id] = idByName[key];
  }

  var ordered = listItems.slice().sort(compareByPosition);
  for (var m = 0; m < ordered.length; m++) {
    var item = ordered[m];
    var target = targetIds[item.listId];
    if (target === undefined || !known[item.titleKey]) {
      summary.skipped++;
      continue;
    }
    var state = getListState(states, target);
    if (state.keys[item.titleKey]) continue;
    await requestToPromise(itemStore.add({ listId: target, titleKey: item.titleKey, position: state.next }));
    state.keys[item.titleKey] = true;
    state.next++;
    summary.listItemsAdded++;
  }
}

// Adds the file's viewings whose id is new. Then re-works the rating of every
// film that gained one, so the film shows its latest rated viewing.
async function mergeImportedViewings(tx, incoming, known, summary) {
  var store = tx.objectStore('viewings');
  var heldIds = await requestToPromise(store.getAllKeys());
  var seen = Object.create(null);
  for (var i = 0; i < heldIds.length; i++) seen[heldIds[i]] = true;
  var touched = Object.create(null);
  var now = nowIso();
  for (var j = 0; j < incoming.length; j++) {
    var viewing = incoming[j];
    if (!known[viewing.titleKey]) {
      summary.skipped++;
      continue;
    }
    if (seen[viewing.id]) continue;
    seen[viewing.id] = true;
    await requestToPromise(store.add(viewing));
    touched[viewing.titleKey] = true;
    summary.viewingsAdded++;
  }
  var keys = Object.keys(touched);
  for (var k = 0; k < keys.length; k++) await syncFilmRating(tx, keys[k], now);
}

function abortQuietly(tx) {
  try {
    tx.abort();
  } catch (err) {
    // Already finished or aborted; nothing to undo.
  }
}

async function settleQuietly(promise) {
  try {
    await promise;
  } catch (err) {
    // The failure that matters is the one the caller is about to rethrow.
  }
}

// input: the parsed backup object, or its JSON text.
// Returns a summary of what changed (see emptyImportSummary).
async function importAll(input) {
  var clean = cleanBackup(input);
  var db = await openDb();
  var tx = db.transaction(['titles', 'progress', 'watch_log', 'lists', 'list_items', 'viewings'], 'readwrite');
  var done = txDone(tx);
  var summary = emptyImportSummary();
  summary.skipped += clean.badViewings;
  try {
    var known = await mergeImportedTitles(tx, clean.titles, summary);
    await mergeImportedProgress(tx, clean.progress, known, summary);
    await mergeImportedLog(tx, clean.watchLog, known, summary);
    await mergeImportedLists(tx, clean.lists, clean.listItems, known, summary);
    await mergeImportedViewings(tx, clean.viewings, known, summary);
    summary.viewingsCreated = await addMissingBareViewings(tx);
  } catch (err) {
    abortQuietly(tx);
    await settleQuietly(done);
    throw err;
  }
  await done;
  return summary;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STATUSES: STATUSES,
    EXPORT_VERSION: EXPORT_VERSION,
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
    undoEpisode: undoEpisode,
    markWatched: markWatched,
    getWatchLog: getWatchLog,
    addViewing: addViewing,
    updateViewing: updateViewing,
    deleteViewing: deleteViewing,
    getViewings: getViewings,
    getAllViewings: getAllViewings,
    getViewing: getViewing,
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
    purgeExpiredCache: purgeExpiredCache,
    exportAll: exportAll,
    importAll: importAll
  };
}


test('getViewing returns one viewing by id, or null', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  const saved = await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-03-09', note: 'hi' });
  assert.deepEqual(await db.getViewing(saved.id), saved);
  assert.equal(await db.getViewing('v_nope_1'), null);
});
