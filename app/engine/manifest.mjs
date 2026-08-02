// ai-usage — normalization + verdict core.
// Pure functions: no I/O. Turns adapter output into the `ai-usage` manifest
// shape (see ../../spec/ai-usage.schema.json) and derives per-provider +
// overall status. This is the logic that later runs inside the Tauri app.

export const round = (n) => Math.round(n * 100) / 100;

/**
 * Error carrying the HTTP status, so the poller can tell a transient network
 * blip (worth retrying) from a 4xx (bad or under-scoped key — retrying only
 * wastes time on every cycle).
 */
export function httpError(label, status, extra = "") {
  const err = new Error(`${label} ${status}${extra}`);
  err.status = status;
  return err;
}

/** Build one normalized meter. */
export function meter(type, label, value, opts = {}) {
  return {
    type,
    label,
    value: value == null ? null : value,
    limit: opts.limit ?? null,
    unit: opts.unit ?? "USD",
    ...(opts.period ? { period: opts.period } : {}),
    ...(opts.resets_at ? { resets_at: opts.resets_at } : {}),
    ...(opts.status ? { status: opts.status } : {}),
  };
}

/** Build a provider manifest. */
export function manifest(id, name, meters, opts = {}) {
  return {
    ai_usage_version: "0.1",
    provider: {
      id,
      name,
      // billing model: "credit" (prepaid, counts down) | "usage" (pay-as-you-go,
      // accrues, invoiced) | "subscription" (flat fee, rolling quota that resets).
      ...(opts.billing ? { billing: opts.billing } : {}),
      ...(opts.dashboard_url ? { dashboard_url: opts.dashboard_url } : {}),
    },
    as_of: opts.as_of ?? new Date().toISOString(),
    ...(opts.account ? { account: opts.account } : {}),
    meters,
    ...(opts.links ? { links: opts.links } : {}),
  };
}

const MONEY_UNITS = new Set(["USD", "usd", "credits"]);

/**
 * Runway in hours: how long `balance` lasts at the current burn rate.
 * Burn is derived from a month-to-date spend meter (spend / elapsed days).
 * Returns null when it can't be estimated.
 */
export function estimateRunwayHours(balance, spendMonth, now = new Date()) {
  if (balance == null || spendMonth == null || spendMonth <= 0) return null;
  const dayOfMonth = now.getDate(); // 1..31; elapsed days incl. today
  const perDay = spendMonth / Math.max(dayOfMonth, 1);
  if (perDay <= 0) return null;
  return round((balance / perDay) * 24);
}

const RANK = { unknown: 0, ok: 1, info: 1, low: 2, critical: 3 };
export const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/** Status for a single balance meter, from runway if known, else absolute $. */
export function statusForBalance(balanceMeter, runwayHours, thresholds) {
  const t = { criticalUsd: 5, lowUsd: 20, criticalHours: 6, lowHours: 24, ...thresholds };
  if (!balanceMeter || balanceMeter.value == null) return "unknown";
  if (!MONEY_UNITS.has(balanceMeter.unit)) return "info";
  if (runwayHours != null) {
    if (runwayHours < t.criticalHours) return "critical";
    if (runwayHours < t.lowHours) return "low";
    return "ok";
  }
  if (balanceMeter.value < t.criticalUsd) return "critical";
  if (balanceMeter.value < t.lowUsd) return "low";
  return "ok";
}

/**
 * Given a normalized manifest, derive a UI summary: the headline meter, its
 * status, and a runway estimate. Non-balance providers report `info`.
 */
export function summarize(m, thresholds, now = new Date()) {
  if (m.error) {
    return { status: "unknown", headline: `${m.provider.name} — no data (${m.error})`, runwayHours: null };
  }
  const balance = m.meters.find((x) => x.type === "balance");
  const spendMonth = m.meters.find((x) => x.type === "spend" && x.period === "month");

  if (balance) {
    const runwayHours = estimateRunwayHours(balance.value, spendMonth?.value ?? null, now);
    const status = balance.status ?? statusForBalance(balance, runwayHours, thresholds);
    const left = fmtMoney(balance.value, balance.unit);
    const tail = runwayHours != null ? ` (${fmtRunway(runwayHours)})` : "";
    return { status, headline: `${m.provider.name} — ${left} left${tail}`, runwayHours };
  }
  // Subscription providers have no balance — judge the rolling quota/window, not $.
  const window = m.meters.find((x) => x.type === "quota" || x.type === "rate_window");
  if (window) return summarizeWindow(m.provider.name, window);
  if (spendMonth) {
    return { status: "info", headline: `${m.provider.name} — ${fmtMoney(spendMonth.value, spendMonth.unit)} spent this month`, runwayHours: null };
  }
  return { status: "unknown", headline: `${m.provider.name} — no balance or spend reported`, runwayHours: null };
}

// A quota (used/allowance) or rate_window (remaining/window) → % headroom left.
function summarizeWindow(name, w) {
  if (w.value == null || w.limit == null || w.limit === 0) {
    return { status: "unknown", headline: `${name} — usage window (no numbers)`, runwayHours: null };
  }
  const pctLeft = w.type === "rate_window" ? (w.value / w.limit) * 100 : ((w.limit - w.value) / w.limit) * 100;
  const status = w.status ?? (pctLeft <= 10 ? "critical" : pctLeft <= 25 ? "low" : "ok");
  const resets = w.resets_at ? `, resets ${new Date(w.resets_at).toLocaleTimeString()}` : "";
  const kind = w.type === "rate_window" ? "window" : "quota";
  return { status, headline: `${name} — ${Math.round(pctLeft)}% of ${kind} left${resets}`, runwayHours: null };
}

/** Overall verdict across all providers (worst real status wins). */
export function overall(summaries) {
  const real = summaries.filter((s) => s.status !== "unknown");
  const level = real.reduce((acc, s) => worse(acc, s.status), "unknown");
  const worstReal = [...summaries].sort((a, b) => RANK[b.status] - RANK[a.status])[0];
  let message;
  if (level === "critical") message = `Critical — ${worstReal.headline}`;
  else if (level === "low") message = `Running low — ${worstReal.headline}`;
  else if (level === "ok" || level === "info") message = "All clear";
  else message = "No live data";
  return { level, message };
}

export function fmtMoney(v, unit) {
  if (v == null) return "—";
  if (unit === "USD" || unit === "usd") return `$${v.toFixed(2)}`;
  return `${v} ${unit}`;
}

export function fmtRunway(hours) {
  if (hours == null) return "";
  if (hours < 48) return `~${Math.round(hours)}h`;
  return `~${(hours / 24).toFixed(1)} days`;
}
