// tmdb.js
// The Movie Database, used as the second opinion behind Cinemeta.
//
// Cinemeta covers anything with an IMDb id well, which is most of a typical
// library. TMDB is brought in for what it does not: regional and older titles,
// films released under a local name, and anything the filename spells
// differently from the official English title. It also carries descriptions in
// other languages, which Cinemeta does not.
//
// The whole module is optional. With no TMDB_API_KEY set, `isEnabled()`
// returns false, no request is ever made, and the addon runs on Cinemeta
// alone — so an install with no key behaves exactly as it did before.

const axios = require('axios');

const BASE = process.env.TMDB_URL || 'https://api.themoviedb.org/3';
const IMAGE_BASE = process.env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p';
const API_KEY = (process.env.TMDB_API_KEY || '').trim();
// Cinemeta has no language parameter, so this only affects TMDB results. See
// the note in the README about what that means for a non-English setting.
const LANG = process.env.META_LANG || 'en';

const POSTER_SIZE = 'w500';
const BACKDROP_SIZE = 'w1280';
const STILL_SIZE = 'w300';

let enabled = Boolean(API_KEY);
if (!enabled) {
  console.log('TMDB_API_KEY is not set — metadata comes from Cinemeta only.');
}

/** Turns a TMDB image path into a full URL, or null. */
function image(path, size) {
  return path ? `${IMAGE_BASE}/${size}${path}` : null;
}

async function get(endpoint, params = {}) {
  if (!enabled) return null;
  try {
    const { data } = await axios.get(`${BASE}${endpoint}`, {
      timeout: 10000,
      params: { api_key: API_KEY, language: LANG, ...params },
    });
    return data;
  } catch (err) {
    const status = err.response && err.response.status;
    // A bad key fails every request identically, so there is no point in
    // making thousands of them: the provider switches itself off for the rest
    // of the process and the addon carries on with Cinemeta.
    if (status === 401) {
      enabled = false;
      console.warn('TMDB rejected the API key (401) — TMDB lookups are now disabled.');
    } else {
      console.warn(`TMDB request failed (${endpoint}): ${err.message}`);
    }
    return null;
  }
}

/**
 * Finds a title. `year` narrows the search when it is known; passing it as a
 * hint rather than a filter is deliberate — see the fallback chain in meta.js.
 */
async function search(kind, title, year) {
  const endpoint = kind === 'series' ? '/search/tv' : '/search/movie';
  const params = { query: title, include_adult: false };
  if (year) params[kind === 'series' ? 'first_air_date_year' : 'year'] = year;

  const data = await get(endpoint, params);
  const results = (data && data.results) || [];
  return results.slice(0, 5).map(r => ({
    tmdbId: r.id,
    name: r.title || r.name || '',
    // TMDB also carries the original-language title, which is often what a
    // local filename actually says — "Ko to tamo peva" rather than
    // "Who's Singin' Over There?".
    originalName: r.original_title || r.original_name || '',
    year: parseInt(String(r.release_date || r.first_air_date || '').slice(0, 4), 10) || null,
  }));
}

/** Full record for one TMDB id, in the shape meta.js works with. */
async function details(kind, tmdbId) {
  const endpoint = kind === 'series' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
  const data = await get(endpoint, { append_to_response: 'external_ids' });
  if (!data) return null;

  const ext = data.external_ids || {};
  const minutes = data.runtime || (data.episode_run_time || [])[0] || null;

  return {
    source: 'tmdb',
    tmdbId,
    // TMDB knows the IMDb id for most entries; carrying it back means a title
    // matched here also becomes reachable through regular Stremio search.
    imdbId: ext.imdb_id || null,
    name: data.title || data.name || null,
    description: data.overview || null,
    poster: image(data.poster_path, POSTER_SIZE),
    background: image(data.backdrop_path, BACKDROP_SIZE),
    year: parseInt(String(data.release_date || data.first_air_date || '').slice(0, 4), 10) || null,
    genres: (data.genres || []).map(g => g.name).filter(Boolean),
    // TMDB's own 0-10 average, which is not the IMDb rating. It is labelled as
    // such where it is displayed.
    rating: data.vote_average ? Number(data.vote_average).toFixed(1) : null,
    // TMDB reports minutes as a number; Cinemeta reports a ready-made string
    // like "1h 59min". Both end up in the same field, so it is formatted here.
    runtime: minutes ? `${minutes} min` : null,
  };
}

/** Episode list for one season, used to title and illustrate series entries. */
async function season(tmdbId, seasonNumber) {
  const data = await get(`/tv/${tmdbId}/season/${seasonNumber}`);
  if (!data || !Array.isArray(data.episodes)) return null;

  return data.episodes.map(e => ({
    season: e.season_number,
    episode: e.episode_number,
    title: e.name || null,
    description: e.overview || null,
    thumbnail: image(e.still_path, STILL_SIZE),
    released: e.air_date ? `${e.air_date}T00:00:00.000Z` : null,
  }));
}

module.exports = {
  search,
  details,
  season,
  isEnabled: () => enabled,
};
