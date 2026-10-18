// Run with: node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('./viewings.js');

const CTX = { today: '2026-10-17', now: '2026-10-17T10:00:00.000Z' };

function base(extra) {
  return Object.assign({ id: 'v_abc_123', titleKey: 'movie:603', watchedOn: '2026-10-01' }, extra);
}

test('a bare viewing keeps only date, rating and note', () => {
  const out = v.cleanViewing(base({ rating: 4.5, note: '  great  ', cinemaName: 'Odeon', source: 'disc' }), CTX);
  assert.equal(out.error, null);
  assert.equal(out.value.where, null);
  assert.equal(out.value.rating, 4.5);
  assert.equal(out.value.note, 'great');
  assert.equal(out.value.cinemaName, null);
  assert.equal(out.value.source, null);
  assert.equal(out.value.createdAt, CTX.now);
  assert.equal(out.value.updatedAt, CTX.now);
});

test('a cinema viewing keeps cinema fields and drops home fields', () => {
  const out = v.cleanViewing(base({
    where: 'cinema', cinemaName: ' Starlight ', cinemaCity: 'Portland', screen: '3', seat: 'F12',
    format: 'IMAX', withWhom: 'Riya', price: 14, source: 'streaming', device: 'tv'
  }), CTX);
  assert.equal(out.error, null);
  assert.equal(out.value.cinemaName, 'Starlight');
  assert.equal(out.value.price, 14);
  assert.equal(out.value.format, 'IMAX');
  assert.equal(out.value.withWhom, 'Riya');
  assert.equal(out.value.source, null);
  assert.equal(out.value.device, null);
});

test('a home viewing keeps home fields and drops cinema fields', () => {
  const out = v.cleanViewing(base({
    where: 'home', source: 'streaming', service: 'Max', device: 'laptop', format: '4K',
    cinemaName: 'Odeon', price: 9
  }), CTX);
  assert.equal(out.error, null);
  assert.equal(out.value.source, 'streaming');
  assert.equal(out.value.service, 'Max');
  assert.equal(out.value.device, 'laptop');
  assert.equal(out.value.cinemaName, null);
  assert.equal(out.value.price, null);
});

test('service is only kept when the source is streaming', () => {
  const out = v.cleanViewing(base({ where: 'home', source: 'disc', service: 'Max' }), CTX);
  assert.equal(out.value.service, null);
});

test('empty strings become null', () => {
  const out = v.cleanViewing(base({ where: 'cinema', cinemaName: '   ', seat: '' }), CTX);
  assert.equal(out.value.cinemaName, null);
  assert.equal(out.value.seat, null);
});

test('bad input is reported, not thrown', () => {
  const cases = [
    [null, /required/],
    [base({ titleKey: 'tv:5' }), /titleKey/],
    [base({ watchedOn: '2026-02-30' }), /watchedOn/],
    [base({ watchedOn: '2026-10-18' }), /future/],
    [base({ where: 'moon' }), /where/],
    [base({ rating: 4.3 }), /rating/],
    [base({ rating: 0 }), /rating/],
    [base({ rating: 5.5 }), /rating/],
    [base({ note: 'x'.repeat(81) }), /note/],
    [base({ where: 'cinema', price: -1 }), /price/],
    [base({ where: 'cinema', cinemaName: 'x'.repeat(61) }), /cinemaName/],
    [base({ where: 'home', source: 'carrier pigeon' }), /source/],
    [base({ where: 'home', device: 'toaster' }), /device/],
    [base({ id: 'nope' }), /id/]
  ];
  for (const [input, pattern] of cases) {
    const out = v.cleanViewing(input, CTX);
    assert.equal(out.value, null);
    assert.match(out.error, pattern);
  }
});

test('createdAt and updatedAt are kept when valid', () => {
  const out = v.cleanViewing(base({ createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }), CTX);
  assert.equal(out.value.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(out.value.updatedAt, '2026-02-01T00:00:00.000Z');
});

test('localDateString uses the local calendar day', () => {
  assert.equal(v.localDateString(new Date(2026, 9, 7, 23, 59)), '2026-10-07');
  assert.equal(v.localDateString(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
});

test('makeViewingId always passes cleaning', () => {
  for (const r of [0, 0.5, 0.123456789, 0.999999]) {
    const id = v.makeViewingId(1760000000000, r);
    assert.match(id, /^v_[a-z0-9]+_[a-z0-9]+$/);
  }
});

// ---------- helpers: bare viewings, film rating, ordering ----------

test('makeBareViewing builds a clean record with no details', () => {
  const rec = v.makeBareViewing('movie:7', 'v_x_1', CTX);
  assert.equal(rec.id, 'v_x_1');
  assert.equal(rec.titleKey, 'movie:7');
  assert.equal(rec.watchedOn, '2026-10-17');
  assert.equal(rec.where, null);
  assert.equal(rec.rating, null);
  assert.equal(rec.note, '');
  assert.equal(rec.price, null);
  assert.equal(rec.createdAt, CTX.now);
});

function viewing(id, watchedOn, rating, createdAt) {
  return { id: id, watchedOn: watchedOn, rating: rating, createdAt: createdAt || '2026-01-01T00:00:00.000Z' };
}

test('filmRatingFromViewings takes the latest rated viewing', () => {
  const list = [
    viewing('v_a_1', '2025-01-01', 3),
    viewing('v_b_1', '2026-05-01', 4.5),
    viewing('v_c_1', '2026-09-01', null)
  ];
  assert.equal(v.filmRatingFromViewings(list), 4.5);
});

test('filmRatingFromViewings breaks date ties by createdAt', () => {
  const list = [
    viewing('v_a_1', '2026-05-01', 2, '2026-05-01T08:00:00.000Z'),
    viewing('v_b_1', '2026-05-01', 3.5, '2026-05-01T09:00:00.000Z')
  ];
  assert.equal(v.filmRatingFromViewings(list), 3.5);
});

test('filmRatingFromViewings is null with no rated viewings', () => {
  assert.equal(v.filmRatingFromViewings([]), null);
  assert.equal(v.filmRatingFromViewings([viewing('v_a_1', '2026-05-01', null)]), null);
});

test('compareViewingsNewestFirst sorts by date, then createdAt, then id', () => {
  const list = [
    viewing('v_a_1', '2026-01-01', null, '2026-01-01T00:00:00.000Z'),
    viewing('v_b_1', '2026-03-01', null, '2026-03-01T00:00:00.000Z'),
    viewing('v_c_1', '2026-03-01', null, '2026-03-01T05:00:00.000Z'),
    viewing('v_d_1', '2026-03-01', null, '2026-03-01T05:00:00.000Z')
  ];
  list.sort(v.compareViewingsNewestFirst);
  assert.deepEqual(list.map((x) => x.id), ['v_d_1', 'v_c_1', 'v_b_1', 'v_a_1']);
});
