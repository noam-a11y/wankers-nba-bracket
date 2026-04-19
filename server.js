const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'wankers2026';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('\n❌ DATABASE_URL is required.\n');
  console.error('   For local dev: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pw --name wankers-pg postgres:16');
  console.error('   Then: export DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres\n');
  process.exit(1);
}

const app = express();
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false }
});

const q = (sql, params) => pool.query(sql, params);
const qOne = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
const qRows = async (sql, params) => (await pool.query(sql, params)).rows;

async function initSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      name_lower TEXT NOT NULL UNIQUE,
      edit_key TEXT NOT NULL UNIQUE,
      tiebreaker INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS picks (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      series_id TEXT NOT NULL,
      winner_id TEXT NOT NULL,
      PRIMARY KEY (user_id, series_id)
    );
    CREATE TABLE IF NOT EXISTS results (
      series_id TEXT PRIMARY KEY,
      winner_id TEXT NOT NULL,
      games TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT INTO settings (key, value) VALUES ('locked', 'false') ON CONFLICT DO NOTHING;
  `);
}

const getSetting = async (k) => (await qOne('SELECT value FROM settings WHERE key = $1', [k]))?.value ?? null;
const setSetting = async (k, v) => {
  await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, String(v)]);
};

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

app.post('/api/register', async (req, res) => {
  const name = (req.body?.name || '').trim();
  const picks = req.body?.picks || {};
  const tbRaw = req.body?.tiebreaker;
  const tiebreaker = (tbRaw != null && Number.isFinite(+tbRaw)) ? +tbRaw : null;

  if (!name || name.length < 2 || name.length > 40) {
    return res.status(400).json({ error: 'Name must be 2-40 characters' });
  }
  if ((await getSetting('locked')) === 'true') {
    return res.status(403).json({ error: 'Picks are locked — the playoffs have started' });
  }

  const editKey = crypto.randomBytes(12).toString('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query(
      'INSERT INTO users (name, name_lower, edit_key, tiebreaker) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, name.toLowerCase(), editKey, tiebreaker]
    );
    const userId = userRes.rows[0].id;
    for (const [sid, wid] of Object.entries(picks)) {
      await client.query(
        'INSERT INTO picks (user_id, series_id, winner_id) VALUES ($1, $2, $3)',
        [userId, sid, wid]
      );
    }
    await client.query('COMMIT');
    res.json({ editKey, userId, name });
  } catch (e) {
    await client.query('ROLLBACK');
    if (String(e.message).match(/unique|duplicate/i)) {
      return res.status(409).json({ error: 'That name is taken. Pick another.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.get('/api/user/:editKey', async (req, res) => {
  const user = await qOne('SELECT id, name, tiebreaker FROM users WHERE edit_key = $1', [req.params.editKey]);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const picks = await qRows('SELECT series_id, winner_id FROM picks WHERE user_id = $1', [user.id]);
  const picksObj = Object.fromEntries(picks.map(p => [p.series_id, p.winner_id]));
  res.json({ id: user.id, name: user.name, tiebreaker: user.tiebreaker, picks: picksObj });
});

app.post('/api/user/:editKey/picks', async (req, res) => {
  const user = await qOne('SELECT id FROM users WHERE edit_key = $1', [req.params.editKey]);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if ((await getSetting('locked')) === 'true') return res.status(403).json({ error: 'Picks are locked' });

  const picks = req.body?.picks || {};
  const tbRaw = req.body?.tiebreaker;
  const tiebreaker = (tbRaw != null && Number.isFinite(+tbRaw)) ? +tbRaw : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM picks WHERE user_id = $1', [user.id]);
    for (const [sid, wid] of Object.entries(picks)) {
      await client.query(
        'INSERT INTO picks (user_id, series_id, winner_id) VALUES ($1, $2, $3)',
        [user.id, sid, wid]
      );
    }
    await client.query('UPDATE users SET tiebreaker = $1 WHERE id = $2', [tiebreaker, user.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.get('/api/state', async (req, res) => {
  const locked = (await getSetting('locked')) === 'true';
  const results = await qRows('SELECT series_id, winner_id, games FROM results');
  const resultsObj = Object.fromEntries(results.map(r => [r.series_id, { winner: r.winner_id, games: r.games }]));

  const users = await qRows('SELECT id, name, tiebreaker FROM users');
  const allPicks = await qRows('SELECT user_id, series_id, winner_id FROM picks');
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

app.post('/api/admin/result', requireAdmin, async (req, res) => {
  const { seriesId, winnerId, games } = req.body || {};
  if (!seriesId || !winnerId) return res.status(400).json({ error: 'Missing seriesId or winnerId' });
  await q(
    `INSERT INTO results (series_id, winner_id, games) VALUES ($1, $2, $3)
     ON CONFLICT (series_id) DO UPDATE SET winner_id = EXCLUDED.winner_id, games = EXCLUDED.games, updated_at = now()`,
    [seriesId, winnerId, games ? String(games) : null]
  );
  res.json({ ok: true });
});

app.delete('/api/admin/result/:seriesId', requireAdmin, async (req, res) => {
  await q('DELETE FROM results WHERE series_id = $1', [req.params.seriesId]);
  res.json({ ok: true });
});

app.post('/api/admin/lock', requireAdmin, async (req, res) => {
  const locked = !!req.body?.locked;
  await setSetting('locked', locked ? 'true' : 'false');
  res.json({ ok: true, locked });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const rows = await qRows('SELECT id, name, edit_key, tiebreaker, created_at FROM users ORDER BY created_at DESC');
  res.json({ users: rows });
});

app.delete('/api/admin/user/:id', requireAdmin, async (req, res) => {
  await q('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));

initSchema().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🏀 Wankers NBA Bracket running on http://localhost:${PORT}`);
    console.log(`   Admin panel: http://localhost:${PORT}/admin.html`);
    console.log(`   Admin key: ${ADMIN_KEY === 'wankers2026' ? '(default — set ADMIN_KEY in production!)' : '(set via env)'}\n`);
  });
}).catch(e => {
  console.error('Failed to initialize schema:', e);
  process.exit(1);
});
