'use strict';

// sw.js: makes Queued installable and usable offline.
//
// - The app files are cached on install, so the app opens with no connection.
// - Same-origin files are fetched from the network first and the cache is
//   refreshed each time, so a new deploy shows up on the next load and the
//   files never come from two different versions.
// - TMDB posters are cached as they are seen (capped), so the shelf keeps its
//   covers offline.
// - The TMDB API is never intercepted or cached: it carries the user's key.
//
// Change CACHE_VERSION when you add, remove or rename an app file.

var CACHE_VERSION = 'queued-v4';
var APP_CACHE = CACHE_VERSION + '-app';
var IMAGE_CACHE = 'queued-images';
var MAX_IMAGES = 300;
var IMAGE_HOST = 'image.tmdb.org';

var SHELL_FILES = [
  './',
  'index.html',
  'styles.css',
  'settings.js',
  'html.js',
  'viewings.js',
  'db.js',
  'progress.js',
  'tmdb.js',
  'app.js',
  'manifest.webmanifest',
  'favicon.ico',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

// 'app' | 'image' | 'skip'. Pure, so it can be tested without a browser.
function strategyFor(method, urlString, ownOrigin) {
  if (method !== 'GET') return 'skip';
  var url = new URL(urlString);
  if (url.origin === ownOrigin) return 'app';
  if (url.hostname === IMAGE_HOST) return 'image';
  return 'skip';
}

function isStorable(response) {
  return !!response && (response.ok || response.type === 'opaque');
}

// ---------- install / activate ----------

function precache() {
  return caches.open(APP_CACHE).then(function (cache) { return cache.addAll(SHELL_FILES); });
}

function onInstall(event) {
  event.waitUntil(precache().then(function () { return self.skipWaiting(); }));
}

function isOldCache(name) {
  return name !== APP_CACHE && name !== IMAGE_CACHE;
}

function deleteCache(name) { return caches.delete(name); }

function dropOldCaches() {
  return caches.keys().then(function (names) {
    return Promise.all(names.filter(isOldCache).map(deleteCache));
  });
}

function onActivate(event) {
  event.waitUntil(dropOldCaches().then(function () { return self.clients.claim(); }));
}

// ---------- fetch ----------

function storeCopy(request, response) {
  return caches.open(APP_CACHE).then(function (cache) { return cache.put(request, response); });
}

function fromCache(request) {
  return caches.match(request, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    if (request.mode === 'navigate') return caches.match('index.html');
    return Response.error();
  });
}

function networkFirst(event) {
  var request = event.request;
  function keep(response) {
    if (isStorable(response)) event.waitUntil(storeCopy(request, response.clone()));
    return response;
  }
  function offline() { return fromCache(request); }
  return fetch(request).then(keep, offline);
}

function trimImages(cache) {
  return cache.keys().then(function (keys) {
    var extra = keys.length - MAX_IMAGES;
    if (extra <= 0) return null;
    return Promise.all(keys.slice(0, extra).map(function (key) { return cache.delete(key); }));
  });
}

function storeImage(request, response) {
  return caches.open(IMAGE_CACHE).then(function (cache) {
    return cache.put(request, response).then(function () { return trimImages(cache); });
  });
}

function cacheFirstImage(event) {
  var request = event.request;
  function fetchAndKeep() {
    return fetch(request).then(function (response) {
      if (isStorable(response)) event.waitUntil(storeImage(request, response.clone()));
      return response;
    });
  }
  return caches.match(request).then(function (hit) { return hit || fetchAndKeep(); });
}

function onFetch(event) {
  var kind = strategyFor(event.request.method, event.request.url, self.location.origin);
  if (kind === 'app') event.respondWith(networkFirst(event));
  else if (kind === 'image') event.respondWith(cacheFirstImage(event));
}

if (typeof self !== 'undefined' && self.addEventListener) {
  self.addEventListener('install', onInstall);
  self.addEventListener('activate', onActivate);
  self.addEventListener('fetch', onFetch);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SHELL_FILES: SHELL_FILES, strategyFor: strategyFor, CACHE_VERSION: CACHE_VERSION };
}
