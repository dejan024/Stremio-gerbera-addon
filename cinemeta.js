// cinemeta.js
// Cinemeta is the public Stremio metadata addon — the same source Stremio uses
// to render movie and series detail pages. It is used here for two things:
//
//   1. IMDb id -> title and year. When Stremio asks "do you have a stream for
//      tt0086567?", the addon needs to know which title that is in order to
//      look it up among the local files.
//   2. title + year -> IMDb id. Local files are resolved to IMDb ids once, so
//      later lookups are an exact id match rather than title guessing.
//
// If the addon has no internet access all of this fails quietly: the local
// catalog keeps working, only the "local source in Stremio search" part is
// skipped.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { normalize } = require('./parse');

const BASE = process.env.CINEMETA_URL || 'https://v3-cinemeta.strem.io';
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, 'cache', 'imdb.json');

let enabled = String(process.env.CINEMETA_ENABLED || 'true') !== 'false';
let cache = {};

function loadCache() {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    console.log(`Loaded ${Object.keys(cache).length} cached lookups from ${CACHE_FILE}.`);
  } catch {
    cache = {};
  }
}

let saveTimer = null;
function saveCacheSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch (err) {
      console.warn('Could not write the lookup cache:', err.message);
    }
  }, 2000);
}

async function get(url) {
  if (!enabled) return null;
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return data;
  } catch (err) {
    console.warn(`Cinemeta unreachable (${err.message}) — IMDb matching skipped.`);
    return null;
  }
}

/** IMDb id -> { name, year } or null. */
async function metaById(type, imdbId) {
  const key = `meta:${type}:${imdbId}`;
  if (key in cache) return cache[key];

  const data = await get(`${BASE}/meta/${type}/${encodeURIComponent(imdbId)}.json`);
  const meta = data && data.meta;
  const result = meta
    ? { name: meta.name, year: parseInt(String(meta.releaseInfo || meta.year || ''), 10) || null }
    : null;

  cache[key] = result;
  saveCacheSoon();
  return result;
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
  if (key in cache) return cache[key];

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

  cache[key] = hit;
  saveCacheSoon();
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

loadCache();

module.exports = {
  metaById,
  findImdbId,
  mapLimited,
  isEnabled: () => enabled,
  disable: () => { enabled = false; },
};
