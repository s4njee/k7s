/**
 * Provider selection. Exactly one {@link DataProvider} is constructed for the app:
 *   - demo mode (VITE_DEMO=1 or browser outside Tauri): MockProvider — runs anywhere, no cluster
 *   - otherwise (Tauri desktop app):                   TauriProvider — talks to the Rust backend
 *
 * Components import `getProvider()` and never reference a concrete class, keeping
 * the two implementations interchangeable.
 */

import { isTauri } from "@tauri-apps/api/core";
import type { DataProvider } from "./types";
import { MockProvider } from "./mock/MockProvider";
import { TauriProvider } from "./tauri/TauriProvider";

/** True when the app was started in demo mode (Vite env flag) or running in a browser outside Tauri. */
export const IS_DEMO = import.meta.env.VITE_DEMO === "1" || !isTauri();

// Single shared instance for the lifetime of the app.
let instance: DataProvider | null = null;

/** Return the app's data provider (constructed lazily, once). */
export function getProvider(): DataProvider {
  if (!instance) {
    instance = IS_DEMO ? new MockProvider() : new TauriProvider();
  }
  return instance;
}
