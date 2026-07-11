export type WidgetType =
  | 'button'
  | 'title-field'
  | 'file-path'
  | 'scoreboard'
  | 'score-log'
  | 'score-lower-third'
  | 'player-lower-third'
  | 'timer'
  | 'timeline'
  | 'player-list'
  | 'substitution'
  | 'card-display'
  | 'sin-bin-lower-third'
  | 'tbar'
  | 'volume'
  | 'overlay'
  | 'label'
  | 'input-tally'
  | 'transitions'
  | 'ndi-input'
  | 'panel'
  | 'vmix-titles'
  | 'rugby-lineup'
  | 'card-lower-third'
  | 'pomodoro'
  | 'image-display'
  | 'recent-matches'
  | 'match-schedule';

export type TimelineEventType = 'score' | 'yellow-card' | 'orange-card' | 'red-card' | 'substitution' | 'period' | 'custom';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  timeStr: string;
  timeMs: number;
  team?: 'A' | 'B';
  player?: string;
  playerOff?: string;
  jerseyNo?: string;
  jerseyNoOff?: string;
  detail?: string;
  scoreA?: number;
  scoreB?: number;
}

export interface CanvasWidget {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  config: Record<string, any>;
}

export interface CanvasPage {
  id: string;
  name: string;
  widgets: CanvasWidget[];
}

export const WIDGET_DEFAULTS: Record<WidgetType, { w: number; h: number; config: Record<string, any> }> = {
  button: {
    w: 140, h: 70,
    config: { label: 'Button', actions: [{ fn: 'Cut', params: {} }], releaseActions: [], mode: 'momentary', color: '#3498db', textColor: '#ffffff', fontSize: 14 },
  },
  'title-field': {
    w: 280, h: 130,
    config: {
      label: 'Title Fields',
      autoSend: false,
      autoSendDelayMs: 400,
      inputs: [{ inputKey: '', fields: ['Title.Text'] }],
    },
  },
  'file-path': {
    w: 260, h: 90,
    config: {
      label: 'File Path',
      inputKey: '',
      fieldName: 'Path.Text',
      accept: 'image/*',
      autoSend: false,
      currentPath: '',
    },
  },
  scoreboard: {
    w: 340, h: 320,
    config: {
      style: 'basic', teamAName: 'Team A', teamBName: 'Team B',
      teamAShortName: '', teamBShortName: '',
      teamATextField: '', teamBTextField: '',
      competition: '', subtitle: '',
      teamAColor: '#e74c3c', teamBColor: '#3498db', scoreA: 0, scoreB: 0,
      increments: [1, 2, 5, 10], vmixInputKey: '',
      fieldScoreA: 'ScoreA.Text', fieldScoreB: 'ScoreB.Text',
      fieldTeamA: 'TeamA.Text', fieldTeamB: 'TeamB.Text',
      fieldShortA: 'ShortA.Text', fieldShortB: 'ShortB.Text',
      scoreLog: [],
      linkedTimerWidgetId: '', linkedScoreLogWidgetId: '',
      linkedPlayerListA: '', linkedPlayerListB: '',
      linkedScoreboardSourceId: '',
      // Set automatically when a scheduled fixture is loaded (Load Match /
      // Send to Scoreboard) — tags "Save Result" snapshots with the right
      // tournament so they show up in that tournament's Results tab.
      linkedTournamentId: '',
      // Also set automatically on load — lets "Save Result" mark the
      // originating fixture as completed back in the Schedule tab.
      linkedScheduleMatchId: '',
      lastSavedSignature: '',
      // Carried from the fixture when it's a bye/walkover — undefined for a
      // normal match.
      matchType: '',
      walkoverLoser: '',
    },
  },
  'score-log': {
    w: 300, h: 300,
    config: {
      linkedScoreboardId: '', teamFilter: 'all',
    },
  },
  'score-lower-third': {
    w: 300, h: 180,
    config: {
      linkedScoreboardId: '',
      teamFilter: 'all',
      autoSend: false,
      overlayChannel: 1,
      vmixInputs: [
        { id: 'default', actionLabel: '', vmixInputKey: '', vmixInputTitle: '',
          fieldTeam: 'Team.Text', fieldScorer: 'Scorer.Text', fieldJersey: 'Jersey.Text', fieldAction: 'Action.Text' },
      ],
    },
  },
  'player-lower-third': {
    w: 300, h: 180,
    config: {
      linkedPlayerListId: '',
      autoSend: false,
      overlayChannel: 1,
      vmixInputKey: '',
      vmixInputTitle: '',
      fieldName: 'Name.Text',
      fieldJersey: 'Jersey.Text',
      fieldPosition: 'Position.Text',
      fieldTeam: 'Team.Text',
      highlightedPlayerId: '',
      highlightedName: '',
      highlightedJersey: '',
      highlightedPosition: '',
      highlightedTeam: '',
      highlightedTeamColor: '',
      highlightedSide: 'A',
    },
  },
  timeline: {
    w: 320, h: 420,
    config: {
      title: 'Match Timeline',
      events: [],
      linkedTimerWidgetId: '',
      linkedScoreboardId: '',
      // appearance
      showTeamHeader: true,
      bgColor: '',
      fontSizeEvent: 11,
      fontSizeTime: 10,
      fontSizeTeam: 11,
      fontSizePlayer: 10,
      bubbleHeight: 24,
      bubbleBg: '',
      bubbleTextColor: '',
      rowMinHeight: 48,
      spineWidth: 1,
      spineColor: '',
    },
  },
  timer: {
    w: 220, h: 180,
    config: {
      name: 'Timer', mode: 'countdown', format: 'mm:ss', timerFontSize: 28,
      periodOverrides: {},
      durationMs: 300000, currentMs: 300000, running: false,
      highPrecision: false, vmixInputKey: '', fieldName: 'Timer.Text',
      periods: 1, periodMode: 'reset', overrun: false, breakDurationMs: 0,
      // When false (default), period end and break end both stop the timer and
      // wait for a manual Play/Resume press. When true, it flows straight
      // through period → break → next period with no manual step.
      autoAdvance: false,
      // Set when a period's timer reaches its scheduled end on its own (not
      // autoAdvance/Final Play) — the operator must confirm before the label
      // actually advances, same prompt as pressing the manual End button.
      awaitingEndConfirm: false,
      // When true (opt-in), confirming "End Period" still requires the
      // confirm prompt, but the half-time/break countdown starts immediately
      // afterward instead of waiting for a second Play press.
      autoStartBreak: false,
      currentPeriod: 1, periodStartMs: 0, overrunning: false, inBreak: false, breakCurrentMs: 0,
      breakVmixInputKey: '', breakFieldName: 'Timer.Text',
      miniVmixInputKey: '', miniFieldName: 'MiniTimer.Text',
      overrunColorEnabled: false, overrunColor: '#ff0000', normalColor: '#ffffff', overrunColorField: '',
      linkedTournamentId: '',
      linkedTimerSourceId: '',
      extraTimePeriods: 0, etDurationMs: 300000, etBreakDurationMs: 0,
      inExtraTime: false, etCurrentPeriod: 1, etCurrentMs: 300000,
      etPeriodStartMs: 0, etInBreak: false, etBreakCurrentMs: 0, etOverrunning: false,
      afterEtMode: 'none', afterEtDurationMs: 0,
      inAfterEt: false, afterEtCurrentMs: 0, afterEtOverrunning: false,
      finalPlayEnabled: false, inFinalPlay: false, finalPlayMs: 0, finalPlayPendingNext: false,
      finalPlayDurationMs: 0,
      finalPlayVmixInputKey: '', finalPlayFieldName: 'FinalPlay.Text',
      finalPlayEndTriggerEnabled: false, finalPlayEndTriggerFn: '', finalPlayEndTriggerInput: '', finalPlayEndTriggerInputTitle: '', finalPlayEndTriggerSelectedName: '', finalPlayEndTriggerValue: '',
      periodEndTriggerEnabled: false, periodEndTriggerFn: '', periodEndTriggerInput: '', periodEndTriggerInputTitle: '', periodEndTriggerValue: '', periodEndTriggerSelectedName: '',
    },
  },
  tbar: {
    w: 280, h: 60,
    config: { label: 'T-Bar', orientation: 'horizontal' },
  },
  volume: {
    w: 72, h: 220,
    config: { target: 'master', inputKey: '', busName: 'M', showMute: true, label: 'Master' },
  },
  overlay: {
    w: 200, h: 110,
    config: { channel: 1 },
  },
  label: {
    w: 160, h: 44,
    config: { text: 'Label', fontSize: 14, color: '#ffffff', bgColor: 'transparent', align: 'center', bold: false },
  },
  'input-tally': {
    w: 130, h: 80,
    config: { inputKey: '', showTitle: true, showType: true },
  },
  transitions: {
    w: 300, h: 60,
    config: { buttons: ['cut', 'fade', 'auto'] },
  },
  'player-list': {
    w: 300, h: 520,
    config: {
      linkedTournamentId: '',
      linkedTeamId: '',
      teamSide: 'A',
      linkedTimerWidgetId: '',
      linkedTimelineId: '',
      showTime: true,
      showPosition: true,
      starters: [],
      subs: [],
      onField: [],
      entries: {},
      accumulated: {},
      subbedOnPlayers: [],
      vmixTeamInputKey: '',
      vmixTeamInputTitle: '',
      vmixTeamFieldName: 'TeamName.Text',
      vmixTeamFieldShort: 'ShortName.Text',
      vmixTeamAutoSync: false,
    },
  },
  substitution: {
    w: 300, h: 360,
    config: {
      linkedTournamentId: '',
      linkedTeamId: '',
      teamSide: 'A',
      linkedPlayerListId: '',
      linkedTimerWidgetId: '',
      linkedTimelineId: '',
    },
  },
  'card-display': {
    w: 260, h: 200,
    config: {
      linkedPlayerListA: '',
      linkedPlayerListB: '',
      showNames: true,
    },
  },
  'sin-bin-lower-third': {
    w: 300, h: 180,
    config: {
      linkedPlayerListId: '',
      autoSend: false,
      overlayChannel: 1,
      vmixInputKey: '',
      vmixInputTitle: '',
      fieldJersey: 'Jersey.Text',
      fieldName: 'Name.Text',
      fieldTimer: 'Timer.Text',
      fieldTeam: 'Team.Text',
    },
  },
  'ndi-input': {
    w: 300, h: 220,
    config: { sources: [] },
  },
  panel: {
    w: 240, h: 200,
    config: { items: [] },
  },
  'vmix-titles': {
    w: 280, h: 260,
    config: { inputs: [], showThumbs: true, autoSend: false },
  },
  'card-lower-third': {
    w: 300, h: 180,
    config: {
      linkedPlayerListA: '',
      linkedPlayerListB: '',
      autoSend: false,
      overlayChannel: 1,
      vmixInputKey: '',
      vmixInputTitle: '',
      fieldJersey: 'Jersey.Text',
      fieldName: 'Name.Text',
      fieldTeam: 'Team.Text',
      fieldCardType: 'Card.Text',
    },
  },
  'rugby-lineup': {
    w: 420, h: 560,
    config: {
      linkedTournamentId: '',
      linkedTeamId: '',
      teamName: 'Team Name',
      teamColor: '#3498db',
      fieldColor: '#2d7a3a',
      players: [
        { number: 1,  position: 'Loosehead Prop',  name: '', x: 27, y: 13, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 2,  position: 'Hooker',           name: '', x: 50, y: 13, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 3,  position: 'Tighthead Prop',   name: '', x: 73, y: 13, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 6,  position: 'Open Flanker',     name: '', x: 13, y: 29, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 4,  position: 'L Lock',           name: '', x: 35, y: 29, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 5,  position: 'R Lock',           name: '', x: 58, y: 29, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 7,  position: 'Blind Flanker',    name: '', x: 80, y: 29, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 8,  position: 'Number 8',         name: '', x: 50, y: 42, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 9,  position: 'Scrum Half',       name: '', x: 50, y: 52, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 10, position: 'Fly Half',         name: '', x: 30, y: 62, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 12, position: 'Inside Centre',    name: '', x: 64, y: 62, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 11, position: 'Left Wing',        name: '', x: 11, y: 76, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 13, position: 'Outside Centre',   name: '', x: 31, y: 76, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 15, position: 'Full Back',        name: '', x: 53, y: 76, jerseyColor: '#3498db', textColor: '#222222' },
        { number: 14, position: 'Right Wing',       name: '', x: 78, y: 76, jerseyColor: '#3498db', textColor: '#222222' },
      ],
    },
  },
  pomodoro: {
    w: 360, h: 200,
    config: { focusMins: 25, breakMins: 5, totalCycles: 4 },
  },
  'image-display': {
    w: 240, h: 160,
    config: { imageUrl: '', objectFit: 'contain', bgColor: 'transparent' },
  },
  'recent-matches': {
    w: 320, h: 360,
    config: {
      title: 'Latest Results',
      maxResults: 8,
      groupByCompetition: true,
      showDate: true,
    },
  },
  'match-schedule': {
    w: 340, h: 320,
    config: {
      title: 'Upcoming Matches',
      linkedScoreboardId: '',
    },
  },
};

export const WIDGET_TYPE_LABELS: Record<WidgetType, string> = {
  button: 'Button', 'title-field': 'Title Field', 'file-path': 'File Path',
  scoreboard: 'Scoreboard', 'score-log': 'Score Log', 'score-lower-third': 'Score Lower Third', 'player-lower-third': 'Player Highlight', 'sin-bin-lower-third': 'Sin Bin LT',
  timeline: 'Timeline',
  'player-list': 'Player List',
  substitution: 'Quick Sub',
  'card-display': 'Card Display',
  timer: 'Timer', tbar: 'T-Bar', volume: 'Volume',
  overlay: 'Overlay', label: 'Label', 'input-tally': 'Input Tally', transitions: 'Transitions',
  'ndi-input': 'NDI Input',
  panel: 'Custom Panel',
  'vmix-titles': 'vMix Titles',
  'rugby-lineup': 'Rugby Lineup',
  'card-lower-third': 'Card LT',
  pomodoro: 'Pomodoro',
  'image-display': 'Image',
  'recent-matches': 'Latest Results',
  'match-schedule': 'Match Schedule',
};

export const WIDGET_TYPE_ICONS: Record<WidgetType, string> = {
  button: '⬡', 'title-field': 'T', 'file-path': '📁',
  scoreboard: '⚽', 'score-log': '📋', 'score-lower-third': '⬇', 'player-lower-third': '★', 'sin-bin-lower-third': '🟨',
  timeline: '📅',
  'player-list': '👕',
  substitution: '⇄',
  'card-display': '🟨',
  timer: '⏱', tbar: '⇄', volume: '♪',
  overlay: '▣', label: 'A', 'input-tally': '●', transitions: '⇌',
  'ndi-input': 'NDI',
  panel: '⊞',
  'vmix-titles': 'Aa',
  'rugby-lineup': '🏉',
  'card-lower-third': '🟨',
  pomodoro: '🍅',
  'image-display': '🖼',
  'recent-matches': '🏆',
  'match-schedule': '📅',
};
