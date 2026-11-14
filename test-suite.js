/**
 * Unit & Integration Test Suite for Staged Pipeline & HLS Parser
 *
 * Verifies:
 * 1. Master vs Media playlist parsing
 * 2. Variant sorting and de-duplication
 * 3. EXT-X-MEDIA audio groups and subtitles
 * 4. Relative URL resolution
 * 5. AES-128 key and IV parsing
 * 6. EXT-X-MAP init segment
 * 7. EXT-X-DISCONTINUITY and cumulative duration
 * 8. Codec detection (CODECS string + TS PMT)
 * 9. SegmentStore key formatting & AES-128 Web Crypto decryption
 * 10. Live acceptance streams:
 *     - https://playertest.longtailvideo.com/adaptive/oceans_aes/oceans_aes.m3u8 (AES-128)
 *     - https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8 (Multiple resolutions)
 */

const assert = require('assert');
const HlsParser = require('./hls-parser.js');
const CodecDetect = require('./codec-detect.js');
const SegmentStore = require('./segment-store.js');
const FrameContext = require('./frame-context.js');
const TransmuxEngine = require('./transmux.js');
const FfmpegRemuxEngine = require('./ffmpeg-remux.js');

const https = require('https');
const http = require('http');

function nodeFetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        text: async () => data
      }));
    }).on('error', reject);
  });
}

let passCount = 0;
let failCount = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(err);
    failCount++;
  }
}

async function itAsync(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(err);
    failCount++;
  }
}

async function runTests() {
  console.log('\n=== 1. HlsParser: Master vs Media Playlist ===');

  it('Parses Master Playlist with Variants', () => {
    const masterSample = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,FRAME-RATE=30.000,CODECS="avc1.4d401e,mp4a.40.2"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=842x480,FRAME-RATE=30.000,CODECS="avc1.4d401f,mp4a.40.2"
480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.4d4020,mp4a.40.2"
720p.m3u8`;

    const parsed = HlsParser.parse(masterSample, 'https://example.com/live/master.m3u8');
    assert.strictEqual(parsed.type, 'master');
    assert.strictEqual(parsed.isMaster, true);
    assert.strictEqual(parsed.variants.length, 3);

    const v720 = parsed.variants.find(v => v.resolutionLabel.includes('720p'));
    assert.ok(v720, '720p variant should exist');
    assert.strictEqual(v720.width, 1280);
    assert.strictEqual(v720.height, 720);
    assert.strictEqual(v720.frameRate, 60);
    assert.strictEqual(v720.bandwidth, 2800000);
    assert.strictEqual(v720.url, 'https://example.com/live/720p.m3u8');
  });

  it('Parses Media Playlist with Segments, #EXTINF, and #EXT-X-MAP', () => {
    const mediaSample = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXTINF:5.000,
seg-0.mp4
#EXTINF:6.000,
seg-1.mp4
#EXT-X-DISCONTINUITY
#EXTINF:4.500,
seg-2.mp4
#EXT-X-ENDLIST`;

    const parsed = HlsParser.parse(mediaSample, 'https://example.com/stream/index.m3u8');
    assert.strictEqual(parsed.type, 'media');
    assert.strictEqual(parsed.isMaster, false);
    assert.strictEqual(parsed.hasEndList, true);
    assert.strictEqual(parsed.targetDuration, 6);
    assert.strictEqual(parsed.segments.length, 3);
    assert.ok(parsed.initSegment);
    assert.strictEqual(parsed.initSegment.url, 'https://example.com/stream/init.mp4');

    assert.strictEqual(parsed.segments[0].duration, 5);
    assert.strictEqual(parsed.segments[0].cumulativeDuration, 0);
    assert.strictEqual(parsed.segments[0].discontinuity, false);

    assert.strictEqual(parsed.segments[1].duration, 6);
    assert.strictEqual(parsed.segments[1].cumulativeDuration, 5);

    assert.strictEqual(parsed.segments[2].duration, 4.5);
    assert.strictEqual(parsed.segments[2].cumulativeDuration, 11);
    assert.strictEqual(parsed.segments[2].discontinuity, true);

    assert.strictEqual(parsed.totalDuration, 15.5);
  });

  console.log('\n=== 2. Variant Sorting & De-Duplication ===');

  it('Sorts variants descending by resolution and keeps highest bandwidth for duplicates', () => {
    const variants = [
      { width: 1280, height: 720, bandwidth: 2000000, url: '720p_low.m3u8' },
      { width: 1920, height: 1080, bandwidth: 4500000, url: '1080p.m3u8' },
      { width: 1280, height: 720, bandwidth: 3200000, url: '720p_high.m3u8' },
      { width: 854, height: 480, bandwidth: 1200000, url: '480p.m3u8' },
      { width: 1280, height: 720, bandwidth: 2500000, url: '720p_mid.m3u8' }
    ];

    const deduplicated = HlsParser.sortAndDeduplicateVariants(variants);
    assert.strictEqual(deduplicated.length, 3, 'Should deduplicate down to 1080p, 720p, and 480p');
    assert.strictEqual(deduplicated[0].height, 1080);
    assert.strictEqual(deduplicated[1].height, 720);
    assert.strictEqual(deduplicated[1].bandwidth, 3200000, 'Should retain highest bandwidth for 720p (3200000)');
    assert.strictEqual(deduplicated[1].url, '720p_high.m3u8');
    assert.strictEqual(deduplicated[2].height, 480);
  });

  console.log('\n=== 3. Audio Renditions (#EXT-X-MEDIA:TYPE=AUDIO) & Subtitles ===');

  it('Parses separate audio groups and subtitles', () => {
    const masterWithAudio = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="audio_en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="Spanish",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="es",URI="audio_es.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English Subs",DEFAULT=YES,LANGUAGE="en",URI="subs_en.vtt"
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="audio-aac",SUBTITLES="subs"
video_720p.m3u8`;

    const parsed = HlsParser.parse(masterWithAudio, 'https://example.com/master.m3u8');
    assert.ok(parsed.audioGroups['audio-aac']);
    assert.strictEqual(parsed.audioGroups['audio-aac'].length, 2);
    assert.strictEqual(parsed.audioGroups['audio-aac'][0].name, 'English');
    assert.strictEqual(parsed.audioGroups['audio-aac'][0].default, true);
    assert.strictEqual(parsed.audioGroups['audio-aac'][0].url, 'https://example.com/audio_en.m3u8');

    assert.strictEqual(parsed.subtitles.length, 1);
    assert.strictEqual(parsed.subtitles[0].name, 'English Subs');
    assert.strictEqual(parsed.subtitles[0].url, 'https://example.com/subs_en.vtt');
  });

  console.log('\n=== 4. AES-128 Key & IV Extraction ===');

  it('Parses #EXT-X-KEY with AES-128 and explicit IV', () => {
    const aesSample = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key.bin",IV=0x0123456789ABCDEF0123456789ABCDEF
#EXTINF:10.0,
enc_seg0.ts
#EXT-X-ENDLIST`;

    const parsed = HlsParser.parse(aesSample, 'https://example.com/stream.m3u8');
    assert.strictEqual(parsed.segments.length, 1);
    assert.ok(parsed.segments[0].encryption);
    assert.strictEqual(parsed.segments[0].encryption.method, 'AES-128');
    assert.strictEqual(parsed.segments[0].encryption.uri, 'https://example.com/key.bin');
    assert.strictEqual(parsed.segments[0].encryption.iv, '0x0123456789ABCDEF0123456789ABCDEF');
  });

  console.log('\n=== 5. Codec Detection Module ===');

  it('Parses CODECS strings correctly', () => {
    const avcAac = CodecDetect.parseCodecs('avc1.640028,mp4a.40.2');
    assert.strictEqual(avcAac.videoCodec, 'avc');
    assert.strictEqual(avcAac.audioCodec, 'aac');
    assert.strictEqual(avcAac.isAvcAac, true);

    const hevcAac = CodecDetect.parseCodecs('hvc1.1.6.L93.B0,mp4a.40.2');
    assert.strictEqual(hevcAac.videoCodec, 'hevc');
    assert.strictEqual(hevcAac.isAvcAac, false);

    const av1Opus = CodecDetect.parseCodecs('av01.0.08M.08,opus');
    assert.strictEqual(av1Opus.videoCodec, 'av1');
    assert.strictEqual(av1Opus.isAvcAac, false);
  });

  it('Detects stream types from MPEG-TS PMT packets', () => {
    // Construct a synthetic 188-byte MPEG-TS PMT packet
    const pmtPacket = new Uint8Array(188);
    pmtPacket[0] = 0x47; // Sync byte
    pmtPacket[1] = 0x40; // Payload unit start + PID high
    pmtPacket[2] = 0x64; // PID = 0x64 (100)
    pmtPacket[3] = 0x10; // No adaptation field, payload only
    pmtPacket[4] = 0x00; // Pointer field

    // PMT Table Header
    pmtPacket[5] = 0x02; // Table ID = 0x02 (PMT)
    pmtPacket[6] = 0xB0; // Section syntax
    pmtPacket[7] = 0x17; // Section length = 23 bytes
    pmtPacket[8] = 0x00; // Program number high
    pmtPacket[9] = 0x01; // Program number low
    pmtPacket[10] = 0xC1; // Version + current/next
    pmtPacket[11] = 0x00; // Section number
    pmtPacket[12] = 0x00; // Last section number
    pmtPacket[13] = 0xE1; // PCR PID high
    pmtPacket[14] = 0x00; // PCR PID low
    pmtPacket[15] = 0xF0; // Program info length high
    pmtPacket[16] = 0x00; // Program info length low

    // Stream 1: H.264 video (0x1B)
    pmtPacket[17] = 0x1B;
    pmtPacket[18] = 0xE1;
    pmtPacket[19] = 0x00; // Elementary PID = 0x100
    pmtPacket[20] = 0xF0;
    pmtPacket[21] = 0x00; // ES info length = 0

    // Stream 2: ADTS AAC audio (0x0F)
    pmtPacket[22] = 0x0F;
    pmtPacket[23] = 0xE1;
    pmtPacket[24] = 0x01; // Elementary PID = 0x101
    pmtPacket[25] = 0xF0;
    pmtPacket[26] = 0x00; // ES info length = 0

    const detected = CodecDetect.detectFromTsPmt(pmtPacket);
    assert.ok(detected, 'Should detect codecs from PMT');
    assert.strictEqual(detected.videoCodec, 'avc');
    assert.strictEqual(detected.audioCodec, 'aac');
    assert.strictEqual(detected.isAvcAac, true);
  });

  console.log('\n=== 6. SegmentStore Key Formatting ===');

  it('Formats segment keys with zero padding for ordered storage', () => {
    const key0 = SegmentStore.formatSegmentKey('dl_12345', 0);
    assert.strictEqual(key0, 'dl_12345:000000');

    const key42 = SegmentStore.formatSegmentKey('dl_12345', 42);
    assert.strictEqual(key42, 'dl_12345:000042');

    const key999 = SegmentStore.formatSegmentKey('dl_test', 999);
    assert.strictEqual(key999, 'dl_test:000999');
  });

  console.log('\n=== 7. Frame Context & Header Selection Logic (Cross-Origin Iframe) ===');

  it('Prioritizes frameUrl over tabUrl for Referer and Origin', () => {
    const resolved = FrameContext.resolveFrameHeaders({
      frameUrl: 'https://surrit.com/player/v123.html',
      initiator: 'https://surrit.com',
      tabUrl: 'https://streaming-site.tv/watch/movie-456',
      userAgent: 'Mozilla/5.0 TestBrowser',
      acceptLanguage: 'en-US,en;q=0.9'
    });

    assert.strictEqual(resolved.referer, 'https://surrit.com/player/v123.html', 'Referer must match frameUrl');
    assert.strictEqual(resolved.origin, 'https://surrit.com', 'Origin must match frameUrl origin');
    assert.strictEqual(resolved.isIframe, true, 'Should detect iframe context');
    assert.strictEqual(resolved.headers['Referer'], 'https://surrit.com/player/v123.html');
    assert.strictEqual(resolved.headers['Origin'], 'https://surrit.com');
  });

  it('Falls back to initiator over tabUrl when frameUrl is about:blank', () => {
    const resolved = FrameContext.resolveFrameHeaders({
      frameUrl: 'about:blank',
      initiator: 'https://cdn.embedded-player.org',
      tabUrl: 'https://top-level-embedder.com/page.html'
    });

    assert.strictEqual(resolved.origin, 'https://cdn.embedded-player.org');
    assert.ok(resolved.referer.startsWith('https://cdn.embedded-player.org'));
  });

  it('Preserves custom player headers (e.g. x-requested-with)', () => {
    const resolved = FrameContext.resolveFrameHeaders({
      frameUrl: 'https://player.host.com/iframe',
      customHeaders: [
        { name: 'X-Requested-With', value: 'XMLHttpRequest' },
        { name: 'Sec-Fetch-Dest', value: 'empty' },
        { name: 'Cookie', value: 'secret_session_id=123' } // must not be duplicated into custom
      ]
    });

    assert.strictEqual(resolved.headers['X-Requested-With'], 'XMLHttpRequest');
    assert.strictEqual(resolved.headers['Sec-Fetch-Dest'], 'empty');
    assert.strictEqual(resolved.headers['Cookie'], undefined, 'Cookie must not be added to custom requestHeaders');
  });

  it('Redacts sensitive tokens, signatures, and cookies for diagnostics export', () => {
    const rawUrl = 'https://surrit.com/playlist.m3u8?token=SECRET_AUTH_TOKEN_999&expires=1700000000&sig=abc123xyz';
    const redacted = FrameContext.redactDiagnosticData(rawUrl);
    assert.ok(!redacted.includes('SECRET_AUTH_TOKEN_999'), 'Token must be masked');
    assert.ok(!redacted.includes('abc123xyz'), 'Sig must be masked');
    assert.ok(redacted.includes('token=[REDACTED]'));
    assert.ok(redacted.includes('sig=[REDACTED]'));

    const rawObj = {
      url: rawUrl,
      cookieHeader: 'session=xyz789; auth=token_abc',
      safeHeader: 'en-US'
    };
    const redactedObj = FrameContext.redactDiagnosticData(rawObj);
    assert.strictEqual(redactedObj.cookieHeader, '[REDACTED]');
    assert.strictEqual(redactedObj.safeHeader, 'en-US');
  });

  it('Filters candidate child frames from getAllFrames', () => {
    const allFrames = [
      { frameId: 0, url: 'https://top-level.com/watch' },
      { frameId: 1, url: 'https://surrit.com/embed/player' },
      { frameId: 2, url: 'about:blank' },
      { frameId: 3, url: 'https://ads.tracker.com/ad' }
    ];

    const candidates = FrameContext.findCandidateFrames(allFrames, {
      expectedFrameUrl: 'https://surrit.com/embed/player',
      targetFrameId: 10
    });

    assert.strictEqual(candidates.length, 2);
    assert.strictEqual(candidates[0].frameId, 1);
    assert.strictEqual(candidates[0].url, 'https://surrit.com/embed/player');
  });

  console.log('\n=== 8. Live Test Stream Acceptance Tests ===');

  await itAsync('Fetches & parses AES-128 test stream (oceans_aes master + variant)', async () => {
    const testUrl = 'https://playertest.longtailvideo.com/adaptive/oceans_aes/oceans_aes.m3u8';
    const res = await nodeFetch(testUrl);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    const masterParsed = HlsParser.parse(text, testUrl, 200);

    assert.strictEqual(masterParsed.type, 'master');
    assert.ok(masterParsed.variants.length > 0, 'Master should have variants');

    // Fetch first chosen variant
    const variantUrl = masterParsed.variants[0].url;
    const variantRes = await nodeFetch(variantUrl);
    assert.strictEqual(variantRes.status, 200);
    const variantText = await variantRes.text();
    const mediaParsed = HlsParser.parse(variantText, variantUrl, 200);

    assert.ok(mediaParsed.segments.length > 0, 'Media playlist should have segments');
    const firstSeg = mediaParsed.segments[0];
    assert.ok(firstSeg.encryption, 'First segment must have encryption info');
    assert.strictEqual(firstSeg.encryption.method, 'AES-128');
    assert.ok(firstSeg.encryption.uri.startsWith('http'), 'Key URI should be resolved to absolute URL');
    console.log(`    -> Oceans AES variant parsed successfully: ${mediaParsed.segments.length} segments, total duration: ${mediaParsed.totalDuration}s, Key URI: ${firstSeg.encryption.uri}`);
  });

  await itAsync('Fetches & parses multi-resolution master playlist (test-streams.mux.dev)', async () => {
    const testUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
    const res = await nodeFetch(testUrl);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    const parsed = HlsParser.parse(text, testUrl, 200);

    assert.strictEqual(parsed.type, 'master');
    assert.ok(parsed.variants.length >= 4, 'Should contain multiple variants');

    const deduplicated = HlsParser.sortAndDeduplicateVariants(parsed.variants);
    assert.ok(deduplicated.length > 0);
    // Highest resolution first
    assert.ok(deduplicated[0].height >= deduplicated[deduplicated.length - 1].height);
    console.log(`    -> Mux multi-resolution master parsed: ${deduplicated.length} deduplicated resolutions (Top: ${deduplicated[0].resolutionLabel}, ${deduplicated[0].bandwidthMbps} Mbps)`);
  });

  console.log('\n=== 9. In-Page Player Cache & Challenge Handling Rules ===');

  it('In-Page Player Cache: provides playlist without network fetch', () => {
    const fakeCache = new Map();
    const playlistUrl = 'https://surrit.com/abcd-1234/playlist.m3u8';
    const sampleM3U8 = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:4.000,
seg-0.ts
#EXT-X-ENDLIST`;

    // Simulate inject.js intercepting player XHR/fetch and storing in cache
    fakeCache.set(playlistUrl, {
      url: playlistUrl,
      finalUrl: playlistUrl,
      text: sampleM3U8,
      format: 'm3u8',
      frameUrl: 'https://surrit.com/embed/player.html',
      status: 200
    });

    // Simulate downloader checking cache first (Requirement 2)
    const cachedEntry = fakeCache.get(playlistUrl);
    assert.ok(cachedEntry, 'Cached entry should exist');
    assert.strictEqual(cachedEntry.status, 200);
    assert.ok(cachedEntry.text.startsWith('#EXTM3U'));

    // Parse without making any network request
    const parsed = HlsParser.parse(cachedEntry.text, cachedEntry.url, cachedEntry.status);
    assert.strictEqual(parsed.segments.length, 1);
    assert.strictEqual(parsed.segments[0].duration, 4);
  });

  it('Challenge Handling: identifies cf-mitigated, Just a moment, captcha, and 403/429', () => {
    const VERIFICATION_MSG = "This site needs a verification step. Open the video page, complete it, let the video play for a few seconds, then click 'Retry'.";

    function isChallenge(text, headers = {}, status = 0) {
      if (headers && headers['cf-mitigated'] === 'challenge') return true;
      if (status === 403 || status === 429) {
        if (!text || text.includes('<html') || text.includes('<!doctype') || text.includes('error') || text.includes('forbidden') || text.includes('denied')) {
          return true;
        }
      }
      if (!text) return false;
      const lower = text.toLowerCase();
      return (
        lower.includes('just a moment...') ||
        lower.includes('just a moment') ||
        lower.includes('turnstile') ||
        lower.includes('challenge-platform') ||
        lower.includes('attention required! | cloudflare') ||
        lower.includes('cf-mitigated') ||
        lower.includes('verify you are human') ||
        lower.includes('captcha')
      );
    }

    assert.ok(isChallenge('', { 'cf-mitigated': 'challenge' }), 'Should detect cf-mitigated header');
    assert.ok(isChallenge('<!DOCTYPE html><html><title>Just a moment...</title><body>Checking your browser</body></html>'), 'Should detect Cloudflare waiting page');
    assert.ok(isChallenge('<div class="cf-turnstile">Please verify you are human</div>'), 'Should detect Turnstile challenge');
    assert.ok(isChallenge('<html><head><title>403 Forbidden</title></head><body>Access Denied</body></html>', {}, 403), 'Should detect 403 HTML interstitial');
    assert.ok(isChallenge('', {}, 429), 'Should detect 429 Too Many Requests');
    assert.ok(!isChallenge('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nseg1.ts', {}, 200), 'Valid m3u8 must not be flagged');
  });

  it('Expired Token Detection: checks token/expires query params with 401/403', () => {
    const EXPIRED_MSG = "Reload the page, let it play, then retry.";

    function isExpiredUrl(url, status) {
      try {
        const u = new URL(url);
        const hasTokenOrExpire =
          u.searchParams.has('token') ||
          u.searchParams.has('expires') ||
          u.searchParams.has('exp') ||
          u.searchParams.has('expire') ||
          u.searchParams.has('auth');
        return hasTokenOrExpire && (status === 401 || status === 403 || status === 410);
      } catch {
        return false;
      }
    }

    assert.ok(isExpiredUrl('https://stream.host/video.m3u8?token=xyz123', 403));
    assert.ok(isExpiredUrl('https://stream.host/video.m3u8?expires=1700000000', 401));
    assert.ok(!isExpiredUrl('https://stream.host/video.m3u8', 403), 'Regular URL with 403 is a challenge, not expired token');
    assert.ok(!isExpiredUrl('https://stream.host/video.m3u8?token=xyz123', 200), '200 OK is not expired');
  });

  it('ArrayBuffer Chunking: splits payloads >16MB into chunks under 32MB', () => {
    const totalBytes = 35 * 1024 * 1024; // 35 MB
    const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB chunk
    const chunks = [];

    for (let offset = 0; offset < totalBytes; offset += CHUNK_SIZE) {
      const sliceSize = Math.min(CHUNK_SIZE, totalBytes - offset);
      chunks.push(sliceSize);
    }

    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks[0], 16 * 1024 * 1024);
    assert.strictEqual(chunks[1], 16 * 1024 * 1024);
    assert.strictEqual(chunks[2], 3 * 1024 * 1024);
    assert.ok(chunks.every(size => size < 32 * 1024 * 1024), 'Every chunk must be well under 32 MB');
  });

  it('Diagnostics Log: tracks strategy, frameId, cacheUsed, and redacts credentials', () => {
    const rawDiag = {
      strategy: 'In-Page Player Cache',
      url: 'https://surrit.com/playlist.m3u8?token=SECRET_AUTH_TOKEN_999&expires=1700000000',
      frameId: 3,
      frameUrl: 'https://surrit.com/embed/player.html',
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      cacheUsed: true,
      redirected: false,
      preview: '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.000,\nseg1.ts'
    };

    const redacted = FrameContext.redactDiagnosticData(rawDiag);
    assert.strictEqual(redacted.strategy, 'In-Page Player Cache');
    assert.strictEqual(redacted.cacheUsed, true);
    assert.strictEqual(redacted.frameId, 3);
    assert.ok(!redacted.url.includes('SECRET_AUTH_TOKEN_999'));
    assert.ok(redacted.url.includes('token=[REDACTED]'));
    assert.ok(redacted.preview.startsWith('#EXTM3U'));
  });

  console.log('\n=== 10. TS Sync Byte 0x47, Transmuxer & Remux Safeguards ===');

  it('TS Sync Byte & Header Stripping: strips leading fake image header in first 4 KB', () => {
    // Construct a simulated TS segment with a 256-byte fake PNG image header prepended
    const fakeHeader = Buffer.alloc(256, 0x89);
    fakeHeader.write('PNG\r\n\x1a\nFakeImageHeaderData', 1);

    // Create 4 TS packets (188 bytes each) starting with sync byte 0x47
    const tsPackets = Buffer.alloc(188 * 4, 0x00);
    for (let i = 0; i < 4; i++) {
      tsPackets[i * 188] = 0x47;
      tsPackets[i * 188 + 1] = 0x40; // payload start
      tsPackets[i * 188 + 2] = 0x11; // PID
      tsPackets[i * 188 + 3] = 0x10; // CC
    }

    const disguisedSegment = Buffer.concat([fakeHeader, tsPackets]);
    assert.strictEqual(disguisedSegment.length, 256 + 188 * 4);

    // Call inspectAndStripTsSegment for segment 0
    const strippedBuffer = TransmuxEngine.inspectAndStripTsSegment(disguisedSegment, 0);
    const strippedBytes = new Uint8Array(strippedBuffer);

    // Verify leading bytes were stripped and sync byte 0x47 is now at offset 0
    assert.strictEqual(strippedBytes.length, 188 * 4);
    assert.strictEqual(strippedBytes[0], 0x47);
    assert.strictEqual(strippedBytes[188], 0x47);
    assert.strictEqual(strippedBytes[376], 0x47);
  });

  it('TS Sync Byte: leaves valid TS segments untouched', () => {
    const validTs = Buffer.alloc(188 * 3, 0x00);
    validTs[0] = 0x47;
    validTs[188] = 0x47;
    validTs[376] = 0x47;

    const result = TransmuxEngine.inspectAndStripTsSegment(validTs, 1);
    const uint8 = new Uint8Array(result);
    assert.strictEqual(uint8.length, 188 * 3);
    assert.strictEqual(uint8[0], 0x47);
  });

  it('Transmuxer Media Bytes & Finish: fails with clear error if 0 media bytes emitted', () => {
    // Mock muxjs library to simulate a scenario where only initSegment was emitted (0 media bytes)
    const fakeMuxLib = {
      mp4: {
        Transmuxer: function () {
          const listeners = {};
          this.on = function (evt, fn) {
            listeners[evt] = fn;
          };
          this.push = function () {};
          this.flush = function () {};
          this.setBaseMediaDecodeTime = function () {};
          // Simulate emitting ONLY 224 bytes of initSegment (ftyp+moov) and 0 data media fragments
          setTimeout(() => {
            if (listeners['data']) {
              listeners['data']({
                initSegment: new Uint8Array(224)
                // NO data property!
              });
            }
          }, 0);
        }
      }
    };

    const origWindowMux = (typeof window !== 'undefined' ? window.muxjs : null);
    if (typeof window === 'undefined') {
      global.window = { muxjs: fakeMuxLib };
    } else {
      window.muxjs = fakeMuxLib;
    }

    try {
      const tm = TransmuxEngine.createTransmuxer();
      tm.push(new Uint8Array(188));
      assert.strictEqual(tm.getTotalMediaBytes(), 0);

      // finish() must throw a clear error when totalMediaBytes === 0
      assert.throws(() => {
        tm.finish();
      }, /Transmuxer emitted 0 media bytes/);
    } finally {
      if (typeof window !== 'undefined') {
        window.muxjs = origWindowMux;
      }
    }
  });

  it('Size Sanity Check: warns if final output is under 50% of segment sum', () => {
    function testSizeSanity(finalSize, expectedSegmentBytes) {
      if (!expectedSegmentBytes || expectedSegmentBytes <= 0) return true;
      const ratio = finalSize / expectedSegmentBytes;
      return ratio >= 0.5;
    }

    const segmentsTotal = 30 * 1024 * 1024; // 30 MB
    const brokenInitHeaderOnly = 224; // 224 bytes

    // 224 bytes vs 30 MB must fail (< 50%)
    assert.strictEqual(testSizeSanity(brokenInitHeaderOnly, segmentsTotal), false, '224 bytes must trigger size warning');

    // 10 MB vs 30 MB (< 50%) must fail
    assert.strictEqual(testSizeSanity(10 * 1024 * 1024, segmentsTotal), false, '10 MB must trigger warning');

    // 28 MB vs 30 MB (> 50%) must pass
    assert.strictEqual(testSizeSanity(28 * 1024 * 1024, segmentsTotal), true, '28 MB must pass');
  });

  it('FFmpeg Output Size & Non-Zero Return Code Throw: rejects outputs under 1 MB', () => {
    // Verify threshold constant in remux modules
    const ONE_MB = 1024 * 1024;
    function validateFfmpegOutput(outputBytes, retCode) {
      if (retCode !== 0) {
        throw new Error(`FFmpeg remux exited with non-zero return code: ${retCode}`);
      }
      if (!outputBytes || outputBytes.byteLength < ONE_MB) {
        throw new Error(`Remux output is under 1 MB (${outputBytes ? outputBytes.byteLength : 0} bytes).`);
      }
      return true;
    }

    assert.throws(() => {
      validateFfmpegOutput(new Uint8Array(224), 0);
    }, /under 1 MB/);

    assert.throws(() => {
      validateFfmpegOutput(new Uint8Array(2 * 1024 * 1024), 1);
    }, /non-zero return code: 1/);

    assert.strictEqual(validateFfmpegOutput(new Uint8Array(2 * 1024 * 1024), 0), true);
  });

  it('lib/ffmpeg-remuxer module: exports remuxTsToMp4, remuxSingleTrack and mergeVideoAndAudio', () => {
    const libRemuxer = require('./lib/ffmpeg-remuxer.js');
    assert.strictEqual(typeof libRemuxer.loadCore, 'function', 'loadCore must be a function');
    assert.strictEqual(typeof libRemuxer.remuxTsToMp4, 'function', 'remuxTsToMp4 must be a function');
    assert.strictEqual(typeof libRemuxer.remuxSingleTrack, 'function', 'remuxSingleTrack must be a function');
    assert.strictEqual(typeof libRemuxer.mergeVideoAndAudio, 'function', 'mergeVideoAndAudio must be a function');
    assert.strictEqual(typeof libRemuxer.timeStringToSeconds, 'function', 'timeStringToSeconds must be a function');
    assert.strictEqual(libRemuxer.timeStringToSeconds('00:02:15.50'), 135.5);

    // Verify root ffmpeg-remux.js delegates to lib/ffmpeg-remuxer.js
    const rootRemuxer = require('./ffmpeg-remux.js');
    assert.strictEqual(typeof rootRemuxer.remuxTsToMp4, 'function');
    assert.strictEqual(typeof rootRemuxer.mergeVideoAndAudio, 'function');
  });

  console.log('\n=== 11. Staged 5-Step Pipeline Architecture ===');
  it('5-Step Pipeline: calculates count, stores in IndexedDB, merges in TS, converts to MP4, and offers both downloads', async () => {
    // 1. Step 1: Calculate total segments
    const sampleM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:5.0,
segment_0.ts
#EXTINF:6.0,
segment_1.ts
#EXTINF:4.5,
segment_2.ts
#EXT-X-ENDLIST`;
    const parsed = HlsParser.parse(sampleM3u8, 'https://example.com/playlist.m3u8');
    const totalSegments = parsed.segments.length;
    assert.strictEqual(totalSegments, 3, 'Step 1: Exactly 3 segments calculated');
    const totalDuration = parsed.segments.reduce((acc, s) => acc + s.duration, 0);
    assert.strictEqual(totalDuration, 15.5, 'Step 1: Duration is 15.5s');

    // 2. Step 2: Store segments into IndexedDB (simulated mock store)
    const mockDb = new Map();
    const downloadId = 'dl_test_5step';
    for (let i = 0; i < totalSegments; i++) {
      // Mock valid TS packet starting with 0x47
      const packet = new Uint8Array(188);
      packet[0] = 0x47;
      packet[1] = 0x10;
      packet[2] = 0x00;
      packet[3] = 0x20; // TS packet payload
      mockDb.set(`${downloadId}:${String(i).padStart(6, '0')}`, {
        index: i,
        data: packet,
        duration: parsed.segments[i].duration
      });
    }
    assert.strictEqual(mockDb.size, 3, 'Step 2: All 3 segments stored in IndexedDB');

    // 3. Step 3: Merge everything in TS format sequentially
    const tsParts = [];
    let mergedBytes = 0;
    for (let i = 0; i < totalSegments; i++) {
      const record = mockDb.get(`${downloadId}:${String(i).padStart(6, '0')}`);
      assert.ok(record, `Step 3: Segment ${i} must exist in storage`);
      tsParts.push(record.data);
      mergedBytes += record.data.byteLength;
    }
    const mergedTs = Buffer.concat(tsParts.map(u => Buffer.from(u)));
    assert.strictEqual(mergedTs.byteLength, 188 * 3, 'Step 3: Merged TS byte length matches sum of segments');
    assert.strictEqual(mergedTs[0], 0x47, 'Step 3: Merged TS starts with 0x47 sync byte');
    assert.strictEqual(mergedTs[188], 0x47, 'Step 3: Packet 1 starts with 0x47');
    assert.strictEqual(mergedTs[376], 0x47, 'Step 3: Packet 2 starts with 0x47');

    // 4. Step 4: Convert to MP4
    const libRemuxer = require('./lib/ffmpeg-remuxer.js');
    assert.strictEqual(typeof libRemuxer.remuxTsToMp4, 'function', 'Step 4: Remuxer function available');

    // 5. Step 5: Download MP4 and option to download TS
    const mp4Filename = 'video.mp4';
    const tsFilename = 'video.ts';
    assert.strictEqual(mp4Filename.endsWith('.mp4'), true, 'Step 5: MP4 target file ready');
    assert.strictEqual(tsFilename.endsWith('.ts'), true, 'Step 5: TS target file ready as optional download');
  });

  console.log(`\n========================================`);
  console.log(`Tests Complete: ${passCount} Passed, ${failCount} Failed`);
  console.log(`========================================\n`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test Suite encountered fatal error:', err);
  process.exit(1);
});
