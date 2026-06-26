use crate::AppState;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

// ── Raw HTTP/1.1 GET over plain TCP ─────────────────────────────────────────
// Using tokio directly (no reqwest) so the same socket stack that handles
// our TCP subscription also drives HTTP — no TLS-library initialisation,
// no connection-pool state, nothing to interfere with plain-HTTP LAN traffic.

async fn http_get_inner(url: &str) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::time::{timeout, Duration};

    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("expected http://, got: {url}"))?;

    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None    => (rest, "/"),
    };
    // Ensure there is a port; default HTTP is 80
    let addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:80")
    };

    let mut stream = timeout(Duration::from_secs(5), TcpStream::connect(&addr))
        .await
        .map_err(|_| format!("connect timeout ({addr})"))?
        .map_err(|e| format!("connect {addr}: {e}"))?;

    // HTTP/1.1 + Connection:close so the server terminates the body by closing,
    // which lets read_to_end work regardless of whether chunked encoding is used.
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    timeout(Duration::from_secs(5), stream.write_all(req.as_bytes()))
        .await
        .map_err(|_| "write timeout".to_string())?
        .map_err(|e| format!("write: {e}"))?;

    let mut raw: Vec<u8> = Vec::with_capacity(131_072);
    timeout(Duration::from_secs(10), stream.read_to_end(&mut raw))
        .await
        .map_err(|_| "read timeout".to_string())?
        .map_err(|e| format!("read: {e}"))?;

    // Split header / body at \r\n\r\n (or \n\n as fallback)
    let (hdr_end, body_start) = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| (i, i + 4))
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n").map(|i| (i, i + 2)))
        .ok_or("no HTTP header terminator in response")?;

    let hdr = std::str::from_utf8(&raw[..hdr_end]).unwrap_or("");

    // HTTP status check
    let status: u16 = hdr
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);
    if status >= 400 {
        return Err(format!("HTTP {status}"));
    }

    let body_raw = &raw[body_start..];

    // Decode chunked transfer encoding when the server uses it
    let body = if hdr.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        decode_chunked(body_raw)
    } else {
        String::from_utf8_lossy(body_raw).into_owned()
    };

    Ok(body)
}

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
    use tokio::net::TcpStream;

    let addr = format!("{host}:{tcp_port}");

    // Cancel any existing task for this address
    if let Some(entry) = TCP_TASKS.lock().await.remove(&addr) {
        let _ = entry.cancel.send(());
    }

    let stream = TcpStream::connect(&addr)
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

        // Subscribe to XML state changes
        let _ = writer.lock().await.write_all(b"SUBSCRIBE XML\r\nSUBSCRIBE TALLY\r\n").await;

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
    #[serde(rename = "interactiveEnabled")]
    pub interactive_enabled: bool,
    #[serde(rename = "readonlyEnabled")]
    pub readonly_enabled: bool,
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

// ── Sync server info & toggles ───────────────────────────────────────────────

#[tauri::command]
pub async fn get_server_info(state: State<'_, AppState>) -> Result<ServerInfo, String> {
    let srv = &state.server;
    let interactive_enabled = *srv.interactive_enabled.read().await;
    let readonly_enabled = *srv.readonly_enabled.read().await;
    Ok(ServerInfo {
        ip: srv.lan_ip.clone(),
        port: srv.sync_port,
        url: format!("http://{}:{}", srv.lan_ip, srv.sync_port),
        readonly_port: srv.readonly_port,
        readonly_url: format!("http://{}:{}", srv.lan_ip, srv.readonly_port),
        interactive_enabled,
        readonly_enabled,
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
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let name = format!("{}_{}.{}", ts, safe_stem, ext);
    let dest = state.server.images_dir.join(&name);
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    let url = format!(
        "http://{}:{}/images/{}",
        state.server.lan_ip, state.server.sync_port, name
    );
    Ok(SaveImageResult { name, url })
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
            url: format!(
                "http://{}:{}/images/{}",
                state.server.lan_ip, state.server.sync_port, name
            ),
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
    format!(
        "http://{}:{}/images",
        state.server.lan_ip, state.server.sync_port
    )
}

// ── NDI source discovery ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn scan_ndi() -> Vec<String> {
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
