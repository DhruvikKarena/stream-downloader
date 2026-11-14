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
    const api = factory();
    root.FFmpegRemuxer = api;
    root.FfmpegRemuxEngine = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let coreInstance = null;
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
          const cleanPath = path.startsWith('lib/') ? path : 'lib/' + path;
          return chrome.runtime.getURL(cleanPath);
        }
        if (typeof window !== 'undefined' && window.location) {
          const cleanPath = path.startsWith('lib/') ? path : 'lib/' + path;
          return new URL(cleanPath, window.location.href).href;
        }
        return (prefix || '') + path;
      };

      let core = null;
      core = await coreFactory({
        locateFile,
        print: (msg) => {
          console.log('[ffmpeg stdout]', msg);
          if (core && core._currentOnStdout) core._currentOnStdout(msg);
        },
        printErr: (msg) => {
          console.log('[ffmpeg stderr]', msg);
          if (core && core._currentOnStderr) core._currentOnStderr(msg);
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
      console.log('[ffmpeg stdout]', msg);
      onLog(msg);
    };

    core._currentOnStderr = (msg) => {
      logs.push(msg);
      console.log('[ffmpeg stderr]', msg);
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

    // Pass copies (slice()) to ffmpeg.writeFile & log input size
    const uint8Ts = (tsData instanceof Uint8Array ? tsData : new Uint8Array(tsData)).slice();
    const inputSize = uint8Ts.byteLength;
    console.log(`[FFmpegRemuxer] Input size for in.ts: ${inputSize} bytes (${(inputSize / (1024 * 1024)).toFixed(2)} MB)`);

    const inputName = 'in.ts';
    const outputName = 'out.mp4';

    try {
      // Clean up previous files if any
      try { core.FS.unlink(inputName); } catch (_) {}
      try { core.FS.unlink(outputName); } catch (_) {}

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

      let retCode = 0;
      try {
        const res = ffmpegMain(argc, argvPtr);
        if (typeof res === 'number') {
          retCode = res;
        }
      } catch (err) {
        // Emscripten calls exit(0) on completion, which throws ExitStatus
        if (err && typeof err.status === 'number') {
          retCode = err.status;
        } else if (err && err.name === 'ExitStatus') {
          retCode = typeof err.status === 'number' ? err.status : 0;
        } else if (err === 'unwind' || (err && err.message && err.message.includes('exit(0)'))) {
          retCode = 0;
        } else {
          throw new Error(`FFmpeg remux process error: ${err.message || err}`);
        }
      } finally {
        freeArgs(core, argc, argvPtr);
      }

      console.log(`[FFmpegRemuxer] ffmpeg exec() return code: ${retCode}`);
      if (retCode !== 0) {
        throw new Error(`FFmpeg remux exited with non-zero return code: ${retCode}`);
      }

      // 3. Read back resulting MP4
      const mp4Data = core.FS.readFile(outputName);
      const outputSize = mp4Data ? mp4Data.byteLength : 0;
      console.log(`[FFmpegRemuxer] Output size for ${outputName}: ${outputSize} bytes (${(outputSize / (1024 * 1024)).toFixed(2)} MB)`);

      const ONE_MB = 1024 * 1024;
      if (!mp4Data || outputSize === 0) {
        throw new Error('Remux output is empty. No MP4 data was generated.');
      }
      // If input was substantial (>= 1MB), output shouldn't be suspiciously tiny (e.g. 224-byte header only)
      if (inputSize >= ONE_MB && outputSize < ONE_MB) {
        throw new Error(`Remux output is under 1 MB (${outputSize} bytes) while input was ${(inputSize / ONE_MB).toFixed(2)} MB. Incomplete MP4 generated.`);
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
      try { core.FS.unlink(inputName); } catch (_) {}
      try { core.FS.unlink(outputName); } catch (_) {}
      core._currentOnStdout = null;
      core._currentOnStderr = null;
    }
  }

  /**
   * Combine separate video track and audio track into a single MP4:
   *   -fflags +genpts -i video.ts -i audio.ts -map 0:v:0 -map 1:a:0 -c copy -movflags +faststart out.mp4
   */
  async function mergeVideoAndAudio(videoBuffer, audioBuffer, options = {}) {
    const core = await loadCore(options);
    const onProgress = options.onProgress || (() => {});
    const onLog = options.onLog || (() => {});
    const expectedDuration = options.expectedDuration || 0;

    const logs = [];
    let detectedDuration = 0;
    let lastTime = 0;

    core._currentOnStdout = (msg) => {
      logs.push(msg);
      console.log('[ffmpeg stdout]', msg);
      onLog(msg);
    };

    core._currentOnStderr = (msg) => {
      logs.push(msg);
      console.log('[ffmpeg stderr]', msg);
      onLog(msg);

      if (typeof msg === 'string') {
        if (msg.includes('Duration:')) {
          const match = msg.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
          if (match && match[1]) {
            detectedDuration = timeStringToSeconds(match[1]);
          }
        }
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
              message: `Merging tracks: ${Math.round(ratio * 100)}%`
            });
          }
        }
      }
    };

    const uint8Video = (videoBuffer instanceof Uint8Array ? videoBuffer : new Uint8Array(videoBuffer)).slice();
    const uint8Audio = (audioBuffer instanceof Uint8Array ? audioBuffer : new Uint8Array(audioBuffer)).slice();
    const videoInputSize = uint8Video.byteLength;
    const audioInputSize = uint8Audio.byteLength;
    console.log(`[FFmpegRemuxer] Video input size: ${videoInputSize} bytes, Audio input size: ${audioInputSize} bytes`);

    const videoName = 'video.ts';
    const audioName = 'audio.ts';
    const outputName = 'out.mp4';

    try {
      try { core.FS.unlink(videoName); } catch (_) {}
      try { core.FS.unlink(audioName); } catch (_) {}
      try { core.FS.unlink(outputName); } catch (_) {}

      core.FS.writeFile(videoName, uint8Video);
      core.FS.writeFile(audioName, uint8Audio);

      const args = [
        'ffmpeg',
        '-nostdin',
        '-y',
        '-fflags', '+genpts',
        '-i', videoName,
        '-i', audioName,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c', 'copy',
        '-movflags', '+faststart',
        outputName
      ];

      const ffmpegMain = core.cwrap('main', 'number', ['number', 'number']);
      const [argc, argvPtr] = parseArgs(core, args);

      let retCode = 0;
      try {
        const res = ffmpegMain(argc, argvPtr);
        if (typeof res === 'number') retCode = res;
      } catch (err) {
        if (err && typeof err.status === 'number') {
          retCode = err.status;
        } else if (err && err.name === 'ExitStatus') {
          retCode = typeof err.status === 'number' ? err.status : 0;
        } else if (err === 'unwind' || (err && err.message && err.message.includes('exit(0)'))) {
          retCode = 0;
        } else {
          throw new Error(`FFmpeg merge process error: ${err.message || err}`);
        }
      } finally {
        freeArgs(core, argc, argvPtr);
      }

      console.log(`[FFmpegRemuxer] ffmpeg merge exec() return code: ${retCode}`);
      if (retCode !== 0) {
        throw new Error(`FFmpeg merge exited with non-zero return code: ${retCode}`);
      }

      const mp4Data = core.FS.readFile(outputName);
      const outputSize = mp4Data ? mp4Data.byteLength : 0;
      console.log(`[FFmpegRemuxer] Merge output size: ${outputSize} bytes`);

      const ONE_MB = 1024 * 1024;
      if (!mp4Data || outputSize === 0) {
        throw new Error('Merge output is empty. No MP4 data was generated.');
      }
      if ((videoInputSize + audioInputSize) >= ONE_MB && outputSize < ONE_MB) {
        throw new Error(`Merge output is under 1 MB (${outputSize} bytes) while input was ${((videoInputSize + audioInputSize) / ONE_MB).toFixed(2)} MB.`);
      }

      const finalDuration = detectedDuration > 0 ? detectedDuration : lastTime;
      onProgress({
        ratio: 1.0,
        time: finalDuration,
        duration: finalDuration,
        message: 'Merge complete'
      });

      return {
        mp4Data,
        duration: finalDuration,
        logs
      };
    } finally {
      try { core.FS.unlink(videoName); } catch (_) {}
      try { core.FS.unlink(audioName); } catch (_) {}
      try { core.FS.unlink(outputName); } catch (_) {}
      core._currentOnStdout = null;
      core._currentOnStderr = null;
    }
  }

  return {
    loadCore,
    remuxTsToMp4,
    remuxSingleTrack: remuxTsToMp4,
    mergeVideoAndAudio,
    timeStringToSeconds
  };
});
