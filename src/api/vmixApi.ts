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
  // In Tauri, route through Rust backend — no browser network restrictions.
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('http_get', { url });
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
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
  private _tcpReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Coalesce rapid field writes so that when multiple timers fire in the same
  // tick they don't race each other to the same vMix field.  Only SetText and
  // SetImage are coalesced (last-write-wins per field); all other functions
  // are sent immediately so interactive actions feel instant.
  private coalesceMap = new Map<string, string>(); // field-key → URL
  private coalesceScheduled = false;

  private flushCoalesce() {
    this.coalesceScheduled = false;
    const urls = [...this.coalesceMap.values()];
    this.coalesceMap.clear();
    for (const url of urls) httpGet(url).catch(() => {});
  }

  constructor(host: string, port = 8088) {
    this.host = host;
    this.httpPort = port;
    this.baseUrl = `http://${host}:${port}`;
  }

  get apiUrl() { return `${this.baseUrl}/api/`; }

  async fetchState(): Promise<VmixState> {
    return parseXmlState(await httpGet(this.apiUrl));
  }

  async fn(functionName: string, params: Record<string, string> = {}): Promise<void> {
    const q = new URLSearchParams({ Function: functionName, ...params });
    const url = `${this.apiUrl}?${q}`;
    // Coalesce field writes: buffer same-field updates and only send the last
    // value that arrives within the current synchronous execution frame.
    if ((functionName === 'SetText' || functionName === 'SetImage') &&
        params.Input && params.SelectedName) {
      this.coalesceMap.set(`${params.Input}::${params.SelectedName}`, url);
      if (!this.coalesceScheduled) {
        this.coalesceScheduled = true;
        queueMicrotask(() => this.flushCoalesce());
      }
      return;
    }
    await httpGet(url);
    // After command delivery, force an immediate vMix state push:
    // — TCP active: send "XML\r\n" through the existing TCP socket so vMix
    //   pushes a fresh state within ~5 ms (no extra HTTP round-trip).
    // — TCP inactive: fire an HTTP fetchState as fallback.
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
    await this.fn('SetImage', { Input: inputKey, SelectedName: fieldName, Value: filePath });
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
    this.onStateUpdate = onState;
    this.onError = onError;
    this._pollRunning = true;

    if (_isTauri) {
      // Desktop: TCP push only — zero HTTP polling.
      // vMix's SUBSCRIBE XML pushes full state on every change, and XML\r\n
      // is sent after every command for instant refresh.
      // HTTP polling activates automatically only if TCP port 8099 is blocked.
      this._startTCP();
    } else {
      // Browser: no TCP available, use HTTP polling.
      this._startHttpPoll(250);
    }
  }

  private _startHttpPoll(intervalMs: number) {
    const poll = async () => {
      // Stop if polling was cancelled or if TCP took over (reconnected).
      if (!this._pollRunning || this._tcpActive) return;
      try {
        this.onStateUpdate?.(await this.fetchState());
      } catch (err) {
        this.onError?.(err instanceof Error ? err.message : 'Poll error');
      }
      if (this._pollRunning && !this._tcpActive) {
        this.pollTimer = setTimeout(poll, intervalMs);
      }
    };
    poll();
  }

  private async _startTCP() {
    if (this._tcpActive) return;
    this._tcpActive = true;
    if (this._tcpReconnectTimer) { clearTimeout(this._tcpReconnectTimer); this._tcpReconnectTimer = null; }

    const { invoke } = await import('@tauri-apps/api/core');
    const { listen }  = await import('@tauri-apps/api/event');

    const xmlEvent  = `vmix-xml-${this.host}-${VmixApiClient.TCP_PORT}`;
    const discEvent = `vmix-tcp-disc-${this.host}-${VmixApiClient.TCP_PORT}`;

    try {
      await invoke('vmix_tcp_connect', { host: this.host, tcpPort: VmixApiClient.TCP_PORT });
    } catch {
      // TCP unavailable (old vMix, firewall) — fall back to HTTP polling.
      this._tcpActive = false;
      if (this._pollRunning) this._startHttpPoll(500);
      return;
    }

    // Listen for full XML state pushes from vMix (fires immediately on subscribe,
    // then on every state change, and on each explicit XML\r\n request).
    this._tcpUnlisten = await listen<string>(xmlEvent, (event) => {
      try { this.onStateUpdate?.(parseXmlState(event.payload)); } catch { /* ignore parse errors */ }
    });

    // Listen for disconnect: bridge with HTTP polling during the 3 s reconnect gap.
    this._tcpDiscUnlisten = await listen<void>(discEvent, () => {
      this._tcpActive = false;
      this._tcpUnlisten?.(); this._tcpUnlisten = null;
      this._tcpDiscUnlisten?.(); this._tcpDiscUnlisten = null;
      if (this._pollRunning) {
        this._startHttpPoll(500); // temporary bridge; stops automatically when TCP reconnects
        this._tcpReconnectTimer = setTimeout(() => this._startTCP(), 3000);
      }
    });
  }

  stopPolling() {
    this._pollRunning = false;
    this._tcpActive = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this._tcpReconnectTimer) { clearTimeout(this._tcpReconnectTimer); this._tcpReconnectTimer = null; }
    this._tcpUnlisten?.(); this._tcpUnlisten = null;
    this._tcpDiscUnlisten?.(); this._tcpDiscUnlisten = null;
    if (_isTauri) {
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('vmix_tcp_disconnect', { host: this.host, tcpPort: VmixApiClient.TCP_PORT }).catch(() => {})
      );
    }
  }
}
