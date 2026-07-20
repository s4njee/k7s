/// <reference types="vite/client" />

// Typed access to the app's Vite env vars (see providers/index.ts).
interface ImportMetaEnv {
  /** "1" enables demo mode (MockProvider instead of the real Tauri backend). */
  readonly VITE_DEMO?: string;
  /**
   * Demo-only stress fixture for table virtualization (B21): a row count that
   * pads the mock pods list to that many synthetic rows, e.g.
   * `VITE_DEMO=1 VITE_STRESS=5000 npm run dev`. Ignored outside demo mode.
   */
  readonly VITE_STRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
