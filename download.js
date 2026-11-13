/* ===================================================================
   Stream Video Downloader — Multi-Thread Downloader Engine (download.js)
   Handles HLS (.m3u8) & DASH (.mpd) stream parsing, concurrent multi-thread
   segment fetching, AES-128 decryption, live visual grid, and file saving.
   =================================================================== */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. State & Variables
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  let streamUrl = params.get('url') || '';
  let originalTitle = params.get('title') || 'video_download';
  let streamType = (params.get('type') || 'hls').toLowerCase();

  let concurrency = 8;
  let masterPlaylistData = null;
  let segmentsList = []; // Array of { url, duration, index, encryption }
  let downloadedBuffers = []; // Uint8Array or ArrayBuffer for each segment index
  let segmentStatus = []; // 'waiting' | 'active' | 'done' | 'error'
  let activeWorkers = 0;
  let nextSegmentIndex = 0;

  let isDownloading = false;
  let isPaused = false;
  let isCancelled = false;

  let totalBytes = 0;
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
  const filenameInput = document.getElementById('filename-input');
  const fileExtLabel = document.getElementById('file-ext-label');
  const urlDisplay = document.getElementById('url-display');
  const copyUrlBtn = document.getElementById('copy-url-btn');
  const streamTypeBadge = document.getElementById('stream-type-badge');
  const statusBadge = document.getElementById('status-badge');
  const qualitySection = document.getElementById('quality-section');
  const qualitySelect = document.getElementById('quality-select');
  const threadButtons = document.getElementById('thread-buttons');

  const progressBarFill = document.getElementById('progress-bar-fill');
  const percentLabel = document.getElementById('percent-label');
  const etaLabel = document.getElementById('eta-label');
  const liveSpeed = document.getElementById('live-speed');

  const metricSegments = document.getElementById('metric-segments');
  const metricSize = document.getElementById('metric-size');
  const metricSpeed = document.getElementById('metric-speed');
  const metricStatus = document.getElementById('metric-status');

  const startBtn = document.getElementById('start-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const saveBtn = document.getElementById('save-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const noticeBox = document.getElementById('notice-box');
  const segmentsGrid = document.getElementById('segments-grid');

  // ---------------------------------------------------------------------------
  // 3. Helpers
  // ---------------------------------------------------------------------------
  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function formatTime(seconds) {
    if (!seconds || !isFinite(seconds) || seconds < 0) return '--:--';
    const s = Math.floor(seconds);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function showNotice(msg, type = 'error') {
    noticeBox.textContent = msg;
    noticeBox.className = `notice-box ${type}`;
    noticeBox.classList.remove('hidden');
  }

  function hideNotice() {
    noticeBox.classList.add('hidden');
  }

  function setStatus(text, badgeClass) {
    metricStatus.textContent = text;
    statusBadge.textContent = text;
    statusBadge.className = `badge status-badge ${badgeClass}`;
  }

  function resolveUrl(relative, base) {
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  }

  // ---------------------------------------------------------------------------
  // 4. M3U8 Playlist Parser
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
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const attrs = lines[i].substring(lines[i].indexOf(':') + 1);
          const bandwidth = parseInt(parseAttr(attrs, 'BANDWIDTH'), 10) || 0;
          const resolution = parseAttr(attrs, 'RESOLUTION');
          let variantUrl = '';
          for (let j = i + 1; j < lines.length; j++) {
            if (!lines[j].startsWith('#')) {
              variantUrl = resolveUrl(lines[j], baseUrl);
              break;
            }
          }
          if (variantUrl) {
            variants.push({ bandwidth, resolution, url: variantUrl });
          }
        }
      }
      return { type: 'master', variants };
    }

    // Media playlist
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
          encryption: encryptionInfo ? { ...encryptionInfo } : null
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
      // Default IV is the sequence number as 16-byte big-endian
      ivBytes = new Uint8Array(16);
      const view = new DataView(ivBytes.buffer);
      view.setUint32(12, segmentIndex, false);
    }

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: ivBytes },
      cryptoKey,
      buffer
    );
    return decrypted;
  }

  // ---------------------------------------------------------------------------
  // 6. UI: Segment Matrix Grid
  // ---------------------------------------------------------------------------
  function buildSegmentGrid(count) {
    segmentsGrid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'seg-block';
      el.id = `seg-${i}`;
      el.title = `Segment ${i + 1}`;
      frag.appendChild(el);
    }
    segmentsGrid.appendChild(frag);
  }

  function updateSegmentBlock(index, status) {
    const el = document.getElementById(`seg-${index}`);
    if (!el) return;
    el.className = `seg-block ${status}`;
  }

  // ---------------------------------------------------------------------------
  // 7. Multi-threaded Download Engine
  // ---------------------------------------------------------------------------
  async function downloadSegmentWithRetry(seg, retries = 3) {
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (isCancelled) return null;
      try {
        const res = await fetch(seg.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let buf = await res.arrayBuffer();

        // Handle AES-128 Decryption if encrypted
        if (seg.encryption && seg.encryption.method === 'AES-128') {
          buf = await decryptSegment(buf, seg.encryption, seg.index);
        }

        return buf;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 600 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  }

  async function workerLoop() {
    while (!isCancelled && !isPaused && nextSegmentIndex < segmentsList.length) {
      const idx = nextSegmentIndex++;
      const seg = segmentsList[idx];

      segmentStatus[idx] = 'active';
      updateSegmentBlock(idx, 'active');

      try {
        const buf = await downloadSegmentWithRetry(seg);
        if (isCancelled) return;

        downloadedBuffers[idx] = buf;
        segmentStatus[idx] = 'done';
        updateSegmentBlock(idx, 'done');
        totalBytes += buf ? buf.byteLength : 0;
      } catch (err) {
        console.error(`Segment ${idx} failed:`, err);
        segmentStatus[idx] = 'error';
        updateSegmentBlock(idx, 'error');
      }

      updateProgress();
    }
  }

  function updateProgress() {
    const total = segmentsList.length;
    const completed = segmentStatus.filter(s => s === 'done').length;
    const percent = total > 0 ? (completed / total) * 100 : 0;

    progressBarFill.style.width = `${percent.toFixed(1)}%`;
    percentLabel.textContent = `${percent.toFixed(1)}%`;
    metricSegments.textContent = `${completed} / ${total}`;
    metricSize.textContent = formatBytes(totalBytes);

    // Calculate ETA
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed > 2 && currentSpeed > 0 && completed > 0) {
      const remainingSegments = total - completed;
      const avgBytesPerSeg = totalBytes / completed;
      const remainingBytes = remainingSegments * avgBytesPerSeg;
      const etaSeconds = remainingBytes / currentSpeed;
      etaLabel.textContent = `ETA: ${formatTime(etaSeconds)}`;
    }

    // Check completion
    if (completed === total && total > 0 && isDownloading) {
      finishDownload();
    }
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
        const speedFormatted = `${formatBytes(currentSpeed)}/s`;
        liveSpeed.textContent = speedFormatted;
        metricSpeed.textContent = speedFormatted;
        lastBytes = totalBytes;
        lastSpeedTime = now;
      }
    }, 1000);
  }

  function stopSpeedMonitor() {
    if (speedInterval) {
      clearInterval(speedInterval);
      speedInterval = null;
    }
    liveSpeed.textContent = '0.0 MB/s';
    metricSpeed.textContent = '0.0 MB/s';
  }

  // ---------------------------------------------------------------------------
  // 8. Lifecycle: Start, Pause, Resume, Save
  // ---------------------------------------------------------------------------
  async function loadManifestAndSetup() {
    try {
      setStatus('Loading playlist...', 'status-active');
      const text = await fetchPlaylist(streamUrl);
      const parsed = parseM3U8Content(text, streamUrl);

      if (parsed.type === 'master') {
        masterPlaylistData = parsed;
        qualitySection.classList.remove('hidden');
        qualitySelect.innerHTML = '';

        parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
        parsed.variants.forEach((v, i) => {
          const opt = document.createElement('option');
          opt.value = v.url;
          const res = v.resolution ? `${v.resolution}` : `Variant ${i + 1}`;
          const kbps = v.bandwidth ? ` (${Math.round(v.bandwidth / 1000)} kbps)` : '';
          opt.textContent = `${res}${kbps}`;
          qualitySelect.appendChild(opt);
        });

        // Load the highest quality variant by default
        streamUrl = parsed.variants[0].url;
        const subText = await fetchPlaylist(streamUrl);
        const subParsed = parseM3U8Content(subText, streamUrl);
        setupMediaSegments(subParsed.segments);
      } else {
        setupMediaSegments(parsed.segments);
      }

      setStatus('Ready', 'status-idle');
    } catch (err) {
      console.error('Failed to parse playlist:', err);
      showNotice(`Error loading stream: ${err.message}`, 'error');
      setStatus('Error', 'status-error');
    }
  }

  function setupMediaSegments(segments) {
    segmentsList = segments;
    downloadedBuffers = new Array(segments.length);
    segmentStatus = new Array(segments.length).fill('waiting');
    nextSegmentIndex = 0;
    totalBytes = 0;

    metricSegments.textContent = `0 / ${segments.length}`;
    buildSegmentGrid(segments.length);
  }

  async function startDownload() {
    if (segmentsList.length === 0) {
      showNotice('No segments loaded. Please check stream URL.', 'error');
      return;
    }

    isDownloading = true;
    isPaused = false;
    isCancelled = false;
    startTime = Date.now();

    hideNotice();
    setStatus('Downloading', 'status-active');

    startBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    cancelBtn.classList.remove('hidden');
    saveBtn.classList.add('hidden');

    startSpeedMonitor();

    // Spawn N workers for concurrent downloading
    const pool = [];
    for (let i = 0; i < concurrency; i++) {
      pool.push(workerLoop());
    }
    await Promise.all(pool);
  }

  function pauseDownload() {
    isPaused = true;
    stopSpeedMonitor();
    setStatus('Paused', 'status-paused');
    pauseBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
    startBtn.querySelector('span').textContent = 'Resume Download';
  }

  function cancelDownload() {
    isCancelled = true;
    isDownloading = false;
    stopSpeedMonitor();
    setStatus('Cancelled', 'status-error');

    pauseBtn.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
    startBtn.querySelector('span').textContent = 'Restart Download';
    nextSegmentIndex = 0;
  }

  async function finishDownload() {
    isDownloading = false;
    stopSpeedMonitor();
    setStatus('Finished', 'status-done');

    pauseBtn.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    saveBtn.classList.remove('hidden');
    startBtn.classList.add('hidden');

    etaLabel.textContent = 'Completed!';
    showNotice(`All ${segmentsList.length} segments downloaded (${formatBytes(totalBytes)}). Ready to save!`, 'success');

    // Auto-save
    saveVideoFile();
  }

  function saveVideoFile() {
    const validBuffers = downloadedBuffers.filter(Boolean);
    if (validBuffers.length === 0) {
      showNotice('No downloaded data to save.', 'error');
      return;
    }

    setStatus('Merging...', 'status-active');

    // Concatenate all ArrayBuffers
    const totalLen = validBuffers.reduce((acc, b) => acc + b.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const buf of validBuffers) {
      merged.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    const blob = new Blob([merged], { type: 'video/mp2t' });
    const blobUrl = URL.createObjectURL(blob);

    let cleanName = (filenameInput.value.trim() || originalTitle).replace(/[\\/:*?"<>|]/g, '_');
    const saveName = `${cleanName}.ts`;

    // Trigger standard browser download
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = saveName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    setStatus('Saved', 'status-done');
  }

  // ---------------------------------------------------------------------------
  // 9. Event Listeners
  // ---------------------------------------------------------------------------
  startBtn.addEventListener('click', () => {
    if (isPaused) {
      isPaused = false;
      setStatus('Downloading', 'status-active');
      startBtn.classList.add('hidden');
      pauseBtn.classList.remove('hidden');
      startSpeedMonitor();
      for (let i = 0; i < concurrency; i++) {
        workerLoop();
      }
    } else {
      startDownload();
    }
  });

  pauseBtn.addEventListener('click', pauseDownload);
  cancelBtn.addEventListener('click', cancelDownload);
  saveBtn.addEventListener('click', saveVideoFile);

  copyUrlBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(urlDisplay.value).then(() => {
      copyUrlBtn.style.color = '#3fb950';
      setTimeout(() => copyUrlBtn.style.color = '', 1500);
    });
  });

  qualitySelect.addEventListener('change', async () => {
    if (isDownloading) {
      alert('Please pause or cancel the current download before switching quality.');
      return;
    }
    streamUrl = qualitySelect.value;
    try {
      const text = await fetchPlaylist(streamUrl);
      const parsed = parseM3U8Content(text, streamUrl);
      setupMediaSegments(parsed.segments);
    } catch (err) {
      showNotice(`Error loading variant: ${err.message}`, 'error');
    }
  });

  // Thread selector buttons
  threadButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.thread-btn');
    if (!btn) return;
    document.querySelectorAll('.thread-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    concurrency = parseInt(btn.dataset.threads, 10) || 8;
  });

  // Warn if leaving page during active download
  window.addEventListener('beforeunload', (e) => {
    if (isDownloading && !isPaused) {
      e.preventDefault();
      e.returnValue = 'Download is in progress. Are you sure you want to leave?';
      return e.returnValue;
    }
  });

  // ---------------------------------------------------------------------------
  // 10. Initialization
  // ---------------------------------------------------------------------------
  function init() {
    urlDisplay.value = streamUrl;
    streamTypeBadge.textContent = streamType.toUpperCase();

    // Clean up filename
    let defaultName = originalTitle;
    try {
      const u = new URL(streamUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        defaultName = decodeURIComponent(parts[parts.length - 1]).replace(/\.m3u8$/i, '');
      }
    } catch {}
    filenameInput.value = defaultName;

    if (streamUrl) {
      loadManifestAndSetup();
    } else {
      showNotice('No stream URL provided. Please open this page from the extension popup.', 'error');
    }
  }

  init();
})();

