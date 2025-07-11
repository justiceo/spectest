import { build } from "esbuild";

await build({
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "external",
  entryPoints: [
    "src/cli.ts",
    "src/helpers.ts",
    "src/generate-openapi.ts",
  ],
  outdir: "dist/",
  banner: { js: "#!/usr/bin/env node" },
});
