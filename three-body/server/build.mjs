import { build } from "esbuild";

await build({
  entryPoints: ["server/main.ts"],
  outfile: "dist-server/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "external",
});

