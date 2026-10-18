# Viewings Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Queued a tested data layer for viewings: the record and its cleaning rules, the year-in-review numbers, the IndexedDB store with migration and backup v2, the currency setting, and director names on new films.

**Architecture:** Two new pure modules (`viewings.js`, `stats.js`) hold all rules and arithmetic and have no database or page access. `db.js` gets a version 2 `viewings` store and calls into `viewings.js`. Everything is plain classic scripts with flat functions (no nested functions), loaded by `<script>` tags in the browser and by `require` under `node --test` with `fake-indexeddb`.

**Tech Stack:** Vanilla JS, IndexedDB, `node:test`, `fake-indexeddb`.

**Spec:** `docs/superpowers/specs/2026-10-17-viewings-diary-and-year-in-review-design.md`

---

## Where this plan sits

The spec is split into three plans, each leaving the app working:

1. **This plan: data layer.** No visible change in the app yet, except that every film marked Watched now also gets a bare viewing.
2. **Plan 2: viewings screens.** Log sheet, "Log details?" prompt, detail sheet section, Diary tab, ticket stubs (including the spec's stub field list in `viewings.js`).
3. **Plan 3: year-in-review.** Stats screen, share card, the service worker rule for CORS poster requests, and the `stats.js` script tag and `SHELL_FILES` entry.

## Before you start

- Node 18 or newer. From the project folder run `npm install`, then `node --test`. Expected: every test passes (`# fail 0`).
- Every command below runs from the project folder (the one containing `index.html`).
- If you do not use git locally (you upload through the GitHub website), skip the commit steps and upload the changed files when the task is green.
- Code style rule for this codebase: flat top-level functions, no functions defined inside other functions. IndexedDB callbacks use `.bind()`. Test files may use arrow functions.

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `viewings.js` | create | What a viewing is; cleaning and validating one; bare viewings; the film rating rule; ordering. Pure. |
| `viewings.test.js` | create | Tests for the above. |
| `stats.js` | create | Year-in-review numbers from viewings and titles. Pure. |
| `stats.test.js` | create | Tests for the above. |
| `db.js` | modify | Version 2 schema, migration, viewing functions, the "became watched" hooks, delete cascade, backup v2. |
| `db.test.js` | modify | Tests for all of the db changes. |
| `settings.js`, `settings.test.js` | modify | Currency symbol setting. |
| `tmdb.js`, `tmdb.test.js` | modify | Director names saved on new films. |
| `index.html`, `sw.js` | modify | Load `viewings.js` before `db.js`; cache it for offline; bump cache version. |
| `browser_scripts.test.js` | create | Loads the scripts like a browser does, to catch name clashes and missing globals. |

## What this plan adds to `db.js` (used by Plans 2 and 3)

| Function | Returns |
| --- | --- |
| `addViewing(input)` | The saved viewing. `input` has the viewing's fields without `id`, `createdAt`, `updatedAt`. Throws `INVALID` or `NOT_FOUND`. |
| `updateViewing(id, changes)` | The saved viewing. `id`, `titleKey`, `createdAt` cannot change. Changing `where` drops the other place's fields. |
| `deleteViewing(id)` | `true` if it existed. Never changes the film's status. |
| `getViewings(titleKey)` | That film's viewings, newest first. |
| `getAllViewings()` | Every viewing, newest first. |

Also: `markWatched`, `setStatus`, `updateTitle` (to `watched`) and `addTitle` (as `watched`) each create one bare viewing dated today for a movie that was not already watched. `markWatched` still returns the title only; Plan 2 reads the new viewing with `getViewings(key)` (it is the newest). `exportAll`/`importAll` handle a `viewings` list at format version 2. `settings.js` gains `loadCurrencySymbol()` and `saveCurrencySymbol(raw)`. `tmdb.titleFromMovie` saves `snapshot.directors`.

---

### Task 1: viewings.js: the viewing record and its cleaning rules

**Files:**
- Create: `viewings.js`
- Create: `viewings.test.js`

- [ ] **Step 1: Write the failing test**

Create `viewings.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test viewings.test.js`
Expected: FAIL with `Cannot find module './viewings.js'`.

- [ ] **Step 3: Write the implementation**

Create `viewings.js`:

```js
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VIEWING_WHERE: VIEWING_WHERE,
    VIEWING_SOURCES: VIEWING_SOURCES,
    VIEWING_DEVICES: VIEWING_DEVICES,
    VIEWING_NOTE_MAX: VIEWING_NOTE_MAX,
    localDateString: localDateString,
    makeViewingId: makeViewingId,
    cleanViewing: cleanViewing
  };
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `node --test viewings.test.js`
Expected: 9 tests pass, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add viewings.js viewings.test.js
git commit -m "feat: viewing record and cleaning rules"
```

### Task 2: viewings.js: bare viewings, film rating, ordering

**Files:**
- Modify: `viewings.js`
- Modify: `viewings.test.js`

- [ ] **Step 1: Write the failing tests**

Append to the end of `viewings.test.js`:

```js

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
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test viewings.test.js`
Expected: the 5 new tests FAIL with `v.makeBareViewing is not a function` (or the same for `filmRatingFromViewings` / `compareViewingsNewestFirst`); the first 9 still pass.

- [ ] **Step 3: Write the implementation**

In `viewings.js`, insert this immediately above the line `if (typeof module !== 'undefined' && module.exports) {`:

```js
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
```

Then replace the export block at the bottom of `viewings.js`.

Find:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VIEWING_WHERE: VIEWING_WHERE,
    VIEWING_SOURCES: VIEWING_SOURCES,
    VIEWING_DEVICES: VIEWING_DEVICES,
    VIEWING_NOTE_MAX: VIEWING_NOTE_MAX,
    localDateString: localDateString,
    makeViewingId: makeViewingId,
    cleanViewing: cleanViewing
  };
}
```

Replace with:

```js
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
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test viewings.test.js`
Expected: 14 tests pass, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add viewings.js viewings.test.js
git commit -m "feat: bare viewings, film rating rule, ordering"
```

### Task 3: stats.js: the year-in-review numbers

**Files:**
- Create: `stats.js`
- Create: `stats.test.js`

- [ ] **Step 1: Write the failing tests**

Create `stats.test.js`:

```js
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
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test stats.test.js`
Expected: FAIL with `Cannot find module './stats.js'`.

- [ ] **Step 3: Write the implementation**

Create `stats.js` (not loaded by `index.html` yet; Plan 3 adds that when the stats screen needs it):

```js
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
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test stats.test.js`
Expected: 13 tests pass, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add stats.js stats.test.js
git commit -m "feat: year-in-review stats"
```

### Task 4: db.js: schema version 2, and carrying existing films over

**Files:**
- Modify: `db.js`

- [ ] **Step 1: Write the failing tests**

Append to the end of `db.test.js`:

```js

// ---------- viewings: schema version 2 and migration ----------

const viewingsLib = require('./viewings.js');

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Builds a database exactly as version 1 of Queued left it, then closes it,
// so the next openDb() has to upgrade it.
async function seedVersion1(titles, logEntries) {
  await db.deleteDb();
  const open = indexedDB.open('queued-db', 1);
  open.onupgradeneeded = () => {
    const d = open.result;
    const t = d.createObjectStore('titles', { keyPath: 'key' });
    t.createIndex('status', 'status');
    t.createIndex('type', 'type');
    d.createObjectStore('progress', { keyPath: 'key' });
    const l = d.createObjectStore('watch_log', { keyPath: 'id', autoIncrement: true });
    l.createIndex('titleKey', 'titleKey');
    l.createIndex('at', 'at');
    d.createObjectStore('lists', { keyPath: 'id', autoIncrement: true });
    const i = d.createObjectStore('list_items', { keyPath: 'id', autoIncrement: true });
    i.createIndex('listId', 'listId');
    i.createIndex('titleKey', 'titleKey');
    const c = d.createObjectStore('cache', { keyPath: 'key' });
    c.createIndex('expiresAt', 'expiresAt');
  };
  const conn = await idbRequest(open);
  const tx = conn.transaction(['titles', 'watch_log'], 'readwrite');
  for (const t of titles) tx.objectStore('titles').put(t);
  for (const e of logEntries) tx.objectStore('watch_log').add(e);
  await idbTxDone(tx);
  conn.close();
}

async function rawViewings() {
  const conn = await db.openDb();
  const tx = conn.transaction('viewings', 'readonly');
  return idbRequest(tx.objectStore('viewings').getAll());
}

function oldTitle(id, type, status, updatedAt) {
  return {
    key: type + ':' + id, type: type, title: 'T' + id, status: status,
    addedAt: '2026-01-01T00:00:00.000Z', updatedAt: updatedAt
  };
}

test('a new database has a viewings store with titleKey and watchedOn indexes', async () => {
  const conn = await db.openDb();
  assert.ok(conn.objectStoreNames.contains('viewings'));
  const store = conn.transaction('viewings', 'readonly').objectStore('viewings');
  assert.ok(store.indexNames.contains('titleKey'));
  assert.ok(store.indexNames.contains('watchedOn'));
  assert.equal(conn.version, 2);
});

test('upgrading from version 1 gives each watched movie one bare viewing', async () => {
  await seedVersion1(
    [
      oldTitle(1, 'movie', 'watched', '2026-05-01T12:00:00.000Z'),
      oldTitle(2, 'movie', 'watched', '2026-03-03T12:00:00.000Z'),
      oldTitle(3, 'movie', 'watchlist', '2026-03-03T12:00:00.000Z'),
      oldTitle(4, 'tv', 'watched', '2026-03-03T12:00:00.000Z'),
      oldTitle(5, 'movie', 'watched', '2999-01-01T12:00:00.000Z')
    ],
    [
      { titleKey: 'movie:1', season: null, episode: null, at: '2026-04-02T12:00:00.000Z' },
      { titleKey: 'movie:1', season: null, episode: null, at: '2026-04-10T12:00:00.000Z' },
      { titleKey: 'tv:4', season: 1, episode: 1, at: '2026-03-04T12:00:00.000Z' }
    ]
  );
  const all = await rawViewings();
  all.sort((a, b) => (a.titleKey < b.titleKey ? -1 : 1));
  assert.deepEqual(all.map((x) => x.titleKey), ['movie:1', 'movie:2', 'movie:5']);
  assert.equal(all[0].watchedOn, viewingsLib.localDateString(new Date('2026-04-10T12:00:00.000Z')));
  assert.equal(all[1].watchedOn, viewingsLib.localDateString(new Date('2026-03-03T12:00:00.000Z')));
  assert.equal(all[2].watchedOn, viewingsLib.localDateString(new Date()));
  for (const x of all) {
    assert.equal(x.where, null);
    assert.equal(x.rating, null);
    assert.match(x.id, /^v_[a-z0-9]+_[a-z0-9]+$/);
  }
});

test('upgrading keeps the titles and the log that were already there', async () => {
  await seedVersion1(
    [oldTitle(1, 'movie', 'watched', '2026-05-01T12:00:00.000Z')],
    [{ titleKey: 'movie:1', season: null, episode: null, at: '2026-04-02T12:00:00.000Z' }]
  );
  assert.equal((await db.getTitle('movie:1')).title, 'T1');
  assert.equal((await db.getWatchLog('movie:1')).length, 1);
});
```

Note: later tasks reuse `viewingsLib` and the seeding helpers from this block, so keep these test blocks in this one file, in this order.

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test db.test.js`
Expected: 2 FAIL (`a new database has a viewings store with titleKey and watchedOn indexes`, `upgrading from version 1 gives each watched movie one bare viewing`). The third new test already passes.

- [ ] **Step 3: Write the implementation**

In `db.js`, find:

```js
//   watch_log  auto id, append-only           { titleKey, season, episode, at }
```

Replace with:

```js
//   watch_log  auto id, append-only           { titleKey, season, episode, at }
//   viewings   key = id ('v_...')             one record per time a movie was watched (see viewings.js)
```

In `db.js`, find:

```js
var DB_VERSION = 1;
```

Replace with:

```js
var DB_VERSION = 2;
```

In `db.js`, find:

```js
function handleUpgradeNeeded(event) {
  // Version 1 creates everything. Future versions: branch on event.oldVersion.
  var db = event.target.result;

  var titles = db.createObjectStore('titles', { keyPath: 'key' });
```

Replace with:

```js
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
```

In `db.js`, find:

```js
  var cache = db.createObjectStore('cache', { keyPath: 'key' });
  cache.createIndex('expiresAt', 'expiresAt');
}
```

Replace with:

```js
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
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add db.js
git commit -m "feat: viewings store, version 2 upgrade and migration"
```

### Task 5: db.js: add, update, delete and read viewings

**Files:**
- Modify: `db.js`

- [ ] **Step 1: Write the failing tests**

Append to the end of `db.test.js`:

```js

// ---------- viewings: add, update, delete, read ----------

function addedMovie(id, status) {
  return db.addTitle(movie(id, status || 'watchlist'));
}

test('addViewing saves a clean viewing and returns it', async () => {
  await addedMovie(1);
  const saved = await db.addViewing({
    titleKey: 'movie:1', watchedOn: '2026-10-01', where: 'cinema',
    cinemaName: ' Starlight ', price: 14, rating: 4.5, note: 'loud'
  });
  assert.match(saved.id, /^v_[a-z0-9]+_[a-z0-9]+$/);
  assert.equal(saved.cinemaName, 'Starlight');
  assert.equal(saved.createdAt, saved.updatedAt);
  assert.deepEqual(await db.getViewings('movie:1'), [saved]);
});

test('addViewing ignores an id the caller supplies', async () => {
  await addedMovie(1);
  const saved = await db.addViewing({ id: 'v_mine_1', titleKey: 'movie:1', watchedOn: '2026-10-01' });
  assert.notEqual(saved.id, 'v_mine_1');
});

test('addViewing rejects bad input and unknown films', async () => {
  await addedMovie(1);
  await assert.rejects(db.addViewing({ titleKey: 'movie:1', watchedOn: '2999-01-01' }), { code: 'INVALID' });
  await assert.rejects(db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-10-01', rating: 9 }), { code: 'INVALID' });
  await assert.rejects(db.addViewing({ titleKey: 'tv:1', watchedOn: '2026-10-01' }), { code: 'INVALID' });
  await assert.rejects(db.addViewing({ titleKey: 'movie:99', watchedOn: '2026-10-01' }), { code: 'NOT_FOUND' });
  assert.deepEqual(await db.getAllViewings(), []);
});

test('a film can have several viewings, newest first', async () => {
  await addedMovie(1);
  await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-01-01' });
  await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-06-01' });
  await addedMovie(2);
  await db.addViewing({ titleKey: 'movie:2', watchedOn: '2026-03-01' });
  assert.deepEqual((await db.getViewings('movie:1')).map((x) => x.watchedOn), ['2026-06-01', '2026-01-01']);
  assert.deepEqual((await db.getAllViewings()).map((x) => x.watchedOn), ['2026-06-01', '2026-03-01', '2026-01-01']);
});

test('updateViewing merges changes and keeps id, film and createdAt', async () => {
  await addedMovie(1);
  const saved = await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-10-01', where: 'cinema', cinemaName: 'Odeon', seat: 'A1' });
  const next = await db.updateViewing(saved.id, { where: 'home', source: 'streaming', service: 'Max', titleKey: 'movie:2', id: 'v_x_1' });
  assert.equal(next.id, saved.id);
  assert.equal(next.titleKey, 'movie:1');
  assert.equal(next.createdAt, saved.createdAt);
  assert.equal(next.where, 'home');
  assert.equal(next.service, 'Max');
  assert.equal(next.cinemaName, null);
  assert.equal(next.seat, null);
});

test('updateViewing rejects bad changes without writing them', async () => {
  await addedMovie(1);
  const saved = await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-10-01', rating: 3 });
  await assert.rejects(db.updateViewing(saved.id, { rating: 9 }), { code: 'INVALID' });
  await assert.rejects(db.updateViewing('v_nope_1', { rating: 4 }), { code: 'NOT_FOUND' });
  assert.equal((await db.getViewings('movie:1'))[0].rating, 3);
});

test('deleteViewing removes it and reports whether it existed', async () => {
  await addedMovie(1);
  const saved = await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-10-01' });
  assert.equal(await db.deleteViewing(saved.id), true);
  assert.equal(await db.deleteViewing(saved.id), false);
  assert.deepEqual(await db.getViewings('movie:1'), []);
});

test('deleting a viewing never changes the film status', async () => {
  await addedMovie(1, 'watched');
  const saved = await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-10-01' });
  await db.deleteViewing(saved.id);
  assert.equal((await db.getTitle('movie:1')).status, 'watched');
});

test('the film rating follows its latest rated viewing', async () => {
  await addedMovie(1);
  assert.equal((await db.getTitle('movie:1')).rating ?? null, null);
  const first = await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-01-01', rating: 3 });
  assert.equal((await db.getTitle('movie:1')).rating, 3);
  const second = await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-06-01', rating: 4.5 });
  assert.equal((await db.getTitle('movie:1')).rating, 4.5);
  await db.updateViewing(second.id, { rating: null });
  assert.equal((await db.getTitle('movie:1')).rating, 3);
  await db.deleteViewing(first.id);
  assert.equal((await db.getTitle('movie:1')).rating, null);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test db.test.js`
Expected: the 8 new tests FAIL with `db.addViewing is not a function`.

- [ ] **Step 3: Write the implementation**

In `db.js`, find:

```js
// ---------- lists ----------
```

Replace with:

```js
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

// Every viewing, newest first.
async function getAllViewings() {
  var db = await openDb();
  var tx = db.transaction('viewings', 'readonly');
  var list = await requestToPromise(tx.objectStore('viewings').getAll());
  return list.sort(viewingsLib().compareViewingsNewestFirst);
}

// ---------- lists ----------
```

In `db.js`, find:

```js
    getWatchLog: getWatchLog,
```

Replace with:

```js
    getWatchLog: getWatchLog,
    addViewing: addViewing,
    updateViewing: updateViewing,
    deleteViewing: deleteViewing,
    getViewings: getViewings,
    getAllViewings: getAllViewings,
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add db.js
git commit -m "feat: viewing add, update, delete and read, with film rating sync"
```

### Task 6: db.js: a bare viewing whenever a movie becomes watched

**Files:**
- Modify: `db.js`

- [ ] **Step 1: Write the failing tests**

Append to the end of `db.test.js`:

```js

// ---------- viewings: made whenever a movie becomes watched ----------

const TODAY = viewingsLib.localDateString(new Date());

test('markWatched adds one bare viewing dated today', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  await db.markWatched('movie:1');
  const list = await db.getViewings('movie:1');
  assert.equal(list.length, 1);
  assert.equal(list[0].watchedOn, TODAY);
  assert.equal(list[0].where, null);
});

test('markWatched on a film that is already watched adds nothing', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  await db.markWatched('movie:1');
  await db.markWatched('movie:1');
  assert.equal((await db.getViewings('movie:1')).length, 1);
});

test('markWatched on a series adds no viewing', async () => {
  await db.addTitle(series(1, 'watching'));
  await db.markWatched('tv:1');
  assert.deepEqual(await db.getAllViewings(), []);
});

test('setStatus to watched adds a viewing once, other changes add none', async () => {
  await db.addTitle(movie(1, 'watching'));
  await db.updateTitle('movie:1', { notes: 'hello' });
  assert.equal((await db.getViewings('movie:1')).length, 0);
  await db.setStatus('movie:1', 'watched');
  assert.equal((await db.getViewings('movie:1')).length, 1);
  await db.setStatus('movie:1', 'watched');
  assert.equal((await db.getViewings('movie:1')).length, 1);
});

test('un-watching a film keeps its viewings', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  await db.markWatched('movie:1');
  await db.setStatus('movie:1', 'watchlist');
  assert.equal((await db.getViewings('movie:1')).length, 1);
});

test('adding a movie straight as watched adds a viewing; as watchlist does not', async () => {
  await db.addTitle(movie(1, 'watched'));
  await db.addTitle(movie(2, 'watchlist'));
  await db.addTitle(series(3, 'watched'));
  assert.equal((await db.getViewings('movie:1')).length, 1);
  assert.deepEqual(await db.getViewings('movie:2'), []);
  assert.deepEqual(await db.getViewings('tv:3'), []);
});

test('a failed addTitle leaves no stray viewing', async () => {
  await db.addTitle(movie(1, 'watched'));
  await assert.rejects(db.addTitle(movie(1, 'watched')), { code: 'DUPLICATE' });
  assert.equal((await db.getAllViewings()).length, 1);
});

test('removeTitle deletes that film\'s viewings and no others', async () => {
  await db.addTitle(movie(1, 'watched'));
  await db.addTitle(movie(2, 'watched'));
  await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-01-01' });
  await db.removeTitle('movie:1');
  assert.deepEqual(await db.getViewings('movie:1'), []);
  assert.equal((await db.getViewings('movie:2')).length, 1);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test db.test.js`
Expected: 7 of the 8 new tests FAIL (for example `markWatched adds one bare viewing dated today`). `markWatched on a series adds no viewing` passes already.

- [ ] **Step 3: Write the implementation**

In `db.js`, find:

```js
function viewingContext(now) {
  return { today: viewingsLib().localDateString(new Date()), now: now };
}
```

Replace with:

```js
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
```

In `db.js`, find:

```js
  var tx = db.transaction('titles', 'readwrite');
  var done = txDone(tx);
  tx.objectStore('titles').add(full);
```

Replace with:

```js
  var tx = db.transaction(['titles', 'viewings'], 'readwrite');
  var done = txDone(tx);
  tx.objectStore('titles').add(full);
  if (full.type === 'movie' && full.status === 'watched') addBareViewing(tx, full.key, now);
```

In `db.js`, find:

```js
  var tx = db.transaction('titles', 'readwrite');
  var done = txDone(tx);
  var store = tx.objectStore('titles');
  var existing = await requestToPromise(store.get(key));
```

Replace with:

```js
  var tx = db.transaction(['titles', 'viewings'], 'readwrite');
  var done = txDone(tx);
  var store = tx.objectStore('titles');
  var existing = await requestToPromise(store.get(key));
```

In `db.js`, find:

```js
  store.put(merged);
  await done;
  return merged;
```

Replace with:

```js
  store.put(merged);
  var becameWatched = existing.type === 'movie' && existing.status !== 'watched' && merged.status === 'watched';
  if (becameWatched) addBareViewing(tx, key, merged.updatedAt);
  await done;
  return merged;
```

In `db.js`, find:

```js
// Removes a title and everything that hangs off it: progress, log entries and
// its place in any lists. Returns true if the title existed.
```

Replace with:

```js
// Removes a title and everything that hangs off it: progress, log entries,
// viewings and its place in any lists. Returns true if the title existed.
```

In `db.js`, find:

```js
  var names = ['titles', 'progress', 'watch_log', 'list_items'];
```

Replace with:

```js
  var names = ['titles', 'progress', 'watch_log', 'list_items', 'viewings'];
```

In `db.js`, find:

```js
  for (var j = 0; j < itemIds.length; j++) items.delete(itemIds[j]);
```

Replace with:

```js
  for (var j = 0; j < itemIds.length; j++) items.delete(itemIds[j]);

  var viewingStore = tx.objectStore('viewings');
  var viewingIds = await requestToPromise(viewingStore.index('titleKey').getAllKeys(key));
  for (var k = 0; k < viewingIds.length; k++) viewingStore.delete(viewingIds[k]);
```

In `db.js`, find:

```js
// Sets status to watched. A movie also gets a log entry (season and episode
// null); a series' episodes are already in the log from commitEpisode.
```

Replace with:

```js
// Sets status to watched. A movie also gets a log entry (season and episode
// null) and, unless it was already watched, a bare viewing dated today; a
// series' episodes are already in the log from commitEpisode.
```

In `db.js`, find:

```js
  var tx = db.transaction(['titles', 'watch_log'], 'readwrite');
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
  }
```

Replace with:

```js
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
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add db.js
git commit -m "feat: bare viewing on becoming watched; removeTitle deletes viewings"
```

### Task 7: db.js: backup format version 2

**Files:**
- Modify: `db.js`
- Modify: `db.test.js`

- [ ] **Step 1: Write the failing tests**

Append to the end of `db.test.js`:

```js

// ---------- viewings: backup version 2 ----------

test('exportAll includes viewings, newest first, at format version 2', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-01-01' });
  await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-06-01', where: 'home', source: 'disc' });
  const data = await db.exportAll();
  assert.equal(data.version, 2);
  assert.deepEqual(data.viewings.map((x) => x.watchedOn), ['2026-06-01', '2026-01-01']);
});

test('viewings survive an export and import into an empty library', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  await db.addViewing({
    titleKey: 'movie:1', watchedOn: '2026-03-09', where: 'cinema', cinemaName: 'Starlight',
    price: 14, rating: 4.5, note: 'loud'
  });
  const before = await db.exportAll();
  await db.deleteDb();
  const summary = await db.importAll(JSON.stringify(before));
  assert.equal(summary.viewingsAdded, 1);
  assert.equal(summary.viewingsCreated, 0);
  assert.equal(summary.skipped, 0);
  assert.deepEqual((await db.exportAll()).viewings, before.viewings);
  assert.equal((await db.getTitle('movie:1')).rating, 4.5);
});

test('importing viewings twice adds them once', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-03-09' });
  const file = await db.exportAll();
  const second = await db.importAll(file);
  assert.equal(second.viewingsAdded, 0);
  assert.equal((await db.getViewings('movie:1')).length, 1);
});

test('viewings from two devices are merged by id', async () => {
  await db.addTitle(movie(1, 'watchlist'));
  const mine = await db.addViewing({ titleKey: 'movie:1', watchedOn: '2026-03-09' });
  const theirs = Object.assign({}, mine, { id: 'v_other_1', watchedOn: '2026-04-01' });
  const file = backup({ version: 2, titles: [movie(1, 'watchlist')], viewings: [theirs] });
  const summary = await db.importAll(file);
  assert.equal(summary.viewingsAdded, 1);
  assert.deepEqual((await db.getViewings('movie:1')).map((x) => x.id), ['v_other_1', mine.id]);
});

test('a version 1 backup imports, and watched movies get a bare viewing', async () => {
  const file = backup({ version: 1, titles: [movie(1, 'watched'), movie(2, 'watchlist'), series(3, 'watched')] });
  assert.equal(file.viewings, undefined);
  const summary = await db.importAll(file);
  assert.equal(summary.viewingsCreated, 1);
  assert.equal((await db.getViewings('movie:1')).length, 1);
  assert.deepEqual(await db.getViewings('movie:2'), []);
  assert.deepEqual(await db.getViewings('tv:3'), []);
});

test('a watched movie that already has a viewing gets no extra one on import', async () => {
  await db.addTitle(movie(1, 'watched'));
  const summary = await db.importAll(backup({ version: 1, titles: [movie(1, 'watched')] }));
  assert.equal(summary.viewingsCreated, 0);
  assert.equal((await db.getViewings('movie:1')).length, 1);
});

test('invalid viewings and viewings for unknown films are skipped and counted', async () => {
  const good = { id: 'v_good_1', titleKey: 'movie:1', watchedOn: '2026-03-09' };
  const badDate = { id: 'v_bad_1', titleKey: 'movie:1', watchedOn: '2026-02-30' };
  const orphan = { id: 'v_orphan_1', titleKey: 'movie:99', watchedOn: '2026-03-09' };
  const file = backup({ version: 2, titles: [movie(1, 'watchlist')], viewings: [good, badDate, orphan] });
  const summary = await db.importAll(file);
  assert.equal(summary.viewingsAdded, 1);
  assert.equal(summary.skipped, 2);
  assert.deepEqual((await db.getAllViewings()).map((x) => x.id), ['v_good_1']);
});

test('a backup with viewings must still be a list', async () => {
  await assert.rejects(db.importAll(backup({ version: 2, viewings: 'x' })), { code: 'INVALID' });
});

test('a backup from a newer version is still refused', async () => {
  await assert.rejects(db.importAll({ app: 'queued', version: 3 }), { code: 'INVALID' });
});
```

These two existing tests describe the old file shape, so they change too.

In `db.test.js`, find:

```js
    ['app', 'exportedAt', 'listItems', 'lists', 'progress', 'titles', 'version', 'watchLog']);
```

Replace with:

```js
    ['app', 'exportedAt', 'listItems', 'lists', 'progress', 'titles', 'version', 'viewings', 'watchLog']);
```

In `db.test.js`, find:

```js
    logAdded: 0, listsAdded: 0, listItemsAdded: 0, skipped: 0
```

Replace with:

```js
    logAdded: 0, listsAdded: 0, listItemsAdded: 0, viewingsAdded: 0, viewingsCreated: 0, skipped: 0
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test db.test.js`
Expected: 2 existing tests FAIL (`exportAll returns a versioned snapshot...`, `importing the same file twice changes nothing the second time`) because they now describe the version 2 shape, and the new backup tests FAIL too.

- [ ] **Step 3: Write the implementation**

In `db.js`, find:

```js
var EXPORT_VERSION = 1;
```

Replace with:

```js
var EXPORT_VERSION = 2;
```

In `db.js`, find:

```js
//     listItems: [{ listId, titleKey, position }] }
```

Replace with:

```js
//     listItems: [{ listId, titleKey, position }],
//     viewings:  [viewing records, see viewings.js]          (version 2 and later)
//   }
```

In `db.js`, find:

```js
// The cache is not exported, and neither is the TMDB key
```

Replace with:

```js
//   viewings  matched by id: new ids are added, existing ones are left alone. A
//             viewing that is invalid, or whose film is in neither the file nor
//             the library, is skipped (counted in summary.skipped). Afterwards
//             every watched movie with no viewing gets one bare viewing, which is
//             how a version 1 backup becomes complete.
// The cache is not exported, and neither is the TMDB key
```

In `db.js`, find:

```js
  var tx = db.transaction(['titles', 'progress', 'watch_log', 'lists', 'list_items'], 'readonly');
  // Every request
```

Replace with:

```js
  var tx = db.transaction(['titles', 'progress', 'watch_log', 'lists', 'list_items', 'viewings'], 'readonly');
  // Every request
```

In `db.js`, find:

```js
    requestToPromise(tx.objectStore('list_items').getAll())
  ]);
```

Replace with:

```js
    requestToPromise(tx.objectStore('list_items').getAll()),
    requestToPromise(tx.objectStore('viewings').getAll())
  ]);
```

In `db.js`, find:

```js
    lists: parts[3],
    listItems: listItems
  };
```

Replace with:

```js
    lists: parts[3],
    listItems: listItems,
    viewings: parts[5].sort(viewingsLib().compareViewingsNewestFirst)
  };
```

In `db.js`, find:

```js
// Checks the whole file and returns cleaned copies. Throws INVALID on the first
// problem, before anything is written.
function cleanBackup(input) {
  var data = parseBackup(input);
  var now = nowIso();
  var clean = { titles: [], progress: [], watchLog: [], lists: [], listItems: [] };
```

Replace with:

```js
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
```

In `db.js`, find:

```js
  for (var e = 0; e < items.length; e++) clean.listItems.push(cleanImportedListItem(items[e], e));
  return clean;
```

Replace with:

```js
  for (var e = 0; e < items.length; e++) clean.listItems.push(cleanImportedListItem(items[e], e));
  var viewings = readBackupArray(data, 'viewings');
  for (var f = 0; f < viewings.length; f++) {
    var viewing = cleanImportedViewing(viewings[f], now);
    if (viewing) clean.viewings.push(viewing);
    else clean.badViewings++;
  }
  return clean;
```

In `db.js`, find:

```js
    listItemsAdded: 0,
    skipped: 0
  };
```

Replace with:

```js
    listItemsAdded: 0,
    viewingsAdded: 0,
    viewingsCreated: 0,
    skipped: 0
  };
```

In `db.js`, find:

```js
function abortQuietly(tx) {
```

Replace with:

```js
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
```

In `db.js`, find:

```js
  var tx = db.transaction(['titles', 'progress', 'watch_log', 'lists', 'list_items'], 'readwrite');
  var done = txDone(tx);
  var summary = emptyImportSummary();
  try {
```

Replace with:

```js
  var tx = db.transaction(['titles', 'progress', 'watch_log', 'lists', 'list_items', 'viewings'], 'readwrite');
  var done = txDone(tx);
  var summary = emptyImportSummary();
  summary.skipped += clean.badViewings;
  try {
```

In `db.js`, find:

```js
    await mergeImportedLists(tx, clean.lists, clean.listItems, known, summary);
  } catch (err) {
```

Replace with:

```js
    await mergeImportedLists(tx, clean.lists, clean.listItems, known, summary);
    await mergeImportedViewings(tx, clean.viewings, known, summary);
    summary.viewingsCreated = await addMissingBareViewings(tx);
  } catch (err) {
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add db.js db.test.js
git commit -m "feat: backup format version 2 with viewings"
```

### Task 8: Currency symbol setting and director names on new films

**Files:**
- Modify: `settings.js`
- Modify: `settings.test.js`
- Modify: `tmdb.js`
- Modify: `tmdb.test.js`

- [ ] **Step 1: Write the failing tests**

In `settings.test.js`, append to the end of the file:

```js

// ---------- currency symbol ----------

test('the currency symbol defaults to a dollar sign', () => {
  assert.equal(settings.loadCurrencySymbol(), '$');
  assert.equal(settings.DEFAULT_CURRENCY, '$');
});

test('a saved currency symbol is trimmed and loaded back', () => {
  assert.deepEqual(settings.saveCurrencySymbol('  \u20b9 '), { ok: true, symbol: '\u20b9' });
  assert.equal(settings.loadCurrencySymbol(), '\u20b9');
  assert.equal(settings.saveCurrencySymbol('CHF').ok, true);
  assert.equal(settings.loadCurrencySymbol(), 'CHF');
});

test('an empty or long currency symbol is refused and nothing changes', () => {
  settings.saveCurrencySymbol('\u20ac');
  assert.deepEqual(settings.saveCurrencySymbol('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(settings.saveCurrencySymbol('dollars'), { ok: false, reason: 'long' });
  assert.deepEqual(settings.saveCurrencySymbol(42), { ok: false, reason: 'empty' });
  assert.equal(settings.loadCurrencySymbol(), '\u20ac');
});

test('a bad stored currency symbol falls back to the default', () => {
  localStorage.setItem('queued.currency', 'way too long');
  assert.equal(settings.loadCurrencySymbol(), '$');
});

test('currency settings cope with missing storage', () => {
  installStorage(null);
  assert.equal(settings.loadCurrencySymbol(), '$');
  assert.deepEqual(settings.saveCurrencySymbol('\u20ac'), { ok: false, reason: 'storage' });
});
```

In `tmdb.test.js`, append to the end of the file:

```js

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
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test settings.test.js tmdb.test.js`
Expected: 5 currency tests FAIL (`settings.loadCurrencySymbol is not a function`) and 2 director tests FAIL (`snapshot.directors` is undefined).

- [ ] **Step 3: Write the implementation**

In `settings.js`, find:

```js
var KEY_STORAGE_NAME = 'queued.tmdb_key';
```

Replace with:

```js
var KEY_STORAGE_NAME = 'queued.tmdb_key';

// The symbol shown beside cinema ticket prices ($, EUR, a rupee sign...). It is
// only a label: prices are never converted.
var CURRENCY_STORAGE_NAME = 'queued.currency';
var DEFAULT_CURRENCY = '$';
var CURRENCY_MAX_LENGTH = 3;
```

In `settings.js`, find:

```js
// For showing a saved key in Settings without exposing all of it.
```

Replace with:

```js
// The saved currency symbol, or the default if none is saved or it is unusable.
function loadCurrencySymbol() {
  var storage = getKeyStorage();
  if (!storage) return DEFAULT_CURRENCY;
  var raw = null;
  try {
    raw = storage.getItem(CURRENCY_STORAGE_NAME);
  } catch (err) {
    return DEFAULT_CURRENCY;
  }
  var symbol = typeof raw === 'string' ? raw.trim() : '';
  if (symbol === '' || symbol.length > CURRENCY_MAX_LENGTH) return DEFAULT_CURRENCY;
  return symbol;
}

// Returns { ok: true, symbol } or { ok: false, reason: 'empty' | 'long' | 'storage' }.
function saveCurrencySymbol(raw) {
  var symbol = typeof raw === 'string' ? raw.trim() : '';
  if (symbol === '') return { ok: false, reason: 'empty' };
  if (symbol.length > CURRENCY_MAX_LENGTH) return { ok: false, reason: 'long' };
  var storage = getKeyStorage();
  if (!storage) return { ok: false, reason: 'storage' };
  try {
    storage.setItem(CURRENCY_STORAGE_NAME, symbol);
  } catch (err) {
    return { ok: false, reason: 'storage' };
  }
  return { ok: true, symbol: symbol };
}

// For showing a saved key in Settings without exposing all of it.
```

In `settings.js`, find:

```js
    maskKey: maskKey
```

Replace with:

```js
    maskKey: maskKey,
    DEFAULT_CURRENCY: DEFAULT_CURRENCY,
    loadCurrencySymbol: loadCurrencySymbol,
    saveCurrencySymbol: saveCurrencySymbol
```

In `tmdb.js`, find:

```js
function creatorIds(details) {
```

Replace with:

```js
// [{ id, name }] for each director, once each, in credit order. Stats shows the
// names, so they are saved with the title.
function directorList(credits) {
  var list = [];
  var seen = Object.create(null);
  var crew = credits && Array.isArray(credits.crew) ? credits.crew : [];
  for (var i = 0; i < crew.length; i++) {
    if (crew[i].job !== 'Director' || seen[crew[i].id]) continue;
    seen[crew[i].id] = true;
    list.push({ id: crew[i].id, name: typeof crew[i].name === 'string' ? crew[i].name : '' });
  }
  return list;
}

function creatorIds(details) {
```

In `tmdb.js`, find:

```js
      genres: genreNames(details),
      status: details.status || '',
      releaseDate: details.release_date || ''
    },
    snapshotRefreshedAt: nowIso || new Date().toISOString()
  };
}

// A titles record from getTv() output.
```

Replace with:

```js
      genres: genreNames(details),
      directors: directorList(details.credits),
      status: details.status || '',
      releaseDate: details.release_date || ''
    },
    snapshotRefreshedAt: nowIso || new Date().toISOString()
  };
}

// A titles record from getTv() output.
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add settings.js settings.test.js tmdb.js tmdb.test.js
git commit -m "feat: currency symbol setting; save director names on new films"
```

### Task 9: Load viewings.js in the browser and cache it

**Files:**
- Modify: `index.html`
- Modify: `sw.js`
- Create: `browser_scripts.test.js`

- [ ] **Step 1: Write the failing tests**

Create `browser_scripts.test.js`:

```js
// Run with: node --test
// The app's scripts are plain <script> tags that share one global scope. These
// tests load them the way the browser does (no require, no module) so a name
// clash or a missing global shows up here instead of on a phone.
'use strict';

require('fake-indexeddb/auto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const SCRIPTS = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
// app.js touches the page the moment it loads, so it is not loaded here.
const DATA_SCRIPTS = SCRIPTS.filter((name) => name !== 'app.js');

function topLevelNames(source) {
  const names = [];
  for (const m of source.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) names.push(m[1]);
  for (const m of source.matchAll(/^(?:var|let|const|class)\s+([A-Za-z0-9_$]+)/gm)) names.push(m[1]);
  return names;
}

test('index.html loads viewings.js before db.js', () => {
  assert.ok(SCRIPTS.includes('viewings.js'));
  assert.ok(SCRIPTS.indexOf('viewings.js') < SCRIPTS.indexOf('db.js'));
});

test('no two scripts declare the same top-level name', () => {
  const owner = new Map();
  for (const file of SCRIPTS) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    for (const name of topLevelNames(source)) {
      assert.ok(!owner.has(name), name + ' is declared in both ' + owner.get(name) + ' and ' + file);
      owner.set(name, file);
    }
  }
});

test('the data scripts work as plain browser scripts', async () => {
  const context = vm.createContext({ indexedDB: indexedDB, console: console, Date: Date, Math: Math });
  for (const file of DATA_SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
  }
  const program = `(async function () {
    await deleteDb();
    await addTitle({ key: 'movie:1', type: 'movie', title: 'X', status: 'watchlist' });
    await markWatched('movie:1');
    const bare = await getViewings('movie:1');
    const saved = await addViewing({ titleKey: 'movie:1', watchedOn: bare[0].watchedOn, rating: 4 });
    const title = await getTitle('movie:1');
    return { bare: bare.length, saved: saved.rating, filmRating: title.rating, all: (await getAllViewings()).length };
  })()`;
  const out = await vm.runInContext(program, context);
  assert.deepEqual({ ...out }, { bare: 1, saved: 4, filmRating: 4, all: 2 });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test browser_scripts.test.js`
Expected: 2 FAIL (`index.html loads viewings.js before db.js`, `the data scripts work as plain browser scripts`).

- [ ] **Step 3: Write the implementation**

In `index.html`, find:

```js
<script src="settings.js"></script><script src="db.js"></script>
```

Replace with:

```js
<script src="settings.js"></script><script src="viewings.js"></script><script src="db.js"></script>
```

In `sw.js`, find:

```js
var CACHE_VERSION = 'queued-v2';
```

Replace with:

```js
var CACHE_VERSION = 'queued-v3';
```

In `sw.js`, find:

```js
  'settings.js',
  'db.js',
```

Replace with:

```js
  'settings.js',
  'viewings.js',
  'db.js',
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test`
Expected: every test passes, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add browser_scripts.test.js index.html sw.js
git commit -m "feat: load viewings.js in the page and precache it"
```

### Task 10: Final check

- [ ] **Step 1: Run everything**

Run: `node --test`
Expected: every test passes, `# fail 0`.

- [ ] **Step 2: Check the app still opens**

Open `index.html` through a local web server (for example `npx serve .`), open the browser console, and confirm there are no errors on load. Add a movie, mark it Watched, and in the console run `getAllViewings().then(console.log)`. Expected: one viewing with today's date and `where: null`.

- [ ] **Step 3: Upload**

Upload the changed and new files (`viewings.js`, `stats.js`, `db.js`, `settings.js`, `tmdb.js`, `index.html`, `sw.js` and the test files) to the repo root. The service worker cache version changed, so the next visit picks up the new files.

---

## Self-review against the spec

- **Section 1, viewings store and fields:** Tasks 1, 4, 5. **Creating viewings on becoming watched, no new one when already watched:** Task 6. **Film rating from the latest rated viewing:** Tasks 2 and 5. **Migration:** Task 4. **Backup v2 (union by id, v1 files still import, skipped and counted, bare viewings created after import):** Task 7. **Currency setting and director names:** Task 8. **Removing a title deletes its viewings; deleting a viewing never changes status:** Tasks 5 and 6.
- **Section 3, stat definitions:** Task 3, one test per definition including empty year, ties and missing runtime.
- **Section 4, code layout:** `viewings.js`, `stats.js`, `db.js`, `sw.js` here. Not in this plan, by design: the stub field list (Plan 2), UI files (Plans 2 and 3), the `stats.js` script tag and `SHELL_FILES` entry (Plan 3).
- **Section 5, CORS poster risk:** Plan 3. **Section 2, screens and the share card:** Plans 2 and 3.
- **Spec corrections found while planning:** the app has no snapshot refresh, so older films get director names from the cached person lookup in Plan 3 (the spec now says so). Invalid imported viewings are skipped and counted in `summary.skipped`, matching the spec.
