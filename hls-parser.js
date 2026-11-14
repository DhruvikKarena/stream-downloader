/**
 * HLS Playlist Parser (hls-parser.js)
 *
 * Implements RFC 8216 HLS playlist specification.
 * Parses #EXT-X-DISCONTINUITY and #EXTINF, exposing per-segment duration
 * and discontinuity flags.
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
   * Parse an #EXT-X-KEY tag line.
   */
  function parseKeyTag(line, baseUrl) {
    const attrs = line.substring(line.indexOf(':') + 1);
    const method = extractAttr(attrs, 'METHOD');
    const uri = extractAttr(attrs, 'URI');
    const iv = extractAttr(attrs, 'IV');
    const keyFormat = extractAttr(attrs, 'KEYFORMAT');
    const keyFormatVersions = extractAttr(attrs, 'KEYFORMATVERSIONS');

    return {
      method: method || 'NONE',
      uri: uri ? resolveUrl(uri, baseUrl) : '',
      iv: iv || '',
      keyFormat: keyFormat || 'identity',
      keyFormatVersions: keyFormatVersions || '1',
      isDrm: method === 'SAMPLE-AES' ||
             (keyFormat && keyFormat.toLowerCase().includes('widevine')) ||
             (keyFormat && keyFormat.toLowerCase().includes('fairplay')) ||
             (keyFormat && keyFormat.toLowerCase().includes('playready'))
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
   *
   * @param {string} text - Raw M3U8 text content.
   * @param {string} [baseUrl=''] - Base URL for resolving relative URIs.
   * @param {number} [httpStatus=200] - HTTP status code of the response.
   * @returns {Object} Parsed playlist structure.
   */
  function parse(text, baseUrl = '', httpStatus = 200) {
    const clean = (text || '').trim();
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
   * Parse Master Playlist containing variant streams and alternate audio.
   */
  function parseMasterPlaylist(lines, baseUrl) {
    const variants = [];
    const audioTracks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')) {
        const attrs = line.substring(line.indexOf(':') + 1);
        const groupId = extractAttr(attrs, 'GROUP-ID');
        const uri = extractAttr(attrs, 'URI');
        const name = extractAttr(attrs, 'NAME');
        const language = extractAttr(attrs, 'LANGUAGE');
        const isDefault = extractAttr(attrs, 'DEFAULT') === 'YES';
        if (uri) {
          audioTracks.push({
            groupId,
            name,
            language,
            isDefault,
            url: resolveUrl(uri, baseUrl)
          });
        }
      }

      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const attrs = line.substring(line.indexOf(':') + 1);
        const bandwidth = parseInt(extractAttr(attrs, 'BANDWIDTH'), 10) || 0;
        const resolution = extractAttr(attrs, 'RESOLUTION');
        const codecs = extractAttr(attrs, 'CODECS');
        const audioGroup = extractAttr(attrs, 'AUDIO');

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
            resolution,
            codecs,
            audioGroup,
            url: variantUrl
          });
        }
      }
    }

    // Associate audio tracks with matching variant streams
    for (const v of variants) {
      if (v.audioGroup) {
        const match = audioTracks.find(a => a.groupId === v.audioGroup);
        if (match) v.audioUrl = match.url;
      } else if (audioTracks.length > 0) {
        v.audioUrl = audioTracks[0].url;
      }
    }

    return {
      type: 'master',
      isMaster: true,
      variants,
      audioTracks,
      isDrmProtected: false
    };
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
        // Flag next segment as having a discontinuity
        pendingDiscontinuity = true;
        discontinuityCount++;
      } else if (line.startsWith('#EXTINF')) {
        // #EXTINF:<duration>,[<title>]
        const val = line.substring(line.indexOf(':') + 1);
        const parts = val.split(',');
        currentDuration = parseFloat(parts[0]) || 0;
        currentTitle = parts.slice(1).join(',').trim();
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        hasEndList = true;
      } else if (!line.startsWith('#')) {
        // Line is a segment URL
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
    parseKeyTag,
    extractAttr,
    resolveUrl,
    checkDrmProtection
  };
});
