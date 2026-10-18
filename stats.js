// stats.js: the year-in-review numbers. Pure: viewings and titles go in, a
// plain object comes out. Loads as a classic browser script and as a CommonJS
// module for the Node tests.
//
// Definitions (a "year" is the calendar year of watchedOn):
//   films        number of viewings (rewatches count); distinctFilms counts titles
//   hours        sum of runtimes of those viewings / 60, rounded; viewings whose
//                title has no runtime are left out and counted in runtimeMissing
//   where        cinema / home counts; bare viewings are "unlogged", not in the split
//   top lists    each viewing counts once per genre or director, and once for
//                its release decade; top five, ties alphabetical
//
// Style: flat top-level functions, no nested functions.

'use strict';

var STATS_TOP_COUNT = 5;
var STATS_HIGHEST_COUNT = 3;
var STATS_WALL_COUNT = 10;

function getStatsViewingsApi() {
  if (typeof module !== 'undefined' && module.exports) return require('./viewings.js');
  return { compareViewingsNewestFirst: compareViewingsNewestFirst };
}

function yearOfViewing(viewing) {
  return Number(viewing.watchedOn.slice(0, 4));
}

function monthOfViewing(viewing) {
  return Number(viewing.watchedOn.slice(5, 7));
}

function zeros(length) {
  var out = [];
  for (var i = 0; i < length; i++) out.push(0);
  return out;
}

// Years that have at least one viewing, newest first.
function yearsWithViewings(viewings) {
  var seen = Object.create(null);
  var years = [];
  for (var i = 0; i < viewings.length; i++) {
    var year = yearOfViewing(viewings[i]);
    if (!seen[year]) {
      seen[year] = true;
      years.push(year);
    }
  }
  return years.sort(compareNumbersDescending);
}

function compareNumbersDescending(a, b) {
  return b - a;
}

function viewingsInYear(viewings, year) {
  var out = [];
  for (var i = 0; i < viewings.length; i++) {
    if (yearOfViewing(viewings[i]) === year) out.push(viewings[i]);
  }
  return out;
}

// ---------- counting helpers ----------

function bump(counts, label) {
  counts[label] = (counts[label] || 0) + 1;
}

function compareCountThenLabel(a, b) {
  if (a.count !== b.count) return b.count - a.count;
  if (a.label === b.label) return 0;
  return a.label < b.label ? -1 : 1;
}

// { label: count } to [{ label, count }], best first, at most `limit`.
function topCounts(counts, limit) {
  var rows = [];
  var labels = Object.keys(counts);
  for (var i = 0; i < labels.length; i++) rows.push({ label: labels[i], count: counts[labels[i]] });
  rows.sort(compareCountThenLabel);
  return rows.slice(0, limit);
}

function directorNameMap(titles, extraNames) {
  var names = Object.create(null);
  var keys = Object.keys(titles);
  for (var i = 0; i < keys.length; i++) {
    var list = titles[keys[i]].snapshot && titles[keys[i]].snapshot.directors;
    if (!Array.isArray(list)) continue;
    for (var j = 0; j < list.length; j++) names[list[j].id] = list[j].name;
  }
  if (extraNames) {
    var extraIds = Object.keys(extraNames);
    for (var k = 0; k < extraIds.length; k++) {
      if (!names[extraIds[k]]) names[extraIds[k]] = extraNames[extraIds[k]];
    }
  }
  return names;
}

function compareDirectors(a, b) {
  if (a.count !== b.count) return b.count - a.count;
  var left = a.name === null ? '\uffff' + a.id : a.name;
  var right = b.name === null ? '\uffff' + b.id : b.name;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function topDirectorsFrom(counts, names) {
  var rows = [];
  var ids = Object.keys(counts);
  for (var i = 0; i < ids.length; i++) {
    var id = Number(ids[i]);
    rows.push({ id: id, name: names[id] || null, count: counts[ids[i]] });
  }
  rows.sort(compareDirectors);
  return rows.slice(0, STATS_TOP_COUNT);
}

// ---------- tallies (each adds one viewing's facts to acc) ----------

function tallyTitle(title, acc) {
  if (!title) return;
  if (Number.isInteger(title.runtime)) acc.minutes += title.runtime;
  else acc.runtimeMissing++;
  var genres = title.snapshot && Array.isArray(title.snapshot.genres) ? title.snapshot.genres : [];
  for (var i = 0; i < genres.length; i++) bump(acc.genres, genres[i]);
  if (Number.isInteger(title.year)) bump(acc.decades, Math.floor(title.year / 10) * 10 + 's');
  var directors = Array.isArray(title.directorIds) ? title.directorIds : [];
  for (var j = 0; j < directors.length; j++) bump(acc.directors, directors[j]);
}

function tallyRating(viewing, acc) {
  if (viewing.rating === null || viewing.rating === undefined) return;
  acc.ratingSum += viewing.rating;
  acc.ratingCount++;
  acc.ratingSpread[viewing.rating * 2 - 1]++;
  var best = acc.bestByTitle[viewing.titleKey];
  if (!best || viewing.rating > best.rating) {
    acc.bestByTitle[viewing.titleKey] = {
      titleKey: viewing.titleKey,
      rating: viewing.rating,
      watchedOn: viewing.watchedOn
    };
  }
}

function tallyWhere(viewing, acc) {
  if (viewing.where === 'cinema') acc.where.cinema++;
  else if (viewing.where === 'home') acc.where.home++;
  else acc.where.unlogged++;
  if (viewing.where !== 'cinema') return;
  if (typeof viewing.price === 'number') {
    acc.spend += viewing.price;
    acc.spendCount++;
  }
  if (typeof viewing.cinemaName !== 'string' || viewing.cinemaName.trim() === '') return;
  var key = viewing.cinemaName.trim().toLowerCase();
  if (!acc.cinemas[key]) acc.cinemas[key] = { name: viewing.cinemaName.trim(), city: null, count: 0 };
  acc.cinemas[key].count++;
  if (acc.cinemas[key].city === null && viewing.cinemaCity) acc.cinemas[key].city = viewing.cinemaCity;
}

function tallyPoster(viewing, title, acc) {
  if (acc.posters.length >= STATS_WALL_COUNT) return;
  if (!title || !title.posterPath || acc.posterSeen[viewing.titleKey]) return;
  acc.posterSeen[viewing.titleKey] = true;
  acc.posters.push({ titleKey: viewing.titleKey, posterPath: title.posterPath });
}

// ---------- results ----------

function compareHighest(a, b) {
  if (a.rating !== b.rating) return b.rating - a.rating;
  if (a.watchedOn !== b.watchedOn) return a.watchedOn < b.watchedOn ? 1 : -1;
  return a.titleKey < b.titleKey ? -1 : 1;
}

function compareCinemas(a, b) {
  if (a.count !== b.count) return b.count - a.count;
  return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
}

function busiestMonthOf(byMonth) {
  var best = null;
  for (var i = 0; i < byMonth.length; i++) {
    if (byMonth[i] > 0 && (best === null || byMonth[i] >= byMonth[best])) best = i;
  }
  return best === null ? null : best + 1;
}

function valuesOf(object) {
  var keys = Object.keys(object);
  var out = [];
  for (var i = 0; i < keys.length; i++) out.push(object[keys[i]]);
  return out;
}

function mostVisitedCinemaOf(cinemas) {
  var rows = valuesOf(cinemas);
  if (rows.length === 0) return null;
  rows.sort(compareCinemas);
  return rows[0];
}

function newAccumulator() {
  return {
    minutes: 0, runtimeMissing: 0,
    genres: Object.create(null), decades: Object.create(null), directors: Object.create(null),
    ratingSum: 0, ratingCount: 0, ratingSpread: zeros(10), bestByTitle: Object.create(null),
    where: { cinema: 0, home: 0, unlogged: 0 },
    spend: 0, spendCount: 0, cinemas: Object.create(null),
    byMonth: zeros(12), distinct: Object.create(null),
    posters: [], posterSeen: Object.create(null)
  };
}

// viewings: all viewings. titles: { 'movie:1': titleRecord }. year: number.
// extraNames: optional { directorId: name } for names not stored on titles.
function buildYearStats(viewings, titles, year, extraNames) {
  var list = viewingsInYear(viewings, year).sort(getStatsViewingsApi().compareViewingsNewestFirst);
  var acc = newAccumulator();
  for (var i = 0; i < list.length; i++) {
    var viewing = list[i];
    var title = titles[viewing.titleKey];
    acc.distinct[viewing.titleKey] = true;
    acc.byMonth[monthOfViewing(viewing) - 1]++;
    tallyTitle(title, acc);
    tallyRating(viewing, acc);
    tallyWhere(viewing, acc);
    tallyPoster(viewing, title, acc);
  }
  var best = valuesOf(acc.bestByTitle);
  best.sort(compareHighest);
  return {
    year: year,
    films: list.length,
    distinctFilms: Object.keys(acc.distinct).length,
    hours: Math.round(acc.minutes / 60),
    runtimeMissing: acc.runtimeMissing,
    averageRating: acc.ratingCount > 0 ? Math.round((acc.ratingSum / acc.ratingCount) * 10) / 10 : null,
    ratingSpread: acc.ratingSpread,
    highestRated: best.slice(0, STATS_HIGHEST_COUNT),
    where: acc.where,
    byMonth: acc.byMonth,
    busiestMonth: busiestMonthOf(acc.byMonth),
    topGenres: topCounts(acc.genres, STATS_TOP_COUNT),
    topDecades: topCounts(acc.decades, STATS_TOP_COUNT),
    topDirectors: topDirectorsFrom(acc.directors, directorNameMap(titles, extraNames)),
    cinemaSpend: acc.spendCount > 0 ? Math.round(acc.spend * 100) / 100 : null,
    mostVisitedCinema: mostVisitedCinemaOf(acc.cinemas),
    posters: acc.posters
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    yearsWithViewings: yearsWithViewings,
    buildYearStats: buildYearStats
  };
}
