// Prevent an extra console window from opening on Windows in release builds.
// (No effect on macOS/Linux; harmless to keep for cross-platform builds.)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The binary is intentionally thin: all real logic lives in the library crate
// (`k7s_lib`) so it can be exercised by `cargo test` without launching a window.
fn main() {
    k7s_lib::run();
}
