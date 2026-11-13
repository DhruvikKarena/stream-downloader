/* ===== Stream Video Downloader — Popup Script ===== */

(function () {
  'use strict';

  // DOM references
  const mediaListEl = document.getElementById('media-list');
  const emptyStateEl = document.getElementById('empty-state');
  const mediaCountEl = document.getElementById('media-count');
  const refreshBtn = document.getElementById('refresh-btn');
  const openDownloaderBtn = document.getElementById('open-downloader-btn');
  const settingsBtn = document.getElementById('settings-btn');

  // Helper DOM references
  const helperDot = document.getElementById('helper-status-dot');
  const helperText = document.getElementById('helper-status-text');
  const checkHelperBtn = document.getElementById('check-helper-btn');
  const helperGuideBanner = document.getElementById('helper-guide-banner');
  const closeHelperGuide = document.getElementById('close-helper-guide');
  const extIdDisplay = document.getElementById('ext-id-display');
  const copyExtIdBtn = document.getElementById('copy-ext-id-btn');

  let helperState = { checked: false, installed: false, data: null };

  // Track active downloads keyed by URL so we can update progress
  const activeDownloads = new Map();

  // ───────── Helpers ─────────

  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes) || bytes < 0) return '';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return value.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function formatSpeed(bytesPerSec) {
    if (bytesPerSec == null || isNaN(bytesPerSec) || bytesPerSec <= 0) return '';
    return formatBytes(bytesPerSec) + '/s';
  }

  function extractFilename(url) {
    if (!url) return 'video_download.mp4';
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const segments = path.split('/').filter(Boolean);
      if (segments.length > 0) {
        const last = decodeURIComponent(segments[segments.length - 1]);
        const cleaned = last.split('?')[0];
        if (cleaned && cleaned.length > 0 && cleaned !== '/' && !cleaned.startsWith('videoplayback')) {
          return cleaned.length > 60 ? cleaned.substring(0, 57) + '...' : cleaned;
        }
      }
      if (parsed.pathname.includes('videoplayback')) {
        return 'video_download.mp4';
      }
      const fallback = parsed.hostname + parsed.pathname;
      return fallback.length > 55 ? fallback.substring(0, 52) + '...' : fallback;
    } catch {
      return url.length > 55 ? url.substring(0, 52) + '...' : url;
    }
  }

  function getSafeFilename(item) {
    if (!item) return 'video_download.mp4';
    let name = item.filename;
    if (!name || name === 'videoplayback' || name.startsWith('videoplayback') || name === 'Unknown file' || name === 'media' || !name.includes('.')) {
      const ext = item.format ? `.${item.format}` : (item.type === 'audio' ? '.m4a' : '.mp4');
      const tag = item.resolution || item.quality || (item.type === 'audio' ? 'Audio' : 'Video');
      const cleanTitle = (item.title || 'video').replace(/[\\/:*?"<>|]/g, '_').trim();
      name = `${cleanTitle || 'video'} [${tag}]${ext}`;
    }
    return name.replace(/[\\/:*?"<>|]/g, '_').trim();
  }

  function getMediaTypeLabel(item) {
    if (!item) return 'OTHER';
    const type = (typeof item === 'string' ? item : item.type || '').toLowerCase();
    const hasAudio = typeof item === 'object' ? item.hasAudio : true;
    const isYt = item && typeof item === 'object' && item.url && (item.url.includes('googlevideo.com') || item.url.includes('videoplayback'));

    if (type === 'hls' || type === 'm3u8') return 'HLS STREAM';
    if (type === 'dash' || type === 'mpd') return 'DASH STREAM';
    if (type === 'video') {
      if (isYt || !hasAudio) return 'VIDEO STREAM';
      return hasAudio ? 'VIDEO + AUDIO' : 'VIDEO ONLY';
    }
    if (type === 'audio') return 'AUDIO ONLY';
    if (type === 'mp4' || type === 'webm' || type === 'mkv' || type === 'avi' || type === 'mov') {
      return hasAudio ? `${type.toUpperCase()} + AUDIO` : `${type.toUpperCase()} ONLY`;
    }
    return type.toUpperCase();
  }

  function getMediaBadgeClass(item) {
    const type = (typeof item === 'string' ? item : item.type || '').toLowerCase();
    const hasAudio = typeof item === 'object' ? item.hasAudio : true;

    if (type === 'hls' || type === 'm3u8') return 'hls';
    if (type === 'dash' || type === 'mpd') return 'dash';
    if (type === 'audio') return 'audio';
    if (type === 'video' || type === 'mp4' || type === 'webm') {
      return hasAudio ? 'video-audio' : 'mp4';
    }
    return 'other';
  }

  function getMediaTypeBadge(item) {
    const label = getMediaTypeLabel(item);
    const cls = getMediaBadgeClass(item);
    return `<span class="type-badge ${cls}">${label}</span>`;
  }

  function createSvg(name) {
    const svgs = {
      download: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      retry: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
    };
    return svgs[name] || '';
  }

  // ───────── Render ─────────

  function renderMediaList(mediaItems) {
    mediaListEl.innerHTML = '';
    const items = Array.isArray(mediaItems) ? mediaItems : [];
    window._svd_mediaItems = items;

    mediaCountEl.textContent = items.length;

    if (items.length === 0) {
      emptyStateEl.style.display = 'flex';
      return;
    }

    emptyStateEl.style.display = 'none';

    items.forEach(function (item, index) {
      const card = document.createElement('div');
      card.className = 'media-card';
      card.dataset.url = item.url;
      card.dataset.index = index;

      const filename = item.filename || extractFilename(item.url);
      const sizeStr = item.size ? formatBytes(item.size) : '';

      // Build details line
      let detailsHTML = '';
      if (item.resolution) {
        detailsHTML += `<span class="media-size" style="color:#58a6ff; font-weight:600;">${escapeHtml(item.resolution)}</span>`;
        detailsHTML += '<span class="detail-separator"></span>';
      }
      if (sizeStr) {
        detailsHTML += `<span class="media-size">${sizeStr}</span>`;
        detailsHTML += '<span class="detail-separator"></span>';
      }
      detailsHTML += `<span class="media-url" title="${escapeHtml(item.url)}">${escapeHtml(truncateUrl(item.url))}</span>`;

      if (item.referer) {
        detailsHTML += '<span class="detail-separator"></span>';
        detailsHTML += `<span class="media-url" style="color:#81c784;" title="Page / Player Referer: ${escapeHtml(item.referer)}">Ref: ${escapeHtml(truncateUrl(item.referer))}</span>`;
      }

      const type = (item.type || '').toLowerCase();
      const isDash = type === 'dash' || type === 'mpd';

      card.innerHTML = `
        <div class="media-card-top">
          ${getMediaTypeBadge(item)}
          <div class="media-card-info">
            <div class="media-filename" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
            <div class="media-details">${detailsHTML}</div>
          </div>
          <div class="media-card-actions">
            <button class="native-dl-btn" data-index="${index}" title="Download via Native Helper (yt-dlp + ffmpeg to ~/Downloads)">
              ⚡ Native
            </button>
            <button class="download-btn browser-dl-btn" data-index="${index}" ${isDash ? 'disabled style="opacity:0.4; cursor:not-allowed;" title="DASH (.mpd) requires Native Helper (yt-dlp + ffmpeg)"' : 'title="Download via In-Browser Downloader (parallel segments, AES-128, disk streaming)"'}>
              ${createSvg('download')}
              <span>${isDash ? 'N/A' : 'Browser'}</span>
            </button>
          </div>
        </div>
      `;

      // Quality selector for HLS / DASH
      if (type === 'hls' || type === 'm3u8') {
        const qualityRow = document.createElement('div');
        qualityRow.className = 'quality-row';
        qualityRow.innerHTML = `
          <span class="quality-label">Quality:</span>
          <span class="quality-loading">Loading streams...</span>
        `;
        card.appendChild(qualityRow);
        loadHLSQualities(item.url, qualityRow, index);
      } else if (isDash) {
        const qualityRow = document.createElement('div');
        qualityRow.className = 'quality-row';
        qualityRow.innerHTML = `
          <span class="quality-label">DASH:</span>
          <span class="quality-loading">Inspecting MPD manifest...</span>
        `;
        card.appendChild(qualityRow);
        loadDASHQualities(item.url, qualityRow, index);
      }

      // Progress / status area
      const statusArea = document.createElement('div');
      statusArea.className = 'status-area hidden';
      statusArea.id = `status-${index}`;
      card.appendChild(statusArea);

      // Attach download click handlers
      const nativeBtn = card.querySelector('.native-dl-btn');
      if (nativeBtn) {
        nativeBtn.addEventListener('click', function () {
          handleNativeDownload(item, index, card);
        });
      }

      const browserBtn = card.querySelector('.browser-dl-btn');
      if (browserBtn && !isDash) {
        browserBtn.addEventListener('click', function () {
          handleDownload(item, index, card);
        });
      }

      mediaListEl.appendChild(card);
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text || ''));
    return div.innerHTML;
  }

  function truncateUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      const display = u.hostname + u.pathname;
      return display.length > 50 ? display.substring(0, 47) + '...' : display;
    } catch {
      return url.length > 50 ? url.substring(0, 47) + '...' : url;
    }
  }

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds) || seconds <= 0) return '00:00';
    const s = Math.floor(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // ───────── HLS Quality & Media Info Loading ─────────

  function loadHLSQualities(url, qualityRow, index) {
    chrome.runtime.sendMessage({ action: 'parseM3U8', url: url }, function (response) {
      qualityRow.innerHTML = '';

      const parsed = response && response.success ? response.data : null;
      if (chrome.runtime.lastError || !parsed) {
        qualityRow.innerHTML = `
          <span class="quality-label">Stream:</span>
          <span class="quality-info">Standard Playlist</span>
        `;
        return;
      }

      // Check DRM
      if (parsed.isDrmProtected) {
        qualityRow.innerHTML = `
          <div class="drm-warning-pill" title="DRM-protected, can't be downloaded">
            🔒 DRM-protected, can't be downloaded
          </div>
        `;
        const card = qualityRow.closest('.media-card');
        if (card) {
          card.querySelectorAll('button').forEach(btn => {
            btn.disabled = true;
            btn.title = "DRM-protected, can't be downloaded";
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
          });
        }
        return;
      }

      // 1. Master Playlist with #EXT-X-STREAM-INF variants -> Quality Picker
      if (parsed.type === 'master' && Array.isArray(parsed.variants) && parsed.variants.length > 0) {
        const label = document.createElement('span');
        label.className = 'quality-label';
        label.textContent = 'Quality:';

        const select = document.createElement('select');
        select.className = 'quality-select';
        select.dataset.index = index;

        // Sort variants by bandwidth descending
        const sorted = parsed.variants.slice().sort(function (a, b) {
          return (b.bandwidth || 0) - (a.bandwidth || 0);
        });

        sorted.forEach(function (stream, i) {
          const opt = document.createElement('option');
          opt.value = stream.url || '';
          if (stream.audioUrl) {
            opt.dataset.audioUrl = stream.audioUrl;
          }

          let text = '';
          if (stream.resolution) {
            const parts = stream.resolution.split('x');
            const height = parts.length === 2 ? parts[1] : stream.resolution;
            text = height + 'p';
          } else {
            text = 'Stream ' + (i + 1);
          }
          if (stream.bandwidth) {
            const kbps = Math.round(stream.bandwidth / 1000);
            text += ' \u2014 ' + kbps + ' kbps';
          }
          if (stream.audioUrl) {
            text += ' (with Audio)';
          }
          opt.textContent = text;
          if (i === 0) opt.selected = true;
          select.appendChild(opt);
        });

        qualityRow.appendChild(label);
        qualityRow.appendChild(select);
        return;
      }

      // 2. Media Playlist with segments -> Show Segment Count & Total Duration (sum of #EXTINF)
      if (parsed.type === 'media' && Array.isArray(parsed.segments)) {
        const segCount = parsed.segments.length;
        const durStr = formatDuration(parsed.totalDuration);
        const liveLabel = parsed.hasEndList ? '' : ' <span class="live-tag">LIVE</span>';

        qualityRow.innerHTML = `
          <div class="media-playlist-stats">
            <span class="stat-pill"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg> ${segCount} segments</span>
            <span class="stat-pill"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${durStr}</span>
            ${liveLabel}
          </div>
        `;
        return;
      }

      qualityRow.innerHTML = `
        <span class="quality-label">Quality:</span>
        <select class="quality-select" data-index="${index}">
          <option value="">Default</option>
        </select>
      `;
    });
  }

  function loadDASHQualities(url, qualityRow, index) {
    chrome.runtime.sendMessage({ action: 'parseMPD', url: url }, function (response) {
      qualityRow.innerHTML = '';

      if (response && !response.success && response.error) {
        qualityRow.innerHTML = `
          <span class="quality-label" style="color:#f44336;">Error:</span>
          <span class="quality-info" style="color:#f44336;" title="${escapeHtml(response.error)}">${escapeHtml(response.error.slice(0, 80))}...</span>
        `;
        return;
      }

      const parsed = response && response.success ? response.data : null;
      if (parsed && parsed.isDrmProtected) {
        qualityRow.innerHTML = `
          <div class="drm-warning-pill" title="DRM-protected, can't be downloaded">
            🔒 DRM-protected, can't be downloaded
          </div>
        `;
        const card = qualityRow.closest('.media-card');
        if (card) {
          card.querySelectorAll('button').forEach(btn => {
            btn.disabled = true;
            btn.title = "DRM-protected, can't be downloaded";
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
          });
        }
        return;
      }

      qualityRow.innerHTML = `
        <span class="quality-label">Format:</span>
        <span class="quality-info">DASH (.mpd) — Native Helper (yt-dlp)</span>
      `;
    });
  }

  // ───────── Native Helper & Download Handlers ─────────

  function checkNativeHelperStatus() {
    if (helperDot) helperDot.className = 'helper-dot checking';
    if (helperText) helperText.textContent = 'Helper: Checking...';

    chrome.runtime.sendMessage({ action: 'checkNativeHelper' }, function (res) {
      if (chrome.runtime.lastError || !res || !res.installed) {
        helperState.checked = true;
        helperState.installed = false;
        helperState.data = null;
        if (helperDot) helperDot.className = 'helper-dot disconnected';
        if (helperText) helperText.textContent = 'Helper: Not Installed';
        if (extIdDisplay) extIdDisplay.textContent = chrome.runtime.id;
      } else {
        helperState.checked = true;
        helperState.installed = true;
        helperState.data = res.data;
        if (helperDot) helperDot.className = 'helper-dot connected';
        const hasBoth = res.data && res.data.dependencies && res.data.dependencies.ytdlp && res.data.dependencies.ffmpeg;
        if (helperText) {
          helperText.textContent = hasBoth
            ? 'Helper: Ready (yt-dlp + ffmpeg)'
            : 'Helper: Warning (yt-dlp/ffmpeg missing)';
        }
        if (helperGuideBanner) helperGuideBanner.classList.add('hidden');
      }
    });
  }

  function showHelperGuide() {
    if (extIdDisplay) extIdDisplay.textContent = chrome.runtime.id;
    if (helperGuideBanner) helperGuideBanner.classList.remove('hidden');
  }

  async function handleNativeDownload(item, index, card) {
    if (!helperState.installed) {
      showHelperGuide();
      alert('Native Helper (yt-dlp + ffmpeg) is not installed.\n\nPlease follow the setup guide at the top of the popup to run the installer script in native-host/.');
      return;
    }

    const nativeBtn = card.querySelector('.native-dl-btn');
    const statusArea = card.querySelector('.status-area');
    if (nativeBtn) {
      nativeBtn.disabled = true;
      nativeBtn.className = 'native-dl-btn downloading';
      nativeBtn.innerHTML = '<span>⏳ Downloading...</span>';
    }
    if (statusArea) {
      statusArea.classList.remove('hidden');
      statusArea.innerHTML = '<div style="color:#64b5f6; font-size:11px;">Sending job to yt-dlp... Saving to ~/Downloads</div>';
    }

    let activePageUrl = item.pageUrl || '';
    if (!activePageUrl) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab && activeTab.url) activePageUrl = activeTab.url;
      } catch {}
    }

    let downloadUrl = cleanStreamUrl(item.url);
    const qualitySelect = card.querySelector('.quality-select');
    if (qualitySelect && qualitySelect.value) {
      downloadUrl = qualitySelect.value;
    }

    chrome.runtime.sendMessage({
      action: 'startNativeDownload',
      url: downloadUrl,
      pageUrl: activePageUrl,
      referer: item.referer || activePageUrl,
      origin: item.origin || '',
      ua: item.userAgent || ''
    }, function (response) {
      if (chrome.runtime.lastError || !response || !response.success) {
        const errMsg = response ? response.log || response.error : (chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download failed');
        console.error('Native download error:', errMsg);
        if (nativeBtn) {
          nativeBtn.disabled = false;
          nativeBtn.className = 'native-dl-btn failed';
          nativeBtn.innerHTML = '<span>❌ Failed</span>';
        }
        if (statusArea) {
          statusArea.innerHTML = `
            <div style="color:#f44336; font-size:11px; margin-bottom:4px;">❌ ${escapeHtml((errMsg || '').slice(0, 150))}...</div>
            <button class="download-btn browser-dl-btn" style="font-size:10px; padding:3px 8px;">Try Browser Downloader</button>
          `;
          const retryBrowserBtn = statusArea.querySelector('.browser-dl-btn');
          if (retryBrowserBtn) {
            retryBrowserBtn.addEventListener('click', () => handleDownload(item, index, card));
          }
        }
      } else {
        if (nativeBtn) {
          nativeBtn.className = 'native-dl-btn done';
          nativeBtn.innerHTML = '<span>✅ Saved</span>';
        }
        if (statusArea) {
          statusArea.innerHTML = '<div style="color:#00e676; font-size:11px; font-weight:600;">✅ Saved to ~/Downloads!</div>';
        }
      }
    });
  }

  // ───────── Download Handling (Opens downloader.html in New Tab) ─────────

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

  async function handleDownload(item, index, card) {
    const filename = getSafeFilename(item);
    let downloadUrl = cleanStreamUrl(item.url);
    let chosenVariant = '';
    let audioUrl = item.audioUrl ? cleanStreamUrl(item.audioUrl) : '';

    const isAudioItem = item.type === 'audio' ||
                        (item.format && ['m4a', 'mp3', 'aac', 'wav', 'ogg'].includes(item.format.toLowerCase())) ||
                        (item.url && (item.url.includes('mime=audio') || item.url.includes('mime%2faudio')));

    // If HLS quality select is present and chosen
    const qualitySelect = card.querySelector('.quality-select');
    if (qualitySelect && qualitySelect.value) {
      chosenVariant = qualitySelect.value;
      downloadUrl = chosenVariant;
      const selOpt = qualitySelect.selectedOptions ? qualitySelect.selectedOptions[0] : null;
      if (selOpt && selOpt.dataset.audioUrl) {
        audioUrl = selOpt.dataset.audioUrl;
      }
    }

    // Automatically pair video-only stream with detected audio track from the same page (ONLY if downloading video)
    if (!audioUrl && !isAudioItem) {
      const allItems = window._svd_mediaItems || [];
      const audioItem = allItems.find(m => m.type === 'audio' || (m.url && (m.url.includes('mime=audio') || m.url.includes('mime%2faudio'))));
      if (audioItem && audioItem.url !== downloadUrl) {
        audioUrl = cleanStreamUrl(audioItem.url);
      }
    }

    const detectedType = isAudioItem ? 'audio' : (item.type || 'video');
    const detectedFormat = item.format || (isAudioItem ? 'm4a' : 'mp4');

    // Retrieve active tab URL to pass as Referer/Origin
    let activePageUrl = '';
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.url) activePageUrl = activeTab.url;
    } catch {}

    // Open downloader.html in a new tab (conforming to specification)
    let dlUrl = chrome.runtime.getURL(
      `downloader.html?url=${encodeURIComponent(item.url)}&variant=${encodeURIComponent(chosenVariant || downloadUrl)}&type=${encodeURIComponent(detectedType)}&format=${encodeURIComponent(detectedFormat)}&title=${encodeURIComponent(filename)}`
    );
    if (activePageUrl) {
      dlUrl += `&referer=${encodeURIComponent(activePageUrl)}`;
    }
    if (audioUrl && !isAudioItem) {
      dlUrl += `&audioUrl=${encodeURIComponent(audioUrl)}`;
    }
    if (item.size && item.size > 65536) {
      dlUrl += `&size=${encodeURIComponent(item.size)}`;
    }

    chrome.tabs.create({ url: dlUrl });
    window.close();
  }

  function updateProgress(index, card, data) {
    const fill = document.getElementById(`progress-fill-${index}`);
    const sizeEl = document.getElementById(`progress-size-${index}`);
    const speedEl = document.getElementById(`progress-speed-${index}`);
    const pctEl = document.getElementById(`progress-pct-${index}`);

    if (!fill) return;

    const percent = data.percent != null ? Math.min(100, Math.max(0, data.percent)) : 0;
    fill.style.width = percent + '%';

    if (pctEl) pctEl.textContent = Math.round(percent) + '%';

    if (sizeEl) {
      let sizeText = '';
      if (data.loaded != null) {
        sizeText = formatBytes(data.loaded);
        if (data.total != null && data.total > 0) {
          sizeText += ' / ' + formatBytes(data.total);
        }
      }
      sizeEl.textContent = sizeText || 'Downloading...';
    }

    if (speedEl) {
      speedEl.textContent = data.speed ? formatSpeed(data.speed) : '';
    }
  }

  function showComplete(index, card) {
    const statusArea = card.querySelector('.status-area');
    if (statusArea) {
      statusArea.innerHTML = `
        <div class="download-complete">
          ${createSvg('check')}
          <span>Downloaded</span>
        </div>
      `;
    }
    activeDownloads.forEach(function (val, key) {
      if (val.index === index) activeDownloads.delete(key);
    });
  }

  function showError(index, card, message, item) {
    const statusArea = card.querySelector('.status-area');
    if (!statusArea) return;
    statusArea.classList.remove('hidden');

    const errorMsg = message || 'Download failed';

    statusArea.innerHTML = `
      <div class="download-error">
        <span class="error-text" title="${escapeHtml(errorMsg)}">${escapeHtml(errorMsg)}</span>
        <button class="retry-btn">${createSvg('retry')} Retry</button>
      </div>
    `;

    const retryBtn = statusArea.querySelector('.retry-btn');
    retryBtn.addEventListener('click', function () {
      statusArea.classList.add('hidden');
      const dlBtn = card.querySelector('.download-btn');
      if (dlBtn) {
        dlBtn.style.display = '';
        dlBtn.disabled = false;
      }
    });

    // Re-show the download button logic is handled by retry
    activeDownloads.forEach(function (val, key) {
      if (val.index === index) activeDownloads.delete(key);
    });
  }

  // ───────── Message Listener (real-time updates) ─────────

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.action) return;

    if (message.action === 'downloadProgress') {
      // Background sends { action: 'downloadProgress', data: { id, status, totalSegments, completedSegments, bytesDownloaded, ... } }
      const d = message.data || message;
      const dlId = d.id || d.downloadId;

      // Try matching by download ID or URL
      let entry = null;
      activeDownloads.forEach(function (val, key) {
        if (val.downloadId === dlId || key === d.url) {
          entry = val;
        }
      });
      // Also try matching by originalUrl stored in the entry
      if (!entry) {
        activeDownloads.forEach(function (val) {
          if (!entry) entry = val; // fallback to any active download
        });
      }

      if (entry) {
        // Store download ID for future matching
        if (dlId) entry.downloadId = dlId;

        const total = d.totalSegments || 0;
        const completed = d.completedSegments || 0;
        const percent = total > 0 ? (completed / total) * 100 : 0;

        updateProgress(entry.index, entry.card, {
          percent: percent,
          loaded: d.bytesDownloaded || 0,
          total: null,
          speed: null,
        });

        // Check for completion or error
        if (d.status === 'complete') {
          setTimeout(function () {
            showComplete(entry.index, entry.card);
          }, 500);
        } else if (d.status === 'error') {
          showError(entry.index, entry.card, d.error || 'Download failed', entry.item);
        }
      }
    }

    if (message.action === 'downloadComplete') {
      activeDownloads.forEach(function (val) {
        updateProgress(val.index, val.card, { percent: 100, loaded: message.totalSize, total: message.totalSize });
        setTimeout(function () {
          showComplete(val.index, val.card);
        }, 500);
      });
    }

    if (message.action === 'downloadError') {
      activeDownloads.forEach(function (val) {
        showError(val.index, val.card, message.error, val.item);
      });
    }

    if (message.action === 'newMediaDetected') {
      // A new media resource was detected on the active tab — refresh the list
      loadMedia();
    }
  });

  // ───────── Load Media ─────────

  function loadMedia() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || tabs.length === 0) {
        renderMediaList([]);
        return;
      }

      const tabId = tabs[0].id;

      chrome.runtime.sendMessage({ action: 'getMedia', tabId: tabId }, function (response) {
        if (chrome.runtime.lastError) {
          console.error('Error getting media:', chrome.runtime.lastError.message);
          renderMediaList([]);
          return;
        }

        const mediaItems = (response && response.media) ? response.media : [];
        // Attach tabId to each item for reference
        mediaItems.forEach(function (item) {
          item.tabId = tabId;
        });
        renderMediaList(mediaItems);
      });
    });
  }

  // ───────── Video Player Recording Mode (CocoCut Style) ─────────

  function checkVideoRecorderStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || tabs.length === 0) return;
      const tabId = tabs[0].id;
      const tabUrl = tabs[0].url || '';
      const isVideoSite = tabUrl.includes('youtube.com') || tabUrl.includes('vimeo.com') || tabUrl.includes('twitch.tv');

      const banner = document.getElementById('record-banner');
      const recordBtn = document.getElementById('record-btn');
      const desc = document.getElementById('rec-banner-desc');
      if (!banner || !recordBtn) return;

      if (isVideoSite || (window._svd_mediaItems && window._svd_mediaItems.length > 0)) {
        banner.classList.remove('hidden');
        recordBtn.innerHTML = '<span>⚡ Open Downloader Tab</span>';
        if (desc) desc.textContent = 'Multi-threaded stream caching in new tab';
      }
    });
  }

  const recordBtn = document.getElementById('record-btn');
  if (recordBtn) {
    recordBtn.addEventListener('click', function () {
      const items = window._svd_mediaItems || [];
      if (items.length > 0) {
        handleDownload(items[0], 0, document.body);
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('download.html') });
        window.close();
      }
    });
  }

  // ───────── Event Handlers ─────────

  refreshBtn.addEventListener('click', function () {
    // Animate the refresh icon
    const svg = refreshBtn.querySelector('svg');
    if (svg) {
      svg.style.transform = 'rotate(360deg)';
      setTimeout(function () {
        svg.style.transform = '';
      }, 500);
    }
    loadMedia();
    checkVideoRecorderStatus();
  });

  if (checkHelperBtn) {
    checkHelperBtn.addEventListener('click', function () {
      checkNativeHelperStatus();
      setTimeout(function () {
        if (!helperState.installed) {
          showHelperGuide();
        }
      }, 350);
    });
  }

  if (closeHelperGuide) {
    closeHelperGuide.addEventListener('click', function () {
      if (helperGuideBanner) helperGuideBanner.classList.add('hidden');
    });
  }

  if (copyExtIdBtn) {
    copyExtIdBtn.addEventListener('click', function () {
      const id = chrome.runtime.id;
      navigator.clipboard.writeText(id).then(function () {
        copyExtIdBtn.textContent = 'Copied!';
        setTimeout(function () { copyExtIdBtn.textContent = 'Copy ID'; }, 2000);
      });
    });
  }

  if (openDownloaderBtn) {
    openDownloaderBtn.addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html') });
      window.close();
    });
  }

  settingsBtn.addEventListener('click', function () {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });

  // ───────── Init ─────────

  checkNativeHelperStatus();
  loadMedia();
  checkVideoRecorderStatus();
})();
