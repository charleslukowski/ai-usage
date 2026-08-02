# ai_usage — app (engine + panel)

The local-first core: polls every AI provider you configure, normalizes each to the `ai-usage` manifest shape (`../spec`), and derives a one-glance verdict. Zero dependencies, Node 22+. **This is the production polling logic** — the Tauri packaging just wraps it in a tray.

## Run it now (no keys, no network)

```sh
cd app
node engine/cli.mjs --mock
```

Runs the *real* adapters against built-in fixtures, so the whole pipeline (fetch → normalize → verdict) is verifiable offline. Add `--json` to see the aggregate the UI consumes.

## Run it live

```sh
cp config.example.json config.json      # config.json is gitignored
OPENROUTER_API_KEY=... FAL_KEY=... ANTHROPIC_ADMIN_KEY=sk-admin-... node engine/cli.mjs
```

- **OpenRouter / fal.ai** — your **normal** inference key (grade B).
- **Anthropic** — a separate **Admin** key (`sk-admin…`), and it returns **spend only**; no prepaid-balance API exists (grade C). ⚠️ The Admin cost-report endpoint/shape is the one adapter not yet verified against a live key — confirm it against current docs before trusting the number. `--mock` exercises the full path regardless.

Keys live in `config.json` or env — **never committed** (see `.gitignore`).

## What's here

| File | Role |
|---|---|
| `engine/manifest.mjs` | normalization + verdict/runway logic (pure, browser-safe) |
| `engine/adapters/*.mjs` | OpenRouter, fal.ai, Anthropic (grades B, B, C — see `../reportcard`) |
| `engine/engine.mjs` | poll all providers → per-provider + overall verdict |
| `engine/fixtures.mjs` | mock HTTP + config for offline runs |
| `engine/cli.mjs` | the CLI above |
| `panel-preview.html` | the menu-bar panel design (published as an Artifact) |

Providers with **no usage API** (Claude Max, Hugging Face, Gemini, Together, Groq) aren't polled — the UI shows them as static "no API" rows.

## Wrapping it in Tauri (the native tray)

Not compiled in the session this was built (no Rust toolchain there). On your machine:

1. **Install Rust** via `rustup` (provides `cargo`). Node 22 is already here.
2. **Scaffold the shell:** `npm create tauri-app@latest` → TypeScript + React (or vanilla). Let the generator produce `src-tauri/` — don't hand-author the config.
3. **Drop in the UI:** port `panel-preview.html` into the frontend as the window body.
4. **Slot in the engine** — same code, just inject Tauri's fetch so provider calls bypass CORS and stay native:
   ```js
   import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
   import { poll } from "./engine/engine.mjs";
   const result = await poll(config, { http: tauriFetch });   // result.overall drives the tray colour
   ```
5. **Keys:** `@tauri-apps/plugin-store` (local, gitignored) for v1 → OS keychain (`tauri-plugin-keyring` / stronghold) later. Keys never leave the machine.
6. **Tray:** Tauri v2 `TrayIcon` from JS (`@tauri-apps/api/tray`) — tint the icon/title from `result.overall.level`, toggle a borderless always-on-top window on click. Minimal Rust.
7. **Permissions** (`src-tauri/capabilities/default.json`): enable `http` (allowlist `openrouter.ai`, `api.fal.ai`, `api.anthropic.com`), `store`, and tray. **That http allowlist is the security boundary — keep it tight.**

Then `npm run tauri dev`.
