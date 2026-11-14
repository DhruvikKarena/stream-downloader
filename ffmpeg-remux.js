/**
 * FFmpeg Remuxer & Track Merger Module (ffmpeg-remux.js)
 *
 * Re-exports the core remuxing engine from lib/ffmpeg-remuxer.js, ensuring
 * unified behavior across both module entry points and direct browser script tags.
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const engine = factory();
    root.FfmpegRemuxEngine = engine;
    root.FFmpegRemuxer = engine;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Check if FFmpegRemuxer is already defined globally from lib/ffmpeg-remuxer.js
  if (typeof self !== 'undefined' && self.FFmpegRemuxer) {
    return self.FFmpegRemuxer;
  }
  if (typeof window !== 'undefined' && window.FFmpegRemuxer) {
    return window.FFmpegRemuxer;
  }

  // Node environment: load lib/ffmpeg-remuxer.js
  try {
    return require('./lib/ffmpeg-remuxer.js');
  } catch (_) {}

  return null;
});
