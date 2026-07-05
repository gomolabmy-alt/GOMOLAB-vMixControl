import { useState } from 'react';
import { useVmixStore } from '../../stores/vmixStore';

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

const TRANS_MAP: Record<string, { label: string; fn: string; color: string }> = {
  cut:      { label: 'CUT',    fn: 'Cut',         color: '#e74c3c' },
  fade:     { label: 'FADE',   fn: 'Fade',        color: '#3498db' },
  auto:     { label: 'AUTO',   fn: 'Transition1', color: '#9b59b6' },
  t2:       { label: 'T2',     fn: 'Transition2', color: '#8e44ad' },
  t3:       { label: 'T3',     fn: 'Transition3', color: '#6c3483' },
  t4:       { label: 'T4',     fn: 'Transition4', color: '#4a235a' },
  stinger1: { label: 'STG1',   fn: 'Stinger1',    color: '#e67e22' },
  stinger2: { label: 'STG2',   fn: 'Stinger2',    color: '#ca6f1e' },
  ftb:      { label: 'FTB',    fn: 'FadeToBlack', color: '#1a1a1a' },
};

export function TransitionsWidget({ config }: Props) {
  const { getClient, vmixState } = useVmixStore();
  const connVmixState = vmixState;
  const [firing, setFiring] = useState<string | null>(null);
  const buttons: string[] = config.buttons ?? ['cut', 'fade', 'auto'];

  const handle = async (key: string, fn: string) => {
    setFiring(key);
    await getClient()?.sendFunction(fn, {});
    setTimeout(() => setFiring(null), 200);
  };

  return (
    <div className="wgt-trans">
      {buttons.map((key) => {
        const t = TRANS_MAP[key];
        if (!t) return null;
        return (
          <button
            key={key}
            className={`wgt-trans-btn ${firing === key ? 'wgt-trans-btn--fire' : ''}`}
            style={{ '--tc': t.color } as React.CSSProperties}
            onClick={() => handle(key, t.fn)}
            disabled={!connVmixState}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
