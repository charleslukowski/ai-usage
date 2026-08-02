import { defineConfig } from "vite";

// Frontend lives in src/ (index.html + main.js + engine copy). Vite bundles it
// to ../dist, which tauri.conf.json points at via frontendDist.
export default defineConfig({
  root: "src",
  publicDir: false,
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext",
    // two entry points: the tray panel and the settings window
    rollupOptions: { input: { main: "src/index.html", settings: "src/settings.html" } },
  },
});
