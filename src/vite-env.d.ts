/// <reference types="vite/client" />

// Typed access to the app's Vite env vars (see providers/index.ts).
interface ImportMetaEnv {
  /** "1" enables demo mode (MockProvider instead of the real Tauri backend). */
  readonly VITE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
