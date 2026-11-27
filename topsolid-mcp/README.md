# TopSolid MCP (`topsolid-mcp`)

Zero-dependency MCP stdio server + Windows System Tray COM bridge for **TopSolid** (`TopSolid.Application`, compatible with TopSolid 6.x),
communicating via atomic Shared-Folder IPC (`.ts6-ipc/` — works seamlessly across macOS + Parallels / MEGA sync
or locally on Windows).

## Features (v0.3.0)
- **Network Mode — MCP Streamable HTTP (`server/http.mjs`, port `8765`):**
  - Connects Claude Code / Antigravity on macOS (Parallels host) or LAN directly to Windows over HTTP (`http://<Windows-IP>:8765/mcp`) — no fragile MEGA/shared-folder IPC sync required.
  - Zero external npm dependencies (`node:http`, `node:fs`, `node:crypto`), stateless MCP Streamable HTTP (`2025-03-26` / `2025-06-18`), `GET /healthz` unauthenticated health check, mandatory `Authorization: Bearer <token>` (`timingSafeEqual`), `Origin` DNS-rebinding guard, IP/CIDR allowlist (`127.0.0.1`, `::1`, Parallels `10.211.55.0/24`, `10.37.129.0/24`, RFC1918 LAN).
  - Auto-started and supervised by `ts6_bridge.ps1` (auto-restarts on crash, max 5/min, stopped cleanly on exit).
  - **stdio → HTTP proxy** (`node server/index.mjs --remote <url> --token <token>`) for stdio-only MCP clients, plus full backwards-compatibility with legacy stdio + shared `.ts6-ipc/`.
  - **Stale IPC Request Guard**: clients stamp `ts` + `deadline`; bridge skips expired `req-*.json` (`SKIP stale`) and prunes `res-*.json` older than 10 minutes on startup.
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

## Network Mode (Streamable HTTP)

```
 Mac (Claude Code / Antigravity)     Windows VM (Parallels) / Windows PC
 ───────────────────────────────     ──────────────────────────────────────────────────────────
                                     ┌──────────────────────────┐   local IPC     ┌──────────────────────┐
 HTTP POST /mcp  ──────────────────► │ server/http.mjs (Node)   │ ─ C:\…\.ts6-ipc │ ts6_bridge.ps1 (tray)│ ─► COM ─► TopSolid 6
 Authorization: Bearer <TOKEN>       │ MCP Streamable HTTP      │ ◄────────────── │ (interactive desktop)│
                                     │ 0.0.0.0:8765             │                 └──────────────────────┘
 Windows client  ──────────────────► │ (127.0.0.1:8765)         │
                                     └──────────────────────────┘
 Legacy mode: stdio index.mjs ── shared .ts6-ipc ── bridge  (still supported)
```

### Firewall (Windows, Private/Domain networks only)
Installed automatically when running `Install-BridgeService` as Administrator, or run once in an elevated Command Prompt:
```cmd
netsh advfirewall firewall add rule name="TopSolid MCP HTTP" dir=in action=allow protocol=TCP localport=8765 profile=private,domain
```

### Client Configurations
Find your Windows VM IP with `ipconfig` (Parallels Shared Network is typically `10.211.55.x`; reserve a static IP in Parallels Network settings). Copy your Bearer token from **Tray → Settings… → Network (HTTP MCP) → Copy Client Config**.

**Claude Code on macOS (host → Windows VM):**
```bash
claude mcp add --transport http --scope user topsolid6 http://10.211.55.X:8765/mcp --header "Authorization: Bearer <TOKEN>"
```
*(Remove any old stdio entry first with `claude mcp remove topsolid6 --scope user`.)*

**Claude Code on Windows (local VM/PC):**
```bash
claude mcp add --transport http --scope user topsolid6 http://127.0.0.1:8765/mcp --header "Authorization: Bearer <TOKEN>"
```

**stdio-only MCP Client Fallback (macOS / Windows / Linux, including Antigravity `mcp_config.json`):**
```json
{
  "mcpServers": {
    "topsolid6": {
      "command": "node",
      "args": ["<repo>/server/index.mjs", "--remote", "http://10.211.55.X:8765/mcp"],
      "env": { "TS6_HTTP_TOKEN": "<TOKEN>" }
    }
  }
}
```
*(Antigravity `mcp_config.json` also supports remote HTTP servers via `serverUrl` + `headers`: `{ "serverUrl": "http://10.211.55.X:8765/mcp", "headers": { "Authorization": "Bearer <TOKEN>" } }`; if your client version requires stdio, use the `--remote` proxy above.)*

## Bridge Supervision & Exit Codes (v0.3.2)

`agent/ts6_tray_launcher.vbs` runs as a silent supervising watchdog (`TS6_LAUNCHER=1`) that waits for `ts6_bridge.ps1` and handles its exit codes:

| Exit Code | Meaning | Launcher Action |
|---|---|---|
| `0` | User clicked **Exit** in tray (writes `%APPDATA%\TopSolid6MCP\stopped.flag`) | Exits cleanly; does not restart until manual start or next Windows logon |
| `3` | Another bridge instance already holds mutex `Local\TopSolid6McpBridge_v1` | Exits cleanly (prevents duplicate bridges) |
| `10` | Bridge requested restart (**Tray → Restart** or GitHub update) | Restarts bridge immediately, resets backoff |
| Other (`1`, `taskkill /F`, crash) | Unexpected crash / termination | Logs `[LAUNCHER] bridge exited code=N, restart in Ns` and restarts with exponential backoff (`5s → 10s → 20s → 40s → 80s → … → 5 min`, reset after 10 min uptime) |

The Windows Scheduled Task `TopSolid6McpBridge` uses **two triggers**: **At logon** + a **5-minute safety trigger** (`MultipleInstances IgnoreNew`), so even if `wscript.exe` itself is killed, Task Scheduler brings both the launcher and bridge back within 5 minutes.

## Troubleshooting
- **Bridge won't start after clicking Exit:** **Tray → Exit** creates `%APPDATA%\TopSolid6MCP\stopped.flag` so the 5-minute safety trigger won't resurrect a manually stopped bridge during the same Windows session. Start it again via **Start Menu → TopSolid MCP → TopSolid MCP Bridge** or `Start_TopSolid6_Bridge.bat` (both automatically delete `stopped.flag`), or log out and back into Windows (stale flags older than the current logon are ignored and deleted automatically).
- **Bridge won't stop when killing `powershell.exe`:** the supervising launcher (`wscript.exe //B ...\ts6_tray_launcher.vbs`) intentionally restarts a crashed bridge after 5 seconds. To stop cleanly, right-click the tray icon and choose **Exit**.
- **Mac cannot reach Windows port 8765:** check `ping <IP VM>`; ensure Windows network profile is **Private** (`Get-NetConnectionProfile`); verify the firewall rule (`TopSolid MCP HTTP`, TCP 8765, `private,domain`); check `netstat -ano | findstr 8765`.
- **`/healthz` returns 200 OK, but `tools/call` times out:** the Windows tray bridge is not running/paused, or the HTTP gateway and bridge are using different `ipcDir` paths (`ts6_bridge_info` `ipcDir` must match `TS6_IPC_DIR`).
- **`EADDRINUSE` / orphan gateway (`mode: blocked`):**
  - When a previous gateway survives on port `8765` (for example, started elevated while the bridge runs with `RunLevel Limited`), `Start-HttpGateway` first tries `Stop-Process` and `taskkill /T /F`, logging any refusal (`WARN Orphan gateway PID=… kill failed`).
  - If `/healthz` responds with a matching `cfgHash`, the bridge automatically adopts it (`mode: adopted`, `listening: true`).
  - If `cfgHash` does not match (stale token/port/IPC), the bridge enters `mode: blocked` without spinning restarts, shows a tray balloon, and exposes **Tray → Kill stale gateway PID … (admin)** (`taskkill -Verb RunAs`).
  - If a foreign process occupies port `8765`, `mode: blocked` reports its process name & PID and automatically recovers via exponential backoff once the port is freed.
- **Parallels VM IP changes after VM recreate:** assign a DHCP reservation in Parallels Settings → Network or set a static IPv4 address in Windows.
