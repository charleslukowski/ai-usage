// Rolling local history of polls -> real burn rate, runway, and anomaly detection.
// Pure functions (no I/O) so they're unit-testable; the app owns persistence.
//
// Sample shape: { t: epochMs, p: { [providerId]: { b: balance|null, s: spend|null } } }

const DAY = 86400000;
const HOUR = 3600000;

/** Compress a poll result into one history sample. */
export function sampleFrom(result, now = Date.now()) {
  const p = {};
  for (const prov of result.providers || []) {
    if (prov.error) continue; // don't record failed reads as real values
    const bal = prov.meters.find((m) => m.type === "balance");
    const spend = prov.meters.find((m) => m.type === "spend");
    const q = prov.meters.find((m) => m.type === "quota");
    if (!bal && !spend && !q) continue;
    p[prov.provider.id] = {
      b: bal && bal.value != null ? bal.value : null,
      s: spend && spend.value != null ? spend.value : null,
      q: q && q.value != null ? q.value : null,
    };
  }
  return { t: now, p };
}

/**
 * Keep every sample from the last 24h, then one per hour beyond that,
 * dropping anything older than `keepDays`. Bounds the file without losing
 * the recent resolution the anomaly check needs.
 */
export function prune(history, now = Date.now(), keepDays = 14) {
  const cutoff = now - keepDays * DAY;
  const recentCut = now - DAY;
  const out = [];
  let lastHourBucket = null;
  for (const s of history) {
    if (s.t < cutoff) continue;
    if (s.t >= recentCut) {
      out.push(s);
      continue;
    }
    const bucket = Math.floor(s.t / HOUR);
    if (bucket !== lastHourBucket) {
      out.push(s);
      lastHourBucket = bucket;
    }
  }
  return out;
}

/**
 * Money consumed between two consecutive samples for one provider.
 * Balances count DOWN (a rise means a top-up -> ignore); spend counts UP
 * (a drop means the billing period rolled over -> ignore).
 */
export function deltaSpend(prev, cur) {
  if (!prev || !cur) return 0;
  if (prev.b != null && cur.b != null) return Math.max(0, prev.b - cur.b);
  if (prev.s != null && cur.s != null) return Math.max(0, cur.s - prev.s);
  if (prev.q != null && cur.q != null) return Math.max(0, cur.q - prev.q);
  return 0;
}

/**
 * Observed burn per day over a window. Returns null when there isn't enough
 * history to say anything honest (needs >= minHours of span).
 */
export function burnPerDay(history, id, { now = Date.now(), windowDays = 7, minHours = 2 } = {}) {
  const from = now - windowDays * DAY;
  const pts = history.filter((s) => s.t >= from && s.p && s.p[id]);
  if (pts.length < 2) return null;
  const spanMs = pts[pts.length - 1].t - pts[0].t;
  if (spanMs < minHours * HOUR) return null;

  let total = 0;
  for (let i = 1; i < pts.length; i++) total += deltaSpend(pts[i - 1].p[id], pts[i].p[id]);
  if (total <= 0) return 0;
  return (total / spanMs) * DAY;
}

/**
 * Time series for one provider, for drawing a sparkline. Picks whichever value
 * the provider actually reports (balance / quota / spend). Returns null when
 * there aren't enough points to be worth drawing — a 2-point "trend" is noise.
 * Downsamples to at most `max` points so the SVG stays small.
 */
export function series(history, id, { now = Date.now(), hours = 7 * 24, max = 40, min = 3 } = {}) {
  const from = now - hours * HOUR;
  const pts = [];
  for (const s of history) {
    if (s.t < from || !s.p || !s.p[id]) continue;
    const d = s.p[id];
    const v = d.b != null ? d.b : d.q != null ? d.q : d.s;
    if (v != null) pts.push({ t: s.t, v });
  }
  if (pts.length < min) return null;
  if (pts.length <= max) return pts;

  const step = (pts.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

/** Hours until a balance hits zero at the observed burn rate. */
export function runwayHours(balance, perDay) {
  if (balance == null || perDay == null || perDay <= 0) return null;
  return (balance / perDay) * 24;
}

/**
 * Is the recent burn far above normal? Catches a runaway loop draining an
 * account, which a low-balance threshold only notices once it's nearly gone.
 * Returns null unless there's enough history to compare against.
 */
export function anomaly(history, id, { now = Date.now(), recentHours = 1, ratio = 4, floor = 0.5 } = {}) {
  const recentFrom = now - recentHours * HOUR;
  const recentPts = history.filter((s) => s.t >= recentFrom && s.p && s.p[id]);
  if (recentPts.length < 2) return null;

  let recentTotal = 0;
  for (let i = 1; i < recentPts.length; i++) recentTotal += deltaSpend(recentPts[i - 1].p[id], recentPts[i].p[id]);
  if (recentTotal < floor) return null;

  const baseline = burnPerDay(history, id, { now, windowDays: 7, minHours: 12 });
  if (baseline == null || baseline <= 0) return null;

  const typicalForWindow = (baseline / 24) * recentHours;
  if (typicalForWindow <= 0) return null;
  const r = recentTotal / typicalForWindow;
  return r >= ratio ? { ratio: r, recent: recentTotal, typicalForWindow, recentHours } : null;
}
