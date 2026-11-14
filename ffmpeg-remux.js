/**
 * FFmpeg Remuxer & Track Merger Module (ffmpeg-remux.js)
 *
 * Lazy-loads ffmpeg.wasm from locally bundled files (lib/ffmpeg-core.js, lib/ffmpeg-core.wasm)
 * using chrome.runtime.getURL (zero CDN).
 *
 * Capabilities:
 *  1. Single-track remux:
 *     -fflags +genpts -i in.ts -c copy -avoid_negative_ts make_zero -movflags +faststart out.mp4
 *  2. Dual-track video + separate audio merge:
 *     -fflags +genpts -i video.ts -i audio.ts -map 0:v:0 -map 1:a:0 -c copy -avoid_negative_ts make_zero -movflags +faststart out.mp4
 *  3. Accurate duration detection and progress reporting.
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FfmpegRemuxEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let coreInstance = null;
  let coreLoadPromise = null;

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

  function freeArgs(core, argc, argvPtr) {
    try {
      for (let i = 0; i < argc; i++) {
        const ptr = core.HEAPU32 ? core.HEAPU32[(argvPtr >> 2) + i] : (core.getValue ? core.getValue(argvPtr + (Uint32Array.BYTES_PER_ELEMENT * i), 'i32') : 0);
        if (ptr) core._free(ptr);
      }
      core._free(argvPtr);
    } catch (e) {
      console.warn('[FfmpegRemuxEngine] Error freeing args:', e);
    }
  }

  /**
   * Lazy load local Emscripten ffmpeg-core instance.
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
        try {
          coreFactory = require('./lib/ffmpeg-core.js');
        } catch (e) {
          throw new Error('createFFmpegCore is not loaded. Ensure lib/ffmpeg-core.js is included.');
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
   * Run an arbitrary ffmpeg CLI command with stdout/stderr interceptors.
   */
  async function executeFfmpegCommand(args, options = {}) {
    const core = await loadCore(options);
    const onProgress = options.onProgress || (() => {});
    const onLog = options.onLog || (() => {});
    const expectedDuration = options.expectedDuration || 0;

    const logs = [];
    let detectedDuration = 0;
    let lastTime = 0;

    core._currentOnStdout = (msg) => {
      logs.push(msg);
      onLog(msg);
    };

    core._currentOnStderr = (msg) => {
      logs.push(msg);
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
              message: `Remuxing: ${Math.round(ratio * 100)}% (Faststart & duration fix)`
            });
          }
        }
      }
    };

    const fullArgs = ['ffmpeg', '-nostdin', '-y', ...args];
    const ffmpegMain = core.cwrap('main', 'number', ['number', 'number']);
    const [argc, argvPtr] = parseArgs(core, fullArgs);

    try {
      ffmpegMain(argc, argvPtr);
    } catch (err) {
      const isExitZero = (err && (err.status === 0 || err.name === 'ExitStatus' || (err.message && err.message.includes('exit(0)'))));
      if (!isExitZero) {
        throw new Error(`FFmpeg remux process error: ${err.message || err}`);
      }
    } finally {
      freeArgs(core, argc, argvPtr);
      core._currentOnStdout = null;
      core._currentOnStderr = null;
    }

    const finalDuration = detectedDuration > 0 ? detectedDuration : lastTime;
    onProgress({
      ratio: 1.0,
      time: finalDuration,
      duration: finalDuration,
      message: 'Remux complete (faststart moov positioned)'
    });

    return {
      duration: finalDuration,
      logs
    };
  }

  /**
   * Remux a single stream file (e.g. concatenated TS or fragmented MP4):
   *   -fflags +genpts -i in -c copy -avoid_negative_ts make_zero -movflags +faststart out.mp4
   */
  async function remuxSingleTrack(inputBuffer, options = {}) {
    const core = await loadCore(options);
    const inputExt = options.inputExt || 'ts';
    const inputName = `in.${inputExt}`;
    const outputName = 'out.mp4';

    const uint8 = inputBuffer instanceof Uint8Array ? inputBuffer : new Uint8Array(inputBuffer);

    try {
      core.FS.writeFile(inputName, uint8);

      const args = [
        '-fflags', '+genpts',
        '-i', inputName,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        outputName
      ];

      const execResult = await executeFfmpegCommand(args, options);
      const mp4Data = core.FS.readFile(outputName);

      if (!mp4Data || mp4Data.byteLength === 0) {
        throw new Error('Remux produced an empty or invalid MP4 output.');
      }

      return {
        mp4Data,
        duration: execResult.duration,
        logs: execResult.logs
      };
    } finally {
      try { core.FS.unlink(inputName); } catch (_) {}
      try { core.FS.unlink(outputName); } catch (_) {}
    }
  }

  /**
   * Combine separate video track and audio track into a single MP4:
   *   -fflags +genpts -i video -i audio -map 0:v:0 -map 1:a:0 -c copy -avoid_negative_ts make_zero -movflags +faststart out.mp4
   */
  async function mergeVideoAndAudio(videoBuffer, audioBuffer, options = {}) {
    const core = await loadCore(options);
    const videoExt = options.videoExt || 'ts';
    const audioExt = options.audioExt || 'ts';
    const videoName = `video.${videoExt}`;
    const audioName = `audio.${audioExt}`;
    const outputName = 'out.mp4';

    const uint8Video = videoBuffer instanceof Uint8Array ? videoBuffer : new Uint8Array(videoBuffer);
    const uint8Audio = audioBuffer instanceof Uint8Array ? audioBuffer : new Uint8Array(audioBuffer);

    try {
      core.FS.writeFile(videoName, uint8Video);
      core.FS.writeFile(audioName, uint8Audio);

      const args = [
        '-fflags', '+genpts',
        '-i', videoName,
        '-i', audioName,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        outputName
      ];

      const execResult = await executeFfmpegCommand(args, options);
      const mp4Data = core.FS.readFile(outputName);

      if (!mp4Data || mp4Data.byteLength === 0) {
        throw new Error('Merging video and audio produced an empty MP4 output.');
      }

      return {
        mp4Data,
        duration: execResult.duration,
        logs: execResult.logs
      };
    } finally {
      try { core.FS.unlink(videoName); } catch (_) {}
      try { core.FS.unlink(audioName); } catch (_) {}
      try { core.FS.unlink(outputName); } catch (_) {}
    }
  }

  return {
    loadCore,
    remuxSingleTrack,
    mergeVideoAndAudio,
    executeFfmpegCommand,
    timeStringToSeconds
  };
});
