# Universal Stream & Media Downloader

A powerful Manifest V3 Chrome extension designed to detect and download streaming and direct media (HLS `.m3u8`, DASH `.mpd`, direct `.mp4` / `.webm`, and audio streams) using a high-performance **Native Messaging Helper (`yt-dlp` + `ffmpeg`)** with an automatic **In-Browser HLS/AES-128 Downloader Fallback**.

---

## 🚀 Architecture & Core Features

### 1. Request-Level Stream Detection
- **`webRequest.onSendHeaders` (with `extraHeaders`)**:
  - Non-blocking observation of network traffic.
  - Automatically identifies HLS manifests (`.m3u8`), DASH manifests (`.mpd`), and direct video files (`.mp4`, `.webm`).
  - **Ignores individual `.ts` and `.m4s` segment requests** to prevent notification spam.
  - Captures the exact `Referer`, `Origin`, and `User-Agent` headers used by the page's video player.
  - De-duplicates streams per tab, maintains live badge counters, and purges entries on tab navigation or closure.

### 2. Primary Download Path: Native Messaging Helper (`yt-dlp` + `ffmpeg`)
- Standard 4-byte length-prefixed JSON communication with the local native host (`com.example.hlsdl`).
- Runs `yt-dlp` with:
  - `-N 8` (8 concurrent fragment connections).
  - `--add-header` for the captured `Referer` and `Origin`.
  - `--user-agent` matching the browser.
  - `--cookies-from-browser chrome` to pass authentication cookies (with auto-retry if database is locked).
  - Merges audio and video into `.mp4` using `ffmpeg`.
  - Saves completed videos directly to `~/Downloads`.
  - **Dual-target strategy**: Tries `pageUrl` first (allowing `yt-dlp`'s 1000+ specialized extractors to run), then automatically falls back to the raw stream URL.

### 3. Fallback Path: In-Browser HLS Engine
- If the Native Helper is not installed:
  - HLS streams (`.m3u8`) download directly inside an extension tab (`downloader.html`).
  - Concurrent worker pool (6 parallel workers by default, boostable up to 16).
  - Decrypts encrypted segments using **AES-128 via Web Crypto API** (AES-CBC) with playlist IV or big-endian sequence IVs.
  - Real-time disk streaming via **File System Access API (`showSaveFilePicker`)** with fallback to in-memory Blob assembly.
  - In-browser transmuxing of MPEG-TS to `.mp4` using locally bundled `/lib/mux.min.js` (no remote CDNs).
  - Prompts the user to install the Native Helper for DASH (`.mpd`) and specialized site support.

### 4. DRM Detection & Error Transparency
- **Strict DRM Detection**: Automatically detects `SAMPLE-AES`, Widevine, PlayReady, FairPlay, and MPD `<ContentProtection>` tags.
  - When DRM is detected, displays: **`🔒 DRM-protected, can't be downloaded`** and disables download actions.
  - *No DRM circumvention is implemented.*
- **Informative Error Messages**: If an M3U8/MPD request returns an HTML page (such as a 403 Forbidden or Cloudflare challenge) or is missing `#EXTM3U`, the extension displays the HTTP status code and the first 200 characters of the server's response.

---

## 📁 File Structure

```text
downloader-extention/
├── manifest.json              # Manifest V3 extension configuration (nativeMessaging, webRequest, DNR)
├── background.js              # Service worker (onSendHeaders sniffing, badge, native messaging bridge)
├── content.js                 # Content script (DOM video element detector & recording bridge)
├── inject.js                  # MAIN world script (intercepts fetch, XHR, and MediaSource)
├── popup.html                 # Extension toolbar popup interface
├── popup.css                  # Popup dark-themed styling & helper status indicator
├── popup.js                   # Popup controller & download dispatcher
├── downloader.html            # Standalone In-Browser HLS/Chunk downloader dashboard
├── downloader.css             # Downloader UI & live segment matrix
├── downloader.js              # Multi-threaded HLS engine (Web Crypto AES-128, mux.js remuxing)
├── lib/
│   └── mux.min.js             # Bundled mux.js library (no CDN dependencies)
├── native-host/               # Native Messaging Host files
│   ├── host.py                # Python host script (stdin/stdout 4-byte JSON protocol, runs yt-dlp)
│   ├── host.bat               # Windows launcher wrapper
│   ├── com.example.hlsdl.json # Native host manifest template
│   ├── install.bat            # Windows 1-click batch installer
│   ├── install.ps1            # Windows PowerShell installer
│   ├── install_mac.sh         # macOS installation shell script
│   └── install_linux.sh       # Linux installation shell script
└── icons/                     # Extension icons (16px, 32px, 48px, 128px)
```

---

## ⚙️ Installation & Setup

### Step 1: Install the Chrome Extension
1. Open Google Chrome (or Edge/Brave) and go to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `downloader-extention` directory.
4. Note your 32-character **Extension ID** displayed on the extension card (e.g., `abcdefghijklmnopqrstuvwxyz123456`).

### Step 2: Install Prerequisites for Native Helper
Ensure you have the following installed on your machine:
- **Python 3** (3.8 or newer): [python.org](https://www.python.org/)
- **yt-dlp**: [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp)
  - Windows: `winget install yt-dlp.yt-dlp` or `pip install -U yt-dlp`
  - macOS: `brew install yt-dlp`
  - Linux: `sudo apt install yt-dlp` or `pip install -U yt-dlp`
- **ffmpeg**: [ffmpeg.org](https://ffmpeg.org/)
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`

### Step 3: Register the Native Host
Run the installer corresponding to your operating system:

#### Windows
Double-click `native-host\install.bat` (or run in PowerShell `powershell -ExecutionPolicy Bypass -File native-host\install.ps1`). When prompted, paste your Extension ID.

#### macOS
Open Terminal and run:
```bash
cd native-host
chmod +x install_mac.sh
./install_mac.sh <YOUR_EXTENSION_ID>
```

#### Linux
Open Terminal and run:
```bash
cd native-host
chmod +x install_linux.sh
./install_linux.sh <YOUR_EXTENSION_ID>
```

### Step 4: Verify Connection
1. Click the extension icon in Chrome.
2. In the popup header, click **Check helper status**.
3. The indicator will show **`Helper: Ready (yt-dlp + ffmpeg)`** with a green status light.

---

## 🔒 Permissions Explained

| Permission | Purpose |
| :--- | :--- |
| `webRequest` | Non-blocking observation of network requests (`onSendHeaders` with `extraHeaders`) to capture `.m3u8` / `.mpd` requests and extract authentic playback headers (`Referer`, `Origin`, `User-Agent`, `Accept-Language`). |
| `declarativeNetRequest` | Creates dynamic session rules to replay captured request headers (`Referer`, `Origin`, `User-Agent`, `Accept-Language`) scoped specifically to the extension's own requests (`tabIds: [chrome.tabs.TAB_ID_NONE]`). |
| `declarativeNetRequestWithHostAccess` | Permits modifying request headers on host URLs without requiring static declarative rule files. |
| `storage` | Persists per-tab media stream lists, real request headers in `chrome.storage.session`, and user quality preferences in `chrome.storage.local`. |
| `cookies` | Attaches authenticated site session cookies to `fetch(url, { credentials: "include" })` to prevent HTTP 403 Forbidden errors on cookie-gated streams. |
| `scripting` | Provides the page-context fallback (`chrome.scripting.executeScript` into `world: "MAIN"`) to execute fetches directly inside the host tab when bot protection or CORS blocks extension-level requests. |
| `tabs` & `activeTab` | Detects tab navigation and closure for automatic state cleanup, and targets the originating tab for page-context fetches. |
| `downloads` | Saves assembled, remuxed MP4 or TS files directly to the browser's download directory. |
| `nativeMessaging` | Allows optional communication with the local native helper (`host.py`) for command-line acceleration. |
| `<all_urls>` | Host permission required to observe network headers, attach session cookies, and download media segments across any video streaming host. |

---

## ⚖️ Legal & Policy Notice

### Personal & Authorized Use Only
This extension is intended solely for personal archival and downloading content that you own or have explicit authorization or legal rights to save. Respect the copyright and intellectual property rights of content owners.

### Chrome Web Store Limitation
Google Chrome Web Store policies strictly prohibit extensions from downloading or extracting videos from YouTube. Consequently, this extension **cannot and will not be published to the Chrome Web Store**; it is designed strictly for local, unpacked, and developer use.
