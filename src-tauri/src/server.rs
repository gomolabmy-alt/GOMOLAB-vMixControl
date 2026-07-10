use axum::{
    Router,
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Multipart, Path, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use include_dir::{include_dir, Dir};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::sync::{mpsc, Mutex, RwLock};
use uuid::Uuid;

// The frontend dist/ directory is embedded at compile time.
// Run `npm run build` before `cargo build` / `tauri build`.
static DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist");

pub type ClientSender = mpsc::UnboundedSender<Message>;
pub type ClientList = Arc<Mutex<Vec<(Uuid, ClientSender)>>>;

/// One connected browser client entry (readonly or commentator)
#[derive(Clone)]
pub struct BrowserClientEntry {
    pub id: Uuid,
    pub ip: String,
    pub kind: &'static str, // "readonly" | "commentator"
}

pub type BrowserClientList = Arc<Mutex<Vec<BrowserClientEntry>>>;

#[derive(Clone)]
pub struct ServerState {
    pub interactive_clients: ClientList,
    pub readonly_clients: ClientList,
    pub commentator_clients: ClientList,
    pub browser_clients: BrowserClientList,
    pub cached_state: Arc<RwLock<Option<String>>>,
    pub commentator_cached_state: Arc<RwLock<Option<String>>>,
    pub cached_vmix_state: Arc<RwLock<Option<String>>>,
    pub cached_vmix_data: Arc<RwLock<Option<String>>>,
    pub interactive_enabled: Arc<RwLock<bool>>,
    pub readonly_enabled: Arc<RwLock<bool>>,
    pub commentator_enabled: Arc<RwLock<bool>>,
    pub lan_ip: String,
    pub sync_port: u16,
    pub readonly_port: u16,
    pub commentator_port: u16,
    pub images_dir: PathBuf,
}

impl ServerState {
    pub fn new(
        lan_ip: String,
        sync_port: u16,
        readonly_port: u16,
        commentator_port: u16,
        images_dir: PathBuf,
    ) -> Self {
        Self {
            interactive_clients: Arc::new(Mutex::new(vec![])),
            readonly_clients: Arc::new(Mutex::new(vec![])),
            commentator_clients: Arc::new(Mutex::new(vec![])),
            browser_clients: Arc::new(Mutex::new(vec![])),
            cached_state: Arc::new(RwLock::new(None)),
            commentator_cached_state: Arc::new(RwLock::new(None)),
            cached_vmix_state: Arc::new(RwLock::new(None)),
            cached_vmix_data: Arc::new(RwLock::new(None)),
            interactive_enabled: Arc::new(RwLock::new(true)),
            readonly_enabled: Arc::new(RwLock::new(true)),
            commentator_enabled: Arc::new(RwLock::new(true)),
            lan_ip,
            sync_port,
            readonly_port,
            commentator_port,
            images_dir,
        }
    }
}

// ── Static file serving from embedded dist ───────────────────────────────────

fn serve_dist_file(path: &str) -> Response {
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = DIST.get_file(path) {
        let mime = mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string();
        let cache = if path == "index.html" {
            "no-store"
        } else {
            "max-age=31536000, immutable"
        };
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, mime.as_str()),
                (header::CACHE_CONTROL, cache),
            ],
            Body::from(file.contents()),
        )
            .into_response();
    }

    // SPA fallback
    if let Some(index) = DIST.get_file("index.html") {
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            Body::from(index.contents()),
        )
            .into_response();
    }

    (StatusCode::NOT_FOUND, "not found").into_response()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Serialise the current browser_clients list and push it to all interactive clients.
async fn broadcast_client_list(state: &Arc<ServerState>) {
    let entries = state.browser_clients.lock().await;
    let json = format!(
        r#"{{"type":"CLIENT_LIST","clients":[{}]}}"#,
        entries
            .iter()
            .map(|e| format!(r#"{{"ip":"{}","kind":"{}"}}"#, e.ip, e.kind))
            .collect::<Vec<_>>()
            .join(",")
    );
    drop(entries);
    broadcast(&state.interactive_clients, &json).await;
}

async fn broadcast(clients: &ClientList, text: &str) {
    let mut dead = Vec::new();
    {
        let guard = clients.lock().await;
        for (id, tx) in guard.iter() {
            if tx.send(Message::Text(text.to_owned())).is_err() {
                dead.push(*id);
            }
        }
    }
    if !dead.is_empty() {
        clients.lock().await.retain(|(id, _)| !dead.contains(id));
    }
}

// ── Routers ──────────────────────────────────────────────────────────────────

pub fn make_interactive_router(state: Arc<ServerState>) -> Router {
    use tower_http::cors::{Any, CorsLayer};
    use tower_http::services::ServeDir;

    let images_dir = state.images_dir.clone();
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);

    Router::new()
        .route("/", get(interactive_root_handler))
        .route("/api/images", get(api_list_images).post(api_upload_image))
        .route("/ndi-preview/:id", get(ndi_preview_handler))
        .nest_service("/images", ServeDir::new(images_dir))
        .fallback(|uri: Uri| async move { serve_dist_file(uri.path()) })
        .layer(cors)
        .with_state(state)
}

pub fn make_readonly_router(state: Arc<ServerState>) -> Router {
    use tower_http::cors::{Any, CorsLayer};
    use tower_http::services::ServeDir;

    let images_dir = state.images_dir.clone();
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);

    Router::new()
        .route("/", get(readonly_root_handler))
        .route("/api/images", get(api_list_images).post(api_upload_image))
        .route("/ndi-preview/:id", get(ndi_preview_handler))
        .nest_service("/images", ServeDir::new(images_dir))
        .fallback(|uri: Uri| async move { serve_dist_file(uri.path()) })
        .layer(cors)
        .with_state(state)
}

pub fn make_commentator_router(state: Arc<ServerState>) -> Router {
    use tower_http::cors::{Any, CorsLayer};
    use tower_http::services::ServeDir;

    let images_dir = state.images_dir.clone();
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);

    Router::new()
        .route("/", get(commentator_root_handler))
        .route("/api/images", get(api_list_images).post(api_upload_image))
        .route("/ndi-preview/:id", get(ndi_preview_handler))
        .nest_service("/images", ServeDir::new(images_dir))
        .fallback(|uri: Uri| async move { serve_dist_file(uri.path()) })
        .layer(cors)
        .with_state(state)
}

// ── Root handlers (WS upgrade or HTML) ───────────────────────────────────────

async fn interactive_root_handler(
    ws: Option<WebSocketUpgrade>,
    State(state): State<Arc<ServerState>>,
) -> Response {
    match ws {
        Some(ws) => ws.on_upgrade(move |socket| handle_interactive_ws(socket, state)),
        None => serve_dist_file("index.html"),
    }
}

async fn readonly_root_handler(
    ws: Option<WebSocketUpgrade>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<ServerState>>,
) -> Response {
    let ip = addr.ip().to_string();
    match ws {
        Some(ws) => ws.on_upgrade(move |socket| handle_readonly_ws(socket, state, ip)),
        None => serve_dist_file("index.html"),
    }
}

async fn commentator_root_handler(
    ws: Option<WebSocketUpgrade>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<ServerState>>,
) -> Response {
    let ip = addr.ip().to_string();
    match ws {
        Some(ws) => ws.on_upgrade(move |socket| handle_commentator_ws(socket, state, ip)),
        None => serve_dist_file("index.html"),
    }
}

// ── Interactive WebSocket ─────────────────────────────────────────────────────

async fn handle_interactive_ws(socket: WebSocket, state: Arc<ServerState>) {
    if !*state.interactive_enabled.read().await {
        return;
    }

    let client_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    state
        .interactive_clients
        .lock()
        .await
        .push((client_id, tx.clone()));

    if let Some(cached) = state.cached_state.read().await.as_ref() {
        let _ = tx.send(Message::Text(cached.clone()));
    }

    let (mut ws_tx, mut ws_rx) = socket.split();
    let state_r = Arc::clone(&state);
    let tx_r = tx.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match &msg {
                Message::Text(text) => {
                    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) else {
                        continue;
                    };
                    match parsed["type"].as_str().unwrap_or("") {
                        "FULL_STATE" => {
                            *state_r.cached_state.write().await = Some(text.clone());
                            broadcast(&state_r.readonly_clients, text).await;
                            broadcast(&state_r.commentator_clients, text).await;
                        }
                        "REQUEST_STATE" => {
                            if let Some(cached) = state_r.cached_state.read().await.as_ref() {
                                let _ = tx_r.send(Message::Text(cached.clone()));
                            }
                            if let Some(cached) = state_r.cached_vmix_state.read().await.as_ref() {
                                let _ = tx_r.send(Message::Text(cached.clone()));
                            }
                            if let Some(cached) = state_r.cached_vmix_data.read().await.as_ref() {
                                let _ = tx_r.send(Message::Text(cached.clone()));
                            }
                            continue;
                        }
                        "ACTION" => {
                            broadcast(&state_r.readonly_clients, text).await;
                            broadcast(&state_r.commentator_clients, text).await;
                        }
                        "COMMENTATOR_FULL_STATE" => {
                            *state_r.commentator_cached_state.write().await = Some(text.clone());
                            broadcast(&state_r.commentator_clients, text).await;
                        }
                        "VMIX_STATUS" => {
                            *state_r.cached_vmix_state.write().await = Some(text.clone());
                            broadcast(&state_r.readonly_clients, text).await;
                            broadcast(&state_r.commentator_clients, text).await;
                        }
                        "VMIX_STATE" => {
                            *state_r.cached_vmix_data.write().await = Some(text.clone());
                            broadcast(&state_r.readonly_clients, text).await;
                            broadcast(&state_r.commentator_clients, text).await;
                        }
                        _ => {}
                    }
                    let clients = state_r.interactive_clients.lock().await;
                    for (id, sender) in clients.iter() {
                        if *id != client_id {
                            let _ = sender.send(msg.clone());
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        state_r
            .interactive_clients
            .lock()
            .await
            .retain(|(id, _)| *id != client_id);
    });

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = (&mut recv_task) => send_task.abort(),
        _ = (&mut send_task) => recv_task.abort(),
    }
}

// ── Read-only WebSocket ───────────────────────────────────────────────────────

async fn handle_readonly_ws(socket: WebSocket, state: Arc<ServerState>, ip: String) {
    if !*state.readonly_enabled.read().await {
        return;
    }

    let client_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    state.readonly_clients.lock().await.push((client_id, tx.clone()));
    state.browser_clients.lock().await.push(BrowserClientEntry { id: client_id, ip, kind: "readonly" });
    broadcast_client_list(&state).await;

    if let Some(cached) = state.cached_state.read().await.as_ref() {
        let _ = tx.send(Message::Text(cached.clone()));
    }
    if let Some(cached) = state.cached_vmix_state.read().await.as_ref() {
        let _ = tx.send(Message::Text(cached.clone()));
    }
    if let Some(cached) = state.cached_vmix_data.read().await.as_ref() {
        let _ = tx.send(Message::Text(cached.clone()));
    }

    let (mut ws_tx, mut ws_rx) = socket.split();
    let state_r = Arc::clone(&state);
    let tx_r = tx.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match &msg {
                Message::Text(text) => {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
                        match v["type"].as_str().unwrap_or("") {
                            "REQUEST_STATE" => {
                                if let Some(cached) = state_r.cached_state.read().await.as_ref() {
                                    let _ = tx_r.send(Message::Text(cached.clone()));
                                }
                                if let Some(cached) = state_r.cached_vmix_state.read().await.as_ref() {
                                    let _ = tx_r.send(Message::Text(cached.clone()));
                                }
                                if let Some(cached) = state_r.cached_vmix_data.read().await.as_ref() {
                                    let _ = tx_r.send(Message::Text(cached.clone()));
                                }
                            }
                            "VMIX_COMMAND" => {
                                broadcast(&state_r.interactive_clients, text).await;
                            }
                            _ => {}
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        state_r.readonly_clients.lock().await.retain(|(id, _)| *id != client_id);
        state_r.browser_clients.lock().await.retain(|e| e.id != client_id);
        broadcast_client_list(&state_r).await;
    });

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = (&mut recv_task) => send_task.abort(),
        _ = (&mut send_task) => recv_task.abort(),
    }
}

// ── Commentator WebSocket ─────────────────────────────────────────────────────

async fn handle_commentator_ws(socket: WebSocket, state: Arc<ServerState>, ip: String) {
    if !*state.commentator_enabled.read().await {
        return;
    }

    let client_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    state.commentator_clients.lock().await.push((client_id, tx.clone()));
    state.browser_clients.lock().await.push(BrowserClientEntry { id: client_id, ip, kind: "commentator" });
    broadcast_client_list(&state).await;

    // Send main canvas state first so linked widgets have live data
    if let Some(cached) = state.cached_state.read().await.as_ref() {
        let _ = tx.send(Message::Text(cached.clone()));
    }
    if let Some(cached) = state.commentator_cached_state.read().await.as_ref() {
        let _ = tx.send(Message::Text(cached.clone()));
    }
    if let Some(cached) = state.cached_vmix_state.read().await.as_ref() {
        let _ = tx.send(Message::Text(cached.clone()));
    }
    if let Some(cached) = state.cached_vmix_data.read().await.as_ref() {
        let _ = tx.send(Message::Text(cached.clone()));
    }

    let (mut ws_tx, mut ws_rx) = socket.split();
    let state_r = Arc::clone(&state);
    let tx_r = tx.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match &msg {
                Message::Text(text) => {
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
                        continue;
                    };
                    match v["type"].as_str().unwrap_or("") {
                        "REQUEST_STATE" => {
                            if let Some(cached) = state_r.cached_state.read().await.as_ref() {
                                let _ = tx_r.send(Message::Text(cached.clone()));
                            }
                            if let Some(cached) = state_r.commentator_cached_state.read().await.as_ref() {
                                let _ = tx_r.send(Message::Text(cached.clone()));
                            }
                            if let Some(cached) = state_r.cached_vmix_state.read().await.as_ref() {
                                let _ = tx_r.send(Message::Text(cached.clone()));
                            }
                            if let Some(cached) = state_r.cached_vmix_data.read().await.as_ref() {
                                let _ = tx_r.send(Message::Text(cached.clone()));
                            }
                        }
                        "COMMENTATOR_FULL_STATE" => {
                            *state_r.commentator_cached_state.write().await = Some(text.clone());
                            // Broadcast to other commentator clients
                            {
                                let mut dead = Vec::new();
                                let guard = state_r.commentator_clients.lock().await;
                                for (id, sender) in guard.iter() {
                                    if *id != client_id && sender.send(Message::Text(text.clone())).is_err() {
                                        dead.push(*id);
                                    }
                                }
                                drop(guard);
                                if !dead.is_empty() {
                                    state_r.commentator_clients.lock().await.retain(|(id, _)| !dead.contains(id));
                                }
                            }
                            // Relay to host so it can update its commentator canvas store
                            broadcast(&state_r.interactive_clients, text).await;
                        }
                        "VMIX_COMMAND" => {
                            broadcast(&state_r.interactive_clients, text).await;
                        }
                        _ => {}
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        state_r.commentator_clients.lock().await.retain(|(id, _)| *id != client_id);
        state_r.browser_clients.lock().await.retain(|e| e.id != client_id);
        broadcast_client_list(&state_r).await;
    });

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = (&mut recv_task) => send_task.abort(),
        _ = (&mut send_task) => recv_task.abort(),
    }
}

// ── Image API ─────────────────────────────────────────────────────────────────

async fn api_list_images(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // Use the Host header so browser clients on port 9878/9879 get image URLs
    // that resolve from their own origin — all three ports serve /images/.
    let base = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|host| format!("http://{}", host))
        .unwrap_or_else(|| format!("http://{}:{}", state.lan_ip, state.sync_port));

    let dir = &state.images_dir;
    let entries: Vec<serde_json::Value> = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| {
            let l = name.to_lowercase();
            l.ends_with(".png") || l.ends_with(".jpg") || l.ends_with(".jpeg")
                || l.ends_with(".gif") || l.ends_with(".webp") || l.ends_with(".svg")
        })
        .map(|name| serde_json::json!({
            "name": name,
            "url": format!("{}/images/{}", base, name),
        }))
        .collect();

    (
        [(header::CONTENT_TYPE, "application/json"),
         (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
        serde_json::to_string(&entries).unwrap_or_else(|_| "[]".into()),
    )
}

async fn api_upload_image(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let base = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|host| format!("http://{}", host))
        .unwrap_or_else(|| format!("http://{}:{}", state.lan_ip, state.sync_port));

    while let Ok(Some(field)) = multipart.next_field().await {
        let filename = field.file_name().unwrap_or("upload").to_string();
        let ext = std::path::Path::new(&filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_lowercase();
        if !["png","jpg","jpeg","gif","webp","svg"].contains(&ext.as_str()) {
            continue;
        }
        if let Ok(data) = field.bytes().await {
            let stem: String = std::path::Path::new(&filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("img")
                .chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .collect();
            // Keep the original filename where possible, only suffixing
            // "_2", "_3", … if that exact name is already taken.
            let name = {
                let plain = format!("{}.{}", stem, ext);
                if !state.images_dir.join(&plain).exists() {
                    plain
                } else {
                    let mut n = 2;
                    loop {
                        let candidate = format!("{}_{}.{}", stem, n, ext);
                        if !state.images_dir.join(&candidate).exists() {
                            break candidate;
                        }
                        n += 1;
                    }
                }
            };
            let dest = state.images_dir.join(&name);
            if std::fs::write(&dest, &data).is_ok() {
                let url = format!("{}/images/{}", base, name);
                let body = serde_json::json!({ "name": name, "url": url }).to_string();
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json"),
                     (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
                    body,
                );
            }
        }
    }
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "application/json"),
         (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
        r#"{"error":"no valid image found"}"#.into(),
    )
}

// ── NDI live preview (single JPEG per request) ───────────────────────────────
// Returns the latest JPEG frame from a crate::ndi preview session. The
// frontend polls this with a cache-busting query param and refreshes a plain
// <img> tag — identical to how vMix's own /thumbnail endpoint is consumed.
//
// We deliberately do NOT stream multipart/x-mixed-replace here: WKWebView
// (the engine Tauri uses on macOS) holds the connection open but never
// renders the replacing frames — a long-standing WebKit limitation — so the
// <img> just shows solid black forever even though the stream is live and
// correct. Plain single-image polling works reliably in every WebView/browser.
async fn ndi_preview_handler(Path(id): Path<String>) -> Response {
    match crate::ndi::get_frame(&id) {
        Some(jpeg) => (
            [
                (header::CONTENT_TYPE, "image/jpeg".to_string()),
                (header::CACHE_CONTROL, "no-store".to_string()),
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".to_string()),
            ],
            jpeg,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "no such NDI preview session or no frame yet").into_response(),
    }
}

// ── Start both servers ────────────────────────────────────────────────────────

pub async fn start_servers(state: Arc<ServerState>) {
    let sync_port = state.sync_port;
    let readonly_port = state.readonly_port;
    let commentator_port = state.commentator_port;
    let lan_ip = state.lan_ip.clone();

    println!("Interactive:  http://{}:{}", lan_ip, sync_port);
    println!("Read-only:    http://{}:{}", lan_ip, readonly_port);
    println!("Commentator:  http://{}:{}", lan_ip, commentator_port);

    let interactive_router = make_interactive_router(Arc::clone(&state));
    let readonly_router = make_readonly_router(Arc::clone(&state));
    let commentator_router = make_commentator_router(Arc::clone(&state));

    let interactive_listener =
        tokio::net::TcpListener::bind(format!("0.0.0.0:{}", sync_port))
            .await
            .expect("failed to bind interactive port");

    let readonly_listener =
        tokio::net::TcpListener::bind(format!("0.0.0.0:{}", readonly_port))
            .await
            .expect("failed to bind readonly port");

    let commentator_listener =
        tokio::net::TcpListener::bind(format!("0.0.0.0:{}", commentator_port))
            .await
            .expect("failed to bind commentator port");

    tokio::spawn(async move {
        axum::serve(interactive_listener, interactive_router)
            .await
            .ok();
    });

    tokio::spawn(async move {
        axum::serve(
            readonly_listener,
            readonly_router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .ok();
    });

    tokio::spawn(async move {
        axum::serve(
            commentator_listener,
            commentator_router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .ok();
    });
}
