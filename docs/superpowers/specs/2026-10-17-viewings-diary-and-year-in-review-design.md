# Queued: viewings, diary and year-in-review

Date: 2026-10-17. Status: design approved in conversation, awaiting written-spec review.

## Goal

Make Queued the best place for a Letterboxd-style cinema fan to log how they watched a film and to look back on a year of watching. Two features, one data model:

1. A diary of viewings, with cinema nights shown as ticket stubs.
2. A year-in-review screen with a shareable image.

Queued stays standalone, local-only and vanilla JS with flat functions (no nested functions). No new network calls except the TMDB calls it already makes.

## Scope

In: viewings for movies; log sheet; Diary tab; viewings section in the detail sheet; stats screen; share card; backup format v2; settings currency symbol; director names.

Out for now: viewings and stats for TV shows, Letterboxd CSV import, streaming availability, currency conversion, festival as a "where" value, year-over-year comparison.

## 1. Data

### Viewings store

New IndexedDB store `viewings` (`keyPath: 'id'`), indexes `titleKey` and `watchedOn`. DB_VERSION goes 1 to 2. The upgrade only adds the store; it does not touch other stores.

A viewing record:

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | `v_` + timestamp + random, unique |
| `titleKey` | string | `movie:<id>` of an existing title |
| `watchedOn` | string | `YYYY-MM-DD`, valid, not after today |
| `where` | `'cinema'`, `'home'` or `null` | `null` means a bare viewing |
| `rating` | number or `null` | multiple of 0.5 from 0.5 to 5 |
| `note` | string | trimmed, at most 80 characters, `''` if none |
| `format` | string or `null` | free text, at most 60 characters, cinema or home |
| `withWhom` | string or `null` | at most 60 characters |
| `cinemaName`, `cinemaCity`, `screen`, `seat` | string or `null` | at most 60 characters, cinema only |
| `price` | number or `null` | 0 to 1,000,000, cinema only |
| `source` | `'streaming'`, `'disc'`, `'tv'`, `'pirated'`, `'other'` or `null` | home only |
| `service` | string or `null` | at most 60 characters, only when `source` is `'streaming'` |
| `device` | `'tv'`, `'laptop'`, `'phone'`, `'tablet'`, `'projector'` or `null` | home only |
| `createdAt`, `updatedAt` | ISO string | set by the data layer |

Cleaning rules: strings are trimmed and empty strings become `null`. Fields that do not belong to the chosen `where` are forced to `null`. A bare viewing (`where` null) keeps only `watchedOn`, `rating`, `note`. Invalid input throws a `DbError` with code `INVALID`, like the existing store functions.

### Creating viewings

- Any movie transition into status `watched` creates a bare viewing dated today, in the same transaction as the status change. The hook lives in `db.js` (`markWatched`, `setStatus`, `updateTitle` when it changes status, and `addTitle` with status `watched`), so every path from the UI is covered. A film that is already `watched` does not get a new viewing. Shows are excluded.
- The "Log details?" prompt then offers to fill in that viewing; Skip leaves it bare.
- "Log another viewing" (rewatch or backfill) creates an additional viewing for any movie, whatever its status.
- Editing or deleting a viewing never changes the film's status. Un-watching a film never deletes viewings. Removing a title deletes its viewings, with that stated in the existing confirmation.
- The existing `watch_log` store is unchanged and keeps recording. Stats read `viewings` only.

### Film rating

`titles.rating` stays. After every viewing add, edit or delete, it is recomputed as the rating of the film's rated viewing with the latest `watchedOn` (ties: latest `createdAt`), or `null` if none.

### Migration

On the first open at version 2, every movie with status `watched` and no viewings gets one bare viewing. Its `watchedOn` is the date of the film's latest `watch_log` entry, or the date of the title's `updatedAt` if there is none. The same rule runs after importing a backup: any watched movie that still has no viewing gets one.

### Backup format v2

`EXPORT_VERSION` becomes 2 and the file gains a `viewings` array. Version 1 files still import (no viewings). On import, viewings merge by union on `id`; a viewing whose `titleKey` is not in the merged titles is dropped. Imported viewings go through the same cleaning rules; invalid ones are skipped and counted in the result, like invalid titles today.

### Settings and director names

- Settings gains `currencySymbol` (localStorage `queued.currency`), default `$`, at most 3 characters. Prices are never converted.
- `titleFromMovie` also stores `snapshot.directors` as `[{ id, name }]`; `directorIds` stays. Films added before this change keep only `directorIds`: the app has no snapshot refresh today, so nothing backfills them, and the stats screen looks up names for the top five through the cached person call (section 3).

## 2. Screens

### Log sheet

Opens from the "Log details?" prompt (editing the bare viewing), from "Log another viewing", and from tapping a stub (edit). Fields: date (default today), Cinema or Home toggle, half-star rating (tap left half for a half, right half for a whole), one-line note with a counter.

- Cinema shows: cinema name, city, format, screen, seat, with whom, price.
- Home shows: source (reveals a service-name field when Streaming), device, format, with whom.
- Editing a bare viewing opens with Home selected. Switching the toggle clears the fields that no longer apply.
- Format offers suggestion chips (cinema: IMAX, 35mm, 70mm, Dolby Cinema, 3D, Standard; home: SD, HD, 4K, Blu-ray) and still accepts free text.
- Edit mode also has Delete, with a confirmation.

### Detail sheet

A Viewings section lists that film's stubs, newest first, each tappable to edit, plus a "Log another viewing" button. Hidden for shows.

### Diary tab

A new fifth bottom tab. Every viewing as a stub, grouped by month, newest first. Filter chips: All, Cinema, Home. A Stats button at the top opens the year-in-review. Empty state: an invitation to log a first viewing.

### Stubs

- Cinema stub: perforated tear line with notches, a Cinema tag, all filled fields shown.
- Home stub: plain edge and solid divider, no tag, only filled fields.
- Bare viewing: title, year and date only.
- Blank fields never render. Layout: poster thumbnail, serif title and year, field rows with small gold icons, italic note, and a side strip with month, day, stars. Palette is the existing Velvet tokens.

### Year-in-review screen

A year picker (current year by default, only years with viewings), then in order:

1. Films and hours, with a poster collage.
2. Cinema vs home split bar, then busiest month as twelve small bars.
3. Rating spread (half-star histogram) beside the highest-rated films.
4. Top five genres, decades and directors.
5. Cinema spend and most-visited cinema.

### Share card

A 1080 by 1350 PNG drawn on a canvas: title "My <year> in film", a poster wall of up to 10 distinct posters (most recent first), the numbers films, hours and average rating, and four highlights (top genre, busiest month, cinema and home counts, cinema spend). Shared with `navigator.share` using a file when supported, otherwise downloaded.

## 3. Stat definitions

A year is the calendar year of `watchedOn`.

- Films: number of viewings in the year. If the number of distinct titles differs, the screen also shows "N different films".
- Hours: sum of runtime over viewings whose title has a runtime, divided by 60, rounded to the nearest hour. Viewings without a runtime are excluded, not guessed.
- Average rating: mean of rated viewings, one decimal; hidden if none.
- Rating spread: count of rated viewings per half-star step. Highest rated: up to three titles by rating, then most recent date, one viewing per title.
- Busiest month: month with the most viewings; ties go to the later month; hidden if there are none.
- Cinema vs home: counts of viewings with `where` set. Bare viewings are shown as "not logged" and excluded from the split.
- Top genres, decades, directors: each viewing counts once per genre or director, and once for its release decade; top five by count, ties alphabetical. Director names come from `snapshot.directors`; if missing, the cached person lookup supplies names for the top five only; if that fails the label is "Unknown director".
- Cinema spend: sum of `price` over cinema viewings in the year, shown with the currency symbol; the line is hidden when no cinema viewing has a price. Most-visited cinema: grouped by trimmed, case-insensitive `cinemaName`, shown with the most recent city.

## 4. Code layout

New files, all flat functions, each with a test file where it holds logic:

- `viewings.js`: validate and clean a viewing, recompute film rating, stub field list. Pure.
- `stats.js`: all definitions in section 3. Pure.
- `share_card.js`: pure layout math plus the canvas drawing function.
- `viewing_sheet.js`, `diary.js`, `stats_screen.js`: UI.
- `db.js`: store plumbing only (version 2, create and update and delete, migration, backup v2, the hook on becoming watched). `app.js` gets only wiring.
- `sw.js`: add the new files to `SHELL_FILES` and bump `CACHE_VERSION`.

## 5. Errors and risks

- Any failed viewing write shows the existing error toast and leaves the film's status as it was (one transaction).
- Canvas export needs CORS-enabled poster images. The card loads posters with a CORS request. The service worker must not return a cached opaque (no-cors) poster for a CORS request, so the image handler bypasses its cache for requests in `cors` mode. If export still fails with a security error, the card draws title tiles instead of posters and says so. This must be checked in a real browser during the share card step.
- The year-in-review reads every viewing for the year into memory. That is fine at personal scale.

## 6. Testing

- Unit tests (`node --test`) for `viewings.js` cleaning and rating recompute, every definition in `stats.js` including empty years and ties, and share card layout math.
- `fake-indexeddb` tests for the version 1 to 2 upgrade and migration, the viewing created on becoming watched, rollback on failure, removing a title, backup v2 round trip, and importing a v1 file.
- `sw.test.js` updated for the new files.
- Manual checks in a browser: log sheet field switching, stub rendering in light and dark system modes, share card export on Android and iOS.

## 7. Build order

1. `viewings.js` and `stats.js` with tests.
2. `db.js` viewings store, migration, hooks and backup v2, with tests; currency setting; director names.
3. Log sheet, detail sheet section, "Log details?" prompt.
4. Diary tab and stubs.
5. Stats screen.
6. Share card.
7. Service worker file list and cache version.
