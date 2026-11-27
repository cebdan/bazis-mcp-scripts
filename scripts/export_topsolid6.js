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
        // Skip TCSGOperation subtrees — their operand panels belong to the boolean body
        if (typeof obj.CSGFunction === "number") continue;
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
            var ctr = el.Center || el.ArcCenter || null;
            var cx = ctr ? Number(ctr.x) : (el.Pos1.x + el.Pos2.x) / 2;
            var cy = ctr ? Number(ctr.y) : (el.Pos1.y + el.Pos2.y) / 2;
            var r = (typeof el.Radius === "number" && isFinite(el.Radius) && el.Radius > 0)
                ? el.Radius
                : (typeof el.ArcRadius === "function" ? Number(el.ArcRadius()) : Math.sqrt(Math.pow(el.Pos1.x - cx, 2) + Math.pow(el.Pos1.y - cy, 2)));
            var pmx = (el.Pos1.x + el.Pos2.x) / 2;
            var pmy = (el.Pos1.y + el.Pos2.y) / 2;
            if (isFinite(cx) && isFinite(cy) && isFinite(r) && r > 1e-6) {
                var a1 = Math.atan2(el.Pos1.y - cy, el.Pos1.x - cx);
                var a2 = Math.atan2(el.Pos2.y - cy, el.Pos2.x - cx);
                var da = a2 - a1;
                if (el.ArcDir) {
                    if (da <= 0) da += 2 * Math.PI;
                } else {
                    if (da >= 0) da -= 2 * Math.PI;
                }
                var am = a1 + da / 2;
                pmx = cx + r * Math.cos(am);
                pmy = cy + r * Math.sin(am);
            }
            segs.push({
                kind: "arc",
                p1: { x: el.Pos1.x, y: el.Pos1.y },
                pm: { x: pmx, y: pmy },
                p2: { x: el.Pos2.x, y: el.Pos2.y }
            });
        } else if (el.ElType === 3) { // Full circle
            var c3 = el.Center || el.CirCenter || { x: 0, y: 0 };
            var r3 = (typeof el.Radius === "number" && isFinite(el.Radius)) ? el.Radius : (typeof el.CirRadius === "function" ? Number(el.CirRadius()) : 10);
            segs.push({
                kind: "circle",
                center: { x: c3.x, y: c3.y },
                radius: r3
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

function pointInContour2D(contour, x, y) {
    try {
        if (typeof contour.IsPointInside === "function") {
            return !!contour.IsPointInside(NewPoint(x, y));
        }
    } catch (e) {}
    var cMin = contour.Min, cMax = contour.Max;
    return (x > cMin.x + 1e-4 && x < cMax.x - 1e-4 && y > cMin.y + 1e-4 && y < cMax.y - 1e-4);
}

function extractEdgesData(panel, cMin, cMax, lz, isRect) {
    var edges = [];
    var trim = { left: 0, right: 0, bottom: 0, top: 0 };
    if (!panel.Butts || panel.Butts.Count === 0 || !panel.Contour) {
        return { edges: edges, trim: trim, totalLenMm: 0 };
    }
    var cnt = panel.Contour.Count;
    var objs = panel.Contour.Objects;
    var totalLenMm = 0;

    for (var i = 0; i < panel.Butts.Count; i++) {
        var b = panel.Butts[i];
        if (!b) continue;
        var ei = b.ElemIndex;
        if (typeof ei !== "number" || ei < 0 || ei >= cnt) continue;
        var el = objs[ei];
        if (!el) continue;

        var sp = splitBazisMatName(b.Material || "");
        var matName = sp.name || "Edge";
        var code = sp.code || "";
        var thk = Number(b.Thickness) || 0;
        if (thk < 0.1) thk = 1.0;
        var wid = Number(b.Width) || (lz + 1.0);
        var clipPanel = !!b.ClipPanel;
        var sign = b.Sign ? String(b.Sign).trim() : "";
        var overhung = Number(b.Overhung) || 0;

        var stripSegs = null;
        var midPtTs = null;
        var outNormTs = null;
        var lenMm = 0;
        var sideTag = "E" + ei;

        if (el.ElType === 1) {
            // Straight line edge
            var p1 = el.Pos1, p2 = el.Pos2;
            var dx = p2.x - p1.x, dy = p2.y - p1.y;
            lenMm = Math.sqrt(dx * dx + dy * dy);
            if (lenMm < 0.5) continue;
            var tx = dx / lenMm, ty = dy / lenMm;
            // Two candidate normals in panel local XY
            var n1x = -ty, n1y = tx;
            var mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            var eps = Math.min(1.0, Math.max(0.2, lenMm * 0.05));
            var in1 = pointInContour2D(panel.Contour, mx + n1x * eps, my + n1y * eps);
            var in2 = pointInContour2D(panel.Contour, mx - n1x * eps, my - n1y * eps);
            var nx, ny;
            if (in1 && !in2) { nx = -n1x; ny = -n1y; }
            else if (in2 && !in1) { nx = n1x; ny = n1y; }
            else {
                // Fallback: away from contour center
                var cx = (cMin.x + cMax.x) / 2, cy = (cMin.y + cMax.y) / 2;
                var dot = (mx - cx) * n1x + (my - cy) * n1y;
                nx = dot >= 0 ? n1x : -n1x;
                ny = dot >= 0 ? n1y : -n1y;
            }

            // Classify side for rectangular panels (L1/L2 along X, W1/W2 along Y)
            if (isRect) {
                if (Math.abs(nx) > 0.7) {
                    if (nx < 0) {
                        sideTag = "W1";
                        if (clipPanel) trim.left = Math.max(trim.left, thk);
                    } else {
                        sideTag = "W2";
                        if (clipPanel) trim.right = Math.max(trim.right, thk);
                    }
                } else if (Math.abs(ny) > 0.7) {
                    if (ny < 0) {
                        sideTag = "L1";
                        if (clipPanel) trim.bottom = Math.max(trim.bottom, thk);
                    } else {
                        sideTag = "L2";
                        if (clipPanel) trim.top = Math.max(trim.top, thk);
                    }
                }
            }

            // Build closed 4-segment strip loop at Z=0
            // If clipPanel=true: outer face is ON (p1..p2), inner face is at (p - n*thk)
            // If clipPanel=false: inner face is ON (p1..p2), outer face is at (p + n*thk)
            var a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y;
            if (clipPanel) {
                a1x = p1.x - nx * thk; a1y = p1.y - ny * thk;
                a2x = p2.x - nx * thk; a2y = p2.y - ny * thk;
                b1x = p1.x; b1y = p1.y;
                b2x = p2.x; b2y = p2.y;
            } else {
                a1x = p1.x; a1y = p1.y;
                a2x = p2.x; a2y = p2.y;
                b1x = p1.x + nx * thk; b1y = p1.y + ny * thk;
                b2x = p2.x + nx * thk; b2y = p2.y + ny * thk;
            }

            var gpA1 = toTsPt(panel.ToGlobal(NewVector(a1x, a1y, 0)));
            var gpA2 = toTsPt(panel.ToGlobal(NewVector(a2x, a2y, 0)));
            var gpB2 = toTsPt(panel.ToGlobal(NewVector(b2x, b2y, 0)));
            var gpB1 = toTsPt(panel.ToGlobal(NewVector(b1x, b1y, 0)));
            stripSegs = [
                { kind: "line", p1: gpA1, p2: gpA2 },
                { kind: "line", p1: gpA2, p2: gpB2 },
                { kind: "line", p1: gpB2, p2: gpB1 },
                { kind: "line", p1: gpB1, p2: gpA1 }
            ];
            midPtTs = toTsPt(panel.ToGlobal(NewVector(mx, my, lz / 2)));
            var p0g = panel.ToGlobal(NewVector(0, 0, 0));
            outNormTs = toTsDir(vSub(panel.ToGlobal(NewVector(nx, ny, 0)), p0g));
        } else if (el.ElType === 2) {
            // Curved arc edge (T2DArc)
            var c = el.Center;
            var r = el.ArcRadius();
            var p1a = el.Pos1, p2a = el.Pos2;
            var pma = el.ArcCenter();
            var ang = 0;
            try { ang = Math.abs(el.ArcAngle()); } catch (e) {}
            if (!ang || ang < 1e-4) {
                var v1x = p1a.x - c.x, v1y = p1a.y - c.y;
                var v2x = p2a.x - c.x, v2y = p2a.y - c.y;
                var dotA = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (r * r)));
                ang = Math.acos(dotA);
            }
            lenMm = r * ang;
            if (r < thk + 0.5 || lenMm < 0.5) continue;

            // Outward radial direction at arc midpoint
            var rmx = (pma.x - c.x) / r, rmy = (pma.y - c.y) / r;
            var epsA = Math.min(1.0, r * 0.1);
            var outSign = pointInContour2D(panel.Contour, pma.x + rmx * epsA, pma.y + rmy * epsA) ? -1 : 1;
            // Offset radius for the second arc
            var rOff = clipPanel ? (r - outSign * thk) : (r + outSign * thk);
            if (rOff < 0.5) continue;
            var scale = rOff / r;
            var q1x = c.x + (p1a.x - c.x) * scale, q1y = c.y + (p1a.y - c.y) * scale;
            var qmx = c.x + (pma.x - c.x) * scale, qmy = c.y + (pma.y - c.y) * scale;
            var q2x = c.x + (p2a.x - c.x) * scale, q2y = c.y + (p2a.y - c.y) * scale;

            var gP1 = toTsPt(panel.ToGlobal(NewVector(p1a.x, p1a.y, 0)));
            var gPm = toTsPt(panel.ToGlobal(NewVector(pma.x, pma.y, 0)));
            var gP2 = toTsPt(panel.ToGlobal(NewVector(p2a.x, p2a.y, 0)));
            var gQ2 = toTsPt(panel.ToGlobal(NewVector(q2x, q2y, 0)));
            var gQm = toTsPt(panel.ToGlobal(NewVector(qmx, qmy, 0)));
            var gQ1 = toTsPt(panel.ToGlobal(NewVector(q1x, q1y, 0)));
            stripSegs = [
                { kind: "arc", p1: gP1, pm: gPm, p2: gP2 },
                { kind: "line", p1: gP2, p2: gQ2 },
                { kind: "arc", p1: gQ2, pm: gQm, p2: gQ1 },
                { kind: "line", p1: gQ1, p2: gP1 }
            ];
            midPtTs = toTsPt(panel.ToGlobal(NewVector(pma.x, pma.y, lz / 2)));
            var p0gA = panel.ToGlobal(NewVector(0, 0, 0));
            outNormTs = toTsDir(vSub(panel.ToGlobal(NewVector(rmx * outSign, rmy * outSign, 0)), p0gA));
            sideTag = "ARC_E" + ei;
        }

        if (!stripSegs) continue;
        totalLenMm += lenMm;
        edges.push({
            elemIndex: ei,
            sideTag: sideTag,
            material: matName,
            code: code,
            thicknessMm: Math.round(thk * 100) / 100,
            widthMm: Math.round(wid * 10) / 10,
            lengthMm: Math.round(lenMm * 10) / 10,
            overhungMm: Math.round(overhung * 10) / 10,
            clipPanel: clipPanel,
            sign: sign,
            midPoint: midPtTs,
            outNormal: outNormTs,
            stripLoop: { segs: stripSegs }
        });
    }

    return {
        edges: edges,
        trim: trim,
        totalLenMm: Math.round(totalLenMm * 10) / 10
    };
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
        var gMin = obj.GabMin || obj.GMin;
        var gMax = obj.GabMax || obj.GMax;
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
        if (typeof obj.CSGFunction === "number") continue;

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
            // Bazis wraps loaded .fr3d fragments (legs, hangers, etc.) inside an outer block named "Model";
            // recurse into it so we pick up the real named fragment block inside!
            if (!name || name === "Model") {
                if (childCount > 0) {
                    collectHardware(obj, panelUidToTsName, out);
                }
                continue;
            }

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
            // For edge operations (rabbet / moulding), Origin (0,0,0) in B&S_Rabbet.top / B&S_Moulding.top
            // lies directly ON the outer panel edge (Y=0) and cuts inward along +Y (0..W).
            // Snap entryPt to the touched panel edge and orient +Y inward toward panel center.
            if (opKind === "rabbet" || opKind === "moulding") {
                if ((gx2 - gx1) >= (gy2 - gy1)) {
                    if (Math.abs(gy1 - cMin.y) <= Math.abs(gy2 - cMax.y)) {
                        entryPt = NewVector((gx1 + gx2) / 2, cMin.y, entryZ);
                    } else {
                        entryPt = NewVector((gx1 + gx2) / 2, cMax.y, entryZ);
                    }
                } else {
                    if (Math.abs(gx1 - cMin.x) <= Math.abs(gx2 - cMax.x)) {
                        entryPt = NewVector(cMin.x, (gy1 + gy2) / 2, entryZ);
                    } else {
                        entryPt = NewVector(cMax.x, (gy1 + gy2) / 2, entryZ);
                    }
                }
                var cutCenterTs = toTsPt(panel.ToGlobal(entryPt));
                var toPanelCenter = vSub(center, cutCenterTs);
                if (vDot(cutAxY, toPanelCenter) < 0) {
                    cutAxX = { x: -cutAxX.x, y: -cutAxX.y, z: -cutAxX.z };
                    cutAxY = { x: -cutAxY.x, y: -cutAxY.y, z: -cutAxY.z };
                }
            }
            var actualDepth = Math.min(profZ2, lz) - Math.max(profZ1, 0);
            if (actualDepth < 0.1) actualDepth = Math.min(profZ, lz);
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
                depthMm: Math.round(actualDepth * 10) / 10
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

    var edgesInfo = extractEdgesData(panel, cMin, cMax, lz, isRect);
    var boardLx = lx;
    var boardLy = ly;
    var boardCenter = center;
    if (isRect && (edgesInfo.trim.left > 0 || edgesInfo.trim.right > 0 || edgesInfo.trim.bottom > 0 || edgesInfo.trim.top > 0)) {
        var bMinX = cMin.x + edgesInfo.trim.left;
        var bMaxX = cMax.x - edgesInfo.trim.right;
        var bMinY = cMin.y + edgesInfo.trim.bottom;
        var bMaxY = cMax.y - edgesInfo.trim.top;
        if (bMaxX - bMinX > 1.0 && bMaxY - bMinY > 1.0) {
            boardLx = bMaxX - bMinX;
            boardLy = bMaxY - bMinY;
            boardCenter = toTsPt(panel.ToGlobal(NewVector((bMinX + bMaxX) / 2, (bMinY + bMaxY) / 2, lz / 2)));
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
        edgeCount: edgesInfo.edges.length,
        edgeTotalLenMm: edgesInfo.totalLenMm,
        edges: edgesInfo.edges,
        layer: pickLayer(rawName, lz),
        isRect: isRect,
        outerLoop: (loops && loops.length > 0) ? loops[0] : null,
        innerLoops: innerLoops,
        center: boardCenter,
        axX: axX,
        axY: blockAxY,
        axZ: axZ,
        lx: boardLx * MM_TO_M,
        ly: boardLy * MM_TO_M,
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

function extract2DSegs(contour) {
    var segs = [];
    if (!contour) return segs;
    var n = contour.Count || 0;
    for (var i = 0; i < n; i++) {
        var el = contour.Objects[i];
        if (!el) continue;
        if (el.ElType === 1) {
            segs.push({
                kind: "line",
                p1: { x: el.Pos1.x, y: el.Pos1.y },
                p2: { x: el.Pos2.x, y: el.Pos2.y }
            });
        } else if (el.ElType === 2) {
            var ctr = el.Center || el.ArcCenter || null;
            var cx = ctr ? Number(ctr.x) : (el.Pos1.x + el.Pos2.x) / 2;
            var cy = ctr ? Number(ctr.y) : (el.Pos1.y + el.Pos2.y) / 2;
            var r = (typeof el.Radius === "number" && isFinite(el.Radius) && el.Radius > 0)
                ? el.Radius
                : (typeof el.ArcRadius === "function" ? Number(el.ArcRadius()) : Math.sqrt(Math.pow(el.Pos1.x - cx, 2) + Math.pow(el.Pos1.y - cy, 2)));
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
                p2: { x: el.Pos2.x, y: el.Pos2.y },
                cx: cx, cy: cy, r: r, a1: a1, da: da
            });
        } else if (el.ElType === 3) {
            var c3 = el.Center || el.CirCenter || { x: 0, y: 0 };
            var r3 = 0;
            if (typeof el.CirRadius === "number" && isFinite(el.CirRadius) && el.CirRadius > 0) r3 = el.CirRadius;
            else if (typeof el.Radius === "number" && isFinite(el.Radius) && el.Radius > 0) r3 = el.Radius;
            else if (typeof el.CirRadius === "function") r3 = Number(el.CirRadius());
            if (!isFinite(r3) || r3 <= 0) r3 = 10;
            segs.push({
                kind: "circle",
                center: { x: c3.x, y: c3.y },
                radius: r3
            });
        }
    }
    return segs;
}

function map2DLoopWithTransform(segs2d, mapPtFn) {
    var segs3d = [];
    for (var k = 0; k < segs2d.length; k++) {
        var sg = segs2d[k];
        if (sg.kind === "line") {
            segs3d.push({ kind: "line", p1: mapPtFn(sg.p1.x, sg.p1.y), p2: mapPtFn(sg.p2.x, sg.p2.y) });
        } else if (sg.kind === "arc") {
            segs3d.push({ kind: "arc", p1: mapPtFn(sg.p1.x, sg.p1.y), pm: mapPtFn(sg.pm.x, sg.pm.y), p2: mapPtFn(sg.p2.x, sg.p2.y) });
        } else if (sg.kind === "circle") {
            segs3d.push({ kind: "circle", center: mapPtFn(sg.center.x, sg.center.y), radius: sg.radius * MM_TO_M });
        }
    }
    return { area: 1, segs: segs3d };
}

function isStandaloneBody3D(obj) {
    if (!obj || obj.AsPanel) return false;
    var hasEx = false, hasTr = false;
    try { hasEx = !!(obj.Contour && typeof obj.Thickness === "number" && obj.Thickness > 0.1 && !obj.Trajectory2D); } catch (e) {}
    try { hasTr = !!(obj.Contour2D && obj.Trajectory2D && obj.Contour2D.Count > 0 && obj.Trajectory2D.Count > 0); } catch (e) {}
    return hasEx || hasTr;
}

function makeRectLoop3D(obj, x1, y1, x2, y2, zLocal) {
    var p1 = toTsPt(obj.ToGlobal(NewVector(x1, y1, zLocal)));
    var p2 = toTsPt(obj.ToGlobal(NewVector(x2, y1, zLocal)));
    var p3 = toTsPt(obj.ToGlobal(NewVector(x2, y2, zLocal)));
    var p4 = toTsPt(obj.ToGlobal(NewVector(x1, y2, zLocal)));
    return {
        area: Math.abs((x2 - x1) * (y2 - y1)),
        segs: [
            { kind: "line", p1: p1, p2: p2 },
            { kind: "line", p1: p2, p2: p3 },
            { kind: "line", p1: p3, p2: p4 },
            { kind: "line", p1: p4, p2: p1 }
        ]
    };
}

function extractBody3D(obj, idxHint) {
    if (!obj) return null;
    try {
        if (obj.constructor && obj.constructor.name === "TModelLimits") return null;
    } catch (e) {}
    var matName = "";
    try { matName = String(obj.MaterialName || "").split("\r")[0].trim(); } catch (e) {}
    var bName = String(obj.Name || ("Body_" + idxHint));

    // Case A: TCSGOperation (recursive boolean: 0=subtract, 1=union, 2=intersect)
    if (typeof obj.CSGFunction === "number" && obj.Count > 0) {
        var ops = [];
        for (var c = 0; c < obj.Count; c++) {
            var ch = extractBody3D(obj.Objects[c], idxHint + "_" + c);
            if (ch) ops.push(ch);
        }
        if (ops.length > 0) {
            return {
                kind: "csg",
                name: bName,
                material: matName,
                csgOp: Number(obj.CSGFunction),
                operands: ops
            };
        }
        return null;
    }

    // Case B: TFurnPanel operand inside a TCSGOperation
    if (obj.AsPanel) {
        var pd = extractPanelData(obj.AsPanel, 0);
        if (pd.isRect || !pd.outerLoop) {
            return {
                kind: "box",
                name: bName,
                material: pd.material,
                center: pd.center,
                axX: pd.axX,
                axY: pd.axY,
                lx: pd.lx,
                ly: pd.ly,
                lz: pd.lz
            };
        }
        return {
            kind: "extrusion",
            name: bName,
            material: pd.material,
            outerLoop: pd.outerLoop,
            innerLoops: pd.innerLoops || [],
            axX: pd.axX,
            axY: pd.axY,
            dir: pd.axZ,
            length: pd.lz
        };
    }

    // Case C: TSphere3D (Radius, StartAngle, EndAngle, center at local (0,0,0))
    if (typeof obj.Radius === "number" && obj.Radius > 0.1 && typeof obj.StartAngle === "number") {
        var sp0 = obj.ToGlobal(NewVector(0, 0, 0));
        var saxX = toTsDir(vSub(obj.ToGlobal(NewVector(1, 0, 0)), sp0));
        var saxY = toTsDir(vSub(obj.ToGlobal(NewVector(0, 1, 0)), sp0));
        var ang = Math.abs(Number(obj.EndAngle || (2 * Math.PI)) - Number(obj.StartAngle || 0));
        if (ang < 1e-4) ang = 2 * Math.PI;
        return {
            kind: "sphere",
            name: bName,
            material: matName,
            center: toTsPt(sp0),
            axX: saxX,
            axY: saxY,
            radius: obj.Radius * MM_TO_M,
            angleRad: ang
        };
    }

    // Case D: TPyramid3D (Width along X, Height along Y, Depth along Z: base at Z=0, apex at Z=Depth)
    // Exact 5-face closed Parasolid pyramid = AddIntersection of two extruded triangular wedges (XZ wedge along Y & YZ wedge along X)
    if (typeof obj.Width === "number" && typeof obj.Height === "number" && typeof obj.Depth === "number" &&
        obj.Width > 0.1 && obj.Height > 0.1 && obj.Depth > 0.1 && !obj.Contour && !obj.Trajectory2D) {
        var pp0 = obj.ToGlobal(NewVector(0, 0, 0));
        var paxX = toTsDir(vSub(obj.ToGlobal(NewVector(1, 0, 0)), pp0));
        var paxY = toTsDir(vSub(obj.ToGlobal(NewVector(0, 1, 0)), pp0));
        var hw = obj.Width / 2, hh = obj.Height / 2, dep = obj.Depth;
        // Wedge 1: triangle in XZ plane at y = -hh, extruded along +Y by Height
        var w1p1 = toTsPt(obj.ToGlobal(NewVector(-hw, -hh, 0)));
        var w1p2 = toTsPt(obj.ToGlobal(NewVector(hw, -hh, 0)));
        var w1p3 = toTsPt(obj.ToGlobal(NewVector(0, -hh, dep)));
        var triXZ = {
            area: hw * dep,
            segs: [
                { kind: "line", p1: w1p1, p2: w1p2 },
                { kind: "line", p1: w1p2, p2: w1p3 },
                { kind: "line", p1: w1p3, p2: w1p1 }
            ]
        };
        // Wedge 2: triangle in YZ plane at x = -hw, extruded along +X by Width
        var w2p1 = toTsPt(obj.ToGlobal(NewVector(-hw, -hh, 0)));
        var w2p2 = toTsPt(obj.ToGlobal(NewVector(-hw, hh, 0)));
        var w2p3 = toTsPt(obj.ToGlobal(NewVector(-hw, 0, dep)));
        var triYZ = {
            area: hh * dep,
            segs: [
                { kind: "line", p1: w2p1, p2: w2p2 },
                { kind: "line", p1: w2p2, p2: w2p3 },
                { kind: "line", p1: w2p3, p2: w2p1 }
            ]
        };
        return {
            kind: "pyramid",
            name: bName,
            material: matName,
            outerLoop: triXZ,
            topLoop: triYZ,
            axX: paxX,
            axY: paxY,
            lx: obj.Width * MM_TO_M,
            ly: obj.Height * MM_TO_M
        };
    }

    // Case E: TExtrusionBody (Contour + Thickness)
    var isEx = false;
    try { isEx = !!(obj.Contour && obj.Contour.Count > 0 && typeof obj.Thickness === "number" && obj.Thickness > 0.1 && !obj.Trajectory2D); } catch (e) {}
    if (isEx) {
        var p0 = obj.ToGlobal(NewVector(0, 0, 0));
        var axX = toTsDir(vSub(obj.ToGlobal(NewVector(1, 0, 0)), p0));
        var axY = toTsDir(vSub(obj.ToGlobal(NewVector(0, 1, 0)), p0));
        var axZ = toTsDir(vSub(obj.ToGlobal(NewVector(0, 0, 1)), p0));
        var loops = extractContourLoops(obj, 0);
        var innerLoops = loops.length > 1 ? extractContourLoops(obj, -1.0).slice(1) : [];
        if (loops.length > 0) {
            return {
                kind: "extrusion",
                name: bName,
                material: matName,
                outerLoop: loops[0],
                innerLoops: innerLoops,
                axX: axX,
                axY: axY,
                dir: axZ,
                length: obj.Thickness * MM_TO_M
            };
        }
        return null;
    }

    // Case F: TTrajectoryBody (Contour2D + Trajectory2D -> Revolve or Sweep)
    var isTr = false;
    try { isTr = !!(obj.Contour2D && obj.Trajectory2D && obj.Contour2D.Count > 0 && obj.Trajectory2D.Count > 0); } catch (e) {}
    if (isTr) {
        var profSegs = extract2DSegs(obj.Contour2D);
        var trajSegs = extract2DSegs(obj.Trajectory2D);
        if (profSegs.length === 0 || trajSegs.length === 0) return null;

        var tp0 = obj.ToGlobal(NewVector(0, 0, 0));
        var zAxisTs = toTsDir(vSub(obj.ToGlobal(NewVector(0, 0, 1)), tp0));

        function buildProfileAt(tx, ty, nx, ny) {
            var lp = map2DLoopWithTransform(profSegs, function(u, v) {
                return toTsPt(obj.ToGlobal(NewVector(tx + u * nx, ty + u * ny, v)));
            });
            var nDir = toTsDir(vSub(obj.ToGlobal(NewVector(nx, ny, 0)), tp0));
            return { loop: lp, axX: nDir, axY: zAxisTs };
        }

        if (trajSegs.length === 1 && (trajSegs[0].kind === "circle" || trajSegs[0].kind === "arc")) {
            var ts0 = trajSegs[0];
            var cx = ts0.kind === "circle" ? ts0.center.x : ts0.cx;
            var cy = ts0.kind === "circle" ? ts0.center.y : ts0.cy;
            var sx = ts0.kind === "circle" ? (cx + ts0.radius) : ts0.p1.x;
            var sy = ts0.kind === "circle" ? cy : ts0.p1.y;
            var dirSign = (ts0.kind === "circle" || ts0.da >= 0) ? 1 : -1;
            var aStart = ts0.kind === "circle" ? 0 : ts0.a1;
            var tangX = -dirSign * Math.sin(aStart);
            var tangY = dirSign * Math.cos(aStart);
            var normX = -tangY;
            var normY = tangX;
            var pf = buildProfileAt(sx, sy, normX, normY);
            return {
                kind: "revolve",
                name: bName,
                material: matName,
                outerLoop: pf.loop,
                axX: pf.axX,
                axY: pf.axY,
                axisOrigin: toTsPt(obj.ToGlobal(NewVector(cx, cy, 0))),
                axisDir: { x: zAxisTs.x * dirSign, y: zAxisTs.y * dirSign, z: zAxisTs.z * dirSign },
                angleRad: ts0.kind === "circle" ? (2 * Math.PI) : Math.abs(ts0.da)
            };
        } else {
            var sweepSegs = [];
            for (var si = 0; si < trajSegs.length; si++) {
                var seg = trajSegs[si];
                if (seg.kind === "line") {
                    var dx = seg.p2.x - seg.p1.x, dy = seg.p2.y - seg.p1.y;
                    var len = Math.sqrt(dx * dx + dy * dy);
                    if (len < 0.1) continue;
                    var tx = dx / len, ty = dy / len;
                    var nx = -ty, ny = tx;
                    var pfL = buildProfileAt(seg.p1.x, seg.p1.y, nx, ny);
                    var dirTs = toTsDir(vSub(obj.ToGlobal(NewVector(seg.p2.x, seg.p2.y, 0)), obj.ToGlobal(NewVector(seg.p1.x, seg.p1.y, 0))));
                    sweepSegs.push({
                        kind: "extrude",
                        profileLoop: pfL.loop,
                        axX: pfL.axX,
                        axY: pfL.axY,
                        dir: dirTs,
                        length: len * MM_TO_M
                    });
                } else if (seg.kind === "arc") {
                    var dS = seg.da >= 0 ? 1 : -1;
                    var tAx = -dS * Math.sin(seg.a1), tAy = dS * Math.cos(seg.a1);
                    var nAx = -tAy, nAy = tAx;
                    var pfA = buildProfileAt(seg.p1.x, seg.p1.y, nAx, nAy);
                    sweepSegs.push({
                        kind: "revolve",
                        profileLoop: pfA.loop,
                        axX: pfA.axX,
                        axY: pfA.axY,
                        axisOrigin: toTsPt(obj.ToGlobal(NewVector(seg.cx, seg.cy, 0))),
                        axisDir: { x: zAxisTs.x * dS, y: zAxisTs.y * dS, z: zAxisTs.z * dS },
                        angleRad: Math.abs(seg.da)
                    });
                }
            }
            if (sweepSegs.length > 0) {
                return {
                    kind: "sweep",
                    name: bName,
                    material: matName,
                    segments: sweepSegs
                };
            }
        }
    }
    return null;
}

function collectBodies(container, out) {
    var cnt = 0;
    try { cnt = container.Count || 0; } catch (e) { cnt = 0; }
    for (var i = 0; i < cnt; i++) {
        var obj = container.Objects[i];
        if (!obj || obj.Visible === false || obj.AsPanel) continue;

        var isFastener = false;
        try { isFastener = !!(obj.Holes && obj.Holes.Count >= 0); } catch (e) {}
        if (isFastener) continue;

        // Check TCSGOperation FIRST (it has Count > 0, so handle it before generic container recursion)
        if (typeof obj.CSGFunction === "number") {
            var csgBody = extractBody3D(obj, out.length + 1);
            if (csgBody) out.push(csgBody);
            continue;
        }

        var childCount = 0;
        try { childCount = obj.Count || 0; } catch (e) {}
        if (childCount > 0) {
            if (subtreeHasPanel(obj)) {
                collectBodies(obj, out);
            }
            continue;
        }

        var b = extractBody3D(obj, out.length + 1);
        if (b) out.push(b);
    }
}

function decodeXmlEntities(s) {
    return String(s || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'");
}

function splitBazisMatName(rawName) {
    var s = String(rawName || "");
    var parts = s.split(/[\r\n]+/);
    var name = (parts[0] || "").trim();
    var code = parts.length > 1 ? (parts[1] || "").trim() : "";
    return { name: name, code: code };
}

function colorRefToRgb(col) {
    var n = Number(col);
    if (!isFinite(n) || n < 0) return { r: 0.85, g: 0.85, b: 0.85 };
    var iv = Math.floor(n) & 0xFFFFFF;
    var r = (iv & 0xFF) / 255.0;
    var g = ((iv >> 8) & 0xFF) / 255.0;
    var b = ((iv >> 16) & 0xFF) / 255.0;
    return { r: r, g: g, b: b };
}

function resolveBazisTextureRoots() {
    var roots = [];
    var appData = process.env.APPDATA || "";
    var userProf = process.env.USERPROFILE || "";
    var settingsPaths = [];
    if (appData) settingsPaths.push(path.join(appData, "Bazis", "Settings.xml"));
    settingsPaths.push("Y:\\Works\\bazis\\Settings\\Settings.xml");

    for (var i = 0; i < settingsPaths.length; i++) {
        try {
            if (!fs.existsSync(settingsPaths[i])) continue;
            var xml = fs.readFileSync(settingsPaths[i], "utf8");
            var m = xml.match(/<PathTEXTUR>([^<]+)<\/PathTEXTUR>/i);
            if (m && m[1]) {
                var p = decodeXmlEntities(m[1]).trim().replace(/\{\{BAZIS_DIR\}\}/g, "Y:\\Works\\bazis");
                if (p && roots.indexOf(p) === -1) roots.push(p);
            }
        } catch (e) {}
    }
    var fallbacks = [
        "Y:\\Works\\bazis\\Textures",
        "Y:\\Works\\bazis",
        userProf ? path.join(userProf, "Documents", "Bazis", "Textures") : "",
        userProf ? path.join(userProf, "Documents", "Bazis") : ""
    ];
    for (var j = 0; j < fallbacks.length; j++) {
        if (fallbacks[j] && roots.indexOf(fallbacks[j]) === -1) roots.push(fallbacks[j]);
    }
    return roots;
}

function resolveTextureFile(relOrAbs, texRoots) {
    var raw = String(relOrAbs || "").trim();
    if (!raw) return "";
    try {
        if (fs.existsSync(raw)) return raw;
    } catch (e) {}
    for (var i = 0; i < texRoots.length; i++) {
        var cand = path.join(texRoots[i], raw);
        try {
            if (fs.existsSync(cand)) return cand;
        } catch (e) {}
    }
    return "";
}

function loadBazisMaterialLibrary() {
    var map = {};
    var texRoots = resolveBazisTextureRoots();
    var appData = process.env.APPDATA || "";
    var xmlPaths = [];
    if (appData) xmlPaths.push(path.join(appData, "Bazis", "Materials.xml"));
    xmlPaths.push("Y:\\Works\\bazis\\Settings\\Materials.xml");

    for (var i = 0; i < xmlPaths.length; i++) {
        try {
            if (!fs.existsSync(xmlPaths[i])) continue;
            var xml = fs.readFileSync(xmlPaths[i], "utf8");
            var re = /<Material>([\s\S]*?)<\/Material>/g;
            var m;
            while ((m = re.exec(xml)) !== null) {
                var blk = m[1];
                var nmM = blk.match(/<Name>([\s\S]*?)<\/Name>/i);
                if (!nmM) continue;
                var sp = splitBazisMatName(decodeXmlEntities(nmM[1]));
                if (!sp.name) continue;
                var key = sp.name.toLowerCase();
                var colM = blk.match(/<Color>([^<]+)<\/Color>/i);
                var texM = blk.match(/<Texture>([^<]+)<\/Texture>/i);
                var reflM = blk.match(/<Reflection>([^<]+)<\/Reflection>/i);
                var transM = blk.match(/<Transparency>([^<]+)<\/Transparency>/i);
                var rgb = colM ? colorRefToRgb(colM[1]) : { r: 0.85, g: 0.85, b: 0.85 };
                var rawTex = texM ? decodeXmlEntities(texM[1]).trim() : "";
                var texPath = resolveTextureFile(rawTex, texRoots);
                var texName = rawTex ? path.basename(rawTex).replace(/\.[^.]+$/, "") : "";
                var existing = map[key];
                if (!existing || (!existing.texturePath && texPath)) {
                    map[key] = {
                        name: sp.name,
                        code: sp.code || (existing ? existing.code : ""),
                        colorR: rgb.r,
                        colorG: rgb.g,
                        colorB: rgb.b,
                        reflection: reflM ? (parseFloat(reflM[1]) || 0) : 0,
                        transparency: transM ? (parseFloat(transM[1]) || 0) : 0,
                        texturePath: texPath || (existing ? existing.texturePath : ""),
                        textureName: texName || (existing ? existing.textureName : "")
                    };
                }
            }
        } catch (e) {}
    }
    return map;
}

function classifyMaterialCategory(name, hintCat) {
    if (hintCat === "panel" || hintCat === "edge") return hintCat;
    var low = String(name || "").toLowerCase();
    if (low.indexOf("edge") !== -1 || low.indexOf("abs") !== -1 || low.indexOf("pvc") !== -1 || low.indexOf("butt") !== -1) {
        return "edge";
    }
    if (low.indexOf("ldsp") !== -1 || low.indexOf("mdf") !== -1 || low.indexOf("hdf") !== -1 || low.indexOf("board") !== -1 || low.indexOf("panel") !== -1 || low.indexOf("plywood") !== -1) {
        return "panel";
    }
    return "other";
}

function collectModelMaterials(rawPanels, bodies, matLib) {
    var byKey = {};
    var out = [];

    function upsert(rawName, hintCat, thicknessMm, widthMm, objColor, hasGrain) {
        var sp = splitBazisMatName(rawName);
        if (!sp.name) return;
        var key = sp.name.toLowerCase();
        var lib = matLib[key] || null;
        if (byKey[key]) {
            if (thicknessMm > 0 && byKey[key].thicknessMm <= 0) byKey[key].thicknessMm = thicknessMm;
            if (widthMm > 0 && byKey[key].widthMm <= 0) byKey[key].widthMm = widthMm;
            if (hasGrain) byKey[key].hasGrain = true;
            return;
        }
        var rgb = lib ? { r: lib.colorR, g: lib.colorG, b: lib.colorB } : colorRefToRgb(objColor);
        var entry = {
            name: sp.name,
            code: sp.code || (lib ? lib.code : ""),
            category: classifyMaterialCategory(sp.name, hintCat),
            thicknessMm: thicknessMm > 0 ? thicknessMm : 0,
            widthMm: widthMm > 0 ? widthMm : 0,
            lengthMm: 0,
            density: 0,
            colorR: rgb.r,
            colorG: rgb.g,
            colorB: rgb.b,
            reflection: lib ? lib.reflection : 0,
            transparency: lib ? lib.transparency : 0,
            texturePath: lib ? lib.texturePath : "",
            textureName: lib ? lib.textureName : "",
            hasGrain: !!hasGrain
        };
        byKey[key] = entry;
        out.push(entry);
    }

    for (var i = 0; i < rawPanels.length; i++) {
        var p = rawPanels[i];
        var pMat = "";
        try { pMat = cleanMatName(p.MaterialName); } catch (e) {}
        var pThk = 0;
        try { pThk = Number(p.Thickness) || 0; } catch (e) {}
        var pCol = -1;
        try { pCol = p.Color; } catch (e) {}
        var pGrain = false;
        try { pGrain = (p.TextureOrientation !== 0); } catch (e) {}
        if (pMat) upsert(p.MaterialName || pMat, "panel", pThk, 0, pCol, pGrain);

        try {
            if (p.Butts && p.Butts.Count > 0) {
                for (var bi = 0; bi < p.Butts.Count; bi++) {
                    var bt = p.Butts[bi];
                    if (!bt) continue;
                    var bMat = bt.Material || "";
                    var bThk = Number(bt.Thickness) || 0;
                    var bWid = Number(bt.Width) || (pThk > 0 ? pThk + 1 : 19);
                    if (bMat) upsert(bMat, "edge", bThk, bWid, -1, false);
                }
            }
        } catch (e) {}

        try {
            if (p.Plastics && p.Plastics.Count > 0) {
                for (var pi = 0; pi < p.Plastics.Count; pi++) {
                    var pl = p.Plastics[pi];
                    if (!pl) continue;
                    var plMat = pl.Material || "";
                    var plThk = Number(pl.Thickness) || 0;
                    if (plMat) upsert(plMat, "panel", plThk, 0, -1, false);
                }
            }
        } catch (e) {}
    }

    function walkBodyMats(list) {
        if (!list) return;
        for (var j = 0; j < list.length; j++) {
            var b = list[j];
            if (!b) continue;
            if (b.material) upsert(b.material, "other", 0, 0, -1, false);
            if (b.operands && b.operands.length > 0) walkBodyMats(b.operands);
        }
    }
    walkBodyMats(bodies);

    return out;
}

function main() {
    var rawPanels = [];
    collectPanels(Model, rawPanels);
    var bodies = [];
    collectBodies(Model, bodies);
    if (rawPanels.length === 0 && bodies.length === 0) {
        alert("No panels or 3D bodies found in the active Bazis model.");
        return;
    }

    var tplDir = resolveTemplatesDir();
    var hwLibDir = resolveHardwareLibDir();
    var matLib = loadBazisMaterialLibrary();
    var materials = collectModelMaterials(rawPanels, bodies, matLib);
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
            bodies: bodies,
            hardware: hardware,
            materials: materials
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
