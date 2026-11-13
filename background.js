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
// 3. Helpers & YouTube Itag Table
// ---------------------------------------------------------------------------

const YOUTUBE_ITAG_INFO = {
  // Legacy combined formats (Video + Audio)
  '18':  { resolution: '360p', format: 'mp4', type: 'video', hasAudio: true },
  '22':  { resolution: '720p', format: 'mp4', type: 'video', hasAudio: true },
  '37':  { resolution: '1080p', format: 'mp4', type: 'video', hasAudio: true },

  // H.264 Video Only
  '160': { resolution: '144p', format: 'mp4', type: 'video', hasAudio: false },
  '133': { resolution: '240p', format: 'mp4', type: 'video', hasAudio: false },
  '134': { resolution: '360p', format: 'mp4', type: 'video', hasAudio: false },
  '135': { resolution: '480p', format: 'mp4', type: 'video', hasAudio: false },
  '136': { resolution: '720p', format: 'mp4', type: 'video', hasAudio: false },
  '137': { resolution: '1080p', format: 'mp4', type: 'video', hasAudio: false },
  '298': { resolution: '720p60', format: 'mp4', type: 'video', hasAudio: false },
  '299': { resolution: '1080p60', format: 'mp4', type: 'video', hasAudio: false },

  // VP9 Video Only
  '278': { resolution: '144p', format: 'webm', type: 'video', hasAudio: false },
  '242': { resolution: '240p', format: 'webm', type: 'video', hasAudio: false },
  '243': { resolution: '360p', format: 'webm', type: 'video', hasAudio: false },
  '244': { resolution: '480p', format: 'webm', type: 'video', hasAudio: false },
  '247': { resolution: '720p', format: 'webm', type: 'video', hasAudio: false },
  '248': { resolution: '1080p', format: 'webm', type: 'video', hasAudio: false },
  '271': { resolution: '1440p', format: 'webm', type: 'video', hasAudio: false },
  '313': { resolution: '4K', format: 'webm', type: 'video', hasAudio: false },
  '302': { resolution: '720p60', format: 'webm', type: 'video', hasAudio: false },
  '303': { resolution: '1080p60', format: 'webm', type: 'video', hasAudio: false },
  '308': { resolution: '1440p60', format: 'webm', type: 'video', hasAudio: false },
  '315': { resolution: '4K60', format: 'webm', type: 'video', hasAudio: false },

  // AV1 Video Only
  '394': { resolution: '144p', format: 'mp4', type: 'video', hasAudio: false },
  '395': { resolution: '240p', format: 'mp4', type: 'video', hasAudio: false },
  '396': { resolution: '360p', format: 'mp4', type: 'video', hasAudio: false },
  '397': { resolution: '480p', format: 'mp4', type: 'video', hasAudio: false },
  '398': { resolution: '720p', format: 'mp4', type: 'video', hasAudio: false },
  '399': { resolution: '1080p', format: 'mp4', type: 'video', hasAudio: false },
  '400': { resolution: '1440p', format: 'mp4', type: 'video', hasAudio: false },
  '401': { resolution: '4K', format: 'mp4', type: 'video', hasAudio: false },

  // Audio Only
  '139': { quality: '48 kbps', format: 'm4a', type: 'audio', hasAudio: true },
  '140': { quality: '128 kbps', format: 'm4a', type: 'audio', hasAudio: true },
  '171': { quality: '128 kbps', format: 'webm', type: 'audio', hasAudio: true },
  '249': { quality: '50 kbps', format: 'webm', type: 'audio', hasAudio: true },
  '250': { quality: '70 kbps', format: 'webm', type: 'audio', hasAudio: true },
  '251': { quality: '160 kbps', format: 'webm', type: 'audio', hasAudio: true },
};

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

/**
 * Clean a media URL (e.g. remove chunk byte-ranges from YouTube videoplayback)
 * so downloading fetches the complete file.
 */
function cleanMediaUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname.includes('googlevideo.com') && u.pathname.includes('videoplayback')) {
      u.searchParams.delete('range');
      u.searchParams.delete('rn');
      u.searchParams.delete('rbuf');
      return u.href;
    }
  } catch {}
  return urlStr;
}

/**
 * Classify a URL and extract rich metadata (type, format, resolution, hasAudio).
 * Inspects URL structure, query parameters (e.g. mime=video/webm), and Content-Type.
 */
function classifyMediaUrl(urlStr, contentType = '') {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const lowerUrl = urlStr.toLowerCase();
  const ct = (contentType || '').toLowerCase();

  // 1. YouTube & GoogleVideo streams (videoplayback) — inspect first so mime and itags are preserved
  if (lowerUrl.includes('googlevideo.com/videoplayback') || lowerUrl.includes('/videoplayback')) {
    let itag = '';
    let mime = '';
    try {
      const u = new URL(urlStr);
      itag = u.searchParams.get('itag') || '';
      mime = (u.searchParams.get('mime') || '').toLowerCase();
    } catch {}

    const itagInfo = YOUTUBE_ITAG_INFO[itag];
    if (itagInfo) {
      return {
        type: itagInfo.type,
        resolution: itagInfo.resolution || '',
        quality: itagInfo.quality || '',
        format: itagInfo.format || '',
        hasAudio: !!itagInfo.hasAudio,
        itag
      };
    }

    if (mime.startsWith('video/') || lowerUrl.includes('mime=video') || lowerUrl.includes('mime%2fvideo')) {
      const isWebm = mime.includes('webm') || lowerUrl.includes('webm');
      return { type: 'video', format: isWebm ? 'webm' : 'mp4', hasAudio: false, itag };
    }
    if (mime.startsWith('audio/') || lowerUrl.includes('mime=audio') || lowerUrl.includes('mime%2faudio')) {
      const isWebm = mime.includes('webm') || lowerUrl.includes('webm');
      return { type: 'audio', format: isWebm ? 'webm' : 'm4a', hasAudio: true, itag };
    }
    return { type: 'video', itag };
  }

  // 2. Content-Type inspection
  if (ct.includes('mpegurl') || ct.includes('application/x-mpegurl') || ct.includes('application/vnd.apple.mpegurl')) {
    return { type: 'hls', hasAudio: true };
  }
  if (ct.includes('dash+xml') || ct.includes('application/dash+xml')) {
    return { type: 'dash', hasAudio: true };
  }
  if (ct.startsWith('video/') || ct.includes('video/mp4') || ct.includes('video/webm')) {
    return { type: 'video', format: ct.includes('webm') ? 'webm' : 'mp4' };
  }
  if (ct.startsWith('audio/') || ct.includes('audio/mp4') || ct.includes('audio/webm') || ct.includes('audio/mpeg') || ct.includes('audio/ogg')) {
    return { type: 'audio', format: ct.includes('webm') ? 'webm' : (ct.includes('ogg') ? 'ogg' : 'mp3'), hasAudio: true };
  }

  // 3. Stream format patterns in URL
  if (/\.m3u8($|\?|#)/i.test(urlStr) || lowerUrl.includes('.m3u8') || lowerUrl.includes('format=m3u8')) {
    return { type: 'hls', hasAudio: true };
  }
  if (/\.mpd($|\?|#)/i.test(urlStr) || lowerUrl.includes('.mpd') || lowerUrl.includes('format=mpd')) {
    return { type: 'dash', hasAudio: true };
  }

  // 4. Generic MIME params in query (common on video CDNs)
  if (lowerUrl.includes('mime=video') || lowerUrl.includes('mime%2fvideo') || lowerUrl.includes('type=video')) {
    return { type: 'video', format: lowerUrl.includes('webm') ? 'webm' : 'mp4' };
  }
  if (lowerUrl.includes('mime=audio') || lowerUrl.includes('mime%2faudio') || lowerUrl.includes('type=audio')) {
    return { type: 'audio', hasAudio: true };
  }

  // 5. Path extensions
  const pathname = urlPathname(urlStr) || '';
  if (MEDIA_PATTERNS.video.test(pathname) || /\.(mp4|webm|mkv|flv|avi|mov)($|\?|#)/i.test(urlStr)) {
    const extMatch = (pathname || urlStr).match(/\.(mp4|webm|mkv|flv|avi|mov)/i);
    return { type: 'video', format: extMatch ? extMatch[1].toLowerCase() : 'mp4', hasAudio: true };
  }
  if (MEDIA_PATTERNS.audio.test(pathname) || /\.(mp3|aac|flac|ogg|wav|m4a|opus)($|\?|#)/i.test(urlStr)) {
    const extMatch = (pathname || urlStr).match(/\.(mp3|aac|flac|ogg|wav|m4a|opus)/i);
    return { type: 'audio', format: extMatch ? extMatch[1].toLowerCase() : 'mp3', hasAudio: true };
  }
  if (MEDIA_PATTERNS.ts.test(pathname) || /\.ts($|\?|#)/i.test(urlStr)) {
    return { type: 'ts', hasAudio: true };
  }

  return null;
}

/** Legacy wrapper */
function classifyUrl(urlStr) {
  const meta = classifyMediaUrl(urlStr);
  return meta ? meta.type : null;
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
// 5. Add a detected media item (deduplicates intelligently)
// ---------------------------------------------------------------------------

async function addMediaItem(tabId, rawUrl, type, source = 'webRequest', size = 0, extraMeta = {}) {
  if (!tabId || tabId < 0) return;

  const url = cleanMediaUrl(rawUrl);

  let items = mediaByTab.get(tabId);
  if (!items) {
    items = [];
    mediaByTab.set(tabId, items);
  }

  // Deduplicate by URL
  if (items.some(m => m.url === url)) return;

  // Deduplicate YouTube streams by video ID & itag
  try {
    const u = new URL(url);
    if (u.hostname.includes('googlevideo.com')) {
      const id = u.searchParams.get('id');
      const itag = u.searchParams.get('itag');
      if (id && itag) {
        const exists = items.some(m => {
          try {
            const mu = new URL(m.url);
            return mu.searchParams.get('id') === id && mu.searchParams.get('itag') === itag;
          } catch { return false; }
        });
        if (exists) return;
      }
    }
  } catch {}

  // For .ts files, skip if we already track an HLS playlist for this tab
  if (type === 'ts') {
    const hasHls = items.some(m => m.type === 'hls');
    if (hasHls) return;
  }

  let title = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    title = (tab.title || '').replace(/\s*-\s*YouTube$/i, '').trim();
  } catch { /* tab may have closed */ }

  // Construct readable filename
  let filename = extraMeta.title || filenameFromUrl(url);
  if (url.includes('googlevideo.com/videoplayback') || url.includes('/videoplayback')) {
    const tag = extraMeta.resolution || extraMeta.quality || (type === 'video' ? 'Video' : 'Audio');
    const ext = extraMeta.format ? `.${extraMeta.format}` : (type === 'video' ? '.mp4' : '.m4a');
    filename = (title ? `${title} [${tag}]` : `YouTube_${tag}`) + ext;
  } else if (!filename || filename === 'media' || filename.startsWith('videoplayback') || !filename.includes('.')) {
    const ext = extraMeta.format ? `.${extraMeta.format}` : (type === 'audio' ? '.mp3' : '.mp4');
    filename = (title ? `${title}` : 'video_download') + ext;
  }
  filename = filename.replace(/[\\/:*?"<>|]/g, '_').trim();

  const item = {
    url,
    type,
    filename,
    size: size || extraMeta.size || 0,
    tabId,
    timestamp: Date.now(),
    title: title || extraMeta.title || '',
    source,
    hasAudio: extraMeta.hasAudio !== undefined ? extraMeta.hasAudio : (type === 'video' || type === 'hls'),
    resolution: extraMeta.resolution || '',
    quality: extraMeta.quality || '',
    format: extraMeta.format || ''
  };

  items.push(item);
  await persistTab(tabId);
  updateBadge(tabId);

  // Notify open popup safely
  try {
    chrome.runtime.sendMessage({
      action: 'newMediaDetected',
      tabId,
      item,
    }, () => {
      if (chrome.runtime.lastError) { /* popup closed */ }
    });
  } catch (e) { /* context invalidated */ }
}

// ---------------------------------------------------------------------------
// 6. webRequest listeners — detect media URLs in network traffic
// ---------------------------------------------------------------------------

// A. Before request (URL inspection)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0 || isIgnoredDomain(url)) return;

    const meta = classifyMediaUrl(url);
    if (meta && meta.type) {
      addMediaItem(tabId, url, meta.type, 'webRequest', 0, meta);
    }
  },
  { urls: ['<all_urls>'] }
);

// B. On headers received (Content-Type & Content-Length inspection)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, tabId, responseHeaders } = details;
    if (tabId < 0 || isIgnoredDomain(url)) return;

    let contentType = '';
    let contentLength = 0;
    if (responseHeaders) {
      for (const h of responseHeaders) {
        const name = (h.name || '').toLowerCase();
        if (name === 'content-type') contentType = h.value || '';
        else if (name === 'content-length') contentLength = parseInt(h.value, 10) || 0;
      }
    }

    const meta = classifyMediaUrl(url, contentType);
    if (meta && meta.type) {
      addMediaItem(tabId, url, meta.type, 'headers', contentLength, meta);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
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
  const audioTracks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Extract separate audio track playlists (#EXT-X-MEDIA:TYPE=AUDIO)
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')) {
      const attrs = line.substring(line.indexOf(':') + 1);
      const groupId = extractAttr(attrs, 'GROUP-ID');
      const uri = extractAttr(attrs, 'URI');
      const name = extractAttr(attrs, 'NAME') || 'Audio';
      if (uri) {
        audioTracks.push({
          groupId,
          name,
          url: resolveUrl(uri, baseUrl),
        });
      }
    }

    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    // Extract attributes.
    const attrs = line.substring(line.indexOf(':') + 1);
    const bandwidth  = extractAttr(attrs, 'BANDWIDTH');
    const resolution = extractAttr(attrs, 'RESOLUTION');
    const codecs     = extractAttr(attrs, 'CODECS');
    const audioGroup = extractAttr(attrs, 'AUDIO');

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
      audioGroup: audioGroup || '',
      url:        variantUrl,
    });
  }

  // Link matching audio track to each variant
  for (const v of variants) {
    if (v.audioGroup) {
      const match = audioTracks.find(a => a.groupId === v.audioGroup);
      if (match) v.audioUrl = match.url;
    } else if (audioTracks.length > 0) {
      v.audioUrl = audioTracks[0].url;
    }
  }

  return { type: 'master', variants, audioTracks };
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
  try {
    chrome.runtime.sendMessage({
      action: 'downloadProgress',
      data: { ...state },
    }, () => {
      if (chrome.runtime.lastError) { /* popup closed */ }
    });
  } catch (e) { /* context invalidated */ }
}

// ---------------------------------------------------------------------------
// 11. Download kick-off
// ---------------------------------------------------------------------------

async function startDownload(request) {
  const { url, type, filename, threadCount, variantUrl, audioUrl } = request;

  // ----- Direct file -----
  if (type === 'video' || type === 'audio' || type === 'direct') {
    let safeName = filename || filenameFromUrl(url);
    if (!safeName || safeName === 'videoplayback' || safeName.startsWith('videoplayback') || !safeName.includes('.')) {
      safeName = `video_download.${type === 'audio' ? 'm4a' : 'mp4'}`;
    }
    safeName = safeName.replace(/[\\/:*?"<>|]/g, '_').trim();
    const downloadId = await chrome.downloads.download({
      url,
      filename: safeName,
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
      let downloadPageUrl = `download.html?url=${encodeURIComponent(targetUrl)}&originalUrl=${encodeURIComponent(url)}&type=${encodeURIComponent(type)}&title=${encodeURIComponent(filename || filenameFromUrl(url))}`;
      if (audioUrl) {
        downloadPageUrl += `&audioUrl=${encodeURIComponent(audioUrl)}`;
      }
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(downloadPageUrl) });
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
    const meta         = message.meta || classifyMediaUrl(detectedUrl) || {};
    const detectedType = message.mediaType || meta.type || classifyUrl(detectedUrl);
    const source       = message.source || 'content';
    const size         = message.size || meta.size || 0;

    if (detectedType && tabId >= 0) {
      addMediaItem(tabId, detectedUrl, detectedType, source, size, meta);
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
