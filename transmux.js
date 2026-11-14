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
          for (const cb of initCallbacks) {
            cb(segment.initSegment);
          }
        }

        // Emit media fragment data (moof + mdat)
        if (segment.data) {
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
      try {
        transmuxer.setBaseMediaDecodeTime(0);
      } catch (_) {}
    }

    return {
      push,
      onInit,
      onData,
      onError,
      reset,
      isInitWritten: () => isInitWritten,
      getCumulativeDuration: () => cumulativeDuration,
      rawTransmuxer: transmuxer
    };
  }

  return {
    createTransmuxer
  };
});
