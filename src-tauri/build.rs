// Tauri build script: runs code generation for the app (embeds config, icons,
// capabilities, and the frontend dist path) before the Rust crate is compiled.
fn main() {
    tauri_build::build();
}
