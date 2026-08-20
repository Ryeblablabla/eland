import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "../../../..");
export const RUN_DATA_DIRECTORY = path.resolve(
  process.env.THREEBODY_DATA_DIR ?? path.join(PROJECT_DIRECTORY, "data"),
);

/**
 * Bundle the TypeScript storage adapter for plain Node.js maintenance scripts.
 * The caller owns the returned lifecycle and must always invoke close().
 */
export async function openSqliteRunReader() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "eland-sqlite-run-reader-"));
  const bundlePath = path.join(bundleDirectory, "sqlite-run-store.mjs");
  let store;
  try {
    await build({
      entryPoints: [path.join(PROJECT_DIRECTORY, "server", "sqlite-run-store.ts")],
      outfile: bundlePath,
      absWorkingDir: PROJECT_DIRECTORY,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      logLevel: "silent",
    });
    const module = await import(`${pathToFileURL(bundlePath).href}?reader=${Date.now()}`);
    store = new module.SqliteRunStore(RUN_DATA_DIRECTORY, { readOnly: true });
    let closed = false;
    return {
      store,
      async close() {
        if (closed) return;
        closed = true;
        try {
          store.close();
        } finally {
          await rm(bundleDirectory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    store?.close();
    await rm(bundleDirectory, { recursive: true, force: true });
    throw error;
  }
}
