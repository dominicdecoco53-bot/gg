/* ═══════════════════════════════════════════════════════════════════════════
 *  HesitationEngine.js — Real-Time Micro-Hesitation Scoring Engine
 *  v1.0.0 · ES6+ · Zero dependencies · Framework-agnostic ES module
 * ─────────────────────────────────────────────────────────────────────────────
 *  OVERVIEW
 *  Attaches privacy-safe, strictly local telemetry to ONE high-value element
 *  (e.g. a "Buy Now" button) and continuously distills pointer / touch /
 *  scroll micro-behaviour into an immutable, structured state object:
 *
 *      {
 *        hesitation_score:        0–100   (int)   — live psychological friction
 *        confidence_level:        0.0–1.0 (float) — statistical certainty
 *        predicted_friction_type: "price_shock" | "security_distrust" |
 *                                 "device_distraction" | "high_intent"
 *      }
 *
 *  TELEMETRY CAPTURED (all reduced to O(1) scalar aggregates, never stored):
 *    • Hover duration & micro-pauses ......... dwell pressure on the target
 *    • Velocity vectors (v = Δd/Δt) .......... approach dynamics
 *    • Acceleration sign flips ............... start/stop indecision
 *    • Angular vector jitter ................. shaky, conflicted motor paths
 *    • Approach→retreat "friction loops" ..... aborted commitment cycles
 *    • Scroll reversals & settle inertia ..... comparison / price re-checking
 *
 *  PRIVACY CONTRACT (GDPR / CCPA aligned — by architecture, not by policy)
 *    1. 100% of computation happens inside the client session. The module
 *       performs NO network I/O of any kind (no fetch, XHR, beacon, socket).
 *    2. NO persistence of any kind: no cookies, localStorage, sessionStorage,
 *       IndexedDB, or writes of any sort. Everything lives in volatile RAM.
 *    3. Raw coordinates are consumed the instant they arrive and immediately
 *       folded into exponential moving averages and counters. No movement
 *       path, coordinate history, or replayable trace is EVER retained.
 *    4. The public state contains only abstract behavioural indices — no PII,
 *       no coordinates, no fingerprinting entropy.
 *    5. destroy() detaches every listener and zeroes every accumulator.
 *
 *  PERFORMANCE CONTRACT
 *    • All high-frequency listeners are passive and rAF-coalesced: at most
 *      ONE pointer sample and ONE scroll sample are processed per rendered
 *      frame, regardless of raw event rate (which can exceed 500 Hz on
 *      high-polling-rate mice).
 *    • The hot path allocates nothing. All statistics are incremental
 *      (EMA / decaying counters), so memory footprint is a fixed set of
 *      ~40 numeric slots — a few hundred bytes, independent of session length.
 *    • State objects are only allocated on emission (≤ ~8 Hz, and only when
 *      the rounded output actually changed).
 *
 *  RESPONSIBLE USE
 *    This engine is designed to help REMOVE friction — clarify a price,
 *    surface trust proof, offer help — not to pressure users. Pair its output
 *    with honest UX interventions and validate weights via A/B testing.
 *
 *  QUICK START
 *      import HesitationEngine from './HesitationEngine.js';
 *
 *      const engine = new HesitationEngine(document.querySelector('#buy-now'), {
 *        priceSelector:      '.product-price',   // optional context signal
 *        trustBadgeSelector: '.trust-badges',    // optional context signal
 *        onUpdate: (state) => {
 *          if (state.confidence_level < 0.35) return;           // not enough data yet
 *          switch (state.predicted_friction_type) {
 *            case 'security_distrust': revealTrustRow();  break; // reassure
 *            case 'price_shock':       revealValueHint(); break; // clarify value
 *            case 'device_distraction':                   break; // do nothing loud
 *            case 'high_intent':                          break; // stay out of the way
 *          }
 *        },
 *      });
 *      engine.start();
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────
 * SECTION 0 · Environment guards
 * ────────────────────────────────────────────────────────────────────────── */

const HAS_DOM =
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  typeof performance !== 'undefined';

/** Canonical friction-type vocabulary (exactly the four contract strings). */
const FRICTION = Object.freeze({
  PRICE_SHOCK: 'price_shock',
  SECURITY_DISTRUST: 'security_distrust',
  DEVICE_DISTRACTION: 'device_distraction',
  HIGH_INTENT: 'high_intent',
});

/* ─────────────────────────────────────────────────────────────────────────
 * SECTION 1 · Tunable runtime configuration (safe defaults)
 * ────────────────────────────────────────────────────────────────────────── */

const DEFAULTS = Object.freeze({
  /** Minimum ms between emitted state objects (event-driven path). */
  emitIntervalMs: 120,
  /** Low-cost background tick: drives idle detection + score decay. */
  heartbeatMs: 300,

  /* Approach / retreat hysteresis (distances measured from the element's
   * bounding-box EDGE, in CSS px). Enter and exit radii differ so boundary
   * noise cannot manufacture phantom friction loops. */
  approachEnterPx: 40,
  approachExitPx: 110,
  /** An approach must dwell this long (or visibly decelerate) to count as a
   *  genuine aborted commitment when the pointer withdraws. Filters fly-bys. */
  minApproachDwellMs: 90,

  /* Micro-pause detector (speed in px/ms, with hysteresis). */
  pauseSpeedEnter: 0.06,
  pauseSpeedExit: 0.12,
  pauseMinMs: 90,

  /* Acceleration-flip detector. */
  flipMinSpeed: 0.08,      // ignore flips while the pointer is basically at rest
  flipRefractoryMs: 60,    // debounce: max one counted flip per 60 ms

  /** Total telemetry silence (while page visible) before "device_distraction"
   *  evidence begins accruing. */
  idleDistractionMs: 1600,

  /** Radius (px from element edge) inside which behaviour is considered
   *  "about" the target. null → auto: max(140, 1.1 × element diagonal). */
  proximityRadiusPx: null,

  /* Scroll indecision detector. */
  scrollFlipMinPx: 24,     // a reversal must travel ≥ this to count
  scrollSettleSpeed: 0.05, // |px/ms| below which scrolling is "settled"
  scrollSettleHoldMs: 250, // must hold settled speed this long

  /** Optional selectors enriching classification (purely local lookups). */
  priceSelector: null,
  trustBadgeSelector: null,

  /** Include a frozen `diagnostics` block in emitted state (debug/tuning). */
  exposeDiagnostics: true,

  /** Convenience subscriber; equivalent to engine.subscribe(fn). */
  onUpdate: null,

  /** Start immediately from the constructor. */
  autoStart: false,
});

/* ─────────────────────────────────────────────────────────────────────────
 * SECTION 2 · Math primitives (pure, allocation-free)
 * ────────────────────────────────────────────────────────────────────────── */

/** Clamp to the unit interval. */
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Saturating normaliser: sat(x, k) = x / (x + k).
 *  Monotone, ∈ [0,1), equals 0.5 exactly at x = k ("half-saturation point").
 *  Chosen over hard clamps because human signals have diminishing returns:
 *  the 6th friction loop says little more than the 5th. */
const sat = (x, k) => (x <= 0 ? 0 : x / (x + k));

/** Linear ramp to 1 at `full` (used where linearity is desired, e.g. confidence). */
const ramp = (x, full) => clamp01(x / full);

/** Time-correct EMA blending factor for an update Δt ms apart, with time
 *  constant τ ms:  α = 1 − e^(−Δt/τ).  Makes smoothing frame-rate invariant. */
const emaAlpha = (dtMs, tauMs) => 1 - Math.exp(-dtMs / tauMs);

/** Wrap an angle to (−π, π]. */
const wrapAngle = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
};

/** Sign with a dead-band (returns 0 inside ±eps). */
const sgn = (x, eps) => (x > eps ? 1 : x < -eps ? -1 : 0);

const round3 = (x) => Math.round(x * 1000) / 1000;
const round2 = (x) => Math.round(x * 100) / 100;

/* ─────────────────────────────────────────────────────────────────────────
 * SECTION 3 · THE PROPRIETARY SCORING MODEL
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  Seven normalised features Xᵢ ∈ [0,1] are blended into a raw index:
 *
 *      S_raw = clamp01(  w_H·H  +  w_P·P  +  w_J·J  +  w_F·F  +  w_A·A
 *                      + w_S·S  +  w_syn·(J·F)^γ  −  w_B·B )
 *
 *      hesitation_score(t) = round( 100 · EMA(S_raw) )
 *          with ASYMMETRIC time constants  τ↑ = 350 ms,  τ↓ = 3800 ms
 *          — hesitation evidence must register almost instantly (so the host
 *          app can react in-moment) but dissipate slowly (one smooth second
 *          of movement should not erase a minute of visible conflict).
 *
 *  FEATURES
 *  ┌────┬──────────────────────────┬────────────────────────────────────────┐
 *  │ H  │ Hover pressure           │ sat(cumulative target-hover ms, 2600)  │
 *  │ P  │ Micro-pause density      │ sat(pauseCount + pauseMs/900, 3.2)     │
 *  │ J  │ Vector jitter            │ ramp(proximity-weighted EMA of |Δθ|    │
 *  │    │                          │      per sample, 0.9 rad)              │
 *  │ F  │ Friction loops           │ sat(approach→retreat count, 1.8)       │
 *  │ A  │ Acceleration instability │ sat(decaying flip counter (τ=1.5 s), 3)│
 *  │ S  │ Scroll indecision        │ 0.75·sat(qualified reversals, 2.6)     │
 *  │    │                          │ + 0.25·sat(max(settleMs−300,0), 1500)  │
 *  │ B  │ Intent bonus (ballistic  │ monotonicity × (1−jitter) ×            │
 *  │    │ approach quality)        │ ramp(peak v, 1.0 px/ms), decayed by    │
 *  │    │                          │ e^(−0.55·frictionLoops)                │
 *  └────┴──────────────────────────┴────────────────────────────────────────┘
 *
 *  WEIGHTS — behavioural rationale
 *  ┌────────┬──────┬──────────────────────────────────────────────────────┐
 *  │ w_H    │ 0.14 │ Long dwell = active deliberation, but alone is       │
 *  │        │      │ ambiguous (could be reading), so mid-weighted.       │
 *  │ w_P    │ 0.11 │ Micro-freezes inside the decision zone mark discrete │
 *  │        │      │ "should I?" moments; supportive, not decisive.       │
 *  │ w_J    │ 0.17 │ Angular jitter is the classic motor signature of     │
 *  │        │      │ approach–avoidance conflict; strongly weighted.      │
 *  │ w_F    │ 0.21 │ A completed approach→retreat is an ABORTED decision — │
 *  │        │      │ the single most literal hesitation event we can see. │
 *  │ w_A    │ 0.09 │ Accel flips overlap with J and P; kept low to avoid  │
 *  │        │      │ double counting the same physical behaviour.         │
 *  │ w_S    │ 0.11 │ Scroll reversals + slow settle indicate comparison / │
 *  │        │      │ re-checking behaviour above the fold.                │
 *  │ w_syn  │ 0.38 │ SYNERGY TERM (J·F)^γ, γ = 0.70. Jitter AND retreat   │
 *  │        │      │ loops co-occurring is the canonical "hand hovering,  │
 *  │        │      │ shaking, pulling back" pattern. γ < 1 makes the term │
 *  │        │      │ engage early, and the deliberately large 0.38 slot   │
 *  │        │      │ lets this combination alone SPIKE the score into the │
 *  │        │      │ 60+ band even with zero hover/pause corroboration.   │
 *  │ w_B    │ 0.38 │ A clean ballistic strike (smooth, fast, monotone)    │
 *  │        │      │ is powerful negative evidence: it actively pulls the │
 *  │        │      │ score toward 0 rather than merely not adding to it. │
 *  └────────┴──────┴──────────────────────────────────────────────────────┘
 *
 *  Positive weights intentionally sum to 1.21 (> 1): deliberate over-drive
 *  head-room so a genuinely extreme multi-signal episode saturates to a true
 *  100 after the clamp, while any SINGLE noisy channel (max contribution
 *  0.38) can never push the index past the mid-band on its own.
 *
 *  CONFIDENCE
 *      confidence = √( ramp(samples, 60) · ramp(activeMs, 3200) )
 *  Geometric mean of sample-count sufficiency and engaged-time sufficiency:
 *  both a burst of 60 samples in 200 ms and 5 s of near-zero movement are,
 *  alone, weak evidence; certainty requires BOTH volume and duration.
 *
 *  CLASSIFICATION — evidence scores per contract category (argmax wins;
 *  deterministic priority on ties: distraction → security → price → intent):
 *      E_distraction = ramp(idleMs − 1600, 2200)      gated on prior activity,
 *                                                     page visible, no click
 *      E_security    = 0.42·J + 0.34·F + 0.14·A + min(0.30, 0.15·badgeHovers)
 *      E_price       = 0.40·S + 0.32·H + 0.18·P + min(0.30, 0.12·priceVisits)
 *      E_intent      = 0.55·B + 0.45·(1 − EMA(S_raw))
 *  With zero data every E is ~0 except E_intent ≈ 0.45, so the engine
 *  cold-starts as "high_intent" — the honest prior for an un-hesitant user —
 *  while confidence_level ≈ 0 tells the host not to act on it yet.
 * ────────────────────────────────────────────────────────────────────────── */

const WEIGHTS = Object.freeze({
  HOVER: 0.14,
  PAUSE: 0.11,
  JITTER: 0.17,
  FRICTION_LOOPS: 0.21,
  ACCEL_FLIPS: 0.09,
  SCROLL: 0.11,
  SYNERGY: 0.38,
  INTENT_BONUS: 0.38,
  SYNERGY_GAMMA: 0.70,
});

const NORMS = Object.freeze({
  HOVER_HALF_MS: 2600,      // 2.6 s cumulative hover → H = 0.5
  PAUSE_HALF: 3.2,          // ~3 micro-pauses → P = 0.5
  PAUSE_MS_DIV: 900,        // every 0.9 s of frozen time ≈ one extra pause
  JITTER_FULL_RAD: 0.9,     // avg |Δθ| of 0.9 rad/sample ≈ chaotic path → J = 1
  FLIPS_HALF: 3.0,          // decayed flip mass of 3 → A = 0.5
  FLIP_DECAY_TAU_MS: 1500,  // flip counter half-life ≈ 1.04 s
  LOOPS_HALF: 1.8,          // ~2 aborted approaches → F ≈ 0.5
  SCROLL_FLIPS_HALF: 2.6,
  SETTLE_GRACE_MS: 300,     // settling within 300 ms of visibility is "free"
  SETTLE_HALF_MS: 1500,
  PEAK_V_FULL: 1.0,         // 1 px/ms peak approach speed = fully "committed"
  APPROACH_JITTER_FULL: 0.7,
  INTENT_LOOP_DECAY: 0.55,  // B ← B·e^(−0.55·loops): retreats revoke the bonus
  JITTER_EMA_TAU_MS: 240,
  MONO_EMA_TAU_MS: 300,
  SCORE_TAU_UP_MS: 350,     // asymmetric score smoothing (see model doc)
  SCORE_TAU_DOWN_MS: 3800,
  ACCEL_DEADBAND: 0.0025,   // px/ms² dead-band for flip sign detection
  CONF_SAMPLES_FULL: 60,
  CONF_ACTIVE_MS_FULL: 3200,
  IDLE_EVIDENCE_FULL_MS: 2200,
  MAX_SAMPLE_GAP_MS: 400,   // pointer chain resets across gaps (no fake vectors)
  MIN_SAMPLE_DT_MS: 8,      // merge sub-8 ms frames (coalescing guard)
});

/* ─────────────────────────────────────────────────────────────────────────
 * SECTION 4 · Engine implementation
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} HesitationState
 * @property {number} hesitation_score        Integer 0–100.
 * @property {number} confidence_level        Float 0.0–1.0 (2 dp).
 * @property {('price_shock'|'security_distrust'|'device_distraction'|'high_intent')} predicted_friction_type
 * @property {number} timestamp               performance.now() at emission.
 * @property {Object} [diagnostics]           Frozen tuning block (optional).
 */

class HesitationEngine {
  /**
   * @param {Element} target                  The high-value element to monitor.
   * @param {Partial<typeof DEFAULTS>} [options]
   */
  constructor(target, options = {}) {
    /** SSR / non-DOM environments: construct an inert, safe stub. */
    if (!HAS_DOM) {
      this._inert = true;
      this._subs = new Set();
      this._state = Object.freeze({
        hesitation_score: 0,
        confidence_level: 0,
        predicted_friction_type: FRICTION.HIGH_INTENT,
        timestamp: 0,
      });
      return;
    }

    if (!(target instanceof Element)) {
      throw new TypeError(
        '[HesitationEngine] `target` must be a live DOM Element.'
      );
    }

    this.target = target;
    this.cfg = Object.assign({}, DEFAULTS, options);
    this._validateConfig();

    this._inert = false;
    this._running = false;
    this._subs = new Set();
    if (typeof this.cfg.onUpdate === 'function') this._subs.add(this.cfg.onUpdate);

    /* Bind handlers once so add/removeEventListener stay symmetric. */
    this._onPointerMoveRaw = this._onPointerMoveRaw.bind(this);
    this._onPointerFrame = this._onPointerFrame.bind(this);
    this._onScrollRaw = this._onScrollRaw.bind(this);
    this._onScrollFrame = this._onScrollFrame.bind(this);
    this._onTargetEnter = this._onTargetEnter.bind(this);
    this._onTargetLeave = this._onTargetLeave.bind(this);
    this._onTargetDown = this._onTargetDown.bind(this);
    this._onConvert = this._onConvert.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onBadgeEnter = this._onBadgeEnter.bind(this);
    this._heartbeat = this._heartbeat.bind(this);

    this._teardown = [];        // [{el,type,fn,opts}] for symmetric cleanup
    this._observers = [];       // IntersectionObservers
    this._hbId = 0;
    this._rafPtr = 0;
    this._rafScr = 0;

    this._resetAccumulators(performance.now());
    this._state = this._buildState(performance.now());

    if (this.cfg.autoStart) this.start();
  }

  /* ── Public API ──────────────────────────────────────────────────────── */

  /** Begin monitoring. Idempotent. @returns {HesitationEngine} this */
  start() {
    if (this._inert || this._running) return this;
    this._running = true;

    const now = performance.now();
    this._lastEventT = now;
    this._lastScoreT = now;
    this._recomputeGeometry();

    const passive = { passive: true };
    const usePointer = 'PointerEvent' in window;

    /* High-frequency streams — window-scoped so approaches are visible
     * BEFORE the pointer reaches the element. Passive + rAF-coalesced. */
    if (usePointer) {
      this._listen(window, 'pointermove', this._onPointerMoveRaw, passive);
      this._listen(this.target, 'pointerenter', this._onTargetEnter, passive);
      this._listen(this.target, 'pointerleave', this._onTargetLeave, passive);
      this._listen(this.target, 'pointerdown', this._onTargetDown, passive);
    } else {
      this._listen(window, 'mousemove', this._onPointerMoveRaw, passive);
      this._listen(window, 'touchmove', this._onPointerMoveRaw, passive);
      this._listen(this.target, 'mouseenter', this._onTargetEnter, passive);
      this._listen(this.target, 'mouseleave', this._onTargetLeave, passive);
      this._listen(this.target, 'touchstart', this._onTargetDown, passive);
    }
    this._listen(this.target, 'click', this._onConvert, passive);
    this._listen(window, 'scroll', this._onScrollRaw, passive);
    this._listen(window, 'resize', this._onResize, passive);
    this._listen(document, 'visibilitychange', this._onVisibility, passive);

    this._wireIntersectionObservers();
    this._wireContextSelectors();

    /* Heartbeat: idle/distraction detection + score decay while no events
     * flow. Deliberately a timer (not rAF) so we do zero per-frame work. */
    this._hbId = window.setInterval(this._heartbeat, this.cfg.heartbeatMs);

    this._emit(now, /*force*/ true);
    return this;
  }

  /** Stop monitoring and release every listener/observer. Idempotent. */
  stop() {
    if (this._inert || !this._running) return this;
    this._running = false;

    for (let i = 0; i < this._teardown.length; i++) {
      const l = this._teardown[i];
      l.el.removeEventListener(l.type, l.fn, l.opts);
    }
    this._teardown.length = 0;

    for (let i = 0; i < this._observers.length; i++) this._observers[i].disconnect();
    this._observers.length = 0;

    if (this._hbId) { window.clearInterval(this._hbId); this._hbId = 0; }
    if (this._rafPtr) { window.cancelAnimationFrame(this._rafPtr); this._rafPtr = 0; }
    if (this._rafScr) { window.cancelAnimationFrame(this._rafScr); this._rafScr = 0; }
    return this;
  }

  /** Wipe all accumulators (e.g. on SPA route change) and re-emit. */
  reset() {
    if (this._inert) return this;
    this._resetAccumulators(performance.now());
    this._emit(performance.now(), /*force*/ true);
    return this;
  }

  /** Stop, clear subscribers, and zero state. The instance becomes inert. */
  destroy() {
    this.stop();
    if (this._subs) this._subs.clear();
    if (!this._inert) this._resetAccumulators(HAS_DOM ? performance.now() : 0);
    this._inert = true;
    return this;
  }

  /**
   * Subscribe to state emissions.
   * @param {(state: HesitationState) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('[HesitationEngine] subscribe() expects a function.');
    }
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  /** @returns {HesitationState} the latest immutable state snapshot. */
  getState() {
    return this._state;
  }

  /* ── Internal: configuration & lifecycle plumbing ────────────────────── */

  _validateConfig() {
    const c = this.cfg;
    const positive = [
      'emitIntervalMs', 'heartbeatMs', 'approachEnterPx', 'approachExitPx',
      'minApproachDwellMs', 'pauseMinMs', 'flipRefractoryMs',
      'idleDistractionMs', 'scrollFlipMinPx', 'scrollSettleHoldMs',
    ];
    for (const key of positive) {
      if (!(typeof c[key] === 'number' && isFinite(c[key]) && c[key] > 0)) {
        throw new RangeError(`[HesitationEngine] cfg.${key} must be a positive number.`);
      }
    }
    if (c.approachExitPx <= c.approachEnterPx) {
      throw new RangeError(
        '[HesitationEngine] approachExitPx must exceed approachEnterPx (hysteresis).'
      );
    }
  }

  _listen(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this._teardown.push({ el, type, fn, opts });
  }

  _wireIntersectionObservers() {
    if (!('IntersectionObserver' in window)) {
      this._elementVisible = true; // graceful fallback: assume visible
      return;
    }
    const targetIO = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      const visible = e.isIntersecting && e.intersectionRatio >= 0.35;
      if (visible && !this._elementVisible) {
        this._elementVisible = true;
        this._visibleSince = performance.now();
        this._settleMs = -1;
        this._settleCandidateT = 0;
      } else if (!visible) {
        this._elementVisible = false;
      }
    }, { threshold: [0, 0.35] });
    targetIO.observe(this.target);
    this._observers.push(targetIO);

    if (this._priceEl) {
      const priceIO = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1];
        const vis = e.isIntersecting && e.intersectionRatio >= 0.35;
        if (vis && !this._priceVisible) {
          this._priceVisible = true;
          if (this._running && !this._converted) this._priceVisits++;
        } else if (!vis) {
          this._priceVisible = false;
        }
      }, { threshold: [0, 0.35] });
      priceIO.observe(this._priceEl);
      this._observers.push(priceIO);
    }
  }

  _wireContextSelectors() {
    const c = this.cfg;
    try {
      this._priceEl = c.priceSelector ? document.querySelector(c.priceSelector) : null;
    } catch (_) {
      console.warn('[HesitationEngine] Invalid priceSelector; ignoring.');
      this._priceEl = null;
    }
    try {
      const badges = c.trustBadgeSelector
        ? document.querySelectorAll(c.trustBadgeSelector)
        : [];
      const evt = 'PointerEvent' in window ? 'pointerenter' : 'mouseenter';
      badges.forEach((node) =>
        this._listen(node, evt, this._onBadgeEnter, { passive: true })
      );
    } catch (_) {
      console.warn('[HesitationEngine] Invalid trustBadgeSelector; ignoring.');
    }
  }

  _recomputeGeometry() {
    const r = this.target.getBoundingClientRect();
    this._rect = r;
    if (r.width > 0 || r.height > 0) {
      const diag = Math.hypot(r.width, r.height);
      this._proxR = this.cfg.proximityRadiusPx || Math.max(140, 1.1 * diag);
    }
    this._rectDirty = false;
  }

  /* ── Internal: accumulator lifecycle ─────────────────────────────────── */

  _resetAccumulators(now) {
    /* Session clocks */
    this._startT = now;
    this._lastEventT = now;      // any telemetry event (idle detector anchor)
    this._lastSampleT = 0;       // last processed pointer sample
    this._lastEmitT = 0;
    this._lastScoreT = now;
    this._hiddenAt = 0;

    /* Pointer chain state (previous-sample memory — the ONLY "history"). */
    this._px = NaN; this._py = NaN;
    this._pv = 0;
    this._pHeading = NaN;
    this._pAccelSign = 0;
    this._lastFlipT = 0;
    this._prevEdgeDist = Infinity;
    this._prevProx = 0;

    /* rAF-coalescing slots */
    this._pendX = 0; this._pendY = 0; this._pendHas = false;

    /* Aggregates (the entire memory footprint of the model) */
    this._sampleCount = 0;
    this._activeMs = 0;

    this._hoverMs = 0;
    this._hovering = false;
    this._hoverEnterT = 0;

    this._pauseCount = 0;
    this._pauseMs = 0;
    this._pauseRunMs = 0;
    this._pausedEpisode = false;

    this._jitterEma = 0;
    this._flipsDecay = 0;

    this._frictionLoops = 0;
    this._inZone = false;
    this._zoneEnterT = 0;
    this._zoneDecel = false;

    /* Ballistic-approach accumulators (rebuilt on every fresh approach). */
    this._appMonotone = 0.5;
    this._appPeakV = 0;
    this._appJitterSum = 0;
    this._appSamples = 0;
    this._approachSmoothness = 0;

    /* Scroll aggregates */
    this._scrollY = NaN;
    this._scrollT = 0;
    this._scrollDir = 0;
    this._scrollAnchorY = 0;
    this._scrollFlips = 0;
    this._elementVisible = false;
    this._visibleSince = 0;
    this._settleMs = -1;
    this._settleCandidateT = 0;

    /* Context signals */
    this._priceVisits = 0;
    this._priceVisible = false;
    this._badgeHovers = 0;

    /* Outputs */
    this._scoreEma = 0;
    this._converted = false;
    this._lastEmitted = { score: -1, conf: -1, type: '' };
  }

  _resetApproach() {
    this._appMonotone = 0.5;
    this._appPeakV = 0;
    this._appJitterSum = 0;
    this._appSamples = 0;
  }

  /* ── Internal: raw event intake (rAF-coalesced) ──────────────────────── */

  _onPointerMoveRaw(e) {
    if (!this._running) return;
    const p = e.touches ? e.touches[0] : e;   // touchmove fallback path
    if (!p) return;
    this._pendX = p.clientX;
    this._pendY = p.clientY;
    this._pendHas = true;
    if (!this._rafPtr) this._rafPtr = window.requestAnimationFrame(this._onPointerFrame);
  }

  _onScrollRaw() {
    if (!this._running) return;
    if (!this._rafScr) this._rafScr = window.requestAnimationFrame(this._onScrollFrame);
  }

  _onResize() {
    this._rectDirty = true;
  }

  _onVisibility() {
    const now = performance.now();
    if (document.visibilityState === 'hidden') {
      this._hiddenAt = now;
    } else {
      /* Time hidden must not read as "distraction": restart the idle clock. */
      this._hiddenAt = 0;
      this._lastEventT = now;
    }
  }

  _onTargetEnter() {
    if (!this._running) return;
    this._hovering = true;
    this._hoverEnterT = performance.now();
    this._lastEventT = this._hoverEnterT;
  }

  _onTargetLeave() {
    if (!this._running) return;
    const now = performance.now();
    if (this._hovering) this._hoverMs += now - this._hoverEnterT;
    this._hovering = false;
    this._lastEventT = now;
  }

  _onTargetDown() {
    this._lastEventT = performance.now(); // taps without movement still count
  }

  _onBadgeEnter() {
    if (!this._running || this._converted) return;
    this._badgeHovers++;
    this._lastEventT = performance.now();
  }

  _onConvert() {
    if (!this._running || this._converted) return;
    const now = performance.now();
    if (this._hovering) {                 // fold live hover into the total
      this._hoverMs += now - this._hoverEnterT;
      this._hoverEnterT = now;
    }
    this._converted = true;               // freezes all negative accumulation
    this._lastEventT = now;
    this._emit(now, /*force*/ true);
  }

  /* ── Internal: per-frame pointer physics ─────────────────────────────── */

  _onPointerFrame() {
    this._rafPtr = 0;
    if (!this._running || !this._pendHas) return;
    this._pendHas = false;

    const now = performance.now();
    this._lastEventT = now;

    if (this._rectDirty) this._recomputeGeometry();
    const r = this._rect;
    if (!r || (r.width === 0 && r.height === 0)) return; // hidden/detached: skip

    const x = this._pendX;
    const y = this._pendY;

    /* Distance from the element's bounding-box EDGE (0 while inside it). */
    const edgeDx = Math.max(r.left - x, 0, x - r.right);
    const edgeDy = Math.max(r.top - y, 0, y - r.bottom);
    const edgeDist = Math.hypot(edgeDx, edgeDy);

    /* Proximity weight ∈ [0,1]: 1 on the element, 0 at the proximity radius.
     * Every noisy micro-signal below is multiplied by it, so behaviour far
     * from the target contributes (almost) nothing. */
    const prox = clamp01(1 - edgeDist / this._proxR);

    /* First sample of a chain: seed previous-state memory, no vector math. */
    if (isNaN(this._px)) {
      this._seedChain(x, y, now, edgeDist);
      return;
    }

    let dt = now - this._lastSampleT;
    if (dt < NORMS.MIN_SAMPLE_DT_MS) return;                 // coalescing guard
    if (dt > NORMS.MAX_SAMPLE_GAP_MS) {                      // chain break
      this._seedChain(x, y, now, edgeDist);
      return;
    }

    const dx = x - this._px;
    const dy = y - this._py;
    const dist = Math.hypot(dx, dy);
    const v = dist / dt;                                     // px/ms

    this._sampleCount++;
    if (prox > 0) this._activeMs += dt;

    /* — Angular jitter (motor conflict) — */
    let dH = 0;
    if (v > 0.02) {
      const heading = Math.atan2(dy, dx);
      if (!isNaN(this._pHeading)) {
        dH = Math.abs(wrapAngle(heading - this._pHeading));
        const aJ = emaAlpha(dt, NORMS.JITTER_EMA_TAU_MS);
        this._jitterEma += aJ * (dH * prox - this._jitterEma);
      }
      this._pHeading = heading;
    }

    /* — Acceleration sign flips (start/stop indecision) — */
    const accel = (v - this._pv) / dt;
    const s = sgn(accel, NORMS.ACCEL_DEADBAND);
    this._flipsDecay *= Math.exp(-dt / NORMS.FLIP_DECAY_TAU_MS);
    if (
      s !== 0 && this._pAccelSign !== 0 && s !== this._pAccelSign &&
      v > this.cfg.flipMinSpeed &&
      now - this._lastFlipT > this.cfg.flipRefractoryMs
    ) {
      this._flipsDecay += 1;
      this._lastFlipT = now;
      if (s < 0 && this._inZone) this._zoneDecel = true; // braking at the target
    }
    if (s !== 0) this._pAccelSign = s;

    /* — Micro-pauses (frozen cursor inside the decision zone) — */
    if (prox > 0.15) {
      if (!this._pausedEpisode) {
        if (v < this.cfg.pauseSpeedEnter) {
          this._pauseRunMs += dt;
          if (this._pauseRunMs >= this.cfg.pauseMinMs) {
            this._pausedEpisode = true;
            this._pauseCount++;
            this._pauseMs += this._pauseRunMs;
          }
        } else if (v > this.cfg.pauseSpeedExit) {
          this._pauseRunMs = 0;
        }
      } else {
        this._pauseMs += dt;
        if (v > this.cfg.pauseSpeedExit) {
          this._pausedEpisode = false;
          this._pauseRunMs = 0;
        }
      }
    } else {
      this._pausedEpisode = false;
      this._pauseRunMs = 0;
    }

    /* — Approach → retreat friction loops (hysteresis band) — */
    if (!this._inZone && edgeDist <= this.cfg.approachEnterPx) {
      this._inZone = true;
      this._zoneEnterT = now;
      this._zoneDecel = false;
      this._finalizeApproach();          // an approach just concluded → grade it
    } else if (this._inZone && edgeDist >= this.cfg.approachExitPx) {
      this._inZone = false;
      const dwell = now - this._zoneEnterT;
      if (!this._converted &&
          (dwell >= this.cfg.minApproachDwellMs || this._zoneDecel)) {
        this._frictionLoops++;           // a literal aborted commitment
      }
    }

    /* — Ballistic-approach accumulation (outside zone, inside proximity) — */
    if (!this._inZone && prox > 0) {
      const closer = edgeDist < this._prevEdgeDist ? 1 : 0;
      const aM = emaAlpha(dt, NORMS.MONO_EMA_TAU_MS);
      this._appMonotone += aM * (closer - this._appMonotone);
      if (v > this._appPeakV) this._appPeakV = v;
      this._appJitterSum += dH;
      this._appSamples++;
    } else if (prox === 0 && this._prevProx > 0) {
      this._resetApproach();             // left the arena entirely: fresh slate
    }

    /* — Advance chain memory — */
    this._px = x; this._py = y;
    this._pv = v;
    this._prevEdgeDist = edgeDist;
    this._prevProx = prox;
    this._lastSampleT = now;

    this._emit(now, /*force*/ false);
  }

  _seedChain(x, y, now, edgeDist) {
    this._px = x; this._py = y;
    this._pv = 0;
    this._pHeading = NaN;
    this._pAccelSign = 0;
    this._prevEdgeDist = edgeDist;
    this._prevProx = clamp01(1 - edgeDist / this._proxR);
    this._lastSampleT = now;
  }

  /** Grade the approach that just reached the enter-radius (intent bonus B). */
  _finalizeApproach() {
    if (this._appSamples >= 4) {
      const mono = clamp01(this._appMonotone);
      const meanJitter = this._appJitterSum / this._appSamples;
      const smoothTerm = 1 - clamp01(meanJitter / NORMS.APPROACH_JITTER_FULL);
      const speedTerm = ramp(this._appPeakV, NORMS.PEAK_V_FULL);
      const quality = mono * smoothTerm * speedTerm;
      /* Blend 50/50 with the previous grade so one lucky strike after many
       * shaky ones cannot instantly claim full high-intent credit. */
      this._approachSmoothness = 0.5 * this._approachSmoothness + 0.5 * quality;
    }
    this._resetApproach();
  }

  /* ── Internal: per-frame scroll physics ──────────────────────────────── */

  _onScrollFrame() {
    this._rafScr = 0;
    if (!this._running) return;

    const now = performance.now();
    this._lastEventT = now;
    this._recomputeGeometry();           // viewport-relative rect moved

    const y = window.scrollY;
    if (!isNaN(this._scrollY)) {
      const dt = now - this._scrollT;
      if (dt > 0) {
        const dy = y - this._scrollY;
        const sv = dy / dt;              // px/ms, signed
        const dir = sgn(dy, 0.5);

        /* Qualified reversals while the target is on screen: the classic
         * "scroll up to the price, back down to the button" oscillation. */
        if (dir !== 0) {
          if (
            this._scrollDir !== 0 && dir !== this._scrollDir &&
            Math.abs(y - this._scrollAnchorY) >= this.cfg.scrollFlipMinPx &&
            this._elementVisible && !this._converted
          ) {
            this._scrollFlips++;
            this._scrollAnchorY = y;
          }
          if (dir !== this._scrollDir) this._scrollAnchorY = y;
          this._scrollDir = dir;
        }

        /* Settle inertia: how long after the element appears does scrolling
         * stabilise? A long, wandering settle reads as comparison behaviour. */
        if (this._elementVisible && this._settleMs < 0) {
          if (Math.abs(sv) < this.cfg.scrollSettleSpeed) {
            if (!this._settleCandidateT) this._settleCandidateT = now;
            else if (now - this._settleCandidateT >= this.cfg.scrollSettleHoldMs) {
              this._settleMs = Math.max(0, this._settleCandidateT - this._visibleSince);
            }
          } else {
            this._settleCandidateT = 0;
          }
        }
        if (this._elementVisible) this._activeMs += Math.min(dt, 100);
      }
    }
    this._scrollY = y;
    this._scrollT = now;

    this._emit(now, /*force*/ false);
  }

  /* ── Internal: heartbeat (idle, decay, liveness) ─────────────────────── */

  _heartbeat() {
    if (!this._running) return;
    if (document.visibilityState === 'hidden') return; // hidden ≠ distracted

    if (!this.target.isConnected) {
      console.warn('[HesitationEngine] Target left the DOM; engine stopped.');
      this.stop();
      return;
    }
    /* Re-evaluate so distraction evidence accrues and the score EMA decays
     * even in total event silence — which is precisely the signal. */
    this._emit(performance.now(), /*force*/ false);
  }

  /* ── Internal: evaluation → classification → emission ────────────────── */

  _features(now) {
    const liveHoverMs =
      this._hoverMs + (this._hovering ? now - this._hoverEnterT : 0);

    const H = sat(liveHoverMs, NORMS.HOVER_HALF_MS);
    const P = sat(this._pauseCount + this._pauseMs / NORMS.PAUSE_MS_DIV, NORMS.PAUSE_HALF);
    const J = ramp(this._jitterEma, NORMS.JITTER_FULL_RAD);
    const A = sat(this._flipsDecay, NORMS.FLIPS_HALF);
    const F = sat(this._frictionLoops, NORMS.LOOPS_HALF);

    const settleContribution =
      this._settleMs >= 0
        ? sat(Math.max(0, this._settleMs - NORMS.SETTLE_GRACE_MS), NORMS.SETTLE_HALF_MS)
        : 0;
    const S = clamp01(
      0.75 * sat(this._scrollFlips, NORMS.SCROLL_FLIPS_HALF) +
      0.25 * settleContribution
    );

    const synergy = Math.pow(J * F, WEIGHTS.SYNERGY_GAMMA);

    /* Intent bonus decays exponentially with every aborted approach: a user
     * who has retreated three times no longer earns "ballistic" credit. */
    const B = this._approachSmoothness *
      Math.exp(-NORMS.INTENT_LOOP_DECAY * this._frictionLoops);

    const idleMs = Math.max(0, now - this._lastEventT);

    return { H, P, J, A, F, S, synergy, B, idleMs, liveHoverMs };
  }

  _evaluate(now) {
    const f = this._features(now);

    /* ── The proprietary weighted blend (see SECTION 3 for rationale) ── */
    const raw = clamp01(
      WEIGHTS.HOVER * f.H +
      WEIGHTS.PAUSE * f.P +
      WEIGHTS.JITTER * f.J +
      WEIGHTS.FRICTION_LOOPS * f.F +
      WEIGHTS.ACCEL_FLIPS * f.A +
      WEIGHTS.SCROLL * f.S +
      WEIGHTS.SYNERGY * f.synergy -
      WEIGHTS.INTENT_BONUS * f.B
    );

    /* Asymmetric temporal smoothing: fast attack, slow release. */
    const dt = Math.max(1, now - this._lastScoreT);
    this._lastScoreT = now;
    const tau = raw > this._scoreEma ? NORMS.SCORE_TAU_UP_MS : NORMS.SCORE_TAU_DOWN_MS;
    this._scoreEma += emaAlpha(dt, tau) * (raw - this._scoreEma);

    /* Confidence: geometric mean of data volume and engaged duration. */
    const confidence = Math.sqrt(
      ramp(this._sampleCount, NORMS.CONF_SAMPLES_FULL) *
      ramp(this._activeMs, NORMS.CONF_ACTIVE_MS_FULL)
    );

    const type = this._classify(f);
    return { f, raw, confidence, type };
  }

  _classify(f) {
    if (this._converted) return FRICTION.HIGH_INTENT; // decision executed

    /* device_distraction: telemetry was flowing, then ceased entirely while
     * the page stayed visible. Gated on prior engagement so a user who never
     * touched the pointer is not "distracted" — merely absent. */
    const hadEngagement = this._activeMs > 400 || this._sampleCount > 12;
    const eDistraction =
      hadEngagement && f.idleMs > this.cfg.idleDistractionMs
        ? ramp(f.idleMs - this.cfg.idleDistractionMs, NORMS.IDLE_EVIDENCE_FULL_MS)
        : 0;

    /* security_distrust: shaky vectors + retreat loops (+ trust-badge scans). */
    const eSecurity = clamp01(
      0.42 * f.J + 0.34 * f.F + 0.14 * f.A +
      Math.min(0.30, 0.15 * this._badgeHovers)
    );

    /* price_shock: scroll oscillation + long dwell (+ price-region revisits). */
    const ePrice = clamp01(
      0.40 * f.S + 0.32 * f.H + 0.18 * f.P +
      Math.min(0.30, 0.12 * this._priceVisits)
    );

    /* high_intent: ballistic approach quality + absence of accumulated friction. */
    const eIntent = clamp01(0.55 * f.B + 0.45 * (1 - this._scoreEma));

    /* Deterministic argmax; earlier entries win ties. */
    let best = FRICTION.DEVICE_DISTRACTION;
    let bestE = eDistraction;
    if (eSecurity > bestE) { best = FRICTION.SECURITY_DISTRUST; bestE = eSecurity; }
    if (ePrice > bestE) { best = FRICTION.PRICE_SHOCK; bestE = ePrice; }
    if (eIntent > bestE) { best = FRICTION.HIGH_INTENT; }
    return best;
  }

  _buildState(now, evaluated) {
    const ev = evaluated || this._evaluate(now);
    const state = {
      hesitation_score: Math.round(100 * this._scoreEma),
      confidence_level: round2(clamp01(ev.confidence)),
      predicted_friction_type: ev.type,
      timestamp: now,
    };
    if (this.cfg && this.cfg.exposeDiagnostics) {
      state.diagnostics = Object.freeze({
        raw_index: round3(ev.raw),
        hover_pressure: round3(ev.f.H),
        micro_pause_density: round3(ev.f.P),
        vector_jitter: round3(ev.f.J),
        accel_instability: round3(ev.f.A),
        friction_loops: this._frictionLoops,
        scroll_indecision: round3(ev.f.S),
        synergy_term: round3(ev.f.synergy),
        intent_bonus: round3(ev.f.B),
        hover_ms: Math.round(ev.f.liveHoverMs),
        micro_pauses: this._pauseCount,
        scroll_reversals: this._scrollFlips,
        price_region_visits: this._priceVisits,
        trust_badge_hovers: this._badgeHovers,
        idle_ms: Math.round(ev.f.idleMs),
        samples: this._sampleCount,
        active_ms: Math.round(this._activeMs),
        element_visible: this._elementVisible,
        converted: this._converted,
      });
    }
    return Object.freeze(state);
  }

  _emit(now, force) {
    if (!force && now - this._lastEmitT < this.cfg.emitIntervalMs) return;

    const ev = this._evaluate(now);
    const score = Math.round(100 * this._scoreEma);
    const conf = round2(clamp01(ev.confidence));

    const changed =
      score !== this._lastEmitted.score ||
      conf !== this._lastEmitted.conf ||
      ev.type !== this._lastEmitted.type;
    if (!changed && !force) { this._lastEmitT = now; return; }

    this._state = this._buildState(now, ev);
    this._lastEmitT = now;
    this._lastEmitted.score = score;
    this._lastEmitted.conf = conf;
    this._lastEmitted.type = ev.type;

    /* Subscriber faults must never destabilise the engine. */
    this._subs.forEach((fn) => {
      try { fn(this._state); }
      catch (err) { console.error('[HesitationEngine] subscriber error:', err); }
    });
  }
}

/* Static metadata */
HesitationEngine.VERSION = '1.0.0';
HesitationEngine.FrictionType = FRICTION;

/* ─────────────────────────────────────────────────────────────────────────
 * SECTION 5 · Integration example (reference only)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   <script type="module">
 *     import HesitationEngine from '/js/HesitationEngine.js';
 *
 *     const engine = new HesitationEngine(document.querySelector('#buy-now'), {
 *       priceSelector: '.product-price',
 *       trustBadgeSelector: '.trust-badges img',
 *     });
 *
 *     const unsubscribe = engine.subscribe((s) => {
 *       // Act only on statistically meaningful reads.
 *       if (s.confidence_level < 0.4 || s.hesitation_score < 55) return;
 *       if (s.predicted_friction_type === 'security_distrust') {
 *         document.querySelector('.trust-badges').classList.add('emphasized');
 *       }
 *       if (s.predicted_friction_type === 'price_shock') {
 *         document.querySelector('.value-breakdown').hidden = false;
 *       }
 *     });
 *
 *     engine.start();
 *     // SPA route change:  engine.reset();
 *     // Teardown:          unsubscribe(); engine.destroy();
 *   </script>
 * ────────────────────────────────────────────────────────────────────────── */

export { FRICTION as FrictionType };
export default HesitationEngine;
