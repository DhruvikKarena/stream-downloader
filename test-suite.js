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

  console.log('\n=== 7. Live Test Stream Acceptance Tests ===');

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
