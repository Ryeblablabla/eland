import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "threebody-audit-"));
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
  const report = mod.auditOriginReachability();
  console.log(JSON.stringify({
    auditedAt: report.auditedAt,
    targetCount: report.targetIds.length,
    reachedCount: report.reachedIds.length,
    allReachable: report.allReachable,
    missingIds: report.missingIds,
    reached: report.evidence.map((e) => ({ id: e.milestoneId, label: e.label, year: e.reachedAtYear })),
    scenarios: report.scenarios.map((s) => ({ name: s.name, years: s.simulatedYears, reached: s.reachedIds.length, outcome: s.outcome?.kind ?? "running" })),
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
