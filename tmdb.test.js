// Run with: node --test
'use strict';

require('fake-indexeddb/auto');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const tmdb = require('./tmdb.js');
const db = require('./db.js');
const settings = require('./settings.js');

const V3 = '0123456789abcdef0123456789abcdef';
const V4 = 'eyJ' + 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.' + 'c'.repeat(40);

// ---------- test helpers ----------

function makeFakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k)
  };
}

function installStorage(storage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true
  });
}

// Replaces fetch with a stub that answers from a queue and records calls.
function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => next.body
    };
  };
  return calls;
}

function ok(body) {
  return { status: 200, body: body };
}

beforeEach(async () => {
  installStorage(makeFakeStorage());
  await db.deleteDb();
});

// ---------- buildRequest ----------

test('buildRequest puts a v3 key in the query string', () => {
  const req = tmdb.buildRequest('/movie/1', { language: 'en-US' }, { type: 'v3', key: V3 });
  assert.equal(req.url, 'https://api.themoviedb.org/3/movie/1?language=en-US&api_key=' + V3);
  assert.equal(req.options.headers.Authorization, undefined);
});

test('buildRequest puts a v4 token in the Authorization header, not the URL', () => {
  const req = tmdb.buildRequest('/movie/1', {}, { type: 'v4', key: V4 });
  assert.equal(req.url, 'https://api.themoviedb.org/3/movie/1');
  assert.equal(req.options.headers.Authorization, 'Bearer ' + V4);
});

test('buildRequest skips undefined and null params', () => {
  const req = tmdb.buildRequest('/x', { a: 1, b: undefined, c: null }, { type: 'v4', key: V4 });
  assert.equal(req.url, 'https://api.themoviedb.org/3/x?a=1');
});

// ---------- error handling ----------

test('a missing key throws NO_KEY without calling TMDB', async () => {
  const calls = stubFetch([ok({})]);
  await assert.rejects(tmdb.getMovie(1), { code: 'NO_KEY' });
  assert.equal(calls.length, 0);
});

test('401 becomes BAD_KEY', async () => {
  settings.saveKey(V3);
  stubFetch([{ status: 401, body: {} }]);
  await assert.rejects(tmdb.getMovie(1), { code: 'BAD_KEY' });
});

test('404, 429 and other statuses map to their codes', async () => {
  settings.saveKey(V3);
  stubFetch([{ status: 404, body: {} }]);
  await assert.rejects(tmdb.getMovie(1), { code: 'NOT_FOUND' });
  stubFetch([{ status: 429, body: {} }]);
  await assert.rejects(tmdb.getMovie(1), { code: 'RATE_LIMITED' });
  stubFetch([{ status: 500, body: {} }]);
  await assert.rejects(tmdb.getMovie(1), { code: 'HTTP' });
});

test('a network failure becomes NETWORK', async () => {
  settings.saveKey(V3);
  stubFetch([new TypeError('Failed to fetch')]);
  await assert.rejects(tmdb.getMovie(1), { code: 'NETWORK' });
});

test('error messages never contain the key or the URL', async () => {
  settings.saveKey(V3);
  stubFetch([{ status: 401, body: {} }]);
  await assert.rejects(tmdb.getMovie(1), (err) => {
    assert.ok(!err.message.includes(V3));
    assert.ok(!err.message.includes('api.themoviedb.org'));
    return true;
  });
  stubFetch([new TypeError('Failed to fetch https://api.themoviedb.org/3/movie/1?api_key=' + V3)]);
  await assert.rejects(tmdb.getMovie(1), (err) => {
    assert.ok(!err.message.includes(V3));
    return true;
  });
});

// ---------- searchMulti ----------

test('searchMulti normalises movies, series and people and drops other types', async () => {
  settings.saveKey(V4);
  const calls = stubFetch([ok({
    page: 1,
    total_pages: 3,
    results: [
      { media_type: 'movie', id: 11, title: 'Star Wars', release_date: '1977-05-25', poster_path: '/a.jpg', overview: 'o' },
      { media_type: 'tv', id: 22, name: 'Andor', first_air_date: '2022-09-21', poster_path: null },
      { media_type: 'person', id: 33, name: 'Diego Luna', profile_path: '/p.jpg', known_for_department: 'Acting' },
      { media_type: 'collection', id: 44, name: 'Ignore me' }
    ]
  })]);
  const out = await tmdb.searchMulti('  star  ', 2);
  assert.equal(out.totalPages, 3);
  assert.deepEqual(out.results.map((r) => r.mediaType), ['movie', 'tv', 'person']);
  assert.deepEqual(out.results[0], {
    mediaType: 'movie', id: 11, title: 'Star Wars', year: 1977, imagePath: '/a.jpg', overview: 'o'
  });
  assert.equal(out.results[1].title, 'Andor');
  assert.equal(out.results[1].year, 2022);
  assert.equal(out.results[1].imagePath, null);
  assert.equal(out.results[2].title, 'Diego Luna');
  assert.equal(out.results[2].year, null);
  assert.match(calls[0].url, /\/search\/multi\?query=star&include_adult=false&page=2$/);
});

test('searchMulti with an empty query makes no request', async () => {
  settings.saveKey(V3);
  const calls = stubFetch([ok({})]);
  const out = await tmdb.searchMulti('   ');
  assert.deepEqual(out, { results: [], page: 1, totalPages: 0 });
  assert.equal(calls.length, 0);
});

// ---------- details ----------

test('getMovie asks for credits; getSeason and getTv hit the right paths', async () => {
  settings.saveKey(V3);
  const calls = stubFetch([ok({ id: 1 })]);
  await tmdb.getMovie(603);
  await tmdb.getTv(1399);
  await tmdb.getSeason(1399, 2);
  assert.match(calls[0].url, /\/movie\/603\?append_to_response=credits&api_key=/);
  assert.match(calls[1].url, /\/tv\/1399\?api_key=/);
  assert.match(calls[2].url, /\/tv\/1399\/season\/2\?api_key=/);
});

// ---------- cache ----------

test('getPerson is cached: the second call does not hit TMDB', async () => {
  settings.saveKey(V3);
  const calls = stubFetch([ok({ id: 5, name: 'Someone' })]);
  const first = await tmdb.getPerson(5);
  const second = await tmdb.getPerson(5);
  assert.deepEqual(first, second);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/person\/5\?append_to_response=combined_credits/);
});

test('cached data is served even with no key and no network', async () => {
  settings.saveKey(V3);
  stubFetch([ok({ id: 9, name: 'Cached' })]);
  await tmdb.getCollection(9);
  settings.clearKey();
  const calls = stubFetch([new TypeError('offline')]);
  const data = await tmdb.getCollection(9);
  assert.equal(data.name, 'Cached');
  assert.equal(calls.length, 0);
});

test('an expired cache entry is refetched', async () => {
  settings.saveKey(V3);
  await db.putCache('person:7', { id: 7, name: 'Old' }, -1000);
  const calls = stubFetch([ok({ id: 7, name: 'New' })]);
  const data = await tmdb.getPerson(7);
  assert.equal(data.name, 'New');
  assert.equal(calls.length, 1);
});

// ---------- verifyKey ----------

test('verifyKey reports a good key without saving it', async () => {
  const calls = stubFetch([ok({ images: {} })]);
  assert.deepEqual(await tmdb.verifyKey(V3), { ok: true, type: 'v3' });
  assert.match(calls[0].url, /\/configuration\?api_key=/);
  assert.equal(settings.loadStoredKey(), null);
});

test('verifyKey reports bad format, rejected keys and network problems', async () => {
  const calls = stubFetch([ok({})]);
  assert.deepEqual(await tmdb.verifyKey('nope'), { ok: false, code: 'BAD_FORMAT', reason: 'format' });
  assert.equal(calls.length, 0);
  stubFetch([{ status: 401, body: {} }]);
  assert.deepEqual(await tmdb.verifyKey(V3), { ok: false, code: 'BAD_KEY' });
  stubFetch([new TypeError('offline')]);
  assert.deepEqual(await tmdb.verifyKey(V4), { ok: false, code: 'NETWORK' });
});

// ---------- shaping ----------

test('imageUrl builds URLs, falls back to the default size, and handles no path', () => {
  assert.equal(tmdb.imageUrl('/a.jpg', 'w185'), 'https://image.tmdb.org/t/p/w185/a.jpg');
  assert.equal(tmdb.imageUrl('/a.jpg', 'bogus'), 'https://image.tmdb.org/t/p/w342/a.jpg');
  assert.equal(tmdb.imageUrl('/a.jpg'), 'https://image.tmdb.org/t/p/w342/a.jpg');
  assert.equal(tmdb.imageUrl(null), null);
});

test('seasonsFromTv maps to the shape progress.js uses', () => {
  const seasons = tmdb.seasonsFromTv({
    seasons: [
      { season_number: 0, episode_count: 3 },
      { season_number: 1, episode_count: 10 },
      { season_number: 2, episode_count: 0 },
      { season_number: 3 }
    ]
  });
  assert.deepEqual(seasons, [
    { number: 0, episodeCount: 3 },
    { number: 1, episodeCount: 10 },
    { number: 2, episodeCount: 0 },
    { number: 3, episodeCount: null }
  ]);
  assert.deepEqual(tmdb.seasonsFromTv(null), []);
});

test('titleFromMovie builds a titles record', () => {
  const rec = tmdb.titleFromMovie({
    id: 603, title: 'The Matrix', release_date: '1999-03-30', poster_path: '/m.jpg',
    runtime: 136, overview: 'ov', tagline: 'tag', status: 'Released',
    genres: [{ id: 1, name: 'Action' }, { id: 2, name: 'Sci-Fi' }],
    belongs_to_collection: { id: 2344, name: 'The Matrix Collection' },
    credits: { crew: [
      { id: 9, job: 'Director' }, { id: 9, job: 'Director' }, { id: 8, job: 'Writer' }, { id: 7, job: 'Director' }
    ] }
  }, '2026-10-17T00:00:00.000Z');
  assert.equal(rec.key, 'movie:603');
  assert.equal(rec.type, 'movie');
  assert.equal(rec.year, 1999);
  assert.equal(rec.runtime, 136);
  assert.equal(rec.franchiseId, 2344);
  assert.equal(rec.franchiseName, 'The Matrix Collection');
  assert.deepEqual(rec.directorIds, [9, 7]);
  assert.deepEqual(rec.snapshot.genres, ['Action', 'Sci-Fi']);
  assert.equal(rec.snapshotRefreshedAt, '2026-10-17T00:00:00.000Z');
  assert.equal(rec.status, undefined);
});

test('titleFromMovie copes with no collection, credits or dates', () => {
  const rec = tmdb.titleFromMovie({ id: 5, title: 'Bare' });
  assert.equal(rec.franchiseId, null);
  assert.equal(rec.year, null);
  assert.deepEqual(rec.directorIds, []);
  assert.equal(rec.posterPath, null);
});

test('titleFromTv builds a titles record with seasons in the snapshot', () => {
  const rec = tmdb.titleFromTv({
    id: 1399, name: 'Show', first_air_date: '2011-04-17', poster_path: '/s.jpg',
    number_of_seasons: 2, number_of_episodes: 13,
    created_by: [{ id: 1 }, { id: 2 }],
    seasons: [{ season_number: 1, episode_count: 10 }, { season_number: 2, episode_count: 3 }]
  });
  assert.equal(rec.key, 'tv:1399');
  assert.equal(rec.type, 'tv');
  assert.deepEqual(rec.creatorIds, [1, 2]);
  assert.equal(rec.seasonCount, 2);
  assert.equal(rec.episodeCount, 13);
  assert.deepEqual(rec.snapshot.seasons, [
    { number: 1, episodeCount: 10 }, { number: 2, episodeCount: 3 }
  ]);
});

test('collectionPartsInOrder sorts by release date with undated films last', () => {
  const ordered = tmdb.collectionPartsInOrder({
    parts: [
      { id: 3, release_date: '2003-11-05' },
      { id: 9, release_date: '' },
      { id: 1, release_date: '1999-03-30' },
      { id: 2, release_date: '2003-05-15' }
    ]
  });
  assert.deepEqual(ordered.map((p) => p.id), [1, 2, 3, 9]);
  assert.deepEqual(tmdb.collectionPartsInOrder(null), []);
});

test('titleFromMovie saves director names, once each, in credit order', () => {
  const rec = tmdb.titleFromMovie({
    id: 7, title: 'Duo',
    credits: { crew: [
      { id: 9, name: 'Lana', job: 'Director' }, { id: 9, name: 'Lana', job: 'Director' },
      { id: 8, name: 'Writer Person', job: 'Writer' }, { id: 7, name: 'Lilly', job: 'Director' },
      { id: 6, job: 'Director' }
    ] }
  });
  assert.deepEqual(rec.snapshot.directors, [
    { id: 9, name: 'Lana' }, { id: 7, name: 'Lilly' }, { id: 6, name: '' }
  ]);
  assert.deepEqual(rec.directorIds, [9, 7, 6]);
});

test('titleFromMovie with no credits has an empty director list', () => {
  assert.deepEqual(tmdb.titleFromMovie({ id: 5, title: 'Bare' }).snapshot.directors, []);
});
