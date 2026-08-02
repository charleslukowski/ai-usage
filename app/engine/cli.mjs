#!/usr/bin/env node
// ai-usage CLI — poll every configured provider and print a one-glance status.
//   node cli.mjs --mock        run against built-in fixtures (no keys, no network)
//   node cli.mjs --json        emit the aggregate as JSON (for the UI to consume)
//   node cli.mjs               live: reads config.json (or env) beside the app
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { poll } from "./engine.mjs";
import { mockHttp, mockConfig } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const useMock = args.has("--mock");
const asJson = args.has("--json");

const DOT = { ok: "●", info: "●", low: "●", critical: "●", unknown: "○" };
const C = { ok: "\x1b[32m", info: "\x1b[36m", low: "\x1b[33m", critical: "\x1b[31m", unknown: "\x1b[90m", reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m" };

function loadLiveConfig() {
  // config.json sits next to /app; keys may be inline or named via key_env.
  const path = join(here, "..", "config.json");
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.error(`No config found at ${path}. Copy config.example.json → config.json, or run with --mock.`);
    process.exit(1);
  }
  for (const p of cfg.providers ?? []) {
    if (!p.key && p.key_env) p.key = process.env[p.key_env];
  }
  return cfg;
}

const { config, deps } = useMock
  ? { config: mockConfig, deps: { http: mockHttp } }
  : { config: loadLiveConfig(), deps: {} };

const result = await poll(config, deps);

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const o = result.overall;
console.log("");
console.log(`  ${C[o.level]}${DOT[o.level]}${C.reset} ${C.bold}${o.message}${C.reset}`);
console.log(`  ${C.dim}as of ${new Date(result.as_of).toLocaleString()}${useMock ? "  ·  MOCK DATA" : ""}${C.reset}`);
console.log("");

for (const p of result.providers) {
  const s = p.summary;
  const bal = p.meters.find((m) => m.type === "balance");
  const spend = p.meters.find((m) => m.type === "spend");
  const primary = bal ? money(bal) : spend ? `${money(spend)} spent` : p.error ? p.error : "—";
  console.log(
    `  ${C[s.status]}${DOT[s.status]}${C.reset} ${pad(p.provider.name, 14)} ${pad(primary, 20)} ${C.dim}${s.status}${C.reset}`
  );
}
console.log("");

function money(m) {
  if (m.value == null) return "—";
  return m.unit === "USD" ? `$${m.value.toFixed(2)}` : `${m.value} ${m.unit}`;
}
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
