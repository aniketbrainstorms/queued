// viewings.js: what a viewing is and the rules for cleaning one. Pure: no
// database, no DOM. Loads as a classic browser script and as a CommonJS module
// for the Node tests.
//
// A viewing is one time a movie was watched:
//   { id, titleKey, watchedOn, where, rating, note, format, withWhom,
//     cinemaName, cinemaCity, screen, seat, price,      (cinema only)
//     source, service, device,                           (home only)
//     createdAt, updatedAt }
// A "bare" viewing has where = null and keeps only watchedOn, rating and note.
//
// Style: flat top-level functions, no nested functions.

'use strict';

var VIEWING_WHERE = ['cinema', 'home'];
var VIEWING_SOURCES = ['streaming', 'disc', 'tv', 'pirated', 'other'];
var VIEWING_DEVICES = ['tv', 'laptop', 'phone', 'tablet', 'projector'];
var VIEWING_NOTE_MAX = 80;
var VIEWING_TEXT_MAX = 60;
var VIEWING_PRICE_MAX = 1000000;
var VIEWING_ID_PATTERN = /^v_[a-z0-9]+_[a-z0-9]+$/;
var VIEWING_KEY_PATTERN = /^movie:[1-9][0-9]*$/;
var VIEWING_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// The calendar day on the user's own clock, as YYYY-MM-DD. Not the UTC day:
// a late-night viewing in India must not be filed under yesterday.
function localDateString(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function isRealDate(text) {
  if (typeof text !== 'string' || !VIEWING_DATE_PATTERN.test(text)) return false;
  var year = Number(text.slice(0, 4));
  var month = Number(text.slice(5, 7));
  var day = Number(text.slice(8, 10));
  var date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// id: 'v_' + time in base 36 + '_' + random in base 36. Both inputs are passed
// in so tests can control them.
function makeViewingId(ms, random) {
  var tail = random.toString(36).slice(2, 8);
  return 'v_' + ms.toString(36) + '_' + (tail === '' ? '0' : tail);
}

function readText(raw, field, max, problems) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    problems.push(field + ' must be text');
    return null;
  }
  var text = raw.trim();
  if (text === '') return null;
  if (text.length > max) {
    problems.push(field + ' must be at most ' + max + ' characters');
    return null;
  }
  return text;
}

function readChoice(raw, field, allowed, problems) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (allowed.indexOf(raw) === -1) {
    problems.push(field + ' must be one of: ' + allowed.join(', '));
    return null;
  }
  return raw;
}

function readRating(raw, problems) {
  if (raw === undefined || raw === null) return null;
  var ok = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0.5 && raw <= 5 && raw * 2 === Math.round(raw * 2);
  if (!ok) {
    problems.push('rating must be from 0.5 to 5 in steps of 0.5');
    return null;
  }
  return raw;
}

function readPrice(raw, problems) {
  if (raw === undefined || raw === null) return null;
  var ok = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= VIEWING_PRICE_MAX;
  if (!ok) {
    problems.push('price must be a number from 0 to ' + VIEWING_PRICE_MAX);
    return null;
  }
  return raw;
}

// Checks and tidies one viewing. ctx = { today: 'YYYY-MM-DD', now: ISO text }.
// Returns { value, error }: value is the clean record, error is null; or
// value is null and error says what is wrong. Fields that do not belong to
// the chosen place are dropped (set to null), not rejected.
function cleanViewing(raw, ctx) {
  if (!raw || typeof raw !== 'object') return { value: null, error: 'viewing is required' };
  var problems = [];

  if (typeof raw.id !== 'string' || !VIEWING_ID_PATTERN.test(raw.id)) problems.push('id is not valid');
  if (typeof raw.titleKey !== 'string' || !VIEWING_KEY_PATTERN.test(raw.titleKey)) {
    problems.push('titleKey must look like "movie:123"');
  }
  if (!isRealDate(raw.watchedOn)) problems.push('watchedOn must be a real date like 2026-10-17');
  else if (raw.watchedOn > ctx.today) problems.push('watchedOn cannot be in the future');

  var where = readChoice(raw.where, 'where', VIEWING_WHERE, problems);
  var cinema = where === 'cinema';
  var home = where === 'home';
  var logged = cinema || home;
  var source = home ? readChoice(raw.source, 'source', VIEWING_SOURCES, problems) : null;

  var value = {
    id: raw.id,
    titleKey: raw.titleKey,
    watchedOn: raw.watchedOn,
    where: where,
    rating: readRating(raw.rating, problems),
    note: readText(raw.note, 'note', VIEWING_NOTE_MAX, problems) || '',
    format: logged ? readText(raw.format, 'format', VIEWING_TEXT_MAX, problems) : null,
    withWhom: logged ? readText(raw.withWhom, 'withWhom', VIEWING_TEXT_MAX, problems) : null,
    cinemaName: cinema ? readText(raw.cinemaName, 'cinemaName', VIEWING_TEXT_MAX, problems) : null,
    cinemaCity: cinema ? readText(raw.cinemaCity, 'cinemaCity', VIEWING_TEXT_MAX, problems) : null,
    screen: cinema ? readText(raw.screen, 'screen', VIEWING_TEXT_MAX, problems) : null,
    seat: cinema ? readText(raw.seat, 'seat', VIEWING_TEXT_MAX, problems) : null,
    price: cinema ? readPrice(raw.price, problems) : null,
    source: source,
    service: source === 'streaming' ? readText(raw.service, 'service', VIEWING_TEXT_MAX, problems) : null,
    device: home ? readChoice(raw.device, 'device', VIEWING_DEVICES, problems) : null,
    createdAt: isIsoDate(raw.createdAt) ? raw.createdAt : ctx.now,
    updatedAt: null
  };
  value.updatedAt = isIsoDate(raw.updatedAt) ? raw.updatedAt : value.createdAt;

  if (problems.length > 0) return { value: null, error: problems[0] };
  return { value: value, error: null };
}

// A viewing with no details: today's date and nothing else. Made whenever a
// movie becomes Watched.
function makeBareViewing(titleKey, id, ctx) {
  var out = cleanViewing({ id: id, titleKey: titleKey, watchedOn: ctx.today }, ctx);
  if (out.error) throw new Error(out.error);
  return out.value;
}

// Newest first: later date, then later createdAt, then id (so the order is
// always the same for the same data).
function compareViewingsNewestFirst(a, b) {
  if (a.watchedOn !== b.watchedOn) return a.watchedOn < b.watchedOn ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

// The film's rating is the rating on its latest rated viewing, or null.
function filmRatingFromViewings(viewings) {
  var sorted = viewings.filter(hasRating).sort(compareViewingsNewestFirst);
  return sorted.length > 0 ? sorted[0].rating : null;
}

function hasRating(viewing) {
  return viewing.rating !== null && viewing.rating !== undefined;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VIEWING_WHERE: VIEWING_WHERE,
    VIEWING_SOURCES: VIEWING_SOURCES,
    VIEWING_DEVICES: VIEWING_DEVICES,
    VIEWING_NOTE_MAX: VIEWING_NOTE_MAX,
    localDateString: localDateString,
    makeViewingId: makeViewingId,
    cleanViewing: cleanViewing,
    makeBareViewing: makeBareViewing,
    compareViewingsNewestFirst: compareViewingsNewestFirst,
    filmRatingFromViewings: filmRatingFromViewings
  };
}
