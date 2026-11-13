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
      if (isYt || !hasAudio) return 'VIDEO + AUDIO (RECORDER)';
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

      card.innerHTML = `
        <div class="media-card-top">
          ${getMediaTypeBadge(item)}
          <div class="media-card-info">
            <div class="media-filename" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
            <div class="media-details">${detailsHTML}</div>
          </div>
          <div class="media-card-actions">
            <button class="download-btn" data-index="${index}">
              ${createSvg('download')}
              <span>Download</span>
            </button>
          </div>
        </div>
      `;

      // Quality selector for HLS
      const type = (item.type || '').toLowerCase();
      if (type === 'hls' || type === 'm3u8') {
        const qualityRow = document.createElement('div');
        qualityRow.className = 'quality-row';
        qualityRow.innerHTML = `
          <span class="quality-label">Quality:</span>
          <span class="quality-loading">Loading streams...</span>
        `;
        card.appendChild(qualityRow);
        loadHLSQualities(item.url, qualityRow, index);
      }

      // Progress / status area
      const statusArea = document.createElement('div');
      statusArea.className = 'status-area hidden';
      statusArea.id = `status-${index}`;
      card.appendChild(statusArea);

      // Attach download click handler
      const dlBtn = card.querySelector('.download-btn');
      dlBtn.addEventListener('click', function () {
        handleDownload(item, index, card);
      });

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

  // ───────── HLS Quality Loading ─────────

  function loadHLSQualities(url, qualityRow, index) {
    chrome.runtime.sendMessage({ action: 'parseM3U8', url: url }, function (response) {
      qualityRow.innerHTML = '';

      // Background returns { success, data: { type: 'master', variants } }
      const parsed = response && response.success ? response.data : null;
      const variants = (parsed && parsed.type === 'master' && Array.isArray(parsed.variants))
        ? parsed.variants
        : [];

      if (chrome.runtime.lastError || variants.length === 0) {
        // No variant streams found — just show "Default" option
        qualityRow.innerHTML = `
          <span class="quality-label">Quality:</span>
          <select class="quality-select" data-index="${index}">
            <option value="">Default</option>
          </select>
        `;
        return;
      }

      const label = document.createElement('span');
      label.className = 'quality-label';
      label.textContent = 'Quality:';

      const select = document.createElement('select');
      select.className = 'quality-select';
      select.dataset.index = index;

      // Sort variants by bandwidth descending (highest quality first)
      const sorted = variants.slice().sort(function (a, b) {
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
          // Extract height for "1080p" style label
          const parts = stream.resolution.split('x');
          const height = parts.length === 2 ? parts[1] : stream.resolution;
          text = height + 'p';
        } else {
          text = 'Stream ' + (i + 1);
        }
        if (stream.bandwidth) {
          const kbps = Math.round(stream.bandwidth / 1000);
          text += ' \u2014 ' + kbps + 'kbps';
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
    });
  }

  // ───────── Download Handling (Opens in New Tab like Screenshot) ─────────

  function handleDownload(item, index, card) {
    const filename = getSafeFilename(item);
    let downloadUrl = item.url;
    let audioUrl = item.audioUrl || '';

    // If HLS quality select is present and chosen
    const qualitySelect = card.querySelector('.quality-select');
    if (qualitySelect && qualitySelect.value) {
      downloadUrl = qualitySelect.value;
      const selOpt = qualitySelect.selectedOptions ? qualitySelect.selectedOptions[0] : null;
      if (selOpt && selOpt.dataset.audioUrl) {
        audioUrl = selOpt.dataset.audioUrl;
      }
    }

    // Automatically pair video-only stream with detected audio track from the same page
    if (!audioUrl) {
      const allItems = window._svd_mediaItems || [];
      const audioItem = allItems.find(m => m.type === 'audio' || (m.url && (m.url.includes('mime=audio') || m.url.includes('mime%2faudio'))));
      if (audioItem && audioItem.url !== downloadUrl) {
        audioUrl = audioItem.url;
      }
    }

    // Open CocoCut-style Caching Downloader Tab in a new tab
    let dlUrl = chrome.runtime.getURL(
      `download.html?url=${encodeURIComponent(downloadUrl)}&originalUrl=${encodeURIComponent(item.url)}&type=${encodeURIComponent(item.type || 'video')}&title=${encodeURIComponent(filename)}`
    );
    if (audioUrl) {
      dlUrl += `&audioUrl=${encodeURIComponent(audioUrl)}`;
    }
    if (item.format) {
      dlUrl += `&format=${encodeURIComponent(item.format)}`;
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

  if (openDownloaderBtn) {
    openDownloaderBtn.addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('download.html') });
      window.close();
    });
  }

  settingsBtn.addEventListener('click', function () {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });

  // ───────── Init ─────────

  loadMedia();
  checkVideoRecorderStatus();
})();
