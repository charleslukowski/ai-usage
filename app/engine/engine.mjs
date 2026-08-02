import { summarize, overall } from "./manifest.mjs";
import openrouter from "./adapters/openrouter.mjs";
import fal from "./adapters/fal.mjs";
import anthropic from "./adapters/anthropic.mjs";
import deepseek from "./adapters/deepseek.mjs";
import openai from "./adapters/openai.mjs";
import elevenlabs from "./adapters/elevenlabs.mjs";

// Registry of adapters that actually hit an API. Providers with no usage API
// (Claude Max, Hugging Face, Gemini, Together, Groq, …) are surfaced by the UI
// as static "no API" rows — see ../../reportcard for the full grading.
export const ADAPTERS = { openrouter, fal, anthropic, deepseek, openai, elevenlabs };

/**
 * Poll every enabled provider, normalize, and derive verdicts.
 * @param config  { thresholds?, providers: [{ id, enabled, key }] }
 * @param deps    { http?: fetch-like, now?: Date }
 * @returns { as_of, thresholds, providers: [{...manifest, summary}], overall }
 */
/** One slow provider shouldn't hold up the whole panel. */
function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

export async function poll(config, deps = {}) {
  const http = deps.http ?? globalThis.fetch;
  const now = deps.now ?? new Date();
  const thresholds = config.thresholds ?? {};
  const timeoutMs = config.timeoutMs ?? 8000;

  const enabled = (config.providers ?? []).filter((p) => p.enabled !== false);

  // deps.onProvider fires the moment each provider resolves, so a UI can fill
  // rows in as they arrive rather than waiting on the slowest one.
  const announce = (r) => {
    if (deps.onProvider) {
      try {
        deps.onProvider(r);
      } catch {}
    }
    return r;
  };

  const results = await Promise.all(
    enabled.map(async (p) => {
      const adapter = ADAPTERS[p.id];
      if (!adapter) {
        return announce(withSummary(errorManifest(p.id, p.id, "no adapter"), thresholds, now));
      }
      if (!p.key) {
        return announce(withSummary(errorManifest(adapter.id, adapter.name, "no key configured"), thresholds, now));
      }
      // Per-provider thresholds override the global ones ("low" means something
      // different for a $5 side account than a $500 one).
      const th = { ...thresholds, ...(p.thresholds || {}) };

      // Retry once on failure so a single network blip doesn't surface as an
      // error — but never retry a 4xx (bad/insufficient key): it cannot succeed,
      // and retrying added a pointless 400ms to every single poll.
      // A hung provider is also capped so it can't stall the whole refresh.
      // `timeoutMs` is the budget for the WHOLE attempt sequence, not each try —
      // otherwise a retry doubles the worst case and one slow provider holds
      // up the panel for twice as long as advertised.
      const deadline = Date.now() + timeoutMs;
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          const m = await withTimeout(adapter.read({ key: p.key, http, now }), remaining, adapter.name);
          return announce(withSummary(m, th, now));
        } catch (err) {
          lastErr = err;
          const status = err && err.status;
          if (status >= 400 && status < 500) break;
          if (attempt === 0 && deadline - Date.now() > 500) await new Promise((r) => setTimeout(r, 400));
        }
      }
      return announce(withSummary(errorManifest(adapter.id, adapter.name, String(lastErr?.message ?? lastErr)), th, now));
    })
  );

  return {
    as_of: now.toISOString(),
    thresholds,
    providers: results,
    overall: overall(results.map((r) => r.summary)),
  };
}

function withSummary(m, thresholds, now) {
  return { ...m, summary: summarize(m, thresholds, now) };
}

function errorManifest(id, name, error) {
  return { ai_usage_version: "0.1", provider: { id, name }, as_of: new Date().toISOString(), meters: [], error };
}
