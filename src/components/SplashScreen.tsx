import { useEffect, useState } from 'react';

interface Props {
  onDone: () => void;
}

export function SplashScreen({ onDone }: Props) {
  const [buildNumber, setBuildNumber] = useState('');
  const [phase, setPhase] = useState<'in' | 'hold' | 'out'>('in');

  useEffect(() => {
    if ('__TAURI_INTERNALS__' in window) {
      import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke<string>('get_build_number'))
        .then(setBuildNumber)
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    // in → hold after 300ms, out after 1700ms, done after 2300ms
    const t1 = setTimeout(() => setPhase('hold'), 300);
    const t2 = setTimeout(() => setPhase('out'), 1700);
    const t3 = setTimeout(() => onDone(), 2300);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onDone]);

  return (
    <div className={`splash${phase === 'in' ? ' splash--in' : phase === 'out' ? ' splash--out' : ''}`}>
      <div className="splash-content">
        <img src="/icon.png" alt="GOMOLAB" className="splash-logo" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        <div className="splash-brand">GOMOLAB</div>
        <div className="splash-product">vMix Control</div>
        {buildNumber && <div className="splash-build">Build {buildNumber}</div>}
      </div>
    </div>
  );
}
