/**
 * Transmuxing Module (transmux.js)
 *
 * For AVC + AAC streams: wraps ONE mux.js Transmuxer (keepOriginalTimestamps: false).
 * Pushes and flushes each segment in order, writes the init segment only once,
 * and handles #EXT-X-DISCONTINUITY with setBaseMediaDecodeTime(cumulativeDuration * 90000).
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TransmuxEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Scan and verify TS sync byte 0x47 at offsets 0, 188, 376.
   * If not found, scans the first 4 KB and strips leading bytes (fake image headers).
   *
   * @param {ArrayBuffer|Uint8Array} segBuffer
   * @param {number} [segmentIndex=0]
   * @returns {ArrayBuffer}
   */
  function inspectAndStripTsSegment(segBuffer, segmentIndex = 0) {
    if (!segBuffer || segBuffer.byteLength === 0) return segBuffer;
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

    // Fallback: in case segment is short or last packet in 4KB window matches 2 syncs
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

  /**
   * Create an in-order HLS transmuxer session.
   *
   * @param {Object} [options]
   * @param {Function} [options.onInit] - Called when the first (and only) init segment is generated.
   * @param {Function} [options.onData] - Called for every fragmented media chunk.
   * @param {Function} [options.onError] - Error callback.
   */
  function createTransmuxer(options = {}) {
    const muxjsLib = (typeof window !== 'undefined' && window.muxjs) ? window.muxjs : (typeof muxjs !== 'undefined' ? muxjs : null);
    if (!muxjsLib || !muxjsLib.mp4 || !muxjsLib.mp4.Transmuxer) {
      throw new Error('mux.js library is not available. Ensure lib/mux.min.js is loaded.');
    }

    // Single Transmuxer for the entire download session
    // keepOriginalTimestamps: false is REQUIRED so setBaseMediaDecodeTime is applied
    const transmuxer = new muxjsLib.mp4.Transmuxer({
      remux: false,
      keepOriginalTimestamps: false
    });

    let isInitWritten = false;
    let cumulativeDuration = 0;
    let totalMediaBytes = 0;
    let initSegmentBytes = 0;
    const initCallbacks = options.onInit ? [options.onInit] : [];
    const dataCallbacks = options.onData ? [options.onData] : [];
    const errorCallbacks = options.onError ? [options.onError] : [];

    // Initialize baseMediaDecodeTime to 0
    try {
      transmuxer.setBaseMediaDecodeTime(0);
    } catch (_) {}

    transmuxer.on('data', (segment) => {
      try {
        // Emit the init segment (ftyp + moov) only once
        if (segment.initSegment && !isInitWritten) {
          isInitWritten = true;
          initSegmentBytes = segment.initSegment.byteLength || (segment.initSegment.length || 0);
          console.log(`[TransmuxEngine] Received init segment: ${initSegmentBytes} bytes`);
          for (const cb of initCallbacks) {
            cb(segment.initSegment);
          }
        }

        // Emit media fragment data (moof + mdat)
        if (segment.data && segment.data.byteLength > 0) {
          totalMediaBytes += segment.data.byteLength;
          console.log(`[TransmuxEngine] Emitted media data: ${segment.data.byteLength} bytes (total media: ${totalMediaBytes} bytes)`);
          for (const cb of dataCallbacks) {
            cb(segment.data);
          }
        }
      } catch (err) {
        console.error('[TransmuxEngine] Error processing transmuxed segment:', err);
        for (const cb of errorCallbacks) {
          cb(err);
        }
      }
    });

    /**
     * Push a TS segment in order with discontinuity alignment.
     *
     * @param {Uint8Array|ArrayBuffer} segBuffer - TS segment data
     * @param {Object} [segMeta] - Segment metadata (duration, discontinuity)
     */
    function push(segBuffer, segMeta = {}) {
      if (!segBuffer || segBuffer.byteLength === 0) return;

      // On discontinuity, align track fragment decode time to cumulative playlist duration
      if (segMeta.discontinuity) {
        try {
          const ticks = Math.round(cumulativeDuration * 90000);
          transmuxer.setBaseMediaDecodeTime(ticks);
        } catch (err) {
          console.warn('[TransmuxEngine] setBaseMediaDecodeTime note:', err);
        }
      }

      const uint8 = segBuffer instanceof Uint8Array ? segBuffer : new Uint8Array(segBuffer);
      transmuxer.push(uint8);
      transmuxer.flush();

      if (typeof segMeta.duration === 'number' && segMeta.duration > 0) {
        cumulativeDuration += segMeta.duration;
      }
    }

    /**
     * Finalize transmuxing and assert that non-zero media bytes were emitted (Requirement 2).
     */
    function finish() {
      try {
        transmuxer.flush();
      } catch (_) {}

      console.log(`[TransmuxEngine] Transmuxer completed. Total media bytes emitted: ${totalMediaBytes} bytes (init header: ${initSegmentBytes} bytes).`);

      if (totalMediaBytes === 0) {
        const errMsg = `Transmuxer emitted 0 media bytes (only init header ${initSegmentBytes} bytes produced). mux.js failed to transmux TS segments into MP4 fragments.`;
        console.error(`[TransmuxEngine] ${errMsg}`);
        const err = new Error(errMsg);
        err.totalMediaBytes = 0;
        err.initSegmentBytes = initSegmentBytes;
        for (const cb of errorCallbacks) {
          cb(err);
        }
        throw err;
      }

      return totalMediaBytes;
    }

    function onInit(cb) {
      if (typeof cb === 'function') initCallbacks.push(cb);
    }

    function onData(cb) {
      if (typeof cb === 'function') dataCallbacks.push(cb);
    }

    function onError(cb) {
      if (typeof cb === 'function') errorCallbacks.push(cb);
    }

    function reset() {
      isInitWritten = false;
      cumulativeDuration = 0;
      totalMediaBytes = 0;
      initSegmentBytes = 0;
      try {
        transmuxer.setBaseMediaDecodeTime(0);
      } catch (_) {}
    }

    return {
      push,
      finish,
      onInit,
      onData,
      onError,
      reset,
      isInitWritten: () => isInitWritten,
      getTotalMediaBytes: () => totalMediaBytes,
      getInitSegmentBytes: () => initSegmentBytes,
      getCumulativeDuration: () => cumulativeDuration,
      rawTransmuxer: transmuxer
    };
  }

  return {
    createTransmuxer,
    inspectAndStripTsSegment
  };
});
