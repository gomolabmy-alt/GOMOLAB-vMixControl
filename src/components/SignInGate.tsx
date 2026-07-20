import { useAuthStore } from '../stores/authStore';

export function SignInGate() {
  const { pendingState, error, beginSignIn } = useAuthStore();

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
          ) : (
            <>
              {error && <p className="signin-gate-error">{error}</p>}
              <button className="signin-gate-btn" onClick={() => beginSignIn()}>
                Sign In
              </button>
              <p className="signin-gate-hint">Opens your GOMOLAB Event Management account in the browser.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
