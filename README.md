# bazis-mcp-scripts

> **Note:** This is an **experimental / test project** for working with **Bazis-Mebelshchik 2022 and newer** via MCP (Model Context Protocol) and JavaScript scripts. No specific Bazis build or minor version is required or guaranteed — available scripting features depend on your Bazis installation. No proprietary Bazis files, libraries, databases, or SDK typings are included in this repository.

Zero-dependency MCP (Model Context Protocol) server and script bridge that lets an AI agent inspect and drive **Bazis-Mebelshchik 2022+** from macOS (or Windows).

## Architecture

```
Mac (Claude Code / Claude Desktop / Cursor / Antigravity)
  └── stdio MCP ──> server/index.mjs (zero-dependency Node.js)
                       ├── Shared-folder IPC (.bridge-ipc/) ──> agent/bridge.js (Parallels VM, works even with Bazis firewalled & VPN on)
                       └── HTTP (+ Bearer token)            ──> agent/bridge.js (local Windows or separate PC over LAN)
```

- **`agent/bridge.js`**: runs inside Bazis 2022+ via the **Scripts** menu using its embedded Node.js runtime (`Action.Continue()`). Runs both:
  - **Shared-folder IPC** (`.bridge-ipc/` inside the shared Parallels repo folder) — works even when `Bazis.exe` is completely blocked in Windows Firewall and a VPN is active;
  - **HTTP server** (default `127.0.0.1:18765`, configurable via `BAZIS_BRIDGE_HOST=0.0.0.0`) for local Windows tools or a separate Windows PC over LAN.
- **`server/index.mjs`**: zero-dependency Node.js (`>= 16`) MCP stdio server. Automatically discovers `.bridge-endpoint.json` / `.bridge-ipc/` in the repo root (or uses `BAZIS_BRIDGE_URL` / `BAZIS_BRIDGE_TOKEN` for a separate PC).

## Setup (Mac + Parallels Windows VM)

No Windows Firewall changes, no port forwarding, and no `npm install` are required — `Bazis.exe` can remain completely blocked in Windows Firewall and VPN can stay on.

### 1. Copy the agent script into Bazis on Windows

Copy `agent/bridge.js` to your Bazis scripts folder:

```
C:\Users\<you>\Documents\Bazis\Scripts\bridge.js
```

### 2. Start the bridge inside Bazis 2022+

Open Bazis-Mebelshchik 2022+ → **Scripts** menu → run `bridge.js`.

In the Bazis Properties panel you will see:
- **MCP Bridge URL** (`http://127.0.0.1:18765 + Shared IPC`)
- **Status** (`Listening (Shared IPC + ...)`)
- **Stop MCP Bridge** button (cleanly stops the bridge and removes `.bridge-endpoint.json`)

### 3. Verify from macOS

```bash
node /path/to/bazis-mcp-scripts/server/index.mjs --health
```

### 4. Register the MCP server on macOS

No `npm install` is required — only Node.js (`>= 16`).

**Claude Code (CLI):**
```bash
claude mcp add bazis -- node ~/Documents/bazis-mcp-scripts/server/index.mjs
```

**Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) / Cursor / Antigravity:**
```json
{
  "mcpServers": {
    "bazis": {
      "command": "node",
      "args": ["/Users/<your-mac-user>/Documents/Claude/bazis-mcp/server/index.mjs"]
    }
  }
}
```

### Connecting to a separate Windows PC (without shared folder)

Set `BAZIS_BRIDGE_URL` and `BAZIS_BRIDGE_TOKEN` (copied from the Bazis Properties panel) in the MCP server `env`:

```json
{
  "mcpServers": {
    "bazis": {
      "command": "node",
      "args": ["/Users/<your-mac-user>/Documents/Claude/bazis-mcp/server/index.mjs"],
      "env": {
        "BAZIS_BRIDGE_URL": "http://192.168.1.50:18765",
        "BAZIS_BRIDGE_TOKEN": "<token-from-bazis-ui>"
      }
    }
  }
}
```

## Available MCP Tools (34)

| Tool | Description |
| --- | --- |
| `bazis_health` | Check bridge connectivity, API version, active model, object count, URLs |
| `bazis_get_model` | Recursive model tree, bounding box, active material, panel metadata |
| `bazis_get_bom` | Cut list / Bill of Materials for all panels with edge banding & material area summary |
| `bazis_create_panel` | Create a horizontal, vertical, or frontal panel (mm) |
| `bazis_create_carcass` | Create a parametric cabinet carcass block (sides, top, bottom, plinth, back, shelves) |
| `bazis_panel_butt` | Inspect panel contour edges or apply edge banding (all, visible, or by edge index) |
| `bazis_panel_cut` | Add a straight groove / dado (`AddCut`) by side+offset or explicit 2D trajectory |
| `bazis_panel_cutout` | Subtract/add rectangular or circular cutouts/holes in a panel's 2D contour |
| `bazis_panel_edit_contour` | Edit a panel's 2D contour: rubber-band stretch (`elastic`), `fit`, corner `rounding`/`chamfer`, 2D `symmetry`, `offset`, or `load_frw` |
| `bazis_panel_plastic` | Add or clear laminate / veneer / plastic facing on a panel's front, back, or both faces |
| `bazis_object_edit` | 3D editing: `elastic_resize` on elastic blocks/fragments, `copy`/linear array, 3D `mirror`, or `group` into a block/assembly |
| `bazis_create_profile` | Create 3D profiles via linear `extrusion` (`AddExtrusion`) or path sweep (`AddTrajectory`) |
| `bazis_list_fasteners` | Scan Bazis Accessories / Fragments folders for `.f3d` fasteners & furniture |
| `bazis_mount_fastener` | Mount a `.f3d` fastener (`between` two panels with auto seam points, `plane`, `scheme`, or `box`) |
| `bazis_add_doors` | Add cabinet doors via native `NewDoorsMaker` (`configFile`) or parametrically (1–2 overlay/inset doors, edging, handles) |
| `bazis_add_drawers` | Add drawers via native `NewBoxesMaker` (`configFile`) or parametrically (1–12 stacked drawer boxes + fronts) |
| `bazis_materials` | Inspect active/used materials (`get`), set active material (`set_active`), or assign to UIDs (`assign`) |
| `bazis_export` | Export panel contour to `svg`, or BOM to `bom_csv` / `bom_json` |
| `bazis_list_library` | List Bazis library folders & files (`Fragments`, `Accessories`, `Templates`, `Blum`, `Doors`, `Drawers`) |
| `bazis_open_library` | Insert (with position/rotation/elastic resize) or open `.fr3d`/`.b3d`/`.f3d` from a Bazis library |
| `bazis_save_library` | Save the active model/fragment/furniture into a Bazis library folder (auto-mkdir, overwrite guard) |
| `bazis_bbb_read` | Decode a Bazis Drawer Library (`.bbb`) or Binary XML file into JSON summary or full AST |
| `bazis_bbb_write` | Generate or update a native Bazis `.bbb` drawer library (Blum, Hettich, GTV, Boyard, etc.) and verify via `NewBoxesMaker().Load()` |
| `bazis_bxf_to_bbb` | Convert Blum E-SERVICES `Bazis (*.bxf2)` XML export(s) (with official articles, grooves & System 32 drilling) directly into a `.bbb` drawer library |
| `bazis_db_info` | Inspect Bazis Firebird 2.5 Materials Database (`.fdb`) path, port, counts, groups, types, and measures |
| `bazis_db_query` | Search materials in the Firebird 2.5 Materials DB (by name/article/groupId) or run read-only `SELECT` SQL |
| `bazis_db_execute` | Insert/update materials (`upsert_material`) or run write SQL in the Firebird 2.5 Materials DB with auto-backup |
| `bazis_list_scripts` | List available Bazis `.js` scripts in Bazis Scripts folder or custom directory |
| `bazis_run_script` | Run an existing Bazis `.js` script safely inside the bridge (with `Action.Finish`/`alert`/dialog protection) |
| `bazis_delete_object` | Delete object(s) by UID |
| `bazis_transform_object` | Rename, toggle visibility, translate, or rotate an object/block by UID (with Undo) |
| `bazis_check_model` | Run Bazis built-in `NewModelInspector` to find intersections & errors |
| `bazis_scene_action` | `view_all`, `orient_camera`, `new_model`, `save_model`, `load_model`, `save_project`, `load_project`, `arrange_positions` |
| `bazis_eval` | Execute arbitrary JavaScript inside Bazis 2022 with full API access |

## CLI Shortcuts (macOS)

```bash
node ~/Documents/bazis-mcp-scripts/server/index.mjs --health
node ~/Documents/bazis-mcp-scripts/server/index.mjs --call bazis_get_bom '{}'
node ~/Documents/bazis-mcp-scripts/server/index.mjs --eval 'return Model.Count;'
```

## Bridge Environment Variables (Windows / Bazis)

- `BAZIS_BRIDGE_HOST` — HTTP bind address (default `127.0.0.1`; set `0.0.0.0` for LAN PC mode)
- `BAZIS_BRIDGE_PORT` — TCP port (default `18765`)
- `BAZIS_BRIDGE_TOKEN` — fixed auth token (default: random 32-hex per run)
- `BAZIS_BRIDGE_NO_AUTH=1` — disable token check for non-loopback requests
- `BAZIS_BRIDGE_ENDPOINT_FILE` — custom path for `.bridge-endpoint.json`
- `BAZIS_BRIDGE_IPC_DIR` — custom path for `.bridge-ipc` directory
- `BAZIS_ACCESSORIES_DIR` — extra directory to scan for `.f3d` fasteners
