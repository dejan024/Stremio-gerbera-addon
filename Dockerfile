FROM node:20-alpine

WORKDIR /app

# The lockfile is copied in as well, so the image always builds against the
# exact dependency versions the addon was tested with.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY index.js gerbera.js parse.js cinemeta.js library.js ./

# Cache of resolved IMDb ids; mount a volume here so it survives restarts.
RUN mkdir -p /app/cache
ENV PORT=7100
ENV CACHE_FILE=/app/cache/imdb.json
EXPOSE 7100

CMD ["node", "index.js"]
