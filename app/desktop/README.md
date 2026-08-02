# AI Usage — desktop (Tauri tray app)

The taskbar/tray front end for the engine. A status-coloured tray icon; click it for the panel (balance + spend per provider, verdict-first).

## Prerequisites (already satisfied on this machine)

- **Rust** (`rustup`, MSVC toolchain) — installed.
- **MSVC C++ build tools** — present (VS Build Tools 2022, toolset 14.44).
- **WebView2 runtime** — present.
- **Node 22** — present.

## ⚠️ Always build with `npm run tauri build` — never `cargo build --release`

`tauri build` enables the **`custom-protocol`** Cargo feature, which is what makes the
release binary serve its own embedded frontend. A bare `cargo build --release` compiles
fine and produces a runnable exe, but that exe still points at the dev server
(`localhost:1420`) — so with Vite stopped it loads a **blank page**: no JS, no IPC, no
store writes, and every feature silently does nothing. Cost an hour of debugging once.
(For a quick Rust-only syntax check, `cargo build` for the *debug* target is fine.)

## Run

```sh
cd ai_usage/app/desktop
npm install                # once
npm run tauri dev          # dev, hot-reload — the tray icon appears
# or a distributable:
npm run tauri build        # release exe + installer under src-tauri/target/release
```

First run: left-click the tray icon → the panel opens → click ⚙ → paste your keys → **Save & refresh**.

- **OpenRouter** — your normal key (shows a balance immediately).
- **fal.ai** — a *billing-scoped* key (a standard inference key returns 403).
- **Anthropic** — an *admin* key (`sk-admin…`); shows month-to-date spend, no balance.

Keys are stored by the Tauri **store** plugin (`keys.json` in the OS app-data dir) — never in the repo.

## Architecture

- **Frontend** (`src/`, bundled by Vite): `index.html` + `styles.css` = the panel; `main.js` loads keys from the store, calls `poll()` injecting `@tauri-apps/plugin-http`'s `fetch` (native, CORS-free, host-scoped), renders, and pushes the verdict to the tray via `invoke("set_status")`.
- **Engine** (`src/engine/`): **copied from `../engine`** (the non-CLI modules — pure `fetch` + logic). ⚠️ Re-copy after changing the engine: `Copy-Item ../engine/manifest.mjs,../engine/engine.mjs src/engine; Copy-Item ../engine/adapters/*.mjs src/engine/adapters`.
- **Rust** (`src-tauri/`): builds the tray (icon generated from RGBA in the worst-status colour), the hidden frameless panel window, and the `set_status` command. Left-click toggles the panel; right-click → Refresh / Quit.
- **Security**: the `http` permission is **scoped** to `openrouter.ai`, `api.fal.ai`, `api.anthropic.com` in `src-tauri/capabilities/default.json` — the app can't call anything else.
