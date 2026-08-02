# The `ai-usage` manifest — v0.1 (draft)

*One tiny, authenticated endpoint that reports what you have left and what you've spent — in a shape every client can read the same way.*

Status: draft / request-for-comment. License: CC0 (public domain) — copy it, ship it, no attribution required.

## Why

Every AI provider takes your money. Almost none let you read your own balance or spend from an API with the key you already have. A solo builder running a dozen providers has a dozen dashboards and no single view — and an autonomous agent can drain a prepaid balance to zero overnight with no signal until a job fails.

There is no shared shape for "how much is left." Each provider that *does* expose usage invents its own — different field names, different auth, different units. So every tool that wants to show your balance hand-writes an adapter per provider, and the providers with no API at all are simply invisible.

`ai-usage` is that shared shape. If a provider serves it, any conformant client shows your numbers with zero custom code.

## What it is

A small JSON document, served over authenticated HTTPS, describing the money and usage on **your** account: prepaid balance, month-to-date spend, quota consumption, and rolling rate-window headroom — normalized into a handful of "meters."

It reuses your existing credential. No new key, no OAuth dance: the same bearer token you send to the inference API authorizes the usage read.

## Discovery

A client looks for the manifest in this order:

1. `GET https://<api-host>/.well-known/ai-usage.json`  *(preferred)*
2. A provider-documented `GET /v1/usage` returning the same body.

Both are **authenticated** — the response is account-specific — using the provider's normal `Authorization` header. The response is `application/json` with the body below.

A provider MAY advertise support with an `X-AI-Usage: /.well-known/ai-usage.json` header on its normal API responses, so clients can discover it without a probe.

## The document

| Field | Req | Type | Notes |
|---|---|---|---|
| `ai_usage_version` | ✓ | string | Spec version, e.g. `"0.1"`. |
| `provider` | ✓ | object | `{ id, name, billing?, dashboard_url? }`. `id` is a stable lowercase slug; `billing` ∈ `credit` / `usage` / `subscription` (see Billing models). |
| `as_of` | ✓ | string | RFC 3339 timestamp of data freshness. |
| `account` | – | object | `{ id?, label?, plan? }` — which account/key this is. |
| `meters` | ✓ | array | One or more readings (below). May be empty if nothing is knowable. |
| `links` | – | object | `{ dashboard?, topup?, docs? }`. |

### Meter

| Field | Req | Type | Notes |
|---|---|---|---|
| `type` | ✓ | enum | `balance` \| `spend` \| `quota` \| `rate_window`. |
| `label` | ✓ | string | Human label, e.g. `"Credit balance"`. |
| `value` | ✓ | number \| null | The reading. `null` = the meter exists but the number can't be reported here. |
| `limit` | – | number \| null | Cap, for `spend` budgets / `quota` / `rate_window`. |
| `unit` | ✓ | string | ISO-4217 currency (`"USD"`) or `"tokens"` / `"requests"` / `"credits"`. |
| `period` | – | enum | For `spend`/`quota`: `day` \| `week` \| `month` \| `billing_cycle` \| `total`. |
| `resets_at` | – | string \| null | RFC 3339, for `quota` / `rate_window`. |
| `status` | – | enum | The provider's own verdict: `ok` \| `low` \| `critical` \| `unknown`. Optional. |

### Meter types

- **`balance`** — prepaid money (or credits) remaining. `value` counts *down*; the number a top-up increases.
- **`spend`** — money accrued so far, usually within `period: month`. Counts *up*. `limit` = a spend cap if one exists.
- **`quota`** — units used against an allowance in a period (e.g. "1.2M of 2M monthly credits"). `value` = used, `limit` = allowance, `resets_at` = period end.
- **`rate_window`** — headroom left in a rolling window (requests remaining this minute, or tokens left in a 5-hour subscription window). `value` = remaining, `limit` = window size, `resets_at` = window reset.

### Billing models

`provider.billing` tells a client how to *read* an account — because which meter is even meaningful depends on it:

- **`credit`** — prepaid. You load money/credits and they count down. Read a `balance` meter; runway (balance ÷ burn) is meaningful. *e.g. OpenRouter, fal.ai, most prepaid API credits.*
- **`usage`** — pay-as-you-go / postpaid. You accrue cost and get invoiced; there is no prepaid balance. Read a `spend` meter (month-to-date). *e.g. Anthropic API, Railway, Replicate.*
- **`subscription`** — a flat recurring fee with a rolling quota or rate window that resets. There is no dollar balance and nothing to "run dry" — you get throttled until the reset. Read a `quota` or `rate_window` meter, never `balance`. *e.g. Claude Max, ChatGPT Plus, Hugging Face PRO.*

A client must not judge a subscription by a dollar threshold, or show a credit provider a "resets at" — the billing model picks the treatment. Some providers offer more than one mode (prepaid *and* invoiced); report the one this account actually uses.

### Status

If a provider omits `status`, the **client** computes one from thresholds (its own defaults, or the user's). If a provider sets it, the client should prefer it — the provider knows its own soft limits and grace behavior better than a threshold guess. Lead the UI with `status`, not raw numbers: a red "critical" chip beats making the user do the arithmetic.

## Versioning

`ai_usage_version` is `MAJOR.MINOR`. Minor bumps are additive (new optional fields, new meter types) — clients ignore unknown fields and unknown meter `type`s. A major bump may change required fields; clients should refuse a major version they don't recognize.

## Conformance → report-card grade

| Grade | What it means |
|---|---|
| **A** | Serves a valid `ai-usage` manifest at a discovery path, with your normal credential, covering at least one of balance/spend. |
| **B** | No manifest, but a clean single-endpoint balance or spend read with your **normal** key (a trivial adapter). |
| **C** | Balance/spend readable via API, but needs a **separate admin/management key**, GraphQL you assemble yourself, or a bolt-on product. |
| **D** | No usage endpoint — only response headers or 429 bodies hint at remaining quota. |
| **F** | No programmatic path at all. Dashboard-only. |

## For providers — why serve it

- **Fewer "what's my balance?" tickets.** The single most common billing question, answered by a ~20-line endpoint.
- **You already have the data.** You compute it for your own dashboard; this exposes it in a shared shape.
- **Your users asked.** They're staring at a client that shows every other provider's number and a blank where yours should be.
- **Earn the badge.** Be the first **A** in your category instead of the red row.

Reference schema: [`ai-usage.schema.json`](./ai-usage.schema.json). Example: [`example.ai-usage.json`](./example.ai-usage.json).
