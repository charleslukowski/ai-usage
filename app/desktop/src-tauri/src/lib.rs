use std::sync::{LazyLock, Mutex};
use std::time::Instant;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewWindow, WindowEvent,
};

// When the panel loses focus it hides itself. Clicking the tray icon to dismiss
// it also blurs it, so the tray handler would immediately re-show the window.
// Record when we hid and swallow a show that lands right after.
static LAST_HIDE: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));

fn mark_hidden() {
    if let Ok(mut g) = LAST_HIDE.lock() {
        *g = Some(Instant::now());
    }
}

fn hidden_just_now() -> bool {
    LAST_HIDE
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|t| t.elapsed().as_millis() < 400)
        .unwrap_or(false)
}

// A 32x32 gauge-ring tray icon: a faint track with a solid arc filled to
// `fill` (0..1 = worst remaining headroom across providers), in the status
// colour. A big shape is deliberate — Windows downscales tray icons to 16px,
// which would destroy rendered digits but keeps an arc perfectly readable.
fn status_icon(level: &str, fill: f64) -> Image<'static> {
    let (r, g, b) = match level {
        "critical" => (179u8, 38u8, 30u8),
        "low" => (176u8, 125u8, 23u8),
        "ok" | "info" => (26u8, 138u8, 85u8),
        _ => (150u8, 150u8, 150u8),
    };
    let fill = fill.clamp(0.0, 1.0);
    let size: u32 = 32;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let c = size as f64 / 2.0;
    let (outer, inner) = (15.0f64, 9.0f64);
    let tau = std::f64::consts::PI * 2.0;

    for y in 0..size {
        for x in 0..size {
            let dx = x as f64 + 0.5 - c;
            let dy = y as f64 + 0.5 - c;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist > outer || dist < inner {
                continue;
            }
            // angle measured clockwise from 12 o'clock
            let mut ang = dx.atan2(-dy);
            if ang < 0.0 {
                ang += tau;
            }
            let idx = ((y * size + x) * 4) as usize;
            if ang <= fill * tau {
                rgba[idx] = r;
                rgba[idx + 1] = g;
                rgba[idx + 2] = b;
                rgba[idx + 3] = 255;
            } else {
                // unfilled track — same hue, mostly transparent
                rgba[idx] = r;
                rgba[idx + 1] = g;
                rgba[idx + 2] = b;
                rgba[idx + 3] = 60;
            }
        }
    }
    Image::new_owned(rgba, size, size)
}

// --- secrets -------------------------------------------------------------
// API keys live in the OS credential store (Windows Credential Manager /
// macOS Keychain / secret-service), never in a plaintext file next to the app.
const KEYRING_SERVICE: &str = "com.lukow.aiusage";

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_set(id: String, value: String) -> Result<(), String> {
    entry(&id)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(id: String) -> Result<Option<String>, String> {
    match entry(&id)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// Settings window asks the panel to re-poll after config changes.
#[tauri::command]
fn request_refresh(app: tauri::AppHandle) {
    let _ = app.emit("refresh", ());
}

#[tauri::command]
fn secret_delete(id: String) -> Result<(), String> {
    match entry(&id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// The webview calls this after each poll to reflect the verdict in the tray.
#[tauri::command]
fn set_status(app: tauri::AppHandle, level: String, message: String, fill: Option<f64>) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(message.as_str()));
        let _ = tray.set_icon(Some(status_icon(&level, fill.unwrap_or(1.0))));
    }
}

fn toggle_window(win: &WebviewWindow, near: Option<(f64, f64)>) {
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        mark_hidden();
        return;
    }
    // This click is what blurred (and auto-hid) the panel — don't reopen it.
    if hidden_just_now() {
        return;
    }
    if let Some((x, y)) = near {
        let (w, h) = win
            .outer_size()
            .map(|s| (s.width as f64, s.height as f64))
            .unwrap_or((384.0, 560.0));
        let px = (x - w).max(0.0);
        let py = (y - h).max(0.0);
        let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
    }
    let _ = win.show();
    let _ = win.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            set_status,
            secret_set,
            secret_get,
            secret_delete,
            request_refresh
        ])
        // Click anywhere outside the panel -> it dismisses to the tray.
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    mark_hidden();
                }
            }
        })
        .setup(|app| {
            let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&refresh, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(status_icon("unknown", 1.0))
                .tooltip("AI Usage \u{2014} starting\u{2026}")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "refresh" => {
                        let _ = app.emit("refresh", ());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            toggle_window(&win, Some((position.x, position.y)));
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
