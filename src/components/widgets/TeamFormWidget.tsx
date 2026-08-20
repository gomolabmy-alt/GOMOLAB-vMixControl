import { useEffect, useMemo, useRef } from 'react';
import { ArrowUp } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useMatchScheduleStore } from '../../stores/matchScheduleStore';
import { mergeResultRows, mergeUpcomingRows, type ResultFormRow, type UpcomingFormRow } from '../../lib/teamForm';
import { autoLinkedWidget } from '../../lib/autoLink';
import { TeamFormTable } from './TeamFormTable';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

type Outcome = 'W' | 'L' | 'D';

function rowOutcome(row: ResultFormRow, side: 'a' | 'b'): Outcome | null {
  const entry = row[side];
  if (!entry) return null;
  const { r, side: s } = entry;
  const own = s === 'A' ? r.scoreA : r.scoreB;
  const opp = s === 'A' ? r.scoreB : r.scoreA;
  return own > opp ? 'W' : own < opp ? 'L' : 'D';
}

function resultText(row: ResultFormRow, side: 'a' | 'b'): string | null {
  const entry = row[side];
  const outcome = rowOutcome(row, side);
  if (!entry || !outcome) return null;
  const { r, side: s } = entry;
  const own = s === 'A' ? r.scoreA : r.scoreB;
  const opp = s === 'A' ? r.scoreB : r.scoreA;
  const oppName = s === 'A' ? (r.teamBShortName || r.teamBName) : (r.teamAShortName || r.teamAName);
  return `${row.stage}: ${outcome} ${own}-${opp} v ${oppName}`;
}

// '#RRGGBB' (what <input type="color"> gives us) -> 'FFRRGGBB', the ARGB hex
// vMix's SetColor function expects for its Value parameter.
function toArgbHex(hex: string): string {
  return 'FF' + hex.replace('#', '').toUpperCase();
}

// Per-row Win/Loss/Draw styling for the indexed vMix push below — same
// three outcome values regardless of team side, applied through whichever
// of Text/Color/Image prefixes are actually configured for that side (see
// the 'team-form' case in WidgetConfigPanel.tsx — each is independently
// optional, so an operator can wire up just a color, just an image, just
// text, or any combination, depending on what their vMix template needs).
function outcomeText(config: Record<string, any>, outcome: Outcome): string {
  return outcome === 'W' ? (config.formWinText ?? 'W') : outcome === 'L' ? (config.formLossText ?? 'L') : (config.formDrawText ?? 'D');
}
function outcomeColor(config: Record<string, any>, outcome: Outcome): string {
  const hex = outcome === 'W' ? (config.formWinColor ?? '#2ecc71') : outcome === 'L' ? (config.formLossColor ?? '#e74c3c') : (config.formDrawColor ?? '#95a5a6');
  return toArgbHex(hex);
}
function outcomeImage(config: Record<string, any>, outcome: Outcome): string | undefined {
  return outcome === 'W' ? config.formWinImage : outcome === 'L' ? config.formLossImage : config.formDrawImage;
}

function upcomingText(row: UpcomingFormRow, side: 'a' | 'b'): string | null {
  const entry = row[side];
  if (!entry) return null;
  const { m, side: s } = entry;
  const oppName = s === 'A' ? (m.teamBShortName || m.teamBName) : (m.teamAShortName || m.teamAName);
  return `${row.stage}: v ${oppName}${m.time ? ` (${m.time})` : ''}`;
}

// Round-aligned Form + Upcoming comparison for the two teams on a linked
// scoreboard, as its own standalone/positionable canvas widget — the same
// data HeadToHeadPanel already shows inline on the Scoreboard widget itself
// (via TeamFormTable, reused here unchanged), but addable independently and
// with its own vMix text-field output for a custom title template.
export function TeamFormWidget({ widgetId, config }: Props) {
  const { pages, commentatorPages } = useCanvasStore();
  const { getClient, vmixState, vmixSyncVersion } = useVmixStore();
  const { results } = useMatchResultsStore();
  const { matches } = useMatchScheduleStore();

  const allPages = useMemo(() => [...pages, ...commentatorPages], [pages, commentatorPages]);
  // Falls back to the sole Scoreboard widget on this page when nothing's
  // been explicitly linked in settings — an explicit pick always wins.
  const linkedScoreboard = autoLinkedWidget(allPages, widgetId, config.linkedScoreboardId, 'scoreboard');
  const dc = linkedScoreboard?.config ?? {};

  const teamAName: string = dc.teamAName ?? 'Team A';
  const teamBName: string = dc.teamBName ?? 'Team B';
  const teamAShortName: string | undefined = dc.teamAShortName;
  const teamBShortName: string | undefined = dc.teamBShortName;
  const category: string | undefined = dc.category;
  // Also falls back to the page's own tournament (same convention as
  // Scoreboard/Timer/Player List) when the linked scoreboard hasn't set one.
  const pageTournamentId = allPages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const tournamentId: string | undefined = dc.linkedTournamentId || pageTournamentId;

  const resultRows = useMemo(
    () => mergeResultRows(results, { name: teamAName, shortName: teamAShortName }, { name: teamBName, shortName: teamBShortName }, category, tournamentId),
    [results, teamAName, teamAShortName, teamBName, teamBShortName, category, tournamentId]
  );
  const upcomingRows = useMemo(
    () => mergeUpcomingRows(matches, { name: teamAName, shortName: teamAShortName }, { name: teamBName, shortName: teamBShortName }, category, tournamentId),
    [matches, teamAName, teamAShortName, teamBName, teamBShortName, category, tournamentId]
  );

  const resultsAText = resultRows.map(r => resultText(r, 'a')).filter(Boolean).join(' | ');
  const resultsBText = resultRows.map(r => resultText(r, 'b')).filter(Boolean).join(' | ');
  const upcomingAText = upcomingRows.map(r => upcomingText(r, 'a')).filter(Boolean).join(' | ');
  const upcomingBText = upcomingRows.map(r => upcomingText(r, 'b')).filter(Boolean).join(' | ');

  const targets = [
    { inputKey: config.vmixResultsAInputKey, field: config.vmixResultsAField, text: resultsAText },
    { inputKey: config.vmixUpcomingAInputKey, field: config.vmixUpcomingAField, text: upcomingAText },
    { inputKey: config.vmixResultsBInputKey, field: config.vmixResultsBField, text: resultsBText },
    { inputKey: config.vmixUpcomingBInputKey, field: config.vmixUpcomingBField, text: upcomingBText },
  ];
  // Per-result-row Win/Loss/Draw indicator — indexed (FormTextA1.Text,
  // FormTextA2.Text, ...) same as every other per-row vMix push in this app,
  // reusing that side's own Results input rather than adding yet another
  // input picker. Each of Text/Color/Image is independently optional.
  const formSides: { side: 'a' | 'b'; inputKey: string; textPrefix?: string; colorPrefix?: string; imagePrefix?: string }[] = [
    { side: 'a', inputKey: config.vmixResultsAInputKey, textPrefix: config.formTextPrefixA, colorPrefix: config.formColorPrefixA, imagePrefix: config.formImagePrefixA },
    { side: 'b', inputKey: config.vmixResultsBInputKey, textPrefix: config.formTextPrefixB, colorPrefix: config.formColorPrefixB, imagePrefix: config.formImagePrefixB },
  ];
  const hasFormOutput = (s: typeof formSides[number]) => !!s.inputKey && !!(s.textPrefix || s.colorPrefix || s.imagePrefix);
  const hasAnyTarget = targets.some(t => t.inputKey && t.field) || formSides.some(hasFormOutput);

  const sendAll = () => {
    const c = getClient();
    if (!c) return;
    for (const t of targets) {
      if (t.inputKey && t.field) c.setTextField(t.inputKey, t.field, t.text);
    }
    for (const s of formSides) {
      if (!hasFormOutput(s)) continue;
      resultRows.forEach((row, i) => {
        const outcome = rowOutcome(row, s.side);
        if (!outcome) return;
        const idx = i + 1;
        if (s.textPrefix) c.setTextField(s.inputKey, `${s.textPrefix}${idx}.Text`, outcomeText(config, outcome));
        if (s.colorPrefix) c.setColor(s.inputKey, `${s.colorPrefix}${idx}`, outcomeColor(config, outcome));
        const img = s.imagePrefix && outcomeImage(config, outcome);
        if (img) c.setImageField(s.inputKey, `${s.imagePrefix}${idx}.Source`, img);
      });
      // Clear leftover text from a previous, longer form history (e.g. a
      // category swap dropping the row count) — same stale-slot regex clear
      // every other indexed push in this app uses; color/image slots are
      // left as-is, matching how logo fields elsewhere in the app don't
      // auto-clear either (no natural "empty" image/color to reset to).
      if (s.textPrefix) {
        const vmixInput = vmixState?.inputs?.find(inp => inp.key === s.inputKey);
        if (vmixInput) {
          const esc = s.textPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`^${esc}(\\d+)\\.Text$`, 'i');
          for (const field of vmixInput.textFields) {
            const fm = field.name.match(re);
            if (fm && parseInt(fm[1]) > resultRows.length) c.setTextField(s.inputKey, field.name, '');
          }
        }
      }
    }
  };

  const dataKey = targets.map(t => t.text).join('');
  const prevKeyRef = useRef('');
  useEffect(() => {
    if (!hasAnyTarget) return;
    if (dataKey === prevKeyRef.current && vmixSyncVersion === 0) return;
    prevKeyRef.current = dataKey;
    sendAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, hasAnyTarget, vmixSyncVersion]);

  return (
    <div className="wgt-team-form">
      {(linkedScoreboard || hasAnyTarget) && (
        <div className="wgt-team-form-header">
          {hasAnyTarget && (
            <button className="wgt-team-form-send-btn" onClick={sendAll} disabled={!getClient()} title="Send all configured fields to vMix now">
              <ArrowUp size={12} strokeWidth={2} /> Send
            </button>
          )}
        </div>
      )}
      {!linkedScoreboard ? (
        <div className="wgt-team-form-empty">Link a scoreboard in settings</div>
      ) : (
        <TeamFormTable
          teamAName={teamAName} teamAShortName={teamAShortName}
          teamBName={teamBName} teamBShortName={teamBShortName}
          category={category} tournamentId={tournamentId}
        />
      )}
    </div>
  );
}
