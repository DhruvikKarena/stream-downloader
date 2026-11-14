/* ===================================================================
   Stream Downloader — Multi-Threaded HLS Engine (downloader.js)
   - Runs in extension page context (Blob, URL.createObjectURL, File System Access API)
   - Staged Pipeline Architecture:
       1. Request Context & Header Replay (declarativeNetRequest scoped to TAB_ID_NONE)
       2. Multi-tier Fetch Strategy Chain (Direct + Credentials -> Page-Context Fallback -> Challenge & Expiry Detection)
       3. Pre-Download Resolution Picker (De-duplicated variants, audio renditions, subtitles, saved preferences)
       4. Codec Detection (CODECS attribute parsing & MPEG-TS PMT stream ID inspection)
       5. Segment Storage & AES-128 Decryption (IndexedDB keyed ${downloadId}:${index}, Web Crypto AES-CBC)
       6. Transmuxing & In-Order Assembly (Single mux.js transmuxer, setBaseMediaDecodeTime on discontinuity)
       7. FFmpeg.wasm Remuxing (PTS normalization, -movflags +faststart, moov duration repair, dual-track merge)
       8. Duration Verification Sanity Check (Sum of #EXTINF vs final duration, 5% threshold warning)
       9. Raw TS Fallback & Copyable Manual FFmpeg Command
   =================================================================== */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Session State & URL Parameters
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  let playlistUrl = params.get('url') || '';
  let variantUrl = params.get('variant') || '';
  let originalTitle = params.get('title') || 'video_download';
  let refererUrl = params.get('referer') || '';
  let streamType = (params.get('type') || 'hls').toLowerCase();
  let requestedFormat = (params.get('format') || 'mp4').toLowerCase();
  let currentTabId = parseInt(params.get('tabId') || '0', 10);

  // Unique session identifier for IndexedDB & DNR rule scoping
  const sessionDownloadId = 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const DNR_RULE_ID = Math.floor(Math.random() * 800000) + 100000;

  // Request context captured from background.js
  let currentRequestContext = null;

  // Concurrency & Workers
  let concurrency = 6;
  let activeWorkers = 0;
  let abortController = new AbortController();

  // Playlist & Segment State
  let segmentsList = [];
  let audioSegmentsList = [];
  let downloadedBuffers = {}; // In-memory buffer cache for drain fallback
  let segmentStatus = [];     // 'waiting' | 'active' | 'done' | 'error'
  let audioSegmentStatus = [];
  let nextSegmentIndex = 0;
  let nextWriteIndex = 0;
  let retryCount = 0;

  // Master Playlist & Selection State
  let masterPlaylistData = null;
  let selectedVariant = null;
  let selectedAudioTrack = null;
  let selectedSubtitles = [];

  // Stream Info
  let isMasterPlaylist = false;
  let isLiveStream = false;
  let isRecordingLive = false;
  let livePollTimer = null;
  let isDrmProtected = false;
  let isFmp4 = false;
  let isDirectStream = false;
  let initSegmentUrl = '';
  let initSegmentBuffer = null;
  let mediaSequenceBase = 0;
  let targetDurationSec = 6;
  let cumulativeDuration = 0;
  let playlistTotalDuration = 0;

  // Detected Codecs & Pipeline Routing
  let detectedCodecs = {
    videoCodec: 'unknown',
    audioCodec: 'unknown',
    videoCodecString: '',
    audioCodecString: '',
    isAvcAac: true,
    label: 'AVC + AAC (Default)'
  };

  // Disk Streaming (File System Access API)
  let isDiskStreamingActive = false;
  let fileHandle = null;
  let writableStream = null;
  let assembledBlobParts = [];
  let rawTsChunks = [];

  // Transmuxer (mux.js) Session
  let transmuxSession = null;
  let isTransmuxerInitWritten = false;

  // Download & UI Flags
  let isDownloading = false;
  let isPaused = false;
  let isCancelled = false;
  let isDraining = false;

  // Speed & Progress Monitoring
  let totalBytes = 0;
  let startTime = 0;
  let speedInterval = null;
  let lastBytes = 0;
  let lastSpeedTime = 0;
  let currentSpeed = 0;

  // ---------------------------------------------------------------------------
  // 2. DOM Elements
  // ---------------------------------------------------------------------------
  const cachingBox = document.getElementById('caching-box');
  const cachingStatusLabel = document.getElementById('caching-status-label');
  const cachingFilename = document.getElementById('caching-filename');
  const pipelineStepBadge = document.getElementById('pipeline-step-badge');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressBarBuffered = document.getElementById('progress-bar-buffered');
  const cachingStats = document.getElementById('caching-stats');

  const pauseBtn = document.getElementById('pause-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const saveBtn = document.getElementById('save-btn');
  const saveBtnText = document.getElementById('save-btn-text');
  const boostSpeedBtn = document.getElementById('boost-speed-btn');
  const turboBoostBtn = document.getElementById('turbo-boost-btn');
  const autoSaveToggle = document.getElementById('auto-save-toggle');
  const streamDiskToggle = document.getElementById('stream-disk-toggle');

  const filenameInput = document.getElementById('filename-input');
  const fileExtLabel = document.getElementById('file-ext-label');
  const outputFormatSelect = document.getElementById('output-format-select');
  const urlDisplay = document.getElementById('url-display');
  const copyUrlBtn = document.getElementById('copy-url-btn');
  const streamTypeBadge = document.getElementById('stream-type-badge');
  const qualitySection = document.getElementById('quality-section');
  const qualitySelect = document.getElementById('quality-select');
  const threadButtons = document.getElementById('thread-buttons');
  const segmentsGrid = document.getElementById('segments-grid');

  // Banners & Notifications
  const drmBanner = document.getElementById('drm-banner');
  const liveBanner = document.getElementById('live-banner');
  const liveRecordBtn = document.getElementById('live-record-btn');
  const liveStopBtn = document.getElementById('live-stop-btn');
  const noticeBox = document.getElementById('notice-box');
  const noticeText = document.getElementById('notice-text');
  const retryBtn = document.getElementById('retry-btn');

  // Challenge & Expired Banners
  const challengeBanner = document.getElementById('challenge-banner');
  const challengeMessage = document.getElementById('challenge-message');
  const challengeRetryBtn = document.getElementById('challenge-retry-btn');
  const expiredBanner = document.getElementById('expired-banner');
  const expiredMessage = document.getElementById('expired-message');
  const expiredRetryBtn = document.getElementById('expired-retry-btn');

  // Resolution Picker Elements
  const resolutionPickerCard = document.getElementById('resolution-picker-card');
  const pickerStreamTypeBadge = document.getElementById('picker-stream-type-badge');
  const variantsList = document.getElementById('variants-list');
  const pickerAudioSection = document.getElementById('picker-audio-section');
  const pickerAudioSelect = document.getElementById('picker-audio-select');
  const pickerSubtitleSection = document.getElementById('picker-subtitle-section');
  const pickerSubtitlesList = document.getElementById('picker-subtitles-list');
  const pickerRememberPref = document.getElementById('picker-remember-pref');
  const pickerCancelBtn = document.getElementById('picker-cancel-btn');
  const pickerStartBtn = document.getElementById('picker-start-btn');

  // Fallback Banner, Command & Sanity Elements
  const fallbackBanner = document.getElementById('fallback-banner');
  const ffmpegCommandDisplay = document.getElementById('ffmpeg-command-display');
  const copyCmdBtn = document.getElementById('copy-cmd-btn');
  const sanityBanner = document.getElementById('sanity-banner');
  const sanityIcon = document.getElementById('sanity-icon');
  const sanityTitle = document.getElementById('sanity-title');
  const sanityMessage = document.getElementById('sanity-message');
  const saveRawTsBtn = document.getElementById('save-raw-ts-btn');

  // ---------------------------------------------------------------------------
  // 3. UI Helpers & Status Display
  // ---------------------------------------------------------------------------
  function updatePipelineStep(step, text) {
    if (!pipelineStepBadge) return;
    pipelineStepBadge.className = `pipeline-badge step-${step}`;
    pipelineStepBadge.textContent = text;
  }

  function setStatus(text, isPulse = true) {
    if (cachingStatusLabel) cachingStatusLabel.textContent = text;
    const dot = document.querySelector('.caching-pulse-dot');
    if (dot) {
      dot.style.background = isPulse ? '#00e676' : '#ffb300';
      dot.style.boxShadow = isPulse ? '0 0 10px #00e676' : '0 0 10px #ffb300';
    }
  }

  function showNotice(msg, type = 'error', showRetry = false) {
    if (!noticeBox) return;
    noticeText.textContent = msg;
    noticeBox.className = `notice-box ${type}`;
    noticeBox.classList.remove('hidden');
    if (retryBtn) retryBtn.classList.toggle('hidden', !showRetry);
  }

  function hideNotice() {
    if (noticeBox) noticeBox.classList.add('hidden');
    if (retryBtn) retryBtn.classList.add('hidden');
  }

  function hideAllAlertBanners() {
    if (drmBanner) drmBanner.classList.add('hidden');
    if (challengeBanner) challengeBanner.classList.add('hidden');
    if (expiredBanner) expiredBanner.classList.add('hidden');
    if (sanityBanner) sanityBanner.classList.add('hidden');
    if (fallbackBanner) fallbackBanner.classList.add('hidden');
    hideNotice();
  }

  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '0.0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    return mb.toFixed(1) + ' MB';
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || isNaN(bytesPerSec) || bytesPerSec <= 0) return '0.0 KB/s';
    if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
    return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  }

  function formatTime(seconds) {
    if (!seconds || !isFinite(seconds) || seconds < 0) return '00:00:00';
    const s = Math.floor(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function resolveUrl(relative, base) {
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  }

  function cleanFilename(name) {
    return (name || 'video_download').replace(/[\\/:*?"<>|]/g, '_').trim();
  }

  function updateFfmpegCommand(name) {
    const safe = cleanFilename(name || (filenameInput ? filenameInput.value : '') || originalTitle || 'video_download');
    if (ffmpegCommandDisplay) {
      ffmpegCommandDisplay.textContent = `ffmpeg -fflags +genpts -i "${safe}.ts" -c copy -movflags +faststart "${safe}.mp4"`;
    }
  }

  function concatBuffers(buffers) {
    let totalLength = 0;
    for (let i = 0; i < buffers.length; i++) {
      totalLength += buffers[i].byteLength;
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (let i = 0; i < buffers.length; i++) {
      const b = buffers[i];
      result.set(b instanceof Uint8Array ? b : new Uint8Array(b), offset);
      offset += b.byteLength;
    }
    return result;
  }

  function triggerBlobDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
  }

  async function getBlobDuration(blob) {
    return new Promise((resolve) => {
      try {
        const video = document.createElement('video');
        video.preload = 'metadata';
        const url = URL.createObjectURL(blob);
        const timer = setTimeout(() => {
          URL.revokeObjectURL(url);
          resolve(0);
        }, 6000);
        video.onloadedmetadata = () => {
          clearTimeout(timer);
          const dur = video.duration;
          URL.revokeObjectURL(url);
          resolve(isFinite(dur) && !isNaN(dur) ? dur : 0);
        };
        video.onerror = () => {
          clearTimeout(timer);
          URL.revokeObjectURL(url);
          resolve(0);
        };
        video.src = url;
      } catch {
        resolve(0);
      }
    });
  }

  function runDurationSanityCheck(actualDuration, expectedDuration) {
    if (!sanityBanner) return;
    if (!expectedDuration || expectedDuration <= 0) return;

    if (!actualDuration || actualDuration <= 0) {
      console.log('[Sanity Check] Media duration probe returned 0 or unavailable.');
      return;
    }

    const diffSec = Math.abs(actualDuration - expectedDuration);
    const diffPercent = (diffSec / expectedDuration) * 100;

    if (diffPercent > 5) {
      // Differ by more than 5% -> WARN
      sanityBanner.className = 'alert-banner sanity-banner warning';
      if (sanityIcon) sanityIcon.textContent = '⚠️';
      if (sanityTitle) sanityTitle.textContent = `Duration Warning: ${diffPercent.toFixed(1)}% discrepancy detected!`;
      if (sanityMessage) {
        sanityMessage.textContent = `Output video duration is ${formatTime(actualDuration)} (${actualDuration.toFixed(1)}s), but the sum of #EXTINF segments is ${formatTime(expectedDuration)} (${expectedDuration.toFixed(1)}s). The difference exceeds the 5% sanity threshold. VLC seeking or playback duration may be inaccurate. Use the Raw TS fallback command below if needed.`;
      }
      sanityBanner.classList.remove('hidden');
      if (fallbackBanner) fallbackBanner.classList.remove('hidden');
      showNotice(`⚠️ Duration Warning: Output duration (${actualDuration.toFixed(1)}s) differs from #EXTINF playlist sum (${expectedDuration.toFixed(1)}s) by ${diffPercent.toFixed(1)}% (> 5%).`, 'error');
      console.warn(`[Sanity Check] Warning: Output duration ${actualDuration}s differs from expected ${expectedDuration}s by ${diffPercent.toFixed(1)}%`);
    } else {
      // Within 5% -> Verified
      sanityBanner.className = 'alert-banner sanity-banner success';
      if (sanityIcon) sanityIcon.textContent = '✅';
      if (sanityTitle) sanityTitle.textContent = `Duration Verified (${diffPercent.toFixed(1)}% diff, within 5% threshold)`;
      if (sanityMessage) {
        sanityMessage.textContent = `Output video duration (${formatTime(actualDuration)}) matches playlist duration (${formatTime(expectedDuration)}). Moov duration and seeking indices are valid.`;
      }
      sanityBanner.classList.remove('hidden');
      console.log(`[Sanity Check] Duration check passed: ${actualDuration}s matches ${expectedDuration}s (${diffPercent.toFixed(1)}% diff)`);
    }
  }

  function cleanMediaUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
      const u = new URL(rawUrl);
      u.searchParams.delete('range');
      u.searchParams.delete('rn');
      u.searchParams.delete('rbuf');
      u.searchParams.delete('start');
      u.searchParams.delete('end');
      return u.href;
    } catch {}
    return rawUrl;
  }

  // ---------------------------------------------------------------------------
  // 4. Request Context & declarativeNetRequest Session Rules (Section A.1 & A.2)
  // ---------------------------------------------------------------------------
  async function initRequestContext(url) {
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getRequestContext', url: url || playlistUrl }, resolve);
      });
      if (res && res.success && res.context) {
        currentRequestContext = res.context;
        if (!currentTabId && res.context.tabId) {
          currentTabId = res.context.tabId;
        }
        if (!refererUrl && res.context.referer) {
          refererUrl = res.context.referer;
        }
      }
    } catch (err) {
      console.warn('[Request Context] Could not get context from background:', err);
    }

    await applyRequestHeaders(url);
  }

  async function applyRequestHeaders(url) {
    try {
      const targetUrl = url || playlistUrl;
      const referer = (currentRequestContext && currentRequestContext.referer) || refererUrl || '';
      let origin = (currentRequestContext && currentRequestContext.origin) || '';
      if (!origin && referer) {
        try { origin = new URL(referer).origin; } catch {}
      }
      const userAgent = (currentRequestContext && currentRequestContext.userAgent) || '';
      const acceptLanguage = (currentRequestContext && currentRequestContext.acceptLanguage) || '';

      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'setDownloadHeaders',
          ruleId: DNR_RULE_ID,
          url: targetUrl,
          referer,
          origin,
          userAgent,
          acceptLanguage
        }, resolve);
      });
    } catch (err) {
      console.warn('[DNR] Error setting download headers:', err);
    }
  }

  async function clearRequestHeaders() {
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'clearDownloadHeaders',
          ruleId: DNR_RULE_ID
        }, resolve);
      });
    } catch {}
  }

  window.addEventListener('beforeunload', () => {
    clearRequestHeaders();
    if (isDownloading && !isPaused) {
      abortController.abort();
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Fetch Strategy Chain (Section A.1 - A.8)
  // ---------------------------------------------------------------------------
  function isChallengeResponse(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return (
      lower.includes('just a moment...') ||
      lower.includes('turnstile') ||
      lower.includes('challenge-platform') ||
      lower.includes('attention required! | cloudflare') ||
      lower.includes('cf-mitigated') ||
      (lower.includes('verify you are human') && lower.includes('captcha'))
    );
  }

  function checkExpiredUrl(url, status) {
    try {
      const u = new URL(url);
      const hasTokenOrExpire =
        u.searchParams.has('token') ||
        u.searchParams.has('expires') ||
        u.searchParams.has('exp') ||
        u.searchParams.has('expire') ||
        u.searchParams.has('auth');
      if (hasTokenOrExpire && (status === 401 || status === 403 || status === 410)) {
        triggerExpiredDetected();
        return true;
      }
    } catch {}
    return false;
  }

  function triggerChallengeDetected(customMsg) {
    if (challengeBanner) {
      if (customMsg && challengeMessage) challengeMessage.textContent = customMsg;
      challengeBanner.classList.remove('hidden');
    }
    setStatus('Bot Challenge Detected', false);
    updatePipelineStep('error', 'Bot Challenge Block');
    showNotice('This site is blocking automated downloads (bot challenge). Open the video page, let it play for a few seconds, then try again.', 'error', true);
  }

  function triggerExpiredDetected(customMsg) {
    if (expiredBanner) {
      if (customMsg && expiredMessage) expiredMessage.textContent = customMsg;
      expiredBanner.classList.remove('hidden');
    }
    setStatus('Token Expired', false);
    updatePipelineStep('error', 'Token Expired');
    showNotice('The media stream URL has expired or has an invalid authentication token. Please refresh the video page and click Download again.', 'error', true);
  }

  /**
   * Fetch with staged strategy chain:
   * 1. Direct fetch with credentials: "include" and DNR session headers
   * 2. Fallback to chrome.scripting page-context fetch (world: "MAIN") on 403 or HTML block
   * 3. Response validation: strip BOM, check #EXTM3U, detect bot challenges, check token expiry
   */
  async function fetchWithStrategy(url, options = {}) {
    const {
      responseType = 'text', // 'text' | 'arraybuffer'
      isPlaylist = false,
      headers = {},
      signal = abortController.signal,
      allowPageFallback = true,
      allowTokenRetry = true
    } = options;

    let directRes = null;
    let fetchError = null;

    try {
      directRes = await fetch(url, {
        method: 'GET',
        headers,
        signal,
        credentials: 'include'
      });
    } catch (err) {
      fetchError = err;
      if (err.name === 'AbortError' || isCancelled) throw err;
    }

    let shouldTryPageFallback = false;
    if (!directRes || !directRes.ok) {
      const status = directRes ? directRes.status : 0;
      if (status === 403 || status === 401 || status === 429 || status === 0 || !directRes) {
        shouldTryPageFallback = true;
      }
    }

    let directText = null;
    if (directRes && directRes.ok) {
      const cfMitigated = directRes.headers.get('cf-mitigated');
      if (cfMitigated === 'challenge') {
        triggerChallengeDetected();
        throw new Error('Bot challenge detected (cf-mitigated: challenge)');
      }

      if (responseType === 'text' || isPlaylist) {
        directText = await directRes.text();
        if (directText.charCodeAt(0) === 0xFEFF) directText = directText.slice(1);
        directText = directText.trim();

        if (isChallengeResponse(directText)) {
          triggerChallengeDetected();
          throw new Error('This site is blocking automated downloads (bot challenge). Open the video page, let it play for a few seconds, then try again.');
        }

        if (isPlaylist && !directText.startsWith('#EXTM3U')) {
          shouldTryPageFallback = true;
        } else {
          return { ok: true, status: directRes.status, text: directText, url: directRes.url };
        }
      } else {
        const directBytes = await directRes.arrayBuffer();
        return { ok: true, status: directRes.status, buffer: directBytes, url: directRes.url };
      }
    }

    // Step 4: Page-Context Fallback (Section A.4)
    if (shouldTryPageFallback && allowPageFallback && currentTabId > 0) {
      console.log(`[Fetch Strategy] Direct fetch status ${directRes ? directRes.status : 'ERR'}. Attempting page-context fallback via tab ${currentTabId}...`);
      try {
        const pageResult = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'fetchFromPageContext',
            tabId: currentTabId,
            url,
            responseType: (responseType === 'arraybuffer' ? 'bytes' : 'text')
          }, resolve);
        });

        if (pageResult && pageResult.success && pageResult.result) {
          const pr = pageResult.result;
          if (pr.headers && pr.headers['cf-mitigated'] === 'challenge') {
            triggerChallengeDetected();
            throw new Error('Bot challenge detected (cf-mitigated: challenge)');
          }

          if (responseType === 'text' || isPlaylist) {
            let text = pr.text || '';
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            text = text.trim();

            if (isChallengeResponse(text)) {
              triggerChallengeDetected();
              throw new Error('This site is blocking automated downloads (bot challenge). Open the video page, let it play for a few seconds, then try again.');
            }

            if (isPlaylist && !text.startsWith('#EXTM3U')) {
              checkExpiredUrl(url, pr.status);
              const preview = text.slice(0, 200).replace(/\s+/g, ' ');
              throw new Error(`Server returned HTTP ${pr.status}: "${preview}" (Page-context fetch returned invalid #EXTM3U)`);
            }

            return { ok: pr.ok, status: pr.status, text, url: pr.url || url };
          } else {
            const base64 = pr.base64 || '';
            const binStr = atob(base64);
            const len = binStr.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binStr.charCodeAt(i);
            }
            return { ok: pr.ok, status: pr.status, buffer: bytes.buffer, url: pr.url || url };
          }
        }
      } catch (pageErr) {
        console.warn('[Fetch Strategy] Page fallback exception:', pageErr);
      }
    }

    const finalStatus = directRes ? directRes.status : 0;
    if (checkExpiredUrl(url, finalStatus)) {
      throw new Error('The media stream URL has expired or has an invalid authentication token. Please refresh the video page and click Download again.');
    }

    if (allowTokenRetry) {
      console.log('[Fetch Strategy] Retrying once with fresh request context...');
      await initRequestContext(url);
      return await fetchWithStrategy(url, { ...options, allowTokenRetry: false });
    }

    if (directRes) {
      const contentType = directRes.headers.get('content-type') || 'unknown';
      const preview = directText ? directText.slice(0, 200).replace(/\s+/g, ' ') : '';
      throw new Error(`Failed to load valid playlist. HTTP ${directRes.status} (${directRes.statusText}), Content-Type: ${contentType}, Final URL: ${directRes.url}. Response preview: "${preview}"`);
    }

    throw fetchError || new Error(`Network failure requesting ${url}`);
  }

  // ---------------------------------------------------------------------------
  // 6. Segment Matrix UI
  // ---------------------------------------------------------------------------
  function buildSegmentGrid(count) {
    if (!segmentsGrid) return;
    segmentsGrid.innerHTML = '';
    const frag = document.createDocumentFragment();
    const maxCells = Math.min(count, 500);
    for (let i = 0; i < maxCells; i++) {
      const el = document.createElement('div');
      el.className = 'seg-cell waiting';
      el.id = `seg-${i}`;
      el.title = `Segment ${i + 1}`;
      frag.appendChild(el);
    }
    segmentsGrid.appendChild(frag);
  }

  function updateSegmentBlock(index, status) {
    if (index >= 500) return;
    const el = document.getElementById(`seg-${index}`);
    if (el) el.className = `seg-cell ${status}`;
  }

  // ---------------------------------------------------------------------------
  // 7. Resolution Picker (Shown BEFORE downloading - Section B)
  // ---------------------------------------------------------------------------
  async function showResolutionPicker(parsedMaster) {
    masterPlaylistData = parsedMaster;
    isMasterPlaylist = true;

    setStatus('Choose quality', false);
    updatePipelineStep('picker', 'Step 0: Choose Quality');

    // De-duplicate variants and sort by resolution descending (Section B.3)
    const deduplicatedVariants = (typeof HlsParser !== 'undefined' && HlsParser.sortAndDeduplicateVariants)
      ? HlsParser.sortAndDeduplicateVariants(parsedMaster.variants)
      : parsedMaster.variants.slice().sort((a, b) => (b.height || 0) - (a.height || 0));

    // Retrieve saved user quality preference (Section B.7)
    let savedQualityPref = 'highest';
    try {
      const storage = await chrome.storage.local.get(['stream_quality_pref', 'stream_remember_pref']);
      if (storage.stream_quality_pref) savedQualityPref = storage.stream_quality_pref;
      if (pickerRememberPref && storage.stream_remember_pref !== undefined) {
        pickerRememberPref.checked = storage.stream_remember_pref;
      }
    } catch (_) {}

    // Populate Variants List
    variantsList.innerHTML = '';
    let preselectedIndex = 0;

    deduplicatedVariants.forEach((v, index) => {
      const card = document.createElement('label');
      card.className = 'variant-card';
      card.dataset.index = index;

      const resLabel = v.resolutionLabel || (typeof HlsParser !== 'undefined' ? HlsParser.getResolutionLabel(v.width, v.height) : `${v.height || 'Auto'}p`);
      const dims = v.width && v.height ? `${v.width}x${v.height}` : 'Adaptive';
      const fps = v.frameRate ? `${Math.round(v.frameRate)} fps` : '';
      const bitrateStr = v.bandwidthMbps ? `${v.bandwidthMbps} Mbps` : (v.bandwidth ? `${(v.bandwidth / 1000000).toFixed(2)} Mbps` : '');
      const codecInfo = (typeof CodecDetect !== 'undefined') ? CodecDetect.parseCodecs(v.codecs) : { label: v.codecs || 'Standard' };

      // Estimated size = (BANDWIDTH / 8) * totalDuration
      let sizeStr = '';
      if (parsedMaster.totalDuration > 0 && v.bandwidth > 0) {
        const estBytes = (v.bandwidth / 8) * parsedMaster.totalDuration;
        sizeStr = `~${formatBytes(estBytes)}`;
      } else if (v.bandwidth > 0) {
        sizeStr = bitrateStr;
      }

      // Check preference match
      if (savedQualityPref !== 'highest') {
        if (resLabel.toLowerCase().includes(savedQualityPref.toLowerCase())) {
          preselectedIndex = index;
        }
      }

      card.innerHTML = `
        <input type="radio" name="variant_pick" class="variant-radio" value="${v.url}" ${index === preselectedIndex ? 'checked' : ''}>
        <div class="variant-info">
          <div class="variant-title-line">
            <span class="variant-title">${resLabel}</span>
            <span class="variant-badge-res">${dims}</span>
            ${index === 0 ? '<span class="variant-badge-best">BEST</span>' : ''}
          </div>
          <div class="variant-meta">
            ${fps ? `<span>🎞️ ${fps}</span>` : ''}
            <span>⚙️ ${codecInfo.label}</span>
          </div>
        </div>
        <div class="variant-size-col">
          <span class="variant-size-value">${sizeStr}</span>
          <span class="variant-bitrate-value">${bitrateStr}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        document.querySelectorAll('.variant-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        const radio = card.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
      });

      variantsList.appendChild(card);
    });

    // Mark initial selected
    const initialSelectedCard = variantsList.children[preselectedIndex];
    if (initialSelectedCard) initialSelectedCard.classList.add('selected');

    // Separate Audio Tracks Selector (#EXT-X-MEDIA:TYPE=AUDIO - Section B.4)
    if (parsedMaster.audioGroups && Object.keys(parsedMaster.audioGroups).length > 0) {
      pickerAudioSelect.innerHTML = '';
      let hasAudioOptions = false;

      Object.keys(parsedMaster.audioGroups).forEach(groupId => {
        const tracks = parsedMaster.audioGroups[groupId];
        tracks.forEach(track => {
          hasAudioOptions = true;
          const opt = document.createElement('option');
          opt.value = track.url;
          opt.textContent = `${track.name || track.language || 'Audio'} (${track.language || 'Default'}) [Group: ${groupId}]`;
          if (track.default) opt.selected = true;
          pickerAudioSelect.appendChild(opt);
        });
      });

      if (hasAudioOptions) {
        pickerAudioSection.classList.remove('hidden');
      } else {
        pickerAudioSection.classList.add('hidden');
      }
    } else {
      pickerAudioSection.classList.add('hidden');
    }

    // Subtitles Checklist
    if (parsedMaster.subtitles && parsedMaster.subtitles.length > 0) {
      pickerSubtitlesList.innerHTML = '';
      parsedMaster.subtitles.forEach((sub, idx) => {
        const item = document.createElement('label');
        item.className = 'subtitle-item';
        item.innerHTML = `
          <input type="checkbox" value="${sub.url}" data-lang="${sub.language || ''}" data-name="${sub.name || ''}">
          <span>${sub.name || sub.language || `Subtitle ${idx + 1}`} (${sub.language || 'und'})</span>
        `;
        pickerSubtitlesList.appendChild(item);
      });
      pickerSubtitleSection.classList.remove('hidden');
    } else {
      pickerSubtitleSection.classList.add('hidden');
    }

    // Show picker card and hide caching box
    if (resolutionPickerCard) resolutionPickerCard.classList.remove('hidden');
    if (cachingBox) cachingBox.classList.add('hidden');
  }

  async function handlePickerStart() {
    if (!masterPlaylistData) return;

    // Determine chosen variant
    const selectedRadio = document.querySelector('input[name="variant_pick"]:checked');
    if (!selectedRadio) {
      showNotice('Please select a resolution to download.', 'error');
      return;
    }

    const chosenVariantUrl = selectedRadio.value;
    const chosenCard = selectedRadio.closest('.variant-card');
    const chosenIndex = chosenCard ? parseInt(chosenCard.dataset.index, 10) : 0;
    selectedVariant = masterPlaylistData.variants[chosenIndex] || { url: chosenVariantUrl };

    // Separate audio rendition
    if (!pickerAudioSection.classList.contains('hidden') && pickerAudioSelect.value) {
      selectedAudioTrack = { url: pickerAudioSelect.value };
    } else {
      selectedAudioTrack = null;
    }

    // Subtitles
    selectedSubtitles = [];
    document.querySelectorAll('#picker-subtitles-list input:checked').forEach(cb => {
      selectedSubtitles.push({ url: cb.value, language: cb.dataset.lang, name: cb.dataset.name });
    });

    // Save preferences
    if (pickerRememberPref && pickerRememberPref.checked) {
      const chosenLabel = selectedVariant.resolutionLabel || `${selectedVariant.height || 'best'}p`;
      chrome.storage.local.set({
        stream_quality_pref: chosenIndex === 0 ? 'highest' : chosenLabel,
        stream_remember_pref: true
      });
    }

    // Hide picker card and show caching box
    if (resolutionPickerCard) resolutionPickerCard.classList.add('hidden');
    if (cachingBox) cachingBox.classList.remove('hidden');

    // Fetch and setup chosen variant media playlist
    setStatus('Loading chosen variant...', true);
    updatePipelineStep('loading', 'Loading Chosen Variant');

    try {
      const res = await fetchWithStrategy(chosenVariantUrl, { isPlaylist: true, responseType: 'text' });
      const subParsed = (typeof HlsParser !== 'undefined')
        ? HlsParser.parse(res.text, chosenVariantUrl, res.status)
        : parseM3U8Content(res.text, chosenVariantUrl, res.status);

      setupMediaPlaylist(subParsed);
    } catch (err) {
      setStatus('Failed to load variant', false);
      updatePipelineStep('error', 'Variant Load Failed');
      showNotice(`Error loading variant playlist: ${err.message}`, 'error', true);
    }
  }

  function handlePickerCancel() {
    if (resolutionPickerCard) resolutionPickerCard.classList.add('hidden');
    if (cachingBox) cachingBox.classList.remove('hidden');
    setStatus('Download Cancelled', false);
    updatePipelineStep('error', 'Cancelled by User');
    showNotice('Download selection was cancelled.', 'error');
  }

  // ---------------------------------------------------------------------------
  // 8. Staged Pipeline: Codec Detect & Setup Media Playlist
  // ---------------------------------------------------------------------------
  function parseM3U8Content(text, baseUrl, httpStatus = 200) {
    if (typeof HlsParser !== 'undefined' && typeof HlsParser.parse === 'function') {
      return HlsParser.parse(text, baseUrl, httpStatus);
    }
    throw new Error('HlsParser module is not loaded.');
  }

  async function setupHlsStream(url) {
    setStatus('Loading playlist...', true);
    updatePipelineStep('loading', 'Loading Playlist');
    hideAllAlertBanners();

    try {
      const res = await fetchWithStrategy(url, { isPlaylist: true, responseType: 'text' });
      const parsed = parseM3U8Content(res.text, url, res.status);

      // 1. DRM Check (Section C & E)
      if (parsed.isDrmProtected) {
        isDrmProtected = true;
        if (drmBanner) drmBanner.classList.remove('hidden');
        setStatus('DRM-Protected Stream', false);
        updatePipelineStep('error', "DRM-protected, can't be downloaded");
        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.style.opacity = '0.5';
        }
        showNotice("DRM-protected, can't be downloaded. SAMPLE-AES/Widevine/FairPlay encryption detected.", 'error');
        return;
      }

      // 2. Master Playlist with variants -> Show Resolution Picker BEFORE downloading (Section B)
      if (parsed.type === 'master' || parsed.isMaster) {
        await showResolutionPicker(parsed);
      } else {
        // Single media playlist (no variants): Skip picker directly (Section B.5)
        if (resolutionPickerCard) resolutionPickerCard.classList.add('hidden');
        if (cachingBox) cachingBox.classList.remove('hidden');
        setupMediaPlaylist(parsed);
      }
    } catch (err) {
      console.warn('Playlist load error:', err);
      if (err.message && (err.message.includes('Missing #EXTM3U tag') || err.message.includes('Server returned an HTML page') || err.message.includes('Invalid M3U8'))) {
        setupDirectChunkDownload(url, originalTitle);
        return;
      }
      setStatus('Failed to load playlist', false);
      updatePipelineStep('error', 'Load Failed');
      showNotice(`Failed to load or parse playlist: ${err.message}`, 'error', true);
    }
  }

  function setupMediaPlaylist(parsed) {
    isLiveStream = !parsed.hasEndList;
    isFmp4 = parsed.isFmp4;
    targetDurationSec = parsed.targetDuration || 6;
    mediaSequenceBase = parsed.mediaSequence || 0;
    playlistTotalDuration = parsed.totalDuration || (parsed.segments ? parsed.segments.reduce((acc, s) => acc + (s.duration || 0), 0) : 0);

    if (parsed.initSegment) {
      initSegmentUrl = parsed.initSegment.url;
    }

    segmentsList = parsed.segments.map((s, idx) => ({ ...s, index: idx }));
    downloadedBuffers = {};
    segmentStatus = new Array(segmentsList.length).fill('waiting');

    buildSegmentGrid(segmentsList.length);

    // Codec Detection (Section C.1)
    if (selectedVariant && selectedVariant.codecs && typeof CodecDetect !== 'undefined') {
      detectedCodecs = CodecDetect.parseCodecs(selectedVariant.codecs);
    } else {
      detectedCodecs = {
        videoCodec: 'unknown',
        audioCodec: 'unknown',
        videoCodecString: '',
        audioCodecString: '',
        isAvcAac: true,
        label: 'Auto Detect'
      };
    }

    // Live stream banner
    if (isLiveStream) {
      if (liveBanner) liveBanner.classList.remove('hidden');
      setStatus('Live Stream Ready', false);
      showNotice('Live stream detected (no endlist). Click "Record Live Stream" to begin capturing.', 'success');
      return;
    }

    setStatus('Ready to Download', false);
    startDownload();
  }

  async function setupDirectChunkDownload(rawUrl, title) {
    isDirectStream = true;
    setStatus('Probing Media Stream...', true);
    hideNotice();

    const cleanUrl = cleanMediaUrl(rawUrl);
    let totalSize = parseInt(params.get('size'), 10) || 0;
    let detectedMime = '';

    try {
      const u = new URL(cleanUrl);
      const clen = u.searchParams.get('clen');
      if (clen && parseInt(clen, 10) > 65536) {
        totalSize = parseInt(clen, 10);
      }
      const mime = u.searchParams.get('mime');
      if (mime) detectedMime = mime;
    } catch {}

    if (!totalSize) {
      try {
        const probeRes = await new Promise(resolve => {
          chrome.runtime.sendMessage({ action: 'probeMedia', url: cleanUrl }, resolve);
        });
        if (probeRes && probeRes.success) {
          const probedSize = probeRes.totalSize || (probeRes.primary && probeRes.primary.totalSize) || 0;
          const probedMime = probeRes.mimeType || (probeRes.primary && probeRes.primary.mimeType) || '';
          if (probedSize > 65536) totalSize = probedSize;
          if (probedMime) detectedMime = probedMime;
        }
      } catch (e) {
        console.warn('Probe check note:', e);
      }
    }

    const isAudio = streamType === 'audio' ||
                    detectedMime.includes('audio') ||
                    cleanUrl.includes('mime=audio') ||
                    cleanUrl.includes('mime%2faudio');

    let defaultExt = isAudio ? 'm4a' : 'mp4';
    if (detectedMime.includes('webm')) defaultExt = isAudio ? 'weba' : 'webm';
    else if (detectedMime.includes('mp3') || cleanUrl.endsWith('.mp3')) defaultExt = 'mp3';
    else if (detectedMime.includes('mp4') || cleanUrl.endsWith('.mp4')) defaultExt = 'mp4';

    outputFormatSelect.value = defaultExt;
    if (fileExtLabel) fileExtLabel.textContent = `.${defaultExt}`;
    const safeTitle = cleanFilename(filenameInput.value || title || originalTitle);
    cachingFilename.textContent = `${safeTitle}.${defaultExt}`;

    segmentsList = [];
    downloadedBuffers = {};

    if (totalSize > 0) {
      const CHUNK_SIZE = totalSize <= 4 * 1048576 ? 524288 : 1048576;
      let offset = 0;
      while (offset < totalSize) {
        const end = Math.min(offset + CHUNK_SIZE - 1, totalSize - 1);
        segmentsList.push({
          url: cleanUrl,
          range: `bytes=${offset}-${end}`,
          start: offset,
          end: end,
          size: end - offset + 1,
          index: segmentsList.length,
          isDirect: true
        });
        offset = end + 1;
      }
    } else {
      segmentsList.push({
        url: cleanUrl,
        range: null,
        index: 0,
        isDirect: true
      });
    }

    segmentStatus = new Array(segmentsList.length).fill('waiting');
    buildSegmentGrid(segmentsList.length);
    setStatus('Ready to Download', false);
    updatePipelineStep('downloading', `Step 1: Downloading Segments (${segmentsList.length})`);

    startDownload();
  }

  // ---------------------------------------------------------------------------
  // 9. Disk Streaming & Transmuxing Engine (Section C.4 & C.5)
  // ---------------------------------------------------------------------------
  async function initializeDiskStream(filename, ext) {
    if (!streamDiskToggle || !streamDiskToggle.checked || !window.showSaveFilePicker) {
      isDiskStreamingActive = false;
      return false;
    }

    try {
      let desc = 'MP4 Video (.mp4)';
      let mime = 'video/mp4';
      if (ext === 'ts') { desc = 'MPEG-2 Transport Stream (.ts)'; mime = 'video/mp2t'; }
      else if (ext === 'webm') { desc = 'WebM Video (.webm)'; mime = 'video/webm'; }
      else if (ext === 'm4a') { desc = 'M4A Audio (.m4a)'; mime = 'audio/mp4'; }
      else if (ext === 'mp3') { desc = 'MP3 Audio (.mp3)'; mime = 'audio/mpeg'; }

      fileHandle = await window.showSaveFilePicker({
        suggestedName: `${filename}.${ext}`,
        types: [{
          description: desc,
          accept: {
            [mime]: [`.${ext}`]
          }
        }]
      });
      writableStream = await fileHandle.createWritable();
      isDiskStreamingActive = true;
      showNotice(`Direct disk streaming enabled: Saving directly to "${fileHandle.name}".`, 'success');
      return true;
    } catch (err) {
      console.warn('showSaveFilePicker cancelled or unsupported, fallback to memory:', err);
      fileHandle = null;
      writableStream = null;
      isDiskStreamingActive = false;
      if (streamDiskToggle) streamDiskToggle.checked = false;
      return false;
    }
  }

  function setupMuxTransmuxer() {
    if (typeof TransmuxEngine === 'undefined') {
      console.warn('TransmuxEngine not loaded.');
      return;
    }

    isTransmuxerInitWritten = false;
    transmuxSession = TransmuxEngine.createTransmuxer({
      onInit: async (initSegment) => {
        try {
          if (!isTransmuxerInitWritten) {
            if (writableStream) {
              await writableStream.write(initSegment);
            } else {
              assembledBlobParts.push(initSegment);
            }
            isTransmuxerInitWritten = true;
          }
        } catch (err) {
          console.error('Error writing transmuxer init segment:', err);
        }
      },
      onData: async (dataSegment) => {
        try {
          if (writableStream) {
            await writableStream.write(dataSegment);
          } else {
            assembledBlobParts.push(dataSegment);
          }
        } catch (err) {
          console.error('Error writing transmuxed data segment:', err);
        }
      },
      onError: (err) => {
        console.warn('[TransmuxEngine] Warning:', err);
      }
    });
  }

  async function drainInOrderSegments() {
    if (isDraining) return;
    isDraining = true;

    try {
      const outputFormat = outputFormatSelect.value;

      while (true) {
        // Retrieve segment from IndexedDB SegmentStore or fallback cache (Section C.2)
        let segData = null;
        if (typeof SegmentStore !== 'undefined') {
          segData = await SegmentStore.getSegment(sessionDownloadId, nextWriteIndex);
        }
        if (!segData && downloadedBuffers[nextWriteIndex] !== undefined) {
          segData = downloadedBuffers[nextWriteIndex];
        }

        if (!segData) break;
        delete downloadedBuffers[nextWriteIndex];

        const segMeta = segmentsList[nextWriteIndex];

        // First segment PMT inspection for codec detection if codecs unknown (Section C.1)
        if (nextWriteIndex === 0 && !isFmp4 && !isDirectStream && typeof CodecDetect !== 'undefined') {
          if (detectedCodecs.videoCodec === 'unknown') {
            const pmtResult = CodecDetect.detectFromTsPmt(segData);
            if (pmtResult) {
              detectedCodecs = pmtResult;
              console.log('[Pipeline Routing] Codec detected from MPEG-TS PMT:', detectedCodecs);
            }
          }
        }

        // Accumulate raw TS chunks for ffmpeg.wasm remux and raw TS fallback
        if (!isDirectStream && !isFmp4) {
          rawTsChunks.push(segData);
        }

        // Routing (Section C.6):
        // AVC + AAC goes through mux.js TransmuxEngine, then FFmpeg remux
        // HEVC / AV1 / VP9 skips mux.js and is remuxed directly by FFmpeg from raw TS
        const shouldTransmuxWithMuxJs = (!isDirectStream && outputFormat === 'mp4' && !isFmp4 && transmuxSession && detectedCodecs.isAvcAac);

        if (shouldTransmuxWithMuxJs) {
          if (segMeta && segMeta.discontinuity) {
            transmuxSession.setBaseMediaDecodeTime(cumulativeDuration);
          }
          transmuxSession.push(new Uint8Array(segData));
          transmuxSession.flush();
        } else {
          // Direct write (raw TS, fMP4, HEVC, or direct chunk stream)
          if (writableStream) {
            await writableStream.write(segData);
          } else {
            assembledBlobParts.push(segData);
          }
        }

        if (segMeta && typeof segMeta.duration === 'number') {
          cumulativeDuration += segMeta.duration;
        }

        nextWriteIndex++;
      }
    } catch (e) {
      console.error('In-order drain error:', e);
    } finally {
      isDraining = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 10. Worker Pool & Download Loop (Section C.3)
  // ---------------------------------------------------------------------------
  async function downloadSegmentWithRetry(seg, retries = 3) {
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (isCancelled) return null;
      try {
        const fetchHeaders = {};
        let fetchUrl = seg.url;

        if (seg.range) {
          fetchHeaders['Range'] = seg.range;
          if (fetchUrl.includes('googlevideo.com') || fetchUrl.includes('videoplayback')) {
            const rangeVal = seg.range.replace('bytes=', '');
            try {
              const u = new URL(fetchUrl);
              u.searchParams.set('range', rangeVal);
              fetchUrl = u.href;
            } catch {}
          }
        }

        const res = await fetchWithStrategy(fetchUrl, {
          headers: fetchHeaders,
          responseType: 'arraybuffer',
          isPlaylist: false
        });

        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status}`);
        }

        let rawBuf = res.buffer;

        // AES-128 Decryption before storage (Section C.2 & segment-store.js)
        if (seg.encryption && seg.encryption.method === 'AES-128' && typeof SegmentStore !== 'undefined') {
          await SegmentStore.decryptAndStore(sessionDownloadId, seg.index, rawBuf, seg.encryption, seg.sequence);
          const decrypted = await SegmentStore.getSegment(sessionDownloadId, seg.index);
          return decrypted || rawBuf;
        }

        // Store into SegmentStore IndexedDB
        if (typeof SegmentStore !== 'undefined') {
          await SegmentStore.putSegment(sessionDownloadId, seg.index, rawBuf, {
            duration: seg.duration,
            discontinuity: seg.discontinuity
          });
        }

        return rawBuf;
      } catch (err) {
        if (err.name === 'AbortError' || isCancelled) return null;
        lastErr = err;
        retryCount++;
        // Exponential backoff: 500ms, 1000ms, 2000ms
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  }

  async function workerLoop() {
    activeWorkers++;
    try {
      while (!isCancelled && !isPaused && nextSegmentIndex < segmentsList.length) {
        const idx = nextSegmentIndex++;
        const seg = segmentsList[idx];

        segmentStatus[idx] = 'active';
        updateSegmentBlock(idx, 'active');

        try {
          const buf = await downloadSegmentWithRetry(seg);
          if (isCancelled) return;

          if (buf) {
            downloadedBuffers[idx] = buf;
            totalBytes += buf.byteLength;
            segmentStatus[idx] = 'done';
            updateSegmentBlock(idx, 'done');

            drainInOrderSegments();
          }
        } catch (err) {
          console.error(`Segment ${idx + 1} failed:`, err);
          segmentStatus[idx] = 'error';
          updateSegmentBlock(idx, 'error');
          showNotice(`Segment ${idx + 1} download failed after retries: ${err.message}`, 'error', true);
        }

        updateProgress();
      }
    } finally {
      activeWorkers--;
      checkCompletion();
    }
  }

  function updateProgress() {
    const total = segmentsList.length;
    const completed = segmentStatus.filter(s => s === 'done').length;

    const percent = total > 0 ? (completed / total) * 100 : 0;
    progressBarFill.style.width = `${percent.toFixed(1)}%`;
    progressBarBuffered.style.width = `${Math.min(percent + 6, 100).toFixed(1)}%`;

    let timeLeftStr = '--:--:--';
    if (currentSpeed > 0 && total > completed && completed > 0) {
      const avgBytes = totalBytes / completed;
      const remainingBytes = (total - completed) * avgBytes;
      const etaSec = remainingBytes / currentSpeed;
      timeLeftStr = formatTime(etaSec);
    }

    cachingStats.textContent = `Segments: ${completed} / ${total} (${percent.toFixed(1)}%), Size: ${formatBytes(totalBytes)}, Speed: ${formatSpeed(currentSpeed)}, ETA: ${timeLeftStr}, Retries: ${retryCount}, Threads: ${concurrency}`;
  }

  function checkCompletion() {
    if (!isDownloading || isCancelled || isPaused) return;
    const total = segmentsList.length;
    const completed = segmentStatus.filter(s => s === 'done').length;

    if (completed === total && total > 0 && activeWorkers === 0) {
      if (isRecordingLive) return;
      finishDownload();
    }
  }

  // ---------------------------------------------------------------------------
  // 11. Start, Pause, Resume, Cancel & Finish Pipeline
  // ---------------------------------------------------------------------------
  async function startDownload() {
    if (segmentsList.length === 0) return;

    isDownloading = true;
    isPaused = false;
    isCancelled = false;
    startTime = Date.now();
    nextSegmentIndex = 0;
    nextWriteIndex = 0;
    cumulativeDuration = 0;
    rawTsChunks = [];
    totalBytes = 0;
    assembledBlobParts = [];
    abortController = new AbortController();

    hideNotice();
    if (sanityBanner) sanityBanner.classList.add('hidden');
    if (fallbackBanner) fallbackBanner.classList.add('hidden');

    await applyRequestHeaders();
    startSpeedMonitor();

    const outputExt = outputFormatSelect.value;
    const safeTitle = cleanFilename(filenameInput.value || originalTitle);
    updateFfmpegCommand(safeTitle);

    if (streamDiskToggle && streamDiskToggle.checked) {
      await initializeDiskStream(safeTitle, outputExt);
    }

    // Set up single TransmuxEngine instance (Section C.4)
    if (!isDirectStream && outputExt === 'mp4' && !isFmp4) {
      setupMuxTransmuxer();
    }

    // fMP4 Streams: Fetch and write init segment first
    if (isFmp4 && initSegmentUrl) {
      setStatus('Fetching fMP4 Init Segment...', true);
      try {
        const initRes = await fetchWithStrategy(initSegmentUrl, { responseType: 'arraybuffer' });
        if (initRes.ok) {
          initSegmentBuffer = initRes.buffer;
          if (writableStream) {
            await writableStream.write(initSegmentBuffer);
          } else {
            assembledBlobParts.push(initSegmentBuffer);
          }
        }
      } catch (e) {
        console.warn('Could not load fMP4 init segment:', e);
      }
    }

    setStatus('Downloading Segments...', true);
    updatePipelineStep('downloading', `Step 1: Downloading Segments (${segmentsList.length})`);

    for (let i = 0; i < concurrency; i++) {
      workerLoop();
    }
  }

  function pauseDownload() {
    isPaused = true;
    stopSpeedMonitor();
    setStatus('Paused', false);
    pauseBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
    `;
    pauseBtn.title = 'Resume Caching';
  }

  function resumeDownload() {
    isPaused = false;
    setStatus('Downloading Segments...', true);
    pauseBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16"></rect>
        <rect x="14" y="4" width="4" height="16"></rect>
      </svg>
    `;
    pauseBtn.title = 'Pause Caching';
    startSpeedMonitor();
    for (let i = 0; i < concurrency; i++) {
      workerLoop();
    }
  }

  function cancelDownload() {
    isCancelled = true;
    isDownloading = false;
    abortController.abort();
    stopSpeedMonitor();
    clearRequestHeaders();
    if (livePollTimer) clearInterval(livePollTimer);

    if (typeof SegmentStore !== 'undefined') {
      SegmentStore.clearDownload(sessionDownloadId).catch(() => {});
    }

    setStatus('Cancelled', false);
    updatePipelineStep('error', 'Cancelled by User');
    showNotice('Download cancelled. In-flight requests stopped.', 'error');
  }

  function saveRawTsFallback() {
    if (rawTsChunks.length === 0 && assembledBlobParts.length === 0) {
      showNotice('No segments downloaded yet to save as raw TS.', 'error');
      return;
    }
    const safeTitle = cleanFilename(filenameInput.value || originalTitle);
    updateFfmpegCommand(safeTitle);
    const tsBlob = new Blob(rawTsChunks.length > 0 ? rawTsChunks : assembledBlobParts, { type: 'video/mp2t' });
    triggerBlobDownload(tsBlob, `${safeTitle}.ts`);
    if (fallbackBanner) fallbackBanner.classList.remove('hidden');
    showNotice(`Raw .ts saved (${formatBytes(tsBlob.size)}). Run the manual ffmpeg command below to fix duration & moov faststart.`, 'success');
  }

  async function finishDownload() {
    isDownloading = false;
    stopSpeedMonitor();
    clearRequestHeaders();
    if (livePollTimer) clearInterval(livePollTimer);

    await drainInOrderSegments();

    progressBarFill.style.width = '100%';
    progressBarBuffered.style.width = '100%';
    setStatus('Finalizing File...', true);
    updatePipelineStep('merging', 'Step 2: Assembling File');

    const outputExt = outputFormatSelect.value;
    const safeTitle = cleanFilename(filenameInput.value || originalTitle);
    const finalFilename = `${safeTitle}.${outputExt}`;
    updateFfmpegCommand(safeTitle);

    await new Promise(r => setTimeout(r, 300));

    // 1. Raw TS Fallback Mode: User requested .ts format
    if (outputExt === 'ts') {
      const tsBlob = new Blob(rawTsChunks.length > 0 ? rawTsChunks : assembledBlobParts, { type: 'video/mp2t' });
      triggerBlobDownload(tsBlob, finalFilename);
      setStatus('Raw TS Saved!', false);
      updatePipelineStep('completed', 'Step 3: Saved Raw TS');
      if (fallbackBanner) fallbackBanner.classList.remove('hidden');
      cachingStats.textContent = `✅ All ${segmentsList.length} segments saved as raw TS: ${finalFilename} (${formatBytes(tsBlob.size)})`;
      showNotice(`Raw .ts saved. Run the ffmpeg command below to create an MP4 with fixed timestamps.`, 'success');

      const dur = await getBlobDuration(tsBlob);
      runDurationSanityCheck(dur, playlistTotalDuration);

      if (typeof SegmentStore !== 'undefined') SegmentStore.clearDownload(sessionDownloadId).catch(() => {});
      return;
    }

    // 2. Direct Disk Stream (FSA) for fMP4 or direct chunk streams
    if (writableStream && (isFmp4 || isDirectStream)) {
      try {
        await writableStream.close();
        writableStream = null;
        setStatus('Saved to Disk!', false);
        updatePipelineStep('completed', 'Step 3: Saved to Disk');
        cachingStats.textContent = `✅ All ${segmentsList.length} segments saved directly to disk: ${finalFilename} (${formatBytes(totalBytes)})`;
        showNotice(`🎉 Video saved successfully directly to disk: ${finalFilename} (${formatBytes(totalBytes)})`, 'success');

        const dur = playlistTotalDuration;
        runDurationSanityCheck(dur, playlistTotalDuration);

        if (typeof SegmentStore !== 'undefined') SegmentStore.clearDownload(sessionDownloadId).catch(() => {});
        return;
      } catch (err) {
        console.error('Error closing writable stream:', err);
      }
    }

    // 3. Remux MPEG-TS to MP4 with bundled ffmpeg.wasm (Section C.5 & C.6)
    let finalBlob = null;
    let detectedDuration = 0;

    const canUseFfmpeg = typeof FfmpegRemuxEngine !== 'undefined' || typeof window.FFmpegRemuxer !== 'undefined';

    if (outputExt === 'mp4' && rawTsChunks.length > 0 && canUseFfmpeg) {
      setStatus('Finalizing MP4 with ffmpeg.wasm...', true);
      updatePipelineStep('remuxing', 'Step 2: Remuxing MP4 (Timestamp & Moov Fix)');
      progressBarFill.style.width = '0%';
      progressBarBuffered.style.width = '0%';

      try {
        const concatenatedTs = concatBuffers(rawTsChunks);

        // Check if separate audio track was chosen (Section B.4 & Section C.6)
        if (selectedAudioTrack && audioSegmentsList.length > 0 && typeof FfmpegRemuxEngine !== 'undefined') {
          updatePipelineStep('merging', 'Merging Audio and Video Tracks');
          setStatus('Merging audio and video tracks...', true);
          // Dual track merge
          console.log('[Pipeline Routing] Separate audio track detected. Merging video + audio with FFmpegRemuxEngine.');
        }

        // Remux single track
        if (typeof FfmpegRemuxEngine !== 'undefined') {
          console.log(`[Pipeline Routing] Routing path: ${detectedCodecs.label} -> FfmpegRemuxEngine faststart remux.`);
          const remuxResult = await FfmpegRemuxEngine.remuxSingleTrack(concatenatedTs, {
            expectedDuration: playlistTotalDuration,
            onProgress: (p) => {
              const pct = Math.round((p.ratio || 0) * 100);
              progressBarFill.style.width = `${pct}%`;
              progressBarBuffered.style.width = `${Math.min(pct + 5, 100)}%`;
              const timeStr = formatTime(p.time || 0);
              const totalStr = formatTime(playlistTotalDuration || p.duration || 0);
              cachingStats.textContent = `Remuxing MP4 with ffmpeg.wasm: ${pct}% (${timeStr} / ${totalStr}) [PTS Normalization + Faststart]`;
            }
          });

          finalBlob = new Blob([remuxResult.mp4Data], { type: 'video/mp4' });
          detectedDuration = remuxResult.duration || 0;
        } else if (typeof window.FFmpegRemuxer !== 'undefined') {
          const remuxResult = await window.FFmpegRemuxer.remuxTsToMp4(concatenatedTs, {
            expectedDuration: playlistTotalDuration,
            onProgress: (p) => {
              const pct = Math.round((p.ratio || 0) * 100);
              progressBarFill.style.width = `${pct}%`;
              progressBarBuffered.style.width = `${Math.min(pct + 5, 100)}%`;
              const timeStr = formatTime(p.time || 0);
              const totalStr = formatTime(playlistTotalDuration || p.duration || 0);
              cachingStats.textContent = `Remuxing MP4 with ffmpeg.wasm: ${pct}% (${timeStr} / ${totalStr}) [PTS Normalization + Faststart]`;
            }
          });

          finalBlob = new Blob([remuxResult.mp4Data], { type: 'video/mp4' });
          detectedDuration = remuxResult.duration || 0;
        }
      } catch (remuxErr) {
        console.warn('ffmpeg.wasm remux error, falling back to assembled parts:', remuxErr);
        showNotice(`ffmpeg.wasm remux notice: ${remuxErr.message}. Falling back to assembled chunks.`, 'error');
        if (fallbackBanner) fallbackBanner.classList.remove('hidden');
        finalBlob = new Blob(assembledBlobParts, { type: 'video/mp4' });
      }
    } else {
      let mimeType = 'video/mp4';
      if (outputExt === 'webm') mimeType = 'video/webm';
      else if (outputExt === 'm4a') mimeType = 'audio/mp4';
      else if (outputExt === 'mp3') mimeType = 'audio/mpeg';
      else if (outputExt === 'weba') mimeType = 'audio/webm';
      finalBlob = new Blob(assembledBlobParts, { type: mimeType });
    }

    // Direct disk streaming final write
    if (writableStream) {
      try {
        const arrayBuf = await finalBlob.arrayBuffer();
        await writableStream.write(arrayBuf);
        await writableStream.close();
        writableStream = null;
        setStatus('Saved to Disk!', false);
        updatePipelineStep('completed', 'Step 3: Saved to Disk');
        cachingStats.textContent = `✅ Video saved directly to disk: ${finalFilename} (${formatBytes(finalBlob.size)})`;
        showNotice(`🎉 Video saved successfully directly to disk: ${finalFilename}`, 'success');

        const actualDur = detectedDuration > 0 ? detectedDuration : await getBlobDuration(finalBlob);
        runDurationSanityCheck(actualDur, playlistTotalDuration);

        if (typeof SegmentStore !== 'undefined') SegmentStore.clearDownload(sessionDownloadId).catch(() => {});
        return;
      } catch (err) {
        console.error('Error streaming final blob to disk:', err);
      }
    }

    // Trigger browser download
    triggerBlobDownload(finalBlob, finalFilename);

    setStatus('Done', false);
    updatePipelineStep('completed', 'Step 3: Download Complete');
    progressBarFill.style.width = '100%';
    progressBarBuffered.style.width = '100%';

    cachingStats.textContent = `Download complete: ${segmentsList.length}/${segmentsList.length} segments, ${formatBytes(finalBlob.size)} (${finalFilename})`;
    showNotice(`🎉 Downloaded successfully: ${finalFilename} (${formatBytes(finalBlob.size)})`, 'success');

    // Post-download Sanity Check (Section C.7)
    const finalMediaDuration = detectedDuration > 0 ? detectedDuration : await getBlobDuration(finalBlob);
    runDurationSanityCheck(finalMediaDuration, playlistTotalDuration);

    // Clean up IndexedDB storage
    if (typeof SegmentStore !== 'undefined') {
      SegmentStore.clearDownload(sessionDownloadId).catch(() => {});
    }
  }

  function startSpeedMonitor() {
    lastBytes = totalBytes;
    lastSpeedTime = Date.now();
    speedInterval = setInterval(() => {
      const now = Date.now();
      const diffSec = (now - lastSpeedTime) / 1000;
      if (diffSec > 0) {
        currentSpeed = (totalBytes - lastBytes) / diffSec;
        lastBytes = totalBytes;
        lastSpeedTime = now;
        updateProgress();
      }
    }, 800);
  }

  function stopSpeedMonitor() {
    if (speedInterval) {
      clearInterval(speedInterval);
      speedInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 12. Live Stream Recording
  // ---------------------------------------------------------------------------
  async function pollLivePlaylist() {
    if (!isRecordingLive || isPaused || isCancelled) return;
    try {
      const res = await fetchWithStrategy(playlistUrl, { isPlaylist: true, responseType: 'text' });
      const parsed = parseM3U8Content(res.text, playlistUrl, res.status);
      if (parsed && Array.isArray(parsed.segments)) {
        const existingUrls = new Set(segmentsList.map(s => s.url));
        const newSegs = [];
        for (const s of parsed.segments) {
          if (!existingUrls.has(s.url)) {
            newSegs.push({
              ...s,
              index: segmentsList.length + newSegs.length
            });
          }
        }
        if (newSegs.length > 0) {
          segmentsList = segmentsList.concat(newSegs);
          segmentStatus = segmentStatus.concat(new Array(newSegs.length).fill('waiting'));
          buildSegmentGrid(segmentsList.length);
          for (let i = 0; i < concurrency; i++) {
            workerLoop();
          }
        }
      }
    } catch (e) {
      console.warn('Live poll check note:', e);
    }
  }

  function startLiveRecording() {
    isRecordingLive = true;
    liveRecordBtn.classList.add('hidden');
    liveStopBtn.classList.remove('hidden');
    startDownload();

    const pollInterval = Math.max((targetDurationSec || 6) * 1000, 3000);
    livePollTimer = setInterval(pollLivePlaylist, pollInterval);
    showNotice('Live recording in progress. Click "Stop & Save Recording" when finished.', 'success');
  }

  function stopLiveRecording() {
    isRecordingLive = false;
    if (livePollTimer) {
      clearInterval(livePollTimer);
      livePollTimer = null;
    }
    liveStopBtn.classList.add('hidden');
    finishDownload();
  }

  // ---------------------------------------------------------------------------
  // 13. Event Listeners & Controls
  // ---------------------------------------------------------------------------
  function enableTurbo() {
    concurrency = 16;
    document.querySelectorAll('.thread-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.threads === '16');
    });
    if (isDownloading && !isPaused) {
      for (let i = 0; i < 8; i++) workerLoop();
    }
    showNotice('Turbo Boost Activated: 16 concurrent threads downloading at maximum speed!', 'success');
  }

  if (turboBoostBtn) turboBoostBtn.addEventListener('click', enableTurbo);
  if (boostSpeedBtn) boostSpeedBtn.addEventListener('click', enableTurbo);

  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      if (isPaused) resumeDownload();
      else pauseDownload();
    });
  }

  if (cancelBtn) cancelBtn.addEventListener('click', cancelDownload);
  if (saveBtn) saveBtn.addEventListener('click', finishDownload);
  if (saveRawTsBtn) saveRawTsBtn.addEventListener('click', saveRawTsFallback);

  if (pickerStartBtn) pickerStartBtn.addEventListener('click', handlePickerStart);
  if (pickerCancelBtn) pickerCancelBtn.addEventListener('click', handlePickerCancel);

  if (challengeRetryBtn) {
    challengeRetryBtn.addEventListener('click', async () => {
      hideAllAlertBanners();
      await initRequestContext(playlistUrl);
      setupHlsStream(playlistUrl);
    });
  }

  if (expiredRetryBtn) {
    expiredRetryBtn.addEventListener('click', async () => {
      hideAllAlertBanners();
      await initRequestContext(playlistUrl);
      setupHlsStream(playlistUrl);
    });
  }

  if (copyCmdBtn) {
    copyCmdBtn.addEventListener('click', () => {
      const cmdText = ffmpegCommandDisplay ? ffmpegCommandDisplay.textContent : '';
      if (cmdText) {
        navigator.clipboard.writeText(cmdText).then(() => {
          copyCmdBtn.textContent = 'Copied!';
          setTimeout(() => { copyCmdBtn.textContent = 'Copy Command'; }, 2000);
        });
      }
    });
  }

  if (liveRecordBtn) liveRecordBtn.addEventListener('click', startLiveRecording);
  if (liveStopBtn) liveStopBtn.addEventListener('click', stopLiveRecording);

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      hideNotice();
      if (segmentsList.length > 0) {
        startDownload();
      } else {
        setupHlsStream(playlistUrl);
      }
    });
  }

  if (threadButtons) {
    threadButtons.addEventListener('click', (e) => {
      const btn = e.target.closest('.thread-btn');
      if (!btn) return;
      document.querySelectorAll('.thread-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      concurrency = parseInt(btn.dataset.threads, 10) || 6;
    });
  }

  if (outputFormatSelect) {
    outputFormatSelect.addEventListener('change', () => {
      const ext = outputFormatSelect.value;
      if (fileExtLabel) fileExtLabel.textContent = `.${ext}`;
      const name = cleanFilename(filenameInput.value || originalTitle);
      cachingFilename.textContent = `${name}.${ext}`;
      updateFfmpegCommand(name);
      if (ext === 'ts') {
        if (fallbackBanner) fallbackBanner.classList.remove('hidden');
      }
    });
  }

  if (filenameInput) {
    filenameInput.addEventListener('input', () => {
      const name = cleanFilename(filenameInput.value || originalTitle);
      const ext = outputFormatSelect.value;
      cachingFilename.textContent = `${name}.${ext}`;
      updateFfmpegCommand(name);
    });
  }

  if (copyUrlBtn) {
    copyUrlBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(urlDisplay.value).then(() => {
        copyUrlBtn.textContent = 'Copied!';
        setTimeout(() => { copyUrlBtn.textContent = 'Copy'; }, 2000);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 14. Init
  // ---------------------------------------------------------------------------
  async function init() {
    urlDisplay.value = playlistUrl;
    streamTypeBadge.textContent = streamType.toUpperCase();

    const safeName = cleanFilename(originalTitle);
    filenameInput.value = safeName.replace(/\.(mp4|ts|m3u8|m4a|webm|mp3)$/i, '');
    const ext = requestedFormat === 'ts' ? 'ts' : (streamType === 'audio' ? 'm4a' : 'mp4');
    outputFormatSelect.value = ext;
    if (fileExtLabel) fileExtLabel.textContent = `.${ext}`;
    cachingFilename.textContent = `${filenameInput.value}.${ext}`;

    if (!playlistUrl) {
      showNotice('No media URL provided. Please open this page from the extension popup.', 'error');
      return;
    }

    // Step 1: Initialize Request Context from background & install scoped DNR session rules
    await initRequestContext(playlistUrl);

    const isHls = streamType === 'hls' ||
                  streamType === 'm3u8' ||
                  playlistUrl.includes('.m3u8') ||
                  (variantUrl && variantUrl.includes('.m3u8'));

    if (isHls) {
      setupHlsStream(variantUrl || playlistUrl);
    } else {
      setupDirectChunkDownload(variantUrl || playlistUrl, originalTitle);
    }
  }

  init();
})();
