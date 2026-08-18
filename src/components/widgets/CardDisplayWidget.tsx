import { useMemo, useEffect, useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { autoLinkedWidgetPair } from '../../lib/autoLink';
import { resolvePlayerListRoster } from '../../lib/playerListSquad';
import { simplifyPlayerName } from '../../lib/simpleName';
import { resolveImageUrl } from '../../lib/imageUrl';

interface Props {
  widgetId: string;
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

export function CardDisplayWidget({ widgetId, config: cfg }: Props) {
  const { pages } = useCanvasStore();
  const { teams: teamDbTeams } = useTeamDbStore();
  const { getClient, vmixSyncVersion } = useVmixStore();
  // Simple Names (App Settings) — this widget only ever displays cards
  // read-only / pushes to vMix, no editable name field to protect.
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

  // Falls back to the two Player List widgets on this page (assigned by
  // their own teamSide A/B, or left-to-right position) when neither side's
  // been explicitly linked in settings — an explicit pick always wins.
  const { a: playerListA, b: playerListB } = useMemo(
    () => autoLinkedWidgetPair(pages, widgetId, cfg.linkedPlayerListA, cfg.linkedPlayerListB, 'player-list'),
    [pages, widgetId, cfg.linkedPlayerListA, cfg.linkedPlayerListB]
  );

  function resolveTeam(plw: typeof playerListA, side: 'A' | 'B'): { name: string; color: string; logo?: string; entries: CardEntry[] } {
    if (!plw) return { name: '—', color: '#888', entries: [] };

    const { team, playerCards, sinBinEntries } = resolvePlayerListRoster(plw, side, teamDbTeams);
    const players = team?.players ?? [];

    const entries: CardEntry[] = [];

    for (const [id, cards] of Object.entries(playerCards)) {
      const yellows = cards.filter(c => c === 'yellow').length;
      const hasRed = cards.includes('red') || yellows >= 2;

      if (hasRed) {
        const player = players.find(p => p.id === id);
        entries.push({ playerId: id, name: player ? disp(player.name) : '?', jerseyNo: player?.jerseyNo ?? '', activeCard: 'red' });
      } else if (yellows === 1 && sinBinEntries[id] !== undefined) {
        const player = players.find(p => p.id === id);
        entries.push({ playerId: id, name: player ? disp(player.name) : '?', jerseyNo: player?.jerseyNo ?? '', activeCard: 'sinbin' });
      }
    }

    return { name: team?.name ?? '—', color: team?.color ?? '#888', logo: team?.logo, entries };
  }

  const teamA = useMemo(() => resolveTeam(playerListA, 'A'), [playerListA, teamDbTeams, simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker]);
  const teamB = useMemo(() => resolveTeam(playerListB, 'B'), [playerListB, teamDbTeams, simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker]);

  const showNames: boolean = cfg.showNames !== false;

  // ── vMix sync ──────────────────────────────────────────────────────
  const syncToVmix = useCallback(() => {
    const cdTargets: Array<{inputKey:string;vmixFieldSinBinA?:string;vmixFieldSinBinB?:string;vmixFieldRedA?:string;vmixFieldRedB?:string;vmixFieldLogoA?:string;vmixFieldLogoB?:string;mergedPrefix?:string;mergedParts?:string[];mergedSeparator?:string}> =
      cfg.vmixInputs?.length
        ? cfg.vmixInputs
        : cfg.vmixInputKey
          ? [{ inputKey: cfg.vmixInputKey, vmixFieldSinBinA: cfg.vmixFieldSinBinA, vmixFieldSinBinB: cfg.vmixFieldSinBinB, vmixFieldRedA: cfg.vmixFieldRedA, vmixFieldRedB: cfg.vmixFieldRedB, vmixFieldLogoA: cfg.vmixFieldLogoA, vmixFieldLogoB: cfg.vmixFieldLogoB }]
          : [];
    if (!cdTargets.length) return;

    const sinbinA = teamA.entries.filter(e => e.activeCard === 'sinbin').map(e => e.name).join(', ');
    const sinbinB = teamB.entries.filter(e => e.activeCard === 'sinbin').map(e => e.name).join(', ');
    const redA    = teamA.entries.filter(e => e.activeCard === 'red').map(e => e.name).join(', ');
    const redB    = teamB.entries.filter(e => e.activeCard === 'red').map(e => e.name).join(', ');
    const src: Record<string, string> = { sinbinA, sinbinB, redA, redB };

    for (const t of cdTargets) {
      if (!t.inputKey) continue;
      const c = getClient();
      if (!c) continue;
      if (t.vmixFieldSinBinA) c.setTextField(t.inputKey, t.vmixFieldSinBinA, sinbinA);
      if (t.vmixFieldSinBinB) c.setTextField(t.inputKey, t.vmixFieldSinBinB, sinbinB);
      if (t.vmixFieldRedA)    c.setTextField(t.inputKey, t.vmixFieldRedA,    redA);
      if (t.vmixFieldRedB)    c.setTextField(t.inputKey, t.vmixFieldRedB,    redB);
      if (t.vmixFieldLogoA && teamA.logo) c.setImageField(t.inputKey, t.vmixFieldLogoA, teamA.logo);
      if (t.vmixFieldLogoB && teamB.logo) c.setImageField(t.inputKey, t.vmixFieldLogoB, teamB.logo);
      if (t.mergedPrefix && t.mergedParts?.length) {
        c.setTextField(t.inputKey, t.mergedPrefix, t.mergedParts.map(k => src[k] ?? '').join(t.mergedSeparator ?? ' '));
      }
    }
  }, [cfg.vmixInputs, cfg.vmixInputKey, cfg.vmixFieldSinBinA, cfg.vmixFieldSinBinB, cfg.vmixFieldRedA, cfg.vmixFieldRedB,
      cfg.vmixFieldLogoA, cfg.vmixFieldLogoB, teamA.entries, teamA.logo, teamB.entries, teamB.logo, getClient]);

  useEffect(() => {
    if (cfg.vmixAutoSync) syncToVmix();
  }, [teamA.entries, teamB.entries, cfg.vmixAutoSync, syncToVmix, vmixSyncVersion]);

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

  const configured = !!(playerListA || playerListB);

  return (
    <div className="wgt-cd">
      {!configured ? (
        <div className="wgt-cd-uncfg">Link player lists in settings</div>
      ) : (
        <>
          <div className="wgt-cd-cols">
            <div className="wgt-cd-col">
              <div className="wgt-cd-team-hdr" style={{ color: teamA.color }}>
                {teamA.logo ? <img className="wgt-cd-team-logo" src={resolveImageUrl(teamA.logo)} alt="" /> : <span className="wgt-cd-team-dot" style={{ background: teamA.color }} />}
                {teamA.name}
              </div>
              <div className="wgt-cd-entries">{renderEntries(teamA.entries)}</div>
            </div>

            <div className="wgt-cd-vsep" />

            <div className="wgt-cd-col">
              <div className="wgt-cd-team-hdr" style={{ color: teamB.color }}>
                {teamB.logo ? <img className="wgt-cd-team-logo" src={resolveImageUrl(teamB.logo)} alt="" /> : <span className="wgt-cd-team-dot" style={{ background: teamB.color }} />}
                {teamB.name}
              </div>
              <div className="wgt-cd-entries">{renderEntries(teamB.entries)}</div>
            </div>
          </div>

          {cfg.vmixInputKey && !cfg.vmixAutoSync && (
            <div className="wgt-cd-footer">
              <button className="wgt-cd-sync-btn" onClick={syncToVmix} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <ArrowRight size={12} strokeWidth={2} /> Sync to vMix
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
