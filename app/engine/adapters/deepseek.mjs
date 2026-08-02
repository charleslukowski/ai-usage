import { manifest, meter, round, httpError } from "../manifest.mjs";

// DeepSeek — clean prepaid balance with your normal key (verified live 2026-07-18).
//   GET /user/balance  → { is_available, balance_infos: [{ currency, total_balance (string), ... }] }
export default {
  id: "deepseek",
  name: "DeepSeek",
  dashboard_url: "https://platform.deepseek.com/usage",

  async read({ key, http }) {
    const r = await http("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (!r.ok) throw httpError("balance", r.status);
    const j = await r.json();
    const info = (j.balance_infos || [])[0];

    const meters = [];
    if (info && info.total_balance != null) {
      meters.push(meter("balance", "Credit balance", round(Number(info.total_balance)), { unit: info.currency || "USD" }));
    }
    return manifest(this.id, this.name, meters, {
      billing: "credit",
      dashboard_url: this.dashboard_url,
      links: { dashboard: this.dashboard_url, topup: this.dashboard_url },
    });
  },
};
