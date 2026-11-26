@echo off
chcp 65001 >nul
setlocal
set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"

echo ============================================================
echo  TopSolid MCP Bridge - Uninstaller
echo ============================================================
echo.
echo [1/2] Stopping running TopSolid MCP Bridge...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*ts6_bridge.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo [2/3] Removing Windows autostart service and Start Menu section...
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%\agent\ts6_bridge.ps1" -UninstallAll

echo [3/3] Removing Windows Installed Apps registry entry...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\TopSolid6MCP" /f >nul 2>&1

echo.
echo ============================================================
echo  TopSolid MCP Bridge service and Start Menu shortcuts removed.
echo ============================================================
pause
exit /b 0
