@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js first.
  pause
  exit /b 1
)

echo [1/2] Starting game server on http://localhost:3000 ...

rem Kill any stale server still holding port 3000 (old code would serve
rem new frontend files with old game logic and break the client)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
  echo [INFO] Port 3000 busy (pid %%a) - stopping stale server ...
  taskkill /F /PID %%a >nul 2>nul
)
timeout /t 1 >nul

start "PokerServer" cmd /c "node server.js"
timeout /t 2 >nul

echo [2/2] Starting Cloudflare tunnel (public URL) ...
set "CF=tools\cloudflared.exe"
if not exist "%CF%" set "CF=%TEMP%\poker-debug\cloudflared.exe"
if not exist "%CF%" (
  echo [WARN] cloudflared.exe not found - LAN mode only.
  echo        Friends on the same network can use: http://YOUR-IP:3000
  echo        To enable internet play, download cloudflared from:
  echo        https://github.com/cloudflare/cloudflared/releases
  echo Server is running. Close this window or press Ctrl+C to stop the tunnel.
  cmd /k node server.js
  exit /b 0
)
"%CF%" tunnel --url http://localhost:3000 --no-autoupdate
pause
