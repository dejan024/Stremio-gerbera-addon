// library.js
// Keeps the current state of the Gerbera library in memory and refreshes it
// periodically.
//
// From the raw list of video files it builds three things:
//   - movies and other clips, as flat catalog entries
//   - series, with their episodes grouped by show name
//   - an index by IMDb id, so the stream handler can answer when Stremio asks
//     about a title found through its regular search

const { getAllVideos } = require('./gerbera');
const { parseTitle, normalize } = require('./parse');
const cinemeta = require('./cinemeta');

const GERBERA_URL = process.env.GERBERA_URL || 'http://127.0.0.1:49494';
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 30);
const MATCH_IMDB = String(process.env.MATCH_IMDB || 'true') !== 'false';
// A scan still running after this long is treated as hung — the one failure a
// container restart can actually clear. See health() below.
const SCAN_TIMEOUT_MINUTES = Number(process.env.SCAN_TIMEOUT_MINUTES || 10);

const state = {
  ready: false,
  scannedAt: 0,
  scanStartedAt: 0,    // 0 when no scan is in flight
  error: null,
  movies: [],          // { id, kind, title, year, video }
  others: [],
  series: [],          // { id, title, slug, episodes: [{ season, episode, title, video }] }
  byId: new Map(),     // 'gerbera:...' -> entry used by the meta/stream handlers
  byImdb: new Map(),   // 'tt0086567' or 'tt9077540:2:1' -> [ video, ... ]
};

function slugify(title) {
  return normalize(title).replace(/\s+/g, '-') || 'unknown';
}

/** Human readable description of a file, shown in the Stremio source list. */
function describe(video) {
  const bits = [];
  if (video.resolution) bits.push(video.resolution);
  if (video.size) bits.push(`${(video.size / 1024 / 1024 / 1024).toFixed(2)} GB`);
  if (video.mime) bits.push(video.mime.replace('video/', '').replace('x-', ''));
  if (video.duration) bits.push(String(video.duration).split('.')[0]);
  return bits.join(' · ');
}

function buildEntries(videos) {
  const movies = [];
  const others = [];
  const seriesMap = new Map();

  for (const video of videos) {
    const parsed = parseTitle(video.rawTitle);

    if (parsed.kind === 'series') {
      const slug = slugify(parsed.title);
      let s = seriesMap.get(slug);
      if (!s) {
        s = { id: `gerbera:series:${slug}`, slug, title: parsed.title, episodes: [] };
        seriesMap.set(slug, s);
      }
      s.episodes.push({
        season: parsed.season,
        episode: parsed.episode,
        title: parsed.title,
        video,
      });
      continue;
    }

    const entry = {
      id: `gerbera:file:${video.objectId}`,
      kind: parsed.kind,
      title: parsed.title,
      year: parsed.year || null,
      video,
    };
    (parsed.kind === 'movie' ? movies : others).push(entry);
  }

  for (const s of seriesMap.values()) {
    s.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  }

  const byTitle = (a, b) => a.title.localeCompare(b.title);
  movies.sort(byTitle);
  others.sort(byTitle);
  const series = [...seriesMap.values()].sort(byTitle);

  return { movies, others, series };
}

function buildIndex({ movies, others, series }) {
  const byId = new Map();
  for (const e of [...movies, ...others]) byId.set(e.id, e);
  for (const s of series) {
    byId.set(s.id, s);
    for (const ep of s.episodes) {
      byId.set(`${s.id}:${ep.season}:${ep.episode}`, { ...ep, seriesTitle: s.title });
    }
  }
  return byId;
}

/**
 * Resolves local titles to IMDb ids through Cinemeta search.
 * Runs in the background — the catalog is usable before this finishes.
 */
async function resolveImdb({ movies, series }) {
  if (!MATCH_IMDB || !cinemeta.isEnabled()) return new Map();

  const byImdb = new Map();
  const push = (key, video) => {
    if (!byImdb.has(key)) byImdb.set(key, []);
    byImdb.get(key).push(video);
  };

  await cinemeta.mapLimited(movies, 4, async entry => {
    const id = await cinemeta.findImdbId('movie', entry.title, entry.year);
    if (id) {
      entry.imdbId = id;
      push(id, entry.video);
    }
  });

  await cinemeta.mapLimited(series, 4, async s => {
    const id = await cinemeta.findImdbId('series', s.title, null);
    if (!id) return;
    s.imdbId = id;
    for (const ep of s.episodes) {
      push(`${id}:${ep.season}:${ep.episode}`, ep.video);
    }
  });

  return byImdb;
}

async function scan() {
  console.log('Scanning Gerbera server:', GERBERA_URL);
  const t0 = Date.now();

  const videos = await getAllVideos(GERBERA_URL);
  const entries = buildEntries(videos);

  state.movies = entries.movies;
  state.others = entries.others;
  state.series = entries.series;
  state.byId = buildIndex(entries);
  state.scannedAt = Date.now();
  state.error = null;
  state.ready = true;

  console.log(
    `Done in ${Date.now() - t0}ms: ${videos.length} files -> ` +
    `${entries.movies.length} movies, ${entries.series.length} series ` +
    `(${entries.series.reduce((n, s) => n + s.episodes.length, 0)} episodes), ` +
    `${entries.others.length} other clips.`
  );

  // IMDb matching runs afterwards so the catalog never waits on the internet.
  resolveImdb(entries)
    .then(byImdb => {
      state.byImdb = byImdb;
      if (byImdb.size) console.log(`Matched ${byImdb.size} titles to an IMDb id.`);
    })
    .catch(err => console.warn('IMDb matching failed:', err.message));
}

let scanning = null;

/** Rescans when the cache is stale or empty; never runs two scans at once. */
async function ensureFresh() {
  const ageMin = (Date.now() - state.scannedAt) / 60000;
  if (state.ready && ageMin < REFRESH_MINUTES) return;
  if (scanning) return scanning;

  state.scanStartedAt = Date.now();

  // A failed scan never rejects: a refresh keeps serving the previous results,
  // and a failed first scan leaves the library empty with `state.error` set, so
  // the handlers can report the reason instead of returning a bare HTTP 500.
  scanning = scan()
    .catch(err => {
      state.error = err.message;
      console.error('Gerbera scan failed:', err.stack || err.message);
    })
    .finally(() => { scanning = null; state.scanStartedAt = 0; });

  return scanning;
}

/**
 * Snapshot of the addon's own state, behind `GET /health` and the container
 * healthcheck that polls it.
 *
 * `healthy: false` is reported only for a fault a restart can actually clear:
 * a scan that started and never finished, which leaves every request waiting
 * on `ensureFresh()` forever. An unreachable Gerbera server is *not* that —
 * it is reported as `degraded` while staying healthy, because restarting the
 * addon will not bring the media server back, and a container that restarts
 * every minute for as long as the server is off is worse than one that keeps
 * serving its last known library.
 */
function health() {
  const now = Date.now();
  const scanningFor = state.scanStartedAt ? now - state.scanStartedAt : 0;
  const hung = scanningFor > SCAN_TIMEOUT_MINUTES * 60000;

  let status;
  if (hung) status = 'hung';
  else if (state.error) status = 'degraded';       // last scan failed
  else if (state.ready) status = 'ok';
  else status = 'starting';                        // first scan not done yet

  return {
    status,
    healthy: !hung,
    gerbera: GERBERA_URL,
    error: state.error,
    lastScan: state.scannedAt ? new Date(state.scannedAt).toISOString() : null,
    lastScanAgeSeconds: state.scannedAt ? Math.round((now - state.scannedAt) / 1000) : null,
    scanningForSeconds: state.scanStartedAt ? Math.round(scanningFor / 1000) : null,
    uptimeSeconds: Math.round(process.uptime()),
    library: {
      movies: state.movies.length,
      series: state.series.length,
      episodes: state.series.reduce((n, s) => n + s.episodes.length, 0),
      others: state.others.length,
      imdbMatches: state.byImdb.size,
    },
  };
}

module.exports = {
  state,
  ensureFresh,
  health,
  describe,
  GERBERA_URL,
  REFRESH_MINUTES,
};
