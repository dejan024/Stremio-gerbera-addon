# Stremio Gerbera Addon

A [Stremio](https://www.stremio.com/) addon that turns a local
[Gerbera](https://gerbera.io/) DLNA/UPnP media server into a first-class
source inside Stremio.

It does three things:

1. **Catalogs** — your movies, series and other clips from the Gerbera server,
   browsable straight from Stremio.
2. **Local source** — when you open *any* movie or episode in Stremio through
   its normal search, the addon checks whether that exact title sits on your
   Gerbera server and, if it does, offers it in the source list as
   **Gerbera → Local network**.
3. **Real metadata** — filenames are matched against
   [Cinemeta](https://v3-cinemeta.strem.io) and, optionally,
   [TMDB](https://www.themoviedb.org/), so the catalog shows posters,
   descriptions, genres, ratings and episode names instead of
   `Some.Movie.2019.1080p.WEBRip.x264.mkv`.

Playback uses the direct HTTP URL that Gerbera already serves to DLNA clients.
Nothing is transcoded, nothing leaves your network, and because Gerbera
supports HTTP Range requests, seeking works normally.

```
┌─────────┐   manifest / catalog / stream    ┌───────────┐   UPnP SOAP   ┌─────────┐
│ Stremio │ ───────────────────────────────► │   addon   │ ────────────► │ Gerbera │
│ client  │                                  │  (+Caddy) │               │  server │
└─────────┘ ◄─────────────────────────────── └───────────┘               └─────────┘
     │              stream URL                                                 ▲
     └─────────────────── direct HTTP video, LAN only ─────────────────────────┘
```

---

## Requirements

- A running Gerbera server (developed and tested against **Gerbera 3.3.0**;
  any UPnP MediaServer exposing `ContentDirectory` should work)
- Docker and Docker Compose, **or** Node.js 18+
- Stremio client on the same network as the Gerbera server
- Outbound internet access, if you want posters and descriptions. It is not
  required: an air-gapped install serves the same library from filenames.

---

## Quick start

```bash
git clone https://github.com/dejan024/Stremio-gerbera-addon.git stremio-gerbera-addon
cd stremio-gerbera-addon
cp .env.example .env
```

> **Keep the directory name lowercase** — note that the clone command above
> renames it. This is a general rule for Compose stacks rather than anything
> specific to this addon: Docker Compose takes the project name from the
> directory it runs in and lowercases it, because project names may only
> contain lowercase letters, digits, dashes and underscores. Compose managers
> match their stack folder against that project name literally, so a
> capitalised folder leaves the two unable to pair up. In Dockge, for instance,
> the stack is listed as `inactive` while its containers are in fact running.

Edit `.env` and point `GERBERA_URL` at your server. Nothing else in it has to
be touched — posters and descriptions are on by default and need no API key;
see [Metadata](#metadata) for the optional second provider.

Then set up a certificate (see [HTTPS](#https-why-its-required) below — a
self-signed one is fine, unless a TV is going to use the addon) and start it:

```bash
docker compose up -d --build
```

Install it in Stremio from:

```
https://<your-server-ip>:7443/manifest.json
```

---

## Updating

```bash
cd stremio-gerbera-addon
git pull
docker compose up -d --build
```

`--build` is required because the addon image is built from this repository —
without it Docker keeps running the old code. Your `.env`, `certs/` and
`cache/` are left untouched.

---

## HTTPS: why it's required

Stremio refuses to install an addon over plain HTTP unless it is served from
`127.0.0.1`. This is enforced by the Stremio client itself, not by a browser,
so it applies to the desktop app too. A self-signed certificate is enough —
nothing ever leaves your network.

Generate one for your server's IP:

```bash
mkdir -p certs
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout certs/addon-key.pem \
  -out certs/addon.pem \
  -days 825 \
  -subj "/CN=192.168.1.10" \
  -addext "subjectAltName=IP:192.168.1.10"
```

Replace `192.168.1.10` with your server's address. The
`-addext "subjectAltName=IP:..."` part matters: Chromium-based clients
(including Stremio) reject certificates that only carry a CN, even self-signed
ones. 825 days is the maximum lifetime Chromium accepts for such a certificate.

### Trusting the certificate

A self-signed certificate is not trusted automatically. Import `certs/addon.pem`
on **every machine** running Stremio — the desktop app and the browser share
the operating system trust store:

- **Windows** — double-click `addon.pem` → Install Certificate → Local Machine →
  *Place all certificates in the following store* → Trusted Root Certification
  Authorities
- **macOS** — double-click → Keychain Access → find the certificate → Get Info →
  Trust → *Always Trust*
- **Linux (Debian/Ubuntu)**
  ```bash
  sudo cp certs/addon.pem /usr/local/share/ca-certificates/gerbera-addon.crt
  sudo update-ca-certificates
  ```

### When a client cannot be made to trust it

A TV cannot. Neither Samsung's Tizen nor LG's webOS offers any way to import a
certificate, and the Stremio app on them shows no "continue anyway" prompt — it
simply gets nothing back, and the catalog stays empty with no error. Syncing
the addon from a desktop where the certificate *is* trusted does not help: the
TV still makes its own request, and fails it on its own.

The way out is a certificate from a real authority, for a real domain name
whose A record points at this server's **LAN** address. Nothing is published:
a name is public, the address behind it is not routable from outside, and the
certificate is proven through a DNS record rather than through an open port.

You need a domain on [Cloudflare](https://www.cloudflare.com/) (its free tier
is enough; the nameservers are what matters, not where the domain was bought).

**1. Add the DNS record.** In the Cloudflare dashboard, under *DNS → Records*:

| | |
|---|---|
| Type | `A` |
| Name | `gerbera` (giving `gerbera.example.org`) |
| IPv4 address | this server's LAN address, e.g. `192.168.1.10` |
| Proxy status | **DNS only** — the grey cloud, not the orange one |

Cloudflare warns that the address is private. That is the intent.

**2. Create an API token.** *My Profile → API Tokens → Create Token*, from the
*Edit zone DNS* template. It needs `Zone:Read` and `DNS:Edit`, and under *Zone
Resources* pick the one zone. The token is shown once. It can create and delete
DNS records in that zone and nothing else — no account access, no other domain.

**3. Point `.env` at the second Caddyfile:**

```ini
CADDYFILE=./Caddyfile.letsencrypt
ADDON_DOMAIN=gerbera.example.org
ACME_EMAIL=you@example.org
CF_API_TOKEN=<the token from step 2>
```

**4. Rebuild.** The first build compiles Caddy with its Cloudflare DNS module
and takes a couple of minutes; later ones are cached.

```bash
docker compose up -d --build
```

Watch it get the certificate:

```bash
docker compose logs -f caddy
```

`certificate obtained successfully` means it worked. Then install the addon in
Stremio from `https://gerbera.example.org:7443/manifest.json` — on the desktop,
if that is where you manage addons; the TV picks it up through account sync.
Remove the old `https://<ip>:7443/...` entry first, or the two fight over the
same addon id.

Renewal is automatic and needs no open port either. The certificates live in
the `caddy-data` volume, so restarts and rebuilds keep them.

---

## Configuration

Everything is configured through environment variables. Copy `.env.example` to
`.env` and adjust:

| Variable | Default | Description |
|---|---|---|
| `GERBERA_URL` | `http://127.0.0.1:49494` | Base URL of the Gerbera server |
| `PORT` | `7100` | Port the addon listens on (behind Caddy) |
| `HTTPS_PORT` | `7443` | Port Caddy serves HTTPS on |
| `CADDYFILE` | `./Caddyfile` | Which Caddyfile to use — the self-signed one, or `./Caddyfile.letsencrypt` |
| `ADDON_DOMAIN` | — | Domain the Let's Encrypt certificate is issued for |
| `ACME_EMAIL` | — | Address Let's Encrypt sends expiry warnings to |
| `CF_API_TOKEN` | — | Cloudflare token used to answer the DNS-01 challenge |
| `REFRESH_MINUTES` | `30` | How often the library is rescanned |
| `MATCH_IMDB` | `true` | Resolve local titles to IMDb ids via Cinemeta |
| `SCAN_TIMEOUT_MINUTES` | `10` | A scan running longer than this marks the addon unhealthy |
| `META_ENRICH` | `true` | Fetch posters, descriptions, genres, ratings and episode names |
| `TMDB_API_KEY` | *(empty)* | Optional second metadata provider — see below |
| `META_LANG` | `en` | Language for TMDB descriptions (`sr-RS`, `de-DE`, …) |
| `META_TTL_DAYS` | `30` | How long a metadata record is kept before refetching |
| `META_MISS_TTL_DAYS` | `3` | How long a title no provider knew is remembered as a miss |
| `IMDB_TTL_DAYS` | `180` | How long a resolved IMDb id is kept |
| `LOOKUP_CONCURRENCY` | `4` | Concurrent provider lookups during the metadata pass |
| `CACHE_FILE` | `/app/cache/imdb.json` | Where resolved IMDb ids are cached |
| `META_CACHE_FILE` | `/app/cache/meta.json` | Where metadata records are cached |

`GERBERA_URL` must be the UPnP port, which is the same port that serves the
Gerbera web UI — check `http://<host>:<port>/description.xml` returns XML.

---

## Metadata

Out of the box the addon uses **Cinemeta**, the public metadata addon Stremio
itself runs on. It needs no key, no account and no configuration, and it
covers anything with an IMDb id — which is most of a typical library.

A title it recognises is published in the catalog under its **IMDb id**, so
opening that card lands on the same detail page Stremio shows for the film
everywhere else — artwork, cast, trailer — with your local file listed as a
source next to whatever other addons offer. A title it does not recognise
keeps an id of the addon's own, and the addon draws that page itself from
whatever it managed to find, falling back to the parsed filename.

### Adding a TMDB key (optional)

TMDB is the second opinion for what Cinemeta does not have: regional and
older titles, films released under a local name, and anything whose filename
spells the title differently from the official English one. It also carries
descriptions in other languages.

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/signup).
2. Request an API key under **Settings → API** (choose *Developer*; approval
   is immediate).
3. Copy the **API Key (v3 auth)** — a 32-character hex string, *not* the
   longer "Read Access Token".
4. Put it in your `.env` next to the other settings:

   ```ini
   TMDB_API_KEY=0123456789abcdef0123456789abcdef
   ```

5. Recreate the container so it picks the value up:

   ```bash
   docker compose up -d
   ```

Nothing else changes. Without a key the addon never contacts TMDB and runs on
Cinemeta alone; if the key is wrong, the first rejected request switches TMDB
off for that run and logs why, and the addon carries on.

> **About `META_LANG`.** It applies to TMDB only — Cinemeta has no language
> parameter and always answers in English. Because Cinemeta is asked first,
> setting `META_LANG=sr-RS` gives you a mix: English for everything Cinemeta
> recognised, Serbian only for the titles that fell through to TMDB.

### How the cache works

Every lookup is a network round trip, and the answers barely change, so both
are written to disk under the `./cache` volume:

| File | Holds | Lifetime |
|---|---|---|
| `cache/imdb.json` | filename → IMDb id | `IMDB_TTL_DAYS` (180 days) |
| `cache/meta.json` | IMDb/TMDB id → poster, description, genres, episodes | `META_TTL_DAYS` (30 days) |

Three things are worth knowing about it:

- **Misses are cached too**, for the shorter `META_MISS_TTL_DAYS`. A title no
  provider recognises is not looked up again on every rescan, but it *is*
  retried after a few days, because metadata databases keep growing.
- **Only new or expired entries cost a request.** A rescan of a library that
  has not changed makes no provider calls at all. Adding one film costs one
  or two requests, not a full re-fetch.
- **The first scan after enabling this is the slow one.** Every title is a
  fresh lookup. It runs in the background — the catalog is served immediately
  and the cards fill in behind it — but on a library of a few thousand files
  expect a few minutes before everything has artwork. Watch it finish with
  `curl -sk https://<host>:7443/health | grep -E 'enrich'`.

Deleting `cache/meta.json` forces a full re-fetch; the addon recreates it.
Keeping the `./cache` volume mounted is what stops that happening on every
container restart.

---

## Health checks and automatic restart

The addon serves a plain JSON report at `/health`:

```bash
curl -s http://localhost:7100/health
```

```json
{
  "status": "ok",
  "healthy": true,
  "gerbera": "http://192.168.1.10:49494",
  "error": null,
  "lastScan": "2026-03-04T09:12:44.118Z",
  "lastScanAgeSeconds": 96,
  "scanningForSeconds": null,
  "uptimeSeconds": 3711,
  "library": {
    "movies": 14, "series": 1, "episodes": 10, "others": 277, "imdbMatches": 19
  }
}
```

| `status` | HTTP | Meaning |
|---|---|---|
| `starting` | 200 | The first scan has not finished yet |
| `ok` | 200 | Library loaded, last scan succeeded |
| `degraded` | 200 | The last scan failed — the reason is in `error` |
| `hung` | 503 | A scan has been running for over `SCAN_TIMEOUT_MINUTES` |

Only `hung` counts as unhealthy, and that is deliberate. Restarting the addon
cannot bring back an unreachable Gerbera server, so `degraded` stays healthy:
the addon keeps serving the library from its last successful scan, and the
catalog tile carries the reason. A container that restarted every minute for
as long as the media server was switched off would be worse than one that
simply says what is wrong. A scan that starts and never returns is the
opposite case — every request then waits on it forever, and only a restart
clears that.

### What restarts what

`restart: unless-stopped` covers a container that crashed or exited. It does
**not** cover one that stays up while reporting unhealthy: the Docker engine
records the healthcheck result and acts on nothing. Three pieces close that
gap:

| Piece | Where | What it does |
|---|---|---|
| `HEALTHCHECK` | [`Dockerfile`](Dockerfile) | Polls `/health` on the addon every 60s |
| `healthcheck:` | [`docker-compose.yml`](docker-compose.yml) | Polls Caddy's admin API on `127.0.0.1:2019` |
| `autoheal` | [`docker-compose.yml`](docker-compose.yml) | Restarts any container labelled `autoheal=true` once its healthcheck fails |

Caddy is probed through its own admin API rather than through the port it
proxies, so the addon being down — a 502 from the TLS port — does not get
Caddy restarted for someone else's fault. The `admin 127.0.0.1:2019` line in
the [`Caddyfile`](Caddyfile) is what this relies on; with `network_mode: host`
that port is taken on the host, so a second Caddy cannot run alongside it.

Where things stand:

```bash
docker compose ps
```

```bash
docker inspect --format '{{json .State.Health}}' stremio-gerbera-addon
```

### Running without the watchdog

`autoheal` restarts containers through the Docker socket, which is effectively
root on the host. If you would rather not grant that, delete the `autoheal`
service and the two `labels:` blocks from `docker-compose.yml`. The
healthchecks stay in place and `docker compose ps` keeps reporting
`healthy` / `unhealthy` — nothing acts on it on its own.

---

## Running without Docker

Works directly only if Stremio runs on the same machine (the `127.0.0.1`
exemption); otherwise put a TLS reverse proxy in front of it.

```bash
npm install
GERBERA_URL=http://192.168.1.10:49494 PORT=7100 npm start
```

Both cache files default to a `cache/` directory next to `index.js`, which is
created on first write. Point `CACHE_FILE` and `META_CACHE_FILE` somewhere
writable if the code lives in a read-only location.

A `systemd` unit for a permanent install:

```ini
[Unit]
Description=Stremio Gerbera addon
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/stremio-gerbera-addon
Environment=GERBERA_URL=http://192.168.1.10:49494
Environment=PORT=7100
Environment=CACHE_FILE=/opt/stremio-gerbera-addon/cache/imdb.json
Environment=META_CACHE_FILE=/opt/stremio-gerbera-addon/cache/meta.json
# Optional second metadata provider; leave it out to run on Cinemeta alone.
#Environment=TMDB_API_KEY=0123456789abcdef0123456789abcdef
ExecStart=/usr/bin/node index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` covers a crash, but nothing polls `/health` here — a
systemd install has no equivalent of the container watchdog below. A timer
running `curl -sf http://127.0.0.1:7100/health || systemctl restart
stremio-gerbera-addon` is the usual substitute.

---

## How it works

### Reading the library

Gerbera is queried over its `ContentDirectory` SOAP service. Rather than
walking the whole content tree, the addon issues a single UPnP `Search` for
`upnp:class derivedfrom "object.item.videoItem"`, which returns every video
file with its direct stream URL, thumbnail, size, duration and resolution in
one request. A library of several hundred videos scans in about two seconds.
Servers that do not implement `Search` fall back to a recursive tree walk.

Gerbera exposes the same file in several places at once — under `PC Directory`
and again in the virtual `Video/All Video/Directories` tree — so every file
appears two or more times under different object IDs. Entries are merged by
title, size and duration.

### Matching local files to IMDb ids

This is what makes a local file show up as a source under a title you found
through normal Stremio search.

1. [`parse.js`](parse.js) splits the raw filename into a title, a year and —
   for series — a season, an episode number and, when the filename carries
   one, the episode's name. Two parsers run over every name: the rules in
   that file decide *what kind* of file it is, because telling a scene release
   (`1080p`, `x264`, `YIFY`, …) from a music video or a home recording depends
   on the shape of a home library and no general-purpose library does it;
   [`parse-torrent-title`](https://www.npmjs.com/package/parse-torrent-title)
   then runs over the same name to sharpen the title and year. Where the two
   disagree the shorter title wins — whatever the other kept is a site tag or
   a release group — except when one of them cut the title at a number that
   belongs to it, as in *Blade Runner 2049*.
2. [`cinemeta.js`](cinemeta.js) asks [Cinemeta](https://v3-cinemeta.strem.io)
   — the public Stremio metadata addon — for the IMDb id matching that title
   and year. A hit is accepted only when the normalized titles match exactly
   and the years differ by at most one. Results are cached on disk, so a
   restart does not re-query anything.
3. When Stremio asks for streams for `tt0086567`, the addon looks that id up
   in the resulting map.

If step 2 never produced a match — common for local or non-English titles
whose filenames differ from the official name — the addon falls back at
request time to asking Cinemeta for the title behind that IMDb id and matching
it against the library by normalized title and year.

Without internet access this whole layer fails quietly: the catalogs keep
working, only the search-integration part is skipped. It can also be turned
off deliberately with `MATCH_IMDB=false`.

### Filling in the metadata

The same background pass that resolves IMDb ids also fetches the metadata,
because the two share their expensive half — a metadata record carries the
IMDb id it was found under, so one request answers both questions.

For each title [`meta.js`](meta.js) works down a chain, stopping at the first
answer:

1. **Cinemeta by id**, when the id is already known. One request, no
   searching. This is the common case.
2. **Cinemeta search** on the parsed title. Worth trying even after step 1
   failed, since the parser may have cleaned the name up differently from the
   pass that resolved the id.
3. **TMDB**, if a key is configured: title + year, then the title without the
   year (a filename's year is often the encode's, not the film's), then the
   title cut at a subtitle. A result is only accepted when its name — or its
   original-language name, which is usually what a local filename carries —
   matches exactly; TMDB ranks by popularity, so the top hit for a short title
   is frequently the wrong film.
4. **Nothing.** The entry keeps its parsed name and the Gerbera thumbnail,
   and the miss is cached so the next scan does not repeat the search.

Episode names come from the provider where it has them, and otherwise from
the filename — a show no database carries is usually named
`Serija.S01E04.Dolazak.Kuci.HDTV.avi`, and that is the difference between a
readable episode list and a column of `S01E04`.

For series, only the seasons actually present on the server are fetched from
TMDB: a twelve-season show with two seasons on disk costs two requests.

Every step of this is allowed to fail on its own. A provider that is down, a
rejected API key, no internet at all — each one degrades the cards, never the
addon: worst case you get exactly what the addon showed before this layer
existed. Set `META_ENRICH=false` to skip it entirely.

### Project layout

| File | Responsibility |
|---|---|
| [`gerbera.js`](gerbera.js) | UPnP/SOAP client, deduplication |
| [`parse.js`](parse.js) | Filename → title, year, season, episode, episode name |
| [`cinemeta.js`](cinemeta.js) | IMDb id lookups and full records from Cinemeta |
| [`tmdb.js`](tmdb.js) | TMDB provider — optional, key-gated |
| [`meta.js`](meta.js) | Provider chain, fallbacks, one record shape |
| [`cache.js`](cache.js) | On-disk key/value store with TTLs and negative caching |
| [`library.js`](library.js) | In-memory library state, periodic refresh, metadata pass |
| [`index.js`](index.js) | Stremio manifest and request handlers |

---

## Verifying it works

Without touching Stremio:

```bash
curl -sk https://localhost:7443/manifest.json
```

```bash
curl -sk https://localhost:7443/health
```

```bash
curl -sk https://localhost:7443/catalog/movie/gerbera-movies.json
```

```bash
curl -sk https://localhost:7443/stream/movie/tt0086567.json
```

The last call should return a local source if that film is in your library.
Substitute an IMDb id you actually have.

To check that the metadata layer is doing its job, look for `poster`,
`genres` and `imdbRating` in the catalog, and for entries whose `id` is an
IMDb id rather than a `gerbera:` one:

```bash
curl -sk https://localhost:7443/catalog/movie/gerbera-movies.json | grep -o '"id":"[^"]*"' | sort | uniq -c
```

A recognised series page — episode names, thumbnails and air dates — is
whatever Cinemeta serves for its IMDb id. For a series the providers do *not*
know, the addon draws the page itself; that is the one to check:

```bash
curl -sk "https://localhost:7443/meta/series/gerbera:series:<slug>.json"
```

Startup logs should look like this:

```
Scanning Gerbera server: http://192.168.1.10:49494
Done in 2110ms: 301 files -> 14 movies, 1 series (10 episodes), 277 other clips.
Metadata: 15 titles enriched, 19 matched to an IMDb id ({"hits":0,"cinemeta":15,"tmdb":0,"misses":6,"cached":21}).
```

`cinemeta` and `tmdb` count fresh lookups, `hits` come from the cache, and
`misses` are titles no provider recognised. On the second start the same
library should log mostly `hits` and no provider calls at all.

---

## Troubleshooting

**A catalog tile reads "Gerbera unavailable — ..."**
The library could not be read; the tile carries the reason. Check the logs
(`docker compose logs -f stremio-gerbera-addon`) and confirm
`GERBERA_URL/description.xml` is reachable from inside the container:

```bash
docker exec stremio-gerbera-addon wget -qO- "$GERBERA_URL/description.xml" | head
```

**A container shows `unhealthy`, or keeps being restarted**
Read the report first — it names the fault:

```bash
docker exec stremio-gerbera-addon wget -qO- http://127.0.0.1:7100/health
```

`status: hung` means a library scan never returned, which is what the
restart is for. If it recurs, the Gerbera server is most likely accepting
connections but not answering; raising `SCAN_TIMEOUT_MINUTES` only makes the
addon wait longer. A `degraded` status never triggers a restart, so if the
container is restarting the cause is elsewhere — check the logs.

**`Entity expansion limit exceeded` in the logs**
A ContentDirectory response carries its DIDL-Lite payload inside `<Result>` as
an XML-escaped string, so every markup character arrives as an entity —
thousands per page. fast-xml-parser 4.5.3 and later cap entity expansion at
1000 by default, which aborts the parse on any non-trivial library. The addon
avoids this by parsing SOAP envelopes with entity processing disabled and
unescaping the payload itself, so this should not occur; if it reappears after
changing dependencies, check that `soapParser` in [`gerbera.js`](gerbera.js)
still sets `processEntities: false`.

Dependencies are pinned through `package-lock.json` and installed with
`npm ci`, so a rebuild cannot silently pick up a parser version that behaves
differently.

**`socket hang up` in the logs**
Gerbera closes the TCP connection after every SOAP response while Node keeps
connections alive by default, so pooled sockets go stale. The addon disables
keep-alive explicitly for this reason; if you fork the UPnP code, keep the
custom `http.Agent({ keepAlive: false })` in [`gerbera.js`](gerbera.js).
Adding a `Connection: close` header is *not* a substitute — Node still reuses
a pooled socket for the next request.

**Stremio refuses to install the addon**
The certificate is not trusted on that machine, or it has no
`subjectAltName`. See [HTTPS](#https-why-its-required).

**The catalog is empty on a Samsung (Tizen) or LG (webOS) TV, but fine elsewhere**
Almost always the certificate: a TV has no trust store you can add to, and the
Stremio app on it reports nothing when TLS fails — just an empty catalog. A
certificate from a real authority is the fix, see
[When a client cannot be made to trust it](#when-a-client-cannot-be-made-to-trust-it).

To confirm before changing anything, follow the logs and open the catalog on
the TV:

```bash
docker compose logs -f stremio-gerbera-addon caddy
```

No request arriving at all is TLS or the network. A request that arrives and
answers `200` means the TV reached the addon, and the cause is elsewhere: the
catalogs live under **Discover**, not on the home screen, and posters served
by Gerbera over plain HTTP are blocked as mixed content on some builds, which
leaves cards blank but titled.

**A film is in the catalog but not offered in search**
Its filename did not resolve to an IMDb id. It remains playable from the
**Gerbera — Movies** catalog. Renaming the file closer to the official title,
with the release year, usually fixes it.

**Series are not detected**
Episode detection relies on `S02E01`, `2x01` or `Season 2 Episode 1` in the
filename, plus whatever
[`parse-torrent-title`](https://www.npmjs.com/package/parse-torrent-title)
recognises beyond those. A file with no episode marker at all is treated as a
movie or an other clip.

**Cards still show filenames, with no poster**
Check `/health` first — during the first scan after an upgrade the catalog is
served before the metadata is in:

```bash
docker exec stremio-gerbera-addon wget -qO- http://127.0.0.1:7100/health
```

`enriching: true` means it is still working; give it a few minutes on a large
library. If `enriching` is `false` and `enriched` is `0`, the pass found
nothing — confirm `META_ENRICH` is not set to `false`, and that the container
can reach the internet:

```bash
docker exec stremio-gerbera-addon wget -qO- https://v3-cinemeta.strem.io/meta/movie/tt0397313.json | head -c 200
```

Individual titles that stay bare are simply unrecognised; see the next two
entries.

**`TMDB rejected the API key (401)` in the logs**
The key is wrong, or it is the *Read Access Token* rather than the **API Key
(v3 auth)** — only the short 32-character hex string works here. TMDB
switches itself off for the rest of the run after the first rejection, so the
addon keeps going on Cinemeta alone. Fix the key and recreate the container.

**A title got matched to the wrong film**
Rename the file closer to `Title (Year).ext` and rescan. The wrong record is
cached, so clear it too:

```bash
docker compose stop stremio-gerbera-addon
rm cache/meta.json
docker compose up -d
```

That forces a full re-fetch of the whole library, which is the slow path —
there is no per-title invalidation. A miss expires on its own after
`META_MISS_TTL_DAYS`, so a title nothing recognised today is retried in a few
days without any intervention.

**Metadata did not change after renaming files**
Renaming produces a new title, so it is looked up fresh — but only on the
next rescan, up to `REFRESH_MINUTES` later. `docker compose restart
stremio-gerbera-addon` triggers one immediately.

**A show's page lists episodes that are not on the server**
Expected. A recognised series is published under its IMDb id, so Stremio
renders the provider's full episode list; only the episodes you actually have
return a Gerbera source. Series the providers do not recognise are drawn by
the addon itself and list local episodes only.

---

## Limitations

- The Gerbera server has to be reachable from the Stremio client, exactly as
  with ordinary DLNA playback. Watching from outside the house needs a VPN or
  a tunnel, like any other self-hosted service.
- There is no transcoding. Playback depends on the Stremio client supporting
  the container and codec of the file.
- A card is only as good as the filename behind it. A file the providers
  cannot be matched to falls back to its parsed name and the Gerbera
  thumbnail; renaming it closer to `Title (Year).ext` usually fixes that on
  the next rescan.
- Opening a recognised series lands on the provider's page, which lists every
  episode of the show — including the ones you do not have. Those open onto
  whatever other addons offer, or onto an empty source list.
- `META_LANG` only reaches TMDB. Cinemeta always answers in English, so a
  non-English setting produces a mix of the two.

---

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
