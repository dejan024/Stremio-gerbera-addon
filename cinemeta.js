// cinemeta.js
// Cinemeta is the public Stremio metadata addon — the same source Stremio uses
// to render movie and series detail pages. It is the primary provider here,
// for three reasons: it needs no API key, it has no rate limit worth worrying
// about, and using it means a local file is described with exactly the same
// text and artwork Stremio shows for that title everywhere else.
//
// It is used for three things:
//
//   1. IMDb id -> title and year. When Stremio asks "do you have a stream for
//      tt0086567?", the addon needs to know which title that is in order to
//      look it up among the local files.
//   2. title + year -> IMDb id. Local files are resolved to IMDb ids once, so
//      later lookups are an exact id match rather than title guessing.
//   3. IMDb id -> the full record: poster, background, logo, description,
//      genres, IMDb rating, and for series the episode list with names and
//      thumbnails. This is what turns a bare filename into a proper card.
//
// If the addon has no internet access all of this fails quietly: the local
// catalog keeps working, only the enrichment and the "local source in Stremio
// search" parts are skipped.

const path = require('path');
const axios = require('axios');
const { normalize } = require('./parse');
const { createCache } = require('./cache');

const BASE = process.env.CINEMETA_URL || 'https://v3-cinemeta.strem.io';
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, 'cache', 'imdb.json');

let enabled = String(process.env.CINEMETA_ENABLED || 'true') !== 'false';

// Id lookups are cheap to redo and the answers are stable, so they are kept
// far longer than the metadata records in meta.js.
const cache = createCache({
  file: CACHE_FILE,
  ttlDays: Number(process.env.IMDB_TTL_DAYS || 180),
  missTtlDays: Number(process.env.META_MISS_TTL_DAYS || 3),
  label: 'IMDb lookup cache',
});

async function get(url) {
  if (!enabled) return null;
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return data;
  } catch (err) {
    // A 404 is a legitimate answer — Cinemeta does not have that title — and
    // the caller stores it as a miss. Anything else is a transport problem.
    if (err.response && err.response.status === 404) return null;
    console.warn(`Cinemeta request failed (${err.message}).`);
    return null;
  }
}

/** Raw Cinemeta meta object for an IMDb id, or null. */
async function rawMeta(type, imdbId) {
  const data = await get(`${BASE}/meta/${type}/${encodeURIComponent(imdbId)}.json`);
  return (data && data.meta) || null;
}

/** IMDb id -> { name, year } or null. */
async function metaById(type, imdbId) {
  const key = `meta:${type}:${imdbId}`;
  const hit = cache.get(key);
  if (hit) return hit.value;

  const meta = await rawMeta(type, imdbId);
  const result = meta
    ? { name: meta.name, year: parseInt(String(meta.releaseInfo || meta.year || ''), 10) || null }
    : null;

  cache.set(key, result);
  return result;
}

/**
 * IMDb id -> the full record, normalized into the shape meta.js works with.
 * This is not cached here: meta.js keeps one cache for the finished record,
 * whichever provider it came from.
 */
async function metaFull(type, imdbId) {
  const m = await rawMeta(type, imdbId);
  if (!m) return null;

  // Cinemeta spells the release year differently per title: "2019",
  // "2019-2023" for a finished show, "2019-" for a running one.
  const year = parseInt(String(m.releaseInfo || m.year || ''), 10) || null;

  return {
    source: 'cinemeta',
    imdbId,
    name: m.name || null,
    description: m.description || null,
    poster: m.poster || null,
    background: m.background || null,
    logo: m.logo || null,
    year,
    releaseInfo: m.releaseInfo || (year ? String(year) : null),
    genres: m.genres || m.genre || [],
    imdbRating: m.imdbRating || null,
    runtime: m.runtime || null,
    cast: m.cast || [],
    director: m.director || [],
    country: m.country || null,
    // Series only. Cinemeta gives every episode it knows about; the library
    // decides which of them are actually on the server.
    videos: Array.isArray(m.videos)
      ? m.videos.map(v => ({
          season: v.season,
          episode: v.episode || v.number,
          title: v.title || v.name || null,
          description: v.overview || v.description || null,
          thumbnail: v.thumbnail || null,
          released: v.released || v.firstAired || null,
        }))
      : [],
  };
}

/**
 * title (+ year) -> IMDb id, or null.
 *
 * Cinemeta search returns a ranked list. Only a hit whose normalized title
 * matches exactly is accepted, and the year may differ by at most one — the
 * release year in a filename does not always match the official one.
 */
async function findImdbId(type, title, year) {
  const key = `find:${type}:${normalize(title)}:${year || ''}`;
  const cached = cache.get(key);
  if (cached) return cached.value;

  const data = await get(`${BASE}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
  const metas = (data && data.metas) || [];
  const wanted = normalize(title);

  let hit = null;
  for (const m of metas) {
    if (normalize(m.name) !== wanted) continue;
    const my = parseInt(String(m.releaseInfo || m.year || ''), 10);
    if (year && my && Math.abs(my - year) > 1) continue;
    hit = m.id;
    break;
  }

  cache.set(key, hit);
  return hit;
}

/** Runs `fn` over `items` with a bounded number of concurrent requests. */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  metaById,
  metaFull,
  findImdbId,
  mapLimited,
  isEnabled: () => enabled,
  disable: () => { enabled = false; },
};
