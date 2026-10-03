#!/usr/bin/env node
// Self-check: exercises the engine end-to-end and validates adapter output
// against the real spec schema. Run: node engine/selfcheck.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { poll } from "./engine.mjs";
import { mockHttp, mockConfig } from "./fixtures.mjs";
import openrouter from "./adapters/openrouter.mjs";
import fal from "./adapters/fal.mjs";
import anthropic from "./adapters/anthropic.mjs";
import deepseek from "./adapters/deepseek.mjs";
import openai from "./adapters/openai.mjs";
import elevenlabs from "./adapters/elevenlabs.mjs";
import { estimateRunwayHours, statusForBalance, fmtRunway, meter, summarize } from "./manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, "..", "..", "spec", "ai-usage.schema.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m`); } };

// ---- minimal JSON-Schema validator (type/enum/required/props/additionalProps/items/$ref) ----
function validate(sch, data, root = schema, path = "$", errs = []) {
  if (sch.$ref) {
    const ref = sch.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    return validate(ref, data, root, path, errs);
  }
  if (sch.enum && !sch.enum.includes(data)) errs.push(`${path}: ${JSON.stringify(data)} not in enum`);
  const types = Array.isArray(sch.type) ? sch.type : sch.type ? [sch.type] : null;
  if (types) {
    const matches = types.some((t) =>
      t === "null" ? data === null :
      t === "number" ? typeof data === "number" :
      t === "string" ? typeof data === "string" :
      t === "boolean" ? typeof data === "boolean" :
      t === "array" ? Array.isArray(data) :
      t === "object" ? data !== null && typeof data === "object" && !Array.isArray(data) : false);
    if (!matches) errs.push(`${path}: type ${JSON.stringify(data)} not ${types}`);
  }
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    for (const r of sch.required ?? []) if (!(r in data)) errs.push(`${path}: missing required '${r}'`);
    if (sch.additionalProperties === false) for (const k of Object.keys(data)) if (!sch.properties?.[k]) errs.push(`${path}: unexpected key '${k}'`);
    for (const [k, v] of Object.entries(data)) if (sch.properties?.[k]) validate(sch.properties[k], v, root, `${path}.${k}`, errs);
  }
  if (Array.isArray(data) && sch.items) data.forEach((el, i) => validate(sch.items, el, root, `${path}[${i}]`, errs));
  return errs;
}

console.log("\nengine self-check\n");

// 1. Happy path
const r = await poll(mockConfig, { http: mockHttp });
ok("overall verdict = low (worst provider wins)", r.overall.level === "low");
ok("overall message names fal.ai", r.overall.message.includes("fal.ai"));
const byId = Object.fromEntries(r.providers.map((p) => [p.provider.id, p]));
ok("OpenRouter status ok", byId.openrouter.summary.status === "ok");
ok("OpenRouter balance = 42.17 (via /credits: 60.57 - 18.40)", byId.openrouter.meters.find((m) => m.type === "balance")?.value === 42.17);
ok("fal.ai status low ($8.90 < $20)", byId.fal.summary.status === "low");
ok("Anthropic status info (spend, no balance)", byId.anthropic.summary.status === "info");
ok("Anthropic spend = 18.40 (12.10 + 6.30 summed)", byId.anthropic.meters.find((m) => m.type === "spend")?.value === 18.4);

// billing classification present on every adapter
ok("OpenRouter tagged billing=credit", byId.openrouter.provider.billing === "credit");
ok("fal.ai tagged billing=credit", byId.fal.provider.billing === "credit");
ok("Anthropic tagged billing=usage", byId.anthropic.provider.billing === "usage");
ok("DeepSeek balance = 9.88 (string total_balance parsed)", byId.deepseek.meters.find((m) => m.type === "balance")?.value === 9.88);
ok("DeepSeek billing=credit", byId.deepseek.provider.billing === "credit");
ok("OpenAI spend = 2.50 (0.19 + 2.31 string amounts summed)", byId.openai.meters.find((m) => m.type === "spend")?.value === 2.5);
ok("ElevenLabs quota = 60000 of 300000 credits", byId.elevenlabs.meters.find((m) => m.type === "quota")?.value === 60000 && byId.elevenlabs.meters.find((m) => m.type === "quota")?.limit === 300000);
ok("ElevenLabs reports credits, matching its dashboard wording", byId.elevenlabs.meters.find((m) => m.type === "quota")?.unit === "credits");
ok("ElevenLabs billing=subscription, judged as quota (80% left, ok)", byId.elevenlabs.provider.billing === "subscription" && byId.elevenlabs.summary.status === "ok" && /quota left/.test(byId.elevenlabs.summary.headline));

// 2. Schema conformance — validate each adapter's raw (pre-summary) manifest
for (const [name, adapter] of [["openrouter", openrouter], ["fal", fal], ["anthropic", anthropic], ["deepseek", deepseek], ["openai", openai], ["elevenlabs", elevenlabs]]) {
  const m = await adapter.read({ key: "mock", http: mockHttp, now: new Date() });
  const errs = validate(schema, m);
  ok(`${name} manifest conforms to ai-usage.schema.json`, errs.length === 0);
  if (errs.length) errs.forEach((e) => console.log(`      → ${e}`));
}

// 3. Graceful degradation — a provider returning 403 must not crash the poll
const http403 = (url, opts) => url.includes("api.fal.ai") ? Promise.resolve({ ok: false, status: 403, json: async () => ({}), text: async () => "" }) : mockHttp(url, opts);
const r2 = await poll(mockConfig, { http: http403 });
const fal2 = r2.providers.find((p) => p.provider.id === "fal");
ok("failing provider degrades to unknown (not a crash)", fal2.summary.status === "unknown" && /403/.test(fal2.error));
ok("overall still computes with one provider down", ["ok", "info", "low", "critical"].includes(r2.overall.level));

// 4. Missing key → provider reports 'no key configured', no throw
const r3 = await poll({ providers: [{ id: "fal", enabled: true }] }, { http: mockHttp });
ok("missing key handled (no key configured)", /no key/.test(r3.providers[0].error ?? ""));

// 5. Pure logic — runway + thresholds
ok("runway: $90 balance, $30 spent by day 10 → $3/day → 720h (30 days)", estimateRunwayHours(90, 30, new Date(2026, 0, 10)) === 720);
ok("status critical when runway < 6h", statusForBalance(meter("balance", "b", 5), 3, {}) === "critical");
ok("status low when runway < 24h", statusForBalance(meter("balance", "b", 100), 12, {}) === "low");
ok("status ok when runway >= 24h", statusForBalance(meter("balance", "b", 100), 100, {}) === "ok");
ok("status critical on low $ (no runway)", statusForBalance(meter("balance", "b", 3), null, {}) === "critical");
ok("non-money unit (tokens) → info, not a false alarm", statusForBalance(meter("balance", "b", 2, { unit: "tokens" }), null, {}) === "info");
ok("fmtRunway: 40h stays hours", fmtRunway(40) === "~40h");
ok("fmtRunway: 60h becomes days", fmtRunway(60) === "~2.5 days");

// 6. Runway actually flows through summarize when a monthly spend meter exists
const withBurn = { ai_usage_version: "0.1", provider: { id: "x", name: "X" }, as_of: "", meters: [meter("balance", "b", 48), meter("spend", "s", 30, { period: "month" })] };
const sum = summarize(withBurn, {}, new Date(2026, 0, 10));
ok("summarize computes runway (48 / (30/10 per day) = 16 days)", sum.runwayHours === 384 && /days/.test(sum.headline));

// 7. Subscription providers judged by % headroom, not a dollar threshold
const subQuota = { ai_usage_version: "0.1", provider: { id: "s", name: "S", billing: "subscription" }, as_of: "", meters: [meter("quota", "Monthly credits", 1800000, { limit: 2000000, unit: "credits", period: "month" })] };
const sq = summarize(subQuota, {}, new Date());
ok("subscription quota 90% used → critical (10% left), reads 'quota'", sq.status === "critical" && /quota left/.test(sq.headline));
const subWin = { ai_usage_version: "0.1", provider: { id: "w", name: "W", billing: "subscription" }, as_of: "", meters: [meter("rate_window", "5h window", 50, { limit: 200, unit: "tokens" })] };
const sw = summarize(subWin, {}, new Date());
ok("rate_window 25% remaining → low, reads 'window'", sw.status === "low" && /window left/.test(sw.headline));

// 7b. Per-provider config: disable, and threshold overrides
{
  const only = await poll({ ...mockConfig, providers: mockConfig.providers.filter((p) => p.id !== "fal") }, { http: mockHttp });
  ok("disabled provider is not polled at all", !only.providers.some((p) => p.provider.id === "fal"));

  // DeepSeek reads $9.88; global low=20 -> "low". Override to low=5 -> "ok".
  const overridden = await poll(
    { ...mockConfig, providers: mockConfig.providers.map((p) => (p.id === "deepseek" ? { ...p, thresholds: { lowUsd: 5, criticalUsd: 1 } } : p)) },
    { http: mockHttp }
  );
  const ds = overridden.providers.find((p) => p.provider.id === "deepseek");
  ok("per-provider threshold override changes the verdict", ds.summary.status === "ok");
  const or = overridden.providers.find((p) => p.provider.id === "openrouter");
  ok("other providers keep the global threshold", or.summary.status === "ok");
}

// 7c. Retry policy: transient errors retry, 4xx doesn't (it can never succeed)
{
  let calls403 = 0, calls500 = 0;
  const http403 = (url, opts) => {
    if (url.includes("api.fal.ai")) { calls403++; return Promise.resolve({ ok: false, status: 403, json: async () => ({}), text: async () => "" }); }
    return mockHttp(url, opts);
  };
  await poll({ providers: [{ id: "fal", enabled: true, key: "k" }] }, { http: http403 });
  ok("4xx is not retried (one attempt only)", calls403 === 1);

  const http500 = (url, opts) => {
    if (url.includes("api.fal.ai")) { calls500++; return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => "" }); }
    return mockHttp(url, opts);
  };
  await poll({ providers: [{ id: "fal", enabled: true, key: "k" }] }, { http: http500 });
  ok("5xx still retries once (transient)", calls500 === 2);

  // a provider that never resolves must not stall the whole poll
  const t0 = Date.now();
  const hang = (url, opts) => (url.includes("api.fal.ai") ? new Promise(() => {}) : mockHttp(url, opts));
  const r = await poll({ timeoutMs: 300, providers: [{ id: "fal", enabled: true, key: "k" }, { id: "deepseek", enabled: true, key: "k" }] }, { http: hang });
  ok("a hung provider times out instead of stalling the panel", Date.now() - t0 < 3000 && /timed out/.test(r.providers.find((p) => p.provider.id === "fal").error || ""));
  ok("other providers still return while one hangs", r.providers.find((p) => p.provider.id === "deepseek").summary.status === "low");
}

// 8. History: burn rate, runway, top-up handling, anomaly detection
{
  const H = await import("./history.mjs");
  const DAY = 86400000, HOUR = 3600000;
  const now = Date.UTC(2026, 6, 20, 12, 0, 0);
  // $2/day for 7 days on a balance that counts down
  const steady = [];
  for (let d = 7; d >= 0; d--) steady.push({ t: now - d * DAY, p: { x: { b: 100 - (7 - d) * 2 } } });

  const perDay = H.burnPerDay(steady, "x", { now });
  ok("burn: steady $2/day balance drain reads ~2/day", Math.abs(perDay - 2) < 0.05);
  ok("runway: $86 left at $2/day ≈ 43 days", Math.abs(H.runwayHours(86, 2) / 24 - 43) < 0.5);
  ok("burn: unknown provider → null", H.burnPerDay(steady, "nope", { now }) === null);
  ok("burn: too little history → null", H.burnPerDay([{ t: now, p: { x: { b: 5 } } }], "x", { now }) === null);

  // a top-up mid-window must not read as negative burn
  const toppedUp = [
    { t: now - 3 * DAY, p: { x: { b: 10 } } },
    { t: now - 2 * DAY, p: { x: { b: 6 } } },
    { t: now - 1 * DAY, p: { x: { b: 100 } } }, // topped up
    { t: now, p: { x: { b: 96 } } },
  ];
  ok("burn: a top-up is ignored, not counted as negative spend", Math.abs(H.burnPerDay(toppedUp, "x", { now }) - (8 / 3)) < 0.1);

  // spend meters count UP, and reset at the period boundary
  const spendy = [
    { t: now - 2 * DAY, p: { y: { s: 10 } } },
    { t: now - 1 * DAY, p: { y: { s: 14 } } },
    { t: now, p: { y: { s: 1 } } }, // month rolled over
  ];
  ok("burn: spend-meter rollover is ignored", Math.abs(H.burnPerDay(spendy, "y", { now }) - 2) < 0.05);

  // anomaly: normal $2/day, then $6 burned in the last hour (~72x normal)
  const spike = steady.concat([
    { t: now + 30 * 60000, p: { x: { b: 86 } } },
    { t: now + HOUR, p: { x: { b: 80 } } },
  ]);
  const a = H.anomaly(spike, "x", { now: now + HOUR });
  ok("anomaly: a burst far above baseline is flagged", a !== null && a.ratio > 4);
  ok("anomaly: steady burn is NOT flagged", H.anomaly(steady, "x", { now }) === null);
  ok("anomaly: tiny amounts below the floor are ignored", H.anomaly(steady.concat([{ t: now + HOUR, p: { x: { b: 85.9 } } }]), "x", { now: now + HOUR }) === null);

  // quota-only providers (ElevenLabs credits) use a prepaid allowance — not money.
  // Real 2026-10-02 history: 4748 -> 5654 credits in 6 min read as "$906 unusual spend".
  const quota = [];
  for (let d = 7; d >= 1; d--) quota.push({ t: now - d * DAY, p: { el: { b: null, s: null, q: (7 - d) * 100 } } });
  quota.push({ t: now - 6 * 60000, p: { el: { b: null, s: null, q: 4748 } } }, { t: now, p: { el: { b: null, s: null, q: 5654 } } });
  ok("anomaly: quota credits used are NOT flagged as spend", H.anomaly(quota, "el", { now }) === null);
  ok("burn: quota credits used are not counted as $/day", !H.burnPerDay(quota, "el", { now }));

  // prune keeps recent resolution, thins older, drops ancient
  const many = [];
  for (let i = 0; i < 400; i++) many.push({ t: now - i * 10 * 60000, p: { x: { b: 1 } } }); // 10-min steps back ~66h
  many.push({ t: now - 40 * DAY, p: { x: { b: 1 } } });
  // sparkline series
  ok("series: returns points for a provider with history", (H.series(steady, "x", { now }) || []).length === 8);
  ok("series: null when there aren't enough points to be meaningful", H.series([{ t: now, p: { x: { b: 1 } } }], "x", { now }) === null);
  ok("series: downsamples to the cap", (H.series(steady.concat(Array.from({ length: 200 }, (_, i) => ({ t: now - i * 60000, p: { x: { b: 50 } } }))), "x", { now, max: 40 }) || []).length <= 40);
  ok("series: picks quota when that's what the provider reports", (H.series([1, 2, 3].map((i) => ({ t: now - i * HOUR, p: { q1: { q: i * 10 } } })), "q1", { now }) || []).every((p) => p.v > 0));

  const pruned = H.prune(many.slice().reverse(), now, 14);
  ok("prune: drops samples older than the retention window", !pruned.some((s) => s.t < now - 14 * DAY));
  ok("prune: thins beyond 24h but keeps recent full resolution", pruned.length < many.length && pruned.filter((s) => s.t >= now - DAY).length > 100);
}

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
