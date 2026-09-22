// parse.js
// Turns raw filenames coming from the Gerbera server into usable metadata.
//
//   "Eight.Below.2006.720p.BrRip.x264.YIFY"          -> movie  "Eight Below" (2006)
//   "Sweet.Magnolias.S02E01.Casseroles.1080p.NF"     -> series "Sweet Magnolias" S2E1
//   "Some Artist - Some Song (Official Video 2015)"  -> other  (music clip, not a movie)

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

  for (const re of SERIES_PATTERNS) {
    const m = base.match(re);
    if (!m) continue;
    const name = prettify(base.slice(0, m.index));
    if (!name) break;
    return {
      kind: 'series',
      title: name,
      season: parseInt(m[1], 10),
      episode: parseInt(m[2], 10),
      year: null,
    };
  }

  const ym = base.match(YEAR);
  const jm = base.match(JUNK);
  const year = ym ? parseInt(ym[1], 10) : null;

  // The title runs up to the first release tag or the year, whichever is first.
  const cut = Math.min(ym ? ym.index : Infinity, jm ? jm.index : Infinity);
  const name = prettify(Number.isFinite(cut) ? base.slice(0, cut) : base);

  if (!name) return { kind: 'other', title: prettify(base) || 'Untitled' };

  // A strong release tag (1080p, BluRay, x264, YIFY...) reliably means this is
  // a movie release rather than a home recording or a music clip.
  if (STRONG_JUNK.test(base)) return { kind: 'movie', title: name, year };

  if (CLIP.test(base)) return { kind: 'other', title: prettify(base) };

  if (WEAK_JUNK.test(base)) return { kind: 'movie', title: name, year };

  // A year in brackets — "Some Film (2014)". A bare trailing year is more often
  // the date of a home recording than a movie release year.
  if (ym && /[([]/.test(base.charAt(ym.index))) {
    return { kind: 'movie', title: name, year };
  }

  return { kind: 'other', title: prettify(base) || 'Untitled' };
}

module.exports = { parseTitle, normalize, prettify };
