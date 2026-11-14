/* ===================================================================
   Stream Downloader — Multi-Threaded HLS Engine (downloader.js)
   - Runs in extension page context (Blob, URL.createObjectURL, File System Access API)
   - Staged Pipeline Architecture:
       1. Request Context & Frame Capture (webRequest onSendHeaders + webNavigation)
       2. Multi-tier Fetch Strategy Chain (Stop at first valid #EXTM3U):
          - Strategy A: Same-frame fetch (MAIN world -> ISOLATED world -> candidate frames)
          - Strategy B: Frame content-script bridge ({ type: "FETCH", url, as })
          - Strategy C: declarativeNetRequest Header Replay (scoped to TAB_ID_NONE & stream host)
       3. Consistent Strategy Reuse for all key, init, and segment requests
       4. Real-time Diagnostics Debug Panel & Redacted Debug Info Export
       5. Pre-Download Resolution Picker (De-duplicated variants, audio renditions, subtitles)
       6. Codec Detection (CODECS attribute parsing & MPEG-TS PMT stream ID inspection)
       7. Segment Storage & AES-128 Decryption (IndexedDB keyed ${downloadId}:${index}, Web Crypto AES-CBC)
       8. Transmuxing & In-Order Assembly (Single mux.js transmuxer, setBaseMediaDecodeTime on discontinuity)
       9. FFmpeg.wasm Remuxing (PTS normalization, -movflags +faststart, moov duration repair, dual-track merge)
       10. Duration Verification Sanity Check (Sum of #EXTINF vs final duration, 5% threshold warning)
       11. Raw TS Fallback & Copyable Manual FFmpeg Command
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

  // Cross-origin iframe frame context parameters (Requirement 1)
  let currentFrameId = parseInt(params.get('frameId') || '0', 10);
  let currentFrameUrl = params.get('frameUrl') || '';
  let currentInitiator = params.get('initiator') || '';
  let currentCustomHeaders = [];
  let currentOrigin = '';

  // Working fetch strategy established during playlist probing (Requirement 2.D)
  let workingStrategy = null; // 'same-frame' | 'content-script' | 'header-replay'
  let workingFrameId = currentFrameId;

  // Stream tab lifecycle tracking (allows downloading to continue seamlessly when stream tab closes)
  let isTabClosed = false;
  let ownTabId = null;
  const installedDnrHosts = new Set();

  if (typeof chrome !== 'undefined' && chrome.tabs) {
    if (chrome.tabs.getCurrent) {
      chrome.tabs.getCurrent((tab) => {
        if (tab && tab.id) ownTabId = tab.id;
      });
    }

    if (currentTabId > 0 && chrome.tabs.get) {
      chrome.tabs.get(currentTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          console.log(`[Downloader] Origin tab ${currentTabId} is closed. Standalone extension mode active.`);
          isTabClosed = true;
          workingStrategy = 'header-replay';
          updateDebugActiveStrategy('header-replay (standalone)');
        }
      });
    }

    if (chrome.tabs.onRemoved) {
      chrome.tabs.onRemoved.addListener((closedTabId) => {
        if (closedTabId === currentTabId) {
          console.log(`[Downloader] Stream tab ${closedTabId} was closed. Seamlessly continuing download via standalone extension fetch.`);
          isTabClosed = true;
          workingStrategy = 'header-replay';
          updateDebugActiveStrategy('header-replay (standalone)');
        }
      });
    }
  } else {
    isTabClosed = true;
  }

  // Unique session identifier for IndexedDB & DNR rule scoping
  const sessionDownloadId = 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const DNR_RULE_ID = Math.floor(Math.random() * 800000) + 100000;

  // Request context captured from background.js
  let currentRequestContext = null;

  // Concurrency & Workers (6 parallel default, up to 16 with Turbo)
  let concurrency = 6;
  let activeWorkers = 0;
  let abortController = new AbortController();

  // Playlist & Segment State
  let segmentsList = [];
  let audioSegmentsList = [];
  let downloadedBuffers = {}; // In-memory buffer cache for drain fallback
  let segmentStatus = [];     // 'waiting' | 'active' | 'done' | 'error'
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

  // Disk Streaming & 5-Step Pipeline State Variables
  let totalSegmentsCount = 0;
  let mergedTsBuffer = null;
  let mergedTsBlob = null;
  let finalMp4Blob = null;
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

  // Diagnostic Logs Array (Requirement 3)
  const diagnosticLogs = [];

  // ---------------------------------------------------------------------------
  // 2. DOM Elements
  // ---------------------------------------------------------------------------
  const cachingBox = document.getElementById('caching-box');
  const cachingStatusLabel = document.getElementById('caching-status-label');
  const streamProtocolBadge = document.getElementById('stream-protocol-badge');
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
  const noticeCopyDebugBtn = document.getElementById('notice-copy-debug-btn');

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

  // Diagnostics / Debug Panel Elements (Requirement 3)
  const debugPanelCard = document.getElementById('debug-panel-card');
  const debugToggleHeader = document.getElementById('debug-toggle-header');
  const debugPanelBody = document.getElementById('debug-panel-body');
  const debugStrategyBadge = document.getElementById('debug-strategy-badge');
  const debugActiveStrategy = document.getElementById('debug-active-strategy');
  const debugFrameContext = document.getElementById('debug-frame-context');
  const debugDnrStatus = document.getElementById('debug-dnr-status');
  const debugLogsContainer = document.getElementById('debug-logs-container');
  const copyDebugBtn = document.getElementById('copy-debug-btn');
  const debugArrow = document.getElementById('debug-arrow');

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
    if (noticeCopyDebugBtn && diagnosticLogs.length > 0) {
      noticeCopyDebugBtn.classList.remove('hidden');
    }
  }

  function hideNotice() {
    if (noticeBox) noticeBox.classList.add('hidden');
    if (retryBtn) retryBtn.classList.add('hidden');
    if (noticeCopyDebugBtn) noticeCopyDebugBtn.classList.add('hidden');
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

  function runSizeSanityCheck(finalSize, expectedSegmentBytes) {
    if (!sanityBanner) return true;
    if (!expectedSegmentBytes || expectedSegmentBytes <= 0) return true;

    const ratio = finalSize / expectedSegmentBytes;
    const ratioPercent = (ratio * 100).toFixed(1);

    console.log(`[Sanity Check] Final size: ${finalSize} bytes (${formatBytes(finalSize)}), Segment sum: ${expectedSegmentBytes} bytes (${formatBytes(expectedSegmentBytes)}), Ratio: ${ratioPercent}%`);

    if (ratio < 0.5) {
      sanityBanner.className = 'alert-banner sanity-banner warning';
      if (sanityIcon) sanityIcon.textContent = '⚠️';
      if (sanityTitle) sanityTitle.textContent = `Size Warning: Output is only ${ratioPercent}% of segment data!`;
      if (sanityMessage) {
        sanityMessage.textContent = `The final file size (${formatBytes(finalSize)}) is under 50% of total downloaded segments (${formatBytes(expectedSegmentBytes)}). Media data may be incomplete or missing media fragments. Use the Raw TS fallback option below to save the full stream.`;
      }
      sanityBanner.classList.remove('hidden');
      if (fallbackBanner) fallbackBanner.classList.remove('hidden');
      showNotice(`⚠️ Size Warning: Final file size (${formatBytes(finalSize)}) is under 50% of total segment data (${formatBytes(expectedSegmentBytes)}).`, 'error');
      console.warn(`[Sanity Check] Warning: Output size ${finalSize} is under 50% of segment sum ${expectedSegmentBytes}`);
      return false;
    }
    return true;
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
  // 4. Diagnostics & Logging (Requirement 3)
  // ---------------------------------------------------------------------------
  function redactSensitive(data) {
    if (typeof FrameContext !== 'undefined' && FrameContext.redactDiagnosticData) {
      return FrameContext.redactDiagnosticData(data);
    }
    if (typeof data !== 'string') return data;
    return data
      .replace(/([?&](?:token|expires|exp|auth|sig|signature|key|session)=)[^&#\s]+/gi, '$1[REDACTED]')
      .replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/cookie:\s*[^;\r\n]+/gi, 'Cookie: [REDACTED]');
  }

  function logDiagnostic(entry) {
    const item = {
      ...entry,
      timestamp: new Date().toLocaleTimeString()
    };
    diagnosticLogs.push(item);
    renderDebugEntry(item);
    console.log(`[Diagnostic] [${item.strategy}] ${item.url} -> HTTP ${item.status || 'ERR'} (${item.contentType || ''})`, item);
  }

  function renderDebugEntry(item) {
    if (!debugLogsContainer) return;
    const emptyMsg = debugLogsContainer.querySelector('.debug-empty-msg');
    if (emptyMsg) emptyMsg.remove();

    const el = document.createElement('div');
    const isOk = item.ok && (item.status >= 200 && item.status < 300);
    el.className = `debug-log-entry ${isOk ? 'success' : 'failed'}`;

    const cleanUrl = redactSensitive(item.url || '');
    const preview = item.preview ? redactSensitive(item.preview.slice(0, 200)) : '';

    el.innerHTML = `
      <div class="debug-log-header">
        <span class="debug-log-strat">${item.strategy}</span>
        <span class="debug-log-status status-${item.status || 'err'}">HTTP ${item.status || 'ERR'}${item.statusText ? ' ' + item.statusText : ''}</span>
      </div>
      <div class="debug-log-url">${cleanUrl}</div>
      <div class="debug-log-details">
        <div><strong>Frame:</strong> id=${item.frameId !== undefined ? item.frameId : '0'}, url=${item.frameUrl ? redactSensitive(item.frameUrl) : 'top-level'}</div>
        <div><strong>Cache Used:</strong> ${item.cacheUsed ? '<span class="badge-cache">YES (In-Page)</span>' : 'NO (Network)'}</div>
        <div><strong>Content-Type:</strong> ${item.contentType || 'unknown'}, <strong>Final URL:</strong> ${item.finalUrl ? redactSensitive(item.finalUrl) : 'same'}, <strong>Redirected:</strong> ${!!item.redirected}</div>
        ${item.sentHeaders && Object.keys(item.sentHeaders).length > 0 ? `<div><strong>Headers Sent:</strong> ${redactSensitive(JSON.stringify(item.sentHeaders))}</div>` : ''}
        ${item.dnrMatched !== undefined ? `<div><strong>DNR Rule Match:</strong> ${item.dnrMatched ? 'YES (Rule ' + item.ruleId + ' fired)' : 'NO'}</div>` : ''}
        ${preview ? `<div class="debug-log-preview">${preview}</div>` : ''}
      </div>
    `;
    debugLogsContainer.appendChild(el);
    debugLogsContainer.scrollTop = debugLogsContainer.scrollHeight;
  }

  function updateDebugActiveStrategy(strat) {
    if (debugActiveStrategy) debugActiveStrategy.textContent = strat;
    if (debugStrategyBadge) {
      debugStrategyBadge.textContent = strat.toUpperCase();
      debugStrategyBadge.style.background = '#00c853';
    }
  }

  function copyDebugInfo() {
    const report = {
      generatedAt: new Date().toISOString(),
      streamUrl: redactSensitive(playlistUrl),
      tabId: currentTabId,
      resolvedFrameId: workingFrameId !== undefined ? workingFrameId : currentFrameId,
      resolvedFrameUrl: redactSensitive(currentFrameUrl),
      workingStrategy: workingStrategy || 'none',
      capturedContext: currentRequestContext ? {
        frameId: currentRequestContext.frameId,
        frameUrl: redactSensitive(currentRequestContext.frameUrl),
        initiator: redactSensitive(currentRequestContext.initiator),
        referer: redactSensitive(currentRequestContext.referer),
        origin: redactSensitive(currentRequestContext.origin),
        userAgent: currentRequestContext.userAgent,
        acceptLanguage: currentRequestContext.acceptLanguage,
        hasCookie: currentRequestContext.hasCookie,
        customHeaders: currentRequestContext.customHeaders
      } : null,
      attempts: diagnosticLogs.map(l => ({
        strategy: l.strategy,
        url: redactSensitive(l.url),
        status: l.status,
        contentType: l.contentType,
        frameId: l.frameId,
        frameUrl: redactSensitive(l.frameUrl),
        redirected: !!l.redirected,
        cacheUsed: !!l.cacheUsed,
        sentHeaders: l.sentHeaders ? redactSensitive(JSON.stringify(l.sentHeaders)) : null,
        dnrMatched: l.dnrMatched,
        preview: l.preview ? redactSensitive(l.preview.slice(0, 200)) : '',
        error: l.error || null,
        timestamp: l.timestamp
      }))
    };

    const jsonStr = JSON.stringify(report, null, 2);
    navigator.clipboard.writeText(jsonStr).then(() => {
      if (copyDebugBtn) copyDebugBtn.textContent = 'Copied!';
      if (noticeCopyDebugBtn) noticeCopyDebugBtn.textContent = 'Copied!';
      setTimeout(() => {
        if (copyDebugBtn) copyDebugBtn.textContent = 'Copy Debug Info';
        if (noticeCopyDebugBtn) noticeCopyDebugBtn.textContent = 'Copy Debug Info';
      }, 2500);
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Request Context & declarativeNetRequest Session Rules (Requirement 1 & 2.C)
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
        if (res.context.frameId !== undefined && !params.get('frameId')) {
          currentFrameId = res.context.frameId;
        }
        if (res.context.frameUrl && !currentFrameUrl) {
          currentFrameUrl = res.context.frameUrl;
        }
        if (res.context.initiator && !currentInitiator) {
          currentInitiator = res.context.initiator;
        }
        if (Array.isArray(res.context.customHeaders)) {
          currentCustomHeaders = res.context.customHeaders;
        }
      }
    } catch (err) {
      console.warn('[Request Context] Could not get context from background:', err);
    }

    if (debugFrameContext) {
      const fInfo = currentFrameUrl
        ? `Frame ${currentFrameId} (${currentFrameUrl})`
        : (currentFrameId > 0 ? `Frame ${currentFrameId}` : 'Top-Level Tab');
      debugFrameContext.textContent = redactSensitive(fInfo);
    }

    if (currentTabId > 0 && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.get) {
      chrome.tabs.get(currentTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          console.log(`[Downloader] Origin tab ${currentTabId} is closed. Using standalone extension mode.`);
          isTabClosed = true;
          workingStrategy = 'header-replay';
          updateDebugActiveStrategy('header-replay (standalone)');
        }
      });
    }

    await applyRequestHeaders(url);
  }

  async function applyRequestHeaders(urls) {
    try {
      const urlList = Array.isArray(urls) ? urls : [urls || playlistUrl];
      const targetUrl = urlList[0] || playlistUrl;

      // Extract unique hosts
      const hosts = [];
      for (const u of urlList) {
        if (!u) continue;
        try {
          const h = new URL(u).host;
          if (h && !hosts.includes(h)) hosts.push(h);
        } catch (_) {}
      }

      // If all hosts are already configured in DNR session rules, avoid duplicate API calls
      if (hosts.length > 0 && hosts.every(h => installedDnrHosts.has(h))) {
        return;
      }

      // Prioritize frameUrl / initiator over top-level tab URL (Requirement 1 & 2.C)
      const resolved = (typeof FrameContext !== 'undefined')
        ? FrameContext.resolveFrameHeaders({
            frameUrl: currentFrameUrl,
            initiator: currentInitiator,
            tabUrl: (currentRequestContext && currentRequestContext.pageUrl) || refererUrl,
            rawReferer: (currentRequestContext && currentRequestContext.rawReferer) || refererUrl,
            rawOrigin: (currentRequestContext && currentRequestContext.rawOrigin) || '',
            userAgent: (currentRequestContext && currentRequestContext.userAgent) || '',
            acceptLanguage: (currentRequestContext && currentRequestContext.acceptLanguage) || '',
            accept: (currentRequestContext && currentRequestContext.accept) || '',
            customHeaders: currentCustomHeaders
          })
        : {
            referer: currentFrameUrl || refererUrl,
            origin: (currentFrameUrl ? new URL(currentFrameUrl).origin : '') || '',
            headers: {}
          };

      currentOrigin = resolved.origin;

      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'setDownloadHeaders',
          ruleId: DNR_RULE_ID,
          url: targetUrl,
          urls: urlList,
          hosts,
          downloaderTabId: ownTabId,
          frameUrl: currentFrameUrl,
          referer: resolved.referer,
          origin: resolved.origin,
          userAgent: (currentRequestContext && currentRequestContext.userAgent) || '',
          acceptLanguage: (currentRequestContext && currentRequestContext.acceptLanguage) || '',
          accept: (currentRequestContext && currentRequestContext.accept) || '',
          customHeaders: currentCustomHeaders
        }, (res) => {
          if (res && res.success) {
            hosts.forEach(h => installedDnrHosts.add(h));
          }
          resolve(res);
        });
      });

      if (debugDnrStatus) {
        debugDnrStatus.textContent = `Installed (Rule ${DNR_RULE_ID})`;
      }
    } catch (err) {
      console.warn('[DNR] Error setting download headers:', err);
    }
  }

  async function clearRequestHeaders() {
    try {
      installedDnrHosts.clear();
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'clearDownloadHeaders',
          ruleId: DNR_RULE_ID
        }, resolve);
      });
      if (debugDnrStatus) debugDnrStatus.textContent = 'Cleared';
    } catch {}
  }

  window.addEventListener('beforeunload', () => {
    clearRequestHeaders();
    if (isDownloading && !isPaused) {
      abortController.abort();
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Fetch Strategy Chain (Stop at first valid #EXTM3U)
  // ---------------------------------------------------------------------------
  const VERIFICATION_MSG = "This site needs a verification step. Open the video page, complete it, let the video play for a few seconds, then click 'Retry'.";
  const EXPIRED_MSG = "Reload the page, let it play, then retry.";

  function isChallengeResponse(text, headers = {}, status = 0) {
    if (headers && headers['cf-mitigated'] === 'challenge') return true;
    if (status === 403 || status === 429) {
      if (!text || text.includes('<html') || text.includes('<!doctype') || text.includes('error') || text.includes('forbidden') || text.includes('denied')) {
        return true;
      }
    }
    if (!text) return false;
    const lower = text.toLowerCase();
    if (
      lower.includes('just a moment...') ||
      lower.includes('just a moment') ||
      lower.includes('turnstile') ||
      lower.includes('challenge-platform') ||
      lower.includes('attention required! | cloudflare') ||
      lower.includes('cf-mitigated') ||
      lower.includes('verify you are human') ||
      lower.includes('verify that you are a human') ||
      lower.includes('recaptcha') ||
      lower.includes('hcaptcha') ||
      lower.includes('captcha') ||
      lower.includes('security check') ||
      lower.includes('bot detection') ||
      lower.includes('checking your browser') ||
      lower.includes('enable javascript and cookies')
    ) {
      return true;
    }
    if ((lower.includes('<!doctype html') || lower.includes('<html')) && (
      lower.includes('access denied') ||
      lower.includes('forbidden') ||
      lower.includes('challenge') ||
      lower.includes('block') ||
      lower.includes('verification')
    )) {
      return true;
    }
    return false;
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
        triggerExpiredDetected(EXPIRED_MSG);
        return true;
      }
    } catch {}
    return false;
  }

  function triggerChallengeDetected(customMsg) {
    const msg = customMsg || VERIFICATION_MSG;
    if (challengeBanner) {
      if (challengeMessage) challengeMessage.textContent = msg;
      challengeBanner.classList.remove('hidden');
    }
    setStatus('Verification Required', false);
    updatePipelineStep('error', 'Verification Required');
    showNotice(msg, 'error', true);
  }

  function triggerExpiredDetected(customMsg) {
    const msg = customMsg || EXPIRED_MSG;
    if (expiredBanner) {
      if (expiredMessage) expiredMessage.textContent = msg;
      expiredBanner.classList.remove('hidden');
    }
    setStatus('Token Expired', false);
    updatePipelineStep('error', 'Token Expired');
    showNotice(msg, 'error', true);
  }

  async function getCachedPlaylist(url) {
    if (!chrome.runtime || !chrome.runtime.sendMessage) return null;
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getCachedPlaylist', url }, (res) => {
        if (chrome.runtime.lastError || !res || !res.success || !res.cached) {
          resolve(null);
        } else {
          resolve(res.entry);
        }
      });
    });
  }

  /**
   * Execute a single named strategy attempt.
   */
  async function executeStrategy(strat, url, options = {}) {
    const { responseType = 'text', isPlaylist = false, headers = {}, signal = abortController.signal } = options;

    if (strat === 'same-frame') {
      if (isTabClosed || !currentTabId || currentTabId <= 0) {
        return { ok: false, status: 0, error: 'Stream tab is closed' };
      }

      // Strategy A: Same-frame fetch in MAIN world with fallback to ISOLATED (Requirement 2.A)
      const targetFrame = workingFrameId !== undefined ? workingFrameId : currentFrameId;
      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          action: 'fetchFromPageContext',
          tabId: currentTabId,
          frameId: targetFrame,
          frameUrl: currentFrameUrl,
          initiator: currentInitiator,
          url,
          responseType: (responseType === 'arraybuffer' ? 'bytes' : 'text')
        }, resolve);
      });

      if (!res || !res.success || !res.result) {
        const errMsg = res ? res.error : 'No response';
        if ((res && res.tabClosed) || (errMsg && /no tab with id|receiving end does not exist|tab closed|not found/i.test(errMsg))) {
          console.log('[Downloader] Stream tab closed during execution. Switching permanently to header-replay.');
          isTabClosed = true;
          workingStrategy = 'header-replay';
          updateDebugActiveStrategy('header-replay (standalone)');
        }

        logDiagnostic({
          strategy: 'same-frame',
          url,
          frameId: targetFrame,
          frameUrl: currentFrameUrl,
          sentHeaders: { Referer: currentFrameUrl || 'location.href', credentials: 'include' },
          status: 0,
          statusText: 'Frame execution failed',
          contentType: '',
          error: errMsg,
          cacheUsed: false,
          ok: false
        });
        return { ok: false, status: 0, error: errMsg };
      }

      const pr = res.result;
      const isOk = pr.ok && (pr.status >= 200 && pr.status < 300);

      // 1. Check expired URL first
      if (checkExpiredUrl(url, pr.status)) {
        const err = new Error(EXPIRED_MSG);
        err.isExpired = true;
        throw err;
      }

      // 2. Treat header cf-mitigated: challenge as challenge
      if (pr.headers && pr.headers['cf-mitigated'] === 'challenge') {
        triggerChallengeDetected(VERIFICATION_MSG);
        const err = new Error(VERIFICATION_MSG);
        err.isChallenge = true;
        throw err;
      }

      // 3. Persistent 403 or 429 after same-frame fetch is treated as verification challenge
      if (pr.status === 403 || pr.status === 429) {
        triggerChallengeDetected(VERIFICATION_MSG);
        const err = new Error(VERIFICATION_MSG);
        err.isChallenge = true;
        throw err;
      }

      if (responseType === 'text' || isPlaylist) {
        let text = pr.text || '';
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        text = text.trim();

        if (isChallengeResponse(text, pr.headers, pr.status)) {
          triggerChallengeDetected(VERIFICATION_MSG);
          const err = new Error(VERIFICATION_MSG);
          err.isChallenge = true;
          throw err;
        }

        const validPlaylist = !isPlaylist || text.startsWith('#EXTM3U');

        logDiagnostic({
          strategy: `same-frame (${res.world || 'MAIN'})`,
          url,
          frameId: res.frameId !== undefined ? res.frameId : targetFrame,
          frameUrl: pr.frameLocation || currentFrameUrl,
          sentHeaders: { Referer: pr.frameLocation || currentFrameUrl, credentials: 'include' },
          status: pr.status,
          statusText: pr.statusText,
          contentType: pr.contentType || (pr.headers && pr.headers['content-type']) || '',
          finalUrl: pr.url || url,
          redirected: pr.redirected,
          preview: text,
          cacheUsed: false,
          ok: isOk && validPlaylist
        });

        if (isOk && validPlaylist) {
          workingFrameId = res.frameId !== undefined ? res.frameId : targetFrame;
          return { ok: true, status: pr.status, text, url: pr.url || url };
        }
        return { ok: false, status: pr.status, text, url: pr.url || url };
      } else {
        // Binary bytes: assemble chunks if split, or decode base64
        let bytes;
        if (pr.chunks && Array.isArray(pr.chunks)) {
          const parts = pr.chunks.map(c => atob(c));
          const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
          bytes = new Uint8Array(totalLen);
          let offset = 0;
          for (const part of parts) {
            for (let i = 0; i < part.length; i++) {
              bytes[offset++] = part.charCodeAt(i);
            }
          }
        } else {
          const base64 = pr.base64 || '';
          const binStr = atob(base64);
          const len = binStr.length;
          bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binStr.charCodeAt(i);
          }
        }

        logDiagnostic({
          strategy: `same-frame (${res.world || 'MAIN'})`,
          url,
          frameId: res.frameId !== undefined ? res.frameId : targetFrame,
          frameUrl: pr.frameLocation || currentFrameUrl,
          sentHeaders: { Referer: pr.frameLocation || currentFrameUrl, credentials: 'include' },
          status: pr.status,
          statusText: pr.statusText,
          contentType: pr.contentType || (pr.headers && pr.headers['content-type']) || '',
          finalUrl: pr.url || url,
          redirected: pr.redirected,
          preview: `[Binary data: ${bytes.byteLength} bytes]`,
          cacheUsed: false,
          ok: isOk
        });

        if (isOk) {
          workingFrameId = res.frameId !== undefined ? res.frameId : targetFrame;
          return { ok: true, status: pr.status, buffer: bytes.buffer, url: pr.url || url };
        }
        return { ok: false, status: pr.status, buffer: bytes.buffer, url: pr.url || url };
      }
    }

    if (strat === 'content-script') {
      if (isTabClosed || !currentTabId || currentTabId <= 0) {
        return { ok: false, status: 0, error: 'Stream tab is closed' };
      }

      // Strategy B: Frame content-script fetch (Requirement 2.B)
      const targetFrame = workingFrameId !== undefined ? workingFrameId : currentFrameId;
      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          action: 'fetchFromContentScript',
          tabId: currentTabId,
          frameId: targetFrame,
          url,
          responseType: (responseType === 'arraybuffer' ? 'bytes' : 'text'),
          headers
        }, resolve);
      });

      if (!res || !res.success || !res.result) {
        const errMsg = res ? res.error : 'No response';
        if ((res && res.tabClosed) || (errMsg && /no tab with id|receiving end does not exist|tab closed|not found/i.test(errMsg))) {
          console.log('[Downloader] Stream tab closed during execution. Switching permanently to header-replay.');
          isTabClosed = true;
          workingStrategy = 'header-replay';
          updateDebugActiveStrategy('header-replay (standalone)');
        }

        logDiagnostic({
          strategy: 'content-script',
          url,
          frameId: targetFrame,
          frameUrl: currentFrameUrl,
          sentHeaders: { Referer: currentFrameUrl || 'location.href', ...headers },
          status: 0,
          statusText: 'Content script unreachable',
          contentType: '',
          error: errMsg,
          cacheUsed: false,
          ok: false
        });
        return { ok: false, status: 0, error: errMsg };
      }

      const cr = res.result;
      const isOk = cr.ok && (cr.status >= 200 && cr.status < 300);

      // Check expired token URL
      if (checkExpiredUrl(url, cr.status)) {
        const err = new Error(EXPIRED_MSG);
        err.isExpired = true;
        throw err;
      }

      // Check challenge
      if (cr.headers && cr.headers['cf-mitigated'] === 'challenge') {
        triggerChallengeDetected(VERIFICATION_MSG);
        const err = new Error(VERIFICATION_MSG);
        err.isChallenge = true;
        throw err;
      }

      if (responseType === 'text' || isPlaylist) {
        let text = cr.text || '';
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        text = text.trim();

        if (isChallengeResponse(text, cr.headers, cr.status)) {
          triggerChallengeDetected(VERIFICATION_MSG);
          const err = new Error(VERIFICATION_MSG);
          err.isChallenge = true;
          throw err;
        }

        const validPlaylist = !isPlaylist || text.startsWith('#EXTM3U');

        logDiagnostic({
          strategy: 'content-script',
          url,
          frameId: res.frameId !== undefined ? res.frameId : targetFrame,
          frameUrl: cr.frameUrl || currentFrameUrl,
          sentHeaders: { Referer: cr.frameUrl || currentFrameUrl, ...headers },
          status: cr.status,
          statusText: cr.statusText,
          contentType: cr.contentType || '',
          finalUrl: cr.url || url,
          redirected: cr.redirected,
          preview: text,
          cacheUsed: false,
          ok: isOk && validPlaylist
        });

        if (isOk && validPlaylist) {
          workingFrameId = res.frameId !== undefined ? res.frameId : targetFrame;
          return { ok: true, status: cr.status, text, url: cr.url || url };
        }
        return { ok: false, status: cr.status, text, url: cr.url || url };
      } else {
        let bytes;
        if (cr.chunks && Array.isArray(cr.chunks)) {
          const parts = cr.chunks.map(c => atob(c));
          const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
          bytes = new Uint8Array(totalLen);
          let offset = 0;
          for (const part of parts) {
            for (let i = 0; i < part.length; i++) {
              bytes[offset++] = part.charCodeAt(i);
            }
          }
        } else {
          const base64 = cr.base64 || '';
          const binStr = atob(base64);
          const len = binStr.length;
          bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binStr.charCodeAt(i);
          }
        }

        logDiagnostic({
          strategy: 'content-script',
          url,
          frameId: res.frameId !== undefined ? res.frameId : targetFrame,
          frameUrl: cr.frameUrl || currentFrameUrl,
          sentHeaders: { Referer: cr.frameUrl || currentFrameUrl, ...headers },
          status: cr.status,
          statusText: cr.statusText,
          contentType: cr.contentType || '',
          finalUrl: cr.url || url,
          redirected: cr.redirected,
          preview: `[Binary data: ${bytes.byteLength} bytes]`,
          cacheUsed: false,
          ok: isOk
        });

        if (isOk) {
          workingFrameId = res.frameId !== undefined ? res.frameId : targetFrame;
          return { ok: true, status: cr.status, buffer: bytes.buffer, url: cr.url || url };
        }
        return { ok: false, status: cr.status, buffer: bytes.buffer, url: cr.url || url };
      }
    }

    if (strat === 'header-replay') {
      // Strategy C: declarativeNetRequest Header Replay (Requirement 2.C)
      await applyRequestHeaders(url);

      let directRes;
      try {
        directRes = await fetch(url, {
          method: 'GET',
          headers,
          signal,
          credentials: 'include'
        });
      } catch (fErr) {
        logDiagnostic({
          strategy: 'header-replay',
          url,
          frameId: -1,
          frameUrl: currentFrameUrl || refererUrl,
          sentHeaders: {
            Referer: currentFrameUrl || refererUrl,
            Origin: currentOrigin,
            'User-Agent': (currentRequestContext && currentRequestContext.userAgent) || '',
            ...headers
          },
          status: 0,
          statusText: fErr.name || 'NetworkError',
          contentType: '',
          error: fErr.message,
          cacheUsed: false,
          ok: false
        });
        return { ok: false, status: 0, error: fErr.message };
      }

      // Check matched rules from background (Requirement 2.C & 3)
      let dnrMatched = false;
      try {
        const matchedCheck = await new Promise(resolve => {
          chrome.runtime.sendMessage({ action: 'getMatchedRules' }, resolve);
        });
        if (matchedCheck && matchedCheck.success && Array.isArray(matchedCheck.rulesMatchedInfo)) {
          dnrMatched = matchedCheck.rulesMatchedInfo.some(r => r.rule && r.rule.ruleId === DNR_RULE_ID);
        }
      } catch (_) {}

      if (debugDnrStatus) {
        debugDnrStatus.textContent = dnrMatched ? `Rule ${DNR_RULE_ID} Fired (Active)` : `Installed (Rule ${DNR_RULE_ID})`;
      }

      // Check expired URL first
      if (checkExpiredUrl(url, directRes.status)) {
        const err = new Error(EXPIRED_MSG);
        err.isExpired = true;
        throw err;
      }

      const cfMitigated = directRes.headers.get('cf-mitigated');
      if (cfMitigated === 'challenge') {
        triggerChallengeDetected(VERIFICATION_MSG);
        const err = new Error(VERIFICATION_MSG);
        err.isChallenge = true;
        throw err;
      }

      const isOk = directRes.ok;

      if (responseType === 'text' || isPlaylist) {
        let text = await directRes.text();
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        text = text.trim();

        if (isChallengeResponse(text, {}, directRes.status)) {
          triggerChallengeDetected(VERIFICATION_MSG);
          const err = new Error(VERIFICATION_MSG);
          err.isChallenge = true;
          throw err;
        }

        const validPlaylist = !isPlaylist || text.startsWith('#EXTM3U');

        logDiagnostic({
          strategy: 'header-replay',
          url,
          frameId: -1,
          frameUrl: currentFrameUrl || refererUrl,
          sentHeaders: {
            Referer: currentFrameUrl || refererUrl,
            Origin: currentOrigin,
            'User-Agent': (currentRequestContext && currentRequestContext.userAgent) || '',
            ...headers
          },
          status: directRes.status,
          statusText: directRes.statusText,
          contentType: directRes.headers.get('content-type') || '',
          finalUrl: directRes.url,
          redirected: directRes.redirected,
          dnrMatched,
          ruleId: DNR_RULE_ID,
          preview: text,
          cacheUsed: false,
          ok: isOk && validPlaylist
        });

        if (isOk && validPlaylist) {
          return { ok: true, status: directRes.status, text, url: directRes.url };
        }
        return { ok: false, status: directRes.status, text, url: directRes.url };
      } else {
        const buf = await directRes.arrayBuffer();

        logDiagnostic({
          strategy: 'header-replay',
          url,
          frameId: -1,
          frameUrl: currentFrameUrl || refererUrl,
          sentHeaders: {
            Referer: currentFrameUrl || refererUrl,
            Origin: currentOrigin,
            'User-Agent': (currentRequestContext && currentRequestContext.userAgent) || '',
            ...headers
          },
          status: directRes.status,
          statusText: directRes.statusText,
          contentType: directRes.headers.get('content-type') || '',
          finalUrl: directRes.url,
          redirected: directRes.redirected,
          dnrMatched,
          ruleId: DNR_RULE_ID,
          preview: `[Binary data: ${buf.byteLength} bytes]`,
          cacheUsed: false,
          ok: isOk
        });

        if (isOk) {
          return { ok: true, status: directRes.status, buffer: buf, url: directRes.url };
        }
        return { ok: false, status: directRes.status, buffer: buf, url: directRes.url };
      }
    }

    throw new Error(`Unknown fetch strategy: ${strat}`);
  }

  /**
   * Staged Strategy Chain:
   * Probes strategies in order (Cache -> A -> B -> C) until first valid #EXTM3U is returned.
   * Once proven, locks in workingStrategy for all subsequent key, init, and segment fetches (Requirement 2.D).
   */
  async function fetchWithStrategy(url, options = {}) {
    const {
      responseType = 'text',
      isPlaylist = false,
      headers = {},
      signal = abortController.signal
    } = options;

    // Requirement 2: Reuse what the player already loaded first!
    if (isPlaylist) {
      try {
        const cached = await getCachedPlaylist(url);
        if (cached && cached.text) {
          let text = cached.text;
          if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
          text = text.trim();
          if (text.startsWith('#EXTM3U') || text.includes('<MPD')) {
            console.log('[Fetch Strategy] Using cached playlist from player session (zero network requests):', url);
            logDiagnostic({
              strategy: 'In-Page Player Cache',
              url,
              frameId: currentFrameId,
              frameUrl: cached.frameUrl || currentFrameUrl,
              sentHeaders: {},
              status: cached.status || 200,
              statusText: 'OK (Cached from Player)',
              contentType: cached.format === 'mpd' ? 'application/dash+xml' : 'application/vnd.apple.mpegurl',
              finalUrl: cached.finalUrl || url,
              redirected: false,
              preview: text,
              cacheUsed: true,
              ok: true
            });
            updateDebugActiveStrategy('In-Page Player Cache');
            return {
              ok: true,
              status: cached.status || 200,
              text,
              url: cached.finalUrl || url,
              cacheUsed: true
            };
          }
        }
      } catch (cacheErr) {
        console.warn('[Fetch Strategy] Cache lookup error:', cacheErr);
      }
    }

    // If working strategy has already been established, reuse it immediately (Requirement 2.D)
    if (workingStrategy) {
      try {
        const res = await executeStrategy(workingStrategy, url, { responseType, isPlaylist, headers, signal });
        if (res && res.ok) return res;
      } catch (err) {
        if (err.isChallenge || err.isExpired || err.name === 'AbortError' || isCancelled) throw err;
        console.warn(`[Fetch Strategy] Primary working strategy ${workingStrategy} failed, trying alternatives:`, err.message);
      }
    }

    // If the stream tab is closed, any in-page strategy cannot work; switch to header-replay
    if (isTabClosed && (workingStrategy === 'same-frame' || workingStrategy === 'content-script')) {
      workingStrategy = 'header-replay';
      updateDebugActiveStrategy('header-replay (standalone)');
    }

    // Try strategy chain in order: A (same-frame) -> B (content-script) -> C (header-replay)
    const strategies = isTabClosed
      ? ['header-replay']
      : ['same-frame', 'content-script', 'header-replay'];
    let lastError = null;
    let lastStatus = 0;

    for (const strat of strategies) {
      if (isCancelled) return null;
      try {
        const res = await executeStrategy(strat, url, { responseType, isPlaylist, headers, signal });
        if (res && res.ok) {
          if (workingStrategy !== strat) {
            console.log(`[Fetch Strategy] Switched working strategy from ${workingStrategy || 'none'} to ${strat}`);
            workingStrategy = strat;
            updateDebugActiveStrategy(strat);
          }
          return res;
        }
        if (res && res.status) lastStatus = res.status;
      } catch (err) {
        lastError = err;
        if (err.isChallenge || err.isExpired || err.name === 'AbortError' || isCancelled) throw err;
        console.warn(`[Fetch Strategy] Strategy ${strat} failed:`, err.message);
      }
    }

    // Check expired token (Requirement 4)
    if (checkExpiredUrl(url, lastStatus)) {
      throw new Error(EXPIRED_MSG);
    }

    // On final failure, show notice with tried strategies and display Copy Debug Info button (Requirement 3 & 4)
    if (noticeCopyDebugBtn) noticeCopyDebugBtn.classList.remove('hidden');
    const triedStr = strategies.join(' -> ');
    throw new Error(`Failed to load stream after trying all strategies (${triedStr}). HTTP Status: ${lastStatus || 'ERR'}. Click "Copy Debug Info" to inspect diagnostics.`);
  }

  // ---------------------------------------------------------------------------
  // 7. Segment Matrix UI
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
  // 8. Pre-Download Resolution Picker (Requirement 4)
  // ---------------------------------------------------------------------------
  async function showResolutionPicker(parsedMaster) {
    masterPlaylistData = parsedMaster;
    isMasterPlaylist = true;

    setStatus('Choose quality', false);
    updatePipelineStep('picker', 'Step 0: Choose Quality');

    // De-duplicate variants and sort by resolution descending
    const deduplicatedVariants = (typeof HlsParser !== 'undefined' && HlsParser.sortAndDeduplicateVariants)
      ? HlsParser.sortAndDeduplicateVariants(parsedMaster.variants)
      : parsedMaster.variants.slice().sort((a, b) => (b.height || 0) - (a.height || 0));

    // Retrieve saved user quality preference
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

    const initialSelectedCard = variantsList.children[preselectedIndex];
    if (initialSelectedCard) initialSelectedCard.classList.add('selected');

    // Separate Audio Tracks Selector (#EXT-X-MEDIA:TYPE=AUDIO)
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

    if (resolutionPickerCard) resolutionPickerCard.classList.remove('hidden');
    if (cachingBox) cachingBox.classList.add('hidden');
  }

  async function handlePickerStart() {
    if (!masterPlaylistData) return;

    const selectedRadio = document.querySelector('input[name="variant_pick"]:checked');
    if (!selectedRadio) {
      showNotice('Please select a resolution to download.', 'error');
      return;
    }

    const chosenVariantUrl = selectedRadio.value;
    const chosenCard = selectedRadio.closest('.variant-card');
    const chosenIndex = chosenCard ? parseInt(chosenCard.dataset.index, 10) : 0;
    selectedVariant = masterPlaylistData.variants[chosenIndex] || { url: chosenVariantUrl };

    if (!pickerAudioSection.classList.contains('hidden') && pickerAudioSelect.value) {
      selectedAudioTrack = { url: pickerAudioSelect.value };
    } else {
      selectedAudioTrack = null;
    }

    selectedSubtitles = [];
    document.querySelectorAll('#picker-subtitles-list input:checked').forEach(cb => {
      selectedSubtitles.push({ url: cb.value, language: cb.dataset.lang, name: cb.dataset.name });
    });

    if (pickerRememberPref && pickerRememberPref.checked) {
      const chosenLabel = selectedVariant.resolutionLabel || `${selectedVariant.height || 'best'}p`;
      chrome.storage.local.set({
        stream_quality_pref: chosenIndex === 0 ? 'highest' : chosenLabel,
        stream_remember_pref: true
      });
    }

    if (resolutionPickerCard) resolutionPickerCard.classList.add('hidden');
    if (cachingBox) cachingBox.classList.remove('hidden');

    setStatus('Loading chosen variant...', true);
    updatePipelineStep('loading', 'Loading Chosen Variant');

    try {
      const res = await fetchWithStrategy(chosenVariantUrl, { isPlaylist: true, responseType: 'text' });
      const subParsed = (typeof HlsParser !== 'undefined')
        ? HlsParser.parse(res.text, chosenVariantUrl, res.status)
        : parseM3U8Content(res.text, chosenVariantUrl, res.status);

      setupMediaPlaylist(subParsed);
    } catch (err) {
      if (err.isChallenge || err.isExpired) return;
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
  // 9. Staged Pipeline: Setup & Media Playlists
  // ---------------------------------------------------------------------------
  function parseM3U8Content(text, baseUrl, httpStatus = 200) {
    if (typeof HlsParser !== 'undefined' && typeof HlsParser.parse === 'function') {
      return HlsParser.parse(text, baseUrl, httpStatus);
    }
    throw new Error('HlsParser module is not loaded.');
  }

  async function setupHlsStream(url) {
    setStatus('Step 1: Detecting stream & reading manifest...', true);
    updatePipelineStep('loading', 'Step 1: Detecting Stream');
    hideAllAlertBanners();

    try {
      const res = await fetchWithStrategy(url, { isPlaylist: true, responseType: 'text' });
      const parsed = parseM3U8Content(res.text, url, res.status);

      // 1. DRM Check (Requirement 4)
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

      // 2. Master Playlist with variants -> Show Resolution Picker BEFORE downloading
      if (parsed.type === 'master' || parsed.isMaster) {
        if (streamProtocolBadge) {
          streamProtocolBadge.textContent = '📡 HLS Master Stream';
          streamProtocolBadge.className = 'stream-protocol-badge badge-hls-master';
        }
        if (streamTypeBadge) streamTypeBadge.textContent = 'HLS (Master)';
        setStatus('HLS Master stream detected. Select stream rendition below...', false);
        updatePipelineStep('ready', 'Step 1: Select HLS Rendition');
        await showResolutionPicker(parsed);
      } else {
        if (resolutionPickerCard) resolutionPickerCard.classList.add('hidden');
        if (cachingBox) cachingBox.classList.remove('hidden');
        setupMediaPlaylist(parsed);
      }
    } catch (err) {
      console.warn('Playlist load error:', err);
      if (err.isChallenge || err.isExpired) {
        // Challenge or expired token banners have already been displayed and retries stopped.
        return;
      }
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

    // -------------------------------------------------------------------------
    // STEP 1: Stream detected -> from that stream calculate total segments
    // -------------------------------------------------------------------------
    segmentsList = (parsed.segments || []).map((s, idx) => ({ ...s, index: idx }));
    totalSegmentsCount = segmentsList.length;
    downloadedBuffers = {};
    segmentStatus = new Array(totalSegmentsCount).fill('waiting');

    const avgSegDur = totalSegmentsCount > 0 ? (playlistTotalDuration / totalSegmentsCount).toFixed(1) : '0';
    const hlsSubtype = parsed.isFmp4 ? 'fMP4' : 'MPEG-TS';
    const isEncrypted = parsed.segments && parsed.segments.some(s => s.encryption && s.encryption.method === 'AES-128');
    const encTag = isEncrypted ? ' • AES-128' : '';

    // Show prominently in UI that this is an HLS stream
    if (streamProtocolBadge) {
      streamProtocolBadge.textContent = `📡 HLS Stream (${hlsSubtype}${encTag})`;
      streamProtocolBadge.className = 'stream-protocol-badge badge-hls';
    }
    if (streamTypeBadge) {
      streamTypeBadge.textContent = `HLS (${hlsSubtype})`;
    }

    console.log(`[Pipeline Step 1] HLS stream detected (${hlsSubtype}). Calculated total segments: ${totalSegmentsCount}, Duration: ${playlistTotalDuration}s (${formatTime(playlistTotalDuration)})`);

    buildSegmentGrid(totalSegmentsCount);
    updatePipelineStep('ready', `Step 1: HLS Stream (${totalSegmentsCount} Segments)`);
    setStatus(`HLS Stream detected: ${totalSegmentsCount} segments calculated (${formatTime(playlistTotalDuration)}, ~${avgSegDur}s/segment)`, false);
    cachingStats.textContent = `📡 HLS Stream: ${totalSegmentsCount} segments (${formatTime(playlistTotalDuration)} total duration, ~${avgSegDur}s/segment), Format: ${hlsSubtype}${encTag}`;

    // Codec Detection
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

    if (isLiveStream) {
      if (liveBanner) liveBanner.classList.remove('hidden');
      setStatus('Live Stream Ready', false);
      showNotice('Live stream detected (no endlist). Click "Record Live Stream" to begin capturing.', 'success');
      return;
    }

    setStatus('Starting Download to IndexedDB...', true);
    startDownload();
  }

  async function setupDirectChunkDownload(rawUrl, title) {
    isDirectStream = true;
    if (streamProtocolBadge) {
      streamProtocolBadge.textContent = 'Direct Stream';
      streamProtocolBadge.className = 'stream-protocol-badge badge-direct';
    }
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
  // 10. Disk Streaming & Transmuxing Engine
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

  /**
   * Scan and verify TS sync byte 0x47 at offsets 0, 188, 376.
   * If not found, scans the first 4 KB and strips leading bytes (fake image headers). (Requirement 1)
   */
  function inspectAndStripTsSegment(segBuffer, segmentIndex = 0) {
    if (!segBuffer || segBuffer.byteLength === 0) return segBuffer;
    if (typeof TransmuxEngine !== 'undefined' && typeof TransmuxEngine.inspectAndStripTsSegment === 'function') {
      return TransmuxEngine.inspectAndStripTsSegment(segBuffer, segmentIndex);
    }
    const uint8 = segBuffer instanceof Uint8Array ? segBuffer : new Uint8Array(segBuffer);

    // 1. Log first 16 bytes and size of segment 0 (Requirement 1)
    if (segmentIndex === 0) {
      const slice16 = Array.from(uint8.subarray(0, Math.min(16, uint8.length)))
        .map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[Segment 0] Downloaded/decrypted size: ${segBuffer.byteLength} bytes. First 16 bytes: [ ${slice16} ]`);
    }

    // Check if TS sync byte 0x47 is present at offsets 0, 188, 376
    const hasSyncAtZero = uint8.length >= 377 &&
      uint8[0] === 0x47 &&
      uint8[188] === 0x47 &&
      uint8[376] === 0x47;

    if (hasSyncAtZero) {
      return segBuffer instanceof ArrayBuffer ? segBuffer : uint8.buffer;
    }

    // If not found, scan the first 4 KB and strip leading bytes (fake image headers)
    const scanLimit = Math.min(4096, uint8.length - (188 * 2 + 1));
    let syncOffset = -1;

    for (let offset = 0; offset <= scanLimit; offset++) {
      if (uint8[offset] === 0x47 &&
          uint8[offset + 188] === 0x47 &&
          uint8[offset + 376] === 0x47) {
        syncOffset = offset;
        break;
      }
    }

    if (syncOffset === -1) {
      const fallbackLimit = Math.min(4096, uint8.length - 189);
      for (let offset = 0; offset <= fallbackLimit; offset++) {
        if (uint8[offset] === 0x47 && uint8[offset + 188] === 0x47) {
          syncOffset = offset;
          break;
        }
      }
    }

    if (syncOffset > 0) {
      const strippedUint8 = uint8.subarray(syncOffset);
      const out = new Uint8Array(strippedUint8.byteLength);
      out.set(strippedUint8);
      const strippedBuf = out.buffer;
      console.log(`[Segment ${segmentIndex}] TS sync byte 0x47 not at offset 0. Stripped ${syncOffset} leading bytes (fake image headers). Original size: ${segBuffer.byteLength} bytes -> Stripped size: ${strippedBuf.byteLength} bytes.`);
      return strippedBuf;
    }

    if (segBuffer instanceof ArrayBuffer) return segBuffer;
    const exactOut = new Uint8Array(uint8.byteLength);
    exactOut.set(uint8);
    return exactOut.buffer;
  }

  // ---------------------------------------------------------------------------
  // 11. Worker Pool & Download Loop (Requirement 2.D)
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

        // Segments are downloaded using the established working strategy (Requirement 2.D)
        const res = await fetchWithStrategy(fetchUrl, {
          headers: fetchHeaders,
          responseType: 'arraybuffer',
          isPlaylist: false
        });

        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status}`);
        }

        let rawBuf = res.buffer;

        // AES-128 Decryption before storage (SegmentStore IndexedDB)
        if (seg.encryption && seg.encryption.method === 'AES-128' && typeof SegmentStore !== 'undefined') {
          if (typeof SegmentStore.decryptSegmentBuffer === 'function') {
            rawBuf = await SegmentStore.decryptSegmentBuffer(rawBuf, seg.encryption, seg.sequence);
          } else {
            await SegmentStore.decryptAndStore(sessionDownloadId, seg.index, rawBuf, seg.encryption, seg.sequence);
            const decrypted = await SegmentStore.getSegment(sessionDownloadId, seg.index);
            if (decrypted) rawBuf = decrypted.data ? (decrypted.data.buffer || decrypted.data) : decrypted;
          }
        }

        // 1. Verify TS sync byte 0x47 and strip fake image headers if present (Requirement 1)
        rawBuf = inspectAndStripTsSegment(rawBuf, seg.index);

        // Store clean stripped segment in IndexedDB
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
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------------------
  // 11. Worker Pool & Download Loop (STEP 2: Download segments & store in IndexedDB)
  // ---------------------------------------------------------------------------
  async function workerLoop() {
    activeWorkers++;
    try {
      while (!isCancelled && !isPaused && nextSegmentIndex < segmentsList.length) {
        const idx = nextSegmentIndex++;
        const seg = segmentsList[idx];

        segmentStatus[idx] = 'active';
        updateSegmentBlock(idx, 'active');

        try {
          // Download, decrypt (if AES-128), strip headers, and save to IndexedDB
          const buf = await downloadSegmentWithRetry(seg);
          if (isCancelled) return;

          if (buf) {
            totalBytes += buf.byteLength;
            segmentStatus[idx] = 'done';
            updateSegmentBlock(idx, 'done');
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
  // 12. Start, Pause, Resume, Cancel & 5-Step Pipeline
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
    totalBytes = 0;
    mergedTsBuffer = null;
    mergedTsBlob = null;
    finalMp4Blob = null;
    rawTsChunks = [];
    assembledBlobParts = [];
    abortController = new AbortController();

    hideNotice();
    if (sanityBanner) sanityBanner.classList.add('hidden');
    if (fallbackBanner) fallbackBanner.classList.add('hidden');

    // Clean any prior stored segments for this download session in IndexedDB
    if (typeof SegmentStore !== 'undefined') {
      await SegmentStore.clearDownload(sessionDownloadId).catch(() => {});
    }

    // Check origin stream tab status
    if (currentTabId > 0 && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.get) {
      chrome.tabs.get(currentTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          isTabClosed = true;
          workingStrategy = 'header-replay';
          updateDebugActiveStrategy('header-replay (standalone)');
        }
      });
    }

    // Prepare DNR rules for both stream playlist host and segment hosts before downloading
    const initialHosts = [playlistUrl];
    if (segmentsList && segmentsList.length > 0) {
      if (segmentsList[0].url) initialHosts.push(segmentsList[0].url);
      const lastSeg = segmentsList[segmentsList.length - 1];
      if (lastSeg && lastSeg.url) initialHosts.push(lastSeg.url);
    }
    await applyRequestHeaders(initialHosts);
    startSpeedMonitor();

    const safeTitle = cleanFilename(filenameInput.value || originalTitle);
    updateFfmpegCommand(safeTitle);

    // -------------------------------------------------------------------------
    // STEP 2: Download segments and store in IndexedDB
    // -------------------------------------------------------------------------
    setStatus(`Step 2: Downloading ${totalSegmentsCount} segments to IndexedDB...`, true);
    updatePipelineStep('downloading', `Step 2: Downloading to IndexedDB (${totalSegmentsCount} Segments)`);

    // Launch concurrent worker pool
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
    setStatus(`Downloading ${totalSegmentsCount} Segments to IndexedDB...`, true);
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

  /**
   * Option to download raw .ts format (at any stage or on-demand).
   */
  async function saveRawTsFallback() {
    const safeTitle = cleanFilename(filenameInput.value || originalTitle);
    const tsFilename = `${safeTitle}.ts`;

    if (mergedTsBlob) {
      triggerBlobDownload(mergedTsBlob, tsFilename);
      showNotice(`Raw .ts saved (${formatBytes(mergedTsBlob.size)}).`, 'success');
      return;
    }

    // If not merged yet, retrieve whatever segments are currently stored in IndexedDB
    try {
      setStatus('Exporting available segments from IndexedDB as .ts...', true);
      if (typeof SegmentStore === 'undefined') {
        showNotice('SegmentStore is not available.', 'error');
        return;
      }
      const all = await SegmentStore.getAllSegments(sessionDownloadId);
      if (!all || all.length === 0) {
        showNotice('No segments downloaded yet to save as raw TS.', 'error');
        return;
      }
      const chunks = all.map(s => (s.data instanceof Uint8Array ? s.data : new Uint8Array(s.data)));
      const combined = concatBuffers(chunks);
      const tsBlob = new Blob([combined], { type: 'video/mp2t' });
      triggerBlobDownload(tsBlob, tsFilename);
      if (fallbackBanner) fallbackBanner.classList.remove('hidden');
      showNotice(`Exported ${all.length} segments as raw .ts (${formatBytes(tsBlob.size)}).`, 'success');
    } catch (e) {
      showNotice(`Error exporting raw TS: ${e.message}`, 'error');
    }
  }

  /**
   * Main Pipeline Execution (Steps 3, 4, 5):
   * 3. Once every segment is stored in IndexedDB, merge everything in .ts format.
   * 4. Once .ts format is generated, convert to .mp4 with FFmpeg.wasm.
   * 5. Download the .mp4 file and also give option to download .ts file.
   */
  async function finishDownload() {
    isDownloading = false;
    stopSpeedMonitor();
    clearRequestHeaders();
    if (livePollTimer) clearInterval(livePollTimer);

    const safeTitle = cleanFilename(filenameInput.value || originalTitle);
    updateFfmpegCommand(safeTitle);
    const mp4Filename = `${safeTitle}.mp4`;
    const tsFilename = `${safeTitle}.ts`;

    const totalSegments = segmentsList.length;
    if (totalSegments === 0) {
      showNotice('No segments available to assemble.', 'error');
      return;
    }

    try {
      // -----------------------------------------------------------------------
      // STEP 3: Once every segment is stored in IndexedDB, merge everything in TS format
      // -----------------------------------------------------------------------
      setStatus(`Step 3: Merging all ${totalSegments} segments from IndexedDB into .ts format...`, true);
      updatePipelineStep('merging', `Step 3: Merging in TS format (${totalSegments} segments)`);
      progressBarFill.style.width = '0%';
      progressBarBuffered.style.width = '0%';

      const tsParts = [];
      let totalMergedBytes = 0;

      for (let i = 0; i < totalSegments; i++) {
        if (isCancelled) return;
        let record = null;
        if (typeof SegmentStore !== 'undefined') {
          record = await SegmentStore.getSegment(sessionDownloadId, i);
        }
        if (!record || !record.data) {
          throw new Error(`Missing segment ${i + 1}/${totalSegments} in IndexedDB.`);
        }
        const u8 = record.data instanceof Uint8Array ? record.data : new Uint8Array(record.data);
        tsParts.push(u8);
        totalMergedBytes += u8.byteLength;

        const mergePct = Math.round(((i + 1) / totalSegments) * 100);
        progressBarFill.style.width = `${mergePct}%`;
        progressBarBuffered.style.width = `${Math.min(mergePct + 5, 100)}%`;
        cachingStats.textContent = `Merging segments in TS format: ${i + 1} / ${totalSegments} (${mergePct}%) — ${formatBytes(totalMergedBytes)}`;
      }

      // Concatenate all segment buffers into a single continuous MPEG-TS
      mergedTsBuffer = concatBuffers(tsParts);
      mergedTsBlob = new Blob([mergedTsBuffer], { type: 'video/mp2t' });
      rawTsChunks = [mergedTsBuffer]; // Keep populated for fallback references
      console.log(`[Pipeline Step 3] Merged TS created: ${mergedTsBuffer.byteLength} bytes (${formatBytes(mergedTsBuffer.byteLength)}) from ${totalSegments} segments.`);

      // Update manual TS command & display
      updateFfmpegCommand(safeTitle);
      if (fallbackBanner) fallbackBanner.classList.remove('hidden');

      // -----------------------------------------------------------------------
      // STEP 4: Once TS format is generated, convert to MP4
      // -----------------------------------------------------------------------
      setStatus('Step 4: Converting TS to MP4 with FFmpeg.wasm...', true);
      updatePipelineStep('remuxing', 'Step 4: Converting TS to MP4');
      progressBarFill.style.width = '0%';
      progressBarBuffered.style.width = '0%';

      let detectedDuration = playlistTotalDuration;

      const remuxEngine = (typeof window !== 'undefined' && window.FFmpegRemuxer) || (typeof FfmpegRemuxEngine !== 'undefined' ? FfmpegRemuxEngine : null);

      if (remuxEngine) {
        try {
          const remuxFn = (remuxEngine.remuxTsToMp4 || remuxEngine.remuxSingleTrack).bind(remuxEngine);
          const remuxResult = await remuxFn(mergedTsBuffer, {
            expectedDuration: playlistTotalDuration,
            onProgress: (p) => {
              const pct = Math.round((p.ratio || 0) * 100);
              progressBarFill.style.width = `${pct}%`;
              progressBarBuffered.style.width = `${Math.min(pct + 5, 100)}%`;
              const timeStr = formatTime(p.time || 0);
              const totalStr = formatTime(playlistTotalDuration || p.duration || 0);
              cachingStats.textContent = `Converting TS to MP4 with FFmpeg: ${pct}% (${timeStr} / ${totalStr}) [PTS Normalization + Faststart]`;
            }
          });

          finalMp4Blob = new Blob([remuxResult.mp4Data], { type: 'video/mp4' });
          if (remuxResult.duration > 0) detectedDuration = remuxResult.duration;
          console.log(`[Pipeline Step 4] FFmpeg conversion complete: MP4 size: ${finalMp4Blob.size} bytes (${formatBytes(finalMp4Blob.size)}), Duration: ${detectedDuration}s`);
        } catch (remuxErr) {
          console.warn('[Pipeline Step 4] FFmpeg remux error, trying TransmuxEngine fallback:', remuxErr);
          showNotice(`FFmpeg conversion warning: ${remuxErr.message}. Falling back to mux.js transmuxer...`, 'warning');

          if (typeof TransmuxEngine !== 'undefined') {
            try {
              const transmuxer = new TransmuxEngine.TransmuxSession({
                onData: () => {},
                isFmp4: false
              });
              for (const part of tsParts) {
                transmuxer.push(part);
                transmuxer.flush();
              }
              const assembled = transmuxer.getAssembledBoxes();
              if (assembled && assembled.length > 0) {
                finalMp4Blob = new Blob(assembled, { type: 'video/mp4' });
              }
            } catch (tErr) {
              console.error('TransmuxEngine fallback also failed:', tErr);
            }
          }
        }
      }

      // -----------------------------------------------------------------------
      // STEP 5: Download the MP4 file and also give option to download TS file
      // -----------------------------------------------------------------------
      progressBarFill.style.width = '100%';
      progressBarBuffered.style.width = '100%';
      setStatus('Step 5: Download Ready!', false);
      updatePipelineStep('completed', 'Step 5: Download Complete');

      // Auto-save MP4 if enabled
      if (finalMp4Blob) {
        if (autoSaveToggle && autoSaveToggle.checked) {
          triggerBlobDownload(finalMp4Blob, mp4Filename);
          showNotice(`🎉 MP4 downloaded: ${mp4Filename} (${formatBytes(finalMp4Blob.size)})! You can also download the raw .ts file below.`, 'success');
        } else {
          showNotice(`🎉 Ready to save: ${mp4Filename} (${formatBytes(finalMp4Blob.size)}). Click "Download MP4" or "Download .TS" below.`, 'success');
        }

        // Configure Save MP4 button
        if (saveBtn) {
          saveBtn.classList.remove('hidden');
          saveBtn.disabled = false;
          saveBtn.style.opacity = '1';
          if (saveBtnText) saveBtnText.textContent = 'Download MP4';
          saveBtn.onclick = () => {
            triggerBlobDownload(finalMp4Blob, mp4Filename);
            showNotice(`MP4 downloaded: ${mp4Filename} (${formatBytes(finalMp4Blob.size)})`, 'success');
          };
        }
      } else {
        // If MP4 conversion was not possible, default to downloading the TS file
        showNotice(`MP4 conversion could not complete. Saving raw TS file directly: ${tsFilename} (${formatBytes(mergedTsBlob.size)})`, 'warning');
        triggerBlobDownload(mergedTsBlob, tsFilename);
      }

      // Always give option to download the TS file
      if (saveRawTsBtn) {
        saveRawTsBtn.classList.remove('hidden');
        saveRawTsBtn.onclick = () => {
          triggerBlobDownload(mergedTsBlob, tsFilename);
          showNotice(`Downloaded raw .ts: ${tsFilename} (${formatBytes(mergedTsBlob.size)})`, 'success');
        };
      }

      const downloadTsBannerBtn = document.getElementById('download-ts-banner-btn');
      if (downloadTsBannerBtn) {
        downloadTsBannerBtn.onclick = () => {
          triggerBlobDownload(mergedTsBlob, tsFilename);
          showNotice(`Downloaded raw .ts: ${tsFilename} (${formatBytes(mergedTsBlob.size)})`, 'success');
        };
      }

      cachingStats.textContent = `✅ Complete! MP4 (${formatBytes(finalMp4Blob ? finalMp4Blob.size : 0)}) and TS (${formatBytes(mergedTsBuffer.byteLength)}) ready for download.`;

      // Sanity Checks: Compare final size with sum of segments & durations
      runSizeSanityCheck(finalMp4Blob ? finalMp4Blob.size : mergedTsBuffer.byteLength, totalMergedBytes);
      runDurationSanityCheck(detectedDuration, playlistTotalDuration);

    } catch (err) {
      console.error('[Pipeline Error]:', err);
      showNotice(`Pipeline error: ${err.message}. You can save the raw TS file below.`, 'error', true);
      if (fallbackBanner) fallbackBanner.classList.remove('hidden');
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
  // 13. Live Stream Recording
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
  // 14. Event Listeners & Controls
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
  const downloadTsBannerBtn = document.getElementById('download-ts-banner-btn');
  if (downloadTsBannerBtn) downloadTsBannerBtn.addEventListener('click', saveRawTsFallback);

  if (pickerStartBtn) pickerStartBtn.addEventListener('click', handlePickerStart);
  if (pickerCancelBtn) pickerCancelBtn.addEventListener('click', handlePickerCancel);

  // Debug Panel Toggle & Actions (Requirement 3)
  if (debugToggleHeader) {
    debugToggleHeader.addEventListener('click', (e) => {
      if (e.target && e.target.closest('#copy-debug-btn')) return;
      if (debugPanelBody) {
        debugPanelBody.classList.toggle('hidden');
        if (debugArrow) debugArrow.classList.toggle('rotated', debugPanelBody.classList.contains('hidden'));
      }
    });
  }

  if (copyDebugBtn) copyDebugBtn.addEventListener('click', copyDebugInfo);
  if (noticeCopyDebugBtn) noticeCopyDebugBtn.addEventListener('click', copyDebugInfo);

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
  // 15. Init
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

    // -------------------------------------------------------------------------
    // STEP 1: First detect stream (from URL params or active tab media list)
    // -------------------------------------------------------------------------
    if (!playlistUrl) {
      setStatus('Detecting stream from active tab...', true);
      try {
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const activeTab = tabs && tabs[0];
          if (activeTab && activeTab.id) {
            const resp = await new Promise(r => chrome.runtime.sendMessage({ action: 'getMedia', tabId: activeTab.id }, r));
            if (resp && resp.media && resp.media.length > 0) {
              const detected = resp.media[0];
              playlistUrl = detected.url;
              streamType = (detected.type || 'hls').toLowerCase();
              originalTitle = detected.title || detected.filename || 'video_download';
              currentTabId = activeTab.id;
              urlDisplay.value = playlistUrl;
              streamTypeBadge.textContent = streamType.toUpperCase();
              filenameInput.value = cleanFilename(originalTitle).replace(/\.(mp4|ts|m3u8|m4a|webm|mp3)$/i, '');
              cachingFilename.textContent = `${filenameInput.value}.${ext}`;
              console.log('[Pipeline Step 1] Stream auto-detected from tab:', detected);
            }
          }
        }
      } catch (e) {
        console.warn('Stream auto-detection query failed:', e);
      }
    }

    if (!playlistUrl) {
      showNotice('No media stream detected. Open a video page and select a stream from the extension popup.', 'error');
      setStatus('No Stream Detected', false);
      updatePipelineStep('error', 'No Stream Detected');
      return;
    }

    // Initialize Request Context with full frame context & DNR replay rules
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
