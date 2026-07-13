import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasStore } from '../stores/canvasStore';
import { useVmixStore } from '../stores/vmixStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { useTeamDbStore } from '../stores/teamDbStore';
import { WIDGET_TYPE_ICONS, WIDGET_TYPE_LABELS } from '../types/canvas';
import type { CanvasWidget } from '../types/canvas';
import { INPUT_TYPE_LABELS } from '../types/vmix';
import type { VmixInput } from '../types/vmix';
import { LogoUrlPicker } from './LogoUrlPicker';
import { ConfirmButton } from './ConfirmButton';
import { resolveImageUrl } from '../lib/imageUrl';
import { useMatchResultsStore } from '../stores/matchResultsStore';

// Label for a player-list widget in a picker dropdown — shows the linked
// saved team's name (teamDbStore), falling back to a short widget id.
function plWidgetLabel(w: { id: string; config: Record<string, any> }, teamDbTeams: { id: string; name: string }[]): string {
  const t = teamDbTeams.find(t2 => t2.id === w.config.linkedTeamId);
  return t ? t.name : `Widget ${w.id.slice(0, 6)}`;
}

function msToFormatStr(ms: number, format: string): string {
  const totalSec = Math.floor((ms ?? 0) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (format === 'ss') return String(totalSec);
  if (format === 'mm:ss') return `${pad(m)}:${pad(s)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatStrToMs(str: string, format: string): number {
  if (format === 'ss') return (parseInt(str) || 0) * 1000;
  const parts = str.split(':').map(v => parseInt(v) || 0);
  if (format === 'mm:ss') {
    const [m = 0, s = 0] = parts;
    return (m * 60 + s) * 1000;
  }
  const [h = 0, m = 0, s = 0] = parts;
  return (h * 3600 + m * 60 + s) * 1000;
}

const PRESET_COLORS = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#34495e','#ecf0f1','#ffffff'];
const TRANS_KEYS = ['cut','fade','auto','t2','t3','t4','stinger1','stinger2','ftb'];
const RUGBY_UNION_INCS = [
  { label: 'Try',  value: 5 },
  { label: 'Conv', value: 2 },
  { label: 'Pen',  value: 3 },
  { label: 'Drop', value: 3 },
  { label: 'PTry', value: 7 },
];
const RUGBY_LEAGUE_INCS = [
  { label: 'Try',  value: 4 },
  { label: 'Conv', value: 2 },
  { label: 'Pen',  value: 2 },
  { label: 'Drop', value: 1 },
];

const VMIX_FUNCTIONS: { group: string; fns: { fn: string; label: string; p: string[] }[] }[] = [
  { group: 'Transitions', fns: [
    { fn: 'Cut',                    label: 'Cut',                    p: ['Input'] },
    { fn: 'Fade',                   label: 'Fade',                   p: ['Input'] },
    { fn: 'Transition1',            label: 'Auto (T1)',              p: ['Input'] },
    { fn: 'Transition2',            label: 'Transition 2',           p: ['Input'] },
    { fn: 'Transition3',            label: 'Transition 3',           p: ['Input'] },
    { fn: 'Transition4',            label: 'Transition 4',           p: ['Input'] },
    { fn: 'Stinger1',               label: 'Stinger 1',              p: ['Input'] },
    { fn: 'Stinger2',               label: 'Stinger 2',              p: ['Input'] },
    { fn: 'FadeToBlack',            label: 'Fade To Black',          p: [] },
    { fn: 'SetTransitionEffect1',   label: 'Set T1 Effect',          p: ['Value'] },
    { fn: 'SetTransitionEffect2',   label: 'Set T2 Effect',          p: ['Value'] },
    { fn: 'SetTransitionEffect3',   label: 'Set T3 Effect',          p: ['Value'] },
    { fn: 'SetTransitionEffect4',   label: 'Set T4 Effect',          p: ['Value'] },
    { fn: 'SetTransitionDuration1', label: 'Set T1 Duration (ms)',   p: ['Value'] },
    { fn: 'SetTransitionDuration2', label: 'Set T2 Duration (ms)',   p: ['Value'] },
    { fn: 'SetTransitionDuration3', label: 'Set T3 Duration (ms)',   p: ['Value'] },
    { fn: 'SetTransitionDuration4', label: 'Set T4 Duration (ms)',   p: ['Value'] },
  ]},
  { group: 'Inputs', fns: [
    { fn: 'PreviewInput',           label: 'Preview Input',          p: ['Input'] },
    { fn: 'ActiveInput',            label: 'Active Input',           p: ['Input'] },
    { fn: 'SetNextInput',           label: 'Next Input',             p: ['Input'] },
    { fn: 'SetPreviousInput',       label: 'Previous Input',         p: [] },
    { fn: 'ResetInput',             label: 'Reset Input',            p: ['Input'] },
    { fn: 'CloseInput',             label: 'Close Input',            p: ['Input'] },
    { fn: 'SetInputAlpha',          label: 'Set Alpha',              p: ['Input', 'Value'] },
    { fn: 'SetInputZoom',           label: 'Set Zoom',               p: ['Input', 'Value'] },
    { fn: 'SetInputPanX',           label: 'Set Pan X',              p: ['Input', 'Value'] },
    { fn: 'SetInputPanY',           label: 'Set Pan Y',              p: ['Input', 'Value'] },
    { fn: 'SetInputVolume',         label: 'Set Input Volume',       p: ['Input', 'Value'] },
  ]},
  { group: 'Overlay', fns: [
    { fn: 'OverlayInput1',          label: 'Overlay 1 Toggle',       p: ['Input'] },
    { fn: 'OverlayInput2',          label: 'Overlay 2 Toggle',       p: ['Input'] },
    { fn: 'OverlayInput3',          label: 'Overlay 3 Toggle',       p: ['Input'] },
    { fn: 'OverlayInput4',          label: 'Overlay 4 Toggle',       p: ['Input'] },
    { fn: 'OverlayInput1In',        label: 'Overlay 1 In',           p: ['Input'] },
    { fn: 'OverlayInput2In',        label: 'Overlay 2 In',           p: ['Input'] },
    { fn: 'OverlayInput3In',        label: 'Overlay 3 In',           p: ['Input'] },
    { fn: 'OverlayInput4In',        label: 'Overlay 4 In',           p: ['Input'] },
    { fn: 'OverlayInput1Out',       label: 'Overlay 1 Out',          p: ['Input'] },
    { fn: 'OverlayInput2Out',       label: 'Overlay 2 Out',          p: ['Input'] },
    { fn: 'OverlayInput3Out',       label: 'Overlay 3 Out',          p: ['Input'] },
    { fn: 'OverlayInput4Out',       label: 'Overlay 4 Out',          p: ['Input'] },
    { fn: 'OverlayInput1Off',       label: 'Overlay 1 Off',          p: [] },
    { fn: 'OverlayInput2Off',       label: 'Overlay 2 Off',          p: [] },
    { fn: 'OverlayInput3Off',       label: 'Overlay 3 Off',          p: [] },
    { fn: 'OverlayInput4Off',       label: 'Overlay 4 Off',          p: [] },
  ]},
  { group: 'Title / GT', fns: [
    { fn: 'SetText',                label: 'Set Text',               p: ['Input', 'SelectedName', 'Value'] },
    { fn: 'SetTextCase',            label: 'Set Text Case',          p: ['Input', 'SelectedName', 'Value'] },
    { fn: 'SetImage',               label: 'Set Image',              p: ['Input', 'SelectedName', 'Value'] },
    { fn: 'SetColor',               label: 'Set Color (ARGB)',       p: ['Input', 'SelectedName', 'Value'] },
    { fn: 'SetTickerSpeed',         label: 'Set Ticker Speed',       p: ['Input', 'Value'] },
    { fn: 'SetCountdown',           label: 'Set Countdown',          p: ['Input', 'SelectedName', 'Value'] },
    { fn: 'StartCountdown',         label: 'Start Countdown',        p: ['Input', 'SelectedName'] },
    { fn: 'StopCountdown',          label: 'Stop Countdown',         p: ['Input', 'SelectedName'] },
    { fn: 'PauseCountdown',         label: 'Pause Countdown',        p: ['Input', 'SelectedName'] },
    { fn: 'ResetCountdown',         label: 'Reset Countdown',        p: ['Input', 'SelectedName'] },
    { fn: 'AdjustCountdown',        label: 'Adjust Countdown (+/-s)', p: ['Input', 'SelectedName', 'Value'] },
    { fn: 'NextPhoto',              label: 'Next Photo',             p: ['Input'] },
    { fn: 'PreviousPhoto',          label: 'Previous Photo',         p: ['Input'] },
    { fn: 'SelectTitlePreset',      label: 'Select Title Preset',    p: ['Input', 'Value'] },
    { fn: 'TitlePreset',            label: 'Title Preset Next',      p: ['Input'] },
    { fn: 'TitleBeginAnimation',    label: 'Title Begin Animation',  p: ['Input', 'Value'] },
    { fn: 'SelectDataSourceRow',    label: 'Data Source Select Row', p: ['Input', 'SelectedName', 'Value'] },
    { fn: 'NextDataSourceRow',      label: 'Data Source Next Row',   p: ['Input', 'SelectedName'] },
    { fn: 'PreviousDataSourceRow',  label: 'Data Source Prev Row',   p: ['Input', 'SelectedName'] },
    { fn: 'SetDynamic1',            label: 'Set Dynamic 1',          p: ['Value'] },
    { fn: 'SetDynamic2',            label: 'Set Dynamic 2',          p: ['Value'] },
    { fn: 'SetDynamic3',            label: 'Set Dynamic 3',          p: ['Value'] },
    { fn: 'SetDynamic4',            label: 'Set Dynamic 4',          p: ['Value'] },
  ]},
  { group: 'Playback', fns: [
    { fn: 'Play',                   label: 'Play',                   p: ['Input'] },
    { fn: 'Pause',                  label: 'Pause',                  p: ['Input'] },
    { fn: 'PlayPause',              label: 'Play / Pause',           p: ['Input'] },
    { fn: 'Restart',                label: 'Restart',                p: ['Input'] },
    { fn: 'Loop',                   label: 'Loop Toggle',            p: ['Input'] },
    { fn: 'LoopOn',                 label: 'Loop On',                p: ['Input'] },
    { fn: 'LoopOff',                label: 'Loop Off',               p: ['Input'] },
  ]},
  { group: 'Audio', fns: [
    { fn: 'AudioOn',                label: 'Audio On',               p: ['Input'] },
    { fn: 'AudioOff',               label: 'Audio Off',              p: ['Input'] },
    { fn: 'AudioAutoOn',            label: 'Audio Auto On',          p: ['Input'] },
    { fn: 'AudioAutoOff',           label: 'Audio Auto Off',         p: ['Input'] },
    { fn: 'SetVolume',              label: 'Set Volume (0–100)',      p: ['Input', 'Value'] },
    { fn: 'SetMasterVolume',        label: 'Set Master Volume',      p: ['Value'] },
    { fn: 'SetBalance',             label: 'Set Balance (-1 to 1)',  p: ['Input', 'Value'] },
    { fn: 'SetGain',                label: 'Set Gain (dB)',          p: ['Input', 'Value'] },
    { fn: 'SetHeadphonesVolume',    label: 'Set Headphones Volume',  p: ['Value'] },
    { fn: 'AudioBusOn',             label: 'Audio Bus On',           p: ['Input', 'Value'] },
    { fn: 'AudioBusOff',            label: 'Audio Bus Off',          p: ['Input', 'Value'] },
    { fn: 'AudioMixerShowHide',     label: 'Audio Mixer Toggle',     p: [] },
  ]},
  { group: 'Recording / Streaming', fns: [
    { fn: 'StartRecording',         label: 'Start Recording',        p: [] },
    { fn: 'StopRecording',          label: 'Stop Recording',         p: [] },
    { fn: 'PauseRecording',         label: 'Pause Recording',        p: [] },
    { fn: 'StartStreaming',         label: 'Start Streaming',        p: ['Value'] },
    { fn: 'StopStreaming',          label: 'Stop Streaming',         p: ['Value'] },
    { fn: 'StartExternal',          label: 'Start External',         p: [] },
    { fn: 'StopExternal',           label: 'Stop External',          p: [] },
    { fn: 'StartMultiCorder',       label: 'Start MultiCorder',      p: [] },
    { fn: 'StopMultiCorder',        label: 'Stop MultiCorder',       p: [] },
    { fn: 'StartOutput',            label: 'Start Output',           p: ['Value'] },
    { fn: 'StopOutput',             label: 'Stop Output',            p: ['Value'] },
    { fn: 'StartSRTOutput',         label: 'Start SRT Output',       p: ['Value'] },
    { fn: 'StopSRTOutput',          label: 'Stop SRT Output',        p: ['Value'] },
  ]},
  { group: 'List', fns: [
    { fn: 'ListAdd',                label: 'List Add',               p: ['Input', 'Value'] },
    { fn: 'ListRemoveAll',          label: 'List Remove All',        p: ['Input'] },
    { fn: 'ListSelectIndex',        label: 'List Select Index',      p: ['Input', 'Value'] },
    { fn: 'ListPlayNext',           label: 'List Play Next',         p: ['Input'] },
    { fn: 'ListShuffle',            label: 'List Shuffle',           p: ['Input'] },
  ]},
  { group: 'Browser', fns: [
    { fn: 'BrowserNavigate',        label: 'Browser Navigate',       p: ['Input', 'Value'] },
    { fn: 'BrowserReload',          label: 'Browser Reload',         p: ['Input'] },
    { fn: 'BrowserBack',            label: 'Browser Back',           p: ['Input'] },
    { fn: 'BrowserForward',         label: 'Browser Forward',        p: ['Input'] },
    { fn: 'BrowserKeyboardShowHide',label: 'Browser Keyboard Toggle',p: ['Input'] },
  ]},
  { group: 'PTZ', fns: [
    { fn: 'PTZMoveUp',              label: 'PTZ Move Up',            p: ['Input'] },
    { fn: 'PTZMoveDown',            label: 'PTZ Move Down',          p: ['Input'] },
    { fn: 'PTZMoveLeft',            label: 'PTZ Move Left',          p: ['Input'] },
    { fn: 'PTZMoveRight',           label: 'PTZ Move Right',         p: ['Input'] },
    { fn: 'PTZMoveUpLeft',          label: 'PTZ Move Up-Left',       p: ['Input'] },
    { fn: 'PTZMoveUpRight',         label: 'PTZ Move Up-Right',      p: ['Input'] },
    { fn: 'PTZMoveDownLeft',        label: 'PTZ Move Down-Left',     p: ['Input'] },
    { fn: 'PTZMoveDownRight',       label: 'PTZ Move Down-Right',    p: ['Input'] },
    { fn: 'PTZZoomIn',              label: 'PTZ Zoom In',            p: ['Input'] },
    { fn: 'PTZZoomOut',             label: 'PTZ Zoom Out',           p: ['Input'] },
    { fn: 'PTZFocusFar',            label: 'PTZ Focus Far',          p: ['Input'] },
    { fn: 'PTZFocusNear',           label: 'PTZ Focus Near',         p: ['Input'] },
    { fn: 'PTZAutoFocus',           label: 'PTZ Auto Focus',         p: ['Input'] },
    { fn: 'PTZHome',                label: 'PTZ Home',               p: ['Input'] },
    { fn: 'PTZMoveToVirtualInput',  label: 'PTZ Move To Virtual',    p: ['Input', 'Value'] },
    { fn: 'PTZCreateVirtualInput',  label: 'PTZ Create Virtual',     p: ['Input'] },
  ]},
  { group: 'Replay', fns: [
    { fn: 'ReplayStartRecording',   label: 'Replay Start Recording', p: [] },
    { fn: 'ReplayStopRecording',    label: 'Replay Stop Recording',  p: [] },
    { fn: 'ReplayMarkIn',           label: 'Replay Mark In',         p: [] },
    { fn: 'ReplayMarkOut',          label: 'Replay Mark Out',        p: [] },
    { fn: 'ReplayMarkInLive',       label: 'Replay Mark In (Live)',  p: [] },
    { fn: 'ReplayMarkOutLive',      label: 'Replay Mark Out (Live)', p: [] },
    { fn: 'ReplayLastEvent',        label: 'Replay Last Event',      p: [] },
    { fn: 'ReplayLastEventSinglePlay', label: 'Replay Last (Single)', p: [] },
    { fn: 'ReplayLive',             label: 'Replay Live',            p: [] },
    { fn: 'ReplayPlayPause',        label: 'Replay Play/Pause',      p: [] },
    { fn: 'ReplayPlay',             label: 'Replay Play',            p: [] },
    { fn: 'ReplayPause',            label: 'Replay Pause',           p: [] },
    { fn: 'ReplayJumpToNow',        label: 'Replay Jump To Now',     p: [] },
    { fn: 'ReplayFastForward',      label: 'Replay Fast Forward',    p: [] },
    { fn: 'ReplayFastBackward',     label: 'Replay Fast Backward',   p: [] },
    { fn: 'ReplaySetPlaybackSpeed', label: 'Replay Set Speed',       p: ['Value'] },
    { fn: 'ReplayACamera1',         label: 'Replay A: Camera 1',     p: [] },
    { fn: 'ReplayACamera2',         label: 'Replay A: Camera 2',     p: [] },
    { fn: 'ReplayACamera3',         label: 'Replay A: Camera 3',     p: [] },
    { fn: 'ReplayACamera4',         label: 'Replay A: Camera 4',     p: [] },
    { fn: 'ReplayBCamera1',         label: 'Replay B: Camera 1',     p: [] },
    { fn: 'ReplayBCamera2',         label: 'Replay B: Camera 2',     p: [] },
    { fn: 'ReplayBCamera3',         label: 'Replay B: Camera 3',     p: [] },
    { fn: 'ReplayBCamera4',         label: 'Replay B: Camera 4',     p: [] },
    { fn: 'ReplayChannelAOutput1',  label: 'Replay Output A',        p: [] },
    { fn: 'ReplayChannelBOutput2',  label: 'Replay Output B',        p: [] },
    { fn: 'ReplaySelectFeedA',      label: 'Replay Select Feed A',   p: [] },
    { fn: 'ReplaySelectFeedB',      label: 'Replay Select Feed B',   p: [] },
    { fn: 'ReplaySelectFeedFull',   label: 'Replay Select Full',     p: [] },
  ]},
  { group: 'Script / System', fns: [
    { fn: 'ScriptStart',            label: 'Script Start',           p: ['Value'] },
    { fn: 'ScriptStop',             label: 'Script Stop',            p: ['Value'] },
    { fn: 'ScriptStopAll',          label: 'Script Stop All',        p: [] },
    { fn: 'KeyPress',               label: 'Key Press',              p: ['Value'] },
    { fn: 'SavePreset',             label: 'Save Preset',            p: ['Value'] },
    { fn: 'OpenPreset',             label: 'Open Preset',            p: ['Value'] },
    { fn: 'LastPreset',             label: 'Last Preset',            p: [] },
    { fn: 'Snapshot',               label: 'Snapshot',               p: [] },
    { fn: 'SnapshotInput',          label: 'Snapshot Input',         p: ['Input'] },
    { fn: 'FullscreenOn',           label: 'Fullscreen On',          p: [] },
    { fn: 'FullscreenOff',          label: 'Fullscreen Off',         p: [] },
    { fn: 'Fullscreen',             label: 'Fullscreen Toggle',      p: [] },
  ]},
  { group: 'MultiView', fns: [
    { fn: 'MultiViewOverlay',       label: 'MultiView Overlay Toggle', p: ['Input', 'Value'] },
    { fn: 'MultiViewOverlayOn',     label: 'MultiView Overlay On',     p: ['Input', 'Value'] },
    { fn: 'MultiViewOverlayOff',    label: 'MultiView Overlay Off',    p: ['Input', 'Value'] },
    { fn: 'SetMultiViewOverlay',    label: 'Set MultiView Overlay',    p: ['Input', 'Value'] },
  ]},
  { group: 'Custom', fns: [
    { fn: '__custom__',             label: 'Custom…',                p: [] },
  ]},
];

const VMIX_ALL_FNS = VMIX_FUNCTIONS.flatMap(g => g.fns);

const SCORE_STYLES = [
  { value: 'basic',         label: 'Basic',              increments: [1,2,5,10] },
  { value: 'basketball',    label: 'Basketball',          increments: [1,2,3] },
  { value: 'football',      label: 'American Football',   increments: [1,2,3,6,7] },
  { value: 'soccer',        label: 'Soccer',              increments: [1] },
  { value: 'rugby-union',   label: 'Rugby Union',         increments: RUGBY_UNION_INCS },
  { value: 'rugby-league',  label: 'Rugby League',        increments: RUGBY_LEAGUE_INCS },
];

export function InputPickerDropdown({ currentKey, currentTitle, allInputs, onSelect, filter }: {
  currentKey: string;
  currentTitle: string | undefined;
  allInputs: VmixInput[];
  onSelect: (key: string, title: string) => void;
  filter?: (i: VmixInput) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const inTrigger = triggerRef.current?.contains(e.target as Node);
      const inDropdown = dropdownRef.current?.contains(e.target as Node);
      if (!inTrigger && !inDropdown) { setOpen(false); setSearch(''); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 3, left: r.left, width: r.width });
    }
    setOpen(o => !o);
  };

  const opts = filter ? allInputs.filter(filter) : allInputs;
  const filtered = search
    ? opts.filter(i =>
        i.title.toLowerCase().includes(search.toLowerCase()) ||
        String(i.number).includes(search)
      )
    : opts;
  const selected = allInputs.find(i => i.key === currentKey);
  const displayTitle = currentTitle || selected?.title || '';

  return (
    <div className="cfg-inp-picker" ref={triggerRef}>
      <div className={`cfg-inp-picker-display ${open ? 'cfg-inp-picker-display--open' : ''}`}
        onClick={toggle}>
        {currentKey ? (
          <>
            {selected && <span className="cfg-inp-picker-num">{selected.number}</span>}
            <span className="cfg-inp-picker-display-title">{displayTitle || currentKey}</span>
            {selected && <span className={`cfg-inp-picker-tag input-type-tag input-type-tag--${selected.type?.toLowerCase()}`}>{INPUT_TYPE_LABELS[selected.type] ?? selected.type}</span>}
          </>
        ) : (
          <span className="cfg-inp-picker-placeholder">— select input —</span>
        )}
        <span className="cfg-inp-picker-chevron">{open ? '▲' : '▼'}</span>
        {currentKey && (
          <span className="cfg-inp-picker-clear" onClick={e => { e.stopPropagation(); onSelect('', ''); setOpen(false); }}>×</span>
        )}
      </div>
      {open && pos && createPortal(
        <div className="cfg-inp-picker-dropdown" ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}>
          <input className="cfg-inp-picker-search" placeholder="Search…" autoFocus
            value={search} onChange={e => setSearch(e.target.value)}
            onClick={e => e.stopPropagation()} />
          <ul className="cfg-inp-picker-list">
            {filtered.length === 0
              ? <li className="cfg-inp-picker-empty">No inputs</li>
              : filtered.map(inp => (
                <li key={inp.key}
                  className={`cfg-inp-picker-item${inp.key === currentKey ? ' cfg-inp-picker-item--selected' : ''}`}
                  onClick={() => { onSelect(inp.key, inp.title); setOpen(false); setSearch(''); }}>
                  <span className="cfg-inp-picker-num">{inp.number}</span>
                  <span className="cfg-inp-picker-item-title">{inp.title || `Input ${inp.number}`}</span>
                  <span className={`cfg-inp-picker-tag input-type-tag input-type-tag--${inp.type?.toLowerCase()}`}>{INPUT_TYPE_LABELS[inp.type] ?? inp.type}</span>
                </li>
              ))
            }
          </ul>
        </div>,
        document.body
      )}
    </div>
  );
}

function FieldPickerDropdown({ inputKey, value, onChange, placeholder = 'Field.Text', fieldFilter, allInputs }: {
  inputKey: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  fieldFilter?: (name: string) => boolean;
  allInputs: VmixInput[];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const inp = allInputs.find(i => i.key === inputKey);
  const allFields = inp?.textFields ?? [];
  const fields = fieldFilter ? allFields.filter(f => fieldFilter(f.name)) : allFields;
  const filtered = search ? fields.filter(f => f.name.toLowerCase().includes(search.toLowerCase())) : fields;
  const currentVal = value ? allFields.find(f => f.name === value)?.value : undefined;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const inTrigger = triggerRef.current?.contains(e.target as Node);
      const inDropdown = dropdownRef.current?.contains(e.target as Node);
      if (!inTrigger && !inDropdown) {
        if (search && search !== value) onChange(search);
        setOpen(false); setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, search, value, onChange]);

  const toggle = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 3, left: r.left, width: r.width });
    }
    setSearch(value);
    setOpen(o => !o);
  };

  return (
    <div className="cfg-field-picker" ref={triggerRef}>
      <div className={`cfg-inp-picker-display ${open ? 'cfg-inp-picker-display--open' : ''}`}
        onClick={toggle}>
        {value
          ? <span className="cfg-inp-picker-display-title">{value}</span>
          : <span className="cfg-inp-picker-placeholder">{placeholder}</span>
        }
        <span className="cfg-inp-picker-chevron">{open ? '▲' : '▼'}</span>
        {value && <span className="cfg-inp-picker-clear" onClick={e => { e.stopPropagation(); onChange(''); setOpen(false); }}>×</span>}
      </div>
      {currentVal !== undefined && currentVal !== '' && !open && (
        <div className="field-picker-annotation">{currentVal}</div>
      )}
      {open && pos && createPortal(
        <div className="cfg-inp-picker-dropdown" ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}>
          <input className="cfg-inp-picker-search" placeholder="Type or search field…" autoFocus
            value={search} onChange={e => setSearch(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter') { if (search) onChange(search); setOpen(false); setSearch(''); }
              if (e.key === 'Escape') { setOpen(false); setSearch(''); }
            }} />
          <ul className="cfg-inp-picker-list">
            {filtered.length === 0 && !search && <li className="cfg-inp-picker-empty">No fields available</li>}
            {filtered.length === 0 && search && (
              <li className="cfg-inp-picker-item" onClick={() => { onChange(search); setOpen(false); setSearch(''); }}>
                <span className="cfg-inp-picker-display-title" style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>Use "{search}"</span>
              </li>
            )}
            {filtered.map(f => (
              <li key={f.name}
                className={`cfg-inp-picker-item${f.name === value ? ' cfg-inp-picker-item--selected' : ''}`}
                onClick={() => { onChange(f.name); setOpen(false); setSearch(''); }}>
                <span className="cfg-inp-picker-item-title">{f.name}</span>
                {f.value !== '' && <span className="cfg-inp-picker-field-val">{f.value}</span>}
              </li>
            ))}
          </ul>
        </div>,
        document.body
      )}
    </div>
  );
}

interface Props {
  widget: CanvasWidget;
  onClose: () => void;
  pagesOverride?: import('../types/canvas').CanvasPage[];
  actionsOverride?: {
    updateWidgetConfig: (id: string, patch: Record<string, any>) => void;
    updateWidget: (id: string, patch: Partial<CanvasWidget>) => void;
    deleteWidget: (id: string) => void;
    duplicateWidget: (id: string) => void;
    selectWidget: (id: string | null) => void;
  };
}

function CollapsibleSection({ label, children, defaultOpen = true }: { label: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <div className="config-section-label config-section-label--toggle" onClick={() => setOpen(o => !o)}>
        <span>{label}</span>
        <span className="config-section-chevron">{open ? '▼' : '▶'}</span>
      </div>
      {open && <>{children}</>}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field-row">
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

const _panelPos = { x: -1, y: 56, w: 300, h: 480 };

export function WidgetConfigPanel({ widget, onClose, pagesOverride, actionsOverride }: Props) {
  const store = useCanvasStore();
  const updateWidgetConfig = actionsOverride?.updateWidgetConfig ?? store.updateWidgetConfig;
  const updateWidget = actionsOverride?.updateWidget ?? store.updateWidget;
  const duplicateWidget = actionsOverride?.duplicateWidget ?? store.duplicateWidget;
  const deleteWidget = actionsOverride?.deleteWidget ?? store.deleteWidget;
  const selectWidget = actionsOverride?.selectWidget ?? store.selectWidget;
  const pages = pagesOverride ? [...store.pages, ...pagesOverride] : store.pages;
  const { vmixState, globalVariables, getClient } = useVmixStore();
  const { tournaments } = useTournamentStore();
  const { teams: teamDbTeams } = useTeamDbStore();
  const { results: savedMatchResults, clearResults: clearMatchResults } = useMatchResultsStore();
  const cfg = widget.config;
  const up = (patch: Record<string, any>) => updateWidgetConfig(widget.id, patch);
  const [panelExpandedId, setPanelExpandedId] = useState<string | null>(null);
  const [durationText, setDurationText] = useState(() =>
    msToFormatStr(cfg.durationMs ?? 0, cfg.format ?? 'mm:ss')
  );
  useEffect(() => {
    setDurationText(msToFormatStr(cfg.durationMs ?? 0, cfg.format ?? 'mm:ss'));
  }, [cfg.durationMs, cfg.format]);

  const [breakText, setBreakText] = useState(() =>
    msToFormatStr(cfg.breakDurationMs ?? 0, cfg.format ?? 'mm:ss')
  );
  useEffect(() => {
    setBreakText(msToFormatStr(cfg.breakDurationMs ?? 0, cfg.format ?? 'mm:ss'));
  }, [cfg.breakDurationMs, cfg.format]);

  const [finalPlayDurationText, setFinalPlayDurationText] = useState(() =>
    msToFormatStr(cfg.finalPlayDurationMs ?? 0, cfg.format ?? 'mm:ss')
  );
  useEffect(() => {
    setFinalPlayDurationText(msToFormatStr(cfg.finalPlayDurationMs ?? 0, cfg.format ?? 'mm:ss'));
  }, [cfg.finalPlayDurationMs, cfg.format]);
  const allInputs = vmixState?.inputs ?? [];

  const [vtCollapsed, setVTCollapsed] = useState<Record<string, boolean>>({});
  const [tfCollapsed, setTFCollapsed] = useState<Record<number, boolean>>({});
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; w: number; h: number }>(() => {
    if (_panelPos.x < 0) _panelPos.x = Math.max(0, window.innerWidth - _panelPos.w - 16);
    return { ..._panelPos };
  });
  const updatePos = (patch: Partial<typeof pos>) => {
    const next = { ...pos, ...patch };
    Object.assign(_panelPos, next);
    setPos(next);
  };
  const panelDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const panelResizeXRef = useRef<{ sx: number; ow: number } | null>(null);
  const panelResizeBRRef = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null);
  const onPanelDragDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    panelDragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPanelDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panelDragRef.current) return;
    const x = Math.max(0, Math.min(window.innerWidth - 80, panelDragRef.current.ox + e.clientX - panelDragRef.current.sx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, panelDragRef.current.oy + e.clientY - panelDragRef.current.sy));
    updatePos({ x, y });
  };
  const onPanelDragUp = () => { panelDragRef.current = null; };
  const onResizeXDown = (e: React.PointerEvent<HTMLDivElement>) => {
    panelResizeXRef.current = { sx: e.clientX, ow: pos.w };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation(); e.preventDefault();
  };
  const onResizeXMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panelResizeXRef.current) return;
    updatePos({ w: Math.max(240, Math.min(700, panelResizeXRef.current.ow + e.clientX - panelResizeXRef.current.sx)) });
  };
  const onResizeXUp = () => { panelResizeXRef.current = null; };
  const onResizeBRDown = (e: React.PointerEvent<HTMLDivElement>) => {
    panelResizeBRRef.current = { sx: e.clientX, sy: e.clientY, ow: pos.w, oh: pos.h };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation(); e.preventDefault();
  };
  const onResizeBRMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panelResizeBRRef.current) return;
    const w = Math.max(240, Math.min(700, panelResizeBRRef.current.ow + e.clientX - panelResizeBRRef.current.sx));
    const h = Math.max(120, Math.min(window.innerHeight - 40, panelResizeBRRef.current.oh + e.clientY - panelResizeBRRef.current.sy));
    updatePos({ w, h });
  };
  const onResizeBRUp = () => { panelResizeBRRef.current = null; };
  const [adjNewLabel, setAdjNewLabel] = useState('');
  const [adjNewSeconds, setAdjNewSeconds] = useState('10');
  const [vilCollapsed, setVilCollapsed] = useState<Record<string, boolean>>({});

  const renderInputPicker = (
    label: string,
    currentKey: string,
    currentTitle: string | undefined,
    onSelect: (key: string, title: string) => void,
    filter?: (i: VmixInput) => boolean,
    inputs?: typeof allInputs,
  ) => (
    <Field label={label}>
      <InputPickerDropdown
        currentKey={currentKey}
        currentTitle={currentTitle}
        allInputs={inputs ?? allInputs}
        onSelect={onSelect}
        filter={filter}
      />
    </Field>
  );

  const renderFieldPicker = (inputKey: string, value: string, onChange: (v: string) => void, placeholder = 'Field.Text', fieldFilter?: (name: string) => boolean, inputs?: typeof allInputs) => (
    <FieldPickerDropdown inputKey={inputKey} value={value} onChange={onChange} placeholder={placeholder} fieldFilter={fieldFilter} allInputs={inputs ?? allInputs} />
  );

  const renderConfig = () => {
    switch (widget.type) {

      case 'button': {
        type ActionItem = { fn: string; params: Record<string, string> };
        type SideButton = { id: string; label: string; color?: string; textColor?: string; fontSize?: number; mode?: string; actions: ActionItem[]; releaseActions?: ActionItem[] };
        const timerWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'timer'));
        const scoreboardWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'scoreboard'));

        // Migrate legacy single-function format
        const pressActions: ActionItem[] = cfg.actions ?? (cfg.function ? [{ fn: cfg.function, params: cfg.params ?? {} }] : [{ fn: 'Cut', params: {} }]);
        const releaseActions: ActionItem[] = cfg.releaseActions ?? (cfg.releaseFunction ? [{ fn: cfg.releaseFunction, params: cfg.releaseParams ?? {} }] : []);

        const savePress = (next: ActionItem[]) => up({ actions: next });
        const saveRelease = (next: ActionItem[]) => up({ releaseActions: next });

        // Renders the function editor for one action item — called as a function, not a component
        const renderFnEditor = (
          action: ActionItem,
          setFn: (fn: string) => void,
          setParam: (k: string, v: string) => void,
          idxKey: string,
        ) => {
          const { fn, params } = action;
          const isApp = fn.startsWith('App.');
          const vmixDef = VMIX_ALL_FNS.find(f => f.fn === fn);
          const isCustomVmix = !isApp && !vmixDef;
          const vmixSelectVal = vmixDef ? fn : '__custom__';

          return (
            <div key={idxKey} className="action-editor">
              <Field label="Type">
                <select className="field-input" value={isApp ? 'app' : 'vmix'} onChange={e => {
                  if (e.target.value === 'app') setFn('App.GoToPage');
                  else setFn('Cut');
                }}>
                  <option value="vmix">vMix Function</option>
                  <option value="app">App Function</option>
                </select>
              </Field>

              {isApp ? (
                <>
                  <Field label="App Function">
                    <select className="field-input" value={fn} onChange={e => setFn(e.target.value)}>
                      <optgroup label="Navigation">
                        <option value="App.GoToPage">Go To Page</option>
                      </optgroup>
                      <optgroup label="Timer">
                        <option value="App.TimerStart">Timer: Start</option>
                        <option value="App.TimerPause">Timer: Pause</option>
                        <option value="App.TimerToggle">Timer: Toggle Start/Pause</option>
                        <option value="App.TimerReset">Timer: Reset</option>
                        <option value="App.TimerEndPeriod">Timer: End Period</option>
                        <option value="App.TimerSkipBreak">Timer: Skip Break</option>
                      </optgroup>
                      <optgroup label="Scoreboard">
                        <option value="App.ScoreA">Score: Add Team A</option>
                        <option value="App.ScoreB">Score: Add Team B</option>
                        <option value="App.ScoreReset">Score: Reset</option>
                      </optgroup>
                      <optgroup label="Variable">
                        <option value="App.SetVariable">Set Variable</option>
                      </optgroup>
                      <optgroup label="App">
                        <option value="App.ToggleEditMode">Toggle Edit Mode</option>
                      </optgroup>
                    </select>
                  </Field>
                  {fn === 'App.GoToPage' && (
                    <Field label="Page">
                      <select className="field-input" value={params.Page ?? ''} onChange={e => setParam('Page', e.target.value)}>
                        <option value="">— select page —</option>
                        {pages.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                      </select>
                    </Field>
                  )}
                  {['App.TimerStart','App.TimerPause','App.TimerReset','App.TimerToggle','App.TimerEndPeriod','App.TimerSkipBreak'].includes(fn) && (
                    <Field label="Timer Widget">
                      <select className="field-input" value={params.Input ?? ''} onChange={e => setParam('Input', e.target.value)}>
                        <option value="">— select timer —</option>
                        {timerWidgets.map(w => <option key={w.id} value={w.id}>{w.config.name || 'Timer'}</option>)}
                      </select>
                    </Field>
                  )}
                  {(fn === 'App.ScoreReset') && (
                    <Field label="Scoreboard Widget">
                      <select className="field-input" value={params.Input ?? ''} onChange={e => setParam('Input', e.target.value)}>
                        <option value="">— select scoreboard —</option>
                        {scoreboardWidgets.map(w => <option key={w.id} value={w.id}>{w.config.teamAName} vs {w.config.teamBName}</option>)}
                      </select>
                    </Field>
                  )}
                  {(fn === 'App.ScoreA' || fn === 'App.ScoreB') && (
                    <>
                      <Field label="Scoreboard Widget">
                        <select className="field-input" value={params.Input ?? ''} onChange={e => setParam('Input', e.target.value)}>
                          <option value="">— select scoreboard —</option>
                          {scoreboardWidgets.map(w => <option key={w.id} value={w.id}>{w.config.teamAName} vs {w.config.teamBName}</option>)}
                        </select>
                      </Field>
                      <Field label="Points">
                        <input className="field-input" type="number" min={1} value={params.Value ?? '1'} onChange={e => setParam('Value', e.target.value)} />
                      </Field>
                      <Field label="Label (e.g. Try)">
                        <input className="field-input" value={params.Label ?? ''} placeholder="Try, Conv, Pen…" onChange={e => setParam('Label', e.target.value)} />
                      </Field>
                    </>
                  )}
                  {fn === 'App.SetVariable' && (
                    <>
                      <Field label="Variable">
                        <select className="field-input" value={params.Variable ?? ''} onChange={e => setParam('Variable', e.target.value)}>
                          <option value="">— select variable —</option>
                          {globalVariables.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                        </select>
                      </Field>
                      <Field label="Value">
                        <input className="field-input" value={params.Value ?? ''} onChange={e => setParam('Value', e.target.value)} />
                      </Field>
                    </>
                  )}
                </>
              ) : (
                <>
                  <Field label="vMix Function">
                    <select className="field-input" value={vmixSelectVal} onChange={e => {
                      if (e.target.value === '__custom__') setFn('');
                      else setFn(e.target.value);
                    }}>
                      {VMIX_FUNCTIONS.map(g => (
                        <optgroup key={g.group} label={g.group}>
                          {g.fns.map(f => <option key={f.fn} value={f.fn}>{f.label}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </Field>
                  {isCustomVmix && (
                    <Field label="Custom Function">
                      <input className="field-input" value={fn} onChange={e => setFn(e.target.value)} placeholder="e.g. SetFader" />
                    </Field>
                  )}
                  {vmixDef && vmixDef.p.map(pk => pk === 'Input' ? (
                    <Field key={pk} label="Input">
                      <InputPickerDropdown
                        currentKey={params.Input ?? ''}
                        currentTitle={allInputs.find(i => i.key === (params.Input ?? ''))?.title}
                        allInputs={allInputs}
                        onSelect={(key) => setParam('Input', key)}
                      />
                    </Field>
                  ) : (
                    <Field key={pk} label={pk}>
                      <input className="field-input" value={params[pk] ?? ''} onChange={e => setParam(pk, e.target.value)} />
                    </Field>
                  ))}
                  {isCustomVmix && (
                    <Field label="Params (Key=Value)">
                      <textarea className="field-input" rows={3}
                        value={Object.entries(params).map(([k,v]) => `${k}=${v}`).join('\n')}
                        onChange={e => {
                          const p: Record<string,string> = {};
                          e.target.value.split('\n').forEach(line => {
                            const [k,...rest] = line.split('=');
                            if (k?.trim()) p[k.trim()] = rest.join('=').trim();
                          });
                          setParam('__bulk__', JSON.stringify(p));
                        }} placeholder="Input=1&#10;Value=Hello" />
                    </Field>
                  )}
                </>
              )}
            </div>
          );
        };

        const renderActionList = (actions: ActionItem[], save: (next: ActionItem[]) => void, sectionKey: string) => (
          <>
            {actions.map((action, i) => (
              <div key={`${sectionKey}-${i}`} className="action-row">
                <div className="action-row-header">
                  <span className="action-row-num">#{i + 1}</span>
                  <button className="action-row-del" title="Remove" onClick={() => save(actions.filter((_, j) => j !== i))}>×</button>
                </div>
                {renderFnEditor(
                  action,
                  (fn) => save(actions.map((a, j) => j === i ? { fn, params: {} } : a)),
                  (k, v) => {
                    if (k === '__bulk__') {
                      save(actions.map((a, j) => j === i ? { ...a, params: JSON.parse(v) } : a));
                    } else {
                      save(actions.map((a, j) => j === i ? { ...a, params: { ...a.params, [k]: v } } : a));
                    }
                  },
                  `${sectionKey}-${i}`,
                )}
              </div>
            ))}
            <button className="action-add-btn" onClick={() => save([...actions, { fn: 'Cut', params: {} }])}>
              + Add Action
            </button>
          </>
        );

        return (
          <>
            <Field label="Label">
              <input className="field-input" value={cfg.label ?? ''} onChange={e => up({ label: e.target.value })} />
            </Field>
            <Field label="Mode">
              <select className="field-input" value={cfg.mode ?? 'momentary'} onChange={e => up({ mode: e.target.value })}>
                <option value="momentary">Momentary</option>
                <option value="toggle">Toggle</option>
              </select>
            </Field>

            <CollapsibleSection label="Press Actions">
              {renderActionList(pressActions, savePress, 'press')}
            </CollapsibleSection>

            <CollapsibleSection label="Release Actions">
              {renderActionList(releaseActions, saveRelease, 'release')}
            </CollapsibleSection>

            <CollapsibleSection label="Side Buttons">
              {(() => {
                const sideButtons: SideButton[] = cfg.sideButtons ?? [];
                const updateSb = (i: number, patch: Partial<SideButton>) =>
                  up({ sideButtons: sideButtons.map((sb, j) => j === i ? { ...sb, ...patch } : sb) });
                return (
                  <>
                    {sideButtons.map((sb, i) => {
                      const isCollapsed = vilCollapsed[`sb-${sb.id}`] ?? false;
                      return (
                        <div key={sb.id} className="vil-cfg-block">
                          <div className="vil-cfg-header">
                            <button className="btn btn--ghost btn--small tf-collapse-btn"
                              onClick={() => setVilCollapsed(p => ({ ...p, [`sb-${sb.id}`]: !p[`sb-${sb.id}`] }))}>
                              {isCollapsed ? '▶' : '▼'}
                            </button>
                            <span className="vil-cfg-label">{sb.label || `Button ${i + 1}`}</span>
                            <button className="btn btn--ghost btn--small"
                              onClick={() => up({ sideButtons: sideButtons.filter((_, j) => j !== i) })}>×</button>
                          </div>
                          {!isCollapsed && (
                            <>
                              <Field label="Label">
                                <input className="field-input" value={sb.label} onChange={e => updateSb(i, { label: e.target.value })} />
                              </Field>
                              <Field label="Mode">
                                <select className="field-input" value={sb.mode ?? 'momentary'} onChange={e => updateSb(i, { mode: e.target.value })}>
                                  <option value="momentary">Momentary</option>
                                  <option value="toggle">Toggle</option>
                                </select>
                              </Field>
                              <Field label="Color">
                                <div className="color-picker">
                                  {PRESET_COLORS.map(c => (
                                    <button key={c} className={`color-swatch ${sb.color === c ? 'color-swatch--selected' : ''}`}
                                      style={{ background: c }} onClick={() => updateSb(i, { color: c })} />
                                  ))}
                                  <input type="color" className="color-custom" value={sb.color ?? '#555555'} onChange={e => updateSb(i, { color: e.target.value })} />
                                </div>
                              </Field>
                              <Field label="Font Size">
                                <input className="field-input" type="number" min={8} max={32} value={sb.fontSize ?? 11} onChange={e => updateSb(i, { fontSize: Number(e.target.value) })} />
                              </Field>
                              <CollapsibleSection label="Press Actions">
                                {renderActionList(sb.actions ?? [], (next) => updateSb(i, { actions: next }), `sb-${i}-press`)}
                              </CollapsibleSection>
                              <CollapsibleSection label="Release Actions">
                                {renderActionList(sb.releaseActions ?? [], (next) => updateSb(i, { releaseActions: next }), `sb-${i}-release`)}
                              </CollapsibleSection>
                            </>
                          )}
                        </div>
                      );
                    })}
                    <button className="action-add-btn"
                      onClick={() => up({ sideButtons: [...sideButtons, { id: crypto.randomUUID(), label: 'Button', color: '#555555', mode: 'momentary', actions: [] }] })}>
                      + Add Side Button
                    </button>
                  </>
                );
              })()}
            </CollapsibleSection>

            <CollapsibleSection label="Appearance">
              <Field label="Color">
                <div className="color-picker">
                  {PRESET_COLORS.map(c => (
                    <button key={c} className={`color-swatch ${cfg.color === c ? 'color-swatch--selected' : ''}`} style={{ background: c }} onClick={() => up({ color: c })} />
                  ))}
                  <input type="color" className="color-custom" value={cfg.color ?? '#3498db'} onChange={e => up({ color: e.target.value })} />
                </div>
              </Field>
              <Field label="Text Color">
                <div className="color-picker">
                  {['#ffffff','#000000','#f1c40f','#e74c3c'].map(c => (
                    <button key={c} className={`color-swatch ${cfg.textColor === c ? 'color-swatch--selected' : ''}`} style={{ background: c }} onClick={() => up({ textColor: c })} />
                  ))}
                </div>
              </Field>
              <Field label="Font Size">
                <input className="field-input" type="number" min={8} max={48} value={cfg.fontSize ?? 14} onChange={e => up({ fontSize: Number(e.target.value) })} />
              </Field>
              <Field label="Tally Input (optional)">
                <InputPickerDropdown
                  currentKey={cfg.tallyInputKey ?? ''}
                  currentTitle={allInputs.find(i => i.key === cfg.tallyInputKey)?.title}
                  allInputs={allInputs}
                  onSelect={(key) => up({ tallyInputKey: key || undefined })}
                />
              </Field>
              <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '2px 0 0' }}>
                Auto-detected from press actions if not set. Shows PGM / OVL / PRV state.
              </p>
            </CollapsibleSection>
          </>
        );
      }

      case 'title-field': {
        // Normalise legacy single-input format
        type TFEntry = string | { name: string; type: 'source' };
        type TFGroup = { inputKey: string; inputTitle?: string; name?: string; fields: TFEntry[] };
        const tfFName = (f: TFEntry) => typeof f === 'string' ? f : f.name;
        const tfFType = (f: TFEntry): 'text' | 'source' => typeof f === 'string' ? 'text' : (f.type ?? 'text');
        const groups: TFGroup[] = cfg.inputs ?? (
          cfg.inputKey
            ? [{ inputKey: cfg.inputKey, inputTitle: cfg.inputTitle, fields: cfg.fields ?? [cfg.fieldName ?? 'Title.Text'] }]
            : [{ inputKey: '', fields: ['Title.Text'] }]
        );

        const setGroups = (next: TFGroup[]) => up({ inputs: next, inputKey: undefined, fields: undefined, fieldName: undefined });
        const updateGroup = (gi: number, patch: Partial<TFGroup>) => {
          const next = groups.map((g, i) => i === gi ? { ...g, ...patch } : g);
          setGroups(next);
        };

        return (
          <>
            <Field label="Display Label">
              <input className="field-input" value={cfg.label ?? ''} onChange={e => up({ label: e.target.value })} />
            </Field>

            <div className="tf-autosend-row">
              <label className="tf-autosend-label">
                <input
                  type="checkbox"
                  checked={cfg.autoSend ?? false}
                  onChange={e => up({ autoSend: e.target.checked })}
                />
                Auto-send while typing
              </label>
              {cfg.autoSend && (
                <div className="tf-autosend-delay">
                  <span className="field-label">Delay (ms)</span>
                  <input
                    className="field-input"
                    type="number"
                    min={0}
                    max={2000}
                    step={100}
                    value={cfg.autoSendDelayMs ?? 400}
                    onChange={e => up({ autoSendDelayMs: Number(e.target.value) })}
                    style={{ width: 90 }}
                  />
                </div>
              )}
            </div>

            {groups.map((grp, gi) => {
              const isCollapsed = tfCollapsed[gi] ?? false;
              return (
                <div key={gi} className="tf-group-block">
                  <div className="tf-group-header">
                    <button
                      className="btn btn--ghost btn--small tf-collapse-btn"
                      onClick={() => setTFCollapsed(prev => ({ ...prev, [gi]: !prev[gi] }))}
                      title={isCollapsed ? 'Expand' : 'Collapse'}>
                      {isCollapsed ? '▶' : '▼'}
                    </button>
                    <input
                      className="tf-group-name-input"
                      value={grp.name ?? ''}
                      placeholder={`Title Field Input ${gi + 1}`}
                      onChange={e => updateGroup(gi, { name: e.target.value })}
                    />
                    {groups.length > 1 && (
                      <button className="btn btn--ghost btn--small tf-field-del"
                        onClick={() => setGroups(groups.filter((_, i) => i !== gi))}>×</button>
                    )}
                  </div>

                  {!isCollapsed && (<>
                    {renderInputPicker(
                      'vMix Input',
                      grp.inputKey,
                      grp.inputTitle,
                      (key, title) => {
                        const inp = allInputs.find(i => i.key === key);
                        updateGroup(gi, {
                          inputKey: key,
                          inputTitle: title,
                          fields: inp?.textFields?.length ? inp.textFields.map((f: { name: string }) => f.name) : grp.fields,
                        });
                      },
                      undefined,
                      allInputs,
                    )}

                    {/* Field list */}
                    <div className="tf-fields-editor">
                      {grp.fields.map((f, fi) => (
                        <div key={fi} className="tf-field-row">
                          <FieldPickerDropdown
                            inputKey={grp.inputKey}
                            value={tfFName(f)}
                            onChange={v => {
                              const next = [...grp.fields];
                              next[fi] = tfFType(f) === 'source' ? { name: v, type: 'source' } : v;
                              updateGroup(gi, { fields: next });
                            }}
                            placeholder="FieldName.Text"
                            allInputs={allInputs}
                          />
                          <button
                            className={`btn btn--small${tfFType(f) === 'source' ? '' : ' btn--ghost'}`}
                            title={tfFType(f) === 'source' ? 'Source (image) field — click to switch to Text' : 'Text field — click to switch to Source'}
                            style={{ minWidth: 22, padding: '0 4px', fontSize: 10 }}
                            onClick={() => {
                              const next = [...grp.fields];
                              const name = tfFName(f);
                              next[fi] = tfFType(f) === 'text' ? { name, type: 'source' } : name;
                              updateGroup(gi, { fields: next });
                            }}>
                            {tfFType(f) === 'source' ? 'S' : 'T'}
                          </button>
                          <button className="btn btn--ghost btn--small tf-field-del"
                            onClick={() => updateGroup(gi, { fields: grp.fields.filter((_, i) => i !== fi) })}
                            disabled={grp.fields.length === 1}>×</button>
                        </div>
                      ))}
                      <button className="btn btn--ghost btn--small" style={{ alignSelf: 'flex-start', marginTop: 2 }}
                        onClick={() => updateGroup(gi, { fields: [...grp.fields, ''] })}>
                        + Add Field
                      </button>
                    </div>
                  </>)}
                </div>
              );
            })}

            <button className="btn btn--ghost btn--small"
              onClick={() => setGroups([...groups, { inputKey: '', fields: ['Title.Text'] }])}>
              + Add vMix Input
            </button>
          </>
        );
      }

      case 'scoreboard': {
        const allScoreboardWidgets = pages.flatMap(p => p.widgets).filter(w => w.type === 'scoreboard' && w.id !== widget.id);
        return (
        <>
          <CollapsibleSection label="Link to Scoreboard">
            <Field label="Source Scoreboard">
              <select className="field-input" value={cfg.linkedScoreboardSourceId ?? ''} onChange={e => up({ linkedScoreboardSourceId: e.target.value })}>
                <option value="">— standalone (own scoreboard) —</option>
                {allScoreboardWidgets.map(w => (
                  <option key={w.id} value={w.id}>{w.label || w.config?.teamAName + ' vs ' + w.config?.teamBName || w.id}</option>
                ))}
              </select>
            </Field>
            {cfg.linkedScoreboardSourceId && (
              <p className="timer-db-hint">This widget mirrors the selected scoreboard. Controls are hidden — score from the source widget.</p>
            )}
          </CollapsibleSection>

          <CollapsibleSection label="Tournament Database">
            <Field label="Link Tournament">
              <select className="field-input" value={cfg.linkedTournamentId ?? ''} onChange={e => up({ linkedTournamentId: e.target.value })}>
                <option value="">— none (set automatically from Load Match) —</option>
                {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <p className="app-settings-hint" style={{ margin: '4px 0 0' }}>
              Tags "💾 Save Result" with this tournament so it shows up in its Results tab. Loading a fixture from the Schedule tab sets this automatically — only set it here for matches entered manually.
            </p>
          </CollapsibleSection>

          <CollapsibleSection label="Teams">
            <p className="app-settings-hint" style={{ margin: '0 0 6px' }}>
              Use the 👥 team picker on the scoreboard itself to pull from the Team DB, or edit directly here.
            </p>
              <Field label="Team A Name">
                <input className="field-input" value={cfg.teamAName ?? 'Team A'} onChange={e => up({ teamAName: e.target.value })} />
              </Field>
              <Field label="Team A Color">
                <input type="color" className="color-custom" value={cfg.teamAColor ?? '#e74c3c'} onChange={e => up({ teamAColor: e.target.value })} />
              </Field>
              <Field label="Team A Logo">
                <LogoUrlPicker value={cfg.teamALogo ?? ''} onChange={url => up({ teamALogo: url })} placeholder="Team A logo URL" />
              </Field>
              <Field label="Team B Name">
                <input className="field-input" value={cfg.teamBName ?? 'Team B'} onChange={e => up({ teamBName: e.target.value })} />
              </Field>
              <Field label="Team B Color">
                <input type="color" className="color-custom" value={cfg.teamBColor ?? '#3498db'} onChange={e => up({ teamBColor: e.target.value })} />
              </Field>
              <Field label="Team B Logo">
                <LogoUrlPicker value={cfg.teamBLogo ?? ''} onChange={url => up({ teamBLogo: url })} placeholder="Team B logo URL" />
              </Field>
          </CollapsibleSection>

          <CollapsibleSection label="Match Info">
            <Field label="Competition">
              <input className="field-input" value={cfg.competition ?? ''} placeholder="e.g. Premier League" onChange={e => up({ competition: e.target.value })} />
            </Field>
            <Field label="Round / Week">
              <input className="field-input" value={cfg.subtitle ?? ''} placeholder="e.g. Round 5" onChange={e => up({ subtitle: e.target.value })} />
            </Field>
          </CollapsibleSection>

          <CollapsibleSection label="Sport Style">
          <Field label="Style">
            <select className="field-input" value={cfg.style ?? 'basic'} onChange={e => {
              const found = SCORE_STYLES.find(s => s.value === e.target.value);
              up({ style: e.target.value, increments: found?.increments ?? [1] });
            }}>
              {SCORE_STYLES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          {/* ── Increment editor ── */}
          {(() => {
            type Inc = { label: string; value: number };
            const incs: Inc[] = (cfg.increments ?? [1]).map((i: number | { label?: string; value: number }) =>
              typeof i === 'number' ? { label: '', value: i } : { label: i.label ?? '', value: i.value }
            );
            const setIncs = (next: Inc[]) => up({ increments: next });
            const updateInc = (idx: number, patch: Partial<Inc>) =>
              setIncs(incs.map((inc, i) => i === idx ? { ...inc, ...patch } : inc));
            return (
              <div className="sb-incs">
                <div className="sb-incs-hdr">
                  <span className="sb-incs-col-lbl">Label</span>
                  <span className="sb-incs-col-val">Pts</span>
                </div>
                {incs.map((inc, idx) => (
                  <div key={idx} className="sb-inc-row">
                    <input
                      className="field-input sb-inc-label"
                      value={inc.label}
                      placeholder={`+${inc.value}`}
                      onChange={e => updateInc(idx, { label: e.target.value })}
                    />
                    <input
                      className="field-input sb-inc-value"
                      type="number"
                      value={inc.value}
                      onChange={e => updateInc(idx, { value: Number(e.target.value) })}
                    />
                    <button className="btn btn--ghost btn--small sb-inc-del" onClick={() => setIncs(incs.filter((_, i) => i !== idx))}>×</button>
                  </div>
                ))}
                <button className="btn btn--ghost btn--small" style={{ marginTop: 2 }} onClick={() => setIncs([...incs, { label: '', value: 1 }])}>+ Add</button>
              </div>
            );
          })()}
          <Field label="Score size (px)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={24} max={120} step={2} className="field-range"
                value={cfg.scoreFontSize ?? 36} onChange={e => up({ scoreFontSize: Number(e.target.value) })} />
              <span style={{ minWidth: 32, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{cfg.scoreFontSize ?? 36}px</span>
            </div>
          </Field>
          <Field label="Full name size (px)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={8} max={48} step={1} className="field-range"
                value={cfg.nameFontSize ?? 16} onChange={e => up({ nameFontSize: Number(e.target.value) })} />
              <span style={{ minWidth: 32, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{cfg.nameFontSize ?? 16}px</span>
            </div>
          </Field>
          <Field label="Short name size (px)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={8} max={48} step={1} className="field-range"
                value={cfg.shortNameFontSize ?? 14} onChange={e => up({ shortNameFontSize: Number(e.target.value) })} />
              <span style={{ minWidth: 32, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{cfg.shortNameFontSize ?? 14}px</span>
            </div>
          </Field>
          <Field label="Button size">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={0.5} max={2.5} step={0.05} className="field-range"
                value={cfg.buttonSize ?? 1} onChange={e => up({ buttonSize: Number(e.target.value) })} />
              <span style={{ minWidth: 36, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{Math.round((cfg.buttonSize ?? 1) * 100)}%</span>
            </div>
          </Field>
          </CollapsibleSection>

          {/* ── Multiple vMix Title Inputs ── */}
          {(() => {
            type SbInput = { id: string; inputKey: string; inputTitle?: string; fieldScoreA: string; fieldScoreB: string; fieldTeamA: string; fieldTeamB: string; fieldShortA: string; fieldShortB: string; fieldTextA: string; fieldTextB: string; fieldLogoA: string; fieldLogoB: string; fieldCompetition: string; fieldRound: string };
            // Migrate legacy single-input config on first open
            const sbInputs: SbInput[] = cfg.vmixInputs?.length
              ? cfg.vmixInputs
              : cfg.vmixInputKey
                ? [{ id: 'legacy', inputKey: cfg.vmixInputKey, inputTitle: cfg.vmixInputTitle, fieldScoreA: cfg.fieldScoreA ?? 'ScoreA.Text', fieldScoreB: cfg.fieldScoreB ?? 'ScoreB.Text', fieldTeamA: cfg.fieldTeamA ?? 'TeamA.Text', fieldTeamB: cfg.fieldTeamB ?? 'TeamB.Text', fieldShortA: cfg.fieldShortA ?? '', fieldShortB: cfg.fieldShortB ?? '', fieldTextA: cfg.fieldTextA ?? '', fieldTextB: cfg.fieldTextB ?? '', fieldLogoA: cfg.fieldLogoA ?? '', fieldLogoB: cfg.fieldLogoB ?? '', fieldCompetition: cfg.fieldCompetition ?? '', fieldRound: cfg.fieldRound ?? '' }]
                : [];
            const setSbInputs = (next: SbInput[]) => up({ vmixInputs: next });
            const updateSb = (idx: number, patch: Partial<SbInput>) =>
              setSbInputs(sbInputs.map((s, i) => i === idx ? { ...s, ...patch } : s));
            const addSbInput = () => setSbInputs([...sbInputs, { id: crypto.randomUUID(), inputKey: '', fieldScoreA: 'ScoreA.Text', fieldScoreB: 'ScoreB.Text', fieldTeamA: 'TeamA.Text', fieldTeamB: 'TeamB.Text', fieldShortA: '', fieldShortB: '', fieldTextA: '', fieldTextB: '', fieldLogoA: '', fieldLogoB: '', fieldCompetition: '', fieldRound: '' }]);

            return (
              <>
                {sbInputs.map((inp, idx) => {
                  const isVilCollapsed = vilCollapsed[inp.id] ?? false;
                  return (
                    <div key={inp.id} className="vil-cfg-block">
                      <div className="vil-cfg-header">
                        <button className="btn btn--ghost btn--small tf-collapse-btn"
                          onClick={() => setVilCollapsed(p => ({ ...p, [inp.id]: !p[inp.id] }))}
                          title={isVilCollapsed ? 'Expand' : 'Collapse'}>
                          {isVilCollapsed ? '▶' : '▼'}
                        </button>
                        <span className="vil-cfg-label">vMix Title Input {idx + 1}</span>
                        {sbInputs.length > 1 && (
                          <button className="btn btn--ghost btn--small"
                            onClick={() => setSbInputs(sbInputs.filter((_, i) => i !== idx))}>×</button>
                        )}
                      </div>
                      {!isVilCollapsed && (<>
                        {renderInputPicker('vMix Title Input', inp.inputKey, inp.inputTitle,
                          (key, title) => updateSb(idx, { inputKey: key, inputTitle: title }),
                          undefined, allInputs,
                        )}
                        {inp.inputKey && (
                          <>
                            <Field label="Score A Field">{renderFieldPicker(inp.inputKey, inp.fieldScoreA, v => updateSb(idx, { fieldScoreA: v }), 'ScoreA.Text', undefined, allInputs)}</Field>
                            <Field label="Score B Field">{renderFieldPicker(inp.inputKey, inp.fieldScoreB, v => updateSb(idx, { fieldScoreB: v }), 'ScoreB.Text', undefined, allInputs)}</Field>
                            <Field label="Team A Field">{renderFieldPicker(inp.inputKey, inp.fieldTeamA, v => updateSb(idx, { fieldTeamA: v }), 'TeamA.Text', undefined, allInputs)}</Field>
                            <Field label="Team B Field">{renderFieldPicker(inp.inputKey, inp.fieldTeamB, v => updateSb(idx, { fieldTeamB: v }), 'TeamB.Text', undefined, allInputs)}</Field>
                            <Field label="Short Name A Field">{renderFieldPicker(inp.inputKey, inp.fieldShortA ?? '', v => updateSb(idx, { fieldShortA: v }), 'ShortA.Text', undefined, allInputs)}</Field>
                            <Field label="Short Name B Field">{renderFieldPicker(inp.inputKey, inp.fieldShortB ?? '', v => updateSb(idx, { fieldShortB: v }), 'ShortB.Text', undefined, allInputs)}</Field>
                            <Field label="Competition Field">{renderFieldPicker(inp.inputKey, inp.fieldCompetition ?? '', v => updateSb(idx, { fieldCompetition: v }), 'Competition.Text', undefined, allInputs)}</Field>
                            <Field label="Round/Week Field">{renderFieldPicker(inp.inputKey, inp.fieldRound ?? '', v => updateSb(idx, { fieldRound: v }), 'Round.Text', undefined, allInputs)}</Field>
                            <Field label="Logo A Field">{renderFieldPicker(inp.inputKey, inp.fieldLogoA ?? '', v => {
                              updateSb(idx, { fieldLogoA: v });
                              if (v && cfg.teamALogo) {
                                const { getClient } = useVmixStore.getState();
                                const c = getClient();
                                if (c && inp.inputKey) c.setImageField(inp.inputKey, v, cfg.teamALogo);
                              }
                            }, 'LogoA.Source', n => n.toLowerCase().endsWith('.source'), allInputs)}</Field>
                            {inp.fieldLogoA && (
                              <Field label="Logo A (auto)">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {cfg.teamALogo ? (
                                    <>
                                      <img src={resolveImageUrl(cfg.teamALogo)} alt="" style={{ width: 28, height: 21, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 3, background: '#111', flexShrink: 0 }} />
                                      <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{cfg.teamALogo}</span>
                                    </>
                                  ) : (
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No logo — set in Scoreboard or Tournament</span>
                                  )}
                                </div>
                              </Field>
                            )}
                            <Field label="Logo B Field">{renderFieldPicker(inp.inputKey, inp.fieldLogoB ?? '', v => {
                              updateSb(idx, { fieldLogoB: v });
                              if (v && cfg.teamBLogo) {
                                const { getClient } = useVmixStore.getState();
                                const c = getClient();
                                if (c && inp.inputKey) c.setImageField(inp.inputKey, v, cfg.teamBLogo);
                              }
                            }, 'LogoB.Source', n => n.toLowerCase().endsWith('.source'), allInputs)}</Field>
                            {inp.fieldLogoB && (
                              <Field label="Logo B (auto)">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {cfg.teamBLogo ? (
                                    <>
                                      <img src={resolveImageUrl(cfg.teamBLogo)} alt="" style={{ width: 28, height: 21, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 3, background: '#111', flexShrink: 0 }} />
                                      <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{cfg.teamBLogo}</span>
                                    </>
                                  ) : (
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No logo — set in Scoreboard or Tournament</span>
                                  )}
                                </div>
                              </Field>
                            )}
                          </>
                        )}
                      </>)}
                    </div>
                  );
                })}
                <button className="btn btn--ghost btn--small" onClick={addSbInput}>+ Add vMix Input</button>
              </>
            );
          })()}
          <CollapsibleSection label="Score Log">
            <Field label="Linked Score Log Widget">
              <select className="field-input" value={cfg.linkedScoreLogWidgetId ?? ''} onChange={e => up({ linkedScoreLogWidgetId: e.target.value })}>
                <option value="">— none —</option>
                {pages.flatMap(p => p.widgets.filter(w => w.type === 'score-log')).map(w => (
                  <option key={w.id} value={w.id}>Score Log</option>
                ))}
              </select>
            </Field>
            <Field label="Linked Timer (for timestamps)">
              <select className="field-input" value={cfg.linkedTimerWidgetId ?? ''} onChange={e => up({ linkedTimerWidgetId: e.target.value })}>
                <option value="">— wall clock —</option>
                {pages.flatMap(p => p.widgets.filter(w => w.type === 'timer')).map(w => (
                  <option key={w.id} value={w.id}>{w.config.name || 'Timer'}</option>
                ))}
              </select>
            </Field>
          </CollapsibleSection>

          <CollapsibleSection label="Player Picker">
            <Field label="Team A Player List">
              <select className="field-input" value={cfg.linkedPlayerListA ?? ''} onChange={e => up({ linkedPlayerListA: e.target.value })}>
                <option value="">— none —</option>
                {pages.flatMap(p => p.widgets.filter(w => w.type === 'player-list')).map(w => (
                  <option key={w.id} value={w.id}>{plWidgetLabel(w, teamDbTeams)}</option>
                ))}
              </select>
            </Field>
            <Field label="Team B Player List">
              <select className="field-input" value={cfg.linkedPlayerListB ?? ''} onChange={e => up({ linkedPlayerListB: e.target.value })}>
                <option value="">— none —</option>
                {pages.flatMap(p => p.widgets.filter(w => w.type === 'player-list')).map(w => (
                  <option key={w.id} value={w.id}>{plWidgetLabel(w, teamDbTeams)}</option>
                ))}
              </select>
            </Field>
          </CollapsibleSection>
        </>
        );
      }

      case 'score-lower-third': {
        const scoreboards = pages.flatMap(p => p.widgets.filter(w => w.type === 'scoreboard'));
        type SltInput = { id: string; actionLabel: string; vmixInputKey: string; vmixInputTitle?: string; fieldTeam: string; fieldScorer: string; fieldJersey: string; fieldAction: string };
        const sltInputs: SltInput[] = cfg.vmixInputs?.length
          ? cfg.vmixInputs
          : [{ id: 'default', actionLabel: '', vmixInputKey: '', fieldTeam: 'Team.Text', fieldScorer: 'Scorer.Text', fieldJersey: 'Jersey.Text', fieldAction: 'Action.Text' }];
        const setSltInputs = (next: SltInput[]) => up({ vmixInputs: next });
        const updateSlt = (idx: number, patch: Partial<SltInput>) =>
          setSltInputs(sltInputs.map((s, i) => i === idx ? { ...s, ...patch } : s));

        const sb = scoreboards.find(w => w.id === cfg.linkedScoreboardId);
        const nameA = sb?.config.teamAName ?? 'Team A';
        const nameB = sb?.config.teamBName ?? 'Team B';

        return (
          <>
            <CollapsibleSection label="Data Source">
              <Field label="Linked Scoreboard">
                <select className="field-input" value={cfg.linkedScoreboardId ?? ''} onChange={e => up({ linkedScoreboardId: e.target.value })}>
                  <option value="">— select scoreboard —</option>
                  {scoreboards.map(w => (
                    <option key={w.id} value={w.id}>{w.config.teamAName ?? 'Team A'} vs {w.config.teamBName ?? 'Team B'}</option>
                  ))}
                </select>
              </Field>
              <Field label="Team Filter">
                <select className="field-input" value={cfg.teamFilter ?? 'all'} onChange={e => up({ teamFilter: e.target.value })}>
                  <option value="all">Both teams (last scorer)</option>
                  <option value="A">{nameA} only</option>
                  <option value="B">{nameB} only</option>
                </select>
              </Field>
              <Field label="Auto-send on new goal">
                <label className="tf-autosend-label">
                  <input type="checkbox" checked={cfg.autoSend ?? false} onChange={e => up({ autoSend: e.target.checked })} />
                  Send automatically when score changes
                </label>
              </Field>
            </CollapsibleSection>

            <CollapsibleSection label="vMix Title Inputs">
              <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '0 0 6px', lineHeight: 1.4 }}>
                Add one input per score type. Leave "Score Action" blank to use as default fallback.
              </p>
              {sltInputs.map((inp, idx) => {
                const isVilCollapsed = vilCollapsed[inp.id] ?? false;
                return (
                  <div key={inp.id} className="vil-cfg-block">
                    <div className="vil-cfg-header">
                      <button className="btn btn--ghost btn--small tf-collapse-btn"
                        onClick={() => setVilCollapsed(p => ({ ...p, [inp.id]: !p[inp.id] }))}
                        title={isVilCollapsed ? 'Expand' : 'Collapse'}>
                        {isVilCollapsed ? '▶' : '▼'}
                      </button>
                      <span className="vil-cfg-label">
                        {inp.actionLabel ? `"${inp.actionLabel}"` : 'Default (fallback)'}
                      </span>
                      {sltInputs.length > 1 && (
                        <button className="btn btn--ghost btn--small"
                          onClick={() => setSltInputs(sltInputs.filter((_, i) => i !== idx))}>×</button>
                      )}
                    </div>
                    {!isVilCollapsed && (<>
                      <Field label="Score Action">
                        <input className="field-input" value={inp.actionLabel} placeholder="e.g. Try, Goal (blank = default)"
                          onChange={e => updateSlt(idx, { actionLabel: e.target.value })} />
                      </Field>
                      {renderInputPicker(
                        'vMix Title Input',
                        inp.vmixInputKey,
                        inp.vmixInputTitle,
                        (key, title) => updateSlt(idx, { vmixInputKey: key, vmixInputTitle: title }),
                        (i: any) => i.type === 'GT',
                        allInputs,
                      )}
                      {inp.vmixInputKey && (
                        <>
                          <Field label="Team Name Field">{renderFieldPicker(inp.vmixInputKey, inp.fieldTeam, v => updateSlt(idx, { fieldTeam: v }), 'Team.Text', undefined, allInputs)}</Field>
                          <Field label="Scorer Name Field">{renderFieldPicker(inp.vmixInputKey, inp.fieldScorer, v => updateSlt(idx, { fieldScorer: v }), 'Scorer.Text', undefined, allInputs)}</Field>
                          <Field label="Jersey No. Field">{renderFieldPicker(inp.vmixInputKey, inp.fieldJersey, v => updateSlt(idx, { fieldJersey: v }), 'Jersey.Text', undefined, allInputs)}</Field>
                          <Field label="Score Action Field">
                            {renderFieldPicker(inp.vmixInputKey, inp.fieldAction, v => updateSlt(idx, { fieldAction: v }), 'Action.Text', undefined, allInputs)}
                          </Field>
                        </>
                      )}
                    </>)}
                  </div>
                );
              })}
              <button className="btn btn--ghost btn--small" onClick={() =>
                setSltInputs([...sltInputs, { id: crypto.randomUUID(), actionLabel: '', vmixInputKey: '', fieldTeam: 'Team.Text', fieldScorer: 'Scorer.Text', fieldJersey: 'Jersey.Text', fieldAction: 'Action.Text' }])
              }>+ Add Score Type</button>
            </CollapsibleSection>

            <CollapsibleSection label="Overlay">
              <Field label="Overlay Channel">
                <select className="field-input" value={cfg.overlayChannel ?? 1} onChange={e => up({ overlayChannel: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>Overlay {n}</option>)}
                </select>
              </Field>
            </CollapsibleSection>
          </>
        );
      }

      case 'player-lower-third': {
        const playerListWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'player-list'));
        return (
          <>
            <CollapsibleSection label="Data Source">
              <Field label="Linked Player List">
                <select className="field-input" value={cfg.linkedPlayerListId ?? ''} onChange={e => up({ linkedPlayerListId: e.target.value })}>
                  <option value="">— select player list —</option>
                  {playerListWidgets.map(w => (
                    <option key={w.id} value={w.id}>{plWidgetLabel(w, teamDbTeams)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Linked Scoreboard (for score summary)">
                <select className="field-input" value={cfg.linkedScoreboardId ?? ''} onChange={e => up({ linkedScoreboardId: e.target.value })}>
                  <option value="">— none —</option>
                  {pages.flatMap(p => p.widgets.filter(w => w.type === 'scoreboard')).map(w => (
                    <option key={w.id} value={w.id}>{w.config.teamAName ?? 'Team A'} vs {w.config.teamBName ?? 'Team B'}</option>
                  ))}
                </select>
              </Field>
              <Field label="Auto-send on highlight">
                <label className="tf-autosend-label">
                  <input type="checkbox" checked={cfg.autoSend ?? true} onChange={e => up({ autoSend: e.target.checked })} />
                  Send automatically when player is highlighted
                </label>
              </Field>
            </CollapsibleSection>

            <CollapsibleSection label="vMix Title Input">
              {renderInputPicker('vMix Input', cfg.vmixInputKey ?? '', cfg.vmixInputTitle,
                (key, title) => up({ vmixInputKey: key, vmixInputTitle: title }),
                (i: any) => i.type === 'GT',
                allInputs,
              )}
              {cfg.vmixInputKey && (
                <>
                  <Field label="Name field">{renderFieldPicker(cfg.vmixInputKey, cfg.fieldName ?? 'Name.Text', v => up({ fieldName: v }), 'Name.Text', undefined, allInputs)}</Field>
                  <Field label="Jersey No. field">{renderFieldPicker(cfg.vmixInputKey, cfg.fieldJersey ?? 'Jersey.Text', v => up({ fieldJersey: v }), 'Jersey.Text', undefined, allInputs)}</Field>
                  <Field label="Position field">{renderFieldPicker(cfg.vmixInputKey, cfg.fieldPosition ?? 'Position.Text', v => up({ fieldPosition: v }), 'Position.Text', undefined, allInputs)}</Field>
                  <Field label="Team name field">{renderFieldPicker(cfg.vmixInputKey, cfg.fieldTeam ?? 'Team.Text', v => up({ fieldTeam: v }), 'Team.Text', undefined, allInputs)}</Field>
                  <Field label="Score summary field">{renderFieldPicker(cfg.vmixInputKey, cfg.fieldScoreSummary ?? '', v => up({ fieldScoreSummary: v }), 'ScoreSummary.Text', undefined, allInputs)}</Field>
                </>
              )}
            </CollapsibleSection>

            <CollapsibleSection label="Overlay">
              <Field label="Overlay Channel">
                <select className="field-input" value={cfg.overlayChannel ?? 1} onChange={e => up({ overlayChannel: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>Overlay {n}</option>)}
                </select>
              </Field>
            </CollapsibleSection>
          </>
        );
      }

      case 'sin-bin-lower-third': {
        const playerListWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'player-list'));
        const plLabel = (w: any) => plWidgetLabel(w, teamDbTeams);
        return (
          <>
            <CollapsibleSection label="Team">
              <p className="app-settings-hint" style={{ margin: '0 0 6px' }}>
                Link one player list (one team). Add a second widget for the other team.
              </p>
              <Field label="Player List">
                <select className="field-input" value={cfg.linkedPlayerListId ?? ''} onChange={e => up({ linkedPlayerListId: e.target.value })}>
                  <option value="">— select player list —</option>
                  {playerListWidgets.map(w => <option key={w.id} value={w.id}>{plLabel(w)}</option>)}
                </select>
              </Field>
              <Field label="Auto-send on change">
                <label className="tf-autosend-label">
                  <input type="checkbox" checked={cfg.autoSend ?? false} onChange={e => up({ autoSend: e.target.checked })} />
                  Send automatically when player changes
                </label>
              </Field>
            </CollapsibleSection>

            <CollapsibleSection label="vMix Title Input">
              {renderInputPicker('vMix Input', cfg.vmixInputKey ?? '', cfg.vmixInputTitle,
                (key, title) => up({ vmixInputKey: key, vmixInputTitle: title }),
                (i: any) => i.type === 'GT',
                allInputs,
              )}
              {cfg.vmixInputKey && (
                <>
                  <Field label="Jersey No. field">{renderFieldPicker(cfg.vmixInputKey, cfg.fieldJersey ?? 'Jersey.Text', v => up({ fieldJersey: v }), 'Jersey.Text', undefined, allInputs)}</Field>
                  <Field label="Name field">{renderFieldPicker(cfg.vmixInputKey, cfg.fieldName ?? 'Name.Text', v => up({ fieldName: v }), 'Name.Text', undefined, allInputs)}</Field>
                  <Field label="Timer field">{renderFieldPicker(cfg.vmixInputKey, cfg.fieldTimer ?? 'Timer.Text', v => up({ fieldTimer: v }), 'Timer.Text', undefined, allInputs)}</Field>
                  <Field label="Team name field">{renderFieldPicker(cfg.vmixInputKey, cfg.fieldTeam ?? 'Team.Text', v => up({ fieldTeam: v }), 'Team.Text', undefined, allInputs)}</Field>
                </>
              )}
            </CollapsibleSection>

            <CollapsibleSection label="Overlay">
              <Field label="Overlay Channel">
                <select className="field-input" value={cfg.overlayChannel ?? 1} onChange={e => up({ overlayChannel: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>Overlay {n}</option>)}
                </select>
              </Field>
            </CollapsibleSection>
          </>
        );
      }

      case 'timer': {
        const allTimerWidgets = pages.flatMap(p => p.widgets).filter(w => w.type === 'timer' && w.id !== widget.id);
        const linkedTimerTournament = tournaments.find(t => t.id === cfg.linkedTournamentId);
        const timerTournSettings = linkedTimerTournament
          ? (linkedTimerTournament.settings ?? { periods: 2, periodDurationMs: 2700000, halfTimeDurationMs: 900000, maxOnField: 11 })
          : null;
        const fmtMs = (ms: number) => {
          const m = Math.floor(ms / 60000);
          const s = Math.floor((ms % 60000) / 1000);
          return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        };
        return (
        <>
          <CollapsibleSection label="Link to Timer">
            <Field label="Source Timer">
              <select className="field-input" value={cfg.linkedTimerSourceId ?? ''} onChange={e => up({ linkedTimerSourceId: e.target.value })}>
                <option value="">— standalone (own timer) —</option>
                {allTimerWidgets.map(w => (
                  <option key={w.id} value={w.id}>{w.label || w.config?.name || w.id}</option>
                ))}
              </select>
            </Field>
            {cfg.linkedTimerSourceId && (
              <p className="timer-db-hint">This widget mirrors the selected timer. Controls are hidden — manage from the source timer.</p>
            )}
          </CollapsibleSection>
          <CollapsibleSection label="Tournament Database">
            <Field label="Link Tournament">
              <select className="field-input" value={cfg.linkedTournamentId ?? ''} onChange={e => up({ linkedTournamentId: e.target.value })}>
                <option value="">— none (manual) —</option>
                {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            {timerTournSettings && (
              <div className="timer-db-settings">
                <div className="timer-db-row">
                  <span>Periods</span><strong>{timerTournSettings.periods}</strong>
                </div>
                <div className="timer-db-row">
                  <span>Period duration</span><strong>{fmtMs(timerTournSettings.periodDurationMs)}</strong>
                </div>
                <div className="timer-db-row">
                  <span>Half-time / Break</span><strong>{fmtMs(timerTournSettings.halfTimeDurationMs)}</strong>
                </div>
                <p className="timer-db-hint">Settings auto-apply when timer is not running. Edit in 🏆 DB.</p>
              </div>
            )}
          </CollapsibleSection>
          <CollapsibleSection label="Timer">
          <Field label="Mode">
            <select className="field-input" value={cfg.mode ?? 'countdown'} onChange={e => {
              const mode = e.target.value;
              up({ mode, currentMs: mode === 'countdown' ? cfg.durationMs : 0 });
            }}>
              <option value="countdown">Countdown</option>
              <option value="countup">Count Up</option>
            </select>
          </Field>
          <Field label="Display Format">
            <select className="field-input" value={cfg.format ?? 'mm:ss'} onChange={e => up({ format: e.target.value })}>
              <option value="hh:mm:ss">hh:mm:ss</option>
              <option value="h:mm:ss">h:mm:ss</option>
              <option value="mm:ss">mm:ss</option>
              <option value="ss">seconds only</option>
            </select>
          </Field>
          <Field label="Timer font size (px)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={12} max={120} step={2} className="field-range"
                value={cfg.timerFontSize ?? 28} onChange={e => up({ timerFontSize: Number(e.target.value) })} />
              <span style={{ minWidth: 32, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{cfg.timerFontSize ?? 28}px</span>
            </div>
          </Field>
          <Field label="Button size (px)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={10} max={32} step={1} className="field-range"
                value={cfg.btnFontSize ?? 13} onChange={e => up({ btnFontSize: Number(e.target.value) })} />
              <span style={{ minWidth: 32, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{cfg.btnFontSize ?? 13}px</span>
            </div>
          </Field>
          <Field label={`Duration (${cfg.format ?? 'mm:ss'})`}>
            <input
              className="field-input"
              value={durationText}
              placeholder={cfg.format === 'ss' ? '300' : cfg.format === 'mm:ss' ? '05:00' : '00:05:00'}
              onChange={e => setDurationText(e.target.value)}
              onBlur={() => {
                const ms = formatStrToMs(durationText, cfg.format ?? 'mm:ss');
                up({ durationMs: ms, currentMs: cfg.mode === 'countdown' ? ms : cfg.currentMs });
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const ms = formatStrToMs(durationText, cfg.format ?? 'mm:ss');
                  up({ durationMs: ms, currentMs: cfg.mode === 'countdown' ? ms : cfg.currentMs });
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </Field>
          <Field label="Periods">
            <select className="field-input" value={cfg.periods ?? 1} onChange={e => {
              up({ periods: Number(e.target.value), currentPeriod: 1, periodStartMs: 0, inBreak: false, breakCurrentMs: 0 });
            }}>
              <option value={1}>None (no periods)</option>
              <option value={2}>2 Halves</option>
              <option value={3}>3 Periods</option>
              <option value={4}>4 Quarters</option>
            </select>
          </Field>
          {(cfg.periods ?? 1) > 1 && (
            <Field label="After Break">
              <select className="field-input" value={cfg.periodMode ?? 'reset'} onChange={e => up({ periodMode: e.target.value })}>
                <option value="reset">Reset timer each period</option>
                <option value="continue">Continue from last period</option>
              </select>
            </Field>
          )}
          {(cfg.periods ?? 1) > 1 && (
            <Field label="Current Period">
              <select
                className="field-input"
                value={Math.min(cfg.currentPeriod ?? 1, cfg.periods ?? 1)}
                onChange={e => store.jumpToPeriod(widget.id, Number(e.target.value))}
              >
                {Array.from({ length: cfg.periods ?? 1 }, (_, i) => i + 1).map(p => (
                  <option key={p} value={p}>Period {p}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Overrun (manual end)">
            <label className="tf-autosend-label">
              <input type="checkbox" checked={cfg.overrun ?? false} onChange={e => up({ overrun: e.target.checked })} />
              Keep running after time — end manually
            </label>
          </Field>
          {cfg.overrun && (
            <>
              <Field label="Change title color on overrun">
                <label className="tf-autosend-label">
                  <input type="checkbox" checked={cfg.overrunColorEnabled ?? false} onChange={e => up({ overrunColorEnabled: e.target.checked })} />
                  Send a vMix function on overrun
                </label>
              </Field>
              {cfg.overrunColorEnabled && (() => {
                const ocFn = cfg.overrunColorFn ?? 'SetColor';
                const isCustomOc = ocFn !== '' && !VMIX_ALL_FNS.find(f => f.fn === ocFn);
                const selectValOc = isCustomOc ? '__custom__' : ocFn;
                return (
                  <>
                    <Field label="Function">
                      <select className="field-input" value={selectValOc} onChange={e => {
                        if (e.target.value === '__custom__') up({ overrunColorFn: '' });
                        else up({ overrunColorFn: e.target.value });
                      }}>
                        <option value="">— select function —</option>
                        {VMIX_FUNCTIONS.map(g => (
                          <optgroup key={g.group} label={g.group}>
                            {g.fns.map(f => <option key={f.fn} value={f.fn}>{f.label}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </Field>
                    {isCustomOc && (
                      <Field label="Custom Function">
                        <input className="field-input" value={ocFn}
                          onChange={e => up({ overrunColorFn: e.target.value })}
                          placeholder="e.g. SetColor" />
                      </Field>
                    )}
                    <Field label="Selected Name">
                      {renderFieldPicker(cfg.vmixInputs?.[0]?.inputKey ?? cfg.vmixInputKey ?? '', cfg.overrunColorField ?? '', v => up({ overrunColorField: v }), 'e.g. Color1')}
                    </Field>
                    <span className="field-hint" style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginTop: -4, marginBottom: 4 }}>
                      For SetColor, this must match the named Colour property in the vMix title — not a plain text field name.
                    </span>
                    <Field label="Overrun Color">
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="color" className="color-custom" value={cfg.overrunColor ?? '#ff0000'} onChange={e => up({ overrunColor: e.target.value })} />
                        <span className="field-label" style={{ fontSize: 10 }}>{(cfg.overrunColor ?? '#ff0000').toUpperCase()}</span>
                      </div>
                    </Field>
                    <Field label="Normal Color (restored)">
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="color" className="color-custom" value={cfg.normalColor ?? '#ffffff'} onChange={e => up({ normalColor: e.target.value })} />
                        <span className="field-label" style={{ fontSize: 10 }}>{(cfg.normalColor ?? '#ffffff').toUpperCase()}</span>
                      </div>
                    </Field>
                  </>
                );
              })()}
            </>
          )}
          <Field label="Quick Adjust Buttons">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
              {((cfg.adjustButtons ?? []) as { id: string; label: string; deltaMs: number }[]).map((btn, i) => (
                <div key={btn.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    className="field-input"
                    style={{ flex: 1, minWidth: 0 }}
                    value={btn.label}
                    placeholder="Label"
                    onChange={e => {
                      const buttons = [...(cfg.adjustButtons ?? [])];
                      buttons[i] = { ...btn, label: e.target.value };
                      up({ adjustButtons: buttons });
                    }}
                  />
                  <input
                    type="number"
                    className="field-input"
                    style={{ width: 72 }}
                    value={btn.deltaMs / 1000}
                    title="Seconds (negative = subtract)"
                    onChange={e => {
                      const buttons = [...(cfg.adjustButtons ?? [])];
                      buttons[i] = { ...btn, deltaMs: (parseFloat(e.target.value) || 0) * 1000 };
                      up({ adjustButtons: buttons });
                    }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)', minWidth: 16 }}>s</span>
                  <button
                    className="wcp-btn-icon"
                    title="Remove button"
                    onClick={() => {
                      const buttons = (cfg.adjustButtons ?? []).filter((_: unknown, j: number) => j !== i);
                      up({ adjustButtons: buttons });
                    }}
                  >✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2 }}>
                <input
                  className="field-input"
                  style={{ flex: 1, minWidth: 0 }}
                  value={adjNewLabel}
                  placeholder="Label (e.g. +30s)"
                  onChange={e => setAdjNewLabel(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const secs = parseFloat(adjNewSeconds) || 0;
                      if (secs === 0) return;
                      const newBtn = { id: Math.random().toString(36).slice(2), label: adjNewLabel || `${secs > 0 ? '+' : ''}${secs}s`, deltaMs: secs * 1000 };
                      up({ adjustButtons: [...(cfg.adjustButtons ?? []), newBtn] });
                      setAdjNewLabel(''); setAdjNewSeconds('10');
                    }
                  }}
                />
                <input
                  type="number"
                  className="field-input"
                  style={{ width: 72 }}
                  value={adjNewSeconds}
                  title="Seconds (negative = subtract)"
                  onChange={e => setAdjNewSeconds(e.target.value)}
                />
                <span style={{ fontSize: 10, color: 'var(--text-secondary)', minWidth: 16 }}>s</span>
                <button
                  className="wcp-btn-icon wcp-btn-icon--add"
                  title="Add button"
                  onClick={() => {
                    const secs = parseFloat(adjNewSeconds) || 0;
                    if (secs === 0) return;
                    const newBtn = { id: Math.random().toString(36).slice(2), label: adjNewLabel || `${secs > 0 ? '+' : ''}${secs}s`, deltaMs: secs * 1000 };
                    up({ adjustButtons: [...(cfg.adjustButtons ?? []), newBtn] });
                    setAdjNewLabel(''); setAdjNewSeconds('10');
                  }}
                >+</button>
              </div>
              <p style={{ fontSize: 10, color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                Positive = add time, negative = subtract. Buttons work while timer is running.
              </p>
            </div>
          </Field>
          </CollapsibleSection>
            <CollapsibleSection label="Final Play">
            <Field label="Enable Final Play">
              <label className="tf-autosend-label">
                <input type="checkbox" checked={cfg.finalPlayEnabled ?? false}
                  onChange={e => up({ finalPlayEnabled: e.target.checked })} />
                Auto-start when period ends (overrun off)
              </label>
            </Field>
            {cfg.finalPlayEnabled && (<>
              <Field label="vMix Input">
                {renderInputPicker('fp_vmix', cfg.finalPlayVmixInputKey ?? '', cfg.finalPlayVmixInputTitle ?? '',
                  (key, title) => up({ finalPlayVmixInputKey: key, finalPlayVmixInputTitle: title }))}
              </Field>
              <Field label="Field Name">
                {renderFieldPicker(cfg.finalPlayVmixInputKey ?? '', cfg.finalPlayFieldName ?? '', v => up({ finalPlayFieldName: v }), 'FinalPlay.Text')}
              </Field>
              <Field label={`Duration (${cfg.format ?? 'mm:ss'}, 0 = unlimited)`}>
                <input className="field-input" value={finalPlayDurationText}
                  placeholder={cfg.format === 'ss' ? '0' : cfg.format === 'mm:ss' ? '00:00' : '00:00:00'}
                  onChange={e => setFinalPlayDurationText(e.target.value)}
                  onBlur={() => up({ finalPlayDurationMs: formatStrToMs(finalPlayDurationText, cfg.format ?? 'mm:ss') })}
                  onKeyDown={e => { if (e.key === 'Enter') { up({ finalPlayDurationMs: formatStrToMs(finalPlayDurationText, cfg.format ?? 'mm:ss') }); (e.target as HTMLInputElement).blur(); } }} />
              </Field>
              <Field label="End Trigger">
                <label className="tf-autosend-label">
                  <input type="checkbox" checked={cfg.finalPlayEndTriggerEnabled ?? false}
                    onChange={e => up({ finalPlayEndTriggerEnabled: e.target.checked })} />
                  Fire vMix function when Final Play ends
                </label>
              </Field>
              {cfg.finalPlayEndTriggerEnabled && (() => {
                const fpFn = cfg.finalPlayEndTriggerFn ?? '';
                const isCustom = fpFn !== '' && !VMIX_ALL_FNS.find(f => f.fn === fpFn);
                const fpDef = VMIX_ALL_FNS.find(f => f.fn === fpFn);
                const selectVal = isCustom ? '__custom__' : (fpFn || '');
                const needsInput = isCustom || (fpDef?.p ?? []).includes('Input');
                const needsSelectedName = isCustom || (fpDef?.p ?? []).includes('SelectedName');
                const needsValue = isCustom || (fpDef?.p ?? []).includes('Value');
                return (
                  <>
                    <Field label="Function">
                      <select className="field-input" value={selectVal} onChange={e => {
                        if (e.target.value === '__custom__') up({ finalPlayEndTriggerFn: '' });
                        else up({ finalPlayEndTriggerFn: e.target.value });
                      }}>
                        <option value="">— select function —</option>
                        {VMIX_FUNCTIONS.map(g => (
                          <optgroup key={g.group} label={g.group}>
                            {g.fns.map(f => <option key={f.fn} value={f.fn}>{f.label}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </Field>
                    {isCustom && (
                      <Field label="Custom Function">
                        <input className="field-input" value={fpFn}
                          onChange={e => up({ finalPlayEndTriggerFn: e.target.value })}
                          placeholder="e.g. OverlayInput1In" />
                      </Field>
                    )}
                    {needsInput && (
                      <Field label="Input">
                        {renderInputPicker('fpe_input', cfg.finalPlayEndTriggerInput ?? '', cfg.finalPlayEndTriggerInputTitle ?? '',
                          (key, title) => up({ finalPlayEndTriggerInput: key, finalPlayEndTriggerInputTitle: title }))}
                      </Field>
                    )}
                    {needsSelectedName && (
                      <Field label="Selected Name">
                        <input className="field-input" value={cfg.finalPlayEndTriggerSelectedName ?? ''}
                          onChange={e => up({ finalPlayEndTriggerSelectedName: e.target.value })}
                          placeholder="e.g. Headline.Text" />
                      </Field>
                    )}
                    {needsValue && (
                      <Field label="Value">
                        <input className="field-input" value={cfg.finalPlayEndTriggerValue ?? ''}
                          onChange={e => up({ finalPlayEndTriggerValue: e.target.value })}
                          placeholder="value" />
                      </Field>
                    )}
                  </>
                );
              })()}
            </>)}
          </CollapsibleSection>
            <CollapsibleSection label="Period End Trigger">
            <Field label="Enable">
              <label className="tf-autosend-label">
                <input type="checkbox" checked={cfg.periodEndTriggerEnabled ?? false}
                  onChange={e => up({ periodEndTriggerEnabled: e.target.checked })} />
                Fire vMix function after each period ends
              </label>
            </Field>
            {cfg.periodEndTriggerEnabled && (() => {
              const petFn = cfg.periodEndTriggerFn ?? '';
              const isCustomPet = petFn !== '' && !VMIX_ALL_FNS.find(f => f.fn === petFn);
              const petDef = VMIX_ALL_FNS.find(f => f.fn === petFn);
              const selectVal = isCustomPet ? '__custom__' : (petFn || '');
              const needsInput = isCustomPet || (petDef?.p ?? []).includes('Input');
              const needsSelectedName = isCustomPet || (petDef?.p ?? []).includes('SelectedName');
              const needsValue = isCustomPet || (petDef?.p ?? []).includes('Value');
              return (
                <>
                  <Field label="Function">
                    <select className="field-input" value={selectVal} onChange={e => {
                      if (e.target.value === '__custom__') up({ periodEndTriggerFn: '' });
                      else up({ periodEndTriggerFn: e.target.value });
                    }}>
                      <option value="">— select function —</option>
                      {VMIX_FUNCTIONS.map(g => (
                        <optgroup key={g.group} label={g.group}>
                          {g.fns.map(f => <option key={f.fn} value={f.fn}>{f.label}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </Field>
                  {isCustomPet && (
                    <Field label="Custom Function">
                      <input className="field-input" value={petFn}
                        onChange={e => up({ periodEndTriggerFn: e.target.value })}
                        placeholder="e.g. SetFader" />
                    </Field>
                  )}
                  {needsInput && (
                    <Field label="Input">
                      {renderInputPicker('pet_input', cfg.periodEndTriggerInput ?? '', cfg.periodEndTriggerInputTitle ?? '',
                        (key, title) => up({ periodEndTriggerInput: key, periodEndTriggerInputTitle: title }))}
                    </Field>
                  )}
                  {needsSelectedName && (
                    <Field label="Selected Name">
                      <input className="field-input" value={cfg.periodEndTriggerSelectedName ?? ''}
                        onChange={e => up({ periodEndTriggerSelectedName: e.target.value })}
                        placeholder="e.g. Headline.Text" />
                    </Field>
                  )}
                  {needsValue && (
                    <Field label="Value">
                      <input className="field-input" value={cfg.periodEndTriggerValue ?? ''}
                        onChange={e => up({ periodEndTriggerValue: e.target.value })}
                        placeholder="value" />
                    </Field>
                  )}
                </>
              );
            })()}
          {(cfg.periods ?? 1) > 1 && (
            <Field label={`Break Duration (${cfg.format ?? 'mm:ss'})`}>
              <input
                className="field-input"
                value={breakText}
                placeholder={cfg.format === 'ss' ? '0' : cfg.format === 'mm:ss' ? '00:00' : '00:00:00'}
                onChange={e => setBreakText(e.target.value)}
                onBlur={() => {
                  const ms = formatStrToMs(breakText, cfg.format ?? 'mm:ss');
                  up({ breakDurationMs: ms });
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const ms = formatStrToMs(breakText, cfg.format ?? 'mm:ss');
                    up({ breakDurationMs: ms });
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
            </Field>
          )}
          {(cfg.periods ?? 1) > 1 && (cfg.breakDurationMs ?? 0) > 0 && (
            <Field label="Break Direction">
              <div className="tm-timer-mode-toggle">
                {([['down','Count Down'],['up','Count Up']] as [string,string][]).map(([val, lbl]) => (
                  <button key={val}
                    className={`tm-timer-mode-btn ${(cfg.breakCountMode ?? 'down') === val ? 'tm-timer-mode-btn--active' : ''}`}
                    onClick={() => up({ breakCountMode: val })}
                  >{lbl}</button>
                ))}
              </div>
            </Field>
          )}
          {(cfg.periods ?? 1) > 1 && (
            <Field label="Auto-advance">
              <label className="tf-autosend-label">
                <input type="checkbox" checked={cfg.autoAdvance ?? false} onChange={e => up({ autoAdvance: e.target.checked })} />
                Flow straight through period → break → next period automatically
              </label>
              <p className="app-settings-hint" style={{ margin: '4px 0 0' }}>
                {cfg.autoAdvance
                  ? 'Auto: no manual step needed between periods and breaks.'
                  : 'Manual (default): period end and break end both pause the timer — press Play/Resume to start each next step.'}
              </p>
            </Field>
          )}
          {(cfg.periods ?? 1) > 1 && !cfg.autoAdvance && (cfg.breakDurationMs ?? 0) > 0 && (
            <Field label="Auto-start break">
              <label className="tf-autosend-label">
                <input type="checkbox" checked={cfg.autoStartBreak ?? false} onChange={e => up({ autoStartBreak: e.target.checked })} />
                Start the half-time/break timer immediately once "End Period" is confirmed
              </label>
              <p className="app-settings-hint" style={{ margin: '4px 0 0' }}>
                Still asks for confirmation to end the period — just skips the extra Play press to start the break countdown afterward.
              </p>
            </Field>
          )}
          </CollapsibleSection>
          {/* ── Extra Time ── */}
          <CollapsibleSection label="Extra Time">
          <Field label="ET Halves">
            <div className="tm-timer-mode-toggle">
              {([['0','None'],['1','1 Half'],['2','2 Halves']] as [string,string][]).map(([val, lbl]) => (
                <button key={val}
                  className={`tm-timer-mode-btn ${(cfg.extraTimePeriods ?? 0) === Number(val) ? 'tm-timer-mode-btn--active' : ''}`}
                  onClick={() => up({ extraTimePeriods: Number(val) })}>
                  {lbl}
                </button>
              ))}
            </div>
          </Field>
          {(cfg.extraTimePeriods ?? 0) > 0 && (() => {
            const etFmt = cfg.format ?? 'mm:ss';
            return (
              <>
                <Field label={`ET Duration (${etFmt})`}>
                  <input
                    className="field-input"
                    defaultValue={msToFormatStr(cfg.etDurationMs ?? 300000, etFmt)}
                    key={cfg.etDurationMs + etFmt}
                    placeholder={etFmt === 'mm:ss' ? '05:00' : '00:05:00'}
                    onBlur={e => up({ etDurationMs: formatStrToMs(e.target.value, etFmt) })}
                    onKeyDown={e => { if (e.key === 'Enter') { up({ etDurationMs: formatStrToMs((e.target as HTMLInputElement).value, etFmt) }); (e.target as HTMLInputElement).blur(); } }}
                  />
                </Field>
                {(cfg.extraTimePeriods ?? 0) === 2 && (
                  <Field label={`ET Break (${etFmt})`}>
                    <input
                      className="field-input"
                      defaultValue={msToFormatStr(cfg.etBreakDurationMs ?? 0, etFmt)}
                      key={cfg.etBreakDurationMs + etFmt}
                      placeholder={etFmt === 'mm:ss' ? '00:00' : '00:00:00'}
                      onBlur={e => up({ etBreakDurationMs: formatStrToMs(e.target.value, etFmt) })}
                      onKeyDown={e => { if (e.key === 'Enter') { up({ etBreakDurationMs: formatStrToMs((e.target as HTMLInputElement).value, etFmt) }); (e.target as HTMLInputElement).blur(); } }}
                    />
                  </Field>
                )}
              </>
            );
          })()}
          </CollapsibleSection>
          {/* ── After Extra Time ── */}
          <CollapsibleSection label="After Extra Time">
          <Field label="Mode">
            <div className="tm-timer-mode-toggle">
              {([['none','None'],['suddenDeath','Sudden Death'],['goldenPoint','Golden Point']] as [string,string][]).map(([val, lbl]) => (
                <button key={val}
                  className={`tm-timer-mode-btn ${(cfg.afterEtMode ?? 'none') === val ? 'tm-timer-mode-btn--active' : ''}`}
                  onClick={() => up({ afterEtMode: val })}>
                  {lbl}
                </button>
              ))}
            </div>
          </Field>
          {(cfg.afterEtMode ?? 'none') !== 'none' && (() => {
            const etFmt = cfg.format ?? 'mm:ss';
            return (
              <Field label={`Max Duration (${etFmt}, 0=unlimited)`}>
                <input
                  className="field-input"
                  defaultValue={msToFormatStr(cfg.afterEtDurationMs ?? 0, etFmt)}
                  key={cfg.afterEtDurationMs + etFmt}
                  placeholder={etFmt === 'mm:ss' ? '00:00' : '00:00:00'}
                  onBlur={e => up({ afterEtDurationMs: formatStrToMs(e.target.value, etFmt) })}
                  onKeyDown={e => { if (e.key === 'Enter') { up({ afterEtDurationMs: formatStrToMs((e.target as HTMLInputElement).value, etFmt) }); (e.target as HTMLInputElement).blur(); } }}
                />
              </Field>
            );
          })()}
          <Field label="High Precision (100ms)">
            <input type="checkbox" checked={cfg.highPrecision ?? false} onChange={e => up({ highPrecision: e.target.checked })} />
          </Field>
          </CollapsibleSection>
          {/* ── Period Labels & Images ── */}
          {(() => {
            const timerPeriods = cfg.periods ?? 1;
            const hasBreak = (cfg.breakDurationMs ?? 0) > 0 && timerPeriods > 1;
            const etPeriods = cfg.extraTimePeriods ?? 0;
            const afterEtMode = cfg.afterEtMode ?? 'none';
            const hasEtBreak = etPeriods === 2 && (cfg.etBreakDurationMs ?? 0) > 0;
            const overrides: Record<string, { customText?: string; imagePath?: string }> = cfg.periodOverrides ?? {};
            const patchOverride = (key: string, patch: { customText?: string; imagePath?: string }) =>
              up({ periodOverrides: { ...overrides, [key]: { ...(overrides[key] ?? {}), ...patch } } });

            const states: { key: string; label: string }[] = [];
            for (let p = 1; p <= timerPeriods; p++) {
              const lbl = timerPeriods === 2 ? (p === 1 ? '1st Half' : '2nd Half')
                : timerPeriods === 4 ? `Q${p}`
                : `Period ${p}`;
              states.push({ key: `p${p}`, label: lbl });
              if (hasBreak && p < timerPeriods)
                states.push({ key: 'break', label: timerPeriods === 2 ? 'Half Time' : 'Break' });
            }
            states.push({ key: 'done', label: timerPeriods === 2 ? 'Full Time' : 'Done' });
            if (etPeriods > 0) {
              for (let ep = 1; ep <= etPeriods; ep++) {
                const etLbl = etPeriods === 2 ? (ep === 1 ? 'ET 1st Half' : 'ET 2nd Half') : 'Extra Time';
                states.push({ key: `et${ep}`, label: etLbl });
                if (hasEtBreak && ep < etPeriods)
                  states.push({ key: 'etBreak', label: 'ET Half Time' });
              }
            }
            if (afterEtMode === 'suddenDeath') states.push({ key: 'sd', label: 'Sudden Death' });
            else if (afterEtMode === 'goldenPoint') states.push({ key: 'gp', label: 'Golden Point' });

            return (
              <>
                <CollapsibleSection label="Period Labels">
                <div className="timer-period-overrides">
                  {states.map(s => (
                    <div key={s.key + s.label} className="timer-period-override-row">
                      <span className="timer-period-override-state">{s.label}</span>
                      <input
                        className="field-input timer-period-override-text"
                        value={overrides[s.key]?.customText ?? ''}
                        placeholder="Custom text…"
                        onChange={e => patchOverride(s.key, { customText: e.target.value })}
                      />
                      <input
                        className="field-input timer-period-override-img"
                        value={overrides[s.key]?.imagePath ?? ''}
                        placeholder="Image path…"
                        onChange={e => patchOverride(s.key, { imagePath: e.target.value })}
                      />
                    </div>
                  ))}
                </div>
                </CollapsibleSection>
              </>
            );
          })()}
          {/* ── Multiple vMix Timer Inputs ── */}
          {(() => {
            type TiInput = { id: string; inputKey: string; inputTitle?: string; fieldName: string; fieldTimerName?: string; fieldPeriodLabel?: string; fieldPeriodImage?: string };
            const tiInputs: TiInput[] = cfg.vmixInputs?.length
              ? cfg.vmixInputs
              : cfg.vmixInputKey
                ? [{ id: 'legacy', inputKey: cfg.vmixInputKey, inputTitle: cfg.vmixInputTitle, fieldName: cfg.fieldName ?? 'Timer.Text' }]
                : [];
            const setTiInputs = (next: TiInput[]) => up({ vmixInputs: next });
            const updateTi = (idx: number, patch: Partial<TiInput>) => setTiInputs(tiInputs.map((t, i) => i === idx ? { ...t, ...patch } : t));
            return (
              <>
                {tiInputs.map((inp, idx) => {
                  const isVilCollapsed = vilCollapsed[inp.id] ?? false;
                  return (
                    <div key={inp.id} className="vil-cfg-block">
                      <div className="vil-cfg-header">
                        <button className="btn btn--ghost btn--small tf-collapse-btn"
                          onClick={() => setVilCollapsed(p => ({ ...p, [inp.id]: !p[inp.id] }))}
                          title={isVilCollapsed ? 'Expand' : 'Collapse'}>
                          {isVilCollapsed ? '▶' : '▼'}
                        </button>
                        <span className="vil-cfg-label">vMix Title Input {idx + 1}</span>
                        {tiInputs.length > 1 && <button className="btn btn--ghost btn--small" onClick={() => setTiInputs(tiInputs.filter((_, i) => i !== idx))}>×</button>}
                      </div>
                      {!isVilCollapsed && (<>
                        {renderInputPicker('vMix Title Input', inp.inputKey, inp.inputTitle,
                          (key, title) => updateTi(idx, { inputKey: key, inputTitle: title }),
                          i => i.type === 'GT',
                          allInputs,
                        )}
                        {inp.inputKey && (
                          <>
                            <Field label="Timer Value Field">{renderFieldPicker(inp.inputKey, inp.fieldName, v => updateTi(idx, { fieldName: v }), 'Timer.Text', undefined, allInputs)}</Field>
                            <Field label="Timer Name Field">{renderFieldPicker(inp.inputKey, inp.fieldTimerName ?? '', v => updateTi(idx, { fieldTimerName: v }), 'TimerName.Text', undefined, allInputs)}</Field>
                            <Field label="Period Label Field">{renderFieldPicker(inp.inputKey, inp.fieldPeriodLabel ?? '', v => updateTi(idx, { fieldPeriodLabel: v }), 'Period.Text', undefined, allInputs)}</Field>
                            <Field label="Period Image Field">{renderFieldPicker(inp.inputKey, inp.fieldPeriodImage ?? '', v => updateTi(idx, { fieldPeriodImage: v }), 'PeriodImg.Source', undefined, allInputs)}</Field>
                          </>
                        )}
                      </>)}
                    </div>
                  );
                })}
                <button className="btn btn--ghost btn--small" onClick={() => setTiInputs([...tiInputs, { id: crypto.randomUUID(), inputKey: '', fieldName: 'Timer.Text' }])}>+ Add vMix Input</button>
              </>
            );
          })()}
          {(cfg.periods ?? 1) > 1 && (cfg.breakDurationMs ?? 0) > 0 && (
            <CollapsibleSection label="Break / Half Time Output">
              {renderInputPicker(
                'Break vMix Input',
                cfg.breakVmixInputKey ?? '',
                cfg.breakVmixInputTitle,
                (key, title) => up({ breakVmixInputKey: key, breakVmixInputTitle: title }),
                i => i.type === 'GT',
              )}
              {cfg.breakVmixInputKey && (
                <Field label="Break Field Name">{renderFieldPicker(cfg.breakVmixInputKey, cfg.breakFieldName ?? '', v => up({ breakFieldName: v }), 'Timer.Text')}</Field>
              )}
            </CollapsibleSection>
          )}
          <CollapsibleSection label="Mini Timer Output">
            {renderInputPicker(
              'Mini Timer vMix Input',
              cfg.miniVmixInputKey ?? '',
              cfg.miniVmixInputTitle,
              (key, title) => up({ miniVmixInputKey: key, miniVmixInputTitle: title }),
              i => i.type === 'GT',
            )}
            {cfg.miniVmixInputKey && (
              <Field label="Mini Timer Field Name">{renderFieldPicker(cfg.miniVmixInputKey, cfg.miniFieldName ?? '', v => up({ miniFieldName: v }), 'MiniTimer.Text')}</Field>
            )}
          </CollapsibleSection>
        </>
        );
      }

      case 'file-path': return (
        <>
          <Field label="Label">
            <input className="field-input" value={cfg.label ?? ''} onChange={e => up({ label: e.target.value })} />
          </Field>
          {renderInputPicker(
            'vMix Title Input',
            cfg.inputKey ?? '',
            cfg.inputTitle,
            (key, title) => up({ inputKey: key, inputTitle: title }),
            i => i.type === 'GT',
            allInputs,
          )}
          <Field label="Field Name">{renderFieldPicker(cfg.inputKey ?? '', cfg.fieldName ?? '', v => up({ fieldName: v }), 'Path.Text', undefined, allInputs)}</Field>
          <Field label="File Filter">
            <select className="field-input" value={cfg.accept ?? 'image/*'} onChange={e => up({ accept: e.target.value })}>
              <option value="image/*">Images only (jpg, png, gif…)</option>
              <option value="image/jpeg,image/jpg">JPEG only</option>
              <option value="image/png">PNG only</option>
              <option value="image/gif">GIF only</option>
              <option value="image/webp">WebP only</option>
            </select>
          </Field>
          <Field label="Auto-send on browse">
            <label className="tf-autosend-label">
              <input type="checkbox" checked={cfg.autoSend ?? false} onChange={e => up({ autoSend: e.target.checked })} />
              Send path immediately after selecting file
            </label>
          </Field>
        </>
      );

      case 'tbar': return (
        <>
          <Field label="Label">
            <input className="field-input" value={cfg.label ?? 'T-Bar'} onChange={e => up({ label: e.target.value })} />
          </Field>
        </>
      );

      case 'volume': return (
        <>
          <Field label="Target">
            <select className="field-input" value={cfg.target ?? 'master'} onChange={e => up({ target: e.target.value })}>
              <option value="master">Master</option>
              <option value="input">Input</option>
              <option value="bus">Audio Bus</option>
            </select>
          </Field>
          {cfg.target === 'input' && renderInputPicker(
            'Input',
            cfg.inputKey ?? '',
            cfg.inputTitle,
            (key, title) => up({ inputKey: key, inputTitle: title, label: title || 'Volume' }),
          )}
          {cfg.target === 'bus' && (
            <Field label="Bus">
              <select className="field-input" value={cfg.busName ?? 'M'} onChange={e => up({ busName: e.target.value, label: `Bus ${e.target.value}` })}>
                {['M','A','B','C','D','E','F','G'].map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
          )}
          <Field label="Label">
            <input className="field-input" value={cfg.label ?? ''} onChange={e => up({ label: e.target.value })} />
          </Field>
          <Field label="Show Mute Button">
            <input type="checkbox" checked={cfg.showMute !== false} onChange={e => up({ showMute: e.target.checked })} />
          </Field>
        </>
      );

      case 'overlay': return (
        <>
          <Field label="Overlay Channel">
            <select className="field-input" value={cfg.channel ?? 1} onChange={e => up({ channel: Number(e.target.value) })}>
              {[1,2,3,4].map(n => <option key={n} value={n}>Overlay {n}</option>)}
            </select>
          </Field>
        </>
      );

      case 'label': return (
        <>
          <Field label="Text">
            <input className="field-input" value={cfg.text ?? ''} onChange={e => up({ text: e.target.value })} />
          </Field>
          <Field label="Font Size">
            <input className="field-input" type="number" min={8} max={72} value={cfg.fontSize ?? 14} onChange={e => up({ fontSize: Number(e.target.value) })} />
          </Field>
          <Field label="Text Color">
            <input type="color" className="color-custom" value={cfg.color ?? '#ffffff'} onChange={e => up({ color: e.target.value })} />
          </Field>
          <Field label="Background">
            <input type="color" className="color-custom" value={cfg.bgColor === 'transparent' ? '#1a1a2e' : cfg.bgColor ?? '#1a1a2e'} onChange={e => up({ bgColor: e.target.value })} />
          </Field>
          <Field label="Bold">
            <input type="checkbox" checked={cfg.bold ?? false} onChange={e => up({ bold: e.target.checked })} />
          </Field>
          <Field label="Align">
            <select className="field-input" value={cfg.align ?? 'center'} onChange={e => up({ align: e.target.value })}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </Field>
        </>
      );

      case 'image-display': return (
        <>
          <Field label="Image">
            <LogoUrlPicker
              value={cfg.imageUrl ?? ''}
              onChange={url => up({ imageUrl: url })}
              placeholder="Pick from library…"
            />
          </Field>
          <Field label="Fit">
            <select className="field-input" value={cfg.objectFit ?? 'contain'} onChange={e => up({ objectFit: e.target.value })}>
              <option value="contain">Contain</option>
              <option value="cover">Cover</option>
              <option value="fill">Stretch</option>
              <option value="none">Original size</option>
            </select>
          </Field>
          <Field label="Background">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="color" className="color-custom"
                value={cfg.bgColor && cfg.bgColor !== 'transparent' ? cfg.bgColor : '#000000'}
                onChange={e => up({ bgColor: e.target.value })} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                <input type="checkbox" checked={!cfg.bgColor || cfg.bgColor === 'transparent'}
                  onChange={e => up({ bgColor: e.target.checked ? 'transparent' : '#000000' })} />
                Transparent
              </label>
            </div>
          </Field>
          <Field label="Caption">
            <input className="field-input" value={cfg.caption ?? ''} placeholder="Optional label"
              onChange={e => up({ caption: e.target.value })} />
          </Field>
        </>
      );

      case 'recent-matches': return (
        <>
          <Field label="Title">
            <input className="field-input" value={cfg.title ?? ''} placeholder="Latest Results"
              onChange={e => up({ title: e.target.value })} />
          </Field>
          <Field label="Max results shown">
            <input type="number" className="field-input" min={1} max={50} value={cfg.maxResults ?? 8}
              onChange={e => up({ maxResults: Math.max(1, parseInt(e.target.value) || 8) })} />
          </Field>
          <Field label="Group by competition">
            <input type="checkbox" checked={cfg.groupByCompetition ?? true}
              onChange={e => up({ groupByCompetition: e.target.checked })} />
          </Field>
          <Field label="Show date">
            <input type="checkbox" checked={cfg.showDate ?? true}
              onChange={e => up({ showDate: e.target.checked })} />
          </Field>
          <Field label="Team name">
            <select className="field-input" value={cfg.nameDisplay ?? 'short'} onChange={e => up({ nameDisplay: e.target.value })}>
              <option value="short">Short name (falls back to full)</option>
              <option value="full">Full name</option>
            </select>
          </Field>
          <Field label="Widget size">
            <select className="field-input" value={cfg.compactSize ? 'compact' : 'normal'} onChange={e => up({ compactSize: e.target.value === 'compact' })}>
              <option value="normal">Bigger (default)</option>
              <option value="compact">Compact</option>
            </select>
          </Field>
          <Field label={`Saved results (${savedMatchResults.length})`}>
            <ConfirmButton
              className="btn btn--ghost btn--small"
              disabled={savedMatchResults.length === 0}
              label="Clear All"
              confirmLabel="Delete all"
              message="Delete all saved match results? This cannot be undone."
              onConfirm={clearMatchResults}
            />
          </Field>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 2px' }}>
            Results are added from a scoreboard widget's "💾 Save Result" button.
          </div>
        </>
      );

      case 'match-schedule': return (
        <>
          <Field label="Title">
            <input className="field-input" value={cfg.title ?? ''} placeholder="Upcoming Matches"
              onChange={e => up({ title: e.target.value })} />
          </Field>
          <Field label="Send To Scoreboard">
            <select className="field-input" value={cfg.linkedScoreboardId ?? ''} onChange={e => up({ linkedScoreboardId: e.target.value })}>
              <option value="">— none —</option>
              {pages.flatMap(p => p.widgets.filter(w => w.type === 'scoreboard')).map(w => (
                <option key={w.id} value={w.id}>{w.config.name || `Scoreboard (${w.config.teamAName || 'A'} vs ${w.config.teamBName || 'B'})`}</option>
              ))}
            </select>
          </Field>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 2px' }}>
            Manage fixtures in 🏆 DB → Schedule. Sent matches grey out here automatically.
          </div>
        </>
      );

      case 'input-tally': return (
        <>
          {renderInputPicker(
            'Input',
            cfg.inputKey ?? '',
            cfg.inputTitle,
            (key, title) => up({ inputKey: key, inputTitle: title }),
            undefined,
            allInputs,
          )}
          <Field label="Show Title">
            <input type="checkbox" checked={cfg.showTitle !== false} onChange={e => up({ showTitle: e.target.checked })} />
          </Field>
          <Field label="Show Type">
            <input type="checkbox" checked={cfg.showType !== false} onChange={e => up({ showType: e.target.checked })} />
          </Field>
        </>
      );

      case 'transitions': return (
        <>
          <Field label="Buttons">
            <div className="trans-picker">
              {TRANS_KEYS.map(key => (
                <label key={key} className="trans-picker-item">
                  <input type="checkbox"
                    checked={(cfg.buttons ?? ['cut','fade','auto']).includes(key)}
                    onChange={e => {
                      const current: string[] = cfg.buttons ?? ['cut','fade','auto'];
                      const next = e.target.checked ? [...current, key] : current.filter(k => k !== key);
                      up({ buttons: next });
                    }} />
                  {key.toUpperCase()}
                </label>
              ))}
            </div>
          </Field>
        </>
      );

      case 'score-log': {
        const linkedSb = cfg.linkedScoreboardId
          ? pages.flatMap(p => p.widgets).find(w => w.id === cfg.linkedScoreboardId)
          : null;
        const teamAName = linkedSb?.config.teamAName ?? 'Team A';
        const teamBName = linkedSb?.config.teamBName ?? 'Team B';
        const teamAColor = linkedSb?.config.teamAColor ?? '#e74c3c';
        const teamBColor = linkedSb?.config.teamBColor ?? '#3498db';
        return (
          <>
            <Field label="Linked Scoreboard">
              <select className="field-input" value={cfg.linkedScoreboardId ?? ''} onChange={e => up({ linkedScoreboardId: e.target.value })}>
                <option value="">— select scoreboard —</option>
                {pages.flatMap(p => p.widgets.filter(w => w.type === 'scoreboard')).map(w => (
                  <option key={w.id} value={w.id}>{w.config.teamAName ?? 'Team A'} vs {w.config.teamBName ?? 'Team B'}</option>
                ))}
              </select>
            </Field>
            <Field label="Show team">
              <div className="team-side-picker">
                {(['A', 'all', 'B'] as const).map(t => (
                  <button
                    key={t}
                    className={`team-side-btn ${(cfg.teamFilter ?? 'all') === t ? 'team-side-btn--active' : ''}`}
                    style={t !== 'all' ? { '--tc': t === 'A' ? teamAColor : teamBColor } as React.CSSProperties : undefined}
                    onClick={() => up({ teamFilter: t })}
                  >
                    {t === 'A' && <span className="team-side-dot" style={{ background: teamAColor }} />}
                    {t === 'B' && <span className="team-side-dot" style={{ background: teamBColor }} />}
                    {t === 'A' ? teamAName : t === 'B' ? teamBName : 'All'}
                  </button>
                ))}
              </div>
            </Field>
            <CollapsibleSection label="vMix Summary Output">
              <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                Sends a per-player score summary (jersey · name: count×action pts) to a vMix text field whenever the log changes.
              </p>
              <Field label="vMix Input">
                {renderInputPicker('sl_sum_input', cfg.vmixSummaryInputKey ?? '', cfg.vmixSummaryInputTitle,
                  (key, title) => up({ vmixSummaryInputKey: key, vmixSummaryInputTitle: title }),
                  undefined,
                  allInputs)}
              </Field>
              {cfg.vmixSummaryInputKey && (
                <Field label="Text Field">
                  {renderFieldPicker(cfg.vmixSummaryInputKey, cfg.vmixSummaryField ?? '', v => up({ vmixSummaryField: v }), 'Summary.Text', undefined, allInputs)}
                </Field>
              )}
            </CollapsibleSection>
            <Field label="Player Highlight Widget">
              <select className="field-input" value={cfg.linkedPlayerHighlightId ?? ''} onChange={e => up({ linkedPlayerHighlightId: e.target.value })}>
                <option value="">— none —</option>
                {pages.flatMap(p => p.widgets).filter(w => w.type === 'player-lower-third').map(w => (
                  <option key={w.id} value={w.id}>Player Highlight {w.id.slice(0, 6)}</option>
                ))}
              </select>
            </Field>
          </>
        );
      }

      case 'timeline': return (
        <>
          <Field label="Title">
            <input className="field-input" value={cfg.title ?? 'Match Timeline'} onChange={e => up({ title: e.target.value })} />
          </Field>
          <Field label="Linked Timer">
            <select className="field-input" value={cfg.linkedTimerWidgetId ?? ''} onChange={e => up({ linkedTimerWidgetId: e.target.value })}>
              <option value="">— wall clock —</option>
              {pages.flatMap(p => p.widgets.filter(w => w.type === 'timer')).map(w => (
                <option key={w.id} value={w.id}>{w.config.name || 'Timer'}</option>
              ))}
            </select>
          </Field>
          <Field label="Linked Scoreboard">
            <select className="field-input" value={cfg.linkedScoreboardId ?? ''} onChange={e => up({ linkedScoreboardId: e.target.value })}>
              <option value="">— none —</option>
              {pages.flatMap(p => p.widgets.filter(w => w.type === 'scoreboard')).map(w => (
                <option key={w.id} value={w.id}>{w.config.teamAName ?? 'Team A'} vs {w.config.teamBName ?? 'Team B'}</option>
              ))}
            </select>
          </Field>

          <CollapsibleSection label="Appearance">
            <Field label="Show team header">
              <label className="toggle-row">
                <input type="checkbox" checked={cfg.showTeamHeader ?? true} onChange={e => up({ showTeamHeader: e.target.checked })} />
                <span>Show team names bar</span>
              </label>
            </Field>
            <Field label="Background">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="color" value={cfg.bgColor || '#1a1a2e'} onChange={e => up({ bgColor: e.target.value })} style={{ width: 32, height: 28, border: 'none', cursor: 'pointer', background: 'none' }} />
                <button className="btn btn--small" onClick={() => up({ bgColor: '' })}>Clear</button>
              </div>
            </Field>
          </CollapsibleSection>

          <CollapsibleSection label="Font Sizes (px)">
            <Field label="Event label">
              <input type="number" className="field-input" min={6} max={32} value={cfg.fontSizeEvent ?? 11} onChange={e => up({ fontSizeEvent: +e.target.value })} />
            </Field>
            <Field label="Time bubble">
              <input type="number" className="field-input" min={6} max={32} value={cfg.fontSizeTime ?? 10} onChange={e => up({ fontSizeTime: +e.target.value })} />
            </Field>
            <Field label="Team names">
              <input type="number" className="field-input" min={6} max={32} value={cfg.fontSizeTeam ?? 11} onChange={e => up({ fontSizeTeam: +e.target.value })} />
            </Field>
            <Field label="Player name">
              <input type="number" className="field-input" min={6} max={32} value={cfg.fontSizePlayer ?? 10} onChange={e => up({ fontSizePlayer: +e.target.value })} />
            </Field>
          </CollapsibleSection>

          <CollapsibleSection label="Layout">
            <Field label="Row height (px)">
              <input type="number" className="field-input" min={20} max={120} value={cfg.rowMinHeight ?? 48} onChange={e => up({ rowMinHeight: +e.target.value })} />
            </Field>
            <Field label="Spine width (px)">
              <input type="number" className="field-input" min={0} max={8} value={cfg.spineWidth ?? 1} onChange={e => up({ spineWidth: +e.target.value })} />
            </Field>
            <Field label="Spine color">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="color" value={cfg.spineColor || '#2a2a3e'} onChange={e => up({ spineColor: e.target.value })} style={{ width: 32, height: 28, border: 'none', cursor: 'pointer', background: 'none' }} />
                <button className="btn btn--small" onClick={() => up({ spineColor: '' })}>Default</button>
              </div>
            </Field>
          </CollapsibleSection>

          <CollapsibleSection label="Time Bubble">
            <Field label="Height (px)">
              <input type="number" className="field-input" min={16} max={64} value={cfg.bubbleHeight ?? 24} onChange={e => up({ bubbleHeight: +e.target.value })} />
            </Field>
            <Field label="Background">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="color" value={cfg.bubbleBg || '#3498db'} onChange={e => up({ bubbleBg: e.target.value })} style={{ width: 32, height: 28, border: 'none', cursor: 'pointer', background: 'none' }} />
                <button className="btn btn--small" onClick={() => up({ bubbleBg: '' })}>Default</button>
              </div>
            </Field>
            <Field label="Text color">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="color" value={cfg.bubbleTextColor || '#ffffff'} onChange={e => up({ bubbleTextColor: e.target.value })} style={{ width: 32, height: 28, border: 'none', cursor: 'pointer', background: 'none' }} />
                <button className="btn btn--small" onClick={() => up({ bubbleTextColor: '' })}>Default</button>
              </div>
            </Field>
          </CollapsibleSection>

          <CollapsibleSection label="Data">
            <Field label="Clear events">
              <button className="btn btn--danger btn--small" onClick={() => { if (confirm('Clear all manual events?')) up({ events: [] }); }}>
                Clear manual events
              </button>
            </Field>
          </CollapsibleSection>
        </>
      );

      case 'player-list': {
        const timerWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'timer'));
        const timelineWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'timeline'));
        const hasPlaytime = Object.keys(cfg.accumulated ?? {}).length > 0 || (cfg.onField ?? []).length > 0;
        const scopedTeams = cfg.linkedTournamentId
          ? teamDbTeams.filter(t => t.tournamentId === cfg.linkedTournamentId)
          : teamDbTeams;
        return (
          <>
            <Field label="Tournament">
              <select className="field-input" value={cfg.linkedTournamentId ?? ''} onChange={e => up({ linkedTournamentId: e.target.value })}>
                <option value="">— select tournament (for periods/settings) —</option>
                {tournaments.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Team">
              <select className="field-input" value={cfg.linkedTeamId ?? ''} onChange={e => up({ linkedTeamId: e.target.value })}>
                <option value="">— select team —</option>
                {scopedTeams.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Player Highlight Widget">
              <select className="field-input" value={cfg.linkedPlayerHighlightId ?? ''} onChange={e => up({ linkedPlayerHighlightId: e.target.value })}>
                <option value="">— none —</option>
                {pages.flatMap(p => p.widgets).filter(w => w.type === 'player-lower-third').map(w => (
                  <option key={w.id} value={w.id}>Player Highlight {w.id.slice(0, 6)}</option>
                ))}
              </select>
            </Field>
            <Field label="Linked Timer">
              <select className="field-input" value={cfg.linkedTimerWidgetId ?? ''} onChange={e => up({ linkedTimerWidgetId: e.target.value })}>
                <option value="">— none —</option>
                {timerWidgets.map(w => <option key={w.id} value={w.id}>{w.config.name || 'Timer'}</option>)}
              </select>
            </Field>
            <Field label="Linked Timeline (for auto-log)">
              <select className="field-input" value={cfg.linkedTimelineId ?? ''} onChange={e => up({ linkedTimelineId: e.target.value })}>
                <option value="">— none —</option>
                {timelineWidgets.map(w => <option key={w.id} value={w.id}>{w.config.title || 'Timeline'}</option>)}
              </select>
            </Field>
            <CollapsibleSection label="vMix Team Title">
              {renderInputPicker('vMix Input', cfg.vmixTeamInputKey ?? '', cfg.vmixTeamInputTitle,
                (key, title) => up({ vmixTeamInputKey: key, vmixTeamInputTitle: title }),
              )}
              {cfg.vmixTeamInputKey && (
                <>
                  <Field label="Team name field">
                    {renderFieldPicker(cfg.vmixTeamInputKey ?? '', cfg.vmixTeamFieldName ?? 'TeamName.Text', v => up({ vmixTeamFieldName: v }), 'TeamName.Text')}
                  </Field>
                  <Field label="Short name field">
                    {renderFieldPicker(cfg.vmixTeamInputKey ?? '', cfg.vmixTeamFieldShort ?? '', v => up({ vmixTeamFieldShort: v }), 'ShortName.Text')}
                  </Field>
                  <Field label="Auto-sync on change">
                    <input type="checkbox" checked={cfg.vmixTeamAutoSync ?? false} onChange={e => up({ vmixTeamAutoSync: e.target.checked })} />
                  </Field>
                </>
              )}
            </CollapsibleSection>
            <CollapsibleSection label="vMix Name Sync">
            {(() => {
              type PlInput = { id: string; inputKey: string; inputTitle?: string; vmixNamePrefix: string; vmixJerseyPrefix: string; vmixAutoSync: boolean };
              const plInputs: PlInput[] = cfg.vmixInputs?.length
                ? cfg.vmixInputs
                : cfg.vmixInputKey
                  ? [{ id: 'legacy', inputKey: cfg.vmixInputKey, vmixNamePrefix: cfg.vmixNamePrefix ?? 'Name', vmixJerseyPrefix: cfg.vmixJerseyPrefix ?? '', vmixAutoSync: cfg.vmixAutoSync ?? false }]
                  : [];
              const setPlInputs = (next: PlInput[]) => up({ vmixInputs: next });
              const updatePl = (idx: number, patch: Partial<PlInput>) => setPlInputs(plInputs.map((p, i) => i === idx ? { ...p, ...patch } : p));
              return (
                <>
                  {plInputs.map((inp, idx) => {
                    const isVilCollapsed = vilCollapsed[inp.id] ?? false;
                    return (
                    <div key={inp.id} className="vil-cfg-block">
                      <div className="vil-cfg-header">
                        <button className="btn btn--ghost btn--small tf-collapse-btn"
                          onClick={() => setVilCollapsed(p => ({ ...p, [inp.id]: !p[inp.id] }))}
                          title={isVilCollapsed ? 'Expand' : 'Collapse'}>
                          {isVilCollapsed ? '▶' : '▼'}
                        </button>
                        <span className="vil-cfg-label">vMix Input {idx + 1}</span>
                        {plInputs.length > 1 && <button className="btn btn--ghost btn--small" onClick={() => setPlInputs(plInputs.filter((_, i) => i !== idx))}>×</button>}
                      </div>
                      {!isVilCollapsed && (<>
                        {renderInputPicker('vMix Input', inp.inputKey, inp.inputTitle,
                          (key, title) => updatePl(idx, { inputKey: key, inputTitle: title }),
                          undefined, allInputs,
                        )}
                      </>)}
                      {inp.inputKey && (
                        <>
                          <Field label="Name prefix">
                            {renderFieldPicker(
                              inp.inputKey,
                              inp.vmixNamePrefix ? `${inp.vmixNamePrefix}1.Text` : '',
                              (v) => updatePl(idx, { vmixNamePrefix: v.replace(/\.Text$/i, '').replace(/\d+$/, '') }),
                              'Pick Name1.Text → auto-prefix',
                              undefined, allInputs,
                            )}
                          </Field>
                          <Field label="Jersey No prefix">
                            {renderFieldPicker(
                              inp.inputKey,
                              inp.vmixJerseyPrefix ? `${inp.vmixJerseyPrefix}1.Text` : '',
                              (v) => updatePl(idx, { vmixJerseyPrefix: v.replace(/\.Text$/i, '').replace(/\d+$/, '') }),
                              'Pick Jersey1.Text → auto-prefix',
                              undefined, allInputs,
                            )}
                          </Field>
                          <Field label="Auto-sync on edit">
                            <input type="checkbox" checked={inp.vmixAutoSync} onChange={e => updatePl(idx, { vmixAutoSync: e.target.checked })} />
                          </Field>
                        </>
                      )}
                    </div>
                    );
                  })}
                  <button className="btn btn--ghost btn--small" onClick={() => setPlInputs([...plInputs, { id: crypto.randomUUID(), inputKey: '', vmixNamePrefix: 'Name', vmixJerseyPrefix: '', vmixAutoSync: false }])}>+ Add vMix Input</button>
                </>
              );
            })()}
            </CollapsibleSection>
            <CollapsibleSection label="vMix Staff Names">
              <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                Sends Manager (MNG) and Head Coach (HC) names to vMix text fields.
              </p>
              <Field label="vMix Input">
                {renderInputPicker('vmix_staff_input', cfg.vmixStaffInputKey ?? '', cfg.vmixStaffInputTitle,
                  (key, title) => up({ vmixStaffInputKey: key, vmixStaffInputTitle: title }))}
              </Field>
              {cfg.vmixStaffInputKey && (
                <>
                  <Field label="Manager field">
                    {renderFieldPicker(cfg.vmixStaffInputKey, cfg.vmixManagerField ?? '', v => up({ vmixManagerField: v }), 'Manager.Text')}
                  </Field>
                  <Field label="Head Coach field">
                    {renderFieldPicker(cfg.vmixStaffInputKey, cfg.vmixHCField ?? '', v => up({ vmixHCField: v }), 'HeadCoach.Text')}
                  </Field>
                  <Field label="Auto-sync on edit">
                    <input type="checkbox" checked={cfg.vmixStaffAutoSync ?? false} onChange={e => up({ vmixStaffAutoSync: e.target.checked })} />
                  </Field>
                </>
              )}
            </CollapsibleSection>
            <CollapsibleSection label="Display">
            <Field label="Show time played">
              <input type="checkbox" checked={cfg.showTime !== false} onChange={e => up({ showTime: e.target.checked })} />
            </Field>
            <Field label="Show position">
              <input type="checkbox" checked={cfg.showPosition !== false} onChange={e => up({ showPosition: e.target.checked })} />
            </Field>
            <Field label="Show card buttons">
              <input type="checkbox" checked={cfg.showCards !== false} onChange={e => up({ showCards: e.target.checked })} />
            </Field>
            <Field label="Sin bin duration (min)">
              <input
                className="field-input"
                type="number"
                min={1} max={30} step={1}
                value={Math.round((cfg.sinBinDuration ?? 600000) / 60000)}
                onChange={e => up({ sinBinDuration: Number(e.target.value) * 60000 })}
              />
            </Field>
            </CollapsibleSection>
            {hasPlaytime && (
              <CollapsibleSection label="Session Data">
                <Field label="Reset playtime">
                  <button className="btn btn--danger btn--small"
                    onClick={() => { if (confirm('Reset all playtime data?')) up({ onField: [], entries: {}, accumulated: {} }); }}>
                    ↺ Clear session
                  </button>
                </Field>
              </CollapsibleSection>
            )}
          </>
        );
      }

      case 'substitution': {
        const allPlayerListWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'player-list'));
        const timerWidgets2 = pages.flatMap(p => p.widgets.filter(w => w.type === 'timer'));
        const timelineWidgets2 = pages.flatMap(p => p.widgets.filter(w => w.type === 'timeline'));
        const scopedTeams2 = cfg.linkedTournamentId
          ? teamDbTeams.filter(t => t.tournamentId === cfg.linkedTournamentId)
          : teamDbTeams;
        return (
          <>
            <Field label="Player List Widget">
              <select className="field-input" value={cfg.linkedPlayerListId ?? ''} onChange={e => {
                const plw = allPlayerListWidgets.find(w => w.id === e.target.value);
                up({ linkedPlayerListId: e.target.value, linkedTournamentId: plw?.config.linkedTournamentId ?? cfg.linkedTournamentId, linkedTeamId: plw?.config.linkedTeamId ?? cfg.linkedTeamId });
              }}>
                <option value="">— select widget —</option>
                {allPlayerListWidgets.map(w => <option key={w.id} value={w.id}>{plWidgetLabel(w, teamDbTeams)}</option>)}
              </select>
            </Field>
            {!cfg.linkedPlayerListId && (
              <>
                <Field label="Tournament">
                  <select className="field-input" value={cfg.linkedTournamentId ?? ''} onChange={e => up({ linkedTournamentId: e.target.value })}>
                    <option value="">— select tournament (for periods/settings) —</option>
                    {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
                <Field label="Team">
                  <select className="field-input" value={cfg.linkedTeamId ?? ''} onChange={e => up({ linkedTeamId: e.target.value })}>
                    <option value="">— select team —</option>
                    {scopedTeams2.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
              </>
            )}
            <Field label="Linked Timer">
              <select className="field-input" value={cfg.linkedTimerWidgetId ?? ''} onChange={e => up({ linkedTimerWidgetId: e.target.value })}>
                <option value="">— none —</option>
                {timerWidgets2.map(w => <option key={w.id} value={w.id}>{w.config.name || 'Timer'}</option>)}
              </select>
            </Field>
            <Field label="Linked Timeline">
              <select className="field-input" value={cfg.linkedTimelineId ?? ''} onChange={e => up({ linkedTimelineId: e.target.value })}>
                <option value="">— none —</option>
                {timelineWidgets2.map(w => <option key={w.id} value={w.id}>{w.config.title || 'Timeline'}</option>)}
              </select>
            </Field>
            <CollapsibleSection label="vMix Sub Overlay">
            {(() => {
              type SubInput = { id: string; inputKey: string; inputTitle?: string; vmixFieldOut: string; vmixFieldIn: string };
              const subInputs: SubInput[] = cfg.vmixInputs?.length
                ? cfg.vmixInputs
                : cfg.vmixInputKey
                  ? [{ id: 'legacy', inputKey: cfg.vmixInputKey, vmixFieldOut: cfg.vmixFieldOut ?? 'PlayerOff.Text', vmixFieldIn: cfg.vmixFieldIn ?? 'PlayerOn.Text' }]
                  : [];
              const setSubInputs = (next: SubInput[]) => up({ vmixInputs: next });
              const updateSub = (idx: number, patch: Partial<SubInput>) => setSubInputs(subInputs.map((s, i) => i === idx ? { ...s, ...patch } : s));
              return (
                <>
                  {subInputs.map((inp, idx) => {
                    const isVilCollapsed = vilCollapsed[inp.id] ?? false;
                    return (
                    <div key={inp.id} className="vil-cfg-block">
                      <div className="vil-cfg-header">
                        <button className="btn btn--ghost btn--small tf-collapse-btn"
                          onClick={() => setVilCollapsed(p => ({ ...p, [inp.id]: !p[inp.id] }))}
                          title={isVilCollapsed ? 'Expand' : 'Collapse'}>
                          {isVilCollapsed ? '▶' : '▼'}
                        </button>
                        <span className="vil-cfg-label">vMix Input {idx + 1}</span>
                        {subInputs.length > 1 && <button className="btn btn--ghost btn--small" onClick={() => setSubInputs(subInputs.filter((_, i) => i !== idx))}>×</button>}
                      </div>
                      {!isVilCollapsed && (<>
                      {renderInputPicker('vMix Input', inp.inputKey, inp.inputTitle,
                        (key, title) => updateSub(idx, { inputKey: key, inputTitle: title }),
                        undefined, allInputs,
                      )}
                      {inp.inputKey && (
                        <>
                          <Field label="Player Off field">
                            {renderFieldPicker(inp.inputKey, inp.vmixFieldOut, v => updateSub(idx, { vmixFieldOut: v }), 'PlayerOff.Text', undefined, allInputs)}
                          </Field>
                          <Field label="Player On field">
                            {renderFieldPicker(inp.inputKey, inp.vmixFieldIn, v => updateSub(idx, { vmixFieldIn: v }), 'PlayerOn.Text', undefined, allInputs)}
                          </Field>
                        </>
                      )}
                      </>)}
                    </div>
                    );
                  })}
                  <button className="btn btn--ghost btn--small" onClick={() => setSubInputs([...subInputs, { id: crypto.randomUUID(), inputKey: '', vmixFieldOut: 'PlayerOff.Text', vmixFieldIn: 'PlayerOn.Text' }])}>+ Add vMix Input</button>
                </>
              );
            })()}
            </CollapsibleSection>
          </>
        );
      }

      case 'card-display': {
        const playerListWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'player-list'));
        const plLabel = (w: { id: string; config: Record<string, any> }) => plWidgetLabel(w, teamDbTeams);
        return (
          <>
            <Field label="Team A — Player List">
              <select className="field-input" value={cfg.linkedPlayerListA ?? ''} onChange={e => up({ linkedPlayerListA: e.target.value })}>
                <option value="">— select —</option>
                {playerListWidgets.map(w => <option key={w.id} value={w.id}>{plLabel(w)}</option>)}
              </select>
            </Field>
            <Field label="Team B — Player List">
              <select className="field-input" value={cfg.linkedPlayerListB ?? ''} onChange={e => up({ linkedPlayerListB: e.target.value })}>
                <option value="">— select —</option>
                {playerListWidgets.map(w => <option key={w.id} value={w.id}>{plLabel(w)}</option>)}
              </select>
            </Field>
            <Field label="Show player names">
              <input type="checkbox" checked={cfg.showNames !== false} onChange={e => up({ showNames: e.target.checked })} />
            </Field>
            <CollapsibleSection label="vMix Title Sync">
            {(() => {
              type CdInput = { id: string; inputKey: string; inputTitle?: string; vmixFieldSinBinA: string; vmixFieldSinBinB: string; vmixFieldRedA: string; vmixFieldRedB: string };
              const cdInputs: CdInput[] = cfg.vmixInputs?.length
                ? cfg.vmixInputs
                : cfg.vmixInputKey
                  ? [{ id: 'legacy', inputKey: cfg.vmixInputKey, vmixFieldSinBinA: cfg.vmixFieldSinBinA ?? '', vmixFieldSinBinB: cfg.vmixFieldSinBinB ?? '', vmixFieldRedA: cfg.vmixFieldRedA ?? '', vmixFieldRedB: cfg.vmixFieldRedB ?? '' }]
                  : [];
              const setCdInputs = (next: CdInput[]) => up({ vmixInputs: next });
              const updateCd = (idx: number, patch: Partial<CdInput>) => setCdInputs(cdInputs.map((c, i) => i === idx ? { ...c, ...patch } : c));
              return (
                <>
                  <Field label="Auto-sync">
                    <input type="checkbox" checked={cfg.vmixAutoSync ?? false} onChange={e => up({ vmixAutoSync: e.target.checked })} />
                  </Field>
                  {cdInputs.map((inp, idx) => {
                    const isVilCollapsed = vilCollapsed[inp.id] ?? false;
                    return (
                    <div key={inp.id} className="vil-cfg-block">
                      <div className="vil-cfg-header">
                        <button className="btn btn--ghost btn--small tf-collapse-btn"
                          onClick={() => setVilCollapsed(p => ({ ...p, [inp.id]: !p[inp.id] }))}
                          title={isVilCollapsed ? 'Expand' : 'Collapse'}>
                          {isVilCollapsed ? '▶' : '▼'}
                        </button>
                        <span className="vil-cfg-label">vMix Input {idx + 1}</span>
                        {cdInputs.length > 1 && <button className="btn btn--ghost btn--small" onClick={() => setCdInputs(cdInputs.filter((_, i) => i !== idx))}>×</button>}
                      </div>
                      {!isVilCollapsed && (<>
                      {renderInputPicker('vMix Input', inp.inputKey, inp.inputTitle,
                        (key, title) => updateCd(idx, { inputKey: key, inputTitle: title }),
                        undefined, allInputs,
                      )}
                      {inp.inputKey && (
                        <>
                          <div className="config-section-label" style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>Sin bin fields</div>
                          <Field label="Team A sin bin">{renderFieldPicker(inp.inputKey, inp.vmixFieldSinBinA, v => updateCd(idx, { vmixFieldSinBinA: v }), 'SinBinA.Text', undefined, allInputs)}</Field>
                          <Field label="Team B sin bin">{renderFieldPicker(inp.inputKey, inp.vmixFieldSinBinB, v => updateCd(idx, { vmixFieldSinBinB: v }), 'SinBinB.Text', undefined, allInputs)}</Field>
                          <div className="config-section-label" style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>Red card fields</div>
                          <Field label="Team A red card">{renderFieldPicker(inp.inputKey, inp.vmixFieldRedA, v => updateCd(idx, { vmixFieldRedA: v }), 'RedA.Text', undefined, allInputs)}</Field>
                          <Field label="Team B red card">{renderFieldPicker(inp.inputKey, inp.vmixFieldRedB, v => updateCd(idx, { vmixFieldRedB: v }), 'RedB.Text', undefined, allInputs)}</Field>
                        </>
                      )}
                      </>)}
                    </div>
                    );
                  })}
                  <button className="btn btn--ghost btn--small" onClick={() => setCdInputs([...cdInputs, { id: crypto.randomUUID(), inputKey: '', vmixFieldSinBinA: '', vmixFieldSinBinB: '', vmixFieldRedA: '', vmixFieldRedB: '' }])}>+ Add vMix Input</button>
                </>
              );
            })()}
            </CollapsibleSection>
          </>
        );
      }

      case 'card-lower-third': {
        const playerListWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'player-list'));
        const plLabel = (w: any) => plWidgetLabel(w, teamDbTeams);
        return (
          <>
            <CollapsibleSection label="Teams">
              <Field label="Team A — Player List">
                <select className="field-input" value={cfg.linkedPlayerListA ?? ''} onChange={e => up({ linkedPlayerListA: e.target.value })}>
                  <option value="">— select player list —</option>
                  {playerListWidgets.map(w => <option key={w.id} value={w.id}>{plLabel(w)}</option>)}
                </select>
              </Field>
              <Field label="Team B — Player List">
                <select className="field-input" value={cfg.linkedPlayerListB ?? ''} onChange={e => up({ linkedPlayerListB: e.target.value })}>
                  <option value="">— select player list —</option>
                  {playerListWidgets.map(w => <option key={w.id} value={w.id}>{plLabel(w)}</option>)}
                </select>
              </Field>
              <Field label="Auto-send on change">
                <label className="tf-autosend-label">
                  <input type="checkbox" checked={cfg.autoSend ?? false} onChange={e => up({ autoSend: e.target.checked })} />
                  Send automatically when player changes
                </label>
              </Field>
            </CollapsibleSection>

            <CollapsibleSection label="Yellow Card — vMix Input">
              {renderInputPicker('vMix Input', cfg.vmixInputKeyYellow ?? '', cfg.vmixInputTitleYellow,
                (key, title) => up({ vmixInputKeyYellow: key, vmixInputTitleYellow: title }),
                (i: any) => i.type === 'GT',
                allInputs,
              )}
            </CollapsibleSection>
            <CollapsibleSection label="Orange Card — vMix Input">
              {renderInputPicker('vMix Input', cfg.vmixInputKeyOrange ?? '', cfg.vmixInputTitleOrange,
                (key, title) => up({ vmixInputKeyOrange: key, vmixInputTitleOrange: title }),
                (i: any) => i.type === 'GT',
                allInputs,
              )}
            </CollapsibleSection>
            <CollapsibleSection label="Red Card — vMix Input">
              {renderInputPicker('vMix Input', cfg.vmixInputKeyRed ?? '', cfg.vmixInputTitleRed,
                (key, title) => up({ vmixInputKeyRed: key, vmixInputTitleRed: title }),
                (i: any) => i.type === 'GT',
                allInputs,
              )}
            </CollapsibleSection>
            {(cfg.vmixInputKeyYellow || cfg.vmixInputKeyOrange || cfg.vmixInputKeyRed) && (
              <CollapsibleSection label="Field Mapping">
                <Field label="Jersey No. field">{renderFieldPicker(cfg.vmixInputKeyYellow ?? cfg.vmixInputKeyOrange ?? cfg.vmixInputKeyRed, cfg.fieldJersey ?? 'Jersey.Text', v => up({ fieldJersey: v }), 'Jersey.Text', undefined, allInputs)}</Field>
                <Field label="Name field">{renderFieldPicker(cfg.vmixInputKeyYellow ?? cfg.vmixInputKeyOrange ?? cfg.vmixInputKeyRed, cfg.fieldName ?? 'Name.Text', v => up({ fieldName: v }), 'Name.Text', undefined, allInputs)}</Field>
                <Field label="Team name field">{renderFieldPicker(cfg.vmixInputKeyYellow ?? cfg.vmixInputKeyOrange ?? cfg.vmixInputKeyRed, cfg.fieldTeam ?? 'Team.Text', v => up({ fieldTeam: v }), 'Team.Text', undefined, allInputs)}</Field>
                <Field label="Card type field">{renderFieldPicker(cfg.vmixInputKeyYellow ?? cfg.vmixInputKeyOrange ?? cfg.vmixInputKeyRed, cfg.fieldCardType ?? 'Card.Text', v => up({ fieldCardType: v }), 'Card.Text', undefined, allInputs)}</Field>
              </CollapsibleSection>
            )}

            <CollapsibleSection label="Overlay">
              <Field label="Overlay Channel">
                <select className="field-input" value={cfg.overlayChannel ?? 1} onChange={e => up({ overlayChannel: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>Overlay {n}</option>)}
                </select>
              </Field>
            </CollapsibleSection>
          </>
        );
      }

      case 'ndi-input': return (
        <>
          <CollapsibleSection label="NDI Input">
            <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '0 0 6px' }}>
              Save NDI source names from the widget itself. Use the format your network shows, e.g. <em>LAPTOP (Camera 1)</em>.
            </p>
          </CollapsibleSection>
          <CollapsibleSection label="Live Preview">
            <Field label="Bandwidth">
              <select className="field-input" value={cfg.ndiLowBandwidth ? 'low' : 'highest'}
                onChange={e => up({ ndiLowBandwidth: e.target.value === 'low' })}>
                <option value="highest">Highest quality</option>
                <option value="low">Low bandwidth</option>
              </select>
            </Field>
            <Field label="Speed (fps)">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="range" min={1} max={30} step={1} className="field-range"
                  value={cfg.ndiFps ?? 15} onChange={e => up({ ndiFps: Number(e.target.value) })} />
                <span style={{ minWidth: 32, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{cfg.ndiFps ?? 15}fps</span>
              </div>
            </Field>
            <Field label="Quality">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="range" min={10} max={100} step={5} className="field-range"
                  value={cfg.ndiQuality ?? 75} onChange={e => up({ ndiQuality: Number(e.target.value) })} />
                <span style={{ minWidth: 32, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{cfg.ndiQuality ?? 75}</span>
              </div>
            </Field>
          </CollapsibleSection>
        </>
      );

      case 'panel': {
        const panelItems: Array<Record<string, any>> = cfg.items ?? [];
        const upItems = (items: Array<Record<string, any>>) => up({ items });
        const addItem = (type: 'command' | 'input' | 'text') => {
          const id = crypto.randomUUID();
          upItems([...panelItems, { id, type }]);
          setPanelExpandedId(id);
        };
        const delItem = (id: string) => {
          upItems(panelItems.filter(i => i.id !== id));
          if (panelExpandedId === id) setPanelExpandedId(null);
        };
        const patchItem = (id: string, patch: Record<string, any>) =>
          upItems(panelItems.map(i => i.id === id ? { ...i, ...patch } : i));
        const moveItem = (id: string, dir: -1 | 1) => {
          const idx = panelItems.findIndex(i => i.id === id);
          if (idx < 0) return;
          const next = [...panelItems];
          const swap = idx + dir;
          if (swap < 0 || swap >= next.length) return;
          [next[idx], next[swap]] = [next[swap], next[idx]];
          upItems(next);
        };
        const TYPE_ICONS: Record<string, string> = { command: '▶', input: '⬡', text: 'T' };
        const TYPE_LABELS: Record<string, string> = { command: 'Command', input: 'Input', text: 'Text Field' };
        return (
          <>
            <CollapsibleSection label="Items">
            {panelItems.length === 0 && (
              <p className="config-no-settings" style={{ marginBottom: 6 }}>No items yet — add below</p>
            )}
            {panelItems.map((item, idx) => {
              const expanded = panelExpandedId === item.id;
              const preview = item.label || item.fn || item.fieldName || item.inputKey || '—';
              return (
                <div key={item.id} className="wgt-panel-cfg-item">
                  <div className="wgt-panel-cfg-row" onClick={() => setPanelExpandedId(expanded ? null : item.id)}>
                    <span className="wgt-panel-cfg-type">{TYPE_ICONS[item.type]}</span>
                    <span className="wgt-panel-cfg-preview">{TYPE_LABELS[item.type]}: {preview}</span>
                    <div className="wgt-panel-cfg-actions" onClick={e => e.stopPropagation()}>
                      <button className="wgt-panel-cfg-move" disabled={idx === 0} onClick={() => moveItem(item.id, -1)}>↑</button>
                      <button className="wgt-panel-cfg-move" disabled={idx === panelItems.length - 1} onClick={() => moveItem(item.id, 1)}>↓</button>
                      <button className="wgt-panel-cfg-del" onClick={() => delItem(item.id)}>×</button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="wgt-panel-cfg-edit">
                      <Field label="Label">
                        <input className="field-input" value={item.label ?? ''} placeholder="Display label" onChange={e => patchItem(item.id, { label: e.target.value })} />
                      </Field>

                      {item.type === 'command' && (
                        <>
                          <Field label="vMix Function">
                            <input className="field-input" value={item.fn ?? ''} placeholder="e.g. Cut, Fade, StartRecording" onChange={e => patchItem(item.id, { fn: e.target.value })} />
                          </Field>
                          <Field label="Value (optional)">
                            <input className="field-input" value={item.fnValue ?? ''} placeholder="Value param" onChange={e => patchItem(item.id, { fnValue: e.target.value })} />
                          </Field>
                          <Field label="Color">
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {PRESET_COLORS.map(c => (
                                <button key={c} onClick={() => patchItem(item.id, { color: c })}
                                  style={{ width: 18, height: 18, borderRadius: 3, background: c, border: item.color === c ? '2px solid #fff' : '1px solid #0004', cursor: 'pointer' }} />
                              ))}
                            </div>
                          </Field>
                        </>
                      )}

                      {item.type === 'input' && (
                        <Field label="vMix Input">
                          <select className="field-input" value={item.inputKey ?? ''} onChange={e => patchItem(item.id, { inputKey: e.target.value })}>
                            <option value="">— select input —</option>
                            {allInputs.map(i => <option key={i.key} value={i.key}>{i.number}. {i.title}</option>)}
                          </select>
                        </Field>
                      )}

                      {item.type === 'text' && (
                        <>
                          <Field label="vMix Title Input">
                            <select className="field-input" value={item.textInputKey ?? ''} onChange={e => patchItem(item.id, { textInputKey: e.target.value })}>
                              <option value="">— select input —</option>
                              {allInputs.filter(i => i.type === 'GT').map(i => <option key={i.key} value={i.key}>{i.number}. {i.title}</option>)}
                            </select>
                          </Field>
                          <Field label="Field Name">{renderFieldPicker(item.textInputKey ?? '', item.fieldName ?? '', v => patchItem(item.id, { fieldName: v }), 'Name.Text')}</Field>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <div className="wgt-panel-cfg-add">
              <button className="wgt-panel-cfg-add-btn" onClick={() => addItem('command')}>+ Command</button>
              <button className="wgt-panel-cfg-add-btn" onClick={() => addItem('input')}>+ Input</button>
              <button className="wgt-panel-cfg-add-btn" onClick={() => addItem('text')}>+ Text Field</button>
            </div>
            </CollapsibleSection>
          </>
        );
      }

      case 'vmix-titles': {
        type VTEntry = string | { name: string; type: 'source' };
        type VTInput = { id: string; inputKey: string; label?: string; name?: string; fields: VTEntry[] };
        const vtFName = (f: VTEntry) => typeof f === 'string' ? f : f.name;
        const vtFType = (f: VTEntry): 'text' | 'source' => typeof f === 'string' ? 'text' : (f.type ?? 'text');
        const vtInputs: VTInput[] = cfg.inputs ?? [];
        const setVTInputs = (next: VTInput[]) => up({ inputs: next });
        const updateVT = (idx: number, patch: Partial<VTInput>) =>
          setVTInputs(vtInputs.map((g, i) => i === idx ? { ...g, ...patch } : g));

        return (
          <>
            <CollapsibleSection label="vMix Titles">
            <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                <input type="checkbox" checked={cfg.showThumbs ?? true}
                  onChange={e => up({ showThumbs: e.target.checked })} />
                Show thumbnails
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                <input type="checkbox" checked={cfg.autoSend ?? false}
                  onChange={e => up({ autoSend: e.target.checked })} />
                Auto-send
              </label>
            </div>

            {vtInputs.map((grp, gi) => {
              const isCollapsed = vtCollapsed[grp.id] ?? false;
              return (
                <div key={grp.id} className="tf-group-block">
                  <div className="tf-group-header">
                    <button
                      className="btn btn--ghost btn--small tf-collapse-btn"
                      onClick={() => setVTCollapsed(prev => ({ ...prev, [grp.id]: !prev[grp.id] }))}
                      title={isCollapsed ? 'Expand' : 'Collapse'}>
                      {isCollapsed ? '▶' : '▼'}
                    </button>
                    <input
                      className="tf-group-name-input"
                      value={grp.name ?? ''}
                      placeholder={`vMix Title Input ${gi + 1}`}
                      onChange={e => updateVT(gi, { name: e.target.value })}
                    />
                    <button className="btn btn--ghost btn--small tf-field-del"
                      onClick={() => setVTInputs(vtInputs.filter((_, i) => i !== gi))}>×</button>
                  </div>

                  {!isCollapsed && (<>
                    {renderInputPicker('vMix Input', grp.inputKey, grp.label,
                      (key, title) => {
                        const inp = allInputs.find(i => i.key === key);
                        updateVT(gi, {
                          inputKey: key,
                          label: title,
                          fields: inp?.textFields?.length
                            ? inp.textFields.map((f: { name: string }) => f.name)
                            : grp.fields.length ? grp.fields : ['Title.Text'],
                        });
                      },
                      undefined,
                      allInputs,
                    )}

                    <Field label="Display Label (optional)">
                      <input className="field-input" value={grp.label ?? ''}
                        placeholder="Defaults to vMix input name"
                        onChange={e => updateVT(gi, { label: e.target.value })} />
                    </Field>

                    <div className="tf-fields-editor">
                      {grp.fields.map((f, fi) => (
                        <div key={fi} className="tf-field-row">
                          <FieldPickerDropdown
                            inputKey={grp.inputKey}
                            value={vtFName(f)}
                            onChange={v => {
                              const next = [...grp.fields];
                              next[fi] = vtFType(f) === 'source' ? { name: v, type: 'source' } : v;
                              updateVT(gi, { fields: next });
                            }}
                            placeholder="FieldName.Text"
                            allInputs={allInputs}
                          />
                          <button
                            className={`btn btn--small${vtFType(f) === 'source' ? '' : ' btn--ghost'}`}
                            title={vtFType(f) === 'source' ? 'Source (image) field — click to switch to Text' : 'Text field — click to switch to Source'}
                            style={{ minWidth: 22, padding: '0 4px', fontSize: 10 }}
                            onClick={() => {
                              const next = [...grp.fields];
                              const name = vtFName(f);
                              next[fi] = vtFType(f) === 'text' ? { name, type: 'source' } : name;
                              updateVT(gi, { fields: next });
                            }}>
                            {vtFType(f) === 'source' ? 'S' : 'T'}
                          </button>
                          <button className="btn btn--ghost btn--small tf-field-del"
                            onClick={() => updateVT(gi, { fields: grp.fields.filter((_, i) => i !== fi) })}
                            disabled={grp.fields.length === 1}>×</button>
                        </div>
                      ))}
                      <button className="btn btn--ghost btn--small" style={{ alignSelf: 'flex-start', marginTop: 2 }}
                        onClick={() => updateVT(gi, { fields: [...grp.fields, ''] })}>
                        + Add Field
                      </button>
                    </div>
                  </>)}
                </div>
              );
            })}

            <button className="btn btn--ghost btn--small"
              onClick={() => setVTInputs([...vtInputs, { id: crypto.randomUUID(), inputKey: '', fields: ['Title.Text'] }])}>
              + Add Input
            </button>
            </CollapsibleSection>
          </>
        );
      }

      case 'rugby-lineup': {
        const allPlayerListWidgets = pages.flatMap(p => p.widgets.filter(w => w.type === 'player-list'));
        const scopedTeams3 = cfg.linkedTournamentId
          ? teamDbTeams.filter(t => t.tournamentId === cfg.linkedTournamentId)
          : teamDbTeams;
        const linkedTeam = teamDbTeams.find(t => t.id === cfg.linkedTeamId);
        const loadFromTournament = () => {
          if (!linkedTeam) return;
          const currentPlayers: any[] = cfg.players ?? [];
          const updated = currentPlayers.map((p: any, i: number) => {
            const match = linkedTeam.players[i];
            return match ? { ...p, name: match.name, jerseyNo: match.jerseyNo || undefined } : p;
          });
          up({ teamName: linkedTeam.name, players: updated });
        };
        return (
          <>
            <Field label="Player List">
              <select
                className="field-input"
                value={cfg.linkedPlayerListId ?? ''}
                onChange={e => {
                  const plw = allPlayerListWidgets.find(w => w.id === e.target.value);
                  up({
                    linkedPlayerListId: e.target.value || undefined,
                    linkedTournamentId: plw?.config.linkedTournamentId ?? cfg.linkedTournamentId,
                    linkedTeamId: plw?.config.linkedTeamId ?? cfg.linkedTeamId,
                  });
                }}
              >
                <option value="">— none (manual names) —</option>
                {allPlayerListWidgets.map(w => (
                  <option key={w.id} value={w.id}>{plWidgetLabel(w, teamDbTeams)}</option>
                ))}
              </select>
            </Field>
            <Field label="Tournament">
              <select className="field-input" value={cfg.linkedTournamentId ?? ''}
                onChange={e => up({ linkedTournamentId: e.target.value })}>
                <option value="">— select tournament —</option>
                {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Team">
              <select className="field-input" value={cfg.linkedTeamId ?? ''}
                onChange={e => {
                  const t = teamDbTeams.find(t2 => t2.id === e.target.value);
                  up({ linkedTeamId: e.target.value, ...(t ? { teamName: t.name } : {}) });
                }}>
                <option value="">— select team —</option>
                {scopedTeams3.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            {linkedTeam && !cfg.linkedPlayerListId && (
              <Field label="Players">
                <button className="btn btn--secondary btn--small" onClick={loadFromTournament}>
                  Load names from {linkedTeam.name}
                </button>
              </Field>
            )}
          </>
        );
      }

      default: return <p className="config-no-settings">No settings for this widget type.</p>;
    }
  };

  return (
    <div
      className={`config-panel${panelCollapsed ? ' config-panel--collapsed' : ''}`}
      style={{ left: pos.x, top: pos.y, width: pos.w, height: panelCollapsed ? undefined : pos.h } as React.CSSProperties}
    >
      <div
        className="config-panel-header"
        onPointerDown={onPanelDragDown}
        onPointerMove={onPanelDragMove}
        onPointerUp={onPanelDragUp}
      >
        <span className="config-panel-header-icon">{WIDGET_TYPE_ICONS[widget.type]}</span>
        <input
          key={widget.id}
          className="config-panel-title-input"
          defaultValue={widget.label ?? ''}
          placeholder={WIDGET_TYPE_LABELS[widget.type]}
          onBlur={e => updateWidget(widget.id, { label: e.target.value.trim() || undefined })}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          <button className="btn btn--ghost btn--small" title={panelCollapsed ? 'Expand' : 'Collapse'}
            onClick={() => setPanelCollapsed(c => !c)}>
            {panelCollapsed ? '▶' : '▼'}
          </button>
          <button className="btn btn--ghost btn--small" title="Duplicate"
            onClick={() => { duplicateWidget(widget.id); onClose(); }}>⧉</button>
          <button className="btn btn--danger btn--small" title="Delete"
            onClick={() => { deleteWidget(widget.id); selectWidget(null); onClose(); }}>⌫</button>
          <button className="config-panel-close" onClick={onClose}>×</button>
        </div>
      </div>
      {!panelCollapsed && (
        <div className="config-panel-body">
          {renderConfig()}
          <CollapsibleSection label="Widget Appearance" defaultOpen={false}>
            <Field label="Theme">
              <select
                className="field-input"
                value={cfg.widgetTheme ?? 'inherit'}
                onChange={e => up({ widgetTheme: e.target.value === 'inherit' ? undefined : e.target.value })}
              >
                <option value="inherit">Inherit app theme</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </Field>
            <Field label="Accent Color">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="color"
                  value={cfg.widgetAccent ?? '#4a90d9'}
                  onChange={e => up({ widgetAccent: e.target.value })}
                  style={{ width: 36, height: 28, padding: 2, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-2)', cursor: 'pointer', flexShrink: 0 }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                  {cfg.widgetAccent ?? 'default'}
                </span>
                {cfg.widgetAccent && (
                  <button
                    className="btn btn--ghost btn--small"
                    style={{ marginLeft: 'auto', fontSize: 10 }}
                    onClick={() => up({ widgetAccent: undefined })}
                  >Reset</button>
                )}
              </div>
            </Field>
          </CollapsibleSection>
        </div>
      )}
      <div
        className="config-panel-resize-x"
        onPointerDown={onResizeXDown}
        onPointerMove={onResizeXMove}
        onPointerUp={onResizeXUp}
      />
      {!panelCollapsed && (
        <div
          className="config-panel-resize-br"
          onPointerDown={onResizeBRDown}
          onPointerMove={onResizeBRMove}
          onPointerUp={onResizeBRUp}
        />
      )}
    </div>
  );
}
