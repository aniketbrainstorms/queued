// Run with: node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const stats = require('./stats.js');

const TITLES = {
  'movie:1': {
    key: 'movie:1', title: 'Dune: Part Two', year: 2024, runtime: 166, posterPath: '/dune.jpg',
    directorIds: [10],
    snapshot: { genres: ['Sci-Fi', 'Adventure'], directors: [{ id: 10, name: 'Denis Villeneuve' }] }
  },
  'movie:2': {
    key: 'movie:2', title: 'Parasite', year: 2019, runtime: 132, posterPath: '/par.jpg',
    directorIds: [20],
    snapshot: { genres: ['Drama', 'Thriller'], directors: [{ id: 20, name: 'Bong Joon-ho' }] }
  },
  'movie:3': {
    key: 'movie:3', title: 'Heat', year: 1995, runtime: null, posterPath: null,
    directorIds: [30],
    snapshot: { genres: ['Crime', 'Drama'] }
  }
};

function viewing(id, titleKey, watchedOn, extra) {
  return Object.assign({
    id: id, titleKey: titleKey, watchedOn: watchedOn, where: null, rating: null, note: '',
    cinemaName: null, cinemaCity: null, price: null,
    createdAt: watchedOn + 'T12:00:00.000Z'
  }, extra);
}

const VIEWINGS = [
  viewing('v_a_1', 'movie:1', '2026-03-09', { where: 'cinema', cinemaName: 'Starlight', cinemaCity: 'Portland', price: 14, rating: 4.5 }),
  viewing('v_b_1', 'movie:1', '2026-03-20', { where: 'home', rating: 5 }),
  viewing('v_c_1', 'movie:2', '2026-02-14', { where: 'cinema', cinemaName: ' starlight ', cinemaCity: 'Salem', price: 10.5, rating: 3.5 }),
  viewing('v_d_1', 'movie:3', '2026-02-02', {}),
  viewing('v_e_1', 'movie:2', '2025-12-31', { where: 'home' })
];

test('yearsWithViewings lists each year once, newest first', () => {
  assert.deepEqual(stats.yearsWithViewings(VIEWINGS), [2026, 2025]);
  assert.deepEqual(stats.yearsWithViewings([]), []);
});

test('an empty year gives zeros and nulls, not errors', () => {
  const s = stats.buildYearStats([], {}, 2026);
  assert.equal(s.films, 0);
  assert.equal(s.distinctFilms, 0);
  assert.equal(s.hours, 0);
  assert.equal(s.averageRating, null);
  assert.equal(s.busiestMonth, null);
  assert.deepEqual(s.highestRated, []);
  assert.deepEqual(s.topGenres, []);
  assert.equal(s.cinemaSpend, null);
  assert.equal(s.mostVisitedCinema, null);
  assert.deepEqual(s.posters, []);
  assert.equal(s.byMonth.length, 12);
  assert.equal(s.ratingSpread.length, 10);
});

test('films, distinct films, hours and missing runtimes', () => {
  const s = stats.buildYearStats(VIEWINGS, TITLES, 2026);
  assert.equal(s.films, 4);
  assert.equal(s.distinctFilms, 3);
  assert.equal(s.hours, 8);
  assert.equal(s.runtimeMissing, 1);
});

test('average rating, spread and highest rated', () => {
  const s = stats.buildYearStats(VIEWINGS, TITLES, 2026);
  assert.equal(s.averageRating, 4.3);
  assert.deepEqual(s.ratingSpread, [0, 0, 0, 0, 0, 0, 1, 0, 1, 1]);
  assert.deepEqual(s.highestRated, [
    { titleKey: 'movie:1', rating: 5, watchedOn: '2026-03-20' },
    { titleKey: 'movie:2', rating: 3.5, watchedOn: '2026-02-14' }
  ]);
});

test('cinema vs home counts leave bare viewings out of the split', () => {
  const s = stats.buildYearStats(VIEWINGS, TITLES, 2026);
  assert.deepEqual(s.where, { cinema: 2, home: 1, unlogged: 1 });
});

test('busiest month: ties go to the later month', () => {
  const s = stats.buildYearStats(VIEWINGS, TITLES, 2026);
  assert.equal(s.byMonth[1], 2);
  assert.equal(s.byMonth[2], 2);
  assert.equal(s.busiestMonth, 3);
});

test('top genres and decades: counted per viewing, ties alphabetical', () => {
  const s = stats.buildYearStats(VIEWINGS, TITLES, 2026);
  assert.deepEqual(s.topGenres, [
    { label: 'Adventure', count: 2 },
    { label: 'Drama', count: 2 },
    { label: 'Sci-Fi', count: 2 },
    { label: 'Crime', count: 1 },
    { label: 'Thriller', count: 1 }
  ]);
  assert.deepEqual(s.topDecades, [
    { label: '2020s', count: 2 },
    { label: '1990s', count: 1 },
    { label: '2010s', count: 1 }
  ]);
});

test('top directors use stored names and leave unknown names null', () => {
  const s = stats.buildYearStats(VIEWINGS, TITLES, 2026);
  assert.deepEqual(s.topDirectors, [
    { id: 10, name: 'Denis Villeneuve', count: 2 },
    { id: 20, name: 'Bong Joon-ho', count: 1 },
    { id: 30, name: null, count: 1 }
  ]);
});

test('extra director names fill the gaps', () => {
  const s = stats.buildYearStats(VIEWINGS, TITLES, 2026, { 30: 'Michael Mann' });
  assert.equal(s.topDirectors[2].name, 'Michael Mann');
});

test('cinema spend and most visited cinema', () => {
  const s = stats.buildYearStats(VIEWINGS, TITLES, 2026);
  assert.equal(s.cinemaSpend, 24.5);
  assert.deepEqual(s.mostVisitedCinema, { name: 'Starlight', city: 'Portland', count: 2 });
});

test('cinema spend is null when no cinema viewing has a price', () => {
  const free = [viewing('v_a_1', 'movie:1', '2026-03-09', { where: 'cinema', cinemaName: 'Odeon' })];
  const s = stats.buildYearStats(free, TITLES, 2026);
  assert.equal(s.cinemaSpend, null);
});

test('posters: newest first, one per film, none without a poster', () => {
  const s = stats.buildYearStats(VIEWINGS, TITLES, 2026);
  assert.deepEqual(s.posters, [
    { titleKey: 'movie:1', posterPath: '/dune.jpg' },
    { titleKey: 'movie:2', posterPath: '/par.jpg' }
  ]);
});

test('posters are capped at ten', () => {
  const titles = {};
  const many = [];
  for (let i = 1; i <= 12; i++) {
    titles['movie:' + i] = { key: 'movie:' + i, runtime: 100, posterPath: '/p' + i + '.jpg', snapshot: {} };
    many.push(viewing('v_x_' + i, 'movie:' + i, '2026-01-' + String(i).padStart(2, '0'), {}));
  }
  const s = stats.buildYearStats(many, titles, 2026);
  assert.equal(s.posters.length, 10);
  assert.equal(s.posters[0].titleKey, 'movie:12');
});
