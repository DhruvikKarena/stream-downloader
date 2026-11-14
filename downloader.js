/* ===================================================================
   Stream Downloader — Multi-Threaded HLS Engine (downloader.js)
   - Runs in extension page context (Blob, URL.createObjectURL, File System Access API)
   - Master and media playlist parsing (#EXT-X-STREAM-INF, #EXT-X-ENDLIST, #EXT-X-MAP, #EXT-X-KEY)
   - AES-128 decryption via Web Crypto (AES-CBC) with playlist IV or big-endian sequence IV
   - Concurrent worker pool (6 parallel default, configurable) with 3 retries & backoff
   - In-order assembly & streaming to disk (showSaveFilePicker) to prevent memory overload
   - Transmuxes MPEG-TS to MP4 using bundled /lib/mux.min.js without re-encoding
   - fMP4 streams: writes init segment first, then media segments
   - Live stream detection & "Record until stopped" mode
   - DRM detection (SAMPLE-AES, Widevine, FairPlay, PlayReady) with warning banner
   - Request headers (Referer, Origin) managed via declarativeNetRequest session rules
   =================================================================== */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. URL Parameters & State
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  let playlistUrl = params.get('url') || '';
  let variantUrl = params.get('variant') || '';
  let originalTitle = params.get('title') || 'video_download';
  let refererUrl = params.get('referer') || '';
  let streamType = (params.get('type') || 'hls').toLowerCase();
  let requestedFormat = (params.get('format') || 'mp4').toLowerCase();

  // Dynamic rule ID for declarativeNetRequest session rules
  const DNR_RULE_ID = 8888;

  // Concurrency & Workers
  let concurrency = 6;
  let activeWorkers = 0;
  let abortController = new AbortController();

  // Playlist & Segment State
  let segmentsList = [];
  let downloadedBuffers = {}; // index -> ArrayBuffer
  let segmentStatus = [];     // 'waiting' | 'active' | 'done' | 'error'
  let nextSegmentIndex = 0;
  let nextWriteIndex = 0;
  let retryCount = 0;

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

  // Disk Streaming (File System Access API)
  let isDiskStreamingActive = false;
  let fileHandle = null;
  let writableStream = null;
  let assembledBlobParts = [];

  // Transmuxer (mux.js) & Timestamps
  let transmuxer = null;
  let isTransmuxerInitWritten = false;
  let rawTsChunks = [];
  let cumulativeDuration = 0;
  let playlistTotalDuration = 0;

  // Download & UI Flags
  let isDownloading = false;
  let isPaused = false;
  let isCancelled = false;
  let isDraining = false;

  // Speed & Progress Monitoring
  let totalBytes = 0;
  let expectedTotalBytes = 0;
  let startTime = 0;
  let speedInterval = null;
  let lastBytes = 0;
  let lastSpeedTime = 0;
  let currentSpeed = 0;

  // AES-128 Crypto Cache
  const cryptoKeyCache = new Map();

  // ---------------------------------------------------------------------------
  // 2. DOM Elements
  // ---------------------------------------------------------------------------
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

  const drmBanner = document.getElementById('drm-banner');
  const liveBanner = document.getElementById('live-banner');
  const liveRecordBtn = document.getElementById('live-record-btn');
  const liveStopBtn = document.getElementById('live-stop-btn');
  const noticeBox = document.getElementById('notice-box');
  const noticeText = document.getElementById('notice-text');
  const retryBtn = document.getElementById('retry-btn');

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
  // 3. UI Helpers
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
  // 4. Request Headers via declarativeNetRequest
  // ---------------------------------------------------------------------------
  function applyRequestHeaders() {
    if (!refererUrl) return;
    try {
      const u = new URL(refererUrl);
      const origin = u.origin;
      chrome.runtime.sendMessage({
        action: 'setDownloadHeaders',
        ruleId: DNR_RULE_ID,
        referer: refererUrl,
        origin: origin
      });
    } catch {}
  }

  function clearRequestHeaders() {
    try {
      chrome.runtime.sendMessage({
        action: 'clearDownloadHeaders',
        ruleId: DNR_RULE_ID
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
  // 5. Segment Matrix UI
  // ---------------------------------------------------------------------------
  function buildSegmentGrid(count) {
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
  // 6. M3U8 Playlist Parser
  // ---------------------------------------------------------------------------
  function extractAttr(attrStr, name) {
    const match = attrStr.match(new RegExp(`${name}=(?:"([^"]*)"|([^,\\s]*))`));
    return match ? (match[1] || match[2] || '') : '';
  }

  async function fetchPlaylistText(url) {
    let res;
    try {
      res = await fetch(url, { signal: abortController.signal, credentials: 'include' });
    } catch (err) {
      throw new Error(`Network error when fetching playlist: ${err.message}`);
    }
    const text = await res.text();
    return { text, status: res.status, ok: res.ok };
  }

  function parseM3U8Content(text, baseUrl, httpStatus = 200) {
    if (typeof HlsParser !== 'undefined' && typeof HlsParser.parse === 'function') {
      return HlsParser.parse(text, baseUrl, httpStatus);
    }

    // Fallback if HlsParser script is not loaded
    const clean = (text || '').replace(/^\uFEFF/, '').trim();
    const m3uIndex = clean.indexOf('#EXTM3U');
    if (m3uIndex === -1) {
      const snippet = clean.slice(0, 200).replace(/\s+/g, ' ');
      if (clean.includes('<html') || clean.includes('<!DOCTYPE')) {
        throw new Error(`Server returned HTTP ${httpStatus}: "${snippet}" (HTML error page, not #EXTM3U)`);
      }
      throw new Error(`Server returned HTTP ${httpStatus}: "${snippet}" (Missing #EXTM3U tag)`);
    }

    const lines = clean.slice(m3uIndex).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const segments = [];
    let currentDuration = 0;
    let pendingDiscontinuity = false;
    let cumulativeDuration = 0;
    let mediaSequence = 0;
    let hasEndList = false;
    let initSegment = null;
    let targetDuration = 6;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-TARGETDURATION')) {
        targetDuration = parseFloat(line.split(':')[1]) || 6;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      } else if (line.startsWith('#EXT-X-MAP')) {
        const attrs = line.substring(line.indexOf(':') + 1);
        const mapUri = extractAttr(attrs, 'URI');
        if (mapUri) initSegment = { url: resolveUrl(mapUri, baseUrl) };
      } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        pendingDiscontinuity = true;
      } else if (line.startsWith('#EXTINF')) {
        const val = line.substring(line.indexOf(':') + 1);
        currentDuration = parseFloat(val.split(',')[0]) || 0;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        hasEndList = true;
      } else if (!line.startsWith('#')) {
        segments.push({
          url: resolveUrl(line, baseUrl),
          duration: currentDuration,
          discontinuity: pendingDiscontinuity,
          cumulativeDuration: cumulativeDuration,
          index: segments.length,
          sequence: mediaSequence + segments.length
        });
        cumulativeDuration += currentDuration;
        pendingDiscontinuity = false;
        currentDuration = 0;
      }
    }

    return {
      type: 'media',
      segments,
      totalDuration: cumulativeDuration,
      mediaSequence,
      targetDuration,
      hasEndList,
      initSegment,
      isFmp4: !!initSegment || segments.some(s => s.url.includes('.m4s') || s.url.includes('.mp4'))
    };
  }

  // ---------------------------------------------------------------------------
  // 7. AES-128 Decryption (Web Crypto AES-CBC)
  // ---------------------------------------------------------------------------
  async function getCryptoKey(keyUri) {
    if (cryptoKeyCache.has(keyUri)) return cryptoKeyCache.get(keyUri);
    const res = await fetch(keyUri, { signal: abortController.signal, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} when fetching AES encryption key`);
    const keyRaw = await res.arrayBuffer();
    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      keyRaw,
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );
    cryptoKeyCache.set(keyUri, cryptoKey);
    return cryptoKey;
  }

  function parseHexIv(hexStr) {
    const clean = hexStr.startsWith('0x') || hexStr.startsWith('0X') ? hexStr.slice(2) : hexStr;
    const ivBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      ivBytes[i] = parseInt(clean.substr(i * 2, 2), 16) || 0;
    }
    return ivBytes;
  }

  async function decryptSegmentBuffer(buffer, encryption, sequenceNumber) {
    if (!encryption || encryption.method !== 'AES-128' || !encryption.uri) {
      return buffer;
    }

    const cryptoKey = await getCryptoKey(encryption.uri);

    // IV from tag or default to segment sequence number as a 16-byte big-endian value
    let ivBytes;
    if (encryption.iv && encryption.iv.length >= 2) {
      ivBytes = parseHexIv(encryption.iv);
    } else {
      ivBytes = new Uint8Array(16);
      const view = new DataView(ivBytes.buffer);
      // Sequence number is placed in the last 4 bytes as a big-endian integer
      view.setUint32(12, sequenceNumber, false);
    }

    return await window.crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: ivBytes },
      cryptoKey,
      buffer
    );
  }

  // ---------------------------------------------------------------------------
  // 8. Disk Streaming & Transmuxing Engine
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
      console.warn('showSaveFilePicker was cancelled or unsupported, falling back to in-memory Blob:', err);
      fileHandle = null;
      writableStream = null;
      isDiskStreamingActive = false;
      if (streamDiskToggle) streamDiskToggle.checked = false;
      return false;
    }
  }

  function setupMuxTransmuxer() {
    if (typeof window.muxjs === 'undefined' || !window.muxjs.mp4) {
      console.warn('mux.js not loaded, raw TS will be preserved.');
      return;
    }

    // Single mux.js Transmuxer instance for the whole download
    // keepOriginalTimestamps is disabled so setBaseMediaDecodeTime functions properly
    transmuxer = new window.muxjs.mp4.Transmuxer({
      remux: false,
      keepOriginalTimestamps: false
    });
    isTransmuxerInitWritten = false;

    try {
      transmuxer.setBaseMediaDecodeTime(0);
    } catch (_) {}

    transmuxer.on('data', async (segment) => {
      try {
        // Write the init segment (ftyp + moov) only once for the whole stream
        if (segment.initSegment && !isTransmuxerInitWritten) {
          if (writableStream) {
            await writableStream.write(segment.initSegment);
          } else {
            assembledBlobParts.push(segment.initSegment);
          }
          isTransmuxerInitWritten = true;
        }

        if (segment.data) {
          if (writableStream) {
            await writableStream.write(segment.data);
          } else {
            assembledBlobParts.push(segment.data);
          }
        }
      } catch (err) {
        console.error('Error writing transmuxed fragment:', err);
      }
    });
  }

  async function drainInOrderSegments() {
    if (isDraining) return;
    isDraining = true;

    try {
      const outputFormat = outputFormatSelect.value;

      while (downloadedBuffers[nextWriteIndex] !== undefined) {
        const segData = downloadedBuffers[nextWriteIndex];
        const segMeta = segmentsList[nextWriteIndex];
        delete downloadedBuffers[nextWriteIndex]; // Free memory immediately

        // Accumulate raw TS chunks for ffmpeg.wasm remux and raw TS fallback
        if (!isDirectStream && !isFmp4) {
          rawTsChunks.push(segData);
        }

        if (!isDirectStream && outputFormat === 'mp4' && !isFmp4 && transmuxer) {
          // On discontinuity, align track fragment decode time to cumulative playlist duration
          if (segMeta && segMeta.discontinuity) {
            try {
              transmuxer.setBaseMediaDecodeTime(Math.round(cumulativeDuration * 90000));
            } catch (err) {
              console.warn('[Transmuxer] setBaseMediaDecodeTime warning:', err);
            }
          }

          // Push and flush each segment in order
          transmuxer.push(new Uint8Array(segData));
          transmuxer.flush();
        } else {
          // Direct write (raw TS, fMP4, or direct chunk stream)
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
  // 9. Worker Pool & Download Loop
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

        const res = await fetch(fetchUrl, {
          headers: fetchHeaders,
          signal: abortController.signal,
          credentials: 'include'
        });

        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status}`);
        }

        let buf = await res.arrayBuffer();

        // Decrypt if AES-128
        if (seg.encryption && seg.encryption.method === 'AES-128') {
          buf = await decryptSegmentBuffer(buf, seg.encryption, seg.sequence);
        }

        return buf;
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

            // In-order assembly & streaming to disk
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

    // Speed & ETA
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
      if (isRecordingLive) {
        // Continue live recording until user stops
        return;
      }
      finishDownload();
    }
  }

  // ---------------------------------------------------------------------------
  // 10. Start, Pause, Resume, Cancel & Finish
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
    applyRequestHeaders();
    startSpeedMonitor();

    const outputExt = outputFormatSelect.value;
    const safeTitle = cleanFilename(filenameInput.value || originalTitle);
    updateFfmpegCommand(safeTitle);

    // Prompt user to stream to disk if enabled
    if (streamDiskToggle && streamDiskToggle.checked) {
      await initializeDiskStream(safeTitle, outputExt);
    }

    // Set up transmuxer if converting TS to MP4 (not for direct streams or fMP4)
    if (!isDirectStream && outputExt === 'mp4' && !isFmp4) {
      setupMuxTransmuxer();
    }

    // fMP4 Streams: Fetch and write init segment first
    if (isFmp4 && initSegmentUrl) {
      setStatus('Fetching fMP4 Init Segment...', true);
      try {
        const initRes = await fetch(initSegmentUrl, { signal: abortController.signal, credentials: 'include' });
        if (initRes.ok) {
          initSegmentBuffer = await initRes.arrayBuffer();
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

    // Dispatch concurrency workers
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

    // Complete in-order draining
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

      // Sanity Check
      const dur = await getBlobDuration(tsBlob);
      runDurationSanityCheck(dur, playlistTotalDuration);
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
        return;
      } catch (err) {
        console.error('Error closing writable stream:', err);
      }
    }

    // 3. Remux MPEG-TS to MP4 with bundled ffmpeg.wasm
    // Command: -fflags +genpts -i in.ts -c copy -movflags +faststart out.mp4
    let finalBlob = null;
    let detectedDuration = 0;

    if (outputExt === 'mp4' && rawTsChunks.length > 0 && typeof window.FFmpegRemuxer !== 'undefined') {
      setStatus('Remuxing with ffmpeg.wasm...', true);
      updatePipelineStep('remuxing', 'Step 2: Remuxing MP4 (Timestamp & Moov Fix)');
      progressBarFill.style.width = '0%';
      progressBarBuffered.style.width = '0%';

      try {
        const concatenatedTs = concatBuffers(rawTsChunks);
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
      } catch (remuxErr) {
        console.warn('ffmpeg.wasm remux failed, falling back to mux.js / raw TS:', remuxErr);
        showNotice(`ffmpeg.wasm remux notice: ${remuxErr.message}. Output assembled via mux.js.`, 'error');
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

    // Write to writableStream if direct disk streaming was selected
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
        return;
      } catch (err) {
        console.error('Error streaming final blob to disk:', err);
      }
    }

    // Trigger browser download
    triggerBlobDownload(finalBlob, finalFilename);

    setStatus('Download Complete!', false);
    updatePipelineStep('completed', 'Step 3: Download Complete');
    progressBarFill.style.width = '100%';
    progressBarBuffered.style.width = '100%';

    cachingStats.textContent = `✅ All ${segmentsList.length} segments merged! Downloaded: ${finalFilename} (${formatBytes(finalBlob.size)})`;
    showNotice(`🎉 Downloaded successfully: ${finalFilename} (${formatBytes(finalBlob.size)})`, 'success');

    // Post-download Sanity Check (Requirement 5)
    const finalMediaDuration = detectedDuration > 0 ? detectedDuration : await getBlobDuration(finalBlob);
    runDurationSanityCheck(finalMediaDuration, playlistTotalDuration);
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
  // 11. Live Stream Recording
  // ---------------------------------------------------------------------------
  async function pollLivePlaylist() {
    if (!isRecordingLive || isPaused || isCancelled) return;
    try {
      const { text, status } = await fetchPlaylistText(playlistUrl);
      const parsed = parseM3U8Content(text, playlistUrl, status);
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
  // 12. Setup & Initialization
  // ---------------------------------------------------------------------------
  async function setupHlsStream(url) {
    setStatus('Parsing HLS Playlist...', true);
    hideNotice();

    try {
      const { text, status } = await fetchPlaylistText(url);
      const parsed = parseM3U8Content(text, url, status);

      // 1. DRM Check
      if (parsed.isDrmProtected) {
        isDrmProtected = true;
        drmBanner.classList.remove('hidden');
        setStatus('DRM-Protected Stream', false);
        updatePipelineStep('error', "DRM-protected, can't be downloaded");
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.5';
        showNotice("DRM-protected, can't be downloaded", 'error');
        return;
      }

      // 2. Master Playlist with variants
      if (parsed.type === 'master') {
        isMasterPlaylist = true;
        qualitySection.classList.remove('hidden');
        qualitySelect.innerHTML = '';

        parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
        parsed.variants.forEach((v, i) => {
          const opt = document.createElement('option');
          opt.value = v.url;
          if (v.audioUrl) opt.dataset.audioUrl = v.audioUrl;
          const res = v.resolution ? `${v.resolution}` : `Variant ${i + 1}`;
          const kbps = v.bandwidth ? ` (${Math.round(v.bandwidth / 1000)} kbps)` : '';
          opt.textContent = `${res}${kbps}`;
          qualitySelect.appendChild(opt);
        });

        // Use variant from query or highest quality
        const chosen = variantUrl && parsed.variants.some(v => v.url === variantUrl)
          ? variantUrl
          : parsed.variants[0].url;

        qualitySelect.value = chosen;
        const { text: subText, status: subStatus } = await fetchPlaylistText(chosen);
        const subParsed = parseM3U8Content(subText, chosen, subStatus);
        setupMediaPlaylist(subParsed);
      } else {
        setupMediaPlaylist(parsed);
      }
    } catch (err) {
      console.warn('Playlist load error, checking if direct stream:', err);
      if (err.message && (err.message.includes('Missing #EXTM3U tag') || err.message.includes('Server returned an HTML page') || err.message.includes('Invalid M3U8'))) {
        // Fallback to multi-threaded direct chunk download
        setupDirectChunkDownload(url, originalTitle);
        return;
      }
      setStatus('Failed to load playlist', false);
      updatePipelineStep('error', 'Load Failed');
      showNotice(`Failed to load or parse playlist: ${err.message}`, 'error', true);
    }
  }

  async function setupDirectChunkDownload(rawUrl, title) {
    isDirectStream = true;
    setStatus('Probing Media Stream...', true);
    hideNotice();

    const cleanUrl = cleanMediaUrl(rawUrl);
    let totalSize = parseInt(params.get('size'), 10) || 0;
    let detectedMime = '';

    // Check query params (e.g. YouTube videoplayback clen)
    try {
      const u = new URL(cleanUrl);
      const clen = u.searchParams.get('clen');
      if (clen && parseInt(clen, 10) > 65536) {
        totalSize = parseInt(clen, 10);
      }
      const mime = u.searchParams.get('mime');
      if (mime) detectedMime = mime;
    } catch {}

    // Background SW probe (bypasses CORS and gets accurate Content-Length / Range)
    if (!totalSize) {
      try {
        const probeRes = await new Promise(resolve => {
          chrome.runtime.sendMessage({ action: 'probeMedia', url: cleanUrl }, resolve);
        });
        if (probeRes && probeRes.success) {
          const probedSize = probeRes.totalSize || (probeRes.primary && probeRes.primary.totalSize) || 0;
          const probedMime = probeRes.mimeType || (probeRes.primary && probeRes.primary.mimeType) || '';
          if (probedSize > 65536) {
            totalSize = probedSize;
          }
          if (probedMime) {
            detectedMime = probedMime;
          }
        }
      } catch (e) {
        console.warn('Probe background check note:', e);
      }
    }

    // Determine extension based on type / mime
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
      // Split into 1MB chunks (or 512KB for small files)
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
      // Single continuous segment
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

    // Live stream banner
    if (isLiveStream) {
      liveBanner.classList.remove('hidden');
      setStatus('Live Stream Ready', false);
      showNotice('Live stream detected. Click "Record Live Stream" to begin capturing.', 'success');
      return;
    }

    setStatus('Stream Ready', false);
    startDownload();
  }

  // ---------------------------------------------------------------------------
  // 13. Event Listeners
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

  if (qualitySelect) {
    qualitySelect.addEventListener('change', async () => {
      const newUrl = qualitySelect.value;
      if (newUrl) {
        if (isDownloading) cancelDownload();
        const { text, status } = await fetchPlaylistText(newUrl);
        const parsed = parseM3U8Content(text, newUrl, status);
        setupMediaPlaylist(parsed);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 14. Init
  // ---------------------------------------------------------------------------
  function init() {
    applyRequestHeaders();

    urlDisplay.value = playlistUrl;
    streamTypeBadge.textContent = streamType.toUpperCase();

    const safeName = cleanFilename(originalTitle);
    filenameInput.value = safeName.replace(/\.(mp4|ts|m3u8|m4a|webm|mp3)$/i, '');
    const ext = requestedFormat === 'ts' ? 'ts' : (streamType === 'audio' ? 'm4a' : 'mp4');
    outputFormatSelect.value = ext;
    fileExtLabel.textContent = `.${ext}`;
    cachingFilename.textContent = `${filenameInput.value}.${ext}`;

    if (!playlistUrl) {
      showNotice('No media URL provided. Please open this page from the extension popup.', 'error');
      return;
    }

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

