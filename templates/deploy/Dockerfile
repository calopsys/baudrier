# syntax=docker/dockerfile:1
#
# templates/deploy/Dockerfile - multi-stage build for Scaleway Serverless
# Containers (region fr-par). See templates/deploy/README.md for the three
# failure modes this file exists to prevent.
#
# Build with (see scripts/_docker-build.mjs for the real invocation, run
# directly by /bootstrap and /deploy - no CI involved, CONTRACT.md §5):
#   docker build --platform linux/amd64 \
#     --build-arg SKIP_ENV_VALIDATION=1 \
#     -t rg.fr-par.scw.cloud/<namespace>/<app>:<sha> .
#
# --platform linux/amd64 is MANDATORY and is passed by the harness's build
# script, not by this file - Dockerfiles cannot force the platform of the
# build they're invoked with. Serverless Containers accept amd64 images
# ONLY. An arm64 image (e.g. built by default on an Apple Silicon laptop)
# builds and pushes without a single error, then fails only at deploy time
# on Scaleway's side.

# -----------------------------------------------------------------------------
# Stage 1/3 - deps: install dependencies in their own layer
# -----------------------------------------------------------------------------
# Kept separate from the `builder` stage so Docker's layer cache is reused
# across builds where only application source changed, not package.json /
# pnpm-lock.yaml. libc6-compat is required on Alpine's musl libc by several
# native npm packages.
#
# `sharp` (next/image's optimizer, see next.config.js) is installed here as
# an ordinary dependency. Because `pnpm install` runs INSIDE this Alpine
# container, its postinstall step fetches the correct linux-musl-x64 binary
# automatically - no extra flags needed. Unlike a managed platform (which
# offloads image optimisation to a CDN), on a self-hosted container every
# optimised image request burns the container's own CPU/mvCPU budget.
FROM node:24-alpine AS deps
# proxy-ca.crt is written into the build context by scripts/_docker-build.mjs
# on every build: the Claude Code web egress proxy re-terminates TLS, and
# without its CA in the system bundle apk/corepack/pnpm all fail with
# "server certificate not trusted" (live-verified). Off web the file is
# empty and the append is a no-op. The runner stage never inherits it.
COPY proxy-ca.crt /tmp/proxy-ca.crt
RUN cat /tmp/proxy-ca.crt >> /etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml must travel with the lockfile: pnpm 11 reads its
# `allowBuilds:` entries to approve native postinstall scripts (sharp,
# esbuild, ...) and fails the install without it - verified on a live build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2/3 - builder: run `next build` and assemble the standalone output
# -----------------------------------------------------------------------------
# SKIP_ENV_VALIDATION=1 is required at build time: T3's src/env.js validates
# env vars (DATABASE_URL, AUTH_SECRET, ...) with zod at import time, and none
# of those exist yet during `docker build` - they only exist once the
# harness writes them into the container's secret_environment_variables at
# deploy time. Without this, `next build` throws and the image never builds.
FROM node:24-alpine AS builder
# Same proxy CA trust as the deps stage: corepack fetches pnpm here, and
# `next build` can fetch build-time assets (next/font).
COPY proxy-ca.crt /tmp/proxy-ca.crt
RUN cat /tmp/proxy-ca.crt >> /etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG SKIP_ENV_VALIDATION=1
ENV SKIP_ENV_VALIDATION=${SKIP_ENV_VALIDATION}

RUN pnpm build

# `output: 'standalone'` (see next.config.js) traces the minimal server into
# .next/standalone/ but deliberately leaves out .next/static/ and public/ -
# copy-assets.js puts them back before the runner stage copies
# .next/standalone/ wholesale. Skipping this step is the #1 way this setup
# breaks: the container deploys, passes its health check, and serves a
# completely unstyled page because none of the CSS/JS chunks/images shipped.
#
# --chmod=755 rather than relying on the build context's own exec bit: a
# fresh git checkout does not guarantee one is set.
COPY --chmod=755 copy-assets.js ./copy-assets.js
RUN node copy-assets.js

# -----------------------------------------------------------------------------
# Stage 3/3 - runner: minimal runtime image
# -----------------------------------------------------------------------------
# Only the standalone server + its traced node_modules + static/public ship
# here - not the full source tree, not devDependencies, not the pnpm store.
# This is what gets the image down to roughly ~200MB vs ~547MB for a naive
# `pnpm install --prod && pnpm start` image that carries a full
# node_modules tree. Scaleway recommends staying under 1GB; standalone
# leaves comfortable headroom.
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Scaleway's health probes hit the container over the network, not over
# loopback. Binding 127.0.0.1 makes the container start, log "ready", and
# then fail every health check forever - it deploys but never becomes
# ready. This is the single most common cause of that failure mode, and
# 0.0.0.0 is not optional.
ENV HOSTNAME=0.0.0.0
ENV PORT=8080

# Run as non-root - standard container hardening, free to do here.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# copy-assets.js already merged .next/static and public/ into
# .next/standalone/ during the builder stage, so a single copy of the
# standalone directory brings everything the server needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

# migrate.mjs and drizzle/ ship in the image because the migration Job
# (scripts/deploy.mjs) runs on this SAME image, and the standalone copy
# above has no devDependencies, no drizzle-kit and no drizzle/*.sql of its
# own. Both come straight from the build context, not the builder stage -
# neither needs a build step. bootstrap-init.mjs guarantees
# drizzle/meta/_journal.json exists even with zero migrations generated yet,
# so this COPY never fails on a fresh project - migrate.mjs's own no-op path
# (empty journal) covers that case at runtime instead.
COPY --chown=nextjs:nodejs migrate.mjs ./migrate.mjs
COPY --chown=nextjs:nodejs drizzle ./drizzle

USER nextjs

EXPOSE 8080

CMD ["node", "server.js"]
