import { manifest, meter, round, httpError } from "../manifest.mjs";

// OpenRouter — grade B. Balance + usage with your normal inference key.
//   GET /api/v1/key      → per-key usage + limit_remaining (normal key)
//   GET /api/v1/credits  → account totals (may require a provisioning key;
//                          used opportunistically for a true balance)
export default {
  id: "openrouter",
  name: "OpenRouter",
  dashboard_url: "https://openrouter.ai/credits",

  async read({ key, http }) {
    const r = await http("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw httpError("/key", r.status);
    const { data } = await r.json();

    const meters = [];
    let balance = null;

    // Prefer a real account balance from /credits when the key can read it.
    try {
      const cr = await http("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (cr.ok) {
        const c = (await cr.json()).data;
        if (c && typeof c.total_credits === "number") {
          balance = round(c.total_credits - (c.total_usage ?? 0));
        }
      }
    } catch {
      /* credits needs a management key on some accounts — fall back below */
    }

    // Fallback: a spend cap on the key exposes remaining headroom.
    if (balance == null && typeof data?.limit_remaining === "number") {
      balance = round(data.limit_remaining);
    }
    if (balance != null) meters.push(meter("balance", "Credit balance", balance, { unit: "USD" }));

    if (typeof data?.usage === "number") {
      meters.push(meter("spend", "Used (this key)", round(data.usage), { unit: "USD", period: "total" }));
    }

    return manifest(this.id, this.name, meters, {
      billing: "credit",
      dashboard_url: this.dashboard_url,
      links: { dashboard: this.dashboard_url, topup: this.dashboard_url },
    });
  },
};
