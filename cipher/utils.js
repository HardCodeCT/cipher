/**
 * cipher-names.js  —  Cipher DOM name randomiser
 *
 * HOW IT WORKS
 * ────────────────────────────────────────────────────────────────────────────
 * After AD_CHECK_SESSION resolves and the plan is known, call:
 *
 *   CipherNames.init(userPlan);   // 'pro' | 'basic' | 'notpaid'
 *
 * From that point every n.id() / n.cls() call returns:
 *   • pro   → a random token (re-generated on every page load)
 *   • basic / notpaid → the original literal string, unchanged
 *
 * All injection functions (injectCard, injectEngineStatusBadge, showAdGate …)
 * must be called AFTER init() so they pick up the right tokens.
 *
 * ON URL CHANGE  (pro only)
 *   Call n.rotate() after tearing down all live DOM elements, before
 *   re-injecting.  This gives the new page session completely fresh tokens.
 *
 * ── TOKEN FORMAT ─────────────────────────────────────────────────────────────
 *   <1-2 alpha prefix>_<5 alphanum body>_<1 alpha suffix>
 *   Example:  "mq_9k2pa_r"
 *
 * ── DEBUG ─────────────────────────────────────────────────────────────────
 *   CipherNames.debug = true   →  id/cls return canonical key (no obfuscation)
 *   CipherNames.dump()         →  inspect the live mapping table
 */

const CipherNames = (() => {

  // ── Canonical → original literal  (used verbatim for basic / notpaid) ──────
  //
  //   key                    original literal in content.js
  //   ─────────────────────  ─────────────────────────────────
  const ID_ORIGINALS = {
    cipher_card:           '__cipher_card',
    cipher_ad_gate:        '__cipher_ad_gate',
    cipher_audio_gate:     '__cipher_audio_gate',
    cipher_engine_status:  '__cipher_engine_status',
    cipher_audio_btn:      '__cipher_audio_btn',
    cipher_svg_overlay:    'cipher-svg-overlay',
    cipher_move_editor:    'cipher-move-editor-overlay',
    cipher_rated_modal:    'cipher-rated-modal',
    cipher_username_modal: 'cipher-username-modal',
  };

  const CLASS_ORIGINALS = {
    move_display:   'cipher-move-display',
    timer_row:      'cipher-timer-row',
    timer_display:  'cipher-timer-display',
    timer_label:    'cipher-timer-label',
    card_req_btn:   'cipher-req-btn',
    card_auto_btn:  'cipher-auto-btn',
    card_count:     'cipher-move-count',
    card_time_input:'cipher-time-input',
    variant_label:  'cipher-variant-label',
    dropdown:       'cipher-dropdown',
    pinned_card:    'cipher-pinned-card',
    pinned_move:    'cipher-pinned-move',
  };

  // ── Token generator ───────────────────────────────────────────────────────
  const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const ALPHA  = 'abcdefghijklmnopqrstuvwxyz';

  function rc(pool) { return pool[Math.floor(Math.random() * pool.length)]; }
  function rs(n, pool) { let s = ''; for (let i = 0; i < n; i++) s += rc(pool); return s; }

  function makeToken(pfx) {
    return pfx + '_' + rs(5, CHARS) + '_' + rc(ALPHA);
  }

  // ── Internal state ────────────────────────────────────────────────────────
  let _ready    = false;   // true after init() has been called
  let _isPro    = false;
  let _idMap    = {};      // key → resolved token/original
  let _classMap = {};
  let _prefix   = '';

  function _buildRandom() {
    _prefix = rs(1 + Math.floor(Math.random() * 2), ALPHA);
    const used = new Set();
    function unique() {
      let t;
      do { t = makeToken(_prefix); } while (used.has(t));
      used.add(t);
      return t;
    }
    _idMap    = {};
    _classMap = {};
    Object.keys(ID_ORIGINALS).forEach(k    => { _idMap[k]    = unique(); });
    Object.keys(CLASS_ORIGINALS).forEach(k => { _classMap[k] = unique(); });
  }

  function _buildFixed() {
    _idMap    = { ...ID_ORIGINALS };
    _classMap = { ...CLASS_ORIGINALS };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  const api = {
    debug: false,

    /**
     * Must be called once, right after AD_CHECK_SESSION resolves and userPlan
     * is set, before any UI injection.
     *
     * @param {'pro'|'basic'|'notpaid'} plan
     */
    init(plan) {
      _isPro  = (plan === 'pro');
      _ready  = true;
      if (_isPro) _buildRandom();
      else        _buildFixed();
    },

    /**
     * Rotate tokens (pro only).  Call after tearing down all live DOM nodes,
     * before re-injecting on URL change.  No-op for basic / notpaid.
     */
    rotate() {
      if (!_ready || !_isPro) return;
      _buildRandom();
    },

    /**
     * Resolve an ID key → current token.
     * Falls back to the original literal if init() hasn't been called yet
     * (safety net — should not happen in normal flow).
     */
    id(key) {
      if (this.debug) return key;
      if (!_ready) return ID_ORIGINALS[key] || key;
      return _idMap[key] || key;
    },

    /**
     * Resolve a class key → current token.
     */
    cls(key) {
      if (this.debug) return key;
      if (!_ready) return CLASS_ORIGINALS[key] || key;
      return _classMap[key] || key;
    },

    /** Returns true only for pro after init() */
    get isPro() { return _isPro; },

    /** Inspect live tables (devtools) */
    dump() {
      return { plan: _isPro ? 'pro' : 'other', prefix: _prefix, ids: {..._idMap}, classes: {..._classMap} };
    },
  };

  return api;
})();
