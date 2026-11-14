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

  function safeSendMessage(payload) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(payload, () => {
        if (chrome.runtime.lastError) {
          // Suppress harmless "Receiving end does not exist" or closed channel warnings
        }
      });
    } catch (e) {
      // Suppress extension context invalidated errors after extension reload
    }
  }

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

  function reportMedia(url, source = 'content', mediaType, size, meta) {
    const rawUrl = toCleanString(url);
    if (!rawUrl) return;
    if (!chrome.runtime || !chrome.runtime.id) return;

    // Normalise and skip data: / blob: / empty strings.
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) return;

    // Resolve relative URLs against the current document location.
    let absoluteUrl;
    try {
      absoluteUrl = new URL(trimmed, document.location.href).href;
    } catch {
      return;
    }

    if (reportedUrls.has(absoluteUrl)) return;
    reportedUrls.add(absoluteUrl);

    safeSendMessage({
      action: 'mediaDetected',
      url: absoluteUrl,
      source,
      mediaType: mediaType || undefined,
      size: size || undefined,
      meta: meta || undefined
    });
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
    if (!data) return;

    if (data.type === MSG_TYPE) {
      const url = data.url;
      if (url) {
        reportMedia(url, data.source || 'inject', data.mediaType, data.size, data.meta);
      }
    } else if (data.type === 'STREAM_PLAYLIST_CACHED') {
      // Re-use what the player already loaded (Requirement 2)
      safeSendMessage({
        action: 'cachePlaylist',
        url: data.url,
        finalUrl: data.finalUrl,
        text: data.text,
        format: data.format,
        frameUrl: data.frameUrl || location.href,
        status: data.status
      });
    }
  });

  // -------------------------------------------------------------------
  // 7. Video + Audio Recorder (Recording Mode / CocoCut Style)
  // -------------------------------------------------------------------

  let mediaRecorder = null;
  let recordedBlobs = [];
  let recordingTimer = null;
  let recordingStartMs = 0;
  let floatingWidget = null;

  function getBestSupportedMimeType() {
    const types = [
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'video/mp4',
      'video/webm; codecs=vp9,opus',
      'video/webm; codecs=vp8,opus',
      'video/webm',
    ];
    for (const t of types) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
        return t;
      }
    }
    return 'video/webm';
  }

  function findBestVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    const playing = videos.find(v => !v.paused && v.currentTime > 0);
    if (playing) return playing;
    const ytVideo = document.querySelector('video.html5-main-video');
    if (ytVideo) return ytVideo;
    return videos.reduce((a, b) => {
      const aArea = (a.videoWidth || a.clientWidth || 0) * (a.videoHeight || a.clientHeight || 0);
      const bArea = (b.videoWidth || b.clientWidth || 0) * (b.videoHeight || b.clientHeight || 0);
      return bArea > aArea ? b : a;
    });
  }

  function formatRecordingTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatBytesLocal(bytes) {
    if (!bytes || bytes <= 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }

  function createFloatingWidget() {
    if (floatingWidget) return;
    floatingWidget = document.createElement('div');
    floatingWidget.id = 'svd-recording-widget';
    floatingWidget.innerHTML = `
      <div style="
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        background: #1a1a2e;
        border: 2px solid #e94560;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        padding: 12px 18px;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 14px;
      ">
        <span style="display:inline-block; width:12px; height:12px; background:#e94560; border-radius:50%; animation:svd-blink 1s infinite;"></span>
        <div>
          <div style="font-weight:700; color:#fff; font-size:13px;">Recording Video + Audio</div>
          <div id="svd-rec-status" style="font-size:11px; color:#a0a0b0; margin-top:2px;">00:00 (0.0 MB)</div>
        </div>
        <button id="svd-rec-stop-btn" style="
          background: #4CAF50;
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 6px 12px;
          font-weight: 600;
          cursor: pointer;
          font-size: 12px;
        ">Finish & Save</button>
        <button id="svd-rec-cancel-btn" style="
          background: transparent;
          color: #8b949e;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 6px 10px;
          cursor: pointer;
          font-size: 12px;
        ">Cancel</button>
      </div>
      <style>
        @keyframes svd-blink {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.3; transform: scale(0.85); }
        }
      </style>
    `;
    document.documentElement.appendChild(floatingWidget);

    document.getElementById('svd-rec-stop-btn')?.addEventListener('click', () => stopRecording());
    document.getElementById('svd-rec-cancel-btn')?.addEventListener('click', () => cancelRecording());
  }

  function updateFloatingWidget() {
    if (!floatingWidget || !mediaRecorder) return;
    const elapsed = Math.floor((Date.now() - recordingStartMs) / 1000);
    const totalBytes = recordedBlobs.reduce((acc, b) => acc + b.size, 0);
    const statusEl = document.getElementById('svd-rec-status');
    if (statusEl) {
      statusEl.textContent = `${formatRecordingTime(elapsed)} (${formatBytesLocal(totalBytes)})`;
    }
  }

  function removeFloatingWidget() {
    if (floatingWidget) {
      floatingWidget.remove();
      floatingWidget = null;
    }
  }

  function startRecording(sendResponse) {
    const video = findBestVideo();
    if (!video) {
      if (sendResponse) sendResponse({ success: false, error: 'No video element found on this page. Please start playing a video first.' });
      return;
    }

    try {
      // Ensure playback is active so frames and audio stream
      if (video.paused) {
        video.play().catch(() => {});
      }

      const stream = video.captureStream ? video.captureStream() : (video.webkitCaptureStream ? video.webkitCaptureStream() : null);
      if (!stream) throw new Error('Browser could not capture stream from video element');

      const videoTracks = stream.getVideoTracks();
      let audioTracks = stream.getAudioTracks();

      // Audio capture fallback if captureStream did not include audio
      if (audioTracks.length === 0) {
        try {
          if (!window._svd_actx) {
            window._svd_actx = new (window.AudioContext || window.webkitAudioContext)();
          }
          if (window._svd_actx.state === 'suspended') {
            window._svd_actx.resume();
          }
          if (!video._svd_audio_source) {
            video._svd_audio_source = window._svd_actx.createMediaElementSource(video);
          }
          const dest = window._svd_actx.createMediaStreamDestination();
          video._svd_audio_source.connect(dest);
          video._svd_audio_source.connect(window._svd_actx.destination);
          audioTracks = dest.stream.getAudioTracks();
        } catch (e) {
          console.warn('AudioContext routing note:', e);
        }
      }

      const combined = new MediaStream([...videoTracks, ...audioTracks]);
      const mimeType = getBestSupportedMimeType();
      mediaRecorder = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: 5000000
      });
      recordedBlobs = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedBlobs.push(e.data);
          updateFloatingWidget();
        }
      };

      mediaRecorder.onstop = () => {
        clearInterval(recordingTimer);
        removeFloatingWidget();
        if (recordedBlobs.length === 0) return;

        const isMp4 = mimeType.includes('mp4');
        const finalBlob = new Blob(recordedBlobs, { type: mimeType });
        const rawTitle = toCleanString(document.title) || 'video_recording';
        const cleanTitle = rawTitle.replace(/[\\/:*?"<>|]/g, '_').replace(/\s*-\s*YouTube$/i, '').trim();
        const filename = `${cleanTitle || 'video'}.${isMp4 ? 'mp4' : 'webm'}`;

        const a = document.createElement('a');
        const blobUrl = URL.createObjectURL(finalBlob);
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      };

      mediaRecorder.start(1000);
      recordingStartMs = Date.now();
      createFloatingWidget();
      recordingTimer = setInterval(updateFloatingWidget, 1000);

      if (sendResponse) sendResponse({ success: true, mimeType });
    } catch (err) {
      console.error('Failed to start recording:', err);
      if (sendResponse) sendResponse({ success: false, error: err.message });
    }
  }

  function stopRecording(sendResponse) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      if (sendResponse) sendResponse({ success: true });
    } else {
      if (sendResponse) sendResponse({ success: false, error: 'Not currently recording' });
    }
  }

  function cancelRecording(sendResponse) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      recordedBlobs = [];
      mediaRecorder.stop();
      removeFloatingWidget();
      if (sendResponse) sendResponse({ success: true });
    }
  }

  // -------------------------------------------------------------------
  // 8. Listen for messages from popup & background
  // -------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Strategy B: Frame Fetch Bridge (Cross-Origin Iframe fallback)
    if (message.type === 'FETCH' || message.action === 'FETCH') {
      (async () => {
        try {
          const fetchUrl = message.url;
          const asType = message.as || 'text'; // 'text' | 'arraybuffer'
          const headers = message.headers || {};

          const res = await fetch(fetchUrl, {
            credentials: 'include',
            referrer: location.href,
            headers
          });

          const resHeaders = {};
          res.headers.forEach((v, k) => { resHeaders[k.toLowerCase()] = v; });

          if (asType === 'arraybuffer' || asType === 'bytes') {
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            const totalBytes = bytes.byteLength;
            const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB per chunk (well under 32 MB limit)

            if (totalBytes > CHUNK_SIZE) {
              const chunks = [];
              for (let offset = 0; offset < totalBytes; offset += CHUNK_SIZE) {
                const slice = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, totalBytes));
                let binary = '';
                const sliceLen = slice.byteLength;
                for (let i = 0; i < sliceLen; i += 8192) {
                  binary += String.fromCharCode.apply(null, slice.subarray(i, Math.min(i + 8192, sliceLen)));
                }
                chunks.push(btoa(binary));
              }
              sendResponse({
                ok: res.ok,
                status: res.status,
                statusText: res.statusText,
                contentType: res.headers.get('content-type') || '',
                url: res.url,
                redirected: res.redirected,
                headers: resHeaders,
                chunks,
                byteLength: totalBytes,
                frameUrl: location.href
              });
            } else {
              let binary = '';
              for (let i = 0; i < totalBytes; i += 8192) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, totalBytes)));
              }
              sendResponse({
                ok: res.ok,
                status: res.status,
                statusText: res.statusText,
                contentType: res.headers.get('content-type') || '',
                url: res.url,
                redirected: res.redirected,
                headers: resHeaders,
                base64: btoa(binary),
                byteLength: totalBytes,
                frameUrl: location.href
              });
            }
          } else {
            const text = await res.text();
            sendResponse({
              ok: res.ok,
              status: res.status,
              statusText: res.statusText,
              contentType: res.headers.get('content-type') || '',
              url: res.url,
              redirected: res.redirected,
              headers: resHeaders,
              text,
              frameUrl: location.href
            });
          }
        } catch (err) {
          sendResponse({
            ok: false,
            status: 0,
            statusText: err.name || 'FetchError',
            error: err.message,
            frameUrl: location.href
          });
        }
      })();
      return true; // async
    }

    if (message.action === 'HLS_STREAM_DETECTED') {
      sendResponse({ received: true });
      return false;
    }

    if (message.action === 'scanDOM') {
      scanDOM();
      sendResponse({ received: true });
      return false;
    }

    if (message.action === 'hasVideoElement') {
      const v = findBestVideo();
      sendResponse({
        hasVideo: !!v,
        isPlaying: v ? (!v.paused && v.currentTime > 0) : false,
        isRecording: mediaRecorder ? mediaRecorder.state === 'recording' : false
      });
      return false;
    }

    if (message.action === 'startRecording') {
      startRecording(sendResponse);
      return true; // async
    }

    if (message.action === 'stopRecording') {
      stopRecording(sendResponse);
      return true;
    }

    if (message.action === 'getRecordingStatus') {
      const isRec = mediaRecorder ? mediaRecorder.state === 'recording' : false;
      const elapsed = isRec ? Math.floor((Date.now() - recordingStartMs) / 1000) : 0;
      const totalBytes = recordedBlobs.reduce((acc, b) => acc + b.size, 0);
      sendResponse({ isRecording: isRec, elapsed, totalBytes });
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
