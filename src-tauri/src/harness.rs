//! Shared helpers for the live verification harnesses in `examples/` (B83).
//!
//! Each `examples/*_check.rs` is a self-contained binary that connects to a real
//! cluster and asserts a code path. Today a harness that finds nothing suitable
//! prints a line and returns `Ok(())` — exit 0, indistinguishable from a pass.
//! The manifested runner (`dev/run-harnesses.mjs`) needs to *record* skip, so
//! every skip site should print the machine-readable marker below.

/// Print the `HARNESS_SKIP:` marker the manifested runner keys on. Call it right
/// before the skip's `return Ok(())`, keeping the human-readable line that
/// explains *why*.
pub fn skip(reason: impl std::fmt::Display) {
    println!("\nHARNESS_SKIP: {reason}");
}
