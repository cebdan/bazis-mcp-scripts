// Bazis-Mebelshchik 2022+ Script: Export Clean 3D Solids to AutoCAD (.scr)
//
// Exports every visible panel in the active Bazis model as a TRUE native
// AutoCAD ACIS 3DSOLID (ZERO triangles, ZERO meshes, ZERO facet bloat):
//   - Rectangular axis-aligned panels -> native AutoCAD _BOX (exact 6-face 3DSOLID)
//   - Shaped / curved / rotated panels -> exact _UCS + _PLINE (with arcs) + _EXTRUDE
//   - Panels with inner cutouts/holes  -> exact boolean _SUBTRACT of inner 3DSOLIDs
//   - Organizes solids onto clean AutoCAD layers by Material (or Unit)
//   - Automatically converts Bazis Y-up coordinates to AutoCAD Z-up coordinates
//
// Usage in AutoCAD:
//   Run command SCRIPT (or drag-and-drop the exported .scr file into AutoCAD).

// --- Configuration --------------------------------------------------------
var SWAP_YZ_FOR_AUTOCAD = true;   // true = Bazis (X, Y-up, Z) -> AutoCAD (X, Z, Y-up)
var LAYER_MODE = "material";      // "material" | "unit"
var DECIMAL_PLACES = 3;           // Coordinate precision in mm
var SET_SHADED_VIEW = true;       // Switch AutoCAD viewport to Shaded + Zoom Extents at end
// --------------------------------------------------------------------------

function safeGet(fn, fallback) {
    try {
        var v = fn();
        return v === undefined || v === null ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function fmt(n) {
    var num = Number(n || 0);
    if (!isFinite(num)) return "0";
    var f = Math.pow(10, DECIMAL_PLACES);
    var r = Math.round(num * f) / f;
    if (Math.abs(r) < 1e-6) r = 0;
    return String(r);
}

function toAcadPt(v) {
    if (SWAP_YZ_FOR_AUTOCAD) {
        return { x: v.x, y: v.z, z: v.y };
    }
    return { x: v.x, y: v.y, z: v.z };
}

function ptStr(p) {
    return fmt(p.x) + "," + fmt(p.y) + "," + fmt(p.z);
}

function cleanMatName(raw) {
    var s = String(raw || "Default").trim();
    if (typeof ExtractMatName === "function") {
        try {
            var e = ExtractMatName(s);
            if (e) s = String(e).trim();
        } catch (err) {}
    }
    var cr = s.indexOf("\r");
    if (cr !== -1) s = s.slice(0, cr).trim();
    return s || "Default";
}

function sanitizeLayerName(name) {
    return String(name || "Default")
        .replace(/[<>/\\\":;?*|,=`]+/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 64) || "Default";
}

function collectPanels(obj, topUnitName, out) {
    if (!obj) return;
    if (!safeGet(function () { return obj.Visible; }, true)) return;
    var p = safeGet(function () { return obj.AsPanel; }, null);
    if (p) {
        out.push({ panel: p, unitName: topUnitName || "Model" });
        return;
    }
    if (safeGet(function () { return obj.List; }, false)) {
        var list = safeGet(function () { return obj.AsList(); }, null);
        if (list) {
            for (var i = 0; i < safeGet(function () { return list.Count; }, 0); i++) {
                collectPanels(safeGet(function () { return list.Objects[i]; }, null), topUnitName, out);
            }
        }
    }
}

// Check if panel is axis-aligned rectangular (so we can emit a pure 1-command _BOX)
function isAxisAlignedRectPanel(panel) {
    if (!safeGet(function () { return panel.IsContourRectangle; }, false)) return false;
    var contour = safeGet(function () { return panel.Contour; }, null);
    if (!contour || safeGet(function () { return contour.Count; }, 0) !== 4) return false;

    // Verify local axes align with global X/Y/Z axes
    var ux = safeGet(function () { return panel.NToGlobal(NewVector(1, 0, 0)); }, null);
    var uy = safeGet(function () { return panel.NToGlobal(NewVector(0, 1, 0)); }, null);
    var uz = safeGet(function () { return panel.NToGlobal(NewVector(0, 0, 1)); }, null);
    if (!ux || !uy || !uz) return false;

    function isAxis(v) {
        var ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
        return (ax > 0.999 && ay < 0.001 && az < 0.001) ||
               (ay > 0.999 && ax < 0.001 && az < 0.001) ||
               (az > 0.999 && ax < 0.001 && ay < 0.001);
    }
    return isAxis(ux) && isAxis(uy) && isAxis(uz);
}

// Build exact closed loops from panel.Contour elements (lines, arcs, circles)
function emitShapedPanelSolid(panel, lines) {
    var contour = safeGet(function () { return panel.Contour; }, null);
    var thickness = Number(safeGet(function () { return panel.Thickness; }, 16));
    if (!contour || thickness <= 0) return false;

    var o0 = toAcadPt(panel.ToGlobal(NewVector(0, 0, 0)));
    var ox = toAcadPt(panel.ToGlobal(NewVector(100, 0, 0)));
    var oy = toAcadPt(panel.ToGlobal(NewVector(0, 100, 0)));
    var oz = toAcadPt(panel.ToGlobal(NewVector(0, 0, thickness)));

    // Compute signed extrusion height along AutoCAD right-handed UCS Z = (ox-o0) x (oy-o0)
    var vx = { x: ox.x - o0.x, y: ox.y - o0.y, z: ox.z - o0.z };
    var vy = { x: oy.x - o0.x, y: oy.y - o0.y, z: oy.z - o0.z };
    var vz = { x: oz.x - o0.x, y: oz.y - o0.y, z: oz.z - o0.z };
    var cross = {
        x: vx.y * vy.z - vx.z * vy.y,
        y: vx.z * vy.x - vx.x * vy.z,
        z: vx.x * vy.y - vx.y * vy.x
    };
    var dot = cross.x * vz.x + cross.y * vz.y + cross.z * vz.z;
    var extrudeH = dot >= 0 ? thickness : -thickness;

    lines.push("_UCS _3 " + ptStr(o0) + " " + ptStr(ox) + " " + ptStr(oy));

    var count = safeGet(function () { return contour.Count; }, 0);
    var circles = [];
    var segs = [];

    for (var i = 0; i < count; i++) {
        var el = safeGet(function () { return contour.Objects[i]; }, null);
        if (!el) continue;
        var elType = safeGet(function () { return el.ElType; }, 0);
        // Bazis Contour2D ElType: 1 = Line, 2 = Arc, 3 = Circle
        if (elType === 3) {
            var cc = safeGet(function () { return el.Center; }, null);
            var cr = Number(safeGet(function () { return el.CirRadius; }, 0));
            if (cc && cr > 0.01) circles.push({ cx: cc.x, cy: cc.y, r: cr });
        } else {
            var p1 = safeGet(function () { return el.Pos1; }, null);
            var p2 = safeGet(function () { return el.Pos2; }, null);
            if (p1 && p2) {
                var mid = null;
                if (elType === 2) {
                    mid = safeGet(function () { return el.ElCenter ? el.ElCenter() : null; }, null);
                }
                segs.push({ type: elType, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mid: mid });
            }
        }
    }

    // Group connected segments into closed loops
    var used = [];
    var loops = [];
    var tol = 0.05;
    function samePt(ax, ay, bx, by) {
        return Math.abs(ax - bx) <= tol && Math.abs(ay - by) <= tol;
    }

    for (var s = 0; s < segs.length; s++) {
        if (used[s]) continue;
        var loop = [segs[s]];
        used[s] = true;
        var curX = segs[s].x2, curY = segs[s].y2;
        var startX = segs[s].x1, startY = segs[s].y1;
        var progress = true;
        while (progress && !samePt(curX, curY, startX, startY)) {
            progress = false;
            for (var n = 0; n < segs.length; n++) {
                if (used[n]) continue;
                if (samePt(segs[n].x1, segs[n].y1, curX, curY)) {
                    loop.push(segs[n]);
                    used[n] = true;
                    curX = segs[n].x2; curY = segs[n].y2;
                    progress = true;
                    break;
                } else if (samePt(segs[n].x2, segs[n].y2, curX, curY)) {
                    loop.push({ type: segs[n].type, x1: segs[n].x2, y1: segs[n].y2, x2: segs[n].x1, y2: segs[n].y1, mid: segs[n].mid });
                    used[n] = true;
                    curX = segs[n].x1; curY = segs[n].y1;
                    progress = true;
                    break;
                }
            }
        }
        loops.push(loop);
    }

    // Estimate area of each loop to distinguish outer boundary (largest) from inner cutouts
    function loopBboxArea(lp) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < lp.length; i++) {
            if (lp[i].x1 < minX) minX = lp[i].x1;
            if (lp[i].y1 < minY) minY = lp[i].y1;
            if (lp[i].x1 > maxX) maxX = lp[i].x1;
            if (lp[i].y1 > maxY) maxY = lp[i].y1;
        }
        return (maxX - minX) * (maxY - minY);
    }

    function emitLoopPline(lp) {
        var cmd = "_PLINE " + fmt(lp[0].x1) + "," + fmt(lp[0].y1);
        var inArc = false;
        for (var i = 0; i < lp.length; i++) {
            var seg = lp[i];
            if (seg.type === 2 && seg.mid) {
                if (!inArc) { cmd += " _A"; inArc = true; }
                cmd += " _S " + fmt(seg.mid.x) + "," + fmt(seg.mid.y) + " " + fmt(seg.x2) + "," + fmt(seg.y2);
            } else {
                if (inArc) { cmd += " _L"; inArc = false; }
                cmd += " " + fmt(seg.x2) + "," + fmt(seg.y2);
            }
        }
        cmd += " _C";
        lines.push(cmd);
    }

    if (loops.length === 0 && circles.length > 0) {
        // Pure circular panel (e.g. round tabletop)
        circles.sort(function (a, b) { return b.r - a.r; });
        var outerC = circles[0];
        lines.push("_CIRCLE " + fmt(outerC.cx) + "," + fmt(outerC.cy) + " " + fmt(outerC.r));
        lines.push("_EXTRUDE _L  " + fmt(extrudeH));
        for (var ci = 1; ci < circles.length; ci++) {
            lines.push("_CIRCLE " + fmt(circles[ci].cx) + "," + fmt(circles[ci].cy) + " " + fmt(circles[ci].r));
            lines.push("_EXTRUDE _L  " + fmt(extrudeH));
        }
    } else if (loops.length > 0) {
        loops.sort(function (a, b) { return loopBboxArea(b) - loopBboxArea(a); });
        // Outer solid
        emitLoopPline(loops[0]);
        lines.push("_EXTRUDE _L  " + fmt(extrudeH));
        // If there are inner cutout loops or inner circles, subtract them cleanly
        var hasInner = loops.length > 1 || circles.length > 0;
        if (hasInner) {
            // Note: outer solid is created first; mark handle via AutoLISP for exact _SUBTRACT
            lines.push("(setq _bazis_outer (entlast))");
            for (var li = 1; li < loops.length; li++) {
                emitLoopPline(loops[li]);
                lines.push("_EXTRUDE _L  " + fmt(extrudeH));
                lines.push("(command \"_SUBTRACT\" _bazis_outer \"\" (entlast) \"\")");
            }
            for (var cj = 0; cj < circles.length; cj++) {
                lines.push("_CIRCLE " + fmt(circles[cj].cx) + "," + fmt(circles[cj].cy) + " " + fmt(circles[cj].r));
                lines.push("_EXTRUDE _L  " + fmt(extrudeH));
                lines.push("(command \"_SUBTRACT\" _bazis_outer \"\" (entlast) \"\")");
            }
        }
    }

    lines.push("_UCS _W");
    return true;
}

function main() {
    var collected = [];
    for (var i = 0; i < Model.Count; i++) {
        var rootObj = Model.Objects[i];
        if (!rootObj) continue;
        var uName = safeGet(function () { return String(rootObj.Name || "Model"); }, "Model");
        collectPanels(rootObj, uName, collected);
    }

    if (collected.length === 0) {
        alert("No visible panels found in the current model to export.");
        Action.Finish();
        return;
    }

    var outPath = system.askFileNameSave("scr");
    if (!outPath) {
        Action.Finish();
        return;
    }
    if (!/\.scr$/i.test(outPath)) {
        outPath += ".scr";
    }

    var lines = [];
    lines.push("; AutoCAD 3DSOLID Export from Bazis-Mebelshchik");
    lines.push("; Article: " + safeGet(function () { return String(Article.Name || ""); }, ""));
    lines.push("; Order: " + safeGet(function () { return String(Article.OrderName || ""); }, ""));
    lines.push("; Panels: " + collected.length + " (pure ACIS 3DSOLIDs, zero triangles)");
    lines.push("(setq _bazis_old_osmode (getvar \"OSMODE\"))");
    lines.push("(setvar \"OSMODE\" 0)");
    lines.push("(setvar \"CMDECHO\" 0)");
    lines.push("_UCS _W");

    var layerColors = {};
    var colorPalette = [7, 3, 4, 5, 6, 2, 1, 30, 40, 140, 210];
    var nextColorIdx = 0;
    var currentLayer = "";
    var boxCount = 0;
    var shapedCount = 0;

    for (var k = 0; k < collected.length; k++) {
        var panel = collected[k].panel;
        var unitName = collected[k].unitName;
        var matName = cleanMatName(safeGet(function () { return panel.MaterialName; }, "Default"));
        var thick = Number(safeGet(function () { return panel.Thickness; }, 16));
        var rawLayer = LAYER_MODE === "unit"
            ? unitName
            : (matName + "_" + fmt(thick) + "mm");
        var layer = sanitizeLayerName(rawLayer);

        if (!layerColors[layer]) {
            var col = colorPalette[nextColorIdx % colorPalette.length];
            nextColorIdx++;
            layerColors[layer] = col;
            lines.push("_-LAYER _M " + layer + " _C " + col + " " + layer + " ");
            currentLayer = layer;
        } else if (currentLayer !== layer) {
            lines.push("_-LAYER _S " + layer + " ");
            currentLayer = layer;
        }

        var pName = safeGet(function () { return String(panel.Name || "Panel"); }, "Panel");
        var pPos = safeGet(function () { return String(panel.ArtPos || ""); }, "");
        lines.push("; Part: " + (pPos ? ("[" + pPos + "] ") : "") + pName);

        if (isAxisAlignedRectPanel(panel)) {
            var mn = toAcadPt(panel.GabMin);
            var mx = toAcadPt(panel.GabMax);
            var pMin = { x: Math.min(mn.x, mx.x), y: Math.min(mn.y, mx.y), z: Math.min(mn.z, mx.z) };
            var pMax = { x: Math.max(mn.x, mx.x), y: Math.max(mn.y, mx.y), z: Math.max(mn.z, mx.z) };
            lines.push("_BOX " + ptStr(pMin) + " " + ptStr(pMax));
            boxCount++;
        } else {
            if (emitShapedPanelSolid(panel, lines)) {
                shapedCount++;
            }
        }
    }

    lines.push("_UCS _W");
    if (SET_SHADED_VIEW) {
        lines.push("_-VPOINT -1,-1,0.8");
        lines.push("_ZOOM _E");
        lines.push("_VSCURRENT _Shaded");
    }
    lines.push("(setvar \"OSMODE\" _bazis_old_osmode)");
    lines.push("(setvar \"CMDECHO\" 1)");
    lines.push("");

    var content = lines.join("\r\n");
    fs.writeFileSync(outPath, content, "utf8");

    alert(
        "AutoCAD 3DSOLID (.scr) export complete!\n" +
        "File: " + outPath + "\n" +
        "Total 3D Solids: " + (boxCount + shapedCount) + " (" + boxCount + " box solids, " + shapedCount + " extruded/shaped solids)\n" +
        "Layers created: " + Object.keys(layerColors).length + "\n\n" +
        "In AutoCAD: run SCRIPT and select this .scr file (or drag-and-drop it into AutoCAD)."
    );
    Action.Finish();
}

main();
