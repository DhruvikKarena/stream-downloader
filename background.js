/* ===================================================================
   Stream Video Downloader — Background Service Worker
   Detects media streams via webRequest, manages per-tab media lists,
   parses HLS/DASH manifests, and runs a multi-threaded download engine.
   =================================================================== */

// ---------------------------------------------------------------------------
// 1. Constants & Patterns
// ---------------------------------------------------------------------------

/** Regex applied to the *pathname* portion of a URL (before query string). */
const MEDIA_PATTERNS = {
  hls:   /\.m3u8$/i,
  dash:  /\.mpd$/i,
  video: /\.(mp4|webm|mkv|flv|avi|mov)$/i,
  ts:    /\.ts$/i,
  audio: /\.(mp3|aac|flac|ogg|wav)$/i,
};

/** Domains whose URLs we silently ignore (analytics / tracking CDNs). */
const IGNORED_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'facebook.com',
  'facebook.net',
  'analytics.',
  'tracking.',
  'pixel.',
  'beacon.',
  'telemetry.',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'hotjar.com',
  'newrelic.com',
  'sentry.io',
];

const BADGE_COLOR = '#4CAF50';
const DEFAULT_THREAD_COUNT = 6;
const MAX_THREAD_COUNT = 16;
const SEGMENT_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// 2. In-memory state (survives as long as the SW is alive; persisted to
//    session storage so it can be restored after a SW restart).
// ---------------------------------------------------------------------------

/** Map<number, MediaItem[]>  —  tabId → detected media items */
const mediaByTab = new Map();

/** Map<string, DownloadState>  —  downloadId → progress object */
const activeDownloads = new Map();

/**
 * @typedef {Object} MediaItem
 * @property {string}  url       - The detected media URL.
 * @property {string}  type      - One of 'hls','dash','video','audio','ts'.
 * @property {string}  filename  - Best-guess filename from the URL path.
 * @property {number}  tabId     - Tab where it was detected.
 * @property {number}  timestamp - Detection epoch ms.
 * @property {string}  [title]   - Page title at detection time.
 * @property {string}  [source]  - How it was detected (webRequest | content | inject).
 */

/**
 * @typedef {Object} DownloadState
 * @property {string}  id              - Unique download identifier.
 * @property {string}  url             - Source URL.
 * @property {string}  type            - 'hls' | 'dash' | 'direct'.
 * @property {string}  status          - 'downloading' | 'merging' | 'complete' | 'error'.
 * @property {number}  totalSegments   - Total segment count (0 for direct).
 * @property {number}  completedSegments
 * @property {number}  failedSegments
 * @property {number}  bytesDownloaded
 * @property {string}  [error]
 */

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the "clean" pathname from a URL string (strips query & fragment).
 * Returns null for unparseable URLs.
 */
function urlPathname(urlStr) {
  try {
    return new URL(urlStr).pathname;
  } catch {
    return null;
  }
}

/** Check if a hostname belongs to an ignored analytics/tracking domain. */
function isIgnoredDomain(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return IGNORED_DOMAINS.some(d => host.includes(d));
  } catch {
    return false;
  }
}

/** Classify a URL by its path extension. Returns type string or null. */
function classifyUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const pathname = urlPathname(urlStr) || '';

  if (MEDIA_PATTERNS.hls.test(pathname) || /\.m3u8($|\?|#)/i.test(urlStr)) return 'hls';
  if (MEDIA_PATTERNS.dash.test(pathname) || /\.mpd($|\?|#)/i.test(urlStr)) return 'dash';
  if (MEDIA_PATTERNS.video.test(pathname) || /\.(mp4|webm|mkv|flv|avi|mov)($|\?|#)/i.test(urlStr)) return 'video';
  if (MEDIA_PATTERNS.audio.test(pathname) || /\.(mp3|aac|flac|ogg|wav)($|\?|#)/i.test(urlStr)) return 'audio';
  if (MEDIA_PATTERNS.ts.test(pathname) || /\.ts($|\?|#)/i.test(urlStr)) return 'ts';
  return null;
}

/** Extract a human-readable filename from a URL. */
function filenameFromUrl(urlStr) {
  try {
    const pathname = new URL(urlStr).pathname;
    const parts = pathname.split('/');
    const last = parts[parts.length - 1];
    return decodeURIComponent(last) || 'media';
  } catch {
    return 'media';
  }
}

/** Build a session-storage key for a given tab. */
function storageKey(tabId) {
  return `tab_${tabId}`;
}

/** Persist the current media list for a tab into session storage. */
async function persistTab(tabId) {
  const items = mediaByTab.get(tabId) || [];
  await chrome.storage.session.set({ [storageKey(tabId)]: items });
}

/** Restore all tab data from session storage (called on SW start). */
async function restoreState() {
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('tab_') && Array.isArray(value)) {
      const tabId = parseInt(key.slice(4), 10);
      if (!isNaN(tabId)) {
        mediaByTab.set(tabId, value);
        updateBadge(tabId);
      }
    }
  }
}

// Restore on SW startup.
restoreState();

// ---------------------------------------------------------------------------
// 4. Badge management
// ---------------------------------------------------------------------------

function updateBadge(tabId) {
  const items = mediaByTab.get(tabId) || [];
  const count = items.length;
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 5. Add a detected media item (deduplicates by URL)
// ---------------------------------------------------------------------------

async function addMediaItem(tabId, url, type, source = 'webRequest') {
  if (!tabId || tabId < 0) return;

  let items = mediaByTab.get(tabId);
  if (!items) {
    items = [];
    mediaByTab.set(tabId, items);
  }

  // Deduplicate by URL.
  if (items.some(m => m.url === url)) return;

  // For .ts files, skip if we already track an HLS playlist for this tab
  // (the .ts is likely a segment of that playlist, not a standalone file).
  if (type === 'ts') {
    const hasHls = items.some(m => m.type === 'hls');
    if (hasHls) return;
  }

  let title = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    title = tab.title || '';
  } catch { /* tab may have closed */ }

  const item = {
    url,
    type,
    filename: filenameFromUrl(url),
    tabId,
    timestamp: Date.now(),
    title,
    source,
  };

  items.push(item);
  await persistTab(tabId);
  updateBadge(tabId);

  // Notify any open popup about the new detection
  chrome.runtime.sendMessage({
    action: 'newMediaDetected',
    tabId,
    item,
  }).catch(() => { /* popup may not be open */ });
}

// ---------------------------------------------------------------------------
// 6. webRequest listener — detect media URLs in network traffic
// ---------------------------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0) return;           // background / service-worker request
    if (isIgnoredDomain(url)) return;

    const type = classifyUrl(url);
    if (type) {
      addMediaItem(tabId, url, type, 'webRequest');
    }
  },
  { urls: ['<all_urls>'] }
);

// ---------------------------------------------------------------------------
// 7. Tab cleanup
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
});

// ---------------------------------------------------------------------------
// 8. M3U8 / HLS parser
// ---------------------------------------------------------------------------

/**
 * Fetch and parse an M3U8 playlist.
 * @param {string} m3u8Url - The URL of the .m3u8 file.
 * @returns {Promise<Object>} Parsed result.
 */
async function parseM3U8(m3u8Url) {
  const response = await fetch(m3u8Url, {
    headers: { 'Accept': '*/*' },
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch m3u8: HTTP ${response.status}`);
  }
  const text = await response.text();
  return parseM3U8Text(text, m3u8Url);
}

/**
 * Parse raw M3U8 text content.
 * @param {string} text      - The raw playlist text.
 * @param {string} baseUrl   - URL used to resolve relative paths.
 * @returns {Object}          Parsed playlist descriptor.
 */
function parseM3U8Text(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('Invalid M3U8: missing #EXTM3U header');
  }

  // Determine playlist type.
  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

  if (isMaster) {
    return parseMasterPlaylist(lines, baseUrl);
  }
  return parseMediaPlaylist(lines, baseUrl);
}

/**
 * Parse a master (variant) playlist.
 */
function parseMasterPlaylist(lines, baseUrl) {
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    // Extract attributes.
    const attrs = line.substring(line.indexOf(':') + 1);
    const bandwidth  = extractAttr(attrs, 'BANDWIDTH');
    const resolution = extractAttr(attrs, 'RESOLUTION');
    const codecs     = extractAttr(attrs, 'CODECS');

    // The next non-comment line is the variant URL.
    let variantUrl = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].startsWith('#')) {
        variantUrl = resolveUrl(lines[j], baseUrl);
        break;
      }
    }

    variants.push({
      bandwidth:  bandwidth ? parseInt(bandwidth, 10) : 0,
      resolution: resolution || '',
      codecs:     codecs || '',
      url:        variantUrl,
    });
  }

  return { type: 'master', variants };
}

/**
 * Parse a media (segment) playlist.
 */
function parseMediaPlaylist(lines, baseUrl) {
  const segments = [];
  let totalDuration = 0;
  let currentDuration = 0;
  let encryptionInfo = null;
  let mediaSequence = 0;
  let targetDuration = 0;
  let version = 0;
  let hasEndList = false;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-VERSION')) {
      version = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION')) {
      targetDuration = parseFloat(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY')) {
      encryptionInfo = parseKeyTag(line, baseUrl);
    } else if (line.startsWith('#EXTINF')) {
      currentDuration = parseFloat(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndList = true;
    } else if (!line.startsWith('#')) {
      // It's a segment URL.
      const segUrl = resolveUrl(line, baseUrl);
      segments.push({
        url: segUrl,
        duration: currentDuration,
        encryption: encryptionInfo,
      });
      totalDuration += currentDuration;
      currentDuration = 0;
    }
  }

  return {
    type: 'media',
    version,
    targetDuration,
    mediaSequence,
    totalDuration,
    hasEndList,
    encryptionInfo,
    segments,
  };
}

/** Extract a named attribute value from an HLS attribute string. */
function extractAttr(attrStr, name) {
  // Handles both quoted and unquoted values (e.g. BANDWIDTH=1280000 or CODECS="avc1.42e00a")
  const match = attrStr.match(new RegExp(name + '=(?:"([^"]*)"|([^,\\s]*))'));
  return match ? (match[1] || match[2] || '') : '';
}

/** Parse an #EXT-X-KEY tag. */
function parseKeyTag(line, baseUrl) {
  const attrs = line.substring(line.indexOf(':') + 1);
  const method = extractAttr(attrs, 'METHOD');
  const uri    = extractAttr(attrs, 'URI');
  const iv     = extractAttr(attrs, 'IV');

  return {
    method,
    uri: uri ? resolveUrl(uri, baseUrl) : '',
    iv: iv || '',
  };
}

/** Resolve a potentially relative URL against a base. */
function resolveUrl(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

// ---------------------------------------------------------------------------
// 9. DASH / MPD parser (basic)
// ---------------------------------------------------------------------------

async function parseMPD(mpdUrl) {
  const response = await fetch(mpdUrl, {
    headers: { 'Accept': '*/*' },
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch MPD: HTTP ${response.status}`);
  }
  const text = await response.text();
  return parseMPDText(text, mpdUrl);
}

/**
 * Lightweight MPD parser — extracts segment URLs from SegmentList and
 * SegmentTemplate (number-based) representations.
 */
function parseMPDText(xmlText, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  const representations = [];

  const repEls = doc.querySelectorAll('Representation');
  for (const rep of repEls) {
    const id         = rep.getAttribute('id') || '';
    const bandwidth  = parseInt(rep.getAttribute('bandwidth') || '0', 10);
    const width      = parseInt(rep.getAttribute('width') || '0', 10);
    const height     = parseInt(rep.getAttribute('height') || '0', 10);
    const mimeType   = rep.getAttribute('mimeType') ||
                       rep.closest('AdaptationSet')?.getAttribute('mimeType') || '';

    const segments = [];

    // --- SegmentList ---
    const segList = rep.querySelector('SegmentList');
    if (segList) {
      const initSeg = segList.querySelector('Initialization');
      if (initSeg) {
        const initUrl = initSeg.getAttribute('sourceURL');
        if (initUrl) segments.push({ url: resolveUrl(initUrl, baseUrl), init: true });
      }
      for (const segUrl of segList.querySelectorAll('SegmentURL')) {
        const media = segUrl.getAttribute('media');
        if (media) segments.push({ url: resolveUrl(media, baseUrl), init: false });
      }
    }

    // --- SegmentTemplate with SegmentTimeline ---
    const segTpl = rep.querySelector('SegmentTemplate') ||
                   rep.closest('AdaptationSet')?.querySelector('SegmentTemplate');
    if (segTpl && segments.length === 0) {
      const initTpl = segTpl.getAttribute('initialization') || '';
      const mediaTpl = segTpl.getAttribute('media') || '';
      const startNumber = parseInt(segTpl.getAttribute('startNumber') || '1', 10);

      if (initTpl) {
        const initUrl = initTpl.replace('$RepresentationID$', id)
                               .replace('$Bandwidth$', String(bandwidth));
        segments.push({ url: resolveUrl(initUrl, baseUrl), init: true });
      }

      const timeline = segTpl.querySelector('SegmentTimeline');
      if (timeline) {
        let segNum = startNumber;
        let time = 0;
        for (const s of timeline.querySelectorAll('S')) {
          const d = parseInt(s.getAttribute('d') || '0', 10);
          const r = parseInt(s.getAttribute('r') || '0', 10);
          const t = s.getAttribute('t');
          if (t !== null) time = parseInt(t, 10);

          for (let i = 0; i <= r; i++) {
            const segUrl = mediaTpl
              .replace('$RepresentationID$', id)
              .replace('$Bandwidth$', String(bandwidth))
              .replace('$Number$', String(segNum))
              .replace('$Time$', String(time));
            segments.push({ url: resolveUrl(segUrl, baseUrl), init: false });
            segNum++;
            time += d;
          }
        }
      } else {
        // No timeline — try a reasonable number range (we won't know
        // how many segments exist without duration / timescale math,
        // so we fall back to providing the template info).
      }
    }

    // --- BaseURL (single-file representation) ---
    if (segments.length === 0) {
      const baseUrlEl = rep.querySelector('BaseURL');
      if (baseUrlEl && baseUrlEl.textContent) {
        segments.push({ url: resolveUrl(baseUrlEl.textContent.trim(), baseUrl), init: false });
      }
    }

    representations.push({
      id,
      bandwidth,
      width,
      height,
      mimeType,
      segments,
    });
  }

  return { type: 'dash', representations };
}

// ---------------------------------------------------------------------------
// 10. Multi-threaded download engine
// ---------------------------------------------------------------------------

/**
 * Download a list of segment URLs concurrently with a pool of N workers.
 * Sends progress messages to the popup.
 *
 * @param {Object}   opts
 * @param {string}   opts.downloadId   - Unique identifier for this download job.
 * @param {Object[]} opts.segments     - Array of { url } segment descriptors.
 * @param {number}   opts.threadCount  - Concurrency limit.
 * @param {string}   opts.filename     - Target filename.
 * @returns {Promise<Blob>}             Concatenated blob.
 */
async function downloadSegments({ downloadId, segments, threadCount, filename }) {
  const threads = Math.min(Math.max(threadCount || DEFAULT_THREAD_COUNT, 1), MAX_THREAD_COUNT);

  const state = {
    id: downloadId,
    url: segments[0]?.url || '',
    type: 'hls',
    status: 'downloading',
    totalSegments: segments.length,
    completedSegments: 0,
    failedSegments: 0,
    bytesDownloaded: 0,
    error: null,
  };
  activeDownloads.set(downloadId, state);
  broadcastProgress(state);

  /** Buffer to hold downloaded data in order. */
  const results = new Array(segments.length);

  /** Index of the next segment to start downloading. */
  let nextIndex = 0;

  /**
   * Worker function — fetches the segment at `idx` with retry.
   */
  async function fetchSegment(idx) {
    const seg = segments[idx];
    let lastErr = null;

    for (let attempt = 0; attempt < SEGMENT_MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(seg.url, {
          headers: { 'Accept': '*/*' },
          credentials: 'include',
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        results[idx] = buf;
        state.completedSegments++;
        state.bytesDownloaded += buf.byteLength;
        broadcastProgress(state);
        return;
      } catch (err) {
        lastErr = err;
        // Exponential backoff: 500ms, 1s, 2s …
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }

    // All retries exhausted.
    results[idx] = null;
    state.failedSegments++;
    broadcastProgress(state);
    console.warn(`[Downloader] Segment ${idx} failed after ${SEGMENT_MAX_RETRIES} retries:`, lastErr);
  }

  /**
   * Pool runner — keeps `threads` workers active at a time.
   */
  async function runPool() {
    async function worker() {
      while (nextIndex < segments.length) {
        const idx = nextIndex++;
        await fetchSegment(idx);
      }
    }
    const workers = [];
    for (let i = 0; i < threads; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  await runPool();

  // Merge all buffers.
  state.status = 'merging';
  broadcastProgress(state);

  const validBuffers = results.filter(Boolean);
  const totalBytes = validBuffers.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const buf of validBuffers) {
    merged.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  const blob = new Blob([merged], { type: 'video/mp2t' });
  state.status = 'complete';
  broadcastProgress(state);
  activeDownloads.delete(downloadId);

  return blob;
}

/** Send download progress to any open popup / runtime listeners. */
function broadcastProgress(state) {
  chrome.runtime.sendMessage({
    action: 'downloadProgress',
    data: { ...state },
  }).catch(() => { /* popup may not be open */ });
}

// ---------------------------------------------------------------------------
// 11. Download kick-off
// ---------------------------------------------------------------------------

async function startDownload(request) {
  const { url, type, filename, threadCount, variantUrl } = request;

  // ----- Direct file -----
  if (type === 'video' || type === 'audio' || type === 'direct') {
    const downloadId = await chrome.downloads.download({
      url,
      filename: filename || filenameFromUrl(url),
      saveAs: true,
    });
    return { success: true, downloadId };
  }

  // ----- HLS & DASH Streams -----
  // Streams are downloaded via the dedicated multi-threaded downloader tab
  // which supports DOM APIs (Blob, URL.createObjectURL), AES-128 decryption,
  // configurable worker threads, and visual matrix without service worker limits.
  if (type === 'hls' || type === 'dash' || type === 'ts' || type === 'm3u8' || type === 'mpd') {
    try {
      const targetUrl = variantUrl || url;
      const downloadPageUrl = chrome.runtime.getURL(
        `download.html?url=${encodeURIComponent(targetUrl)}&originalUrl=${encodeURIComponent(url)}&type=${encodeURIComponent(type)}&title=${encodeURIComponent(filename || filenameFromUrl(url))}`
      );
      const tab = await chrome.tabs.create({ url: downloadPageUrl });
      return { success: true, tabId: tab.id };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: `Unknown media type: ${type}` };
}

// ---------------------------------------------------------------------------
// 12. Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action } = message;

  if (action === 'getMedia') {
    const tabId = message.tabId;
    (async () => {
      let items = mediaByTab.get(tabId);
      if (!items || items.length === 0) {
        const data = await chrome.storage.session.get(storageKey(tabId)).catch(() => ({}));
        items = data[storageKey(tabId)] || [];
        if (items.length > 0) {
          mediaByTab.set(tabId, items);
        }
      }
      sendResponse({ success: true, media: items });
    })();
    return true; // asynchronous response
  }

  if (action === 'clearMedia') {
    const tabId = message.tabId;
    mediaByTab.delete(tabId);
    chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
    updateBadge(tabId);
    sendResponse({ success: true });
    return false;
  }

  if (action === 'mediaDetected') {
    // From content script / inject script.
    const tabId = sender.tab?.id ?? message.tabId;
    const detectedUrl  = message.url;
    const detectedType = message.mediaType || classifyUrl(detectedUrl);
    const source       = message.source || 'content';

    if (detectedType && tabId >= 0) {
      addMediaItem(tabId, detectedUrl, detectedType, source);
    }
    sendResponse({ success: true });
    return false;
  }

  if (action === 'parseM3U8') {
    // Async response.
    parseM3U8(message.url)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open
  }

  if (action === 'startDownload') {
    startDownload(message)
      .then(result => sendResponse(result))
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open
  }

  if (action === 'getDownloadState') {
    const all = {};
    for (const [id, s] of activeDownloads) {
      all[id] = { ...s };
    }
    sendResponse({ success: true, downloads: all });
    return false;
  }

  // Unknown action — no-op.
  return false;
});

// ---------------------------------------------------------------------------
// 13. Persist download state periodically (best-effort)
// ---------------------------------------------------------------------------

async function persistDownloadState() {
  const obj = {};
  for (const [id, s] of activeDownloads) {
    obj[id] = { ...s };
  }
  await chrome.storage.session.set({ _activeDownloads: obj }).catch(() => {});
}

// We don't use setInterval in service workers (they can be killed).
// Instead, progress broadcasts already keep the SW alive during downloads.
