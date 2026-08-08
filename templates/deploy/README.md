# templates/deploy/

Files copied into a generated Next.js app so it can build and run on
Scaleway Serverless Containers (`fr-par`). Not consumed by the generic
add-\* feature/detect system - `/bootstrap` and `/deploy` copy these files
directly, and CONTRACT.md records the platform facts these files encode.

| File | Destination in the generated app | What it's for |
|---|---|---|
| `Dockerfile` | `Dockerfile` | Multi-stage build (`deps` → `builder` → `runner`) producing a small `node:24-alpine` image from the Next 16 `output: 'standalone'` build. |
| `copy-assets.js` | `copy-assets.js` | Restores `.next/static/` and `public/` into `.next/standalone/` after `next build`, since standalone mode does not copy them itself. Run from the Dockerfile's `builder` stage. |
| `next.config.js` | `next.config.js` | Sets `output: 'standalone'` and `next/image` remote-pattern config for Scaleway-hosted images. |
| `proxy.ts` | `src/proxy.ts` | The `ACCESS_RESTRICTED` / `ACCESS_ALLOWED_IPS` IP-allowlist gate from CONTRACT.md §6, with real IPv4/IPv6 CIDR matching. |

There is no CI workflow file in this set: the image is built and pushed
directly by whichever machine runs `/bootstrap` or `/deploy` (`docker build`
+ `docker push`, `scripts/_docker-build.mjs`, CONTRACT.md §5) - never GitHub
Actions.

## Three failure modes to remember

These are the ones that let a deploy *look* successful while actually being
broken, which is what makes them worth writing down here instead of trusting
memory:

1. **arm64 image.** Serverless Containers accept `amd64` only. An arm64
   image (default on Apple Silicon, or any non-x86 build machine) builds and
   pushes cleanly and then fails **only at deploy time** on Scaleway's side.
   `scripts/_docker-build.mjs` passes `--platform linux/amd64` unconditionally
   on every build - don't let that flag become conditional or optional in a
   later edit.

2. **Missing `copy-assets.js` step.** `output: 'standalone'` does not copy
   `.next/static/` or `public/` into `.next/standalone/`. Skip the
   copy-assets step in the Dockerfile and the container deploys, passes its
   health check, and serves a completely unstyled page - no CSS, no client
   JS, no images - for every real visitor. This is the single most likely
   way this template set gets silently broken by a future edit that
   "simplifies" the Dockerfile.

3. **Binding `127.0.0.1`.** The container must listen on `0.0.0.0:8080`
   (`ENV HOSTNAME=0.0.0.0`, `ENV PORT=8080` in the Dockerfile). Scaleway's
   health probes connect over the network, not over loopback; binding
   `127.0.0.1` makes the container start, log "ready", and then fail every
   health check forever - it deploys but never becomes ready.

## Also worth knowing

- `proxy.ts` is an **application-layer** gate, not a firewall.
  Scaleway has no network-level IP filtering for Serverless Containers - DNS
  still resolves, TLS still completes. Never describe this to a user as a
  firewall.
- Custom-domain TLS (HTTP-01 challenge) has a hard 3-minute window and fails
  into a permanently unrecoverable `error` state - that's why
  `/.well-known/acme-challenge/` is exempted from the IP gate unconditionally.
- The health-check path is also exempted unconditionally: health checks
  don't wake a scaled-to-zero container (CONTRACT.md §1), but they DO run
  continuously against a running one, from outside the VPN. Blocking the
  probe kills all traffic to the container, including from allowed IPs.
- Container Registry has no retention policy - old tags accumulate forever
  unless something prunes them (see `registry.mjs: pruneTags`). Not this
  template's job, just don't be surprised the registry keeps growing.
