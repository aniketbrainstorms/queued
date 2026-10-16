// Run with: node --test
// Uses fake-indexeddb (npm install) so IndexedDB works under Node.
'use strict';

require('fake-indexeddb/auto');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db.js');

function movie(id, status) {
  return { key: 'movie:' + id, type: 'movie', title: 'Movie ' + id, status: status || 'watchlist' };
}

function series(id, status) {
  return { key: 'tv:' + id, type: 'tv', title: 'Series ' + id, status: status || 'watching' };
}

const SEASONS = [{ number: 1, episodeCount: 3 }, { number: 2, episodeCount: 2 }];

beforeEach(async () => {
  await db.deleteDb();
});

// ---------- titles ----------

test('makeTitleKey builds and validates keys', () => {
  assert.equal(db.makeTitleKey('movie', 603), 'movie:603');
  assert.equal(db.makeTitleKey('tv', 1), 'tv:1');
  assert.throws(() => db.makeTitleKey('book', 1), { code: 'INVALID' });
  assert.throws(() => db.makeTitleKey('movie', 0), { code: 'INVALID' });
  assert.throws(() => db.makeTitleKey('movie', '5'), { code: 'INVALID' });
});

test('addTitle stores a record and stamps addedAt and updatedAt', async () => {
  const saved = await db.addTitle(movie(1));
  assert.ok(saved.addedAt);
  assert.ok(saved.updatedAt);
  const read = await db.getTitle('movie:1');
  assert.equal(read.title, 'Movie 1');
  assert.equal(read.status, 'watchlist');
});

test('addTitle keeps a supplied addedAt', async () => {
  const saved = await db.addTitle(Object.assign(movie(1), { addedAt: '2020-01-01T00:00:00.000Z' }));
  assert.equal(saved.addedAt, '2020-01-01T00:00:00.000Z');
});

test('addTitle blocks duplicates by key', async () => {
  await db.addTitle(movie(1));
  await assert.rejects(db.addTitle(movie(1)), { code: 'DUPLICATE' });
  assert.equal((await db.getAllTitles()).length, 1);
});

test('a movie and a series with the same TMDB id are different titles', async () => {
  await db.addTitle(movie(5));
  await db.addTitle(series(5));
  assert.equal((await db.getAllTitles()).length, 2);
});

test('addTitle validates the record', async () => {
  await assert.rejects(db.addTitle(null), { code: 'INVALID' });
  await assert.rejects(db.addTitle({ key: 'nope', type: 'movie', status: 'watchlist' }), { code: 'INVALID' });
  await assert.rejects(db.addTitle({ key: 'movie:1', type: 'tv', status: 'watchlist' }), { code: 'INVALID' });
  await assert.rejects(db.addTitle({ key: 'movie:1', type: 'movie', status: 'done' }), { code: 'INVALID' });
});

test('getTitle returns null for an unknown key', async () => {
  assert.equal(await db.getTitle('movie:404'), null);
});

test('getTitlesByStatus filters by status', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  await db.addTitle(movie(2, 'watched'));
  await db.addTitle(series(3, 'watching'));
  await db.addTitle(series(4, 'watching'));
  const watching = await db.getTitlesByStatus('watching');
  assert.deepEqual(watching.map((t) => t.key).sort(), ['tv:3', 'tv:4']);
  await assert.rejects(db.getTitlesByStatus('nope'), { code: 'INVALID' });
});

test('updateTitle merges changes but cannot change key, type or addedAt', async () => {
  const original = await db.addTitle(movie(1));
  const updated = await db.updateTitle('movie:1', {
    rating: 4, notes: 'good', key: 'movie:2', type: 'tv', addedAt: 'x'
  });
  assert.equal(updated.rating, 4);
  assert.equal(updated.notes, 'good');
  assert.equal(updated.key, 'movie:1');
  assert.equal(updated.type, 'movie');
  assert.equal(updated.addedAt, original.addedAt);
  assert.equal(await db.getTitle('movie:2'), null);
});

test('updateTitle rejects unknown titles and bad statuses', async () => {
  await assert.rejects(db.updateTitle('movie:9', { rating: 1 }), { code: 'NOT_FOUND' });
  await db.addTitle(movie(1));
  await assert.rejects(db.updateTitle('movie:1', { status: 'bogus' }), { code: 'INVALID' });
  assert.equal((await db.getTitle('movie:1')).status, 'watchlist');
});

test('setStatus changes status', async () => {
  await db.addTitle(movie(1));
  const updated = await db.setStatus('movie:1', 'watching');
  assert.equal(updated.status, 'watching');
});

// ---------- progress, log, mark watched ----------

test('saveProgress and getProgress round-trip, and unknown is null', async () => {
  assert.equal(await db.getProgress('tv:1'), null);
  await db.saveProgress('tv:1', { season: 1, episode: 0 }, SEASONS);
  const p = await db.getProgress('tv:1');
  assert.equal(p.season, 1);
  assert.equal(p.episode, 0);
  assert.deepEqual(p.seasons, SEASONS);
});

test('commitEpisode saves progress and appends a dated log entry', async () => {
  await db.addTitle(series(1));
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  await db.commitEpisode('tv:1', { season: 1, episode: 2 }, SEASONS);
  const p = await db.getProgress('tv:1');
  assert.equal(p.episode, 2);
  const log = await db.getWatchLog('tv:1');
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((e) => e.episode), [1, 2]);
  assert.ok(!Number.isNaN(Date.parse(log[0].at)));
});

test('saveProgress alone does not add to the log (stepper edits and undo)', async () => {
  await db.saveProgress('tv:1', { season: 2, episode: 1 }, SEASONS);
  assert.equal((await db.getWatchLog('tv:1')).length, 0);
});

test('undoEpisode saves the earlier pointer and removes the log entry that tap made', async () => {
  await db.addTitle(series(1));
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  await db.commitEpisode('tv:1', { season: 1, episode: 2 }, SEASONS);
  const result = await db.undoEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  assert.deepEqual(result, { removedLogEntry: true });
  assert.equal((await db.getProgress('tv:1')).episode, 1);
  assert.deepEqual((await db.getWatchLog('tv:1')).map((e) => e.episode), [1]);
});

test('next, undo, next again leaves one log entry, not a ghost', async () => {
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  await db.undoEpisode('tv:1', { season: 1, episode: 0 }, SEASONS);
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  const log = await db.getWatchLog('tv:1');
  assert.equal(log.length, 1);
  assert.equal(log[0].episode, 1);
});

test('undoEpisode can step all the way back, across a season rollover', async () => {
  await db.commitEpisode('tv:1', { season: 1, episode: 3 }, SEASONS);
  await db.commitEpisode('tv:1', { season: 2, episode: 1 }, SEASONS);
  await db.undoEpisode('tv:1', { season: 1, episode: 3 }, SEASONS);
  await db.undoEpisode('tv:1', { season: 1, episode: 2 }, SEASONS);
  assert.equal((await db.getWatchLog('tv:1')).length, 0);
  const p = await db.getProgress('tv:1');
  assert.deepEqual([p.season, p.episode], [1, 2]);
});

test('undoEpisode leaves the log alone when the pointer was moved by the stepper', async () => {
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  await db.saveProgress('tv:1', { season: 1, episode: 3 }, SEASONS); // stepper: logs nothing
  const result = await db.undoEpisode('tv:1', { season: 1, episode: 2 }, SEASONS);
  assert.deepEqual(result, { removedLogEntry: false });
  assert.equal((await db.getWatchLog('tv:1')).length, 1);
  assert.equal((await db.getProgress('tv:1')).episode, 2);
});

test('undoEpisode with no progress or log just saves the pointer', async () => {
  const result = await db.undoEpisode('tv:1', { season: 1, episode: 0 }, SEASONS);
  assert.deepEqual(result, { removedLogEntry: false });
  assert.equal((await db.getProgress('tv:1')).episode, 0);
});

test('undoEpisode only touches the log of its own title', async () => {
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  await db.commitEpisode('tv:2', { season: 1, episode: 1 }, SEASONS);
  await db.undoEpisode('tv:1', { season: 1, episode: 0 }, SEASONS);
  assert.equal((await db.getWatchLog('tv:1')).length, 0);
  assert.equal((await db.getWatchLog('tv:2')).length, 1);
});

test('getWatchLog without an argument returns every entry, oldest first', async () => {
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  await db.commitEpisode('tv:2', { season: 1, episode: 1 }, SEASONS);
  const all = await db.getWatchLog();
  assert.deepEqual(all.map((e) => e.titleKey), ['tv:1', 'tv:2']);
});

test('markWatched on a movie sets status and logs a null season/episode entry', async () => {
  await db.addTitle(movie(1));
  const updated = await db.markWatched('movie:1');
  assert.equal(updated.status, 'watched');
  const log = await db.getWatchLog('movie:1');
  assert.equal(log.length, 1);
  assert.equal(log[0].season, null);
  assert.equal(log[0].episode, null);
});

test('markWatched on a series sets status without adding a log entry', async () => {
  await db.addTitle(series(1));
  await db.markWatched('tv:1');
  assert.equal((await db.getTitle('tv:1')).status, 'watched');
  assert.equal((await db.getWatchLog('tv:1')).length, 0);
});

test('markWatched on an unknown title fails and logs nothing', async () => {
  await assert.rejects(db.markWatched('movie:404'), { code: 'NOT_FOUND' });
  assert.equal((await db.getWatchLog()).length, 0);
});

// ---------- removeTitle ----------

test('removeTitle deletes the title, its progress, its log and its list items', async () => {
  await db.addTitle(series(1));
  await db.addTitle(series(2));
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  await db.commitEpisode('tv:2', { season: 1, episode: 1 }, SEASONS);
  const list = await db.createList('Favourites');
  await db.addToList(list.id, 'tv:1');
  await db.addToList(list.id, 'tv:2');

  assert.equal(await db.removeTitle('tv:1'), true);

  assert.equal(await db.getTitle('tv:1'), null);
  assert.equal(await db.getProgress('tv:1'), null);
  assert.equal((await db.getWatchLog('tv:1')).length, 0);
  assert.deepEqual((await db.getListItems(list.id)).map((i) => i.titleKey), ['tv:2']);
  // the other title is untouched
  assert.notEqual(await db.getTitle('tv:2'), null);
  assert.equal((await db.getWatchLog('tv:2')).length, 1);
});

test('removeTitle reports false for an unknown title', async () => {
  assert.equal(await db.removeTitle('movie:404'), false);
});

// ---------- lists ----------

test('createList trims the name and rejects empty names', async () => {
  const list = await db.createList('  Weekend  ');
  assert.equal(list.name, 'Weekend');
  assert.ok(list.id);
  await assert.rejects(db.createList('   '), { code: 'INVALID' });
  assert.equal((await db.getLists()).length, 1);
});

test('renameList renames, and fails for unknown lists', async () => {
  const list = await db.createList('Old');
  const renamed = await db.renameList(list.id, 'New');
  assert.equal(renamed.name, 'New');
  await assert.rejects(db.renameList(9999, 'x'), { code: 'NOT_FOUND' });
  await assert.rejects(db.renameList(list.id, ' '), { code: 'INVALID' });
});

test('addToList appends in order and blocks duplicates', async () => {
  await db.addTitle(movie(1));
  await db.addTitle(movie(2));
  const list = await db.createList('L');
  const a = await db.addToList(list.id, 'movie:1');
  const b = await db.addToList(list.id, 'movie:2');
  assert.equal(a.position, 0);
  assert.equal(b.position, 1);
  await assert.rejects(db.addToList(list.id, 'movie:1'), { code: 'DUPLICATE' });
  assert.deepEqual((await db.getListItems(list.id)).map((i) => i.titleKey), ['movie:1', 'movie:2']);
});

test('addToList needs the list and the title to exist', async () => {
  await db.addTitle(movie(1));
  const list = await db.createList('L');
  await assert.rejects(db.addToList(9999, 'movie:1'), { code: 'NOT_FOUND' });
  await assert.rejects(db.addToList(list.id, 'movie:404'), { code: 'NOT_FOUND' });
  assert.equal((await db.getListItems(list.id)).length, 0);
});

test('the same title can be in several lists', async () => {
  await db.addTitle(movie(1));
  const a = await db.createList('A');
  const b = await db.createList('B');
  await db.addToList(a.id, 'movie:1');
  await db.addToList(b.id, 'movie:1');
  const ids = await db.getListIdsForTitle('movie:1');
  assert.deepEqual(ids.sort(), [a.id, b.id].sort());
});

test('removeFromList removes only that title from that list', async () => {
  await db.addTitle(movie(1));
  await db.addTitle(movie(2));
  const a = await db.createList('A');
  const b = await db.createList('B');
  await db.addToList(a.id, 'movie:1');
  await db.addToList(a.id, 'movie:2');
  await db.addToList(b.id, 'movie:1');
  await db.removeFromList(a.id, 'movie:1');
  assert.deepEqual((await db.getListItems(a.id)).map((i) => i.titleKey), ['movie:2']);
  assert.deepEqual((await db.getListItems(b.id)).map((i) => i.titleKey), ['movie:1']);
});

test('reorderList applies the order, keeps unmentioned items after, ignores unknown keys', async () => {
  for (const id of [1, 2, 3, 4]) await db.addTitle(movie(id));
  const list = await db.createList('L');
  for (const id of [1, 2, 3, 4]) await db.addToList(list.id, 'movie:' + id);

  await db.reorderList(list.id, ['movie:3', 'movie:99', 'movie:1', 'movie:3']);
  const items = await db.getListItems(list.id);
  assert.deepEqual(items.map((i) => i.titleKey), ['movie:3', 'movie:1', 'movie:2', 'movie:4']);
  assert.deepEqual(items.map((i) => i.position), [0, 1, 2, 3]);
});

test('deleteList removes the list and its items but keeps the titles', async () => {
  await db.addTitle(movie(1));
  const list = await db.createList('L');
  await db.addToList(list.id, 'movie:1');
  await db.deleteList(list.id);
  assert.equal((await db.getLists()).length, 0);
  assert.equal((await db.getListItems(list.id)).length, 0);
  assert.notEqual(await db.getTitle('movie:1'), null);
});

// ---------- cache ----------

test('cache returns fresh data, null for missing, and null once expired', async () => {
  assert.equal(await db.getCache('person:1'), null);
  await db.putCache('person:1', { name: 'A' }, 60000);
  assert.deepEqual(await db.getCache('person:1'), { name: 'A' });
  await db.putCache('person:2', { name: 'B' }, -1);
  assert.equal(await db.getCache('person:2'), null);
});

test('purgeExpiredCache deletes only expired entries', async () => {
  await db.putCache('fresh', { a: 1 }, 60000);
  await db.putCache('stale1', { a: 2 }, -1);
  await db.putCache('stale2', { a: 3 }, -1);
  assert.equal(await db.purgeExpiredCache(), 2);
  assert.deepEqual(await db.getCache('fresh'), { a: 1 });
  assert.equal(await db.purgeExpiredCache(), 0);
});

// ---------- export and import ----------

const OLD = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

function backup(extra) {
  return Object.assign({
    app: 'queued', version: 1, exportedAt: OLD,
    titles: [], progress: [], watchLog: [], lists: [], listItems: []
  }, extra);
}

function stamped(record, addedAt, updatedAt) {
  return Object.assign({}, record, { addedAt: addedAt, updatedAt: updatedAt });
}

// { listName: [titleKeys in order] } from an export, so tests do not depend on list ids.
function listsByName(data) {
  const out = {};
  for (const list of data.lists) {
    out[list.name] = data.listItems
      .filter((i) => i.listId === list.id)
      .sort((a, b) => a.position - b.position)
      .map((i) => i.titleKey);
  }
  return out;
}

async function populate() {
  await db.addTitle(movie(1));
  await db.markWatched('movie:1');
  await db.addTitle(series(2));
  await db.commitEpisode('tv:2', { season: 1, episode: 1 }, SEASONS);
  await db.commitEpisode('tv:2', { season: 1, episode: 2 }, SEASONS);
  const fav = await db.createList('Favourites');
  const weekend = await db.createList('Weekend');
  await db.addToList(fav.id, 'tv:2');
  await db.addToList(fav.id, 'movie:1');
  await db.addToList(weekend.id, 'movie:1');
}

test('exportAll returns a versioned snapshot without log or item ids, and without the cache', async () => {
  await db.addTitle(series(1));
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  const list = await db.createList('L');
  await db.addToList(list.id, 'tv:1');
  await db.putCache('person:1', { name: 'A' }, 60000);

  const data = await db.exportAll();
  assert.equal(data.app, 'queued');
  assert.equal(data.version, db.EXPORT_VERSION);
  assert.ok(!Number.isNaN(Date.parse(data.exportedAt)));
  assert.deepEqual(Object.keys(data).sort(),
    ['app', 'exportedAt', 'listItems', 'lists', 'progress', 'titles', 'version', 'watchLog']);
  assert.equal(data.titles.length, 1);
  assert.equal(data.progress.length, 1);
  assert.deepEqual(Object.keys(data.watchLog[0]).sort(), ['at', 'episode', 'season', 'titleKey']);
  assert.deepEqual(data.lists.map((l) => l.name), ['L']);
  assert.deepEqual(data.listItems, [{ listId: list.id, titleKey: 'tv:1', position: 0 }]);
});

test('exportAll on an empty library is a valid empty backup', async () => {
  const data = await db.exportAll();
  assert.deepEqual([data.titles, data.progress, data.watchLog, data.lists, data.listItems],
    [[], [], [], [], []]);
  const summary = await db.importAll(data);
  assert.equal(summary.titlesAdded, 0);
});

test('an export imports back into an empty library unchanged, through JSON text', async () => {
  await populate();
  const before = await db.exportAll();
  const text = JSON.stringify(before);
  await db.deleteDb();

  const summary = await db.importAll(text);
  assert.equal(summary.titlesAdded, 2);
  assert.equal(summary.progressWritten, 1);
  assert.equal(summary.logAdded, 3);
  assert.equal(summary.listsAdded, 2);
  assert.equal(summary.listItemsAdded, 3);
  assert.equal(summary.skipped, 0);

  const after = await db.exportAll();
  assert.deepEqual(after.titles, before.titles);
  assert.deepEqual(after.progress, before.progress);
  assert.deepEqual(after.watchLog, before.watchLog);
  assert.deepEqual(listsByName(after), listsByName(before));
  assert.deepEqual(listsByName(after), { Favourites: ['tv:2', 'movie:1'], Weekend: ['movie:1'] });
});

test('importing the same file twice changes nothing the second time', async () => {
  await populate();
  const file = await db.exportAll();
  const second = await db.importAll(file);
  assert.deepEqual(second, {
    titlesAdded: 0, titlesUpdated: 0, titlesKept: 2, progressWritten: 0,
    logAdded: 0, listsAdded: 0, listItemsAdded: 0, skipped: 0
  });
  assert.equal((await db.getWatchLog()).length, 3);
  assert.equal((await db.getLists()).length, 2);
  assert.equal((await db.getListItems((await db.getLists())[0].id)).length, 2);
});

test('import: the newer title record wins, and addedAt keeps the earlier date', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  const summary = await db.importAll(backup({
    titles: [stamped(movie(1, 'watched'), OLD, FUTURE)]
  }));
  assert.equal(summary.titlesUpdated, 1);
  const t = await db.getTitle('movie:1');
  assert.equal(t.status, 'watched');
  assert.equal(t.addedAt, OLD);
});

test('import: an older title record loses and the library record is kept', async () => {
  await db.addTitle(movie(1, 'watched'));
  const mine = await db.getTitle('movie:1');
  const summary = await db.importAll(backup({
    titles: [stamped(movie(1, 'watchlist'), mine.addedAt, OLD)]
  }));
  assert.equal(summary.titlesKept, 1);
  assert.equal((await db.getTitle('movie:1')).status, 'watched');
});

test('import: an older record still brings an earlier addedAt', async () => {
  await db.addTitle(movie(1, 'watched'));
  await db.importAll(backup({ titles: [stamped(movie(1, 'watchlist'), OLD, OLD)] }));
  const t = await db.getTitle('movie:1');
  assert.equal(t.status, 'watched');
  assert.equal(t.addedAt, OLD);
});

test('import keeps the furthest progress and takes seasons from the newer record', async () => {
  await db.addTitle(series(1));
  await db.saveProgress('tv:1', { season: 1, episode: 3 }, SEASONS);
  function rec(season, episode, updatedAt, seasons) {
    return { key: 'tv:1', season: season, episode: episode, seasons: seasons, updatedAt: updatedAt };
  }

  // behind and older: nothing changes
  let summary = await db.importAll(backup({ progress: [rec(1, 1, OLD, [])] }));
  assert.equal(summary.progressWritten, 0);
  let p = await db.getProgress('tv:1');
  assert.deepEqual([p.season, p.episode], [1, 3]);

  // further but older: the pointer moves, the library's seasons stay
  summary = await db.importAll(backup({ progress: [rec(2, 1, OLD, [{ number: 1, episodeCount: 99 }])] }));
  assert.equal(summary.progressWritten, 1);
  p = await db.getProgress('tv:1');
  assert.deepEqual([p.season, p.episode], [2, 1]);
  assert.deepEqual(p.seasons, SEASONS);

  // behind but newer: the pointer stays, the seasons come from the file
  const fresh = [{ number: 1, episodeCount: 3 }, { number: 2, episodeCount: 4 }];
  await db.importAll(backup({ progress: [rec(1, 1, FUTURE, fresh)] }));
  p = await db.getProgress('tv:1');
  assert.deepEqual([p.season, p.episode], [2, 1]);
  assert.deepEqual(p.seasons, fresh);
});

test('import adds only missing log entries, and the log stays in date order', async () => {
  await db.addTitle(series(1));
  await db.commitEpisode('tv:1', { season: 1, episode: 1 }, SEASONS);
  const old = { titleKey: 'tv:1', season: 1, episode: 1, at: OLD };
  const summary = await db.importAll(backup({ watchLog: [old, old, Object.assign({}, old, { at: '2000-01-01T00:00:00Z' })] }));
  assert.equal(summary.logAdded, 1); // the repeats (even a differently written same instant) are not added
  const log = await db.getWatchLog('tv:1');
  assert.equal(log.length, 2);
  assert.equal(log[0].at, OLD); // added last, but dated first
  assert.deepEqual((await db.getWatchLog()).map((e) => e.at), [log[0].at, log[1].at]);
});

test('import merges lists by name, appends missing titles in file order and creates new lists', async () => {
  await db.addTitle(movie(1));
  await db.addTitle(movie(2));
  const mine = await db.createList('Favourites');
  await db.addToList(mine.id, 'movie:1');

  const summary = await db.importAll(backup({
    titles: [movie(3)],
    lists: [{ id: 7, name: ' favourites ', createdAt: OLD }, { id: 8, name: 'Weekend', createdAt: OLD }],
    listItems: [
      { listId: 7, titleKey: 'movie:2', position: 2 },
      { listId: 7, titleKey: 'movie:3', position: 1 },
      { listId: 7, titleKey: 'movie:1', position: 0 },
      { listId: 8, titleKey: 'movie:3', position: 0 }
    ]
  }));
  assert.equal(summary.listsAdded, 1);
  assert.equal(summary.listItemsAdded, 3);
  assert.deepEqual(listsByName(await db.exportAll()), {
    Favourites: ['movie:1', 'movie:3', 'movie:2'],
    Weekend: ['movie:3']
  });
});

test('import skips progress, log entries and list items that point at missing titles or lists', async () => {
  const summary = await db.importAll(backup({
    titles: [series(1)],
    progress: [{ key: 'tv:9', season: 1, episode: 1, seasons: [], updatedAt: OLD }],
    watchLog: [{ titleKey: 'tv:9', season: 1, episode: 1, at: OLD }],
    lists: [{ id: 1, name: 'L', createdAt: OLD }],
    listItems: [
      { listId: 1, titleKey: 'tv:9', position: 0 },  // title missing
      { listId: 99, titleKey: 'tv:1', position: 0 }, // list missing
      { listId: 1, titleKey: 'tv:1', position: 1 }
    ]
  }));
  assert.equal(summary.skipped, 4);
  assert.equal(summary.listItemsAdded, 1);
  assert.equal(await db.getProgress('tv:9'), null);
  assert.equal((await db.getWatchLog()).length, 0);
});

test('import accepts a file that only has titles', async () => {
  const summary = await db.importAll({ app: 'queued', version: 1, titles: [movie(1)] });
  assert.equal(summary.titlesAdded, 1);
  const t = await db.getTitle('movie:1');
  assert.ok(t.addedAt);
  assert.ok(t.updatedAt);
});

test('importAll rejects files that are not usable Queued backups and writes nothing', async () => {
  await db.addTitle(movie(1));
  await assert.rejects(db.importAll('not json'), { code: 'INVALID' });
  await assert.rejects(db.importAll(null), { code: 'INVALID' });
  await assert.rejects(db.importAll({ app: 'other', version: 1 }), { code: 'INVALID' });
  await assert.rejects(db.importAll({ app: 'queued' }), { code: 'INVALID' });
  await assert.rejects(db.importAll({ app: 'queued', version: 99 }), { code: 'INVALID' });
  await assert.rejects(db.importAll({ app: 'queued', version: 1, titles: 'x' }), { code: 'INVALID' });
  assert.equal((await db.getAllTitles()).length, 1);
});

test('importAll checks every record before writing anything', async () => {
  const bad = [
    backup({ titles: [movie(5), { key: 'movie:6', type: 'tv', status: 'watchlist' }] }),
    backup({ titles: [movie(5)], progress: [{ key: 'movie:1', season: 1, episode: 1 }] }),
    backup({ titles: [movie(5)], progress: [{ key: 'tv:1', season: -1, episode: 1 }] }),
    backup({ titles: [movie(5)], watchLog: [{ titleKey: 'tv:1', season: 1, episode: null, at: OLD }] }),
    backup({ titles: [movie(5)], watchLog: [{ titleKey: 'tv:1', season: 1, episode: 1, at: 'yesterday' }] }),
    backup({ titles: [movie(5)], lists: [{ id: 1, name: '  ' }] }),
    backup({ titles: [movie(5)], listItems: [{ listId: 'a', titleKey: 'movie:5' }] })
  ];
  for (const file of bad) {
    await assert.rejects(db.importAll(file), { code: 'INVALID' });
  }
  assert.equal(await db.getTitle('movie:5'), null);
});

// ---------- storage ----------

test('requestPersistentStorage returns false when the browser has no storage API', async () => {
  assert.equal(await db.requestPersistentStorage(), false);
});

test('deleteDb erases everything', async () => {
  await db.addTitle(movie(1));
  await db.deleteDb();
  assert.equal((await db.getAllTitles()).length, 0);
});
