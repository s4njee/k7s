/**
 * Global ErrorBoundary to catch unexpected runtime render errors
 * and display a styled recovery screen instead of a blank white screen.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { logFrontendError, recordBoundaryTrace, exportDiagnostics } from "../lib/diagnostics";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught runtime error in component tree:", error, errorInfo);
    // B73: the trace lands in the backend log file and is kept for the
    // diagnostics bundle, so a bug report has the stack without re-running.
    logFrontendError("error-boundary", error);
    recordBoundaryTrace(error.stack ?? error.message);
    this.setState({ errorInfo });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleExport = () => {
    void exportDiagnostics();
  };

  private handleReset = () => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100vw",
            height: "100vh",
            background: "var(--bg-app, #0d0d0f)",
            color: "var(--text-primary, #ececf1)",
            fontFamily: "var(--font-mono, JetBrains Mono, monospace)",
            padding: "24px",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              maxWidth: "640px",
              width: "100%",
              background: "var(--bg-panel, #121214)",
              border: "1px solid var(--border-default, #26262b)",
              borderRadius: "8px",
              padding: "24px",
              boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                marginBottom: "16px",
              }}
            >
              <span style={{ color: "var(--status-err, #f7768e)", fontSize: "18px" }}>✕</span>
              <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
                k7s encountered an error
              </h2>
            </div>
            <div
              style={{
                background: "var(--bg-terminal, #0a0a0c)",
                border: "1px solid var(--border-control, #2e2e34)",
                borderRadius: "4px",
                padding: "12px",
                fontSize: "12px",
                color: "var(--status-err, #f7768e)",
                marginBottom: "16px",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {this.state.error?.message || String(this.state.error)}
            </div>
            {this.state.error?.stack && (
              <details
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted, #70707a)",
                  marginBottom: "20px",
                  cursor: "pointer",
                }}
              >
                <summary style={{ marginBottom: "8px" }}>View stack trace</summary>
                <pre
                  style={{
                    margin: 0,
                    padding: "8px",
                    background: "var(--bg-terminal, #0a0a0c)",
                    borderRadius: "4px",
                    overflowX: "auto",
                    color: "var(--text-secondary, #a4a4ae)",
                  }}
                >
                  {this.state.error.stack}
                </pre>
              </details>
            )}
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={this.handleReload}
                style={{
                  background: "var(--accent, #4d9fff)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  padding: "8px 16px",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Reload
              </button>
              <button
                onClick={this.handleReset}
                style={{
                  background: "transparent",
                  color: "var(--text-secondary, #a4a4ae)",
                  border: "1px solid var(--border-control, #2e2e34)",
                  borderRadius: "4px",
                  padding: "8px 16px",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Reset cache & reload
              </button>
              <button
                onClick={this.handleExport}
                title="Log tail, versions and this trace, scrubbed and zipped"
                style={{
                  background: "transparent",
                  color: "var(--text-secondary, #a4a4ae)",
                  border: "1px solid var(--border-control, #2e2e34)",
                  borderRadius: "4px",
                  padding: "8px 16px",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Export diagnostics
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
