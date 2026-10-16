'use strict';

var currentView = 'watchlist';
var currentTitles = [];
var viewCopy = {
  watching: ['WATCHING', 'Keep the story moving', 'Pick up where you left off.'],
  watchlist: ['WATCHLIST', 'What’s next?', 'Save something for later.'],
  watched: ['WATCHED', 'Your viewing history', 'Everything you’ve finished.'],
  collections: ['LISTS', 'Your collections', 'Hand-made lists will live here.']
};

function byId(id) { return document.getElementById(id); }
function showToast(message) { var toast = byId('toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(function () { toast.classList.remove('show'); }, 2600); }
function isSafePath(path) { return typeof path === 'string' && /^\/[A-Za-z0-9._-]+$/.test(path); }
function poster(path, alt) { return isSafePath(path) ? '<img class="poster" src="' + imageUrl(path, 'w342') + '" alt="' + escapeHtml(alt) + '">' : '<div class="poster poster-placeholder">✦</div>'; }
function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function statusLabel(status) { return status === 'watching' ? 'Watching' : status === 'watched' ? 'Watched' : 'Watchlist'; }
function syncHeroLayout() { var hero = byId('hero'); if (!hero) return; if (window.innerWidth <= 700) { hero.style.setProperty('height', '172px', 'important'); hero.style.setProperty('min-height', '172px', 'important'); hero.style.setProperty('max-height', '172px', 'important'); } else { hero.style.removeProperty('height'); hero.style.removeProperty('min-height'); hero.style.removeProperty('max-height'); } }

async function loadProgress(titles) {
  var map = {};
  var watchingSeries = titles.filter(function (t) { return t.type === 'tv' && t.status === 'watching'; });
  var rows = await Promise.all(watchingSeries.map(function (t) { return getProgress(t.key); }));
  watchingSeries.forEach(function (t, i) { if (rows[i]) map[t.key] = rows[i]; });
  return map;
}
function progressBar(record) {
  var fraction = progressFraction(record.seasons, record);
  if (fraction === null) return '';
  return '<span class="bar"><span class="bar-fill" style="width:' + Math.round(fraction * 100) + '%"></span></span>';
}
function progressMini(title, record) {
  if (!record) return '';
  return '<div class="progress-mini"><span>' + (formatLabel(record) || 'Not started') + '</span>' + progressBar(record) + '</div>';
}

async function render() {
  syncHeroLayout();
  var copy = viewCopy[currentView]; byId('view-kicker').textContent = copy[0]; byId('view-title').textContent = copy[1]; byId('view-description').textContent = copy[2];
  var grid = byId('library-grid');
  if (currentView === 'collections') { grid.innerHTML = '<div class="empty"><div class="empty-icon" aria-hidden="true">✦</div><h3>Your collections are empty</h3><p class="muted">Add titles to your library and start building a collection.</p><button class="primary-button empty-action" id="empty-add">＋ Add a title</button></div>'; byId('empty-add').addEventListener('click', openSearch); return; }
  currentTitles = await getTitlesByStatus(currentView); byId('shelf-count').textContent = currentTitles.length + (currentTitles.length === 1 ? ' TITLE' : ' TITLES'); var progressByKey = await loadProgress(currentTitles);
  if (!currentTitles.length) { grid.innerHTML = '<div class="empty"><div class="empty-icon" aria-hidden="true">✦</div><h3>' + (currentView === 'watchlist' ? 'Your watchlist is empty' : 'Nothing here yet') + '</h3><p class="muted">Add a movie or series to start building your shelf.</p><button class="primary-button empty-action" id="empty-add">＋ Add a title</button></div>'; byId('empty-add').addEventListener('click', openSearch); return; }
  grid.innerHTML = currentTitles.map(function (title) { return '<article class="card" data-key="' + title.key + '">' + poster(title.posterPath, title.title) + '<div class="card-body"><div class="card-title">' + escapeHtml(title.title) + '</div><div class="card-meta">' + (title.year || 'Unknown year') + (title.type === 'tv' ? ' · Series' : ' · Movie') + '</div>' + progressMini(title, progressByKey[title.key]) + '<span class="badge badge-' + title.status + '">' + statusLabel(title.status) + '</span></div></article>'; }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('.card'), function (card) { card.addEventListener('click', openDetail); });
}

function openDetail(event) { return showDetail(event.currentTarget.getAttribute('data-key')); }

async function showDetail(key) {
  var title = await getTitle(key); var detail = byId('detail-content');
  var record = title.type === 'tv' && title.status === 'watching' ? await getProgress(key) : null;
  detail.innerHTML = '<div class="sheet-heading"><div><p class="eyebrow">TITLE</p><h2>' + escapeHtml(title.title) + '</h2></div><button class="close-button" onclick="byId(\'detail-dialog\').close()">×</button></div><div class="detail-copy">' + poster(title.posterPath, title.title).replace('class="poster"', 'class="detail-poster"') + '<p class="muted">' + (title.year || 'Unknown year') + ' · ' + (title.type === 'tv' ? 'Series' : 'Movie') + '</p><p>' + escapeHtml(title.snapshot && title.snapshot.overview || 'No overview saved.') + '</p></div>' + progressBlock(record) + '<div class="status-row">' + ['watchlist','watching','watched'].map(function (status) { return '<button data-status="' + status + '" class="' + (title.status === status ? 'selected' : '') + '">' + statusLabel(status) + '</button>'; }).join('') + '</div><textarea class="notes" id="detail-notes" placeholder="Personal note…">' + escapeHtml(title.notes || '') + '</textarea><div class="button-row"><button class="primary-button" id="save-detail">Save changes</button><button class="ghost-button" id="remove-detail">Remove</button></div>';
  if (!byId('detail-dialog').open) byId('detail-dialog').showModal(); var selectedStatus = title.status;
  Array.prototype.forEach.call(detail.querySelectorAll('[data-status]'), function (button) { button.addEventListener('click', function () { selectedStatus = button.getAttribute('data-status'); Array.prototype.forEach.call(detail.querySelectorAll('[data-status]'), function (other) { other.classList.toggle('selected', other === button); }); }); });
  byId('save-detail').addEventListener('click', async function () { await changeStatus(title, selectedStatus); await updateTitle(key, {notes:byId('detail-notes').value, updatedAt:new Date().toISOString()}); byId('detail-dialog').close(); showToast('Saved'); render(); });
  byId('remove-detail').addEventListener('click', async function () { await removeTitle(key); byId('detail-dialog').close(); showToast('Removed from library'); render(); });
  wireProgress(key, record);
}

var STEP_MESSAGES = {
  already_at_end: 'That was the last episode.',
  at_start: 'Already at the start.',
  unknown_previous_count: 'Cannot step back: the earlier season length is unknown.',
  unknown_season: 'This season is no longer listed on TMDB.',
  no_seasons: 'No season data saved for this series.',
  bad_pointer: 'Progress looks damaged.'
};

function progressBlock(record) {
  if (!record) return '';
  return '<div class="progress-block" id="progress-block"><p class="progress-label">' + (formatLabel(record) || 'Not started') + '</p>' + progressBar(record) + '<div class="button-row"><button type="button" class="ghost-button" id="prev-episode">Back</button><button type="button" class="primary-button" id="next-episode">Next episode</button></div></div>';
}

function wireProgress(key, record) {
  if (!record) return;
  byId('next-episode').addEventListener('click', function () { stepEpisode(key, 'next'); });
  byId('prev-episode').addEventListener('click', function () { stepEpisode(key, 'prev'); });
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
  var result = direction === 'next' ? nextEpisode(record.seasons, pointer) : previousEpisode(record.seasons, pointer);
  if (!result.changed) { showToast(STEP_MESSAGES[result.reason] || 'Cannot move there.'); setStepButtons(false); return; }
  if (direction === 'next') await commitEpisode(key, result.pointer, record.seasons);
  else await undoEpisode(key, result.pointer, record.seasons);
  await showDetail(key);
  render();
  if (direction === 'next' && result.reachedEnd) showFinishPrompt(key);
}

function showFinishPrompt(key) {
  var block = byId('progress-block');
  if (!block) return;
  block.insertAdjacentHTML('beforeend', '<div class="finish-prompt"><p>That was the last episode. Mark as watched?</p><div class="button-row"><button type="button" class="ghost-button" id="finish-later">Not yet</button><button type="button" class="primary-button" id="finish-now">Mark as watched</button></div></div>');
  byId('finish-later').addEventListener('click', function () { block.querySelector('.finish-prompt').remove(); });
  byId('finish-now').addEventListener('click', async function () { await markWatched(key); byId('detail-dialog').close(); showToast('Marked as watched'); render(); });
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

async function searchTitles(event) { event.preventDefault(); var results = byId('search-results'); results.innerHTML = '<p class="muted">Searching…</p>'; try { var found = await searchMulti(byId('search-input').value); var items = found.results.filter(function (item) { return item.mediaType !== 'person'; }); results.innerHTML = items.length ? items.map(function (item) { return '<button type="button" class="result" data-type="' + item.mediaType + '" data-id="' + item.id + '">' + (isSafePath(item.imagePath) ? '<img src="' + imageUrl(item.imagePath, 'w185') + '" alt="">' : '<div class="result poster-placeholder">✦</div>') + '<span><span class="result-title">' + escapeHtml(item.title) + '</span><br><span class="small muted">' + (item.year || 'Unknown year') + ' · ' + item.mediaType + '</span><br><span class="small muted">' + escapeHtml(item.overview).slice(0, 120) + '</span></span></button>'; }).join('') : '<p class="muted">No movies or series found.</p>'; Array.prototype.forEach.call(results.querySelectorAll('.result'), function (button) { button.addEventListener('click', previewSearchResult); }); } catch (err) { results.innerHTML = '<p class="muted">' + escapeHtml(err.message || 'Search failed.') + '</p>'; } }
var pendingAdd = null;

function addPreviewHtml(t) {
  var kind = t.type === 'tv' ? 'Series' : 'Movie';
  var overview = (t.snapshot && t.snapshot.overview || 'No overview saved.').slice(0, 280);
  var buttons = ['watchlist', 'watching', 'watched'].map(function (s) { return '<button type="button" data-add="' + s + '">' + statusLabel(s) + '</button>'; }).join('');
  return '<div class="add-preview">' + poster(t.posterPath, t.title).replace('class="poster"', 'class="detail-poster"') + '<h3>' + escapeHtml(t.title) + '</h3><p class="muted">' + (t.year || 'Unknown year') + ' · ' + kind + '</p><p>' + escapeHtml(overview) + '</p><p class="field-label">Add to</p><div class="status-row">' + buttons + '</div><button type="button" class="ghost-button full-width" id="add-back">Back to results</button></div>';
}

async function previewSearchResult(event) {
  var button = event.currentTarget; var box = byId('search-results');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    var isMovie = button.getAttribute('data-type') === 'movie'; var id = button.getAttribute('data-id');
    var details = isMovie ? await getMovie(id) : await getTv(id);
    pendingAdd = isMovie ? titleFromMovie(details) : titleFromTv(details);
    box.innerHTML = addPreviewHtml(pendingAdd);
    Array.prototype.forEach.call(box.querySelectorAll('[data-add]'), function (b) { b.addEventListener('click', function () { addFromPreview(b.getAttribute('data-add')); }); });
    byId('add-back').addEventListener('click', function () { byId('search-form').requestSubmit(); });
  } catch (err) { box.innerHTML = '<p class="muted">' + escapeHtml(err.message || 'Could not load details.') + '</p>'; }
}

async function addFromPreview(status) {
  try {
    var record = Object.assign({}, pendingAdd, { status: 'watchlist', addedAt: new Date().toISOString() });
    await addTitle(record);
    await changeStatus(record, status);
    byId('search-dialog').close(); showToast('Added to ' + statusLabel(status)); render();
  } catch (err) { showToast(err.code === 'DUPLICATE' ? 'Already in your library' : err.message || 'Could not add title'); }
}
function openSearch() { byId('search-dialog').showModal(); byId('search-input').focus(); }
async function handleSaveKey() { var result = verifyKey(byId('tmdb-key').value); result.then(function (check) { if (!check.ok) { byId('key-state').textContent = 'Could not verify key: ' + check.code; return; } var saved = saveKey(byId('tmdb-key').value); if (saved.ok) { byId('key-state').textContent = 'Key saved.'; showToast('TMDB key saved'); } else { byId('key-state').textContent = 'Could not save the key (' + saved.reason + ').'; } }); }
function openSettings() { var info = loadStoredKey(); byId('tmdb-key').value = ''; byId('key-state').textContent = info ? 'Saved key: ' + maskKey(info.key) : 'No key saved yet.'; byId('settings-dialog').showModal(); }
function exportBackup() { exportAll().then(function (data) { var blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}); var url = URL.createObjectURL(blob); var link = document.createElement('a'); link.href = url; link.download = 'queued-backup-' + data.exportedAt.slice(0,10) + '.json'; link.click(); URL.revokeObjectURL(url); showToast('Backup exported'); }); }

document.addEventListener('DOMContentLoaded', function () { window.addEventListener('resize', syncHeroLayout); document.querySelectorAll('.bottom-bar button').forEach(function (button) { button.addEventListener('click', function () { currentView = button.getAttribute('data-view'); document.querySelectorAll('.bottom-bar button').forEach(function (other) { other.classList.toggle('active', other === button); }); render(); }); }); byId('search-button').addEventListener('click', openSearch); byId('search-form').addEventListener('submit', searchTitles); byId('settings-button').addEventListener('click', openSettings); byId('export-button').addEventListener('click', exportBackup); byId('save-key').addEventListener('click', handleSaveKey); byId('clear-key').addEventListener('click', function () { clearKey(); byId('key-state').textContent = 'Key cleared.'; }); byId('import-button').addEventListener('click', function () { byId('import-file').click(); }); byId('import-file').addEventListener('change', function () { var file = this.files[0]; if (!file) return; file.text().then(importAll).then(function () { showToast('Backup imported'); byId('settings-dialog').close(); render(); }).catch(function (err) { showToast(err.message || 'Import failed'); }); }); render(); });
