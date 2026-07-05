// Thin wrapper around the Tauri commands that drive the real (non-vMix)
// NDI live preview: a background Rust thread receives raw NDI video frames
// directly from the network and republishes them as an MJPEG HTTP stream,
// so widgets can preview any NDI source before it's ever added to vMix.

let _baseUrl: string | null = null;

export interface NdiPreviewOptions {
  /** Use NDI's low-bandwidth mode (lower source resolution/compression, less network traffic). */
  lowBandwidth?: boolean;
  /** Capped re-encode rate in frames/sec (1-30). Lower = smoother on slow networks/CPUs. */
  fps?: number;
  /** JPEG quality (10-100). Lower = smaller/faster, higher = crisper. */
  quality?: number;
}

const DEFAULT_OPTIONS: Required<NdiPreviewOptions> = { lowBandwidth: false, fps: 15, quality: 75 };

export async function ndiRuntimeAvailable(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('ndi_runtime_available');
  } catch {
    return false;
  }
}

export async function ndiPreviewStart(
  source: string,
  options?: NdiPreviewOptions,
): Promise<{ id: string; url: string }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { invoke } = await import('@tauri-apps/api/core');
  const id = await invoke<string>('ndi_preview_start', {
    source,
    lowBandwidth: opts.lowBandwidth,
    fps: opts.fps,
    quality: opts.quality,
  });
  if (_baseUrl === null) _baseUrl = await invoke<string>('get_ndi_preview_base_url');
  return { id, url: `${_baseUrl}/${id}` };
}

export function ndiPreviewStop(id: string) {
  import('@tauri-apps/api/core').then(({ invoke }) =>
    invoke('ndi_preview_stop', { id }).catch(() => {})
  );
}
