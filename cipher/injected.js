(function () {
  if (window.__cipherActive) return;
  window.__cipherActive = true;

  const OriginalWebSocket = window.WebSocket;
  let counter = 0;

  function dispatch(direction, url, data) {
    let payload, type = 'text';
    if (typeof data === 'string') {
      payload = data;
    } else if (data instanceof ArrayBuffer) {
      payload = `[ArrayBuffer ${data.byteLength} bytes]`; type = 'binary';
    } else if (data instanceof Blob) {
      payload = `[Blob ${data.size} bytes]`; type = 'binary';
    } else {
      payload = String(data);
    }
    window.postMessage({ __cipher: true, id: ++counter, direction, url, payload, type, timestamp: Date.now() }, '*');
  }

  window.WebSocket = function (...args) {
    const ws  = new OriginalWebSocket(...args);
    const url = args[0];
    ws.addEventListener('open',    ()  => dispatch('OPEN',     url, 'Connection established'));
    ws.addEventListener('close',   e   => dispatch('CLOSE',    url, `Closed (code ${e.code})`));
    ws.addEventListener('message', e   => dispatch('RECEIVED', url, e.data));
    const origSend = ws.send.bind(ws);
    ws.send = function (data) { dispatch('SENT', url, data); origSend(data); };
    return ws;
  };
  Object.keys(OriginalWebSocket).forEach(k => window.WebSocket[k] = OriginalWebSocket[k]);
  window.WebSocket.prototype = OriginalWebSocket.prototype;

  // ── History patch — content.js can't touch history so we do it here ─────────
  function notifyNav() {
    window.postMessage({ __wsNavigation: true, url: location.href }, '*');
  }
  const _push    = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState    = function (...a) { _push(...a);    notifyNav(); };
  history.replaceState = function (...a) { _replace(...a); notifyNav(); };
  window.addEventListener('popstate', notifyNav);

  console.log('[Cipher] Active ✓');
})();
