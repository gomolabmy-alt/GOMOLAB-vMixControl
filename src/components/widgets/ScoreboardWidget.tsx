import { useState, useMemo, useEffect } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useVmixStore } from '../../stores/vmixStore';

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

interface Pending { team: 'A' | 'B'; value: number; label: string; }

const DEC_AMOUNTS = [7, 5, 3, 1];

interface ScoreButtonsProps {
  team: 'A' | 'B';
  increments: Increment[];
  onScore: (team: 'A' | 'B', value: number, label: string) => void;
  onDec: (team: 'A' | 'B', amount: number) => void;
  buttonSize?: number;
}

function ScoreButtons({ team, increments, onScore, onDec, buttonSize = 1 }: ScoreButtonsProps) {
  const incStyle = {
    minHeight: Math.round(48 * buttonSize),
    fontSize: Math.round(17 * buttonSize),
    padding: `${Math.round(8 * buttonSize)}px 4px`,
  };
  const decStyle = {
    minHeight: Math.round(36 * buttonSize),
    fontSize: Math.round(13 * buttonSize),
    padding: `${Math.round(5 * buttonSize)}px 2px`,
  };
  return (
    <div className="wgt-score-btns">
      {increments.map((inc, i) => {
        const { label, value } = resolveInc(inc);
        const lastOdd = i === increments.length - 1 && increments.length % 2 === 1;
        return (
          <button
            key={i}
            className="wgt-score-inc"
            style={{ ...incStyle, ...(lastOdd ? { gridColumn: '1 / -1' } : {}) }}
            onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); onScore(team, value, label); }}
            onClick={(e) => e.stopPropagation()}
          >
            {label}
          </button>
        );
      })}
      <div className="wgt-score-dec-group" style={{ gridColumn: '1 / -1' }}>
        {DEC_AMOUNTS.map(n => (
          <button
            key={n}
            className="wgt-score-dec"
            style={decStyle}
            onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); onDec(team, n); }}
            onClick={(e) => e.stopPropagation()}
          >–{n}</button>
        ))}
      </div>
    </div>
  );
}

export function ScoreboardWidget({ widgetId, config }: Props) {
  const { pages, scoreWidgetAction, resetWidgetScore, updateWidgetConfig } = useCanvasStore();
  const { tournaments, updateTeam } = useTournamentStore();
  const { client, getClientById } = useVmixStore();

  // When linked, mirror the source scoreboard's display state
  const allWidgets = useMemo(() => pages.flatMap(p => p.widgets), [pages]);
  const sourceWidget = config.linkedScoreboardSourceId
    ? allWidgets.find(w => w.id === config.linkedScoreboardSourceId && w.type === 'scoreboard')
    : null;
  const isLinked = !!sourceWidget;
  const dc: Record<string, any> = sourceWidget?.config ?? config;

  const increments: Increment[] = config.increments ?? [1, 2, 5, 10];
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingDec, setPendingDec] = useState<{ team: 'A' | 'B'; value: number } | null>(null);

  const tournament = config.linkedTournamentId
    ? tournaments.find(t => t.id === config.linkedTournamentId)
    : null;

  useEffect(() => {
    if (!tournament) return;
    const { teamA, teamB } = tournament;
    if (
      config.teamAName      !== teamA.name  ||
      config.teamBName      !== teamB.name  ||
      config.teamAShortName !== (teamA.shortName ?? config.teamAShortName) ||
      config.teamBShortName !== (teamB.shortName ?? config.teamBShortName) ||
      config.teamAColor     !== teamA.color ||
      config.teamBColor     !== teamB.color ||
      config.teamALogo      !== (teamA.logo ?? null) ||
      config.teamBLogo      !== (teamB.logo ?? null)
    ) {
      updateWidgetConfig(widgetId, {
        teamAName: teamA.name, teamBName: teamB.name,
        ...(teamA.shortName != null && { teamAShortName: teamA.shortName }),
        ...(teamB.shortName != null && { teamBShortName: teamB.shortName }),
        teamAColor: teamA.color, teamBColor: teamB.color,
        teamALogo: teamA.logo ?? null, teamBLogo: teamB.logo ?? null,
      });
      {
        const targets = config.vmixInputs?.length
          ? config.vmixInputs
          : config.vmixInputKey
            ? [{ inputKey: config.vmixInputKey, fieldTeamA: config.fieldTeamA, fieldTeamB: config.fieldTeamB, fieldLogoA: config.fieldLogoA, fieldLogoB: config.fieldLogoB }]
            : [];
        for (const t of targets) {
          if (!t.inputKey) continue;
          const c = getClientById(t.clientId);
          if (!c) continue;
          if (t.fieldTeamA) c.setTextField(t.inputKey, t.fieldTeamA, teamA.name);
          if (t.fieldTeamB) c.setTextField(t.inputKey, t.fieldTeamB, teamB.name);
          if (t.fieldLogoA && teamA.logo) c.setImageField(t.inputKey, t.fieldLogoA, teamA.logo);
          if (t.fieldLogoB && teamB.logo) c.setImageField(t.inputKey, t.fieldLogoB, teamB.logo);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournament?.teamA.name, tournament?.teamA.shortName, tournament?.teamA.color, tournament?.teamA.logo,
      tournament?.teamB.name, tournament?.teamB.shortName, tournament?.teamB.color, tournament?.teamB.logo]);

  // Send short name + text field to vMix when values change
  useEffect(() => {
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [config] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = getClientById(t.clientId);
      if (!c) continue;
      if (t.fieldShortA && config.teamAShortName != null) c.setTextField(t.inputKey, t.fieldShortA, config.teamAShortName);
      if (t.fieldShortB && config.teamBShortName != null) c.setTextField(t.inputKey, t.fieldShortB, config.teamBShortName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.teamAShortName, config.teamBShortName]);

  useEffect(() => {
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [config] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = getClientById(t.clientId);
      if (!c) continue;
      if (t.fieldTextA && config.teamATextField != null) c.setTextField(t.inputKey, t.fieldTextA, config.teamATextField);
      if (t.fieldTextB && config.teamBTextField != null) c.setTextField(t.inputKey, t.fieldTextB, config.teamBTextField);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.teamATextField, config.teamBTextField]);

  useEffect(() => {
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [config] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = getClientById(t.clientId);
      if (!c) continue;
      if (t.fieldTeamA && config.teamAName != null) c.setTextField(t.inputKey, t.fieldTeamA, config.teamAName);
      if (t.fieldTeamB && config.teamBName != null) c.setTextField(t.inputKey, t.fieldTeamB, config.teamBName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.teamAName, config.teamBName]);

  useEffect(() => {
    const targets: any[] = config.vmixInputs?.length ? config.vmixInputs : config.vmixInputKey ? [config] : [];
    for (const t of targets) {
      if (!t.inputKey) continue;
      const c = getClientById(t.clientId);
      if (!c) continue;
      if (t.fieldLogoA && config.teamALogo) c.setImageField(t.inputKey, t.fieldLogoA, config.teamALogo);
      if (t.fieldLogoB && config.teamBLogo) c.setImageField(t.inputKey, t.fieldLogoB, config.teamBLogo);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.teamALogo, config.teamBLogo]);


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
    const t = tournaments.find(t2 => t2.id === plCfg.linkedTournamentId);
    const side: 'A' | 'B' = plCfg.teamSide ?? 'A';
    const team = side === 'A' ? t?.teamA : t?.teamB;
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
    [config.linkedPlayerListA, allWidgets, tournaments]
  );
  const squadB = useMemo(
    () => resolveSquad(config.linkedPlayerListB ?? ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.linkedPlayerListB, allWidgets, tournaments]
  );

  const teamAColor = dc.teamAColor ?? '#e74c3c';
  const teamBColor = dc.teamBColor ?? '#3498db';

  const handleColorChange = (team: 'A' | 'B', color: string) => {
    const field = team === 'A' ? 'teamAColor' : 'teamBColor';
    updateWidgetConfig(widgetId, { [field]: color });
    if (tournament) updateTeam(tournament.id, team, { color });
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


      {/* ── Scoreboard ───────────────────────────────────────────── */}
      <div className="wgt-score-teams">
        {/* Team A */}
        <div className="wgt-score-team">
          <div className="wgt-score-identity">
            {dc.teamALogo && (
              <img className="wgt-score-logo" src={dc.teamALogo} alt="" />
            )}
            {isLinked ? (
              <span className="wgt-score-color-dot" style={{ background: teamAColor }} />
            ) : (
              <input
                type="color"
                className="wgt-score-color-swatch"
                value={teamAColor}
                title="Team color"
                onChange={e => handleColorChange('A', e.target.value)}
                onClick={e => e.stopPropagation()}
              />
            )}
            {isLinked ? (
              <span className="wgt-score-name wgt-score-name--ro" style={{ color: teamAColor, fontSize: config.nameFontSize ?? 16 }}>{dc.teamAName ?? 'Team A'}</span>
            ) : (
              <input
                className="wgt-score-name"
                value={config.teamAName ?? ''}
                placeholder="Team A"
                style={{ color: teamAColor, fontSize: config.nameFontSize ?? 16 }}
                onChange={e => updateWidgetConfig(widgetId, { teamAName: e.target.value })}
                onClick={e => e.stopPropagation()}
              />
            )}
            {isLinked ? (
              dc.teamAShortName ? <span className="wgt-score-shortname wgt-score-shortname--ro" style={{ color: teamAColor, fontSize: config.shortNameFontSize ?? 14 }}>{dc.teamAShortName}</span> : null
            ) : (
              <input
                className="wgt-score-shortname"
                value={config.teamAShortName ?? ''}
                placeholder="Short"
                style={{ color: teamAColor, fontSize: config.shortNameFontSize ?? 14 }}
                onChange={e => updateWidgetConfig(widgetId, { teamAShortName: e.target.value })}
                onClick={e => e.stopPropagation()}
              />
            )}
            {!isLinked && (
              <input
                className="wgt-score-textfield"
                value={config.teamATextField ?? ''}
                placeholder="Text field"
                style={{ fontSize: config.textFieldFontSize ?? 11 }}
                onChange={e => updateWidgetConfig(widgetId, { teamATextField: e.target.value })}
                onClick={e => e.stopPropagation()}
              />
            )}
          </div>
          <div className="wgt-score-num" style={{ fontSize: config.scoreFontSize ?? 36 }}>{dc.scoreA ?? 0}</div>
        </div>

        {/* Divider */}
        <div className="wgt-score-divider">
          <span className="wgt-score-colon">:</span>
          {pointCounts.length > 0 && (
            <div className="wgt-score-counts">
              {pointCounts.map(({ key, label, A, B }) => (  // eslint-disable-line @typescript-eslint/no-unused-vars
                <div key={key} className="wgt-score-count-row">
                  <span className="wgt-score-count-val" style={{ color: teamAColor }}>{A}</span>
                  <span className="wgt-score-count-type">{label}</span>
                  <span className="wgt-score-count-val" style={{ color: teamBColor }}>{B}</span>
                </div>
              ))}
            </div>
          )}
          {!isLinked && (
            <button className="wgt-score-rst" onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); resetWidgetScore(widgetId); }} onClick={(e) => e.stopPropagation()}>RST</button>
          )}
        </div>

        {/* Team B */}
        <div className="wgt-score-team">
          <div className="wgt-score-identity">
            {dc.teamBLogo && (
              <img className="wgt-score-logo" src={dc.teamBLogo} alt="" />
            )}
            {isLinked ? (
              <span className="wgt-score-color-dot" style={{ background: teamBColor }} />
            ) : (
              <input
                type="color"
                className="wgt-score-color-swatch"
                value={teamBColor}
                title="Team color"
                onChange={e => handleColorChange('B', e.target.value)}
                onClick={e => e.stopPropagation()}
              />
            )}
            {isLinked ? (
              <span className="wgt-score-name wgt-score-name--ro" style={{ color: teamBColor, fontSize: config.nameFontSize ?? 16 }}>{dc.teamBName ?? 'Team B'}</span>
            ) : (
              <input
                className="wgt-score-name"
                value={config.teamBName ?? ''}
                placeholder="Team B"
                style={{ color: teamBColor, fontSize: config.nameFontSize ?? 16 }}
                onChange={e => updateWidgetConfig(widgetId, { teamBName: e.target.value })}
                onClick={e => e.stopPropagation()}
              />
            )}
            {isLinked ? (
              dc.teamBShortName ? <span className="wgt-score-shortname wgt-score-shortname--ro" style={{ color: teamBColor, fontSize: config.shortNameFontSize ?? 14 }}>{dc.teamBShortName}</span> : null
            ) : (
              <input
                className="wgt-score-shortname"
                value={config.teamBShortName ?? ''}
                placeholder="Short"
                style={{ color: teamBColor, fontSize: config.shortNameFontSize ?? 14 }}
                onChange={e => updateWidgetConfig(widgetId, { teamBShortName: e.target.value })}
                onClick={e => e.stopPropagation()}
              />
            )}
            {!isLinked && (
              <input
                className="wgt-score-textfield"
                value={config.teamBTextField ?? ''}
                placeholder="Text field"
                style={{ fontSize: config.textFieldFontSize ?? 11 }}
                onChange={e => updateWidgetConfig(widgetId, { teamBTextField: e.target.value })}
                onClick={e => e.stopPropagation()}
              />
            )}
          </div>
          <div className="wgt-score-num" style={{ fontSize: config.scoreFontSize ?? 36 }}>{dc.scoreB ?? 0}</div>
        </div>
      </div>

      {/* ── Buttons row — full widget width, shared overlay ──────── */}
      {!isLinked && (
        <div className="wgt-score-btns-outer">
          <ScoreButtons team="A" increments={increments} onScore={handleScore} onDec={handleDec} buttonSize={config.buttonSize ?? 1} />
          <ScoreButtons team="B" increments={increments} onScore={handleScore} onDec={handleDec} buttonSize={config.buttonSize ?? 1} />

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
                  {tLogo && <img className="wgt-score-dec-confirm-logo" src={tLogo} alt="" />}
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
    </div>
  );
}
