/**
 * background.js — Vercel gateway is the single source of truth.
 * All Firebase reads/writes are routed through the secure gateway endpoint.
 * UID is NEVER stored in chrome.storage.local — it is derived fresh from the
 * device fingerprint on every service worker boot and cached only in memory
 * for the lifetime of that service worker instance.
 */

// ===================== GATEWAY CONFIG =====================
const GATEWAY_URL = "https://cipherweb-mu.vercel.app/api"

async function gatewayRequest(uid, path, method, data) {
  const body = { uid, path, method };
  if (data !== undefined) body.data = data;
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Gateway error ${res.status}`);
  return json.data;
}

async function dbRead(uid, path) {
  return gatewayRequest(uid, path, "GET");
}

async function dbSet(uid, path, value) {
  return gatewayRequest(uid, path, "PUT", value);
}

async function dbUpdate(uid, path, updates) {
  return gatewayRequest(uid, path, "PATCH", updates);
}

// dbCreate and dbDelete are admin-only operations — kept as direct stubs
// that will be rejected by the gateway for regular users.
async function dbCreate(uid, path, value) {
  return gatewayRequest(uid, path, "PUT", value);
}

// ===================== FINGERPRINT =====================
let _extraSignals = [];
let _cachedFingerprint = null;
let _fingerprintPromise = null;

let _deviceData = null;
let _deviceDataResolve = null;
const _deviceDataPromise = new Promise((resolve) => {
    _deviceDataResolve = resolve;
});
// FIX 1: Guard against SW restart where content.js already sent DEVICE_DATA
// before the new SW instance booted — without this timeout _deviceDataPromise
// hangs forever, freezing getUID() and every message handler that calls it.
setTimeout(() => {
    if (_deviceDataResolve) { _deviceDataResolve(); _deviceDataResolve = null; }
}, 12_000);

let _extraSignalsResolve = null;
const _extraSignalsPromise = new Promise((resolve) => {
    _extraSignalsResolve = resolve;
});
setTimeout(() => {
    if (_extraSignalsResolve) { _extraSignalsResolve(); _extraSignalsResolve = null; }
}, 10_000);

async function generateFingerprint() {
  const parts = [];
  if (_extraSignals.length) {
    parts.push(..._extraSignals);
  }
  if (_deviceData) {
    parts.push('dev:' + _deviceData);
  }
  const raw = parts.join('|');
  const encoded = new TextEncoder().encode(raw);
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function getDeviceFingerprint() {
  if (_cachedFingerprint) return _cachedFingerprint;
  if (!_fingerprintPromise) {
    _fingerprintPromise = (async () => {
      await Promise.all([_deviceDataPromise, _extraSignalsPromise]);
      _cachedFingerprint = await generateFingerprint();
      return _cachedFingerprint;
    })();
  }
  return _fingerprintPromise;
}

function uidFromFingerprint(fingerprint) {
  return 'cipher_' + fingerprint;
}

async function getUID() {
  const fp = await getDeviceFingerprint();
  return uidFromFingerprint(fp);
}

// Sync chrome.storage.sync usernames from Firebase record
async function syncUsernameFromRecord(record) {
  if (!record) return;
  const updates = {};
  if (record.lichess_username)  updates.wsUsername = record.lichess_username;
  if (record.chesscom_username) updates.ccUsername = record.chesscom_username;
  if (Object.keys(updates).length) await chrome.storage.sync.set(updates);
}

// ===================== USER DATA =====================
// Fetches the full user record in one Vercel trip.
// All fields (status, free_games, session_granted_at) come from this single fetch.
// Retries up to MAX_ATTEMPTS times with a delay between each — guards against
// Vercel cold starts and flaky mobile networks without silently falling back
// to a fake record that would suppress the ad gate.
async function getUserData() {
  const uid = await getUID();

  const MAX_ATTEMPTS = 10;
  const RETRY_DELAY_MS = 1500;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const record = await dbRead(uid, `users/${uid}`);
      if (!record) {
        // First-time user — create them
        const fresh = { status: 'notpaid', free_games: 0, session_granted_at: null, created_at: Date.now() };
        await dbSet(uid, `users/${uid}`, fresh);
        return { uid, record: fresh };
      }
      await syncUsernameFromRecord(record);
      return { uid, record };
    } catch (_) {
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  // All 10 attempts failed — only now use the safe fallback
  return { uid, record: { status: 'notpaid', free_games: 0, session_granted_at: null } };
}

function parsePlan(status) {
  if (status === 'pro' || status === 'paid') return 'pro';
  if (status === 'basic') return 'basic';
  return 'notpaid';
}

// ===================== SESSION CACHE (chrome.storage.local) =====================
// Writes a snapshot of the user record to local storage after every successful
// AD_CHECK_SESSION Vercel response. On next page load, content.js reads this
// cache instantly and boots the UI without waiting for the Vercel round trip.
// The real Vercel check always still runs in the background for self-healing.
const SESSION_CACHE_KEY = 'cipher_session_cache';

// ===================== CACHE ENCODING =====================
// moves(str) → encoded string   |   moved(str) → original string
// No libraries. XOR with a position-derived rolling key, then
// re-encoded with a shuffled alphabet so it reads as gibberish.
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

function writeSessionCache(record) {
  try {
    const payload = JSON.stringify({
      status:             record.status             ?? 'notpaid',
      free_games:         record.free_games         ?? 0,
      session_granted_at: record.session_granted_at ?? null,
      cached_at:          Date.now(),
    });
    chrome.storage.local.set({ [SESSION_CACHE_KEY]: moves(payload) });
  } catch (_) {}
}

async function readSessionCache() {
  try {
    const data = await chrome.storage.local.get(SESSION_CACHE_KEY);
    const raw = data[SESSION_CACHE_KEY];
    if (!raw) return null;
    const decoded = moved(raw);
    if (!decoded) return null;
    return JSON.parse(decoded);
  } catch (_) { return null; }
}

// ===================== SESSION =====================
const THIRTY_MIN_MS = 30 * 60 * 1000;

async function saveSessionGrantedAt(grantedAt) {
  try {
    const uid = await getUID();
    // Gateway enforces the 26-minute cooldown server-side
    await dbSet(uid, `users/${uid}/session_granted_at`, grantedAt);
  } catch (_) {}
}

async function grantSession(grantedAt, targetTabId) {
  await saveSessionGrantedAt(grantedAt);
  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, { type: 'AD_SESSION_GRANTED', grantedAt }).catch(() => {});
  }
  chrome.tabs.query({ url: ['https://lichess.org/*', 'https://www.chess.com/*', 'https://chess.com/*'] }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id !== targetTabId) {
        chrome.tabs.sendMessage(tab.id, { type: 'AD_SESSION_GRANTED', grantedAt }).catch(() => {});
      }
    }
  });
}

// ===================== FREE GAMES COUNTER =====================
async function incrementFreeGamesCount(uid, current) {
  try {
    const next = current + 1;
    await dbSet(uid, `users/${uid}/free_games`, next);
    const active = next >= 5;
    return { count: next, active };
  } catch (_) {
    return { count: current, active: false };
  }
}

// ===================== MOVE TRACKING =====================
const store = {};
const MAX = 5000;
function getStore(url) {
  if (!store[url]) store[url] = [];
  return store[url];
}
function dumpToFile(messages, filename) {
  const lines = [];
  messages.forEach(m => {
    try {
      const parsed = JSON.parse(m.payload);
      if (parsed.t === 'move' && parsed.d?.uci) lines.push(parsed.d.uci);
    } catch (_) {}
  });
  if (!lines.length) return;
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: filename + '.txt', saveAs: false, conflictAction: 'uniquify' },
    () => URL.revokeObjectURL(url));
}

let activeUrl = null;
const adTabMap = new Map();

// ===================== MESSAGE LISTENER =====================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'FINGERPRINT_SIGNALS') {
    if (Array.isArray(msg.signals) && msg.signals.length && !_cachedFingerprint) {
      _extraSignals = msg.signals;
    }
    if (_extraSignalsResolve) { _extraSignalsResolve(); _extraSignalsResolve = null; }
    return;
  }

  if (msg.type === 'DEVICE_DATA') {
    if (msg.data && !_deviceData) {
      _deviceData = msg.data;
      if (_deviceDataResolve) { _deviceDataResolve(); _deviceDataResolve = null; }
    }
    return;
  }

  // Gateway CRUD passthrough (admin panel / popup direct calls)
  if (['DB_CREATE','DB_READ','DB_SET','DB_UPDATE','DB_DELETE'].includes(msg.type)) {
    (async () => {
      try {
        const uid = await getUID();
        let result;
        const method = msg.type === 'DB_READ' ? 'GET'
          : (msg.type === 'DB_CREATE' || msg.type === 'DB_SET') ? 'PUT'
          : msg.type === 'DB_UPDATE' ? 'PATCH'
          : null;
        if (!method) throw new Error('DB_DELETE not supported via gateway for regular users');
        result = await gatewayRequest(uid, msg.path, method, msg.value);
        sendResponse({ data: result });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // Game played
  if (msg.type === 'GAME_PLAYED') {
    (async () => {
      const { uid, record } = await getUserData();
      const current = typeof record.free_games === 'number' ? record.free_games : 0;
      const result = await incrementFreeGamesCount(uid, current);
      sendResponse(result);
    })();
    return true;
  }

  // Session check — 1 Vercel trip, all fields read from single record
  if (msg.type === 'AD_CHECK_SESSION') {
    (async () => {
      const { record } = await getUserData();
      writeSessionCache(record); // persist for instant load on next page
      const plan = parsePlan(record.status);

      if (plan === 'pro') {
        sendResponse({ active: true, grantedAt: Date.now(), gated: false, plan: 'pro' });
        return;
      }

      if (plan === 'basic') {
        sendResponse({ active: true, grantedAt: Date.now(), gated: false, plan: 'basic' });
        return;
      }

      const freeGamesUsed = typeof record.free_games === 'number' ? record.free_games : 0;
      const grantedAt = typeof record.session_granted_at === 'number' ? record.session_granted_at : null;

      if (freeGamesUsed < 5) {
        const sessionActive = grantedAt && Date.now() < grantedAt + THIRTY_MIN_MS;
        sendResponse({
          active: !!sessionActive,
          grantedAt: sessionActive ? grantedAt : null,
          gated: false,
          plan: 'notpaid',
          freeGamesRemaining: 5 - freeGamesUsed,
        });
        return;
      }

      if (!grantedAt) {
        sendResponse({ active: false, grantedAt: null, gated: true, plan: 'notpaid' });
        return;
      }

      const expiresAt = grantedAt + THIRTY_MIN_MS;
      if (Date.now() < expiresAt) {
        sendResponse({ active: true, grantedAt, gated: false, plan: 'notpaid' });
      } else {
        sendResponse({ active: false, grantedAt, gated: true, expired: true, plan: 'notpaid' });
      }
    })();
    return true;
  }

  // Open ad tab — 1 Vercel trip
  if (msg.type === 'AD_OPEN_TAB') {
    (async () => {
      const { record } = await getUserData();
      const plan = parsePlan(record.status);
      if (plan === 'pro' || plan === 'basic') return;
      const freeGamesUsed = typeof record.free_games === 'number' ? record.free_games : 0;
      if (freeGamesUsed < 5) {
        await grantSession(Date.now(), sender.tab?.id);
        return;
      }
      const sourceTabId = sender.tab?.id;
      chrome.tabs.create({ url: 'https://cipherad-ten.vercel.app/', active: true }, (tab) => {
        if (sourceTabId !== undefined) adTabMap.set(tab.id, sourceTabId);
        const onRemoved = (tabId) => {
          if (tabId === tab.id) { adTabMap.delete(tab.id); chrome.tabs.onRemoved.removeListener(onRemoved); }
        };
        chrome.tabs.onRemoved.addListener(onRemoved);
      });
    })();
    return;
  }

  // Ad page clicked — 1 Vercel trip
  if (msg.type === 'AD_PAGE_CLICKED') {
    (async () => {
      const { record } = await getUserData();
      const plan = parsePlan(record.status);
      if (plan === 'pro' || plan === 'basic') return;
      const adTabId = sender.tab?.id;
      const requestingTabId = adTabMap.get(adTabId);
      const grantedAt = msg.grantedAt || Date.now();
      await grantSession(grantedAt, requestingTabId);
      if (adTabId) adTabMap.delete(adTabId);
      chrome.tabs.create({ url: chrome.runtime.getURL('clicked.html'), active: true });
    })();
    return;
  }

  // Request user ID
  if (msg.type === 'REQUEST_USER_ID') {
    (async () => {
      const uid = await getUID();
      sendResponse({ userId: uid });
    })();
    return true;
  }

  // Get ad site data — 1 Vercel trip
  if (msg.type === 'GET_AD_SITE_DATA') {
    (async () => {
      const { uid, record } = await getUserData();
      sendResponse({ userId: uid, status: parsePlan(record.status) });
    })();
    return true;
  }

  // WS message
  if (msg.type === 'WS_MESSAGE') {
    const url = activeUrl || sender.tab?.url || 'unknown';
    const list = getStore(url);
    list.push(msg.data);
    if (list.length > MAX) list.shift();
    chrome.runtime.sendMessage({ type: 'WS_UPDATE', entry: msg.data }).catch(() => {});
    return;
  }

  // Confirmed
  if (msg.type === 'CONFIRMED') {
    activeUrl = msg.url;
    chrome.runtime.sendMessage({ type: 'STATUS', status: 'capturing', color: msg.color, url: msg.url }).catch(() => {});
    return;
  }

  // URL changed
  if (msg.type === 'URL_CHANGED') {
    if (activeUrl) delete store[activeUrl];
    activeUrl = msg.url;
    chrome.runtime.sendMessage({ type: 'STATUS', status: 'new_game', url: msg.url }).catch(() => {});
    return;
  }

  // Idle
  if (msg.type === 'IDLE') {
    chrome.runtime.sendMessage({ type: 'STATUS', status: 'idle', reason: msg.reason }).catch(() => {});
    return;
  }

  // Popup history
  if (msg.type === 'GET_HISTORY') {
    sendResponse({ messages: getStore(activeUrl || '') });
    return true;
  }

  // Popup dump
  if (msg.type === 'DUMP') {
    const messages = getStore(activeUrl || '');
    if (!messages.length) { sendResponse({ ok: false }); return true; }
    dumpToFile(messages, `lichess-moves-${Date.now()}`);
    sendResponse({ ok: true });
    return true;
  }

  // Popup clear
  if (msg.type === 'CLEAR') {
    if (activeUrl) store[activeUrl] = [];
    sendResponse({ ok: true });
    return;
  }

  // Username updated
  if (msg.type === 'usernameUpdated') {
    chrome.tabs.query({ url: 'https://lichess.org/*' }, (tabs) => {
      tabs.forEach(tab => { chrome.tabs.sendMessage(tab.id, { type: 'usernameUpdated', username: msg.username }).catch(() => {}); });
    });
    return;
  }

  // Save username to Firebase via gateway
  if (msg.type === 'SAVE_USERNAME') {
    (async () => {
      const { uid, record } = await getUserData();
      try {
        const platform = msg.platform || 'lichess';
        const platformField = platform === 'chesscom' ? 'chesscom_username' : 'lichess_username';
        const updates = { [platformField]: msg.username };
        if (!record.first_username) {
          updates.first_username = msg.username;
        }
        await dbUpdate(uid, 'users/' + uid, updates);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // Get username — 1 Vercel trip
  if (msg.type === 'GET_USERNAME') {
    (async () => {
      try {
        const { record } = await getUserData();
        sendResponse({
          lichess_username:  record?.lichess_username  || null,
          chesscom_username: record?.chesscom_username || null,
          first_username:    record?.first_username    || null,
        });
      } catch (e) {
        sendResponse({ lichess_username: null, chesscom_username: null, first_username: null });
      }
    })();
    return true;
  }

  // Save variant via gateway
  if (msg.type === 'SAVE_VARIANT') {
    (async () => {
      try {
        const uid = await getUID();
        await dbSet(uid, `users/${uid}/variant`, msg.variantId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  // Get variant — 1 Vercel trip
  if (msg.type === 'GET_VARIANT') {
    (async () => {
      try {
        const { record } = await getUserData();
        sendResponse({ variantId: record.variant || null });
      } catch (e) {
        sendResponse({ variantId: null });
      }
    })();
    return true;
  }

  return false;
});

// ===================== STARTUP =====================
// chrome.storage.session defaults to TRUSTED_CONTEXTS only (service worker /
// extension pages). content.js needs to read/write it directly for refresh
// persistence of the move tray, so we explicitly widen access here. This
// must run on every SW boot, not just install, since the flag doesn't
// persist across service worker restarts.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

chrome.runtime.onInstalled.addListener(() => {
  getUserData().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  getUID().catch(() => {});
});
getUID().catch(() => {});

// ===================== KEEP-ALIVE (FIX 6) =====================
// Wakes the SW every minute to prevent Android from killing it during
// active browsing sessions. Reduces cold restart frequency on low-end devices.
// Requires "alarms" in manifest permissions.
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') getUID().catch(() => {});
});

// ===================== PERSISTENT PORT =====================
// When content.js holds an open port to the SW, the browser treats the SW
// as "in use" and suppresses the idle-kill timer entirely for the duration.
// This is strictly better than the alarm for the case where a chess tab is
// open — the SW simply never goes idle. The alarm is the fallback for when
// no chess tab is open.
// Ping-pong: content.js sends { type: 'ping' } every 25 s; we reply with
// { type: 'pong' } so the SW processes a real message and stays active.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onMessage.addListener((msg) => {
      if (msg.type === 'ping') {
        try { port.postMessage({ type: 'pong' }); } catch (_) {}
      }
    });
    port.onDisconnect.addListener(() => {});
  }
});