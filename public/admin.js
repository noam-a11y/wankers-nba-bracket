let adminKey = sessionStorage.getItem('wankers_admin_key') || '';
let state = { locked: false, results: {}, users: [] };

const $ = (s) => document.querySelector(s);

async function adminApi(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function checkAuth() {
  try { await adminApi('/api/admin/check', { method: 'POST' }); return true; } catch { return false; }
}

async function loadData() {
  const [stateData, usersData] = await Promise.all([
    fetch('/api/state').then(r => r.json()),
    adminApi('/api/admin/users')
  ]);
  state.locked = stateData.locked;
  state.results = stateData.results;
  state.users = usersData.users;
  render();
}

function render() { renderSeriesList(); renderUsersList(); renderLockButton(); }

function renderLockButton() {
  const btn = $('#lockToggleBtn');
  btn.textContent = state.locked ? '🔓 Unlock picks' : '🔒 Lock picks';
}

function renderSeriesList() {
  const container = $('#seriesList');
  container.innerHTML = SERIES.map(s => {
    const teams = possibleTeamsFor(s.id, {}, state.results);
    const hasTeams = teams.every(Boolean);
    const result = state.results[s.id];
    const confLabel = s.conf === 'E' ? 'East' : s.conf === 'W' ? 'West' : 'Finals';
    const roundLabel = ROUND_NAMES[s.round];

    const matchupText = hasTeams
      ? `${TEAMS[teams[0]].city} ${TEAMS[teams[0]].name} vs ${TEAMS[teams[1]].city} ${TEAMS[teams[1]].name}`
      : 'Awaiting prior results';

    const optsHtml = hasTeams
      ? teams.map(t => `<option value="${t}" ${result?.winner === t ? 'selected' : ''}>${TEAMS[t].city} ${TEAMS[t].name}</option>`).join('')
      : '';

    return `
      <div class="admin-series-card">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="round-tag">${confLabel} · ${s.id}</span>
        </div>
        <div class="matchup-text">${matchupText}</div>
        <div class="matchup-sub">${roundLabel} · ${ROUND_POINTS[s.round]} pt${ROUND_POINTS[s.round] > 1 ? 's' : ''}</div>
        ${hasTeams ? `
          <div class="admin-row">
            <select id="sel-${s.id}">
              <option value="">Pick winner…</option>
              ${optsHtml}
            </select>
            <input type="number" id="games-${s.id}" min="4" max="7" placeholder="Gms" value="${result?.games || ''}">
            <button class="btn btn-primary" onclick="setResult('${s.id}')">Save</button>
          </div>
        ` : `<div style="font: var(--type-body-small); color: var(--text-caption); padding: 10px 0 0;">Complete earlier rounds first.</div>`}
        ${result ? `
          <div class="admin-result-set">
            <span>✓ Winner: <strong>${TEAMS[result.winner].city} ${TEAMS[result.winner].name}</strong>${result.games ? ` · ${result.games} games` : ''}</span>
            <button class="clear-btn" onclick="clearResult('${s.id}')">Clear</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderUsersList() {
  const container = $('#usersList');
  if (!state.users.length) {
    container.innerHTML = '<div style="padding: 32px; text-align: center; color: var(--text-caption); font: var(--type-body);">No registrations yet.</div>';
    return;
  }
  container.innerHTML = `
    <div class="admin-user-row header">
      <div>Name</div>
      <div>Edit key</div>
      <div>Tiebreaker</div>
      <div>Actions</div>
    </div>
    ${state.users.map(u => `
      <div class="admin-user-row">
        <div>
          <strong>${escapeHtml(u.name)}</strong>
          <div style="font: var(--type-body-small); color: var(--text-caption); margin-top: 2px;">Registered ${new Date(u.created_at).toLocaleString()}</div>
        </div>
        <div><code>${u.edit_key.substring(0, 16)}...</code></div>
        <div class="tb-val">${u.tiebreaker ?? '—'}</div>
        <div class="actions">
          <button onclick="copyUserLink('${u.edit_key}')">Copy link</button>
          <button class="danger" onclick="deleteUser(${u.id}, '${escapeHtml(u.name).replace(/'/g, '')}')">Delete</button>
        </div>
      </div>
    `).join('')}
  `;
}

window.setResult = async (seriesId) => {
  const winnerId = $('#sel-' + seriesId).value;
  const games = $('#games-' + seriesId).value;
  if (!winnerId) return toast('Pick a winner first', 'error');
  try {
    await adminApi('/api/admin/result', {
      method: 'POST',
      body: JSON.stringify({ seriesId, winnerId, games: games || null })
    });
    toast('Result saved', 'success');
    await loadData();
  } catch (e) { toast(e.message, 'error'); }
};

window.clearResult = async (seriesId) => {
  if (!confirm('Clear this result? This will reset downstream matchups.')) return;
  try {
    await adminApi('/api/admin/result/' + encodeURIComponent(seriesId), { method: 'DELETE' });
    toast('Result cleared', 'success');
    await loadData();
  } catch (e) { toast(e.message, 'error'); }
};

window.copyUserLink = (editKey) => {
  const url = `${location.origin}/?k=${editKey}`;
  navigator.clipboard.writeText(url);
  toast('Edit link copied', 'success');
};

window.deleteUser = async (id, name) => {
  if (!confirm(`Delete "${name}" and all their picks? This can't be undone.`)) return;
  try {
    await adminApi('/api/admin/user/' + id, { method: 'DELETE' });
    toast('User deleted', 'success');
    await loadData();
  } catch (e) { toast(e.message, 'error'); }
};

$('#lockToggleBtn').addEventListener('click', async () => {
  try {
    const res = await adminApi('/api/admin/lock', { method: 'POST', body: JSON.stringify({ locked: !state.locked }) });
    state.locked = res.locked;
    renderLockButton();
    toast(state.locked ? 'Picks locked 🔒' : 'Picks unlocked 🔓', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

$('#loginBtn').addEventListener('click', async () => {
  const key = $('#adminKeyInput').value.trim();
  $('#loginError').hidden = true;
  if (!key) return;
  adminKey = key;
  if (await checkAuth()) {
    sessionStorage.setItem('wankers_admin_key', key);
    $('#loginPanel').hidden = true;
    $('#adminPanel').hidden = false;
    await loadData();
  } else {
    $('#loginError').textContent = 'Wrong key';
    $('#loginError').hidden = false;
    adminKey = '';
  }
});

$('#adminKeyInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });

function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast ' + type; }, 2800);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

(async function init() {
  if (adminKey && await checkAuth()) {
    $('#loginPanel').hidden = true;
    $('#adminPanel').hidden = false;
    await loadData();
  }
})();
