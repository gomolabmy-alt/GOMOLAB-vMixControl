import { useState } from 'react';
import { useVmixStore } from '../stores/vmixStore';

export function TransitionControls() {
  const { sendFunction, vmixState } = useVmixStore();
  const [active, setActive] = useState<string | null>(null);

  const fire = async (fn: string) => {
    setActive(fn);
    await sendFunction(fn);
    setTimeout(() => setActive(null), 300);
  };

  if (!vmixState) return null;

  return (
    <div className="transition-controls">
      <button
        className={`trans-btn trans-btn--cut ${active === 'Cut' ? 'trans-btn--fired' : ''}`}
        onClick={() => fire('Cut')}
      >
        CUT
      </button>
      <button
        className={`trans-btn trans-btn--fade ${active === 'Fade' ? 'trans-btn--fired' : ''}`}
        onClick={() => fire('Fade')}
      >
        FADE
      </button>
      <button
        className={`trans-btn trans-btn--auto ${active === 'Transition1' ? 'trans-btn--fired' : ''}`}
        onClick={() => fire('Transition1')}
      >
        AUTO
      </button>
      <button
        className={`trans-btn trans-btn--t2 ${active === 'Transition2' ? 'trans-btn--fired' : ''}`}
        onClick={() => fire('Transition2')}
      >
        T2
      </button>
      <button
        className={`trans-btn trans-btn--t3 ${active === 'Transition3' ? 'trans-btn--fired' : ''}`}
        onClick={() => fire('Transition3')}
      >
        T3
      </button>
    </div>
  );
}
