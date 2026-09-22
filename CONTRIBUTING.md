# Contributing

Thanks for taking the time to contribute.

## Reporting a bug

Please include:

- the Gerbera version (shown in its web UI) and how it is deployed
- the addon logs around the failure (`docker compose logs stremio-gerbera-addon`)
- the output of `curl -s <GERBERA_URL>/description.xml | head -40`
- for a title that is matched incorrectly, the exact filename as Gerbera shows
  it, and what the addon made of it:

  ```bash
  node -e "console.log(require('./parse').parseTitle(process.argv[1]))" "Your.File.Name.mkv"
  ```

- for a metadata problem, whether a TMDB key is configured, and the
  `Metadata: ...` line from the startup logs

## Development

```bash
npm install
GERBERA_URL=http://<your-server>:49494 PORT=7100 npm start
```

The addon then answers on `http://127.0.0.1:7100`. Useful endpoints while
working on it:

```bash
curl -s 127.0.0.1:7100/manifest.json
curl -s 127.0.0.1:7100/health
curl -s 127.0.0.1:7100/catalog/movie/gerbera-movies.json
curl -s 127.0.0.1:7100/stream/movie/tt0086567.json
```

Two cache files sit under `cache/`: `imdb.json` for resolved IMDb ids and
`meta.json` for the metadata records. Delete either to force those lookups to
run again. Both cache misses as well as hits, so a title that came back empty
is not retried until `META_MISS_TTL_DAYS` has passed — delete the file rather
than waiting when you are working on matching.

`META_ENRICH=false` skips the metadata pass entirely, which makes iterating on
`gerbera.js` or `parse.js` a good deal faster.

## Filename parsing

Most behaviour reports come down to `parse.js`. Two parsers run over every
name and they have distinct jobs:

- The rules in `parse.js` decide **what kind of file it is**. That judgement
  depends on the shape of a home library — a DLNA server holds concerts,
  phone recordings and music videos next to movie releases — and no
  general-purpose library makes it.
- `parse-torrent-title` then **sharpens the title and year** for the metadata
  lookup, because it is better at cleaning up a scene release name once you
  know that is what you are holding.

Keep the three categories in mind when changing the first part:

- `movie` — a release with strong scene tags, or a title with a bracketed year
- `series` — anything matching `S02E01`, `2x01` or `Season 2 Episode 1`, or an
  episode marker the other parser recognises
- `other` — music videos, concerts and home recordings

Weak tags such as `4K` or `HDR` deliberately do not classify a file as a movie
on their own, because they also appear in music video titles.

Where the two parsers disagree, `reconcile()` decides: the shorter title wins,
on the reasoning that whatever the longer one kept is a site tag or a release
group — except when one of them cut the title at a number that belongs to it,
as in *Blade Runner 2049*. Outright disagreement, where neither title contains
the other, leaves the `parse.js` reading in place.

Please add a sample filename to the pull request description when you adjust a
pattern, and check it against the categories both ways — a change that fixes
one release name often reclassifies a home recording.

## Metadata providers

`meta.js` owns the provider chain and is the only module the handlers talk to;
`cinemeta.js` and `tmdb.js` each return a raw record and know nothing about
each other. When adding a provider, normalise it into the shape
`normalizeRecord()` produces so nothing downstream has to branch on the
source.

Two rules the existing providers follow:

- **Never throw at the caller.** Every provider call may return `null`; the
  chain treats that as "try the next one" and a total failure as "keep the
  filename". A metadata problem must never take down a catalog request.
- **Accept a match only on an exact normalized title.** TMDB in particular
  ranks by popularity, so the top hit for a short title is frequently the
  wrong film. Loosening this trades visible wrong posters for slightly better
  coverage, which is the worse deal.

Testing TMDB without a key is straightforward: point `TMDB_URL` at a local
server returning canned JSON and set `TMDB_API_KEY` to anything non-empty.

## Pull requests

- One logical change per pull request
- Match the surrounding code style; no build step or linter is configured
- Explain what you verified against a real Gerbera server
