// progress.js: pure episode-progress logic for Queued.
// No DOM, no storage, no network. Loads as a classic browser script (functions
// become globals) and as a CommonJS module for the Node tests.
//
// Vocabulary
//   seasons  : [{ number, episodeCount }]. episodeCount is an integer, or null
//              when unknown. tmdb.js maps TMDB's season_number / episode_count
//              into this shape. Season 0 (specials) is dropped on the way in.
//   pointer  : { season, episode } = the LAST episode the user has watched.
//              { season: 1, episode: 0 } means "not started".
//   result   : { pointer, changed, rolledOver, reachedEnd, reason }
//              reason is null on success, otherwise a short code.
//
// Nothing here mutates its inputs.

'use strict';

function compareSeasons(a, b) {
  return a.number - b.number;
}

// Keep real seasons only (number >= 1), coerce bad counts to null, sort, and
// drop duplicate season numbers (first one wins).
function normalizeSeasons(seasons) {
  var cleaned = [];
  if (!Array.isArray(seasons)) return cleaned;
  for (var i = 0; i < seasons.length; i++) {
    var s = seasons[i];
    if (!s || !Number.isInteger(s.number) || s.number < 1) continue;
    var count = null;
    if (Number.isInteger(s.episodeCount) && s.episodeCount >= 0) count = s.episodeCount;
    cleaned.push({ number: s.number, episodeCount: count });
  }
  cleaned.sort(compareSeasons);
  var out = [];
  for (var j = 0; j < cleaned.length; j++) {
    if (j > 0 && cleaned[j].number === cleaned[j - 1].number) continue;
    out.push(cleaned[j]);
  }
  return out;
}

// Returns a clean { season, episode } or null if the pointer is unusable.
function readPointer(pointer) {
  if (!pointer) return null;
  if (!Number.isInteger(pointer.season) || !Number.isInteger(pointer.episode)) return null;
  if (pointer.season < 0 || pointer.episode < 0) return null;
  return { season: pointer.season, episode: pointer.episode };
}

function defaultPointer(list) {
  if (list.length === 0) return { season: 1, episode: 0 };
  return { season: list[0].number, episode: 0 };
}

function findSeasonIndex(list, number) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].number === number) return i;
  }
  return -1;
}

// A season with 0 episodes (listed by TMDB but not aired yet) is skipped.
// An unknown count (null) is treated as playable.
function nextPlayableIndex(list, fromIndex) {
  for (var i = fromIndex + 1; i < list.length; i++) {
    if (list[i].episodeCount !== 0) return i;
  }
  return -1;
}

function previousPlayableIndex(list, fromIndex) {
  for (var i = fromIndex - 1; i >= 0; i--) {
    if (list[i].episodeCount !== 0) return i;
  }
  return -1;
}

// True when the pointer sits on the last episode of the last playable season.
// If that season's count is unknown, we can't know, so this is false.
function atEnd(list, pointer) {
  var last = -1;
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i].episodeCount !== 0) {
      last = i;
      break;
    }
  }
  if (last === -1) return false;
  var entry = list[last];
  if (entry.episodeCount === null) return false;
  return pointer.season === entry.number && pointer.episode >= entry.episodeCount;
}

function makeResult(list, pointer, changed, rolledOver, reason) {
  return {
    pointer: { season: pointer.season, episode: pointer.episode },
    changed: changed,
    rolledOver: rolledOver,
    reachedEnd: changed && atEnd(list, pointer),
    reason: reason
  };
}

// Public wrapper of atEnd for callers that hold raw seasons.
function isFinalEpisode(seasons, pointer) {
  var list = normalizeSeasons(seasons);
  var p = readPointer(pointer);
  if (!p) return false;
  return atEnd(list, p);
}

// "Next episode" tap. Advances within the season, rolls over at season end,
// never advances past the last episode. reachedEnd = true means the tap landed
// on the final episode, so the UI should ask "Mark as watched?" (never auto).
function nextEpisode(seasons, pointer) {
  var list = normalizeSeasons(seasons);
  var p = readPointer(pointer);
  if (list.length === 0) {
    return makeResult(list, p || defaultPointer(list), false, false, 'no_seasons');
  }
  if (!p) {
    return makeResult(list, defaultPointer(list), false, false, 'bad_pointer');
  }
  var idx = findSeasonIndex(list, p.season);
  if (idx === -1) {
    return makeResult(list, p, false, false, 'unknown_season');
  }
  var count = list[idx].episodeCount;
  if (count === null) {
    // Unknown size: we can only count up. No rollover, no end.
    return makeResult(list, { season: p.season, episode: p.episode + 1 }, true, false, null);
  }
  if (p.episode < count) {
    return makeResult(list, { season: p.season, episode: p.episode + 1 }, true, false, null);
  }
  // At or past the end of this season (covers counts that shrank after a refresh).
  var next = nextPlayableIndex(list, idx);
  if (next === -1) {
    return makeResult(list, p, false, false, 'already_at_end');
  }
  return makeResult(list, { season: list[next].number, episode: 1 }, true, true, null);
}

// Stepper "back" / undo. Mirror of nextEpisode.
function previousEpisode(seasons, pointer) {
  var list = normalizeSeasons(seasons);
  var p = readPointer(pointer);
  if (list.length === 0) {
    return makeResult(list, p || defaultPointer(list), false, false, 'no_seasons');
  }
  if (!p) {
    return makeResult(list, defaultPointer(list), false, false, 'bad_pointer');
  }
  var idx = findSeasonIndex(list, p.season);
  if (idx === -1) {
    return makeResult(list, p, false, false, 'unknown_season');
  }
  if (p.episode > 1) {
    return makeResult(list, { season: p.season, episode: p.episode - 1 }, true, false, null);
  }
  var prev = previousPlayableIndex(list, idx);
  if (prev === -1) {
    if (p.episode === 1) {
      return makeResult(list, { season: p.season, episode: 0 }, true, false, null);
    }
    return makeResult(list, p, false, false, 'at_start');
  }
  var prevCount = list[prev].episodeCount;
  if (prevCount === null) {
    return makeResult(list, p, false, false, 'unknown_previous_count');
  }
  return makeResult(list, { season: list[prev].number, episode: prevCount }, true, true, null);
}

// For the manual season/episode stepper: force a pointer into a valid range.
function clampPointer(seasons, pointer) {
  var list = normalizeSeasons(seasons);
  var p = readPointer(pointer);
  if (!p) return defaultPointer(list);
  var idx = findSeasonIndex(list, p.season);
  if (idx === -1) return defaultPointer(list);
  var count = list[idx].episodeCount;
  var episode = p.episode;
  if (count !== null && episode > count) episode = count;
  return { season: p.season, episode: episode };
}

// Total episodes across real seasons, or null if any count is unknown.
function totalEpisodes(seasons) {
  var list = normalizeSeasons(seasons);
  if (list.length === 0) return null;
  var total = 0;
  for (var i = 0; i < list.length; i++) {
    if (list[i].episodeCount === null) return null;
    total += list[i].episodeCount;
  }
  return total;
}

// Episodes watched so far, or null if earlier seasons have unknown counts.
function countWatched(seasons, pointer) {
  var list = normalizeSeasons(seasons);
  var p = readPointer(pointer);
  if (!p) return null;
  var idx = findSeasonIndex(list, p.season);
  if (idx === -1) return null;
  var watched = 0;
  for (var i = 0; i < idx; i++) {
    if (list[i].episodeCount === null) return null;
    watched += list[i].episodeCount;
  }
  var current = p.episode;
  var count = list[idx].episodeCount;
  if (count !== null && current > count) current = count;
  return watched + current;
}

// 0..1 for the progress bar, or null when there is no honest answer
// (unknown counts, no seasons, zero total). null = show no bar.
function progressFraction(seasons, pointer) {
  var total = totalEpisodes(seasons);
  var watched = countWatched(seasons, pointer);
  if (total === null || watched === null || total === 0) return null;
  var fraction = watched / total;
  if (fraction < 0) return 0;
  if (fraction > 1) return 1;
  return fraction;
}

// "S2 · E5" for the grid card. Empty string when not started.
function formatLabel(pointer) {
  var p = readPointer(pointer);
  if (!p || p.episode < 1) return '';
  return 'S' + p.season + ' · E' + p.episode;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeSeasons: normalizeSeasons,
    nextEpisode: nextEpisode,
    previousEpisode: previousEpisode,
    clampPointer: clampPointer,
    isFinalEpisode: isFinalEpisode,
    totalEpisodes: totalEpisodes,
    countWatched: countWatched,
    progressFraction: progressFraction,
    formatLabel: formatLabel
  };
}
