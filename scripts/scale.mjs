#!/usr/bin/env node
// scale.mjs - apply/read the S/M/L/XL scale presets on a container (CONTRACT.md
// §3 SCALE_PRESETS in container.mjs, §1 DEFAULT_* constants). Never re-hardcodes
// the preset numbers - always reads them from container.mjs's SCALE_PRESETS so
// the two files can't drift.
//
// Each preset moves CPU, memory AND max-concurrency TOGETHER, on purpose:
// Scaleway's platform default for max-concurrency is 80 requests/instance,
// which at the S preset's 250 mvCPU collapses (requests queue, then time out)
// long before Scaleway's autoscaler notices and spins up a second instance.
// That's why S pins max-concurrency down to 8 instead of leaving it at 80.
//
// Cost estimates below are computed from Scaleway's published Serverless
// Containers pricing (https://www.scaleway.com/en/pricing/serverless/,
// checked 2026-07-30): €0.00001 / vCPU-second with a 200,000 vCPU-second
// free tier per account per month, and €0.000002 / GB-second with a 400,000
// GB-second free tier per account per month. Not fetched live - Scaleway has
// no pricing API, so these two constants would need a manual refresh if
// Scaleway changes its rates.

import { previewContainerName, requireCredentials, slugify } from "./scaleway/_scw-auth.mjs";
import { SCALE_PRESETS, ensureNamespace, findContainerByName, updateContainer, waitForContainerReady } from "./scaleway/container.mjs";
import { getDatabase, setDatabaseCpuBounds, DB_CPU_MIN_DEFAULT, DB_CPU_MAX_DEFAULT } from "./scaleway/sdb.mjs";
import { pathToFileURL } from "node:url";

const VCPU_PRICE_PER_SEC = 0.00001;
const FREE_VCPU_SECONDS_PER_MONTH = 200_000;
const MEM_PRICE_PER_GB_SEC = 0.000002;
const FREE_GB_SECONDS_PER_MONTH = 400_000;
const SECONDS_PER_MONTH = 30 * 24 * 3600;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Estimated €/month if the container runs a SINGLE instance 24/7 (i.e.
 * min_scale=1, no extra autoscaled instances beyond the first). This is the
 * "always warm" upper bound one instance can cost - real spend with
 * min_scale=0 and bursty traffic is normally far lower (see note in the
 * human-readable output).
 */
function estimateAlwaysOnCost(preset) {
  const vcpu = preset.cpuLimit / 1000;
  const gb = preset.memoryLimit / 1000;
  const vcpuSeconds = vcpu * SECONDS_PER_MONTH;
  const gbSeconds = gb * SECONDS_PER_MONTH;
  const billableVcpuSeconds = Math.max(0, vcpuSeconds - FREE_VCPU_SECONDS_PER_MONTH);
  const billableGbSeconds = Math.max(0, gbSeconds - FREE_GB_SECONDS_PER_MONTH);
  const cost = billableVcpuSeconds * VCPU_PRICE_PER_SEC + billableGbSeconds * MEM_PRICE_PER_GB_SEC;
  return round2(cost);
}

function presetsWithCosts() {
  return Object.fromEntries(
    Object.entries(SCALE_PRESETS).map(([name, preset]) => [
      name,
      { ...preset, estimatedMonthlyCostAlwaysOnEur: estimateAlwaysOnCost(preset) },
    ]),
  );
}

/* ------------------------------------------------------------------ args */

const [cmd, ...rest] = process.argv.slice(2);
function flag(name, def) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = rest[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

function usage() {
  console.log(
    "usage: scale.mjs <presets|current|apply|db-current|db-apply> [options]\n" +
      "  presets                                          list S/M/L/XL with cost estimates\n" +
      "  current --project-name X --target production|preview [--branch b]\n" +
      "  apply   --project-name X --target production|preview [--branch b] --preset S|M|L|XL [--min-scale N] [--max-concurrency N]\n" +
      "  db-current --project-name X                      show the database's autoscaling bounds\n" +
      `  db-apply   --project-name X --min-cpu N --max-cpu N   change them (0 <= min <= max <= 15; new databases start at ${DB_CPU_MIN_DEFAULT}-${DB_CPU_MAX_DEFAULT})\n`,
  );
}

function resolveContainerName(projectName, target, branch) {
  if (target === "production") return projectName;
  if (!branch) throw new Error("--branch is required when --target preview");
  return previewContainerName(projectName, branch);
}

async function findContainerOrFail(projectName, target, branch) {
  const ns = await ensureNamespace(projectName);
  const name = resolveContainerName(projectName, target, branch);
  const container = await findContainerByName(ns.id, name);
  if (!container) {
    console.log(`⚠️ no container named "${slugify(name)}" in namespace "${ns.name}" - run /deploy first.`);
    console.log(JSON.stringify({ ok: false, error: "container_not_found" }));
    process.exit(1);
  }
  return container;
}

/* ------------------------------------------------------------------- CLI */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  (async () => {
    switch (cmd) {
      case "presets": {
        const presets = presetsWithCosts();
        console.log("▸ scale presets (CPU/mémoire/concurrence liées, coût estimé si l'instance tourne 24h/24)");
        for (const [name, p] of Object.entries(presets)) {
          console.log(
            `  ${name}: ${p.cpuLimit} mvCPU · ${p.memoryLimit} MB · ${p.maxConcurrency} req/instance simultanées · ~${p.estimatedMonthlyCostAlwaysOnEur} €/mois si toujours allumé (min_scale=1)`,
          );
        }
        console.log("✅ presets listed");
        console.log(JSON.stringify({ ok: true, presets }));
        break;
      }

      case "current": {
        const projectName = flag("project-name");
        const target = flag("target");
        const branch = flag("branch");
        if (!projectName || !target) {
          usage();
          process.exit(1);
        }
        requireCredentials();
        console.log(`▸ reading current scale for ${projectName} (${target}${branch ? `, ${branch}` : ""})`);
        const container = await findContainerOrFail(projectName, target, branch);
        const current = {
          containerId: container.id,
          name: container.name,
          cpuLimit: container.cpu_limit,
          memoryLimit: container.memory_limit,
          maxConcurrency: container.max_concurrency,
          minScale: container.min_scale,
          maxScale: container.max_scale,
          status: container.status,
        };
        const matchedPreset = Object.entries(SCALE_PRESETS).find(
          ([, p]) => p.cpuLimit === current.cpuLimit && p.memoryLimit === current.memoryLimit && p.maxConcurrency === current.maxConcurrency,
        );
        current.matchedPreset = matchedPreset ? matchedPreset[0] : null;
        console.log(`✅ current: ${JSON.stringify(current)}`);
        console.log(JSON.stringify({ ok: true, current }));
        break;
      }

      case "apply": {
        const projectName = flag("project-name");
        const target = flag("target");
        const branch = flag("branch");
        const presetName = flag("preset");
        const minScaleArg = flag("min-scale");
        const maxConcurrencyArg = flag("max-concurrency");
        if (!projectName || !target || !presetName) {
          usage();
          process.exit(1);
        }
        const preset = SCALE_PRESETS[presetName];
        if (!preset) {
          console.log(`⚠️ unknown preset "${presetName}" - must be one of: ${Object.keys(SCALE_PRESETS).join(", ")}`);
          console.log(JSON.stringify({ ok: false, error: "unknown_preset" }));
          process.exit(1);
        }
        requireCredentials();
        const container = await findContainerOrFail(projectName, target, branch);

        const patch = {
          cpuLimit: preset.cpuLimit,
          memoryLimit: preset.memoryLimit,
          maxConcurrency: preset.maxConcurrency,
        };
        if (minScaleArg !== undefined) {
          const minScale = Number(minScaleArg);
          if (!Number.isInteger(minScale) || minScale < 0) {
            console.log(`⚠️ --min-scale must be a non-negative integer, got "${minScaleArg}"`);
            console.log(JSON.stringify({ ok: false, error: "invalid_min_scale" }));
            process.exit(1);
          }
          patch.minScale = minScale;
        }
        if (maxConcurrencyArg !== undefined) {
          // Applied AFTER the preset on purpose: this lets a landing (Caddy,
          // IO-light) take M/L cpu/mem while keeping concurrency at 80 - the
          // platform's own default, which the preset would otherwise lower.
          const maxConcurrency = Number(maxConcurrencyArg);
          if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 80) {
            console.log(`⚠️ --max-concurrency must be an integer between 1 and 80, got "${maxConcurrencyArg}"`);
            console.log(JSON.stringify({ ok: false, error: "invalid_max_concurrency" }));
            process.exit(1);
          }
          patch.maxConcurrency = maxConcurrency;
        }

        console.log(`▸ applying preset ${presetName} to ${container.name} (${projectName}, ${target})`);
        await updateContainer(container.id, patch);
        console.log("▸ waiting for the container to come back ready...");
        const ready = await waitForContainerReady(container.id, { timeoutMs: 300_000 });
        const result = {
          containerId: ready.id,
          preset: presetName,
          cpuLimit: ready.cpu_limit,
          memoryLimit: ready.memory_limit,
          maxConcurrency: ready.max_concurrency,
          minScale: ready.min_scale,
          status: ready.status,
          estimatedMonthlyCostAlwaysOnEur: estimateAlwaysOnCost(preset),
        };
        console.log(`✅ preset ${presetName} applied, container ready`);
        console.log(JSON.stringify({ ok: true, ...result }));
        break;
      }

      case "db-current": {
        const projectName = flag("project-name");
        if (!projectName) {
          usage();
          process.exit(1);
        }
        const db = await getDatabase(projectName);
        if (!db) {
          console.log(`⚠️ aucune base de données Serverless SQL nommée "${slugify(projectName)}" - lancez /add-db d'abord.`);
          console.log(JSON.stringify({ ok: false, error: "database_not_found" }));
          process.exit(1);
        }
        console.log(`▸ base "${db.name}" : autoscaling ${db.cpuMin} → ${db.cpuMax} vCPU (statut ${db.status})`);
        console.log(
          JSON.stringify({
            ok: true,
            databaseId: db.id,
            name: db.name,
            cpuMin: db.cpuMin,
            cpuMax: db.cpuMax,
            defaults: { cpuMin: DB_CPU_MIN_DEFAULT, cpuMax: DB_CPU_MAX_DEFAULT },
            status: db.status,
          }),
        );
        break;
      }

      case "db-apply": {
        const projectName = flag("project-name");
        const minCpu = Number(flag("min-cpu"));
        const maxCpu = Number(flag("max-cpu"));
        if (!projectName || Number.isNaN(minCpu) || Number.isNaN(maxCpu)) {
          usage();
          process.exit(1);
        }
        console.log(`▸ application des bornes d'autoscaling ${minCpu} → ${maxCpu} vCPU`);
        const db = await setDatabaseCpuBounds(projectName, { minCpu, maxCpu });
        console.log(`✅ base "${db.name}" : autoscaling ${db.cpuMin} → ${db.cpuMax} vCPU`);
        console.log(
          JSON.stringify({ ok: true, databaseId: db.id, name: db.name, cpuMin: db.cpuMin, cpuMax: db.cpuMax, status: db.status }),
        );
        break;
      }

      default:
        usage();
        process.exitCode = 1;
    }
  })().catch((e) => {
    console.log(`⚠️ ${e.message}`);
    console.log(JSON.stringify({ ok: false, error: e.message, type: e.type, details: e.details }));
    process.exitCode = 1;
  });
}
