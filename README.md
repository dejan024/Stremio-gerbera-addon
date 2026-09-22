# Stremio Gerbera Addon

A [Stremio](https://www.stremio.com/) addon that turns a local
[Gerbera](https://gerbera.io/) DLNA/UPnP media server into a first-class
source inside Stremio.

It does two things:

1. **Catalogs** — your movies, series and other clips from the Gerbera server,
   browsable straight from Stremio.
2. **Local source** — when you open *any* movie or episode in Stremio through
   its normal search, the addon checks whether that exact title sits on your
   Gerbera server and, if it does, offers it in the source list as
   **Gerbera → Local network**.

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

Edit `.env` and point `GERBERA_URL` at your server, then generate a
certificate (see [HTTPS](#https-why-its-required) below) and start it:

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

---

## Configuration

Everything is configured through environment variables. Copy `.env.example` to
`.env` and adjust:

| Variable | Default | Description |
|---|---|---|
| `GERBERA_URL` | `http://127.0.0.1:49494` | Base URL of the Gerbera server |
| `PORT` | `7100` | Port the addon listens on (behind Caddy) |
| `HTTPS_PORT` | `7443` | Port Caddy serves HTTPS on |
| `REFRESH_MINUTES` | `30` | How often the library is rescanned |
| `MATCH_IMDB` | `true` | Resolve local titles to IMDb ids via Cinemeta |
| `CACHE_FILE` | `/app/cache/imdb.json` | Where resolved IMDb ids are cached |

`GERBERA_URL` must be the UPnP port, which is the same port that serves the
Gerbera web UI — check `http://<host>:<port>/description.xml` returns XML.

---

## Running without Docker

Works directly only if Stremio runs on the same machine (the `127.0.0.1`
exemption); otherwise put a TLS reverse proxy in front of it.

```bash
npm install
GERBERA_URL=http://192.168.1.10:49494 PORT=7100 npm start
```

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
ExecStart=/usr/bin/node index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

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
   for series — a season and episode number. It distinguishes scene releases
   (`1080p`, `x264`, `YIFY`, …) from music videos and home recordings, so the
   latter do not pollute the movie catalog.
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

### Project layout

| File | Responsibility |
|---|---|
| [`gerbera.js`](gerbera.js) | UPnP/SOAP client, deduplication |
| [`parse.js`](parse.js) | Filename → title, year, season, episode |
| [`cinemeta.js`](cinemeta.js) | IMDb id lookups, on-disk cache |
| [`library.js`](library.js) | In-memory library state, periodic refresh |
| [`index.js`](index.js) | Stremio manifest and request handlers |

---

## Verifying it works

Without touching Stremio:

```bash
curl -sk https://localhost:7443/manifest.json
```

```bash
curl -sk https://localhost:7443/catalog/movie/gerbera-movies.json
```

```bash
curl -sk https://localhost:7443/stream/movie/tt0086567.json
```

The last call should return a local source if that film is in your library.
Substitute an IMDb id you actually have.

Startup logs should look like this:

```
Scanning Gerbera server: http://192.168.1.10:49494
Done in 2110ms: 301 files -> 14 movies, 1 series (10 episodes), 277 other clips.
Matched 19 titles to an IMDb id.
```

---

## Troubleshooting

**A catalog tile reads "Gerbera unavailable — ..."**
The library could not be read; the tile carries the reason. Check the logs
(`docker compose logs -f stremio-gerbera-addon`) and confirm
`GERBERA_URL/description.xml` is reachable from inside the container:

```bash
docker exec stremio-gerbera-addon wget -qO- "$GERBERA_URL/description.xml" | head
```

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

**A film is in the catalog but not offered in search**
Its filename did not resolve to an IMDb id. It remains playable from the
**Gerbera — Movies** catalog. Renaming the file closer to the official title,
with the release year, usually fixes it.

**Series are not detected**
Episode detection relies on `S02E01`, `2x01` or `Season 2 Episode 1` appearing
in the filename. Files without one of those patterns are treated as movies or
other clips.

---

## Limitations

- The Gerbera server has to be reachable from the Stremio client, exactly as
  with ordinary DLNA playback. Watching from outside the house needs a VPN or
  a tunnel, like any other self-hosted service.
- There is no transcoding. Playback depends on the Stremio client supporting
  the container and codec of the file.
- Metadata for catalog entries comes from the filenames and Gerbera
  thumbnails, not from an online database.

---

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
