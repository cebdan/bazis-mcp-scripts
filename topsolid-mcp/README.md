# TopSolid'Wood 6.25 MCP Server (`topsolid-mcp`)

Zero-dependency MCP stdio server + Windows COM bridge for **TopSolid'Wood 6.25** (`TopSolid.Application`),
communicating via atomic Shared-Folder IPC (`.ts6-ipc/` — works seamlessly across macOS + Parallels / MEGA sync
or locally on Windows).

## Tools
- `ts6_health` — TopSolid version, open document count, active document, templates dir.
- `ts6_list_templates` — list `B&S_*.top` native process templates in `Y:\Works\bazis\TopSolid_Templates\`.
- `ts6_new_doc` — create a new `.top` design document.
- `ts6_list_elements` — list shapes (Name, Designation, Reference, Layer, Operations.Count) and components.
- `ts6_create_block` — create a native Parasolid rectangular panel (`AddBasicBlock`, mm).
- `ts6_insert_component` — insert a `.top` process template at a 3D coordinate system (`AddWithPositioningByCoordinateSystems`).
- `ts6_eval_vbs` — run VBScript directly against live `TopSolid.Application` (`app`) and `CurrentDocument` (`doc`).

## Quick Start
1. **On Windows (where TopSolid 6.25 is open):** run `Start_TopSolid6_Bridge.bat`.
2. **Health check from macOS or Windows:**
   ```bash
   node /Users/user/MEGA/Works/cnc/topsolid-mcp/server/index.mjs --health
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
