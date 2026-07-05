use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

mod commands;
mod ndi;
mod server;

pub struct AppState {
    pub server: Arc<server::ServerState>,
    pub caffeinate: Mutex<Option<std::process::Child>>,
}

pub(crate) fn get_lan_ip() -> String {
    use std::net::UdpSocket;
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let lan_ip = get_lan_ip();

            let images_dir = app
                .handle()
                .path()
                .app_data_dir()
                .expect("failed to get app data dir")
                .join("served-images");
            std::fs::create_dir_all(&images_dir).ok();

            let server_state = Arc::new(server::ServerState::new(
                lan_ip,
                9877,
                9878,
                9879,
                images_dir,
            ));

            app.manage(AppState {
                server: Arc::clone(&server_state),
                caffeinate: Mutex::new(None),
            });

            tauri::async_runtime::spawn(async move {
                server::start_servers(server_state).await;
            });

            // 100 ms tick emitter — drives all timer widgets from the Rust side so
            // WKWebView throttling (background, display sleep) can never pause them.
            // The frontend subscribes to this event and uses wall-clock elapsed time
            // for accuracy even when ticks are delayed.
            let tick_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tokio::time::{interval, Duration, MissedTickBehavior};
                let mut iv = interval(Duration::from_millis(100));
                iv.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    iv.tick().await;
                    let _ = tick_handle.emit("timer-tick", ());
                }
            });

            // Trigger the macOS Local Network permission dialog at startup.
            tauri::async_runtime::spawn(async {
                use tokio::net::UdpSocket;
                if let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await {
                    let _ = sock.set_broadcast(true);
                    let _ = sock.send_to(b"\x00", "255.255.255.255:9").await;
                }
            });


            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_build_number,
            commands::http_get,
            commands::tcp_test,
            commands::diagnose_vmix,
            commands::get_server_info,
            commands::toggle_interactive,
            commands::toggle_readonly,
            commands::toggle_commentator,
            commands::set_sleep_block,
            commands::open_image_dialog,
            commands::save_image,
            commands::list_images,
            commands::delete_image,
            commands::get_images_base_url,
            commands::get_local_ips,
            commands::scan_ndi,
            commands::ndi_runtime_available,
            commands::ndi_preview_start,
            commands::ndi_preview_stop,
            commands::get_ndi_preview_base_url,
            commands::vmix_tcp_connect,
            commands::vmix_tcp_disconnect,
            commands::vmix_tcp_refresh,
            commands::vmix_tcp_function,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
