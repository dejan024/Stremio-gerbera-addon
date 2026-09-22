// parse.js
// Turns raw filenames coming from the Gerbera server into usable metadata.
//
//   "Eight.Below.2006.720p.BrRip.x264.YIFY"          -> movie  "Eight Below" (2006)
//   "Sweet.Magnolias.S02E01.Casseroles.1080p.NF"     -> series "Sweet Magnolias" S2E1
//   "Some Artist - Some Song (Official Video 2015)"  -> other  (music clip, not a movie)
//
// Two parsers run over every name. The rules in this file decide *what kind of
// file* it is, because that judgement depends on the shape of a home library:
// a DLNA server holds concerts, phone recordings and music videos next to
// movie releases, and telling those apart is what the CLIP and STRONG_JUNK
// heuristics below do. `parse-torrent-title` knows none of that — it assumes
// everything it sees is a release — but it is considerably better at cleaning
// up a scene release name once you know that is what you are holding. So it
// runs second, and only to sharpen the title and year that get sent to the
// metadata providers.

const ptt = require('parse-torrent-title');

// Tokens that mark where the title ends and the technical release description
// begins. "Strong" tags never show up by accident, so their presence alone is
// enough to treat the file as a movie release.
const STRONG_JUNK = /\b(?:2160p|1080p|1080i|720p|576p|480p|360p|x264|x265|h\.?264|h\.?265|hevc|xvid|divx|av1|10bit|8bit|bluray|blu-?ray|brrip|bdrip|bdremux|remux|webrip|web-?dl|webdl|hdtv|pdtv|dvdrip|dvdscr|hdrip|camrip|hdcam|telesync|ddp?5|ddp?2|dd5|dd2|aac2?|ac3|eac3|dts(?:-?hd)?|truehd|atmos|proper|repack|unrated|uncut|remastered|imax|hardsub|yify|yts|rarbg|eztv|ettv|tgx|galaxyrg|tepes|amzn|dsnp|hmax|atvp|pcok)\b/i;

// "Weak" tags also appear in music video titles ("... 4K", "... HDR"), so on
// their own they do not make a file a movie.
const WEAK_JUNK = /\b(?:4k|uhd|hdr10|hdr|sdr)\b/i;

const JUNK = new RegExp(`${STRONG_JUNK.source}|${WEAK_JUNK.source}`, 'i');

// S02E01 / s2e1 / S02.E01 / 2x01 / Season 2 Episode 1
const SERIES_PATTERNS = [
  /[\s._-]s(\d{1,2})[\s._-]?e(\d{1,3})(?:[\s._-]?e\d{1,3})*\b/i,
  /[\s._-](\d{1,2})x(\d{1,3})\b/i,
  /[\s._-]season[\s._-]?(\d{1,2})[\s._-]?episode[\s._-]?(\d{1,3})\b/i,
];

const YEAR = /[\s._([-](19\d{2}|20\d{2})(?:[\s._)\]-]|$)/;

// Wording typical of music videos, concerts and home recordings rather than
// movie releases.
const CLIP = /\s[-–]\s|\b(?:official\s*(?:video|spot|lyric)|lyrics|uzivo|live|cover|tekst|remix|mix|album|karaoke)\b/i;

/** "Eight.Below" -> "Eight Below" */
function prettify(raw) {
  return String(raw)
    // Tracker and site stamps glued to the front of a release name.
    .replace(/^\s*(?:www\.)?[a-z0-9-]+\.(?:com|net|org|me|to|se|eu|info|mx|re)\s*[-–_]\s*/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s*[[(].*?[\])]\s*/g, ' ')   // leftover brackets: [eztv.re], (2015)
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—]+|[\s\-–—]+$/g, '')
    .trim();
}

/** Comparison key for titles — letters and digits only, lowercased. */
function normalize(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[đ]/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words that turn up between the episode number and the release tags without
// being part of the episode's name.
const NOT_AN_EPISODE_NAME = /^(?:web|multi|vostfr|vf|vff|vo|sub|subs|subbed|dubbed|ita|eng|srp|srb|hrv|dual|complete|internal|limited|extended|final|hd|sd|season|episode|ep)$/i;

/**
 * Pulls the episode's name out of a filename — the "Casseroles" in
 * "Sweet.Magnolias.S02E01.Casseroles.1080p.NF".
 *
 * It is only ever a fallback: when a provider knows the episode, its title is
 * the canonical one. But plenty of shows are not in any provider's database,
 * and for those this is the difference between a list of "S02E01, S02E02" and
 * a list you can actually read.
 *
 * What sits after the episode number is just as often a release tag or a
 * group name, so a candidate is rejected unless it looks like prose: not only
 * stopwords or digits, and not a bare all-caps token like "WEB" or "NF".
 */
function episodeName(tail) {
  const junk = tail.match(JUNK);
  const clean = prettify(junk ? tail.slice(0, junk.index) : tail);
  if (!clean || clean.length > 80) return null;

  const words = clean.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (words.every(w => NOT_AN_EPISODE_NAME.test(w) || /^\d+$/.test(w))) return null;

  // A lone all-caps token is a release group or a source tag, never a title.
  if (words.length === 1 && words[0] === words[0].toUpperCase() && !/^\d/.test(words[0])) {
    return null;
  }
  return clean;
}

/** Runs parse-torrent-title, swallowing anything it throws on odd input. */
function pttParse(base) {
  try {
    return ptt.parse(base) || {};
  } catch {
    return {};
  }
}

/**
 * Reconciles this file's reading of a release name with the other parser's.
 *
 * Returns the title and year to go forward with. The comparison is done on the
 * normalized forms, so punctuation and casing play no part in it.
 *
 * Three rules, in order:
 *
 *   1. Our title is theirs plus a trailing number. That number is a year we
 *      cut the title at by mistake — "Blade Runner 2049 (2017)" ends up as
 *      "Blade Runner" from 2049. They read the name as a whole and got both
 *      parts right, so they win outright, year included.
 *   2. Neither title contains the other. The two readings disagree about what
 *      the film even is; nothing is assumed and this file's rules win, because
 *      they are the ones tuned to the shape of a home library.
 *   3. Otherwise the shorter title wins. Whatever the longer one kept is a
 *      site tag, a release group, or a technical token the other side did not
 *      recognise.
 */
function reconcile(ourTitle, ourYear, hint) {
  // Their title comes back with the original separators in place when they
  // could not split it — "[YTS.MX] Movie.Name" — so it gets the same cleanup
  // any title from this file would.
  const theirs = hint.title ? prettify(hint.title) : null;
  const fallbackYear = ourYear || hint.year || null;

  if (!theirs) return { title: ourTitle, year: fallbackYear };

  const a = normalize(ourTitle);
  const b = normalize(theirs);

  if (!b) return { title: ourTitle, year: fallbackYear };
  if (!a) return { title: theirs, year: fallbackYear };

  // 1. We stopped at a number that is really part of the title.
  if (b.startsWith(`${a} `) && /^\d+$/.test(b.slice(a.length + 1))) {
    return { title: theirs, year: hint.year || null };
  }

  // 2. Outright disagreement.
  if (!a.includes(b) && !b.includes(a)) return { title: ourTitle, year: fallbackYear };

  // 3. Shorter wins.
  return { title: b.length < a.length ? theirs : ourTitle, year: fallbackYear };
}

/**
 * Main entry point. Returns one of:
 *   { kind: 'series', title, season, episode, year: null }
 *   { kind: 'movie',  title, year|null }
 *   { kind: 'other',  title }
 */
function parseTitle(rawTitle) {
  const raw = String(rawTitle || '').trim();
  if (!raw) return { kind: 'other', title: 'Untitled' };

  // Gerbera sometimes keeps the file extension in the title
  const base = raw.replace(/\.(?:mkv|mp4|avi|mov|m4v|webm|ts|m2ts|wmv|flv|mpg|mpeg)$/i, '');

  const hint = pttParse(base);

  for (const re of SERIES_PATTERNS) {
    const m = base.match(re);
    if (!m) continue;
    const name = prettify(base.slice(0, m.index));
    if (!name) break;
    // A year in a series filename is the year the show started, which helps
    // tell apart remakes ("Battlestar Galactica" 1978 and 2004) when the title
    // alone is looked up. It is a hint, never part of the name.
    const show = reconcile(name, null, hint);
    return {
      kind: 'series',
      title: show.title,
      season: parseInt(m[1], 10),
      episode: parseInt(m[2], 10),
      episodeTitle: episodeName(base.slice(m.index + m[0].length)),
      year: show.year,
    };
  }

  // A season/episode pair the patterns above do not cover — "Ep. 5",
  // "- 05 -" and similar. Trusted only when it comes with a title.
  if (hint.season && hint.episode && hint.title) {
    return {
      kind: 'series',
      title: prettify(hint.title),
      season: hint.season,
      episode: hint.episode,
      episodeTitle: hint.episodeName ? prettify(hint.episodeName) : null,
      year: hint.year || null,
    };
  }

  const ym = base.match(YEAR);
  const jm = base.match(JUNK);
  const year = ym ? parseInt(ym[1], 10) : null;

  // The title runs up to the first release tag or the year, whichever is first.
  const cut = Math.min(ym ? ym.index : Infinity, jm ? jm.index : Infinity);
  let name = prettify(Number.isFinite(cut) ? base.slice(0, cut) : base);
  const strong = STRONG_JUNK.test(base);

  // A release tag can sit at the very start of the filename — "[YTS.MX] ..."
  // or "Proper.Care.2019.1080p" — and cutting there leaves nothing usable.
  // The other parser reads those words in context and recovers the title.
  if (!normalize(name)) {
    if (!strong || !hint.title) return { kind: 'other', title: prettify(base) || 'Untitled' };
    name = prettify(hint.title);
    if (!normalize(name)) return { kind: 'other', title: prettify(base) || 'Untitled' };
    return { kind: 'movie', title: name, year: year || hint.year || null };
  }

  const { title, year: movieYear } = reconcile(name, year, hint);

  // A strong release tag (1080p, BluRay, x264, YIFY...) reliably means this is
  // a movie release rather than a home recording or a music clip.
  if (strong) return { kind: 'movie', title, year: movieYear };

  if (CLIP.test(base)) return { kind: 'other', title: prettify(base) };

  if (WEAK_JUNK.test(base)) return { kind: 'movie', title, year: movieYear };

  // A year in brackets — "Some Film (2014)". A bare trailing year is more often
  // the date of a home recording than a movie release year.
  if (ym && /[([]/.test(base.charAt(ym.index))) {
    return { kind: 'movie', title, year: movieYear };
  }

  return { kind: 'other', title: prettify(base) || 'Untitled' };
}

module.exports = { parseTitle, normalize, prettify };
