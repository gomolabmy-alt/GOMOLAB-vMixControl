fn main() {
    // Expose build number baked in at compile time.
    // The number is incremented by scripts/increment-build.mjs before each build.
    println!("cargo:rerun-if-changed=build_number.txt");
    let n: u64 = std::fs::read_to_string("build_number.txt")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(1);
    println!("cargo:rustc-env=BUILD_NUMBER={:06}", n);

    tauri_build::build()
}
