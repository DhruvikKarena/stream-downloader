/* ===================================================================
   Stream Video Downloader — Inject Script (MAIN world)
   Runs in the page's own JS context so it can monkey-patch native APIs
   to intercept media URLs that are loaded via XHR, fetch, MSE, or
   direct src assignment.

   Detected URLs are forwarded to the content script (ISOLATED world)
   via window.postMessage.
   =================================================================== */

(() => {
  'use strict';

  // -------------------------------------------------------------------
  // 1. Constants
  // -------------------------------------------------------------------

  const MSG_TYPE = 'STREAM_DOWNLOADER_DETECTED';

  /** Extensions we consider "media" (matched against the URL pathname). */
  const MEDIA_EXT_RE =
    /\.(m3u8|mpd|mp4|webm|mkv|flv|avi|mov|ts|mp3|aac|flac|ogg|wav)(\?|#|$)/i;

  /** Content-Type substrings that indicate media responses. */
  const MEDIA_CONTENT_TYPES = [
    'mpegurl',        // application/vnd.apple.mpegurl, application/x-mpegurl
    'dash+xml',       // application/dash+xml
    'video/',
    'audio/',
    'octet-stream',   // generic binary — might be media
  ];

  /** Already-posted URLs (deduplicate within the page context). */
  const postedUrls = new Set();

  // -------------------------------------------------------------------
  // 2. Post a detected URL to the content script
  // -------------------------------------------------------------------

  function postDetected(url, source) {
    if (!url || typeof url !== 'string') return;

    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return;

    // Resolve against page location.
    let absolute;
    try {
      absolute = new URL(trimmed, location.href).href;
    } catch {
      return;
    }

    if (postedUrls.has(absolute)) return;
    postedUrls.add(absolute);

    window.postMessage({
      type: MSG_TYPE,
      url: absolute,
      source: source || 'inject',
    }, '*');
  }

  /** Quick test: does this URL look like a media resource? */
  function isMediaUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const pathname = new URL(url, location.href).pathname;
      return MEDIA_EXT_RE.test(pathname);
    } catch {
      return MEDIA_EXT_RE.test(url);
    }
  }

  // -------------------------------------------------------------------
  // 3. Intercept XMLHttpRequest
  // -------------------------------------------------------------------

  const OrigXHROpen = XMLHttpRequest.prototype.open;
  const OrigXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    // Store the URL so we can inspect it later in send().
    this._svd_url = url;

    if (isMediaUrl(url)) {
      postDetected(url, 'xhr');
    }

    return OrigXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    // Also listen for the response to detect media served with media
    // Content-Type but a generic URL.
    this.addEventListener('load', function onLoad() {
      try {
        const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
        if (MEDIA_CONTENT_TYPES.some(t => ct.includes(t))) {
          postDetected(this._svd_url || this.responseURL, 'xhr-ct');
        }
      } catch { /* cross-origin or network error — ignore */ }
    }, { once: true });

    return OrigXHRSend.apply(this, args);
  };

  // -------------------------------------------------------------------
  // 4. Intercept fetch()
  // -------------------------------------------------------------------

  const OrigFetch = window.fetch;

  window.fetch = function (input, init) {
    let url;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof Request) {
      url = input.url;
    } else if (input instanceof URL) {
      url = input.href;
    }

    if (url && isMediaUrl(url)) {
      postDetected(url, 'fetch');
    }

    // Call the original and also inspect the response content-type.
    const promise = OrigFetch.call(this, input, init);

    promise.then(response => {
      try {
        const ct = (response.headers.get('content-type') || '').toLowerCase();
        if (MEDIA_CONTENT_TYPES.some(t => ct.includes(t))) {
          postDetected(url || response.url, 'fetch-ct');
        }
      } catch { /* ignore */ }
    }).catch(() => { /* network error — ignore */ });

    return promise;
  };

  // -------------------------------------------------------------------
  // 5. Intercept HTMLMediaElement.prototype.src setter
  // -------------------------------------------------------------------

  const mediaProto = HTMLMediaElement.prototype;
  const origSrcDescriptor = Object.getOwnPropertyDescriptor(mediaProto, 'src');

  if (origSrcDescriptor && origSrcDescriptor.set) {
    Object.defineProperty(mediaProto, 'src', {
      configurable: true,
      enumerable: true,
      get: origSrcDescriptor.get,
      set(value) {
        if (value && isMediaUrl(value)) {
          postDetected(value, 'media-src');
        }
        return origSrcDescriptor.set.call(this, value);
      },
    });
  }

  // Also intercept the src attribute on <source> elements.
  const sourceProto = HTMLSourceElement.prototype;
  const origSourceSrcDesc = Object.getOwnPropertyDescriptor(sourceProto, 'src');

  if (origSourceSrcDesc && origSourceSrcDesc.set) {
    Object.defineProperty(sourceProto, 'src', {
      configurable: true,
      enumerable: true,
      get: origSourceSrcDesc.get,
      set(value) {
        if (value && isMediaUrl(value)) {
          postDetected(value, 'source-src');
        }
        return origSourceSrcDesc.set.call(this, value);
      },
    });
  }

  // -------------------------------------------------------------------
  // 6. Intercept MediaSource / SourceBuffer
  // -------------------------------------------------------------------

  if (typeof MediaSource !== 'undefined') {
    // Intercept URL.createObjectURL to track MediaSource blob URLs.
    const origCreateObjectURL = URL.createObjectURL;

    URL.createObjectURL = function (obj) {
      const blobUrl = origCreateObjectURL.call(this, obj);

      if (obj instanceof MediaSource) {
        // We can't extract the real stream URL from a MediaSource directly,
        // but we can watch its sourceBuffers for appended data.
        try {
          obj.addEventListener('sourceopen', () => {
            interceptSourceBuffers(obj);
          }, { once: true });
        } catch { /* ignore */ }
      }

      return blobUrl;
    };

    /**
     * Monitor SourceBuffers added to a MediaSource.
     * We intercept appendBuffer to detect the mime types being used,
     * which hints that MSE-based streaming is active.
     */
    function interceptSourceBuffers(ms) {
      try {
        const origAddSourceBuffer = ms.addSourceBuffer.bind(ms);
        ms.addSourceBuffer = function (mimeType) {
          // Signal that MSE streaming is happening with this mime type.
          // We won't have a direct URL, but the XHR/fetch intercepts
          // will catch the actual segment fetches.
          const sb = origAddSourceBuffer(mimeType);
          return sb;
        };
      } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------
  // 7. Intercept Element.setAttribute for src / href on media elements
  // -------------------------------------------------------------------

  const origSetAttribute = Element.prototype.setAttribute;

  Element.prototype.setAttribute = function (name, value) {
    if ((name === 'src' || name === 'href') && value && isMediaUrl(value)) {
      const tag = this.tagName;
      if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE' ||
          tag === 'A' || tag === 'EMBED') {
        postDetected(value, 'setAttribute');
      }
    }
    return origSetAttribute.call(this, name, value);
  };
})();
