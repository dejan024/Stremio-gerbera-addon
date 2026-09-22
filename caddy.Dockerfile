# Caddy with the Cloudflare DNS module compiled in.
#
# The stock caddy image cannot solve the ACME DNS-01 challenge, and DNS-01 is
# the only challenge that works here: the addon answers on port 7443 and its
# hostname points at a LAN address, so Let's Encrypt can reach neither port 80
# (HTTP-01) nor port 443 (TLS-ALPN-01). Proving control over the DNS record
# instead keeps the whole setup off the public internet.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
