// diary.js: HTML for ticket stubs, the Diary list and a film's Viewings block.
// Pure string builders: no DOM and no database. Loads as a classic browser
// script and as a CommonJS module for the Node tests.
//
// Every builder takes options = { currency, icon(name), poster(title), compact }.
// icon and poster come from app.js so this file does not need the page.
//
// Style: flat top-level functions, no nested functions.

'use strict';

var DIARY_FILTERS = ['all', 'cinema', 'home'];
var DIARY_FILTER_LABELS = { all: 'All', cinema: 'Cinema', home: 'Home' };

// Reaches html.js and viewings.js in both environments.
function diaryLib() {
  if (typeof module !== 'undefined' && module.exports) {
    var viewings = require('./viewings.js');
    return {
      escapeHtml: require('./html.js').escapeHtml,
      monthLabel: viewings.monthLabel,
      longDate: viewings.longDate,
      stubDate: viewings.stubDate,
      starsText: viewings.starsText,
      stubFields: viewings.stubFields
    };
  }
  return {
    escapeHtml: escapeHtml,
    monthLabel: monthLabel,
    longDate: longDate,
    stubDate: stubDate,
    starsText: starsText,
    stubFields: stubFields
  };
}

function filterViewings(viewings, filter) {
  if (filter !== 'cinema' && filter !== 'home') return viewings.slice();
  var out = [];
  for (var i = 0; i < viewings.length; i++) {
    if (viewings[i].where === filter) out.push(viewings[i]);
  }
  return out;
}

// Viewings already sorted newest first become [{ label: 'March 2026', viewings }].
function groupByMonth(viewings) {
  var lib = diaryLib();
  var groups = [];
  for (var i = 0; i < viewings.length; i++) {
    var label = lib.monthLabel(viewings[i].watchedOn);
    if (groups.length === 0 || groups[groups.length - 1].label !== label) {
      groups.push({ label: label, viewings: [] });
    }
    groups[groups.length - 1].viewings.push(viewings[i]);
  }
  return groups;
}

// ---------- one stub ----------

function stubKind(viewing) {
  return viewing.where === 'cinema' || viewing.where === 'home' ? viewing.where : 'bare';
}

function stubLabel(viewing, title) {
  var lib = diaryLib();
  var label = (title ? title.title : 'Unknown title') + ', ' + lib.longDate(viewing.watchedOn);
  if (viewing.where) label += ', ' + viewing.where;
  if (viewing.rating !== null && viewing.rating !== undefined) label += ', rated ' + viewing.rating + ' out of 5';
  return label;
}

function stubFieldsHtml(viewing, options) {
  var lib = diaryLib();
  var fields = lib.stubFields(viewing, options.currency);
  if (fields.length === 0) return '';
  var html = '<ul class="stub-fields">';
  for (var i = 0; i < fields.length; i++) {
    html += '<li>' + options.icon(fields[i].icon) + '<span>' + lib.escapeHtml(fields[i].text) + '</span></li>';
  }
  return html + '</ul>';
}

function stubCopyHtml(viewing, title, options) {
  var lib = diaryLib();
  var fields = stubFieldsHtml(viewing, options);
  var note = viewing.note ? '<p class="stub-note">' + lib.escapeHtml(viewing.note) + '</p>' : '';
  if (options.compact) {
    var bare = fields === '' && note === '' ? '<p class="stub-empty">No details logged</p>' : '';
    return '<div class="stub-copy">' + bare + fields + note + '</div>';
  }
  var name = title ? title.title : 'Unknown title';
  var year = title && title.year ? ' <span class="stub-year">' + lib.escapeHtml(title.year) + '</span>' : '';
  return '<div class="stub-poster">' + (title ? options.poster(title) : '') + '</div>' +
    '<div class="stub-copy"><p class="stub-title">' + lib.escapeHtml(name) + year + '</p>' + fields + note + '</div>';
}

function stubSideHtml(viewing) {
  var lib = diaryLib();
  var date = lib.stubDate(viewing.watchedOn);
  var stars = lib.starsText(viewing.rating);
  return '<div class="stub-side"><span class="stub-month">' + date.month + '</span><span class="stub-day">' + date.day + '</span>' +
    (stars ? '<span class="stub-stars" aria-hidden="true">' + stars + '</span>' : '') +
    (viewing.where === 'cinema' ? '<span class="stub-tag">Cinema</span>' : '') + '</div>';
}

// title may be null (the film is gone); the stub still shows.
function stubHtml(viewing, title, options) {
  var lib = diaryLib();
  var compact = options.compact ? ' stub-compact' : '';
  return '<article class="stub stub-' + stubKind(viewing) + compact + '" role="button" tabindex="0" data-viewing-id="' +
    lib.escapeHtml(viewing.id) + '" aria-label="' + lib.escapeHtml(stubLabel(viewing, title)) + '">' +
    '<div class="stub-main">' + stubCopyHtml(viewing, title, options) + '</div>' + stubSideHtml(viewing) + '</article>';
}

// ---------- the Diary list ----------

function diaryChipsHtml(filter) {
  var html = '<div class="chips" role="group" aria-label="Filter viewings">';
  for (var i = 0; i < DIARY_FILTERS.length; i++) {
    var on = DIARY_FILTERS[i] === filter;
    html += '<button type="button" class="chip' + (on ? ' selected' : '') + '" data-filter="' + DIARY_FILTERS[i] +
      '" aria-pressed="' + on + '">' + DIARY_FILTER_LABELS[DIARY_FILTERS[i]] + '</button>';
  }
  return html + '</div>';
}

function diaryEmptyHtml(nothingAtAll, filter, options) {
  var heading = 'No viewings yet';
  var text = 'Mark a film as watched and it will land here as a stub.';
  if (!nothingAtAll && filter === 'cinema') {
    heading = 'No cinema viewings yet';
    text = 'Log a night at the cinema from any film\u2019s page.';
  } else if (!nothingAtAll && filter === 'home') {
    heading = 'No home viewings yet';
    text = 'Log how you watched a film from its page.';
  }
  return '<div class="empty"><div class="empty-icon" aria-hidden="true">' + options.icon('film') + '</div><h3>' + heading +
    '</h3><p class="muted">' + text + '</p></div>';
}

// viewings: every viewing, newest first. titles: { 'movie:1': titleRecord }.
function diaryHtml(viewings, titles, filter, options) {
  var lib = diaryLib();
  var shown = filterViewings(viewings, filter);
  var html = diaryChipsHtml(filter);
  if (shown.length === 0) return html + diaryEmptyHtml(viewings.length === 0, filter, options);
  var groups = groupByMonth(shown);
  for (var i = 0; i < groups.length; i++) {
    html += '<h3 class="diary-month">' + lib.escapeHtml(groups[i].label) + '</h3><div class="stub-list">';
    for (var j = 0; j < groups[i].viewings.length; j++) {
      html += stubHtml(groups[i].viewings[j], titles[groups[i].viewings[j].titleKey] || null, options);
    }
    html += '</div>';
  }
  return html;
}

// ---------- a film's Viewings block (inside the detail sheet) ----------

function viewingsBlockHtml(viewings, title, options) {
  var compact = Object.assign({}, options, { compact: true });
  var html = '<div class="viewings-block" id="viewings-block"><p class="field-label">Viewings</p>';
  if (viewings.length === 0) {
    html += '<p class="muted small">No viewings logged yet.</p>';
  } else {
    html += '<div class="stub-list">';
    for (var i = 0; i < viewings.length; i++) html += stubHtml(viewings[i], title, compact);
    html += '</div>';
  }
  return html + '<button type="button" class="ghost-button full-width" id="log-another">' + options.icon('plus') +
    'Log another viewing</button></div>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    filterViewings: filterViewings,
    groupByMonth: groupByMonth,
    stubHtml: stubHtml,
    diaryHtml: diaryHtml,
    viewingsBlockHtml: viewingsBlockHtml
  };
}
