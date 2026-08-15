/**
 * Open a URL in the system browser (B89). The Tauri shell plugin's `open` is
 * granted (shell:allow-open) and `http://localhost:<port>` matches the default
 * scope; demo mode is a browser tab with no system browser to delegate to, so
 * it's a no-op there (and the plugin isn't loaded into demo bundles).
 */

import { IS_DEMO } from "../providers";

export async function openExternal(url: string): Promise<void> {
  if (IS_DEMO) return;
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    // best-effort: the URL stays visible in the strip either way
  }
}
