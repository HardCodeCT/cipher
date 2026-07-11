// Chess coaching extension that helps users improve pattern recognition, positional awareness, and move selection. Intended for casual games use only.
// ═══════════════════════════════════════════════════════════════════════════
// Platform detection — everything branches on this
// ═══════════════════════════════════════════════════════════════════════════
const PLATFORM = (() => {
  const host = location.hostname;
  if (host === 'lichess.org') return 'lichess';
  if (host === 'www.chess.com' || host === 'chess.com') return 'chesscom';
  return null;
})();

if (!PLATFORM) {
  throw new Error('[Cipher] Unsupported platform, halting.');
}

// ═══════════════════════════════════════════════════════════════════════════
// Inject Afacad Flux font into the page
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  const style = document.createElement('style');
  style.textContent = `@font-face {
    font-family: 'Afacad Flux';
    src: url('${chrome.runtime.getURL('fonts/AfacadFlux-Regular.woff2')}') format('woff2');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }`;
  (document.head || document.documentElement).appendChild(style);
})();

// Shorthand alias — resolves to random tokens (pro) or fixed strings (basic/notpaid)
const n = CipherNames;

// ═══════════════════════════════════════════════════════════════════════════
// Persistent port — keeps the service worker alive while this tab is open
// ═══════════════════════════════════════════════════════════════════════════
let _keepAlivePort = null;
let _keepAlivePingInterval = null;

function _openKeepAlivePort() {
  try {
    _keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });

    // Ping the SW every 25 s so it stays "active" (not just "connected")
    _keepAlivePingInterval = setInterval(() => {
      try {
        _keepAlivePort.postMessage({ type: 'ping' });
      } catch (_) {
        // Port already dead — disconnect handler will reconnect
      }
    }, 25_000);

    _keepAlivePort.onMessage.addListener((msg) => {
      // pong received — SW is alive, nothing else to do
    });

    _keepAlivePort.onDisconnect.addListener(() => {
      clearInterval(_keepAlivePingInterval);
      _keepAlivePingInterval = null;
      _keepAlivePort = null;
      setTimeout(_openKeepAlivePort, 1000);
    });
  } catch (_) {
    setTimeout(_openKeepAlivePort, 2000);
  }
}
_openKeepAlivePort();

// ═══════════════════════════════════════════════════════════════════════════
// Extra fingerprint signals
// ═══════════════════════════════════════════════════════════════════════════
let _gpuSignals = [];

// ===================== CACHE ENCODING =====================
// Keep _MV_ALPHA identical to background.js — both sides must match exactly.
const _MV_ALPHA = 'pQ3mZ8nRfKx2LtYgBhWvC6dEjA0uOsI4iT9qMwJeP7UlyNzVoD1FcXHkbS5rGa';

function moves(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const key = ((i * 31) + 17) % 127;
    bytes.push(str.charCodeAt(i) ^ key);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += _MV_ALPHA[(n >> 18) & 63];
    out += _MV_ALPHA[(n >> 12) & 63];
    out += _MV_ALPHA[(n >>  6) & 63];
    out += _MV_ALPHA[ n        & 63];
  }
  const len = str.length;
  out += _MV_ALPHA[(len >> 6) & 63] + _MV_ALPHA[len & 63];
  return out;
}

function moved(enc) {
  if (!enc || enc.length < 2) return null;
  const tailA = _MV_ALPHA.indexOf(enc[enc.length - 2]);
  const tailB = _MV_ALPHA.indexOf(enc[enc.length - 1]);
  if (tailA < 0 || tailB < 0) return null;
  const realLen = (tailA << 6) | tailB;
  const body = enc.slice(0, -2);
  const bytes = [];
  for (let i = 0; i < body.length; i += 4) {
    const a = _MV_ALPHA.indexOf(body[i]),   b = _MV_ALPHA.indexOf(body[i + 1]),
          c = _MV_ALPHA.indexOf(body[i + 2]), d = _MV_ALPHA.indexOf(body[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  let str = '';
  for (let i = 0; i < realLen; i++) {
    const key = ((i * 31) + 17) % 127;
    str += String.fromCharCode(bytes[i] ^ key);
  }
  return str;
}
// ===================== END CACHE ENCODING =====================

(async function collectFingerprintSignals() {
  const signals = [];
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        signals.push('glv:' + gl.getParameter(ext.UNMASKED_VENDOR_WEBGL));
      }
      const vp = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT);
      if (vp) signals.push('glp:' + vp.precision + ',' + vp.rangeMin + ',' + vp.rangeMax);
    }
  } catch (_) {}

  _gpuSignals = signals;
  try {
    chrome.runtime.sendMessage({ type: 'FINGERPRINT_SIGNALS', signals });
  } catch (_) {}
})();


// ═══════════════════════════════════════════════════════════════════════════
// Ad Session Gate + stealth game counting
// ═══════════════════════════════════════════════════════════════════════════
const AD_SESSION_MS = 30 * 60 * 1000;

let adSessionActive    = false;
let adSessionGrantedAt = 0;
let freeGamesPeriod    = false;
let adGateEl           = null;
let adSessionTimer     = null;
let adCountdownTimer   = null;
let adTimerLabelEl     = null;
let timerRow           = null;
let timerDisplay       = null;

let userPlan = 'notpaid';
let audioModeActive = false;

let gameCounted = false;

function adFormatRemaining(ms) {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function adStartSessionCountdown(grantedAt) {
  if (adSessionTimer)   clearTimeout(adSessionTimer);
  if (adCountdownTimer) clearInterval(adCountdownTimer);
  const expiresAt  = grantedAt + AD_SESSION_MS;
  const WARN_MS    = 5 * 60 * 1000;
  if (timerRow) timerRow.style.display = '';
  function tickTimer() {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      if (timerDisplay) timerDisplay.textContent = '00:00:00';
      if (timerRow) timerRow.style.background = '#b71c1c';
      return;
    }
    if (timerDisplay) timerDisplay.textContent = adFormatRemaining(remaining);
    if (timerRow) {
      timerRow.style.background = remaining <= WARN_MS ? '#b71c1c' : '#2e7d32';
    }
    if (adTimerLabelEl) adTimerLabelEl.textContent = adFormatRemaining(remaining);
  }
  tickTimer();
  adCountdownTimer = setInterval(tickTimer, 1000);
  const msLeft = expiresAt - Date.now();
  adSessionTimer = setTimeout(() => {
    adSessionActive    = false;
    adSessionGrantedAt = 0;
    if (adCountdownTimer) clearInterval(adCountdownTimer);
    adCountdownTimer = null;
    if (timerRow) timerRow.style.display = 'none';
    tearDownCipherCard();
    showAdGate(true);
  }, Math.max(0, msLeft));
}

function tearDownCipherCard() {
  if (cardEl)       { cardEl.remove();       cardEl = null; }
  if (pinnedCardEl) { pinnedCardEl.remove(); pinnedCardEl = null; }
  const overlay = document.getElementById(n.id('cipher_svg_overlay'));
  if (overlay) overlay.remove();
}

// ─── Audio mode ───────────────────────────────────────────────────────────────
function enterAudioMode() {
  if (audioModeActive) return;
  audioModeActive = true;
  chrome.storage.sync.set({ cipher_audio: true });

  tearDownCipherCard();
  if (adGateEl) { adGateEl.remove(); adGateEl = null; }
  if (engineStatusEl) { engineStatusEl.remove(); engineStatusEl = null; }

  if (adSessionTimer)   { clearTimeout(adSessionTimer);   adSessionTimer   = null; }
  if (adCountdownTimer) { clearInterval(adCountdownTimer); adCountdownTimer = null; }
}

function _speakMove(from, to) {
  if (!from || !to) return;
  const text = from.toUpperCase() + ' to ' + to.toUpperCase();
  try {
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate  = 1.1;
    utt.pitch = 1.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(utt);
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Enlarged Ad Gate Modal
// ═══════════════════════════════════════════════════════════════════════════
function showAdGate(expired) {
  if (adGateEl) return;
  const WALLET = '0xF18022fE8D3a432464B7740392e16793C41AD746';
  const X_URL  = 'https://x.com/Hard_Code_T';
  const G_FONT = "'Afacad Flux', 'Segoe UI', system-ui, sans-serif";

  adGateEl = document.createElement('div');
  adGateEl.id = n.id('cipher_ad_gate');
  Object.assign(adGateEl.style, {
    position:   'fixed',
    top:        '4rem',
    right:      '1rem',
    zIndex:     '999999',
    width:      '22rem',
    background: '#0f1117',
    border:     '1px solid #1e2235',
    boxShadow:  '0 1rem 3rem rgba(0,0,0,.9)',
    fontFamily: G_FONT,
    userSelect: 'none',
    overflowY:  'auto',
    maxHeight:  '90vh',
  });

  function showToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '1rem', left: '50%',
      transform: 'translateX(-50%)',
      background: '#00e5a0', color: '#0f1117',
      fontSize: '0.8rem', fontWeight: '700',
      padding: '0.35rem 1rem', borderRadius: '4px',
      whiteSpace: 'nowrap', zIndex: '9999999',
      pointerEvents: 'none', opacity: '0', transition: 'opacity .15s',
    });
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 1800);
  }

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: '0.5rem', padding: '1rem 1rem 0.8rem',
    borderBottom: '1px solid #1a1d2e', background: '#0f1117',
  });
  const logoSpan = document.createElement('span');
  logoSpan.textContent = 'CIPHER';
  Object.assign(logoSpan.style, { fontWeight: '800', fontSize: '1.1rem', letterSpacing: '0.14em', color: '#fff' });
  const dot = document.createElement('span');
  Object.assign(dot.style, { width: '10px', height: '10px', borderRadius: '50%', background: '#f59e0b', display: 'inline-block', flexShrink: '0' });
  header.append(dot, logoSpan);

  const body = document.createElement('div');
  Object.assign(body.style, { padding: '1.2rem 1.1rem 1.1rem', display: 'flex', flexDirection: 'column', gap: '1rem' });

  const titleEl = document.createElement('div');
  Object.assign(titleEl.style, { fontSize: '1.05rem', fontWeight: '700', color: '#fff', textAlign: 'center', letterSpacing: '0.04em' });
  titleEl.textContent = expired ? "Time's up! 😊" : 'Free Session';

  const msgEl = document.createElement('div');
  Object.assign(msgEl.style, { fontSize: '0.82rem', color: '#ffffff', lineHeight: '1.55', textAlign: 'center' });
  msgEl.textContent = expired
    ? 'Your 30-minute session has ended. Click the ad for 30 more minutes, or subscribe below.'
    : 'Click the ad site to unlock 30 minutes of free engine access, or subscribe below.';

  const ctaBtn = document.createElement('button');
  ctaBtn.textContent = '▶ Go Click Ad';
  Object.assign(ctaBtn.style, {
    width: '100%', padding: '0.75rem 0', background: '#f59e0b', border: 'none',
    color: '#0f1117', fontSize: '0.95rem', fontWeight: '800', letterSpacing: '0.06em',
    cursor: 'pointer', transition: 'background .15s', fontFamily: G_FONT, borderRadius: '3px',
  });
  ctaBtn.addEventListener('mouseenter', () => { ctaBtn.style.background = '#d97706'; });
  ctaBtn.addEventListener('mouseleave', () => { ctaBtn.style.background = '#f59e0b'; });
  ctaBtn.addEventListener('click', () => {
    try { chrome.runtime.sendMessage({ type: 'AD_OPEN_TAB' }); } catch (_) {}
    ctaBtn.textContent = '⏳ Waiting for your click…';
    ctaBtn.style.background = '#374151';
    ctaBtn.style.color = '#ffffff';
    ctaBtn.disabled = true;
  });

  const noteEl = document.createElement('div');
  noteEl.textContent = 'The site will open — click anywhere on it to confirm.';
  Object.assign(noteEl.style, { fontSize: '0.72rem', color: '#ffffff', textAlign: 'center', lineHeight: '1.5' });

  const divider = document.createElement('div');
  Object.assign(divider.style, { borderTop: '1px solid #1a1d2e' });

  const plansLabel = document.createElement('div');
  plansLabel.textContent = 'Subscribe to stop viewing ads';
  Object.assign(plansLabel.style, { fontSize: '0.78rem', color: '#fff', fontWeight: '600', textAlign: 'center', letterSpacing: '0.03em' });

  function makePlanCard(name, price, features, accentColor) {
    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#131620', border: '1px solid #2a2d42',
      borderRadius: '6px', padding: '0.9rem 1rem',
      display: 'flex', flexDirection: 'column', gap: '0.5rem',
    });
    const nameRow = document.createElement('div');
    Object.assign(nameRow.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between' });
    const nameEl = document.createElement('span');
    nameEl.textContent = name;
    Object.assign(nameEl.style, { fontSize: '0.82rem', fontWeight: '800', color: accentColor, letterSpacing: '0.06em', textTransform: 'uppercase' });
    const priceEl = document.createElement('span');
    priceEl.textContent = price + '/mo';
    Object.assign(priceEl.style, { fontSize: '1rem', fontWeight: '800', color: '#fff' });
    nameRow.append(nameEl, priceEl);
    const featList = document.createElement('div');
    Object.assign(featList.style, { display: 'flex', flexDirection: 'column', gap: '0.25rem' });
    features.forEach(f => {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.74rem', color: '#ffffff' });
      const tick = document.createElement('span');
      tick.textContent = '✓';
      Object.assign(tick.style, { color: accentColor, fontWeight: '700', flexShrink: '0' });
      const txt = document.createElement('span');
      txt.textContent = f;
      row.append(tick, txt);
      featList.appendChild(row);
    });
    card.append(nameRow, featList);
    return card;
  }

  const basicCard = makePlanCard(
    'Basic', '$39.99',
    ['No ads', 'Unlimited engine access', 'All variants', 'Audio mode', 'UI + engine[no stealth]'],
    '#00e5a0'
  );
  const proCard = makePlanCard(
    'Professional', '$119.99',
    ['Everything in Basic', 'Priority engine speed', 'Audio mode', 'Stealth[No detection]', 'VIP access'],
    '#f59e0b'
  );
  const eliteCard = makePlanCard(
    'Elite', '$299.99',
    ['Everything in Pro', 'Elite custom build', 'Direct Dev Access'],
    '#a78bfa'
  );

  const walletLabel = document.createElement('div');
  walletLabel.textContent = 'Pay via USDT (ERC-20)';
  Object.assign(walletLabel.style, { fontSize: '0.73rem', color: '#ffffff', textAlign: 'center', lineHeight: '1.5' });

  const walletRow = document.createElement('div');
  Object.assign(walletRow.style, {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    background: '#1a1d2e', border: '1px solid #2a2d42',
    padding: '0.5rem 0.6rem', borderRadius: '4px', overflow: 'hidden',
  });
  const walletScroll = document.createElement('div');
  walletScroll.textContent = WALLET;
  Object.assign(walletScroll.style, {
    flex: '1', fontSize: '0.75rem', color: '#ffffff',
    overflowX: 'auto', whiteSpace: 'nowrap',
    fontFamily: "'Courier New', monospace", letterSpacing: '0.03em',
    scrollbarWidth: 'none',
  });
  const walletCopyBtn = document.createElement('button');
  walletCopyBtn.title = 'Copy wallet address';
  walletCopyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  Object.assign(walletCopyBtn.style, {
    background: 'transparent', border: 'none', cursor: 'pointer', padding: '0',
    flexShrink: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
  });
  walletCopyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(WALLET).then(() => showToast('Wallet copied!')).catch(() => {});
  });
  walletRow.append(walletScroll, walletCopyBtn);

  const xRow = document.createElement('div');
  Object.assign(xRow.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' });
  const xLabel = document.createElement('span');
  xLabel.textContent = 'Send screenshot & ID - DM proof of payment to';
  Object.assign(xLabel.style, { fontSize: '0.72rem', color: '#ffffff' });
  const xBtn = document.createElement('button');
  xBtn.title = 'DM @Hard_Code_T on X';
  xBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="#ffffff"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.259 5.632 5.905-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  Object.assign(xBtn.style, {
    background: '#000', border: '1px solid #333', cursor: 'pointer',
    padding: '0.25rem 0.4rem', display: 'flex', alignItems: 'center',
    justifyContent: 'center', borderRadius: '3px', transition: 'background .15s',
  });
  xBtn.addEventListener('mouseenter', () => { xBtn.style.background = '#1a1a1a'; });
  xBtn.addEventListener('mouseleave', () => { xBtn.style.background = '#000'; });
  xBtn.addEventListener('click', () => { try { window.open(X_URL, '_blank'); } catch (_) {} });
  xRow.append(xLabel, xBtn);

  const userIdRow = document.createElement('div');
  Object.assign(userIdRow.style, {
    display: 'flex', alignItems: 'center', gap: '0.4rem',
    background: '#1a1d2e', border: '1px solid #2a2d42',
    padding: '0.45rem 0.6rem', borderRadius: '4px',
  });
  const userIdLabel = document.createElement('span');
  userIdLabel.textContent = 'ID:';
  Object.assign(userIdLabel.style, { fontSize: '0.72rem', color: '#ffffff', flexShrink: '0' });
  const userIdVal = document.createElement('span');
  userIdVal.textContent = '…';
  Object.assign(userIdVal.style, {
    flex: '1', fontSize: '0.72rem', color: '#ffffff',
    fontFamily: "'Courier New', monospace", overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  });
  try {
    chrome.runtime.sendMessage({ type: 'REQUEST_USER_ID' }, (res) => {
      userIdVal.textContent = res?.userId || 'generating…';
    });
  } catch (_) {}
  const idCopyBtn = document.createElement('button');
  idCopyBtn.title = 'Copy User ID';
  idCopyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  Object.assign(idCopyBtn.style, {
    background: 'transparent', border: 'none', cursor: 'pointer', padding: '0',
    flexShrink: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
  });
  idCopyBtn.addEventListener('click', () => {
    const uid = userIdVal.textContent;
    if (!uid || uid === '…' || uid === 'generating…') return;
    navigator.clipboard.writeText(uid).then(() => showToast('ID copied!')).catch(() => {});
  });
  userIdRow.append(userIdLabel, userIdVal, idCopyBtn);

  body.append(
    titleEl, msgEl,
    ctaBtn, noteEl,
    divider,
    plansLabel,
    basicCard,
    proCard,
    eliteCard,
    divider.cloneNode(),
    walletLabel,
    walletRow,
    xRow,
    userIdRow,
  );

  adGateEl.append(header, body);
  document.documentElement.appendChild(adGateEl);
}

function dismissAdGate() {
  if (adGateEl) { adGateEl.remove(); adGateEl = null; }
}

// ─── Audio unlock gate ────────────────────────────────────────────────────────
function showAudioGate() {
  if (document.getElementById(n.id('cipher_audio_gate'))) return;
  const WALLET = '0xF18022fE8D3a432464B7740392e16793C41AD746';
  const X_URL  = 'https://x.com/Hard_Code_T';
  const G_FONT = "'Afacad Flux', 'Segoe UI', system-ui, sans-serif";

  const gate = document.createElement('div');
  gate.id = n.id('cipher_audio_gate');
  Object.assign(gate.style, {
    position:   'fixed',
    top:        '4rem',
    right:      '1rem',
    zIndex:     '999999',
    width:      '22rem',
    background: '#0f1117',
    border:     '1px solid #1e2235',
    boxShadow:  '0 1rem 3rem rgba(0,0,0,.9)',
    fontFamily: G_FONT,
    userSelect: 'none',
    overflowY:  'auto',
    maxHeight:  '90vh',
  });

  function showGateToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '1rem', left: '50%',
      transform: 'translateX(-50%)',
      background: '#f59e0b', color: '#0f1117',
      fontSize: '0.8rem', fontWeight: '700',
      padding: '0.35rem 1rem', borderRadius: '4px',
      whiteSpace: 'nowrap', zIndex: '9999999',
      pointerEvents: 'none', opacity: '0', transition: 'opacity .15s',
    });
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 1800);
  }

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '1rem 1rem 0.8rem',
    borderBottom: '1px solid #1a1d2e', background: '#0f1117',
  });
  const logoRow = document.createElement('div');
  Object.assign(logoRow.style, { display: 'flex', alignItems: 'center', gap: '0.5rem' });
  const logoDot = document.createElement('span');
  Object.assign(logoDot.style, { width: '10px', height: '10px', borderRadius: '50%', background: '#f59e0b', display: 'inline-block', flexShrink: '0' });
  const logoSpan = document.createElement('span');
  logoSpan.textContent = 'CIPHER AUDIO';
  Object.assign(logoSpan.style, { fontWeight: '800', fontSize: '1.1rem', letterSpacing: '0.14em', color: '#fff' });
  logoRow.append(logoDot, logoSpan);
  const closeX = document.createElement('button');
  closeX.textContent = '✕';
  Object.assign(closeX.style, { background: 'transparent', border: 'none', color: '#ffffff', fontSize: '1rem', cursor: 'pointer', padding: '0', lineHeight: '1', fontFamily: G_FONT });
  closeX.addEventListener('click', () => gate.remove());
  header.append(logoRow, closeX);

  const body = document.createElement('div');
  Object.assign(body.style, { padding: '1.2rem 1.1rem 1.1rem', display: 'flex', flexDirection: 'column', gap: '1rem' });

  const titleEl = document.createElement('div');
  titleEl.textContent = 'Unlock Audio Mode';
  Object.assign(titleEl.style, { fontSize: '1.05rem', fontWeight: '700', color: '#fff', textAlign: 'center', letterSpacing: '0.04em' });

  const msgEl = document.createElement('div');
  msgEl.textContent = 'Audio mode speaks best moves aloud — available on Basic and Professional. Subscribe via USDT (ERC-20) and DM proof to unlock.';
  Object.assign(msgEl.style, { fontSize: '0.82rem', color: '#ffffff', lineHeight: '1.55', textAlign: 'center' });

  const plansContainer = document.createElement('div');
  Object.assign(plansContainer.style, { display: 'flex', flexDirection: 'column', gap: '0.75rem' });

  function audioPlanCard(name, price, features, accentColor) {
    const card = document.createElement('div');
    Object.assign(card.style, { background: '#131620', border: '1px solid #2a2d42', borderRadius: '6px', padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' });
    const nameRow = document.createElement('div');
    Object.assign(nameRow.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between' });
    const nameEl = document.createElement('span');
    nameEl.textContent = name;
    Object.assign(nameEl.style, { fontSize: '0.82rem', fontWeight: '800', color: accentColor, letterSpacing: '0.06em', textTransform: 'uppercase' });
    const priceEl = document.createElement('span');
    priceEl.textContent = price + '/mo';
    Object.assign(priceEl.style, { fontSize: '1rem', fontWeight: '800', color: '#fff' });
    nameRow.append(nameEl, priceEl);
    const featList = document.createElement('div');
    Object.assign(featList.style, { display: 'flex', flexDirection: 'column', gap: '0.25rem' });
    features.forEach((f) => {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.74rem', color: '#ffffff' });
      const tick = document.createElement('span');
      tick.textContent = '✓';
      Object.assign(tick.style, { color: accentColor, fontWeight: '700', flexShrink: '0' });
      const txt = document.createElement('span');
      txt.textContent = f;
      row.append(tick, txt);
      featList.appendChild(row);
    });
    card.append(nameRow, featList);
    return card;
  }

  const basicCard = audioPlanCard('Basic', '$39.99', ['Audio mode', 'No ads', 'Unlimited access', 'No stealth'], '#00e5a0');
  const proCard = audioPlanCard('Professional', '$119.99', ['Audio mode', 'No ads', 'Priority speed', 'Stealth', 'VIP access'], '#f59e0b');
  const eliteCard = audioPlanCard('Elite', '$299.99', ['Audio mode', 'Everything in Pro', 'Elite custom build', 'Direct Dev Access'], '#a78bfa');
  plansContainer.append(basicCard, proCard, eliteCard);

  const divider = document.createElement('div');
  Object.assign(divider.style, { borderTop: '1px solid #1a1d2e' });

  const walletLabel = document.createElement('div');
  walletLabel.textContent = 'Pay via USDT (ERC-20)';
  Object.assign(walletLabel.style, { fontSize: '0.73rem', color: '#ffffff', textAlign: 'center', lineHeight: '1.5' });

  const walletRow = document.createElement('div');
  Object.assign(walletRow.style, { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#1a1d2e', border: '1px solid #2a2d42', padding: '0.5rem 0.6rem', borderRadius: '4px', overflow: 'hidden' });
  const walletScroll = document.createElement('div');
  walletScroll.textContent = WALLET;
  Object.assign(walletScroll.style, { flex: '1', fontSize: '0.75rem', color: '#ffffff', overflowX: 'auto', whiteSpace: 'nowrap', fontFamily: "'Courier New', monospace", letterSpacing: '0.03em', scrollbarWidth: 'none' });
  const walletCopyBtn = document.createElement('button');
  walletCopyBtn.title = 'Copy wallet address';
  walletCopyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  Object.assign(walletCopyBtn.style, { background: 'transparent', border: 'none', cursor: 'pointer', padding: '0', flexShrink: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' });
  walletCopyBtn.addEventListener('click', () => { navigator.clipboard.writeText(WALLET).then(() => showGateToast('Wallet copied!')).catch(() => {}); });
  walletRow.append(walletScroll, walletCopyBtn);

  const xRow = document.createElement('div');
  Object.assign(xRow.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' });
  const xLabel = document.createElement('span');
  xLabel.textContent = 'Send screenshot & ID - DM proof of payment to';
  Object.assign(xLabel.style, { fontSize: '0.72rem', color: '#ffffff' });
  const xBtn = document.createElement('button');
  xBtn.title = 'DM @Hard_Code_T on X';
  xBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="#ffffff"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.259 5.632 5.905-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  Object.assign(xBtn.style, { background: '#000', border: '1px solid #333', cursor: 'pointer', padding: '0.25rem 0.4rem', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '3px', transition: 'background .15s' });
  xBtn.addEventListener('mouseenter', () => { xBtn.style.background = '#1a1a1a'; });
  xBtn.addEventListener('mouseleave', () => { xBtn.style.background = '#000'; });
  xBtn.addEventListener('click', () => { try { window.open(X_URL, '_blank'); } catch (_) {} });
  xRow.append(xLabel, xBtn);

  const userIdRow = document.createElement('div');
  Object.assign(userIdRow.style, { display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#1a1d2e', border: '1px solid #2a2d42', padding: '0.45rem 0.6rem', borderRadius: '4px' });
  const userIdLabel = document.createElement('span');
  userIdLabel.textContent = 'ID:';
  Object.assign(userIdLabel.style, { fontSize: '0.72rem', color: '#ffffff', flexShrink: '0' });
  const userIdVal = document.createElement('span');
  userIdVal.textContent = '…';
  Object.assign(userIdVal.style, { flex: '1', fontSize: '0.72rem', color: '#ffffff', fontFamily: "'Courier New', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
  try { chrome.runtime.sendMessage({ type: 'REQUEST_USER_ID' }, (res) => { userIdVal.textContent = res?.userId || 'generating…'; }); } catch (_) {}
  const idCopyBtn = document.createElement('button');
  idCopyBtn.title = 'Copy User ID';
  idCopyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  Object.assign(idCopyBtn.style, { background: 'transparent', border: 'none', cursor: 'pointer', padding: '0', flexShrink: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' });
  idCopyBtn.addEventListener('click', () => {
    const uid = userIdVal.textContent;
    if (!uid || uid === '…' || uid === 'generating…') return;
    navigator.clipboard.writeText(uid).then(() => showGateToast('ID copied!')).catch(() => {});
  });
  userIdRow.append(userIdLabel, userIdVal, idCopyBtn);

  body.append(titleEl, msgEl, plansContainer, divider, walletLabel, walletRow, xRow, userIdRow);
  gate.append(header, body);
  document.documentElement.appendChild(gate);
}

// ─── Helper: flush accumulated moves to engine when conditions are met ────────
function _flushMovesIfReady() {
  if (autoMode && engineReady && deviceDataReady && movestray.length &&
      (audioModeActive || adSessionActive || freeGamesPeriod)) {
    setMoveDisplay('...', '#93c5fd');
    sendToEngine([...movestray]);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AD_SESSION_GRANTED') {
    if (adCountdownTimer && adSessionGrantedAt === msg.grantedAt) {
      return;
    }
    adSessionActive    = true;
    adSessionGrantedAt = msg.grantedAt;
    dismissAdGate();
    if (timerRow) timerRow.style.display = '';
    if (cardEl) {
      adStartSessionCountdown(adSessionGrantedAt);
      _flushMovesIfReady();
    }
    if (!cardEl) {
      whenEngineReady(() => {
        if (cardEl) return;
        chrome.storage.sync.get(
          ['cipher_auto', 'cipher_movetime', 'cipher_elo', 'cipher_variant', 'cipher_pinned', 'cipher_show_overlay', 'cipher_rated_acknowledged'],
          ({ cipher_auto, cipher_movetime, cipher_elo, cipher_variant, cipher_pinned, cipher_show_overlay, cipher_rated_acknowledged }) => {
            autoMode          = (cipher_auto === undefined) ? true : !!cipher_auto;
            moveTimeSec       = (typeof cipher_movetime === 'number' && cipher_movetime >= 0.01) ? cipher_movetime : 0.3;
              engineElo         = (typeof cipher_elo === 'number' && cipher_elo >= 500) ? cipher_elo : 2200;
            activeVariant     = variantById(cipher_variant);
            ratedAcknowledged = !!cipher_rated_acknowledged;
            _syncRatedApprovalFromFirebase(ratedAcknowledged);
            const showOverlay = (cipher_show_overlay === undefined) ? true : !!cipher_show_overlay;
            injectCard();
            updateMoveCount();
            if (cipher_pinned) activatePin();
            if (PLATFORM === 'lichess') getBoardOffsets();
            if (timerRow) {
              timerRow.style.display = '';
              adStartSessionCountdown(adSessionGrantedAt);
            }
            if (showBtn) {
              showBtn.dataset.active   = showOverlay ? 'true' : 'false';
              showBtn.style.background = showOverlay ? '#00e5a0' : '#3d4460';
              showKnob.style.left      = showOverlay ? '1.35rem' : '0.2rem';
            }
            if (!showOverlay) {
              const overlay = document.getElementById(n.id('cipher_svg_overlay'));
              if (overlay) overlay.style.display = 'none';
            }
            if (ratedAcknowledged && ratedBtn) {
              ratedBtn.dataset.active   = 'true';
              ratedBtn.style.background = '#00e5a0';
              ratedKnob.style.left      = '1.35rem';
            }
            if (PLATFORM === 'chesscom' && !cc_boardElem) {
              const poll = setInterval(() => {
                if (!cc_boardElem) cc_init();
                else clearInterval(poll);
              }, 100);
            }
            _flushMovesIfReady();
          }
        );
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Inject page-world WS interceptor (Lichess only)
// ═══════════════════════════════════════════════════════════════════════════
if (PLATFORM === 'lichess') {
  (function bootstrap() {
    if (!chrome.runtime?.id) return;
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.onload = () => s.remove();
    s.onerror = () => {};
    (document.head || document.documentElement).appendChild(s);
  })();
}

// ═══════════════════════════════════════════════════════════════════════════
// Variants config
// ═══════════════════════════════════════════════════════════════════════════
const VARIANTS = [
  { id: 'standard',      label: 'Standard',        abbr: 'STD', nnue: 'nn-46832cfbead3.nnue'            },
  { id: 'antichess',     label: 'Antichess',        abbr: 'ANT', nnue: 'antichess-dd3cbe53cd4e.nnue',    gdrive: '1a6j61utWpCTADQ8k6BBqYMcKjJ5ESdbl' },
  { id: 'atomic',        label: 'Atomic',           abbr: 'ATM', nnue: 'atomic-2cf13ff256cc.nnue',       gdrive: '1bC7T3iDft8Kbuxlu3Vm2fERxk7cOSoDy' },
  { id: 'kingofthehill', label: 'King of the Hill', abbr: 'KOH', nnue: 'kingofthehill-978b86d0e6a4.nnue',gdrive: '1x25r_1PgB5XqttkfR494M4rseiIm0BAV' },
  { id: '3check',        label: 'Three-Check',      abbr: '3CK', nnue: '3check-cb5f517c228b.nnue',       gdrive: '1z5oUQbqiE0ZIoQ8Z64y2lF91Rz1rUoWP' },
  { id: 'horde',         label: 'Horde',            abbr: 'HRD', nnue: 'horde-28173ddccabe.nnue',        gdrive: '16BQztGqFIS1n_dYtmdfFVE2EexF-KagX' },
  { id: 'racingkings',   label: 'Racing Kings',     abbr: 'RCK', nnue: 'racingkings-636b95f085e3.nnue',  gdrive: '1Tiq8FqSu7eiekE2iaWQzSdJPg-mhvLzJ' },
];
function variantById(id) { return VARIANTS.find(v => v.id === id) || VARIANTS[0]; }

// ═══════════════════════════════════════════════════════════════════════════
// Move + session state
// ═══════════════════════════════════════════════════════════════════════════
let movestray     = [];
let _fmSnapshotGen = 0;   // bumped on URL change so a stale first-move retry loop can self-cancel
let _editorInputs = null;
let currentUrl    = location.href;
let autoMode      = true;
let moveTimeSec   = 0.3;
let engineElo     = 2200;
let activeVariant = VARIANTS[0];

// ─── Refresh-persistence ──────────────────────────────────────────────────────
const _PS_URL   = 'cipher_sess_url';
const _PS_MOVES = 'cipher_sess_moves';
let sessionReady = false; // true once _loadMoveSession has had its one chance to restore

function _saveMoveSession() {
  try {
    chrome.storage.session.set({ [_PS_URL]: location.href, [_PS_MOVES]: [...movestray] });
  } catch (_) {}
}

function _loadMoveSession(cb) {
  try {
    chrome.storage.session.get([_PS_URL, _PS_MOVES], (res) => {
      if (!chrome.runtime.lastError
          && res[_PS_URL] === location.href
          && Array.isArray(res[_PS_MOVES])
          && res[_PS_MOVES].length) {
        movestray = res[_PS_MOVES];
      }
      sessionReady = true;
      cb();
    });
  } catch (_) { sessionReady = true; cb(); }
}
// ─────────────────────────────────────────────────────────────────────────────

const LICHESS_CASTLE_MAP = {
  'e1h1': 'e1g1',
  'e1a1': 'e1c1',
  'e8h8': 'e8g8',
  'e8a8': 'e8c8',
};
function lichessTranslateCastle(uci) { return LICHESS_CASTLE_MAP[uci] || uci; }

function tryIngestMove(payload) {
  if (!payload || payload[0] !== '{') return;
  try {
    const msg = JSON.parse(payload);
    if (msg.t !== 'move' || !msg.d?.uci || !msg.v) return;
    let uci = lichessTranslateCastle(msg.d.uci);
    const promoMatch = msg.d.san?.match(/=([QRBN])/);
    if (promoMatch) uci += promoMatch[1].toLowerCase();
    movestray[msg.v - 1] = uci;
    movestray = movestray.filter(Boolean);

    updateMoveCount();

    if (movestray.length === 1 && !gameCounted) {
      gameCounted = true;
      chrome.runtime.sendMessage({ type: 'GAME_PLAYED' }, (resp) => {});
    }

    if (autoMode && engineReady && deviceDataReady && (audioModeActive || adSessionActive || freeGamesPeriod)) {
      setMoveDisplay('...', '#93c5fd');
      sendToEngine([...movestray]);
    }
  } catch (_) {}
}

if (PLATFORM === 'lichess') {
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
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// Lichess first-move recovery — DOM snapshot (replaces MutationObserver net)
// ═══════════════════════════════════════════════════════════════════════════
// By the time the extension loads the board DOM is already settled, so a
// MutationObserver fires too late (or never) for the very first move when
// playing as Black.  Instead we snapshot the `last-move` highlight squares
// directly from the already-rendered DOM — one synchronous read, zero
// observers, zero race conditions.
//
// For Black the board is flipped: files run h→a (right to left) and ranks
// run 1→8 (top to bottom), so we must invert the pixel-to-square mapping.
// We calibrate pixel positions from the pieces' own transform styles so the
// result is correct at any board size.
//
// The snapshot runs inside queueMicrotask so it is off the call stack and
// cannot block the WS interceptor or any synchronous boot path, but it still
// executes before the next paint — effectively instant.
// ═══════════════════════════════════════════════════════════════════════════
if (PLATFORM === 'lichess') {
  (function _blackFirstMoveSnapshot() {

    // ── Core snapshot logic — user-supplied LreconciliationsBlack algorithm ─
    function _readBlackFirstMove() {
      // 1. Must be Black's perspective
      const wrap = document.querySelector('.cg-wrap') || document.querySelector('div[class*="cg-wrap"]');
      if (!wrap) {
        return null;
      }
      if (wrap.classList.contains('orientation-white')) {
        _stopRetrying = true;
        return null;
      }
      if (!wrap.classList.contains('orientation-black')) {
        return null;
      }

      // 2. Initial placeholders (will be calibrated)
      let d1 = ["0","68","132","198","264","330","396","462"];
      let d2 = ["462","396","330","264","198","132","68","0"];

      // 3. Build coordinate dictionaries a1..h8
      const a={a1:[d1[0],d2[0]],a2:[d1[0],d2[1]],a3:[d1[0],d2[2]],a4:[d1[0],d2[3]],a5:[d1[0],d2[4]],a6:[d1[0],d2[5]],a7:[d1[0],d2[6]],a8:[d1[0],d2[7]]};
      const b={b1:[d1[1],d2[0]],b2:[d1[1],d2[1]],b3:[d1[1],d2[2]],b4:[d1[1],d2[3]],b5:[d1[1],d2[4]],b6:[d1[1],d2[5]],b7:[d1[1],d2[6]],b8:[d1[1],d2[7]]};
      const c={c1:[d1[2],d2[0]],c2:[d1[2],d2[1]],c3:[d1[2],d2[2]],c4:[d1[2],d2[3]],c5:[d1[2],d2[4]],c6:[d1[2],d2[5]],c7:[d1[2],d2[6]],c8:[d1[2],d2[7]]};
      const d={d1:[d1[3],d2[0]],d2:[d1[3],d2[1]],d3:[d1[3],d2[2]],d4:[d1[3],d2[3]],d5:[d1[3],d2[4]],d6:[d1[3],d2[5]],d7:[d1[3],d2[6]],d8:[d1[3],d2[7]]};
      const e={e1:[d1[4],d2[0]],e2:[d1[4],d2[1]],e3:[d1[4],d2[2]],e4:[d1[4],d2[3]],e5:[d1[4],d2[4]],e6:[d1[4],d2[5]],e7:[d1[4],d2[6]],e8:[d1[4],d2[7]]};
      const f={f1:[d1[5],d2[0]],f2:[d1[5],d2[1]],f3:[d1[5],d2[2]],f4:[d1[5],d2[3]],f5:[d1[5],d2[4]],f6:[d1[5],d2[5]],f7:[d1[5],d2[6]],f8:[d1[5],d2[7]]};
      const g={g1:[d1[6],d2[0]],g2:[d1[6],d2[1]],g3:[d1[6],d2[2]],g4:[d1[6],d2[3]],g5:[d1[6],d2[4]],g6:[d1[6],d2[5]],g7:[d1[6],d2[6]],g8:[d1[6],d2[7]]};
      const h={h1:[d1[7],d2[0]],h2:[d1[7],d2[1]],h3:[d1[7],d2[2]],h4:[d1[7],d2[3]],h5:[d1[7],d2[4]],h6:[d1[7],d2[5]],h7:[d1[7],d2[6]],h8:[d1[7],d2[7]]};

      const dictx = [a,b,c,d,e,f,g,h];

      // 4. Calibrate d1/d2 from pawn transforms
      const pawns = document.querySelectorAll('piece.pawn');
      if (pawns.length < 8) {
        return null;
      }

      let data_key = 7;
      for (let i=0; i<pawns.length && data_key>=0; i++) {
        const style = pawns[i].getAttribute('style');
        if (style) {
          const matches = style.match(/[-+]?\d*\.?\d+/g);
          if (matches && matches.length >= 2) {
            d1[data_key] = matches[0];
            d2[data_key] = matches[0];
            data_key--;
          }
        }
      }

      // 5. Flip dictx for Black perspective (reverse files and ranks)
      let ii = 7;
      for (const dicts of dictx) {
        let q = 0;
        for (const key in dicts) {
          const val = dicts[key];
          val[0] = d1[ii];   // x = file (right->left)
          val[1] = d2[q];    // y = rank (top->bottom)
          q++;
        }
        ii--;
      }

      // 6. Build reverse lookup: coordinate string -> square name
      const coordToSquare = {};
      for (let idx=0; idx<8; idx++) {
        const dict = dictx[idx];
        for (const square in dict) {
          const coords = dict[square];
          const key = coords[0] + ',' + coords[1];
          coordToSquare[key] = square;
        }
      }

      // 7. Retrieve last-move squares (origin and destination)
      const squares = document.querySelectorAll('square.last-move');
      if (squares.length < 2) {
        return null;
      }

      const names = [];
      for (const sq of squares) {
        const style = sq.getAttribute('style');
        if (!style) {
          return null;
        }
        const m = style.match(/translate\(([\d.]+)px,\s*([\d.]+)px\)/);
        if (!m) {
          return null;
        }
        const key = m[1] + ',' + m[2];
        const squareName = coordToSquare[key];
        if (!squareName) {
          return null;
        }
        names.push(squareName);
      }

      // 8. Return reversed UCI (destination + origin) → origin + destination
      const uciResult = names[1] + names[0];
      return uciResult;
    }

    // ── Reconcile into movestray (same contract as old _fmReconcile) ───────
    function _reconcileFirstMove(uci) {
      if (!uci) {
        return;
      }


      // Already have this move at the front — interceptor got there first, done.
      if (movestray.length > 0 && movestray[0] === uci) {
        return;
      }

      if (movestray.length === 0) {
        movestray.unshift(uci);
        updateMoveCount();
        if (!gameCounted) {
          gameCounted = true;
          try { chrome.runtime.sendMessage({ type: 'GAME_PLAYED' }, () => {}); } catch (_) {}
        }
      } else {
        // Interceptor captured a later move but missed move 1 — prepend it.
        movestray.unshift(uci);
        updateMoveCount();
      }

      if (autoMode && engineReady && deviceDataReady && (audioModeActive || adSessionActive || freeGamesPeriod)) {
        setMoveDisplay('...', '#93c5fd');
        sendToEngine([...movestray]);
      }
    }

    // ── Fire off the main thread — queueMicrotask keeps us non-blocking ───
    // We retry up to ~30 times (×100 ms = 3 s) to handle pages where the
    // board DOM takes a moment to fully paint transforms.  Each attempt is
    // itself queued as a microtask so we never hold the call stack.
    let _attempts = 0;
    let _stopRetrying = false;
    const _MYGEN = _fmSnapshotGen;              // freeze the generation this loop belongs to
    const _STARTED_AT = Date.now();
    const _MAX_ELAPSED_MS = 30 * 1000;          // generous safety backstop only — not a normal exit path
    let _retryTimer = null;

    function _attempt() {
      if (_MYGEN !== _fmSnapshotGen) {
        return;
      }

      _attempts++;

      const uci = _readBlackFirstMove();
      if (uci) {
        _reconcileFirstMove(uci);
        return;  // done — no cleanup needed, no observer to tear down
      }

      if (_stopRetrying) {
        return;
      }

      if (Date.now() - _STARTED_AT >= _MAX_ELAPSED_MS) {
        return;
      }

      _retryTimer = setTimeout(() => queueMicrotask(_attempt), 100);
      // Retries continue on elapsed time, not a fixed attempt count, so slow/bad
      // network conditions get as long as needed (up to the safety backstop)
      // to find the orientation and settle the board.
    }

    queueMicrotask(_attempt);

  })();
}

// ═══════════════════════════════════════════════════════════════════════════
// Engine connection
// ═══════════════════════════════════════════════════════════════════════════
let confirmed   = false;
let capturing   = false;
let buffer      = [];
let playerColor = null;
let engineWs    = null;
let engineReady = false;
let _hbInterval = null;
let _hbTimeout  = null;
let _reconnectDelay = 300;
let _reconnectTimer = null;

let deviceDataReady = false;

// ═══════════════════════════════════════════════════════════════════════════
// Engine status badge
// ═══════════════════════════════════════════════════════════════════════════
let engineStatusEl = null;
let _pendingEngineCallbacks = [];

function injectEngineStatusBadge() {
  if (engineStatusEl) return;
  engineStatusEl = document.createElement('div');
  engineStatusEl.id = n.id('cipher_engine_status');
  Object.assign(engineStatusEl.style, {
    position:     'fixed',
    left:         '0.75rem',
    bottom:       '0.75rem',
    zIndex:       '999999',
    padding:      '0.4rem 0.75rem',
    fontFamily:   "'Afacad Flux', 'Segoe UI', system-ui, sans-serif",
    fontSize:     '0.78rem',
    fontWeight:   '700',
    letterSpacing:'0.02em',
    color:        '#ffffff',
    background:   '#ef4444',
    borderRadius: '4px',
    boxShadow:    '0 0.25rem 1rem rgba(0,0,0,.5)',
    userSelect:   'none',
    pointerEvents:'none',
  });
  engineStatusEl.textContent = 'Waiting for engine connection';
  (document.documentElement || document.body).appendChild(engineStatusEl);
}

let _engineBadgeHideTimer = null;
function setEngineStatusBadge(connected) {
  if (!engineStatusEl) return;
  // Cancel any pending hide
  if (_engineBadgeHideTimer) { clearTimeout(_engineBadgeHideTimer); _engineBadgeHideTimer = null; }
  if (connected) {
    // Show green briefly, then hide after 3 s
    engineStatusEl.textContent = 'Engine connected';
    engineStatusEl.style.background = '#22c55e';
    engineStatusEl.style.display = '';
    _engineBadgeHideTimer = setTimeout(() => {
      if (engineStatusEl) engineStatusEl.style.display = 'none';
      _engineBadgeHideTimer = null;
    }, 3000);
  } else {
    // Engine lost — bring it back immediately as "Waiting"
    engineStatusEl.style.display = '';
    engineStatusEl.textContent = 'Waiting for engine connection';
    engineStatusEl.style.background = '#ef4444';
  }
}

function whenEngineReady(fn) {
  if (deviceDataReady) fn();
  else _pendingEngineCallbacks.push(fn);
}
function _flushEngineReadyCallbacks() {
  const cbs = _pendingEngineCallbacks;
  _pendingEngineCallbacks = [];
  cbs.forEach((fn) => { try { fn(); } catch (_) {} });
}

function _clearHeartbeat() {
  clearInterval(_hbInterval);
  clearTimeout(_hbTimeout);
  _hbInterval = null;
  _hbTimeout  = null;
}
function _startHeartbeat() {
  _clearHeartbeat();
  _hbInterval = setInterval(() => {
    if (!engineWs || engineWs.readyState !== WebSocket.OPEN) return;
    try { engineWs.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    _hbTimeout = setTimeout(() => { if (engineWs) engineWs.close(); }, 2000);
  }, 5000);
}
function _scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; connectEngine(); }, _reconnectDelay);
  _reconnectDelay = Math.min(_reconnectDelay * 2, 8000);
}

function sendStealthMessage() {
  if (!engineWs || engineWs.readyState !== WebSocket.OPEN) return;
  if (userPlan === 'pro') {
    try { engineWs.send(JSON.stringify({ type: 'proactive' })); } catch (_) {}
  } else {
    try { engineWs.send(JSON.stringify({ type: 'notpaid' })); } catch (_) {}
  }
}

function connectEngine() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (engineWs) { try { engineWs.close(); } catch (_) {} engineWs = null; }
  engineReady = false;
  _clearHeartbeat();
  let ws;
  try { ws = new WebSocket('ws://localhost:8765'); } catch (_) { _scheduleReconnect(); return; }
  engineWs = ws;
  ws.onopen = () => {
    if (ws !== engineWs) { ws.close(); return; }
    engineReady = true;
    _reconnectDelay = 300;
    _startHeartbeat();
    setEngineStatusBadge(deviceDataReady);
    try {
      chrome.runtime.sendMessage({ type: 'FINGERPRINT_SIGNALS', signals: _gpuSignals });
    } catch (_) {}
    _flushMovesIfReady();
    if (activeVariant.gdrive) {
      try {
        ws.send(JSON.stringify({
          type:   'ensure_nnue',
          nnue:   activeVariant.nnue,
          gdrive: activeVariant.gdrive,
        }));
      } catch (_) {}
    }
    if (_planResolved) {
      sendStealthMessage();
    }
  };
  ws.onclose = () => {
    if (ws === engineWs) {
      engineWs = null; engineReady = false; _clearHeartbeat(); _scheduleReconnect();
      setEngineStatusBadge(false);
    }
  };
  ws.onerror = () => ws.close();

  let _nnueAnimInterval = null;
  function clearNnueAnim() {
    if (_nnueAnimInterval) {
      clearInterval(_nnueAnimInterval);
      _nnueAnimInterval = null;
    }
  }
  function animateNnueStatus(baseText, color) {
    if (!nnueStatusEl) return;
    clearNnueAnim();
    let dots = 0;
    const step = () => {
      if (!nnueStatusEl) { clearNnueAnim(); return; }
      nnueStatusEl.textContent = baseText + '.'.repeat(dots);
      nnueStatusEl.style.color = color || '#93c5fd';
      nnueStatusEl.style.display = 'block';
      dots = (dots + 1) % 4;
    };
    step();
    _nnueAnimInterval = setInterval(step, 500);
  }
  function showNnueReady() {
    if (!nnueStatusEl) return;
    clearNnueAnim();
    nnueStatusEl.textContent = '✓ NNUE ready';
    nnueStatusEl.style.color = '#00e5a0';
    nnueStatusEl.style.display = 'block';
    setTimeout(() => {
      if (nnueStatusEl) {
        nnueStatusEl.style.transition = 'opacity 0.5s';
        nnueStatusEl.style.opacity = '0';
        setTimeout(() => {
          if (nnueStatusEl) {
            nnueStatusEl.style.display = 'none';
            nnueStatusEl.style.opacity = '1';
            nnueStatusEl.style.transition = '';
            nnueStatusEl.textContent = '';
          }
        }, 500);
      }
    }, 1200);
  }

  ws.onmessage = (evt) => {
    clearTimeout(_hbTimeout);
    _hbTimeout = null;
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'bestmove') {
        showBestMove(msg.from, msg.to);
      } else if (msg.type === 'nnue_download_start') {
        animateNnueStatus('Downloading engine', '#93c5fd');
      } else if (msg.type === 'nnue_download_retry') {
        const n = msg.attempt || '?', of = msg.of || '?';
        animateNnueStatus(`Retry ${n}/${of}`, '#f59e0b');
      } else if (msg.type === 'nnue_download_done') {
        showNnueReady();
      } else if (msg.type === 'nnue_download_error') {
        clearNnueAnim();
        setNnueStatus('Network error — retry', '#f87171');
        if (typeof showToast === 'function') {
          showToast(
            msg.message ||
            'Could not download variant engine file. Check your network connection.',
            5000
          );
        }
      } else if (msg.type === 'devicedata' && msg.data) {
        const wasReady = deviceDataReady;
        deviceDataReady = true;
        setEngineStatusBadge(true);
        chrome.runtime.sendMessage({
          type: 'DEVICE_DATA',
          data: msg.data
        });
        if (!wasReady) _flushEngineReadyCallbacks();
        _flushMovesIfReady();
      }
    } catch (_) {}
  };
}
function sendToEngine(moves) {
  if (!deviceDataReady) return;
  if (!audioModeActive && !adSessionActive && !freeGamesPeriod) return;
  if (!engineReady || !moves.length) return;
  const movetime = Math.round(moveTimeSec * 1000);
  try {
    const msg = {
      type:    'analyze',
      moves,
      variant: activeVariant.id,
      nnue:    activeVariant.nnue,
      movetime,
      elo:     engineElo,
    };
    if (activeVariant.gdrive) msg.gdrive = activeVariant.gdrive;
    engineWs.send(JSON.stringify(msg));
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Username Firebase helpers
// ═══════════════════════════════════════════════════════════════════════════
function dbMsgRead(path) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'DB_READ', path }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res?.data ?? null);
      });
    } catch (_) { resolve(null); }
  });
}
function dbMsgSet(path, value) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'DB_SET', path, value }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res?.data ?? null);
      });
    } catch (_) { resolve(null); }
  });
}

function getCipherUserID() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'REQUEST_USER_ID' }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res?.userId || null);
      });
    } catch (_) { resolve(null); }
  });
}

async function saveUsernameToFirebase(username, platform) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: 'SAVE_USERNAME', username, platform: platform || PLATFORM },
        (res) => { resolve(res || null); }
      );
    } catch (_) { resolve(null); }
  });
}

async function loadUsernameFromFirebase() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_USERNAME' }, (res) => {
        if (chrome.runtime.lastError || !res) { resolve(null); return; }
        const lichess  = res.lichess_username  || null;
        const chesscom = res.chesscom_username || null;
        const updates = {};
        if (lichess)  updates.wsUsername = lichess;
        if (chesscom) updates.ccUsername = chesscom;
        if (Object.keys(updates).length) chrome.storage.sync.set(updates);
        resolve(PLATFORM === 'chesscom' ? chesscom : lichess);
      });
    } catch (_) { resolve(null); }
  });
}

async function checkUsernameInFirebase() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_USERNAME' }, (res) => {
        if (chrome.runtime.lastError || !res) { resolve(null); return; }
        const username = PLATFORM === 'chesscom'
          ? (res.chesscom_username || null)
          : (res.lichess_username  || null);
        resolve(username);
      });
    } catch (_) { resolve(null); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Rating (Elo) helpers (shared between card display and modal)
// ═══════════════════════════════════════════════════════════════════════════
function _sliderToElo(v) {
  // 0–100 slider → 500–3400 with more granularity in the human range (1000–2500)
  const t = v / 100;
  if (t <= 0.2)  return Math.round(500  + t / 0.2 * 500);           // 500–1000
  if (t <= 0.6)  return Math.round(1000 + (t - 0.2) / 0.4 * 1500); // 1000–2500
  if (t <= 0.85) return Math.round(2500 + (t - 0.6) / 0.25 * 500); // 2500–3000
  return Math.round(3000 + (t - 0.85) / 0.15 * 400);               // 3000–3400
}
function _eloToSlider(elo) {
  if (elo <= 1000) return Math.round((elo - 500) / 500 * 20);
  if (elo <= 2500) return Math.round(20 + (elo - 1000) / 1500 * 40);
  if (elo <= 3000) return Math.round(60 + (elo - 2500) / 500 * 25);
  return Math.round(85 + (elo - 3000) / 400 * 15);
}
function _formatElo(elo) { return elo.toString(); }
function _sliderColor(v) {
  if (v < 25) return '#22c55e';
  if (v < 50) return '#facc15';
  if (v < 75) return '#f97316';
  return '#ef4444';
}
function _sliderZone(v) {
  const elo = _sliderToElo(v);
  if (elo < 1200) return 'Beginner';
  if (elo < 1800) return 'Intermediate';
  if (elo < 2400) return 'Advanced';
  if (elo < 2800) return 'Master';
  return 'Super GM';
}

// ═══════════════════════════════════════════════════════════════════════════
// CARD UI
// ═══════════════════════════════════════════════════════════════════════════
const FONT    = "'Afacad Flux', 'Segoe UI', system-ui, sans-serif";
const BLUE    = '#1d4ed8';
const BLUE_DK = '#1e40af';

let cardEl         = null;
let cardMoveEl     = null;
let nnueStatusEl   = null;
let cardReqBtn     = null;
let cardAutoBtn    = null;
let cardCountEl    = null;
let cardThinkLabel = null;
let variantLabelEl = null;
let dropdownEl     = null;
let showBtn        = null;
let showKnob       = null;
let ratedBtn       = null;
let ratedKnob      = null;
let ratedAcknowledged = false;

let _ratedCheckResolve = null;
const _ratedCheckPromise = new Promise(res => { _ratedCheckResolve = res; });
let _ratedCheckDone = false;
function _resolveRatedCheck(approved) {
  if (_ratedCheckDone) return;
  _ratedCheckDone = true;
  if (approved) {
    ratedAcknowledged = true;
    chrome.storage.sync.set({ cipher_rated_acknowledged: true });
    if (ratedBtn) { ratedBtn.dataset.active = 'true'; ratedBtn.style.background = '#00e5a0'; ratedKnob.style.left = '1.35rem'; }
  }
  if (_ratedCheckResolve) { _ratedCheckResolve(approved); _ratedCheckResolve = null; }
}

let isPinned     = false;
let pinnedCardEl = null;
let pinnedMoveEl = null;
let lastFrom     = null;
let lastTo       = null;

function _getAudioIcon(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
  </svg>`;
}

function injectCard() {
  if (cardEl) return;
  cardEl = document.createElement('div');
  cardEl.id = n.id('cipher_card');
  Object.assign(cardEl.style, {
    position:     'fixed',
    top:          '4.5rem',
    right:        '0.875rem',
    zIndex:       '999999',
    width:        '13rem',
    background:   '#0f1117',
    border:       '1px solid #1e2235',
    borderRadius: '0',
    boxShadow:    '0 0.5rem 2rem rgba(0,0,0,.7)',
    fontFamily:   FONT,
    userSelect:   'none',
    overflow:     'visible',
  });

  const dragHandle = document.createElement('div');
  Object.assign(dragHandle.style, { height:'0.375rem', background:'#0f1117', cursor:'grab' });

  // ── THINKING TIME ROW ── now with a visible border, more breathing room, and a clear hover cue
  const thinkTopRow = document.createElement('div');
  Object.assign(thinkTopRow.style, {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    padding:        '0.42rem 0.6rem',          // was 0.22rem — more vertical breathing room
    borderBottom:   '1px solid #2a3050',       // was #1a1d2e — slightly brighter separator
    borderTop:      '1px solid #2a3050',       // NEW — top border so the row is visually enclosed
    background:     '#111420',                 // slightly lifted background so it reads as its own zone
    gap:            '0.4rem',
    cursor:         'pointer',
    transition:     'background 0.15s, border-color 0.15s',
  });
  const thinkTopIcon = document.createElement('span');
  thinkTopIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  Object.assign(thinkTopIcon.style, { display:'flex', alignItems:'center', flexShrink:'0' });
  const thinkTopLabelText = document.createElement('span');
  thinkTopLabelText.textContent = 'rating';
  Object.assign(thinkTopLabelText.style, { fontSize:'0.6rem', color:'#ffffff', letterSpacing:'0.07em', textTransform:'uppercase', fontFamily:FONT });
  cardThinkLabel = document.createElement('span');
  cardThinkLabel.textContent = _formatElo(engineElo);
  Object.assign(cardThinkLabel.style, { fontSize:'0.72rem', fontWeight:'800', color:'#ffffff', letterSpacing:'0.06em', fontFamily:FONT });
  thinkTopRow.append(thinkTopIcon, thinkTopLabelText, cardThinkLabel);
  thinkTopRow.addEventListener('click', openThinkTimeModal);
  thinkTopRow.addEventListener('mouseenter', () => {
    thinkTopRow.style.background = '#1a1f35';
    thinkTopRow.style.borderColor = '#3d4f80';
  });
  thinkTopRow.addEventListener('mouseleave', () => {
    thinkTopRow.style.background = '#111420';
    thinkTopRow.style.borderColor = '#2a3050';
  });

  // ── VARIANT ROW ── slightly taller for easier clicking
  const variantRow = document.createElement('div');
  Object.assign(variantRow.style, {
    display:'flex', alignItems:'center', justifyContent:'space-between',
    padding:'0 0.6rem',                        // was 0 0.5rem
    height:'2.2rem',                           // was 2rem
    borderBottom:'1px solid #1a1d2e'
  });
  variantLabelEl = document.createElement('span');
  variantLabelEl.textContent = activeVariant.abbr;
  Object.assign(variantLabelEl.style, { fontSize:'0.85rem', fontWeight:'700', color:'#ffffff', letterSpacing:'0.06em', fontFamily:FONT });
  const togglesWrap = document.createElement('div');
  Object.assign(togglesWrap.style, { display:'flex', gap:'0.6rem', alignItems:'center', flex:'1', justifyContent:'center' });
  function makeToggle(label, initOn) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display:'flex', flexDirection:'column', alignItems:'center', gap:'0.18rem' });
    const btn = document.createElement('button');
    btn.dataset.active = initOn ? 'true' : 'false';
    Object.assign(btn.style, { width:'2.4rem', height:'1.2rem', borderRadius:'999px', border:'none', background: initOn ? '#00e5a0' : '#3d4460', cursor:'pointer', position:'relative', transition:'background .2s', padding:'0', flexShrink:'0' });
    const knob = document.createElement('span');
    Object.assign(knob.style, { position:'absolute', top:'50%', left: initOn ? '1.35rem' : '0.2rem', transform:'translateY(-50%)', width:'0.8rem', height:'0.8rem', borderRadius:'50%', background:'#ffffff', transition:'left .2s, background .2s', pointerEvents:'none' });
    btn.appendChild(knob);
    const lbl = document.createElement('span');
    lbl.textContent = label;
    Object.assign(lbl.style, { fontSize:'0.62rem', color:'#ffffff', fontFamily:FONT, fontWeight:'600', letterSpacing:'0.04em' });
    wrap.append(btn, lbl);
    return { wrap, btn, knob };
  }
  const { wrap: ratedWrap, btn: _ratedBtn, knob: _ratedKnob } = makeToggle('Rated', false);
  ratedBtn = _ratedBtn; ratedKnob = _ratedKnob;
  ratedBtn.addEventListener('click', () => {
    const isOn = ratedBtn.dataset.active === 'true';
    if (isOn) {
      ratedBtn.dataset.active = 'false'; ratedBtn.style.background = '#3d4460'; ratedKnob.style.left = '0.2rem';
      ratedAcknowledged = false; chrome.storage.sync.set({ cipher_rated_acknowledged: false });
    } else {
      showRatedModal();
    }
  });
  const { wrap: showWrap, btn: _showBtn, knob: _showKnob } = makeToggle('Show', true);
  showBtn = _showBtn; showKnob = _showKnob;
  showBtn.addEventListener('click', () => {
    const isOn = showBtn.dataset.active === 'true';
    const nowOn = !isOn;
    showBtn.dataset.active = nowOn ? 'true' : 'false';
    showBtn.style.background = nowOn ? '#00e5a0' : '#3d4460';
    showKnob.style.left = nowOn ? '1.35rem' : '0.2rem';
    chrome.storage.sync.set({ cipher_show_overlay: nowOn });
    if (nowOn) { if (lastFrom && lastTo) highlightBestMove(lastFrom, lastTo); }
    else { const overlay = document.getElementById(n.id('cipher_svg_overlay')); if (overlay) overlay.remove(); }
  });
  togglesWrap.append(ratedWrap, showWrap);
  const variantBtn = document.createElement('button');
  variantBtn.innerHTML = '&#9662;';
  Object.assign(variantBtn.style, { background:'transparent', border:'none', color:'#ffffff', fontSize:'1.2rem', cursor:'pointer', padding:'0', lineHeight:'1', fontFamily:FONT, display:'flex', alignItems:'center' });
  variantBtn.title = 'Select variant';
  variantBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(); });
  variantRow.append(variantLabelEl, togglesWrap, variantBtn);

  // ── USERNAME BUTTON ── slightly more vertical padding
  const usernameBtn = document.createElement('button');
  usernameBtn.textContent = 'Username';
  Object.assign(usernameBtn.style, {
    width:'100%', padding:'0.5rem 0.5rem',     // was 0.42rem
    background:'rgba(255,255,255,0.04)', backdropFilter:'blur(6px)', WebkitBackdropFilter:'blur(6px)',
    border:'none', borderBottom:'1px solid rgba(255,255,255,0.18)', borderTop:'1px solid rgba(255,255,255,0.18)',
    color:'#ffffff', fontSize:'0.78rem', fontWeight:'700', fontFamily:FONT,
    cursor:'pointer', textAlign:'center', letterSpacing:'0.1em', textTransform:'uppercase',
    transition:'all .18s', textShadow:'none', boxShadow:'none'
  });
  usernameBtn.addEventListener('mouseenter', () => { usernameBtn.style.background = 'rgba(255,255,255,0.10)'; usernameBtn.style.color = '#ffffff'; });
  usernameBtn.addEventListener('mouseleave', () => { usernameBtn.style.background = 'rgba(255,255,255,0.04)'; usernameBtn.style.color = '#ffffff'; });
  const platformCard = document.createElement('div');
  Object.assign(platformCard.style, { display:'none', position:'absolute', top:'100%', left:'0', width:'100%', background:'#0f1117', border:'1px solid #1e2235', borderTop:'none', zIndex:'9999997', fontFamily:FONT, boxSizing:'border-box' });
  const tabBar = document.createElement('div');
  Object.assign(tabBar.style, { display:'flex', borderBottom:'1px solid #1a1d2e' });
  const tabStyle = (active) => ({ flex:'1', padding:'0.4rem 0', background: active ? '#1a1d2e' : 'transparent', border:'none', color: active ? '#ffffff' : '#ffffff', fontSize:'0.75rem', fontWeight:'700', fontFamily:FONT, cursor:'pointer', letterSpacing:'0.04em', transition:'all .15s' });
  const lichessTab = document.createElement('button'); lichessTab.textContent = 'Lichess';
  const chesscomTab = document.createElement('button'); chesscomTab.textContent = 'Chess.com';
  Object.assign(lichessTab.style, tabStyle(PLATFORM === 'lichess'));
  Object.assign(chesscomTab.style, tabStyle(PLATFORM === 'chesscom'));
  tabBar.append(lichessTab, chesscomTab);
  function makeInputRow(placeholder, storageKey, onSave, onClose) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display:'flex', gap:'0.3rem', padding:'0.5rem', boxSizing:'border-box' });
    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = placeholder; inp.autocomplete = 'off'; inp.spellcheck = false;
    Object.assign(inp.style, { flex:'1', background:'#1a1d2e', border:'1px solid #2a2d42', color:'#ffffff', fontSize:'0.75rem', padding:'0.3rem 0.4rem', outline:'none', fontFamily:FONT, boxSizing:'border-box', minWidth:'0' });
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Enter';
    Object.assign(saveBtn.style, { background:BLUE, border:'none', color:'#fff', fontSize:'0.72rem', fontWeight:'700', padding:'0.3rem 0.45rem', cursor:'pointer', flexShrink:'0', fontFamily:FONT, transition:'background .15s' });
    saveBtn.addEventListener('mouseenter', () => { saveBtn.style.background = BLUE_DK; });
    saveBtn.addEventListener('mouseleave', () => { saveBtn.style.background = BLUE; });
    chrome.storage.sync.get(storageKey, (res) => { if (res[storageKey]) { inp.value = res[storageKey]; inp.style.borderColor = '#00e5a0'; } });
    const doSave = () => {
      const val = inp.value.trim();
      if (!val) return;
      chrome.storage.sync.set({ [storageKey]: val }, () => { inp.style.borderColor = '#00e5a0'; if (onSave) onSave(val); if (onClose) onClose(); });
    };
    saveBtn.addEventListener('click', doSave);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
    inp.addEventListener('input', () => { inp.style.borderColor = '#2a2d42'; });
    wrap.append(inp, saveBtn);
    return wrap;
  }
  let platformOpen = false;
  const closeCard = () => { platformOpen = false; platformCard.style.display = 'none'; };
  const lichessPanel = makeInputRow('e.g. Magnus2882', 'wsUsername', (val) => { try { chrome.runtime.sendMessage({ type: 'usernameUpdated', username: val }); } catch (_) {} usernameBtn.textContent = val; }, closeCard);
  const chesscomPanel = makeInputRow('e.g. Hikaru', 'ccUsername', (val) => { usernameBtn.textContent = val; }, closeCard);
  lichessPanel.style.display = PLATFORM === 'lichess' ? '' : 'none';
  chesscomPanel.style.display = PLATFORM === 'chesscom' ? '' : 'none';
  let activeTab = PLATFORM === 'chesscom' ? 'chesscom' : 'lichess';
  lichessTab.addEventListener('click', () => {
    activeTab = 'lichess';
    Object.assign(lichessTab.style, tabStyle(true)); Object.assign(chesscomTab.style, tabStyle(false));
    lichessPanel.style.display = ''; chesscomPanel.style.display = 'none';
  });
  chesscomTab.addEventListener('click', () => {
    activeTab = 'chesscom';
    Object.assign(lichessTab.style, tabStyle(false)); Object.assign(chesscomTab.style, tabStyle(true));
    lichessPanel.style.display = 'none'; chesscomPanel.style.display = '';
  });
  platformCard.append(tabBar, lichessPanel, chesscomPanel);
  usernameBtn.addEventListener('click', (e) => { e.stopPropagation(); platformOpen = !platformOpen; platformCard.style.display = platformOpen ? 'block' : 'none'; });
  document.addEventListener('click', () => { if (platformOpen) closeCard(); });
  platformCard.addEventListener('click', e => e.stopPropagation());
  const usernameKey = PLATFORM === 'chesscom' ? 'ccUsername' : 'wsUsername';
  chrome.storage.sync.get(usernameKey, (res) => { if (res[usernameKey]) usernameBtn.textContent = res[usernameKey]; });

  nnueStatusEl = document.createElement('div');
  Object.assign(nnueStatusEl.style, {
    display:       'none',
    fontSize:      '0.64rem',
    fontWeight:    '600',
    fontFamily:    FONT,
    letterSpacing: '0.03em',
    textAlign:     'center',
    padding:       '0.18rem 0.5rem',
    color:         '#93c5fd',
    borderBottom:  '1px solid #1a1d2e',
    background:    '#0a0c18',
  });

  const topSection = document.createElement('div');
  Object.assign(topSection.style, { position:'relative' });
  topSection.append(thinkTopRow, variantRow, nnueStatusEl, usernameBtn, platformCard);

  // ── MOVE BLOCK ── more top padding so the big move number breathes away from username button
  const moveBlock = document.createElement('div');
  Object.assign(moveBlock.style, {
    display:'flex', alignItems:'center', justifyContent:'space-between',
    padding:'0.9rem 0.5rem 0.25rem',           // was 0.75rem top
    position:'relative'
  });
  const penBtn = document.createElement('button');
  penBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
  Object.assign(penBtn.style, { background:'transparent', border:'none', cursor:'pointer', padding:'2px', lineHeight:'1', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center' });
  penBtn.title = 'Correct a move';
  penBtn.addEventListener('click', (e) => { e.stopPropagation(); openMoveEditor(); });
  const xCardBtn = document.createElement('button');
  xCardBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="#ffffff"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.259 5.632 5.905-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  Object.assign(xCardBtn.style, { background:'transparent', border:'none', cursor:'pointer', padding:'2px', lineHeight:'1', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', position:'relative', opacity:'0.65', transition:'opacity .15s' });
  const xCardTooltip = document.createElement('span');
  xCardTooltip.textContent = 'Contact me';
  Object.assign(xCardTooltip.style, { position:'absolute', left:'calc(100% + 6px)', top:'50%', transform:'translateY(-50%)', background:'rgba(15,17,23,0.92)', border:'1px solid rgba(255,255,255,0.15)', color:'#ffffff', fontSize:'0.62rem', fontWeight:'600', letterSpacing:'0.06em', padding:'0.18rem 0.45rem', borderRadius:'3px', whiteSpace:'nowrap', pointerEvents:'none', opacity:'0', transition:'opacity .15s', fontFamily:FONT, backdropFilter:'blur(4px)', WebkitBackdropFilter:'blur(4px)', zIndex:'9999999' });
  xCardBtn.appendChild(xCardTooltip);
  xCardBtn.addEventListener('mouseenter', () => { xCardBtn.style.opacity = '1'; xCardTooltip.style.opacity = '1'; });
  xCardBtn.addEventListener('mouseleave', () => { xCardBtn.style.opacity = '0.65'; xCardTooltip.style.opacity = '0'; });
  xCardBtn.addEventListener('click', (e) => { e.stopPropagation(); try { window.open('https://x.com/Hard_Code_T', '_blank'); } catch (_) {} });
  const leftCol = document.createElement('div');
  Object.assign(leftCol.style, { display:'flex', flexDirection:'column', alignItems:'center', gap:'6px', flexShrink:'0' }); // gap was 4px
  leftCol.append(penBtn, xCardBtn);
  cardMoveEl = document.createElement('div');
  cardMoveEl.textContent = '\u2014';
  Object.assign(cardMoveEl.style, { fontSize:'2rem', fontWeight:'700', color:'#ffffff', letterSpacing:'0.12em', lineHeight:'1', minHeight:'2.25rem', fontFamily:FONT, flex:'1', textAlign:'center' });
  const pinBtn = document.createElement('button');
  pinBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';
  Object.assign(pinBtn.style, { background:'transparent', border:'none', cursor:'pointer', padding:'2px', lineHeight:'1', transition:'opacity .15s', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center' });
  pinBtn.title = 'Pin best move to bottom';
  pinBtn.addEventListener('click', (e) => { e.stopPropagation(); activatePin(); });
  const audioBtn = document.createElement('button');
  audioBtn.id = n.id('cipher_audio_btn');
  audioBtn.title = audioModeActive ? 'Audio on' : 'Unlock audio mode';
  audioBtn.innerHTML = _getAudioIcon(audioModeActive ? '#00e5a0' : 'white');
  Object.assign(audioBtn.style, { background:'transparent', border:'none', cursor:'pointer', padding:'2px', lineHeight:'1', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center' });
  const rightCol = document.createElement('div');
  Object.assign(rightCol.style, { display:'flex', flexDirection:'column', alignItems:'center', gap:'6px', flexShrink:'0' }); // gap was 4px
  rightCol.append(pinBtn, audioBtn);
  moveBlock.append(leftCol, cardMoveEl, rightCol);

  // ── MOVE COUNT ── a little more padding so it doesn't press against the move display
  const countWrap = document.createElement('div');
  Object.assign(countWrap.style, { textAlign:'center', padding:'0.2rem 0.5rem 0.35rem' }); // was 0.125rem top / 0.25rem bottom
  cardCountEl = document.createElement('span');
  cardCountEl.textContent = '0 moves';
  Object.assign(cardCountEl.style, { fontSize:'0.8rem', color:'#ffffff', fontWeight:'500', fontFamily:FONT });
  countWrap.appendChild(cardCountEl);

  timerRow = document.createElement('div');
  Object.assign(timerRow.style, { display:'none', background:'#2e7d32', color:'#ffffff', textAlign:'center', padding:'0.28rem 0.5rem', fontSize:'0.82rem', fontWeight:'700', fontFamily:FONT, letterSpacing:'0.08em', borderTop:'1px solid #1a1d2e', borderBottom:'1px solid #1a1d2e', transition:'background 0.4s' });
  timerDisplay = document.createElement('span');
  timerDisplay.textContent = '02:00:00';
  timerRow.appendChild(timerDisplay);

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display:'flex' });
  const btnBase = { flex:'1', padding:'0.6rem 0', fontSize:'0.85rem', fontWeight:'700', border:'none', borderRadius:'0', cursor:'pointer', color:'#ffffff', letterSpacing:'0.04em', textAlign:'center', display:'flex', alignItems:'center', justifyContent:'center', transition:'background .15s', fontFamily:FONT };
  cardAutoBtn = document.createElement('button');
  cardAutoBtn.textContent = 'AUTO';
  Object.assign(cardAutoBtn.style, { ...btnBase, background:'rgba(29,78,216,0.18)', borderRight:'1px solid rgba(99,155,255,0.13)', backdropFilter:'blur(8px)', WebkitBackdropFilter:'blur(8px)', boxShadow:'inset 0 1px 0 rgba(147,197,253,0.13), 0 2px 8px rgba(29,78,216,0.18)', letterSpacing:'0.1em', fontSize:'0.78rem', textShadow:'0 1px 8px rgba(99,155,255,0.5)', borderTop:'1px solid rgba(99,155,255,0.10)' });
  cardReqBtn = document.createElement('button');
  cardReqBtn.textContent = 'REQUEST';
  Object.assign(cardReqBtn.style, { ...btnBase, background:'rgba(29,78,216,0.55)', backdropFilter:'blur(8px)', WebkitBackdropFilter:'blur(8px)', boxShadow:'inset 0 1px 0 rgba(147,197,253,0.22), 0 2px 12px rgba(29,78,216,0.4)', letterSpacing:'0.07em', fontSize:'0.78rem', textShadow:'0 1px 8px rgba(147,197,253,0.6)', borderTop:'1px solid rgba(99,155,255,0.18)' });
  cardAutoBtn.addEventListener('mouseenter', () => { if (!autoMode) { cardAutoBtn.style.background = 'rgba(29,78,216,0.30)'; cardAutoBtn.style.boxShadow = 'inset 0 1px 0 rgba(147,197,253,0.22), 0 2px 16px rgba(29,78,216,0.32)'; } });
  cardAutoBtn.addEventListener('mouseleave', () => { if (!autoMode) { cardAutoBtn.style.background = 'rgba(29,78,216,0.18)'; cardAutoBtn.style.boxShadow = 'inset 0 1px 0 rgba(147,197,253,0.13), 0 2px 8px rgba(29,78,216,0.18)'; } });
  cardReqBtn.addEventListener('mouseenter', () => { if (autoMode) return; cardReqBtn.style.background = 'rgba(29,78,216,0.75)'; cardReqBtn.style.boxShadow = 'inset 0 1px 0 rgba(147,197,253,0.32), 0 2px 18px rgba(29,78,216,0.55)'; });
  cardReqBtn.addEventListener('mouseleave', () => { if (autoMode) return; cardReqBtn.style.background = 'rgba(29,78,216,0.55)'; cardReqBtn.style.boxShadow = 'inset 0 1px 0 rgba(147,197,253,0.22), 0 2px 12px rgba(29,78,216,0.4)'; });
  cardAutoBtn.addEventListener('click', () => { autoMode = !autoMode; chrome.storage.sync.set({ cipher_auto: autoMode }); applyModeStyle(); if (autoMode && engineReady && movestray.length && deviceDataReady && (audioModeActive || adSessionActive || freeGamesPeriod)) { setMoveDisplay('...', '#93c5fd'); sendToEngine([...movestray]); } });
  cardReqBtn.addEventListener('click', () => { if (autoMode) { autoMode = false; chrome.storage.sync.set({ cipher_auto: false }); applyModeStyle(); } handleRequest(); });
  btnRow.append(cardAutoBtn, cardReqBtn);

  cardEl.append(dragHandle, topSection, moveBlock, countWrap, timerRow, btnRow);
  document.documentElement.appendChild(cardEl);
  makeDraggable(cardEl, dragHandle);
  applyModeStyle();

  const _audioBtn = document.getElementById(n.id('cipher_audio_btn'));
  if (_audioBtn) {
    if (userPlan === 'basic') {
      _audioBtn.title = audioModeActive ? 'Audio on' : 'Toggle audio mode';
      _audioBtn.innerHTML = _getAudioIcon(audioModeActive ? '#00e5a0' : 'white');
      _audioBtn.onclick = (e) => {
        e.stopPropagation();
        audioModeActive = !audioModeActive;
        chrome.storage.sync.set({ cipher_audio: audioModeActive });
        _audioBtn.innerHTML = _getAudioIcon(audioModeActive ? '#00e5a0' : 'white');
        _audioBtn.title = audioModeActive ? 'Audio on' : 'Toggle audio mode';
      };
    } else if (userPlan === 'pro') {
      _audioBtn.style.display = 'none';
    } else {
      _audioBtn.onclick = (e) => { e.stopPropagation(); showAudioGate(); };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Rating (Elo) slider modal
// ═══════════════════════════════════════════════════════════════════════════
function openThinkTimeModal() {
  const existing = document.getElementById(n.id('cipher_think_modal'));
  if (existing) { existing.remove(); return; }

  const G_FONT = "'Afacad Flux', 'Segoe UI', system-ui, sans-serif";

  const THUMB_STYLE_ID = 'cipher-slider-thumb-style';
  if (!document.getElementById(THUMB_STYLE_ID)) {
    const st = document.createElement('style');
    st.id = THUMB_STYLE_ID;
    st.textContent = `
      .cipher-think-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: #ffffff;
        border: 3px solid var(--ct, #22c55e);
        cursor: pointer;
        margin-top: -7px;
        transition: border-color 0.15s;
      }
      .cipher-think-slider::-moz-range-thumb {
        width: 22px; height: 22px;
        border-radius: 50%;
        background: #ffffff;
        border: 3px solid var(--ct, #22c55e);
        cursor: pointer;
        transition: border-color 0.15s;
      }
      .cipher-think-slider {
        -webkit-appearance: none;
        appearance: none;
        background: transparent;
        outline: none;
        cursor: pointer;
        width: 100%;
        height: 22px;
        margin: 0;
        padding: 0;
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  const backdrop = document.createElement('div');
  backdrop.id = n.id('cipher_think_modal');
  Object.assign(backdrop.style, {
    position: 'fixed', inset: '0', zIndex: '99999999',
    background: 'rgba(0,0,0,0.75)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: G_FONT,
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    background: '#0f1117', border: '1px solid #2a2d42',
    borderRadius: '10px', padding: '1.4rem 1.5rem 1.2rem',
    width: '340px', display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: '0.9rem', boxSizing: 'border-box',
  });

  const titleEl = document.createElement('div');
  titleEl.textContent = 'ENGINE RATING';
  Object.assign(titleEl.style, { fontSize: '0.78rem', fontWeight: '800', color: '#fff', letterSpacing: '0.12em', fontFamily: G_FONT });

  const eloDispEl = document.createElement('div');
  Object.assign(eloDispEl.style, {
    fontSize: '2.4rem', fontWeight: '800', letterSpacing: '0.06em',
    color: '#22c55e', fontFamily: G_FONT, transition: 'color 0.12s', lineHeight: '1',
  });

  const defaultEl = document.createElement('div');
  defaultEl.textContent = 'default 2200';
  Object.assign(defaultEl.style, {
    fontSize: '0.62rem', color: '#ffffff', fontFamily: G_FONT,
    letterSpacing: '0.05em', marginTop: '-0.5rem',
  });

  const zoneEl = document.createElement('div');
  Object.assign(zoneEl.style, {
    fontSize: '0.7rem', fontWeight: '700', letterSpacing: '0.09em',
    textTransform: 'uppercase', color: '#22c55e',
    fontFamily: G_FONT, transition: 'color 0.12s', marginTop: '-0.3rem',
  });

  const sliderWrap = document.createElement('div');
  Object.assign(sliderWrap.style, { width: '100%', position: 'relative', height: '22px' });

  const trackEl = document.createElement('div');
  Object.assign(trackEl.style, {
    position: 'absolute', top: '7px', left: '0', right: '0',
    height: '8px', borderRadius: '4px', pointerEvents: 'none',
    background: 'linear-gradient(to right, #22c55e 0%, #facc15 50%, #f97316 75%, #ef4444 100%)',
  });

  const sliderEl = document.createElement('input');
  sliderEl.type = 'range';
  sliderEl.min = '0'; sliderEl.max = '100'; sliderEl.step = '1';
  sliderEl.className = 'cipher-think-slider';
  Object.assign(sliderEl.style, { position: 'absolute', top: '0', left: '0' });

  sliderWrap.append(trackEl, sliderEl);

  const tickRow = document.createElement('div');
  Object.assign(tickRow.style, {
    display: 'flex', justifyContent: 'space-between',
    width: '100%', padding: '0 2px', boxSizing: 'border-box',
    marginTop: '-0.3rem',
  });
  ['500', '1000', '1800', '2500', '3400'].forEach(t => {
    const lbl = document.createElement('span');
    lbl.textContent = t;
    Object.assign(lbl.style, { fontSize: '0.62rem', color: '#ffffff', fontFamily: G_FONT });
    tickRow.appendChild(lbl);
  });

  const setBtn = document.createElement('button');
  setBtn.textContent = 'Set rating';
  Object.assign(setBtn.style, {
    width: '100%', padding: '0.68rem', border: 'none',
    borderRadius: '5px', fontSize: '0.83rem', fontWeight: '800',
    cursor: 'pointer', letterSpacing: '0.05em', fontFamily: G_FONT,
    color: '#0f1117', background: '#22c55e',
    transition: 'background 0.12s, color 0.12s',
    marginTop: '0.2rem',
  });

  let currentElo = engineElo;
  sliderEl.value = _eloToSlider(currentElo);

  function syncUI() {
    const v = parseInt(sliderEl.value);
    currentElo = _sliderToElo(v);
    const color = _sliderColor(v);
    const zone  = _sliderZone(v);
    eloDispEl.textContent = _formatElo(currentElo);
    eloDispEl.style.color = color;
    zoneEl.textContent = zone;
    zoneEl.style.color = color;
    setBtn.style.background = color;
    setBtn.style.color = (v >= 50) ? '#ffffff' : '#0f1117';
    sliderEl.style.setProperty('--ct', color);
  }

  sliderEl.addEventListener('input', syncUI);
  syncUI();

  setBtn.addEventListener('click', () => {
    engineElo = currentElo;
    chrome.storage.sync.set({ cipher_elo: engineElo });
    if (cardThinkLabel) cardThinkLabel.textContent = _formatElo(engineElo);
    backdrop.remove();
  });

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', escClose); }
  });

  modal.append(titleEl, eloDispEl, defaultEl, zoneEl, sliderWrap, tickRow, setBtn);
  backdrop.appendChild(modal);
  document.documentElement.appendChild(backdrop);
}

function openMoveEditor() {
  const existing = document.getElementById(n.id('cipher_move_editor'));
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = n.id('cipher_move_editor');
  Object.assign(overlay.style, {
    position:'fixed', inset:'0', zIndex:'99999999',
    background:'rgba(0,0,0,0.75)', display:'flex',
    alignItems:'center', justifyContent:'center', fontFamily:FONT
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    background:'#0f1117', border:'1px solid #2a2d42',
    boxShadow:'0 0.5rem 2.5rem rgba(0,0,0,0.9)',
    borderRadius:'6px', padding:'1.1rem 1.1rem 0.9rem',
    width:'min(480px,92vw)', maxHeight:'82vh',
    display:'flex', flexDirection:'column', gap:'0.7rem',
    boxSizing:'border-box'
  });

  const header = document.createElement('div');
  Object.assign(header.style, { display:'flex', alignItems:'center', justifyContent:'space-between' });
  const title = document.createElement('div');
  title.textContent = 'Edit Move List';
  Object.assign(title.style, { fontSize:'0.75rem', fontWeight:'700', color:'#93c5fd', letterSpacing:'0.07em', textTransform:'uppercase', fontFamily:FONT });
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, { background:'transparent', border:'none', color:'#ffffff', fontSize:'0.95rem', cursor:'pointer', padding:'0', lineHeight:'1', fontFamily:FONT });
  closeBtn.addEventListener('click', () => { _editorInputs = null; overlay.remove(); });
  header.append(title, closeBtn);

  const sub = document.createElement('div');
  sub.textContent = 'Modify or clear any move. Empty slots are ignored when saved.';
  Object.assign(sub.style, { fontSize:'0.67rem', color:'#ffffff', fontFamily:FONT });

  const scroller = document.createElement('div');
  Object.assign(scroller.style, {
    overflowY:'auto', flex:'1',
    display:'grid', gridTemplateColumns:'repeat(5, 1fr)',
    gap:'0.3rem', paddingRight:'0.2rem'
  });

  const TOTAL = movestray.length + 60;
  const inputs = [];
  for (let i = 0; i < TOTAL; i++) {
    const cell = document.createElement('div');
    Object.assign(cell.style, { display:'flex', flexDirection:'column', alignItems:'center', gap:'0.12rem' });

    const num = document.createElement('div');
    num.textContent = i + 1;
    Object.assign(num.style, { fontSize:'0.58rem', color:'#ffffff', fontFamily:FONT });

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 5;
    inp.placeholder = '—';
    inp.value = movestray[i] || '';
    const isFilled = !!movestray[i];
    Object.assign(inp.style, {
      width:'100%', boxSizing:'border-box',
      background: isFilled ? '#1a1d2e' : '#0c0e18',
      border:'1px solid ' + (isFilled ? '#2a2d42' : '#161829'),
      color:'#ffffff', fontSize:'0.7rem', fontFamily:FONT,
      padding:'0.28rem 0.2rem', textAlign:'center',
      outline:'none', borderRadius:'2px'
    });
    inp.addEventListener('focus', () => { inp.style.borderColor = BLUE; });
    inp.addEventListener('blur',  () => { inp.style.borderColor = inp.value ? '#2a2d42' : '#161829'; });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const next = inputs[i + 1];
        if (next) next.focus(); else confirmBtn.focus();
      }
    });

    inputs.push(inp);
    cell.append(num, inp);
    scroller.appendChild(cell);
  }

  _editorInputs = inputs;

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Confirm Changes';
  Object.assign(confirmBtn.style, {
    background:BLUE, border:'none', color:'#fff', fontFamily:FONT,
    fontSize:'0.78rem', fontWeight:'700', letterSpacing:'0.04em',
    padding:'0.55rem 1rem', cursor:'pointer', borderRadius:'3px',
    width:'100%', flexShrink:'0'
  });
  confirmBtn.addEventListener('click', () => {
    movestray = inputs.map(inp => inp.value.trim().toLowerCase()).filter(Boolean);
    updateMoveCount();
    _editorInputs = null;
    overlay.remove();
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) { _editorInputs = null; overlay.remove(); } });

  modal.append(header, sub, scroller, confirmBtn);
  overlay.appendChild(modal);
  document.documentElement.appendChild(overlay);

  setTimeout(() => {
    const firstEmpty = inputs.find(inp => !inp.value);
    (firstEmpty || inputs[0]).focus();
  }, 30);
}

function activatePin() {
  isPinned = true;
  chrome.storage.sync.set({ cipher_pinned: true });
  cardEl.style.display = 'none';
  if (pinnedCardEl) pinnedCardEl.remove();
  pinnedCardEl = document.createElement('div');
  Object.assign(pinnedCardEl.style, { position:'fixed', bottom:'1.25rem', left:'50%', transform:'translateX(-50%)', zIndex:'9999999', background:'#0f1117', border:'1px solid #1e2235', boxShadow:'0 0.25rem 1.25rem rgba(0,0,0,.8)', display:'flex', alignItems:'center', gap:'0.75rem', padding:'0.45rem 0.9rem 0.45rem 1rem', fontFamily:FONT, userSelect:'none', whiteSpace:'nowrap' });
  pinnedMoveEl = document.createElement('span');
  Object.assign(pinnedMoveEl.style, { fontSize:'1.35rem', fontWeight:'700', letterSpacing:'0.1em', color: lastFrom ? '#60a5fa' : '#ffffff', fontFamily:FONT });
  pinnedMoveEl.textContent = lastFrom ? (lastFrom.toUpperCase() + '\u2192' + lastTo.toUpperCase()) : '\u2014';
  const unpinBtn = document.createElement('button');
  unpinBtn.title = 'Unpin';
  unpinBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/><line x1="3" y1="3" x2="21" y2="21" stroke="#ef4444" stroke-width="2"/></svg>';
  Object.assign(unpinBtn.style, { background:'transparent', border:'none', cursor:'pointer', padding:'2px', lineHeight:'1', flexShrink:'0', display:'inline-flex', alignItems:'center', justifyContent:'center' });
  unpinBtn.addEventListener('click', deactivatePin);
  pinnedCardEl.append(pinnedMoveEl, unpinBtn);
  document.documentElement.appendChild(pinnedCardEl);
}
function deactivatePin() {
  isPinned = false;
  chrome.storage.sync.set({ cipher_pinned: false });
  if (pinnedCardEl) { pinnedCardEl.remove(); pinnedCardEl = null; pinnedMoveEl = null; }
  if (cardEl) cardEl.style.display = '';
}

function buildDropdown() {
  if (dropdownEl) { dropdownEl.remove(); dropdownEl = null; return; }
  dropdownEl = document.createElement('div');
  Object.assign(dropdownEl.style, { position:'fixed', zIndex:'9999999', background:'#0f1117', border:'1px solid #2a2d42', boxShadow:'0 0.5rem 1.5rem rgba(0,0,0,.8)', overflow:'hidden', minWidth:'13rem', fontFamily:FONT });
  const rect = cardEl.getBoundingClientRect();
  dropdownEl.style.top = rect.top + 'px';
  dropdownEl.style.left = (rect.left - 13 * 16 - 4) + 'px';
  VARIANTS.forEach((v) => {
    const item = document.createElement('div');
    item.textContent = v.label;
    const isActive = v.id === activeVariant.id;
    Object.assign(item.style, { padding:'0.6rem 1rem', fontSize:'0.8rem', fontWeight: isActive ? '700' : '500', color: isActive ? '#60a5fa' : '#ffffff', cursor:'pointer', letterSpacing:'0.03em', borderLeft: isActive ? '2px solid #1d4ed8' : '2px solid transparent', background:'transparent', transition:'background .1s, color .1s', fontFamily:FONT });
    item.addEventListener('mouseenter', () => { if (v.id !== activeVariant.id) { item.style.background = '#1a1d2e'; item.style.color = '#ffffff'; } });
    item.addEventListener('mouseleave', () => { if (v.id !== activeVariant.id) { item.style.background = 'transparent'; item.style.color = '#ffffff'; } });
    item.addEventListener('click', () => selectVariant(v));
    dropdownEl.appendChild(item);
  });
  document.documentElement.appendChild(dropdownEl);
  setTimeout(() => { document.addEventListener('click', closeDropdown, { once: true }); }, 0);
}
function closeDropdown() { if (dropdownEl) { dropdownEl.remove(); dropdownEl = null; } }
function toggleDropdown() { if (dropdownEl) closeDropdown(); else buildDropdown(); }
function selectVariant(v) {
  activeVariant = v;
  if (variantLabelEl) variantLabelEl.textContent = v.abbr;
  chrome.storage.sync.set({ cipher_variant: v.id });
  try { chrome.runtime.sendMessage({ type: 'SAVE_VARIANT', variantId: v.id }); } catch (_) {}
  if (engineWs && engineWs.readyState === WebSocket.OPEN) {
    try { engineWs.send(JSON.stringify({ type: 'configure', variant: v.id, nnue: v.nnue, gdrive: v.gdrive || '' })); } catch (_) {}
  }
  closeDropdown();
  showBestMove(null, null);
  movestray = [];
  updateMoveCount();
}
function applyModeStyle() {
  if (!cardAutoBtn || !cardReqBtn) return;
  if (autoMode) {
    cardAutoBtn.style.background = 'rgba(29,78,216,0.72)';
    cardAutoBtn.style.boxShadow = 'inset 0 1px 0 rgba(147,197,253,0.28), 0 2px 16px rgba(29,78,216,0.5)';
    cardAutoBtn.style.textShadow = '0 0 12px rgba(147,197,253,0.7)';
    cardReqBtn.style.background = 'rgba(29,78,216,0.18)';
    cardReqBtn.style.boxShadow = 'inset 0 1px 0 rgba(147,197,253,0.08), 0 2px 8px rgba(29,78,216,0.12)';
    cardReqBtn.style.textShadow = '0 1px 8px rgba(99,155,255,0.3)';
  } else {
    cardAutoBtn.style.background = 'rgba(29,78,216,0.18)';
    cardAutoBtn.style.boxShadow = 'inset 0 1px 0 rgba(147,197,253,0.13), 0 2px 8px rgba(29,78,216,0.18)';
    cardAutoBtn.style.textShadow = '0 1px 8px rgba(99,155,255,0.5)';
    cardReqBtn.style.background = 'rgba(29,78,216,0.55)';
    cardReqBtn.style.boxShadow = 'inset 0 1px 0 rgba(147,197,253,0.22), 0 2px 12px rgba(29,78,216,0.4)';
    cardReqBtn.style.textShadow = '0 1px 8px rgba(147,197,253,0.6)';
  }
}
function makeDraggable(el, handle) {
  let ox = 0, oy = 0, sx = 0, sy = 0, dragging = false;
  const INTERACTIVE = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
  function startDrag(e) {
    if (INTERACTIVE.includes(e.target.tagName)) return;
    e.preventDefault();
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    el.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  handle.addEventListener('mousedown', startDrag);
  el.addEventListener('mousedown', startDrag);
  function onMove(e) {
    if (!dragging) return;
    el.style.left = (ox + e.clientX - sx) + 'px';
    el.style.top = (oy + e.clientY - sy) + 'px';
    el.style.right = 'auto';
    if (dropdownEl) closeDropdown();
  }
  function onUp() { dragging = false; el.style.cursor = 'default'; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
}
function setMoveDisplay(text, color) {
  if (cardMoveEl) { cardMoveEl.textContent = text; cardMoveEl.style.color = color; }
  if (pinnedMoveEl) { pinnedMoveEl.textContent = text; pinnedMoveEl.style.color = color; }
}
function setNnueStatus(text, color) {
  if (!nnueStatusEl) return;
  if (!text) {
    nnueStatusEl.style.display = 'none';
    nnueStatusEl.textContent = '';
    return;
  }
  nnueStatusEl.textContent = text;
  nnueStatusEl.style.color = color || '#93c5fd';
  nnueStatusEl.style.display = 'block';
}
function highlightBestMove(from, to) {
  const existing = document.getElementById(n.id('cipher_svg_overlay'));
  if (existing) existing.remove();
  if (!from || !to) return;
  if (showBtn && showBtn.dataset.active !== 'true') return;
  if (PLATFORM === 'lichess') _highlightLichess(from, to);
  else if (PLATFORM === 'chesscom') _highlightChessCom(from, to);
}
function _highlightLichess(from, to) {
  const board = document.querySelector('cg-board');
  if (!board) return;
  const boardRect = board.getBoundingClientRect();
  if (boardRect.width <= 0) return;
  const wrap = document.querySelector('div[class*="cg-wrap"]');
  const isBlack = wrap && wrap.classList.contains('orientation-black');
  const FILES = 'abcdefgh';
  const boardWidth = boardRect.width, boardHeight = boardRect.height, squareSize = boardWidth / 8;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = n.id('cipher_svg_overlay');
  svg.style.cssText = `position:fixed; top:${boardRect.top}px; left:${boardRect.left}px; width:${boardWidth}px; height:${boardHeight}px; pointer-events:none; z-index:9999;`;
  function squareToXY(sq) {
    const fi = FILES.indexOf(sq[0]);
    const rank = parseInt(sq[1], 10);
    if (fi < 0 || isNaN(rank)) return null;
    const col = isBlack ? 7 - fi : fi;
    const row = isBlack ? rank - 1 : 8 - rank;
    return { x: col * squareSize, y: row * squareSize };
  }
  [from, to].forEach((sq) => {
    const pos = squareToXY(sq);
    if (!pos) return;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', pos.x); rect.setAttribute('y', pos.y);
    rect.setAttribute('width', squareSize); rect.setAttribute('height', squareSize);
    rect.setAttribute('fill', 'rgba(0,210,180,0.55)');
    svg.appendChild(rect);
  });
  document.body.appendChild(svg);
}
function _highlightChessCom(from, to) {
  const board = document.querySelector('wc-chess-board');
  if (!board) return;
  const boardRect = board.getBoundingClientRect();
  if (boardRect.width <= 0) return;
  const isFlipped = board.classList.contains('flipped');
  const FILES = 'abcdefgh';
  const boardWidth = boardRect.width, boardHeight = boardRect.height, squareSize = boardWidth / 8;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = n.id('cipher_svg_overlay');
  svg.style.cssText = `position:fixed; top:${boardRect.top}px; left:${boardRect.left}px; width:${boardWidth}px; height:${boardHeight}px; pointer-events:none; z-index:9999;`;
  function squareToXY(sq) {
    const fi = FILES.indexOf(sq[0]);
    const rank = parseInt(sq[1], 10);
    if (fi < 0 || isNaN(rank)) return null;
    const col = isFlipped ? 7 - fi : fi;
    const row = isFlipped ? rank - 1 : 8 - rank;
    return { x: col * squareSize, y: row * squareSize };
  }
  [from, to].forEach((sq) => {
    const pos = squareToXY(sq);
    if (!pos) return;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', pos.x); rect.setAttribute('y', pos.y);
    rect.setAttribute('width', squareSize); rect.setAttribute('height', squareSize);
    rect.setAttribute('fill', 'rgba(0,210,180,0.55)');
    svg.appendChild(rect);
  });
  document.body.appendChild(svg);
}

function showBestMove(from, to) {
  if (audioModeActive) {
    _speakMove(from, to);
  }

  if (userPlan === 'pro') {
    return;
  }

  lastFrom = from;
  lastTo = to;
  if (!from && !to) setMoveDisplay('\u2014', '#ffffff');
  else setMoveDisplay(from.toUpperCase() + '\u2192' + to.toUpperCase(), '#60a5fa');
  highlightBestMove(from, to);
  if (cardReqBtn && !autoMode) {
    cardReqBtn.textContent = 'REQUEST';
    cardReqBtn.disabled = false;
    Object.assign(cardReqBtn.style, { opacity:'1', cursor:'pointer', background:BLUE });
  }
}

function updateMoveCount() {
  _saveMoveSession();
  if (cardCountEl) { const c = movestray.length; cardCountEl.textContent = c + ' move' + (c !== 1 ? 's' : ''); }
  if (_editorInputs) {
    for (let i = 0; i < _editorInputs.length; i++) {
      const newVal = movestray[i] || '';
      if (_editorInputs[i].value !== newVal) {
        _editorInputs[i].value = newVal;
        const isFilled = !!newVal;
        _editorInputs[i].style.background = isFilled ? '#1a1d2e' : '#0c0e18';
        _editorInputs[i].style.borderColor = isFilled ? '#2a2d42' : '#161829';
      }
    }
  }
}
function handleRequest() {
  if (!deviceDataReady) {
    setMoveDisplay('waiting for device...', '#f59e0b');
    return;
  }
  if (!engineReady) { setMoveDisplay('offline', '#ef4444'); return; }
  if (!movestray.length) { setMoveDisplay('no moves', '#f59e0b'); return; }
  if (!audioModeActive && !adSessionActive && !freeGamesPeriod) { setMoveDisplay('no session', '#ef4444'); return; }
  setMoveDisplay('...', '#93c5fd');
  if (cardReqBtn) { cardReqBtn.disabled = true; Object.assign(cardReqBtn.style, { opacity:'.45', cursor:'not-allowed' }); }
  sendToEngine([...movestray]);
}

// ═══════════════════════════════════════════════════════════════════════════
// URL change
// ═══════════════════════════════════════════════════════════════════════════
function onUrlChange(newUrl) {
  if (!sessionReady) return;
  if (newUrl === currentUrl) return;
  _fmSnapshotGen++;   // invalidate any still-running first-move snapshot retry from the previous game
  gameCounted = false;
  currentUrl = newUrl; confirmed = false; capturing = false; buffer = []; playerColor = null;
  movestray = []; updateMoveCount(); showBestMove(null, null);
  tearDownCipherCard();
  if (adGateEl)       { adGateEl.remove();       adGateEl = null; }
  if (engineStatusEl) { engineStatusEl.remove(); engineStatusEl = null; }
  n.rotate();
  injectEngineStatusBadge();
  try { chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: newUrl }); } catch (_) {}
  if (newUrl.includes('lichess')) {
    chrome.storage.sync.get('wsUsername', ({ wsUsername }) => { if (wsUsername) runConfirmation(wsUsername); });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Lichess confirmation
// ═══════════════════════════════════════════════════════════════════════════
function getUsernamesOnPage() { return [...document.querySelectorAll('a.user-link')].map(el => el.innerText.trim().toLowerCase()); }
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
    runGameChecks();
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
    // NOTE: intentionally NOT touching movestray/updateMoveCount/showBestMove here.
    // This message fires whenever the Vercel/device-data round trip resolves the
    // lichess username (including the normal first-load case), and previously wiped
    // out any moves the player had already made while that request was in flight.
    confirmed = false; capturing = false; buffer = []; playerColor = null;
    runConfirmation(msg.username);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Lichess rated modal
// ═══════════════════════════════════════════════════════════════════════════
function showRatedModal() {
  if (document.getElementById(n.id('cipher_rated_modal'))) return;
  const overlay = document.createElement('div');
  overlay.id = n.id('cipher_rated_modal');
  Object.assign(overlay.style, { position:'fixed', top:'0', left:'0', width:'100%', height:'100%', background:'rgba(0,0,0,0.72)', zIndex:'999999', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:FONT, overflowY:'auto', padding:'1rem', boxSizing:'border-box' });
  const modal = document.createElement('div');
  Object.assign(modal.style, { background:'#1a1d2e', border:'1.5px solid #c0392b', borderRadius:'12px', padding:'28px 28px 22px', maxWidth:'460px', width:'100%', boxShadow:'0 8px 40px rgba(0,0,0,0.7)', color:'#ff6b6b', margin:'auto', boxSizing:'border-box' });
  const header = document.createElement('div');
  header.textContent = 'Rated Games';
  Object.assign(header.style, { fontSize:'1.05rem', fontWeight:'700', color:'#ff4444', marginBottom:'14px', letterSpacing:'0.03em', textAlign:'center' });
  const body = document.createElement('div');
  body.innerHTML = `<p style="margin:0 0 10px;font-size:0.82rem;line-height:1.6;color:#ff8080;">Enabling this option allows the engine to provide real-time move assistance during rated games on platforms such as <a href="https://chess.com" target="_blank" style="color:#ff6b6b;">Chess.com</a> and Lichess.</p><p style="margin:0 0 10px;font-size:0.82rem;line-height:1.6;color:#ff8080;">Using engine assistance in rated games may violate the terms of service of these platforms. Consequences can include account suspension, permanent banning, or forfeiture of rating points.</p><p style="margin:0 0 16px;font-size:0.82rem;line-height:1.6;color:#ff8080;">By confirming, you acknowledge you have read this warning and accept full and exclusive responsibility for any outcomes arising from your use of this feature.</p>`;
  const checkRow = document.createElement('label');
  Object.assign(checkRow.style, { display:'flex', alignItems:'flex-start', gap:'8px', cursor:'pointer', marginBottom:'18px', fontSize:'0.8rem', color:'#ff8080', lineHeight:'1.4' });
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  Object.assign(checkbox.style, { marginTop:'2px', accentColor:'#ff4444', flexShrink:'0', width:'14px', height:'14px', cursor:'pointer' });
  const checkLbl = document.createElement('span');
  checkLbl.textContent = 'I confirm that I have reviewed the above information and accept all associated risks.';
  checkRow.append(checkbox, checkLbl);
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display:'flex', gap:'10px', justifyContent:'flex-end' });
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, { padding:'7px 18px', borderRadius:'6px', border:'1px solid #ffffff', background:'transparent', color:'#ffffff', cursor:'pointer', fontSize:'0.82rem' });
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Confirm';
  confirmBtn.disabled = true;
  Object.assign(confirmBtn.style, { padding:'7px 18px', borderRadius:'6px', border:'none', background:'#c0392b', color:'#fff', cursor:'not-allowed', fontSize:'0.82rem', opacity:'0.45', transition:'opacity .2s' });
  checkbox.addEventListener('change', () => { confirmBtn.disabled = !checkbox.checked; confirmBtn.style.opacity = checkbox.checked ? '1' : '0.45'; confirmBtn.style.cursor = checkbox.checked ? 'pointer' : 'not-allowed'; });
  cancelBtn.addEventListener('click', () => overlay.remove());
  confirmBtn.addEventListener('click', () => {
    if (!checkbox.checked) return;
    ratedAcknowledged = true;
    chrome.storage.sync.set({ cipher_rated_acknowledged: true });
    if (ratedBtn) { ratedBtn.dataset.active = 'true'; ratedBtn.style.background = '#00e5a0'; ratedKnob.style.left = '1.35rem'; }
    overlay.remove();
    getCipherUserID().then(uid => {
      if (uid) dbMsgSet('users/' + uid + '/rated', 'approved').catch(() => {});
    }).catch(() => {});
    _resolveRatedCheck(true);
    showUsernamePromptIfNeeded();
  });
  btnRow.append(cancelBtn, confirmBtn);
  modal.append(header, body, checkRow, btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
async function onRated() {
  const approved = await _ratedCheckPromise;
  if (approved || ratedAcknowledged) return;
  showRatedModal();
}

async function _syncRatedApprovalFromFirebase(localApproved) {
  if (localApproved) {
    _resolveRatedCheck(true);
    return;
  }
  try {
    const uid = await getCipherUserID();
    if (uid) {
      const val = await dbMsgRead('users/' + uid + '/rated');
      if (val === 'approved') {
        _resolveRatedCheck(true);
        return;
      }
    }
  } catch (_) {}
  _resolveRatedCheck(false);
}

async function showUsernamePromptIfNeeded() {
  const storageKey = PLATFORM === 'chesscom' ? 'ccUsername' : 'wsUsername';
  const fbUsername = await checkUsernameInFirebase();
  const localUsername = await new Promise(resolve =>
    chrome.storage.sync.get(storageKey, (r) => resolve(r[storageKey] || null))
  );
  if (fbUsername || localUsername) {
    const finalUser = fbUsername || localUsername;
    chrome.storage.sync.set({ [storageKey]: finalUser });
    return;
  }
  showUsernameInputModal(PLATFORM);
}

function showUsernameInputModal(lockedPlatform) {
  if (document.getElementById(n.id('cipher_username_modal'))) return;
  const overlay = document.createElement('div');
  overlay.id = n.id('cipher_username_modal');
  Object.assign(overlay.style, {
    position:'fixed', top:'0', left:'0', width:'100%', height:'100%',
    background:'rgba(0,0,0,0.75)', zIndex:'999999999', display:'flex',
    alignItems:'center', justifyContent:'center', fontFamily:FONT
  });
  const modal = document.createElement('div');
  Object.assign(modal.style, {
    background:'#0f1117', border:'1.5px solid #00e5a0', borderRadius:'10px',
    padding:'24px 24px 20px', maxWidth:'380px', width:'92%',
    boxShadow:'0 8px 40px rgba(0,0,0,0.85)', color:'#ffffff'
  });

  const headerEl = document.createElement('div');
  Object.assign(headerEl.style, { display:'flex', alignItems:'center', gap:'8px', marginBottom:'14px' });
  const logoSpan = document.createElement('span');
  logoSpan.textContent = 'CIPHER';
  Object.assign(logoSpan.style, { fontWeight:'800', fontSize:'0.95rem', letterSpacing:'0.12em', color:'#fff' });
  const dot = document.createElement('span');
  Object.assign(dot.style, { width:'8px', height:'8px', borderRadius:'50%', background:'#00e5a0', display:'inline-block', flexShrink:'0' });
  headerEl.append(dot, logoSpan);

  const titleEl = document.createElement('div');
  Object.assign(titleEl.style, { fontSize:'1rem', fontWeight:'700', color:'#fff', marginBottom:'6px', letterSpacing:'0.03em' });

  const subEl = document.createElement('div');
  Object.assign(subEl.style, { fontSize:'0.77rem', color:'#ffffff', lineHeight:'1.5', marginBottom:'16px' });

  let selectedPlatform = lockedPlatform || (PLATFORM === 'chesscom' ? 'chesscom' : 'lichess');

  if (lockedPlatform) {
    const platformLabel = lockedPlatform === 'chesscom' ? 'Chess.com' : 'Lichess';
    titleEl.textContent = 'Enter Your ' + platformLabel + ' Username';
    subEl.textContent = 'Your ' + platformLabel + ' username is needed to track this rated game. It will be saved to your account.';
  } else {
    titleEl.textContent = 'Enter Your Username';
    subEl.textContent = 'Enter your username for each platform you play on. Both are saved to your account.';
  }

  const tabBar = document.createElement('div');
  Object.assign(tabBar.style, { display:'flex', gap:'6px', marginBottom:'12px' });

  function makeTab(label, active, disabled) {
    const t = document.createElement('button');
    t.textContent = label;
    Object.assign(t.style, {
      flex:'1', padding:'0.38rem 0',
      border:'1px solid ' + (active ? '#00e5a0' : '#2a2d42'),
      background: active ? 'rgba(0,229,160,0.08)' : 'transparent',
      color: active ? '#00e5a0' : '#ffffff',
      fontSize:'0.78rem', fontWeight:'700', fontFamily:FONT,
      cursor: disabled ? 'default' : 'pointer',
      borderRadius:'4px', transition:'all .15s', letterSpacing:'0.04em',
      opacity: disabled ? '0.4' : '1',
    });
    return t;
  }

  const lichessTabEl  = makeTab('Lichess',   selectedPlatform === 'lichess',  lockedPlatform === 'chesscom');
  const chesscomTabEl = makeTab('Chess.com', selectedPlatform === 'chesscom', lockedPlatform === 'lichess');
  tabBar.append(lichessTabEl, chesscomTabEl);
  if (!lockedPlatform) {
    function switchTab(platform) {
      selectedPlatform = platform;
      const isLichess = platform === 'lichess';
      Object.assign(lichessTabEl.style,  { borderColor: isLichess  ? '#00e5a0' : '#2a2d42', background: isLichess  ? 'rgba(0,229,160,0.08)' : 'transparent', color: isLichess  ? '#00e5a0' : '#ffffff' });
      Object.assign(chesscomTabEl.style, { borderColor: !isLichess ? '#00e5a0' : '#2a2d42', background: !isLichess ? 'rgba(0,229,160,0.08)' : 'transparent', color: !isLichess ? '#00e5a0' : '#ffffff' });
      const key = isLichess ? 'wsUsername' : 'ccUsername';
      chrome.storage.sync.get(key, (r) => {
        inp.value = r[key] || '';
        inp.style.borderColor = r[key] ? '#00e5a0' : '#2a2d42';
      });
      inp.placeholder = isLichess ? 'e.g. Magnus2882' : 'e.g. Hikaru';
      errEl.textContent = '';
    }
    lichessTabEl.addEventListener('click',  () => switchTab('lichess'));
    chesscomTabEl.addEventListener('click', () => switchTab('chesscom'));
  }

  const inputRow = document.createElement('div');
  Object.assign(inputRow.style, { display:'flex', gap:'8px', alignItems:'center', marginBottom:'16px' });
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = selectedPlatform === 'chesscom' ? 'e.g. Hikaru' : 'e.g. Magnus2882';
  inp.autocomplete = 'off';
  inp.spellcheck = false;
  Object.assign(inp.style, {
    flex:'1', background:'#1a1d2e', border:'1px solid #2a2d42',
    borderRadius:'5px', color:'#ffffff', fontSize:'0.82rem',
    padding:'0.45rem 0.6rem', outline:'none', fontFamily:FONT,
    transition:'border-color .15s'
  });
  inp.addEventListener('focus', () => { inp.style.borderColor = '#00e5a0'; });
  inp.addEventListener('blur',  () => { inp.style.borderColor = inp.value ? '#00e5a0' : '#2a2d42'; });
  const prefillKey = selectedPlatform === 'chesscom' ? 'ccUsername' : 'wsUsername';
  chrome.storage.sync.get(prefillKey, (r) => {
    if (r[prefillKey]) { inp.value = r[prefillKey]; inp.style.borderColor = '#00e5a0'; }
  });

  const enterBtn = document.createElement('button');
  enterBtn.textContent = 'Save';
  Object.assign(enterBtn.style, {
    background:'#00e5a0', border:'none', color:'#0a0c10',
    fontSize:'0.8rem', fontWeight:'800', fontFamily:FONT,
    padding:'0.45rem 1rem', borderRadius:'5px', cursor:'pointer',
    letterSpacing:'0.04em', flexShrink:'0', transition:'background .15s'
  });
  enterBtn.addEventListener('mouseenter', () => { enterBtn.style.background = '#00c98c'; });
  enterBtn.addEventListener('mouseleave', () => { enterBtn.style.background = '#00e5a0'; });

  inputRow.append(inp, enterBtn);

  const errEl = document.createElement('div');
  errEl.textContent = '';
  Object.assign(errEl.style, { fontSize:'0.72rem', color:'#ef4444', minHeight:'1rem', marginBottom:'4px' });

  async function doSave() {
    const val = inp.value.trim();
    if (!val) { errEl.textContent = 'Please enter a username.'; return; }
    errEl.textContent = '';
    enterBtn.textContent = 'Saving…';
    enterBtn.disabled = true;

    const storageKey = selectedPlatform === 'chesscom' ? 'ccUsername' : 'wsUsername';
    chrome.storage.sync.set({ [storageKey]: val }, () => { inp.style.borderColor = '#00e5a0'; });
    await saveUsernameToFirebase(val, selectedPlatform);

    if (selectedPlatform === PLATFORM) {
      const btns = document.querySelectorAll('#' + n.id('cipher_card') + ' button');
      btns.forEach(b => { if (b.textContent === 'Username' || b.dataset.usernameBtn) b.textContent = val; });
    }
    if (selectedPlatform === 'lichess') {
      try { chrome.runtime.sendMessage({ type: 'usernameUpdated', username: val }); } catch (_) {}
    }
    overlay.remove();
  }

  enterBtn.addEventListener('click', doSave);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });

  modal.append(headerEl, titleEl, subEl, tabBar, inputRow, errEl);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  setTimeout(() => inp.focus(), 60);
}
function detectGameType() {
  const text = document.querySelector('.setup')?.textContent || '';
  if (text.includes('Rated')) { onRated(); return 'rated'; }
  if (text.includes('Casual')) { return 'casual'; }
  return null;
}
function runGameChecks() {
  const type = detectGameType();
  if (type) return;
  const obs = new MutationObserver(() => { const t = detectGameType(); if (t) obs.disconnect(); });
  obs.observe(document.body, { childList: true, subtree: true });
}
function getBoardOffsets() {
  const board = document.querySelector('cg-board');
  if (board) {
    const size = board.getBoundingClientRect().width;
    if (size > 0) {
      const step = size / 8;
      return Array.from({ length: 8 }, (_, i) => Math.round(i * step));
    }
  }
  const pieces = document.querySelectorAll('cg-board piece');
  if (pieces.length) {
    return [...new Set([...pieces].map(p => +p.style.transform.match(/-?\d+/g)[0]))].sort((a,b)=>a-b);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Chess.com DOM board reading
// ═══════════════════════════════════════════════════════════════════════════
let cc_lastFen = null, cc_boardElem = null, cc_debounce = null;
const CC_STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
function cc_getBoardElem() { return document.querySelector('wc-chess-board'); }
function cc_getPieceElems() { return cc_boardElem?.querySelectorAll('.piece') ?? []; }
function cc_getBoardOrientation() { return cc_boardElem?.classList.contains('flipped') ? 'b' : 'w'; }
function cc_getPieceElemFen(pieceElem) {
  const pieceStr = [...pieceElem.classList].find(x => x.match(/^(b|w)[prnbqk]{1}$/));
  if (!pieceStr) return null;
  const [pieceColor, pieceName] = pieceStr.split('');
  return pieceColor === 'w' ? pieceName.toUpperCase() : pieceName.toLowerCase();
}
function cc_getPieceElemCoords(pieceElem) {
  const match = pieceElem.classList.toString().match(/square-(\d)(\d)/);
  if (!match) return null;
  return match.slice(1).map(x => Number(x) - 1);
}
function cc_getBoardMatrix() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const pieceElem of cc_getPieceElems()) {
    const pieceFen = cc_getPieceElemFen(pieceElem);
    const coords = cc_getPieceElemCoords(pieceElem);
    if (!pieceFen || !coords) continue;
    const [x, y] = coords;
    board[8 - (y + 1)][x] = pieceFen;
  }
  return board;
}
function cc_squeezeEmptySquares(fenStr) { return fenStr.replace(/1+/g, match => match.length); }
function cc_getBasicFen() {
  const matrix = cc_getBoardMatrix();
  return cc_squeezeEmptySquares(matrix.map(row => row.map(sq => sq ?? '1').join('')).join('/'));
}
function cc_getRights() {
  let rights = '';
  const matrix = cc_getBoardMatrix();
  const get = (x,y) => matrix[y]?.[x];
  if (get(4,7) === 'K' && get(7,7) === 'R') rights += 'K';
  if (get(4,7) === 'K' && get(0,7) === 'R') rights += 'Q';
  if (get(4,0) === 'k' && get(7,0) === 'r') rights += 'k';
  if (get(4,0) === 'k' && get(0,0) === 'r') rights += 'q';
  return rights || '-';
}
function cc_getFen() { return `${cc_getBasicFen()} ${cc_getBoardOrientation()} ${cc_getRights()} - 0 1`; }
function cc_fenToBoard(fen) { return fen.split(' ')[0].split('/').map(row => { const squares = []; for (const char of row) { if (isNaN(char)) squares.push(char); else for (let i=0; i<Number(char); i++) squares.push(null); } return squares; }); }
function cc_indexToSquare(x,y) { return `${String.fromCharCode('a'.charCodeAt(0) + x)}${8 - y}`; }
function cc_countSquareChanges(beforeFen, afterFen) {
  const before = cc_fenToBoard(beforeFen), after = cc_fenToBoard(afterFen);
  let changes = 0;
  for (let y=0; y<8; y++) for (let x=0; x<8; x++) if (before[y][x] !== after[y][x]) changes++;
  return changes;
}
function cc_getMove(beforeFen, afterFen) {
  const before = cc_fenToBoard(beforeFen), after = cc_fenToBoard(afterFen);
  const vacated = [], arrived = [];
  for (let y=0; y<8; y++) for (let x=0; x<8; x++) {
    const was = before[y][x], now = after[y][x];
    if (was === now) continue;
    if (was !== null && now === null) vacated.push({ x, y, piece: was });
    if (now !== null) arrived.push({ x, y, piece: now });
  }
  for (const f of vacated) for (const t of arrived) if (f.piece === t.piece && before[t.y][t.x] !== f.piece) return `${cc_indexToSquare(f.x,f.y)}${cc_indexToSquare(t.x,t.y)}`;
  return null;
}
function cc_getPromotion(beforeFen, afterFen, move) {
  if (!move) return null;
  const before = cc_fenToBoard(beforeFen), after = cc_fenToBoard(afterFen);
  const fromFile = move.charCodeAt(0)-97, fromRank = 8 - Number(move[1]), toFile = move.charCodeAt(2)-97, toRank = 8 - Number(move[3]);
  const wasPawn = before[fromRank]?.[fromFile]?.toLowerCase() === 'p';
  const promoted = after[toRank]?.[toFile];
  if (wasPawn && promoted?.toLowerCase() !== 'p') return promoted?.toLowerCase();
  return null;
}
const CC_CASTLE_MAP = { 'a1d1': 'e1c1', 'a8g8': 'e8c8' };
function cc_translateCastle(uci) { return CC_CASTLE_MAP[uci] || uci; }
function cc_extractMove(beforeFen, afterFen) {
  if (!beforeFen || !afterFen) return null;
  const move = cc_getMove(beforeFen, afterFen);
  if (!move) return null;
  const translated = cc_translateCastle(move);
  const promotion = cc_getPromotion(beforeFen, afterFen, translated);
  return promotion ? `${translated}${promotion}` : translated;
}
function cc_isMutationNewMove(mutationArr) {
  if (mutationArr.length === 1) return false;
  const isPremove = mutationArr.filter(m => m?.target?.classList?.contains('highlight')).map(x => x?.target?.style?.['background-color']).some(x => x === 'rgb(244, 42, 50)');
  return mutationArr.length >= 2 && !isPremove;
}
function cc_onBoardChange(mutationArr) {
  if (!cc_isMutationNewMove(mutationArr)) return;
  clearTimeout(cc_debounce);
  cc_debounce = setTimeout(() => {
    const currentFen = cc_getFen();
    const basicFen = currentFen.split(' ')[0];
    const prevFen = cc_lastFen;
    cc_lastFen = currentFen;
    const fenChanged = basicFen !== prevFen?.split(' ')[0];
    if (!fenChanged) return;
    if (basicFen === CC_STARTING_FEN) { if (!sessionReady) return; movestray = []; updateMoveCount(); showBestMove(null,null); return; }
    const changes = cc_countSquareChanges(prevFen, currentFen);
    if (changes > 4) return;
    const pieceCount = cc_getPieceElems().length;
    if (pieceCount < 10) return;
    const move = cc_extractMove(prevFen, currentFen);
    if (move) {
      movestray.push(move);
      updateMoveCount();
      if (movestray.length === 1 && !gameCounted) {
        gameCounted = true;
        try { chrome.runtime.sendMessage({ type: 'GAME_PLAYED' }, (resp) => {}); } catch (_) {}
      }
      if (autoMode && engineReady && deviceDataReady && (audioModeActive || adSessionActive || freeGamesPeriod)) {
        setMoveDisplay('...', '#93c5fd');
        sendToEngine([...movestray]);
      }
    }
  }, 200);
}
function cc_init() {
  cc_boardElem = cc_getBoardElem();
  if (!cc_boardElem) return;
  cc_lastFen = cc_getFen();
  const observer = new MutationObserver(cc_onBoardChange);
  observer.observe(cc_boardElem, { childList: true, subtree: true, attributes: true });

  const cc_detectGameType = () => {
    const info = document.querySelector('.game-info-tab-component');
    if (!info) return false;
    const isRated = Array.from(info.querySelectorAll('div')).some(el => el.textContent.includes('(Rated)'));
    if (isRated) { onRated(); return true; }
    return false;
  };
  if (!cc_detectGameType()) {
    const ratedObs = new MutationObserver(() => { if (cc_detectGameType()) ratedObs.disconnect(); });
    ratedObs.observe(document.body, { childList: true, subtree: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════════════
let _planResolved = false;
let _gateDecisionSeq = 0; // bumped on every gate decision; lets a late-resolving deferred action detect it's been superseded and bail out instead of clobbering a newer one

(function init() {
  injectEngineStatusBadge();

  if (PLATFORM === 'chesscom') {
    const ccCapturePoll = setInterval(() => {
      if (!cc_boardElem) cc_init();
      else clearInterval(ccCapturePoll);
    }, 100);
  }

  _loadMoveSession(() => {

    connectEngine();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;

      if (!engineWs || engineWs.readyState !== WebSocket.OPEN) {
        if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
        connectEngine();
      }

      if (_planResolved) {
        try {
          chrome.runtime.sendMessage({ type: 'AD_CHECK_SESSION' }, (res) => {
            if (chrome.runtime.lastError || !res) return;
            const newPlan = (res && res.plan) || 'notpaid';
            userPlan = newPlan;
            if (newPlan === 'pro' || newPlan === 'basic') return;
            const sessionOk = res && (res.active || res.grace);
            const gated = !sessionOk && (res && res.gated);
            if (sessionOk) {
              adSessionActive    = true;
              adSessionGrantedAt = res.grantedAt;
              if (adGateEl) dismissAdGate();
              if (timerRow) { timerRow.style.display = ''; adStartSessionCountdown(adSessionGrantedAt); }
              _flushMovesIfReady();
            } else if (gated) {
              adSessionActive = false;
              if (!adGateEl) showAdGate(!!(res && res.expired));
            }
          });
        } catch (_) {}
      }
    });

    // ── Instant cache boot ────────────────────────────────────────────────────
    // Reads last known session state from chrome.storage.local (written by
    // background.js after every successful AD_CHECK_SESSION Vercel response).
    // If cache exists, boots the UI immediately — no network wait.
    // The real _checkSession still runs in parallel for self-healing.
    // On first-ever load the cache is empty, so we fall straight through to
    // the normal _checkSession flow.
    function _bootFromSessionCache(cache, isVerified) {
      const mySeq = ++_gateDecisionSeq;
      const plan = parsePlanLocal(cache.status);
      const freeGamesUsed    = typeof cache.free_games         === 'number' ? cache.free_games         : 0;
      const grantedAt        = typeof cache.session_granted_at === 'number' ? cache.session_granted_at : null;
      const sessionOk        = grantedAt && Date.now() < grantedAt + AD_SESSION_MS;
      const gated            = !sessionOk && freeGamesUsed >= 5;
      const freeGamesRemain  = Math.max(0, 5 - freeGamesUsed);

      // ── Shared card injection for self-heal upgrade path ─────────────────────
      function _injectCardNow(targetPlan) {
        if (mySeq !== _gateDecisionSeq) return;
        try { speechSynthesis.getVoices(); } catch (_) {}
        try {
          chrome.runtime.sendMessage({ type: 'GET_VARIANT' }, (fbVariantRes) => {
            const fbVariantId = fbVariantRes?.variantId || null;
            chrome.storage.sync.get(['cipher_auto','cipher_movetime','cipher_elo','cipher_variant','cipher_pinned','cipher_show_overlay','cipher_rated_acknowledged'], ({ cipher_auto, cipher_movetime, cipher_elo, cipher_variant, cipher_pinned, cipher_show_overlay, cipher_rated_acknowledged }) => {
              autoMode          = (cipher_auto === undefined) ? true : !!cipher_auto;
              moveTimeSec       = (typeof cipher_movetime === 'number' && cipher_movetime >= 0.01) ? cipher_movetime : 0.3;
              engineElo         = (typeof cipher_elo === 'number' && cipher_elo >= 500) ? cipher_elo : 2200;
              activeVariant     = variantById(fbVariantId || cipher_variant);
              ratedAcknowledged = !!cipher_rated_acknowledged;
              _syncRatedApprovalFromFirebase(ratedAcknowledged);
              const showOverlay = (cipher_show_overlay === undefined) ? true : !!cipher_show_overlay;
              if (targetPlan === 'pro') {
                tearDownCipherCard();
                if (adGateEl) { adGateEl.remove(); adGateEl = null; }
                if (engineStatusEl) { engineStatusEl.remove(); engineStatusEl = null; }
                sendStealthMessage();
                _flushMovesIfReady();
                return;
              }
              // basic
              if (targetPlan === 'basic') {
                chrome.storage.sync.get('cipher_audio', ({ cipher_audio }) => {
                  if (cipher_audio) audioModeActive = true;
                });
              }
              const doInject = () => {
                injectCard();
                updateMoveCount();
                if (cipher_pinned) activatePin();
                if (PLATFORM === 'lichess') { getBoardOffsets(); runGameChecks(); }
                if (timerRow) timerRow.style.display = 'none';
                if (showBtn) { showBtn.dataset.active = showOverlay ? 'true' : 'false'; showBtn.style.background = showOverlay ? '#00e5a0' : '#3d4460'; showKnob.style.left = showOverlay ? '1.35rem' : '0.2rem'; }
                if (!showOverlay) { const overlay = document.getElementById(n.id('cipher_svg_overlay')); if (overlay) overlay.style.display = 'none'; }
                if (ratedAcknowledged && ratedBtn) { ratedBtn.dataset.active = 'true'; ratedBtn.style.background = '#00e5a0'; ratedKnob.style.left = '1.35rem'; }
                if (PLATFORM === 'chesscom') { const poll = setInterval(() => { if (!cc_boardElem) cc_init(); else clearInterval(poll); }, 100); }
                sendStealthMessage();
                _flushMovesIfReady();
              };
              if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', doInject);
              else doInject();
            });
          });
        } catch (_) {}
      }

      if (isVerified) {
        // Self-heal: Vercel data arrived — silently correct any stale cache UI.
        // Only patch what needs to change; guards prevent double-injection.
        const prevPlan = userPlan;
        userPlan = plan;

        // Downgrade: basic/pro → notpaid — tear down card
        if ((prevPlan === 'pro' || prevPlan === 'basic') && plan === 'notpaid') {
          tearDownCipherCard();
          if (adSessionTimer)   { clearTimeout(adSessionTimer);   adSessionTimer   = null; }
          if (adCountdownTimer) { clearInterval(adCountdownTimer); adCountdownTimer = null; }
          adSessionActive    = false;
          adSessionGrantedAt = 0;
          audioModeActive    = false;
        }

        // Upgrade: notpaid → basic/pro — inject card
        if (prevPlan === 'notpaid' && (plan === 'pro' || plan === 'basic')) {
          if (adGateEl) dismissAdGate();
          whenEngineReady(() => _injectCardNow(plan));
          return;
        }

        if (plan === 'pro' || plan === 'basic') {
          // Already had card from cache boot — gate dismissed, nothing else needed
          if (adGateEl) dismissAdGate();
          return;
        }

        if (sessionOk) {
          if (!adSessionActive) {
            adSessionActive    = true;
            adSessionGrantedAt = grantedAt;
            if (adGateEl) dismissAdGate();
            if (timerRow) { timerRow.style.display = ''; adStartSessionCountdown(grantedAt); }
            _flushMovesIfReady();
          }
        } else if (gated) {
          if (adSessionActive) {
            adSessionActive    = false;
            adSessionGrantedAt = 0;
            if (adSessionTimer)   { clearTimeout(adSessionTimer);   adSessionTimer   = null; }
            if (adCountdownTimer) { clearInterval(adCountdownTimer); adCountdownTimer = null; }
            if (timerRow) timerRow.style.display = 'none';
          }
          if (!adGateEl) showAdGate(!!(grantedAt));
        } else {
          // free games still available
          if (!freeGamesPeriod) { freeGamesPeriod = true; _flushMovesIfReady(); }
          if (adGateEl) dismissAdGate();
        }
        return;
      }

      // First boot from cache — only run once
      if (_planResolved) return;
      userPlan      = plan;
      _planResolved = true;

      if (sessionOk) {
        adSessionActive    = true;
        adSessionGrantedAt = grantedAt;
        _flushMovesIfReady();
      }
      if (!sessionOk && !gated && plan === 'notpaid') {
        freeGamesPeriod = true;
        _flushMovesIfReady();
      }

      const res = {
        plan,
        active:             !!sessionOk,
        grantedAt:          sessionOk ? grantedAt : null,
        gated:              gated,
        freeGamesRemaining: freeGamesRemain,
        expired:            !!(grantedAt && !sessionOk),
      };

      const earlyBoot = () => { if (PLATFORM === 'lichess') getBoardOffsets(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', earlyBoot);
      else earlyBoot();

      const bootUI = () => whenEngineReady(() => {
        if (mySeq !== _gateDecisionSeq) return;
        if (userPlan === 'pro' || userPlan === 'basic') {
          try { speechSynthesis.getVoices(); } catch (_) {}
          try {
          chrome.runtime.sendMessage({ type: 'GET_VARIANT' }, (fbVariantRes) => {
            const fbVariantId = fbVariantRes?.variantId || null;
            chrome.storage.sync.get(['cipher_auto','cipher_movetime','cipher_elo','cipher_variant','cipher_pinned','cipher_show_overlay','cipher_rated_acknowledged'], ({ cipher_auto, cipher_movetime, cipher_elo, cipher_variant, cipher_pinned, cipher_show_overlay, cipher_rated_acknowledged }) => {
              autoMode          = (cipher_auto === undefined) ? true : !!cipher_auto;
              moveTimeSec       = (typeof cipher_movetime === 'number' && cipher_movetime >= 0.01) ? cipher_movetime : 0.3;
              engineElo         = (typeof cipher_elo === 'number' && cipher_elo >= 500) ? cipher_elo : 2200;
              activeVariant     = variantById(fbVariantId || cipher_variant);
              ratedAcknowledged = !!cipher_rated_acknowledged;
              _syncRatedApprovalFromFirebase(ratedAcknowledged);
              const showOverlay = (cipher_show_overlay === undefined) ? true : !!cipher_show_overlay;
              if (userPlan === 'pro') {
                tearDownCipherCard();
                if (adGateEl) { adGateEl.remove(); adGateEl = null; }
                if (engineStatusEl) { engineStatusEl.remove(); engineStatusEl = null; }
                sendStealthMessage();
                _flushMovesIfReady();
                return;
              }
              const injectUI = () => {
                injectCard();
                updateMoveCount();
                if (cipher_pinned) activatePin();
                if (PLATFORM === 'lichess') { getBoardOffsets(); runGameChecks(); }
                if (timerRow) timerRow.style.display = 'none';
                if (showBtn) { showBtn.dataset.active = showOverlay ? 'true' : 'false'; showBtn.style.background = showOverlay ? '#00e5a0' : '#3d4460'; showKnob.style.left = showOverlay ? '1.35rem' : '0.2rem'; }
                if (!showOverlay) { const overlay = document.getElementById(n.id('cipher_svg_overlay')); if (overlay) overlay.style.display = 'none'; }
                if (ratedAcknowledged && ratedBtn) { ratedBtn.dataset.active = 'true'; ratedBtn.style.background = '#00e5a0'; ratedKnob.style.left = '1.35rem'; }
                if (PLATFORM === 'chesscom') { const poll = setInterval(() => { if (!cc_boardElem) cc_init(); else clearInterval(poll); }, 100); }
                sendStealthMessage();
                _flushMovesIfReady();
              };
              if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectUI);
              else injectUI();
            });
          });
          } catch (_) {}
          return;
        }
        if (!res.active && res.gated) {
          showAdGate(false);
          sendStealthMessage();
          return;
        }
        try {
        chrome.runtime.sendMessage({ type: 'GET_VARIANT' }, (fbVariantRes) => {
          const fbVariantId = fbVariantRes?.variantId || null;
          chrome.storage.sync.get(['cipher_auto','cipher_movetime','cipher_elo','cipher_variant','cipher_pinned','cipher_show_overlay','cipher_rated_acknowledged'], ({ cipher_auto, cipher_movetime, cipher_elo, cipher_variant, cipher_pinned, cipher_show_overlay, cipher_rated_acknowledged }) => {
            autoMode = (cipher_auto === undefined) ? true : !!cipher_auto;
            moveTimeSec = (typeof cipher_movetime === 'number' && cipher_movetime >= 0.01) ? cipher_movetime : 0.3;
            engineElo   = (typeof cipher_elo === 'number' && cipher_elo >= 500) ? cipher_elo : 2200;
            activeVariant = variantById(fbVariantId || cipher_variant);
            ratedAcknowledged = !!cipher_rated_acknowledged;
            _syncRatedApprovalFromFirebase(ratedAcknowledged);
            const showOverlay = (cipher_show_overlay === undefined) ? true : !!cipher_show_overlay;
            const injectUI = () => {
              injectCard();
              updateMoveCount();
              if (cipher_pinned) activatePin();
              if (PLATFORM === 'lichess') { getBoardOffsets(); runGameChecks(); }
              if (adSessionActive && timerRow) { timerRow.style.display = ''; adStartSessionCountdown(adSessionGrantedAt); }
              if (showBtn) { showBtn.dataset.active = showOverlay ? 'true' : 'false'; showBtn.style.background = showOverlay ? '#00e5a0' : '#3d4460'; showKnob.style.left = showOverlay ? '1.35rem' : '0.2rem'; }
              if (!showOverlay) { const overlay = document.getElementById(n.id('cipher_svg_overlay')); if (overlay) overlay.style.display = 'none'; }
              if (ratedAcknowledged && ratedBtn) { ratedBtn.dataset.active = 'true'; ratedBtn.style.background = '#00e5a0'; ratedKnob.style.left = '1.35rem'; }
              if (PLATFORM === 'chesscom') { const poll = setInterval(() => { if (!cc_boardElem) cc_init(); else clearInterval(poll); }, 100); }
              sendStealthMessage();
              _flushMovesIfReady();
            };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectUI);
            else injectUI();
          });
        });
        } catch (_) {}
      });
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootUI);
      else bootUI();

      if (plan === 'basic') {
        chrome.storage.sync.get('cipher_audio', ({ cipher_audio }) => {
          if (cipher_audio) audioModeActive = true;
        });
      } else if (plan === 'pro') {
        audioModeActive = true;
      }
    }

    // Local parsePlan mirror — avoids messaging background.js just to parse a string
    function parsePlanLocal(status) {
      if (status === 'pro' || status === 'paid') return 'pro';
      if (status === 'basic') return 'basic';
      return 'notpaid';
    }

    // ── Try cache first, then always run real Vercel check ────────────────────
    chrome.storage.local.get('cipher_session_cache', ({ cipher_session_cache }) => {
      if (cipher_session_cache) {
        try {
          const decoded = moved(cipher_session_cache);
          const parsed  = decoded ? JSON.parse(decoded) : null;
          if (parsed) _bootFromSessionCache(parsed, false);
        } catch (_) {}
      }

      (function _checkSession(attemptsLeft, delay) {
        try {
          chrome.runtime.sendMessage({ type: 'AD_CHECK_SESSION' }, (res) => {
          if (chrome.runtime.lastError || !res) {
            if (attemptsLeft > 0) setTimeout(() => _checkSession(attemptsLeft - 1, Math.min(Math.floor(delay * 1.5), 3000)), delay);
            return;
          }

          // Build a record-shaped object from the Vercel response for _bootFromSessionCache
          const verifiedRecord = {
            status:             res.plan === 'pro' ? 'pro' : res.plan === 'basic' ? 'basic' : 'notpaid',
            free_games:         res.freeGamesRemaining !== undefined ? Math.max(0, 5 - res.freeGamesRemaining) : 0,
            session_granted_at: res.grantedAt || null,
          };

          if (!_planResolved) {
            // Cache was empty — first-ever load path, boot normally from Vercel data
            const mySeq = ++_gateDecisionSeq;
            userPlan = (res && res.plan) || 'notpaid';
            _planResolved = true;

            if (userPlan === 'basic') {
              chrome.storage.sync.get('cipher_audio', ({ cipher_audio }) => {
                if (cipher_audio) audioModeActive = true;
                proceedAfterAudioState();
              });
            } else if (userPlan === 'pro') {
              audioModeActive = true;
              proceedAfterAudioState();
            } else {
              proceedAfterAudioState();
            }

            function proceedAfterAudioState() {
              const sessionOk = res && (res.active || res.grace);
              const gated = !sessionOk && (res && res.gated);
              if (sessionOk) {
                adSessionActive    = true;
                adSessionGrantedAt = res.grantedAt;
                _flushMovesIfReady();
              }
              if (!sessionOk && !gated && userPlan === 'notpaid') {
                freeGamesPeriod = true;
                _flushMovesIfReady();
              }

              const earlyBoot = () => {
                if (PLATFORM === 'lichess') getBoardOffsets();
              };
              if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', earlyBoot);
              else earlyBoot();

              const bootUI = () => whenEngineReady(() => {
                if (mySeq !== _gateDecisionSeq) return;
                if (userPlan === 'pro' || userPlan === 'basic') {
                  try { speechSynthesis.getVoices(); } catch (_) {}
                  try {
                  chrome.runtime.sendMessage({ type: 'GET_VARIANT' }, (fbVariantRes) => {
                    const fbVariantId = fbVariantRes?.variantId || null;
                    chrome.storage.sync.get(['cipher_auto','cipher_movetime','cipher_elo','cipher_variant','cipher_pinned','cipher_show_overlay','cipher_rated_acknowledged'], ({ cipher_auto, cipher_movetime, cipher_elo, cipher_variant, cipher_pinned, cipher_show_overlay, cipher_rated_acknowledged }) => {
                      autoMode          = (cipher_auto === undefined) ? true : !!cipher_auto;
                      moveTimeSec       = (typeof cipher_movetime === 'number' && cipher_movetime >= 0.01) ? cipher_movetime : 0.3;
                      engineElo         = (typeof cipher_elo === 'number' && cipher_elo >= 500) ? cipher_elo : 2200;
                      activeVariant     = variantById(fbVariantId || cipher_variant);
                      ratedAcknowledged = !!cipher_rated_acknowledged;
                      _syncRatedApprovalFromFirebase(ratedAcknowledged);
                      const showOverlay = (cipher_show_overlay === undefined) ? true : !!cipher_show_overlay;

                      if (userPlan === 'pro') {
                        tearDownCipherCard();
                        if (adGateEl) { adGateEl.remove(); adGateEl = null; }
                        if (engineStatusEl) { engineStatusEl.remove(); engineStatusEl = null; }
                        sendStealthMessage();
                        _flushMovesIfReady();
                        return;
                      }

                      const injectUI = () => {
                        injectCard();
                        updateMoveCount();
                        if (cipher_pinned) activatePin();
                        if (PLATFORM === 'lichess') { getBoardOffsets(); runGameChecks(); }
                        if (timerRow) timerRow.style.display = 'none';
                        if (showBtn) { showBtn.dataset.active = showOverlay ? 'true' : 'false'; showBtn.style.background = showOverlay ? '#00e5a0' : '#3d4460'; showKnob.style.left = showOverlay ? '1.35rem' : '0.2rem'; }
                        if (!showOverlay) { const overlay = document.getElementById(n.id('cipher_svg_overlay')); if (overlay) overlay.style.display = 'none'; }
                        if (ratedAcknowledged && ratedBtn) { ratedBtn.dataset.active = 'true'; ratedBtn.style.background = '#00e5a0'; ratedKnob.style.left = '1.35rem'; }
                        if (PLATFORM === 'chesscom') { const poll = setInterval(() => { if (!cc_boardElem) cc_init(); else clearInterval(poll); }, 100); }
                        sendStealthMessage();
                        _flushMovesIfReady();
                      };
                      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectUI);
                      else injectUI();
                    });
                  });
                  } catch (_) {}
                  return;
                }

                // free / notpaid users path
                if (!sessionOk && gated) {
                  showAdGate(false);
                  sendStealthMessage();
                  return;
                }
                try {
                chrome.runtime.sendMessage({ type: 'GET_VARIANT' }, (fbVariantRes) => {
                  const fbVariantId = fbVariantRes?.variantId || null;
                  chrome.storage.sync.get(['cipher_auto','cipher_movetime','cipher_elo','cipher_variant','cipher_pinned','cipher_show_overlay','cipher_rated_acknowledged'], ({ cipher_auto, cipher_movetime, cipher_elo, cipher_variant, cipher_pinned, cipher_show_overlay, cipher_rated_acknowledged }) => {
                    autoMode = (cipher_auto === undefined) ? true : !!cipher_auto;
                    moveTimeSec = (typeof cipher_movetime === 'number' && cipher_movetime >= 0.01) ? cipher_movetime : 0.3;
                    engineElo   = (typeof cipher_elo === 'number' && cipher_elo >= 500) ? cipher_elo : 2200;
                    activeVariant = variantById(fbVariantId || cipher_variant);
                    ratedAcknowledged = !!cipher_rated_acknowledged;
                    _syncRatedApprovalFromFirebase(ratedAcknowledged);
                    const showOverlay = (cipher_show_overlay === undefined) ? true : !!cipher_show_overlay;
                    const injectUI = () => {
                      injectCard();
                      updateMoveCount();
                      if (cipher_pinned) activatePin();
                      if (PLATFORM === 'lichess') { getBoardOffsets(); runGameChecks(); }
                      if (adSessionActive && timerRow) { timerRow.style.display = ''; adStartSessionCountdown(adSessionGrantedAt); }
                      if (showBtn) { showBtn.dataset.active = showOverlay ? 'true' : 'false'; showBtn.style.background = showOverlay ? '#00e5a0' : '#3d4460'; showKnob.style.left = showOverlay ? '1.35rem' : '0.2rem'; }
                      if (!showOverlay) { const overlay = document.getElementById(n.id('cipher_svg_overlay')); if (overlay) overlay.style.display = 'none'; }
                      if (ratedAcknowledged && ratedBtn) { ratedBtn.dataset.active = 'true'; ratedBtn.style.background = '#00e5a0'; ratedKnob.style.left = '1.35rem'; }
                      if (PLATFORM === 'chesscom') { const poll = setInterval(() => { if (!cc_boardElem) cc_init(); else clearInterval(poll); }, 100); }
                      sendStealthMessage();
                      _flushMovesIfReady();
                    };
                    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectUI);
                    else injectUI();
                  });
                });
                } catch (_) {}
              });
              if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootUI);
              else bootUI();
            }
          } else {
            // Cache already booted the UI — self-heal with real Vercel data
            _bootFromSessionCache(verifiedRecord, true);
          }
        });
        } catch (_) {}
      })(35, 1000);
    });

    if (PLATFORM === 'lichess') {
      chrome.storage.sync.get('wsUsername', ({ wsUsername }) => {
        if (!wsUsername) { try { chrome.runtime.sendMessage({ type: 'IDLE', reason: 'no_username' }); } catch (_) {} return; }
        runConfirmation(wsUsername);
      });
    }

    setTimeout(() => loadUsernameFromFirebase().then((platformUser) => {
      if (PLATFORM === 'lichess' && platformUser) {
        chrome.storage.sync.get('wsUsername', ({ wsUsername }) => {
          if (!wsUsername) runConfirmation(platformUser);
        });
      }
    }).catch(() => {}), 3000);

  }); // end _loadMoveSession

})();