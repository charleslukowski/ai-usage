import { manifest, meter, round, httpError } from "../manifest.mjs";

// Anthropic (API) — grade C. Spend only, and only with a separate Admin key
// (sk-admin...), not your inference key. There is NO prepaid-balance API.
//
// Verified live 2026-07-18 against a real Admin key:
//   GET /v1/organizations/cost_report?starting_at=<YYYY-MM-DD>   → 200
//   → { data: [ { starting_at, ending_at, results: [ { currency, amount, ... } ] }, ... ] }
//   NB: `amount` is a STRING ("10.7862"); daily buckets, month-to-date from starting_at.
//   Do NOT send group_by=none (→ 400).
//
// Per the API reference (checked 2026-10-02):
//   - `amount` is in the LOWEST currency unit — "123.45" USD means $1.23 — so divide by 100.
//   - `limit` defaults to 7 buckets (max 31), paginated via has_more/next_page. Only
//     reading page one froze month-to-date spend at the first 7 days of the month.
//   - `starting_at` is an RFC 3339 timestamp, not a bare date.
export default {
  id: "anthropic",
  name: "Anthropic",
  dashboard_url: "https://console.anthropic.com/settings/usage",

  async read({ key, http, now = new Date() }) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const base = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(start)}&limit=31`;

    // A month is <= 31 daily buckets, so this is normally one page; follow the
    // cursor anyway (bounded) in case the API ever shrinks the page size.
    const data = [];
    let odd = null; // a response that isn't the documented shape
    let page = null;
    for (let i = 0; i < 5; i++) {
      const r = await http(page ? `${base}&page=${encodeURIComponent(page)}` : base, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) throw httpError("cost_report", r.status, r.status === 401 || r.status === 403 ? " (need Admin key)" : "");
      const j = await r.json();
      if (!Array.isArray(j?.data)) {
        odd = j;
        break;
      }
      data.push(...j.data);
      page = j.has_more ? j.next_page : null;
      if (!page) break;
    }

    const cents = sumCostReport(odd ?? { data });
    const usd = cents == null ? null : cents / 100;
    const meters = [];
    if (usd != null) meters.push(meter("spend", "Spent this month", round(usd), { unit: "USD", period: "month" }));

    return manifest(this.id, this.name, meters, { billing: "usage", dashboard_url: this.dashboard_url });
  },
};

// Sum data[].results[].amount (strings, in cents) across the month's daily buckets.
function sumCostReport(j) {
  if (Array.isArray(j?.data)) {
    let s = 0, found = false;
    for (const bucket of j.data) {
      for (const res of bucket?.results ?? []) {
        const n = Number(res?.amount);
        if (!Number.isNaN(n)) { s += n; found = true; }
      }
    }
    if (found) return s;
    if (j.data.length) return 0; // real report, just no spend yet this month
  }
  return extractUsd(j); // tolerant fallback for any shape drift
}

// Tolerant extractor: sum every numeric (or numeric-string) `amount`/`cost`.
function extractUsd(node, acc = { sum: 0, found: false }) {
  if (node == null || typeof node === "number" || typeof node === "string") return acc.found ? round(acc.sum) : null;
  if (Array.isArray(node)) {
    for (const el of node) extractUsd(el, acc);
    return acc.found ? round(acc.sum) : null;
  }
  for (const [k, v] of Object.entries(node)) {
    if (/^(amount|cost)$/i.test(k)) {
      const num = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : typeof v?.value === "number" ? v.value : null;
      if (num != null) { acc.sum += num; acc.found = true; continue; }
    }
    extractUsd(v, acc);
  }
  return acc.found ? round(acc.sum) : null;
}
