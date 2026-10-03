// Mock provider responses. Lets the REAL adapters run end-to-end (adapter →
// normalize → verdict) with no network and no keys, so the pipeline is
// verifiable in CI and offline. Shapes mirror the documented provider APIs.

const RESPONSES = {
  "openrouter.ai/api/v1/key": {
    ok: true,
    status: 200,
    body: { data: { label: "sk-or-personal", usage: 18.4, limit: null, limit_remaining: null, is_free_tier: false } },
  },
  "openrouter.ai/api/v1/credits": {
    ok: true,
    status: 200,
    body: { data: { total_credits: 60.57, total_usage: 18.4 } },
  },
  "api.fal.ai/v1/account/billing": {
    ok: true,
    status: 200,
    body: { username: "chuck", credits: { current_balance: 8.9, currency: "USD" } },
  },
  "api.anthropic.com/v1/organizations/cost_report": {
    // Real shape (verified live 2026-07-18): daily buckets, string amounts (in cents) under results[].
    ok: true,
    status: 200,
    body: {
      data: [
        { starting_at: "2026-07-01T00:00:00Z", ending_at: "2026-07-02T00:00:00Z", results: [] },
        { starting_at: "2026-07-02T00:00:00Z", ending_at: "2026-07-03T00:00:00Z", results: [{ currency: "USD", amount: "1210", workspace_id: null }] },
        { starting_at: "2026-07-03T00:00:00Z", ending_at: "2026-07-04T00:00:00Z", results: [{ currency: "USD", amount: "630", workspace_id: null }] },
      ],
    },
  },
  "api.deepseek.com/user/balance": {
    ok: true,
    status: 200,
    body: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "9.88", granted_balance: "0.00", topped_up_balance: "9.88" }] },
  },
  "api.openai.com/v1/organization/costs": {
    // amount.value is a STRING, nested in data[].results[] (verified live)
    ok: true,
    status: 200,
    body: { object: "page", has_more: false, data: [{ results: [] }, { results: [{ amount: { value: "0.19", currency: "usd" } }] }, { results: [{ amount: { value: "2.31", currency: "usd" } }] }] },
  },
  "api.elevenlabs.io/v1/user/subscription": {
    ok: true,
    status: 200,
    body: { tier: "creator", character_count: 60000, character_limit: 300000, next_character_count_reset_unix: 1785206407 },
  },
};

/** A fetch-like that resolves from the fixtures above by URL substring. */
export function mockHttp(url) {
  const key = Object.keys(RESPONSES).find((k) => url.includes(k));
  const r = key ? RESPONSES[key] : { ok: false, status: 404, body: { error: "no fixture" } };
  return Promise.resolve({
    ok: r.ok,
    status: r.status,
    json: async () => r.body,
    text: async () => JSON.stringify(r.body),
  });
}

/** A config wired to the mock adapters with dummy keys. */
export const mockConfig = {
  thresholds: { criticalUsd: 5, lowUsd: 20 },
  providers: [
    { id: "openrouter", enabled: true, key: "mock" },
    { id: "fal", enabled: true, key: "mock" },
    { id: "anthropic", enabled: true, key: "mock" },
    { id: "deepseek", enabled: true, key: "mock" },
    { id: "openai", enabled: true, key: "mock" },
    { id: "elevenlabs", enabled: true, key: "mock" },
  ],
};
