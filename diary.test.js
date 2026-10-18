// Run with: node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('./diary.js');

const OPTIONS = {
  currency: '$',
  icon: (name) => '<i data-i="' + name + '"></i>',
  poster: (title) => '<img data-p="' + title.key + '">'
};

const DUNE = { key: 'movie:1', title: 'Dune: Part Two', year: 2024 };

function viewing(extra) {
  return Object.assign({
    id: 'v_abc_123', titleKey: 'movie:1', watchedOn: '2026-03-09', where: null, rating: null, note: '',
    format: null, withWhom: null, cinemaName: null, cinemaCity: null, screen: null, seat: null,
    price: null, source: null, service: null, device: null, createdAt: '2026-03-09T12:00:00.000Z'
  }, extra);
}

const CINEMA = viewing({
  where: 'cinema', cinemaName: 'Starlight Cinema', cinemaCity: 'Portland', format: 'IMAX',
  screen: '3', seat: 'F12', withWhom: 'Riya, Kabir', price: 14, rating: 4.5, note: 'Sandworm scene shook the seats.'
});

test('a cinema stub shows every filled field, the date, stars and a Cinema tag', () => {
  const html = d.stubHtml(CINEMA, DUNE, OPTIONS);
  assert.match(html, /class="stub stub-cinema"/);
  assert.match(html, /data-viewing-id="v_abc_123"/);
  assert.match(html, /Dune: Part Two/);
  assert.match(html, /2024/);
  for (const text of ['Starlight Cinema, Portland', 'IMAX', 'Screen 3, seat F12', 'Riya, Kabir', '\$14']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /data-i="map-pin"/);
  assert.match(html, /Sandworm scene shook the seats\./);
  assert.match(html, /stub-month">MAR</);
  assert.match(html, /stub-day">09</);
  assert.ok(html.includes('\u2605\u2605\u2605\u2605\u00bd'));
  assert.match(html, /stub-tag">Cinema</);
  assert.match(html, /<img data-p="movie:1">/);
});

test('a home stub has no Cinema tag and its own fields', () => {
  const html = d.stubHtml(viewing({ where: 'home', source: 'streaming', service: 'Max', device: 'laptop', format: '4K', rating: 5 }), DUNE, OPTIONS);
  assert.match(html, /class="stub stub-home"/);
  assert.ok(!html.includes('stub-tag'));
  assert.ok(html.includes('Streaming, Max'));
  assert.ok(html.includes('Laptop'));
  assert.ok(html.includes('4K'));
});

test('a bare stub shows only the title and date', () => {
  const html = d.stubHtml(viewing({}), DUNE, OPTIONS);
  assert.match(html, /class="stub stub-bare"/);
  assert.ok(!html.includes('stub-fields'));
  assert.ok(!html.includes('stub-note'));
  assert.ok(!html.includes('stub-stars'));
  assert.ok(!html.includes('stub-tag'));
  assert.match(html, /stub-day">09</);
});

test('blank fields and an empty note leave no rows behind', () => {
  const html = d.stubHtml(viewing({ where: 'cinema', cinemaName: 'Odeon' }), DUNE, OPTIONS);
  assert.equal((html.match(/<li>/g) || []).length, 1);
  assert.ok(!html.includes('stub-note'));
});

test('everything the user typed is escaped', () => {
  const html = d.stubHtml(viewing({ where: 'cinema', cinemaName: '<script>x</script>', note: '"hi" & <b>' }),
    { key: 'movie:1', title: '<img onerror=x>', year: 2024 }, OPTIONS);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>'));
  assert.ok(!html.includes('<img onerror'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&quot;hi&quot; &amp; &lt;b&gt;'));
});

test('the stub has an accessible label with title, date, place and rating', () => {
  const html = d.stubHtml(CINEMA, DUNE, OPTIONS);
  assert.ok(html.includes('aria-label="Dune: Part Two, 9 March 2026, cinema, rated 4.5 out of 5"'));
  assert.ok(d.stubHtml(viewing({}), DUNE, OPTIONS).includes('aria-label="Dune: Part Two, 9 March 2026"'));
});

test('a compact stub drops the poster and title for use inside a film page', () => {
  const html = d.stubHtml(CINEMA, DUNE, Object.assign({ compact: true }, OPTIONS));
  assert.match(html, /stub-compact/);
  assert.ok(!html.includes('stub-poster'));
  assert.ok(!html.includes('stub-title'));
  assert.ok(html.includes('Starlight Cinema, Portland'));
  const bare = d.stubHtml(viewing({}), DUNE, Object.assign({ compact: true }, OPTIONS));
  assert.ok(bare.includes('No details logged'));
});

test('a stub for a film that is missing says so instead of failing', () => {
  assert.ok(d.stubHtml(viewing({}), null, OPTIONS).includes('Unknown title'));
});

test('filterViewings keeps everything, only cinema, or only home', () => {
  const list = [viewing({ id: 'v_a_1', where: 'cinema' }), viewing({ id: 'v_b_1', where: 'home' }), viewing({ id: 'v_c_1' })];
  assert.equal(d.filterViewings(list, 'all').length, 3);
  assert.deepEqual(d.filterViewings(list, 'cinema').map((x) => x.id), ['v_a_1']);
  assert.deepEqual(d.filterViewings(list, 'home').map((x) => x.id), ['v_b_1']);
  assert.equal(d.filterViewings(list, 'nonsense').length, 3);
});

test('groupByMonth keeps order and starts a group when the month changes', () => {
  const list = [
    viewing({ id: 'v_a_1', watchedOn: '2026-03-20' }), viewing({ id: 'v_b_1', watchedOn: '2026-03-09' }),
    viewing({ id: 'v_c_1', watchedOn: '2026-02-14' }), viewing({ id: 'v_d_1', watchedOn: '2025-03-01' })
  ];
  const groups = d.groupByMonth(list);
  assert.deepEqual(groups.map((g) => g.label), ['March 2026', 'February 2026', 'March 2025']);
  assert.deepEqual(groups[0].viewings.map((x) => x.id), ['v_a_1', 'v_b_1']);
});

test('diaryHtml shows filter chips with the chosen one pressed, then month groups', () => {
  const list = [viewing({ id: 'v_a_1', watchedOn: '2026-03-20', where: 'cinema' }), viewing({ id: 'v_c_1', watchedOn: '2026-02-14', where: 'home' })];
  const html = d.diaryHtml(list, { 'movie:1': DUNE }, 'all', OPTIONS);
  assert.match(html, /data-filter="all"[^>]*aria-pressed="true"/);
  assert.match(html, /data-filter="cinema"[^>]*aria-pressed="false"/);
  assert.ok(html.indexOf('March 2026') < html.indexOf('February 2026'));
  assert.equal((html.match(/class="stub /g) || []).length, 2);
  const onlyHome = d.diaryHtml(list, { 'movie:1': DUNE }, 'home', OPTIONS);
  assert.match(onlyHome, /data-filter="home"[^>]*aria-pressed="true"/);
  assert.equal((onlyHome.match(/class="stub /g) || []).length, 1);
});

test('diaryHtml explains an empty diary and an empty filter', () => {
  assert.ok(d.diaryHtml([], {}, 'all', OPTIONS).includes('No viewings yet'));
  const list = [viewing({ where: 'home' })];
  assert.ok(d.diaryHtml(list, { 'movie:1': DUNE }, 'cinema', OPTIONS).includes('No cinema viewings yet'));
  assert.ok(d.diaryHtml([], {}, 'home', OPTIONS).includes('No viewings yet'));
});

test('viewingsBlockHtml lists a film\'s stubs and offers to log another', () => {
  const html = d.viewingsBlockHtml([CINEMA], DUNE, OPTIONS);
  assert.match(html, /id="viewings-block"/);
  assert.match(html, /stub-compact/);
  assert.match(html, /id="log-another"/);
  assert.ok(html.includes('Log another viewing'));
  const empty = d.viewingsBlockHtml([], DUNE, OPTIONS);
  assert.ok(empty.includes('No viewings logged yet.'));
  assert.match(empty, /id="log-another"/);
});
