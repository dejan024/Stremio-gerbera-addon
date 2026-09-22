# Contributing

Thanks for taking the time to contribute.

## Reporting a bug

Please include:

- the Gerbera version (shown in its web UI) and how it is deployed
- the addon logs around the failure (`docker compose logs stremio-gerbera-addon`)
- the output of `curl -s <GERBERA_URL>/description.xml | head -40`
- for a title that is matched incorrectly, the exact filename as Gerbera shows it

## Development

```bash
npm install
GERBERA_URL=http://<your-server>:49494 PORT=7100 npm start
```

The addon then answers on `http://127.0.0.1:7100`. Useful endpoints while
working on it:

```bash
curl -s 127.0.0.1:7100/manifest.json
curl -s 127.0.0.1:7100/catalog/movie/gerbera-movies.json
curl -s 127.0.0.1:7100/stream/movie/tt0086567.json
```

Delete `cache/imdb.json` to force IMDb lookups to run again.

## Filename parsing

Most behaviour reports come down to `parse.js`. When changing it, keep in
mind the three categories it separates:

- `movie` — a release with strong scene tags, or a title with a bracketed year
- `series` — anything matching `S02E01`, `2x01` or `Season 2 Episode 1`
- `other` — music videos, concerts and home recordings

Weak tags such as `4K` or `HDR` deliberately do not classify a file as a movie
on their own, because they also appear in music video titles. Please add a
sample filename to the pull request description when you adjust a pattern.

## Pull requests

- One logical change per pull request
- Match the surrounding code style; no build step or linter is configured
- Explain what you verified against a real Gerbera server
