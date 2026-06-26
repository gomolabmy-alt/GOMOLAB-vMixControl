import { useEffect, useRef, useState, useCallback } from 'react';
import { useCanvasStore, formatTime } from '../stores/canvasStore';
import { useAppSettings } from '../stores/appSettingsStore';

type CardType = 'yellow-card' | 'orange-card' | 'red-card';

interface Notif {
  id: string;
  type: 'goal' | 'card' | 'sub' | 'time-pause';
  team?: 'A' | 'B';
  teamName?: string;
  timeStr?: string;
  // goal
  scorer?: string;
  jerseyNo?: string;
  action?: string;
  scoreA?: number;
  scoreB?: number;
  // card
  cardType?: CardType;
  player?: string;
  // sub
  playerIn?: string;
  playerOut?: string;
  jerseyNoIn?: string;
  jerseyNoOff?: string;
  // time-pause
  timerName?: string;
}

const CARD_LABELS: Record<CardType, string> = {
  'yellow-card': 'Yellow Card',
  'orange-card': 'Orange Card (HIA)',
  'red-card': 'Red Card',
};
const CARD_COLORS: Record<CardType, string> = {
  'yellow-card': '#f1c40f',
  'orange-card': '#e67e22',
  'red-card': '#e74c3c',
};
const CARD_ICONS: Record<CardType, string> = {
  'yellow-card': '🟨',
  'orange-card': '🟧',
  'red-card': '🟥',
};

function NotifCard({ notif, onDismiss, durationMs }: { notif: Notif; onDismiss: () => void; durationMs: number }) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.width = '100%';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = `width ${durationMs}ms linear`;
        el.style.width = '0%';
      });
    });
  }, [durationMs]);

  const accentColor = notif.type === 'card'
    ? CARD_COLORS[notif.cardType!]
    : notif.type === 'goal' ? '#2ecc71'
    : notif.type === 'sub' ? '#3498db'
    : '#95a5a6';

  return (
    <div className="notif-card" style={{ borderLeftColor: accentColor }}>
      <div className="notif-card-inner">
        <div className="notif-icon" style={{ color: accentColor }}>
          {notif.type === 'goal' && '⚽'}
          {notif.type === 'card' && CARD_ICONS[notif.cardType!]}
          {notif.type === 'sub' && '↕'}
          {notif.type === 'time-pause' && '⏸'}
        </div>
        <div className="notif-body">
          {notif.type === 'goal' && (
            <>
              <div className="notif-title" style={{ color: accentColor }}>
                {notif.action ?? 'GOAL!'} — {notif.teamName ?? (notif.team === 'A' ? 'Team A' : 'Team B')}
              </div>
              {(notif.scorer || notif.jerseyNo) && (
                <div className="notif-detail">
                  {notif.jerseyNo && <span className="notif-jersey">#{notif.jerseyNo}</span>}
                  {notif.scorer && <span>{notif.scorer}</span>}
                </div>
              )}
              {(notif.scoreA !== undefined && notif.scoreB !== undefined) && (
                <div className="notif-score">{notif.scoreA} — {notif.scoreB}</div>
              )}
              {notif.timeStr && <div className="notif-time">{notif.timeStr}</div>}
            </>
          )}
          {notif.type === 'card' && (
            <>
              <div className="notif-title" style={{ color: accentColor }}>
                {CARD_LABELS[notif.cardType!]}
              </div>
              {(notif.player || notif.jerseyNo) && (
                <div className="notif-detail">
                  {notif.jerseyNo && <span className="notif-jersey">#{notif.jerseyNo}</span>}
                  {notif.player && <span>{notif.player}</span>}
                </div>
              )}
              {notif.teamName && <div className="notif-team">{notif.teamName}</div>}
              {notif.timeStr && <div className="notif-time">{notif.timeStr}</div>}
            </>
          )}
          {notif.type === 'sub' && (
            <>
              <div className="notif-title" style={{ color: accentColor }}>Substitution</div>
              <div className="notif-detail notif-sub-in">
                <span className="notif-sub-arrow">▶</span>
                {notif.jerseyNoIn && <span className="notif-jersey">#{notif.jerseyNoIn}</span>}
                <span>{notif.playerIn ?? '—'}</span>
              </div>
              <div className="notif-detail notif-sub-out">
                <span className="notif-sub-arrow" style={{ opacity: 0.5 }}>◀</span>
                {notif.jerseyNoOff && <span className="notif-jersey" style={{ opacity: 0.7 }}>#{notif.jerseyNoOff}</span>}
                <span style={{ opacity: 0.7 }}>{notif.playerOut ?? '—'}</span>
              </div>
              {notif.teamName && <div className="notif-team">{notif.teamName}</div>}
              {notif.timeStr && <div className="notif-time">{notif.timeStr}</div>}
            </>
          )}
          {notif.type === 'time-pause' && (
            <>
              <div className="notif-title" style={{ color: accentColor }}>Time Off</div>
              {notif.timerName && <div className="notif-detail">{notif.timerName}</div>}
              {notif.timeStr && <div className="notif-time">{notif.timeStr}</div>}
            </>
          )}
        </div>
        <button className="notif-close" onClick={onDismiss}>✕</button>
      </div>
      <div className="notif-progress">
        <div ref={barRef} className="notif-progress-bar" style={{ background: accentColor }} />
      </div>
    </div>
  );
}

export function NotificationOverlay() {
  const { pages } = useCanvasStore();
  const {
    notifyGoal, notifyCard, notifySub, notifyTimePause, notifyDurationMs,
  } = useAppSettings();

  const [notifs, setNotifs] = useState<Notif[]>([]);

  const addNotif = useCallback((n: Omit<Notif, 'id'>) => {
    const notif: Notif = { ...n, id: crypto.randomUUID() };
    setNotifs(prev => [...prev, notif]);
    setTimeout(() => {
      setNotifs(prev => prev.filter(x => x.id !== notif.id));
    }, notifyDurationMs + 300); // +300 for exit animation
  }, [notifyDurationMs]);

  const prevRef = useRef<{
    scoreLogIds: Record<string, string>;
    timelineEventIds: Record<string, string>;
    timerRunning: Record<string, boolean>;
    initialized: boolean;
  }>({ scoreLogIds: {}, timelineEventIds: {}, timerRunning: {}, initialized: false });

  useEffect(() => {
    const allWidgets = pages.flatMap(p => p.widgets);
    const prev = prevRef.current;
    const next = {
      scoreLogIds: {} as Record<string, string>,
      timelineEventIds: {} as Record<string, string>,
      timerRunning: {} as Record<string, boolean>,
      initialized: true,
    };

    for (const w of allWidgets) {
      // ── Goal (scoreboard scoreLog) ──────────────────────────────────────
      if (w.type === 'scoreboard' && notifyGoal) {
        const entry = (w.config.scoreLog ?? [])[0];
        next.scoreLogIds[w.id] = entry?.id ?? '';
        if (prev.initialized && entry?.id && entry.id !== (prev.scoreLogIds[w.id] ?? '') && (entry.points ?? 0) > 0) {
          addNotif({
            type: 'goal',
            team: entry.team,
            teamName: entry.teamName,
            scorer: entry.scorer || undefined,
            jerseyNo: entry.jerseyNo || undefined,
            action: entry.action,
            timeStr: entry.timeStr,
            scoreA: entry.scoreA,
            scoreB: entry.scoreB,
          });
        }
      }

      // ── Cards & Subs (timeline events) ─────────────────────────────────
      if (w.type === 'timeline' && (notifyCard || notifySub)) {
        const ev = (w.config.events ?? [])[0] as any;
        next.timelineEventIds[w.id] = ev?.id ?? '';
        if (prev.initialized && ev?.id && ev.id !== (prev.timelineEventIds[w.id] ?? '')) {
          if (['yellow-card', 'orange-card', 'red-card'].includes(ev.type) && notifyCard) {
            addNotif({
              type: 'card',
              cardType: ev.type as CardType,
              team: ev.team,
              teamName: ev.teamName,
              player: ev.player,
              jerseyNo: ev.jerseyNo,
              timeStr: ev.timeStr,
            });
          } else if (ev.type === 'substitution' && notifySub) {
            addNotif({
              type: 'sub',
              team: ev.team,
              teamName: ev.teamName,
              playerIn: ev.player,
              playerOut: ev.playerOff,
              jerseyNoIn: ev.jerseyNo,
              jerseyNoOff: ev.jerseyNoOff,
              timeStr: ev.timeStr,
            });
          }
        }
      }

      // ── Timer pause ─────────────────────────────────────────────────────
      if (w.type === 'timer' && notifyTimePause && !w.config.linkedTimerSourceId) {
        const running = w.config.running ?? false;
        next.timerRunning[w.id] = running;
        if (prev.initialized && prev.timerRunning[w.id] === true && !running) {
          const ms = w.config.currentMs ?? 0;
          addNotif({
            type: 'time-pause',
            timerName: (w as any).label || w.config.name || undefined,
            timeStr: formatTime(ms, w.config.format ?? 'mm:ss'),
          });
        }
      }
    }

    prevRef.current = next;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  const dismiss = useCallback((id: string) => setNotifs(prev => prev.filter(x => x.id !== id)), []);

  if (notifs.length === 0) return null;

  return (
    <div className="notif-overlay">
      {notifs.map(n => (
        <NotifCard key={n.id} notif={n} onDismiss={() => dismiss(n.id)} durationMs={notifyDurationMs} />
      ))}
    </div>
  );
}
