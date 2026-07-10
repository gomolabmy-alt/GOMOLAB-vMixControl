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

// A Tournament is a competition/league container — it no longer owns a fixed
// Team A / Team B. Teams belong to a tournament via SavedTeam.tournamentId
// (teamDbStore) and can be any number; widgets reference a specific team by id.
export interface Tournament {
  id: string;
  name: string;
  sport: SportType;
  settings: TournamentSettings;
  createdAt: number;
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
}

export const SPORT_DEFAULTS: Record<SportType, TournamentSettings> = {
  football:    { periods: 2, periodDurationMs: 2700000, halfTimeDurationMs:  900000, maxOnField: 11, maxSubs:  9, timerMode: 'countup'   },
  basketball:  { periods: 4, periodDurationMs:  720000, halfTimeDurationMs:  120000, maxOnField:  5, maxSubs:  7, timerMode: 'countdown' },
  rugby_union: { periods: 2, periodDurationMs: 2400000, halfTimeDurationMs:  600000, maxOnField: 15, maxSubs:  8, timerMode: 'countup'   },
  rugby_league:{ periods: 2, periodDurationMs: 2400000, halfTimeDurationMs:  600000, maxOnField: 13, maxSubs:  4, timerMode: 'countup'   },
  volleyball:  { periods: 5, periodDurationMs:       0, halfTimeDurationMs:  120000, maxOnField:  6, maxSubs:  6, timerMode: 'countup'   },
  handball:    { periods: 2, periodDurationMs: 1800000, halfTimeDurationMs:  600000, maxOnField:  7, maxSubs:  7, timerMode: 'countup'   },
  ice_hockey:  { periods: 3, periodDurationMs: 1200000, halfTimeDurationMs:  900000, maxOnField:  6, maxSubs: 14, timerMode: 'countdown' },
  futsal:      { periods: 2, periodDurationMs: 1200000, halfTimeDurationMs:  600000, maxOnField:  5, maxSubs:  5, timerMode: 'countup'   },
  custom:      { periods: 2, periodDurationMs: 2700000, halfTimeDurationMs:  900000, maxOnField: 11, maxSubs:  7, timerMode: 'countup'   },
};
