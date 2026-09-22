// index.js
// A Stremio addon backed by a local Gerbera DLNA/UPnP server.
//
// It does two things:
//   1. Catalog — movies, series and other clips from the Gerbera server, so the
//      local library can be browsed straight from Stremio.
//   2. Local source — when any movie or episode is opened in Stremio (through
//      its regular search), the addon checks whether that title exists on the
//      Gerbera server and, if so, offers it as a playable source.
//
// Catalog entries carry an IMDb id whenever the title was recognised, so
// opening one lands on the same detail page Stremio shows for that film
// everywhere else — artwork, cast, trailer, and every other addon's streams
// listed next to the local file. A file that could not be recognised keeps an
// id of this addon's own and is described from whatever the metadata pass
// managed to find, falling back to the filename.

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { state, ensureFresh, health, describe, GERBERA_URL } = require('./library');
const cinemeta = require('./cinemeta');
const { normalize } = require('./parse');

const ADDON_PORT = Number(process.env.PORT || 7100);

const manifest = {
  id: 'org.gerbera.dlna.addon',
  version: '2.1.0',
  name: 'Gerbera Local DLNA',
  description: 'Movies, series and clips from a local Gerbera DLNA/UPnP server — ' +
    'as a catalog, and as a playable source inside Stremio search.',
  logo: `${GERBERA_URL}/icons/mt-icon120.png`,
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'gerbera-movies',
      name: 'Gerbera — Movies',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    },
    {
      type: 'series',
      id: 'gerbera-series',
      name: 'Gerbera — Series',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'gerbera-other',
      name: 'Gerbera — Other videos',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    },
  ],
  resources: [
    'catalog',
    // Meta is served only for this addon's own entries — for IMDb ids Stremio
    // should keep using Cinemeta; this addon only adds a source there.
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['gerbera:'] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['gerbera:', 'tt'] },
  ],
  behaviorHints: { configurable: false, adult: false },
};

const builder = new addonBuilder(manifest);
const PAGE_SIZE = 100;

function matches(title, search) {
  if (!search) return true;
  return normalize(title).includes(normalize(search));
}

const pad2 = n => String(n).padStart(2, '0');

/**
 * The id a catalog entry is published under.
 *
 * A recognised title is published as its IMDb id, which is what makes Stremio
 * open the standard detail page for it instead of a page this addon would
 * have to draw itself. Everything else keeps its `gerbera:` id, and the meta
 * handler below answers for those.
 */
const publicId = entry => entry.imdbId || entry.id;

/**
 * Keeps the technical detail of the local file visible underneath the
 * synopsis. It is the one thing no metadata provider can tell you and the
 * main reason to care that the file is on your own server.
 *
 * A TMDB score goes here too rather than into `imdbRating`: it is a different
 * number from a different audience, and Stremio would label it as IMDb's.
 */
function composeDescription(record, tech) {
  const parts = [];
  if (record && record.description) parts.push(record.description);
  if (record && !record.imdbRating && record.tmdbRating) {
    parts.push(`TMDB ${record.tmdbRating}/10`);
  }
  if (tech) parts.push(`On the local server: ${tech}`);
  return parts.length ? parts.join('\n\n') : undefined;
}

function movieMeta(entry) {
  const m = entry.meta;
  // A provider poster is artwork in portrait; a Gerbera thumbnail is a frame
  // grabbed from the video, which only looks right in landscape.
  const poster = (m && m.poster) || entry.video.thumb || undefined;

  return {
    id: publicId(entry),
    type: 'movie',
    name: (m && m.name) || (entry.year ? `${entry.title} (${entry.year})` : entry.title),
    poster,
    posterShape: m && m.poster ? 'poster' : 'landscape',
    background: (m && m.background) || entry.video.thumb || undefined,
    logo: (m && m.logo) || undefined,
    description: composeDescription(m, describe(entry.video)),
    releaseInfo: (m && m.releaseInfo) || (entry.year ? String(entry.year) : undefined),
    genres: m && m.genres.length ? m.genres : undefined,
    imdbRating: (m && m.imdbRating) || undefined,
    runtime: (m && m.runtime) || undefined,
    cast: m && m.cast.length ? m.cast : undefined,
    director: m && m.director.length ? m.director : undefined,
    country: (m && m.country) || undefined,
  };
}

function seriesMeta(s) {
  const m = s.meta;
  const withThumb = s.episodes.find(e => e.video.thumb);
  const local = `${s.episodes.length} episodes on the local server`;

  return {
    id: publicId(s),
    type: 'series',
    name: (m && m.name) || s.title,
    poster: (m && m.poster) || (withThumb && withThumb.video.thumb) || undefined,
    posterShape: m && m.poster ? 'poster' : 'landscape',
    background: (m && m.background) || undefined,
    logo: (m && m.logo) || undefined,
    description: composeDescription(m, local),
    releaseInfo: (m && m.releaseInfo) || undefined,
    genres: m && m.genres.length ? m.genres : undefined,
    imdbRating: (m && m.imdbRating) || undefined,
    cast: m && m.cast.length ? m.cast : undefined,
    country: (m && m.country) || undefined,
  };
}

/**
 * One episode of a series this addon draws the page for itself.
 *
 * The episode's name comes from the provider when it has one, and otherwise
 * from the filename — plenty of shows on a home server are in no provider's
 * database, and their files are usually named "...S01E04.Dolazak.Kuci...".
 */
function episodeVideo(show, ep) {
  const info = show.meta && show.meta.episodes[`${ep.season}:${ep.episode}`];
  const code = `S${pad2(ep.season)}E${pad2(ep.episode)}`;
  const name = (info && info.title) || ep.episodeTitle;

  return {
    id: `${show.id}:${ep.season}:${ep.episode}`,
    title: name ? `${code} · ${name}` : code,
    season: ep.season,
    episode: ep.episode,
    overview: (info && info.description) || undefined,
    thumbnail: (info && info.thumbnail) || ep.video.thumb || undefined,
    released: (info && info.released) || undefined,
  };
}

/**
 * Two copies of the same film on the server resolve to the same IMDb id and
 * would otherwise appear as two identical cards. Both copies stay available:
 * the stream handler indexes files, not cards, and lists every one it has.
 */
function dedupe(metas) {
  const seen = new Set();
  return metas.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/**
 * Surfaces a failed scan as a single catalog tile.
 * Stremio renders a thrown handler error as an opaque "HTTP status code 500",
 * which says nothing about the cause, so the reason is shown in the UI instead.
 */
function errorMeta(type) {
  return {
    id: 'gerbera:error',
    type,
    name: `Gerbera unavailable — ${state.error}`,
    description: `Could not read the library from ${GERBERA_URL}. ` +
      'Check the addon logs and that the server is reachable.',
    posterShape: 'landscape',
  };
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  await ensureFresh();

  if (!state.ready && state.error) return { metas: [errorMeta(type)] };

  const search = (extra && extra.search) || null;
  const skip = Number((extra && extra.skip) || 0);

  let metas;
  if (id === 'gerbera-movies') {
    metas = state.movies.filter(e => matches(e.title, search)).map(movieMeta);
  } else if (id === 'gerbera-other') {
    metas = state.others.filter(e => matches(e.title, search)).map(movieMeta);
  } else if (id === 'gerbera-series') {
    metas = state.series.filter(s => matches(s.title, search)).map(seriesMeta);
  } else {
    return { metas: [] };
  }

  return { metas: dedupe(metas).slice(skip, skip + PAGE_SIZE) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  await ensureFresh();

  const entry = state.byId.get(id);
  if (!entry) return { meta: null };

  if (type === 'series' && entry.episodes) {
    const meta = seriesMeta(entry);
    // Only the episodes actually on the server are listed. Stremio would
    // happily render every episode the provider knows about, but each of the
    // missing ones would open onto an empty source list.
    meta.videos = entry.episodes.map(ep => episodeVideo(entry, ep));
    return { meta };
  }

  if (entry.video) return { meta: movieMeta(entry) };
  return { meta: null };
});

/** One Gerbera file -> one entry in the Stremio source list. */
function toStream(video) {
  return {
    url: video.url,
    name: 'Gerbera',
    title: `Local network\n${describe(video)}`,
    behaviorHints: {
      // The file lives on the LAN and always sits at the same address, so
      // Stremio can treat it as a stable source and offer binge watching.
      bingeGroup: 'gerbera-local',
      notWebReady: false,
    },
  };
}

builder.defineStreamHandler(async ({ type, id }) => {
  await ensureFresh();

  // 1) This addon's own catalog entries
  if (id.startsWith('gerbera:')) {
    const entry = state.byId.get(id);
    if (!entry || !entry.video) return { streams: [] };
    return { streams: [toStream(entry.video)] };
  }

  // 2) An IMDb id coming from regular Stremio search — this is where the local
  //    file gets offered as a source.
  if (!id.startsWith('tt')) return { streams: [] };

  // Series arrive as "tt1234567:2:5" (season:episode)
  const direct = state.byImdb.get(id);
  if (direct && direct.length) {
    return { streams: direct.map(toStream) };
  }

  // If the IMDb id was never matched (for example because the filename differs
  // from the official title), fall back to matching on the title Cinemeta
  // reports for that id.
  const [imdbId, seasonStr, episodeStr] = id.split(':');
  const meta = await cinemeta.metaById(type, imdbId);
  if (!meta || !meta.name) return { streams: [] };

  const wanted = normalize(meta.name);

  if (type === 'series') {
    const season = Number(seasonStr);
    const episode = Number(episodeStr);
    if (!season || !episode) return { streams: [] };

    const s = state.series.find(x => normalize(x.title) === wanted);
    if (!s) return { streams: [] };
    const hits = s.episodes.filter(e => e.season === season && e.episode === episode);
    return { streams: hits.map(e => toStream(e.video)) };
  }

  const hits = state.movies.filter(e => {
    if (normalize(e.title) !== wanted) return false;
    if (e.year && meta.year && Math.abs(e.year - meta.year) > 1) return false;
    return true;
  });
  return { streams: hits.map(e => toStream(e.video)) };
});

// Scan once at startup so the first request does not have to wait.
ensureFresh().catch(err => console.error('Initial scan failed:', err.message));

/**
 * Serves `GET /health` next to the addon's own routes.
 *
 * The SDK builds its express app inside serveHTTP and offers no hook for extra
 * routes, so that app is taken off the server and kept as the fallthrough for
 * everything that is not the health probe.
 */
function mountHealth(server) {
  const [addon] = server.listeners('request');
  if (!addon) {
    console.warn('Could not mount /health: no request handler on the server.');
    return;
  }

  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url.split('?')[0] !== '/health') return addon(req, res);

    // Read-only on purpose: a probe reports state, it does not trigger a scan.
    const report = health();
    res.writeHead(report.healthy ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(report, null, 2) + '\n');
  });
}

serveHTTP(builder.getInterface(), { port: ADDON_PORT })
  .then(({ server }) => {
    mountHealth(server);
    console.log(`Addon listening on http://0.0.0.0:${ADDON_PORT}/manifest.json  (Gerbera: ${GERBERA_URL})`);
  })
  .catch(err => {
    console.error('Could not start the HTTP server:', err.message);
    process.exit(1);
  });
