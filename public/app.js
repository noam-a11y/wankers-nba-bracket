// ===== State =====
const state = {
  picks: {},            // { seriesId: winnerTeamId }
  tiebreaker: null,
  user: null,           // { id, name, editKey }
  locked: false,
  results: {},          // { seriesId: { winner, games } }
  leaderboard: [],
  activeTab: 'bracket',
  dirty: false
};

// ===== DOM helpers =====
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const LOGO_URL = (teamId) => TEAMS[teamId] ? `https://cdn.nba.com/logos/nba/${TEAMS[teamId].nbaId}/primary/L/logo.svg` : '';
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== API =====
async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadState() {
  try {
    const data = await api('api/state');
    state.locked = data.locked;
    state.results = data.results;
    state.leaderboard = data.leaderboard;
  } catch (e) {
    toast('Failed to load: ' + e.message, 'error');
  }
}

// ===== Local persistence =====
function saveLocalPicks() {
  try {
    localStorage.setItem('wankers_draft', JSON.stringify({ picks: state.picks, tiebreaker: state.tiebreaker }));
  } catch {}
}
function loadLocalPicks() {
  try {
    const raw = localStorage.getItem('wankers_draft');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveLocalUser(u) {
  localStorage.setItem('wankers_user', JSON.stringify({ editKey: u.editKey, name: u.name }));
}
function loadLocalUser() {
  try { return JSON.parse(localStorage.getItem('wankers_user')); } catch { return null; }
}
function clearLocalUser() { localStorage.removeItem('wankers_user'); }

async function hydrateUser() {
  const urlKey = new URLSearchParams(location.search).get('k');
  let key = urlKey;
  if (!key) {
    const stored = loadLocalUser();
    if (stored) key = stored.editKey;
  }
  if (!key) return;
  try {
    const user = await api('api/user/' + encodeURIComponent(key));
    state.user = { id: user.id, name: user.name, editKey: key };
    state.picks = { ...user.picks };
    state.tiebreaker = user.tiebreaker;
    saveLocalUser(state.user);
    saveLocalPicks();
    if (urlKey) history.replaceState({}, '', location.pathname);
  } catch (e) {
    clearLocalUser();
  }
}

// ===== Interactions =====
function pickTeam(seriesId, teamId) {
  if (state.locked) return;
  const prev = state.picks[seriesId];
  if (prev === teamId) {
    delete state.picks[seriesId];
  } else {
    state.picks[seriesId] = teamId;
  }
  if (prev && prev !== teamId) invalidateDownstream(seriesId);
  state.dirty = true;
  saveLocalPicks();
  renderBracket();
  renderSidePanel();
}

function invalidateDownstream(changedSeriesId) {
  SERIES.forEach(s => {
    if (!s.feeds || !s.feeds.includes(changedSeriesId)) return;
    const allowed = possibleTeamsFor(s.id, state.picks, state.results);
    const current = state.picks[s.id];
    if (current && !allowed.includes(current)) {
      delete state.picks[s.id];
      invalidateDownstream(s.id);
    }
  });
}

function chalkPicks() {
  const next = {};
  SERIES.forEach(s => {
    if (s.slots) next[s.id] = s.slots[0]; // higher seed wins R1
  });
  // Propagate higher seed through later rounds
  SERIES.forEach(s => {
    if (s.feeds) {
      const [a, b] = s.feeds.map(f => next[f]);
      if (a && b) {
        next[s.id] = TEAMS[a].seed <= TEAMS[b].seed ? a : b;
      }
    }
  });
  state.picks = next;
  state.dirty = true;
  saveLocalPicks();
  renderBracket();
  renderSidePanel();
}

function resetBracket() {
  if (!confirm('Reset all picks? Your tiebreaker stays.')) return;
  state.picks = {};
  state.dirty = true;
  saveLocalPicks();
  renderBracket();
  renderSidePanel();
}

// ===== Rendering =====

// Layout constants — tuned to fit a typical 1280-1440px laptop viewport.
const CARD_H_SM = 69;
const CARD_H_MD = 85;
const R1_GAP = 22;
const R1_PITCH = CARD_H_SM + R1_GAP; // 91
const COL_W = 170;
const CONN_W = 28;
const HALF_H = 4 * CARD_H_SM + 3 * R1_GAP; // 342
const FIN_COL_W = 228;
const TREE_MIN_W = COL_W * 5 + CONN_W * 4 + FIN_COL_W; // 1190

function renderBracket() {
  renderBracketTree();
  renderBracketStacked();
  renderChampionBanner();
}

function renderBracketTree() {
  const tree = $('#bracketTree');

  const B = {
    east: {
      r1: ['E1', 'E2', 'E3', 'E4'].map(id => SERIES_BY_ID[id]),
      r2: ['E5', 'E6'].map(id => SERIES_BY_ID[id]),
      cf: SERIES_BY_ID['EF']
    },
    west: {
      r1: ['W1', 'W2', 'W3', 'W4'].map(id => SERIES_BY_ID[id]),
      r2: ['W5', 'W6'].map(id => SERIES_BY_ID[id]),
      cf: SERIES_BY_ID['WF']
    },
    finals: SERIES_BY_ID['NF']
  };

  const r1Tops = [0, R1_PITCH, R1_PITCH * 2, R1_PITCH * 3];
  const r1Centers = r1Tops.map(t => t + CARD_H_SM / 2);
  const sfCenters = [(r1Centers[0] + r1Centers[1]) / 2, (r1Centers[2] + r1Centers[3]) / 2];
  const sfTops = sfCenters.map(c => c - CARD_H_SM / 2);
  const cfCenter = (sfCenters[0] + sfCenters[1]) / 2;
  const cfTop = cfCenter - CARD_H_MD / 2;

  const headerCol = (title, sub, align, isFinals = false) => `
    <div class="bracket-col round-header ${align}" style="width: ${isFinals ? FIN_COL_W : COL_W}px">
      ${isFinals ? `<div class="finals-pill">The Finals</div><div style="font: var(--type-body-small); color: var(--text-caption); margin-top: 6px; font-variant-numeric: tabular-nums;">Best of 7 · June 2026</div>` :
        `<div class="overline">${title}</div><div class="sub">${sub}</div>`}
    </div>
  `;
  const emptyConnHeader = () => `<div class="bracket-col" style="width: ${CONN_W}px"></div>`;

  const halfHeadersWest = [
    headerCol('First Round', 'Best of 7', 'round-header'),
    emptyConnHeader(),
    headerCol('Conf. Semifinals', 'Best of 7', 'center'),
    emptyConnHeader(),
    headerCol('Conf. Finals', 'Best of 7', 'right')
  ].join('');

  const halfHeadersEast = [
    headerCol('Conf. Finals', 'Best of 7', 'round-header'),
    emptyConnHeader(),
    headerCol('Conf. Semifinals', 'Best of 7', 'center'),
    emptyConnHeader(),
    headerCol('First Round', 'Best of 7', 'right')
  ].join('');

  const connR1toSF = (east) => `
    <div class="bracket-col col-half col-conn">
      <svg width="${CONN_W}" height="${HALF_H}" style="display:block">
        <g stroke="var(--border-muted)" stroke-width="1" fill="none">
          <line x1="${east ? CONN_W : 0}" y1="${r1Centers[0]}" x2="${CONN_W / 2}" y2="${r1Centers[0]}" />
          <line x1="${east ? CONN_W : 0}" y1="${r1Centers[1]}" x2="${CONN_W / 2}" y2="${r1Centers[1]}" />
          <line x1="${CONN_W / 2}" y1="${r1Centers[0]}" x2="${CONN_W / 2}" y2="${r1Centers[1]}" />
          <line x1="${CONN_W / 2}" y1="${sfCenters[0]}" x2="${east ? 0 : CONN_W}" y2="${sfCenters[0]}" />
          <line x1="${east ? CONN_W : 0}" y1="${r1Centers[2]}" x2="${CONN_W / 2}" y2="${r1Centers[2]}" />
          <line x1="${east ? CONN_W : 0}" y1="${r1Centers[3]}" x2="${CONN_W / 2}" y2="${r1Centers[3]}" />
          <line x1="${CONN_W / 2}" y1="${r1Centers[2]}" x2="${CONN_W / 2}" y2="${r1Centers[3]}" />
          <line x1="${CONN_W / 2}" y1="${sfCenters[1]}" x2="${east ? 0 : CONN_W}" y2="${sfCenters[1]}" />
        </g>
      </svg>
    </div>
  `;
  const connSFtoCF = (east) => `
    <div class="bracket-col col-half col-conn">
      <svg width="${CONN_W}" height="${HALF_H}" style="display:block">
        <g stroke="var(--border-muted)" stroke-width="1" fill="none">
          <line x1="${east ? CONN_W : 0}" y1="${sfCenters[0]}" x2="${CONN_W / 2}" y2="${sfCenters[0]}" />
          <line x1="${east ? CONN_W : 0}" y1="${sfCenters[1]}" x2="${CONN_W / 2}" y2="${sfCenters[1]}" />
          <line x1="${CONN_W / 2}" y1="${sfCenters[0]}" x2="${CONN_W / 2}" y2="${sfCenters[1]}" />
          <line x1="${CONN_W / 2}" y1="${cfCenter}" x2="${east ? 0 : CONN_W}" y2="${cfCenter}" />
        </g>
      </svg>
    </div>
  `;

  const r1Col = (conf) => `
    <div class="bracket-col col-half col-w">
      ${conf.r1.map((m, i) => `
        <div style="position: absolute; top: ${r1Tops[i]}px; left: 0; right: 0;">
          ${matchupCardHtml(m, 'sm')}
        </div>
      `).join('')}
    </div>
  `;
  const sfCol = (conf) => `
    <div class="bracket-col col-half col-w">
      ${conf.r2.map((m, i) => `
        <div style="position: absolute; top: ${sfTops[i]}px; left: 0; right: 0;">
          ${matchupCardHtml(m, 'sm')}
        </div>
      `).join('')}
    </div>
  `;
  const cfCol = (conf) => `
    <div class="bracket-col col-half col-w">
      <div style="position: absolute; top: ${cfTop}px; left: 0; right: 0;">
        ${matchupCardHtml(conf.cf, 'md')}
      </div>
    </div>
  `;

  const westHalf = [r1Col(B.west), connR1toSF(false), sfCol(B.west), connSFtoCF(false), cfCol(B.west)].join('');
  const eastHalf = [cfCol(B.east), connSFtoCF(true), sfCol(B.east), connR1toSF(true), r1Col(B.east)].join('');

  // Finals column
  const finalsFrameTop = HALF_H / 2 - CARD_H_MD / 2 - 4;
  const finalsCol = `
    <div class="bracket-col col-half col-finals" style="display: flex; flex-direction: column; align-items: center;">
      <div class="finals-frame" style="top: ${finalsFrameTop}px; left: 20px; right: 20px;">
        <div class="finals-frame-inner">
          ${matchupCardHtml(B.finals, 'md')}
        </div>
      </div>
    </div>
  `;

  tree.style.minWidth = TREE_MIN_W + 'px';
  tree.innerHTML = `
    <div class="bracket-headers-row">
      ${halfHeadersWest}
      <div class="bracket-col" style="width: ${FIN_COL_W}px; text-align: center;">
        <div class="finals-pill">The Finals</div>
        <div style="font: var(--type-body-small); color: var(--text-caption); margin-top: 6px; font-variant-numeric: tabular-nums;">Best of 7 · June 2026</div>
      </div>
      ${halfHeadersEast}
    </div>
    <div class="bracket-cards-row">
      ${westHalf}
      ${finalsCol}
      ${eastHalf}
    </div>
  `;

  // Wire up click handlers
  tree.querySelectorAll('.matchup-row[data-series]').forEach(el => {
    if (el.classList.contains('empty')) return;
    el.addEventListener('click', () => pickTeam(el.dataset.series, el.dataset.team));
  });
}

function renderBracketStacked() {
  const container = $('#bracketStacked');
  const byRound = { 1: [], 2: [], 3: [], 4: [] };
  SERIES.forEach(s => byRound[s.round].push(s));

  container.innerHTML = [1, 2, 3, 4].map(r => `
    <div class="round-block">
      <h4>${ROUND_NAMES[r]} <span class="round-pts">${ROUND_POINTS[r]} pt${ROUND_POINTS[r] > 1 ? 's' : ''} each</span></h4>
      <div class="series-grid">
        ${byRound[r].map(s => matchupCardHtml(s, 'md')).join('')}
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.matchup-row[data-series]').forEach(el => {
    if (el.classList.contains('empty')) return;
    el.addEventListener('click', () => pickTeam(el.dataset.series, el.dataset.team));
  });
}

function matchupCardHtml(series, size) {
  const teams = possibleTeamsFor(series.id, state.picks, state.results);
  const pickedId = state.picks[series.id];
  const actual = state.results[series.id]?.winner;
  return `
    <div class="matchup-card" data-series="${series.id}">
      ${matchupRowHtml(teams[0], series, size, true, pickedId, actual)}
      ${matchupRowHtml(teams[1], series, size, false, pickedId, actual)}
    </div>
  `;
}

function matchupRowHtml(teamId, series, size, isTop, pickedId, actual) {
  if (!teamId) {
    const label = series.round === 1 ? 'winner' :
      series.round === 2 ? `Winner of ${series.feeds[isTop ? 0 : 1]}` :
      series.round === 3 ? 'Winner of Semis' : 'Conference Champion';
    return `
      <button class="matchup-row size-${size} empty">
        <span class="logo-placeholder"></span>
        <span>${label}</span>
      </button>
    `;
  }
  const team = TEAMS[teamId];
  const isPicked = pickedId === teamId;
  const isActual = actual === teamId;
  const isOtherPicked = pickedId && pickedId !== teamId;
  const isLocked = !!actual;

  const classes = ['matchup-row', `size-${size}`];
  if (isPicked && isLocked && isActual) classes.push('picked', 'right');
  else if (isPicked && isLocked && !isActual) classes.push('picked', 'wrong');
  else if (isPicked) classes.push('picked');
  else if (isActual) classes.push('actual-not-picked');
  else if (isOtherPicked) classes.push('other-picked');

  const teamLabel = size === 'sm' ? team.abbr : `${team.city} ${team.name}`;
  const showRecord = size !== 'sm';
  const wonBadge = isActual ? (isPicked ? '<span class="won-badge">✓</span>' : '<span class="won-badge">WON</span>') : '';

  return `
    <button class="${classes.join(' ')}" data-series="${series.id}" data-team="${teamId}">
      <span class="seed">${team.seed}</span>
      <img class="team-logo" src="${LOGO_URL(teamId)}" alt="${team.name}" loading="lazy" onerror="this.style.display='none'">
      <div class="team-text">
        <span class="team-name">${teamLabel}</span>
        ${showRecord ? `<span class="team-record">${team.record}</span>` : ''}
      </div>
      ${wonBadge}
    </button>
  `;
}

function renderChampionBanner() {
  const pick = state.picks['NF'];
  const banner = $('#championBanner');
  if (!pick) { banner.innerHTML = ''; return; }
  const team = TEAMS[pick];
  const actual = state.results['NF']?.winner;
  const right = actual && actual === pick;
  const wrong = actual && actual !== pick;
  let sub = right ? '✓ You called it.' : wrong ? '✗ Not this year.' : 'Your 2026 Champion';
  banner.innerHTML = `
    <div class="champion-banner">
      <div class="inner">
        <div class="label">${sub}</div>
        <div class="name">${team.city} ${team.name}</div>
      </div>
    </div>
  `;
}

function renderSidePanel() {
  const filled = Object.keys(state.picks).length;
  $('#picksFilled').textContent = filled;
  $('#progressFill').style.width = (filled / 15 * 100) + '%';

  const youName = $('#youName');
  if (state.user) {
    youName.hidden = false;
    youName.textContent = '● ' + state.user.name;
  } else {
    youName.hidden = true;
  }

  const saveBtn = $('#saveBtnMain');
  const copyBtn = $('#copyLinkBtn');
  const tbInput = $('#tiebreakerInput');
  const progressText = $('#controlsProgress');
  tbInput.value = state.tiebreaker ?? '';

  if (progressText) {
    progressText.textContent = state.locked
      ? `Picks locked · ${filled}/15 saved`
      : `${filled} / 15 picks`;
  }

  if (state.locked) {
    saveBtn.hidden = true;
    tbInput.disabled = true;
    $('#picksSub').textContent = 'Bracket locked';
  } else {
    saveBtn.hidden = false;
    tbInput.disabled = false;
    if (filled === 0) {
      saveBtn.innerHTML = '💾 Save my bracket';
      saveBtn.disabled = true;
    } else if (filled < 15) {
      saveBtn.innerHTML = `💾 Save progress (${filled}/15)`;
      saveBtn.disabled = false;
    } else {
      saveBtn.innerHTML = state.user ? '💾 Update my bracket' : '💾 Save my bracket';
      saveBtn.disabled = false;
    }
    $('#picksSub').textContent = filled === 15 ? 'Bracket complete' : `${15 - filled} series left`;
  }

  copyBtn.hidden = !state.user;

  // Hero players count
  const playerCount = state.leaderboard.length;
  $('#heroPlayers').textContent = playerCount === 0 ? 'Open' : String(playerCount);
  const deadline = $('#heroDeadline');
  const deadlineSub = $('#heroDeadlineSub');
  if (state.locked) {
    deadline.textContent = 'Closed';
    deadlineSub.textContent = 'Playoffs are live';
  } else {
    deadline.textContent = 'Apr 20';
    deadlineSub.textContent = 'Before Game 1 tip-off';
  }

  // Status pill
  const pill = $('#statusPill');
  const status = $('#statusText');
  if (state.locked) {
    pill.classList.add('locked');
    status.textContent = 'Picks locked';
  } else {
    pill.classList.remove('locked');
    status.textContent = 'Picks open';
  }
}

// Max round visible in picks-view: locked + round's prior round is fully done.
// - Not locked: 0 (nothing visible)
// - Locked, no R1 results: 1 (R1 in progress)
// - All R1 done: 2 (R2 in progress)
// - All R2 done: 3 (CF)
// - All CF done: 4 (Finals)
function visibleMaxRound() {
  if (!state.locked) return 0;
  let max = 1;
  for (let r = 1; r <= 3; r++) {
    const sr = SERIES.filter(s => s.round === r);
    if (sr.length && sr.every(s => state.results[s.id])) max = r + 1;
    else break;
  }
  return max;
}

function renderLeaderboard() {
  const container = $('#leaderboardContainer');
  const board = state.leaderboard;
  const youName = state.user?.name?.toLowerCase();
  const clickable = state.locked;
  const vmax = visibleMaxRound();

  if (!board.length) {
    container.innerHTML = `
      <div class="empty-state">
        <p>🏀 No one has picked yet. Be the first.</p>
        <button class="btn btn-primary" id="emptyJoinBtn">Join the pool</button>
      </div>
    `;
    $('#emptyJoinBtn')?.addEventListener('click', openJoinModal);
    $('#leaderCard').hidden = true;
    return;
  }

  const hint = clickable
    ? `<span style="color: var(--green-700); font-weight: 600;">● Locked.</span> Tap a row to peek at their picks through ${ROUND_NAMES[vmax]}.`
    : `Picks hidden until the bracket locks at tip-off.`;

  container.innerHTML = `
    <div class="leaderboard">
      <div class="leaderboard-head">
        <div>
          <h3>Wankers Leaderboard</h3>
          <div class="sub">${board.length} player${board.length > 1 ? 's' : ''} · updated live</div>
          <div class="sub" style="margin-top: 4px;">${hint}</div>
        </div>
        <div class="leaderboard-pill"><span class="dot"></span> Live</div>
      </div>
      <div>
        ${board.map((u, i) => {
          const isYou = youName && u.name.toLowerCase() === youName;
          const color = avatarColor(u.name);
          const letter = avatarLetter(u.name);
          return `
            <div class="lb-row ${isYou ? 'you' : ''} ${clickable ? 'clickable' : ''}" data-name="${escapeHtml(u.name)}">
              <span class="lb-rank">${i + 1}</span>
              <div class="lb-avatar" style="background: ${color}">${letter}</div>
              <div class="lb-body">
                <div class="lb-name">
                  ${escapeHtml(u.name)}
                  ${isYou ? '<span class="lb-you-tag">You</span>' : ''}
                </div>
                <div class="lb-meta">
                  R1 ${u.correctByRound[1]}/8 · R2 ${u.correctByRound[2]}/4 · CF ${u.correctByRound[3]}/2 · F ${u.correctByRound[4]}/1${u.tiebreaker != null ? ` · TB ${u.tiebreaker}` : ''}
                </div>
              </div>
              <div class="lb-score">
                <div class="pts">${u.score}</div>
                <div class="unit">pts</div>
              </div>
              ${clickable ? '<span class="lb-chevron">›</span>' : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  if (clickable) {
    container.querySelectorAll('.lb-row.clickable').forEach(row => {
      row.addEventListener('click', () => openPicksViewByName(row.dataset.name));
    });
  }

  // Leader card
  $('#leaderCard').hidden = false;
  $('#leaderName').textContent = board[0].name;
  const anyResults = Object.keys(state.results).length > 0;
  $('#leaderSub').textContent = anyResults
    ? `${board[0].score} pts · Max 32`
    : 'Standings start once the first series ends.';
}

// ===== Tabs =====
function setTab(tab) {
  state.activeTab = tab;
  $$('.nav-item[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  $('#panel-bracket').hidden = tab !== 'bracket';
  $('#panel-leaderboard').hidden = tab !== 'leaderboard';
  if (tab === 'leaderboard') renderLeaderboard();
  if (tab === 'bracket') { renderBracket(); renderSidePanel(); }
}

// ===== Modals =====
function openJoinModal() {
  $('#joinModal').classList.add('show');
  $('#nameInput').focus();
  $('#gateError').hidden = true;
}
function closeJoinModal() {
  $('#joinModal').classList.remove('show');
}
function openPicksViewByName(name) {
  const user = state.leaderboard.find(u => u.name.toLowerCase() === name.toLowerCase());
  if (!user || !state.locked) return;
  const picks = user.picks || {};
  const vmax = visibleMaxRound();
  const isYou = state.user && state.user.name.toLowerCase() === name.toLowerCase();

  $('#picksViewName').textContent = (isYou ? 'Your bracket · ' : '') + user.name;
  $('#picksViewMeta').innerHTML = `
    <span style="color: var(--text-title); font-weight: 600;">${user.score} pts</span>
    · R1 ${user.correctByRound[1]}/8
    · R2 ${user.correctByRound[2]}/4
    · CF ${user.correctByRound[3]}/2
    · F ${user.correctByRound[4]}/1
    ${user.tiebreaker != null ? `· TB ${user.tiebreaker}` : ''}
  `;
  $('#picksViewRange').textContent = vmax === 1
    ? 'Showing First Round picks only. Later rounds reveal as they tip off.'
    : vmax === 4
      ? 'Showing all four rounds — the playoffs are underway.'
      : `Showing rounds 1 through ${vmax} (${ROUND_NAMES[vmax]} is live). Later picks still hidden.`;

  // Render rounds 1..vmax as stacked matchup cards (read-only)
  const body = $('#picksViewBody');
  body.innerHTML = '';
  for (let r = 1; r <= vmax; r++) {
    const seriesInRound = SERIES.filter(s => s.round === r);
    const roundHtml = seriesInRound.map(s => readOnlyMatchupCardHtml(s, picks)).join('');
    body.insertAdjacentHTML('beforeend', `
      <div style="margin-bottom: 20px;">
        <h4 style="font: var(--type-overline); color: var(--text-caption); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
          ${ROUND_NAMES[r]}
          <span style="font: 600 10px/1 var(--font-body); background: var(--primary-500); color: var(--green-600); padding: 3px 8px; border-radius: 999px; letter-spacing: 0.08em;">${ROUND_POINTS[r]} pt${ROUND_POINTS[r] > 1 ? 's' : ''} each</span>
        </h4>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px;">
          ${roundHtml}
        </div>
      </div>
    `);
  }

  $('#picksViewModal').classList.add('show');
}

function readOnlyMatchupCardHtml(series, picks) {
  const teams = possibleTeamsFor(series.id, picks, state.results);
  const pickedId = picks[series.id];
  const actual = state.results[series.id]?.winner;
  const confLabel = series.conf === 'E' ? 'East' : series.conf === 'W' ? 'West' : 'Finals';
  const rows = teams.map((teamId, i) => {
    if (!teamId) {
      return `
        <div class="matchup-row size-md empty" style="pointer-events: none;">
          <span class="logo-placeholder"></span>
          <span>TBD</span>
        </div>
      `;
    }
    const team = TEAMS[teamId];
    const isPicked = pickedId === teamId;
    const isActual = actual === teamId;
    const isOther = pickedId && pickedId !== teamId;
    const classes = ['matchup-row', 'size-md'];
    if (isPicked && actual && isActual) classes.push('picked', 'right');
    else if (isPicked && actual && !isActual) classes.push('picked', 'wrong');
    else if (isPicked) classes.push('picked');
    else if (isActual) classes.push('actual-not-picked');
    else if (isOther) classes.push('other-picked');
    const wonBadge = isActual ? (isPicked ? '<span class="won-badge">✓</span>' : '<span class="won-badge">WON</span>') : '';
    return `
      <div class="${classes.join(' ')}" style="pointer-events: none;">
        <span class="seed">${team.seed}</span>
        <img class="team-logo" src="${LOGO_URL(teamId)}" alt="${team.name}" loading="lazy" onerror="this.style.display='none'">
        <div class="team-text">
          <span class="team-name">${team.city} ${team.name}</span>
          <span class="team-record">${team.record}</span>
        </div>
        ${wonBadge}
      </div>
    `;
  }).join('');
  return `
    <div class="matchup-card">
      <div style="padding: 6px 10px 0; display: flex; justify-content: space-between; align-items: center;">
        <span style="font: 600 9px/1 var(--font-code); color: var(--text-caption); letter-spacing: 1px;">${confLabel} · ${series.id}</span>
      </div>
      ${rows}
    </div>
  `;
}

function closePicksViewModal() { $('#picksViewModal').classList.remove('show'); }

function openLinkModal({ title, lead, url }) {
  $('#linkModalTitle').innerHTML = title;
  $('#linkModalLead').innerHTML = lead;
  $('#linkBox').textContent = url;
  $('#linkModal').classList.add('show');
}
function closeLinkModal() { $('#linkModal').classList.remove('show'); }

// ===== Save flow =====
// Click main Save button: if registered → push updates; else prompt for name.
// Actual registration happens in the modal's startPicksBtn handler.
async function save() {
  const errEl = $('#saveErrorMain');
  errEl.hidden = true;
  const saveBtn = $('#saveBtnMain');
  const tbVal = $('#tiebreakerInput').value;
  const tiebreaker = tbVal === '' ? null : +tbVal;
  state.tiebreaker = tiebreaker;
  saveLocalPicks();

  if (state.locked) return;

  if (!state.user?.editKey) {
    // Not registered yet — open the name modal. The modal handler (below) calls registerFromModal.
    openJoinModal();
    return;
  }

  // Registered user — update their bracket on the server.
  saveBtn.innerHTML = '<span class="spinner"></span> Saving...';
  saveBtn.disabled = true;
  try {
    await api('api/user/' + encodeURIComponent(state.user.editKey) + '/picks', {
      method: 'POST',
      body: JSON.stringify({ picks: state.picks, tiebreaker })
    });
    await loadState();
    render();
    state.dirty = false;
    toast('Bracket saved · see how you rank', 'success');
    if (Object.keys(state.picks).length === 15) celebrate();
    setTab('leaderboard');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
  } finally {
    saveBtn.disabled = false;
    renderSidePanel();
  }
}

// Called from the modal's "Save my bracket →" button. Registers a new user
// with the name + current picks, then auto-navigates to the leaderboard.
async function registerFromModal() {
  const name = $('#nameInput').value.trim();
  $('#gateError').hidden = true;
  if (!name || name.length < 2) {
    $('#gateError').textContent = 'Enter a name at least 2 characters long';
    $('#gateError').hidden = false;
    return;
  }
  if (state.locked) {
    $('#gateError').textContent = 'Picks are locked — the playoffs already started.';
    $('#gateError').hidden = false;
    return;
  }
  const btn = $('#startPicksBtn');
  const prevLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving...';
  const tbVal = $('#tiebreakerInput').value;
  const tiebreaker = tbVal === '' ? null : +tbVal;
  try {
    const resp = await api('api/register', {
      method: 'POST',
      body: JSON.stringify({ name, picks: state.picks, tiebreaker })
    });
    state.user = { id: resp.userId, name: resp.name, editKey: resp.editKey };
    state.tiebreaker = tiebreaker;
    saveLocalUser(state.user);
    closeJoinModal();
    await loadState();
    render();
    setTab('leaderboard');
    const url = `${location.origin}${location.pathname}?k=${resp.editKey}`;
    const complete = Object.keys(state.picks).length === 15;
    openLinkModal({
      title: complete ? '🎉 You’re on the board!' : '💾 Progress saved',
      lead: complete
        ? 'Your bracket is saved. <strong>Copy this private link</strong> so you can edit picks before the playoffs tip off.'
        : 'Saved so far. <strong>Copy this private link</strong> so you can come back and finish your bracket before lock.',
      url
    });
    if (complete) celebrate();
  } catch (e) {
    $('#gateError').textContent = e.message;
    $('#gateError').hidden = false;
  } finally {
    btn.disabled = false;
    btn.innerHTML = prevLabel;
  }
}

async function loadViaEditKey() {
  const raw = $('#editKeyInput').value.trim();
  if (!raw) return;
  let key = raw;
  try {
    const u = new URL(raw);
    key = u.searchParams.get('k') || raw;
  } catch {}
  try {
    const user = await api('api/user/' + encodeURIComponent(key));
    state.user = { id: user.id, name: user.name, editKey: key };
    state.picks = { ...user.picks };
    state.tiebreaker = user.tiebreaker;
    saveLocalUser(state.user);
    saveLocalPicks();
    closeJoinModal();
    render();
    toast('Welcome back, ' + user.name, 'success');
  } catch (e) {
    $('#gateError').textContent = 'Invalid key or user not found';
    $('#gateError').hidden = false;
  }
}

function copyEditLink() {
  if (!state.user) return;
  const url = `${location.origin}${location.pathname}?k=${state.user.editKey}`;
  navigator.clipboard.writeText(url).then(
    () => toast('Link copied — save it somewhere safe!', 'success'),
    () => toast('Copy failed — ' + url, 'error')
  );
}

// ===== Render orchestrator =====
function render() {
  renderBracket();
  renderSidePanel();
  if (state.activeTab === 'leaderboard') renderLeaderboard();
}

// ===== Toast + confetti =====
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast ' + type; }, 2800);
}

function celebrate() {
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const colors = ['#ADEE20', '#3AD0D1', '#F88B25', '#7035C4', '#FAF14D', '#E74B3C'];
  const pieces = Array.from({ length: 160 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    vx: (Math.random() - 0.5) * 6,
    vy: 3 + Math.random() * 5,
    w: 6 + Math.random() * 6,
    h: 10 + Math.random() * 8,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)]
  }));
  let frames = 0;
  (function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.1; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    frames++;
    if (frames < 180) requestAnimationFrame(animate);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

// ===== Wire up =====
$$('.nav-item[data-tab]').forEach(el => {
  el.addEventListener('click', () => setTab(el.dataset.tab));
});
$$('[data-tab]').forEach(el => {
  if (!el.classList.contains('nav-item')) {
    el.addEventListener('click', () => setTab(el.dataset.tab));
  }
});

$('#joinBtn').addEventListener('click', openJoinModal);
$('#closeModalBtn').addEventListener('click', closeJoinModal);
$('#joinModal').addEventListener('click', (e) => { if (e.target.id === 'joinModal') closeJoinModal(); });
$('#startPicksBtn').addEventListener('click', registerFromModal);
$('#loadEditBtn').addEventListener('click', loadViaEditKey);
$('#editKeyInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') loadViaEditKey(); });
$('#nameInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') $('#startPicksBtn').click(); });

$('#linkCopyBtn').addEventListener('click', copyEditLink);
$('#linkCloseBtn').addEventListener('click', closeLinkModal);
$('#linkModal').addEventListener('click', (e) => { if (e.target.id === 'linkModal') closeLinkModal(); });
$('#copyLinkBtn').addEventListener('click', copyEditLink);

$('#picksViewClose').addEventListener('click', closePicksViewModal);
$('#picksViewModal').addEventListener('click', (e) => { if (e.target.id === 'picksViewModal') closePicksViewModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePicksViewModal();
    closeLinkModal();
    closeJoinModal();
  }
});

$('#saveBtnMain').addEventListener('click', save);
$('#chalkBtn').addEventListener('click', chalkPicks);
$('#resetBtn').addEventListener('click', resetBracket);
$('#tiebreakerInput').addEventListener('input', () => {
  const v = $('#tiebreakerInput').value;
  state.tiebreaker = v === '' ? null : +v;
  saveLocalPicks();
});

// Periodically refresh state so leaderboard picks up new picks/results
setInterval(async () => {
  await loadState();
  if (state.activeTab === 'leaderboard') renderLeaderboard();
  renderSidePanel();
}, 30000);

// ===== Init =====
async function init() {
  // Load draft from localStorage first (for returning anonymous visitors)
  const draft = loadLocalPicks();
  if (draft) {
    state.picks = draft.picks || {};
    state.tiebreaker = draft.tiebreaker ?? null;
  }

  render(); // paint the bracket shell immediately from local state

  await hydrateUser(); // overrides with server data if we have an edit key
  await loadState();
  render();
}

init();
