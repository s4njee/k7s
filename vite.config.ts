import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite configuration tuned for Tauri development.
// Tauri expects a fixed dev-server port and needs Vite to leave the process
// foreground-friendly; the settings below mirror the official Tauri template.
export default defineConfig({
  plugins: [react()],

  // Tauri reads TAURI_* env vars; keep Vite quiet about them and don't clear the
  // screen so Rust compiler output stays visible in the same terminal.
  clearScreen: false,

  server: {
    // Fixed port so `tauri.conf.json > build.devUrl` can point at it.
    port: 1420,
    strictPort: true,
    // Fail loudly if HMR websocket can't bind rather than silently degrading.
    host: false,
  },

  // Vitest configuration lives here too (single source of truth).
  test: {
    globals: true,
    environment: "jsdom",
    // Only unit-test the frontend; Rust has its own `cargo test`.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
