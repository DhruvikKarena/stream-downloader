#!/usr/bin/env bash
set -e

echo "=============================================================="
echo "  Universal Media Downloader - Native Helper Installer (Linux)"
echo "=============================================================="
echo ""

# 1. Check Python
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] python3 is not installed or not in PATH."
    echo "Install via your package manager: sudo apt install python3"
    exit 1
else
    echo "[OK] Python 3 found: $(which python3)"
fi

# 2. Check yt-dlp
if ! command -v yt-dlp &>/dev/null; then
    echo "[WARNING] yt-dlp is not installed or not in PATH."
    echo "Install via: sudo apt install yt-dlp OR pip install -U yt-dlp"
else
    echo "[OK] yt-dlp found: $(which yt-dlp)"
fi

# 3. Check ffmpeg
if ! command -v ffmpeg &>/dev/null; then
    echo "[WARNING] ffmpeg is not installed or not in PATH."
    echo "Install via: sudo apt install ffmpeg"
else
    echo "[OK] ffmpeg found: $(which ffmpeg)"
fi

echo ""
EXT_ID="$1"
if [ -z "$EXT_ID" ]; then
    echo "Open chrome://extensions, locate 'Stream Video Downloader', and copy the ID."
    read -p "Enter Chrome Extension ID: " EXT_ID
fi

if [ -z "$EXT_ID" ]; then
    echo "[ERROR] Extension ID is required."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PY="$SCRIPT_DIR/host.py"
chmod +x "$HOST_PY"

CHROME_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
CHROMIUM_DIR="$HOME/.config/chromium/NativeMessagingHosts"

mkdir -p "$CHROME_DIR"
mkdir -p "$CHROMIUM_DIR"

MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "com.example.hlsdl",
  "description": "Universal Media Downloader Native Helper",
  "path": "$HOST_PY",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
)

echo "$MANIFEST_CONTENT" > "$CHROME_DIR/com.example.hlsdl.json"
echo "$MANIFEST_CONTENT" > "$CHROMIUM_DIR/com.example.hlsdl.json"

echo "[OK] Registered manifest at:"
echo "  - $CHROME_DIR/com.example.hlsdl.json"
echo "  - $CHROMIUM_DIR/com.example.hlsdl.json"
echo "Installation complete! Click 'Check helper status' in the popup."

