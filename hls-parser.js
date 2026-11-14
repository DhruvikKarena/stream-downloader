/**
 * HLS Playlist Parser (hls-parser.js)
 *
 * Implements RFC 8216 HLS playlist specification.
 * Parses #EXT-X-DISCONTINUITY and #EXTINF, exposing per-segment duration
 * and discontinuity flags, master variant streams with de-duplication,
 * separate audio renditions (#EXT-X-MEDIA:TYPE=AUDIO), and subtitles.
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HlsParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Extract a named attribute from an HLS tag attribute list.
   * Handles quoted ("value") and unquoted (12345 or AVC1) values.
   */
  function extractAttr(attrStr, name) {
    if (!attrStr || !name) return '';
    const match = attrStr.match(new RegExp('(?:^|[,\\s])' + name + '=(?:"([^"]*)"|([^,\\s]*))'));
    return match ? (match[1] !== undefined ? match[1] : (match[2] || '')) : '';
  }

  /**
   * Resolve a relative URL against a base URL.
   */
  function resolveUrl(relativeUrl, baseUrl) {
    if (!relativeUrl) return '';
    if (!baseUrl || relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://') || relativeUrl.startsWith('blob:') || relativeUrl.startsWith('data:')) {
      return relativeUrl;
    }
    try {
      return new URL(relativeUrl, baseUrl).href;
    } catch {
      return relativeUrl;
    }
  }

  /**
   * Human-readable resolution label from width & height.
   */
  function getResolutionLabel(width, height) {
    const h = parseInt(height, 10) || 0;
    if (h >= 2160) return '4K (2160p)';
    if (h >= 1440) return '2K (1440p)';
    if (h >= 1080) return '1080p (Full HD)';
    if (h >= 720) return '720p (HD)';
    if (h >= 480) return '480p (SD)';
    if (h >= 360) return '360p';
    if (h >= 240) return '240p';
    if (h > 0) return `${h}p`;
    return 'Default Quality';
  }

  /**
   * Parse an #EXT-X-KEY tag line.
   */
  function parseKeyTag(line, baseUrl) {
    const attrs = line.substring(line.indexOf(':') + 1);
    const method = extractAttr(attrs, 'METHOD') || 'NONE';
    const uri = extractAttr(attrs, 'URI');
    const iv = extractAttr(attrs, 'IV');
    const keyFormat = extractAttr(attrs, 'KEYFORMAT') || 'identity';
    const keyFormatVersions = extractAttr(attrs, 'KEYFORMATVERSIONS') || '1';

    const lowerMethod = method.toUpperCase();
    const lowerFormat = keyFormat.toLowerCase();

    return {
      method: lowerMethod,
      uri: uri ? resolveUrl(uri, baseUrl) : '',
      iv: iv || '',
      keyFormat,
      keyFormatVersions,
      isDrm: lowerMethod === 'SAMPLE-AES' ||
             lowerFormat.includes('widevine') ||
             lowerFormat.includes('fairplay') ||
             lowerFormat.includes('playready')
    };
  }

  /**
   * Check if playlist text indicates DRM protection.
   */
  function checkDrmProtection(text) {
    const lower = text.toLowerCase();
    return text.includes('METHOD=SAMPLE-AES') ||
           lower.includes('com.widevine.alpha') ||
           lower.includes('widevine') ||
           lower.includes('fairplay') ||
           lower.includes('com.apple.streamingkeydelivery') ||
           lower.includes('playready') ||
           lower.includes('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
  }

  /**
   * Main entry point: Parses Master or Media HLS playlist.
   */
  function parse(text, baseUrl = '', httpStatus = 200) {
    const clean = (text || '').replace(/^\uFEFF/, '').trim();
    const m3uIndex = clean.indexOf('#EXTM3U');
    if (m3uIndex === -1) {
      const snippet = clean.slice(0, 200).replace(/\s+/g, ' ');
      if (clean.includes('<html') || clean.includes('<!DOCTYPE')) {
        throw new Error(`Server returned HTTP ${httpStatus}: "${snippet}" (HTML error page, not #EXTM3U)`);
      }
      throw new Error(`Server returned HTTP ${httpStatus}: "${snippet}" (Missing #EXTM3U tag)`);
    }

    if (checkDrmProtection(text)) {
      return {
        isDrmProtected: true,
        type: 'drm',
        segments: [],
        variants: []
      };
    }

    const lines = clean.slice(m3uIndex)
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);

    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
    if (isMaster) {
      return parseMasterPlaylist(lines, baseUrl);
    }

    return parseMediaPlaylist(lines, baseUrl);
  }

  /**
   * Parse Master Playlist containing variant streams, alternate audio, and subtitles.
   */
  function parseMasterPlaylist(lines, baseUrl) {
    const variants = [];
    const audioTracks = [];
    const subtitles = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Parse Audio Tracks (#EXT-X-MEDIA:TYPE=AUDIO)
      if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')) {
        const attrs = line.substring(line.indexOf(':') + 1);
        const groupId = extractAttr(attrs, 'GROUP-ID');
        const uri = extractAttr(attrs, 'URI');
        const name = extractAttr(attrs, 'NAME') || 'Audio';
        const language = extractAttr(attrs, 'LANGUAGE') || '';
        const isDefault = extractAttr(attrs, 'DEFAULT') === 'YES' || extractAttr(attrs, 'AUTOSELECT') === 'YES';
        audioTracks.push({
          groupId,
          name,
          language,
          isDefault,
          url: uri ? resolveUrl(uri, baseUrl) : ''
        });
      }

      // Parse Subtitle Tracks (#EXT-X-MEDIA:TYPE=SUBTITLES)
      if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=SUBTITLES')) {
        const attrs = line.substring(line.indexOf(':') + 1);
        const groupId = extractAttr(attrs, 'GROUP-ID');
        const uri = extractAttr(attrs, 'URI');
        const name = extractAttr(attrs, 'NAME') || 'Subtitles';
        const language = extractAttr(attrs, 'LANGUAGE') || '';
        const isDefault = extractAttr(attrs, 'DEFAULT') === 'YES';
        if (uri) {
          subtitles.push({
            groupId,
            name,
            language,
            isDefault,
            url: resolveUrl(uri, baseUrl)
          });
        }
      }

      // Parse Variant Streams (#EXT-X-STREAM-INF)
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const attrs = line.substring(line.indexOf(':') + 1);
        const bandwidth = parseInt(extractAttr(attrs, 'BANDWIDTH'), 10) || 0;
        const averageBandwidth = parseInt(extractAttr(attrs, 'AVERAGE-BANDWIDTH'), 10) || bandwidth;
        const resolution = extractAttr(attrs, 'RESOLUTION');
        const frameRateStr = extractAttr(attrs, 'FRAME-RATE');
        const frameRate = frameRateStr ? parseFloat(frameRateStr) : 0;
        const codecs = extractAttr(attrs, 'CODECS');
        const audioGroup = extractAttr(attrs, 'AUDIO');
        const subtitlesGroup = extractAttr(attrs, 'SUBTITLES');

        let width = 0;
        let height = 0;
        if (resolution && resolution.includes('x')) {
          const dims = resolution.split('x');
          width = parseInt(dims[0], 10) || 0;
          height = parseInt(dims[1], 10) || 0;
        }

        let variantUrl = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) {
            variantUrl = resolveUrl(lines[j], baseUrl);
            break;
          }
        }

        if (variantUrl) {
          variants.push({
            bandwidth,
            averageBandwidth,
            bandwidthMbps: ((bandwidth / 1000000) || 0).toFixed(2),
            resolution: resolution || (height > 0 ? `${width}x${height}` : ''),
            width,
            height,
            frameRate,
            resolutionLabel: getResolutionLabel(width, height),
            codecs: codecs || '',
            audioGroup: audioGroup || '',
            subtitlesGroup: subtitlesGroup || '',
            url: variantUrl
          });
        }
      }
    }

    // Group audio tracks by group ID
    const audioGroups = {};
    for (const a of audioTracks) {
      const g = a.groupId || 'default';
      if (!audioGroups[g]) audioGroups[g] = [];
      audioGroups[g].push(a);
      a.default = !!a.isDefault;
    }

    // Associate audio and subtitle tracks with variants
    for (const v of variants) {
      if (v.audioGroup) {
        const matches = audioTracks.filter(a => a.groupId === v.audioGroup);
        v.audioTracks = matches;
        const def = matches.find(a => a.isDefault && a.url) || matches.find(a => a.url);
        if (def) v.audioUrl = def.url;
      } else if (audioTracks.length > 0) {
        v.audioTracks = audioTracks;
        const def = audioTracks.find(a => a.isDefault && a.url) || audioTracks.find(a => a.url);
        if (def) v.audioUrl = def.url;
      }

      if (v.subtitlesGroup) {
        v.subtitles = subtitles.filter(s => s.groupId === v.subtitlesGroup);
      } else {
        v.subtitles = subtitles;
      }
    }

    // Sort and deduplicate variants
    const deduplicatedVariants = sortAndDeduplicateVariants(variants);

    return {
      type: 'master',
      isMaster: true,
      variants: deduplicatedVariants,
      allVariants: variants,
      audioTracks,
      audioGroups,
      subtitles,
      isDrmProtected: false
    };
  }

  /**
   * Sort by resolution descending, de-duplicate identical resolutions
   * (keep highest bandwidth variant for each resolution label).
   */
  function sortAndDeduplicateVariants(variants) {
    if (!Array.isArray(variants)) return [];

    // Sort descending by height, then by bandwidth
    const sorted = [...variants].sort((a, b) => {
      if (b.height !== a.height) return b.height - a.height;
      return b.bandwidth - a.bandwidth;
    });

    // De-duplicate identical resolutions, keeping highest bandwidth
    const seenHeights = new Map();
    const result = [];

    for (const v of sorted) {
      const key = v.height > 0 ? `${v.height}` : (v.resolution || v.url);
      if (!seenHeights.has(key)) {
        seenHeights.set(key, true);
        result.push(v);
      }
    }

    return result;
  }

  /**
   * Parse Media Playlist containing segments, durations, and discontinuity markers.
   */
  function parseMediaPlaylist(lines, baseUrl) {
    const segments = [];
    let currentDuration = 0;
    let currentTitle = '';
    let pendingDiscontinuity = false;
    let discontinuityCount = 0;
    let cumulativeDuration = 0;

    let encryptionInfo = null;
    let mediaSequence = 0;
    let targetDuration = 6;
    let hasEndList = false;
    let initSegment = null;
    let isDrmProtected = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-TARGETDURATION')) {
        targetDuration = parseFloat(line.split(':')[1]) || 6;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      } else if (line.startsWith('#EXT-X-MAP')) {
        const attrs = line.substring(line.indexOf(':') + 1);
        const mapUri = extractAttr(attrs, 'URI');
        if (mapUri) {
          initSegment = { url: resolveUrl(mapUri, baseUrl) };
        }
      } else if (line.startsWith('#EXT-X-KEY')) {
        encryptionInfo = parseKeyTag(line, baseUrl);
        if (encryptionInfo && encryptionInfo.isDrm) {
          isDrmProtected = true;
        }
      } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        pendingDiscontinuity = true;
        discontinuityCount++;
      } else if (line.startsWith('#EXTINF')) {
        const val = line.substring(line.indexOf(':') + 1);
        const parts = val.split(',');
        currentDuration = parseFloat(parts[0]) || 0;
        currentTitle = parts.slice(1).join(',').trim();
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        hasEndList = true;
      } else if (!line.startsWith('#')) {
        const segUrl = resolveUrl(line, baseUrl);
        const segIndex = segments.length;

        segments.push({
          url: segUrl,
          duration: currentDuration,
          discontinuity: pendingDiscontinuity,
          cumulativeDuration: cumulativeDuration,
          index: segIndex,
          sequence: mediaSequence + segIndex,
          encryption: encryptionInfo ? { ...encryptionInfo } : null,
          title: currentTitle
        });

        cumulativeDuration += currentDuration;
        pendingDiscontinuity = false;
        currentDuration = 0;
        currentTitle = '';
      }
    }

    return {
      type: 'media',
      isMaster: false,
      segments,
      totalDuration: cumulativeDuration,
      discontinuityCount,
      hasDiscontinuity: discontinuityCount > 0,
      mediaSequence,
      targetDuration,
      hasEndList,
      initSegment,
      isDrmProtected,
      isFmp4: !!initSegment || segments.some(s => s.url.includes('.m4s') || s.url.includes('.mp4'))
    };
  }

  return {
    parse,
    parseMediaPlaylist,
    parseMasterPlaylist,
    sortAndDeduplicateVariants,
    getResolutionLabel,
    parseKeyTag,
    extractAttr,
    resolveUrl,
    checkDrmProtection
  };
});
