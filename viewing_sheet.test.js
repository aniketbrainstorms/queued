// Run with: node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./viewing_sheet.js');

const TODAY = '2026-10-17';
const CONTEXT = { title: 'Dune: Part Two', today: TODAY, currency: '$', icon: (name) => '<i data-i="' + name + '"></i>' };

function stored(extra) {
  return Object.assign({
    id: 'v_abc_123', titleKey: 'movie:1', watchedOn: '2026-03-09', where: null, rating: null, note: '',
    format: null, withWhom: null, cinemaName: null, cinemaCity: null, screen: null, seat: null,
    price: null, source: null, service: null, device: null
  }, extra);
}

// ---------- the draft ----------

test('a new draft starts on today, at home, with nothing filled in', () => {
  const draft = s.newDraft('movie:1', TODAY);
  assert.equal(draft.id, null);
  assert.equal(draft.titleKey, 'movie:1');
  assert.equal(draft.watchedOn, TODAY);
  assert.equal(draft.where, 'home');
  assert.equal(draft.rating, null);
  assert.equal(draft.price, '');
});

test('a draft from a bare viewing opens on Home with the date and rating kept', () => {
  const draft = s.draftFromViewing(stored({ rating: 3.5, note: 'ok' }));
  assert.equal(draft.id, 'v_abc_123');
  assert.equal(draft.where, 'home');
  assert.equal(draft.watchedOn, '2026-03-09');
  assert.equal(draft.rating, 3.5);
  assert.equal(draft.note, 'ok');
  assert.equal(draft.cinemaName, '');
});

test('a draft from a cinema viewing turns every value into text', () => {
  const draft = s.draftFromViewing(stored({ where: 'cinema', cinemaName: 'Odeon', price: 9.5, seat: 'A1' }));
  assert.equal(draft.where, 'cinema');
  assert.equal(draft.cinemaName, 'Odeon');
  assert.equal(draft.price, '9.5');
  assert.equal(draft.seat, 'A1');
});

test('switching to Home clears the cinema fields but keeps the shared ones', () => {
  const start = Object.assign(s.newDraft('movie:1', TODAY), {
    where: 'cinema', cinemaName: 'Odeon', cinemaCity: 'Leeds', screen: '2', seat: 'B3', price: '9', format: 'IMAX', withWhom: 'Sam', rating: 4
  });
  const next = s.setWhere(start, 'home');
  assert.equal(next.where, 'home');
  assert.equal(next.cinemaName, '');
  assert.equal(next.price, '');
  assert.equal(next.format, 'IMAX');
  assert.equal(next.withWhom, 'Sam');
  assert.equal(next.rating, 4);
  assert.equal(start.cinemaName, 'Odeon');
});

test('switching to Cinema clears the home fields', () => {
  const start = Object.assign(s.newDraft('movie:1', TODAY), { source: 'streaming', service: 'Max', device: 'tv', format: '4K' });
  const next = s.setWhere(start, 'cinema');
  assert.equal(next.where, 'cinema');
  assert.equal(next.source, '');
  assert.equal(next.service, '');
  assert.equal(next.device, '');
  assert.equal(next.format, '4K');
});

test('choosing a source or device twice clears it, and leaving streaming clears the service', () => {
  let draft = s.newDraft('movie:1', TODAY);
  draft = s.toggleChoice(draft, 'source', 'streaming');
  draft = s.setField(draft, 'service', 'Max');
  assert.equal(draft.source, 'streaming');
  draft = s.toggleChoice(draft, 'source', 'disc');
  assert.equal(draft.source, 'disc');
  assert.equal(draft.service, '');
  draft = s.toggleChoice(draft, 'source', 'disc');
  assert.equal(draft.source, '');
  draft = s.toggleChoice(draft, 'device', 'tv');
  assert.equal(draft.device, 'tv');
  draft = s.toggleChoice(draft, 'format', 'IMAX');
  assert.equal(draft.format, 'IMAX');
  draft = s.toggleChoice(draft, 'format', 'IMAX');
  assert.equal(draft.format, '');
});

test('setField only changes the fields a person can edit', () => {
  const draft = s.newDraft('movie:1', TODAY);
  assert.equal(s.setField(draft, 'seat', 'F12').seat, 'F12');
  assert.equal(s.setField(draft, 'id', 'v_evil_1').id, null);
  assert.equal(s.setField(draft, 'titleKey', 'movie:9').titleKey, 'movie:1');
  assert.equal(s.setField(draft, 'where', 'cinema').where, 'home');
});

test('tapping a star half sets that rating, and tapping it again clears it', () => {
  assert.equal(s.toggleRating(null, 4.5), 4.5);
  assert.equal(s.toggleRating(4.5, 4.5), null);
  assert.equal(s.toggleRating(3, 0.5), 0.5);
});

// ---------- from the draft to a viewing ----------

test('a cinema draft becomes a viewing input, with price read as a number', () => {
  const draft = Object.assign(s.newDraft('movie:1', TODAY), {
    where: 'cinema', cinemaName: ' Starlight ', cinemaCity: 'Portland', screen: '3', seat: 'F12', price: '9,50',
    format: 'IMAX', withWhom: 'Riya', rating: 4.5, note: ' loud '
  });
  const out = s.inputFromDraft(draft, TODAY);
  assert.equal(out.error, null);
  assert.deepEqual(out.input, {
    titleKey: 'movie:1', watchedOn: TODAY, where: 'cinema', rating: 4.5, note: 'loud', format: 'IMAX', withWhom: 'Riya',
    cinemaName: 'Starlight', cinemaCity: 'Portland', screen: '3', seat: 'F12', price: 9.5,
    source: null, service: null, device: null
  });
});

test('a home draft becomes a viewing input and blanks become null', () => {
  const draft = Object.assign(s.newDraft('movie:1', TODAY), { source: 'streaming', service: 'Max', device: 'laptop' });
  const out = s.inputFromDraft(draft, TODAY);
  assert.equal(out.error, null);
  assert.equal(out.input.where, 'home');
  assert.equal(out.input.source, 'streaming');
  assert.equal(out.input.service, 'Max');
  assert.equal(out.input.device, 'laptop');
  assert.equal(out.input.format, null);
  assert.equal(out.input.cinemaName, null);
  assert.equal(out.input.price, null);
});

test('a service name is dropped unless the source is streaming', () => {
  const draft = Object.assign(s.newDraft('movie:1', TODAY), { source: 'disc', service: 'Max' });
  assert.equal(s.inputFromDraft(draft, TODAY).input.service, null);
});

test('an empty price is fine and a bad one is explained', () => {
  const base = Object.assign(s.newDraft('movie:1', TODAY), { where: 'cinema' });
  assert.equal(s.inputFromDraft(base, TODAY).input.price, null);
  assert.equal(s.inputFromDraft(Object.assign({}, base, { price: '12' }), TODAY).input.price, 12);
  for (const bad of ['abc', '-3', '1e999']) {
    const out = s.inputFromDraft(Object.assign({}, base, { price: bad }), TODAY);
    assert.equal(out.input, null);
    assert.match(out.error, /Price/);
  }
});

test('the date must be filled in and not in the future', () => {
  const draft = s.newDraft('movie:1', TODAY);
  assert.match(s.inputFromDraft(Object.assign({}, draft, { watchedOn: '' }), TODAY).error, /date/);
  assert.match(s.inputFromDraft(Object.assign({}, draft, { watchedOn: '2026-10-18' }), TODAY).error, /future/);
  assert.equal(s.inputFromDraft(Object.assign({}, draft, { watchedOn: TODAY }), TODAY).error, null);
});

// ---------- the sheet's HTML ----------

test('the sheet has a date, a Cinema and Home toggle, rating, note and a save button', () => {
  const html = s.sheetHtml(s.newDraft('movie:1', TODAY), 'create', CONTEXT);
  assert.match(html, /Log a viewing/);
  assert.match(html, /Dune: Part Two/);
  assert.match(html, /id="vw-date"[^>]*value="2026-10-17"[^>]*max="2026-10-17"/);
  assert.match(html, /data-where="home"[^>]*aria-pressed="true"/);
  assert.match(html, /data-where="cinema"[^>]*aria-pressed="false"/);
  assert.match(html, /id="vw-note"[^>]*maxlength="80"/);
  assert.match(html, /id="vw-count"[^>]*>0\/80</);
  assert.match(html, /id="vw-save"/);
  assert.ok(!html.includes('id="vw-delete"'));
});

test('edit mode offers Delete, and asks again once it has been tapped', () => {
  const draft = s.draftFromViewing(stored({}));
  assert.match(s.sheetHtml(draft, 'edit', CONTEXT), /Edit viewing/);
  assert.match(s.sheetHtml(draft, 'edit', CONTEXT), /id="vw-delete"[^>]*>Delete</);
  const asking = s.sheetHtml(draft, 'edit', Object.assign({ confirmDelete: true }, CONTEXT));
  assert.match(asking, /id="vw-delete"[^>]*>Tap again to delete</);
});

test('Cinema shows the cinema fields and a price labelled with the currency', () => {
  const html = s.sheetHtml(Object.assign(s.newDraft('movie:1', TODAY), { where: 'cinema' }), 'create', CONTEXT);
  for (const key of ['cinemaName', 'cinemaCity', 'screen', 'seat', 'price', 'withWhom', 'format']) {
    assert.ok(html.includes('id="vw-' + key + '"'), key);
  }
  assert.ok(html.includes('Price ($)'));
  assert.ok(html.includes('data-choice="format" data-value="IMAX"'));
  assert.ok(!html.includes('data-choice="source"'));
  assert.ok(!html.includes('id="vw-device"'));
});

test('Home shows source, device, format and company, and the service only for streaming', () => {
  const home = s.newDraft('movie:1', TODAY);
  const html = s.sheetHtml(home, 'create', CONTEXT);
  assert.ok(html.includes('data-choice="source" data-value="streaming"'));
  assert.ok(html.includes('data-choice="device" data-value="laptop"'));
  assert.ok(html.includes('data-choice="format" data-value="4K"'));
  assert.ok(html.includes('id="vw-withWhom"'));
  assert.ok(!html.includes('id="vw-cinemaName"'));
  assert.ok(!html.includes('id="vw-service"'));
  const streaming = s.sheetHtml(s.toggleChoice(home, 'source', 'streaming'), 'create', CONTEXT);
  assert.ok(streaming.includes('id="vw-service"'));
  assert.match(streaming, /data-choice="source" data-value="streaming"[^>]*aria-pressed="true"/);
});

test('stars show whole, half and empty, and the pressed half is marked', () => {
  const html = s.sheetHtml(Object.assign(s.newDraft('movie:1', TODAY), { rating: 3.5 }), 'create', CONTEXT);
  const fills = [...html.matchAll(/class="star" data-fill="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(fills, ['full', 'full', 'full', 'half', 'empty']);
  assert.match(html, /data-rate="3.5"[^>]*aria-pressed="true"/);
  assert.match(html, /data-rate="4"[^>]*aria-pressed="false"/);
  assert.ok(html.includes('id="vw-rating-text">3.5<'));
  const none = s.sheetHtml(s.newDraft('movie:1', TODAY), 'create', CONTEXT);
  assert.ok(none.includes('id="vw-rating-text">No rating<'));
});

test('typed values are escaped in the form', () => {
  const draft = Object.assign(s.newDraft('movie:1', TODAY), { where: 'cinema', cinemaName: '"><script>x</script>', note: '<b>hi</b>' });
  const html = s.sheetHtml(draft, 'create', Object.assign({}, CONTEXT, { title: '<i>T</i>' }));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>hi'));
  assert.ok(!html.includes('<i>T'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
});

test('the Log details prompt names the film and escapes it', () => {
  const html = s.logPromptHtml('<b>Heat</b>');
  assert.ok(html.includes('&lt;b&gt;Heat&lt;/b&gt;'));
  assert.match(html, /id="prompt-log"/);
  assert.match(html, /data-close[^>]*>Skip</);
});
