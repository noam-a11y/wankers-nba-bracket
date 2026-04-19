// 2026 NBA Playoffs — teams and series structure.
// Team logos served from NBA's public CDN.
const LOGO = (nbaId) => `https://cdn.nba.com/logos/nba/${nbaId}/primary/L/logo.svg`;

const TEAMS = {
  // Eastern Conference
  DET: { id: 'DET', abbr: 'DET', name: 'Pistons',       city: 'Detroit',       seed: 1, conf: 'E', nbaId: '1610612765', color: '#1D42BA', accent: '#C8102E', record: '62-20' },
  ORL: { id: 'ORL', abbr: 'ORL', name: 'Magic',         city: 'Orlando',       seed: 8, conf: 'E', nbaId: '1610612753', color: '#0077C0', accent: '#000000', record: '39-43' },
  BOS: { id: 'BOS', abbr: 'BOS', name: 'Celtics',       city: 'Boston',        seed: 2, conf: 'E', nbaId: '1610612738', color: '#007A33', accent: '#BA9653', record: '58-24' },
  PHI: { id: 'PHI', abbr: 'PHI', name: '76ers',         city: 'Philadelphia',  seed: 7, conf: 'E', nbaId: '1610612755', color: '#006BB6', accent: '#ED174C', record: '41-41' },
  NYK: { id: 'NYK', abbr: 'NYK', name: 'Knicks',        city: 'New York',      seed: 3, conf: 'E', nbaId: '1610612752', color: '#006BB6', accent: '#F58426', record: '53-29' },
  ATL: { id: 'ATL', abbr: 'ATL', name: 'Hawks',         city: 'Atlanta',       seed: 6, conf: 'E', nbaId: '1610612737', color: '#E03A3E', accent: '#26282A', record: '44-38' },
  CLE: { id: 'CLE', abbr: 'CLE', name: 'Cavaliers',     city: 'Cleveland',     seed: 4, conf: 'E', nbaId: '1610612739', color: '#860038', accent: '#FDBB30', record: '49-33' },
  TOR: { id: 'TOR', abbr: 'TOR', name: 'Raptors',       city: 'Toronto',       seed: 5, conf: 'E', nbaId: '1610612761', color: '#CE1141', accent: '#000000', record: '46-36' },
  // Western Conference
  OKC: { id: 'OKC', abbr: 'OKC', name: 'Thunder',       city: 'Oklahoma City', seed: 1, conf: 'W', nbaId: '1610612760', color: '#007AC1', accent: '#EF3B24', record: '67-15' },
  PHX: { id: 'PHX', abbr: 'PHX', name: 'Suns',          city: 'Phoenix',       seed: 8, conf: 'W', nbaId: '1610612756', color: '#1D1160', accent: '#E56020', record: '40-42' },
  SAS: { id: 'SAS', abbr: 'SAS', name: 'Spurs',         city: 'San Antonio',   seed: 2, conf: 'W', nbaId: '1610612759', color: '#000000', accent: '#C4CED4', record: '55-27' },
  POR: { id: 'POR', abbr: 'POR', name: 'Trail Blazers', city: 'Portland',      seed: 7, conf: 'W', nbaId: '1610612757', color: '#E03A3E', accent: '#000000', record: '42-40' },
  DEN: { id: 'DEN', abbr: 'DEN', name: 'Nuggets',       city: 'Denver',        seed: 3, conf: 'W', nbaId: '1610612743', color: '#0E2240', accent: '#FEC524', record: '52-30' },
  MIN: { id: 'MIN', abbr: 'MIN', name: 'Timberwolves',  city: 'Minnesota',     seed: 6, conf: 'W', nbaId: '1610612750', color: '#0C2340', accent: '#78BE20', record: '45-37' },
  LAL: { id: 'LAL', abbr: 'LAL', name: 'Lakers',        city: 'Los Angeles',   seed: 4, conf: 'W', nbaId: '1610612747', color: '#552583', accent: '#FDB927', record: '48-34' },
  HOU: { id: 'HOU', abbr: 'HOU', name: 'Rockets',       city: 'Houston',       seed: 5, conf: 'W', nbaId: '1610612745', color: '#CE1141', accent: '#000000', record: '47-35' }
};

// Bracket structure — standard NBA seeding keeps 1 and 2 apart until the conf final.
// Top-down stack order (within a conference): 1v8, 4v5, 3v6, 2v7 so that R1 winners
// feed into R2 as (1v8)↔(4v5) and (3v6)↔(2v7).
const SERIES = [
  // East Round 1 (top→bottom of bracket)
  { id: 'E1', round: 1, conf: 'E', slots: ['DET', 'ORL'] },   // 1v8
  { id: 'E2', round: 1, conf: 'E', slots: ['CLE', 'TOR'] },   // 4v5
  { id: 'E3', round: 1, conf: 'E', slots: ['NYK', 'ATL'] },   // 3v6
  { id: 'E4', round: 1, conf: 'E', slots: ['BOS', 'PHI'] },   // 2v7
  // East Semis
  { id: 'E5', round: 2, conf: 'E', feeds: ['E1', 'E2'] },
  { id: 'E6', round: 2, conf: 'E', feeds: ['E3', 'E4'] },
  // East Conference Finals
  { id: 'EF', round: 3, conf: 'E', feeds: ['E5', 'E6'] },
  // West Round 1 (top→bottom)
  { id: 'W1', round: 1, conf: 'W', slots: ['OKC', 'PHX'] },   // 1v8
  { id: 'W2', round: 1, conf: 'W', slots: ['LAL', 'HOU'] },   // 4v5
  { id: 'W3', round: 1, conf: 'W', slots: ['DEN', 'MIN'] },   // 3v6
  { id: 'W4', round: 1, conf: 'W', slots: ['SAS', 'POR'] },   // 2v7
  // West Semis
  { id: 'W5', round: 2, conf: 'W', feeds: ['W1', 'W2'] },
  { id: 'W6', round: 2, conf: 'W', feeds: ['W3', 'W4'] },
  // West Conference Finals
  { id: 'WF', round: 3, conf: 'W', feeds: ['W5', 'W6'] },
  // NBA Finals
  { id: 'NF', round: 4, conf: null, feeds: ['EF', 'WF'] }
];

const SERIES_BY_ID = Object.fromEntries(SERIES.map(s => [s.id, s]));
const ROUND_POINTS = { 1: 1, 2: 2, 3: 4, 4: 8 };
const ROUND_NAMES = { 1: 'First Round', 2: 'Conference Semis', 3: 'Conference Finals', 4: 'NBA Finals' };
const MAX_SCORE = SERIES.reduce((sum, s) => sum + ROUND_POINTS[s.round], 0); // 32

// For a given series, return the two teams that feed into it.
// - R1: fixed matchups
// - Later rounds: from picks (for your own bracket view) or actual results (for the live bracket)
function possibleTeamsFor(seriesId, picks, results) {
  const s = SERIES_BY_ID[seriesId];
  if (s.slots) return s.slots.slice();
  const resolve = (feedId) => {
    const r = results && results[feedId];
    if (r) return r.winner;
    return picks?.[feedId] || null;
  };
  return s.feeds.map(resolve);
}

// Generate a stable avatar color per user name (for leaderboard)
function avatarColor(name) {
  const palette = ['#ADEE20', '#3AD0D1', '#F88B25', '#7035C4', '#E74B3C', '#FAF14D', '#86BE0E', '#DE6F08', '#3B82F6'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
function avatarLetter(name) { return (name.trim()[0] || '?').toUpperCase(); }
