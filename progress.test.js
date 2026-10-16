// Run with: node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('./progress.js');

// Fixtures. Seasons are { number, episodeCount }; pointers are the last watched episode.
const SHOW = [
  { number: 1, episodeCount: 3 },
  { number: 2, episodeCount: 2 }
];

function ptr(season, episode) {
  return { season: season, episode: episode };
}

// ---------- normalizeSeasons ----------

test('normalizeSeasons drops season 0, sorts, dedupes and nulls bad counts', () => {
  const input = [
    { number: 2, episodeCount: 8 },
    { number: 0, episodeCount: 5 },
    { number: 1, episodeCount: 10 },
    { number: 1, episodeCount: 99 },
    { number: 3, episodeCount: 'x' },
    { number: 4, episodeCount: -1 },
    null,
    { number: 1.5, episodeCount: 2 }
  ];
  assert.deepEqual(p.normalizeSeasons(input), [
    { number: 1, episodeCount: 10 },
    { number: 2, episodeCount: 8 },
    { number: 3, episodeCount: null },
    { number: 4, episodeCount: null }
  ]);
});

test('normalizeSeasons tolerates non-arrays', () => {
  assert.deepEqual(p.normalizeSeasons(undefined), []);
  assert.deepEqual(p.normalizeSeasons('nope'), []);
});

// ---------- nextEpisode ----------

test('next from not started goes to S1 E1', () => {
  const r = p.nextEpisode(SHOW, ptr(1, 0));
  assert.deepEqual(r.pointer, ptr(1, 1));
  assert.equal(r.changed, true);
  assert.equal(r.rolledOver, false);
  assert.equal(r.reachedEnd, false);
  assert.equal(r.reason, null);
});

test('next within a season just adds one episode', () => {
  const r = p.nextEpisode(SHOW, ptr(1, 1));
  assert.deepEqual(r.pointer, ptr(1, 2));
  assert.equal(r.rolledOver, false);
});

test('next at season end rolls over to the next season E1', () => {
  const r = p.nextEpisode(SHOW, ptr(1, 3));
  assert.deepEqual(r.pointer, ptr(2, 1));
  assert.equal(r.changed, true);
  assert.equal(r.rolledOver, true);
});

test('landing on the final episode sets reachedEnd (prompt, never automatic)', () => {
  const r = p.nextEpisode(SHOW, ptr(2, 1));
  assert.deepEqual(r.pointer, ptr(2, 2));
  assert.equal(r.reachedEnd, true);
  assert.equal(p.nextEpisode(SHOW, ptr(2, 0)).reachedEnd, false);
});

test('next on the final episode does nothing', () => {
  const r = p.nextEpisode(SHOW, ptr(2, 2));
  assert.deepEqual(r.pointer, ptr(2, 2));
  assert.equal(r.changed, false);
  assert.equal(r.reachedEnd, false);
  assert.equal(r.reason, 'already_at_end');
});

test('a single-season, single-episode show reaches the end on the first tap', () => {
  const r = p.nextEpisode([{ number: 1, episodeCount: 1 }], ptr(1, 0));
  assert.deepEqual(r.pointer, ptr(1, 1));
  assert.equal(r.reachedEnd, true);
});

test('season 0 in the data is ignored; a pointer in season 0 is rejected', () => {
  const withSpecials = [{ number: 0, episodeCount: 4 }].concat(SHOW);
  assert.deepEqual(p.nextEpisode(withSpecials, ptr(1, 3)).pointer, ptr(2, 1));
  const r = p.nextEpisode(withSpecials, ptr(0, 2));
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'unknown_season');
});

test('unknown episode count: counts up, never rolls over, never reaches the end', () => {
  const seasons = [{ number: 1, episodeCount: null }, { number: 2, episodeCount: 5 }];
  const r = p.nextEpisode(seasons, ptr(1, 7));
  assert.deepEqual(r.pointer, ptr(1, 8));
  assert.equal(r.rolledOver, false);
  assert.equal(r.reachedEnd, false);
});

test('last season with unknown count never reports reachedEnd', () => {
  const seasons = [{ number: 1, episodeCount: 2 }, { number: 2, episodeCount: null }];
  const r = p.nextEpisode(seasons, ptr(2, 0));
  assert.deepEqual(r.pointer, ptr(2, 1));
  assert.equal(r.reachedEnd, false);
  assert.equal(p.isFinalEpisode(seasons, ptr(2, 1)), false);
});

test('seasons with 0 episodes (not aired yet) are skipped on rollover', () => {
  const seasons = [
    { number: 1, episodeCount: 2 },
    { number: 2, episodeCount: 0 },
    { number: 3, episodeCount: 4 }
  ];
  const r = p.nextEpisode(seasons, ptr(1, 2));
  assert.deepEqual(r.pointer, ptr(3, 1));
  assert.equal(r.rolledOver, true);
});

test('a trailing 0-episode season does not stop the final episode counting as final', () => {
  const seasons = [{ number: 1, episodeCount: 2 }, { number: 2, episodeCount: 0 }];
  const r = p.nextEpisode(seasons, ptr(1, 1));
  assert.deepEqual(r.pointer, ptr(1, 2));
  assert.equal(r.reachedEnd, true);
  assert.equal(p.nextEpisode(seasons, ptr(1, 2)).reason, 'already_at_end');
});

test('a pointer past the (shrunken) season count rolls over instead of sticking', () => {
  const r = p.nextEpisode(SHOW, ptr(1, 9));
  assert.deepEqual(r.pointer, ptr(2, 1));
  assert.equal(r.rolledOver, true);
});

test('empty seasons and bad pointers fail safely', () => {
  assert.equal(p.nextEpisode([], ptr(1, 0)).reason, 'no_seasons');
  assert.equal(p.nextEpisode([], ptr(1, 0)).changed, false);
  const bad = p.nextEpisode(SHOW, { season: 'a', episode: 1 });
  assert.equal(bad.reason, 'bad_pointer');
  assert.deepEqual(bad.pointer, ptr(1, 0));
  assert.equal(p.nextEpisode(SHOW, null).reason, 'bad_pointer');
});

test('inputs are not mutated', () => {
  const seasons = Object.freeze([
    Object.freeze({ number: 1, episodeCount: 3 }),
    Object.freeze({ number: 2, episodeCount: 2 })
  ]);
  const pointer = Object.freeze({ season: 1, episode: 3 });
  const r = p.nextEpisode(seasons, pointer);
  assert.deepEqual(pointer, ptr(1, 3));
  assert.deepEqual(r.pointer, ptr(2, 1));
});

// ---------- previousEpisode ----------

test('previous within a season steps back one', () => {
  assert.deepEqual(p.previousEpisode(SHOW, ptr(1, 3)).pointer, ptr(1, 2));
});

test('previous from E1 of a later season goes to the last episode of the earlier one', () => {
  const r = p.previousEpisode(SHOW, ptr(2, 1));
  assert.deepEqual(r.pointer, ptr(1, 3));
  assert.equal(r.rolledOver, true);
});

test('previous from S1 E1 goes back to not started, then stops', () => {
  const r = p.previousEpisode(SHOW, ptr(1, 1));
  assert.deepEqual(r.pointer, ptr(1, 0));
  assert.equal(r.changed, true);
  const again = p.previousEpisode(SHOW, ptr(1, 0));
  assert.equal(again.changed, false);
  assert.equal(again.reason, 'at_start');
});

test('previous skips 0-episode seasons', () => {
  const seasons = [
    { number: 1, episodeCount: 6 },
    { number: 2, episodeCount: 0 },
    { number: 3, episodeCount: 4 }
  ];
  assert.deepEqual(p.previousEpisode(seasons, ptr(3, 1)).pointer, ptr(1, 6));
});

test('previous from a not-started later season steps back one episode, not to the same place', () => {
  const r = p.previousEpisode(SHOW, ptr(2, 0));
  assert.deepEqual(r.pointer, ptr(1, 2));
  assert.equal(r.changed, true);
  assert.equal(r.rolledOver, true);
  // S2 not started and the end of S1 are the same place, so Back from either lands together
  assert.deepEqual(r.pointer, p.previousEpisode(SHOW, ptr(1, 3)).pointer);
});

test('previous from a not-started season after a one-episode season goes to not started', () => {
  const seasons = [{ number: 1, episodeCount: 1 }, { number: 2, episodeCount: 4 }];
  assert.deepEqual(p.previousEpisode(seasons, ptr(2, 0)).pointer, ptr(1, 0));
});

test('previous from a not-started season skips 0-episode seasons', () => {
  const seasons = [
    { number: 1, episodeCount: 6 },
    { number: 2, episodeCount: 0 },
    { number: 3, episodeCount: 4 }
  ];
  assert.deepEqual(p.previousEpisode(seasons, ptr(3, 0)).pointer, ptr(1, 5));
});

test('previous from a not-started season refuses to guess when the earlier count is unknown', () => {
  const seasons = [{ number: 1, episodeCount: null }, { number: 2, episodeCount: 3 }];
  const r = p.previousEpisode(seasons, ptr(2, 0));
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'unknown_previous_count');
  assert.deepEqual(r.pointer, ptr(2, 0));
});

test('previous refuses to guess when the earlier season has an unknown count', () => {
  const seasons = [{ number: 1, episodeCount: null }, { number: 2, episodeCount: 3 }];
  const r = p.previousEpisode(seasons, ptr(2, 1));
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'unknown_previous_count');
});

test('next then previous returns to the start, including across a rollover', () => {
  const forward = p.nextEpisode(SHOW, ptr(1, 3));
  const back = p.previousEpisode(SHOW, forward.pointer);
  assert.deepEqual(back.pointer, ptr(1, 3));
});

// ---------- clampPointer ----------

test('clampPointer limits the episode to the season size', () => {
  assert.deepEqual(p.clampPointer(SHOW, ptr(1, 99)), ptr(1, 3));
  assert.deepEqual(p.clampPointer(SHOW, ptr(2, 1)), ptr(2, 1));
});

test('clampPointer leaves unknown-count seasons unbounded', () => {
  const seasons = [{ number: 1, episodeCount: null }];
  assert.deepEqual(p.clampPointer(seasons, ptr(1, 42)), ptr(1, 42));
});

test('clampPointer falls back to the first season when the season is gone or the pointer is bad', () => {
  assert.deepEqual(p.clampPointer(SHOW, ptr(9, 2)), ptr(1, 0));
  assert.deepEqual(p.clampPointer(SHOW, null), ptr(1, 0));
  assert.deepEqual(p.clampPointer([], ptr(3, 3)), ptr(1, 0));
});

// ---------- totals, progress bar, label ----------

test('totalEpisodes sums known seasons and is null if any are unknown or there are none', () => {
  assert.equal(p.totalEpisodes(SHOW), 5);
  assert.equal(p.totalEpisodes([{ number: 1, episodeCount: 3 }, { number: 2, episodeCount: null }]), null);
  assert.equal(p.totalEpisodes([]), null);
  assert.equal(p.totalEpisodes([{ number: 0, episodeCount: 4 }]), null);
});

test('countWatched adds earlier seasons plus the current episode', () => {
  assert.equal(p.countWatched(SHOW, ptr(1, 0)), 0);
  assert.equal(p.countWatched(SHOW, ptr(1, 2)), 2);
  assert.equal(p.countWatched(SHOW, ptr(2, 1)), 4);
  assert.equal(p.countWatched(SHOW, ptr(2, 2)), 5);
});

test('countWatched is null when an earlier season has an unknown count', () => {
  const seasons = [{ number: 1, episodeCount: null }, { number: 2, episodeCount: 3 }];
  assert.equal(p.countWatched(seasons, ptr(2, 1)), null);
});

test('progressFraction gives 0..1 for the bar', () => {
  assert.equal(p.progressFraction(SHOW, ptr(1, 0)), 0);
  assert.equal(p.progressFraction(SHOW, ptr(2, 1)), 0.8);
  assert.equal(p.progressFraction(SHOW, ptr(2, 2)), 1);
});

test('progressFraction is null (no bar) when counts are unknown, empty or zero', () => {
  assert.equal(p.progressFraction([{ number: 1, episodeCount: null }], ptr(1, 4)), null);
  assert.equal(p.progressFraction([], ptr(1, 0)), null);
  assert.equal(p.progressFraction([{ number: 1, episodeCount: 0 }], ptr(1, 0)), null);
  assert.equal(p.progressFraction(SHOW, ptr(7, 1)), null);
});

test('progressFraction never exceeds 1 even if the pointer overshoots', () => {
  assert.equal(p.progressFraction(SHOW, ptr(2, 50)), 1);
});

test('formatLabel shows S · E, and nothing before the first episode', () => {
  assert.equal(p.formatLabel(ptr(2, 5)), 'S2 · E5');
  assert.equal(p.formatLabel(ptr(1, 0)), '');
  assert.equal(p.formatLabel(null), '');
});

// ---------- isFinalEpisode ----------

test('isFinalEpisode is true only on the last episode of the last season', () => {
  assert.equal(p.isFinalEpisode(SHOW, ptr(2, 2)), true);
  assert.equal(p.isFinalEpisode(SHOW, ptr(2, 1)), false);
  assert.equal(p.isFinalEpisode(SHOW, ptr(1, 3)), false);
  assert.equal(p.isFinalEpisode(SHOW, null), false);
});
