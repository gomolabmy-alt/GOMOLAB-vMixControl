import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export function SignInGate() {
  const { pendingState, error, beginSignIn, bypassPinHash, tryBypass, bypassError } = useAuthStore();
  const [showBypass, setShowBypass] = useState(false);
  const [pin, setPin] = useState('');
  const [checking, setChecking] = useState(false);

  const submitBypass = async () => {
    if (!pin.trim() || checking) return;
    setChecking(true);
    const ok = await tryBypass(pin);
    setChecking(false);
    if (ok) setPin('');
  };

  return (
    <div className="splash" style={{ position: 'fixed' }}>
      <div className="splash-content">
        <img src="/icon.png" alt="GOMOLAB" className="splash-logo" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        <div className="splash-brand">GOMOLAB</div>
        <div className="splash-product">vMix Control</div>

        <div className="signin-gate-body">
          {pendingState ? (
            <>
              <p className="signin-gate-msg">Waiting for you to finish signing in in your browser…</p>
              <button className="signin-gate-btn signin-gate-btn--secondary" onClick={() => beginSignIn()}>
                Reopen browser
              </button>
            </>
          ) : showBypass ? (
            <>
              <p className="signin-gate-msg">Enter the offline PIN an admin gave you for this device.</p>
              {bypassError && <p className="signin-gate-error">{bypassError}</p>}
              <input
                className="signin-gate-pin-input"
                type="password"
                inputMode="numeric"
                autoFocus
                value={pin}
                onChange={e => setPin(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitBypass(); }}
                placeholder="PIN"
              />
              <button className="signin-gate-btn" disabled={checking || !pin.trim()} onClick={submitBypass}>
                {checking ? 'Checking…' : 'Continue Offline'}
              </button>
              <button className="signin-gate-btn signin-gate-btn--secondary" onClick={() => { setShowBypass(false); setPin(''); }}>
                Back to Sign In
              </button>
              <p className="signin-gate-hint">No data is sent to or loaded from the server while offline — cloud sync stays off until you sign in normally.</p>
            </>
          ) : (
            <>
              {error && <p className="signin-gate-error">{error}</p>}
              <button className="signin-gate-btn" onClick={() => beginSignIn()}>
                Sign In
              </button>
              <p className="signin-gate-hint">Opens your GOMOLAB Event Management account in the browser.</p>
              {bypassPinHash && (
                <button className="signin-gate-bypass-link" onClick={() => setShowBypass(true)}>
                  Continue Offline (PIN)
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
