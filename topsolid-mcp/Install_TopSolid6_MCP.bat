@echo off
chcp 65001 >nul
setlocal
set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"

echo ============================================================
echo  TopSolid MCP Bridge - Installer
echo ============================================================
echo.
echo [1/4] Checking Node.js LTS runtime and configuring Antigravity MCP...
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%\agent\ts6_ensure_deps.ps1" -InstallDir "%BASE_DIR%" -EnsureNode -ConfigureAntigravity
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] Node.js / MCP auto-configuration reported an issue. Continuing...
)

echo.
echo [2/4] Installing Windows autostart service (Task Scheduler)
echo       and creating Start Menu section ("TopSolid MCP")...
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%\agent\ts6_bridge.ps1" -InstallAll
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Installation failed with code %ERRORLEVEL%.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [3/4] Restarting any existing bridge instance...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*ts6_bridge.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 1 /nobreak >nul

echo [4/4] Starting TopSolid MCP Bridge in System Tray...
start "" wscript.exe //B "%BASE_DIR%\agent\ts6_tray_launcher.vbs"

echo.
echo ============================================================
echo  Done!
echo   - System Tray icon is now active (left-click: Info, right-click: Settings)
echo   - Autostart service: Task Scheduler "TopSolid6McpBridge" (At Logon)
echo   - Start Menu folder: "TopSolid MCP"
echo ============================================================
timeout /t 3 /nobreak >nul
exit /b 0
