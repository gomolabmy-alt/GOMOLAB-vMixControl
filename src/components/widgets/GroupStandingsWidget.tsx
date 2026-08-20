import { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { Send } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { SPORT_DEFAULTS } from '../../types/tournament';
import { CanvasActionContext } from '../../lib/canvasContext';
import { findTeamRecord } from '../../lib/teamForm';
import { autoLinkedWidget } from '../../lib/autoLink';
import { computeStandings, isPoolStageResult, normalizeGroups, StandingsTable, type StandingRow } from '../TournamentManager';
import { transparentLogoUrl } from '../../lib/imageUrl';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

// One row's worth of vMix fields, index-suffixed per team (Rank1.Text,
// Rank2.Text, ...) — same convention as MatchScheduleWidget's fixture-list
// push, since a standings table is the same shape (N rows, fixed columns).
type GroupStandingsMergePart = 'rank' | 'team' | 'shortTeam' | 'played' | 'won' | 'drawn' | 'lost' | 'pf' | 'pa' | 'diff' | 'pts';
function resolveGroupStandingsPart(r: StandingRow, i: number, key: GroupStandingsMergePart): string {
  switch (key) {
    case 'rank':      return String(i + 1);
    case 'team':      return r.name;
    case 'shortTeam': return r.shortName ?? '';
    case 'played': return String(r.played);
    case 'won':    return String(r.won);
    case 'drawn':  return String(r.drawn);
    case 'lost':   return String(r.lost);
    case 'pf':     return String(r.pf);
    case 'pa':     return String(r.pa);
    case 'diff':   return `${r.pf - r.pa > 0 ? '+' : ''}${r.pf - r.pa}`;
    case 'pts':    return String(r.pts);
  }
}

// Shows the standings table for just the ONE group the linked scoreboard's
// current match belongs to — the operator doesn't pick a group by hand,
// it follows whichever teams are loaded on the scoreboard (same auto-link
// pattern as PlayerStatsWidget/PlayerHighlightWidget). Useful as a "Group A
// Standings" graphic that stays correct as the scoreboard moves between
// matches/groups through the day.
export function GroupStandingsWidget({ widgetId, config }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { pages, commentatorPages } = store;
  const { getClient, vmixState, vmixSyncVersion } = useVmixStore();
  const { teams: allTeams } = useTeamDbStore();
  const { results: allResults } = useMatchResultsStore();
  const { tournaments } = useTournamentStore();

  const allPages = [...pages, ...commentatorPages];
  const linkedScoreboard = autoLinkedWidget(allPages, widgetId, config.linkedScoreboardId, 'scoreboard');
  const dc = linkedScoreboard?.config ?? {};
  const teamAName: string = dc.teamAName ?? '';
  const teamBName: string = dc.teamBName ?? '';
  const category: string | undefined = dc.category;
  const pageTournamentId = allPages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const tournamentId: string | undefined = dc.linkedTournamentId || pageTournamentId;
  const tournament = tournaments.find(t => t.id === tournamentId);

  // Either side resolving a group is enough — in a normal round-robin pool
  // both teams share one, so Team A wins when both do.
  const teamARecord = tournament ? findTeamRecord(allTeams, teamAName, category, tournament.id) : undefined;
  const teamBRecord = tournament ? findTeamRecord(allTeams, teamBName, category, tournament.id) : undefined;
  const groupName = teamARecord?.group || teamBRecord?.group || '';

  const rows: StandingRow[] = useMemo(() => {
    if (!tournament || !groupName) return [];
    const settings = tournament.settings ?? SPORT_DEFAULTS[tournament.sport];
    const groupTeams = allTeams.filter(t => t.tournamentId === tournament.id && (!category || t.category === category) && t.group === groupName);
    // Group standings must only count pool-stage results — see isPoolStageResult.
    const poolResults = allResults.filter(r => r.tournamentId === tournament.id && isPoolStageResult(r));
    return computeStandings(groupTeams, poolResults, settings);
  }, [tournament, groupName, allTeams, allResults, category]);

  const groupLabel = useMemo(() => {
    if (!tournament || !groupName) return '';
    return normalizeGroups(tournament.groups).find(g => g.name === groupName)?.name ?? groupName;
  }, [tournament, groupName]);

  const title: string = config.title || 'Standings';

  const vmixInputKey: string = config.vmixInputKey ?? '';
  const PREFIX_FIELDS: { key: string; part: GroupStandingsMergePart }[] = [
    { key: 'rankPrefix', part: 'rank' }, { key: 'teamPrefix', part: 'team' }, { key: 'shortTeamPrefix', part: 'shortTeam' },
    { key: 'playedPrefix', part: 'played' }, { key: 'wonPrefix', part: 'won' },
    { key: 'drawnPrefix', part: 'drawn' }, { key: 'lostPrefix', part: 'lost' },
    { key: 'pfPrefix', part: 'pf' }, { key: 'paPrefix', part: 'pa' },
    { key: 'diffPrefix', part: 'diff' }, { key: 'ptsPrefix', part: 'pts' },
  ];

  const sendToVmix = useCallback(() => {
    const c = getClient();
    if (!c || !vmixInputKey || rows.length === 0) return;
    // One value for the whole table, not per-row like the fields below —
    // the group/pool name itself (e.g. "Pool A"), not a team's rank in it.
    if (config.groupField) c.setTextField(vmixInputKey, config.groupField, groupLabel);
    const prefixes = PREFIX_FIELDS.map(f => config[f.key] as string | undefined).concat(config.mergedPrefix);
    rows.forEach((r, i) => {
      const idx = i + 1;
      for (const f of PREFIX_FIELDS) {
        const prefix = config[f.key];
        if (prefix) c.setTextField(vmixInputKey, `${prefix}${idx}.Text`, resolveGroupStandingsPart(r, i, f.part));
      }
      if (config.logoPrefix) c.setImageField(vmixInputKey, `${config.logoPrefix}${idx}.Source`, r.logo || transparentLogoUrl());
      if (config.mergedPrefix && config.mergedParts?.length) {
        const merged = config.mergedParts.map((p: GroupStandingsMergePart) => resolveGroupStandingsPart(r, i, p)).join(config.mergedSeparator ?? ' ');
        c.setTextField(vmixInputKey, `${config.mergedPrefix}${idx}.Text`, merged);
      }
    });
    // Clear any extra same-prefix fields beyond the current row count, e.g.
    // leftover text from a previous, bigger group.
    const vmixInput = vmixState?.inputs?.find(inp => inp.key === vmixInputKey);
    if (vmixInput) {
      for (const prefix of prefixes) {
        if (!prefix) continue;
        const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${esc}(\\d+)\\.Text$`, 'i');
        for (const field of vmixInput.textFields) {
          const fm = field.name.match(re);
          if (fm && parseInt(fm[1]) > rows.length) c.setTextField(vmixInputKey, field.name, '');
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getClient, vmixState, vmixInputKey, rows, config, groupLabel]);

  const dataKey = rows.map(r => `${r.teamId}:${r.played}:${r.won}:${r.drawn}:${r.lost}:${r.pf}:${r.pa}:${r.pts}`).join('|');
  const prevKeyRef = useRef('');
  useEffect(() => {
    if (!vmixInputKey || !config.vmixAutoSync) return;
    if (dataKey === prevKeyRef.current && vmixSyncVersion === 0) return;
    prevKeyRef.current = dataKey;
    sendToVmix();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, vmixSyncVersion, config.vmixAutoSync]);

  if (!linkedScoreboard) {
    return <div className="wgt-standings wgt-standings--empty">Link a scoreboard in settings</div>;
  }
  if (!tournament) {
    return <div className="wgt-standings wgt-standings--empty">No tournament linked</div>;
  }
  // A never-loaded (or freshly reset) scoreboard still carries its
  // placeholder "Team A"/"Team B" names, which resolve to no real team and
  // so no group — call that out specifically rather than the more generic
  // "not assigned to a group" message below, which reads like a data
  // mistake on a team that's actually just not loaded yet.
  if (!dc.teamAId && !dc.teamBId) {
    return <div className="wgt-standings wgt-standings--empty">Load a match on the linked scoreboard first</div>;
  }
  if (!groupName) {
    return <div className="wgt-standings wgt-standings--empty">Scoreboard's team isn't assigned to a group</div>;
  }

  return (
    <div className="wgt-standings">
      <div className="wgt-standings-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span>{title}</span>
        {vmixInputKey && (
          <button className="wgt-p-stats-send-btn" onClick={sendToVmix} disabled={!getClient()} title="Send this group's standings to vMix now">
            <Send size={12} strokeWidth={2} /> Send
          </button>
        )}
      </div>
      <div className="wgt-standings-body">
        <StandingsTable title={groupLabel} rows={rows} />
      </div>
    </div>
  );
}
