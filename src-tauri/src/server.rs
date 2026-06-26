use axum::{
    Router,
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Multipart, State,
    },
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use include_dir::{include_dir, Dir};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{mpsc, Mutex, RwLock};
use uuid::Uuid;

// The frontend dist/ directory is embedded at compile time.
// Run `npm run build` before `cargo build` / `tauri build`.
static DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist");

pub type ClientSender = mpsc::UnboundedSender<Message>;
pub type ClientList = Arc<Mutex<Vec<(Uuid, ClientSender)>>>;

#[derive(Clone)]
pub struct ServerState {
    pub interactive_clients: ClientList,
    pub readonly_clients: ClientList,
    pub cached_state: Arc<RwLock<Option<String>>>,
    pub interactive_enabled: Arc<RwLock<bool>>,
    pub readonly_enabled: Arc<RwLock<bool>>,
    pub lan_ip: String,
    pub sync_port: u16,
    pub readonly_port: u16,
    pub images_dir: PathBuf,
}

impl ServerState {
    pub fn new(
        lan_ip: String,
        sync_port: u16,
        readonly_port: u16,
        images_dir: PathBuf,
    ) -> Self {
        Self {
            interactive_clients: Arc::new(Mutex::new(vec![])),
            readonly_clients: Arc::new(Mutex::new(vec![])),
            cached_state: Arc::new(RwLock::new(None)),
            interactive_enabled: Arc::new(RwLock::new(true)),
            readonly_enabled: Arc::new(RwLock::new(true)),
            lan_ip,
            sync_port,
            readonly_port,
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
    use tower_http::services::ServeDir;

    let images_dir = state.images_dir.clone();

    Router::new()
        .route("/", get(interactive_root_handler))
        .route("/api/images", get(api_list_images).post(api_upload_image))
        .nest_service("/images", ServeDir::new(images_dir))
        .fallback(|uri: Uri| async move { serve_dist_file(uri.path()) })
        .with_state(state)
}

pub fn make_readonly_router(state: Arc<ServerState>) -> Router {
    use tower_http::services::ServeDir;

    let images_dir = state.images_dir.clone();

    Router::new()
        .route("/", get(readonly_root_handler))
        .route("/api/images", get(api_list_images))
        .nest_service("/images", ServeDir::new(images_dir))
        .fallback(|uri: Uri| async move { serve_dist_file(uri.path()) })
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
    State(state): State<Arc<ServerState>>,
) -> Response {
    match ws {
        Some(ws) => ws.on_upgrade(move |socket| handle_readonly_ws(socket, state)),
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
                        }
                        "REQUEST_STATE" => {
                            if let Some(cached) = state_r.cached_state.read().await.as_ref() {
                                let _ = tx_r.send(Message::Text(cached.clone()));
                            }
                            continue;
                        }
                        "ACTION" => {
                            broadcast(&state_r.readonly_clients, text).await;
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

async fn handle_readonly_ws(socket: WebSocket, state: Arc<ServerState>) {
    if !*state.readonly_enabled.read().await {
        return;
    }

    let client_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    state
        .readonly_clients
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
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
                        if v["type"].as_str() == Some("REQUEST_STATE") {
                            if let Some(cached) = state_r.cached_state.read().await.as_ref() {
                                let _ = tx_r.send(Message::Text(cached.clone()));
                            }
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        state_r
            .readonly_clients
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

// ── Image API ─────────────────────────────────────────────────────────────────

async fn api_list_images(State(state): State<Arc<ServerState>>) -> impl IntoResponse {
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
            "url": format!("http://{}:{}/images/{}", state.lan_ip, state.sync_port, name),
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
    mut multipart: Multipart,
) -> impl IntoResponse {
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
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let stem: String = std::path::Path::new(&filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("img")
                .chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .collect();
            let name = format!("{}_{}.{}", ts, stem, ext);
            let dest = state.images_dir.join(&name);
            if std::fs::write(&dest, &data).is_ok() {
                let url = format!("http://{}:{}/images/{}", state.lan_ip, state.sync_port, name);
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

// ── Start both servers ────────────────────────────────────────────────────────

pub async fn start_servers(state: Arc<ServerState>) {
    let sync_port = state.sync_port;
    let readonly_port = state.readonly_port;
    let lan_ip = state.lan_ip.clone();

    println!("Interactive: http://{}:{}", lan_ip, sync_port);
    println!("Read-only:   http://{}:{}", lan_ip, readonly_port);

    let interactive_router = make_interactive_router(Arc::clone(&state));
    let readonly_router = make_readonly_router(Arc::clone(&state));

    let interactive_listener =
        tokio::net::TcpListener::bind(format!("0.0.0.0:{}", sync_port))
            .await
            .expect("failed to bind interactive port");

    let readonly_listener =
        tokio::net::TcpListener::bind(format!("0.0.0.0:{}", readonly_port))
            .await
            .expect("failed to bind readonly port");

    tokio::spawn(async move {
        axum::serve(interactive_listener, interactive_router)
            .await
            .ok();
    });

    tokio::spawn(async move {
        axum::serve(readonly_listener, readonly_router).await.ok();
    });
}
