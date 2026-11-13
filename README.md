# Stream Video Downloader (CocoCut Alternative)

A Chrome extension (Manifest V3) designed to detect and download streaming media (HLS `.m3u8`, DASH `.mpd`, and direct `.mp4` / `.webm` / `.mp3`) using high-speed multi-threaded downloading with visual segment tracking, just like CocoCut.

---

## ✨ Features

- **Multi-Source Stream Sniffing**:
  - `webRequest` observation API intercepts `.m3u8`, `.mpd`, `.mp4`, `.webm`, `.ts`, and audio requests.
  - Page-level JS monkey-patching (`inject.js` in `MAIN` world) intercepts `fetch()`, `XMLHttpRequest`, `HTMLMediaElement.src`, and MSE (`MediaSource`).
  - DOM observer (`content.js` in `ISOLATED` world) watches `<video>`, `<audio>`, and `<source>` tags.
- **Dedicated Multi-Thread Downloader Dashboard (`download.html`)**:
  - Concurrent worker pool downloading with **2 to 16 configurable threads** for maximum speed.
  - Real-time download speed calculation (MB/s) and estimated time remaining (ETA).
  - **Live Segment Matrix Grid** (visualizes individual chunk downloads in real time like CocoCut and IDM).
  - **AES-128 Stream Decryption**: Automatically fetches `#EXT-X-KEY` and decrypts encrypted HLS segments using the Web Crypto API.
  - Pause, Resume, and Cancel support.
  - Automatic `.ts` / `.mp4` file merging and download triggering.
- **Popup Interface (`popup.html`)**:
  - Dark-mode design with badge counters and color-coded stream indicators (`HLS`, `DASH`, `MP4`, `AUDIO`).
  - Master playlist quality selector (1080p, 720p, 480p, etc.).
  - Direct 1-click download button.
  - Direct access button to the standalone Multi-Thread Downloader tab.

---

## 📁 File Structure

```text
downloader-extention/
├── manifest.json              # Manifest V3 extension configuration
├── background.js              # Background service worker (stream detection, badge, storage)
├── content.js                 # Content script (DOM scanner, mutation observer, bridge)
├── inject.js                  # MAIN world script (intercepts fetch, XHR, MSE, media src)
├── popup.html                 # Extension toolbar popup interface
├── popup.css                  # Popup dark-themed styling
├── popup.js                   # Popup UI controller & stream detector viewer
├── download.html              # Multi-threaded download dashboard (CocoCut style)
├── download.css               # Downloader tab styling & segment grid matrix
├── download.js                # Multi-threaded engine, AES-128 decryptor & file merger
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
3. Click the **Load unpacked** button.
4. Select the project directory: `d:\Projects\downloader-extention`.
5. The extension **Stream Video Downloader** will now appear in your browser toolbar!

---

## 🎯 How to Use

1. Navigate to any website containing a video or stream.
2. Start playing the video.
3. The extension badge will display the number of detected media streams.
4. Click the extension icon in the toolbar:
   - For **HLS / DASH streams**: Select your desired quality (e.g. 1080p) and click **Download**. The high-speed downloader tab will open and download the segments using multi-threaded concurrency.
   - For **Direct MP4 / Audio**: Click **Download** to save immediately via Chrome's download manager.
5. You can also click the **Downloader** button in the popup to open the downloader tab and paste any `.m3u8` or stream URL directly!

