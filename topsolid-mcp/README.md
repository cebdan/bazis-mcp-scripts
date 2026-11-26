# TopSolid MCP (`topsolid-mcp`)

Zero-dependency MCP stdio server + Windows System Tray COM bridge for **TopSolid** (`TopSolid.Application`, compatible with TopSolid 6.x),
communicating via atomic Shared-Folder IPC (`.ts6-ipc/` — works seamlessly across macOS + Parallels / MEGA sync
or locally on Windows).

## Features (v0.2.1)
- **System Tray Application** (zero console window flash via `ts6_tray_launcher.vbs`, single-instance lock):
  - **Dynamic Status Icon**: green dot when TopSolid is open, amber when waiting for TopSolid, gray when paused.
  - **Left-click**: opens **Information & Live Status** window (version, PID, uptime, request/error stats, TopSolid COM health, service/Start Menu status, live activity log, and one-click **Copy MCP Config**).
  - **Right-click**: opens context menu with **Settings...**, **Information & Status...**, **Pause/Resume**, **Restart**, **Check for Updates (GitHub)**, **Install/Uninstall Service**, **Add/Remove Start Menu**, **Open IPC/Log**, and **Exit**.
- **Windows Service (Interactive Autostart)**:
  - Registers a per-user interactive Windows Scheduled Task (`TopSolid6McpBridge`) at logon with automatic restart on failure and no execution time limit (no Admin UAC required, full access to TopSolid COM, screenshots, and System Tray).
- **Start Menu Section (`TopSolid MCP`)**:
  - Creates shortcuts in `%APPDATA%\Microsoft\Windows\Start Menu\Programs\TopSolid MCP\`: Bridge, Info, Settings, Check for Updates, Install/Repair Service, Open IPC & Logs Folder, and Uninstall.
- **GitHub Update Checker & Self-Updater**:
  - Checks `version.json` and latest commit on GitHub (`cebdan/bazis-mcp-scripts`, configurable in Settings) automatically on startup or on demand, and can update via `git pull` or direct file download + automatic restart.

## MCP Tools (13)
- `ts6_health` — TopSolid version, open document count, active document, templates dir.
- `ts6_bridge_info` — bridge version, PID, uptime, request/error counters, service & Start Menu status, paths.
- `ts6_check_updates` — check GitHub for newer `topsolid-mcp` releases/commits.
- `ts6_list_templates` — list `B&S_*.top` native process templates in `TopSolid_Templates`.
- `ts6_new_doc` — create a new `.top` design document.
- `ts6_list_elements` — list shapes (Name, Designation, Reference, Layer, Operations.Count) and components.
- `ts6_create_block` — create a native Parasolid rectangular panel (`AddBasicBlock`, mm).
- `ts6_insert_component` — insert a `.top` process template at a 3D coordinate system (`AddWithPositioningByCoordinateSystems`).
- `ts6_eval_vbs` — run VBScript directly against live `TopSolid.Application` (`app`) and `CurrentDocument` (`doc`).
- `ts6_focus_window`, `ts6_screenshot`, `ts6_mouse_click`, `ts6_send_keys` — Windows UI automation & screen capture.

## Quick Start
1. **Standalone Windows Installer (`TopSolid_MCP_Setup.exe`, v0.2.1):**
   Double-click `TopSolid_MCP_Setup.exe` (self-contained native Win32 GUI installer, supports `/S` silent mode). It automatically:
   - Checks for **Node.js LTS (`>= 18`)** and installs it automatically if missing (`winget` or zero-UAC official portable Node.js LTS into `<InstallDir>\runtime\` + User `PATH`);
   - Auto-configures **Antigravity MCP** (`%USERPROFILE%\.gemini\antigravity\mcp_config.json`) with the exact `node.exe` and `server\index.mjs` paths;
   - Extracts all bridge/server files, writes `config.json`, installs the Windows autostart service (`TopSolid6McpBridge`), creates the **TopSolid MCP** Start Menu section, registers in Windows Installed Apps, launches the System Tray bridge, and runs an end-to-end MCP self-test.
   *(Or run `Install_TopSolid6_MCP.bat` directly from the repo, or `Start_TopSolid6_Bridge.bat --console` for console debugging.)*
2. **CLI Diagnostics (macOS or Windows):**
   ```bash
   node /Users/user/MEGA/Works/cnc/topsolid-mcp/server/index.mjs --health
   node /Users/user/MEGA/Works/cnc/topsolid-mcp/server/index.mjs --info
   node /Users/user/MEGA/Works/cnc/topsolid-mcp/server/index.mjs --check-updates
   ```
3. **Register in MCP client (`mcp_config.json`):**
   ```json
   {
     "mcpServers": {
       "topsolid6": {
         "command": "node",
         "args": ["/Users/user/MEGA/Works/cnc/topsolid-mcp/server/index.mjs"]
       }
     }
   }
   ```
4. **Uninstall Service & Start Menu:**
   Double-click `Uninstall_TopSolid6_MCP.bat` (or toggle directly from the Tray right-click menu / Settings).
