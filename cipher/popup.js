/**
 * popup.js
 */

const moves      = [];
let gameResult   = null;
let autoScroll   = true;

const moveList   = document.getElementById('move-list');
const emptyEl    = document.getElementById('empty');
const countEl    = document.getElementById('move-count');
const statWhite  = document.getElementById('stat-white');
const statBlack  = document.getElementById('stat-black');
const resultEl   = document.getElementById('result');
const toastEl    = document.getElementById('toast');
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const usernameInput = document.getElementById('username-input');

// ── Username ──────────────────────────────────────────────────────────────────
chrome.storage.sync.get('wsUsername', ({ wsUsername }) => {
  if (wsUsername) {
    usernameInput.value = wsUsername;
    usernameInput.classList.add('saved');
  }
});

document.getElementById('save-btn').addEventListener('click', () => {
  const val = usernameInput.value.trim();
  if (!val) { showToast('Enter a username first', true); return; }
  chrome.storage.sync.set({ wsUsername: val }, () => {
    usernameInput.classList.add('saved');
    showToast('Username saved');
    chrome.tabs.query({ url: 'https://lichess.org/*' }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'usernameUpdated', username: val }).catch(() => {});
      });
    });
  });
});

usernameInput.addEventListener('input', () => usernameInput.classList.remove('saved'));
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('save-btn').click(); });

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(status, extra) {
  statusDot.className = 'status-dot ' + status;
  const labels = {
    capturing: `Capturing — playing as ${extra || '?'}`,
    idle:      extra === 'no_username'       ? 'Set your username above' :
               extra === 'username_not_found'? 'Username not found on page' :
               'Not on a game page',
    waiting:   'Waiting for confirmation…',
    new_game:  'New game detected',
  };
  statusText.textContent = labels[status] || status;
}

// ── Extract UCI ───────────────────────────────────────────────────────────────
function ingestMove(payload) {
  if (!payload || payload[0] !== '{') return;
  try {
    const msg = JSON.parse(payload);
    if (msg.t !== 'move' || !msg.d?.uci || !msg.v) return;

    const ply     = msg.v;
    const uci     = msg.d.uci;
    const isWhite = ply % 2 === 1;
    const rowIdx  = Math.floor((ply - 1) / 2);

    if (!moves[rowIdx]) moves[rowIdx] = { white: null, black: null };
    if (isWhite) moves[rowIdx].white = uci;
    else         moves[rowIdx].black = uci;

    renderRow(rowIdx);
    updateStats();
    if (autoScroll) moveList.scrollTop = moveList.scrollHeight;
  } catch (_) {}
}

function ingestResult(payload) {
  if (!payload || payload[0] !== '{') return;
  try {
    const msg = JSON.parse(payload);
    if (msg.t === 'endData' && msg.d) {
      const w = msg.d.winner;
      gameResult = !w ? '½–½' : w === 'white' ? '1–0' : '0–1';
      resultEl.textContent = gameResult;
    }
  } catch (_) {}
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderRow(i) {
  let row = moveList.querySelector(`[data-idx="${i}"]`);
  if (!row) { row = document.createElement('div'); row.className = 'move-row'; row.dataset.idx = i; }
  const w = moves[i].white || '';
  const b = moves[i].black || '';
  row.innerHTML = `
    <span class="move-num">${i + 1}.</span>
    <span class="move-cell white">${w}</span>
    <span class="move-cell black ${b ? '' : 'empty'}">${b || '…'}</span>
  `;
  if (!moveList.querySelector(`[data-idx="${i}"]`)) moveList.appendChild(row);
  emptyEl.style.display = 'none';
}

function updateStats() {
  const w = moves.filter(m => m.white).length;
  const b = moves.filter(m => m.black).length;
  countEl.textContent = `${w + b} moves`;
  statWhite.textContent = `White: ${w}`;
  statBlack.textContent = `Black: ${b}`;
}

function clearMoves() {
  moves.length = 0;
  gameResult   = null;
  resultEl.textContent = '';
  [...moveList.querySelectorAll('.move-row')].forEach(n => n.remove());
  emptyEl.style.display = '';
  updateStats();
}

// ── Load history ──────────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (res) => {
  if (!res?.messages) return;
  res.messages.forEach(m => { ingestResult(m.payload); ingestMove(m.payload); });
});

// ── Live updates ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WS_UPDATE') {
    ingestResult(msg.entry?.payload);
    ingestMove(msg.entry?.payload);
  }
  if (msg.type === 'STATUS') {
    setStatus(msg.status, msg.color || msg.reason);
    if (msg.status === 'new_game') clearMoves();
  }
  if (msg.type === 'CONFIRMED') setStatus('capturing', msg.color);
  if (msg.type === 'IDLE')      setStatus('idle', msg.reason);
});

// ── Clear ─────────────────────────────────────────────────────────────────────
document.getElementById('clear-btn').addEventListener('click', () => {
  clearMoves();
  chrome.runtime.sendMessage({ type: 'CLEAR' });
});

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className   = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.className = '', 2500);
}
