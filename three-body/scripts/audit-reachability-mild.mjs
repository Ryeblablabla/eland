import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "threebody-audit2-"));
const bundlePath = path.join(temporaryDirectory, "simulation.mjs");

try {
  execFileSync(path.resolve("node_modules/.bin/esbuild"), [
    "src/game/eland/simulation.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${bundlePath}`,
  ], { stdio: "pipe" });
  const mod = await import(`${pathToFileURL(bundlePath).href}?audit=${Date.now()}`);
  const scenarios = [1, 2, 3].map((seed) => ({
    name: `温和恒纪元 seed=${seed}`,
    seed,
    config: { civilizationNo: 1, chaosIntensity: 0, climateBias: "balanced" },
    maximumYears: 200,
  }));
  const report = mod.auditOriginReachability(scenarios);
  console.log(JSON.stringify({
    targetCount: report.targetIds.length,
    reachedCount: report.reachedIds.length,
    allReachable: report.allReachable,
    missingIds: report.missingIds,
    reached: report.evidence.map((e) => ({ id: e.milestoneId, label: e.label, year: e.reachedAtYear, seed: e.seed })),
    scenarios: report.scenarios.map((s) => ({ seed: s.seed, years: s.simulatedYears, reached: s.reachedIds.length, outcome: s.outcome?.kind ?? "running" })),
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
