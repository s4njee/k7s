/**
 * React entry point. Imports global styles (which in turn bundle the fonts and
 * design tokens) and mounts the app.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { startAppearanceSync } from "./hooks/useTheme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { logFrontendError, exportDiagnostics } from "./lib/diagnostics";
import { listen } from "@tauri-apps/api/event";
import { IS_DEMO } from "./providers";

// Before the first render, so nothing paints against the wrong palette or font.
startAppearanceSync();

// B73: anything that throws outside React's tree still reaches the backend log
// (and, when armed, crash reporting) instead of vanishing into the console.
window.addEventListener("error", (e) => logFrontendError("window", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => logFrontendError("unhandledrejection", e.reason));

// File > Export Diagnostics… (B73): the menu emits this event; run the export.
if (!IS_DEMO) {
  void listen("export-diagnostics", () => void exportDiagnostics()).catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
