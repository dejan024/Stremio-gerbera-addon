FROM node:20-alpine

WORKDIR /app

# The lockfile is copied in as well, so the image always builds against the
# exact dependency versions the addon was tested with.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY index.js gerbera.js parse.js cinemeta.js tmdb.js meta.js cache.js library.js ./

# Resolved IMDb ids and metadata records; mount a volume here so they survive
# restarts, otherwise the whole library is looked up again on every start.
RUN mkdir -p /app/cache
ENV PORT=7100
ENV CACHE_FILE=/app/cache/imdb.json
ENV META_CACHE_FILE=/app/cache/meta.json
EXPOSE 7100

# Marks the container unhealthy when /health reports a fault a restart can
# clear (a scan that hung), or when the process stops answering altogether.
# An unreachable Gerbera server keeps the container healthy on purpose — see
# health() in library.js. Restarting on unhealthy needs a watchdog; the
# compose file wires one up.
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "index.js"]
