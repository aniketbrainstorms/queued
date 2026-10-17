'use strict';

// app.js: the UI. Flat top-level functions; events are wired once in init().
// Storage is db.js, TMDB is tmdb.js, episode rules are progress.js.

var currentView = 'watchlist';
var currentTitles = [];
var pendingAdd = null;
var renderToken = 0;
var toastTimer = null;

var viewCopy = {
  watching: ['WATCHING', 'Keep the story moving', 'Pick up where you left off.'],
  watchlist: ['WATCHLIST', 'What’s next?', 'Save something for later.'],
  watched: ['WATCHED', 'Your viewing history', 'Everything you’ve finished.'],
  collections: ['LISTS', 'Your collections', 'Hand-made lists will live here.']
};

var EMPTY_COPY = {
  watching: ['Nothing in progress', 'Start a series and it will show up here with your episode progress.'],
  watchlist: ['Nothing queued yet', 'Add a movie or series you have been meaning to get to.'],
  watched: ['Nothing watched yet', 'Titles you finish will collect here.'],
  collections: ['Your collections are empty', 'Add titles to your library and start building a collection.']
};

var STEP_MESSAGES = {
  already_at_end: 'That was the last episode.',
  at_start: 'Already at the start.',
  unknown_previous_count: 'Cannot step back: the earlier season length is unknown.',
  unknown_season: 'This season is no longer listed on TMDB.',
  no_seasons: 'No season data saved for this series.',
  bad_pointer: 'Progress looks damaged.'
};

var KEY_MESSAGES = {
  BAD_FORMAT: 'That does not look like a TMDB key. Paste the 32-character API key or the long read access token.',
  BAD_KEY: 'TMDB rejected this key. Check it and try again.',
  NETWORK: 'Could not reach TMDB. Check your connection.',
  RATE_LIMITED: 'TMDB is rate limiting this key. Try again in a moment.',
  HTTP: 'TMDB returned an error. Try again in a moment.'
};

// ---------- icons (one place for every glyph) ----------

var ICON_PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  film: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8.5 4v16M15.5 4v16M4 9h4.5M4 15h4.5M15.5 9H20M15.5 15H20"/>',
  'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>'
};

function icon(name) {
  return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICON_PATHS[name] || '') + '</svg>';
}

// Replaces <span data-icon="name"></span> placeholders with the SVG.
function hydrateIcons(root) {
  var spots = root.querySelectorAll('[data-icon]');
  for (var i = 0; i < spots.length; i++) {
    spots[i].outerHTML = icon(spots[i].getAttribute('data-icon'));
  }
}

// ---------- small helpers ----------

function byId(id) { return document.getElementById(id); }

function hideToast() { byId('toast').classList.remove('show'); }

function showToast(message) {
  var toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 2600);
}

function closeDialog(id) {
  var dialog = byId(id);
  if (dialog.open) dialog.close();
}

var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeChar(c) { return HTML_ESCAPES[c]; }
function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, escapeChar); }

function isSafePath(path) { return typeof path === 'string' && /^\/[A-Za-z0-9._-]+$/.test(path); }

function statusLabel(status) { return status === 'watching' ? 'Watching' : status === 'watched' ? 'Watched' : 'Watchlist'; }
function kindLabel(type) { return type === 'tv' ? 'Series' : 'Movie'; }
function metaLine(title) { return (title.year || 'Unknown year') + ' · ' + kindLabel(title.type); }

// Posters without an image get generated art, a stable color per title.
var POSTER_HUES = [290, 75, 190, 350, 130, 220, 30];

function hueFor(seed) {
  var text = String(seed || '');
  var hash = 0;
  for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 100000;
  return POSTER_HUES[hash % POSTER_HUES.length];
}

// alt '' marks the image decorative (the card already has the title as text).
function poster(path, alt, seed, cls) {
  var klass = cls || 'poster';
  if (isSafePath(path)) {
    return '<img class="' + klass + '" src="' + imageUrl(path, 'w342') + '" alt="' + escapeHtml(alt) + '" loading="lazy">';
  }
  var label = alt ? 'role="img" aria-label="No poster for ' + escapeHtml(alt) + '"' : 'aria-hidden="true"';
  return '<div class="poster-art ' + klass + '" style="--hue:' + hueFor(seed) + '" ' + label + '></div>';
}

function newestFirst(a, b) {
  return String(b.addedAt || '').localeCompare(String(a.addedAt || ''));
}

// ---------- progress bars ----------

async function loadProgress(titles) {
  var map = {};
  var watchingSeries = titles.filter(function (t) { return t.type === 'tv' && t.status === 'watching'; });
  var rows = await Promise.all(watchingSeries.map(function (t) { return getProgress(t.key); }));
  watchingSeries.forEach(function (t, i) { if (rows[i]) map[t.key] = rows[i]; });
  return map;
}

// fromFraction (optional) starts the fill there so it animates to the new value.
function progressBar(record, fromFraction) {
  var fraction = progressFraction(record.seasons, record);
  if (fraction === null) return '';
  var to = Math.round(fraction * 100);
  var from = typeof fromFraction === 'number' ? Math.round(fromFraction * 100) : to;
  return '<span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + to + '">' +
    '<span class="bar-fill" data-to="' + to + '" style="width:' + from + '%"></span></span>';
}

function settleBars(root) {
  var fills = root.querySelectorAll('.bar-fill');
  if (!fills.length) return;
  void root.offsetWidth; // commit the starting width before changing it
  for (var i = 0; i < fills.length; i++) fills[i].style.width = fills[i].getAttribute('data-to') + '%';
}

function progressMini(record) {
  if (!record) return '';
  return '<div class="progress-mini"><span>' + (formatLabel(record) || 'Not started') + '</span>' + progressBar(record) + '</div>';
}

// ---------- shelf ----------

function emptyHtml(view) {
  var copy = EMPTY_COPY[view];
  return '<div class="empty"><div class="empty-icon" aria-hidden="true">' + icon('film') + '</div><h3>' + copy[0] +
    '</h3><p class="muted">' + copy[1] + '</p><button type="button" class="primary-button" id="empty-add">' + icon('plus') + 'Add a title</button></div>';
}

function cardHtml(title, record) {
  var label = title.title + ', ' + metaLine(title) + ', ' + statusLabel(title.status);
  return '<article class="card" tabindex="0" role="button" data-key="' + title.key + '" aria-label="' + escapeHtml(label) + '">' +
    poster(title.posterPath, '', title.key) +
    '<div class="card-body"><div class="card-title">' + escapeHtml(title.title) + '</div>' +
    '<div class="card-meta">' + metaLine(title) + '</div>' + progressMini(record) +
    '<span class="badge badge-' + title.status + '">' + statusLabel(title.status) + '</span></div></article>';
}

async function render() {
  var token = ++renderToken;
  var copy = viewCopy[currentView];
  byId('view-kicker').textContent = copy[0];
  byId('view-title').textContent = copy[1];
  byId('view-description').textContent = copy[2];
  var grid = byId('library-grid');

  if (currentView === 'collections') {
    currentTitles = [];
    byId('shelf-count').textContent = '0 LISTS';
    grid.innerHTML = emptyHtml('collections');
    return;
  }

  var titles = await getTitlesByStatus(currentView);
  var progressByKey = await loadProgress(titles);
  if (token !== renderToken) return; // a newer render took over
  titles.sort(newestFirst);
  currentTitles = titles;
  byId('shelf-count').textContent = titles.length + (titles.length === 1 ? ' TITLE' : ' TITLES');

  if (!titles.length) {
    grid.innerHTML = emptyHtml(currentView);
    return;
  }
  var html = '';
  for (var i = 0; i < titles.length; i++) html += cardHtml(titles[i], progressByKey[titles[i].key]);
  grid.innerHTML = html;
}

function onGridClick(event) {
  if (event.target.closest('#empty-add')) { openSearch(); return; }
  var card = event.target.closest('.card');
  if (card) showDetail(card.getAttribute('data-key'));
}

function onGridKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  var card = event.target.closest('.card');
  if (!card) return;
  event.preventDefault();
  showDetail(card.getAttribute('data-key'));
}

// ---------- detail sheet ----------

function progressBlock(record, fromFraction) {
  if (!record) return '';
  return '<div class="progress-block" id="progress-block"><p class="progress-label">' + (formatLabel(record) || 'Not started') + '</p>' +
    progressBar(record, fromFraction) +
    '<div class="button-row"><button type="button" class="ghost-button" id="prev-episode">' + icon('chevron-left') + 'Back</button>' +
    '<button type="button" class="primary-button grow" id="next-episode">Next episode' + icon('chevron-right') + '</button></div></div>';
}

function statusRowHtml(current) {
  var statuses = ['watchlist', 'watching', 'watched'];
  var html = '<div class="status-row" role="group" aria-label="Status" data-selected="' + current + '">';
  for (var i = 0; i < statuses.length; i++) {
    var on = statuses[i] === current;
    html += '<button type="button" data-status="' + statuses[i] + '" class="' + (on ? 'selected' : '') + '" aria-pressed="' + on + '">' + statusLabel(statuses[i]) + '</button>';
  }
  return html + '</div>';
}

function onStatusClick(event) {
  var button = event.target.closest('[data-status]');
  if (!button) return;
  var row = event.currentTarget;
  row.setAttribute('data-selected', button.getAttribute('data-status'));
  var buttons = row.querySelectorAll('[data-status]');
  for (var i = 0; i < buttons.length; i++) {
    var on = buttons[i] === button;
    buttons[i].classList.toggle('selected', on);
    buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

async function showDetail(key, fromFraction) {
  var title = await getTitle(key);
  if (!title) return;
  var detail = byId('detail-content');
  var record = title.type === 'tv' && title.status === 'watching' ? await getProgress(key) : null;
  var overview = title.snapshot && title.snapshot.overview || 'No overview saved.';

  detail.innerHTML =
    '<div class="sheet-heading"><div><p class="eyebrow">' + kindLabel(title.type) + '</p><h2>' + escapeHtml(title.title) + '</h2></div>' +
    '<button type="button" class="close-button" data-close aria-label="Close">' + icon('x') + '</button></div>' +
    '<div class="detail-copy">' + poster(title.posterPath, title.title, title.key, 'detail-poster') +
    '<div class="copy-text"><p class="muted">' + metaLine(title) + '</p><p>' + escapeHtml(overview) + '</p></div></div>' +
    progressBlock(record, fromFraction) + statusRowHtml(title.status) +
    '<textarea class="notes" id="detail-notes" placeholder="Personal note…" aria-label="Personal note">' + escapeHtml(title.notes || '') + '</textarea>' +
    '<div class="button-row"><button type="button" class="ghost-button danger" id="remove-detail">Remove</button>' +
    '<button type="button" class="primary-button grow" id="save-detail">Save changes</button></div>';

  var dialog = byId('detail-dialog');
  if (!dialog.open) dialog.showModal();
  detail.querySelector('.status-row').addEventListener('click', onStatusClick);
  byId('save-detail').addEventListener('click', saveDetail.bind(null, key));
  byId('remove-detail').addEventListener('click', removeFromDetail.bind(null, key));
  wireProgress(key, record);
  settleBars(detail);
}

async function saveDetail(key) {
  var title = await getTitle(key);
  if (!title) return;
  var row = byId('detail-content').querySelector('.status-row');
  var status = row && row.getAttribute('data-selected') || title.status;
  await changeStatus(title, status);
  await updateTitle(key, { notes: byId('detail-notes').value });
  closeDialog('detail-dialog');
  showToast('Saved');
  render();
}

async function removeFromDetail(key) {
  await removeTitle(key);
  closeDialog('detail-dialog');
  showToast('Removed from library');
  render();
}

// ---------- episode stepping ----------

function wireProgress(key, record) {
  if (!record) return;
  byId('next-episode').addEventListener('click', stepEpisode.bind(null, key, 'next'));
  byId('prev-episode').addEventListener('click', stepEpisode.bind(null, key, 'prev'));
}

function setStepButtons(disabled) {
  byId('next-episode').disabled = disabled;
  byId('prev-episode').disabled = disabled;
}

async function stepEpisode(key, direction) {
  setStepButtons(true);
  var record = await getProgress(key);
  if (!record) { setStepButtons(false); return; }
  var pointer = { season: record.season, episode: record.episode };
  var before = progressFraction(record.seasons, record);
  var result = direction === 'next' ? nextEpisode(record.seasons, pointer) : previousEpisode(record.seasons, pointer);
  if (!result.changed) {
    showToast(STEP_MESSAGES[result.reason] || 'Cannot move there.');
    setStepButtons(false);
    return;
  }
  if (direction === 'next') await commitEpisode(key, result.pointer, record.seasons);
  else await undoEpisode(key, result.pointer, record.seasons);
  await showDetail(key, before);
  render();
  if (direction === 'next' && result.reachedEnd) showFinishPrompt(key);
}

function showFinishPrompt(key) {
  var block = byId('progress-block');
  if (!block) return;
  block.insertAdjacentHTML('beforeend',
    '<div class="finish-prompt"><p>That was the last episode. Mark as watched?</p><div class="button-row">' +
    '<button type="button" class="ghost-button" id="finish-later">Not yet</button>' +
    '<button type="button" class="primary-button grow" id="finish-now">Mark as watched</button></div></div>');
  byId('finish-later').addEventListener('click', dismissFinishPrompt);
  byId('finish-now').addEventListener('click', finishSeries.bind(null, key));
}

function dismissFinishPrompt() {
  var prompt = byId('progress-block').querySelector('.finish-prompt');
  if (prompt) prompt.remove();
}

async function finishSeries(key) {
  await markWatched(key);
  closeDialog('detail-dialog');
  showToast('Marked as watched');
  render();
}

// A series entering Watching gets its progress record (S1, not started).
async function ensureProgress(title) {
  if (title.type !== 'tv') return;
  if (await getProgress(title.key)) return;
  var seasons = title.snapshot && title.snapshot.seasons || [];
  await saveProgress(title.key, clampPointer(seasons, null), seasons);
}

// Every status change goes through here so the log and progress stay correct:
// Watched logs a movie (markWatched), Watching creates a series' progress.
async function changeStatus(title, status) {
  if (status === title.status) return;
  if (status === 'watched') await markWatched(title.key); else await setStatus(title.key, status);
  if (status === 'watching') await ensureProgress(title);
}

// ---------- search and add ----------

function isTitleResult(item) { return item.mediaType !== 'person'; }

function resultHtml(item) {
  var thumb = isSafePath(item.imagePath)
    ? '<img class="result-thumb" src="' + imageUrl(item.imagePath, 'w185') + '" alt="" loading="lazy">'
    : poster(null, '', item.mediaType + ':' + item.id, 'result-thumb');
  return '<button type="button" class="result" data-type="' + item.mediaType + '" data-id="' + item.id + '">' + thumb +
    '<span class="result-text"><span class="result-title">' + escapeHtml(item.title) + '</span>' +
    '<span class="result-meta">' + (item.year || 'Unknown year') + ' · ' + kindLabel(item.mediaType) + '</span>' +
    '<span class="result-overview">' + escapeHtml(item.overview) + '</span></span></button>';
}

// Missing or rejected key: say so and offer a way to fix it.
function errorHtml(err, fallback) {
  if (err && (err.code === 'NO_KEY' || err.code === 'BAD_KEY')) {
    var text = err.code === 'NO_KEY' ? 'Add your free TMDB key in Settings to search.' : 'TMDB rejected your key. Check it in Settings.';
    return '<p class="muted">' + text + '</p><button type="button" class="ghost-button open-settings">Open settings</button>';
  }
  return '<p class="muted">' + escapeHtml(err && err.message || fallback) + '</p>';
}

async function searchTitles(event) {
  event.preventDefault();
  var results = byId('search-results');
  var query = byId('search-input').value.trim();
  if (!query) { results.innerHTML = ''; return; }
  results.innerHTML = '<p class="muted">Searching…</p>';
  try {
    var found = await searchMulti(query);
    var items = found.results.filter(isTitleResult);
    results.innerHTML = items.length ? items.map(resultHtml).join('') : '<p class="muted">No movies or series found.</p>';
  } catch (err) {
    results.innerHTML = errorHtml(err, 'Search failed.');
  }
}

function onResultsClick(event) {
  if (event.target.closest('.open-settings')) { closeDialog('search-dialog'); openSettings(); return; }
  var button = event.target.closest('.result');
  if (button) previewSearchResult(button);
}

function addPreviewHtml(t) {
  var overview = (t.snapshot && t.snapshot.overview || 'No overview saved.').slice(0, 280);
  var buttons = ['watchlist', 'watching', 'watched'].map(function (s) { return '<button type="button" data-add="' + s + '">' + statusLabel(s) + '</button>'; }).join('');
  return '<div class="add-preview">' + poster(t.posterPath, t.title, t.key, 'detail-poster') +
    '<h3>' + escapeHtml(t.title) + '</h3><p class="muted">' + metaLine(t) + '</p><p>' + escapeHtml(overview) + '</p>' +
    '<p class="field-label">Add to</p><div class="status-row">' + buttons + '</div>' +
    '<button type="button" class="ghost-button full-width" id="add-back">Back to results</button></div>';
}

async function previewSearchResult(button) {
  var box = byId('search-results');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    var isMovie = button.getAttribute('data-type') === 'movie';
    var id = button.getAttribute('data-id');
    var details = isMovie ? await getMovie(id) : await getTv(id);
    pendingAdd = isMovie ? titleFromMovie(details) : titleFromTv(details);
    box.innerHTML = addPreviewHtml(pendingAdd);
    Array.prototype.forEach.call(box.querySelectorAll('[data-add]'), function (b) { b.addEventListener('click', function () { addFromPreview(b.getAttribute('data-add')); }); });
    byId('add-back').addEventListener('click', function () { byId('search-form').requestSubmit(); });
  } catch (err) {
    box.innerHTML = errorHtml(err, 'Could not load details.');
  }
}

async function addFromPreview(status) {
  try {
    var record = Object.assign({}, pendingAdd, { status: 'watchlist', addedAt: new Date().toISOString() });
    await addTitle(record);
    await changeStatus(record, status);
    closeDialog('search-dialog');
    showToast('Added to ' + statusLabel(status));
    render();
  } catch (err) {
    showToast(err.code === 'DUPLICATE' ? 'Already in your library' : err.message || 'Could not add title');
  }
}

function openSearch() {
  byId('search-dialog').showModal();
  byId('search-input').focus();
}

// ---------- settings, export, import ----------

function openSettings() {
  var info = loadStoredKey();
  byId('tmdb-key').value = '';
  byId('key-state').textContent = info ? 'Saved key: ' + maskKey(info.key) : 'No key saved yet.';
  byId('settings-dialog').showModal();
}

async function handleSaveKey() {
  var field = byId('tmdb-key');
  var state = byId('key-state');
  var raw = field.value;
  state.textContent = 'Testing…';
  var check;
  try {
    check = await verifyKey(raw);
  } catch (err) {
    check = { ok: false, code: 'HTTP' };
  }
  // Offline is not a reason to refuse a well-formed key: save it, test later.
  if (!check.ok && check.code !== 'NETWORK') {
    state.textContent = KEY_MESSAGES[check.code] || 'Could not verify the key.';
    return;
  }
  var saved = saveKey(raw);
  if (!saved.ok) {
    state.textContent = 'Could not save the key (' + saved.reason + ').';
    return;
  }
  field.value = '';
  state.textContent = check.ok ? 'Key saved and working.' : 'Key saved, but TMDB could not be reached to test it.';
  showToast('TMDB key saved');
}

function handleClearKey() {
  clearKey();
  byId('key-state').textContent = 'Key cleared.';
}

function exportBackup() {
  exportAll().then(function (data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'queued-backup-' + data.exportedAt.slice(0, 10) + '.json';
    link.click();
    URL.revokeObjectURL(url);
    showToast('Backup exported');
  });
}

function onImportChange(event) {
  var input = event.currentTarget;
  var file = input.files[0];
  if (!file) return;
  file.text().then(importAll).then(function () {
    showToast('Backup imported');
    closeDialog('settings-dialog');
    render();
  }).catch(function (err) {
    showToast(err.message || 'Import failed');
  }).then(function () {
    input.value = ''; // allow choosing the same file again
  });
}

// ---------- wiring ----------

function setView(view) {
  currentView = view;
  var tabs = document.querySelectorAll('.bottom-bar button');
  for (var i = 0; i < tabs.length; i++) {
    var active = tabs[i].getAttribute('data-view') === view;
    tabs[i].classList.toggle('active', active);
    if (active) tabs[i].setAttribute('aria-current', 'page'); else tabs[i].removeAttribute('aria-current');
  }
  render();
}

function onTabClick(event) { setView(event.currentTarget.getAttribute('data-view')); }

// Any [data-close] button closes its dialog; clicking the backdrop does too.
function onDocumentClick(event) {
  var closer = event.target.closest('[data-close]');
  if (!closer) return;
  var dialog = closer.closest('dialog');
  if (dialog) dialog.close();
}

function onDialogClick(event) {
  if (event.target === event.currentTarget) event.currentTarget.close();
}

function onSettingsSubmit(event) {
  event.preventDefault(); // Enter in the key field saves instead of closing
  handleSaveKey();
}

function init() {
  hydrateIcons(document);

  var tabs = document.querySelectorAll('.bottom-bar button');
  for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener('click', onTabClick);
  var dialogs = document.querySelectorAll('dialog');
  for (var j = 0; j < dialogs.length; j++) dialogs[j].addEventListener('click', onDialogClick);

  document.addEventListener('click', onDocumentClick);
  byId('library-grid').addEventListener('click', onGridClick);
  byId('library-grid').addEventListener('keydown', onGridKeydown);
  byId('search-button').addEventListener('click', openSearch);
  byId('search-form').addEventListener('submit', searchTitles);
  byId('search-results').addEventListener('click', onResultsClick);
  byId('settings-button').addEventListener('click', openSettings);
  byId('settings-form').addEventListener('submit', onSettingsSubmit);
  byId('export-button').addEventListener('click', exportBackup);
  byId('save-key').addEventListener('click', handleSaveKey);
  byId('clear-key').addEventListener('click', handleClearKey);
  byId('import-button').addEventListener('click', function () { byId('import-file').click(); });
  byId('import-file').addEventListener('change', onImportChange);

  render();
}

document.addEventListener('DOMContentLoaded', init);
