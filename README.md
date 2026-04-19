# 🏀 Wankers NBA Playoff Bracket

March Madness-style bracket pool for the 2026 NBA Playoffs. Players register, pick every series, watch the leaderboard move as results come in.

## What's inside

- **Node.js + Express** backend with **Postgres** storage
- Single-page frontend with real NBA team logos, horizontal bracket tree with SVG connectors, dark/chartreuse Darwin-inspired design, confetti on save
- Admin panel at `/admin.html` to mark series winners and lock picks
- Scoring: **1 / 2 / 4 / 8** points per correct pick by round (max 32)
- Tiebreaker: total points in NBA Finals Game 1
- Private edit links — each user gets their own URL to update picks until admin locks
- Round-gated peek at other players' picks once the bracket locks

## Deploy to Render (free, one click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/noam-a11y/wankers-nba-bracket)

1. Click the button above (or go to [render.com/deploy](https://render.com/deploy?repo=https://github.com/noam-a11y/wankers-nba-bracket)).
2. Sign in / sign up for Render (GitHub login works).
3. Render reads [`render.yaml`](./render.yaml) and provisions both a **free Web Service** and a **free Postgres database**, auto-wiring `DATABASE_URL`.
4. You'll be prompted for one secret: **`ADMIN_KEY`** — set it to a long random string. That's your admin password.
5. Click **Apply**. First deploy takes ~3 minutes.
6. Copy the web service URL (e.g. `https://wankers-bracket.onrender.com`) — that's your shareable link.

**Notes on Render's free tier**:
- Free web services sleep after 15 min of inactivity; first request after sleep takes ~30 sec to wake. For uninterrupted use upgrade to Starter ($7/mo).
- Free Postgres databases are retained for 90 days. Renew or upgrade before then or data is lost. That covers the whole playoffs comfortably.

## Run locally

You need Postgres. Easiest way is Docker:

```bash
# boot a local Postgres in the background
docker compose up -d

# install deps
npm install

# run the server
DATABASE_URL=postgres://wankers:wankers@localhost:5432/wankers \
ADMIN_KEY=your-secret-key \
npm start
```

Open http://localhost:3000. Admin panel at http://localhost:3000/admin.html.

To stop / clean up the local DB:
```bash
docker compose down        # stop container
docker compose down -v     # stop + wipe data
```

## Sharing the pool

Once deployed, just paste the web service URL into your group chat. Anyone with the URL can register a name and make picks until you lock the bracket from the admin panel.

## How it works

### User flow

1. Visit the site → click any team to start making picks. All picks save to `localStorage` immediately.
2. Hit **💾 Save my bracket** → enter a name → get a private edit link.
3. Come back via the edit link (or localStorage) to change picks until admin locks.
4. After lock, see the live leaderboard. Click any player to peek at their picks — but only for rounds that have tipped off (R1 first, then R1+R2 once R1 is done, etc.)

### Admin flow

1. Go to `/admin.html`, log in with `ADMIN_KEY`.
2. **Lock picks** before Round 1 Game 1 tips off.
3. After each series concludes, pick the winner in the dropdown and save. Optional games played (4–7).
4. Leaderboard updates live for all users.
5. Delete a user via the admin users table if someone registered by mistake.

### Scoring

| Round         | Series | Points each | Max |
|---------------|--------|------------|-----|
| First Round   | 8      | 1          | 8   |
| Conf Semis    | 4      | 2          | 8   |
| Conf Finals   | 2      | 4          | 8   |
| NBA Finals    | 1      | 8          | 8   |
| **Total**     | **15** | —          | **32** |

Tiebreaker: closest guess to NBA Finals Game 1 total points.

### Bracket propagation

Pick BOS to win R1 + NYK to win R1 → R2 series shows **BOS vs NYK**. Change R1 pick to PHI → R2 pick auto-clears. Same thing as admin posts results: the **Bracket** tab reflects the actual playoff state.

## File tour

```
wankers-bracket/
├── server.js            # Express + pg server (all API routes)
├── render.yaml          # Render blueprint (web + postgres)
├── docker-compose.yml   # Local Postgres for dev
├── package.json
└── public/
    ├── index.html       # Main app shell
    ├── app.js           # State, rendering, interactions
    ├── data.js          # Teams + series definition
    ├── style.css        # Darwin design tokens + components
    ├── admin.html       # Admin panel
    └── admin.js         # Admin logic
```

## Security notes

- Edit keys are 24-char random hex. Anyone with a user's link can edit that user's picks — tell friends not to share theirs.
- Admin key lives in an env var. If you commit it to Git by accident, rotate it in Render's environment settings.
- No auth or rate limiting built in. Fine for friends-and-family; don't paste the URL into a stadium jumbotron.

## Tweaks

- **Change scoring**: edit `ROUND_POINTS` in `server.js` AND `public/data.js` (keep in sync).
- **Change teams/matchups**: edit `TEAMS` and `SERIES` in `public/data.js`. Server doesn't care about specifics.

MIT License.
