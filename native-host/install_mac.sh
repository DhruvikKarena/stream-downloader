#!/usr/bin/env bash
set -e

echo "=============================================================="
echo "  Universal Media Downloader - Native Helper Installer (macOS)"
echo "=============================================================="
echo ""

# 1. Check Python
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] python3 is not installed or not in PATH."
    echo "Install via Homebrew: brew install python"
    exit 1
else
    echo "[OK] Python 3 found: $(which python3)"
fi

# 2. Check yt-dlp
if ! command -v yt-dlp &>/dev/null; then
    echo "[WARNING] yt-dlp is not installed or not in PATH."
    echo "Install via Homebrew: brew install yt-dlp"
else
    echo "[OK] yt-dlp found: $(which yt-dlp)"
fi

# 3. Check ffmpeg
if ! command -v ffmpeg &>/dev/null; then
    echo "[WARNING] ffmpeg is not installed or not in PATH."
    echo "Install via Homebrew: brew install ffmpeg"
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

TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$TARGET_DIR"

MANIFEST_PATH="$TARGET_DIR/com.example.hlsdl.json"

cat <<EOF > "$MANIFEST_PATH"
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

echo "[OK] Registered manifest at: $MANIFEST_PATH"
echo "Installation complete! Click 'Check helper status' in the popup."

