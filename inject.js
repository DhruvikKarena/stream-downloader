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
  // 2. Safe string conversion & posting detected URLs
  // -------------------------------------------------------------------

  function toCleanString(val) {
    if (val == null) return '';
    if (typeof val === 'string') return val;
    if (typeof val.href === 'string') return val.href;
    if (typeof val.baseVal === 'string') return val.baseVal;
    if (typeof val.animVal === 'string') return val.animVal;
    if (typeof val.url === 'string') return val.url;
    try {
      const s = String(val);
      return (s === '[object Object]' || s === '[object HTMLMediaElement]') ? '' : s;
    } catch {
      return '';
    }
  }

  function postDetected(url, source, mediaType, size = 0, meta = {}) {
    const rawUrl = toCleanString(url);
    if (!rawUrl) return;

    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) return;

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
      mediaType: mediaType || undefined,
      size: size || undefined,
      meta: meta || undefined
    }, '*');
  }

  /** Quick test: does this URL look like a media resource? */
  function isMediaUrl(url) {
    const rawUrl = toCleanString(url);
    if (!rawUrl) return false;
    const lower = rawUrl.toLowerCase();
    if (lower.includes('googlevideo.com/videoplayback') || lower.includes('/videoplayback')) return true;
    if (lower.includes('.m3u8') || lower.includes('.mpd')) return true;
    if (lower.includes('mime=video') || lower.includes('mime=audio')) return true;
    if (lower.includes('mime%2fvideo') || lower.includes('mime%2faudio')) return true;

    try {
      const pathname = new URL(rawUrl, location.href).pathname;
      return MEDIA_EXT_RE.test(pathname);
    } catch {
      return MEDIA_EXT_RE.test(rawUrl);
    }
  }

  // -------------------------------------------------------------------
  // 3. Intercept XMLHttpRequest
  // -------------------------------------------------------------------

  const OrigXHROpen = XMLHttpRequest.prototype.open;
  const OrigXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const urlStr = toCleanString(url);
    this._svd_url = urlStr || url;

    if (urlStr && isMediaUrl(urlStr)) {
      let detectedType = undefined;
      const lower = urlStr.toLowerCase();
      if (lower.includes('mime=video') || lower.includes('mime%2fvideo')) {
        detectedType = 'video';
      } else if (lower.includes('mime=audio') || lower.includes('mime%2faudio')) {
        detectedType = 'audio';
      }
      postDetected(urlStr, 'xhr', detectedType);
    }

    return OrigXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function onLoad() {
      try {
        const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
        const cl = parseInt(this.getResponseHeader('content-length') || '0', 10);
        if (MEDIA_CONTENT_TYPES.some(t => ct.includes(t))) {
          const isVideo = ct.startsWith('video/') || ct.includes('video/mp4') || ct.includes('video/webm');
          const isAudio = ct.startsWith('audio/') || ct.includes('audio/mp4') || ct.includes('audio/webm');
          const mediaType = isVideo ? 'video' : (isAudio ? 'audio' : undefined);
          const target = toCleanString(this._svd_url || this.responseURL);
          if (target) {
            postDetected(target, 'xhr-ct', mediaType, cl);
          }
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
    let url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input.url === 'string') {
      url = input.url;
    } else if (input && typeof input.href === 'string') {
      url = input.href;
    } else {
      url = toCleanString(input);
    }

    if (url && isMediaUrl(url)) {
      let detectedType = undefined;
      const lower = url.toLowerCase();
      if (lower.includes('mime=video') || lower.includes('mime%2fvideo')) {
        detectedType = 'video';
      } else if (lower.includes('mime=audio') || lower.includes('mime%2faudio')) {
        detectedType = 'audio';
      }
      postDetected(url, 'fetch', detectedType);
    }

    const promise = OrigFetch.call(this, input, init);

    promise.then(response => {
      try {
        const ct = (response.headers.get('content-type') || '').toLowerCase();
        const cl = parseInt(response.headers.get('content-length') || '0', 10);
        if (MEDIA_CONTENT_TYPES.some(t => ct.includes(t))) {
          const isVideo = ct.startsWith('video/') || ct.includes('video/mp4') || ct.includes('video/webm');
          const isAudio = ct.startsWith('audio/') || ct.includes('audio/mp4') || ct.includes('audio/webm');
          const mediaType = isVideo ? 'video' : (isAudio ? 'audio' : undefined);
          const target = toCleanString(url || response.url);
          if (target) {
            postDetected(target, 'fetch-ct', mediaType, cl);
          }
        }
      } catch { /* ignore */ }
    }).catch(() => { /* network error — ignore */ });

    return promise;
  };

  // -------------------------------------------------------------------
  // 4.1 Scan YouTube Player Data (Direct streams with title & video+audio)
  // -------------------------------------------------------------------

  function scanYouTubePlayerData() {
    try {
      const pr = window.ytInitialPlayerResponse ||
                 (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && window.ytplayer.config.args.raw_player_response);
      if (!pr || !pr.streamingData) return;

      const title = pr.videoDetails ? pr.videoDetails.title : document.title.replace(/\s*-\s*YouTube$/i, '');
      const formats = pr.streamingData.formats || [];
      const adaptive = pr.streamingData.adaptiveFormats || [];

      // formats: streams that contain BOTH video AND audio together (360p, 720p MP4)
      for (const f of formats) {
        if (f.url) {
          postDetected(f.url, 'youtube-player', 'video', f.contentLength, {
            title: `${title} [${f.qualityLabel || '720p'} Video+Audio]`,
            hasAudio: true,
            resolution: f.qualityLabel || '720p',
            format: 'mp4'
          });
        }
      }

      // adaptiveFormats: separate high-res video (1080p, 4K) & audio tracks
      for (const f of adaptive) {
        if (f.url) {
          const isVideo = (f.mimeType || '').startsWith('video/');
          const isAudio = (f.mimeType || '').startsWith('audio/');
          const label = isVideo ? (f.qualityLabel || 'Video') : (f.audioQuality ? f.audioQuality.replace('AUDIO_QUALITY_', '') : 'Audio');
          postDetected(f.url, 'youtube-player', isVideo ? 'video' : (isAudio ? 'audio' : 'video'), f.contentLength, {
            title: `${title} [${label}]`,
            hasAudio: false,
            resolution: isVideo ? f.qualityLabel : '',
            quality: isAudio ? `${Math.round((f.bitrate || 128000) / 1000)} kbps` : '',
            format: isVideo ? ((f.mimeType || '').includes('webm') ? 'webm' : 'mp4') : ((f.mimeType || '').includes('webm') ? 'webm' : 'm4a')
          });
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // Scan YouTube player data periodically and on navigation
  if (location.hostname.includes('youtube.com')) {
    window.addEventListener('yt-navigate-finish', () => setTimeout(scanYouTubePlayerData, 1000));
    window.addEventListener('DOMContentLoaded', () => setTimeout(scanYouTubePlayerData, 1500));
    setInterval(scanYouTubePlayerData, 3000);
  }

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
        const valStr = toCleanString(value);
        if (valStr && isMediaUrl(valStr)) {
          postDetected(valStr, 'media-src');
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
        const valStr = toCleanString(value);
        if (valStr && isMediaUrl(valStr)) {
          postDetected(valStr, 'source-src');
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
    if (name === 'src' || name === 'href') {
      const valStr = toCleanString(value);
      if (valStr && isMediaUrl(valStr)) {
        const tag = this.tagName;
        if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE' ||
            tag === 'A' || tag === 'EMBED') {
          postDetected(valStr, 'setAttribute');
        }
      }
    }
    return origSetAttribute.call(this, name, value);
  };
})();
