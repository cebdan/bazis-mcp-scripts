# Bazis MCP — Agent Capabilities Guide

> **Experimental / Test Project:** Reference for driving **Bazis-Mebelshchik 2022 and newer** via `bazis-mcp-scripts`. No specific Bazis build or minor version is required or guaranteed.

## 1. Overview & Connection

- **MCP server entrypoint:** `node /path/to/bazis-mcp-scripts/server/index.mjs` (zero external dependencies, Node.js >= 16).
- **Bridge agent:** `agent/bridge.js` running inside Bazis 2022+ (`Scripts -> bridge.js`).
- **Transport:** On macOS + Parallels VM, the server automatically uses **Shared-Folder IPC** (`.bridge-ipc/` discovered via `.bridge-endpoint.json`), which works even while `Bazis.exe` is blocked in Windows Firewall and VPN is active. For a separate Windows PC over LAN, set `BAZIS_BRIDGE_URL` and `BAZIS_BRIDGE_TOKEN`.
- **Direct CLI mode (for testing or shell-based agents):**
  ```bash
  node /path/to/bazis-mcp-scripts/server/index.mjs --health
  node /path/to/bazis-mcp-scripts/server/index.mjs --call bazis_get_bom '{}'
  node /path/to/bazis-mcp-scripts/server/index.mjs --eval 'return Model.Count;'
  ```

## 2. Coordinate System & Core Concepts

- **Units:** All dimensions and coordinates are in **millimeters (mm)**; rotation angles are in **degrees**.
- **Global axes:**
  - `X`: width, left to right (`0` = left edge)
  - `Y`: height, bottom to top (`0` = floor)
  - `Z`: depth, back to front (`0` = back wall)
- **Panel orientations (`bazis_create_panel`):**
  - `horiz` — lies in X–Z plane at height `y` (`x1, z1, x2, z2, y`); thickness extends along `+Y`.
  - `vert` — lies in Z–Y plane at position `x` (`z1, y1, z2, y2, x`); thickness extends along `+X`.
  - `front` — lies in X–Y plane at depth `z` (`x1, y1, x2, y2, z`); thickness extends along `+Z`.
- **UIDs:** Every object, block, and panel in Bazis has a stable integer `uid` returned by `bazis_get_model`, `bazis_get_bom`, and creation tools. Pass `uid` / `uids` / `carcassUid` to modify, band, groove, fasten, transform, or delete objects.
- **File paths:** Bazis runs on Windows. Any tool taking `filename` (`bazis_scene_action`, `bazis_export`) expects a **Windows path**. To share exported files directly with macOS in Parallels, write to your shared folder path (e.g. `Z:\path\to\bazis-mcp-scripts\<name>`).

## 3. MCP Tools Catalog (35 Tools)

### A. Status, Inspection & BOM

1. **`bazis_health`** `{}`
   - Verifies Bazis bridge connectivity and returns `apiVersion`, `transport` (`"ipc"` or `"http"`), `articleName`, `modelFilename`, `objectCount`, and `uptimeMs`.
2. **`bazis_get_model`** `{ maxDepth?: number }`
   - Returns full model snapshot: `filename`, `article`, `activeMaterial`, global `bounds` (`size`, `min`, `max`), `count`, `selectionCount`, and recursive `objects` tree with UIDs, positions, `gabMin`/`gabMax`, and per-panel metadata (`thickness`, `contourWidth`, `contourHeight`, `materialName`, `butts`, `cuts`, `plasticsCount`).
3. **`bazis_get_bom`** `{}`
   - Extracts a structured cut list / Bill of Materials for every panel in the model (including nested block `path`, `width`, `height`, `thickness`, `areaM2`, `material`, `butts`, `cutsCount`, `plasticsCount`) plus `materialSummary` (total piece count and total area in m² per material+thickness).
4. **`bazis_check_model`** `{ objIntersection?, fastIntersection?, fastIncorrect?, panelNotFixed?, panelTooLarge?, plasticTooLarge?, matNotExists?, matOutOfStock? }`
   - Runs Bazis's built-in `NewModelInspector` and returns `{ errorCount, errors: [{ type, message, objectsNames, objectUids }] }`.

### B. Building Furniture Geometry

5. **`bazis_create_panel`** `{ orientation: "horiz"|"vert"|"front", name?, x1?, x2?, y1?, y2?, z1?, z2?, x?, y?, z?, thickness?, material?: { name, thickness }, textureOrientation?: 0|1|2, viewAll? }`
   - Creates and commits a single rectangular panel and returns its committed object with real `uid`.
6. **`bazis_create_carcass`** `{ width, height, depth, name?, x?, y?, z?, thickness?, materialName?, topMode?: "between"|"overlay", bottomMode?: "between"|"underlay", plinthHeight?, addPlinth?, plinthSetback?, backPanel?, backThickness?, backMaterialName?, backInset?, shelves?, shelfSetback?, viewAll? }`
   - Creates a complete parametric cabinet carcass block (`Left Side`, `Right Side`, `Bottom`, `Top`, optional `Plinth`, `Shelf 1..N`, and `Back Panel`) and returns the committed block with all child panel UIDs.
7. **`bazis_add_doors`** `{ configFile?, dir?, leftPanelUid?, rightPanelUid?, topPanelUid?, bottomPanelUid?, silent?, showErrors?, carcassUid?, name?, count?: 1|2, mountType?: "overlay"|"inset", hingeSide?: "left"|"right", x?, y?, z?, width?, height?, depth?, carcassThickness?, plinthHeight?, thickness?, gap?, materialName?, edgeMaterial?, edgeThickness?, handleFile?, viewAll? }`
   - **Native Bazis DoorsMaker mode:** pass `configFile` (saved DoorsMaker config) + either `carcassUid` (auto-detects left/right/top/bottom panels) or explicit `leftPanelUid`/`rightPanelUid`/`topPanelUid`/`bottomPanelUid` to run `NewDoorsMaker().Load(configFile)` + `Setup(...)`.
   - **Parametric mode:** omits `configFile` to add 1 or 2 overlay/inset doors auto-fitted to `carcassUid` (or explicit bounds), with optional 4-side edge banding and `.f3d` handles.
8. **`bazis_add_drawers`** `{ configFile?, dir?, leftPanelUid?, rightPanelUid?, topPanelUid?, bottomPanelUid?, showErrors?, carcassUid?, name?, count?: 1..12, mountType?: "overlay"|"inset", x?, y?, z?, width?, height?, depth?, carcassThickness?, plinthHeight?, boxThickness?, bottomThickness?, frontThickness?, boxDepth?, slideClearance?, frontGap?, boxHeightRatio?, materialName?, bottomMaterialName?, frontMaterialName?, edgeMaterial?, edgeThickness?, viewAll? }`
   - **Native Bazis BoxesMaker mode:** pass `configFile` (saved BoxesMaker config) + either `carcassUid` (auto-detects left/right/top/bottom panels) or explicit `leftPanelUid`/`rightPanelUid`/`topPanelUid`/`bottomPanelUid` to run `NewBoxesMaker().Load(configFile)` + `Setup(...)`.
   - **Parametric mode:** omits `configFile` to create 1–12 stacked drawer blocks (left/right sides, back, inner front, bottom, and facade front) auto-fitted to `carcassUid` or explicit opening dimensions.

### C. Panel Machining & Edge Banding

9. **`bazis_panel_butt`** `{ uid, action?: "apply"|"inspect_edges", edges?: "all"|"visible"|number[], visibilityDistance?, clearExisting?, material?, thickness?, width?, sign?, clipPanel?, overhung?, allowance? }`
   - With `action: "inspect_edges"`: lists contour edge indices, endpoints, lengths, and current butts.
   - Otherwise: applies edge banding to all edges, only unoccluded visible edges (`"visible"`), or specific edge indices.
10. **`bazis_panel_cut`** `{ uid, name?, sign?, width?, depth?, frontSide?, side?: "left"|"right"|"top"|"bottom"|"back"|"front", offset?, endInset?, trajectory?: { x1, y1, x2, y2 } }`
    - Adds a straight groove / dado (`AddCut`) on a panel using either a named side + offset or explicit 2D local trajectory coordinates.
11. **`bazis_panel_cutout`** `{ uid, shape?: "rect"|"circle", mode?: "subtract"|"add"|"hole"|"inner", x1?, y1?, x2?, y2?, cornerRadius?, cx?, cy?, radius? }`
    - Subtracts or adds a rectangle (optional rounded corners) or circle to a panel's 2D contour, or creates an inner circular hole (`mode: "hole"`).
12. **`bazis_panel_edit_contour`** `{ uid, action?: "elastic"|"fit"|"rounding"|"chamfer"|"symmetry"|"offset"|"load_frw", x1?, y1?, x2?, y2?, dx?, dy?, x?, y?, radius?, length?, corners?, copy?, offset?, side?, rounding?, replace?, file?, viewAll? }`
    - Full 2D contour editing on a panel: rubber-band stretch (`Contour.Elastic`), fit (`Contour.Fit`), single or batch corner rounding (`Rounding`) and chamfers (`Facet`), 2D mirror (`Symmetry`), equidistant offset (`AddEquidistant`), and `.frw` contour loading (`Load`).
13. **`bazis_panel_plastic`** `{ uid, action?: "add"|"clear", side?: "front"|"back"|"both", material?, thickness? }`
    - Adds or clears laminate/veneer/plastic facing on a panel's front, back, or both faces.
14. **`bazis_object_edit`** `{ action: "elastic_resize"|"copy"|"mirror"|"group", uid?, uids?, name?, asAssembly?, size?, count?, offset?, plane?, coord?, point?, normal?, deleteOriginal?, viewAll? }`
    - 3D editing operations: `elastic_resize` (`ElasticResize`), `copy` / linear array (`AddCopy`), 3D `mirror` (`AddSymmetry`), and `group` into a Block or Assembly (`AddBlock` / `AddAssembly`).
15. **`bazis_create_profile`** `{ mode?: "extrusion"|"trajectory", name?, materialName?, length?, profile?, trajectory?, position?, rotate?, viewAll? }`
    - Creates linear extrusion profiles (`AddExtrusion`) or swept profiles along a 2D path (`AddTrajectory`) for moldings, plinths, handle profiles, and cornices.

### D. Fasteners & Hardware (`.f3d`)

12. **`bazis_list_fasteners`** `{ filter?, limit? }`
    - Scans Bazis `Accessories` and `Fragments` directories (plus `BAZIS_ACCESSORIES_DIR` if set) and returns available `.f3d` files with names, categories, and paths.
13. **`bazis_mount_fastener`** `{ file, mode?: "between"|"plane"|"scheme"|"box", panel1Uid?, panel2Uid?, count?, indent?, points?, position?, basisPoint?, size?, axisZ?, axisY? }`
    - Mounts a `.f3d` fastener/accessory:
      - `between`: mounts between `panel1Uid` and `panel2Uid`; if `points` is omitted, automatically computes `count` evenly spaced points along the touching seam with `indent` mm from each end.
      - `plane`: mounts onto `panel1Uid` at `points: [{ x, y, z, angle? }]`.
      - `scheme`: mounts a fastener scheme (`inside`/`outside`/`up`/`down`).
      - `box`: mounts a parametric box fragment (`position`, `size`, `axisZ`, `axisY`).

### E. Materials, Transforms & Deletion

14. **`bazis_materials`** `{ action?: "get"|"set_active"|"assign", name?, thickness?, width?, textureOrientation?: 0|1|2, uid?, uids? }`
    - `get`: returns current `activeMaterial` and `usedMaterials` summary.
    - `set_active`: sets the active material for subsequently created panels.
    - `assign`: updates material name, thickness, and/or texture orientation on existing panel(s) or all panels inside block UID(s), with Undo support.
15. **`bazis_transform_object`** `{ uid, name?, visible?, translate?: { x, y, z }, rotate?: { axis: "x"|"y"|"z", angle } }`
    - Renames, toggles visibility, translates in global coordinates, or rotates an object/block by UID with `Undo.Changing` / `Undo.RecursiveChanging`.
16. **`bazis_delete_object`** `{ uid?, uids? }`
    - Deletes one or multiple objects/blocks/panels by UID in a single commit.

### F. Libraries (`.fr3d` / `.b3d` / `.f3d`), Scene, Documents & Export

17. **`bazis_list_library`** `{ library?: "all"|"fragments"|"accessories"|"templates"|"blum"|"doors"|"drawers"|"custom", filter?, extensions?, dir?, limit? }`
    - Scans Bazis library folders under `C:\Users\<user>\Documents\Bazis` (Fragments, Accessories, Templates, Blum, Doors library, Drawer library) plus `BAZIS_LIBRARIES_DIR` / `dir`.
18. **`bazis_open_library`** `{ file, library?, dir?, mode?: "insert"|"open", name?, wrapInBlock?, position?: { x, y, z }, rotate?: { axis, angle }, elasticSize?: { x, y, z }, viewAll? }`
    - `mode: "insert"` (default): loads `.fr3d`/`.b3d`/`.f3d` into the current scene (wrapped in a named Block by default), optionally translating, rotating, and calling `ElasticResize(elasticSize)` if the fragment is elastic (`IsElastic()`).
    - `mode: "open"`: opens the file as the active Bazis document (`Action.LoadModel`).
19. **`bazis_save_library`** `{ file, library?: "fragments"|"accessories"|"templates"|"blum"|"custom", dir?, format?: "fr3d"|"b3d"|"f3d", articleName?, articleCode?, datumMode?: 0..7, overwrite?: boolean, commit?: boolean }`
    - Saves the active model/fragment into the target Bazis library folder (auto-creating subfolders and appending the library's default extension if omitted; requires `overwrite: true` to replace an existing file).
20. **`bazis_bbb_read`** `{ file, dir?, mode?: "summary"|"item"|"full", index?, name? }`
    - Decodes any Bazis Binary XML file (`.bbb` Drawer library, `.bdl`, `BoxesMaker.Save()` output) into JSON: `mode: "summary"` lists all drawer systems, dimensions, and nominal lengths; `mode: "item"` returns one drawer's full AST; `mode: "full"` returns the entire file AST.
21. **`bazis_bbb_write`** `{ file, dir?, overwrite?, append?, activeIndex?, validateWithBazis?, boxes?, ast? }`
    - Generates or updates a native Bazis `.bbb` drawer library (e.g. `Blum.bbb`, `GTV.bbb`, `Boyard.bbb`) from friendly high-level `StandartBox` / `SysBox` specs (or a raw AST) and verifies it in Bazis via `NewBoxesMaker().Load()`.
22. **`bazis_bxf_to_bbb`** `{ bxfFile?, bxfFiles?, targetFile?, name?, append?, overwrite?, dryRun? }`
    - Parses one or more Blum E-SERVICES `Bazis (*.bxf2)` XML files from macOS (e.g. `~/Downloads/MOVENTO-....bxf2`), extracts official Blum article numbers, panel formulas, bottom groove, and exact System 32 cabinet-side drilling offsets, merges multiple nominal lengths into a single drawer spec, and writes/verifies the `.bbb` library in Bazis.
23. **`bazis_db_info`** `{ dbPath?, port? }`
    - Inspects the Bazis Firebird 2.5 Materials Database (`.fdb`): auto-detects `isql.exe`, port from `firebird.conf` (`14357`), and `.fdb` path; returns row counts, material types, measures, and sample material groups.
24. **`bazis_db_query`** `{ search?, article?, groupId?, limit?, sql?, dbPath? }`
    - Searches materials in the Firebird 2.5 Materials Database by name/article/groupId or executes a read-only `SELECT` SQL query.
25. **`bazis_db_execute`** `{ action?: "upsert_material"|"sql", id?, name?, article?, groupId?, measureId?, price?, weight?, comment?, sql?, backup?, dbPath? }`
    - Inserts/updates materials (`action: "upsert_material"`) or executes write SQL (`INSERT`/`UPDATE`/`DELETE`) in the Firebird 2.5 Materials Database, automatically creating a dated `.fdb.bak_YYYYMMDD` backup before writing unless `backup: false`.
26. **`bazis_scene_action`** `{ action: "view_all"|"orient_camera"|"new_model"|"save_model"|"load_model"|"save_project"|"load_project"|"arrange_positions", filename?, dir?: { x, y, z }, mode?: 0|1|2 }`
    - Controls viewport (`view_all`, `orient_camera`), document lifecycle (`new_model`, `save_model`, `load_model`, `save_project`, `load_project`), and part position numbering (`arrange_positions`: `0=All, 1=New, 2=Check`).
27. **`bazis_screenshot`** `{ target?: "bazis"|"screen", filename?, viewAll?, orientCamera?: "iso"|"front"|"back"|"left"|"right"|"top"|{x,y,z}, returnBase64? }`
    - Captures a PNG screenshot of the live Bazis window (`target: "bazis"`, default) or full primary display (`target: "screen"`), optionally orienting the camera and fitting the view first, and returns a native MCP `image` content block (plus optional saved file path).
27. **`bazis_export`** `{ format?: "bom_csv"|"bom_json"|"svg", filename, uid?, curveQuality?, groupElems? }`
    - Exports a panel's 2D contour as SVG (`uid` required) or the full model BOM as CSV/JSON to a Windows file path.

### G. Running Existing Scripts & Arbitrary Scripting

28. **`bazis_list_scripts`** `{ filter?, dir?, limit?, includeBridge? }`
    - Scans `C:\Users\<user>\Documents\Bazis\Scripts` (plus `BAZIS_SCRIPTS_DIR`, `Z:\Documents\Claude\bazis-mcp\scripts`, or custom `dir`) for `.js` scripts (excluding `bridge.js` by default).
29. **`bazis_run_script`** `{ file, dir?, params?, mode?: "sandboxed"|"include", commit?: boolean, allowAlerts?: boolean, allowDialogs?: boolean }`
    - Runs an existing Bazis `.js` script file by name, relative path, or full Windows path.
    - Default `mode: "sandboxed"` strips UTF-8 BOM, intercepts `Action.Finish()` / `Cancel()` / `Continue()` so the MCP bridge stays alive, resolves relative `system.include()` inside the same sandbox, captures `system.log()` / `alert()` into `logs` / `alerts`, and suppresses blocking `ask*` / `prompt` / `confirm` dialogs into `dialogs` (unless `allowAlerts` / `allowDialogs` are enabled).
    - Auto-commits (`Action.Commit()`) unless `commit: false` or the script already committed/canceled.
30. **`bazis_eval`** `{ code, params?, commit?: boolean }`
    - Executes a JavaScript function body directly inside Bazis 2022 with full API access (`Model`, `Action`, `ActiveMaterial`, `Article`, `Undo`, `AddHorizPanel`, `AddVertPanel`, `AddFrontPanel`, `BeginBlock`/`EndBlock`, `NewContour`, `OpenFurniture`, etc.).
    - Helpers injected into `code`: `log(...)` (captured and returned in `logs`) and `params` (input JSON object). Return any JSON-serializable value.

## 4. Recommended Agent Workflows

### Build and verify a complete cabinet
1. `bazis_health` — verify Bazis bridge is running.
2. `bazis_materials` (`action: "set_active"`) — set desired board material/thickness.
3. `bazis_create_carcass` — create the carcass block and note its `uid` and child panel UIDs.
4. `bazis_add_doors` or `bazis_add_drawers` — pass `carcassUid` and `plinthHeight` so fronts align automatically.
5. `bazis_panel_butt` — band visible edges (`edges: "visible"`) on carcass panels.
6. `bazis_list_fasteners` → `bazis_mount_fastener` — mount confirmat/minifix/dowels along panel seams.
7. `bazis_check_model` (`objIntersection: true`) — verify 0 geometric intersections.
8. `bazis_get_bom` or `bazis_export` (`format: "bom_csv"`) — output cut list and material totals.

## 5. Important Gotchas for Agents

- **Post-commit handle invalidation (`bazis_eval` only):** Calling `Action.Commit()` inside Bazis transfers newly created script objects into `Model` and invalidates pre-commit JS wrapper references. Never read properties of a newly created `panel` variable *after* `Action.Commit()` — re-read the committed object from `Model.Objects` instead. (All built-in tools already handle this safely.)
- **Panel local 2D coordinates:** `bazis_panel_cut` (`trajectory`), `bazis_panel_cutout`, and `bazis_panel_butt` (`inspect_edges`) operate in the panel's **2D local contour coordinates** (`0..ContourWidth`, `0..ContourHeight`), not global 3D XYZ. Call `bazis_panel_butt` with `action: "inspect_edges"` first whenever unsure which edge index corresponds to front/back/top/bottom.
- **Undo discipline in `bazis_eval`:** Before modifying an existing object from `Model`, call `Undo.Changing(obj)` (or `Undo.RecursiveChanging(block)` for blocks), then `obj.Build()`, then `Action.Commit()`.
- **Non-blocking UI:** Avoid `alert()`, `prompt()`, `confirm()`, or `GetPoint()` inside `bazis_eval` — modal dialogs block the Bazis event loop until a human clicks in the Windows UI.
