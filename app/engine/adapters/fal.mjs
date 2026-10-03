import { manifest, meter, round, httpError } from "../manifest.mjs";

// fal.ai — grade C (was assumed B). Endpoint + auth VERIFIED live 2026-07-18, but a
// standard inference key returns 403 "not permitted to perform this action" — reading
// balance needs a billing-scoped key. `Key` is the correct scheme (Bearer 401s).
// This adapter is correct as written; it just needs a key with billing permission.
//   GET https://api.fal.ai/v1/account/billing?expand=credits  (Authorization: Key <FAL_KEY>)
export default {
  id: "fal",
  name: "fal.ai",
  dashboard_url: "https://fal.ai/dashboard/billing",

  async read({ key, http }) {
    const r = await http("https://api.fal.ai/v1/account/billing?expand=credits", {
      headers: { Authorization: `Key ${key}` },
    });
    if (!r.ok) throw httpError("billing", r.status, r.status === 401 || r.status === 403 ? " (need Admin key)" : "");
    const j = await r.json();

    const bal = j?.credits?.current_balance ?? j?.current_balance ?? null;
    const currency = j?.credits?.currency ?? j?.currency ?? "USD";

    const meters = [];
    if (bal != null) meters.push(meter("balance", "Credit balance", round(Number(bal)), { unit: currency }));

    return manifest(this.id, this.name, meters, {
      billing: "credit",
      dashboard_url: this.dashboard_url,
      account: j?.username ? { label: j.username } : undefined,
      links: { dashboard: this.dashboard_url, topup: this.dashboard_url },
    });
  },
};
