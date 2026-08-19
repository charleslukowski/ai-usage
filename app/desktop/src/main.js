import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { poll } from "./engine/engine.mjs";
import { overall as overallOf } from "./engine/manifest.mjs";
import { sampleFrom, prune, burnPerDay, runwayHours, anomaly, series } from "./engine/history.mjs";

const PROVIDERS = [
  { id: "openrouter", field: "k_openrouter" },
  { id: "fal", field: "k_fal" },
  { id: "anthropic", field: "k_anthropic" },
  { id: "deepseek", field: "k_deepseek" },
  { id: "openai", field: "k_openai" },
  { id: "elevenlabs", field: "k_elevenlabs" },
];
const DOT = { ok: "ok", info: "info", low: "low", critical: "critical", unknown: "off" };
const $ = (id) => document.getElementById(id);

// keys.json now holds only non-secret state (history, alert bookkeeping).
// The API keys themselves live in the OS credential store — see secret_* below.
let storePromise;
const getStore = () => (storePromise ??= load("keys.json", { autoSave: true }));

const getSecret = (id) => invoke("secret_get", { id }).catch(() => null);
const setSecret = (id, value) => invoke("secret_set", { id, value });
const delSecret = (id) => invoke("secret_delete", { id }).catch(() => {});

// One-time move of any plaintext keys out of the store. The plaintext copy is
// only removed after reading the secret back, so a keyring failure can't lose a key.
async function migrateSecrets() {
  const s = await getStore();
  let moved = 0;
  const diag = [];
  for (const p of PROVIDERS) {
    const legacy = await s.get(p.id);
    if (!legacy) continue;
    try {
      await invoke("secret_set", { id: p.id, value: legacy });
      const back = await invoke("secret_get", { id: p.id });
      if (back === legacy) {
        await s.delete(p.id);
        moved++;
      } else {
        diag.push(`${p.id}: readback mismatch (${typeof back})`);
      }
    } catch (e) {
      // Never swallow this silently — a failed migration means keys stay in
      // plaintext, and the reason needs to be visible somewhere.
      diag.push(`${p.id}: ${String(e && e.message ? e.message : e)}`);
      console.error("[ai-usage] secret migration failed", p.id, e);
    }
  }
  await s.set("_migrate", { at: new Date().toISOString(), moved, diag });
  await s.save();
  return moved;
}

const POLL_MS = 5 * 60 * 1000;
const STALE_MS = 15 * 60 * 1000;
let history = [];          // rolling samples -> real burn rate
let burnById = {};         // providerId -> observed $/day
let lastSuccess = 0;       // epoch ms of the last good poll
let lastAttempt = 0;
let lastResult = null;     // last good poll, so the panel can paint instantly

async function buildConfig() {
  const s = await getStore();
  const cfg = (await s.get("providerCfg")) || {};
  const providers = [];
  for (const p of PROVIDERS) {
    const c = cfg[p.id] || {};
    if (c.enabled === false) continue; // disabled in settings -> not polled at all
    const thresholds = {};
    if (c.lowUsd != null) thresholds.lowUsd = c.lowUsd;
    if (c.criticalUsd != null) thresholds.criticalUsd = c.criticalUsd;
    providers.push({
      id: p.id,
      enabled: true,
      key: (await getSecret(p.id)) || null,
      ...(Object.keys(thresholds).length ? { thresholds } : {}),
    });
  }
  return { thresholds: { criticalUsd: 5, lowUsd: 20 }, providers };
}

function money(m) {
  if (!m || m.value == null) return "—";
  return m.unit === "USD" ? "$" + m.value.toFixed(2) : m.value + " " + m.unit;
}
// Returns { text, note }. `note` says both DIRECTION (credit you still have vs
// what you've spent) and the PERIOD it covers — "spent" alone is ambiguous
// (month-to-date? lifetime?), so always name the window.
// Compact tokens — the row is narrow, and the row tooltip carries the full
// sentence. "MTD" (month-to-date) answers the "spent when?" question in three
// characters; a wrapped or clipped phrase answered it in none.
const WHEN = { day: " today", week: " wk", month: " MTD", billing_cycle: " cyc", total: " total" };
const DATE_FMT = { day: "numeric", month: "short" };

function daysUntil(iso) {
  const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  return Number.isFinite(d) ? d : null;
}
// Providers reset on their own anniversaries, not a shared 1st-of-month.
// When one reports its real reset, show that instead of a generic period.
function resetNote(iso) {
  const d = daysUntil(iso);
  if (d == null) return "";
  if (d <= 0) return " resets today";
  if (d === 1) return " resets 1d";
  return ` resets ${d}d`;
}
const firstOfNextMonth = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth() + 1, 1);
};

function amountOf(p) {
  const bal = p.meters.find((m) => m.type === "balance");
  if (bal) {
    // Once there's enough history, say how long it actually lasts at the
    // observed burn — measured, not extrapolated from a monthly average.
    const perDay = burnById[p.provider.id];
    const hrs = perDay != null ? runwayHours(bal.value, perDay) : null;
    if (hrs != null) {
      const left = hrs < 48 ? `~${Math.round(hrs)}h` : `~${Math.round(hrs / 24)}d`;
      return {
        text: money(bal),
        note: `${left} left`,
        title: `Burning ~$${perDay.toFixed(2)}/day (measured over the last week). Empty around ${new Date(Date.now() + hrs * 3600000).toLocaleDateString(undefined, DATE_FMT)}.`,
      };
    }
    return {
      text: money(bal),
      note: "left",
      title: perDay === 0
        ? "Prepaid balance — no spend observed yet, so no burn rate."
        : "Prepaid balance — no reset; collecting history to measure burn rate.",
    };
  }

  const q = p.meters.find((m) => m.type === "quota" || m.type === "rate_window");
  if (q && q.value != null && q.limit) {
    const left = q.type === "rate_window" ? q.value / q.limit : (q.limit - q.value) / q.limit;
    const note = q.resets_at ? resetNote(q.resets_at).trim() : "left" + (WHEN[q.period] || "");
    // Show the raw figures too — a bare percentage can't be checked against the
    // provider's own dashboard, and "98%" hides whether it's 5k or 5M used.
    const used = `${q.value.toLocaleString()} of ${q.limit.toLocaleString()} ${q.unit} used`;
    const title = q.resets_at
      ? `${used}. Allowance resets ${new Date(q.resets_at).toLocaleDateString(undefined, DATE_FMT)} (reported by ${p.provider.name}).`
      : `${used}. Allowance resets each period.`;
    return { text: Math.round(left * 100) + "%", note, title };
  }

  const spend = p.meters.find((m) => m.type === "spend");
  if (spend) {
    const monthly = spend.period === "month";
    return {
      text: money(spend),
      note: "spent" + (WHEN[spend.period] || ""),
      // Be honest: this window is the calendar month we query, not a verified
      // billing anniversary — those APIs don't expose the invoice date.
      title: monthly
        ? `Calendar month-to-date; our window rolls over ${firstOfNextMonth().toLocaleDateString(undefined, DATE_FMT)}. ${p.provider.name}'s own billing date may differ.`
        : "Total spent on this key.",
    };
  }

  return { text: "—", note: "", title: "" };
}
// Header shows the app title; status lives in the dot + header tint (and the
// tray tooltip), not in a sentence.

// Small inline SVG trend line. Scaled to its own min/max, so it shows *shape*
// (draining, flat, spiking) rather than absolute level — the number beside it
// already carries the level.
const SVG_NS = "http://www.w3.org/2000/svg";
function sparkline(points, w = 46, h = 14) {
  const vals = points.map((p) => p.v);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const t0 = points[0].t;
  const tspan = points[points.length - 1].t - t0 || 1;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("aria-hidden", "true");

  const coords = points.map((p) => {
    const x = ((p.t - t0) / tspan) * (w - 2) + 1;
    const y = h - 1.5 - ((p.v - lo) / span) * (h - 3);
    return [x, y];
  });

  const line = document.createElementNS(SVG_NS, "polyline");
  line.setAttribute("points", coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "));
  svg.appendChild(line);

  // emphasise where it ends up
  const [ex, ey] = coords[coords.length - 1];
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", ex.toFixed(1));
  dot.setAttribute("cy", ey.toFixed(1));
  dot.setAttribute("r", "1.6");
  dot.setAttribute("class", "spark-end");
  svg.appendChild(dot);
  return svg;
}

// Size the window to fit its content (tray-popup style).
let fitPending = false;
let lastFitHeight = 0;
function fitWindow() {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(async () => {
    fitPending = false;
    const h = Math.min(560, Math.max(80, Math.ceil(document.documentElement.scrollHeight)));
    if (h === lastFitHeight) return; // don't re-set the same size — it flickers
    lastFitHeight = h;
    try { await getCurrentWindow().setSize(new LogicalSize(400, h)); } catch {}
  });
}

// The panel is a tray popup — it hides itself on blur, so it is off-screen
// almost all of the time, and `poll` announces each provider as it lands, so a
// single refresh calls render() once per provider plus once at the end. Doing
// the full DOM rebuild every time meant ~2,000 invisible rebuilds a day. Track
// visibility and defer the DOM until the panel is actually on screen; the tray
// icon still updates every time, because that is the surface you can see.
let panelVisible = false;
let pendingPaint = null;

function render(result) {
  updateTray(result);
  if (!panelVisible) {
    pendingPaint = result; // painted on next show, so opening is never stale
    return;
  }
  pendingPaint = null;
  paintPanel(result);
}

// Only touch the tray when the verdict actually changed. The level and fill are
// identical across the partial paints of a poll, so this collapses seven Win32
// icon rebuilds per poll down to one — and to zero on the common poll where
// nothing moved.
let lastTraySig = "";
function updateTray(result) {
  const o = result.overall;
  const fill = worstHeadroom(result);
  const message = o.message || "";
  const sig = `${o.level}|${message}|${fill.toFixed(3)}`;
  if (sig === lastTraySig) return;
  lastTraySig = sig;
  invoke("set_status", { level: o.level, message, fill }).catch(() => {});
}

function paintPanel(result) {
  const o = result.overall;
  $("hdr").className = "hdr v-" + (o.level || "unknown");
  $("vdot").className = "d " + (DOT[o.level] || "off");

  const rows = $("rows");
  rows.replaceChildren();
  for (const p of result.providers) {
    const row = document.createElement("div");
    row.className = "row";
    const dot = document.createElement("span");
    dot.className = "d " + (DOT[p.summary.status] || "off");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.provider.name;
    const { text, note, title } = amountOf(p);
    // Low balance -> click the row to go straight to that provider's top-up page.
    const url = (p.links && (p.links.topup || p.links.dashboard)) || p.provider.dashboard_url;
    if (url) {
      row.classList.add("clickable");
      row.addEventListener("click", () => openUrl(url).catch(() => {}));
    }
    if (title) row.title = (p.error ? p.error + " — " : "") + (url ? title + " Click to open." : title);
    // trend line, once there's enough history to be meaningful
    const pts = series(history, p.provider.id);
    let spark;
    if (pts) {
      spark = sparkline(pts);
    } else {
      spark = document.createElement("span");
      spark.className = "spark-empty";
    }

    // number and note are separate grid cells so the figures line up in a
    // column instead of being pushed around by note length
    const amt = document.createElement("span");
    amt.className = "amt";
    amt.textContent = text;

    const n = document.createElement("span");
    n.className = "note";
    n.textContent = note || "";

    row.append(dot, name, spark, amt, n);
    rows.appendChild(row);
  }
  fitWindow();
}

// Lowest remaining headroom across providers (0..1) — drives the tray gauge.
// Spend-only providers have no "level", so they don't participate.
function worstHeadroom(result) {
  const low = (result.thresholds && result.thresholds.lowUsd) || 20;
  const levels = [];
  for (const p of result.providers) {
    const bal = p.meters.find((m) => m.type === "balance");
    if (bal && bal.value != null && (bal.unit === "USD" || bal.unit === "credits")) {
      levels.push(Math.min(1, bal.value / (low * 2)));
      continue;
    }
    const q = p.meters.find((m) => m.type === "quota" || m.type === "rate_window");
    if (q && q.value != null && q.limit) {
      levels.push(q.type === "rate_window" ? q.value / q.limit : (q.limit - q.value) / q.limit);
    }
  }
  return levels.length ? Math.max(0, Math.min(...levels)) : 1;
}

// Push a toast only when a provider *crosses* into a worse state — not every
// poll — so sitting just under a threshold doesn't notify every 5 minutes.
const RANK = { unknown: 0, ok: 1, info: 1, low: 2, critical: 3 };
async function notifyOnDrop(result) {
  const s = await getStore();
  const prev = (await s.get("lastStatus")) || {};
  const next = {};
  const dropped = [];

  for (const p of result.providers) {
    const id = p.provider.id;
    const now = p.summary.status;
    next[id] = now;
    if (RANK[now] >= 2 && RANK[now] > (RANK[prev[id]] ?? 0)) dropped.push(p);
  }
  await s.set("lastStatus", next);

  if (!dropped.length) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    for (const p of dropped) {
      const { text, note } = amountOf(p);
      sendNotification({
        title: p.summary.status === "critical" ? `${p.provider.name} is critical` : `${p.provider.name} is running low`,
        body: `${text} ${note}`.trim(),
      });
    }
  } catch {}
}

async function refresh() {
  lastAttempt = Date.now();
  try {
    // Fill rows in as each provider answers. DeepSeek/ElevenLabs return in
    // under a second; OpenAI's cost API takes ~5s — no reason to make the
    // fast ones wait for the slow one before anything appears.
    const partial = new Map((lastResult?.providers || []).map((p) => [p.provider.id, p]));
    const paint = (pr) => {
      partial.set(pr.provider.id, pr);
      const providers = [...partial.values()];
      render({ as_of: new Date().toISOString(), thresholds: lastResult?.thresholds ?? {}, providers, overall: overallOf(providers.map((x) => x.summary)) });
    };

    const result = await poll(await buildConfig(), { http: tauriFetch, onProvider: paint });

    // Record this poll, then recompute burn from the accumulated history.
    const s = await getStore();
    if (!history.length) history = (await s.get("history")) || [];
    history = prune(history.concat(sampleFrom(result)));
    await s.set("history", history);

    burnById = {};
    for (const p of result.providers) {
      const b = burnPerDay(history, p.provider.id);
      if (b != null) burnById[p.provider.id] = b;
    }

    lastSuccess = Date.now();
    lastResult = result;
    render(result);

    // Alerts run once, on the complete result. Called from inside render() they
    // fired on every partial paint, so seven overlapping read-modify-write
    // cycles raced on the same `lastStatus` key — interleaved reads could
    // re-send a notification already sent, or drop a real crossing. They also
    // judged partial data, where most providers still held last poll's values.
    // Failures here must not flip the panel to the error state: the poll
    // itself succeeded.
    try {
      await notifyOnDrop(result);
      await checkAnomalies(result);
    } catch (e) {
      console.error("[ai-usage] alert pass failed", e);
    }
  } catch (e) {
    if (panelVisible) {
      $("vdot").className = "d off";
      $("hdr").className = "hdr v-unknown";
      fitWindow();
    }
  }
  updateFreshness();
}

// A runaway agent drains an account long before a low-balance threshold trips.
async function checkAnomalies(result) {
  const s = await getStore();
  const seen = (await s.get("anomalyAt")) || {};
  const now = Date.now();
  for (const p of result.providers) {
    const id = p.provider.id;
    const a = anomaly(history, id);
    if (!a) continue;
    if (now - (seen[id] || 0) < 6 * 3600000) continue; // at most one alert per provider per 6h
    seen[id] = now;
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) {
        sendNotification({
          title: `${p.provider.name}: unusual spend`,
          body: `$${a.recent.toFixed(2)} in the last hour — about ${Math.round(a.ratio)}× normal.`,
        });
      }
    } catch {}
  }
  await s.set("anomalyAt", seen);
}

// Say plainly when the numbers are old, instead of showing them as current.
function updateFreshness() {
  if (!panelVisible) return; // repainted on show, so it can't be seen stale
  const el = $("updated");
  if (!el) return;
  if (!lastSuccess) {
    el.textContent = "no data yet";
    el.classList.add("stale");
    return;
  }
  const age = Date.now() - lastSuccess;
  const t = new Date(lastSuccess).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const stale = age > STALE_MS;
  el.textContent = stale ? `${t} · stale` : t;
  el.classList.toggle("stale", stale);
}

// Settings gets its own window: the panel auto-hides on blur, so editing keys
// inline would vanish the moment you clicked away to copy one from a dashboard.
$("settings").addEventListener("click", async () => {
  try {
    const w = await WebviewWindow.getByLabel("settings");
    if (w) {
      await w.show();
      await w.setFocus();
    }
  } catch (e) {
    console.error("[ai-usage] could not open settings window", e);
  }
});
$("refresh").addEventListener("click", refresh);
$("hide").addEventListener("click", () => getCurrentWindow().hide());
listen("refresh", refresh);

// Start with Windows, so it's simply there after a reboot.
// PROD only: the dev binary loads from the Vite server, so registering *it*
// for autostart would fail on boot with "localhost refused".
if (import.meta.env.PROD) {
  (async () => {
    // Re-register every launch rather than only when disabled: enable() writes
    // the *current* exe path, so moving/installing the app self-heals instead
    // of leaving autostart pointed at a stale location.
    try {
      await enableAutostart();
    } catch {}
  })();
}

// Opening the panel should never show hours-old numbers as if they were current.
getCurrentWindow()
  .onFocusChanged(({ payload: focused }) => {
    // The Rust side hides the panel the moment it loses focus, so focus is what
    // "on screen" means here — and it's what gates the DOM work in render().
    panelVisible = focused;
    if (!focused) return;
    // Paint what we already know immediately, then update in the background —
    // waiting on six network calls before showing anything made opening the
    // panel feel slow. pendingPaint holds anything that landed while hidden.
    const known = pendingPaint || lastResult;
    if (known) render(known);
    updateFreshness();
    if (Date.now() - lastSuccess > 60000) refresh();
  })
  .catch(() => {});

// A 30s ticker rather than a 5-minute interval: after the machine sleeps, the
// next tick notices the poll is overdue and refreshes immediately, and the
// staleness label stays honest in between.
setInterval(() => {
  if (Date.now() - lastAttempt >= POLL_MS) refresh();
  else updateFreshness();
}, 30000);

// Move any plaintext keys into the credential store, then do the first poll.
migrateSecrets().finally(refresh);
