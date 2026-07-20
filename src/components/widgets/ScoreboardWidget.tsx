import { useState, useMemo, useEffect, useContext, useRef } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useUndoStore } from '../../stores/undoStore';
import { resolveImageUrl } from '../../lib/imageUrl';
import { LogoUrlPicker } from '../LogoUrlPicker';
import { TeamPicker } from '../TeamPicker';
import { TeamMatchHistoryButton } from '../TeamMatchHistoryButton';
import { MatchSchedulePicker } from '../MatchSchedulePicker';
import { useMatchScheduleStore, type ScheduledMatch } from '../../stores/matchScheduleStore';
import { computeMatchSignature, buildResultFromConfig, buildLoadMatchPatch, guardScoreboardOverwrite, findDuplicateResult } from '../../utils/scoreboardSnapshot';
import { ConfirmModal } from '../ConfirmModal';
import { computeHeadToHead } from '../../lib/headToHead';
import { computeTeamTournamentStats } from '../../lib/teamTournamentStats';
import { HeadToHeadPanel } from './HeadToHeadPanel';
import { computeShootoutStatus, shootoutRoundsNeeded, type ShootoutRound } from '../../lib/shootout';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

type Increment = number | { label: string; value: number };

function resolveInc(inc: Increment): { label: string; value: number } {
  if (typeof inc === 'number') return { label: `+${inc}`, value: inc };
  return { label: inc.label || `+${inc.value}`, value: inc.value };
}

const SCORE_ABBREVS: Record<string, string> = {
  'try': 'TRY', 'tries': 'TRY',
  'conversion': 'CONV', 'conv': 'CONV',
  'penalty try': 'P.TRY', 'pen try': 'P.TRY', 'ptry': 'P.TRY', 'p.try': 'P.TRY',
  'drop kick': 'DROP', 'drop goal': 'DROP', 'dropkick': 'DROP', 'dkick': 'DROP', 'd.kick': 'DROP', 'drop': 'DROP',
  'penalty': 'PEN', 'penalty goal': 'PEN', 'penalty kick': 'PEN', 'pen': 'PEN',
  'goal': 'GOAL', 'field goal': 'FG', 'fg': 'FG',
  'touchdown': 'TD', 'td': 'TD',
  'point after': 'PAT', 'pat': 'PAT',
  'extra point': 'XP', 'xp': 'XP',
  'free kick': 'FREE', 'behind': 'BEHIND',
};

function simpleLabel(label: string): string {
  // Strip leading +/- number prefix: "+5 Try" → "Try", "+5" → "5"
  const word = label.replace(/^[+-]?\d+\s*/, '').trim();
  const base = word || label.replace(/^[+-]/, '');
  return SCORE_ABBREVS[base.toLowerCase()] ?? base;
}

interface Pending { team: 'A' | 'B'; value: number; label: string; }

const DEC_AMOUNTS = [7, 5, 3, 1];

interface ScoreButtonsProps {
  team: 'A' | 'B';
  increments: Increment[];
  onScore: (team: 'A' | 'B', value: number, label: string) => void;
  onDec: (team: 'A' | 'B', amount: number) => void;
  buttonSize?: number;
  teamColor?: string;
}

function ScoreButtons({ team, increments, onScore, onDec, buttonSize = 1, teamColor }: ScoreButtonsProps) {
  const sz = Math.round(34 * buttonSize);
  const dsz = Math.round(22 * buttonSize);
  return (
    <div className="wgt-score-btns">
      {increments.map((inc, i) => {
        const { label, value } = resolveInc(inc);
        const word = simpleLabel(label);
        return (
          <button
            key={i}
            className="wgt-score-inc"
            style={{
              fontSize: sz * 0.38,
              height: sz,
              ...(teamColor ? { background: teamColor, boxShadow: `0 3px 10px ${teamColor}55` } : {}),
            }}
            onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); onScore(team, value, label); }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="wgt-score-inc-circle">{value}</span>
            <span className="wgt-score-inc-lbl">{word}</span>
          </button>
        );
      })}
      <div className="wgt-score-dec-group">
        {DEC_AMOUNTS.map(n => (
          <button
            key={n}
            className="wgt-score-dec"
            style={{ width: dsz, height: dsz }}
            onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); onDec(team, n); }}
            onClick={(e) => e.stopPropagation()}
          >–{n}</button>
        ))}
      </div>
    </div>
  );
}

export function ScoreboardWidget({ widgetId, config }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  // CanvasActionContext is only provided on the commentator canvas — its
  // presence doubles as the commentator-mode flag (see canvasContext.ts).
  const isCommentator = !!ctx;
  const { pages, scoreWidgetAction, resetWidgetScore, resetWidgetTimer } = store;
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { teams: teamDbTeams } = useTeamDbStore();
  const { client, vmixSyncVersion } = useVmixStore();
  const { results: savedResults, addResult, updateResult } = useMatchResultsStore();
  const { markSent, markCompleted, matches: scheduledMatches } = useMatchScheduleStore();

  // When linked, mirror the source scoreboard's display state
  const allWidgets = useMemo(() => pages.flatMap(p => p.widgets), [pages]);
  const sourceWidget = config.linkedScoreboardSourceId
    ? allWidgets.find(w => w.id === config.linkedScoreboardSourceId && w.type === 'scoreboard')
    : null;
  const isLinked = !!sourceWidget;
  const dc: Record<string, any> = sourceWidget?.config ?? config;

  // A canvas is normally dedicated to one tournament — falls back to that
  // instead of requiring "which tournament" to be picked on every widget.
  const pageTournamentId = pages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const effTournamentId: string | undefined = dc.linkedTournamentId || pageTournamentId;

  // Live status pill reflects the linked timer's actual state (reusing the
  // same linkedTimerWidgetId already used for score-log timestamps) instead
  // of always showing a static "LIVE".
  const linkedTimer = dc.linkedTimerWidgetId
    ? allWidgets.find(w => w.id === dc.linkedTimerWidgetId && w.type === 'timer')
    : null;
  const tCfg = linkedTimer?.config;
  const liveStatus = !tCfg
    ? { label: 'LIVE', color: '#e74c3c', pulse: true }
    : tCfg.inFinalPlay
      ? { label: 'FINAL PLAY', color: '#e74c3c', pulse: true }
      : (tCfg.inBreak || tCfg.etInBreak)
        ? { label: 'HALF TIME', color: '#e67e22', pulse: false }
        : tCfg.running
          ? { label: 'LIVE', color: '#e74c3c', pulse: true }
          : { label: 'NOT LIVE', color: '#7f8c9a', pulse: false };

  // Captures the real kickoff time as the moment the linked timer first
  // starts running for this match (rather than the pre-scheduled fixture
  // time) — only meaningful on the primary board that owns the data.
  const prevTimerRunning = useRef(false);
  useEffect(() => {
    if (isLinked) return;
    const nowRunning = !!tCfg?.running;
    if (nowRunning && !prevTimerRunning.current && !config.actualKickoffAt) {
      updateWidgetConfig(widgetId, { actualKickoffAt: Date.now() });
    }
    prevTimerRunning.current = nowRunning;
  }, [tCfg?.running, isLinked, config.actualKickoffAt, widgetId, updateWidgetConfig]);

  const increments: Increment[] = config.increments ?? [1, 2, 5, 10];
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingDec, setPendingDec] = useState<{ team: 'A' | 'B'; value: number } | null>(null);

  // Send short name + text field to vMix when values change
  useEffect(() => {
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [{ ...config, inputKey: config.vmixInputKey }] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = client;
      if (!c) continue;
      if (t.fieldShortA && config.teamAShortName != null) c.setTextField(t.inputKey, t.fieldShortA, config.teamAShortName);
      if (t.fieldShortB && config.teamBShortName != null) c.setTextField(t.inputKey, t.fieldShortB, config.teamBShortName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.teamAShortName, config.teamBShortName, vmixSyncVersion]);

  useEffect(() => {
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [{ ...config, inputKey: config.vmixInputKey }] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = client;
      if (!c) continue;
      if (t.fieldTextA && config.teamATextField != null) c.setTextField(t.inputKey, t.fieldTextA, config.teamATextField);
      if (t.fieldTextB && config.teamBTextField != null) c.setTextField(t.inputKey, t.fieldTextB, config.teamBTextField);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.teamATextField, config.teamBTextField, vmixSyncVersion]);

  useEffect(() => {
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [{ ...config, inputKey: config.vmixInputKey }] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = client;
      if (!c) continue;
      if (t.fieldTeamA && config.teamAName != null) c.setTextField(t.inputKey, t.fieldTeamA, config.teamAName);
      if (t.fieldTeamB && config.teamBName != null) c.setTextField(t.inputKey, t.fieldTeamB, config.teamBName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.teamAName, config.teamBName, vmixSyncVersion]);

  useEffect(() => {
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [{ ...config, inputKey: config.vmixInputKey }] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = client;
      if (!c) continue;
      if (t.fieldLogoA && config.teamALogo) c.setImageField(t.inputKey, t.fieldLogoA, config.teamALogo);
      if (t.fieldLogoB && config.teamBLogo) c.setImageField(t.inputKey, t.fieldLogoB, config.teamBLogo);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.teamALogo, config.teamBLogo, vmixSyncVersion]);

  useEffect(() => {
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [{ ...config, inputKey: config.vmixInputKey }] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = client;
      if (!c) continue;
      if (t.fieldCompetition && config.competition != null) c.setTextField(t.inputKey, t.fieldCompetition, config.competition);
      if (t.fieldCategory && config.category != null) c.setTextField(t.inputKey, t.fieldCategory, config.category);
      if (t.fieldGroup && config.group != null) c.setTextField(t.inputKey, t.fieldGroup, config.group);
      if (t.fieldScheduledTime && config.scheduledTime != null) c.setTextField(t.inputKey, t.fieldScheduledTime, config.scheduledTime);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.competition, config.category, config.group, config.scheduledTime, vmixSyncVersion]);

  useEffect(() => {
    if (isLinked) return;
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [{ ...config, inputKey: config.vmixInputKey }] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = client;
      if (!c) continue;
      if (t.fieldScoreA != null && t.fieldScoreA !== '') c.setTextField(t.inputKey, t.fieldScoreA, String(config.scoreA ?? 0));
      if (t.fieldScoreB != null && t.fieldScoreB !== '') c.setTextField(t.inputKey, t.fieldScoreB, String(config.scoreB ?? 0));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.scoreA, config.scoreB, vmixSyncVersion]);

  const pointCounts = useMemo(() => {
    const log: any[] = dc.scoreLog ?? [];
    const tally: Record<string, { value: number; A: number; B: number }> = {};
    for (const entry of log) {
      const pts: number = entry.points ?? (parseFloat((entry.action ?? '').replace('+', '')) || 0);
      if (pts <= 0) continue;
      const key: string = entry.action ?? `+${pts}`;
      if (!tally[key]) tally[key] = { value: pts, A: 0, B: 0 };
      tally[key][(entry.team as 'A' | 'B')]++;
    }
    const srcIncs: Increment[] = dc.increments ?? [1, 2, 5, 10];
    const posIncs = (srcIncs as Increment[])
      .map(i => typeof i === 'number' ? { label: `+${i}`, value: i } : { label: i.label || `+${i.value}`, value: i.value })
      .filter(i => i.value > 0);
    const seenLabels = new Set<string>();
    return posIncs
      .filter(inc => { if (seenLabels.has(inc.label)) return false; seenLabels.add(inc.label); return true; })
      .map(inc => ({ key: inc.label, label: inc.label, A: tally[inc.label]?.A ?? 0, B: tally[inc.label]?.B ?? 0 }))
      .filter(row => row.A > 0 || row.B > 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dc.scoreLog, dc.increments]);

  function resolveSquad(linkedId: string) {
    const plw = allWidgets.find(w => w.id === linkedId);
    if (!plw) return [];
    const plCfg = plw.config;
    const team = teamDbTeams.find(t => t.id === plCfg.linkedTeamId);
    const players = team?.players ?? [];
    const assigned = new Set(
      [...(plCfg.starters ?? []), ...(plCfg.subs ?? [])].filter(Boolean) as string[]
    );
    return players
      .filter(p => assigned.has(p.id))
      .sort((a, b) => (parseInt(a.jerseyNo) || 999) - (parseInt(b.jerseyNo) || 999));
  }

  const squadA = useMemo(
    () => resolveSquad(config.linkedPlayerListA ?? ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.linkedPlayerListA, allWidgets, teamDbTeams]
  );
  const squadB = useMemo(
    () => resolveSquad(config.linkedPlayerListB ?? ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.linkedPlayerListB, allWidgets, teamDbTeams]
  );

  const teamAColor = dc.teamAColor ?? '#e74c3c';
  const teamBColor = dc.teamBColor ?? '#3498db';

  const handleColorChange = (team: 'A' | 'B', color: string) => {
    const field = team === 'A' ? 'teamAColor' : 'teamBColor';
    updateWidgetConfig(widgetId, { [field]: color });
  };

  // Fills name + short name + color + logo together from a saved team pick.
  const handleTeamPick = (team: 'A' | 'B', picked: { name: string; shortName?: string; color: string; logo?: string }) => {
    const patch = team === 'A'
      ? { teamAName: picked.name, teamAShortName: picked.shortName ?? '', teamAColor: picked.color, teamALogo: picked.logo ?? '' }
      : { teamBName: picked.name, teamBShortName: picked.shortName ?? '', teamBColor: picked.color, teamBLogo: picked.logo ?? '' };
    updateWidgetConfig(widgetId, patch);
  };

  const handleLogoPick = (team: 'A' | 'B', logo: string) => {
    const field = team === 'A' ? 'teamALogo' : 'teamBLogo';
    updateWidgetConfig(widgetId, { [field]: logo });
  };

  // Snapshots the current matchup into the saved results list (powers the
  // "recent-matches" widget) — doesn't touch the live score/log, just records it.
  const [savedFlash, setSavedFlash] = useState(false);
  const [duplicateResultId, setDuplicateResultId] = useState<string | null>(null);
  const commitSaveResult = (existingId?: string) => {
    const patch = buildResultFromConfig({ ...dc, linkedTournamentId: effTournamentId });
    if (existingId) updateResult(existingId, patch);
    else addResult(patch);
    updateWidgetConfig(widgetId, { lastSavedSignature: computeMatchSignature(dc) });
    // If this match came from the Schedule tab, mark that fixture completed.
    if (dc.linkedScheduleMatchId) markCompleted(dc.linkedScheduleMatchId);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  };
  const saveResult = () => {
    const existing = findDuplicateResult(savedResults, { ...dc, linkedTournamentId: effTournamentId });
    if (existing) { setDuplicateResultId(existing.id); return; }
    commitSaveResult();
  };

  // Applies a scheduled fixture's team details + competition/round to this
  // scoreboard in one click — the reverse of saveResult (schedule → board,
  // rather than board → results). Score is left untouched (starts fresh).
  // Guards against silently losing the outgoing match: auto-saves it if it
  // was never saved, or confirms before overwriting if it already was.
  const loadScheduledMatch = (m: ScheduledMatch) => {
    if (!guardScoreboardOverwrite({ ...dc, linkedTournamentId: effTournamentId }, addResult)) return;
    updateWidgetConfig(widgetId, buildLoadMatchPatch(m));
    // A new match starting means the previous one's clock shouldn't carry over.
    if (dc.linkedTimerWidgetId) resetWidgetTimer(dc.linkedTimerWidgetId);
    markSent(m.id);
  };

  const handleScore = (team: 'A' | 'B', value: number, label: string) => {
    const squad = team === 'A' ? squadA : squadB;
    if (squad.length > 0 && value > 0) {
      setPending({ team, value, label });
    } else {
      scoreWidgetAction(widgetId, team, value, label);
    }
  };

  const handleDec = (team: 'A' | 'B', amount: number) => {
    setPendingDec({ team, value: amount });
    setPending(null);
  };

  const confirmDec = () => {
    if (!pendingDec) return;
    scoreWidgetAction(widgetId, pendingDec.team, -pendingDec.value, `–${pendingDec.value}`);
    setPendingDec(null);
  };

  const confirmWithPlayer = (playerName: string, jerseyNo?: string) => {
    if (!pending) return;
    scoreWidgetAction(widgetId, pending.team, pending.value, pending.label, playerName, jerseyNo);
    setPending(null);
  };

  const pendingTeamColor = pending?.team === 'A' ? teamAColor : teamBColor;
  const pendingTeamName  = pending?.team === 'A'
    ? (config.teamAName ?? 'Team A')
    : (config.teamBName ?? 'Team B');
  const pendingSquad = pending ? (pending.team === 'A' ? squadA : squadB) : [];

  // Fixtures not yet marked completed — a saved result can exist for one of
  // these (an in-progress "Save Result" click, or the auto-save that runs
  // before a board gets overwritten) without the match actually being over,
  // so H2H/tournament stats shouldn't count it as played yet.
  const incompleteScheduleIds = useMemo(
    () => new Set(scheduledMatches.filter(m => !m.completedAt).map(m => m.id)),
    [scheduledMatches]
  );
  const h2h = useMemo(
    () => computeHeadToHead(
      savedResults,
      { name: dc.teamAName ?? 'Team A', shortName: dc.teamAShortName },
      { name: dc.teamBName ?? 'Team B', shortName: dc.teamBShortName },
      incompleteScheduleIds,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savedResults, dc.teamAName, dc.teamBName, dc.teamAShortName, dc.teamBShortName, incompleteScheduleIds]
  );
  const aTeamStats = useMemo(
    () => computeTeamTournamentStats(savedResults, { name: dc.teamAName ?? 'Team A', shortName: dc.teamAShortName }, effTournamentId, incompleteScheduleIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savedResults, dc.teamAName, dc.teamAShortName, effTournamentId, incompleteScheduleIds]
  );
  const bTeamStats = useMemo(
    () => computeTeamTournamentStats(savedResults, { name: dc.teamBName ?? 'Team B', shortName: dc.teamBShortName }, effTournamentId, incompleteScheduleIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savedResults, dc.teamBName, dc.teamBShortName, effTournamentId, incompleteScheduleIds]
  );
  // The board's own configured scoring categories (e.g. Try/Conversion/Drop
  // Goal for rugby) — passed to the H2H panel so its breakdown rows always
  // list every point type this sport uses, not just whichever were scored.
  const pointTypeLabels = useMemo(
    () => ((dc.increments ?? [1, 2, 5, 10]) as Increment[]).map(inc => resolveInc(inc).label),
    [dc.increments]
  );

  return (
    <div className="wgt-score" onClick={() => { pending && setPending(null); pendingDec && setPendingDec(null); }}>

      {/* ── Linked badge ─────────────────────────────────────────── */}
      {isLinked && (
        <div className="wgt-score-linked-badge" title={`Linked to: ${sourceWidget?.label ?? sourceWidget?.id}`}>↗ {sourceWidget?.label ?? 'Linked'}</div>
      )}

      {/* ── Quick scorer picker ──────────────────────────────────── */}
      {!isLinked && pending && (
        <div className="wgt-score-picker" style={{ borderTopColor: pendingTeamColor }} onClick={e => e.stopPropagation()}>
          <div className="wgt-score-picker-hdr" style={{ borderBottomColor: pendingTeamColor }}>
            <span className="wgt-score-picker-dot" style={{ background: pendingTeamColor }} />
            <span className="wgt-score-picker-team">{pendingTeamName}</span>
            <span className="wgt-score-picker-type">{pending.label}</span>
            <button className="wgt-score-picker-close" onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setPending(null); }}>✕</button>
          </div>
          <div className="wgt-score-picker-list">
            {pendingSquad.map(p => (
              <button key={p.id} className="wgt-score-picker-opt" onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); confirmWithPlayer(p.name, p.jerseyNo || undefined); }}>
                {p.jerseyNo && <span className="wgt-score-picker-no">{p.jerseyNo}</span>}
                <span className="wgt-score-picker-name">{p.name}</span>
              </button>
            ))}
          </div>
          <button className="wgt-score-picker-skip" onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); confirmWithPlayer(''); }}>
            — No scorer / Skip
          </button>
        </div>
      )}

      {/* ── Header: LIVE pill + competition + category/group/time ─── */}
      <div className="wgt-score-top">
        <div className="wgt-score-live-pill">
          <span className="wgt-score-live-dot" style={{ background: liveStatus.color, animation: liveStatus.pulse ? undefined : 'none' }} />
          {liveStatus.label}
        </div>
        {isLinked ? (
          <>
            {dc.competition && <span className="wgt-score-comp-name">{dc.competition}</span>}
            {dc.category && <span className="wgt-score-meta-badge">🏷 {dc.category}</span>}
            {dc.group && <span className="wgt-score-meta-badge">📋 {dc.group}</span>}
            {dc.scheduledTime && <span className="wgt-score-meta-badge">🕐 {dc.scheduledTime}</span>}
          </>
        ) : (
          <>
            <input
              className="wgt-score-comp-name"
              value={config.competition ?? ''}
              placeholder="Competition"
              onChange={e => updateWidgetConfig(widgetId, { competition: e.target.value })}
              onClick={e => e.stopPropagation()}
            />
            <input
              className="wgt-score-meta-input"
              value={config.category ?? ''}
              placeholder="Category"
              onChange={e => updateWidgetConfig(widgetId, { category: e.target.value })}
              onClick={e => e.stopPropagation()}
            />
            <input
              className="wgt-score-meta-input"
              value={config.group ?? ''}
              placeholder="Group"
              onChange={e => updateWidgetConfig(widgetId, { group: e.target.value })}
              onClick={e => e.stopPropagation()}
            />
            <input
              className="wgt-score-meta-input"
              type="time"
              value={config.scheduledTime ?? ''}
              title="Scheduled kickoff time"
              onChange={e => updateWidgetConfig(widgetId, { scheduledTime: e.target.value })}
              onClick={e => e.stopPropagation()}
            />
          </>
        )}
        {!isLinked && (
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
            <MatchSchedulePicker onPick={loadScheduledMatch} tournamentId={effTournamentId} />
            {dc.enableShootout && (
              <button
                className={`wgt-score-shootout-btn${dc.shootoutOpen ? ' wgt-score-shootout-btn--active' : ''}`}
                title="Penalty Shootout / Place-Kick Competition"
                onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); updateWidgetConfig(widgetId, { shootoutOpen: !dc.shootoutOpen }); }}
                onClick={e => e.stopPropagation()}
              >🥅 Shootout</button>
            )}
            <button
              className={`wgt-score-save-btn${savedFlash ? ' wgt-score-save-btn--flash' : ''}`}
              title="Save this result to Latest Results"
              onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); saveResult(); }}
              onClick={e => e.stopPropagation()}
            >{savedFlash ? '✓ Saved' : '💾 Save Result'}</button>
          </div>
        )}
      </div>

      {/* ── Matchup: Team A | Score | Team B ─────────────────────── */}
      <div className="wgt-score-matchup">
        {/* Team A */}
        <div className="wgt-score-mteam">
          <div className="wgt-score-mlogo-wrap" onClick={e => e.stopPropagation()}>
            {isLinked ? (
              isCommentator ? (
                <TeamMatchHistoryButton teamName={dc.teamAName ?? 'Team A'} teamShortName={dc.teamAShortName} logo={dc.teamALogo} color={teamAColor} category={dc.category} tournamentId={effTournamentId} />
              ) : (
                dc.teamALogo
                  ? <img className="wgt-score-mlogo" src={resolveImageUrl(dc.teamALogo)} alt="" />
                  : <div className="wgt-score-mlogo-ph" style={{ background: teamAColor }} />
              )
            ) : (
              <LogoUrlPicker
                compact
                value={dc.teamALogo ?? ''}
                onChange={logo => handleLogoPick('A', logo)}
                thumbSize={{ w: 54, h: 54 }}
                thumbContent={
                  dc.teamALogo
                    ? <img className="wgt-score-mlogo" src={resolveImageUrl(dc.teamALogo)} alt="" />
                    : <div className="wgt-score-mlogo-ph" style={{ background: teamAColor }} />
                }
              />
            )}
            {!isLinked && (
              <input
                type="color"
                className="wgt-score-mcolor"
                value={teamAColor}
                title="Team A color"
                onChange={e => handleColorChange('A', e.target.value)}
                onClick={e => e.stopPropagation()}
              />
            )}
          </div>
          {isLinked ? (
            <span className="wgt-score-mname" style={{ color: teamAColor, fontSize: config.nameFontSize ?? 14 }}>
              {dc.teamAName ?? 'Team A'}
            </span>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%', minWidth: 0 }} onClick={e => e.stopPropagation()}>
              <input
                className="wgt-score-mname"
                value={config.teamAName ?? ''}
                placeholder="Team A"
                style={{ color: teamAColor, fontSize: config.nameFontSize ?? 14, width: 'auto', flex: '1 1 auto', minWidth: 0 }}
                onChange={e => updateWidgetConfig(widgetId, { teamAName: e.target.value })}
              />
              <div style={{ flexShrink: 0 }}>
                <TeamPicker
                  onPick={picked => handleTeamPick('A', picked)}
                  current={{ name: config.teamAName, shortName: config.teamAShortName, color: teamAColor, logo: dc.teamALogo }}
                />
              </div>
            </div>
          )}
          {isLinked
            ? (dc.teamAShortName ? <span className="wgt-score-mshort" style={{ color: teamAColor }}>{dc.teamAShortName}</span> : null)
            : <input className="wgt-score-mshort" value={config.teamAShortName ?? ''} placeholder="Short"
                style={{ color: teamAColor }}
                onChange={e => updateWidgetConfig(widgetId, { teamAShortName: e.target.value })}
                onClick={e => e.stopPropagation()} />
          }
        </div>

        {/* Score center */}
        <div className="wgt-score-mcenter">
          <div className="wgt-score-mnums">
            <span className="wgt-score-mnum" style={{ color: teamAColor, fontSize: config.scoreFontSize ?? 52 }}>{dc.scoreA ?? 0}</span>
            <span className="wgt-score-mcolon" style={{ fontSize: config.scoreFontSize ?? 52 }}>:</span>
            <span className="wgt-score-mnum" style={{ color: teamBColor, fontSize: config.scoreFontSize ?? 52 }}>{dc.scoreB ?? 0}</span>
          </div>
        </div>

        {/* Team B */}
        <div className="wgt-score-mteam wgt-score-mteam--b">
          <div className="wgt-score-mlogo-wrap" onClick={e => e.stopPropagation()}>
            {isLinked ? (
              isCommentator ? (
                <TeamMatchHistoryButton teamName={dc.teamBName ?? 'Team B'} teamShortName={dc.teamBShortName} logo={dc.teamBLogo} color={teamBColor} category={dc.category} tournamentId={effTournamentId} />
              ) : (
                dc.teamBLogo
                  ? <img className="wgt-score-mlogo" src={resolveImageUrl(dc.teamBLogo)} alt="" />
                  : <div className="wgt-score-mlogo-ph" style={{ background: teamBColor }} />
              )
            ) : (
              <LogoUrlPicker
                compact
                value={dc.teamBLogo ?? ''}
                onChange={logo => handleLogoPick('B', logo)}
                thumbSize={{ w: 54, h: 54 }}
                thumbContent={
                  dc.teamBLogo
                    ? <img className="wgt-score-mlogo" src={resolveImageUrl(dc.teamBLogo)} alt="" />
                    : <div className="wgt-score-mlogo-ph" style={{ background: teamBColor }} />
                }
              />
            )}
            {!isLinked && (
              <input
                type="color"
                className="wgt-score-mcolor"
                value={teamBColor}
                title="Team B color"
                onChange={e => handleColorChange('B', e.target.value)}
                onClick={e => e.stopPropagation()}
              />
            )}
          </div>
          {isLinked ? (
            <span className="wgt-score-mname" style={{ color: teamBColor, fontSize: config.nameFontSize ?? 14 }}>
              {dc.teamBName ?? 'Team B'}
            </span>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%', minWidth: 0 }} onClick={e => e.stopPropagation()}>
              <input
                className="wgt-score-mname"
                value={config.teamBName ?? ''}
                placeholder="Team B"
                style={{ color: teamBColor, fontSize: config.nameFontSize ?? 14, width: 'auto', flex: '1 1 auto', minWidth: 0 }}
                onChange={e => updateWidgetConfig(widgetId, { teamBName: e.target.value })}
              />
              <div style={{ flexShrink: 0 }}>
                <TeamPicker
                  onPick={picked => handleTeamPick('B', picked)}
                  current={{ name: config.teamBName, shortName: config.teamBShortName, color: teamBColor, logo: dc.teamBLogo }}
                />
              </div>
            </div>
          )}
          {isLinked
            ? (dc.teamBShortName ? <span className="wgt-score-mshort" style={{ color: teamBColor }}>{dc.teamBShortName}</span> : null)
            : <input className="wgt-score-mshort" value={config.teamBShortName ?? ''} placeholder="Short"
                style={{ color: teamBColor }}
                onChange={e => updateWidgetConfig(widgetId, { teamBShortName: e.target.value })}
                onClick={e => e.stopPropagation()} />
          }
        </div>
      </div>

      {/* ── Score buttons ────────────────────────────────────────── */}
      {!isLinked && (
        <div className="wgt-score-btns-outer">
          <ScoreButtons team="A" increments={increments} onScore={handleScore} onDec={handleDec} buttonSize={config.buttonSize ?? 1} teamColor={teamAColor} />
          <div className="wgt-score-mcenter wgt-score-mcenter--btns">
            {pointCounts.length > 0 && (
              <div className="wgt-score-stats-pill">
                {pointCounts.map(({ key, label, A, B }) => (
                  <div key={key} className="wgt-score-stat-row">
                    <div className="wgt-score-stat-side">
                      <span className="wgt-score-stat-dot" style={{ background: teamAColor }} />
                      <span className="wgt-score-stat-val" style={{ color: teamAColor }}>{A}</span>
                    </div>
                    <span className="wgt-score-stat-name">{simpleLabel(label)}</span>
                    <div className="wgt-score-stat-side wgt-score-stat-side--b">
                      <span className="wgt-score-stat-val" style={{ color: teamBColor }}>{B}</span>
                      <span className="wgt-score-stat-dot" style={{ background: teamBColor }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button
              className="wgt-score-rst"
              onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); resetWidgetScore(widgetId); }}
              onClick={(e) => e.stopPropagation()}
            >RST</button>
          </div>
          <ScoreButtons team="B" increments={increments} onScore={handleScore} onDec={handleDec} buttonSize={config.buttonSize ?? 1} teamColor={teamBColor} />

          {pendingDec && (() => {
            const isA = pendingDec.team === 'A';
            const tColor = isA ? teamAColor : teamBColor;
            const tName  = isA ? (config.teamAName ?? 'Team A') : (config.teamBName ?? 'Team B');
            const tLogo  = isA ? dc.teamALogo : dc.teamBLogo;
            return (
              <div className="wgt-score-dec-confirm" style={{ '--dec-confirm-color': tColor } as React.CSSProperties} onClick={e => e.stopPropagation()}>
                <span className="wgt-score-dec-confirm-label">Deduct points?</span>
                <span className="wgt-score-dec-confirm-amount">–{pendingDec.value}</span>
                <div className="wgt-score-dec-confirm-team">
                  {tLogo && <img className="wgt-score-dec-confirm-logo" src={resolveImageUrl(tLogo)} alt="" />}
                  <span style={{ color: tColor }}>{tName}</span>
                </div>
                <div className="wgt-score-dec-confirm-actions">
                  <button className="wgt-score-dec-confirm-yes" onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); confirmDec(); }}>✓ Confirm</button>
                  <button className="wgt-score-dec-confirm-no"  onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setPendingDec(null); }}>✕ Cancel</button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Penalty Shootout / Place-Kick Competition ────────────── */}
      {dc.enableShootout && dc.shootoutOpen && (() => {
        const kicksPerRound: number = dc.shootoutKicksPerRound ?? 5;
        const kicks: ShootoutRound[] = dc.shootoutKicks ?? [];
        const status = computeShootoutStatus(kicks, kicksPerRound);
        const rows = shootoutRoundsNeeded(kicks, kicksPerRound);
        const setKick = (i: number, side: 'a' | 'b', made: boolean | undefined) => {
          const next = kicks.slice();
          while (next.length <= i) next.push({});
          next[i] = { ...next[i], [side]: made };
          updateWidgetConfig(widgetId, { shootoutKicks: next });
        };
        const winnerName = status.winner === 'A' ? (dc.teamAName ?? 'Team A') : status.winner === 'B' ? (dc.teamBName ?? 'Team B') : '';
        return (
          <div className="wgt-shootout">
            <div className="wgt-shootout-grid">
              {Array.from({ length: rows }).map((_, i) => {
                const round = kicks[i] ?? {};
                const cell = (side: 'a' | 'b', color: string) => {
                  const v = round[side];
                  if (v === undefined) {
                    return !isLinked ? (
                      <div className="wgt-shootout-cell wgt-shootout-cell--pick">
                        <button className="wgt-shootout-mark wgt-shootout-mark--yes"
                          onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setKick(i, side, true); }}
                          onClick={e => e.stopPropagation()}>✓</button>
                        <button className="wgt-shootout-mark wgt-shootout-mark--no"
                          onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setKick(i, side, false); }}
                          onClick={e => e.stopPropagation()}>✗</button>
                      </div>
                    ) : (
                      <div className="wgt-shootout-dot wgt-shootout-dot--empty" style={{ borderColor: color }} />
                    );
                  }
                  return (
                    <button
                      className={`wgt-shootout-dot wgt-shootout-dot--${v ? 'made' : 'missed'}`}
                      disabled={isLinked}
                      onPointerDown={e => { e.stopPropagation(); if (isLinked) return; e.currentTarget.setPointerCapture(e.pointerId); setKick(i, side, undefined); }}
                      onClick={e => e.stopPropagation()}
                    >{v ? '✓' : '✗'}</button>
                  );
                };
                return (
                  <div key={i} className="wgt-shootout-row">
                    {cell('a', teamAColor)}
                    <span className="wgt-shootout-round-no">{i + 1}</span>
                    {cell('b', teamBColor)}
                  </div>
                );
              })}
            </div>
            <div className="wgt-shootout-tally">
              <span style={{ color: teamAColor }}>{status.scoreA}</span>
              <span className="wgt-shootout-tally-sep">–</span>
              <span style={{ color: teamBColor }}>{status.scoreB}</span>
            </div>
            {status.decided && (
              <div className="wgt-shootout-winner">🏆 {winnerName} win the shootout {status.scoreA}-{status.scoreB}</div>
            )}
            {!isLinked && kicks.length > 0 && (
              <button className="wgt-shootout-reset" onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); const before = kicks; updateWidgetConfig(widgetId, { shootoutKicks: [] }); useUndoStore.getState().pushUndo('Reset shootout', () => updateWidgetConfig(widgetId, { shootoutKicks: before })); }} onClick={e => e.stopPropagation()}>Reset</button>
            )}
          </div>
        );
      })()}

      {/* ── Head to head ──────────────────────────────────────────── */}
      {config.showHeadToHead && (
        <HeadToHeadPanel
          stats={h2h}
          aTeamStats={aTeamStats}
          bTeamStats={bTeamStats}
          teamAName={dc.teamAName ?? 'Team A'}
          teamBName={dc.teamBName ?? 'Team B'}
          teamAShortName={dc.teamAShortName}
          teamBShortName={dc.teamBShortName}
          teamALogo={dc.teamALogo}
          teamBLogo={dc.teamBLogo}
          teamAColor={teamAColor}
          teamBColor={teamBColor}
          category={dc.category}
          tournamentId={effTournamentId}
          pointTypeLabels={pointTypeLabels}
          showRecord={config.h2hShowRecord ?? true}
          showMeetings={config.h2hShowLastMeetings ?? true}
          maxMeetings={config.h2hMaxMeetings ?? 5}
          showBreakdown={config.h2hShowBreakdown ?? true}
          showTeamStats={config.h2hShowTeamStats ?? true}
          showForm={config.h2hShowForm ?? true}
        />
      )}

      {duplicateResultId && (
        <ConfirmModal
          title="Overwrite existing result?"
          message="A result for this fixture already exists. Save again to overwrite it with the current score?"
          confirmLabel="Overwrite"
          danger
          onConfirm={() => { commitSaveResult(duplicateResultId); setDuplicateResultId(null); }}
          onCancel={() => setDuplicateResultId(null)}
        />
      )}
    </div>
  );
}
