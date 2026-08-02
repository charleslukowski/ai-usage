import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Keep in sync with main.js. Each entry describes what kind of credential the
// provider needs, since they differ meaningfully (admin vs normal vs billing).
const PROVIDERS = [
  { id: "openrouter", name: "OpenRouter", hint: "normal API key" },
  { id: "fal", name: "fal.ai", hint: "billing-scoped key (a normal key returns 403)" },
  { id: "anthropic", name: "Anthropic", hint: "admin key (sk-admin…) — spend only" },
  { id: "deepseek", name: "DeepSeek", hint: "normal API key" },
  { id: "openai", name: "OpenAI", hint: "admin key (sk-admin…) — spend only" },
  { id: "elevenlabs", name: "ElevenLabs", hint: "normal API key" },
];

const $ = (id) => document.getElementById(id);
const store = await load("keys.json", { autoSave: true });
const cfg = (await store.get("providerCfg")) || {};

for (const p of PROVIDERS) {
  const c = cfg[p.id] || {};
  const key = (await invoke("secret_get", { id: p.id }).catch(() => null)) || "";

  const row = document.createElement("section");
  row.className = "sp-row";
  row.innerHTML = `
    <div class="sp-row-head">
      <label class="sp-toggle">
        <input type="checkbox" id="en_${p.id}" ${c.enabled === false ? "" : "checked"} />
        <span class="sp-name">${p.name}</span>
      </label>
      <span class="sp-th">
        <label title="Warn below this balance">low <input type="number" min="0" step="1" id="low_${p.id}" placeholder="20" /></label>
        <label title="Critical below this balance">crit <input type="number" min="0" step="1" id="crit_${p.id}" placeholder="5" /></label>
      </span>
    </div>
    <input class="sp-key" type="password" id="key_${p.id}" placeholder="${p.hint}" />`;
  $("list").appendChild(row);

  $(`key_${p.id}`).value = key;
  if (c.lowUsd != null) $(`low_${p.id}`).value = c.lowUsd;
  if (c.criticalUsd != null) $(`crit_${p.id}`).value = c.criticalUsd;
}

$("save").addEventListener("click", async () => {
  const next = {};
  for (const p of PROVIDERS) {
    const enabled = $(`en_${p.id}`).checked;
    const low = $(`low_${p.id}`).value.trim();
    const crit = $(`crit_${p.id}`).value.trim();
    next[p.id] = {
      enabled,
      ...(low === "" ? {} : { lowUsd: Number(low) }),
      ...(crit === "" ? {} : { criticalUsd: Number(crit) }),
    };

    const v = $(`key_${p.id}`).value.trim();
    try {
      if (v) await invoke("secret_set", { id: p.id, value: v });
      else await invoke("secret_delete", { id: p.id });
    } catch (e) {
      console.error("[ai-usage] saving key failed", p.id, e);
    }
  }
  await store.set("providerCfg", next);
  await store.save();

  // Ask Rust to tell the panel to re-poll with the new config.
  await invoke("request_refresh").catch(() => {});
  $("saved").textContent = "Saved";
  setTimeout(() => ($("saved").textContent = ""), 2000);
});

$("close").addEventListener("click", () => getCurrentWindow().hide());
