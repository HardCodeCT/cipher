// ═══════════════════════════════════════════════════════════════════════════
// Inject page-world WS interceptor + Google Font
// ═══════════════════════════════════════════════════════════════════════════
(function bootstrap() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);

  const f = document.createElement('link');
  f.rel  = 'stylesheet';
  f.href = 'https://fonts.googleapis.com/css2?family=Afacad+Flux:wght@500&display=swap';
  (document.head || document.documentElement).appendChild(f);
})();

// ═══════════════════════════════════════════════════════════════════════════
// Variants config
// ═══════════════════════════════════════════════════════════════════════════
const VARIANTS = [
  { id: 'standard',      label: 'Standard',        abbr: 'STD', nnue: 'nn-46832cfbead3.nnue'          },
  { id: 'chess960',      label: 'Chess 960',        abbr: '960', nnue: 'nn-46832cfbead3.nnue'          },
  { id: 'crazyhouse',    label: 'Crazyhouse',       abbr: 'CRZ', nnue: 'crazyhouse-8ebf84784ad2.nnue'  },
  { id: 'antichess',     label: 'Antichess',        abbr: 'ANT', nnue: 'antichess-689c016df8e0.nnue'   },
  { id: 'atomic',        label: 'Atomic',           abbr: 'ATM', nnue: 'atomic-2cf13ff256cc.nnue'      },
  { id: 'kingofthehill', label: 'King of the Hill', abbr: 'KOH', nnue: 'kingofthehill-978b86d0e6a4.nnue'},
  { id: '3check',        label: 'Three-Check',      abbr: '3CK', nnue: '3check-313cc226a173.nnue'      },
  { id: 'horde',         label: 'Horde',            abbr: 'HRD', nnue: 'nn-46832cfbead3.nnue'          },
  { id: 'racingkings',   label: 'Racing Kings',     abbr: 'RCK', nnue: 'nn-46832cfbead3.nnue'          },
];

function variantById(id) { return VARIANTS.find(v => v.id === id) || VARIANTS[0]; }

// ═══════════════════════════════════════════════════════════════════════════
// Move + session state
// ═══════════════════════════════════════════════════════════════════════════
let movestray    = [];
let currentUrl   = location.href;
let autoMode     = false;
let moveTimeSec  = 0.3;
let activeVariant = VARIANTS[0];

let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    chrome.storage.local.set({ cipher_session: { url: currentUrl, moves: [...movestray] } });
  }, 250);
}

function tryIngestMove(payload) {
  if (!payload || payload[0] !== '{') return;
  try {
    const msg = JSON.parse(payload);
    if (msg.t !== 'move' || !msg.d?.uci || !msg.v) return;
    movestray[msg.v - 1] = msg.d.uci;
    movestray = movestray.filter(Boolean);
    scheduleSave();
    updateMoveCount();
    if (autoMode && engineReady) {
      cardMoveEl.textContent = '…';
      cardMoveEl.style.color = '#93c5fd';
      sendToEngine([...movestray]);
    }
  } catch (_) {}
}

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;
  if (!chrome.runtime?.id) return;
  if (event.data.__wsNavigation) { setTimeout(() => onUrlChange(event.data.url), 0); return; }
  if (!event.data.__cipher) return;
  if (event.data.direction === 'RECEIVED') tryIngestMove(event.data.payload);
  setTimeout(() => {
    try {
      if (!confirmed) buffer.push(event.data);
      else chrome.runtime.sendMessage({ type: 'WS_MESSAGE', data: event.data });
    } catch (e) { if (e.message?.includes('Extension context invalidated')) return; }
  }, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Engine connection
// ═══════════════════════════════════════════════════════════════════════════
let confirmed   = false;
let capturing   = false;
let buffer      = [];
let playerColor = null;
let engineWs    = null;
let engineReady = false;

function connectEngine() {
  try { engineWs = new WebSocket('ws://localhost:8765'); }
  catch (_) { setTimeout(connectEngine, 3000); return; }
  engineWs.onopen    = () => { engineReady = true; };
  engineWs.onclose   = () => { engineReady = false; setTimeout(connectEngine, 3000); };
  engineWs.onerror   = () => engineWs.close();
  engineWs.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'bestmove') showBestMove(msg.from, msg.to);
    } catch (_) {}
  };
}

function sendToEngine(moves) {
  if (!engineReady || !moves.length) return;
  const movetime = Math.round(moveTimeSec * 1000);
  engineWs.send(JSON.stringify({
    type: 'analyze',
    moves,
    variant: activeVariant.id,
    nnue:    activeVariant.nnue,
    movetime,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Storage helpers
// ═══════════════════════════════════════════════════════════════════════════
function loadPersistedMoves(url, cb) {
  chrome.storage.local.get('cipher_session', (r) => {
    const s = r.cipher_session;
    if (s && s.url === url && Array.isArray(s.moves) && s.moves.length) {
      movestray = [...s.moves]; updateMoveCount(); cb(true);
    } else cb(false);
  });
}

function switchSession(newUrl) {
  chrome.storage.local.get('cipher_session', (r) => {
    const s = r.cipher_session;
    if (s && s.url === newUrl && Array.isArray(s.moves) && s.moves.length) {
      movestray = [...s.moves];
    } else { movestray = []; chrome.storage.local.remove('cipher_session'); }
    updateMoveCount(); showBestMove(null, null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CARD UI  — all dimensions in rem
// ═══════════════════════════════════════════════════════════════════════════
const FONT    = "'Afacad Flux','Segoe UI',system-ui,sans-serif";
const BLUE    = '#1d4ed8';
const BLUE_DK = '#1e40af';

let cardEl         = null;
let cardMoveEl     = null;
let cardReqBtn     = null;
let cardAutoBtn    = null;
let cardCountEl    = null;
let cardTimeInput  = null;
let variantLabelEl = null;
let dropdownEl     = null;

function injectCard() {
  if (cardEl) return;

  // ── Root card ────────────────────────────────────────────────────────────
  cardEl = document.createElement('div');
  cardEl.id = '__cipher_card';
  Object.assign(cardEl.style, {
    position:    'fixed',
    top:         '4.5rem',
    right:       '0.875rem',
    zIndex:      '999999',
    width:       '7.75rem',
    background:  '#0f1117',
    border:      '1px solid #1e2235',
    borderRadius:'0',
    boxShadow:   '0 0.5rem 2rem rgba(0,0,0,.7)',
    fontFamily:  FONT,
    userSelect:  'none',
    overflow:    'visible',
  });

  // ── Drag handle ──────────────────────────────────────────────────────────
  const dragHandle = document.createElement('div');
  Object.assign(dragHandle.style, {
    height:     '0.375rem',
    background: '#0f1117',
    cursor:     'grab',
  });

  // ── Variant row ──────────────────────────────────────────────────────────
  const variantRow = document.createElement('div');
  Object.assign(variantRow.style, {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '0 0.5rem 0 0.5rem',
    height:         '1.375rem',
    borderBottom:   '1px solid #1a1d2e',
  });

  variantLabelEl = document.createElement('span');
  variantLabelEl.textContent = activeVariant.abbr;
  Object.assign(variantLabelEl.style, {
    fontSize:    '0.6rem',
    fontWeight:  '700',
    color:       '#60a5fa',
    letterSpacing:'0.06em',
    fontFamily:  FONT,
  });

  const variantBtn = document.createElement('button');
  variantBtn.innerHTML = '&#9662;';
  Object.assign(variantBtn.style, {
    background:  'transparent',
    border:      'none',
    color:       '#4b5563',
    fontSize:    '0.6rem',
    cursor:      'pointer',
    padding:     '0',
    lineHeight:  '1',
    fontFamily:  FONT,
    display:     'flex',
    alignItems:  'center',
  });
  variantBtn.title = 'Select variant';
  variantBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(); });

  variantRow.append(variantLabelEl, variantBtn);

  // ── Move display ─────────────────────────────────────────────────────────
  const moveBlock = document.createElement('div');
  Object.assign(moveBlock.style, { padding: '0.5rem 0.5rem 0.125rem', textAlign: 'center' });

  cardMoveEl = document.createElement('div');
  cardMoveEl.textContent = '—';
  Object.assign(cardMoveEl.style, {
    fontSize:      '1.125rem',
    fontWeight:    '700',
    color:         '#e2e8f0',
    letterSpacing: '0.12em',
    lineHeight:    '1',
    minHeight:     '1.375rem',
    fontFamily:    FONT,
  });
  moveBlock.appendChild(cardMoveEl);

  // ── Move count ────────────────────────────────────────────────────────────
  const countWrap = document.createElement('div');
  Object.assign(countWrap.style, { textAlign: 'center', padding: '0.125rem 0.5rem 0.25rem' });
  cardCountEl = document.createElement('span');
  cardCountEl.textContent = '0 moves';
  Object.assign(cardCountEl.style, {
    fontSize:   '0.5625rem',
    color:      '#ffffff',
    fontWeight: '500',
    fontFamily: FONT,
  });
  countWrap.appendChild(cardCountEl);

  // ── Think time row ────────────────────────────────────────────────────────
  const timeRow = document.createElement('div');
  Object.assign(timeRow.style, {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '0.3rem',
    padding:        '0.25rem 0.5rem 0.3125rem',
    borderTop:      '1px solid #1a1d2e',
  });

  const timeLabel = document.createElement('span');
  timeLabel.textContent = 'Think';
  Object.assign(timeLabel.style, { fontSize: '0.5625rem', color: '#6b7280', fontWeight: '500', fontFamily: FONT });

  cardTimeInput = document.createElement('input');
  cardTimeInput.type  = 'number';
  cardTimeInput.step  = '0.1';
  cardTimeInput.min   = '0.1';
  cardTimeInput.max   = '60';
  cardTimeInput.value = moveTimeSec;
  Object.assign(cardTimeInput.style, {
    width:        '2.75rem',
    background:   '#1a1d2e',
    border:       '1px solid #2a2d42',
    borderRadius: '0',
    color:        '#e2e8f0',
    fontSize:     '0.625rem',
    fontWeight:   '600',
    padding:      '0.1875rem 0.25rem',
    textAlign:    'center',
    outline:      'none',
    fontFamily:   FONT,
  });
  cardTimeInput.addEventListener('change', () => {
    let val = parseFloat(cardTimeInput.value);
    if (isNaN(val) || val < 0.1) val = 0.1;
    if (val > 60) val = 60;
    val = Math.round(val * 10) / 10;
    cardTimeInput.value = val;
    moveTimeSec = val;
    chrome.storage.sync.set({ cipher_movetime: val });
  });

  const secLabel = document.createElement('span');
  secLabel.textContent = 's';
  Object.assign(secLabel.style, { fontSize: '0.5625rem', color: '#6b7280', fontFamily: FONT });

  timeRow.append(timeLabel, cardTimeInput, secLabel);

  // ── Auto / Request buttons ────────────────────────────────────────────────
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex' });

  const btnBase = {
    flex:           '1',
    padding:        '0.375rem 0',
    fontSize:       '0.625rem',
    fontWeight:     '700',
    border:         'none',
    borderRadius:   '0',
    cursor:         'pointer',
    color:          '#ffffff',
    letterSpacing:  '0.04em',
    textAlign:      'center',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    transition:     'background .15s',
    fontFamily:     FONT,
  };

  cardAutoBtn = document.createElement('button');
  cardAutoBtn.textContent = 'AUTO';
  Object.assign(cardAutoBtn.style, { ...btnBase, background: '#1e293b', borderRight: '1px solid #1a1d2e' });

  cardReqBtn = document.createElement('button');
  cardReqBtn.textContent = 'REQUEST';
  Object.assign(cardReqBtn.style, { ...btnBase, background: BLUE });

  cardAutoBtn.addEventListener('mouseenter', () => { if (!autoMode) cardAutoBtn.style.background = '#263045'; });
  cardAutoBtn.addEventListener('mouseleave', () => { if (!autoMode) cardAutoBtn.style.background = '#1e293b'; });
  cardReqBtn.addEventListener('mouseenter',  () => { if (!autoMode) cardReqBtn.style.background  = BLUE_DK; });
  cardReqBtn.addEventListener('mouseleave',  () => { if (!autoMode) cardReqBtn.style.background  = BLUE; });

  cardAutoBtn.addEventListener('click', () => {
    autoMode = !autoMode;
    chrome.storage.sync.set({ cipher_auto: autoMode });
    applyModeStyle();
  });
  cardReqBtn.addEventListener('click', handleRequest);

  btnRow.append(cardAutoBtn, cardReqBtn);

  cardEl.append(dragHandle, variantRow, moveBlock, countWrap, timeRow, btnRow);
  document.documentElement.appendChild(cardEl);
  makeDraggable(cardEl, dragHandle);
  applyModeStyle();
}

// ═══════════════════════════════════════════════════════════════════════════
// Variant dropdown panel
// ═══════════════════════════════════════════════════════════════════════════
function buildDropdown() {
  if (dropdownEl) { dropdownEl.remove(); dropdownEl = null; return; }

  dropdownEl = document.createElement('div');
  Object.assign(dropdownEl.style, {
    position:    'fixed',
    zIndex:      '9999999',
    background:  '#0f1117',
    border:      '1px solid #2a2d42',
    borderRadius:'0',
    boxShadow:   '0 0.5rem 1.5rem rgba(0,0,0,.8)',
    overflow:    'hidden',
    minWidth:    '8.5rem',
    fontFamily:  FONT,
  });

  // Position left of card
  const rect = cardEl.getBoundingClientRect();
  dropdownEl.style.top   = rect.top + 'px';
  dropdownEl.style.left  = (rect.left - 8.5 * 16 - 4) + 'px';

  VARIANTS.forEach((v) => {
    const item = document.createElement('div');
    item.textContent = v.label;
    const isActive = v.id === activeVariant.id;
    Object.assign(item.style, {
      padding:    '0.45rem 0.75rem',
      fontSize:   '0.65rem',
      fontWeight: isActive ? '700' : '500',
      color:      isActive ? '#60a5fa' : '#9ca3af',
      cursor:     'pointer',
      letterSpacing: '0.03em',
      borderLeft: isActive ? '2px solid #1d4ed8' : '2px solid transparent',
      background: 'transparent',
      transition: 'background .1s, color .1s',
      fontFamily: FONT,
    });
    item.addEventListener('mouseenter', () => {
      if (v.id !== activeVariant.id) { item.style.background = '#1a1d2e'; item.style.color = '#e2e8f0'; }
    });
    item.addEventListener('mouseleave', () => {
      if (v.id !== activeVariant.id) { item.style.background = 'transparent'; item.style.color = '#9ca3af'; }
    });
    item.addEventListener('click', () => selectVariant(v));
    dropdownEl.appendChild(item);
  });

  document.documentElement.appendChild(dropdownEl);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeDropdown, { once: true });
  }, 0);
}

function closeDropdown() {
  if (dropdownEl) { dropdownEl.remove(); dropdownEl = null; }
}

function toggleDropdown() {
  if (dropdownEl) { closeDropdown(); } else { buildDropdown(); }
}

function selectVariant(v) {
  activeVariant = v;
  if (variantLabelEl) variantLabelEl.textContent = v.abbr;
  chrome.storage.sync.set({ cipher_variant: v.id });
  closeDropdown();
  showBestMove(null, null);
  movestray = [];
  chrome.storage.local.remove('cipher_session');
  updateMoveCount();
}

// ═══════════════════════════════════════════════════════════════════════════
// Card helpers
// ═══════════════════════════════════════════════════════════════════════════
function applyModeStyle() {
  if (!cardAutoBtn || !cardReqBtn) return;
  if (autoMode) {
    cardAutoBtn.style.background = BLUE;
    cardReqBtn.style.background  = '#1e293b';
  } else {
    cardAutoBtn.style.background = '#1e293b';
    cardReqBtn.style.background  = BLUE;
  }
}

function makeDraggable(el, handle) {
  let ox = 0, oy = 0, sx = 0, sy = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    handle.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  function onMove(e) {
    el.style.left  = (ox + e.clientX - sx) + 'px';
    el.style.top   = (oy + e.clientY - sy) + 'px';
    el.style.right = 'auto';
    if (dropdownEl) closeDropdown();
  }
  function onUp() {
    handle.style.cursor = 'grab';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

function showBestMove(from, to) {
  if (!cardMoveEl) return;
  if (!from && !to) {
    cardMoveEl.textContent = '—';
    cardMoveEl.style.color = '#e2e8f0';
  } else {
    cardMoveEl.textContent = `${from.toUpperCase()}→${to.toUpperCase()}`;
    cardMoveEl.style.color = '#60a5fa';
  }
  if (cardReqBtn && !autoMode) {
    cardReqBtn.textContent = 'REQUEST';
    cardReqBtn.disabled = false;
    Object.assign(cardReqBtn.style, { opacity: '1', cursor: 'pointer', background: BLUE });
  }
}

function updateMoveCount() {
  if (!cardCountEl) return;
  const n = movestray.length;
  cardCountEl.textContent = `${n} move${n !== 1 ? 's' : ''}`;
}

function handleRequest() {
  if (!engineReady)      { cardMoveEl.textContent = 'offline';  cardMoveEl.style.color = '#ef4444'; return; }
  if (!movestray.length) { cardMoveEl.textContent = 'no moves'; cardMoveEl.style.color = '#f59e0b'; return; }
  cardMoveEl.textContent = '…';
  cardMoveEl.style.color = '#93c5fd';
  cardReqBtn.disabled = true;
  Object.assign(cardReqBtn.style, { opacity: '.45', cursor: 'not-allowed' });
  sendToEngine([...movestray]);
}

// ═══════════════════════════════════════════════════════════════════════════
// URL change
// ═══════════════════════════════════════════════════════════════════════════
function onUrlChange(newUrl) {
  if (newUrl === currentUrl) return;
  currentUrl = newUrl; confirmed = false; capturing = false; buffer = []; playerColor = null;
  switchSession(newUrl);
  try { chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: newUrl }); } catch (_) {}
  if (newUrl.includes('lichess')) {
    chrome.storage.sync.get('wsUsername', ({ wsUsername }) => {
      if (wsUsername) runConfirmation(wsUsername);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Confirmation
// ═══════════════════════════════════════════════════════════════════════════
function getUsernamesOnPage() {
  return [...document.querySelectorAll('a.user-link')].map(el => el.innerText.trim().toLowerCase());
}

function waitForUsername(username, onFound, onTimeout) {
  const needle = username.toLowerCase();
  let attempts = 0, stopped = false;
  function check() {
    if (stopped) return;
    if (getUsernamesOnPage().includes(needle)) { stopped = true; onFound(); return; }
    if (++attempts >= 60) { stopped = true; onTimeout(); return; }
    setTimeout(check, 500);
  }
  setTimeout(check, 0);
}

function getOrientation() {
  const wrap = document.querySelector('.cg-wrap');
  if (!wrap) return null;
  if (wrap.className.includes('orientation-white')) return 'white';
  if (wrap.className.includes('orientation-black')) return 'black';
  return null;
}

function waitForOrientation(onFound, onTimeout) {
  let attempts = 0, stopped = false;
  function check() {
    if (stopped) return;
    const o = getOrientation();
    if (o) { stopped = true; onFound(o); return; }
    if (++attempts >= 60) { stopped = true; onTimeout(); return; }
    setTimeout(check, 500);
  }
  setTimeout(check, 0);
}

function runConfirmation(username) {
  let usernameOk = false, orientOk = false, userTimedOut = false;
  function tryConfirm() {
    if (confirmed || !usernameOk || !orientOk) return;
    confirmed = true; capturing = true;
    buffer.forEach(entry => { try { chrome.runtime.sendMessage({ type: 'WS_MESSAGE', data: entry }); } catch (_) {} });
    buffer = [];
    try { chrome.runtime.sendMessage({ type: 'CONFIRMED', color: playerColor, url: currentUrl }); } catch (_) {}
  }
  waitForUsername(username,
    () => { usernameOk = true; tryConfirm(); },
    () => { userTimedOut = true; buffer = []; try { chrome.runtime.sendMessage({ type: 'IDLE', reason: 'username_not_found' }); } catch (_) {} }
  );
  waitForOrientation(
    (color) => { playerColor = color; orientOk = true; tryConfirm(); },
    () => { if (!userTimedOut) { buffer = []; try { chrome.runtime.sendMessage({ type: 'IDLE', reason: 'orientation_not_found' }); } catch (_) {} } }
  );
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'usernameUpdated' && msg.username) {
    confirmed = false; capturing = false; buffer = []; playerColor = null;
    movestray = []; chrome.storage.local.remove('cipher_session');
    updateMoveCount(); showBestMove(null, null);
    runConfirmation(msg.username);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap — load all persisted state then build card
// ═══════════════════════════════════════════════════════════════════════════
(function init() {
  loadPersistedMoves(currentUrl, () => {});

  chrome.storage.sync.get(
    ['cipher_auto', 'cipher_movetime', 'cipher_variant'],
    ({ cipher_auto, cipher_movetime, cipher_variant }) => {
      autoMode      = !!cipher_auto;
      moveTimeSec   = (typeof cipher_movetime === 'number' && cipher_movetime >= 0.1) ? cipher_movetime : 0.3;
      activeVariant = variantById(cipher_variant);

      const boot = () => {
        injectCard();
        if (cardTimeInput) cardTimeInput.value = moveTimeSec;
        connectEngine();
        chrome.storage.sync.get('wsUsername', ({ wsUsername }) => {
          if (!wsUsername) { try { chrome.runtime.sendMessage({ type: 'IDLE', reason: 'no_username' }); } catch (_) {} return; }
          runConfirmation(wsUsername);
        });
      };

      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
      else boot();
    }
  );
})();
