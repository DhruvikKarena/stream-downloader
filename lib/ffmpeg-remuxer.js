/**
 * Local Bundled FFmpeg.wasm Remuxer (lib/ffmpeg-remuxer.js)
 * Zero CDN dependencies.
 * Remuxes MPEG-TS to MP4 with:
 *   -fflags +genpts -i in.ts -c copy -movflags +faststart out.mp4
 *
 * Normalizes PTS starting from 0, repairs corrupted timestamps,
 * generates a clean front-loaded moov atom with seek indices,
 * and fixes VLC duration/seeking issues.
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FFmpegRemuxer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let coreInstance = null;
  let isCoreLoading = false;
  let coreLoadPromise = null;

  /**
   * Parse timestamp string HH:MM:SS.ss into total seconds.
   */
  function timeStringToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.trim().split(':');
    if (parts.length === 3) {
      return (parseFloat(parts[0]) * 3600) + (parseFloat(parts[1]) * 60) + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      return (parseFloat(parts[0]) * 60) + parseFloat(parts[1]);
    }
    return parseFloat(timeStr) || 0;
  }

  /**
   * Convert command line argument array into Emscripten argc/argv pointers.
   */
  function parseArgs(core, args) {
    const argsPtr = core._malloc(args.length * Uint32Array.BYTES_PER_ELEMENT);
    args.forEach((s, idx) => {
      const sz = core.lengthBytesUTF8(s) + 1;
      const buf = core._malloc(sz);
      core.stringToUTF8(s, buf, sz);
      core.setValue(argsPtr + (Uint32Array.BYTES_PER_ELEMENT * idx), buf, 'i32');
    });
    return [args.length, argsPtr];
  }

  /**
   * Free allocated argument pointers.
   */
  function freeArgs(core, argc, argvPtr) {
    try {
      for (let i = 0; i < argc; i++) {
        const ptr = core.HEAPU32 ? core.HEAPU32[(argvPtr >> 2) + i] : (core.getValue ? core.getValue(argvPtr + (Uint32Array.BYTES_PER_ELEMENT * i), 'i32') : 0);
        if (ptr) core._free(ptr);
      }
      core._free(argvPtr);
    } catch (e) {
      console.warn('[FFmpegRemuxer] Error freeing arg pointers:', e);
    }
  }

  /**
   * Load and initialize local Emscripten ffmpeg-core module.
   */
  async function loadCore(options = {}) {
    if (coreInstance) return coreInstance;
    if (coreLoadPromise) return coreLoadPromise;

    coreLoadPromise = (async () => {
      let coreFactory = null;
      if (typeof createFFmpegCore === 'function') {
        coreFactory = createFFmpegCore;
      } else if (typeof window !== 'undefined' && typeof window.createFFmpegCore === 'function') {
        coreFactory = window.createFFmpegCore;
      } else if (typeof global !== 'undefined' && typeof global.createFFmpegCore === 'function') {
        coreFactory = global.createFFmpegCore;
      } else {
        // In Node or modular environment
        try {
          coreFactory = require('./ffmpeg-core.js');
        } catch (e) {
          throw new Error('createFFmpegCore is not defined. Ensure lib/ffmpeg-core.js is loaded before ffmpeg-remuxer.js');
        }
      }

      const locateFile = options.locateFile || function (path, prefix) {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
          return chrome.runtime.getURL('lib/' + path);
        }
        if (typeof window !== 'undefined' && window.location) {
          return new URL('lib/' + path, window.location.href).href;
        }
        return (prefix || '') + path;
      };

      const core = await coreFactory({
        locateFile,
        print: (msg) => {
          if (core._currentOnStdout) core._currentOnStdout(msg);
        },
        printErr: (msg) => {
          if (core._currentOnStderr) core._currentOnStderr(msg);
        }
      });

      coreInstance = core;
      return core;
    })();

    return coreLoadPromise;
  }

  /**
   * Remux MPEG-TS data to MP4 using bundled ffmpeg.wasm.
   *
   * @param {Uint8Array|ArrayBuffer} tsData - Input MPEG-TS data.
   * @param {Object} options - Configuration and callbacks.
   * @param {number} [options.expectedDuration] - Total expected stream duration in seconds for progress calculation.
   * @param {Function} [options.onProgress] - Callback ({ ratio, time, duration, message }).
   * @param {Function} [options.onLog] - Callback (message).
   * @returns {Promise<{ mp4Data: Uint8Array, duration: number, logs: string[] }>}
   */
  async function remuxTsToMp4(tsData, options = {}) {
    const core = await loadCore(options);
    const onProgress = options.onProgress || (() => {});
    const onLog = options.onLog || (() => {});
    const expectedDuration = options.expectedDuration || 0;

    const logs = [];
    let detectedDuration = 0;
    let lastTime = 0;

    // Set dynamic stdout/stderr interceptors
    core._currentOnStdout = (msg) => {
      logs.push(msg);
      onLog(msg);
    };

    core._currentOnStderr = (msg) => {
      logs.push(msg);
      onLog(msg);

      if (typeof msg === 'string') {
        // Parse input duration: "  Duration: 00:02:15.30, start: ..."
        if (msg.includes('Duration:')) {
          const match = msg.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
          if (match && match[1]) {
            detectedDuration = timeStringToSeconds(match[1]);
          }
        }

        // Parse progress line: "frame=  120 fps=0.0 ... time=00:00:05.12 ..."
        if (msg.includes('time=')) {
          const match = msg.match(/time=\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
          if (match && match[1]) {
            lastTime = timeStringToSeconds(match[1]);
            const targetDur = detectedDuration > 0 ? detectedDuration : (expectedDuration > 0 ? expectedDuration : 0);
            const ratio = targetDur > 0 ? Math.min(lastTime / targetDur, 0.99) : 0.5;
            onProgress({
              ratio,
              time: lastTime,
              duration: targetDur,
              message: `Remuxing: ${Math.round(ratio * 100)}% (Faststart & duration fix)`
            });
          }
        }
      }
    };

    // Ensure Uint8Array
    const uint8Ts = tsData instanceof Uint8Array ? tsData : new Uint8Array(tsData);

    const inputName = 'in.ts';
    const outputName = 'out.mp4';

    try {
      // 1. Write input TS into Emscripten virtual filesystem
      core.FS.writeFile(inputName, uint8Ts);

      // 2. Prepare command arguments: -fflags +genpts -i in.ts -c copy -movflags +faststart out.mp4
      const args = [
        'ffmpeg',
        '-nostdin',
        '-y',
        '-fflags', '+genpts',
        '-i', inputName,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputName
      ];

      const ffmpegMain = core.cwrap('main', 'number', ['number', 'number']);
      const [argc, argvPtr] = parseArgs(core, args);

      try {
        ffmpegMain(argc, argvPtr);
      } catch (err) {
        // Emscripten calls exit(0) on completion, which throws ExitStatus
        const isExitZero = (err && (err.status === 0 || err.name === 'ExitStatus' || (err.message && err.message.includes('exit(0)'))));
        if (!isExitZero) {
          throw new Error(`FFmpeg remux process error: ${err.message || err}`);
        }
      } finally {
        freeArgs(core, argc, argvPtr);
      }

      // 3. Read back resulting MP4
      const mp4Data = core.FS.readFile(outputName);
      if (!mp4Data || mp4Data.byteLength === 0) {
        throw new Error('Remux produced an empty or invalid MP4 output.');
      }

      const finalDuration = detectedDuration > 0 ? detectedDuration : lastTime;
      onProgress({
        ratio: 1.0,
        time: finalDuration,
        duration: finalDuration,
        message: 'Remux complete (moov atom faststart positioned)'
      });

      return {
        mp4Data,
        duration: finalDuration,
        logs
      };
    } finally {
      // 4. Clean up virtual filesystem to free memory
      try {
        core.FS.unlink(inputName);
      } catch (_) {}
      try {
        core.FS.unlink(outputName);
      } catch (_) {}
      core._currentOnStdout = null;
      core._currentOnStderr = null;
    }
  }

  return {
    loadCore,
    remuxTsToMp4,
    timeStringToSeconds
  };
});
