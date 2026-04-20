const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'wankers2026';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'bracket.db');

const app = express();
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL COLLATE NOCASE,
    edit_key TEXT UNIQUE NOT NULL,
    tiebreaker INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS picks (
    user_id INTEGER NOT NULL,
    series_id TEXT NOT NULL,
    winner_id TEXT NOT NULL,
    PRIMARY KEY (user_id, series_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS results (
    series_id TEXT PRIMARY KEY,
    winner_id TEXT NOT NULL,
    games TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

const getSetting = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value ?? null;
const setSetting = (k, v) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
};
if (getSetting('locked') === null) setSetting('locked', 'false');

const ROUND_POINTS = { 1: 1, 2: 2, 3: 4, 4: 8 };
const seriesRound = (id) => {
  if (id === 'NF') return 4;
  if (id === 'EF' || id === 'WF') return 3;
  const n = id.slice(1);
  if (['5', '6'].includes(n)) return 2;
  if (['1', '2', '3', '4'].includes(n)) return 1;
  return 0;
};

// ----- Series structure (mirrors public/data.js) and ESPN live-data fetcher -----
const SERIES_DEFS = [
  { id: 'E1', slots: ['DET', 'ORL'] },
  { id: 'E2', slots: ['CLE', 'TOR'] },
  { id: 'E3', slots: ['NYK', 'ATL'] },
  { id: 'E4', slots: ['BOS', 'PHI'] },
  { id: 'E5', feeds: ['E1', 'E2'] },
  { id: 'E6', feeds: ['E3', 'E4'] },
  { id: 'EF', feeds: ['E5', 'E6'] },
  { id: 'W1', slots: ['OKC', 'PHX'] },
  { id: 'W2', slots: ['LAL', 'HOU'] },
  { id: 'W3', slots: ['DEN', 'MIN'] },
  { id: 'W4', slots: ['SAS', 'POR'] },
  { id: 'W5', feeds: ['W1', 'W2'] },
  { id: 'W6', feeds: ['W3', 'W4'] },
  { id: 'WF', feeds: ['W5', 'W6'] },
  { id: 'NF', feeds: ['EF', 'WF'] }
];

// ESPN occasionally uses shorter abbreviations than NBA.com; normalize them.
const ESPN_ABBR_ALIAS = { SA: 'SAS', NY: 'NYK', NO: 'NOP', GS: 'GSW', UTAH: 'UTA' };
const normAbbr = (a) => ESPN_ABBR_ALIAS[a?.toUpperCase()] || a?.toUpperCase();

function resolveSeriesTeams(seriesId, results) {
  const s = SERIES_DEFS.find(x => x.id === seriesId);
  if (!s) return null;
  if (s.slots) return s.slots.slice();
  const teams = s.feeds.map(fid => results[fid]?.winner).filter(Boolean);
  return teams.length === 2 ? teams : null;
}

let liveCache = { at: 0, data: {}, inFlight: null };

async function fetchLiveSeries(adminResults) {
  const ageMs = Date.now() - liveCache.at;
  if (ageMs < 60_000) return liveCache.data;
  if (liveCache.inFlight) return liveCache.inFlight;

  const job = (async () => {
    try {
      const today = new Date();
      const end = new Date(today.getTime() + 24 * 3600 * 1000);
      const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
      const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20260419-${yyyymmdd(end)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
      const data = await res.json();
      const events = data.events || [];

      const groups = new Map();
      for (const g of events) {
        const comp = g.competitions?.[0];
        if (!comp) continue;
        const [a, b] = comp.competitors || [];
        if (!a || !b) continue;
        const abbrA = normAbbr(a.team?.abbreviation);
        const abbrB = normAbbr(b.team?.abbreviation);
        if (!abbrA || !abbrB) continue;
        const key = [abbrA, abbrB].sort().join('-');
        const status = g.status?.type || comp.status?.type || {};
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({
          date: g.date,
          completed: !!status.completed,
          state: status.state, // 'pre' | 'in' | 'post'
          desc: status.shortDetail || status.description || '',
          teams: {
            [abbrA]: { score: +a.score || 0, winner: !!a.winner, homeAway: a.homeAway },
            [abbrB]: { score: +b.score || 0, winner: !!b.winner, homeAway: b.homeAway }
          }
        });
      }

      const out = {};
      for (const s of SERIES_DEFS) {
        const teams = resolveSeriesTeams(s.id, adminResults);
        if (!teams) continue;
        const [tA, tB] = teams;
        const key = [tA, tB].sort().join('-');
        const sGames = (groups.get(key) || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
        if (!sGames.length) continue;

        const wins = { [tA]: 0, [tB]: 0 };
        let lastCompleted = null;
        for (const g of sGames) {
          if (g.completed) {
            if (g.teams[tA]?.winner) wins[tA]++;
            else if (g.teams[tB]?.winner) wins[tB]++;
            lastCompleted = g;
          }
        }
        const live = sGames.find(g => g.state === 'in');
        const next = sGames.find(g => g.state === 'pre');

        out[s.id] = {
          teams,
          seriesState: `${wins[tA]}-${wins[tB]}`,
          wins,
          lastGame: lastCompleted ? {
            date: lastCompleted.date,
            scores: { [tA]: lastCompleted.teams[tA].score, [tB]: lastCompleted.teams[tB].score },
            winner: lastCompleted.teams[tA].winner ? tA : (lastCompleted.teams[tB].winner ? tB : null)
          } : null,
          liveGame: live ? {
            date: live.date,
            status: live.desc,
            scores: { [tA]: live.teams[tA].score, [tB]: live.teams[tB].score }
          } : null,
          nextGame: next ? { date: next.date } : null
        };
      }

      liveCache = { at: Date.now(), data: out, inFlight: null };
      return out;
    } catch (e) {
      console.error('ESPN fetch failed:', e.message);
      liveCache.inFlight = null;
      return liveCache.data || {};
    }
  })();

  liveCache.inFlight = job;
  return job;
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', async (req, res) => {
  const name = (req.body?.name || '').trim();
  const picks = req.body?.picks || {};
  const tbRaw = req.body?.tiebreaker;
  const tiebreaker = (tbRaw != null && Number.isFinite(+tbRaw)) ? +tbRaw : null;

  if (!name || name.length < 2 || name.length > 40) {
    return res.status(400).json({ error: 'Name must be 2-40 characters' });
  }
  if (getSetting('locked') === 'true') {
    return res.status(403).json({ error: 'Picks are locked — the playoffs have started' });
  }

  // Silently drop picks for any series that's already started — no hindsight picking.
  const resultsRows = db.prepare('SELECT series_id, winner_id FROM results').all();
  const resultsObj = Object.fromEntries(resultsRows.map(r => [r.series_id, { winner: r.winner_id }]));
  const liveSeries = await fetchLiveSeries(resultsObj);
  const allowedPicks = {};
  for (const [sid, wid] of Object.entries(picks)) {
    if (!isSeriesStarted(sid, liveSeries)) allowedPicks[sid] = wid;
  }

  const editKey = crypto.randomBytes(12).toString('hex');
  const tx = db.transaction(() => {
    const result = db.prepare('INSERT INTO users (name, edit_key, tiebreaker) VALUES (?, ?, ?)').run(name, editKey, tiebreaker);
    const userId = result.lastInsertRowid;
    const ins = db.prepare('INSERT INTO picks (user_id, series_id, winner_id) VALUES (?, ?, ?)');
    for (const [sid, wid] of Object.entries(allowedPicks)) ins.run(userId, sid, wid);
    return userId;
  });

  try {
    const userId = tx();
    res.json({ editKey, userId, name });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That name is taken. Pick another.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/user/:editKey', (req, res) => {
  const user = db.prepare('SELECT id, name, tiebreaker FROM users WHERE edit_key = ?').get(req.params.editKey);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const picks = db.prepare('SELECT series_id, winner_id FROM picks WHERE user_id = ?').all(user.id);
  const picksObj = Object.fromEntries(picks.map(p => [p.series_id, p.winner_id]));
  res.json({ id: user.id, name: user.name, tiebreaker: user.tiebreaker, picks: picksObj });
});

// A series is "started" once any playoff game has been played (completed or live).
// Once started, that series' pick is frozen for everyone.
function isSeriesStarted(seriesId, liveSeries) {
  const l = liveSeries?.[seriesId];
  if (!l) return false;
  if (l.liveGame) return true;
  if (l.seriesState && l.seriesState !== '0-0') return true;
  return false;
}

app.post('/api/user/:editKey/picks', async (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE edit_key = ?').get(req.params.editKey);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (getSetting('locked') === 'true') return res.status(403).json({ error: 'Picks are locked' });

  const newPicks = req.body?.picks || {};
  const tbRaw = req.body?.tiebreaker;
  const tiebreaker = (tbRaw != null && Number.isFinite(+tbRaw)) ? +tbRaw : null;

  // Resolve which series are frozen (already started) so we preserve the user's
  // existing pick for those rather than accepting the incoming value.
  const resultsRows = db.prepare('SELECT series_id, winner_id FROM results').all();
  const resultsObj = Object.fromEntries(resultsRows.map(r => [r.series_id, { winner: r.winner_id }]));
  const liveSeries = await fetchLiveSeries(resultsObj);
  const existingRows = db.prepare('SELECT series_id, winner_id FROM picks WHERE user_id = ?').all(user.id);
  const existingPicks = Object.fromEntries(existingRows.map(p => [p.series_id, p.winner_id]));

  const mergedPicks = {};
  const rejected = [];
  // Iterate all series IDs that appear in either existing or new picks.
  const allIds = new Set([...Object.keys(existingPicks), ...Object.keys(newPicks)]);
  for (const sid of allIds) {
    const started = isSeriesStarted(sid, liveSeries);
    const prev = existingPicks[sid];
    const next = newPicks[sid];
    if (started) {
      // Frozen — keep whatever the user had before; ignore any incoming change.
      if (prev !== undefined) mergedPicks[sid] = prev;
      if (next !== undefined && next !== prev) rejected.push(sid);
    } else if (next !== undefined) {
      mergedPicks[sid] = next;
    }
    // If neither prev nor next, skip (nothing to write).
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM picks WHERE user_id = ?').run(user.id);
    const ins = db.prepare('INSERT INTO picks (user_id, series_id, winner_id) VALUES (?, ?, ?)');
    for (const [sid, wid] of Object.entries(mergedPicks)) ins.run(user.id, sid, wid);
    db.prepare('UPDATE users SET tiebreaker = ? WHERE id = ?').run(tiebreaker, user.id);
  });
  tx();
  res.json({ ok: true, rejected });
});

app.get('/api/state', async (req, res) => {
  const locked = getSetting('locked') === 'true';
  const results = db.prepare('SELECT series_id, winner_id, games FROM results').all();
  const resultsObj = Object.fromEntries(results.map(r => [r.series_id, { winner: r.winner_id, games: r.games }]));

  const users = db.prepare('SELECT id, name, tiebreaker FROM users').all();
  const allPicks = db.prepare('SELECT user_id, series_id, winner_id FROM picks').all();
  const picksByUser = {};
  for (const p of allPicks) {
    (picksByUser[p.user_id] = picksByUser[p.user_id] || {})[p.series_id] = p.winner_id;
  }

  const leaderboard = users.map(u => {
    const picks = picksByUser[u.id] || {};
    let score = 0;
    const correctByRound = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const [sid, wid] of Object.entries(picks)) {
      const result = resultsObj[sid];
      if (result && result.winner === wid) {
        const r = seriesRound(sid);
        score += ROUND_POINTS[r] || 0;
        correctByRound[r]++;
      }
    }
    return {
      name: u.name,
      score,
      correctByRound,
      tiebreaker: u.tiebreaker,
      picks // always visible — pool is open for everyone to see each other's brackets
    };
  });

  leaderboard.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const finals = resultsObj['NF'];
    if (finals && finals.games && a.tiebreaker != null && b.tiebreaker != null) {
      const actual = +finals.games;
      return Math.abs(a.tiebreaker - actual) - Math.abs(b.tiebreaker - actual);
    }
    return a.name.localeCompare(b.name);
  });

  const liveSeries = await fetchLiveSeries(resultsObj);
  res.json({ locked, results: resultsObj, leaderboard, liveSeries });
});

const requireAdmin = (req, res, next) => {
  const key = req.headers['x-admin-key'] || req.query.key || req.body?.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.post('/api/admin/check', requireAdmin, (req, res) => res.json({ ok: true }));

app.post('/api/admin/result', requireAdmin, (req, res) => {
  const { seriesId, winnerId, games } = req.body || {};
  if (!seriesId || !winnerId) return res.status(400).json({ error: 'Missing seriesId or winnerId' });
  db.prepare('INSERT INTO results (series_id, winner_id, games) VALUES (?, ?, ?) ON CONFLICT(series_id) DO UPDATE SET winner_id = excluded.winner_id, games = excluded.games, updated_at = CURRENT_TIMESTAMP')
    .run(seriesId, winnerId, games ? String(games) : null);
  res.json({ ok: true });
});

app.delete('/api/admin/result/:seriesId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM results WHERE series_id = ?').run(req.params.seriesId);
  res.json({ ok: true });
});

app.post('/api/admin/lock', requireAdmin, (req, res) => {
  const locked = !!req.body?.locked;
  setSetting('locked', locked ? 'true' : 'false');
  res.json({ ok: true, locked });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, name, edit_key, tiebreaker, created_at FROM users ORDER BY created_at DESC').all();
  res.json({ users: rows });
});

app.delete('/api/admin/user/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM picks WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`\n🏀 Wankers NBA Bracket on http://localhost:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin.html (key: ${ADMIN_KEY === 'wankers2026' ? 'default wankers2026 — set ADMIN_KEY!' : '***'})\n`);
});
