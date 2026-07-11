/**
 * ad-click.js
 * Runs on https://cipherad-ten.vercel.app/
 * State (userID, free_games, session timestamp) lives entirely in Firebase,
 * via background.js. This script never persists anything itself — it just
 * relays the UID to the page for display (window event, not localStorage)
 * and reports the click so background.js can grant the session.
 */

// ─── Ad blocker detection (combined network + DOM) ───────────────────────────
// Stage 1 — network probe: attempts to HEAD several URLs that major blockers
//   block at the request level (uBlock hard mode, Brave Shields, AdGuard).
//   A thrown fetch = blocked; any response (even opaque) = not blocked.
//   Multiple distinct ad-network URLs, not just one, since some blockers
//   redirect a single well-known script (e.g. adsbygoogle.js) to a local
//   no-op stub instead of canceling it outright — that stub still resolves
//   without throwing, so relying on one URL alone can miss that case.
// Stage 2 — DOM bait: catches blockers that work via CSS/element hiding
//   (AdBlock Plus, some AdGuard modes) rather than network interception.
//   Two differently-named bait elements, not one — some anti-circumvention
//   filter lists specifically avoid hiding one well-known bait pattern, so
//   a second, differently-shaped one reduces the chance both get a pass.
// Running both gives materially better coverage than either method alone,
// though neither stage can catch a blocker that isn't actually blocking
// anything (e.g. AdBlock Plus's default "Acceptable Ads" mode) — that's a
// real, structural limit, not something either stage can be tuned around.
const BAIT_URLS = [
  'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
  'https://static.doubleclick.net/instream/ad_status.js',
  'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
  'https://www.googletagservices.com/tag/js/gpt.js',
];

async function detectAdBlocker() {
  // ── Stage 1: network-level probe ──────────────────────────────────────────
  for (const url of BAIT_URLS) {
    try {
      await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
      // Got a response (even opaque) — this URL wasn't blocked, move on
    } catch (_) {
      // fetch threw → request was intercepted by a blocker
      return true;
    }
  }

  // ── Stage 2: DOM bait ─────────────────────────────────────────────────────
  return new Promise((resolve) => {
    const baitA = document.createElement('div');
    baitA.className = 'adsbygoogle ad-banner ads ad pub_300x250 pub_300x250m pub_728x90';
    baitA.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none;';

    const baitB = document.createElement('div');
    baitB.className = 'textads banner-ad banner_ad ad-container adunit ad-slot';
    baitB.id = 'ad-container';
    baitB.style.cssText = 'position:absolute;top:-9999px;left:-8888px;width:1px;height:1px;pointer-events:none;';

    document.body.appendChild(baitA);
    document.body.appendChild(baitB);

    setTimeout(() => {
      const isHidden = (el) => {
        const style = window.getComputedStyle(el);
        return el.offsetHeight === 0        ||
               el.offsetParent === null     ||
               style.display     === 'none'   ||
               style.visibility  === 'hidden' ||
               style.opacity     === '0';
      };
      const blocked = isHidden(baitA) || isHidden(baitB);
      baitA.remove();
      baitB.remove();
      resolve(blocked);
    }, 200);
  });
}

// ─── Overlay UI ──────────────────────────────────────────────────────────────
// Shows a full-page overlay instructing the user to disable their ad blocker.
// Injected into the cipherad page itself so it's visible and contextual.
function showAdBlockerWarning() {
  // Avoid double-injecting
  if (document.getElementById('cipher-adblocker-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'cipher-adblocker-overlay';
  Object.assign(overlay.style, {
    position:       'fixed',
    inset:          '0',
    zIndex:         '2147483647',
    background:     'rgba(10,11,18,0.97)',
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    fontFamily:     "'Segoe UI', system-ui, sans-serif",
    padding:        '2rem',
    boxSizing:      'border-box',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    background:   '#0f1117',
    border:       '1px solid #ef4444',
    borderRadius: '10px',
    padding:      '2rem 2rem 1.75rem',
    maxWidth:     '420px',
    width:        '100%',
    boxShadow:    '0 1rem 3rem rgba(0,0,0,0.8)',
    textAlign:    'center',
    display:      'flex',
    flexDirection:'column',
    gap:          '1rem',
  });

  // Warning icon
  const icon = document.createElement('div');
  icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24"
    fill="none" stroke="#ef4444" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`;
  Object.assign(icon.style, { display:'flex', justifyContent:'center' });

  const title = document.createElement('div');
  title.textContent = 'Ad Blocker Detected';
  Object.assign(title.style, {
    fontSize:      '1.1rem',
    fontWeight:    '800',
    color:         '#ffffff',
    letterSpacing: '0.04em',
  });

  const msg = document.createElement('div');
  msg.innerHTML = `Your ad blocker is active on this page.<br>
    <strong style="color:#ffffff;">Disable it for this site</strong>, then
    <strong style="color:#ffffff;">refresh the page</strong> and click anywhere
    to unlock your 30-minute session.`;
  Object.assign(msg.style, {
    fontSize:   '0.85rem',
    color:      '#9ca3af',
    lineHeight: '1.65',
  });

  // Step list
  const steps = document.createElement('ol');
  Object.assign(steps.style, {
    textAlign:   'left',
    margin:      '0',
    paddingLeft: '1.2rem',
    display:     'flex',
    flexDirection:'column',
    gap:         '0.4rem',
  });
  [
    'Click your ad blocker icon in the browser toolbar',
    'Pause or disable it for <strong style="color:#fff;">cipherad-ten.vercel.app</strong>',
    'Refresh this page',
    'Click anywhere on the page to confirm',
  ].forEach((text) => {
    const li = document.createElement('li');
    li.innerHTML = text;
    Object.assign(li.style, { fontSize:'0.8rem', color:'#9ca3af', lineHeight:'1.5' });
    steps.appendChild(li);
  });

  // Refresh button — convenience shortcut
  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '↻  Refresh Page';
  Object.assign(refreshBtn.style, {
    background:    '#ef4444',
    border:        'none',
    borderRadius:  '6px',
    color:         '#ffffff',
    fontSize:      '0.88rem',
    fontWeight:    '700',
    padding:       '0.65rem 1.25rem',
    cursor:        'pointer',
    letterSpacing: '0.04em',
    transition:    'background .15s',
    marginTop:     '0.25rem',
  });
  refreshBtn.addEventListener('mouseenter', () => { refreshBtn.style.background = '#dc2626'; });
  refreshBtn.addEventListener('mouseleave', () => { refreshBtn.style.background = '#ef4444'; });
  refreshBtn.addEventListener('click', () => location.reload());

  card.append(icon, title, msg, steps, refreshBtn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// ─── Boot sequence ───────────────────────────────────────────────────────────
// 1. Relay userID to the page for display purposes.
chrome.runtime.sendMessage({ type: 'REQUEST_USER_ID' }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res?.userId) {
    window.dispatchEvent(new CustomEvent('cipher:userId', { detail: { userId: res.userId } }));
  }
});

// 2. Detect ad blocker. If present → show warning and DO NOT attach the click
//    listener, so a frustrated click on the overlay never grants a session.
//    If clear → attach the click listener as normal.
detectAdBlocker().then((blocked) => {
  if (blocked) {
    showAdBlockerWarning();
    return; // click listener is never registered
  }

  // No blocker — safe to register the session-granting click
  document.addEventListener('click', () => {
    const grantedAt = Date.now();
    chrome.runtime.sendMessage({ type: 'AD_PAGE_CLICKED', grantedAt });
  }, { once: true });
});