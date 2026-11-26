// Export Bazis-Mebelshchik 2022 model directly into TopSolid'Wood 6 (v6.xx) via COM Automation
// Creates native Parasolid solids (IShapePart, zero triangles) with editable feature-tree
// subtraction operations (IShapeOperation) for:
//   - Rectangular panels (AddBasicBlock) and shaped panels with arcs/cutouts (AddBasicComposite + AddBasicExtruded)
//   - Grooves and pockets (e.g. back panel grooves & Shaker door pockets)
//   - All vertical and horizontal drilling holes (from FindConnectedFasteners().Holes)
//   - Native TopSolid metadata: Name, Designation, Reference, Layer, SetMatter, and BOM TextProperties (Edges, Material, Thickness)
//
// Coordinate mapping (right-handed, mm -> meters):
//   Bazis (X right, Y up, Z front) -> TopSolid (X right, Y = -Z back, Z = Y up)

var fs = require("fs");
var path = require("path");
var os = require("os");
var cp = require("child_process");

var MM_TO_M = 0.001;
// Native TopSolid'Wood 6.25 process mode (default true):
//   1. Generates & caches exact-size B&S_*.top variants via ts6_apply_ops.ps1 (Parameter -> Modify parameter)
//   2. Inserts every native process component at exact 3D Origin CS via COM
//   3. Batch-applies Assembly -> Use process via ts6_apply_ops.ps1 so every panel gets 100% native
//      TopSolid'Wood operations (Wood -> Drilling / Groove / Pocket / Rabbet / Moulding), ZERO AddSubtraction!
var USE_PROCESS_TEMPLATES = true;

function resolveApplyPs1() {
    var candidates = [
        path.resolve(__dirname, "..", "topsolid-mcp", "agent", "ts6_apply_ops.ps1"),
        "Y:\\Works\\cnc\\topsolid-mcp\\agent\\ts6_apply_ops.ps1"
    ];
    for (var i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    return candidates[1];
}

function numKey(n) {
    return String(Math.round(Number(n) * 10) / 10).replace(/\./g, "p");
}

function vSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function vLen(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
function vNorm(v) {
    var l = vLen(v);
    if (l < 1e-9) return { x: 0, y: 0, z: 1 };
    return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function vCross(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x
    };
}
function vDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

// Right-handed transform: Bazis (X, Y, Z) mm -> TopSolid (X, -Z, Y) meters
function toTsPt(v) {
    return { x: v.x * MM_TO_M, y: -v.z * MM_TO_M, z: v.y * MM_TO_M };
}
function toTsDir(v) {
    return vNorm({ x: v.x, y: -v.z, z: v.y });
}

function fmt(n) {
    if (Math.abs(n) < 1e-9) return "0";
    return Number(n).toFixed(6).replace(/\.?0+$/, "");
}

function vbsStr(s) {
    return '"' + String(s || "").replace(/"/g, '""').replace(/[\r\n]+/g, " ") + '"';
}

function safeName(s, idx) {
    var clean = String(s || "Panel").replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    if (!clean || /^[0-9]/.test(clean)) clean = "P_" + clean;
    return clean.slice(0, 26) + "_" + idx;
}

function orthoBasisFromNormal(n) {
    var nz = vNorm(n);
    var ref = (Math.abs(nz.z) < 0.9) ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    var nx = vNorm(vCross(ref, nz));
    var ny = vNorm(vCross(nz, nx));
    return { x: nx, y: ny, z: nz };
}

function pickLayer(panelName, thickness) {
    var low = String(panelName || "").toLowerCase();
    if (low.indexOf("door") >= 0 || low.indexOf("facade") >= 0 || low.indexOf("front") >= 0) return 2;
    if (low.indexOf("back") >= 0) return 3;
    if (low.indexOf("shelf") >= 0) return 4;
    if (thickness >= 20) return 2;
    return 1; // Carcass
}

function collectPanels(container, out) {
    for (var i = 0; i < container.Count; i++) {
        var obj = container.Objects[i];
        if (!obj || obj.Visible === false) continue;
        if (obj.AsPanel) {
            out.push(obj.AsPanel);
        } else if (obj.Count > 0) {
            collectPanels(obj, out);
        }
    }
}

// Group contour elements into closed 2D loops (outer loop = largest area, inner loops = cutouts)
function extractContourLoops(panel, zLocal) {
    var contour = panel.Contour;
    var n = contour.Count;
    var segs = [];
    for (var i = 0; i < n; i++) {
        var el = contour.Objects[i];
        if (!el) continue;
        if (el.ElType === 1) { // Line
            segs.push({
                kind: "line",
                p1: { x: el.Pos1.x, y: el.Pos1.y },
                p2: { x: el.Pos2.x, y: el.Pos2.y }
            });
        } else if (el.ElType === 2) { // Arc
            var mid = el.ArcCenter ? null : null;
            var pMid = el.ElCenter ? { x: el.ElCenter.x, y: el.ElCenter.y } : null;
            // Compute exact arc midpoint from Pos1, Pos2, Center, Dir
            var cx = el.Center.x, cy = el.Center.y, r = el.Radius;
            var a1 = Math.atan2(el.Pos1.y - cy, el.Pos1.x - cx);
            var a2 = Math.atan2(el.Pos2.y - cy, el.Pos2.x - cx);
            var da = a2 - a1;
            if (el.ArcDir) {
                if (da <= 0) da += 2 * Math.PI;
            } else {
                if (da >= 0) da -= 2 * Math.PI;
            }
            var am = a1 + da / 2;
            segs.push({
                kind: "arc",
                p1: { x: el.Pos1.x, y: el.Pos1.y },
                pm: { x: cx + r * Math.cos(am), y: cy + r * Math.sin(am) },
                p2: { x: el.Pos2.x, y: el.Pos2.y }
            });
        } else if (el.ElType === 3) { // Full circle
            segs.push({
                kind: "circle",
                center: { x: el.Center.x, y: el.Center.y },
                radius: el.Radius
            });
        }
    }

    // Separate full circles into standalone loops; chain lines/arcs into closed loops
    var loops = [];
    var used = [];
    for (var s = 0; s < segs.length; s++) {
        if (segs[s].kind === "circle") {
            loops.push([segs[s]]);
            used[s] = true;
        }
    }

    function dist2(a, b) {
        var dx = a.x - b.x, dy = a.y - b.y;
        return dx * dx + dy * dy;
    }

    for (var start = 0; start < segs.length; start++) {
        if (used[start]) continue;
        var loop = [segs[start]];
        used[start] = true;
        var curEnd = segs[start].p2;
        var progressed = true;
        while (progressed) {
            progressed = false;
            for (var j = 0; j < segs.length; j++) {
                if (used[j]) continue;
                if (dist2(curEnd, segs[j].p1) < 0.04) {
                    loop.push(segs[j]);
                    curEnd = segs[j].p2;
                    used[j] = true;
                    progressed = true;
                    break;
                } else if (dist2(curEnd, segs[j].p2) < 0.04) {
                    var rev = segs[j].kind === "arc"
                        ? { kind: "arc", p1: segs[j].p2, pm: segs[j].pm, p2: segs[j].p1 }
                        : { kind: "line", p1: segs[j].p2, p2: segs[j].p1 };
                    loop.push(rev);
                    curEnd = rev.p2;
                    used[j] = true;
                    progressed = true;
                    break;
                }
            }
        }
        loops.push(loop);
    }

    // Convert each loop to 3D TopSolid coordinates at zLocal and compute approx 2D area
    function loopArea(lp) {
        if (lp.length === 1 && lp[0].kind === "circle") {
            return Math.PI * lp[0].radius * lp[0].radius;
        }
        var sum = 0;
        for (var k = 0; k < lp.length; k++) {
            sum += lp[k].p1.x * lp[k].p2.y - lp[k].p2.x * lp[k].p1.y;
        }
        return Math.abs(sum) / 2;
    }

    var mapped = [];
    for (var li = 0; li < loops.length; li++) {
        var lp = loops[li];
        var segs3d = [];
        for (var k = 0; k < lp.length; k++) {
            var sg = lp[k];
            if (sg.kind === "line") {
                segs3d.push({
                    kind: "line",
                    p1: toTsPt(panel.ToGlobal(NewVector(sg.p1.x, sg.p1.y, zLocal))),
                    p2: toTsPt(panel.ToGlobal(NewVector(sg.p2.x, sg.p2.y, zLocal)))
                });
            } else if (sg.kind === "arc") {
                segs3d.push({
                    kind: "arc",
                    p1: toTsPt(panel.ToGlobal(NewVector(sg.p1.x, sg.p1.y, zLocal))),
                    pm: toTsPt(panel.ToGlobal(NewVector(sg.pm.x, sg.pm.y, zLocal))),
                    p2: toTsPt(panel.ToGlobal(NewVector(sg.p2.x, sg.p2.y, zLocal)))
                });
            } else if (sg.kind === "circle") {
                segs3d.push({
                    kind: "circle",
                    center: toTsPt(panel.ToGlobal(NewVector(sg.center.x, sg.center.y, zLocal))),
                    radius: sg.radius * MM_TO_M
                });
            }
        }
        mapped.push({ area: loopArea(lp), segs: segs3d });
    }
    mapped.sort(function(a, b) { return b.area - a.area; });
    return mapped;
}

function summarizeEdges(panel) {
    if (!panel.Butts || panel.Butts.Count === 0) return "None";
    var parts = [];
    for (var i = 0; i < panel.Butts.Count; i++) {
        var b = panel.Butts[i];
        var m = b.Material ? String(b.Material).split("\r")[0].trim() : "Edge";
        var t = b.Thickness ? (b.Thickness + "mm") : "";
        parts.push("E" + b.ElemIndex + ":" + m + (t ? "(" + t + ")" : ""));
    }
    return parts.join("; ");
}

function classifyCut(cutName, gx1, gx2, gy1, gy2, cMin, cMax, profW) {
    var low = String(cutName || "").toLowerCase();
    if (low.indexOf("pocket") >= 0 || low.indexOf("shaker") >= 0) return "pocket";
    if (low.indexOf("rabbet") >= 0 || low.indexOf("fold") >= 0 || low.indexOf("quarter") >= 0) return "rabbet";
    if (low.indexOf("mould") >= 0 || low.indexOf("profile") >= 0 || low.indexOf("bevel") >= 0) return "moulding";
    if (low.indexOf("groove") >= 0 || low.indexOf("slot") >= 0) return "groove";
    var touchesEdge = (gx1 <= cMin.x + 0.5 || gx2 >= cMax.x - 0.5) && (gy1 <= cMin.y + 0.5 || gy2 >= cMax.y - 0.5);
    if (profW > 40) return "pocket";
    if (touchesEdge && profW <= 40) return "rabbet";
    return "groove";
}

function resolveTemplatesDir() {
    var candidates = [
        path.resolve(__dirname, "..", "TopSolid_Templates"),
        "Y:\\Works\\bazis\\TopSolid_Templates",
        "C:\\Users\\danch\\Documents\\Bazis\\TopSolid_Templates"
    ];
    for (var i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    return candidates[0];
}

function resolveHardwareLibDir() {
    try {
        var rel = path.resolve(__dirname, "..", "TopSolid_Lib_Bazis");
        if (fs.existsSync(path.resolve(__dirname, ".."))) return rel;
    } catch (e) {}
    return "Y:\\Works\\bazis\\TopSolid_Lib_Bazis";
}

function cleanHardwareName(raw) {
    var s = String(raw || "Hardware").split("\r")[0].split("\n")[0].trim();
    // Strip common extensions if present
    s = s.replace(/\.(f3d|fr3d|b3d)$/i, "").trim();
    return s || "Hardware";
}

function safeHardwareFileName(name) {
    // Keep ASCII letters, digits, _, -, & (e.g. B&S_Hinge_Blum_71B3550_110_Overlay)
    var s = String(name || "Hardware")
        .replace(/[^\x20-\x7E]/g, "_")
        .replace(/[^A-Za-z0-9_&-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    if (!s || /^[0-9]/.test(s)) s = "HW_" + s;
    return s.slice(0, 64);
}

function inferSupplier(name) {
    var low = String(name || "").toLowerCase();
    if (low.indexOf("blum") >= 0 || low.indexOf("71b") >= 0 || low.indexOf("760h") >= 0 ||
        low.indexOf("movento") >= 0 || low.indexOf("tandem") >= 0 || low.indexOf("legrabox") >= 0) {
        return "Blum";
    }
    if (low.indexOf("riex") >= 0) return "RIEX";
    if (low.indexOf("libra") >= 0 || low.indexOf("italiana") >= 0) return "Italiana Ferramenta";
    return "Bazis";
}

function inferHardwareShape(name) {
    var low = String(name || "").toLowerCase();
    if (low.indexOf("pin") >= 0 || low.indexOf("dowel") >= 0 || low.indexOf("screw") >= 0 ||
        low.indexOf("shelfholder") >= 0 || low.indexOf("leg") >= 0 || low.indexOf("minifix") >= 0) {
        return "cylinder";
    }
    return "box";
}

function subtreeHasPanel(obj) {
    if (!obj) return false;
    if (obj.AsPanel) return true;
    var cnt = 0;
    try { cnt = obj.Count || 0; } catch (e) { cnt = 0; }
    for (var i = 0; i < cnt; i++) {
        if (subtreeHasPanel(obj.Objects[i])) return true;
    }
    return false;
}

function extractHardwareTransformAndBox(obj) {
    var p0 = obj.ToGlobal(NewVector(0, 0, 0));
    var px = vSub(obj.ToGlobal(NewVector(1, 0, 0)), p0);
    var py = vSub(obj.ToGlobal(NewVector(0, 1, 0)), p0);
    var pz = vSub(obj.ToGlobal(NewVector(0, 0, 1)), p0);

    var axX = toTsDir(px);
    var axY = toTsDir(py);
    var axZ = toTsDir(pz);
    // Guarantee right-handed orthonormal frame in TopSolid
    if (vDot(vCross(axX, axY), axZ) < 0) {
        axY = { x: -axY.x, y: -axY.y, z: -axY.z };
    }
    axY = vNorm(vCross(axZ, axX));
    var origin = toTsPt(p0);

    // Estimate local 3D bounding box in TopSolid local frame (meters)
    var lx = 0.02, ly = 0.02, lz = 0.02;
    var centerLocal = { x: 0, y: 0, z: 0 };
    try {
        var gMin = obj.GMin;
        var gMax = obj.GMax;
        if (gMin && gMax) {
            var gx = [gMin.x, gMax.x], gy = [gMin.y, gMax.y], gz = [gMin.z, gMax.z];
            var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
            var valid = false;
            for (var ix = 0; ix < 2; ix++) {
                for (var iy = 0; iy < 2; iy++) {
                    for (var iz = 0; iz < 2; iz++) {
                        var ptTs = toTsPt(NewVector(gx[ix], gy[iy], gz[iz]));
                        var rel = vSub(ptTs, origin);
                        var lx0 = vDot(rel, axX);
                        var ly0 = vDot(rel, axY);
                        var lz0 = vDot(rel, axZ);
                        if (lx0 < minX) minX = lx0;
                        if (lx0 > maxX) maxX = lx0;
                        if (ly0 < minY) minY = ly0;
                        if (ly0 > maxY) maxY = ly0;
                        if (lz0 < minZ) minZ = lz0;
                        if (lz0 > maxZ) maxZ = lz0;
                        valid = true;
                    }
                }
            }
            if (valid && (maxX - minX > 0.001 || maxY - minY > 0.001 || maxZ - minZ > 0.001)) {
                lx = Math.max(0.004, Math.min(2.0, maxX - minX));
                ly = Math.max(0.004, Math.min(2.0, maxY - minY));
                lz = Math.max(0.004, Math.min(2.0, maxZ - minZ));
                centerLocal = {
                    x: (minX + maxX) / 2,
                    y: (minY + maxY) / 2,
                    z: (minZ + maxZ) / 2
                };
            }
        }
    } catch (e) {}

    return {
        origin: origin,
        axX: axX,
        axY: axY,
        centerLocal: centerLocal,
        lx: lx,
        ly: ly,
        lz: lz
    };
}

function collectHardware(container, panelUidToTsName, out) {
    var cnt = 0;
    try { cnt = container.Count || 0; } catch (e) { cnt = 0; }
    for (var i = 0; i < cnt; i++) {
        var obj = container.Objects[i];
        if (!obj || obj.Visible === false) continue;
        if (obj.AsPanel) continue;

        var isFastener = false;
        try { isFastener = !!(obj.Holes && obj.Holes.Count >= 0); } catch (e) { isFastener = false; }

        var childCount = 0;
        try { childCount = obj.Count || 0; } catch (e) { childCount = 0; }

        // Case 1: TFastener (hinge, dowel, screw, shelfholder, cam lock, etc.)
        // Case 2: Non-panel hardware block/fragment (legs, hangers, handles — subtree has 0 panels)
        if (isFastener || (childCount > 0 && !subtreeHasPanel(obj))) {
            var rawName = "";
            try { rawName = obj.Name || ""; } catch (e) {}
            var name = cleanHardwareName(rawName);
            if (!name || name === "Model") continue;

            var art = "";
            try { art = String(obj.ArtPos || "").trim(); } catch (e) {}
            var tf = extractHardwareTransformAndBox(obj);

            // Skip degenerate 0-size empty containers
            if (!isFastener && tf.lx <= 0.005 && tf.ly <= 0.005 && tf.lz <= 0.005) continue;

            out.push({
                name: name,
                safeName: safeHardwareFileName(name),
                article: art,
                supplier: inferSupplier(name),
                shapeKind: inferHardwareShape(name),
                origin: tf.origin,
                axX: tf.axX,
                axY: tf.axY,
                centerLocal: tf.centerLocal,
                lx: tf.lx,
                ly: tf.ly,
                lz: tf.lz,
                connectedPanels: []
            });
            continue;
        }

        if (childCount > 0) {
            collectHardware(obj, panelUidToTsName, out);
        }
    }
}

function findTemplates(dir) {
    var map = {
        drill: path.join(dir, "B&S_Drill.top"),
        groove: path.join(dir, "B&S_Groove.top"),
        pocket: path.join(dir, "B&S_Pocket.top"),
        rabbet: path.join(dir, "B&S_Rabbet.top"),
        moulding: path.join(dir, "B&S_Moulding.top")
    };
    var found = {};
    Object.keys(map).forEach(function(k) {
        found[k] = fs.existsSync(map[k]) ? map[k] : null;
    });
    return found;
}

function extractPanelData(panel, idx) {
    var cMin = panel.Contour.Min;
    var cMax = panel.Contour.Max;
    var lx = cMax.x - cMin.x;
    var ly = cMax.y - cMin.y;
    var lz = panel.Thickness;

    var p0 = panel.ToGlobal(NewVector(0, 0, 0));
    var px = vSub(panel.ToGlobal(NewVector(1, 0, 0)), p0);
    var py = vSub(panel.ToGlobal(NewVector(0, 1, 0)), p0);
    var pz = vSub(panel.ToGlobal(NewVector(0, 0, 1)), p0);

    var axX = toTsDir(px);
    var axY = toTsDir(py);
    var axZ = toTsDir(pz);
    var blockAxY = axY;
    if (vDot(vCross(axX, blockAxY), axZ) < 0) {
        blockAxY = { x: -axY.x, y: -axY.y, z: -axY.z };
    }

    var midLocal = NewVector((cMin.x + cMax.x) / 2, (cMin.y + cMax.y) / 2, lz / 2);
    var center = toTsPt(panel.ToGlobal(midLocal));

    // Detect whether panel is a simple rectangle or shaped (arcs / >4 segments / cutouts)
    var isRect = (panel.Contour.Count === 4);
    if (isRect) {
        for (var ci0 = 0; ci0 < 4; ci0++) {
            if (panel.Contour.Objects[ci0].ElType !== 1) { isRect = false; break; }
        }
    }
    var loops = isRect ? null : extractContourLoops(panel, 0);
    var innerLoops = (!isRect && loops && loops.length > 1) ? extractContourLoops(panel, -1.0).slice(1) : [];

    // Extract grooves & pockets from panel.Cuts
    var cuts = [];
    if (panel.Cuts && panel.Cuts.Count > 0) {
        for (var ci = 0; ci < panel.Cuts.Count; ci++) {
            var cut = panel.Cuts[ci];
            if (!cut.Trajectory || !cut.Contour) continue;
            var tMin = cut.Trajectory.Min;
            var tMax = cut.Trajectory.Max;
            var kMin = cut.Contour.Min;
            var kMax = cut.Contour.Max;

            var dx = tMax.x - tMin.x;
            var dy = tMax.y - tMin.y;
            var profW = kMax.x - kMin.x;
            var profZ1 = kMin.y;
            var profZ2 = kMax.y;
            var profZ = profZ2 - profZ1;
            if (profW < 0.1 || profZ < 0.1) continue;

            var gx1, gx2, gy1, gy2;
            if (Math.abs(dy) >= Math.abs(dx)) {
                gx1 = tMin.x + kMin.x;
                gx2 = tMax.x + kMax.x;
                gy1 = tMin.y;
                gy2 = tMax.y;
            } else {
                gx1 = tMin.x;
                gx2 = tMax.x;
                gy1 = tMin.y + kMin.x;
                gy2 = tMax.y + kMax.x;
            }

            var gz1 = profZ1;
            var gz2 = profZ2;
            if (gz1 <= 0.01) gz1 = Math.min(gz1, -1.0);
            if (gz2 >= lz - 0.01) gz2 = Math.max(gz2, lz + 1.0);

            var opKind = classifyCut(cut.Name, gx1, gx2, gy1, gy2, cMin, cMax, profW);
            var isTopFace = (profZ2 >= lz - 0.01);
            var entryZ = isTopFace ? lz : 0;
            var cutMid = NewVector((gx1 + gx2) / 2, (gy1 + gy2) / 2, (gz1 + gz2) / 2);
            var entryPt = NewVector((gx1 + gx2) / 2, (gy1 + gy2) / 2, entryZ);
            // Align template Origin CS: +Z = outward panel face normal (-Z cuts into panel),
            // and for grooves/rabbets/mouldings align +X along the long axis.
            var cutAxX = axX;
            var cutAxY = isTopFace ? blockAxY : { x: -blockAxY.x, y: -blockAxY.y, z: -blockAxY.z };
            if (opKind !== "pocket" && (gy2 - gy1) > (gx2 - gx1)) {
                var tmpX = cutAxX;
                cutAxX = cutAxY;
                cutAxY = { x: -tmpX.x, y: -tmpX.y, z: -tmpX.z };
            }
            cuts.push({
                opKind: opKind,
                name: cut.Name || (opKind + "_" + (ci + 1)),
                center: toTsPt(panel.ToGlobal(cutMid)),
                entry: toTsPt(panel.ToGlobal(entryPt)),
                axX: axX,
                axY: blockAxY,
                tplAxX: cutAxX,
                tplAxY: cutAxY,
                lx: (gx2 - gx1) * MM_TO_M,
                ly: (gy2 - gy1) * MM_TO_M,
                lz: (gz2 - gz1) * MM_TO_M,
                boxWmm: Math.round((gx2 - gx1) * 10) / 10,
                boxLmm: Math.round((gy2 - gy1) * 10) / 10,
                widthMm: Math.round(profW * 10) / 10,
                lengthMm: Math.round(Math.max(gx2 - gx1, gy2 - gy1) * 10) / 10,
                depthMm: Math.round(Math.min(profZ, lz) * 10) / 10
            });
        }
    }

    // Extract connected fastener holes intersecting this panel
    var holes = [];
    var seenHoles = {};
    var fasters = null;
    try { fasters = panel.FindConnectedFasteners(); } catch (e) {}
    if (fasters && fasters.length > 0) {
        for (var fi = 0; fi < fasters.length; fi++) {
            var f = fasters[fi];
            if (!f || !f.Holes || f.Holes.Count === 0) continue;
            for (var hi = 0; hi < f.Holes.Count; hi++) {
                var h = f.Holes[hi];
                var d = h.Diameter;
                var dep = h.Depth;
                if (d < 0.5 || dep < 0.5) continue;

                var gStart = f.ToGlobal(h.Position);
                var gEnd = f.ToGlobal(NewVector(
                    h.Position.x + h.Direction.x * dep,
                    h.Position.y + h.Direction.y * dep,
                    h.Position.z + h.Direction.z * dep
                ));
                var lStart = panel.ToObject(gStart);
                var lEnd = panel.ToObject(gEnd);

                var minX = Math.min(lStart.x, lEnd.x), maxX = Math.max(lStart.x, lEnd.x);
                var minY = Math.min(lStart.y, lEnd.y), maxY = Math.max(lStart.y, lEnd.y);
                var minZ = Math.min(lStart.z, lEnd.z), maxZ = Math.max(lStart.z, lEnd.z);
                if (maxX < cMin.x - 0.5 || minX > cMax.x + 0.5) continue;
                if (maxY < cMin.y - 0.5 || minY > cMax.y + 0.5) continue;
                if (maxZ < -0.5 || minZ > lz + 0.5) continue;

                var penZ = Math.min(maxZ, lz) - Math.max(minZ, 0);
                var penX = Math.min(maxX, cMax.x) - Math.max(minX, cMin.x);
                var penY = Math.min(maxY, cMax.y) - Math.max(minY, cMin.y);
                if (penZ < 0.5 && penX < 0.5 && penY < 0.5) continue;

                var gDir = vNorm(vSub(gEnd, gStart));
                var tsStart = toTsPt(gStart);
                var tsDir = toTsDir(gDir);

                var key = [
                    Math.round(tsStart.x * 10000),
                    Math.round(tsStart.y * 10000),
                    Math.round(tsStart.z * 10000),
                    Math.round(d * 10),
                    Math.round(dep * 10)
                ].join("_");
                if (seenHoles[key]) continue;
                seenHoles[key] = true;

                var extStart = {
                    x: tsStart.x - tsDir.x * 0.001,
                    y: tsStart.y - tsDir.y * 0.001,
                    z: tsStart.z - tsDir.z * 0.001
                };
                var basis = orthoBasisFromNormal(tsDir);
                var outBasis = orthoBasisFromNormal({ x: -tsDir.x, y: -tsDir.y, z: -tsDir.z });
                holes.push({
                    entry: tsStart,
                    start: extStart,
                    dir: tsDir,
                    axX: basis.x,
                    axY: basis.y,
                    tplAxX: outBasis.x,
                    tplAxY: outBasis.y,
                    diamMm: Math.round(d * 10) / 10,
                    depthMm: Math.round(dep * 10) / 10,
                    radius: (d / 2) * MM_TO_M,
                    length: (dep + 1.0) * MM_TO_M
                });
            }
        }
    }

    var artPos = panel.ArtPos ? String(panel.ArtPos).trim() : "";
    var matName = panel.MaterialName ? String(panel.MaterialName).split("\r")[0].trim() : "";
    var rawName = panel.Name || ("Panel_" + idx);
    var title = (artPos ? ("[" + artPos + "] ") : "") + rawName + (matName ? (" - " + matName) : "");

    return {
        uidName: safeName(rawName, idx),
        name: title,
        artPos: artPos,
        material: matName,
        thicknessMm: Math.round(lz * 10) / 10,
        edgesSummary: summarizeEdges(panel),
        edgeCount: panel.Butts ? panel.Butts.Count : 0,
        layer: pickLayer(rawName, lz),
        isRect: isRect,
        outerLoop: (loops && loops.length > 0) ? loops[0] : null,
        innerLoops: innerLoops,
        center: center,
        axX: axX,
        axY: blockAxY,
        axZ: axZ,
        lx: lx * MM_TO_M,
        ly: ly * MM_TO_M,
        lz: lz * MM_TO_M,
        cuts: cuts,
        holes: holes
    };
}

function emitLoopCurveVbs(lines, loop, axX, axY, varName) {
    if (loop.segs.length === 1 && loop.segs[0].kind === "circle") {
        var sg = loop.segs[0];
        lines.push(
            "  Set " + varName + " = doc.Curves.AddBasicCircle(" +
            fmt(sg.center.x) + ", " + fmt(sg.center.y) + ", " + fmt(sg.center.z) + ", " +
            fmt(axX.x) + ", " + fmt(axX.y) + ", " + fmt(axX.z) + ", " +
            fmt(axY.x) + ", " + fmt(axY.y) + ", " + fmt(axY.z) + ", " +
            fmt(sg.radius) + ")"
        );
        return;
    }
    lines.push("  ReDim segArr(" + (loop.segs.length - 1) + ")");
    for (var k = 0; k < loop.segs.length; k++) {
        var s = loop.segs[k];
        if (s.kind === "arc") {
            lines.push(
                "  Set segArr(" + k + ") = doc.Curves.Add3PointsCircle(" +
                fmt(s.p1.x) + ", " + fmt(s.p1.y) + ", " + fmt(s.p1.z) + ", " +
                fmt(s.pm.x) + ", " + fmt(s.pm.y) + ", " + fmt(s.pm.z) + ", " +
                fmt(s.p2.x) + ", " + fmt(s.p2.y) + ", " + fmt(s.p2.z) + ", 0)"
            );
        } else {
            lines.push(
                "  Set segArr(" + k + ") = doc.Curves.AddBasicLine(" +
                fmt(s.p1.x) + ", " + fmt(s.p1.y) + ", " + fmt(s.p1.z) + ", " +
                fmt(s.p2.x) + ", " + fmt(s.p2.y) + ", " + fmt(s.p2.z) + ")"
            );
        }
    }
    lines.push("  Set " + varName + " = doc.Curves.AddBasicComposite(segArr, True)");
}

function buildVbsScript(panels, templates, tplDir) {
    var tpl = templates || {};
    var cacheDir = path.join(tplDir || "Y:\\Works\\bazis\\TopSolid_Templates", "cache");
    var variantsMap = {};
    var variantsList = [];
    var applyList = [];

    function registerVariant(kind, basePath, key, paramsObj) {
        var dst = path.join(cacheDir, "B&S_" + kind + "_" + key + ".top");
        if (!variantsMap[dst]) {
            variantsMap[dst] = true;
            variantsList.push({ src: basePath, dst: dst, params: paramsObj });
        }
        return dst;
    }

    var lines = [];
    lines.push("Option Explicit");
    lines.push("On Error Resume Next");
    lines.push("Dim app, doc, blk, tool, circ, comp, cs, cmp, op, segArr()");
    lines.push("Dim okPanels, okShaped, okCutouts, okCuts, okHoles, okTpl, okProps, errCount");
    lines.push("okPanels = 0 : okShaped = 0 : okCutouts = 0 : okCuts = 0 : okHoles = 0 : okTpl = 0 : okProps = 0 : errCount = 0");
    lines.push('Set app = CreateObject("TopSolid.Application")');
    lines.push("If Err.Number <> 0 Or app Is Nothing Then");
    lines.push('  WScript.Echo "ERROR: Cannot connect to TopSolid.Application: " & Err.Description');
    lines.push("  WScript.Quit 1");
    lines.push("End If");
    lines.push('Set doc = app.Documents.Add("top")');
    lines.push("If Err.Number <> 0 Or doc Is Nothing Then");
    lines.push('  WScript.Echo "ERROR: Cannot create TopSolid document: " & Err.Description');
    lines.push("  WScript.Quit 1");
    lines.push("End If");

    for (var i = 0; i < panels.length; i++) {
        var p = panels[i];
        lines.push("' --- Panel " + (i + 1) + ": " + p.name + " ---");
        lines.push("Err.Clear");
        if (p.isRect || !p.outerLoop) {
            lines.push(
                "Set blk = doc.Shapes.AddBasicBlock(" +
                fmt(p.center.x) + ", " + fmt(p.center.y) + ", " + fmt(p.center.z) + ", " +
                fmt(p.axX.x) + ", " + fmt(p.axX.y) + ", " + fmt(p.axX.z) + ", " +
                fmt(p.axY.x) + ", " + fmt(p.axY.y) + ", " + fmt(p.axY.z) + ", " +
                fmt(p.lx) + ", " + fmt(p.ly) + ", " + fmt(p.lz) + ")"
            );
        } else {
            emitLoopCurveVbs(lines, p.outerLoop, p.axX, p.axY, "comp");
            lines.push(
                "Set blk = doc.Shapes.AddBasicExtruded(comp, " +
                fmt(p.axZ.x) + ", " + fmt(p.axZ.y) + ", " + fmt(p.axZ.z) + ", " +
                fmt(p.lz) + ", 0, 0, False, True)"
            );
            lines.push("If Err.Number = 0 And Not blk Is Nothing Then okShaped = okShaped + 1");
        }

        lines.push("If Err.Number = 0 And Not blk Is Nothing Then");
        lines.push("  okPanels = okPanels + 1");
        lines.push("  blk.Name = " + vbsStr(p.uidName));
        lines.push("  blk.Designation = " + vbsStr(p.name));
        if (p.artPos) lines.push("  blk.Reference = " + vbsStr(p.artPos));
        lines.push("  blk.Layer = " + p.layer);
        // Set BOM custom text properties (Material, Thickness, Edges)
        lines.push("  Err.Clear");
        lines.push('  blk.SetTextProperty "Bazis_Material", ' + vbsStr(p.material));
        lines.push('  blk.SetTextProperty "Bazis_Thickness", ' + vbsStr(p.thicknessMm + "mm"));
        lines.push('  blk.SetTextProperty "Bazis_EdgeCount", ' + vbsStr(String(p.edgeCount)));
        lines.push('  blk.SetTextProperty "Bazis_Edges", ' + vbsStr(p.edgesSummary));
        lines.push("  If Err.Number = 0 Then okProps = okProps + 1");
        lines.push("  Err.Clear");
        if (p.material) {
            lines.push("  blk.SetMatter " + vbsStr(p.material));
            lines.push("  Err.Clear");
        }

        // Subtract internal cutout loops (for shaped panels with cutouts)
        for (var ii = 0; ii < p.innerLoops.length; ii++) {
            lines.push("  Err.Clear");
            emitLoopCurveVbs(lines, p.innerLoops[ii], p.axX, p.axY, "comp");
            lines.push(
                "  Set tool = doc.Shapes.AddBasicExtruded(comp, " +
                fmt(p.axZ.x) + ", " + fmt(p.axZ.y) + ", " + fmt(p.axZ.z) + ", " +
                fmt(p.lz + 0.002) + ", 0, 0, False, True)"
            );
            lines.push("  If Err.Number = 0 And Not tool Is Nothing Then");
            lines.push("    Set op = blk.Operations.AddSubtraction(tool, Nothing, True, False)");
            lines.push("    If Err.Number = 0 And Not op Is Nothing Then okCutouts = okCutouts + 1 Else errCount = errCount + 1");
            lines.push("  Else : errCount = errCount + 1 : End If");
        }

        // Grooves, Pockets, Rabbets, Mouldings (use native .top process template if present, else named Parasolid subtraction)
        for (var ci = 0; ci < p.cuts.length; ci++) {
            var c = p.cuts[ci];
            lines.push("  Err.Clear");
            if (tpl[c.opKind]) {
                var cutParams, cutKey;
                if (c.opKind === "pocket") {
                    cutKey = numKey(c.boxWmm) + "x" + numKey(c.boxLmm) + "x" + numKey(c.depthMm);
                    cutParams = { W: c.boxWmm + "mm", L: c.boxLmm + "mm", H: c.depthMm + "mm" };
                } else {
                    cutKey = numKey(c.widthMm) + "x" + numKey(c.depthMm) + "x" + numKey(c.lengthMm);
                    cutParams = { W: c.widthMm + "mm", H: c.depthMm + "mm", L: c.lengthMm + "mm" };
                }
                var cutTplFile = registerVariant(c.opKind, tpl[c.opKind], cutKey, cutParams);
                var cutCmpName = c.opKind + "_" + (i + 1) + "_" + (ci + 1);
                applyList.push({ cmp: cutCmpName, panel: p.uidName });
                lines.push(
                    "  Set cs = doc.CoordinateSystems.AddBasic(" +
                    fmt(c.entry.x) + ", " + fmt(c.entry.y) + ", " + fmt(c.entry.z) + ", " +
                    fmt(c.tplAxX.x) + ", " + fmt(c.tplAxX.y) + ", " + fmt(c.tplAxX.z) + ", " +
                    fmt(c.tplAxY.x) + ", " + fmt(c.tplAxY.y) + ", " + fmt(c.tplAxY.z) + ")"
                );
                lines.push('  Set cmp = doc.Components.AddWithPositioningByCoordinateSystems(' + vbsStr(cutTplFile) + ', "Origin", cs)');
                lines.push("  If Err.Number = 0 And Not cmp Is Nothing Then cmp.Element.Name = " + vbsStr(cutCmpName) + " : okTpl = okTpl + 1 : okCuts = okCuts + 1 Else errCount = errCount + 1");
            } else {
                lines.push(
                    "  Set tool = doc.Shapes.AddBasicBlock(" +
                    fmt(c.center.x) + ", " + fmt(c.center.y) + ", " + fmt(c.center.z) + ", " +
                    fmt(c.axX.x) + ", " + fmt(c.axX.y) + ", " + fmt(c.axX.z) + ", " +
                    fmt(c.axY.x) + ", " + fmt(c.axY.y) + ", " + fmt(c.axY.z) + ", " +
                    fmt(c.lx) + ", " + fmt(c.ly) + ", " + fmt(c.lz) + ")"
                );
                lines.push("  If Err.Number = 0 And Not tool Is Nothing Then");
                lines.push("    tool.Designation = " + vbsStr(c.opKind.toUpperCase() + " " + c.name + " (" + c.widthMm + "x" + c.depthMm + "mm)"));
                lines.push("    Set op = blk.Operations.AddSubtraction(tool, Nothing, True, False)");
                lines.push("    If Err.Number = 0 And Not op Is Nothing Then okCuts = okCuts + 1 Else errCount = errCount + 1");
                lines.push("  Else : errCount = errCount + 1 : End If");
            }
        }

        // Drilling holes (use B&S_Drill.top if present, else named Parasolid cylinder subtraction)
        for (var hi = 0; hi < p.holes.length; hi++) {
            var h = p.holes[hi];
            lines.push("  Err.Clear");
            if (tpl.drill) {
                var drillKey = numKey(h.diamMm) + "x" + numKey(h.depthMm);
                var drillTplFile = registerVariant("drill", tpl.drill, drillKey, { D: h.diamMm + "mm", H: h.depthMm + "mm" });
                var drillCmpName = "Drill_" + (i + 1) + "_" + (hi + 1);
                applyList.push({ cmp: drillCmpName, panel: p.uidName });
                lines.push(
                    "  Set cs = doc.CoordinateSystems.AddBasic(" +
                    fmt(h.entry.x) + ", " + fmt(h.entry.y) + ", " + fmt(h.entry.z) + ", " +
                    fmt(h.tplAxX.x) + ", " + fmt(h.tplAxX.y) + ", " + fmt(h.tplAxX.z) + ", " +
                    fmt(h.tplAxY.x) + ", " + fmt(h.tplAxY.y) + ", " + fmt(h.tplAxY.z) + ")"
                );
                lines.push('  Set cmp = doc.Components.AddWithPositioningByCoordinateSystems(' + vbsStr(drillTplFile) + ', "Origin", cs)');
                lines.push("  If Err.Number = 0 And Not cmp Is Nothing Then cmp.Element.Name = " + vbsStr(drillCmpName) + " : okTpl = okTpl + 1 : okHoles = okHoles + 1 Else errCount = errCount + 1");
            } else {
                lines.push(
                    "  Set circ = doc.Curves.AddBasicCircle(" +
                    fmt(h.start.x) + ", " + fmt(h.start.y) + ", " + fmt(h.start.z) + ", " +
                    fmt(h.axX.x) + ", " + fmt(h.axX.y) + ", " + fmt(h.axX.z) + ", " +
                    fmt(h.axY.x) + ", " + fmt(h.axY.y) + ", " + fmt(h.axY.z) + ", " +
                    fmt(h.radius) + ")"
                );
                lines.push("  If Err.Number = 0 And Not circ Is Nothing Then");
                lines.push(
                    "    Set tool = doc.Shapes.AddBasicExtruded(circ, " +
                    fmt(h.dir.x) + ", " + fmt(h.dir.y) + ", " + fmt(h.dir.z) + ", " +
                    fmt(h.length) + ", 0, 0, False, True)"
                );
                lines.push("    If Err.Number = 0 And Not tool Is Nothing Then");
                lines.push("      tool.Designation = " + vbsStr("DRILL D" + h.diamMm + "x" + h.depthMm + "mm"));
                lines.push("      Set op = blk.Operations.AddSubtraction(tool, Nothing, True, False)");
                lines.push("      If Err.Number = 0 And Not op Is Nothing Then okHoles = okHoles + 1 Else errCount = errCount + 1");
                lines.push("    Else : errCount = errCount + 1 : End If");
                lines.push("  Else : errCount = errCount + 1 : End If");
            }
        }

        lines.push("Else");
        lines.push("  errCount = errCount + 1");
        lines.push("End If");
    }

    lines.push('WScript.Echo "DONE|panels=" & okPanels & "|shaped=" & okShaped & "|cutouts=" & okCutouts & "|cuts=" & okCuts & "|holes=" & okHoles & "|templates=" & okTpl & "|props=" & okProps & "|errors=" & errCount');
    return {
        vbs: lines.join("\r\n"),
        variants: variantsList,
        apply: applyList
    };
}

function resolveRustExe() {
    var candidates = [
        path.join(__dirname, "bazis-to-topsolid.exe"),
        "Y:\\Works\\bazis\\Scripts\\bazis-to-topsolid.exe",
        "Y:\\Works\\cnc\\bazis-to-topsolid\\target\\x86_64-pc-windows-msvc\\release\\bazis-to-topsolid.exe",
        "Y:\\Works\\cnc\\bazis-to-topsolid\\target\\x86_64-pc-windows-gnu\\release\\bazis-to-topsolid.exe",
        "C:\\Users\\danch\\Documents\\Bazis\\Scripts\\bazis-to-topsolid.exe"
    ];
    for (var i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    return null;
}

function main() {
    var rawPanels = [];
    collectPanels(Model, rawPanels);
    if (rawPanels.length === 0) {
        alert("No panels found in the active Bazis model.");
        return;
    }

    var tplDir = resolveTemplatesDir();
    var hwLibDir = resolveHardwareLibDir();
    var panels = [];
    var panelUidToTsName = {};
    var totalCuts = 0, totalHoles = 0;
    for (var i = 0; i < rawPanels.length; i++) {
        var pd = extractPanelData(rawPanels[i], i + 1);
        panels.push(pd);
        try { panelUidToTsName[rawPanels[i].UID] = "P" + (i + 1); } catch (e) {}
        totalCuts += pd.cuts.length;
        totalHoles += pd.holes.length;
    }

    var hardware = [];
    collectHardware(Model, panelUidToTsName, hardware);

    var modelName = (Article && Article.Name) ? String(Article.Name) : "BazisModel";
    var safeModel = modelName.replace(/[^A-Za-z0-9_\-]/g, "_") || "BazisModel";
    var saveTopPath = "Y:\\Works\\bazis\\Projects\\" + safeModel + ".top";

    // Preferred path: hand off JSON asynchronously to native Rust app (Bazis never freezes!)
    var rustExe = resolveRustExe();
    if (rustExe) {
        var jsonPath = path.join(os.tmpdir(), "bazis_to_topsolid_" + safeModel + ".json");
        var payload = {
            modelName: modelName,
            templatesDir: tplDir,
            hardwareLibDir: hwLibDir,
            saveTopPath: saveTopPath,
            panels: panels,
            hardware: hardware
        };
        fs.writeFileSync(jsonPath, JSON.stringify(payload), "utf8");
        var child = cp.spawn(rustExe, [jsonPath], {
            detached: true,
            stdio: "ignore"
        });
        child.unref();
        return;
    }

    // Fallback: inline VBS + PowerShell if bazis-to-topsolid.exe is not found
    var templates = USE_PROCESS_TEMPLATES ? findTemplates(tplDir) : {};
    var built = buildVbsScript(panels, templates, tplDir);
    var applyPs1 = resolveApplyPs1();

    var phase1Out = "";
    if (USE_PROCESS_TEMPLATES && built.variants.length > 0 && fs.existsSync(applyPs1)) {
        var varJobPath = path.join(os.tmpdir(), "ts6_variants_job.json");
        fs.writeFileSync(varJobPath, JSON.stringify({ variants: built.variants, apply: [] }), "utf8");
        phase1Out = cp.execFileSync("powershell.exe", [
            "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
            "-File", applyPs1, "-JobFile", varJobPath
        ], { encoding: "utf8", timeout: 900000, windowsHide: true }).trim();
    }

    var vbsPath = path.join(os.tmpdir(), "bazis_to_topsolid6.vbs");
    fs.writeFileSync(vbsPath, built.vbs, "utf8");
    var out = cp.execSync('cscript //Nologo "' + vbsPath + '"', {
        encoding: "utf8",
        timeout: 900000
    }).trim();

    var phase3Out = "";
    if (USE_PROCESS_TEMPLATES && built.apply.length > 0 && fs.existsSync(applyPs1)) {
        var applyJobPath = path.join(os.tmpdir(), "ts6_apply_job.json");
        fs.writeFileSync(applyJobPath, JSON.stringify({ variants: [], apply: built.apply }), "utf8");
        phase3Out = cp.execFileSync("powershell.exe", [
            "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
            "-File", applyPs1, "-JobFile", applyJobPath
        ], { encoding: "utf8", timeout: 1800000, windowsHide: true }).trim();
    }

    var msg = "TopSolid 6 Native Export Complete (" + modelName + ")\n" +
        "Extracted: " + panels.length + " panels, " + totalCuts + " grooves/pockets, " + totalHoles + " holes.\n" +
        (phase1Out ? ("Variants: " + phase1Out + "\n") : "") +
        "TopSolid COM: " + out +
        (phase3Out ? ("\nNative Use Process: " + phase3Out) : "");
    alert(msg);
}

main();
