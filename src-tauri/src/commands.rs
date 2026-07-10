use crate::AppState;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

// ── TCP socket that bypasses VPN packet tunnels (macOS) ─────────────────────
// On macOS, VPN Network Extensions (e.g. Speedify) intercept TCP connections
// from GUI apps and route them through the tunnel, causing EHOSTUNREACH for
// LAN addresses that the tunnel cannot reach.  Setting IP_BOUND_IF on the
// socket forces it to use a specific physical interface, bypassing the tunnel.
#[cfg(target_os = "macos")]
fn set_bound_if_en(socket: &tokio::net::TcpSocket) {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    // Walk the physical interfaces (en0, en1, …) and bind to the first one
    // that has an IPv4 address (i.e. is up and connected).
    for iface in ["en0", "en1", "en2"] {
        let name = match CString::new(iface) { Ok(n) => n, Err(_) => continue };
        let idx = unsafe { libc::if_nametoindex(name.as_ptr()) };
        if idx == 0 { continue; }
        let idx = idx as libc::c_int;
        let ret = unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::IPPROTO_IP,
                25, // IP_BOUND_IF — binds socket to a specific interface index
                &idx as *const libc::c_int as *const libc::c_void,
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        };
        if ret == 0 { return; }
    }
}

async fn tcp_connect_direct(addr: &str) -> Result<tokio::net::TcpStream, String> {
    use tokio::net::TcpSocket;
    let dest: SocketAddr = addr.parse().map_err(|e| format!("addr parse: {e}"))?;
    let socket = TcpSocket::new_v4().map_err(|e| format!("socket: {e}"))?;
    #[cfg(target_os = "macos")]
    set_bound_if_en(&socket);
    socket.connect(dest).await.map_err(|e| format!("connect {addr}: {e}"))
}

// ── Raw HTTP/1.1 GET over plain TCP ─────────────────────────────────────────

async fn http_get_inner(url: &str) -> Result<String, String> {
    // On macOS, spawn system curl as a subprocess. curl is a separate Apple
    // binary with its own process identity — Speedify's NEAppProxyProvider
    // per-app filter does not match it, and CORS is irrelevant outside a
    // browser context.  Fallback to raw TCP on other platforms (Windows).
    #[cfg(target_os = "macos")]
    return http_get_curl(url).await;

    #[cfg(not(target_os = "macos"))]
    return http_get_tcp(url).await;
}

#[cfg(target_os = "macos")]
async fn http_get_curl(url: &str) -> Result<String, String> {
    let out = tokio::process::Command::new("/usr/bin/curl")
        .args([
            "--silent",
            "--show-error",
            "--max-time", "10",
            "--connect-timeout", "5",
            "--location",
            url,
        ])
        .output()
        .await
        .map_err(|e| format!("curl spawn: {e}"))?;

    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        let code = out.status.code().unwrap_or(-1);
        return Err(format!("curl({code}): {msg}"));
    }

    String::from_utf8(out.stdout).map_err(|e| format!("curl output encoding: {e}"))
}

#[cfg(not(target_os = "macos"))]
async fn http_get_tcp(url: &str) -> Result<String, String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::time::{timeout, Duration};

    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("expected http://, got: {url}"))?;

    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None    => (rest, "/"),
    };
    let addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:80")
    };

    let stream = timeout(Duration::from_secs(5), tcp_connect_direct(&addr))
        .await
        .map_err(|_| format!("connect timeout ({addr})"))?
        .map_err(|e| e)?;

    // Use buffered reader so we can read headers line-by-line efficiently.
    // vMix responds with Connection: Keep-Alive, so we MUST use Content-Length
    // to know when the body ends — read_to_end would block until timeout.
    let (reader_half, mut writer_half) = stream.into_split();
    let mut reader = BufReader::new(reader_half);

    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    timeout(Duration::from_secs(5), writer_half.write_all(req.as_bytes()))
        .await
        .map_err(|_| "write timeout".to_string())?
        .map_err(|e| format!("write: {e}"))?;

    // Read status line + headers
    let mut status_line = String::new();
    timeout(Duration::from_secs(5), reader.read_line(&mut status_line))
        .await
        .map_err(|_| "header read timeout".to_string())?
        .map_err(|e| format!("header read: {e}"))?;

    let status: u16 = status_line.split_whitespace().nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);
    if status >= 400 {
        return Err(format!("HTTP {status}"));
    }

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    loop {
        let mut hdr_line = String::new();
        timeout(Duration::from_secs(5), reader.read_line(&mut hdr_line))
            .await
            .map_err(|_| "header read timeout".to_string())?
            .map_err(|e| format!("header read: {e}"))?;
        let trimmed = hdr_line.trim();
        if trimmed.is_empty() { break; } // blank line = end of headers
        let lower = trimmed.to_ascii_lowercase();
        if let Some(val) = lower.strip_prefix("content-length:") {
            content_length = val.trim().parse().ok();
        }
        if lower.contains("transfer-encoding") && lower.contains("chunked") {
            chunked = true;
        }
    }

    // Read body using Content-Length when available (vMix uses Keep-Alive so
    // we cannot rely on EOF — read_exact with the known length is required).
    let body = if let Some(len) = content_length {
        let mut buf = vec![0u8; len];
        timeout(Duration::from_secs(10), reader.read_exact(&mut buf))
            .await
            .map_err(|_| "body read timeout".to_string())?
            .map_err(|e| format!("body read: {e}"))?;
        String::from_utf8_lossy(&buf).into_owned()
    } else if chunked {
        let mut raw: Vec<u8> = Vec::with_capacity(131_072);
        timeout(Duration::from_secs(10), reader.read_to_end(&mut raw))
            .await
            .map_err(|_| "body read timeout".to_string())?
            .map_err(|e| format!("body read: {e}"))?;
        decode_chunked(&raw)
    } else {
        let mut raw: Vec<u8> = Vec::with_capacity(131_072);
        timeout(Duration::from_secs(10), reader.read_to_end(&mut raw))
            .await
            .map_err(|_| "body read timeout".to_string())?
            .map_err(|e| format!("body read: {e}"))?;
        String::from_utf8_lossy(&raw).into_owned()
    };

    Ok(body)
}

#[cfg(not(target_os = "macos"))]
fn decode_chunked(data: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        // Find end of chunk-size line
        let line_end = match data[i..].windows(2).position(|w| w == b"\r\n") {
            Some(p) => i + p,
            None    => break,
        };
        let size_hex = std::str::from_utf8(&data[i..line_end])
            .unwrap_or("0")
            .split(';')      // strip chunk extensions
            .next()
            .unwrap_or("0")
            .trim();
        let chunk_size = usize::from_str_radix(size_hex, 16).unwrap_or(0);
        i = line_end + 2;    // skip \r\n after size line
        if chunk_size == 0 { break; }
        let end = i + chunk_size;
        if end > data.len() { break; }
        out.extend_from_slice(&data[i..end]);
        i = end + 2;         // skip \r\n after chunk data
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── vMix TCP subscription task registry ─────────────────────────────────────
// Keyed by "host:tcpPort". cancel_tx shuts down the reader task.
// writer lets us send ad-hoc commands (e.g. "XML\r\n" to force a state push).

struct TcpEntry {
    cancel: oneshot::Sender<()>,
    writer: Arc<AsyncMutex<OwnedWriteHalf>>,
}

static TCP_TASKS: Lazy<AsyncMutex<HashMap<String, TcpEntry>>> =
    Lazy::new(|| AsyncMutex::new(HashMap::new()));

/// Open a persistent TCP connection to vMix port 8099, subscribe to XML state
/// pushes, and emit Tauri events for each update.
///
/// Events emitted (per-connection so multiple hosts are independent):
///   vmix-xml-{host}-{tcp_port}   — full XML payload (String)
///   vmix-tcp-disc-{host}-{tcp_port} — connection dropped (no payload)
#[tauri::command]
pub async fn vmix_tcp_connect(handle: tauri::AppHandle, host: String, tcp_port: u16) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    let addr = format!("{host}:{tcp_port}");

    // Cancel any existing task for this address
    if let Some(entry) = TCP_TASKS.lock().await.remove(&addr) {
        let _ = entry.cancel.send(());
    }

    let stream = tcp_connect_direct(&addr)
        .await
        .map_err(|e| format!("TCP connect to {addr}: {e}"))?;

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let (reader_half, writer_half) = stream.into_split();
    let writer_arc = Arc::new(AsyncMutex::new(writer_half));

    TCP_TASKS.lock().await.insert(addr.clone(), TcpEntry {
        cancel: cancel_tx,
        writer: Arc::clone(&writer_arc),
    });

    let xml_event  = format!("vmix-xml-{host}-{tcp_port}");
    let disc_event = format!("vmix-tcp-disc-{host}-{tcp_port}");
    let handle2    = handle.clone();
    let addr2      = addr.clone();

    tauri::async_runtime::spawn(async move {
        let writer = writer_arc;
        let mut reader = BufReader::new(reader_half);

        // Note: vMix's TCP API only supports SUBSCRIBE for TALLY/ACTS events —
        // "SUBSCRIBE XML" is not a real command (vMix replies "XML ER Not
        // Supported"). Full state has no push mechanism; the frontend polls
        // XML\r\n on a short interval over this same connection instead.
        let _ = writer.lock().await.write_all(b"SUBSCRIBE TALLY\r\n").await;

        let mut line = String::new();
        loop {
            line.clear();
            tokio::select! {
                _ = &mut cancel_rx => break,
                result = reader.read_line(&mut line) => {
                    match result {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let trimmed = line.trim_end_matches(['\r', '\n']);
                            if let Some(len_str) = trimmed.strip_prefix("XML ") {
                                if let Ok(len) = len_str.trim().parse::<usize>() {
                                    let mut buf = vec![0u8; len];
                                    match reader.read_exact(&mut buf).await {
                                        Ok(_) => {
                                            if let Ok(xml) = String::from_utf8(buf) {
                                                let _ = handle2.emit(&xml_event, xml);
                                            }
                                        }
                                        Err(_) => break,
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let _ = handle2.emit(&disc_event, ());
        TCP_TASKS.lock().await.remove(&addr2);
    });

    Ok(())
}

/// Close the TCP subscription for the given host:tcp_port.
#[tauri::command]
pub async fn vmix_tcp_disconnect(host: String, tcp_port: u16) {
    let addr = format!("{host}:{tcp_port}");
    if let Some(entry) = TCP_TASKS.lock().await.remove(&addr) {
        let _ = entry.cancel.send(());
    }
}

/// Send a vMix FUNCTION command over the existing TCP connection.
/// `cmd` is the pre-formatted line, e.g. "FUNCTION SetText Input=x&SelectedName=y&Value=z"
/// (vMix's documented TCP API requires '&'-joined params, same as an HTTP query string).
/// Returns Err if no TCP connection exists — caller should fall back to HTTP.
#[tauri::command]
pub async fn vmix_tcp_function(host: String, tcp_port: u16, cmd: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let addr = format!("{host}:{tcp_port}");
    let writer = {
        let tasks = TCP_TASKS.lock().await;
        tasks.get(&addr)
            .map(|e| Arc::clone(&e.writer))
            .ok_or_else(|| "no TCP connection".to_string())?
    };
    let mut line = cmd.trim_end_matches(['\r', '\n']).to_string();
    line.push_str("\r\n");
    let mut guard = writer.lock().await;
    guard.write_all(line.as_bytes()).await
        .map_err(|e| format!("TCP write: {e}"))
}

/// Send "XML\r\n" through the existing TCP connection to force an immediate
/// vMix state push. Call this after any button/function command so the UI
/// updates within milliseconds via the TCP push path (no extra HTTP poll).
#[tauri::command]
pub async fn vmix_tcp_refresh(host: String, tcp_port: u16) {
    use tokio::io::AsyncWriteExt;
    let addr = format!("{host}:{tcp_port}");
    let tasks = TCP_TASKS.lock().await;
    if let Some(entry) = tasks.get(&addr) {
        let _ = entry.writer.lock().await.write_all(b"XML\r\n").await;
    }
}

#[derive(Serialize)]
pub struct ServerInfo {
    pub ip: String,
    pub port: u16,
    pub url: String,
    #[serde(rename = "readonlyPort")]
    pub readonly_port: u16,
    #[serde(rename = "readonlyUrl")]
    pub readonly_url: String,
    #[serde(rename = "commentatorPort")]
    pub commentator_port: u16,
    #[serde(rename = "commentatorUrl")]
    pub commentator_url: String,
    #[serde(rename = "interactiveEnabled")]
    pub interactive_enabled: bool,
    #[serde(rename = "readonlyEnabled")]
    pub readonly_enabled: bool,
    #[serde(rename = "commentatorEnabled")]
    pub commentator_enabled: bool,
}

#[derive(Serialize)]
pub struct SaveImageResult {
    pub name: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct ImageInfo {
    pub name: String,
    pub url: String,
}

// ── Build info ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_build_number() -> &'static str {
    env!("BUILD_NUMBER")
}

// ── vMix HTTP proxy ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn http_get(url: String) -> Result<String, String> {
    http_get_inner(&url).await
}

// ── TCP connectivity test (debug only) ───────────────────────────────────────

#[tauri::command]
pub async fn tcp_test(host: String, port: u16) -> String {
    use std::time::Duration;
    use tokio::net::TcpStream;
    use tokio::time::timeout;
    let addr = format!("{host}:{port}");
    match timeout(Duration::from_secs(5), TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => format!("OK: connected to {addr}"),
        Ok(Err(e)) => format!("FAIL: {e} (addr={addr})"),
        Err(_) => format!("TIMEOUT after 5s (addr={addr})"),
    }
}

// ── Connection diagnostic ────────────────────────────────────────────────────
// Tries every available connection method and returns a plaintext report.
// Called from the "Test" button in the connect dialog so the user can see
// exactly which method works and what error each failing method returns.

#[tauri::command]
pub async fn diagnose_vmix(host: String, port: u16) -> String {
    use tokio::time::{timeout, Duration};

    let mut out: Vec<String> = Vec::new();
    let http_url = format!("http://{}:{}/api/", host, port);

    // ── Method 1: curl subprocess ─────────────────────────────────────────
    #[cfg(target_os = "macos")]
    {
        out.push(format!("[1] curl → {http_url}"));
        match http_get_curl(&http_url).await {
            Ok(body) => {
                let snippet: String = body.chars().take(100).collect();
                out.push(format!("    OK  {} bytes | {}", body.len(), snippet.replace('\n', " ")));
            }
            Err(e) => out.push(format!("    ERR {}", e.trim())),
        }
    }

    // ── Method 2: raw TCP with IP_BOUND_IF to HTTP port ───────────────────
    let addr_http = format!("{}:{}", host, port);
    out.push(format!("[2] tcp+boundif → {addr_http}"));
    match timeout(Duration::from_secs(5), tcp_connect_direct(&addr_http)).await {
        Ok(Ok(_))  => out.push("    OK".to_string()),
        Ok(Err(e)) => out.push(format!("    ERR {e}")),
        Err(_)     => out.push("    TIMEOUT".to_string()),
    }

    // ── Method 3: raw plain TCP to HTTP port ──────────────────────────────
    out.push(format!("[3] tcp plain → {addr_http}"));
    match timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(&addr_http)).await {
        Ok(Ok(_))  => out.push("    OK".to_string()),
        Ok(Err(e)) => out.push(format!("    ERR {e}")),
        Err(_)     => out.push("    TIMEOUT".to_string()),
    }

    // ── Method 4: raw plain TCP to vMix TCP port 8099 ─────────────────────
    let addr_tcp = format!("{}:8099", host);
    out.push(format!("[4] tcp plain → {addr_tcp}"));
    match timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(&addr_tcp)).await {
        Ok(Ok(_))  => out.push("    OK".to_string()),
        Ok(Err(e)) => out.push(format!("    ERR {e}")),
        Err(_)     => out.push("    TIMEOUT".to_string()),
    }

    // ── Method 5: curl to TCP port (proves curl subprocess can reach LAN) ─
    #[cfg(target_os = "macos")]
    {
        let tcp_check_url = format!("http://{}:8099/", host);
        out.push(format!("[5] curl → {tcp_check_url} (expect fail on protocol, not network)"));
        let res = tokio::process::Command::new("/usr/bin/curl")
            .args(["--silent", "--connect-timeout", "5", "--max-time", "6",
                   "--write-out", "%{http_code}", "--output", "/dev/null",
                   &tcp_check_url])
            .output()
            .await;
        match res {
            Ok(o) => {
                let code = o.status.code().unwrap_or(-1);
                let http_code = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                out.push(format!("    exit={code} http={http_code} err={stderr}"));
            }
            Err(e) => out.push(format!("    spawn ERR {e}")),
        }
    }

    out.join("\n")
}

// ── Sync server info & toggles ───────────────────────────────────────────────

#[tauri::command]
pub async fn get_server_info(state: State<'_, AppState>) -> Result<ServerInfo, String> {
    let srv = &state.server;
    let interactive_enabled = *srv.interactive_enabled.read().await;
    let readonly_enabled = *srv.readonly_enabled.read().await;
    let commentator_enabled = *srv.commentator_enabled.read().await;
    Ok(ServerInfo {
        ip: srv.lan_ip.clone(),
        port: srv.sync_port,
        url: format!("http://{}:{}", srv.lan_ip, srv.sync_port),
        readonly_port: srv.readonly_port,
        readonly_url: format!("http://{}:{}", srv.lan_ip, srv.readonly_port),
        commentator_port: srv.commentator_port,
        commentator_url: format!("http://{}:{}", srv.lan_ip, srv.commentator_port),
        interactive_enabled,
        readonly_enabled,
        commentator_enabled,
    })
}

#[tauri::command]
pub async fn toggle_interactive(state: State<'_, AppState>) -> Result<bool, String> {
    let mut enabled = state.server.interactive_enabled.write().await;
    *enabled = !*enabled;
    if !*enabled {
        state.server.interactive_clients.lock().await.clear();
    }
    Ok(*enabled)
}

#[tauri::command]
pub async fn toggle_readonly(state: State<'_, AppState>) -> Result<bool, String> {
    let mut enabled = state.server.readonly_enabled.write().await;
    *enabled = !*enabled;
    if !*enabled {
        state.server.readonly_clients.lock().await.clear();
    }
    Ok(*enabled)
}

#[tauri::command]
pub async fn toggle_commentator(state: State<'_, AppState>) -> Result<bool, String> {
    let mut enabled = state.server.commentator_enabled.write().await;
    *enabled = !*enabled;
    if !*enabled {
        state.server.commentator_clients.lock().await.clear();
    }
    Ok(*enabled)
}

// ── Power save blocker ───────────────────────────────────────────────────────

#[tauri::command]
pub fn set_sleep_block(block: bool, state: State<'_, AppState>) {
    let mut guard = state.caffeinate.lock().unwrap();
    if block {
        if guard.is_none() {
            let child = spawn_sleep_blocker();
            if let Some(c) = child {
                *guard = Some(c);
            }
        }
    } else if let Some(mut child) = guard.take() {
        let _ = child.kill();
    }
}

#[cfg(target_os = "macos")]
fn spawn_sleep_blocker() -> Option<std::process::Child> {
    // caffeinate -i: prevent idle sleep; -d: prevent display sleep
    std::process::Command::new("caffeinate").args(["-id"]).spawn().ok()
}

#[cfg(target_os = "windows")]
fn spawn_sleep_blocker() -> Option<std::process::Child> {
    // Send a harmless F15 keypress every 30 s via WScript.Shell to keep the
    // system awake without requiring admin rights or changing system settings.
    std::process::Command::new("powershell")
        .args([
            "-NoProfile", "-WindowStyle", "Hidden", "-Command",
            "while($true){(New-Object -ComObject WScript.Shell).SendKeys('{F15}');Start-Sleep 30}",
        ])
        .spawn()
        .ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn spawn_sleep_blocker() -> Option<std::process::Child> {
    None
}

// ── Image management ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_image_dialog() -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new()
        .set_title("Select Logo Image")
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "svg"])
        .pick_file()
        .await;
    Ok(file.map(|f| f.path().to_string_lossy().to_string()))
}

// Picks a filename that keeps the original stem where possible, only adding
// a "_2", "_3", … suffix if a file with that exact name already exists —
// so the library shows recognizable names instead of a timestamp prefix.
fn unique_dest_name(dir: &Path, safe_stem: &str, ext: &str) -> String {
    let plain = format!("{}.{}", safe_stem, ext);
    if !dir.join(&plain).exists() {
        return plain;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{}_{}.{}", safe_stem, n, ext);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

#[tauri::command]
pub fn save_image(src_path: String, state: State<'_, AppState>) -> Result<SaveImageResult, String> {
    let src = Path::new(&src_path);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let safe_stem: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let name = unique_dest_name(&state.server.images_dir, &safe_stem, ext);
    let dest = state.server.images_dir.join(&name);
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    // Use localhost so the URL remains valid regardless of which network interface
    // is active. setImageField rewrites to the LAN IP when sending to vMix.
    let url = format!("http://localhost:{}/images/{}", state.server.sync_port, name);
    Ok(SaveImageResult { name, url })
}

#[tauri::command]
pub fn rename_image(old_name: String, new_name: String, state: State<'_, AppState>) -> Result<SaveImageResult, String> {
    let dir = &state.server.images_dir;
    let old_file = dir.join(Path::new(&old_name).file_name().ok_or("invalid filename")?);
    if !old_file.exists() {
        return Err("file not found".into());
    }
    let ext = old_file.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let safe_stem: String = Path::new(&new_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let name = if old_file.file_name().and_then(|n| n.to_str()) == Some(&format!("{}.{}", safe_stem, ext)) {
        // Renaming to the same name — nothing to do.
        old_name.clone()
    } else {
        unique_dest_name(dir, &safe_stem, ext)
    };
    let dest = dir.join(&name);
    std::fs::rename(&old_file, &dest).map_err(|e| e.to_string())?;
    let url = format!("http://localhost:{}/images/{}", state.server.sync_port, name);
    Ok(SaveImageResult { name, url })
}

// Restores an image from a Project export (base64-embedded file data). Kept
// idempotent — if a file with that exact name already exists (e.g. re-importing
// the same project, or the image was never deleted), it's left untouched
// rather than duplicated with a numeric suffix.
#[tauri::command]
pub fn import_image(name: String, data_base64: String, state: State<'_, AppState>) -> Result<SaveImageResult, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| e.to_string())?;
    let dir = &state.server.images_dir;
    let safe_name = Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png")
        .to_string();
    let dest = dir.join(&safe_name);
    if !dest.exists() {
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }
    let url = format!("http://localhost:{}/images/{}", state.server.sync_port, safe_name);
    Ok(SaveImageResult { name: safe_name, url })
}

#[tauri::command]
pub fn list_images(state: State<'_, AppState>) -> Vec<ImageInfo> {
    let dir = &state.server.images_dir;
    std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| {
            let lower = name.to_lowercase();
            lower.ends_with(".png")
                || lower.ends_with(".jpg")
                || lower.ends_with(".jpeg")
                || lower.ends_with(".gif")
                || lower.ends_with(".webp")
                || lower.ends_with(".svg")
        })
        .map(|name| ImageInfo {
            url: format!("http://localhost:{}/images/{}", state.server.sync_port, name),
            name,
        })
        .collect()
}

#[tauri::command]
pub fn delete_image(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let file = state.server.images_dir.join(
        Path::new(&name)
            .file_name()
            .ok_or("invalid filename")?,
    );
    if file.exists() {
        std::fs::remove_file(file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_images_base_url(state: State<'_, AppState>) -> String {
    // Re-detect the LAN IP on every call (not the cached startup value) — this
    // command feeds URLs that get persisted into widget/tournament config and
    // outlive network changes, so a stale IP here silently breaks logos forever.
    format!(
        "http://{}:{}/images",
        crate::get_lan_ip(),
        state.server.sync_port
    )
}

// ── Local IP discovery ───────────────────────────────────────────────────────

#[tauri::command]
pub fn get_local_ips() -> Vec<String> {
    #[cfg(unix)]
    {
        let mut result = Vec::new();
        unsafe {
            let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
            if libc::getifaddrs(&mut ifap) != 0 {
                return result;
            }
            let mut ifa = ifap;
            while !ifa.is_null() {
                let addr_ptr = (*ifa).ifa_addr;
                if !addr_ptr.is_null() && ((*addr_ptr).sa_family as i32) == libc::AF_INET {
                    let sin = addr_ptr as *const libc::sockaddr_in;
                    let bytes = (*sin).sin_addr.s_addr.to_ne_bytes();
                    if bytes[0] != 127 {
                        result.push(format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]));
                    }
                }
                ifa = (*ifa).ifa_next;
            }
            libc::freeifaddrs(ifap);
        }
        result
    }
    #[cfg(not(unix))]
    {
        vec![]
    }
}

// ── NDI source discovery + live preview ─────────────────────────────────────

#[tauri::command]
pub async fn scan_ndi() -> Vec<String> {
    // Prefer the real NDI Find API (exact names, no mDNS timing flakiness)
    // when the NDI runtime is installed — falls back to mDNS below otherwise.
    if crate::ndi::is_available() {
        return tokio::task::spawn_blocking(|| crate::ndi::scan_sources(2500))
            .await
            .unwrap_or_default();
    }

    use std::{collections::HashSet, process::Stdio, time::Duration};
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = match tokio::process::Command::new("dns-sd")
        .args(["-B", "_ndi._tcp", "local"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return vec![],
    };

    let mut reader = BufReader::new(stdout).lines();
    let mut sources = HashSet::new();

    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        while let Ok(Some(line)) = reader.next_line().await {
            if line.contains("Add") && line.contains("_ndi._tcp") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if let Some(name) = parts.last() {
                    if !name.starts_with('_') && !name.is_empty() {
                        sources.insert(name.to_string());
                    }
                }
            }
        }
    })
    .await;

    let _ = child.kill().await;
    sources.into_iter().collect()
}

#[tauri::command]
pub fn ndi_runtime_available() -> bool {
    crate::ndi::is_available()
}

#[tauri::command]
pub fn ndi_preview_start(
    source: String,
    low_bandwidth: bool,
    fps: u32,
    quality: u8,
) -> Result<String, String> {
    crate::ndi::start_preview(source, crate::ndi::PreviewOptions { low_bandwidth, fps, quality })
}

#[tauri::command]
pub fn ndi_preview_stop(id: String) {
    crate::ndi::stop_preview(&id);
}

#[tauri::command]
pub fn get_ndi_preview_base_url(state: State<'_, AppState>) -> String {
    format!("http://{}:{}/ndi-preview", state.server.lan_ip, state.server.sync_port)
}
