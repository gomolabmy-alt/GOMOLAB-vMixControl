import { useEffect, useRef, useState } from 'react';
import { X, ChevronDown, ArrowUp, Eye, EyeOff, ArrowLeftRight } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useMatchScheduleStore } from '../../stores/matchScheduleStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { SPORT_DEFAULTS } from '../../types/tournament';
import { resolvePlacementTeam, type ResolvedPlacementTeam } from '../../lib/placementResolve';
import { resolveImageUrl } from '../../lib/imageUrl';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

interface PlacementSlot {
  id: string;
  rank: number;
  label: string;
  manualTeamName?: string;
  vmixInputKey: string;
  fieldLabel: string;
  fieldTeam: string;
  fieldLogo?: string;
  mergedPrefix?: string;
  mergedParts?: ('label' | 'team')[];
  mergedSeparator?: string;
}

export function PlacementLowerThirdWidget({ widgetId, config }: Props) {
  const { pages } = useCanvasStore();
  const { teams: allTeams } = useTeamDbStore();
  const { matches: allMatches } = useMatchScheduleStore();
  const { results: allResults } = useMatchResultsStore();
  const { tournaments } = useTournamentStore();
  const { client, vmixState, overlayIn, overlayOut, vmixSyncVersion } = useVmixStore();

  // Falls back to the canvas page's own bound tournament (see
  // CanvasTournamentPicker) when nothing's explicitly picked in settings —
  // same convention as StandingsWidget/BracketWidget.
  const pageTournamentId = pages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const tournamentId: string | undefined = config.filterTournamentId || pageTournamentId;
  const tournament = tournaments.find(t => t.id === tournamentId);
  const category: string = config.filterCategory ?? '';

  const scopedMatches = tournamentId
    ? allMatches.filter(m => m.tournamentId === tournamentId && (!category || !m.category || m.category === category))
    : [];
  const scopedResults = tournamentId ? allResults.filter(r => r.tournamentId === tournamentId) : [];
  const scopedTeams = tournamentId
    ? allTeams.filter(t => t.tournamentId === tournamentId && (!category || !t.category || t.category === category))
    : [];
  const settings = tournament?.settings ?? (tournament ? SPORT_DEFAULTS[tournament.sport] : undefined);

  const slots: PlacementSlot[] = config.slots ?? [];

  const resolveSlotTeam = (slot: PlacementSlot): ResolvedPlacementTeam | null => {
    if (slot.manualTeamName?.trim()) return { name: slot.manualTeamName.trim(), color: '#7f8c8d' };
    if (!tournamentId || !settings) return null;
    return resolvePlacementTeam(slot.rank, scopedMatches, scopedResults, scopedTeams, tournamentId, settings);
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const activeSlotId = selectedId ?? config.activeSlotId ?? slots[0]?.id ?? null;
  const active = slots.find(s => s.id === activeSlotId) ?? slots[0] ?? null;
  const activeTeam = active ? resolveSlotTeam(active) : null;

  // ── vMix ─────────────────────────────────────────────────────────────────
  const ch = config.overlayChannel ?? 1;
  const overlay = vmixState?.overlays?.find((o: any) => o.number === ch);
  const overlayActive = !!(overlay && overlay.key !== '');
  const hasInput = !!active?.vmixInputKey;

  const sendToVmix = (slot: PlacementSlot | null, team: ResolvedPlacementTeam | null) => {
    if (!client || !slot?.vmixInputKey) return;
    if (slot.fieldLabel) client.setTextField(slot.vmixInputKey, slot.fieldLabel, slot.label ?? '');
    if (slot.fieldTeam) client.setTextField(slot.vmixInputKey, slot.fieldTeam, team?.name ?? '');
    if (slot.fieldLogo && team?.logo) client.setImageField(slot.vmixInputKey, slot.fieldLogo, team.logo);
    if (slot.mergedPrefix && slot.mergedParts?.length) {
      const merged = slot.mergedParts
        .map(k => k === 'label' ? (slot.label ?? '') : (team?.name ?? ''))
        .join(slot.mergedSeparator ?? ' ');
      client.setTextField(slot.vmixInputKey, slot.mergedPrefix, merged);
    }
  };

  // Auto-send once THIS slot's placement transitions from unresolved to
  // resolved (or a manual override is typed) — never on every re-render,
  // same "send once decided" guard the other lower-thirds use.
  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!config.autoSend || !active || !activeTeam) return;
    const key = `${active.id}:${activeTeam.name}`;
    if (key === lastSentRef.current) return;
    lastSentRef.current = key;
    sendToVmix(active, activeTeam);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, activeTeam?.name, config.autoSend]);

  // Re-push on reconnect regardless of the dedup guard above.
  useEffect(() => {
    if (!config.autoSend || !active || !activeTeam) return;
    sendToVmix(active, activeTeam);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmixSyncVersion]);

  const configured = !!tournamentId && slots.length > 0;

  return (
    <div className="wgt-clt">

      {/* ── Placement picker overlay ──────────────────────────────────────── */}
      {showPicker && (
        <div className="wgt-clt-picker">
          <div className="wgt-clt-picker-hdr">
            <span className="wgt-clt-picker-title">Placements</span>
            <button
              className="wgt-clt-picker-close"
              onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setShowPicker(false); }}
              onClick={(e) => e.stopPropagation()}
            ><X size={14} strokeWidth={2} /></button>
          </div>
          <div className="wgt-clt-picker-list">
            {slots.length === 0 && (
              <div className="wgt-clt-picker-empty">No placements configured</div>
            )}
            {slots.map(s => {
              const t = resolveSlotTeam(s);
              return (
                <button
                  key={s.id}
                  className={`wgt-clt-picker-opt ${s.id === active?.id ? 'wgt-clt-picker-opt--active' : ''}`}
                  onPointerDown={(ev) => { ev.stopPropagation(); ev.currentTarget.setPointerCapture(ev.pointerId); setSelectedId(s.id); setShowPicker(false); }}
                  onClick={(ev) => ev.stopPropagation()}
                >
                  <span className="wgt-clt-picker-no">{s.rank}</span>
                  <span className="wgt-clt-picker-name">{s.label}</span>
                  <span className="wgt-clt-picker-team" style={{ color: t?.color }}>{t?.name ?? 'Not yet decided'}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Preview ───────────────────────────────────────────────────────── */}
      <div className="wgt-clt-preview">
        {!configured ? (
          <div className="wgt-clt-empty">{tournamentId ? 'Add a placement in settings' : 'Pick a tournament in settings'}</div>
        ) : active ? (
          <>
            <div className="wgt-clt-team-bar" style={{ background: activeTeam?.color ?? '#7f8c8d' }} />
            <div className="wgt-clt-info">
              <div className="wgt-clt-identity">
                {activeTeam?.logo && <img className="wgt-clt-team-logo" src={resolveImageUrl(activeTeam.logo)} alt="" />}
                <span className="wgt-clt-jersey">{active.rank}</span>
                <span className="wgt-clt-name">{active.label}</span>
              </div>
              <div className="wgt-clt-card-label" style={{ color: activeTeam?.color ?? 'var(--text-muted)' }}>
                {activeTeam?.name ?? 'Not yet decided'}
              </div>
            </div>
            {slots.length > 1 && (
              <button
                className="wgt-clt-switch-btn"
                title="Switch placement"
                onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setShowPicker(true); }}
                onClick={(e) => e.stopPropagation()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              ><ArrowLeftRight size={12} strokeWidth={2} /> {slots.length}</button>
            )}
          </>
        ) : (
          <div className="wgt-clt-empty">No placements configured</div>
        )}
      </div>

      {/* ── Actions ───────────────────────────────────────────────────────── */}
      <div className="wgt-clt-actions">
        <button
          className="wgt-clt-pick-btn"
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setShowPicker(true); }}
          onClick={(e) => e.stopPropagation()}
          disabled={slots.length === 0}
          title="Pick placement"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        ><ChevronDown size={12} strokeWidth={2} /> Pick</button>
        <button
          className="wgt-clt-btn wgt-clt-btn--send"
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); sendToVmix(active, activeTeam); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!client || !hasInput || !active}
          title="Send to vMix"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        ><ArrowUp size={12} strokeWidth={2} /> Send</button>
        <button
          className={`wgt-clt-btn wgt-clt-btn--show${overlayActive ? ' wgt-clt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayIn(ch, active?.vmixInputKey); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Show overlay"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        ><Eye size={12} strokeWidth={2} /> Show</button>
        <button
          className={`wgt-clt-btn wgt-clt-btn--hide${!overlayActive ? ' wgt-clt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayOut(ch); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Hide overlay"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        ><EyeOff size={12} strokeWidth={2} /> Hide</button>
      </div>
    </div>
  );
}
