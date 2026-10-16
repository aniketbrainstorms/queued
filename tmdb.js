// tmdb.js: the only file that calls TMDB. Reads the user's saved key (settings.js)
// and checks the cache (db.js) for people and franchises.
// Loads as a classic browser script (after settings.js and db.js) and as a
// CommonJS module for the Node tests.
//
// Errors are TmdbError with a .code the UI can act on:
//   NO_KEY        no key saved             -> send the user to Settings
//   BAD_KEY       TMDB rejected the key    -> send the user to Settings
//   NOT_FOUND     404
//   RATE_LIMITED  429
//   NETWORK       offline or unreachable
//   HTTP          any other bad response
// Error messages never contain the request URL, because a v3 key travels in it.

'use strict';

var TMDB_BASE_URL = 'https://api.themoviedb.org/3';
var TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';
var IMAGE_SIZES = ['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original'];
var DEFAULT_IMAGE_SIZE = 'w342';

// How long people and franchise responses stay in the cache. Well inside TMDB's
// reported six-month limit; check TMDB's current terms before launch.
var CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class TmdbError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'TmdbError';
    this.code = code;
    this.status = status || 0;
  }
}

// Reaches the sibling modules in both environments: require() under Node,
// the globals defined by the earlier <script> tags in the browser.
function getSettingsApi() {
  if (typeof module !== 'undefined' && module.exports) return require('./settings.js');
  return { loadStoredKey: loadStoredKey, classifyKey: classifyKey };
}

function getDbApi() {
  if (typeof module !== 'undefined' && module.exports) return require('./db.js');
  return { getCache: getCache, putCache: putCache };
}

// ---------- requests ----------

// v3 keys go in the query string; v4 tokens go in an Authorization header.
function buildRequest(path, params, keyInfo) {
  var query = new URLSearchParams();
  var names = Object.keys(params || {});
  for (var i = 0; i < names.length; i++) {
    var value = params[names[i]];
    if (value !== undefined && value !== null) query.set(names[i], String(value));
  }
  var headers = { Accept: 'application/json' };
  if (keyInfo.type === 'v4') {
    headers.Authorization = 'Bearer ' + keyInfo.key;
  } else {
    query.set('api_key', keyInfo.key);
  }
  var text = query.toString();
  return {
    url: TMDB_BASE_URL + path + (text ? '?' + text : ''),
    options: { headers: headers }
  };
}

async function requestJson(keyInfo, path, params) {
  var req = buildRequest(path, params, keyInfo);
  var response;
  try {
    response = await fetch(req.url, req.options);
  } catch (err) {
    throw new TmdbError('NETWORK', 'Could not reach TMDB.');
  }
  if (response.status === 401) throw new TmdbError('BAD_KEY', 'TMDB rejected the key.', 401);
  if (response.status === 404) throw new TmdbError('NOT_FOUND', 'Not found on TMDB.', 404);
  if (response.status === 429) throw new TmdbError('RATE_LIMITED', 'TMDB rate limit hit. Try again shortly.', 429);
  if (!response.ok) {
    throw new TmdbError('HTTP', 'TMDB returned an error (' + response.status + ').', response.status);
  }
  try {
    return await response.json();
  } catch (err) {
    throw new TmdbError('HTTP', 'TMDB returned an unreadable response.', response.status);
  }
}

async function requestWithStoredKey(path, params) {
  var keyInfo = getSettingsApi().loadStoredKey();
  if (!keyInfo) throw new TmdbError('NO_KEY', 'Add your TMDB key in Settings.');
  return requestJson(keyInfo, path, params);
}

// Cache first. A broken cache never blocks the request.
async function getCachedOrFetch(cacheKey, path, params) {
  var dbApi = getDbApi();
  var cached = null;
  try {
    cached = await dbApi.getCache(cacheKey);
  } catch (err) {
    cached = null;
  }
  if (cached) return cached;
  var data = await requestWithStoredKey(path, params);
  try {
    await dbApi.putCache(cacheKey, data, CACHE_TTL_MS);
  } catch (err) {
    // Not cached this time; the data is still good.
  }
  return data;
}

// Tests a key without saving it. Never throws for expected failures.
// Returns { ok: true, type } or { ok: false, code } where code is one of
// BAD_FORMAT, BAD_KEY, NETWORK, RATE_LIMITED, HTTP.
async function verifyKey(raw) {
  var keyInfo = getSettingsApi().classifyKey(raw);
  if (keyInfo.type === 'invalid') return { ok: false, code: 'BAD_FORMAT', reason: keyInfo.reason };
  try {
    await requestJson(keyInfo, '/configuration', {});
    return { ok: true, type: keyInfo.type };
  } catch (err) {
    if (err instanceof TmdbError) return { ok: false, code: err.code };
    throw err;
  }
}

// ---------- endpoints ----------

function yearFromDate(text) {
  if (typeof text !== 'string' || !/^[0-9]{4}/.test(text)) return null;
  return Number(text.slice(0, 4));
}

function normalizeSearchResult(raw) {
  if (raw.media_type === 'person') {
    return {
      mediaType: 'person',
      id: raw.id,
      title: raw.name,
      year: null,
      imagePath: raw.profile_path || null,
      overview: raw.known_for_department || ''
    };
  }
  return {
    mediaType: raw.media_type,
    id: raw.id,
    title: raw.media_type === 'movie' ? raw.title : raw.name,
    year: yearFromDate(raw.media_type === 'movie' ? raw.release_date : raw.first_air_date),
    imagePath: raw.poster_path || null,
    overview: raw.overview || ''
  };
}

// Multi-search across movies, series and people. Returns
// { results: [{ mediaType, id, title, year, imagePath, overview }], page, totalPages }.
async function searchMulti(query, page) {
  var text = typeof query === 'string' ? query.trim() : '';
  if (text === '') return { results: [], page: 1, totalPages: 0 };
  var data = await requestWithStoredKey('/search/multi', {
    query: text,
    include_adult: 'false',
    page: page || 1
  });
  var results = [];
  var raw = Array.isArray(data.results) ? data.results : [];
  for (var i = 0; i < raw.length; i++) {
    var type = raw[i].media_type;
    if (type === 'movie' || type === 'tv' || type === 'person') {
      results.push(normalizeSearchResult(raw[i]));
    }
  }
  return { results: results, page: data.page || 1, totalPages: data.total_pages || 0 };
}

function getMovie(id) {
  return requestWithStoredKey('/movie/' + id, { append_to_response: 'credits' });
}

function getTv(id) {
  return requestWithStoredKey('/tv/' + id, {});
}

function getSeason(tvId, seasonNumber) {
  return requestWithStoredKey('/tv/' + tvId + '/season/' + seasonNumber, {});
}

// Cached. Includes filmography (combined_credits).
function getPerson(id) {
  return getCachedOrFetch('person:' + id, '/person/' + id, { append_to_response: 'combined_credits' });
}

// Cached. A franchise (TMDB "collection") with its films in parts[].
function getCollection(id) {
  return getCachedOrFetch('collection:' + id, '/collection/' + id, {});
}

// ---------- shaping TMDB data for the app ----------

function imageUrl(path, size) {
  if (!path) return null;
  var chosen = IMAGE_SIZES.indexOf(size) !== -1 ? size : DEFAULT_IMAGE_SIZE;
  return TMDB_IMAGE_BASE_URL + chosen + path;
}

// TMDB season list -> the shape progress.js expects. Season 0 (specials) is
// kept here and dropped by progress.js.
function seasonsFromTv(details) {
  var out = [];
  var raw = details && Array.isArray(details.seasons) ? details.seasons : [];
  for (var i = 0; i < raw.length; i++) {
    out.push({
      number: raw[i].season_number,
      episodeCount: Number.isInteger(raw[i].episode_count) ? raw[i].episode_count : null
    });
  }
  return out;
}

function genreNames(details) {
  var names = [];
  var raw = details && Array.isArray(details.genres) ? details.genres : [];
  for (var i = 0; i < raw.length; i++) names.push(raw[i].name);
  return names;
}

function directorIds(credits) {
  var ids = [];
  var crew = credits && Array.isArray(credits.crew) ? credits.crew : [];
  for (var i = 0; i < crew.length; i++) {
    if (crew[i].job === 'Director' && ids.indexOf(crew[i].id) === -1) ids.push(crew[i].id);
  }
  return ids;
}

function creatorIds(details) {
  var ids = [];
  var raw = details && Array.isArray(details.created_by) ? details.created_by : [];
  for (var i = 0; i < raw.length; i++) ids.push(raw[i].id);
  return ids;
}

// A titles record (without status or addedAt; the caller sets those) from
// getMovie() output. nowIso is optional, for tests.
function titleFromMovie(details, nowIso) {
  var collection = details.belongs_to_collection || null;
  return {
    key: 'movie:' + details.id,
    type: 'movie',
    title: details.title,
    year: yearFromDate(details.release_date),
    posterPath: details.poster_path || null,
    rating: null,
    notes: '',
    runtime: Number.isInteger(details.runtime) ? details.runtime : null,
    franchiseId: collection ? collection.id : null,
    franchiseName: collection ? collection.name : null,
    directorIds: directorIds(details.credits),
    snapshot: {
      overview: details.overview || '',
      tagline: details.tagline || '',
      genres: genreNames(details),
      status: details.status || '',
      releaseDate: details.release_date || ''
    },
    snapshotRefreshedAt: nowIso || new Date().toISOString()
  };
}

// A titles record from getTv() output.
function titleFromTv(details, nowIso) {
  return {
    key: 'tv:' + details.id,
    type: 'tv',
    title: details.name,
    year: yearFromDate(details.first_air_date),
    posterPath: details.poster_path || null,
    rating: null,
    notes: '',
    creatorIds: creatorIds(details),
    seasonCount: Number.isInteger(details.number_of_seasons) ? details.number_of_seasons : null,
    episodeCount: Number.isInteger(details.number_of_episodes) ? details.number_of_episodes : null,
    snapshot: {
      overview: details.overview || '',
      genres: genreNames(details),
      status: details.status || '',
      firstAirDate: details.first_air_date || '',
      lastAirDate: details.last_air_date || '',
      seasons: seasonsFromTv(details)
    },
    snapshotRefreshedAt: nowIso || new Date().toISOString()
  };
}

function compareParts(a, b) {
  var aDate = a.release_date || '';
  var bDate = b.release_date || '';
  if (aDate === bDate) return 0;
  if (aDate === '') return 1;
  if (bDate === '') return -1;
  return aDate < bDate ? -1 : 1;
}

// A franchise's films in release order; films without a date go last.
function collectionPartsInOrder(collection) {
  var parts = collection && Array.isArray(collection.parts) ? collection.parts.slice() : [];
  parts.sort(compareParts);
  return parts;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TmdbError: TmdbError,
    CACHE_TTL_MS: CACHE_TTL_MS,
    buildRequest: buildRequest,
    verifyKey: verifyKey,
    searchMulti: searchMulti,
    getMovie: getMovie,
    getTv: getTv,
    getSeason: getSeason,
    getPerson: getPerson,
    getCollection: getCollection,
    imageUrl: imageUrl,
    seasonsFromTv: seasonsFromTv,
    titleFromMovie: titleFromMovie,
    titleFromTv: titleFromTv,
    collectionPartsInOrder: collectionPartsInOrder
  };
}
