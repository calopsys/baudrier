# syntax=docker/dockerfile:1
#
# templates/landing/Dockerfile - multi-stage build for a static Astro site,
# served by Caddy on Scaleway Serverless Containers (region fr-par).
#
# Build with (see scripts/_docker-build.mjs for the real invocation, run
# directly by /bootstrap and /deploy - no CI involved, CONTRACT.md §5):
#   docker build --platform linux/amd64 \
#     -t rg.fr-par.scw.cloud/<namespace>/<app>:<sha> .
#
# --platform linux/amd64 is MANDATORY and is passed by the harness's build
# script, not by this file - Dockerfiles cannot force the platform of the
# build they're invoked with. Serverless Containers accept amd64 images
# ONLY. An arm64 image builds and pushes without a single error, then fails
# only at deploy time on Scaleway's side.

# -----------------------------------------------------------------------------
# Stage 1/3 - deps: install dependencies in their own layer
# -----------------------------------------------------------------------------
# Kept separate from the `builder` stage so Docker's layer cache is reused
# across builds where only application source changed, not package.json /
# pnpm-lock.yaml.
FROM node:24-alpine AS deps
# proxy-ca.crt is written into the build context by scripts/_docker-build.mjs
# on every build: the Claude Code web egress proxy re-terminates TLS, and
# without its CA in the system bundle apk/corepack/pnpm all fail with
# "server certificate not trusted" (live-verified). Off web the file is
# empty and the append is a no-op. The runner stage never inherits it.
COPY proxy-ca.crt /tmp/proxy-ca.crt
RUN cat /tmp/proxy-ca.crt >> /etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml must travel with the lockfile: it carries the
# supply-chain age floor written by scaffoldLanding() (CONTRACT.md §3).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2/3 - builder: run `astro build`
# -----------------------------------------------------------------------------
FROM node:24-alpine AS builder
# Same proxy CA trust as the deps stage: corepack fetches the pnpm binary
# here too.
COPY proxy-ca.crt /tmp/proxy-ca.crt
RUN cat /tmp/proxy-ca.crt >> /etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
RUN corepack enable
# _docker-build.mjs passes --build-arg SKIP_ENV_VALIDATION=1 unconditionally
# for both stacks (templates/deploy/Dockerfile consumes it; a vitrine has no
# env validation to skip). Declared, not ENV'd, so it is consumed and the
# build stops warning about an unused build arg - Astro reads nothing from it.
ARG SKIP_ENV_VALIDATION=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# -----------------------------------------------------------------------------
# Stage 3/3 - runner: Caddy serving the static build
# -----------------------------------------------------------------------------
# No CA block here: this image never makes an outbound HTTPS call of its own
# (auto_https is off, no ACME - see Caddyfile) and installs nothing over the
# network at container start.
FROM caddy:2-alpine AS runner
# Runs as a non-root user, not the image's default root. docker-entrypoint.sh
# writes /etc/caddy/gate.caddy at container start, so that directory (not
# only /srv) must be writable by the user CMD actually runs as.
RUN addgroup -S -g 1001 baudrier && adduser -S -u 1001 -G baudrier baudrier
COPY --from=builder /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
# --chmod=755 rather than trusting the build context's own exec bit: a
# fresh git checkout does not guarantee one is set.
COPY --chmod=755 docker-entrypoint.sh /docker-entrypoint.sh
RUN chown -R baudrier:baudrier /srv /etc/caddy /config /data
USER baudrier
EXPOSE 8080
CMD ["/docker-entrypoint.sh"]
