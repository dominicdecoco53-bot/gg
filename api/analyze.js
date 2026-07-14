/**
 * ============================================================================
 *  api/analyze.js  —  BACKEND ONLY  (Vercel Node.js Serverless Function)
 * ============================================================================
 *
 *  PLACEMENT:  This file must live at  <repo root>/api/analyze.js
 *              Vercel automatically exposes it as  POST https://<site>/api/analyze
 *
 *  IMPORTANT:  Nothing in this file may reference `window`, `document`,
 *              listeners, or any other browser API. This code runs on
 *              Vercel's Node.js runtime, where those globals do not exist —
 *              that is exactly what caused the instant 500 crashes before.
 *
 *  WHAT IT DOES
 *    1. Accepts POST JSON from the frontend:
 *         { hesitation_score: 0..100, confidence_level: 0..1,
 *           predicted_friction_type: "price_shock" | "security_distrust"
 *                                  | "device_distraction" | "high_intent" }
 *    2. Reads process.env.GEMINI_API_KEY (set in Vercel → Settings →
 *       Environment Variables — you already did this).
 *    3. Calls the Google Gemini `generateContent` REST endpoint and asks it
 *       to write ONE short deal message around a fixed, server-chosen offer.
 *    4. Returns JSON:  { message, source, friction_type, model }
 *
 *  MODEL NOTE (July 2026)
 *    `gemini-1.5-flash` has been fully retired by Google — every request to
 *    it now returns 404 ("model not found"), regardless of your key or code.
 *    The request/response structure below is identical to the 1.5 docs you
 *    were following; only the model name changes. We default to the current
 *    stable flash model and let you override it without a redeploy by adding
 *    a `GEMINI_MODEL` environment variable in Vercel.
 *
 *  DESIGN GUARANTEES
 *    - The shopper-facing UI never hangs on this route: every upstream
 *      failure (timeout, quota, safety block, bad key) still returns a
 *      usable deterministic `message` with `source: "fallback"`, and the
 *      real cause is logged with console.error so it shows up red in your
 *      Vercel deployment logs.
 *    - The LLM never invents discount amounts. Offers are fixed server-side
 *      in OFFER_MATRIX; Gemini only writes the wording around them.
 *    - Metric values are clamped/whitelisted before being placed in the
 *      prompt, so no free-form client text ever reaches the model.
 *
 *  RUNTIME:  CommonJS on purpose — it works on Vercel's Node runtime with or
 *            without a package.json. (If your repo ever gains a package.json
 *            containing `"type": "module"`, remove that line or convert this
 *            file to `export default`.) `fetch` is global on Node 18+, which
 *            Vercel uses by default, so there are ZERO npm dependencies.
 * ============================================================================
 */

'use strict';

/* ---------------------------------------------------------------------------
 * 1. CONFIGURATION
 * ------------------------------------------------------------------------- */

/**
 * Model selection.
 * Override in Vercel with env var GEMINI_MODEL if Google rotates models again
 * (e.g. set it to "gemini-flash-latest" for the auto-updating alias).
 */
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

/** Official Gemini REST endpoint (same structure as the gemini-1.5 docs). */
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/' +
  encodeURIComponent(GEMINI_MODEL) +
  ':generateContent';

/** Abort the upstream call after this long so our function never hits
 *  Vercel's own execution limit with nothing to say. */
const UPSTREAM_TIMEOUT_MS = 9000;

/** Hard cap applied to whatever text the model returns. */
const MAX_MESSAGE_CHARS = 320;

/** The four friction types the HesitationEngine can emit. */
const FRICTION_TYPES = new Set([
  'price_shock',
  'security_distrust',
  'device_distraction',
  'high_intent',
]);

/**
 * Server-authored offers. Gemini writes copy AROUND these; it cannot change
 * the numbers or invent new promo codes. Edit deals/codes here only.
 */
const OFFER_MATRIX = {
  price_shock: {
    code: 'SAVE10',
    deal: '10% off this order',
    angle:
      'The shopper hesitated over the price. Lead with the saving, keep it ' +
      'warm and matter-of-fact, no hard sell.',
  },
  security_distrust: {
    code: 'SAFE5',
    deal: '5% off plus free 30-day returns',
    angle:
      'The shopper showed trust hesitation. Reassure first (secure checkout, ' +
      'free 30-day returns), mention the small discount second.',
  },
  device_distraction: {
    code: 'COMEBACK5',
    deal: '5% off, and the cart is saved',
    angle:
      'The shopper drifted away mid-checkout. Welcome them back, confirm the ' +
      'cart is saved, add gentle (not fake) urgency.',
  },
  high_intent: {
    code: 'SHIPFREE',
    deal: 'free express shipping',
    angle:
      'The shopper looks decisive. One low-pressure line rewarding them with ' +
      'free express shipping. Do not sound desperate.',
  },
};

/**
 * Deterministic copy used whenever Gemini cannot answer (timeout, quota,
 * safety block, misconfiguration). Keeps the storefront experience intact.
 */
const FALLBACK_COPY = {
  price_shock:
    'Still thinking it over? Take 10% off this order with code SAVE10 at checkout.',
  security_distrust:
    'Shop with confidence — secure checkout and free 30-day returns, plus 5% off with code SAFE5.',
  device_distraction:
    'Welcome back — your cart is saved. Finish checkout today with code COMEBACK5 for 5% off.',
  high_intent:
    'Nice pick. Enjoy free express shipping on this order with code SHIPFREE.',
};

/* ---------------------------------------------------------------------------
 * 2. SMALL HELPERS
 * ------------------------------------------------------------------------- */

/** Clamp a number into [min, max]; returns `fallback` for non-numbers. */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalize/validate the metrics payload coming from the sensor script. */
function normalizeMetrics(body) {
  const score = Math.round(clampNumber(body.hesitation_score, 0, 100, 50));
  const confidence =
    Math.round(clampNumber(body.confidence_level, 0, 1, 0.5) * 100) / 100;
  const friction = FRICTION_TYPES.has(body.predicted_friction_type)
    ? body.predicted_friction_type
    : 'high_intent';
  return { score, confidence, friction };
}

/** Build the (fully server-controlled) prompt sent to Gemini. */
function buildPrompt({ score, confidence, friction }) {
  const offer = OFFER_MATRIX[friction];
  return [
    'You write on-page promotional microcopy for an e-commerce checkout.',
    '',
    'Live shopper telemetry:',
    `- Hesitation score: ${score}/100 (data confidence ${confidence})`,
    `- Detected friction type: ${friction}`,
    '',
    `Creative direction: ${offer.angle}`,
    `The exact offer to present: ${offer.deal}.`,
    `The promo code is ${offer.code} and must appear exactly once, verbatim.`,
    '',
    'Write ONE message of at most 35 words. Plain text only: no markdown,',
    'no emojis, no quotation marks, no exclamation spam, no preamble —',
    'reply with the message and nothing else.',
  ].join('\n');
}

/** Flatten a generateContent response into plain text (skips thought parts). */
function extractText(apiJson) {
  const parts =
    apiJson &&
    apiJson.candidates &&
    apiJson.candidates[0] &&
    apiJson.candidates[0].content &&
    Array.isArray(apiJson.candidates[0].content.parts)
      ? apiJson.candidates[0].content.parts
      : [];
  return parts
    .filter((p) => p && typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text)
    .join(' ')
    .trim();
}

/** Strip markdown artifacts / collapse whitespace / cap length. */
function sanitizeMessage(text, promoCode) {
  let out = String(text)
    .replace(/[*_`#>~]/g, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS)
    .trim();
  // Guarantee the promo code survives even if the model dropped it.
  if (promoCode && !out.toUpperCase().includes(promoCode.toUpperCase())) {
    out += ` Use code ${promoCode}.`;
  }
  return out;
}

/** Parse req.body defensively: Vercel usually pre-parses JSON, but be safe. */
function readJsonBody(req) {
  const body = req.body;
  if (body == null) return { ok: false, value: null };
  if (typeof body === 'object') return { ok: true, value: body };
  if (typeof body === 'string') {
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch (_err) {
      return { ok: false, value: null };
    }
  }
  return { ok: false, value: null };
}

/* ---------------------------------------------------------------------------
 * 3. THE SERVERLESS HANDLER
 * ------------------------------------------------------------------------- */

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  /* --- Method gate ------------------------------------------------------ */
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res
      .status(405)
      .json({ error: 'Method not allowed. Send a POST request with JSON metrics.' });
  }

  /* --- Body parsing ------------------------------------------------------ */
  const parsed = readJsonBody(req);
  if (!parsed.ok) {
    return res.status(400).json({
      error:
        'Invalid request body. Send JSON with Content-Type: application/json, e.g. ' +
        '{"hesitation_score":62,"confidence_level":0.7,"predicted_friction_type":"price_shock"}',
    });
  }

  const metrics = normalizeMetrics(parsed.value);
  const offer = OFFER_MATRIX[metrics.friction];
  const fallbackMessage = FALLBACK_COPY[metrics.friction];

  /* --- Configuration gate ------------------------------------------------ */
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Loud in the Vercel logs, but the shopper still gets a usable message.
    console.error(
      '[api/analyze] GEMINI_API_KEY is not set for this environment. ' +
        'Add it in Vercel → Project → Settings → Environment Variables, then redeploy.'
    );
    return res.status(500).json({
      error: 'Server misconfiguration: GEMINI_API_KEY environment variable is not set.',
      message: fallbackMessage,
      source: 'fallback',
      friction_type: metrics.friction,
    });
  }

  /* --- Call Gemini -------------------------------------------------------- */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Official header form of API-key auth (keeps the key out of URLs/logs).
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: buildPrompt(metrics) }],
          },
        ],
        // Note: Gemini 3.x guidance is to leave temperature/top_p/top_k at
        // their defaults, and omitting maxOutputTokens avoids truncation when
        // the model spends internal "thinking" tokens. Length is controlled
        // by the prompt plus sanitizeMessage() above.
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error(
        `[api/analyze] Gemini API error ${upstream.status} for model "${GEMINI_MODEL}": ` +
          detail.slice(0, 600)
      );
      if (upstream.status === 404) {
        console.error(
          `[api/analyze] HTTP 404 usually means the model name "${GEMINI_MODEL}" is retired ` +
            'or unavailable to your key. Set the GEMINI_MODEL env var in Vercel to a current ' +
            'model (e.g. "gemini-flash-latest") and redeploy.'
        );
      }
      return res.status(200).json({
        message: fallbackMessage,
        source: 'fallback',
        reason: `gemini_http_${upstream.status}`,
        friction_type: metrics.friction,
      });
    }

    const apiJson = await upstream.json();

    // Prompt-level safety block (no candidates at all).
    const blockReason =
      apiJson && apiJson.promptFeedback && apiJson.promptFeedback.blockReason;
    const rawText = extractText(apiJson);

    if (!rawText) {
      console.error(
        '[api/analyze] Gemini returned no usable text.' +
          (blockReason ? ` blockReason=${blockReason}` : '') +
          ' Raw (truncated): ' +
          JSON.stringify(apiJson).slice(0, 600)
      );
      return res.status(200).json({
        message: fallbackMessage,
        source: 'fallback',
        reason: blockReason ? 'gemini_blocked' : 'gemini_empty',
        friction_type: metrics.friction,
      });
    }

    /* --- Success ---------------------------------------------------------- */
    return res.status(200).json({
      message: sanitizeMessage(rawText, offer.code),
      source: 'gemini',
      model: GEMINI_MODEL,
      friction_type: metrics.friction,
    });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    console.error(
      `[api/analyze] ${timedOut ? 'Timed out calling' : 'Failed to reach'} Gemini: ` +
        (err && err.message ? err.message : String(err))
    );
    return res.status(200).json({
      message: fallbackMessage,
      source: 'fallback',
      reason: timedOut ? 'gemini_timeout' : 'gemini_network_error',
      friction_type: metrics.friction,
    });
  } finally {
    clearTimeout(timer);
  }
};
