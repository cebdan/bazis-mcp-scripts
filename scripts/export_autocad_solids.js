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
var SUBTRACT_HOLES = true;        // true = subtract true ACIS cylinders (_CYLINDER) for all fastener holes
var SUBTRACT_GROOVES = true;      // true = subtract true ACIS boxes for all panel grooves (panel.Cuts)
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

// Extract all fastener drilling holes that intersect the panel and return
// AutoCAD 3D cylinder endpoints (pStart, pEnd, radius) for exact _SUBTRACT.
function extractPanelDrillCylinders(panel) {
    var out = [];
    var contour = safeGet(function () { return panel.Contour; }, null);
    if (!contour) return out;
    var cMin = safeGet(function () { return contour.Min; }, { x: 0, y: 0 });
    var cMax = safeGet(function () { return contour.Max; }, { x: 0, y: 0 });
    var L = Math.abs(cMax.x - cMin.x);
    var B = Math.abs(cMax.y - cMin.y);
    var T = Number(safeGet(function () { return panel.Thickness; }, 16));
    if (L <= 0 || B <= 0 || T <= 0) return out;

    var fasteners = safeGet(function () { return panel.FindConnectedFasteners(); }, null);
    if (!fasteners || !fasteners.length) return out;

    var seen = {};
    for (var fi = 0; fi < fasteners.length; fi++) {
        var f = fasteners[fi];
        if (!f) continue;
        var holes = safeGet(function () { return f.Holes; }, null);
        if (!holes) continue;
        var hCount = safeGet(function () { return holes.Count; }, 0);

        for (var hi = 0; hi < hCount; hi++) {
            var h = safeGet(function () { return holes[hi]; }, null);
            if (!h) continue;
            var diam = Number(safeGet(function () { return h.Diameter; }, 0));
            var rawDepth = Number(safeGet(function () { return h.Depth; }, 0));
            if (diam <= 0.2 || rawDepth <= 0.2) continue;

            var localPos = safeGet(function () { return h.Position; }, null);
            var localDir = safeGet(function () { return h.Direction; }, null);
            if (!localPos || !localDir) continue;

            var gPos = safeGet(function () { return f.ToGlobal(localPos); }, null);
            var gDir = safeGet(function () { return f.NToGlobal(localDir); }, null);
            if (!gPos || !gDir) continue;

            var pPos = safeGet(function () { return panel.ToObject(gPos); }, null);
            var pDir = safeGet(function () { return panel.NToObject(gDir); }, null);
            if (!pPos || !pDir) continue;

            var dLen = Math.sqrt(pDir.x * pDir.x + pDir.y * pDir.y + pDir.z * pDir.z);
            if (dLen < 1e-6) continue;
            var dx = pDir.x / dLen, dy = pDir.y / dLen, dz = pDir.z / dLen;

            var tol = 1.0;
            var tMin = 0;
            var tMax = rawDepth;

            function clip(s, d, lo, hi) {
                if (Math.abs(d) < 1e-6) return s >= lo - tol && s <= hi + tol;
                var t1 = (lo - s) / d;
                var t2 = (hi - s) / d;
                if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > tMin) tMin = t1;
                if (t2 < tMax) tMax = t2;
                return tMin <= tMax;
            }

            if (!clip(pPos.x, dx, cMin.x, cMax.x)) continue;
            if (!clip(pPos.y, dy, cMin.y, cMax.y)) continue;
            if (!clip(pPos.z, dz, 0, T)) continue;

            var effDepth = tMax - tMin;
            if (effDepth < 0.5) continue;

            // Extend entry end slightly (-0.5mm) and exit end if through-hole (+0.5mm)
            // so ACIS boolean _SUBTRACT has clean non-coplanar faces.
            var isThrough = (tMax >= rawDepth - 0.1) || (effDepth >= T - 0.5);
            var extStart = tMin - 0.5;
            var extEnd = isThrough ? (tMax + 0.5) : tMax;

            var locStart = NewVector(pPos.x + dx * extStart, pPos.y + dy * extStart, pPos.z + dz * extStart);
            var locEnd = NewVector(pPos.x + dx * extEnd, pPos.y + dy * extEnd, pPos.z + dz * extEnd);
            var wStart = toAcadPt(panel.ToGlobal(locStart));
            var wEnd = toAcadPt(panel.ToGlobal(locEnd));

            var key = [
                Math.round(wStart.x * 10), Math.round(wStart.y * 10), Math.round(wStart.z * 10),
                Math.round(wEnd.x * 10), Math.round(wEnd.y * 10), Math.round(wEnd.z * 10),
                Math.round(diam * 10)
            ].join("|");
            if (seen[key]) continue;
            seen[key] = true;

            out.push({ start: wStart, end: wEnd, radius: diam / 2 });
        }
    }
    return out;
}

// Subtract straight panel grooves (panel.Cuts) as exact ACIS 3DSOLID boxes.
function emitPanelGrooveSubtracts(panel, lines) {
    var cuts = safeGet(function () { return panel.Cuts; }, null);
    if (!cuts) return 0;
    var count = safeGet(function () { return cuts.Count; }, 0);
    if (count <= 0) return 0;

    var T = Number(safeGet(function () { return panel.Thickness; }, 16));
    var o0 = toAcadPt(panel.ToGlobal(NewVector(0, 0, 0)));
    var ox = toAcadPt(panel.ToGlobal(NewVector(100, 0, 0)));
    var oy = toAcadPt(panel.ToGlobal(NewVector(0, 100, 0)));
    var oz = toAcadPt(panel.ToGlobal(NewVector(0, 0, T)));
    var vx = { x: ox.x - o0.x, y: ox.y - o0.y, z: ox.z - o0.z };
    var vy = { x: oy.x - o0.x, y: oy.y - o0.y, z: oy.z - o0.z };
    var vz = { x: oz.x - o0.x, y: oz.y - o0.y, z: oz.z - o0.z };
    var cross = { x: vx.y * vy.z - vx.z * vy.y, y: vx.z * vy.x - vx.x * vy.z, z: vx.x * vy.y - vx.y * vy.x };
    var zSign = (cross.x * vz.x + cross.y * vz.y + cross.z * vz.z) >= 0 ? 1 : -1;

    var subtracted = 0;
    lines.push("_UCS _3 " + ptStr(o0) + " " + ptStr(ox) + " " + ptStr(oy));

    for (var i = 0; i < count; i++) {
        var cut = safeGet(function () { return cuts[i]; }, null);
        if (!cut) continue;
        var front = safeGet(function () { return cut.FrontSide !== false; }, true);
        var traj = safeGet(function () { return cut.Trajectory; }, null);
        var prof = safeGet(function () { return cut.Contour; }, null);
        if (!traj) continue;

        var gW = 4, gD = 8;
        if (prof) {
            var pMin = safeGet(function () { return prof.Min; }, null);
            var pMax = safeGet(function () { return prof.Max; }, null);
            if (pMin && pMax) {
                if (Math.abs(pMax.x - pMin.x) > 0.1) gW = Math.abs(pMax.x - pMin.x);
                if (Math.abs(pMax.y - pMin.y) > 0.1) gD = Math.abs(pMax.y - pMin.y);
            }
        }

        var tCount = safeGet(function () { return traj.Count; }, 0);
        for (var j = 0; j < tCount; j++) {
            var el = safeGet(function () { return traj.Objects[j]; }, null);
            var p1 = el ? safeGet(function () { return el.Pos1; }, null) : null;
            var p2 = el ? safeGet(function () { return el.Pos2; }, null) : null;
            if (!p1 || !p2) continue;

            var dx = p2.x - p1.x, dy = p2.y - p1.y;
            var len = Math.sqrt(dx * dx + dy * dy);
            if (len < 0.5) continue;
            var nx = (-dy / len) * (gW / 2);
            var ny = (dx / len) * (gW / 2);

            var z1 = front ? ((T - gD) * zSign) : (-0.5 * zSign);
            var z2 = front ? ((T + 0.5) * zSign) : (gD * zSign);
            var h = z2 - z1;

            lines.push(
                "_PLINE " +
                fmt(p1.x + nx) + "," + fmt(p1.y + ny) + "," + fmt(z1) + " " +
                fmt(p2.x + nx) + "," + fmt(p2.y + ny) + "," + fmt(z1) + " " +
                fmt(p2.x - nx) + "," + fmt(p2.y - ny) + "," + fmt(z1) + " " +
                fmt(p1.x - nx) + "," + fmt(p1.y - ny) + "," + fmt(z1) + " _C"
            );
            lines.push("_EXTRUDE _L  " + fmt(h));
            lines.push("(command \"_SUBTRACT\" _bazis_panel \"\" (entlast) \"\")");
            subtracted++;
        }
    }

    lines.push("_UCS _W");
    return subtracted;
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
    var holesSubtracted = 0;
    var groovesSubtracted = 0;

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

        var createdSolid = false;
        if (isAxisAlignedRectPanel(panel)) {
            var mn = toAcadPt(panel.GabMin);
            var mx = toAcadPt(panel.GabMax);
            var pMin = { x: Math.min(mn.x, mx.x), y: Math.min(mn.y, mx.y), z: Math.min(mn.z, mx.z) };
            var pMax = { x: Math.max(mn.x, mx.x), y: Math.max(mn.y, mx.y), z: Math.max(mn.z, mx.z) };
            lines.push("_BOX " + ptStr(pMin) + " " + ptStr(pMax));
            boxCount++;
            createdSolid = true;
        } else {
            if (emitShapedPanelSolid(panel, lines)) {
                shapedCount++;
                createdSolid = true;
            }
        }

        if (createdSolid) {
            var cyls = SUBTRACT_HOLES ? extractPanelDrillCylinders(panel) : [];
            var hasGrooves = SUBTRACT_GROOVES && safeGet(function () { return panel.Cuts && panel.Cuts.Count > 0; }, false);
            if (cyls.length > 0 || hasGrooves) {
                lines.push("(setq _bazis_panel (entlast))");
                for (var hi = 0; hi < cyls.length; hi++) {
                    var cy = cyls[hi];
                    lines.push("_CYLINDER " + ptStr(cy.start) + " " + fmt(cy.radius) + " _A " + ptStr(cy.end));
                    lines.push("(command \"_SUBTRACT\" _bazis_panel \"\" (entlast) \"\")");
                    holesSubtracted++;
                }
                if (hasGrooves) {
                    groovesSubtracted += emitPanelGrooveSubtracts(panel, lines);
                }
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
        "Drilling holes subtracted: " + holesSubtracted + "\n" +
        "Grooves subtracted: " + groovesSubtracted + "\n" +
        "Layers created: " + Object.keys(layerColors).length + "\n\n" +
        "In AutoCAD: run SCRIPT and select this .scr file (or drag-and-drop it into AutoCAD)."
    );
    Action.Finish();
}

main();
