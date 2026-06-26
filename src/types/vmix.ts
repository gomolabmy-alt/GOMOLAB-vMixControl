// ─── vMix state types ──────────────────────────────────────────────────────

export interface VmixTextField {
  name: string;
  value: string;
}

export interface VmixInput {
  key: string;
  number: number;
  type: string;
  title: string;
  state: string;
  duration: number;
  position: number;
  loop: boolean;
  muted: boolean;
  volume: number;
  balance: number;
  solo: boolean;
  audioBusses: string; // e.g. "MA" means Master + A
  meterF1: number;
  meterF2: number;
  gainDb: number;
  textFields: VmixTextField[];
}

export interface VmixOverlay {
  number: number; // 1–4
  key: string;    // empty string if nothing assigned
  inputNumber: number;
}

export interface VmixAudioBus {
  name: string; // M, A, B, C, D, E, F, G
  volume: number;
  muted: boolean;
  meterF1: number;
  meterF2: number;
}

export interface VmixMasterAudio {
  volume: number;
  muted: boolean;
  meterF1: number;
  meterF2: number;
  headphonesVolume: number;
}

export interface VmixTransition {
  number: number;
  effect: string;
  duration: number;
}

export interface VmixState {
  version: string;
  edition: string;
  inputs: VmixInput[];
  overlays: VmixOverlay[];
  preview: number;
  active: number;
  recording: boolean;
  external: boolean;
  streaming: boolean;
  multiCorder: boolean;
  fullscreen: boolean;
  fadeToBlack: boolean;
  transitions: VmixTransition[];
  masterAudio: VmixMasterAudio;
  audioBuses: VmixAudioBus[];
}

// ─── Connection ────────────────────────────────────────────────────────────

export interface ConnectionConfig {
  host: string;
  port: number;
}

export interface SavedConnection extends ConnectionConfig {
  id: string;
  name: string;
  lastConnected?: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface VmixConnectionEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  status: ConnectionStatus;
  error: string | null;
  vmixState: VmixState | null;
  lastUpdated: number | null;
}

// ─── Shortcuts ─────────────────────────────────────────────────────────────

export type ShortcutMode = 'momentary' | 'toggle';

export interface Shortcut {
  id: string;
  label: string;
  function: string;
  params: Record<string, string>;
  /** Optional second function fired on release (toggle mode release / momentary release) */
  releaseFunction?: string;
  releaseParams?: Record<string, string>;
  mode: ShortcutMode;
  color?: string;
  /** If set, label renders as "{varName}" replaced with global variable value */
  variableLabel?: string;
}

// ─── Scoreboard ────────────────────────────────────────────────────────────

export type ScoreboardStyle = 'basic' | 'basketball' | 'football' | 'soccer';

export interface ScoreboardTeam {
  name: string;
  score: number;
  color: string;
}

export interface Scoreboard {
  id: string;
  name: string;
  style: ScoreboardStyle;
  teamA: ScoreboardTeam;
  teamB: ScoreboardTeam;
  // vMix GT target
  vmixInputKey: string;
  fieldTeamA: string;
  fieldTeamB: string;
  fieldScoreA: string;
  fieldScoreB: string;
}

// ─── Timer ─────────────────────────────────────────────────────────────────

export type TimerMode = 'countdown' | 'countup';
export type TimerFormat = 'hh:mm:ss' | 'mm:ss' | 'ss' | 'h:mm:ss';

export interface VmixTimer {
  id: string;
  name: string;
  mode: TimerMode;
  format: TimerFormat;
  /** Total duration in milliseconds (countdown start / countup max) */
  durationMs: number;
  /** Current elapsed/remaining ms */
  currentMs: number;
  running: boolean;
  highPrecision: boolean;
  // vMix GT target
  vmixInputKey: string;
  fieldName: string;
}

// ─── Data Binding ──────────────────────────────────────────────────────────

export type DataSourceType = 'json' | 'xml' | 'text';

export interface DataBinding {
  id: string;
  name: string;
  sourceType: DataSourceType;
  sourceUrl: string;
  /** dot-path for JSON (e.g. "data.temperature") or XPath for XML */
  selector: string;
  pollIntervalMs: number;
  enabled: boolean;
  // vMix GT target
  vmixInputKey: string;
  fieldName: string;
  lastValue: string;
  lastFetched: number | null;
  lastError: string | null;
}

// ─── Global Variables ──────────────────────────────────────────────────────

export interface GlobalVariable {
  id: string;
  name: string;
  value: string;
}

// ─── Input type display helpers ────────────────────────────────────────────

export const INPUT_TYPE_LABELS: Record<string, string> = {
  GT: 'Title',
  Video: 'Video',
  AudioFile: 'Audio',
  Image: 'Image',
  Colour: 'Color',
  DDR: 'DDR',
  VirtualSet: 'VSet',
  Browser: 'Web',
  Camera: 'Camera',
  Capture: 'Capture',
  NDI: 'NDI',
  Stream: 'Stream',
  Blank: 'Blank',
  Mix: 'Mix',
  Photo: 'Photo',
  Powerpoint: 'PPT',
  VideoList: 'VList',
  Replay: 'Replay',
};

export const AUDIO_BUS_NAMES = ['M', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type AudioBusName = typeof AUDIO_BUS_NAMES[number];

export const SCORE_INCREMENTS: Record<ScoreboardStyle, number[]> = {
  basic: [1, 2, 5, 10],
  basketball: [1, 2, 3],
  football: [1, 2, 3, 6, 7],
  soccer: [1],
};
