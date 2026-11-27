@echo off
chcp 65001 >nul
setlocal
set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"

if exist "%APPDATA%\TopSolid6MCP\stopped.flag" del /f /q "%APPDATA%\TopSolid6MCP\stopped.flag" >nul 2>&1

if /I "%~1"=="--console" (
    echo ============================================================
    echo  TopSolid MCP Bridge (Console Mode)
    echo  IPC dir: %BASE_DIR%\.ts6-ipc
    echo ============================================================
    powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%BASE_DIR%\agent\ts6_bridge.ps1" -NoTray
    pause
    exit /b %ERRORLEVEL%
)

start "" wscript.exe //B "%BASE_DIR%\agent\ts6_tray_launcher.vbs" --clear-stop %*
exit /b 0
