@echo off
setlocal enabledelayedexpansion

echo ==============================================================
echo   Universal Media Downloader - Native Helper Installer (Windows)
echo ==============================================================
echo.

:: 1. Check Python
where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Python is not installed or not in PATH!
    echo Please install Python 3 from https://www.python.org/ or run:
    echo   winget install Python.Python.3.12
    echo.
    pause
    exit /b 1
) else (
    echo [OK] Python is installed.
)

:: 2. Check yt-dlp
where yt-dlp >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [WARNING] yt-dlp was not found on PATH!
    echo To install yt-dlp, run in terminal:
    echo   winget install yt-dlp.yt-dlp
    echo or:
    echo   pip install -U yt-dlp
    echo.
) else (
    echo [OK] yt-dlp is installed.
)

:: 3. Check ffmpeg
where ffmpeg >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [WARNING] ffmpeg was not found on PATH!
    echo To install ffmpeg, run in terminal:
    echo   winget install Gyan.FFmpeg
    echo.
) else (
    echo [OK] ffmpeg is installed.
)

echo.
:: 4. Prompt for Extension ID
set "EXT_ID=%~1"
if "%EXT_ID%"=="" (
    echo Open chrome://extensions in your browser, locate "Stream Video Downloader",
    echo and copy the 32-character extension ID (e.g., abcdefghijklmnop...).
    echo.
    set /p "EXT_ID=Enter Chrome Extension ID: "
)

if "%EXT_ID%"=="" (
    echo [ERROR] Extension ID is required.
    pause
    exit /b 1
)

:: Clean quotes if user pasted them
set "EXT_ID=%EXT_ID:"=%"
set "EXT_ID=%EXT_ID: =%"

set "SCRIPT_DIR=%~dp0"
:: Remove trailing backslash
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "HOST_BAT=%SCRIPT_DIR%\host.bat"
set "MANIFEST_JSON=%SCRIPT_DIR%\com.example.hlsdl.json"

:: Escape backslashes for JSON
set "ESCAPED_PATH=%HOST_BAT:\=\\%"

echo.
echo Writing native manifest: %MANIFEST_JSON%
(
    echo {
    echo   "name": "com.example.hlsdl",
    echo   "description": "Universal Media Downloader Native Helper",
    echo   "path": "%ESCAPED_PATH%",
    echo   "type": "stdio",
    echo   "allowed_origins": [
    echo     "chrome-extension://%EXT_ID%/"
    echo   ]
    echo }
) > "%MANIFEST_JSON%"

echo Registering in Windows Registry (Google Chrome)...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.example.hlsdl" /ve /t REG_SZ /d "%MANIFEST_JSON%" /f >nul
if %ERRORLEVEL% equ 0 (
    echo [OK] Chrome Native Messaging Host registered successfully!
) else (
    echo [ERROR] Failed to write Google Chrome registry key.
)

reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.example.hlsdl" /ve /t REG_SZ /d "%MANIFEST_JSON%" /f >nul 2>nul

echo.
echo ==============================================================
echo   Installation Complete!
echo   Target Manifest: %MANIFEST_JSON%
echo   Allowed Origin:  chrome-extension://%EXT_ID%/
echo   You can now click "Check helper status" in the popup.
echo ==============================================================
echo.
pause

