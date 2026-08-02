import { manifest, meter, round, httpError } from "../manifest.mjs";

// OpenAI — spend via the Admin costs API (needs an Admin key, sk-admin...). No prepaid-balance API.
// Verified live 2026-07-18:
//   GET /v1/organization/costs?start_time=<unix>&limit=31
//   → { data: [ { results: [ { amount: { value (STRING), currency } } ] } ], has_more }
//   A month is <= 31 daily buckets, so limit=31 returns it all in one page.
export default {
  id: "openai",
  name: "OpenAI",
  dashboard_url: "https://platform.openai.com/usage",

  async read({ key, http, now = new Date() }) {
    const start = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    const r = await http(`https://api.openai.com/v1/organization/costs?start_time=${start}&limit=31`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw httpError("costs", r.status, r.status === 401 || r.status === 403 ? " (need Admin key)" : "");
    const j = await r.json();

    const usd = (j.data || [])
      .flatMap((b) => b.results || [])
      .reduce((s, x) => s + Number(x?.amount?.value ?? 0), 0);

    return manifest(this.id, this.name, [meter("spend", "Spent this month", round(usd), { unit: "USD", period: "month" })], {
      billing: "usage",
      dashboard_url: this.dashboard_url,
    });
  },
};
