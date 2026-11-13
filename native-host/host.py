#!/usr/bin/env python3
"""
Universal Media Downloader - Native Messaging Host (com.example.hlsdl)
Standard Chrome Native Messaging Host using 4-byte length-prefixed JSON on stdin/stdout.

Capabilities:
- Receives { action, url, pageUrl, referer, origin, ua }
- Checks dependencies (yt-dlp, ffmpeg)
- Runs yt-dlp with:
  * -N 8 (8 concurrent connections)
  * --add-header for Referer and Origin
  * --user-agent
  * --cookies-from-browser chrome
  * --merge-output-format mp4 (via ffmpeg)
  * Saves directly to ~/Downloads
  * Tries pageUrl first, then falls back to raw stream URL
- Returns { ok: True/False, log: "..." }
"""

import sys
import os
import json
import struct
import subprocess
import shutil

# Chrome Native Messaging protocol on Windows/macOS/Linux uses standard 32-bit unsigned int
LEN_FORMAT = '@I'

def read_message():
    """Reads a message from Chrome (4-byte length prefix followed by UTF-8 JSON)."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    message_length = struct.unpack(LEN_FORMAT, raw_length)[0]
    message_bytes = sys.stdin.buffer.read(message_length)
    if len(message_bytes) < message_length:
        return None
    return json.loads(message_bytes.decode('utf-8'))

def send_message(message_dict):
    """Sends a message to Chrome (4-byte length prefix followed by UTF-8 JSON)."""
    encoded = json.dumps(message_dict, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack(LEN_FORMAT, len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def check_dependencies():
    """Checks whether yt-dlp and ffmpeg are installed and accessible on PATH."""
    ytdlp_path = shutil.which('yt-dlp')
    ffmpeg_path = shutil.which('ffmpeg')
    downloads_dir = os.path.expanduser('~/Downloads')
    return {
        'ytdlp': ytdlp_path is not None,
        'ffmpeg': ffmpeg_path is not None,
        'ytdlp_path': ytdlp_path or '',
        'ffmpeg_path': ffmpeg_path or '',
        'downloads_dir': downloads_dir
    }

def run_ytdlp(url, page_url=None, referer=None, origin=None, ua=None):
    """
    Executes yt-dlp to download media into ~/Downloads.
    Tries page_url first, then falls back to raw stream URL.
    """
    downloads_dir = os.path.expanduser('~/Downloads')
    os.makedirs(downloads_dir, exist_ok=True)

    ytdlp_bin = shutil.which('yt-dlp')
    if not ytdlp_bin:
        return False, "[Native Helper Error] yt-dlp is not installed or not found on PATH. Please install yt-dlp."

    ffmpeg_bin = shutil.which('ffmpeg')
    if not ffmpeg_bin:
        return False, "[Native Helper Error] ffmpeg is not installed or not found on PATH. Please install ffmpeg."

    def build_cmd(target_url, use_cookies=True):
        cmd = [
            ytdlp_bin,
            '-N', '8',
            '--merge-output-format', 'mp4',
            '--remux-video', 'mp4',
            '-P', downloads_dir,
            '-o', '%(title).150B [%(id)s].%(ext)s',
            '--no-playlist',
            '--no-mtime',
        ]
        if use_cookies:
            cmd.extend(['--cookies-from-browser', 'chrome'])
        if referer:
            cmd.extend(['--add-header', f'Referer:{referer}'])
        if origin:
            cmd.extend(['--add-header', f'Origin:{origin}'])
        if ua:
            cmd.extend(['--user-agent', ua])
        cmd.append(target_url)
        return cmd

    def execute(cmd):
        try:
            res = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace'
            )
            return res.returncode == 0, res.stdout or ''
        except Exception as e:
            return False, f"Process execution error: {str(e)}"

    logs = []

    # 1. Try page_url first if provided and valid
    if page_url and page_url.startswith(('http://', 'https://')):
        logs.append(f"[Native Helper] 🚀 Trying download with pageUrl: {page_url}")
        cmd = build_cmd(page_url, use_cookies=True)
        ok, out = execute(cmd)
        logs.append(out)

        # If browser cookie DB was locked, retry pageUrl without cookies
        if not ok and ('database is locked' in out or 'Could not copy Chrome cookie database' in out):
            logs.append("[Native Helper] ⚠️ Chrome cookie database locked; retrying pageUrl without cookies...")
            cmd = build_cmd(page_url, use_cookies=False)
            ok, out = execute(cmd)
            logs.append(out)

        if ok:
            logs.append(f"[Native Helper] ✅ Successfully downloaded via pageUrl to {downloads_dir}")
            return True, "\n".join(logs)
        logs.append("[Native Helper] ⚠️ pageUrl download failed or unsupported. Falling back to raw stream URL...")

    # 2. Fall back to raw stream URL
    target_stream = url or page_url
    if target_stream:
        logs.append(f"[Native Helper] 🚀 Trying download with raw stream URL: {target_stream}")
        cmd = build_cmd(target_stream, use_cookies=True)
        ok, out = execute(cmd)
        logs.append(out)

        if not ok and ('database is locked' in out or 'Could not copy Chrome cookie database' in out):
            logs.append("[Native Helper] ⚠️ Chrome cookie database locked; retrying raw stream URL without cookies...")
            cmd = build_cmd(target_stream, use_cookies=False)
            ok, out = execute(cmd)
            logs.append(out)

        if ok:
            logs.append(f"[Native Helper] ✅ Successfully downloaded via stream URL to {downloads_dir}")
            return True, "\n".join(logs)

    return False, "\n".join(logs)

def main():
    while True:
        try:
            msg = read_message()
            if msg is None:
                break

            action = msg.get('action', 'download')

            if action == 'ping':
                deps = check_dependencies()
                is_ready = deps['ytdlp'] and deps['ffmpeg']
                send_message({
                    'ok': is_ready,
                    'action': 'ping',
                    'dependencies': deps,
                    'log': 'Native helper is ready with yt-dlp & ffmpeg' if is_ready else 'yt-dlp or ffmpeg missing from PATH'
                })
            elif action == 'download' or 'url' in msg:
                url = msg.get('url', '')
                page_url = msg.get('pageUrl') or msg.get('page_url', '')
                referer = msg.get('referer', '')
                origin = msg.get('origin', '')
                ua = msg.get('ua') or msg.get('userAgent', '')

                ok, log = run_ytdlp(url, page_url, referer, origin, ua)
                send_message({
                    'ok': ok,
                    'log': log,
                    'url': url,
                    'pageUrl': page_url
                })
            else:
                send_message({
                    'ok': False,
                    'log': f'Unknown action received: {action}'
                })

        except Exception as e:
            send_message({
                'ok': False,
                'log': f'Native host internal exception: {str(e)}'
            })

if __name__ == '__main__':
    main()

