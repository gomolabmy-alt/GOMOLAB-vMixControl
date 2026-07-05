import { useRef, useState } from 'react';
import { useVmixStore } from '../../stores/vmixStore';

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

export function TBarWidget({ config }: Props) {
  const { getClient, vmixState } = useVmixStore();
  const connVmixState = vmixState;
  const [localValue, setLocalValue] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);

  const pct = (localValue / 255) * 100;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = trackRef.current;
    if (!el) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const update = (cx: number) => {
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
      const val = Math.round(ratio * 255);
      setLocalValue(val);
      getClient()?.setTBar(val);
    };
    update(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // e.buttons is 0 for touch pointers — use pointer capture presence instead
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const val = Math.round(ratio * 255);
    setLocalValue(val);
    getClient()?.setTBar(val);
  };

  return (
    <div className="wgt-tbar">
      <div className="wgt-tbar-label">{config.label ?? 'T-Bar'}</div>
      <div
        ref={trackRef}
        className="wgt-tbar-track"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        style={{ opacity: connVmixState ? 1 : 0.4 }}
      >
        <div className="wgt-tbar-fill" style={{ width: `${pct}%` }} />
        <div className="wgt-tbar-thumb" style={{ left: `${pct}%` }} />
      </div>
      <div className="wgt-tbar-val">{localValue}</div>
    </div>
  );
}
