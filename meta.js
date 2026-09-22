// meta.js
// Turns a parsed filename into a proper metadata record — poster, description,
// genres, rating, episode names — by asking Cinemeta first and TMDB second.
//
// Everything here is best-effort by construction. Every provider call may
// return null, every failure is caught, and the caller gets either a record or
// null; nothing thrown from this module should ever reach a Stremio request
// handler. A library with no internet connection at all keeps working, it just
// shows the filenames it always did.
//
// Results are cached to disk, misses included, because the expensive part is
// the network round trip and the answers barely change. A library that has
// been scanned once makes no provider calls at all on the next scan.

const path = require('path');
const cinemeta = require('./cinemeta');
const tmdb = require('./tmdb');
const { createCache } = require('./cache');
const { normalize } = require('./parse');

const ENABLED = String(process.env.META_ENRICH || 'true') !== 'false';

const cache = createCache({
  file: process.env.META_CACHE_FILE || path.join(__dirname, 'cache', 'meta.json'),
  ttlDays: Number(process.env.META_TTL_DAYS || 30),
  missTtlDays: Number(process.env.META_MISS_TTL_DAYS || 3),
  label: 'metadata cache',
});

const stats = { hits: 0, cinemeta: 0, tmdb: 0, misses: 0 };

/** Cinemeta and TMDB agree on "movie"; Stremio's "series" is TMDB's "tv". */
const stremioType = kind => (kind === 'series' ? 'series' : 'movie');

/**
 * Do these two titles refer to the same thing? Exact match on the normalized
 * form, which already ignores case, punctuation, diacritics and leading
 * articles. Anything looser starts matching sequels to their originals.
 */
function sameTitle(a, b) {
  const x = normalize(a || '');
  const y = normalize(b || '');
  return Boolean(x) && x === y;
}

/** Years from a filename drift by one against the official release date. */
function yearFits(wanted, found) {
  if (!wanted || !found) return true;
  return Math.abs(wanted - found) <= 1;
}

// ---------------------------------------------------------------------------
// TMDB path
// ---------------------------------------------------------------------------

/**
 * Picks a TMDB search result worth trusting.
 *
 * TMDB ranks by popularity, so the top hit for a short or common title is
 * frequently the wrong film. A result is only accepted when its name — or its
 * original-language name, which is what a local filename usually carries —
 * matches what was asked for.
 */
function pickTmdb(results, title, year) {
  for (const r of results) {
    if (!sameTitle(r.name, title) && !sameTitle(r.originalName, title)) continue;
    if (!yearFits(year, r.year)) continue;
    return r;
  }
  return null;
}

/**
 * Titles to try against TMDB, in order of confidence.
 *
 * Dropping the year matters more than it looks: the year in a filename is
 * often the year of the release group's encode rather than of the film.
 * Cutting at a subtitle helps with files named "Movie Name - The Subtitle"
 * where the provider lists only the main title.
 */
function tmdbAttempts(title, year) {
  const attempts = [{ title, year }];
  if (year) attempts.push({ title, year: null });

  const short = title.split(/\s+[-–:]\s+/)[0].trim();
  if (short && short !== title) {
    attempts.push({ title: short, year });
    if (year) attempts.push({ title: short, year: null });
  }
  return attempts;
}

async function fromTmdb(kind, title, year) {
  if (!tmdb.isEnabled()) return null;

  for (const attempt of tmdbAttempts(title, year)) {
    const results = await tmdb.search(kind, attempt.title, attempt.year);
    const pick = pickTmdb(results || [], attempt.title, attempt.year);
    if (!pick) continue;

    const details = await tmdb.details(kind, pick.tmdbId);
    if (details) return details;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Record assembly
// ---------------------------------------------------------------------------

/** One shape for both providers, so the handlers never branch on the source. */
function normalizeRecord(raw) {
  if (!raw || !raw.name) return null;

  return {
    source: raw.source,
    imdbId: raw.imdbId || null,
    tmdbId: raw.tmdbId || null,
    name: raw.name,
    description: raw.description || null,
    poster: raw.poster || null,
    background: raw.background || null,
    logo: raw.logo || null,
    year: raw.year || null,
    releaseInfo: raw.releaseInfo || (raw.year ? String(raw.year) : null),
    genres: Array.isArray(raw.genres) ? raw.genres.filter(Boolean) : [],
    imdbRating: raw.imdbRating || null,
    // TMDB's own average is a different number from the IMDb rating, so it is
    // kept in its own field and labelled separately wherever it is shown.
    tmdbRating: raw.source === 'tmdb' ? raw.rating || null : null,
    runtime: raw.runtime || null,
    cast: Array.isArray(raw.cast) ? raw.cast.slice(0, 8) : [],
    director: Array.isArray(raw.director) ? raw.director : [],
    country: raw.country || null,
    /** Keyed "season:episode" — a plain object so the record is JSON. */
    episodes: {},
  };
}

function addEpisodes(record, list) {
  for (const e of list || []) {
    if (!e || !e.season || !e.episode) continue;
    record.episodes[e.season + ':' + e.episode] = {
      title: e.title || null,
      description: e.description || null,
      thumbnail: e.thumbnail || null,
      released: e.released || null,
    };
  }
}

/**
 * Fills in episode details for the seasons the local server actually holds.
 *
 * Cinemeta ships the whole episode list with the series record, so there is
 * nothing more to fetch there. TMDB charges one request per season, so only
 * the seasons present locally are asked for — a show with twelve seasons of
 * which two are on the server costs two requests, not twelve.
 */
async function fillSeasons(record, seasons) {
  if (record.source !== 'tmdb' || !record.tmdbId) return;

  for (const n of seasons) {
    const key = 'tmdbseason:' + record.tmdbId + ':' + n;
    const cached = cache.get(key);

    let episodes;
    if (cached) {
      episodes = cached.value;
    } else {
      episodes = await tmdb.season(record.tmdbId, n);
      cache.set(key, episodes);
    }
    addEpisodes(record, episodes);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** The provider chain itself, with every step allowed to fail on its own. */
async function lookup(type, title, year, imdbId) {
  // 1. An IMDb id resolved earlier — a straight fetch, no searching. This is
  //    the common case and costs a single request.
  if (imdbId) {
    try {
      const raw = await cinemeta.metaFull(type, imdbId);
      const rec = normalizeRecord(raw);
      if (rec) {
        addEpisodes(rec, raw.videos);
        return rec;
      }
    } catch (err) {
      console.warn(`Cinemeta lookup failed for ${imdbId}: ${err.message}`);
    }
  }

  // 2. Cinemeta search. Worth a try even after step 1, because the title this
  //    parser produces is not always the one the id was resolved from.
  try {
    const found = await cinemeta.findImdbId(type, title, year);
    if (found) {
      const raw = await cinemeta.metaFull(type, found);
      const rec = normalizeRecord(raw);
      if (rec) {
        addEpisodes(rec, raw.videos);
        return rec;
      }
    }
  } catch (err) {
    console.warn(`Cinemeta search failed for "${title}": ${err.message}`);
  }

  // 3. TMDB, with the fallbacks in tmdbAttempts(). Skipped entirely when no
  //    API key is configured.
  try {
    const rec = normalizeRecord(await fromTmdb(type, title, year));
    if (rec) return rec;
  } catch (err) {
    console.warn(`TMDB lookup failed for "${title}": ${err.message}`);
  }

  return null;
}

/**
 * Looks up one title. Returns a record, or null when nothing was found.
 *
 * @param {object}   entry
 * @param {string}   entry.kind      'movie' or 'series'
 * @param {string}   entry.title     title as the parser read it
 * @param {number?}  entry.year
 * @param {string?}  entry.imdbId    already resolved, if it was
 * @param {number[]} [entry.seasons] seasons held locally, for series
 */
async function enrich({ kind, title, year, imdbId, seasons = [] }) {
  if (!ENABLED || !title) return null;

  const type = stremioType(kind);
  const key = 'rec:' + type + ':' + normalize(title) + ':' + (year || '');

  let record;
  const cached = cache.get(key);

  if (cached) {
    record = cached.value;
    if (!record) { stats.misses++; return null; }
    stats.hits++;
  } else {
    record = await lookup(type, title, year, imdbId);
    cache.set(key, record);
    if (!record) { stats.misses++; return null; }
    stats[record.source]++;
  }

  if (type === 'series' && seasons.length) {
    // Season fetches are cached under keys of their own, so this costs nothing
    // on a record whose seasons were already filled in on an earlier scan.
    const have = Object.keys(record.episodes || {});
    const missing = seasons.filter(n => !have.some(k => k.startsWith(n + ':')));
    if (missing.length) {
      try {
        await fillSeasons(record, missing);
        cache.set(key, record);
      } catch (err) {
        console.warn(`Could not fetch season details for "${title}": ${err.message}`);
      }
    }
  }

  return record;
}

module.exports = {
  enrich,
  isEnabled: () => ENABLED,
  stats: () => ({ ...stats, cached: cache.size() }),
  flush: () => cache.save(),
};
