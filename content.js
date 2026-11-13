/* ===================================================================
   Stream Video Downloader — Content Script
   Runs at document_start in the ISOLATED world.
   - Receives media detections from inject.js (MAIN world) via postMessage.
   - Scans the DOM for <video> / <audio> elements and their sources.
   - Uses MutationObserver to catch dynamically added media elements.
   =================================================================== */

(() => {
  'use strict';

  // -------------------------------------------------------------------
  // 1. Constants
  // -------------------------------------------------------------------

  const MSG_TYPE = 'STREAM_DOWNLOADER_DETECTED';

  /**
   * Media-file extensions we care about (matched against the pathname).
   * Keep in sync with background.js patterns.
   */
  const MEDIA_EXT_RE = /\.(m3u8|mpd|mp4|webm|mkv|flv|avi|mov|ts|mp3|aac|flac|ogg|wav)(\?|$)/i;

  /** Already-reported URLs (avoid duplicate messages to background). */
  const reportedUrls = new Set();

  // -------------------------------------------------------------------
  // 2. Report a detected media URL to the background service worker
  // -------------------------------------------------------------------

  function reportMedia(url, source = 'content') {
    if (!url || typeof url !== 'string') return;

    // Normalise and skip data: / blob: / empty strings.
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return;

    // Resolve relative URLs against the current document location.
    let absoluteUrl;
    try {
      absoluteUrl = new URL(trimmed, document.location.href).href;
    } catch {
      return;
    }

    if (reportedUrls.has(absoluteUrl)) return;
    reportedUrls.add(absoluteUrl);

    chrome.runtime.sendMessage({
      action: 'mediaDetected',
      url: absoluteUrl,
      source,
    }).catch(() => { /* extension context may have been invalidated */ });
  }

  // -------------------------------------------------------------------
  // 3. Scan a single media element (<video> or <audio>)
  // -------------------------------------------------------------------

  function scanMediaElement(el) {
    // Direct src attribute.
    if (el.src && MEDIA_EXT_RE.test(el.src)) {
      reportMedia(el.src, 'dom');
    }
    // currentSrc (set after source selection).
    if (el.currentSrc && MEDIA_EXT_RE.test(el.currentSrc)) {
      reportMedia(el.currentSrc, 'dom');
    }
    // <source> children.
    const sources = el.querySelectorAll('source');
    for (const source of sources) {
      const srcVal = source.getAttribute('src');
      if (srcVal && MEDIA_EXT_RE.test(srcVal)) {
        reportMedia(srcVal, 'dom');
      }
    }
  }

  // -------------------------------------------------------------------
  // 4. Full DOM scan
  // -------------------------------------------------------------------

  function scanDOM() {
    const mediaElements = document.querySelectorAll('video, audio');
    for (const el of mediaElements) {
      scanMediaElement(el);
    }

    // Also look for <a> / <embed> / <object> / <iframe> pointing at media.
    const anchors = document.querySelectorAll('a[href], embed[src], object[data], iframe[src]');
    for (const el of anchors) {
      const href = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data');
      if (href && MEDIA_EXT_RE.test(href)) {
        reportMedia(href, 'dom');
      }
    }
  }

  // -------------------------------------------------------------------
  // 5. MutationObserver — watch for dynamically added media elements
  // -------------------------------------------------------------------

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Check added nodes.
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // The node itself could be a media element.
          if (node.matches && node.matches('video, audio')) {
            scanMediaElement(node);
          }

          // Or it could contain media elements.
          if (node.querySelectorAll) {
            const nested = node.querySelectorAll('video, audio');
            for (const el of nested) {
              scanMediaElement(el);
            }
          }

          // Also check for links / embeds.
          if (node.matches && node.matches('a[href], embed[src], object[data], source[src]')) {
            const href = node.getAttribute('href') || node.getAttribute('src') || node.getAttribute('data');
            if (href && MEDIA_EXT_RE.test(href)) {
              reportMedia(href, 'dom');
            }
          }
        }

        // Attribute changes on media elements (e.g., src updated).
        if (mutation.type === 'attributes' && mutation.target.matches &&
            mutation.target.matches('video, audio, source')) {
          scanMediaElement(mutation.target.closest('video, audio') || mutation.target);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data'],
    });
  }

  // -------------------------------------------------------------------
  // 6. Listen for messages from inject.js (MAIN world) via postMessage
  // -------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    // Only accept messages from the same frame.
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.type !== MSG_TYPE) return;

    const url = data.url;
    if (url) {
      reportMedia(url, data.source || 'inject');
    }
  });

  // -------------------------------------------------------------------
  // 7. Listen for messages from the background script
  // -------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'HLS_STREAM_DETECTED') {
      // Background is informing us about a detected HLS stream.
      // We can surface this to the page or simply acknowledge.
      sendResponse({ received: true });
      return false;
    }

    if (message.action === 'scanDOM') {
      // On-demand DOM scan requested by popup or background.
      scanDOM();
      sendResponse({ received: true });
      return false;
    }

    return false;
  });

  // -------------------------------------------------------------------
  // 8. Bootstrap — safe for document_start
  // -------------------------------------------------------------------

  /**
   * Because this script is injected at document_start, the DOM tree may
   * not yet exist beyond <html>.  We wait for the document element to be
   * available before attaching the MutationObserver, and perform the
   * initial full scan once the body is ready.
   */

  function init() {
    if (document.documentElement) {
      startObserver();
    } else {
      // Extremely early — wait for the element.
      const earlyObserver = new MutationObserver(() => {
        if (document.documentElement) {
          earlyObserver.disconnect();
          startObserver();
        }
      });
      earlyObserver.observe(document, { childList: true });
    }

    // Full scan once the body exists.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scanDOM, { once: true });
    } else {
      scanDOM();
    }

    // Re-scan after full load (catches lazy-loaded media).
    window.addEventListener('load', scanDOM, { once: true });
  }

  init();
})();
