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

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', (req, res) => {
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

  const editKey = crypto.randomBytes(12).toString('hex');
  const tx = db.transaction(() => {
    const result = db.prepare('INSERT INTO users (name, edit_key, tiebreaker) VALUES (?, ?, ?)').run(name, editKey, tiebreaker);
    const userId = result.lastInsertRowid;
    const ins = db.prepare('INSERT INTO picks (user_id, series_id, winner_id) VALUES (?, ?, ?)');
    for (const [sid, wid] of Object.entries(picks)) ins.run(userId, sid, wid);
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

app.post('/api/user/:editKey/picks', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE edit_key = ?').get(req.params.editKey);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (getSetting('locked') === 'true') return res.status(403).json({ error: 'Picks are locked' });

  const picks = req.body?.picks || {};
  const tbRaw = req.body?.tiebreaker;
  const tiebreaker = (tbRaw != null && Number.isFinite(+tbRaw)) ? +tbRaw : null;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM picks WHERE user_id = ?').run(user.id);
    const ins = db.prepare('INSERT INTO picks (user_id, series_id, winner_id) VALUES (?, ?, ?)');
    for (const [sid, wid] of Object.entries(picks)) ins.run(user.id, sid, wid);
    db.prepare('UPDATE users SET tiebreaker = ? WHERE id = ?').run(tiebreaker, user.id);
  });
  tx();
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
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
      picks: locked ? picks : null
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

  res.json({ locked, results: resultsObj, leaderboard });
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
