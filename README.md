# Stream Video Downloader (CocoCut Alternative)

A Chrome extension (Manifest V3) designed to detect and download streaming media (YouTube, HLS `.m3u8`, DASH `.mpd`, and direct `.mp4` / `.webm` / `.mp3`) using high-speed multi-threaded downloading with visual segment tracking, separate audio+video synchronization, and live Recording Mode, just like CocoCut.

---

## ✨ Features

- **Multi-Source Stream Sniffing**:
  - `webRequest.onHeadersReceived` & `onBeforeRequest` non-blocking observation: detects video and audio mime types (`video/*`, `audio/*`), HLS manifests, DASH manifests, and GoogleVideo/YouTube `videoplayback` streams.
  - Page-level JS monkey-patching (`inject.js` in `MAIN` world): intercepts `fetch()`, `XMLHttpRequest`, `HTMLMediaElement.src`, and MSE (`MediaSource`).
  - Native YouTube player inspection: reads available resolutions (`1080p`, `720p`, `480p`, `360p`), formats, and tracks.
- **Video With Audio (Two Methods)**:
  - **CocoCut-Style Recording Mode**: One-click **"🔴 Record Video with Audio"** banner in the popup captures playing HTML5 video & audio synchronously from any web player (YouTube, Vimeo, Twitter, Netflix, etc.) and saves a synchronized `.mp4` / `.webm` with full audio!
  - **HLS Separate Audio Merging**: Master playlists with separate `#EXT-X-MEDIA:TYPE=AUDIO` tracks download both video segments AND audio segments, interleaving them into the final `.ts` file so sound is preserved!
- **Dedicated Multi-Thread Downloader Dashboard (`download.html`)**:
  - Concurrent worker pool downloading with **2 to 16 configurable threads** for maximum speed.
  - Real-time download speed calculation (MB/s) and estimated time remaining (ETA).
  - **Live Segment Matrix Grid** (visualizes individual chunk downloads in real time like CocoCut and IDM).
  - **AES-128 Stream Decryption**: Automatically fetches `#EXT-X-KEY` and decrypts encrypted HLS segments using the Web Crypto API.
  - Pause, Resume, and Cancel support.
  - Automatic file merging and download triggering.
- **Popup Interface (`popup.html`)**:
  - Dark-mode design with badge counters and clear indicators (`VIDEO + AUDIO`, `VIDEO ONLY`, `AUDIO ONLY`, `HLS STREAM`, `DASH STREAM`).
  - Master playlist quality selector (1080p, 720p, 480p, etc.).
  - 1-click download button and direct access button to the standalone Multi-Thread Downloader tab.

---

## 📁 File Structure

```text
downloader-extention/
├── manifest.json              # Manifest V3 extension configuration
├── background.js              # Background service worker (stream detection, badge, headers)
├── content.js                 # Content script (DOM scanner, video recording engine, floating UI)
├── inject.js                  # MAIN world script (intercepts fetch, XHR, MSE, YouTube player data)
├── popup.html                 # Extension toolbar popup interface
├── popup.css                  # Popup dark-themed styling
├── popup.js                   # Popup UI controller & stream detector viewer
├── download.html              # Multi-threaded download dashboard (CocoCut style)
├── download.css               # Downloader tab styling & segment grid matrix
├── download.js                # Multi-threaded engine, separate audio merger, AES-128 decryptor
└── icons/                     # Extension icons (16px, 32px, 48px, 128px)
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 How to Install in Chrome / Edge / Brave

1. Open your browser and navigate to:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
2. Enable **Developer mode** (toggle switch in top-right corner).
3. If already installed, click the **Reload (circular arrow)** button on the extension card. If installing for the first time, click **Load unpacked** and select `d:\Projects\downloader-extention`.
4. The extension **Stream Video Downloader** will now be active in your browser toolbar!

---

## 🎯 How to Download Video With Audio

### Option 1: YouTube & Web Video Players (Recording Mode)
1. Open any video on YouTube (or any video website).
2. Start playing the video.
3. Click the extension icon in your browser toolbar.
4. You will see the top banner: **"🔴 Record with Audio"**.
5. Click **Record with Audio**. A floating status bar will appear on your screen showing live recorded time and file size (`🔴 Recording Video + Audio: 00:25 | 18 MB`).
6. Click **Finish & Save** whenever you want, and your browser will immediately save the video file **with synchronized audio**!

### Option 2: Direct Stream Downloads
1. In the popup list, you will see detected streams clearly labeled:
   - `VIDEO + AUDIO` (Green)
   - `VIDEO ONLY` (Purple)
   - `AUDIO ONLY` (Orange)
   - `HLS STREAM` (Red)
2. For HLS streams with separate audio tracks, selecting your desired resolution and clicking **Download** will automatically download both the video and audio segments and merge them together!
