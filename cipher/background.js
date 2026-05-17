/**
 * background.js
 * Stores moves per game URL. Handles URL changes and reloads.
 */

const store = {}; // { [url]: Message[] }
const MAX   = 5000;

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
  const url  = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename: filename + '.txt',
    saveAs: false,
    conflictAction: 'uniquify',
  }, () => URL.revokeObjectURL(url));
}

let activeUrl = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // WS message from content script
  if (msg.type === 'WS_MESSAGE') {
    const url = activeUrl || sender.tab?.url || 'unknown';
    const list = getStore(url);
    list.push(msg.data);
    if (list.length > MAX) list.shift();
    chrome.runtime.sendMessage({ type: 'WS_UPDATE', entry: msg.data }).catch(() => {});
    return;
  }

  // Confirmed — username + orientation matched
  if (msg.type === 'CONFIRMED') {
    activeUrl = msg.url;
    chrome.runtime.sendMessage({ type: 'STATUS', status: 'capturing', color: msg.color, url: msg.url }).catch(() => {});
    return;
  }

  // URL changed — new game, wipe old store
  if (msg.type === 'URL_CHANGED') {
    if (activeUrl) delete store[activeUrl];
    activeUrl = msg.url;
    chrome.runtime.sendMessage({ type: 'STATUS', status: 'new_game', url: msg.url }).catch(() => {});
    return;
  }

  // Idle — username not found or no username set
  if (msg.type === 'IDLE') {
    chrome.runtime.sendMessage({ type: 'STATUS', status: 'idle', reason: msg.reason }).catch(() => {});
    return;
  }

  // Popup requesting history
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
});
