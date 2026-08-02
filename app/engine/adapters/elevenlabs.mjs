import { manifest, meter, httpError } from "../manifest.mjs";

// ElevenLabs — subscription with a monthly allowance (verified live 2026-07-18).
//   GET /v1/user/subscription  (header: xi-api-key)
//   → { tier, character_count (used), character_limit, next_character_count_reset_unix, ... }
//
// Naming: the API fields say "character", but ElevenLabs' own dashboard shows
// this exact quantity as **credits** (and the same payload returns
// `max_credit_limit_extension`). We report "credits" so the panel matches the
// page you'd check it against. Cross-verified 2026-07-28: /v1/usage/character-stats
// summed to 5257 over the cycle, identical to character_count.
export default {
  id: "elevenlabs",
  name: "ElevenLabs",
  dashboard_url: "https://elevenlabs.io/app/usage",

  async read({ key, http }) {
    const r = await http("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
    if (!r.ok) throw httpError("subscription", r.status);
    const j = await r.json();

    const meters = [];
    if (typeof j.character_count === "number" && typeof j.character_limit === "number") {
      meters.push(meter("quota", "Credits this cycle", j.character_count, {
        limit: j.character_limit,
        unit: "credits",
        period: "month",
        resets_at: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : undefined,
      }));
    }
    return manifest(this.id, this.name, meters, {
      billing: "subscription",
      dashboard_url: this.dashboard_url,
      ...(j.tier ? { account: { plan: j.tier } } : {}),
    });
  },
};
