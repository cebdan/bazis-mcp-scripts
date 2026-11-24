@echo off
chcp 65001 >nul
setlocal
set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"
echo ============================================================
echo  TopSolid'Wood 6.25 MCP Bridge (PowerShell)
echo  IPC dir: %BASE_DIR%\.ts6-ipc
echo ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%\agent\ts6_bridge.ps1"
pause
