export type SportType =
  | 'football'
  | 'basketball'
  | 'rugby_union'
  | 'rugby_league'
  | 'volleyball'
  | 'handball'
  | 'ice_hockey'
  | 'futsal'
  | 'custom';

export interface Player {
  id: string;
  jerseyNo: string;
  name: string;
  position: string;
}

export interface StaffMember {
  id: string;
  role: string;
  name: string;
}

export const DEFAULT_STAFF_ROLES = ['Head Coach', 'Manager', 'Medic'];

export interface TournamentGroup {
  /** Display name, e.g. "Group A" — also the value stored in SavedTeam.group. */
  name: string;
  /** Short code prefixed to each team's position within this group (e.g.
   *  prefix "A" + position 1 = "A1") — freely customizable, defaults to the
   *  name's first letter when unset. */
  prefix?: string;
  /** Max team count for this group — the draw won't assign more teams to it
   *  once reached. Unset = unlimited. */
  capacity?: number;
  /** Which Tournament.categories entry this group belongs to (e.g. "Men") —
   *  unset means shared/visible under any category tab in the Draw tab. */
  category?: string;
}

export interface TournamentPot {
  /** Display name, e.g. "Pot 1" — also the value stored in SavedTeam.pot. */
  name: string;
  /** Which Tournament.categories entry this pot belongs to — unset means
   *  shared/visible under any category tab in the Draw tab. */
  category?: string;
}

// A Tournament is a competition/league container — it no longer owns a fixed
// Team A / Team B. Teams belong to a tournament via SavedTeam.tournamentId
// (teamDbStore) and can be any number; widgets reference a specific team by id.
export interface Tournament {
  id: string;
  name: string;
  sport: SportType;
  settings: TournamentSettings;
  createdAt: number;
  /** Preliminary-draw / pool groups (e.g. "Pool A", "Pool B") — freely added
   *  and removed, teams are assigned to one via SavedTeam.group (which stores
   *  the group's `name`). Standings are computed per group when this is
   *  non-empty, otherwise as one table. */
  groups?: TournamentGroup[];
  /** Seeding pots for the live draw (e.g. "Pot 1", "Pot 2") — teams are
   *  pre-assigned to a pot via SavedTeam.pot before drawing; the draw then
   *  randomly places one team per pot into each group in turn. */
  pots?: TournamentPot[];
  /** Freely-defined competition categories (e.g. "Men", "Women", "U21") —
   *  teams are assigned to one via SavedTeam.category. A club entering more
   *  than one category duplicates its team entry per category since rosters
   *  differ (see teamDbStore.duplicateTeam). */
  categories?: string[];
  /** Freely-defined venues (e.g. "Court 1", "Main Hall") — each fixture in
   *  the Schedule tab picks one via ScheduledMatch.venue. Lets a multi-venue
   *  tournament's schedule be filtered down to a single venue per physical
   *  install (see appSettingsStore's canvasTournamentId/canvasVenue). */
  venues?: string[];
  /** Per-venue short code (e.g. "Court 1" → "B") used to build each
   *  fixture's auto match number — keyed by venue name, matching `venues`.
   *  Only meaningful when matchNumberPrefix is set. */
  venuePrefixes?: Record<string, string>;
  /** Base prefix for auto-generated fixture match numbers (e.g. "M" gives
   *  "MB1", "MC2"...) — the number is one running sequence across the whole
   *  schedule in running order regardless of venue; the letter reflects
   *  each fixture's own venue (see src/utils/matchNumber.ts). Empty/
   *  undefined turns the whole match-number feature off. */
  matchNumberPrefix?: string;
  /** How the next team is picked from the current pot — 'random' (default)
   *  picks blindly; 'manual' lets the operator click a specific team chip in
   *  the current pot to draw it (e.g. a physical ball was already pulled by
   *  hand and just needs recording). */
  drawTeamMode?: 'random' | 'manual';
  /** vMix field mapping pushed in real time as each team is drawn, for an
   *  on-air draw graphic — plain text since this is a small, occasional
   *  setup step rather than something needing a full input/field picker. */
  drawVmix?: {
    inputKey?: string;
    fieldTeamName?: string;
    fieldTeamShort?: string;
    fieldTeamLogo?: string;
    fieldGroup?: string;
    fieldPot?: string;
  };
  /** Pushes a whole group's team list to numbered vMix text fields, one
   *  target per on-air "Group A" style title — same numbered-prefix setup as
   *  the Player List widget's vMix Name Sync (pick/type e.g. "Team1.Text"
   *  and the digit + ".Text" suffix is stripped to a reusable prefix, so
   *  team N lands in `{prefix}N.Text`). */
  groupListVmix?: GroupListVmixTarget[];
  /** Multi-venue cloud sync opt-in — local-only, deliberately never
   *  overwritten by an incoming cloud pull (see src/lib/cloudSync.ts), so
   *  each device decides independently whether its edits to this tournament
   *  get shared. A tournament that arrives via a pull (created by another
   *  venue) starts with this true, since its presence in the cloud already
   *  means some venue opted it in. */
  cloudSyncEnabled?: boolean;
  /** The eventmanagementsystem Event this tournament is linked to (via
   *  "Load Shared Event") — lets the website's live scoring overview page
   *  find this tournament's data. Undefined for a purely local tournament. */
  eventId?: string;
  /** The linked event's name, captured at link time purely for display (so
   *  the toolbar can show which event without re-fetching the event list). */
  eventName?: string;
  /** Cross-venue sharing key (see the event page's "Cross-Venue Key" button
   *  on the website) — only set when `eventId` points to an event owned by
   *  a DIFFERENT vendor than this device's own. Re-sent with every push so
   *  the link keeps working (or stops, if the key's since been revoked/
   *  regenerated) without needing to re-enter it. Undefined for an
   *  own-vendor event link, which needs no key at all. */
  eventShareKey?: string;
  /** True for a tournament that arrived via cloud pull from a DIFFERENT
   *  vendor (a cross-venue event link someone else set up) — read-only:
   *  never included in a push regardless of cloudSyncEnabled, since this
   *  device doesn't own it and the server would reject the write anyway.
   *  Undefined/false for anything actually owned by this device's vendor. */
  foreignVendor?: boolean;
}

export interface GroupListVmixTarget {
  id: string;
  /** Which group's team list (in prefix/position order) this target pushes. */
  group: string;
  inputKey?: string;
  /** e.g. "Team" → writes Team1.Text, Team2.Text, … for each team in the group. */
  fieldPrefix?: string;
  /** e.g. "Short" → writes Short1.Text, Short2.Text, … (optional). */
  fieldShortPrefix?: string;
  /** e.g. "Logo" → writes Logo1.Source, Logo2.Source, … (optional, image field). */
  fieldLogoPrefix?: string;
  /** Push automatically whenever this group's membership changes. */
  autoSync?: boolean;
}

export const SPORT_LABELS: Record<SportType, string> = {
  football:    'Football / Soccer',
  basketball:  'Basketball',
  rugby_union: 'Rugby Union',
  rugby_league:'Rugby League',
  volleyball:  'Volleyball',
  handball:    'Handball',
  ice_hockey:  'Ice Hockey',
  futsal:      'Futsal',
  custom:      'Custom',
};

export const SPORT_POSITIONS: Record<SportType, string[]> = {
  football:    ['GK','CB','LB','RB','LM','CM','RM','CAM','LW','RW','ST','CF'],
  basketball:  ['PG','SG','SF','PF','C'],
  rugby_union: ['Prop','Hooker','Lock','Flanker','No.8','Scrum-half','Fly-half','Centre','Wing','Fullback'],
  rugby_league:['Prop','Hooker','Second-row','Loose Fwd','Halfback','Stand-off','Centre','Wing','Fullback'],
  volleyball:  ['Setter','Outside Hitter','Middle Blocker','Opposite','Libero'],
  handball:    ['GK','Left Wing','Right Wing','Left Back','Right Back','Pivot','Centre Back'],
  ice_hockey:  ['G','LD','RD','LW','RW','C'],
  futsal:      ['Goalkeeper','Fixo','Ala','Pivô'],
  custom:      [],
};

export const SPORT_MAX_ON_FIELD: Record<SportType, number> = {
  football:    11,
  basketball:  5,
  rugby_union: 15,
  rugby_league:13,
  volleyball:  6,
  handball:    7,
  ice_hockey:  6,
  futsal:      5,
  custom:      11,
};

export interface TournamentSettings {
  periods: number;
  periodDurationMs: number;
  halfTimeDurationMs: number;
  maxOnField: number;
  maxSubs: number;
  timerMode: 'countup' | 'countdown';
  /** Winning score auto-applied when a fixture is marked Bye/Walkover in the
   *  Schedule tab (loser always gets 0) — per-tournament since the
   *  convention varies by sport/competition (e.g. rugby often uses 21 or 28). */
  walkoverWinScore: number;
  /** Standings points per outcome — varies by sport/competition convention
   *  (e.g. rugby union commonly 4/2/0, football 3/1/0). Bonus points aren't
   *  modeled; walkovers count as a normal win/loss, byes don't count at all. */
  pointsWin: number;
  pointsDraw: number;
  pointsLoss: number;
}

export const SPORT_DEFAULTS: Record<SportType, TournamentSettings> = {
  football:    { periods: 2, periodDurationMs: 2700000, halfTimeDurationMs:  900000, maxOnField: 11, maxSubs:  9, timerMode: 'countup',   walkoverWinScore: 3,  pointsWin: 3, pointsDraw: 1, pointsLoss: 0 },
  basketball:  { periods: 4, periodDurationMs:  720000, halfTimeDurationMs:  120000, maxOnField:  5, maxSubs:  7, timerMode: 'countdown', walkoverWinScore: 20, pointsWin: 2, pointsDraw: 0, pointsLoss: 0 },
  rugby_union: { periods: 2, periodDurationMs: 2400000, halfTimeDurationMs:  600000, maxOnField: 15, maxSubs:  8, timerMode: 'countup',   walkoverWinScore: 28, pointsWin: 4, pointsDraw: 2, pointsLoss: 0 },
  rugby_league:{ periods: 2, periodDurationMs: 2400000, halfTimeDurationMs:  600000, maxOnField: 13, maxSubs:  4, timerMode: 'countup',   walkoverWinScore: 28, pointsWin: 2, pointsDraw: 1, pointsLoss: 0 },
  volleyball:  { periods: 5, periodDurationMs:       0, halfTimeDurationMs:  120000, maxOnField:  6, maxSubs:  6, timerMode: 'countup',   walkoverWinScore: 3,  pointsWin: 3, pointsDraw: 0, pointsLoss: 0 },
  handball:    { periods: 2, periodDurationMs: 1800000, halfTimeDurationMs:  600000, maxOnField:  7, maxSubs:  7, timerMode: 'countup',   walkoverWinScore: 10, pointsWin: 2, pointsDraw: 1, pointsLoss: 0 },
  ice_hockey:  { periods: 3, periodDurationMs: 1200000, halfTimeDurationMs:  900000, maxOnField:  6, maxSubs: 14, timerMode: 'countdown', walkoverWinScore: 5,  pointsWin: 2, pointsDraw: 1, pointsLoss: 0 },
  futsal:      { periods: 2, periodDurationMs: 1200000, halfTimeDurationMs:  600000, maxOnField:  5, maxSubs:  5, timerMode: 'countup',   walkoverWinScore: 5,  pointsWin: 3, pointsDraw: 1, pointsLoss: 0 },
  custom:      { periods: 2, periodDurationMs: 2700000, halfTimeDurationMs:  900000, maxOnField: 11, maxSubs:  7, timerMode: 'countup',   walkoverWinScore: 1,  pointsWin: 3, pointsDraw: 1, pointsLoss: 0 },
};
