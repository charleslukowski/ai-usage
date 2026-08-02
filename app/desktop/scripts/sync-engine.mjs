// Copy the shared engine (../engine) into src/engine so the webview bundles the
// current version. Runs automatically before dev/build via predev/prebuild.
// Excludes the Node-only files (cli, selfcheck, fixtures) that don't belong in the browser.
import { cpSync } from "node:fs";

cpSync("../engine", "src/engine", {
  recursive: true,
  filter: (p) => !/[\\/](cli|selfcheck|fixtures)\.mjs$/.test(p),
});
console.log("[sync-engine] ../engine -> src/engine");
