// viewing_sheet.js: the sheet where a viewing is logged or edited, and the
// "Log details?" prompt. This part is the pure model and the HTML builders:
// no DOM and no database, so Node can test it. Loads as a classic browser
// script and as a CommonJS module.
//
// The sheet edits a "draft": every field is plain text (or the rating number),
// so what is on screen is always what is in the draft.
//
// Style: flat top-level functions, no nested functions.

'use strict';

var SHEET_NOTE_MAX = 80;
var SHEET_TEXT_MAX = 60;
var SHEET_TEXT_KEYS = ['watchedOn', 'note', 'format', 'withWhom', 'cinemaName', 'cinemaCity', 'screen', 'seat', 'price', 'service'];
var SHEET_CHOICE_KEYS = ['source', 'device', 'format'];

var FORMAT_CHIPS = {
  cinema: ['IMAX', '35mm', '70mm', 'Dolby Cinema', '3D', 'Standard'],
  home: ['SD', 'HD', '4K', 'Blu-ray']
};
var SOURCE_CHOICES = [['streaming', 'Streaming'], ['disc', 'Disc'], ['tv', 'TV'], ['pirated', 'Pirated'], ['other', 'Other']];
var DEVICE_CHOICES = [['tv', 'TV'], ['laptop', 'Laptop'], ['phone', 'Phone'], ['tablet', 'Tablet'], ['projector', 'Projector']];

// Reaches html.js in both environments.
function sheetEscape(value) {
  if (typeof module !== 'undefined' && module.exports) return require('./html.js').escapeHtml(value);
  return escapeHtml(value);
}

// ---------- the draft ----------

function newDraft(titleKey, today) {
  return {
    id: null, titleKey: titleKey, watchedOn: today, where: 'home', rating: null, note: '',
    format: '', withWhom: '', cinemaName: '', cinemaCity: '', screen: '', seat: '', price: '',
    source: '', service: '', device: ''
  };
}

function textOf(value) {
  return value === null || value === undefined ? '' : String(value);
}

// A bare viewing (no place chosen) opens on Home.
function draftFromViewing(viewing) {
  return {
    id: viewing.id, titleKey: viewing.titleKey, watchedOn: viewing.watchedOn,
    where: viewing.where === 'cinema' ? 'cinema' : 'home',
    rating: viewing.rating === undefined ? null : viewing.rating, note: textOf(viewing.note),
    format: textOf(viewing.format), withWhom: textOf(viewing.withWhom),
    cinemaName: textOf(viewing.cinemaName), cinemaCity: textOf(viewing.cinemaCity),
    screen: textOf(viewing.screen), seat: textOf(viewing.seat), price: textOf(viewing.price),
    source: textOf(viewing.source), service: textOf(viewing.service), device: textOf(viewing.device)
  };
}

// Switching place clears the fields that only belong to the other place.
function setWhere(draft, where) {
  var next = Object.assign({}, draft, { where: where });
  if (where === 'home') {
    next.cinemaName = '';
    next.cinemaCity = '';
    next.screen = '';
    next.seat = '';
    next.price = '';
  } else {
    next.source = '';
    next.service = '';
    next.device = '';
  }
  return next;
}

// Source, device and format are chosen from chips: choosing the chosen one
// again clears it. Leaving "streaming" clears the service name.
function toggleChoice(draft, key, value) {
  if (SHEET_CHOICE_KEYS.indexOf(key) === -1) return draft;
  var next = Object.assign({}, draft);
  next[key] = draft[key] === value ? '' : value;
  if (key === 'source' && next.source !== 'streaming') next.service = '';
  return next;
}

function setField(draft, key, value) {
  if (SHEET_TEXT_KEYS.indexOf(key) === -1) return draft;
  var next = Object.assign({}, draft);
  next[key] = String(value);
  return next;
}

function toggleRating(current, rate) {
  return current === rate ? null : rate;
}

// ---------- from the draft to a viewing ----------

function blankToNull(text) {
  var trimmed = String(text).trim();
  return trimmed === '' ? null : trimmed;
}

// '' is no price; '9,50' and '9.50' are 9.5. Returns { value, error }.
function priceFromText(text) {
  var trimmed = String(text).trim();
  if (trimmed === '') return { value: null, error: null };
  var number = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) {
    return { value: null, error: 'Price must be a number, like 14 or 9.50.' };
  }
  return { value: number, error: null };
}

// Returns { input, error }. input has every viewing field (the other place's
// fields are null), ready for addViewing or updateViewing. today is
// YYYY-MM-DD on the user's own clock.
function inputFromDraft(draft, today) {
  if (!draft.watchedOn) return { input: null, error: 'Pick the date you watched it.' };
  if (draft.watchedOn > today) return { input: null, error: 'The date cannot be in the future.' };
  var cinema = draft.where === 'cinema';
  var price = cinema ? priceFromText(draft.price) : { value: null, error: null };
  if (price.error) return { input: null, error: price.error };
  var source = cinema ? null : blankToNull(draft.source);
  return {
    input: {
      titleKey: draft.titleKey, watchedOn: draft.watchedOn, where: cinema ? 'cinema' : 'home',
      rating: draft.rating, note: draft.note.trim(),
      format: blankToNull(draft.format), withWhom: blankToNull(draft.withWhom),
      cinemaName: cinema ? blankToNull(draft.cinemaName) : null,
      cinemaCity: cinema ? blankToNull(draft.cinemaCity) : null,
      screen: cinema ? blankToNull(draft.screen) : null,
      seat: cinema ? blankToNull(draft.seat) : null,
      price: price.value,
      source: source,
      service: source === 'streaming' ? blankToNull(draft.service) : null,
      device: cinema ? null : blankToNull(draft.device)
    },
    error: null
  };
}

// ---------- the sheet's HTML ----------

function textFieldHtml(draft, key, label, placeholder, wide, inputmode) {
  var mode = inputmode ? ' inputmode="' + inputmode + '"' : '';
  return '<div class="form-field' + (wide ? ' wide' : '') + '"><label class="field-label" for="vw-' + key + '">' + sheetEscape(label) +
    '</label><input id="vw-' + key + '" type="text" data-field="' + key + '" value="' + sheetEscape(draft[key]) +
    '" placeholder="' + sheetEscape(placeholder) + '" maxlength="' + SHEET_TEXT_MAX + '" autocomplete="off"' + mode + '></div>';
}

function chipsHtml(draft, key, label, choices) {
  var html = '<div class="chips" role="group" aria-label="' + sheetEscape(label) + '">';
  for (var i = 0; i < choices.length; i++) {
    var on = draft[key] === choices[i][0];
    html += '<button type="button" class="chip' + (on ? ' selected' : '') + '" data-choice="' + key + '" data-value="' +
      sheetEscape(choices[i][0]) + '" aria-pressed="' + on + '">' + sheetEscape(choices[i][1]) + '</button>';
  }
  return html + '</div>';
}

function pairsOf(values) {
  var pairs = [];
  for (var i = 0; i < values.length; i++) pairs.push([values[i], values[i]]);
  return pairs;
}

function formatFieldHtml(draft) {
  var chips = FORMAT_CHIPS[draft.where === 'cinema' ? 'cinema' : 'home'];
  return textFieldHtml(draft, 'format', 'Format', draft.where === 'cinema' ? 'IMAX, 35mm\u2026' : '4K, Blu-ray\u2026', true) +
    '<div class="form-field wide">' + chipsHtml(draft, 'format', 'Format', pairsOf(chips)) + '</div>';
}

function cinemaFieldsHtml(draft, currency) {
  return textFieldHtml(draft, 'cinemaName', 'Cinema', 'Starlight Cinema', true) +
    textFieldHtml(draft, 'cinemaCity', 'City', 'Portland', true) +
    textFieldHtml(draft, 'screen', 'Screen', '3', false) +
    textFieldHtml(draft, 'seat', 'Seat', 'F12', false) +
    textFieldHtml(draft, 'price', 'Price (' + currency + ')', '14', false, 'decimal') +
    formatFieldHtml(draft) +
    textFieldHtml(draft, 'withWhom', 'With', 'Riya, Kabir', true);
}

function homeFieldsHtml(draft) {
  var html = '<div class="form-field wide"><p class="field-label">Source</p>' + chipsHtml(draft, 'source', 'Source', SOURCE_CHOICES) + '</div>';
  if (draft.source === 'streaming') html += textFieldHtml(draft, 'service', 'Service', 'Max', true);
  html += '<div class="form-field wide"><p class="field-label">Device</p>' + chipsHtml(draft, 'device', 'Device', DEVICE_CHOICES) + '</div>';
  return html + formatFieldHtml(draft) + textFieldHtml(draft, 'withWhom', 'With', 'Riya, Kabir', true);
}

function fieldsHtml(draft, currency) {
  return '<div class="form-grid" id="vw-fields">' + (draft.where === 'cinema' ? cinemaFieldsHtml(draft, currency) : homeFieldsHtml(draft)) + '</div>';
}

// 'full', 'half' or 'empty' for star number 1 to 5.
function starFill(rating, star) {
  if (rating !== null && rating >= star) return 'full';
  if (rating !== null && rating === star - 0.5) return 'half';
  return 'empty';
}

function rateButtonHtml(draft, rate, side) {
  var label = rate === 1 ? '1 star' : rate + ' stars';
  return '<button type="button" class="half ' + side + '" data-rate="' + rate + '" aria-label="' + label +
    '" aria-pressed="' + (draft.rating === rate) + '"></button>';
}

function ratingHtml(draft) {
  var html = '<div class="rating-row"><div class="stars-input" role="group" aria-label="Rating">';
  for (var star = 1; star <= 5; star++) {
    html += '<span class="star" data-fill="' + starFill(draft.rating, star) + '"><span class="star-base" aria-hidden="true">\u2605</span>' +
      '<span class="star-fill" aria-hidden="true">\u2605</span>' +
      rateButtonHtml(draft, star - 0.5, 'left') + rateButtonHtml(draft, star, 'right') + '</span>';
  }
  return html + '</div><span class="small muted" id="vw-rating-text">' + (draft.rating === null ? 'No rating' : draft.rating) + '</span></div>';
}

function whereHtml(draft) {
  var html = '<div class="segmented" role="group" aria-label="Where you watched">';
  var options = [['cinema', 'Cinema'], ['home', 'Home']];
  for (var i = 0; i < options.length; i++) {
    var on = draft.where === options[i][0];
    html += '<button type="button" class="' + (on ? 'selected' : '') + '" data-where="' + options[i][0] + '" aria-pressed="' + on + '">' + options[i][1] + '</button>';
  }
  return html + '</div>';
}

// mode: 'create' or 'edit'. context: { title, today, currency, icon, confirmDelete }.
function sheetHtml(draft, mode, context) {
  var edit = mode === 'edit';
  var remove = edit ? '<button type="button" class="ghost-button danger" id="vw-delete">' + (context.confirmDelete ? 'Tap again to delete' : 'Delete') + '</button>' : '';
  return '<div class="sheet-heading"><div><p class="eyebrow">' + (edit ? 'Edit viewing' : 'Log a viewing') + '</p><h2>' + sheetEscape(context.title) +
    '</h2></div><button type="button" class="close-button" data-close aria-label="Close">' + context.icon('x') + '</button></div>' +
    '<label class="field-label" for="vw-date">Date watched</label>' +
    '<input id="vw-date" type="date" data-field="watchedOn" value="' + sheetEscape(draft.watchedOn) + '" max="' + sheetEscape(context.today) + '">' +
    '<p class="field-label">Where</p>' + whereHtml(draft) + fieldsHtml(draft, context.currency) +
    '<p class="field-label">Rating</p>' + ratingHtml(draft) +
    '<label class="field-label" for="vw-note">One-line note <span class="small muted" id="vw-count">' + draft.note.length + '/' + SHEET_NOTE_MAX + '</span></label>' +
    '<input id="vw-note" type="text" data-field="note" value="' + sheetEscape(draft.note) + '" maxlength="' + SHEET_NOTE_MAX + '" autocomplete="off" placeholder="Anything you want to remember">' +
    '<div class="button-row">' + remove + '<button type="button" class="primary-button grow" id="vw-save">Save viewing</button></div>';
}

// The small sheet that appears after a movie is marked watched.
function logPromptHtml(title) {
  return '<div class="sheet-heading"><div><p class="eyebrow">Marked as watched</p><h2>' + sheetEscape(title) + '</h2></div></div>' +
    '<p class="muted">Log how you watched it? You can always do this later from the film\u2019s page.</p>' +
    '<div class="button-row"><button type="button" class="ghost-button" data-close>Skip</button>' +
    '<button type="button" class="primary-button grow" id="prompt-log">Log details</button></div>';
}

// ---------- on the page ----------
// Everything below uses the page and the database, so Node does not test it;
// the browser checklist in the plan covers it. It relies on globals from the
// other scripts: byId, closeDialog, showToast, icon (app.js), getTitle,
// getViewing, getViewings, addViewing, updateViewing, deleteViewing (db.js),
// localDateString (viewings.js), loadCurrencySymbol (settings.js) and
// onViewingsChanged (app.js).

var sheetState = null;      // { draft, mode, title, confirmDelete } while the sheet is open
var deleteTimer = null;
var promptKey = null;       // the film the "Log details?" prompt is about

function sheetContext() {
  return {
    title: sheetState.title,
    today: localDateString(new Date()),
    currency: loadCurrencySymbol(),
    icon: icon,
    confirmDelete: sheetState.confirmDelete
  };
}

// Redraws the sheet from the draft and keeps the scroll position.
function renderViewingSheet() {
  var box = byId('viewing-content');
  var top = box.scrollTop;
  box.innerHTML = sheetHtml(sheetState.draft, sheetState.mode, sheetContext());
  box.scrollTop = top;
}

// options: { titleKey } to log a new viewing, or { viewingId } to edit one.
async function openViewingSheet(options) {
  var existing = options.viewingId ? await getViewing(options.viewingId) : null;
  if (options.viewingId && !existing) {
    showToast('That viewing no longer exists');
    return;
  }
  var titleKey = existing ? existing.titleKey : options.titleKey;
  var title = await getTitle(titleKey);
  if (!title) {
    showToast('That film is no longer in your library');
    return;
  }
  sheetState = {
    draft: existing ? draftFromViewing(existing) : newDraft(titleKey, localDateString(new Date())),
    mode: existing ? 'edit' : 'create',
    title: title.title,
    confirmDelete: false
  };
  renderViewingSheet();
  var dialog = byId('viewing-dialog');
  if (!dialog.open) dialog.showModal();
}

function onSheetInput(event) {
  var field = event.target.closest('[data-field]');
  if (!field || !sheetState) return;
  var key = field.getAttribute('data-field');
  sheetState.draft = setField(sheetState.draft, key, field.value);
  if (key === 'note') byId('vw-count').textContent = field.value.length + '/' + SHEET_NOTE_MAX;
}

function rateFrom(button) {
  return toggleRating(sheetState.draft.rating, Number(button.getAttribute('data-rate')));
}

function onSheetClick(event) {
  if (!sheetState) return;
  var target = event.target;
  var whereButton = target.closest('[data-where]');
  var choice = target.closest('[data-choice]');
  var rate = target.closest('[data-rate]');
  if (whereButton) {
    sheetState.draft = setWhere(sheetState.draft, whereButton.getAttribute('data-where'));
    renderViewingSheet();
  } else if (choice) {
    sheetState.draft = toggleChoice(sheetState.draft, choice.getAttribute('data-choice'), choice.getAttribute('data-value'));
    renderViewingSheet();
  } else if (rate) {
    sheetState.draft = Object.assign({}, sheetState.draft, { rating: rateFrom(rate) });
    renderViewingSheet();
  } else if (target.closest('#vw-save')) {
    saveViewingSheet();
  } else if (target.closest('#vw-delete')) {
    deleteViewingFromSheet();
  }
}

async function saveViewingSheet() {
  var draft = sheetState.draft;
  var out = inputFromDraft(draft, localDateString(new Date()));
  if (out.error) {
    showToast(out.error);
    return;
  }
  try {
    if (sheetState.mode === 'edit') await updateViewing(draft.id, out.input);
    else await addViewing(out.input);
  } catch (err) {
    showToast(err.message || 'Could not save the viewing');
    return;
  }
  closeDialog('viewing-dialog');
  showToast('Viewing saved');
  onViewingsChanged(draft.titleKey);
}

function resetDeleteConfirm() {
  if (!sheetState || !sheetState.confirmDelete) return;
  sheetState.confirmDelete = false;
  renderViewingSheet();
}

// The first tap asks again; the second tap deletes. The question lapses after 4 seconds.
async function deleteViewingFromSheet() {
  if (!sheetState.confirmDelete) {
    sheetState.confirmDelete = true;
    renderViewingSheet();
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(resetDeleteConfirm, 4000);
    return;
  }
  clearTimeout(deleteTimer);
  var draft = sheetState.draft;
  try {
    await deleteViewing(draft.id);
  } catch (err) {
    showToast(err.message || 'Could not delete the viewing');
    return;
  }
  closeDialog('viewing-dialog');
  showToast('Viewing deleted');
  onViewingsChanged(draft.titleKey);
}

function onViewingDialogClose() {
  clearTimeout(deleteTimer);
  sheetState = null;
}

// ---------- the "Log details?" prompt ----------

async function showLogPrompt(titleKey) {
  var title = await getTitle(titleKey);
  if (!title) return;
  promptKey = titleKey;
  byId('log-prompt-content').innerHTML = logPromptHtml(title.title);
  byId('log-prompt-dialog').showModal();
}

// "Log details" edits the bare viewing the status change just made (the newest one).
async function onPromptClick(event) {
  if (!event.target.closest('#prompt-log')) return;
  var key = promptKey;
  closeDialog('log-prompt-dialog');
  var list = await getViewings(key);
  openViewingSheet(list.length > 0 ? { viewingId: list[0].id } : { titleKey: key });
}

function initViewingSheet() {
  var content = byId('viewing-content');
  content.addEventListener('click', onSheetClick);
  content.addEventListener('input', onSheetInput);
  content.addEventListener('change', onSheetInput);
  byId('viewing-dialog').addEventListener('close', onViewingDialogClose);
  byId('log-prompt-content').addEventListener('click', onPromptClick);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    newDraft: newDraft,
    draftFromViewing: draftFromViewing,
    setWhere: setWhere,
    toggleChoice: toggleChoice,
    setField: setField,
    toggleRating: toggleRating,
    inputFromDraft: inputFromDraft,
    sheetHtml: sheetHtml,
    logPromptHtml: logPromptHtml
  };
}
