// index.js
// A Stremio addon backed by a local Gerbera DLNA/UPnP server.
//
// It does two things:
//   1. Catalog — movies, series and other clips from the Gerbera server, so the
//      local library can be browsed straight from Stremio.
//   2. Local source — when any movie or episode is opened in Stremio (through
//      its regular search), the addon checks whether that title exists on the
//      Gerbera server and, if so, offers it as a playable source.

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { state, ensureFresh, describe, GERBERA_URL } = require('./library');
const cinemeta = require('./cinemeta');
const { normalize } = require('./parse');

const ADDON_PORT = Number(process.env.PORT || 7100);

const manifest = {
  id: 'org.gerbera.dlna.addon',
  version: '2.0.0',
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

function movieMeta(entry) {
  return {
    id: entry.id,
    type: 'movie',
    name: entry.year ? `${entry.title} (${entry.year})` : entry.title,
    poster: entry.video.thumb || undefined,
    posterShape: 'landscape',
    background: entry.video.thumb || undefined,
    description: describe(entry.video),
    releaseInfo: entry.year ? String(entry.year) : undefined,
  };
}

function seriesMeta(s) {
  const withThumb = s.episodes.find(e => e.video.thumb);
  return {
    id: s.id,
    type: 'series',
    name: s.title,
    poster: (withThumb && withThumb.video.thumb) || undefined,
    posterShape: 'landscape',
    description: `${s.episodes.length} episodes on the local server`,
  };
}

builder.defineCatalogHandler(async ({ id, extra }) => {
  await ensureFresh();

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

  return { metas: metas.slice(skip, skip + PAGE_SIZE) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  await ensureFresh();

  const entry = state.byId.get(id);
  if (!entry) return { meta: null };

  if (type === 'series' && entry.episodes) {
    const meta = seriesMeta(entry);
    meta.videos = entry.episodes.map(ep => ({
      id: `${entry.id}:${ep.season}:${ep.episode}`,
      title: `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`,
      season: ep.season,
      episode: ep.episode,
      thumbnail: ep.video.thumb || undefined,
    }));
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

serveHTTP(builder.getInterface(), { port: ADDON_PORT });
console.log(`Addon listening on http://0.0.0.0:${ADDON_PORT}/manifest.json  (Gerbera: ${GERBERA_URL})`);
