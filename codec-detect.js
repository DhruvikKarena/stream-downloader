/**
 * Codec Detection Module (codec-detect.js)
 *
 * Parses CODECS attribute strings (e.g. avc1, hvc1, av01, vp09, mp4a)
 * and provides fallback PMT parsing from raw MPEG-TS packets:
 *   - 0x1B = H.264 (AVC)
 *   - 0x24 = HEVC (H.265)
 *   - 0x0F = ADTS AAC
 *   - 0x03 / 0x04 = MP3
 *   - 0x81 / 0x87 = AC-3 / E-AC-3
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodecDetect = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TS_PACKET_SIZE = 188;
  const TS_SYNC_BYTE = 0x47;

  /**
   * Parse CODECS string from HLS manifest (#EXT-X-STREAM-INF).
   *
   * @param {string} codecsStr - e.g. "avc1.640028,mp4a.40.2"
   * @returns {{ videoCodec: string, audioCodec: string, videoCodecString: string, audioCodecString: string, isAvcAac: boolean, label: string }}
   */
  function parseCodecsString(codecsStr) {
    const raw = (codecsStr || '').trim();
    if (!raw) {
      return {
        videoCodec: 'unknown',
        audioCodec: 'unknown',
        videoCodecString: '',
        audioCodecString: '',
        isAvcAac: false,
        label: 'Auto Detect'
      };
    }

    const parts = raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    let videoCodec = 'unknown';
    let audioCodec = 'unknown';
    let videoCodecString = '';
    let audioCodecString = '';

    for (const p of parts) {
      const lower = p.toLowerCase();
      // Video
      if (lower.startsWith('avc1') || lower.startsWith('avc3')) {
        videoCodec = 'avc';
        videoCodecString = p;
      } else if (lower.startsWith('hvc1') || lower.startsWith('hev1')) {
        videoCodec = 'hevc';
        videoCodecString = p;
      } else if (lower.startsWith('av01')) {
        videoCodec = 'av1';
        videoCodecString = p;
      } else if (lower.startsWith('vp09') || lower.startsWith('vp9')) {
        videoCodec = 'vp9';
        videoCodecString = p;
      }
      // Audio
      else if (lower.startsWith('mp4a.40.') || lower.includes('aac')) {
        audioCodec = 'aac';
        audioCodecString = p;
      } else if (lower.startsWith('mp4a.67') || lower.includes('mp3')) {
        audioCodec = 'mp3';
        audioCodecString = p;
      } else if (lower.includes('opus')) {
        audioCodec = 'opus';
        audioCodecString = p;
      } else if (lower.includes('ac-3') || lower.includes('ac3')) {
        audioCodec = 'ac3';
        audioCodecString = p;
      } else if (lower.includes('ec-3') || lower.includes('eac3')) {
        audioCodec = 'eac3';
        audioCodecString = p;
      }
    }

    const videoName = videoCodec === 'avc' ? 'H.264' : (videoCodec === 'hevc' ? 'H.265' : videoCodec.toUpperCase());
    const audioName = audioCodec !== 'unknown' ? audioCodec.toUpperCase() : '';
    const label = audioName ? `${videoName} / ${audioName}` : videoName;

    return {
      videoCodec,
      audioCodec,
      videoCodecString: videoCodecString || (videoCodec !== 'unknown' ? videoCodec : ''),
      audioCodecString: audioCodecString || (audioCodec !== 'unknown' ? audioCodec : ''),
      isAvcAac: videoCodec === 'avc' && (audioCodec === 'aac' || audioCodec === 'unknown'),
      label
    };
  }

  /**
   * Parse Program Map Table (PMT) from the first TS segment packets
   * to discover elementary stream types if CODECS was missing.
   *
   * @param {Uint8Array|ArrayBuffer} tsBuffer - TS segment data
   * @returns {{ videoCodec: string, audioCodec: string, videoStreamType: number, audioStreamType: number, isAvcAac: boolean, label: string }}
   */
  function detectCodecsFromTs(tsBuffer) {
    const bytes = tsBuffer instanceof Uint8Array ? tsBuffer : new Uint8Array(tsBuffer);
    const len = bytes.length;
    let offset = 0;

    // Find first sync byte
    while (offset < len && bytes[offset] !== TS_SYNC_BYTE) {
      offset++;
    }

    let pmtPid = null;
    let videoStreamType = null;
    let audioStreamType = null;
    let videoCodec = 'unknown';
    let audioCodec = 'unknown';

    while (offset + TS_PACKET_SIZE <= len) {
      if (bytes[offset] !== TS_SYNC_BYTE) {
        offset++;
        continue;
      }

      const p1 = bytes[offset + 1];
      const p2 = bytes[offset + 2];
      const p3 = bytes[offset + 3];

      const payloadUnitStart = !!(p1 & 0x40);
      const pid = ((p1 & 0x1f) << 8) | p2;
      const adaptationFieldControl = (p3 & 0x30) >> 4;

      let payloadOffset = offset + 4;
      if (adaptationFieldControl === 2) {
        // Adaptation field only, no payload
        offset += TS_PACKET_SIZE;
        continue;
      } else if (adaptationFieldControl === 3) {
        // Adaptation field followed by payload
        const adaptationLength = bytes[payloadOffset];
        payloadOffset += 1 + adaptationLength;
      }

      if (payloadOffset >= offset + TS_PACKET_SIZE) {
        offset += TS_PACKET_SIZE;
        continue;
      }

      // Pointer field if payload_unit_start_indicator
      if (payloadUnitStart) {
        const pointer = bytes[payloadOffset];
        payloadOffset += 1 + pointer;
      }

      if (payloadOffset >= offset + TS_PACKET_SIZE) {
        offset += TS_PACKET_SIZE;
        continue;
      }

      // 1. Check PAT (PID = 0) to find PMT PID
      if (pid === 0 && pmtPid === null) {
        const tableId = bytes[payloadOffset];
        if (tableId === 0x00) { // PAT table ID
          const sectionLength = ((bytes[payloadOffset + 1] & 0x0f) << 8) | bytes[payloadOffset + 2];
          // PAT entries start at payloadOffset + 8
          let entryOffset = payloadOffset + 8;
          const endOffset = Math.min(payloadOffset + 3 + sectionLength - 4, offset + TS_PACKET_SIZE);

          while (entryOffset + 4 <= endOffset) {
            const programNumber = (bytes[entryOffset] << 8) | bytes[entryOffset + 1];
            const programPid = ((bytes[entryOffset + 2] & 0x1f) << 8) | bytes[entryOffset + 3];
            if (programNumber !== 0) { // 0 is network PID
              pmtPid = programPid;
              break;
            }
            entryOffset += 4;
          }
        }
      }

      // 2. Check PMT table (either via discovered pmtPid or direct tableId === 0x02)
      else if ((pmtPid !== null && pid === pmtPid) || (bytes[payloadOffset] === 0x02 && pid !== 0)) {
        const tableId = bytes[payloadOffset];
        if (tableId === 0x02) { // PMT table ID
          const sectionLength = ((bytes[payloadOffset + 1] & 0x0f) << 8) | bytes[payloadOffset + 2];
          const programInfoLength = ((bytes[payloadOffset + 10] & 0x0f) << 8) | bytes[payloadOffset + 11];

          let streamOffset = payloadOffset + 12 + programInfoLength;
          const endOffset = Math.min(payloadOffset + 3 + sectionLength - 4, offset + TS_PACKET_SIZE);

          while (streamOffset + 5 <= endOffset) {
            const streamType = bytes[streamOffset];
            const esInfoLength = ((bytes[streamOffset + 3] & 0x0f) << 8) | bytes[streamOffset + 4];

            // Video types
            if (streamType === 0x1b && !videoStreamType) {
              videoStreamType = streamType;
              videoCodec = 'avc'; // H.264
            } else if (streamType === 0x24 && !videoStreamType) {
              videoStreamType = streamType;
              videoCodec = 'hevc'; // H.265
            } else if (streamType === 0x02 && !videoStreamType) {
              videoStreamType = streamType;
              videoCodec = 'mpeg2';
            }

            // Audio types
            else if ((streamType === 0x0f || streamType === 0x11) && !audioStreamType) {
              audioStreamType = streamType;
              audioCodec = 'aac';
            } else if ((streamType === 0x03 || streamType === 0x04) && !audioStreamType) {
              audioStreamType = streamType;
              audioCodec = 'mp3';
            } else if ((streamType === 0x81 || streamType === 0x87) && !audioStreamType) {
              audioStreamType = streamType;
              audioCodec = 'ac3';
            }

            streamOffset += 5 + esInfoLength;
          }

          if (videoCodec !== 'unknown' || audioCodec !== 'unknown') {
            break;
          }
        }
      }

      offset += TS_PACKET_SIZE;
    }

    const videoName = videoCodec === 'avc' ? 'H.264' : (videoCodec === 'hevc' ? 'H.265' : videoCodec.toUpperCase());
    const audioName = audioCodec !== 'unknown' ? audioCodec.toUpperCase() : '';
    const label = audioName ? `${videoName} / ${audioName}` : videoName;

    return {
      videoCodec,
      audioCodec,
      videoStreamType,
      audioStreamType,
      videoCodecString: videoCodec !== 'unknown' ? videoCodec : '',
      audioCodecString: audioCodec !== 'unknown' ? audioCodec : '',
      isAvcAac: videoCodec === 'avc' && (audioCodec === 'aac' || audioCodec === 'unknown'),
      label
    };
  }

  /**
   * Unified detect helper: tries CODECS string first; falls back to TS PMT if unknown.
   */
  function detectCodecs(codecsStr, sampleTsBuffer) {
    if (codecsStr) {
      const parsed = parseCodecsString(codecsStr);
      if (parsed.videoCodec !== 'unknown' || parsed.audioCodec !== 'unknown') {
        return parsed;
      }
    }

    if (sampleTsBuffer) {
      return detectCodecsFromTs(sampleTsBuffer);
    }

    return {
      videoCodec: 'avc', // default fallback
      audioCodec: 'aac',
      videoCodecString: 'avc',
      audioCodecString: 'aac',
      isAvcAac: true,
      label: 'H.264 / AAC (Default)'
    };
  }

  return {
    parseCodecs: parseCodecsString,
    parseCodecsString,
    detectFromTsPmt: detectCodecsFromTs,
    detectCodecsFromTs,
    detectCodecs
  };
});
