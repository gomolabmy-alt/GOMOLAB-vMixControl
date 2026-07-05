import { useState } from 'react';
import { useVmixStore } from '../../stores/vmixStore';
import { useCanvasStore } from '../../stores/canvasStore';

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

type ActionItem = { fn: string; params: Record<string, string> };
type SideButton = { id: string; label: string; color?: string; textColor?: string; fontSize?: number; mode?: string; actions: ActionItem[]; releaseActions?: ActionItem[] };

function isApp(fn: string) { return fn?.startsWith('App.'); }

function getActions(
  actions: ActionItem[] | undefined,
  legacyFn: string | undefined,
  legacyParams: Record<string, string> | undefined,
): ActionItem[] {
  if (actions?.length) return actions;
  if (legacyFn) return [{ fn: legacyFn, params: legacyParams ?? {} }];
  return [];
}

function keyInOverlay(overlays: any[], key: string, inputNumber?: number): boolean {
  if (!key && !inputNumber) return false;
  return overlays?.some((o: any) => {
    if (key && o.key && o.key !== '' && o.key === key) return true;
    if (inputNumber && o.inputNumber && o.inputNumber > 0 && o.inputNumber === inputNumber) return true;
    return false;
  }) ?? false;
}

function tallyClass(inputKey: string | undefined, actions: ActionItem[], vmixState: any): string {
  if (!vmixState) return '';

  // Overlay function tally: detect channel state from fn name
  for (const a of actions) {
    const m = a.fn?.match(/^OverlayInput(\d)(In|Out|Off)?$/);
    if (!m) continue;
    const ch = parseInt(m[1]);
    const overlay = vmixState.overlays?.find((o: any) => o.number === ch);
    if (!overlay) continue;
    const channelActive = !!(overlay.key && overlay.key !== '');
    const type = m[2]; // 'In', 'Out', 'Off', or undefined (Toggle)
    if (type === 'Out' || type === 'Off') {
      if (channelActive) return 'wgt-btn--ovl';
    } else {
      // In or Toggle: PGM > OVL > PRV using key comparison (UUID from same XML source)
      const actionInput = a.params?.Input;
      if (actionInput) {
        const inp = vmixState.inputs?.find((i: any) => i.key === actionInput);
        if (inp && vmixState.active === inp.number) return 'wgt-btn--pgm';
        if (keyInOverlay(vmixState.overlays, actionInput, inp?.number)) return 'wgt-btn--ovl';
        if (inp && vmixState.preview === inp.number) return 'wgt-btn--prv';
      } else if (channelActive) {
        return 'wgt-btn--ovl';
      }
    }
  }

  // Regular input tally
  if (!inputKey) return '';
  const input = vmixState.inputs?.find((i: any) => i.key === inputKey);
  if (!input) return '';
  if (vmixState.active === input.number) return 'wgt-btn--pgm';
  if (keyInOverlay(vmixState.overlays, inputKey, input.number)) return 'wgt-btn--ovl';
  if (vmixState.preview === input.number) return 'wgt-btn--prv';
  return '';
}

function firstInputKey(actions: ActionItem[]): string | undefined {
  return actions.find(a => a.params?.Input)?.params?.Input;
}

// Derives a toggle button's on/off state from live vMix state rather than
// local click tracking, so it reflects reality even when the state changed
// via another control surface, vMix itself, or a command that silently failed.
function deriveToggleOn(actions: ActionItem[], vmixState: any): boolean {
  if (!vmixState) return false;
  for (const a of actions) {
    const fn = a.fn;
    if (!fn) continue;
    const ovlMatch = fn.match(/^OverlayInput(\d)(In|Out|Off|Toggle)?$/);
    if (ovlMatch) {
      const ch = parseInt(ovlMatch[1], 10);
      const overlay = vmixState.overlays?.find((o: any) => o.number === ch);
      if (overlay) return !!(overlay.key && overlay.key !== '');
    }
    switch (fn) {
      case 'StartRecording': case 'StopRecording': case 'RecordingToggle':
        return !!vmixState.recording;
      case 'StartStreaming': case 'StopStreaming': case 'StreamingToggle':
        return !!vmixState.streaming;
      case 'StartExternal': case 'StopExternal': case 'ExternalToggle':
        return !!vmixState.external;
      case 'StartFullScreen': case 'StopFullScreen': case 'FullScreenToggle':
        return !!vmixState.fullscreen;
      case 'FadeToBlack':
        return !!vmixState.fadeToBlack;
      case 'StartMultiCorder': case 'StopMultiCorder': case 'MultiCorderToggle':
        return !!vmixState.multiCorder;
    }
  }
  return false;
}

export function ButtonWidget({ config }: Props) {
  const { getClient, vmixState } = useVmixStore();
  const connVmixState = vmixState;
  const { executeAppFunction } = useCanvasStore();
  const [firing, setFiring] = useState(false);
  const [sideFiring, setSideFiring] = useState<Record<string, boolean>>({});

  const pressActions = getActions(config.actions, config.function, config.params);
  const releaseActions = getActions(config.releaseActions, config.releaseFunction, config.releaseParams);
  const sideButtons: SideButton[] = config.sideButtons ?? [];

  const dispatch = async (fn: string, params: Record<string, string>) => {
    if (!fn) return;
    if (isApp(fn)) executeAppFunction(fn, params);
    else await getClient()?.sendFunction(fn, params);
  };

  const runActions = async (actions: ActionItem[]) => {
    for (const action of actions) {
      await dispatch(action.fn, action.params);
    }
  };

  const handleDown = async () => {
    if (config.mode === 'toggle') {
      const currentlyOn = deriveToggleOn([...pressActions, ...releaseActions], connVmixState);
      if (!currentlyOn) await runActions(pressActions);
      else await runActions(releaseActions);
    } else {
      setFiring(true);
      await runActions(pressActions);
    }
  };

  const handleUp = async () => {
    if (config.mode !== 'toggle') {
      setFiring(false);
      await runActions(releaseActions);
    }
  };

  const handleCancel = () => { setFiring(false); };

  const handleSbDown = async (sb: SideButton) => {
    const sbPress = sb.actions ?? [];
    const sbRelease = sb.releaseActions ?? [];
    if (sb.mode === 'toggle') {
      const currentlyOn = deriveToggleOn([...sbPress, ...sbRelease], connVmixState);
      if (!currentlyOn) await runActions(sbPress);
      else await runActions(sbRelease);
    } else {
      setSideFiring(p => ({ ...p, [sb.id]: true }));
      await runActions(sbPress);
    }
  };

  const handleSbUp = async (sb: SideButton) => {
    if (sb.mode !== 'toggle') {
      setSideFiring(p => ({ ...p, [sb.id]: false }));
      await runActions(sb.releaseActions ?? []);
    }
  };

  const hasVmixAction = [...pressActions, ...releaseActions, ...sideButtons.flatMap(sb => [...(sb.actions ?? []), ...(sb.releaseActions ?? [])])].some(a => a.fn && !isApp(a.fn));

  const mainInputKey = config.tallyInputKey || firstInputKey(pressActions) || firstInputKey(releaseActions);
  const mainTally = tallyClass(mainInputKey, [...pressActions, ...releaseActions], connVmixState);

  // Both modes derive "on" from live vMix state — toggle uses deriveToggleOn
  // (overlay channel / recording / streaming / etc.), momentary uses tally
  // (PGM/OVL/PRV) — neither depends on local click memory.
  const isOn = config.mode === 'toggle'
    ? deriveToggleOn([...pressActions, ...releaseActions], connVmixState)
    : !!mainTally;

  const mainBtn = (
    <button
      className={`wgt-btn${sideButtons.length ? ' wgt-btn--main' : ''} ${firing ? 'wgt-btn--fire' : ''} ${isOn ? 'wgt-btn--on' : ''} ${mainTally}`}
      style={{
        '--bc': config.color ?? '#3498db',
        '--tc': config.textColor ?? '#fff',
        fontSize: (config.fontSize ?? 14) + 'px',
      } as React.CSSProperties}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); handleDown(); }}
      onPointerUp={handleUp}
      onPointerCancel={handleCancel}
      disabled={hasVmixAction && !connVmixState}
    >
      {config.mode === 'toggle' && <span className="wgt-btn-dot" />}
      {config.label ?? 'Button'}
      {mainTally && <span className={`wgt-btn-tally-badge wgt-btn-tally-badge--${mainTally === 'wgt-btn--pgm' ? 'pgm' : mainTally === 'wgt-btn--ovl' ? 'ovl' : 'prv'}`}>
        {mainTally === 'wgt-btn--pgm' ? 'PGM' : mainTally === 'wgt-btn--ovl' ? 'OVL' : 'PRV'}
      </span>}
    </button>
  );

  if (sideButtons.length === 0) return mainBtn;

  return (
    <div className="wgt-btn-group">
      {mainBtn}
      {sideButtons.map(sb => {
        const sbFire = sideFiring[sb.id] ?? false;
        const sbInputKey = firstInputKey(sb.actions ?? []) || firstInputKey(sb.releaseActions ?? []);
        const sbActions = [...(sb.actions ?? []), ...(sb.releaseActions ?? [])];
        const sbTally = tallyClass(sbInputKey, sbActions, connVmixState);
        const sbOn = sb.mode === 'toggle' ? deriveToggleOn(sbActions, connVmixState) : !!sbTally;
        return (
          <button
            key={sb.id}
            className={`wgt-btn wgt-btn--side ${sbFire ? 'wgt-btn--fire' : ''} ${sbOn ? 'wgt-btn--on' : ''} ${sbTally}`}
            style={{
              '--bc': sb.color ?? '#555555',
              '--tc': sb.textColor ?? '#fff',
              fontSize: (sb.fontSize ?? 11) + 'px',
            } as React.CSSProperties}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); handleSbDown(sb); }}
            onPointerUp={() => handleSbUp(sb)}
            onPointerCancel={() => setSideFiring(p => ({ ...p, [sb.id]: false }))}
            disabled={hasVmixAction && !connVmixState}
          >
            {sb.mode === 'toggle' && <span className="wgt-btn-dot" />}
            {sb.label || '—'}
            {sbTally && <span className={`wgt-btn-tally-badge wgt-btn-tally-badge--${sbTally === 'wgt-btn--pgm' ? 'pgm' : sbTally === 'wgt-btn--ovl' ? 'ovl' : 'prv'}`}>
              {sbTally === 'wgt-btn--pgm' ? 'PGM' : sbTally === 'wgt-btn--ovl' ? 'OVL' : 'PRV'}
            </span>}
          </button>
        );
      })}
    </div>
  );
}
