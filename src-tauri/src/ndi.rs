// Minimal, dynamically-loaded bindings to the NDI SDK runtime (libndi.dylib),
// used only to power a live network preview: finding NDI sources and
// receiving/decoding their video frames directly, independent of vMix. The
// NDI SDK itself is never linked at build time — we dlopen whatever runtime
// the user already has installed (NDI Tools / NDI Redistributable, which
// vMix itself depends on) and resolve only the handful of C symbols we need.
// If the runtime isn't present, every function here degrades to a no-op /
// empty result instead of panicking.

use jpeg_encoder::{ColorType, Encoder};
use libloading::{Library, Symbol};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ── Raw structs matching Processing.NDI.*.h (only the fields we touch) ─────

#[repr(C)]
struct NdiSourceT {
    p_ndi_name: *const c_char,
    p_url_address: *const c_char,
}

#[repr(C)]
struct NdiFindCreateT {
    show_local_sources: bool,
    p_groups: *const c_char,
    p_extra_ips: *const c_char,
}

#[repr(C)]
struct NdiRecvCreateV3T {
    source_to_connect_to: NdiSourceT,
    color_format: i32,
    bandwidth: i32,
    allow_video_fields: bool,
    p_ndi_recv_name: *const c_char,
}

#[repr(C)]
struct NdiVideoFrameV2T {
    xres: i32,
    yres: i32,
    four_cc: i32,
    frame_rate_n: i32,
    frame_rate_d: i32,
    picture_aspect_ratio: f32,
    frame_format_type: i32,
    timecode: i64,
    p_data: *mut u8,
    line_stride_in_bytes: i32,
    p_metadata: *const c_char,
    timestamp: i64,
}

impl Default for NdiVideoFrameV2T {
    fn default() -> Self {
        // All-zero is a valid bit pattern for every field (ints/floats/ptrs).
        unsafe { std::mem::zeroed() }
    }
}

// Delivers RGB with no alpha, RGBA when the source has one — matches
// jpeg_encoder's ColorType::Rgba (which ignores the 4th byte) exactly.
const COLOR_FORMAT_RGBX_RGBA: i32 = 2;
const BANDWIDTH_HIGHEST: i32 = 100;
const BANDWIDTH_LOWEST: i32 = 0;
const FRAME_TYPE_VIDEO: i32 = 1;
const FRAME_TYPE_ERROR: i32 = 4;

/// User-adjustable preview settings (widget config → Tauri command → here).
#[derive(Clone, Copy)]
pub struct PreviewOptions {
    pub low_bandwidth: bool, // NDI's own network bandwidth/compression mode
    pub fps: u32,            // capped re-encode rate — controls motion smoothness / CPU
    pub quality: u8,         // JPEG quality 1-100 — controls visual fidelity / size
}

impl PreviewOptions {
    fn clamped(self) -> Self {
        PreviewOptions {
            low_bandwidth: self.low_bandwidth,
            fps: self.fps.clamp(1, 30),
            quality: self.quality.clamp(10, 100),
        }
    }
}

type FnInitialize = unsafe extern "C" fn() -> bool;
type FnFindCreateV2 = unsafe extern "C" fn(*const NdiFindCreateT) -> *mut c_void;
type FnFindDestroy = unsafe extern "C" fn(*mut c_void);
type FnFindWaitForSources = unsafe extern "C" fn(*mut c_void, u32) -> bool;
type FnFindGetCurrentSources = unsafe extern "C" fn(*mut c_void, *mut u32) -> *const NdiSourceT;
type FnRecvCreateV3 = unsafe extern "C" fn(*const NdiRecvCreateV3T) -> *mut c_void;
type FnRecvCaptureV2 =
    unsafe extern "C" fn(*mut c_void, *mut NdiVideoFrameV2T, *mut c_void, *mut c_void, u32) -> i32;
type FnRecvFreeVideoV2 = unsafe extern "C" fn(*mut c_void, *const NdiVideoFrameV2T);
type FnRecvDestroy = unsafe extern "C" fn(*mut c_void);

struct NdiLib {
    _lib: Library, // must outlive every fn pointer below — never dropped
    find_create_v2: FnFindCreateV2,
    find_destroy: FnFindDestroy,
    find_wait_for_sources: FnFindWaitForSources,
    find_get_current_sources: FnFindGetCurrentSources,
    recv_create_v3: FnRecvCreateV3,
    recv_capture_v2: FnRecvCaptureV2,
    recv_free_video_v2: FnRecvFreeVideoV2,
    recv_destroy: FnRecvDestroy,
}

// Safe: every field is either a plain C fn pointer (always Send+Sync) or
// libloading::Library, which is itself Send+Sync (dlopen/dlsym are
// thread-safe on macOS). Resolved once at load and never mutated after.
unsafe impl Send for NdiLib {}
unsafe impl Sync for NdiLib {}

fn candidate_paths() -> Vec<String> {
    let mut v = vec![
        "/usr/local/lib/libndi.dylib".to_string(),
        "/Library/NDI SDK for Apple/lib/macOS/libndi.dylib".to_string(),
    ];
    if let Ok(dir) = std::env::var("NDI_RUNTIME_DIR_V6") {
        v.push(format!("{dir}/libndi.dylib"));
    }
    if let Ok(dir) = std::env::var("NDI_RUNTIME_DIR_V5") {
        v.push(format!("{dir}/libndi.dylib"));
    }
    v
}

unsafe fn load() -> Option<NdiLib> {
    let lib = candidate_paths().into_iter().find_map(|p| Library::new(&p).ok())?;

    macro_rules! sym {
        ($name:literal) => {{
            let s: Symbol<'_, _> = lib.get($name).ok()?;
            *s
        }};
    }

    let initialize: FnInitialize = sym!(b"NDIlib_initialize");
    let find_create_v2: FnFindCreateV2 = sym!(b"NDIlib_find_create_v2");
    let find_destroy: FnFindDestroy = sym!(b"NDIlib_find_destroy");
    let find_wait_for_sources: FnFindWaitForSources = sym!(b"NDIlib_find_wait_for_sources");
    let find_get_current_sources: FnFindGetCurrentSources = sym!(b"NDIlib_find_get_current_sources");
    let recv_create_v3: FnRecvCreateV3 = sym!(b"NDIlib_recv_create_v3");
    let recv_capture_v2: FnRecvCaptureV2 = sym!(b"NDIlib_recv_capture_v2");
    let recv_free_video_v2: FnRecvFreeVideoV2 = sym!(b"NDIlib_recv_free_video_v2");
    let recv_destroy: FnRecvDestroy = sym!(b"NDIlib_recv_destroy");

    if !initialize() {
        return None;
    }

    Some(NdiLib {
        _lib: lib,
        find_create_v2,
        find_destroy,
        find_wait_for_sources,
        find_get_current_sources,
        recv_create_v3,
        recv_capture_v2,
        recv_free_video_v2,
        recv_destroy,
    })
}

static NDI: Lazy<Option<NdiLib>> = Lazy::new(|| unsafe { load() });

pub fn is_available() -> bool {
    NDI.is_some()
}

// ── Source discovery ────────────────────────────────────────────────────────

/// Blocking — call from a background thread (e.g. tokio::task::spawn_blocking).
pub fn scan_sources(timeout_ms: u32) -> Vec<String> {
    let Some(ndi) = NDI.as_ref() else { return vec![] };
    unsafe {
        let create = NdiFindCreateT {
            show_local_sources: true,
            p_groups: ptr::null(),
            p_extra_ips: ptr::null(),
        };
        let finder = (ndi.find_create_v2)(&create);
        if finder.is_null() {
            return vec![];
        }
        (ndi.find_wait_for_sources)(finder, timeout_ms);
        let mut count: u32 = 0;
        let src_ptr = (ndi.find_get_current_sources)(finder, &mut count);
        let mut names = Vec::new();
        if !src_ptr.is_null() && count > 0 {
            let slice = std::slice::from_raw_parts(src_ptr, count as usize);
            for src in slice {
                if !src.p_ndi_name.is_null() {
                    if let Ok(s) = CStr::from_ptr(src.p_ndi_name).to_str() {
                        names.push(s.to_string());
                    }
                }
            }
        }
        (ndi.find_destroy)(finder);
        names
    }
}

// ── Live preview sessions ────────────────────────────────────────────────────

struct Session {
    stop: Arc<AtomicBool>,
    frame: Arc<Mutex<Option<Vec<u8>>>>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, Session>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Starts a background receiver thread for `source_name` and returns a session id.
pub fn start_preview(source_name: String, options: PreviewOptions) -> Result<String, String> {
    if !is_available() {
        return Err("NDI runtime not found on this Mac".to_string());
    }
    let options = options.clamped();
    let id = uuid::Uuid::new_v4().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let frame = Arc::new(Mutex::new(None));

    SESSIONS.lock().unwrap().insert(id.clone(), Session { stop: stop.clone(), frame: frame.clone() });

    let thread_id = id.clone();
    std::thread::Builder::new()
        .name(format!("ndi-preview-{thread_id}"))
        .spawn(move || run_preview_thread(source_name, options, stop, frame))
        .map_err(|e| {
            SESSIONS.lock().unwrap().remove(&thread_id);
            e.to_string()
        })?;

    Ok(id)
}

pub fn stop_preview(id: &str) {
    if let Some(s) = SESSIONS.lock().unwrap().remove(id) {
        s.stop.store(true, Ordering::Relaxed);
    }
}

/// Returns the latest JPEG frame bytes for a session, if one has arrived yet.
pub fn get_frame(id: &str) -> Option<Vec<u8>> {
    let sessions = SESSIONS.lock().unwrap();
    let frame = sessions.get(id)?.frame.lock().unwrap().clone();
    frame
}

const PREVIEW_MAX_WIDTH: usize = 640; // small, fast preview — not a program feed

fn run_preview_thread(
    source_name: String,
    options: PreviewOptions,
    stop: Arc<AtomicBool>,
    frame_slot: Arc<Mutex<Option<Vec<u8>>>>,
) {
    let Some(ndi) = NDI.as_ref() else { return };
    let Ok(c_name) = CString::new(source_name) else { return };

    let recv = unsafe {
        let create = NdiRecvCreateV3T {
            source_to_connect_to: NdiSourceT { p_ndi_name: c_name.as_ptr(), p_url_address: ptr::null() },
            color_format: COLOR_FORMAT_RGBX_RGBA,
            bandwidth: if options.low_bandwidth { BANDWIDTH_LOWEST } else { BANDWIDTH_HIGHEST },
            allow_video_fields: true,
            p_ndi_recv_name: ptr::null(),
        };
        (ndi.recv_create_v3)(&create)
    };
    if recv.is_null() {
        return;
    }

    let min_frame_interval = Duration::from_millis(1000 / options.fps as u64);
    let mut last_encoded = Instant::now() - min_frame_interval;
    while !stop.load(Ordering::Relaxed) {
        let mut video = NdiVideoFrameV2T::default();
        // Short timeout keeps the loop responsive to the stop flag.
        let frame_type =
            unsafe { (ndi.recv_capture_v2)(recv, &mut video, ptr::null_mut(), ptr::null_mut(), 100) };

        if frame_type == FRAME_TYPE_VIDEO {
            if !video.p_data.is_null() && last_encoded.elapsed() >= min_frame_interval {
                if let Some(jpeg) = encode_frame_to_jpeg(&video, options.quality) {
                    *frame_slot.lock().unwrap() = Some(jpeg);
                    last_encoded = Instant::now();
                }
            }
            unsafe { (ndi.recv_free_video_v2)(recv, &video) };
        } else if frame_type == FRAME_TYPE_ERROR {
            // Source vanished — brief backoff; the receiver reconnects on its own
            // once a source with the same name reappears on the network.
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    unsafe { (ndi.recv_destroy)(recv) };
}

/// Downscales (nearest-neighbour) and JPEG-encodes a raw RGBA/RGBX video frame.
fn encode_frame_to_jpeg(video: &NdiVideoFrameV2T, quality: u8) -> Option<Vec<u8>> {
    let xres = video.xres.max(0) as usize;
    let yres = video.yres.max(0) as usize;
    if xres == 0 || yres == 0 {
        return None;
    }
    let stride = if video.line_stride_in_bytes > 0 { video.line_stride_in_bytes as usize } else { xres * 4 };

    let scale = xres.div_ceil(PREVIEW_MAX_WIDTH).max(1);
    let out_w = (xres / scale).max(1);
    let out_h = (yres / scale).max(1);

    let mut rgba = vec![0u8; out_w * out_h * 4];
    unsafe {
        let src = std::slice::from_raw_parts(video.p_data as *const u8, stride * yres);
        for oy in 0..out_h {
            let row = &src[(oy * scale) * stride..];
            for ox in 0..out_w {
                let sx = ox * scale * 4;
                if sx + 4 > row.len() {
                    continue;
                }
                let d = (oy * out_w + ox) * 4;
                rgba[d..d + 4].copy_from_slice(&row[sx..sx + 4]);
            }
        }
    }

    let mut out = Vec::new();
    let encoder = Encoder::new(&mut out, quality);
    encoder.encode(&rgba, out_w as u16, out_h as u16, ColorType::Rgba).ok()?;
    Some(out)
}
