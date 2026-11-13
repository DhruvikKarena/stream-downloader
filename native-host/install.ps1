# Universal Media Downloader - Native Helper PowerShell Installer (Windows)
param(
    [string]$ExtensionId = ""
)

Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  Universal Media Downloader - Native Helper Installer (Windows)" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Python
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    Write-Host "[ERROR] Python 3 was not found in PATH." -ForegroundColor Red
    Write-Host "Please install Python from https://www.python.org/ or run: winget install Python.Python.3.12"
} else {
    Write-Host "[OK] Python found: $($pythonCmd.Source)" -ForegroundColor Green
}

# 2. Check yt-dlp
$ytdlpCmd = Get-Command yt-dlp -ErrorAction SilentlyContinue
if (-not $ytdlpCmd) {
    Write-Host "[WARNING] yt-dlp was not found in PATH." -ForegroundColor Yellow
    Write-Host "Install via: winget install yt-dlp.yt-dlp OR pip install -U yt-dlp"
} else {
    Write-Host "[OK] yt-dlp found: $($ytdlpCmd.Source)" -ForegroundColor Green
}

# 3. Check ffmpeg
$ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegCmd) {
    Write-Host "[WARNING] ffmpeg was not found in PATH." -ForegroundColor Yellow
    Write-Host "Install via: winget install Gyan.FFmpeg"
} else {
    Write-Host "[OK] ffmpeg found: $($ffmpegCmd.Source)" -ForegroundColor Green
}

Write-Host ""

if (-not $ExtensionId) {
    Write-Host "Open chrome://extensions in your browser, copy your extension ID,"
    $ExtensionId = Read-Host "and enter Extension ID here"
}

$ExtensionId = $ExtensionId.Trim().Trim('"').Trim("'")
if (-not $ExtensionId) {
    Write-Host "[ERROR] Extension ID is required." -ForegroundColor Red
    Exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostBat = Join-Path $scriptDir "host.bat"
$manifestJsonPath = Join-Path $scriptDir "com.example.hlsdl.json"

$manifest = @{
    name = "com.example.hlsdl"
    description = "Universal Media Downloader Native Helper"
    path = $hostBat
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestJsonPath -Encoding utf8
Write-Host "[OK] Manifest generated: $manifestJsonPath" -ForegroundColor Green

# Register in Windows Registry for Chrome and Edge
$chromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.example.hlsdl"
if (-not (Test-Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts")) {
    New-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts" -Force | Out-Null
}
New-Item -Path $chromeRegPath -Force | Out-Null
Set-ItemProperty -Path $chromeRegPath -Name "(Default)" -Value $manifestJsonPath

Write-Host "[OK] Windows Registry updated for Google Chrome." -ForegroundColor Green

$edgeRegPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.example.hlsdl"
if (-not (Test-Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts")) {
    New-Item -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts" -Force -ErrorAction SilentlyContinue | Out-Null
}
New-Item -Path $edgeRegPath -Force -ErrorAction SilentlyContinue | Out-Null
Set-ItemProperty -Path $edgeRegPath -Name "(Default)" -Value $manifestJsonPath -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  Installation Completed Successfully!" -ForegroundColor Cyan
Write-Host "  Allowed Origin: chrome-extension://$ExtensionId/"
Write-Host "  You can now click 'Check helper status' in the popup!"
Write-Host "==============================================================" -ForegroundColor Cyan

