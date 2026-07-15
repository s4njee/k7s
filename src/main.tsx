/**
 * React entry point. Imports global styles (which in turn bundle the fonts and
 * design tokens) and mounts the app.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
