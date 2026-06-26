import { useMemo, useEffect, useCallback } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useVmixStore } from '../../stores/vmixStore';

interface Props {
  config: Record<string, any>;
}

type RugbyCard = 'yellow' | 'orange' | 'red';
type ActiveCard = 'sinbin' | 'red';

interface CardEntry {
  playerId: string;
  name: string;
  jerseyNo: string;
  activeCard: ActiveCard;
}

const CARD_COLOR: Record<ActiveCard, string> = {
  sinbin: '#f1c40f',
  red:    '#e74c3c',
};

const CARD_LABEL: Record<ActiveCard, string> = {
  sinbin: 'Sin bin',
  red:    'Red card — dismissed',
};

export function CardDisplayWidget({ config: cfg }: Props) {
  const { pages } = useCanvasStore();
  const { tournaments } = useTournamentStore();
  const { getClientById } = useVmixStore();

  const allWidgets = useMemo(() => pages.flatMap(p => p.widgets), [pages]);

  function resolveTeam(linkedId: string): { name: string; color: string; entries: CardEntry[] } {
    const plw = allWidgets.find(w => w.id === linkedId);
    if (!plw) return { name: '—', color: '#888', entries: [] };

    const plCfg = plw.config;
    const tournament = tournaments.find(t => t.id === plCfg.linkedTournamentId);
    const side: 'A' | 'B' = plCfg.teamSide ?? 'A';
    const team = side === 'A' ? tournament?.teamA : tournament?.teamB;
    const players = team?.players ?? [];
    const playerCards: Record<string, RugbyCard[]> = plCfg.playerCards ?? {};
    const sinBinEntries: Record<string, number> = plCfg.sinBinEntries ?? {};

    const entries: CardEntry[] = [];

    for (const [id, cards] of Object.entries(playerCards)) {
      const yellows = cards.filter(c => c === 'yellow').length;
      const hasRed = cards.includes('red') || yellows >= 2;

      if (hasRed) {
        const player = players.find(p => p.id === id);
        entries.push({ playerId: id, name: player?.name ?? '?', jerseyNo: player?.jerseyNo ?? '', activeCard: 'red' });
      } else if (yellows === 1 && sinBinEntries[id] !== undefined) {
        const player = players.find(p => p.id === id);
        entries.push({ playerId: id, name: player?.name ?? '?', jerseyNo: player?.jerseyNo ?? '', activeCard: 'sinbin' });
      }
    }

    return { name: team?.name ?? '—', color: team?.color ?? '#888', entries };
  }

  const teamA = useMemo(() => resolveTeam(cfg.linkedPlayerListA ?? ''), [cfg.linkedPlayerListA, allWidgets, tournaments]);
  const teamB = useMemo(() => resolveTeam(cfg.linkedPlayerListB ?? ''), [cfg.linkedPlayerListB, allWidgets, tournaments]);

  const showNames: boolean = cfg.showNames !== false;

  // ── vMix sync ──────────────────────────────────────────────────────
  const syncToVmix = useCallback(() => {
    const cdTargets: Array<{inputKey:string;clientId?:string;vmixFieldSinBinA?:string;vmixFieldSinBinB?:string;vmixFieldRedA?:string;vmixFieldRedB?:string}> =
      cfg.vmixInputs?.length
        ? cfg.vmixInputs
        : cfg.vmixInputKey
          ? [{ inputKey: cfg.vmixInputKey, vmixFieldSinBinA: cfg.vmixFieldSinBinA, vmixFieldSinBinB: cfg.vmixFieldSinBinB, vmixFieldRedA: cfg.vmixFieldRedA, vmixFieldRedB: cfg.vmixFieldRedB }]
          : [];
    if (!cdTargets.length) return;

    const sinbinA = teamA.entries.filter(e => e.activeCard === 'sinbin').map(e => e.name).join(', ');
    const sinbinB = teamB.entries.filter(e => e.activeCard === 'sinbin').map(e => e.name).join(', ');
    const redA    = teamA.entries.filter(e => e.activeCard === 'red').map(e => e.name).join(', ');
    const redB    = teamB.entries.filter(e => e.activeCard === 'red').map(e => e.name).join(', ');

    for (const t of cdTargets) {
      if (!t.inputKey) continue;
      const c = getClientById(t.clientId);
      if (!c) continue;
      if (t.vmixFieldSinBinA) c.setTextField(t.inputKey, t.vmixFieldSinBinA, sinbinA);
      if (t.vmixFieldSinBinB) c.setTextField(t.inputKey, t.vmixFieldSinBinB, sinbinB);
      if (t.vmixFieldRedA)    c.setTextField(t.inputKey, t.vmixFieldRedA,    redA);
      if (t.vmixFieldRedB)    c.setTextField(t.inputKey, t.vmixFieldRedB,    redB);
    }
  }, [cfg.vmixInputs, cfg.vmixInputKey, cfg.vmixFieldSinBinA, cfg.vmixFieldSinBinB, cfg.vmixFieldRedA, cfg.vmixFieldRedB,
      teamA.entries, teamB.entries, getClientById]);

  useEffect(() => {
    if (cfg.vmixAutoSync) syncToVmix();
  }, [teamA.entries, teamB.entries, cfg.vmixAutoSync, syncToVmix]);

  // ── Render ─────────────────────────────────────────────────────────
  function renderEntries(entries: CardEntry[]) {
    if (entries.length === 0) return <span className="wgt-cd-empty">—</span>;
    return entries.map(entry => (
      <div key={entry.playerId} className="wgt-cd-player">
        <div
          className={`wgt-cd-card wgt-cd-card--${entry.activeCard}`}
          style={{ background: CARD_COLOR[entry.activeCard], boxShadow: `0 3px 8px ${CARD_COLOR[entry.activeCard]}55` }}
          title={CARD_LABEL[entry.activeCard]}
        />
        {showNames && (
          <span className="wgt-cd-player-name">
            {entry.jerseyNo ? `${entry.jerseyNo} ` : ''}{entry.name}
          </span>
        )}
      </div>
    ));
  }

  const configured = cfg.linkedPlayerListA || cfg.linkedPlayerListB;

  return (
    <div className="wgt-cd">
      {!configured ? (
        <div className="wgt-cd-uncfg">Link player lists in ⚙</div>
      ) : (
        <>
          <div className="wgt-cd-cols">
            <div className="wgt-cd-col">
              <div className="wgt-cd-team-hdr" style={{ color: teamA.color }}>
                <span className="wgt-cd-team-dot" style={{ background: teamA.color }} />
                {teamA.name}
              </div>
              <div className="wgt-cd-entries">{renderEntries(teamA.entries)}</div>
            </div>

            <div className="wgt-cd-vsep" />

            <div className="wgt-cd-col">
              <div className="wgt-cd-team-hdr" style={{ color: teamB.color }}>
                <span className="wgt-cd-team-dot" style={{ background: teamB.color }} />
                {teamB.name}
              </div>
              <div className="wgt-cd-entries">{renderEntries(teamB.entries)}</div>
            </div>
          </div>

          {cfg.vmixInputKey && !cfg.vmixAutoSync && (
            <div className="wgt-cd-footer">
              <button className="wgt-cd-sync-btn" onClick={syncToVmix}>⇒ Sync to vMix</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
