# Universal Stream & Media Downloader

A high-performance, Manifest V3 Chrome extension designed to detect and download streaming media (HLS `.m3u8`, direct `.mp4`, `.webm`, and audio streams) directly inside the browser using multi-threaded segment caching, IndexedDB storage, Web Crypto AES-128 decryption, and client-side TS-to-MP4 transmuxing.

100% self-contained and fully compliant with Google Chrome Web Store Developer Program Policies.

---

## 🚀 Architecture & Core Features

### 1. Request-Level Stream Detection
- **`webRequest.onSendHeaders` (with `extraHeaders`)**:
  - Non-blocking observation of network traffic.
  - Automatically identifies HLS manifests (`.m3u8`) and direct media files (`.mp4`, `.webm`).
  - Ignores individual `.ts` and `.m4s` segment requests to prevent notification spam.
  - Captures the exact `Referer`, `Origin`, and `User-Agent` headers used by the page's video player.
  - De-duplicates streams per tab, maintains live badge counters, and purges entries on tab navigation or closure.

### 2. Multi-Threaded In-Browser Downloader & IndexedDB Engine
- Runs in a dedicated background/downloader tab (`downloader.html`):
  - Automatically parses Master playlists and sub-playlists to calculate total segment count, duration, and resolution options.
  - Concurrent worker pool downloading segments into browser **IndexedDB** storage.
  - Resilient against tab closures and network hiccups with exponential backoff retry.
  - Decrypts encrypted segments using **AES-128 via Web Crypto API** (AES-CBC) with playlist IV or big-endian sequence IVs.
  - Strips leading fake image headers (e.g. PNG/JPEG wrappers used by obfuscated video providers) by verifying the MPEG-TS `0x47` sync byte.

### 3. Client-Side Transmuxing & Export
- Merges cached segments from IndexedDB into clean, contiguous MPEG-TS format.
- Transmuxes TS to standard MP4 locally using bundled **FFmpeg WebAssembly** / **mux.js** without any remote server dependencies or CDNs.
- Offers dual export options:
  - **Save as MP4** (universal playback across mobile, desktop, and web players).
  - **Save as TS** (raw transport stream preserving original stream packets).

### 4. DRM Protection & Policy Transparency
- **Strict DRM Detection**: Automatically detects `SAMPLE-AES`, Widevine, PlayReady, FairPlay, and encrypted media extensions.
  - When DRM is detected, displays **`🔒 DRM-protected, can't be downloaded`** and disables download actions. No DRM circumvention is attempted or supported.
- **YouTube Policy Compliance**: In accordance with Google Chrome Web Store Developer Program Policies, YouTube and GoogleVideo streaming domains are strictly excluded from detection and downloading.

---

## 📁 File Structure

```text
stream-downloader/
├── manifest.json              # Manifest V3 extension configuration (compliant permissions & CSP)
├── background.js              # Service worker (network sniffing, badge counter, tab state)
├── content.js                 # Content script (DOM video element detector)
├── inject.js                  # MAIN world script (intercepts fetch, XHR, and MediaSource)
├── popup.html                 # Extension toolbar popup interface
├── popup.css                  # Popup dark-themed styling & stream list
├── popup.js                   # Popup controller & stream dispatcher
├── downloader.html            # Standalone multi-threaded HLS downloader interface
├── downloader.css             # Downloader UI & live segment progress matrix
├── downloader.js              # Segment download pipeline, IndexedDB storage, and TS/MP4 exporter
├── transmux.js                # In-browser transmuxer engine (FFmpeg WebAssembly & mux.js)
├── lib/                       # Bundled offline libraries (no remote CDN scripts)
│   ├── ffmpeg.js
│   ├── ffmpeg-core.js
│   ├── ffmpeg-core.wasm
│   └── mux.min.js
└── icons/                     # Extension icons (16px, 32px, 48px, 128px)
```

---

## ⚙️ Installation & Usage

### Installing in Developer Mode
1. Open Google Chrome (or Edge/Brave/Chromium) and navigate to `chrome://extensions/`.
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked** and select the `stream-downloader` folder.
4. Pin the extension to your toolbar.

### Downloading a Stream
1. Navigate to any website playing an HLS or direct video stream.
2. The extension badge will display the number of detected streams.
3. Click the extension icon in the toolbar.
4. Click **Download** next to any detected stream to open the Downloader tab.
5. Select your desired resolution and click **Start Download**.
6. Once download and assembly are complete, click **Save as MP4** or **Save as TS**.

---

## 🔒 Permissions & Security Compliance

| Permission | Justification |
| :--- | :--- |
| `webRequest` | Non-blocking observation of network requests (`onSendHeaders` with `extraHeaders`) to detect `.m3u8` playlists and extract player playback headers (`Referer`, `Origin`, `User-Agent`). |
| `webNavigation` | Resolves cross-origin iframe hierarchies to preserve authentic request origins for embedded players. |
| `declarativeNetRequest` | Replays captured playback headers (`Referer`, `Origin`, `User-Agent`) strictly for the extension's own segment download requests (`tabIds: [chrome.tabs.TAB_ID_NONE]`). |
| `declarativeNetRequestWithHostAccess` | Allows modifying request headers for media segments across origins without static rule files. |
| `storage` | Stores user quality preferences and per-tab media stream lists. |
| `cookies` | Allows attaching session cookies to authenticated streaming segments. |
| `scripting` | In-page DOM inspection fallback when streams are enclosed in sandboxed iframes. |
| `tabs` | Manages download tab creation and tracks tab closures to clean up memory. |
| `downloads` | Saves final converted MP4 or TS files directly to the user's Downloads directory. |
| `<all_urls>` | Required host permission to capture stream headers and download segments across media host origins. |

---

## ⚖️ Policy & Legal Notice

- **Personal & Authorized Archival Only**: This extension is intended solely for personal archival and downloading content that you own or have explicit authorization to save. Respect the copyright and intellectual property rights of content owners.
- **Chrome Web Store Policy Compliance**: This extension strictly complies with Google Chrome Web Store policies:
  - Downloading from YouTube or GoogleVideo is strictly blocked and not supported.
  - No remote scripts, eval(), or external executable downloads.
  - Zero bypass of DRM or technical access controls.
