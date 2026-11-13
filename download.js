/* ===================================================================
   Stream Video Downloader — Multi-Thread Downloader Engine (download.js)
   CocoCut-Style Caching Downloader Tab:
   - Concurrent multi-threaded chunk downloading (1 to 16 threads)
   - Supports HLS (.m3u8), DASH, YouTube (videoplayback), and direct MP4/WebM
   - Real-time caching status, progress bar, speed meter, ETA, and segment matrix
   - Auto-save to Downloads folder when 100% complete
   =================================================================== */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. State & Query Parameters
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  let streamUrl = params.get('url') || '';
  let originalUrl = params.get('originalUrl') || streamUrl;
  let audioUrl = params.get('audioUrl') || '';
  let originalTitle = params.get('title') || 'video_download';
  let streamType = (params.get('type') || 'video').toLowerCase();
  let streamFormat = params.get('format') || 'mp4';

  let concurrency = 8;
  let segmentsList = []; // Array of { url, range, start, end, size, isAudio, index, encryption }
  let downloadedBuffers = [];
  let segmentStatus = []; // 'waiting' | 'active' | 'done' | 'error'
  let nextSegmentIndex = 0;
  let retryCount = 0;

  let isDownloading = false;
  let isPaused = false;
  let isCancelled = false;

  let totalBytes = 0;
  let expectedTotalBytes = 0;
  let isDynamicStreaming = false;
  let isStreamEofReached = false;
  let activeWorkers = 0;
  let startTime = 0;
  let speedInterval = null;
  let lastBytes = 0;
  let lastSpeedTime = 0;
  let currentSpeed = 0;

  // Crypto cache for AES-128
  const keyCache = new Map();

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
  const boostSpeedBtn = document.getElementById('boost-speed-btn');
  const turboBoostBtn = document.getElementById('turbo-boost-btn');
  const autoSaveToggle = document.getElementById('auto-save-toggle');

  const filenameInput = document.getElementById('filename-input');
  const fileExtLabel = document.getElementById('file-ext-label');
  const urlDisplay = document.getElementById('url-display');
  const copyUrlBtn = document.getElementById('copy-url-btn');
  const streamTypeBadge = document.getElementById('stream-type-badge');
  const qualitySection = document.getElementById('quality-section');
  const qualitySelect = document.getElementById('quality-select');
  const threadButtons = document.getElementById('thread-buttons');
  const segmentsGrid = document.getElementById('segments-grid');
  const noticeBox = document.getElementById('notice-box');

  function updatePipelineStep(step, text) {
    if (!pipelineStepBadge) return;
    pipelineStepBadge.className = `pipeline-badge step-${step}`;
    pipelineStepBadge.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // 3. Formatting Helpers
  // ---------------------------------------------------------------------------
  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '0.0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) {
      return (mb / 1024).toFixed(2) + ' GB';
    }
    return mb.toFixed(1) + ' MB';
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || isNaN(bytesPerSec) || bytesPerSec <= 0) return '0.0 KB/s';
    if (bytesPerSec >= 1048576) {
      return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
    }
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

  function showNotice(msg, type = 'error') {
    if (!noticeBox) return;
    noticeBox.textContent = msg;
    noticeBox.className = `notice-box ${type}`;
    noticeBox.classList.remove('hidden');
  }

  function hideNotice() {
    if (noticeBox) noticeBox.classList.add('hidden');
  }

  function setStatus(text, isSpinning = true) {
    if (cachingStatusLabel) {
      cachingStatusLabel.textContent = text;
    }
    const dot = document.querySelector('.caching-pulse-dot');
    if (dot) {
      dot.style.background = isSpinning ? '#00e676' : '#ffb300';
      dot.style.boxShadow = isSpinning ? '0 0 10px #00e676' : '0 0 10px #ffb300';
    }
  }

  function resolveUrl(relative, base) {
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  }

  // ---------------------------------------------------------------------------
  // 4. M3U8 Playlist Parsing
  // ---------------------------------------------------------------------------
  function parseAttr(str, name) {
    const match = str.match(new RegExp(`${name}=(?:"([^"]*)"|([^,\\s]*))`));
    return match ? (match[1] || match[2] || '') : '';
  }

  async function fetchPlaylist(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} when fetching manifest`);
    return await res.text();
  }

  function parseM3U8Content(text, baseUrl) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines[0] || !lines[0].startsWith('#EXTM3U')) {
      throw new Error('Not a valid M3U8 playlist (missing #EXTM3U)');
    }

    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

    if (isMaster) {
      const variants = [];
      const audioTracks = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')) {
          const attrs = line.substring(line.indexOf(':') + 1);
          const uri = parseAttr(attrs, 'URI');
          const groupId = parseAttr(attrs, 'GROUP-ID');
          if (uri) {
            audioTracks.push({ groupId, url: resolveUrl(uri, baseUrl) });
          }
        }

        if (line.startsWith('#EXT-X-STREAM-INF')) {
          const attrs = lines[i].substring(lines[i].indexOf(':') + 1);
          const bandwidth = parseInt(parseAttr(attrs, 'BANDWIDTH'), 10) || 0;
          const resolution = parseAttr(attrs, 'RESOLUTION');
          const audioGroup = parseAttr(attrs, 'AUDIO');
          let variantUrl = '';
          for (let j = i + 1; j < lines.length; j++) {
            if (!lines[j].startsWith('#')) {
              variantUrl = resolveUrl(lines[j], baseUrl);
              break;
            }
          }
          if (variantUrl) {
            variants.push({ bandwidth, resolution, audioGroup, url: variantUrl });
          }
        }
      }

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

    // Media playlist with segments
    const segments = [];
    let currentDuration = 0;
    let encryptionInfo = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-KEY')) {
        const attrs = line.substring(line.indexOf(':') + 1);
        encryptionInfo = {
          method: parseAttr(attrs, 'METHOD'),
          uri: resolveUrl(parseAttr(attrs, 'URI'), baseUrl),
          iv: parseAttr(attrs, 'IV')
        };
      } else if (line.startsWith('#EXTINF')) {
        const val = line.split(':')[1] || '0';
        currentDuration = parseFloat(val.split(',')[0]) || 0;
      } else if (!line.startsWith('#')) {
        segments.push({
          url: resolveUrl(line, baseUrl),
          duration: currentDuration,
          index: segments.length,
          encryption: encryptionInfo ? { ...encryptionInfo } : null,
          isAudio: false
        });
        currentDuration = 0;
      }
    }

    return { type: 'media', segments };
  }

  // ---------------------------------------------------------------------------
  // 5. AES-128 Decryption
  // ---------------------------------------------------------------------------
  async function getCryptoKey(uri) {
    if (keyCache.has(uri)) return keyCache.get(uri);
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`Failed to load AES encryption key: HTTP ${res.status}`);
    const keyData = await res.arrayBuffer();
    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );
    keyCache.set(uri, cryptoKey);
    return cryptoKey;
  }

  function hexToUint8Array(hex) {
    const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      bytes[i / 2] = parseInt(clean.substr(i, 2), 16);
    }
    return bytes;
  }

  async function decryptSegment(buffer, encryption, segmentIndex) {
    if (!encryption || encryption.method !== 'AES-128') return buffer;
    const cryptoKey = await getCryptoKey(encryption.uri);
    let ivBytes;
    if (encryption.iv) {
      ivBytes = hexToUint8Array(encryption.iv);
    } else {
      ivBytes = new Uint8Array(16);
      const view = new DataView(ivBytes.buffer);
      view.setUint32(12, segmentIndex, false);
    }

    return await window.crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: ivBytes },
      cryptoKey,
      buffer
    );
  }

  // ---------------------------------------------------------------------------
  // 6. UI: Segment Matrix
  // ---------------------------------------------------------------------------
  function buildSegmentGrid(count) {
    segmentsGrid.innerHTML = '';
    const frag = document.createDocumentFragment();
    const maxCells = Math.min(count, 400); // cap visual cells for performance
    for (let i = 0; i < maxCells; i++) {
      const el = document.createElement('div');
      el.className = 'seg-cell';
      el.id = `seg-${i}`;
      el.title = `Segment ${i + 1}`;
      frag.appendChild(el);
    }
    segmentsGrid.appendChild(frag);
  }

  function updateSegmentBlock(index, status) {
    if (index >= 400) return;
    const el = document.getElementById(`seg-${index}`);
    if (!el) return;
    el.className = `seg-cell ${status}`;
  }

  // ---------------------------------------------------------------------------
  // 7. Stream Setup (HLS vs Direct Chunked Ranges)
  // ---------------------------------------------------------------------------
  async function loadHlsManifestAndSetup() {
    setStatus('Loading Manifest...');
    try {
      const text = await fetchPlaylist(streamUrl);
      const parsed = parseM3U8Content(text, streamUrl);

      if (parsed.type === 'master') {
        qualitySection.classList.remove('hidden');
        qualitySelect.innerHTML = '';

        parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
        parsed.variants.forEach((v, i) => {
          const opt = document.createElement('option');
          opt.value = v.url;
          if (v.audioUrl) opt.dataset.audioUrl = v.audioUrl;
          const res = v.resolution ? `${v.resolution}` : `Variant ${i + 1}`;
          const kbps = v.bandwidth ? ` (${Math.round(v.bandwidth / 1000)} kbps)` : '';
          const aud = v.audioUrl ? ' + Audio' : '';
          opt.textContent = `${res}${kbps}${aud}`;
          qualitySelect.appendChild(opt);
        });

        const bestVariant = parsed.variants[0];
        streamUrl = bestVariant.url;
        const currentAudio = bestVariant.audioUrl || audioUrl;
        const subText = await fetchPlaylist(streamUrl);
        const subParsed = parseM3U8Content(subText, streamUrl);
        await setupMediaSegments(subParsed.segments, currentAudio);
      } else {
        await setupMediaSegments(parsed.segments, audioUrl);
      }

      setStatus('Caching');
      startDownload();
    } catch (err) {
      console.warn('M3U8 parse failed, fallback to direct chunk probe:', err);
      await setupDirectOrChunkedDownload(streamUrl, audioUrl, originalTitle);
    }
  }

  async function setupMediaSegments(segments, currentAudioUrl) {
    let allSegments = segments.map(s => ({ ...s, isAudio: false }));

    if (currentAudioUrl) {
      try {
        const aText = await fetchPlaylist(currentAudioUrl);
        const aParsed = parseM3U8Content(aText, currentAudioUrl);
        if (aParsed && aParsed.segments) {
          const audioSegs = aParsed.segments.map(s => ({ ...s, isAudio: true }));
          allSegments = allSegments.concat(audioSegs);
        }
      } catch (e) {
        console.warn('Could not load separate audio playlist:', e);
      }
    }

    segmentsList = allSegments.map((s, idx) => ({ ...s, index: idx }));
    downloadedBuffers = new Array(segmentsList.length);
    segmentStatus = new Array(segmentsList.length).fill('waiting');
    nextSegmentIndex = 0;
    totalBytes = 0;

    buildSegmentGrid(segmentsList.length);
  }

  function cleanStreamUrl(urlStr) {
    if (!urlStr) return '';
    try {
      const u = new URL(urlStr);
      u.searchParams.delete('range');
      u.searchParams.delete('rn');
      u.searchParams.delete('rbuf');
      u.searchParams.delete('start');
      u.searchParams.delete('end');
      return u.href;
    } catch {}
    return urlStr;
  }

  function isAudioStream(url, type, format) {
    const lower = (url || '').toLowerCase();
    const t = (type || '').toLowerCase();
    const f = (format || '').toLowerCase();
    return t === 'audio' ||
           f === 'm4a' || f === 'mp3' || f === 'aac' || f === 'wav' || f === 'ogg' ||
           lower.includes('mime=audio') || lower.includes('mime%2faudio') || lower.includes('mime%3aaudio') ||
           lower.includes('audio') || lower.endsWith('.mp3') || lower.endsWith('.m4a') || lower.endsWith('.aac');
  }

  function expandRemainingSegments(url, fullSize, startOffset, isAudio = false) {
    expectedTotalBytes = fullSize;
    isDynamicStreaming = false;
    const CHUNK_SIZE = fullSize <= 4 * 1048576 ? 524288 : 1048576;
    let offset = startOffset;
    const newSegs = [];

    while (offset < fullSize) {
      const end = Math.min(offset + CHUNK_SIZE - 1, fullSize - 1);
      const idx = segmentsList.length + newSegs.length;
      newSegs.push({
        url: url,
        range: `bytes=${offset}-${end}`,
        start: offset,
        end: end,
        size: end - offset + 1,
        isAudio: isAudio,
        index: idx
      });
      offset = end + 1;
    }

    if (newSegs.length > 0) {
      segmentsList = segmentsList.concat(newSegs);
      downloadedBuffers = downloadedBuffers.concat(new Array(newSegs.length));
      segmentStatus = segmentStatus.concat(new Array(newSegs.length).fill('waiting'));
      buildSegmentGrid(segmentsList.length);
      updatePipelineStep('downloading', `Step 1: Downloading Segments (${segmentsList.length})`);

      // Dispatch worker threads to download remaining segments in parallel
      for (let i = 0; i < concurrency; i++) {
        workerLoop();
      }
    }
  }

  function queueNextDynamicSegment(url, nextOffset, isAudio = false) {
    isDynamicStreaming = true;
    const CHUNK_SIZE = 1048576;
    const end = nextOffset + CHUNK_SIZE - 1;
    const idx = segmentsList.length;

    segmentsList.push({
      url: url,
      range: `bytes=${nextOffset}-${end}`,
      start: nextOffset,
      end: end,
      size: CHUNK_SIZE,
      isAudio: isAudio,
      isDynamicStream: true,
      index: idx
    });

    downloadedBuffers.push(null);
    segmentStatus.push('waiting');
    buildSegmentGrid(segmentsList.length);
    updatePipelineStep('downloading', `Step 1: Downloading Segments (${segmentsList.length})`);

    workerLoop();
  }

  async function setupDirectOrChunkedDownload(rawUrl, rawAudioUrl, title) {
    const cleanUrl = cleanStreamUrl(rawUrl);
    const cleanAudio = rawAudioUrl ? cleanStreamUrl(rawAudioUrl) : '';
    streamUrl = cleanUrl;
    audioUrl = cleanAudio;

    let isAudio = isAudioStream(cleanUrl, streamType, streamFormat);

    setStatus('Probing Stream Segments...');
    let totalSize = 0;
    let audioTotalSize = 0;

    // 1. Probe via background service worker (with <all_urls> permission, bypasses CORS)
    try {
      const probeRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'probeMedia', url: cleanUrl, audioUrl: cleanAudio },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.success) {
              resolve(null);
            } else {
              resolve(resp);
            }
          }
        );
      });

      if (probeRes) {
        if (probeRes.totalSize && probeRes.totalSize > 65536) {
          totalSize = probeRes.totalSize;
        }
        if (probeRes.audioTotalSize && probeRes.audioTotalSize > 65536) {
          audioTotalSize = probeRes.audioTotalSize;
        }
        if (probeRes.mimeType) {
          if (probeRes.mimeType.includes('audio')) {
            isAudio = true;
          }
        }
      }
    } catch (e) {
      console.warn('Background probe note:', e);
    }

    // 2. Check clen parameter in URL (YouTube video & audio streams)
    if (!totalSize) {
      try {
        const u = new URL(cleanUrl);
        const clen = u.searchParams.get('clen');
        if (clen && parseInt(clen, 10) > 65536) totalSize = parseInt(clen, 10);
      } catch {}
    }

    // 3. Check query param 'size' passed from detector
    if (!totalSize) {
      const pSize = params.get('size');
      if (pSize && parseInt(pSize, 10) > 65536) totalSize = parseInt(pSize, 10);
    }

    // 4. Local range probe
    if (!totalSize) {
      try {
        let probeUrl = cleanUrl;
        if (probeUrl.includes('googlevideo.com') || probeUrl.includes('videoplayback')) {
          const u = new URL(probeUrl);
          u.searchParams.set('range', '0-1');
          probeUrl = u.href;
        }
        const rangeRes = await fetch(probeUrl, { headers: { 'Range': 'bytes=0-1' } });
        const cr = rangeRes.headers.get('content-range');
        if (cr) {
          const m = cr.match(/\/(\d+)$/);
          if (m && parseInt(m[1], 10) > 65536) totalSize = parseInt(m[1], 10);
        }
        if (!totalSize) {
          const cl = rangeRes.headers.get('content-length');
          if (cl && parseInt(cl, 10) > 65536) totalSize = parseInt(cl, 10);
        }
      } catch (e) {
        console.warn('Range probe note:', e);
      }
    }

    // 5. Try HEAD request
    if (!totalSize) {
      try {
        const headRes = await fetch(cleanUrl, { method: 'HEAD' });
        const cl = headRes.headers.get('content-length');
        if (cl && parseInt(cl, 10) > 65536) totalSize = parseInt(cl, 10);
      } catch (e) {}
    }

    expectedTotalBytes = totalSize || 0;
    // For smaller media like songs (<= 4MB), use 512KB chunks; for larger videos use 1MB chunks
    const CHUNK_SIZE = (totalSize && totalSize <= 4 * 1048576) ? 524288 : 1048576;
    let segs = [];

    if (totalSize && totalSize > 65536) {
      isDynamicStreaming = false;
      let offset = 0;
      while (offset < totalSize) {
        const end = Math.min(offset + CHUNK_SIZE - 1, totalSize - 1);
        segs.push({
          url: cleanUrl,
          range: `bytes=${offset}-${end}`,
          start: offset,
          end: end,
          size: end - offset + 1,
          isAudio: isAudio
        });
        offset = end + 1;
      }
    } else {
      // Dynamic chunk probing: start with initial chunk.
      // Dynamic streaming continues fetching chunk by chunk until EOF.
      isDynamicStreaming = true;
      isStreamEofReached = false;
      segs.push({
        url: cleanUrl,
        range: `bytes=0-${CHUNK_SIZE - 1}`,
        start: 0,
        end: CHUNK_SIZE - 1,
        size: CHUNK_SIZE,
        isAudio: isAudio,
        isDynamicProbe: true,
        isDynamicStream: true
      });
    }

    // Separate audio stream chunks (for YouTube video + audio)
    if (cleanAudio && cleanAudio !== cleanUrl && !isAudio) {
      if (!audioTotalSize) {
        try {
          const au = new URL(cleanAudio);
          const aClen = au.searchParams.get('clen');
          if (aClen && parseInt(aClen, 10) > 65536) audioTotalSize = parseInt(aClen, 10);
        } catch {}
      }

      if (!audioTotalSize) {
        try {
          const aRangeRes = await fetch(cleanAudio, { headers: { 'Range': 'bytes=0-1' } });
          const cr = aRangeRes.headers.get('content-range');
          if (cr) {
            const m = cr.match(/\/(\d+)$/);
            if (m && parseInt(m[1], 10) > 65536) audioTotalSize = parseInt(m[1], 10);
          }
        } catch {}
      }

      if (audioTotalSize && audioTotalSize > 0) {
        expectedTotalBytes += audioTotalSize;
        let aOffset = 0;
        while (aOffset < audioTotalSize) {
          const aEnd = Math.min(aOffset + CHUNK_SIZE - 1, audioTotalSize - 1);
          segs.push({
            url: cleanAudio,
            range: `bytes=${aOffset}-${aEnd}`,
            start: aOffset,
            end: aEnd,
            size: aEnd - aOffset + 1,
            isAudio: true
          });
          aOffset = aEnd + 1;
        }
      }
    }

    segmentsList = segs.map((s, idx) => ({ ...s, index: idx }));
    downloadedBuffers = new Array(segmentsList.length);
    segmentStatus = new Array(segmentsList.length).fill('waiting');
    nextSegmentIndex = 0;
    totalBytes = 0;

    buildSegmentGrid(segmentsList.length);
    setStatus('Downloading Segments...');
    startDownload();
  }

  // ---------------------------------------------------------------------------
  // 8. Multi-Threaded Segment Downloader
  // ---------------------------------------------------------------------------
  async function downloadSegmentWithRetry(seg, retries = 3) {
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (isCancelled) return null;
      try {
        const fetchOptions = {};
        if (seg.range) {
          fetchOptions.headers = { 'Range': seg.range };
        }
        let fetchUrl = cleanStreamUrl(seg.url);

        // If YouTube / googlevideo videoplayback, range MUST be specified in query params
        if (seg.start !== undefined && seg.end !== undefined) {
          try {
            const u = new URL(fetchUrl);
            if (u.hostname.includes('googlevideo.com') || u.pathname.includes('videoplayback')) {
              u.searchParams.set('range', `${seg.start}-${seg.end}`);
              fetchUrl = u.href;
            }
          } catch {}
        }

        const res = await fetch(fetchUrl, fetchOptions);

        // If EOF reached on dynamic range
        if (res.status === 416) {
          return new ArrayBuffer(0);
        }

        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status}`);
        }

        // On dynamic probe, check Content-Range to expand all remaining segments
        if (seg.isDynamicProbe) {
          const cr = res.headers.get('content-range');
          if (cr) {
            const m = cr.match(/\/(\d+)$/);
            if (m) {
              const fullSize = parseInt(m[1], 10);
              if (fullSize > seg.size) {
                expandRemainingSegments(seg.url, fullSize, seg.size, seg.isAudio);
              }
            }
          }
        }

        let buf = await res.arrayBuffer();

        if (seg.encryption && seg.encryption.method === 'AES-128') {
          buf = await decryptSegment(buf, seg.encryption, seg.index);
        }

        return buf;
      } catch (err) {
        lastErr = err;
        retryCount++;
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  }

  function checkCompletion() {
    if (!isDownloading || isCancelled || isPaused) return;

    const total = segmentsList.length;
    const completed = segmentStatus.filter(s => s === 'done').length;

    // If dynamic stream is active, do not finish while workers are still running
    if (isDynamicStreaming && !isStreamEofReached) {
      return;
    }

    // Safety check: a song or video file is NEVER less than 100 KB unless EOF was verified.
    // If it stopped at 6.4 KB, it only fetched the init header chunk!
    if (totalBytes < 100000 && !isStreamEofReached) {
      if (!isCancelled && !isPaused && segmentsList.length > 0) {
        const lastSeg = segmentsList[segmentsList.length - 1];
        const lastBufLen = downloadedBuffers[lastSeg.index]?.byteLength || 0;
        const nextStart = lastSeg.start + lastBufLen;
        console.warn('File size < 100KB, queueing continuation chunk from byte:', nextStart);
        isDynamicStreaming = true;
        queueNextDynamicSegment(streamUrl, nextStart, isAudioStream(streamUrl, streamType, streamFormat));
        return;
      }
    }

    if (completed === total && total > 0 && activeWorkers === 0) {
      finishDownload();
    }
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

          // If EOF reached on dynamic chunk
          if (buf && buf.byteLength === 0 && seg.isDynamicStream) {
            isStreamEofReached = true;
            isDynamicStreaming = false;
            segmentStatus[idx] = 'done';
            updateSegmentBlock(idx, 'done');
            updateProgress();
            continue;
          }

          downloadedBuffers[idx] = buf;
          segmentStatus[idx] = 'done';
          updateSegmentBlock(idx, 'done');
          const chunkLen = buf ? buf.byteLength : 0;
          totalBytes += chunkLen;

          // If dynamic stream without known total size, keep queueing next segment as long as chunks return data
          if (seg.isDynamicStream && isDynamicStreaming && !isStreamEofReached) {
            if (chunkLen > 0) {
              const nextStart = seg.start + chunkLen;
              queueNextDynamicSegment(seg.url, nextStart, seg.isAudio);
            } else {
              isStreamEofReached = true;
              isDynamicStreaming = false;
            }
          }
        } catch (err) {
          console.error(`Segment ${idx} failed:`, err);
          segmentStatus[idx] = 'error';
          updateSegmentBlock(idx, 'error');
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

    let percent = total > 0 ? (completed / total) * 100 : 0;
    if (expectedTotalBytes > 0 && totalBytes > 0) {
      percent = Math.min((totalBytes / expectedTotalBytes) * 100, 100);
    }

    progressBarFill.style.width = `${percent.toFixed(1)}%`;
    progressBarBuffered.style.width = `${Math.min(percent + 8, 100).toFixed(1)}%`;

    // Time left calculation
    let timeLeftStr = '00:00:00';
    if (currentSpeed > 0 && expectedTotalBytes > totalBytes) {
      const remainingBytes = expectedTotalBytes - totalBytes;
      const etaSeconds = remainingBytes / currentSpeed;
      timeLeftStr = formatTime(etaSeconds);
    } else if (currentSpeed > 0 && completed > 0 && total > completed) {
      const avgBytesPerSeg = totalBytes / completed;
      const remainingBytes = (total - completed) * avgBytesPerSeg;
      const etaSeconds = remainingBytes / currentSpeed;
      timeLeftStr = formatTime(etaSeconds);
    }

    // Explicit segment count and progress display
    cachingStats.textContent = `Segments: ${completed} / ${total} (${percent.toFixed(1)}%), Size: ${formatBytes(totalBytes)}, Speed: ${formatSpeed(currentSpeed)}, Time left: ${timeLeftStr}, Retries: ${retryCount}, Threads: ${concurrency}`;

    checkCompletion();
  }

  function startSpeedMonitor() {
    lastBytes = totalBytes;
    lastSpeedTime = Date.now();
    speedInterval = setInterval(() => {
      const now = Date.now();
      const timeDiff = (now - lastSpeedTime) / 1000;
      if (timeDiff > 0) {
        const bytesDiff = totalBytes - lastBytes;
        currentSpeed = bytesDiff / timeDiff;
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

  async function startDownload() {
    if (segmentsList.length === 0) return;

    isDownloading = true;
    isPaused = false;
    isCancelled = false;
    startTime = Date.now();

    hideNotice();
    setStatus('Downloading Segments...', true);
    updatePipelineStep('downloading', `Step 1: Downloading Segments (${segmentsList.length})`);
    startSpeedMonitor();

    const pool = [];
    for (let i = 0; i < concurrency; i++) {
      pool.push(workerLoop());
    }
    await Promise.all(pool);
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
    stopSpeedMonitor();
    setStatus('Stopped', false);
    showNotice('Segment downloading cancelled by user.', 'error');
  }

  async function finishDownload() {
    isDownloading = false;
    stopSpeedMonitor();

    // 1. All segments finished downloading
    progressBarFill.style.width = '100%';
    progressBarBuffered.style.width = '100%';
    setStatus('All Segments Downloaded! Merging...', true);
    updatePipelineStep('merging', 'Step 2: Merging Segments');

    cachingStats.textContent = `All ${segmentsList.length} segments downloaded (${formatBytes(totalBytes)}). Merging all segments into single file...`;
    showNotice(`All ${segmentsList.length} segments downloaded! Merging all segments into actual file...`, 'success');

    // Give visual indication of merging phase
    await new Promise(r => setTimeout(r, 600));

    // 2. Merge all segments & download the actual video/song file
    await mergeAndDownloadActualVideo();
  }

  async function mergeAndDownloadActualVideo() {
    setStatus('Merging All Segments...', true);
    updatePipelineStep('merging', 'Step 2: Merging Segments');

    const validVideoBuffers = [];
    const validAudioBuffers = [];

    segmentsList.forEach((seg, idx) => {
      const buf = downloadedBuffers[idx];
      if (!buf || buf.byteLength === 0) return;
      if (seg.isAudio) {
        validAudioBuffers.push(buf);
      } else {
        validVideoBuffers.push(buf);
      }
    });

    if (validVideoBuffers.length === 0 && validAudioBuffers.length === 0) {
      showNotice('No downloaded segment data to merge.', 'error');
      return;
    }

    const isAudio = isAudioStream(streamUrl, streamType, streamFormat);

    cachingStats.textContent = isAudio ?
      `Merging ${validAudioBuffers.length || validVideoBuffers.length} audio segments into complete song...` :
      `Merging ${validVideoBuffers.length} video segments + ${validAudioBuffers.length} audio segments into final video...`;
    await new Promise(r => setTimeout(r, 400));

    let finalBlob;
    let ext = 'mp4';
    let mimeType = 'video/mp4';

    if (isAudio) {
      ext = streamFormat === 'mp3' ? 'mp3' : (streamUrl.includes('webm') || streamFormat === 'webm' ? 'webm' : 'm4a');
      mimeType = ext === 'mp3' ? 'audio/mpeg' : (ext === 'webm' ? 'audio/webm' : 'audio/mp4');
      const allBufs = validAudioBuffers.concat(validVideoBuffers);
      finalBlob = new Blob(allBufs, { type: mimeType });
    } else if (streamType === 'hls' || streamType === 'm3u8' || streamType === 'ts') {
      const mergedList = [];
      const maxLen = Math.max(validVideoBuffers.length, validAudioBuffers.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < validVideoBuffers.length) mergedList.push(validVideoBuffers[i]);
        if (i < validAudioBuffers.length) mergedList.push(validAudioBuffers[i]);
      }
      const totalLen = mergedList.reduce((acc, b) => acc + b.byteLength, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const buf of mergedList) {
        merged.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
      }
      finalBlob = new Blob([merged], { type: 'video/mp4' });
      ext = 'mp4';
    } else {
      const allBufs = validVideoBuffers.concat(validAudioBuffers);
      const isWebm = streamUrl.includes('webm') || streamType === 'webm' || streamFormat === 'webm';
      ext = isWebm ? 'webm' : 'mp4';
      finalBlob = new Blob(allBufs, { type: isWebm ? 'video/webm' : 'video/mp4' });
    }

    // 3. Merging complete -> Download actual song / video!
    setStatus('Merged & Downloading!', false);
    updatePipelineStep('completed', 'Step 3: Actual File Downloaded');

    let cleanName = (filenameInput.value.trim() || originalTitle).replace(/[\\/:*?"<>|]/g, '_');
    if (isAudio && cleanName.endsWith('.mp4')) {
      cleanName = cleanName.slice(0, -4);
    }
    if (!cleanName.endsWith(`.${ext}`)) {
      cleanName = `${cleanName}.${ext}`;
    }

    // Trigger browser download of actual merged file
    const blobUrl = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = cleanName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);

    const typeDesc = isAudio ? 'Song / Audio' : 'Video';
    cachingStats.textContent = `✅ Merged ${segmentsList.length} segments successfully! Actual ${typeDesc.toLowerCase()} downloaded: ${cleanName} (${formatBytes(finalBlob.size)})`;
    showNotice(`🎉 Actual ${typeDesc.toLowerCase()} downloaded successfully: ${cleanName} (${formatBytes(finalBlob.size)})`, 'success');
  }

  // ---------------------------------------------------------------------------
  // 9. Event Listeners & Turbo Boost
  // ---------------------------------------------------------------------------
  function enableTurbo() {
    concurrency = 16;
    document.querySelectorAll('.thread-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.threads === '16');
    });
    if (isDownloading && !isPaused) {
      for (let i = 0; i < 8; i++) {
        workerLoop();
      }
    }
    showNotice('Turbo Boost Activated: 16 concurrent threads caching at maximum speed!', 'success');
  }

  if (turboBoostBtn) turboBoostBtn.addEventListener('click', enableTurbo);
  if (boostSpeedBtn) boostSpeedBtn.addEventListener('click', enableTurbo);

  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      if (isPaused) {
        resumeDownload();
      } else {
        pauseDownload();
      }
    });
  }

  if (cancelBtn) cancelBtn.addEventListener('click', cancelDownload);
  if (saveBtn) saveBtn.addEventListener('click', mergeAndDownloadActualVideo);

  if (threadButtons) {
    threadButtons.addEventListener('click', (e) => {
      const btn = e.target.closest('.thread-btn');
      if (!btn) return;
      document.querySelectorAll('.thread-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      concurrency = parseInt(btn.dataset.threads, 10) || 8;
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
      const selOpt = qualitySelect.selectedOptions ? qualitySelect.selectedOptions[0] : null;
      const newAudio = selOpt && selOpt.dataset.audioUrl ? selOpt.dataset.audioUrl : audioUrl;
      if (newUrl) {
        streamUrl = newUrl;
        const subText = await fetchPlaylist(streamUrl);
        const subParsed = parseM3U8Content(subText, streamUrl);
        await setupMediaSegments(subParsed.segments, newAudio);
        startDownload();
      }
    });
  }

  window.addEventListener('beforeunload', (e) => {
    if (isDownloading && !isPaused) {
      e.preventDefault();
      e.returnValue = 'Caching is in progress. Are you sure you want to leave?';
      return e.returnValue;
    }
  });

  // ---------------------------------------------------------------------------
  // 10. Initialization
  // ---------------------------------------------------------------------------
  function init() {
    urlDisplay.value = streamUrl;
    streamTypeBadge.textContent = streamType.toUpperCase();

    let safeName = originalTitle.replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!safeName || safeName === 'videoplayback' || safeName.startsWith('videoplayback')) {
      safeName = 'video_download';
    }

    const isAudio = isAudioStream(streamUrl, streamType, streamFormat);
    const defaultExt = isAudio ? (streamFormat === 'mp3' ? 'mp3' : 'm4a') : 'mp4';
    if (fileExtLabel) fileExtLabel.textContent = `.${defaultExt}`;
    if (!safeName.endsWith(`.${defaultExt}`) && !safeName.endsWith('.mp4') && !safeName.endsWith('.m4a') && !safeName.endsWith('.mp3')) {
      cachingFilename.textContent = `${safeName}.${defaultExt}`;
    } else {
      cachingFilename.textContent = safeName;
    }
    filenameInput.value = safeName.replace(/\.(mp4|m4a|mp3|webm|mkv|ts)$/i, '');

    if (!streamUrl) {
      showNotice('No stream URL provided. Please open this page from the extension popup.', 'error');
      return;
    }

    const lower = streamUrl.toLowerCase();
    const isHls = lower.includes('.m3u8') || streamType === 'hls';

    if (isHls) {
      loadHlsManifestAndSetup();
    } else {
      setupDirectOrChunkedDownload(streamUrl, audioUrl, safeName);
    }
  }

  init();
})();
