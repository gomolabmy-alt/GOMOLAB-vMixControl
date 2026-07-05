fn main() {
    println!("cargo:rerun-if-changed=build_number.txt");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    let n: u64 = std::fs::read_to_string("build_number.txt")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(1);

    // Read version from tauri.conf.json with simple string parsing
    let version = std::fs::read_to_string("tauri.conf.json")
        .ok()
        .and_then(|s| {
            // Find `"version": "x.y.z"` — works without serde_json in build deps
            let key = "\"version\":";
            let pos = s.find(key)? + key.len();
            let rest = s[pos..].trim_start().trim_start_matches('"');
            let end = rest.find('"')?;
            Some(rest[..end].to_string())
        })
        .unwrap_or_else(|| "1.0.0".to_string());

    println!("cargo:rustc-env=BUILD_NUMBER={}.{}", version, n);

    tauri_build::build()
}
