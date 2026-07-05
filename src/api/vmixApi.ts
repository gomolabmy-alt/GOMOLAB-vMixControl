import type {
  VmixState, VmixInput, VmixTextField, VmixTransition,
  VmixOverlay, VmixAudioBus, VmixMasterAudio,
} from '../types/vmix';

declare global {
  interface Window {
    Capacitor?: { isNativePlatform: () => boolean };
  }
}

function isCapacitorNative(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.Capacitor !== 'undefined' &&
    window.Capacitor.isNativePlatform()
  );
}

async function httpGet(url: string): Promise<string> {
  if (isCapacitorNative()) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const response = await CapacitorHttp.get({ url, headers: {} });
    return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  }
  // Use WKWebView fetch() — same networking stack as Safari/browser mode.
  // Rust TCP is blocked by macOS network extensions on this machine, but
  // WKWebView's networking process is not (browser mode confirms vMix is reachable).
  // vMix sends Access-Control-Allow-Origin: * so CORS is not an issue.
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

// ── External images base URL ────────────────────────────────────────────────
// save_image / list_images return http://localhost:PORT/images/... so the URL
// is stable inside the Tauri WebView regardless of which NIC is active.
// vMix needs the real LAN IP to fetch images over the network, so we rewrite
// the URL when sending SetImage. Resolved fresh every time (not cached) since
// the LAN IP can change mid-session (WiFi switch, DHCP renewal, new venue).
async function externalImagesBase(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('get_images_base_url'); // http://LAN_IP:PORT/images
  } catch {
    return null;
  }
}

// ─── XML parsing ───────────────────────────────────────────────────────────

function parseXmlState(xml: string): VmixState {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Failed to parse vMix XML state');

  const getText = (tag: string) => doc.querySelector(tag)?.textContent?.trim() ?? '';
  const getBool = (tag: string) => getText(tag).toLowerCase() === 'true';

  // Inputs
  const inputs: VmixInput[] = Array.from(doc.querySelectorAll('inputs > input')).map((el) => {
    const textFields: VmixTextField[] = [
      ...Array.from(el.querySelectorAll('text')).map((t) => ({
        name: t.getAttribute('name') ?? '',
        value: t.getAttribute('value') ?? t.textContent?.trim() ?? '',
      })),
      ...Array.from(el.querySelectorAll('image')).map((t) => ({
        name: t.getAttribute('name') ?? '',
        value: t.getAttribute('value') ?? t.getAttribute('src') ?? t.textContent?.trim() ?? '',
      })),
    ];
    return {
      key: el.getAttribute('key') ?? '',
      number: parseInt(el.getAttribute('number') ?? '0', 10),
      type: el.getAttribute('type') ?? '',
      title: el.getAttribute('title') ?? '',
      state: el.getAttribute('state') ?? '',
      duration: parseInt(el.getAttribute('duration') ?? '0', 10),
      position: parseInt(el.getAttribute('position') ?? '0', 10),
      loop: el.getAttribute('loop') === 'True',
      muted: el.getAttribute('muted') === 'True',
      volume: parseInt(el.getAttribute('volume') ?? '100', 10),
      balance: parseInt(el.getAttribute('balance') ?? '0', 10),
      solo: el.getAttribute('solo') === 'True',
      audioBusses: el.getAttribute('audiobusses') ?? 'M',
      meterF1: parseFloat(el.getAttribute('meterF1') ?? '0'),
      meterF2: parseFloat(el.getAttribute('meterF2') ?? '0'),
      gainDb: parseFloat(el.getAttribute('gainDb') ?? '0'),
      textFields,
    };
  });

  // Overlays — try both wrapped (<overlays><overlay/>) and flat (<vmix><overlay/>)
  const attr = (el: Element, ...names: string[]) => {
    for (const n of names) { const v = el.getAttribute(n); if (v !== null) return v; }
    return null;
  };
  const overlayEls = doc.querySelectorAll('overlays > overlay').length > 0
    ? doc.querySelectorAll('overlays > overlay')
    : doc.querySelectorAll('overlay[number]');
  const overlays: VmixOverlay[] = Array.from(overlayEls).map((el) => {
    const number = parseInt(attr(el, 'number', 'Number') ?? '1', 10);
    const rawText = el.textContent?.trim() ?? '';
    const textNum = parseInt(rawText, 10);
    // Some vMix versions put the input number as text content, others put a GUID
    const isNumericText = rawText !== '' && String(textNum) === rawText && textNum > 0;
    const attrInputNum = parseInt(attr(el, 'inputNumber', 'InputNumber', 'inputnumber') ?? '0', 10);
    const inputNumber = attrInputNum > 0 ? attrInputNum : (isNumericText ? textNum : 0);
    const key = isNumericText ? '' : rawText;
    return { number, key, inputNumber };
  });
  // Pad to 4 overlays if vMix returned fewer
  for (let i = overlays.length + 1; i <= 4; i++) overlays.push({ number: i, key: '', inputNumber: 0 });

  // Transitions
  const transitions: VmixTransition[] = Array.from(
    doc.querySelectorAll('transitions > transition'),
  ).map((el) => ({
    number: parseInt(el.getAttribute('number') ?? '1', 10),
    effect: el.getAttribute('effect') ?? 'Fade',
    duration: parseInt(el.getAttribute('duration') ?? '500', 10),
  }));

  // Master audio
  const masterEl = doc.querySelector('audio > master');
  const masterAudio: VmixMasterAudio = {
    volume: parseInt(masterEl?.getAttribute('volume') ?? '100', 10),
    muted: masterEl?.getAttribute('muted') === 'True',
    meterF1: parseFloat(masterEl?.getAttribute('meterF1') ?? '0'),
    meterF2: parseFloat(masterEl?.getAttribute('meterF2') ?? '0'),
    headphonesVolume: parseInt(masterEl?.getAttribute('headphonesVolume') ?? '74', 10),
  };

  // Audio buses
  const audioBuses: VmixAudioBus[] = Array.from(doc.querySelectorAll('audio > bus')).map((el) => ({
    name: el.getAttribute('name') ?? '',
    volume: parseInt(el.getAttribute('volume') ?? '100', 10),
    muted: el.getAttribute('muted') === 'True',
    meterF1: parseFloat(el.getAttribute('meterF1') ?? '0'),
    meterF2: parseFloat(el.getAttribute('meterF2') ?? '0'),
  }));

  return {
    version: getText('version'),
    edition: getText('edition'),
    inputs,
    overlays,
    preview: parseInt(getText('preview') || '0', 10),
    active: parseInt(getText('active') || '0', 10),
    recording: getBool('recording'),
    external: getBool('external'),
    streaming: getBool('streaming'),
    multiCorder: getBool('multiCorder'),
    fullscreen: getBool('fullscreen'),
    fadeToBlack: getBool('fadeToBlack'),
    transitions,
    masterAudio,
    audioBuses,
  };
}

// ─── API Client ────────────────────────────────────────────────────────────

const _isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Per-field delivery status exposed to the UI. */
export interface FieldStat {
  key: string;
  connectionName: string;
  label: string;
  status: 'ok' | 'err' | 'pending';
  lastOkAt: number | null;
  lastErrAt: number | null;
  sendCount: number;
  errCount: number;
  /** The value most recently sent to vMix (params.Value). */
  appValue: string | null;
  /** Last value confirmed by reading back from vMix state (null = not yet verified). */
  vmixValue: string | null;
  /** true = app value ≠ vMix value, false = in sync, null = can't verify. */
  mismatch: boolean | null;
  /** true = the target input exists but has no field named SelectedName at all —
   *  almost always a case-mismatch/typo, since vMix's field match is case-sensitive
   *  and silently no-ops rather than erroring. */
  fieldMissing: boolean;
  /** true = params.Input doesn't match any input in the current vMix project at
   *  all — vMix assigns a fresh random GUID to every input on each preset load,
   *  so a widget configured against a previous load's key silently no-ops. */
  inputMissing: boolean;
}

interface FieldRecord extends FieldStat {
  url: string;
  fn: string;
  params: Record<string, string>;
}

export class VmixApiClient {
  private baseUrl: string;
  private host: string;
  private httpPort: number;
  static readonly TCP_PORT = 8099; // vMix TCP API — always port 8099

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _pollRunning = false;
  private onStateUpdate: ((state: VmixState) => void) | null = null;
  private onError: ((error: string) => void) | null = null;

  // TCP mode state
  private _tcpUnlisten: (() => void) | null = null;
  private _tcpDiscUnlisten: (() => void) | null = null;
  private _tcpActive = false;
  private _tcpConnecting = false; // true only while the TCP connect call is in flight
  private _tcpReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _tcpKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // Backoff for failed TCP (re)connect attempts — doubles up to a cap so a
  // dead TCP port is retried forever instead of permanently downgrading to
  // HTTP-only polling. Reset to base whenever TCP successfully connects.
  private _tcpBackoffMs = 3000;
  private static readonly TCP_BACKOFF_MAX = 20000;
  private _httpPollActive = false; // prevents duplicate concurrent HTTP poll loops
  private _lastStateAt = 0;        // ms timestamp of last received vMix state
  private _staleWatchdog: ReturnType<typeof setInterval> | null = null;

  // Logger callback wired by the store for the connection log panel
  private _log: ((event: string, detail?: string) => void) | null = null;
  setLogger(fn: ((event: string, detail?: string) => void) | null) { this._log = fn; }

  // Connection name (set by vmixStore when wiring so field stats include it)
  private _connectionName = '';
  setConnectionName(name: string) { this._connectionName = name; }

  // Stats change callback — fires when any field changes status (ok/err/pending)
  private _onStatsChange: (() => void) | null = null;
  setStatsChangeHandler(fn: (() => void) | null) { this._onStatsChange = fn; }

  // Field tracking: key → record. Tracks every Set* value sent to vMix.
  private _fields = new Map<string, FieldRecord>();

  // Retry timer: re-sends 'err' fields every 3 s
  private _retryTimer: ReturnType<typeof setInterval> | null = null;

  getFieldStats(): FieldStat[] {
    return [...this._fields.values()].map(
      ({ key, connectionName, label, status, lastOkAt, lastErrAt, sendCount, errCount, appValue, vmixValue, mismatch, fieldMissing, inputMissing }) =>
        ({ key, connectionName, label, status, lastOkAt, lastErrAt, sendCount, errCount, appValue, vmixValue, mismatch, fieldMissing, inputMissing })
    );
  }

  private _registerField(functionName: string, params: Record<string, string>, url: string, label = ''): string {
    const key = `${functionName}::${params.Input ?? ''}::${params.SelectedName ?? params.Bus ?? ''}`;
    if (!this._fields.has(key)) {
      this._fields.set(key, {
        key, connectionName: this._connectionName, label, url, fn: functionName, params,
        status: 'pending', lastOkAt: null, lastErrAt: null, sendCount: 0, errCount: 0,
        appValue: params.Value ?? null, vmixValue: null, mismatch: null, fieldMissing: false, inputMissing: false,
      });
      this._onStatsChange?.();
    } else {
      const r = this._fields.get(key)!;
      r.url = url; r.label = label; r.fn = functionName; r.params = params;
      r.appValue = params.Value ?? null;
      r.connectionName = this._connectionName;
    }
    return key;
  }

  private _markOk(key: string) {
    const r = this._fields.get(key);
    if (!r) return;
    const wasErr = r.status === 'err';
    const changed = r.status !== 'ok';
    r.status = 'ok'; r.lastOkAt = Date.now(); r.sendCount++;
    if (changed) {
      if (wasErr) this._log?.('sent', `Recovered: ${r.label || key}`);
      this._onStatsChange?.();
    }
  }

  private _markErr(key: string) {
    const r = this._fields.get(key);
    if (!r) return;
    const changed = r.status !== 'err';
    r.status = 'err'; r.lastErrAt = Date.now(); r.errCount++;
    if (changed) {
      this._log?.('send-error', r.label || key);
      this._onStatsChange?.();
    }
  }

  // Fire-and-forget send used by coalesce flush and retry loop.
  private _doSend(fn: string, params: Record<string, string>, url: string, key: string) {
    if (_isTauri && this._tcpActive) {
      const cmd = this._buildTcpCmd(fn, params);
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('vmix_tcp_function', { host: this.host, tcpPort: VmixApiClient.TCP_PORT, cmd })
          .then(() => this._markOk(key))
          .catch(() => httpGet(url).then(() => this._markOk(key)).catch(() => this._markErr(key)))
      );
    } else {
      httpGet(url).then(() => this._markOk(key)).catch(() => this._markErr(key));
    }
  }

  // Retry every field that last failed — called by interval timer and on reconnect.
  private _retryFields() {
    for (const r of this._fields.values()) {
      if (r.status === 'err') this._doSend(r.fn, r.params, r.url, r.key);
    }
  }

  // Look up the current value of a text/image field inside vMix state.
  // Matches input by GUID key, number string, or title (case-insensitive).
  // Distinguishes "input not found at all" from "input found but this exact
  // (case-sensitive) field name doesn't exist on it" — the latter is a real,
  // common typo/case-mismatch (vMix's SelectedName match is case-sensitive
  // and silently no-ops on a mismatch, with no error to catch at send time).
  private _findVmixFieldValue(
    state: VmixState, inputKey: string, fieldName: string,
  ): { inputFound: boolean; value: string | null } {
    const inp = state.inputs.find(i =>
      i.key === inputKey ||
      String(i.number) === inputKey ||
      i.title.toLowerCase() === inputKey.toLowerCase()
    );
    if (!inp) return { inputFound: false, value: null };
    const f = inp.textFields.find(tf => tf.name === fieldName);
    return { inputFound: true, value: f?.value ?? null };
  }

  // Called on every state push. Compares each tracked SetText field against
  // what vMix currently holds. Skips image fields (path rewriting makes comparison
  // unreliable) and very recently sent values (give vMix time to process them).
  private _checkFieldValues(state: VmixState) {
    let changed = false;
    const now = Date.now();
    for (const r of this._fields.values()) {
      // Input existence is a structural fact (not a timing-sensitive value
      // comparison) — vMix assigns a fresh random GUID to every input on each
      // preset load, so a widget still pointed at a previous load's key would
      // otherwise silently no-op forever with no indication why.
      const { inputFound } = this._findVmixFieldValue(state, r.params.Input ?? '', r.params.SelectedName ?? '');
      const inputMissing = !inputFound;

      if (r.fn !== 'SetText') {
        // Images / colours can't be reliably value-compared — clear any stale mismatch
        if (r.mismatch !== null || r.fieldMissing || inputMissing !== r.inputMissing) {
          r.mismatch = null; r.vmixValue = null; r.fieldMissing = false; r.inputMissing = inputMissing; changed = true;
        }
        continue;
      }
      if (r.status !== 'ok') {
        if (inputMissing !== r.inputMissing) { r.inputMissing = inputMissing; changed = true; }
        continue;
      }
      // Wait at least 1 500 ms after the last confirmed send so vMix has time
      // to process the command before we read it back.
      if (r.lastOkAt !== null && now - r.lastOkAt < 1500) continue;

      const { value: vmixVal } = this._findVmixFieldValue(
        state,
        r.params.Input ?? '',
        r.params.SelectedName ?? '',
      );
      // Input exists but the named field never appears on it — near-certainly
      // a case-mismatch or typo in SelectedName, not just "not yet applied".
      const fieldMissing = inputFound && vmixVal === null;
      const newMismatch = vmixVal === null ? null : vmixVal !== r.params.Value;

      if (newMismatch !== r.mismatch || vmixVal !== r.vmixValue || fieldMissing !== r.fieldMissing || inputMissing !== r.inputMissing) {
        r.vmixValue    = vmixVal;
        r.mismatch     = newMismatch;
        r.fieldMissing = fieldMissing;
        r.inputMissing = inputMissing;
        changed = true;
      }
    }
    if (changed) this._onStatsChange?.();
  }

  /** Re-push all registered field values to vMix (e.g. after reconnect or on demand). */
  resync() {
    const fields = [...this._fields.values()];
    if (fields.length === 0) return;
    this._log?.('sent', `Resync: pushing ${fields.length} fields`);
    for (const r of fields) this._doSend(r.fn, r.params, r.url, r.key);
  }

  // Coalesce rapid field writes so that when multiple timers fire in the same
  // tick they don't race each other to the same vMix field.  Only SetText and
  // SetImage are coalesced (last-write-wins per field); all other functions
  // are sent immediately so interactive actions feel instant.
  private coalesceMap = new Map<string, { url: string; label: string; params: Record<string, string>; fn: string }>(); // field-key → {url, label}
  private coalesceScheduled = false;

  // Per vMix's documented TCP API (help29/TCPAPI.html): "FUNCTION <Function>
  // [QueryString] — This Query String exactly matches the syntax and layout
  // of HTTP WEB API. Standard URL escape/encoding characters should be used."
  // i.e. params must be joined with '&' like an HTTP query string, with each
  // value URL-encoded — e.g. "FUNCTION SetText Input=3&SelectedName=Headline&Value=Hello world".
  // Value is deliberately left un-encoded and placed last: vMix's TCP reader
  // takes it verbatim to end-of-line, which is also how the raw space in the
  // documentation's own "Hello world" example survives without escaping.
  private _buildTcpCmd(functionName: string, params: Record<string, string>): string {
    const keys = Object.keys(params).filter(k => k !== 'Value');
    if (params.Value !== undefined) keys.push('Value');
    const paramStr = keys
      .map(k => k === 'Value' ? `Value=${params.Value}` : `${k}=${encodeURIComponent(params[k])}`)
      .join('&');
    return paramStr ? `FUNCTION ${functionName} ${paramStr}` : `FUNCTION ${functionName}`;
  }

  private flushCoalesce() {
    this.coalesceScheduled = false;
    const entries = [...this.coalesceMap.entries()];
    this.coalesceMap.clear();
    for (const [, { url, label, fn, params }] of entries) {
      const key = this._registerField(fn, params, url, label);
      this._doSend(fn, params, url, key);
    }
  }

  constructor(host: string, port = 8088) {
    this.host = host;
    this.httpPort = port;
    this.baseUrl = `http://${host}:${port}`;
    this._retryTimer = setInterval(() => this._retryFields(), 3000);
  }

  get apiUrl() { return `${this.baseUrl}/api/`; }

  async fetchState(): Promise<VmixState> {
    return parseXmlState(await httpGet(this.apiUrl));
  }

  private _fmtCmd(functionName: string, params: Record<string, string>): string {
    const parts = Object.entries(params)
      .filter(([k]) => k !== 'Function')
      .map(([k, v]) => {
        const short = v.length > 40 ? v.slice(0, 40) + '…' : v;
        return `${k}:${short}`;
      });
    return parts.length ? `${functionName}  ${parts.join('  ')}` : functionName;
  }

  async fn(functionName: string, params: Record<string, string> = {}): Promise<void> {
    const q = new URLSearchParams({ Function: functionName, ...params });
    const url = `${this.apiUrl}?${q}`;
    const label = this._fmtCmd(functionName, params);

    // Coalesce rapid SetText/SetImage writes — timers fire 10x/s and would flood
    // both the TCP socket and the log store if sent unbuffered.
    if ((functionName === 'SetText' || functionName === 'SetImage') &&
        params.Input && params.SelectedName) {
      this.coalesceMap.set(`${params.Input}::${params.SelectedName}`, { url, label, fn: functionName, params });
      if (!this.coalesceScheduled) {
        this.coalesceScheduled = true;
        queueMicrotask(() => this.flushCoalesce());
      }
      return;
    }

    // Tracked delivery for all other Set* commands (SetColor, SetVolume, …).
    // Register first so the field appears in stats even if the send is pending.
    if (functionName.startsWith('Set')) {
      const key = this._registerField(functionName, params, url, label);
      if (_isTauri && this._tcpActive) {
        const cmd = this._buildTcpCmd(functionName, params);
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('vmix_tcp_function', { host: this.host, tcpPort: VmixApiClient.TCP_PORT, cmd });
          this._markOk(key);
          this._log?.('sent', label);
          invoke('vmix_tcp_refresh', { host: this.host, tcpPort: VmixApiClient.TCP_PORT }).catch(() => {});
          return;
        } catch {
          this._log?.('send-error', `TCP failed, retrying via HTTP: ${label}`);
        }
      }
      try {
        await httpGet(url);
        this._markOk(key);
        this._log?.('sent', label);
      } catch (err) {
        this._markErr(key);
        const msg = err instanceof Error ? err.message : String(err);
        this._log?.('send-error', `${label} — ${msg}`);
        throw err;
      }
      if (_isTauri && this._tcpActive) {
        import('@tauri-apps/api/core').then(({ invoke }) =>
          invoke('vmix_tcp_refresh', { host: this.host, tcpPort: VmixApiClient.TCP_PORT }).catch(() => {})
        );
      } else if (this.onStateUpdate) {
        this.fetchState().then(s => this.onStateUpdate?.(s)).catch(() => {});
      }
      return;
    }

    // Non-Set* one-shot commands (Cut, Fade, OverlayIn, StartRecording, …).
    // Not tracked — these are interactive actions, not persistent state.
    if (_isTauri && this._tcpActive) {
      const cmd = this._buildTcpCmd(functionName, params);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('vmix_tcp_function', { host: this.host, tcpPort: VmixApiClient.TCP_PORT, cmd });
        this._log?.('sent', label);
        invoke('vmix_tcp_refresh', { host: this.host, tcpPort: VmixApiClient.TCP_PORT }).catch(() => {});
        return;
      } catch {
        this._log?.('send-error', `TCP failed, retrying via HTTP: ${label}`);
      }
    }
    try {
      await httpGet(url);
      this._log?.('sent', label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log?.('send-error', `${label} — ${msg}`);
      throw err;
    }
    if (_isTauri && this._tcpActive) {
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('vmix_tcp_refresh', { host: this.host, tcpPort: VmixApiClient.TCP_PORT }).catch(() => {})
      );
    } else if (this.onStateUpdate) {
      this.fetchState().then(s => this.onStateUpdate?.(s)).catch(() => {});
    }
  }

  // ── Inputs ──────────────────────────────────────────────────────────────

  async setPreview(input: string)  { await this.fn('PreviewInput', { Input: input }); }
  async setActive(input: string)   { await this.fn('ActiveInput',  { Input: input }); }
  async quickPlay(input: string)   { await this.fn('QuickPlay',    { Input: input }); }
  async setLoop(input: string, loop: boolean) {
    await this.fn(loop ? 'SetLoop' : 'SetUnloop', { Input: input });
  }
  async renameInput(input: string, title: string) {
    await this.fn('SetInputName', { Input: input, Value: title });
  }

  // ── Text / image fields ─────────────────────────────────────────────────

  async setTextField(inputKey: string, fieldName: string, value: string) {
    await this.fn('SetText', { Input: inputKey, SelectedName: fieldName, Value: value });
  }
  async setImageField(inputKey: string, fieldName: string, filePath: string) {
    let resolved = filePath;
    // Rewrite our own local-server image URL → current LAN IP so vMix can fetch it.
    // Matches any host (not just "localhost") on our fixed images port: saved
    // logo URLs are persisted in widget/tournament config and outlive network
    // changes, so a URL resolved to a LAN IP on a previous network would
    // otherwise stay silently broken forever — always re-resolve at send time.
    if (_isTauri && /^http:\/\/[^/]+:9877\/images\//.test(filePath)) {
      const ext = await externalImagesBase();
      if (ext) resolved = ext + '/' + filePath.split('/images/')[1];
    }
    await this.fn('SetImage', { Input: inputKey, SelectedName: fieldName, Value: resolved });
  }
  async setColor(inputKey: string, fieldName: string, color: string) {
    await this.fn('SetColor', { Input: inputKey, SelectedName: fieldName, Value: color });
  }

  // ── Transitions ─────────────────────────────────────────────────────────

  async cut(input?: string)    { await this.fn('Cut',         input ? { Input: input } : {}); }
  async fade(input?: string)   { await this.fn('Fade',        input ? { Input: input } : {}); }
  async trans1(input?: string) { await this.fn('Transition1', input ? { Input: input } : {}); }
  async trans2(input?: string) { await this.fn('Transition2', input ? { Input: input } : {}); }
  async trans3(input?: string) { await this.fn('Transition3', input ? { Input: input } : {}); }
  async trans4(input?: string) { await this.fn('Transition4', input ? { Input: input } : {}); }
  async merge()                { await this.fn('Merge'); }
  async stinger1()             { await this.fn('Stinger1'); }
  async stinger2()             { await this.fn('Stinger2'); }

  /** T-Bar: value 0–255 */
  async setTBar(value: number) { await this.fn('SetFader', { Value: String(Math.round(value)) }); }

  // ── Overlays ────────────────────────────────────────────────────────────

  /** Toggle overlay channel (1–4). If input given, assign it first. */
  async overlayIn(channel: number, inputKey?: string) {
    if (inputKey) await this.fn(`OverlayInput${channel}In`, { Input: inputKey });
    else          await this.fn(`OverlayInput${channel}In`);
  }
  async overlayOut(channel: number) { await this.fn(`OverlayInput${channel}Out`); }
  async overlayToggle(channel: number, inputKey?: string) {
    if (inputKey) await this.fn(`OverlayInput${channel}`, { Input: inputKey });
    else          await this.fn(`OverlayInput${channel}`);
  }
  async overlayPreviewIn(channel: number, inputKey?: string) {
    await this.fn(`PreviewOverlayInput${channel}In`, inputKey ? { Input: inputKey } : {});
  }
  async overlayPreviewOut(channel: number) {
    await this.fn(`PreviewOverlayInput${channel}Out`);
  }

  // ── Recording / Streaming / Outputs ─────────────────────────────────────

  async toggleRecord()      { await this.fn('StartStopRecording'); }
  async startRecord()       { await this.fn('StartRecording'); }
  async stopRecord()        { await this.fn('StopRecording'); }
  async toggleStream()      { await this.fn('StartStopStreaming'); }
  async startStream()       { await this.fn('StartStreaming'); }
  async stopStream()        { await this.fn('StopStreaming'); }
  async toggleExternal()    { await this.fn('StartStopExternal'); }
  async startExternal()     { await this.fn('StartExternal'); }
  async stopExternal()      { await this.fn('StopExternal'); }
  async toggleMultiCorder() { await this.fn('StartStopMultiCorder'); }
  async toggleFullscreen()  { await this.fn('Fullscreen'); }
  async toggleFadeToBlack() { await this.fn('FadeToBlack'); }
  async snapshot()          { await this.fn('Snapshot'); }
  async snapshotInput(input: string) { await this.fn('SnapshotInput', { Input: input }); }

  // ── Audio ────────────────────────────────────────────────────────────────

  async setMasterVolume(vol: number)  { await this.fn('SetMasterVolume', { Value: String(vol) }); }
  async toggleMasterMute()            { await this.fn('MasterMute'); }
  async setHeadphones(vol: number)    { await this.fn('SetHeadphonesVolume', { Value: String(vol) }); }
  async setInputVolume(input: string, vol: number) {
    await this.fn('SetVolume', { Input: input, Value: String(vol) });
  }
  async setInputBalance(input: string, balance: number) {
    await this.fn('SetBalance', { Input: input, Value: String(balance) });
  }
  async setInputGain(input: string, gainDb: number) {
    await this.fn('SetGain', { Input: input, Value: String(gainDb) });
  }
  async muteInput(input: string)   { await this.fn('SetMute',   { Input: input }); }
  async unmuteInput(input: string) { await this.fn('SetUnmute', { Input: input }); }
  async soloInput(input: string)   { await this.fn('SetSolo',   { Input: input }); }
  async unsoloInput(input: string) { await this.fn('SetSoloOff', { Input: input }); }
  async setBusOn(input: string, bus: string)  { await this.fn('AudioBusOn',  { Input: input, Value: bus }); }
  async setBusOff(input: string, bus: string) { await this.fn('AudioBusOff', { Input: input, Value: bus }); }
  async setBusVolume(bus: string, vol: number) {
    await this.fn('SetBusVolume', { Value: String(vol), Bus: bus });
  }
  async muteBus(bus: string)   { await this.fn('BusMute',   { Bus: bus }); }
  async unmuteBus(bus: string) { await this.fn('BusUnmute', { Bus: bus }); }

  // ── Replay ───────────────────────────────────────────────────────────────

  async replayMarkIn()     { await this.fn('ReplayMarkIn'); }
  async replayMarkOut()    { await this.fn('ReplayMarkOut'); }
  async replayPlay()       { await this.fn('ReplayPlay'); }
  async replayPause()      { await this.fn('ReplayPause'); }
  async replayStop()       { await this.fn('ReplayStop'); }
  async replayNow()        { await this.fn('ReplayNow'); }
  async replayLive()       { await this.fn('ReplayLive'); }
  async replayCameraA()    { await this.fn('ReplayACamera'); }
  async replayCameraB()    { await this.fn('ReplayBCamera'); }
  async replayFastForward(speed: string) { await this.fn('ReplayFastForward', { Value: speed }); }
  async replayFastBackward(speed: string) { await this.fn('ReplayFastBackward', { Value: speed }); }
  async replaySpeed(speed: number) { await this.fn('ReplaySpeed', { Value: String(speed) }); }

  // ── Playlist / DDR ───────────────────────────────────────────────────────

  async playInput(input: string)  { await this.fn('Play',  { Input: input }); }
  async pauseInput(input: string) { await this.fn('Pause', { Input: input }); }
  async stopInput(input: string)  { await this.fn('Stop',  { Input: input }); }
  async nextInPlaylist()          { await this.fn('NextPlayListEntry'); }
  async prevInPlaylist()          { await this.fn('PreviousPlayListEntry'); }
  async startPlaylist()           { await this.fn('StartPlayList'); }
  async stopPlaylist()            { await this.fn('StopPlayList'); }
  async setInputPosition(input: string, pos: number) {
    await this.fn('SetPosition', { Input: input, Value: String(pos) });
  }

  // ── Virtual Set / Crop ───────────────────────────────────────────────────

  async setCropX1(input: string, v: number) { await this.fn('SetCropX1', { Input: input, Value: String(v) }); }
  async setCropX2(input: string, v: number) { await this.fn('SetCropX2', { Input: input, Value: String(v) }); }
  async setCropY1(input: string, v: number) { await this.fn('SetCropY1', { Input: input, Value: String(v) }); }
  async setCropY2(input: string, v: number) { await this.fn('SetCropY2', { Input: input, Value: String(v) }); }
  async setPanX(input: string, v: number)   { await this.fn('SetPanX',   { Input: input, Value: String(v) }); }
  async setPanY(input: string, v: number)   { await this.fn('SetPanY',   { Input: input, Value: String(v) }); }
  async setZoom(input: string, v: number)   { await this.fn('SetZoom',   { Input: input, Value: String(v) }); }

  // ── Countdown (vMix built-in) ────────────────────────────────────────────

  async countdownStart(input: string) { await this.fn('CountdownStart', { Input: input }); }
  async countdownStop(input: string)  { await this.fn('CountdownStop',  { Input: input }); }
  async countdownReset(input: string) { await this.fn('CountdownReset', { Input: input }); }
  async setCountdown(input: string, value: string) {
    await this.fn('SetCountdown', { Input: input, Value: value });
  }

  // ── Data sources ─────────────────────────────────────────────────────────

  async dataSourceNextRow(name: string)     { await this.fn('DataSourceAutoNextRow', { Value: name }); }
  async dataSourcePrevRow(name: string)     { await this.fn('DataSourcePreviousRow', { Value: name }); }
  async dataSourceSelectRow(name: string, row: number) {
    await this.fn('DataSourceSelectRow', { Value: name, Row: String(row) });
  }

  // ── Generic ──────────────────────────────────────────────────────────────

  async sendFunction(functionName: string, params: Record<string, string> = {}) {
    await this.fn(functionName, params);
  }

  // ── Real-time TCP subscription (Tauri) + HTTP polling fallback ─────────────

  startPolling(
    onState: (state: VmixState) => void,
    onError: (error: string) => void,
    _intervalMs = 800,
  ) {
    // Wrap onState so every incoming vMix state is also checked for field mismatches.
    // _lastStateAt is updated here to drive the stale watchdog below.
    this._lastStateAt = Date.now();
    this.onStateUpdate = (state: VmixState) => {
      this._lastStateAt = Date.now();
      try { this._checkFieldValues(state); } catch { /* never block state updates */ }
      onState(state);
    };
    this.onError = onError;
    this._pollRunning = true;

    // Watchdog: if no XML state arrives for 12s, the TCP connection is zombie
    // or the HTTP poll has silently died. Force a reconnect to recover.
    if (this._staleWatchdog) clearInterval(this._staleWatchdog);
    this._staleWatchdog = setInterval(() => {
      if (!this._pollRunning) return;
      if (Date.now() - this._lastStateAt < 12000) return;
      if (this._tcpActive) {
        this._log?.('tcp-stale', 'No state for 12s — disconnecting zombie TCP, restarting');
        this._tcpActive = false;
        if (this._tcpKeepaliveTimer) { clearInterval(this._tcpKeepaliveTimer); this._tcpKeepaliveTimer = null; }
        this._tcpUnlisten?.(); this._tcpUnlisten = null;
        this._tcpDiscUnlisten?.(); this._tcpDiscUnlisten = null;
        if (_isTauri) {
          import('@tauri-apps/api/core').then(({ invoke }) =>
            invoke('vmix_tcp_disconnect', { host: this.host, tcpPort: VmixApiClient.TCP_PORT }).catch(() => {})
          );
        }
        this._isReconnecting = true;
        // HTTP poll already running; it auto-accelerates now that _tcpActive is false.
        if (this._tcpReconnectTimer) clearTimeout(this._tcpReconnectTimer);
        this._tcpReconnectTimer = setTimeout(() => this._startTCP(), 2000);
      } else if (!this._httpPollActive) {
        // HTTP poll has silently stopped
        this._log?.('poll-restart', 'HTTP poll stalled — restarting');
        this._startHttpPoll(500);
      }
    }, 6000);

    if (_isTauri) {
      // Desktop: run both TCP and HTTP polling simultaneously.
      // TCP polls XML every 200ms over the open socket — the primary
      // near-real-time path (cheap, no new connection per request).
      // HTTP polling runs in parallel (throttled to 2000ms while TCP is active)
      // as a guaranteed backup — if TCP becomes zombie, HTTP keeps lastUpdated
      // fresh and ensures sends fall back to HTTP automatically.
      this._startHttpPoll(500);
      this._startTCP();
    } else {
      // Browser: no TCP available, use HTTP polling.
      this._startHttpPoll(250);
    }
  }

  private _isReconnecting = false;

  private _startHttpPoll(intervalMs: number) {
    // Guard: only one HTTP poll loop at a time.
    if (this._httpPollActive) return;
    this._httpPollActive = true;
    const poll = async () => {
      if (!this._pollRunning) {
        this._httpPollActive = false;
        return;
      }
      try {
        this.onStateUpdate?.(await this.fetchState());
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Poll error';
        this._log?.('poll-error', msg);
        this.onError?.(msg);
      }
      if (this._pollRunning) {
        // While TCP is providing real-time pushes, throttle HTTP to 2000ms.
        // When TCP is down, use the faster interval (500ms) so state stays current.
        const next = this._tcpActive ? 2000 : intervalMs;
        this.pollTimer = setTimeout(poll, next);
      } else {
        this._httpPollActive = false;
      }
    };
    poll();
  }

  private async _startTCP() {
    // _tcpConnecting guards against concurrent connect attempts while the Rust
    // call is in flight. We do NOT set _tcpActive yet — that would block HTTP
    // polling during the connect timeout (3-5 s), causing false "stale" alerts.
    if (this._tcpActive || this._tcpConnecting) return;
    this._tcpConnecting = true;
    if (this._tcpReconnectTimer) { clearTimeout(this._tcpReconnectTimer); this._tcpReconnectTimer = null; }

    // HTTP poll is already running in parallel — no bridge needed during TCP connect.
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen }  = await import('@tauri-apps/api/event');

    const xmlEvent  = `vmix-xml-${this.host}-${VmixApiClient.TCP_PORT}`;
    const discEvent = `vmix-tcp-disc-${this.host}-${VmixApiClient.TCP_PORT}`;

    try {
      await invoke('vmix_tcp_connect', { host: this.host, tcpPort: VmixApiClient.TCP_PORT });
      // TCP connected. vMix's TCP API has no push subscription for full state
      // (only TALLY/ACTS are subscribable) — "XML" is request/response only.
      // So real-time state here means polling XML\r\n frequently over this
      // already-open socket, which is cheap (~50-100ms round-trip on LAN)
      // compared to spinning up a new HTTP connection each time.
      // HTTP poll keeps running in parallel too (throttled to 2000ms) as backup.
      this._tcpActive = true;
      this._tcpConnecting = false;
      this._tcpBackoffMs = 3000; // reset now that TCP is healthy again
      const wasReconnecting = this._isReconnecting;
      this._isReconnecting = false;
      this._log?.(wasReconnecting ? 'tcp-reconnect' : 'tcp-connect');
      // After a reconnect, give the TCP connection 300ms to settle then
      // re-push all registered fields so vMix matches the app state.
      if (wasReconnecting) setTimeout(() => this.resync(), 300);
      // Poll XML over TCP every 200ms — this is the real near-real-time path,
      // catching changes from vMix itself or other control surfaces, not just
      // our own sends (which also get an immediate refresh right after sending).
      if (this._tcpKeepaliveTimer) clearInterval(this._tcpKeepaliveTimer);
      this._tcpKeepaliveTimer = setInterval(() => {
        if (this._tcpActive && _isTauri) {
          import('@tauri-apps/api/core').then(({ invoke }) =>
            invoke('vmix_tcp_refresh', { host: this.host, tcpPort: VmixApiClient.TCP_PORT }).catch(() => {})
          );
        }
      }, 200);
    } catch {
      // TCP unavailable (old vMix, firewall, vMix still starting up, transient
      // network blip, …) — HTTP poll already running. Keep retrying with
      // backoff instead of giving up on TCP for the rest of the session.
      this._tcpConnecting = false;
      this._tcpActive = false;
      const retryIn = this._tcpBackoffMs;
      this._log?.('poll-fallback', `TCP port 8099 unavailable — HTTP poll continues, retrying TCP in ${Math.round(retryIn / 1000)}s`);
      if (this._pollRunning) {
        this._isReconnecting = true;
        if (this._tcpReconnectTimer) clearTimeout(this._tcpReconnectTimer);
        this._tcpReconnectTimer = setTimeout(() => this._startTCP(), retryIn);
        this._tcpBackoffMs = Math.min(this._tcpBackoffMs * 2, VmixApiClient.TCP_BACKOFF_MAX);
      }
      return;
    }

    // Listen for full XML state pushes from vMix (fires immediately on subscribe,
    // then on every state change, and on each explicit XML\r\n request).
    this._tcpUnlisten = await listen<string>(xmlEvent, (event) => {
      try { this.onStateUpdate?.(parseXmlState(event.payload)); } catch (e) { console.warn('vMix XML parse:', e); }
    });

    // Listen for disconnect: bridge with HTTP polling during the 3 s reconnect gap.
    this._tcpDiscUnlisten = await listen<void>(discEvent, () => {
      this._tcpActive = false;
      if (this._tcpKeepaliveTimer) { clearInterval(this._tcpKeepaliveTimer); this._tcpKeepaliveTimer = null; }
      this._log?.('tcp-disconnect', 'TCP dropped — HTTP poll accelerates, reconnecting in 3s');
      this._tcpUnlisten?.(); this._tcpUnlisten = null;
      this._tcpDiscUnlisten?.(); this._tcpDiscUnlisten = null;
      if (this._pollRunning) {
        // HTTP poll is already running; it auto-accelerates now that _tcpActive is false.
        this._isReconnecting = true;
        this._tcpReconnectTimer = setTimeout(() => this._startTCP(), 3000);
      }
    });
  }

  stopPolling() {
    this._pollRunning = false;
    this._tcpActive = false;
    this._tcpConnecting = false;
    this._tcpBackoffMs = 3000;
    this._httpPollActive = false;
    this._fields.clear();
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
    if (this._staleWatchdog) { clearInterval(this._staleWatchdog); this._staleWatchdog = null; }
    if (this._tcpReconnectTimer) { clearTimeout(this._tcpReconnectTimer); this._tcpReconnectTimer = null; }
    if (this._tcpKeepaliveTimer) { clearInterval(this._tcpKeepaliveTimer); this._tcpKeepaliveTimer = null; }
    this._tcpUnlisten?.(); this._tcpUnlisten = null;
    this._tcpDiscUnlisten?.(); this._tcpDiscUnlisten = null;
    this._onStatsChange?.();
    if (_isTauri) {
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('vmix_tcp_disconnect', { host: this.host, tcpPort: VmixApiClient.TCP_PORT }).catch(() => {})
      );
    }
  }
}
