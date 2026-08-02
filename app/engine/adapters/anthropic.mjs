import { manifest, meter, round, httpError } from "../manifest.mjs";

// Anthropic (API) — grade C. Spend only, and only with a separate Admin key
// (sk-admin...), not your inference key. There is NO prepaid-balance API.
//
// Verified live 2026-07-18 against a real Admin key:
//   GET /v1/organizations/cost_report?starting_at=<YYYY-MM-DD>   → 200
//   → { data: [ { starting_at, ending_at, results: [ { currency, amount, ... } ] }, ... ] }
//   NB: `amount` is a STRING ("10.7862"); daily buckets, month-to-date from starting_at.
//   Do NOT send group_by=none (→ 400).
export default {
  id: "anthropic",
  name: "Anthropic",
  dashboard_url: "https://console.anthropic.com/settings/usage",

  async read({ key, http, now = new Date() }) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start}`;

    const r = await http(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!r.ok) throw httpError("cost_report", r.status, r.status === 401 || r.status === 403 ? " (need Admin key)" : "");
    const j = await r.json();

    const usd = sumCostReport(j);
    const meters = [];
    if (usd != null) meters.push(meter("spend", "Spent this month", round(usd), { unit: "USD", period: "month" }));

    return manifest(this.id, this.name, meters, { billing: "usage", dashboard_url: this.dashboard_url });
  },
};

// Sum data[].results[].amount (strings) across the month's daily buckets.
// (If the report ever paginates via has_more/next_page, only the first page is
// summed here — fine for a single month, but worth revisiting for wide ranges.)
function sumCostReport(j) {
  if (Array.isArray(j?.data)) {
    let s = 0, found = false;
    for (const bucket of j.data) {
      for (const res of bucket?.results ?? []) {
        const n = Number(res?.amount);
        if (!Number.isNaN(n)) { s += n; found = true; }
      }
    }
    if (found) return round(s);
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
