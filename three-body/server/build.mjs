import { build } from "esbuild";

await build({
  entryPoints: {
    main: "server/main.ts",
    "eland-worker": "server/eland-worker.ts",
    "run-evolution-worker": "server/run-evolution-worker.ts",
  },
  outdir: "dist-server",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "external",
});
