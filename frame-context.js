/**
 * Frame Context & Header Resolution Helper (frame-context.js)
 *
 * Implements context resolution for streams embedded inside cross-origin iframes.
 * Ensures frameUrl / initiator is prioritized over the top-level tab URL for Referer
 * and Origin headers, preventing HTTP 403 Forbidden hotlink blocks.
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FrameContext = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Resolve effective headers prioritizing the iframe frameUrl / initiator over the top-level tab.
   *
   * @param {Object} params
   * @param {string} [params.frameUrl] - The iframe's own URL from webNavigation
   * @param {string} [params.initiator] - Request initiator origin from webRequest
   * @param {string} [params.tabUrl] - Top-level page URL
   * @param {string} [params.rawReferer] - Captured Referer header from webRequest
   * @param {string} [params.rawOrigin] - Captured Origin header from webRequest
   * @param {string} [params.userAgent] - Captured User-Agent header
   * @param {string} [params.acceptLanguage] - Captured Accept-Language header
   * @param {string} [params.accept] - Captured Accept header
   * @param {Array}  [params.customHeaders] - Additional custom headers (e.g. x-requested-with)
   * @returns {{ referer: string, origin: string, headers: Object, isIframe: boolean, source: string }}
   */
  function resolveFrameHeaders({
    frameUrl = '',
    initiator = '',
    tabUrl = '',
    rawReferer = '',
    rawOrigin = '',
    userAgent = '',
    acceptLanguage = '',
    accept = '',
    customHeaders = []
  } = {}) {
    // 1. Determine effective Referer:
    // Frame URL or initiator (the iframe) must be used over tab URL (Requirement 1)
    let referer = rawReferer;
    let refererSource = 'rawReferer';

    if (!referer) {
      if (frameUrl && frameUrl !== 'about:blank') {
        referer = frameUrl;
        refererSource = 'frameUrl';
      } else if (initiator) {
        referer = initiator.endsWith('/') ? initiator : initiator + '/';
        refererSource = 'initiator';
      } else if (tabUrl) {
        referer = tabUrl;
        refererSource = 'tabUrl';
      }
    }

    // 2. Determine effective Origin:
    let origin = rawOrigin;
    let originSource = 'rawOrigin';

    if (!origin) {
      if (frameUrl && frameUrl !== 'about:blank') {
        try {
          origin = new URL(frameUrl).origin;
          originSource = 'frameUrl';
        } catch {}
      }
      if (!origin && initiator) {
        try {
          origin = new URL(initiator).origin;
          originSource = 'initiator';
        } catch {}
      }
      if (!origin && tabUrl) {
        try {
          origin = new URL(tabUrl).origin;
          originSource = 'tabUrl';
        } catch {}
      }
    }

    // 3. Format header collection
    const headers = {};
    if (referer) headers['Referer'] = referer;
    if (origin) headers['Origin'] = origin;
    if (userAgent) headers['User-Agent'] = userAgent;
    if (acceptLanguage) headers['Accept-Language'] = acceptLanguage;
    if (accept) headers['Accept'] = accept;

    if (Array.isArray(customHeaders)) {
      for (const ch of customHeaders) {
        if (ch && ch.name && ch.value) {
          const lower = ch.name.toLowerCase();
          if (!['cookie', 'referer', 'origin', 'user-agent', 'accept-language', 'accept'].includes(lower)) {
            headers[ch.name] = ch.value;
          }
        }
      }
    }

    const isIframe = !!(frameUrl && tabUrl && frameUrl !== tabUrl);

    return {
      referer,
      origin,
      headers,
      isIframe,
      refererSource,
      originSource
    };
  }

  /**
   * Redact sensitive authentication tokens, cookies, and keys for diagnostics export.
   *
   * @param {*} data
   * @returns {*}
   */
  function redactDiagnosticData(data) {
    if (!data) return data;
    if (typeof data === 'string') {
      return data
        .replace(/([?&](?:token|expires|exp|auth|sig|signature|key|session)=)[^&#\s]+/gi, '$1[REDACTED]')
        .replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
        .replace(/cookie:\s*[^;\r\n]+/gi, 'Cookie: [REDACTED]');
    }
    if (Array.isArray(data)) {
      return data.map(item => redactDiagnosticData(item));
    }
    if (typeof data === 'object') {
      const copy = {};
      for (const [k, v] of Object.entries(data)) {
        const lower = k.toLowerCase();
        if (lower.includes('cookie') || lower.includes('token') || lower.includes('auth') || lower.includes('secret') || lower.includes('sig')) {
          copy[k] = '[REDACTED]';
        } else {
          copy[k] = redactDiagnosticData(v);
        }
      }
      return copy;
    }
    return data;
  }

  /**
   * Find candidate frames matching expected embedding page or host from chrome.webNavigation.getAllFrames.
   *
   * @param {Array} allFrames
   * @param {Object} query
   * @returns {Array}
   */
  function findCandidateFrames(allFrames, { expectedFrameUrl = '', initiator = '', targetFrameId = 0 } = {}) {
    if (!Array.isArray(allFrames)) return [];
    return allFrames.filter(f => {
      if (f.frameId === targetFrameId) return false;
      if (f.frameId === 0) return false;
      if (!f.url || f.url === 'about:blank') return false;

      if (expectedFrameUrl) {
        try {
          const expHost = new URL(expectedFrameUrl).host;
          if (f.url.includes(expHost)) return true;
        } catch {}
      }
      if (initiator) {
        try {
          const initHost = new URL(initiator).host;
          if (f.url.includes(initHost)) return true;
        } catch {}
      }
      return true;
    });
  }

  return {
    resolveFrameHeaders,
    redactDiagnosticData,
    findCandidateFrames
  };
});
