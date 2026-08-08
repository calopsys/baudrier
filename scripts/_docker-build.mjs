#!/usr/bin/env node
// _docker-build.mjs - the one direct build/push pipeline (CONTRACT.md §5),
// shared by bootstrap-init.mjs's first build and deploy.mjs's every later
// build. No GitHub Actions anywhere in this path: the machine running the
// harness builds the image itself and pushes it straight to the registry.
//
// --platform linux/amd64 is passed unconditionally on every build (CONTRACT.md
// §1's hard platform fact: Serverless Containers accept amd64 images only).
// The registry password travels via stdin only, never argv (CONTRACT.md §7 -
// same rule as every other secret write in this codebase).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRemoteSandbox } from "./_platform.mjs";
import { requireCredentials } from "./scaleway/_scw-auth.mjs";
import { listImages, listTags } from "./scaleway/registry.mjs";

export const DOCKER_PLATFORM = "linux/amd64";

// The Claude Code web egress proxy re-terminates TLS. Host tools trust its CA
// through this bundle, but processes INSIDE a docker build neither reach the
// 127.0.0.1 proxy nor trust that CA (live-verified: apk fails with "server
// certificate not trusted"). buildImage() therefore ships the bundle into the
// build context and runs the build on the host network (CONTRACT.md §1).
export const WEB_PROXY_CA_BUNDLE = "/root/.ccr/ca-bundle.crt";

/**
 * Does `imageName:tag` already exist in the registry namespace? Both
 * `/bootstrap` and `/deploy` skip the rebuild when it does (CONTRACT.md §5) -
 * a re-deploy of an unchanged commit must not pay for a second image build.
 * @returns {Promise<boolean>}
 */
export async function imageTagExists({ registryNamespaceId, imageName, tag }) {
  const images = await listImages(registryNamespaceId);
  const image = images.find((i) => i.name === imageName);
  if (!image) return false;
  const tags = await listTags(image.id);
  return tags.some((t) => t.name === tag);
}

/**
 * `docker login` against the Scaleway Container Registry, using the
 * operator's own SCW_SECRET_KEY as the password (username "nologin" - the
 * registry accepts any username with a valid API secret key).
 * @param {string} registryHost  e.g. "rg.fr-par.scw.cloud" (host only, no namespace path)
 */
export function dockerLogin(registryHost) {
  const creds = requireCredentials();
  const res = spawnSync("docker", ["login", registryHost, "-u", "nologin", "--password-stdin"], {
    input: creds.secretKey,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`docker login ${registryHost} failed: ${(res.stderr || res.stdout || "").trim()}`);
  }
}

/**
 * `docker build --platform linux/amd64`, tagged as `imageUri`.
 * @param {object} o
 * @param {string} o.projectDir
 * @param {string} o.imageUri
 * @param {Record<string,string>} [o.buildArgs]  same build-args the removed
 *   GitHub Actions workflow (templates/deploy/build.yml) used to pass
 */
export function buildImage({ projectDir, imageUri, buildArgs = { SKIP_ENV_VALIDATION: "1" } }) {
  const args = ["build", "--platform", DOCKER_PLATFORM];
  const onWeb = isRemoteSandbox();
  if (onWeb) {
    // --network host lets build RUN steps reach the 127.0.0.1 proxy; the
    // predefined proxy build-args become env vars inside every RUN step.
    args.push("--network", "host");
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
      if (process.env[key]) args.push("--build-arg", `${key}=${process.env[key]}`);
    }
  }
  for (const [key, value] of Object.entries(buildArgs)) args.push("--build-arg", `${key}=${value}`);
  args.push("-t", imageUri, ".");

  // The Dockerfile COPYs proxy-ca.crt unconditionally, so the file must
  // exist in every build context: the real CA bundle on web, empty
  // elsewhere (appending an empty file to the system bundle is a no-op).
  const caFile = join(projectDir, "proxy-ca.crt");
  const caContent = onWeb && existsSync(WEB_PROXY_CA_BUNDLE) ? readFileSync(WEB_PROXY_CA_BUNDLE) : "";
  writeFileSync(caFile, caContent);
  try {
    const res = spawnSync("docker", args, { cwd: projectDir, stdio: "inherit" });
    if (res.status !== 0) throw new Error(`docker build failed (exit ${res.status})`);
  } finally {
    rmSync(caFile, { force: true });
  }
}

/** `docker push imageUri`. */
export function pushImage(imageUri, projectDir) {
  const res = spawnSync("docker", ["push", imageUri], { cwd: projectDir, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`docker push failed (exit ${res.status})`);
}

/**
 * Build and push one image, skipping the rebuild when the exact tag already
 * exists in the registry (CONTRACT.md §5).
 *
 * @param {object} o
 * @param {string} o.projectDir
 * @param {string} o.registryEndpoint     e.g. "rg.fr-par.scw.cloud/<namespace>"
 * @param {string} [o.registryNamespaceId] when given, enables the skip-if-exists check
 * @param {string} o.imageName
 * @param {string} o.tag
 * @param {Record<string,string>} [o.buildArgs]
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{imageUri:string, skipped:boolean}>}
 */
export async function buildAndPushImage({
  projectDir,
  registryEndpoint,
  registryNamespaceId,
  imageName,
  tag,
  buildArgs,
  log = () => {},
}) {
  const imageUri = `${registryEndpoint}/${imageName}:${tag}`;

  if (registryNamespaceId) {
    const exists = await imageTagExists({ registryNamespaceId, imageName, tag });
    if (exists) {
      log(`Image already pushed under this tag, skipping the rebuild: ${imageUri}`);
      return { imageUri, skipped: true };
    }
  }

  const registryHost = registryEndpoint.split("/")[0];
  log(`Logging in to ${registryHost}`);
  dockerLogin(registryHost);

  log(`Building ${imageUri} (--platform ${DOCKER_PLATFORM})`);
  buildImage({ projectDir, imageUri, buildArgs });

  log(`Pushing ${imageUri}`);
  pushImage(imageUri, projectDir);

  return { imageUri, skipped: false };
}
