// Bazis-Mebelshchik 2022+ Script: Export CNC Programs for HOMAG / Weeke (woodWOP .mpr)
//
// Reads all CNC machining operations directly from every panel in the model:
//   - Workpiece dimensions (LA x BR x DI) & grain orientation
//   - Vertical drilling (top face -> <102 \BohrVert\>, bottom face -> separate *_B.mpr)
//   - Horizontal edge drilling on all 4 edges (<103 \BohrHoriz\>, BM=XP/XM/YP/YM)
//   - Straight grooves / dadoes (<109 \Nuten\>)
//   - Non-rectangular contours / cutouts (]1 contour + <105 \Konturfraesen\>)
//
// File naming uses each panel's ArtPos (if assigned) + sanitized panel name:
//   e.g. "001_Left_Side_pos_010.mpr" (and "001_Left_Side_pos_010_B.mpr" if back-face ops exist).

// --- Configuration --------------------------------------------------------
var FLIP_AXIS_FOR_BACK = "X";   // "X" (flip around X -> mirrors Y) or "Y" (flip around Y -> mirrors X)
var MILLING_TOOL_NO = "101";    // Default router tool number for <105 \Konturfraesen\>
var MILLING_TOOL_RADIUS = 6;    // Router bit radius in mm (for reference)
var SAW_TOOL_NO = "200";        // Default grooving saw tool number
var THROUGH_TOLERANCE = 0.5;    // mm tolerance to classify a vertical hole as through-hole
var SKIP_NON_CNC = true;        // Skip panels where panel.UseInCNC === false
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
    var r = Math.round(num * 100) / 100;
    if (Math.abs(r) < 0.005) r = 0;
    return String(r);
}

function sanitizeFileName(name) {
    return String(name || "Part")
        .replace(/[\\\/:*?"<>|,]+/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "Part";
}

function padPos(pos) {
    var s = String(pos || "").trim();
    if (/^\d+$/.test(s)) {
        while (s.length < 3) s = "0" + s;
    }
    return s;
}

function collectPanels(obj, out) {
    if (!obj) return;
    if (!safeGet(function () { return obj.Visible; }, true)) return;
    var p = safeGet(function () { return obj.AsPanel; }, null);
    if (p) {
        if (!SKIP_NON_CNC || safeGet(function () { return p.UseInCNC; }, true)) {
            out.push(p);
        }
        return;
    }
    if (safeGet(function () { return obj.List; }, false)) {
        var list = safeGet(function () { return obj.AsList(); }, null);
        if (list) {
            for (var i = 0; i < safeGet(function () { return list.Count; }, 0); i++) {
                collectPanels(safeGet(function () { return list.Objects[i]; }, null), out);
            }
        }
    }
}

// Compute the portion of a hole segment [p0 -> p1] that lies inside the panel box
// [0..L] x [0..B] x [0..T] in panel local coordinates.
function extractPanelHoles(panel, cMin, L, B, T) {
    var topVert = [];
    var botVert = [];
    var horiz = [];

    var fasteners = safeGet(function () { return panel.FindConnectedFasteners(); }, null);
    if (!fasteners || !fasteners.length) return { topVert: topVert, botVert: botVert, horiz: horiz };

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
            if (diam <= 0 || rawDepth <= 0) continue;

            var localPos = safeGet(function () { return h.Position; }, null);
            var localDir = safeGet(function () { return h.Direction; }, null);
            if (!localPos || !localDir) continue;

            var gPos = safeGet(function () { return f.ToGlobal(localPos); }, null);
            var gDir = safeGet(function () { return f.NToGlobal(localDir); }, null);
            if (!gPos || !gDir) continue;

            var pPos = safeGet(function () { return panel.ToObject(gPos); }, null);
            var pDir = safeGet(function () { return panel.NToObject(gDir); }, null);
            if (!pPos || !pDir) continue;

            // Normalize direction
            var dLen = Math.sqrt(pDir.x * pDir.x + pDir.y * pDir.y + pDir.z * pDir.z);
            if (dLen < 1e-6) continue;
            var dx = pDir.x / dLen;
            var dy = pDir.y / dLen;
            var dz = pDir.z / dLen;

            // Shift XY into [0..L] x [0..B]
            var sx = pPos.x - cMin.x;
            var sy = pPos.y - cMin.y;
            var sz = pPos.z;
            var ex = sx + dx * rawDepth;
            var ey = sy + dy * rawDepth;
            var ez = sz + dz * rawDepth;

            // Slab intersection with [0..L] x [0..B] x [0..T] (with 1mm entry tolerance)
            var tol = 1.0;
            var tMin = 0;
            var tMax = rawDepth;

            function clipAxis(s, d, lo, hi) {
                if (Math.abs(d) < 1e-6) {
                    return s >= lo - tol && s <= hi + tol;
                }
                var t1 = (lo - s) / d;
                var t2 = (hi - s) / d;
                if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > tMin) tMin = t1;
                if (t2 < tMax) tMax = t2;
                return tMin <= tMax;
            }

            if (!clipAxis(sx, dx, 0, L)) continue;
            if (!clipAxis(sy, dy, 0, B)) continue;
            if (!clipAxis(sz, dz, 0, T)) continue;

            var effDepth = tMax - tMin;
            if (effDepth < 0.5) continue;

            var ix = sx + dx * tMin;
            var iy = sy + dy * tMin;
            var iz = sz + dz * tMin;

            var dedupKey = [
                Math.round(ix * 10), Math.round(iy * 10), Math.round(iz * 10),
                Math.round(dx * 10), Math.round(dy * 10), Math.round(dz * 10),
                Math.round(diam * 10), Math.round(effDepth * 10)
            ].join("|");
            if (seen[dedupKey]) continue;
            seen[dedupKey] = true;

            if (Math.abs(dz) > 0.9) {
                var isThrough = effDepth >= (T - THROUGH_TOLERANCE);
                var entry = { x: ix, y: iy, diam: diam, depth: isThrough ? T : effDepth, through: isThrough };
                if (dz < 0) {
                    topVert.push(entry);
                } else {
                    botVert.push(entry);
                }
            } else if (Math.abs(dx) > 0.9) {
                horiz.push({
                    bm: dx > 0 ? "XP" : "XM",
                    x: dx > 0 ? 0 : L,
                    y: iy,
                    z: iz,
                    diam: diam,
                    depth: effDepth
                });
            } else if (Math.abs(dy) > 0.9) {
                horiz.push({
                    bm: dy > 0 ? "YP" : "YM",
                    x: ix,
                    y: dy > 0 ? 0 : B,
                    z: iz,
                    diam: diam,
                    depth: effDepth
                });
            }
        }
    }

    return { topVert: topVert, botVert: botVert, horiz: horiz };
}

function extractPanelGrooves(panel, cMin) {
    var topGrooves = [];
    var botGrooves = [];
    var cuts = safeGet(function () { return panel.Cuts; }, null);
    if (!cuts) return { topGrooves: topGrooves, botGrooves: botGrooves };

    var count = safeGet(function () { return cuts.Count; }, 0);
    for (var i = 0; i < count; i++) {
        var cut = safeGet(function () { return cuts[i]; }, null);
        if (!cut) continue;
        var front = safeGet(function () { return cut.FrontSide !== false; }, true);
        var traj = safeGet(function () { return cut.Trajectory; }, null);
        var prof = safeGet(function () { return cut.Contour; }, null);
        if (!traj) continue;

        var width = 4;
        var depth = 8;
        if (prof) {
            var pMin = safeGet(function () { return prof.Min; }, null);
            var pMax = safeGet(function () { return prof.Max; }, null);
            if (pMin && pMax) {
                var pw = Math.abs(pMax.x - pMin.x);
                var pd = Math.abs(pMax.y - pMin.y);
                if (pw > 0.1) width = pw;
                if (pd > 0.1) depth = pd;
            }
        }

        var tCount = safeGet(function () { return traj.Count; }, 0);
        for (var j = 0; j < tCount; j++) {
            var el = safeGet(function () { return traj.Objects[j]; }, null);
            if (!el) continue;
            var p1 = safeGet(function () { return el.Pos1; }, null);
            var p2 = safeGet(function () { return el.Pos2; }, null);
            if (!p1 || !p2) continue;

            var g = {
                name: safeGet(function () { return String(cut.Name || "Groove"); }, "Groove"),
                x1: p1.x - cMin.x,
                y1: p1.y - cMin.y,
                x2: p2.x - cMin.x,
                y2: p2.y - cMin.y,
                width: width,
                depth: depth
            };
            if (front) topGrooves.push(g);
            else botGrooves.push(g);
        }
    }

    return { topGrooves: topGrooves, botGrooves: botGrooves };
}

function buildMprContent(meta, L, B, T, vertHoles, horizHoles, grooves, contourElems) {
    var lines = [];
    lines.push("[H");
    lines.push("VERSION=\"4.0 Alpha\"");
    lines.push("WW=\"6.0.0\"");
    lines.push("OP=\"1\"");
    lines.push("WRK2=\"1\"");
    lines.push("FM=\"1\"");
    lines.push("ML=\"2000\"");
    lines.push("UF=\"STANDARD\"");
    lines.push("DN=\"STANDARD\"");
    lines.push("GP=\"0\"");
    lines.push("GY=\"0\"");
    lines.push("GXY=\"0\"");
    lines.push("NP=\"1\"");
    lines.push("NE=\"0\"");
    lines.push("NA=\"0\"");
    lines.push("BFS=\"1\"");
    lines.push("US=\"0\"");
    lines.push("CB=\"0\"");
    lines.push("UP=\"0\"");
    lines.push("DW=\"0\"");
    lines.push("MAT=\"WPI\"");
    lines.push("INCH=\"0\"");
    lines.push("VIEW=\"NOMIRROR\"");
    lines.push("ANZ=\"1\"");
    lines.push("BES=\"0\"");
    lines.push("ENT=\"0\"");
    lines.push("_BSX=" + fmt(L));
    lines.push("_BSY=" + fmt(B));
    lines.push("_BSZ=" + fmt(T));
    lines.push("_FNX=0.000000");
    lines.push("_FNY=0.000000");
    lines.push("_RNX=0.000000");
    lines.push("_RNY=0.000000");
    lines.push("_RNZ=0.000000");
    lines.push("_RX=" + fmt(L));
    lines.push("_RY=" + fmt(B));
    lines.push("");

    // Variables block
    lines.push("[001");
    lines.push("l=\"" + fmt(L) + "\"");
    lines.push("KM=\"Length\"");
    lines.push("b=\"" + fmt(B) + "\"");
    lines.push("KM=\"Width\"");
    lines.push("d=\"" + fmt(T) + "\"");
    lines.push("KM=\"Thickness\"");
    lines.push("");

    // Optional contour block for non-rectangular panels
    var hasContour = contourElems && contourElems.length > 0;
    if (hasContour) {
        lines.push("]1");
        lines.push("$E0");
        lines.push("KP");
        lines.push("X=" + fmt(contourElems[0].x1));
        lines.push("Y=" + fmt(contourElems[0].y1));
        lines.push("Z=0");
        lines.push("KO=00");
        for (var ci = 0; ci < contourElems.length; ci++) {
            var ce = contourElems[ci];
            lines.push("$E" + (ci + 1));
            lines.push("KL");
            lines.push("X=" + fmt(ce.x2));
            lines.push("Y=" + fmt(ce.y2));
            lines.push("Z=0");
        }
        lines.push("");
    }

    // Program body
    lines.push("<100 \\WerkStck\\");
    lines.push("LA=\"l\"");
    lines.push("BR=\"b\"");
    lines.push("DI=\"d\"");
    lines.push("FNX=\"0\"");
    lines.push("FNY=\"0\"");
    lines.push("AX=\"0\"");
    lines.push("AY=\"0\"");
    lines.push("");

    lines.push("<101 \\Kommentar\\");
    lines.push("KM=\"" + meta.comment.replace(/"/g, "'") + "\"");
    lines.push("");

    // Vertical drilling (<102 \BohrVert\)
    for (var vi = 0; vi < vertHoles.length; vi++) {
        var vh = vertHoles[vi];
        lines.push("<102 \\BohrVert\\");
        lines.push("XA=\"" + fmt(vh.x) + "\"");
        lines.push("YA=\"" + fmt(vh.y) + "\"");
        lines.push("BM=\"" + (vh.through ? "LSL" : "LS") + "\"");
        lines.push("TI=\"" + fmt(vh.depth) + "\"");
        lines.push("DU=\"" + fmt(vh.diam) + "\"");
        lines.push("AN=\"1\"");
        lines.push("MI=\"0\"");
        lines.push("S_=\"1\"");
        lines.push("AB=\"32\"");
        lines.push("WI=\"0\"");
        lines.push("ZT=\"0\"");
        lines.push("RM=\"0\"");
        lines.push("VW=\"0\"");
        lines.push("HP=\"0\"");
        lines.push("SP=\"0\"");
        lines.push("YVE=\"0\"");
        lines.push("WW=\"60,61,62,86,87,88,90,91,92,148,149,150,191,192\"");
        lines.push("ASG=\"2\"");
        lines.push("MX=\"0\"");
        lines.push("MY=\"0\"");
        lines.push("MZ=\"0\"");
        lines.push("MXF=\"1\"");
        lines.push("MYF=\"1\"");
        lines.push("MZF=\"1\"");
        lines.push("KO=\"00\"");
        lines.push("");
    }

    // Horizontal edge drilling (<103 \BohrHoriz\)
    for (var hi = 0; hi < horizHoles.length; hi++) {
        var hh = horizHoles[hi];
        lines.push("<103 \\BohrHoriz\\");
        lines.push("XA=\"" + fmt(hh.x) + "\"");
        lines.push("YA=\"" + fmt(hh.y) + "\"");
        lines.push("ZA=\"" + fmt(hh.z) + "\"");
        lines.push("DU=\"" + fmt(hh.diam) + "\"");
        lines.push("TI=\"" + fmt(hh.depth) + "\"");
        lines.push("BM=\"" + hh.bm + "\"");
        lines.push("AN=\"1\"");
        lines.push("AB=\"32\"");
        lines.push("WI=\"0\"");
        lines.push("MI=\"0\"");
        lines.push("HP=\"0\"");
        lines.push("SP=\"0\"");
        lines.push("YVE=\"0\"");
        lines.push("ASG=\"2\"");
        lines.push("KO=\"00\"");
        lines.push("");
    }

    // Grooves / dadoes (<109 \Nuten\)
    for (var gi = 0; gi < grooves.length; gi++) {
        var gr = grooves[gi];
        lines.push("<109 \\Nuten\\");
        lines.push("XA=\"" + fmt(gr.x1) + "\"");
        lines.push("YA=\"" + fmt(gr.y1) + "\"");
        lines.push("XE=\"" + fmt(gr.x2) + "\"");
        lines.push("YE=\"" + fmt(gr.y2) + "\"");
        lines.push("NB=\"" + fmt(gr.width) + "\"");
        lines.push("TI=\"" + fmt(gr.depth) + "\"");
        lines.push("RK=\"NOWRK\"");
        lines.push("EM=\"MOD0\"");
        lines.push("ML=\"AUTO\"");
        lines.push("NM=\"1\"");
        lines.push("BM=\"LS\"");
        lines.push("WI=\"0\"");
        lines.push("XY=\"100\"");
        lines.push("T_=\"" + SAW_TOOL_NO + "\"");
        lines.push("F_=\"STANDARD\"");
        lines.push("HP=\"0\"");
        lines.push("SP=\"0\"");
        lines.push("YVE=\"0\"");
        lines.push("KO=\"00\"");
        lines.push("");
    }

    // Contour milling for non-rectangular panels (<105 \Konturfraesen\)
    if (hasContour) {
        lines.push("<105 \\Konturfraesen\\");
        lines.push("EA=\"1:0\"");
        lines.push("MDA=\"SEN\"");
        lines.push("STUFEN=\"0\"");
        lines.push("BL=\"0\"");
        lines.push("WZS=\"1\"");
        lines.push("OSZI=\"0\"");
        lines.push("OSZVS=\"0\"");
        lines.push("ZSTART=\"0\"");
        lines.push("ANZZST=\"0\"");
        lines.push("RK=\"WRKL\"");
        lines.push("EE=\"1:" + contourElems.length + "\"");
        lines.push("MDE=\"SEN_AB\"");
        lines.push("EM=\"0\"");
        lines.push("RI=\"1\"");
        lines.push("TNO=\"" + MILLING_TOOL_NO + "\"");
        lines.push("SM=\"0\"");
        lines.push("S_=\"STANDARD\"");
        lines.push("F_=\"STANDARD\"");
        lines.push("AB=\"0\"");
        lines.push("AF=\"0\"");
        lines.push("AW=\"0\"");
        lines.push("BW=\"0\"");
        lines.push("VLS=\"0\"");
        lines.push("VLE=\"0\"");
        lines.push("ZA=\"@0\"");
        lines.push("SC=\"0\"");
        lines.push("HP=\"0\"");
        lines.push("SP=\"0\"");
        lines.push("YVE=\"0\"");
        lines.push("KO=\"00\"");
        lines.push("");
    }

    lines.push("!");
    return lines.join("\r\n") + "\r\n";
}

function flipHolesAndGrooves(L, B, vertHoles, grooves) {
    var flippedV = [];
    for (var i = 0; i < vertHoles.length; i++) {
        var h = vertHoles[i];
        flippedV.push({
            x: FLIP_AXIS_FOR_BACK === "Y" ? (L - h.x) : h.x,
            y: FLIP_AXIS_FOR_BACK === "X" ? (B - h.y) : h.y,
            diam: h.diam,
            depth: h.depth,
            through: h.through
        });
    }
    var flippedG = [];
    for (var j = 0; j < grooves.length; j++) {
        var g = grooves[j];
        flippedG.push({
            name: g.name,
            x1: FLIP_AXIS_FOR_BACK === "Y" ? (L - g.x1) : g.x1,
            y1: FLIP_AXIS_FOR_BACK === "X" ? (B - g.y1) : g.y1,
            x2: FLIP_AXIS_FOR_BACK === "Y" ? (L - g.x2) : g.x2,
            y2: FLIP_AXIS_FOR_BACK === "X" ? (B - g.y2) : g.y2,
            width: g.width,
            depth: g.depth
        });
    }
    return { vert: flippedV, grooves: flippedG };
}

function main() {
    var panels = [];
    for (var i = 0; i < Model.Count; i++) {
        collectPanels(Model.Objects[i], panels);
    }

    if (panels.length === 0) {
        alert("No visible CNC panels found in the current model.");
        Action.Finish();
        return;
    }

    // Ask user for a target directory by picking any filename inside that folder
    var samplePath = system.askFileNameSave("mpr");
    if (!samplePath) {
        Action.Finish();
        return;
    }

    var path = require("path");
    var outDir = path.dirname(samplePath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    var exportedFiles = 0;
    var totalVert = 0;
    var totalHoriz = 0;
    var totalGrooves = 0;

    for (var pIdx = 0; pIdx < panels.length; pIdx++) {
        var panel = panels[pIdx];
        var contour = safeGet(function () { return panel.Contour; }, null);
        if (!contour) continue;

        var cMin = safeGet(function () { return contour.Min; }, { x: 0, y: 0 });
        var cMax = safeGet(function () { return contour.Max; }, { x: 0, y: 0 });
        var L = Math.abs(cMax.x - cMin.x);
        var B = Math.abs(cMax.y - cMin.y);
        var T = Number(safeGet(function () { return panel.Thickness; }, 16));
        if (L <= 1 || B <= 1 || T <= 0) continue;

        var holes = extractPanelHoles(panel, cMin, L, B, T);
        var grooves = extractPanelGrooves(panel, cMin);

        // Extract outer contour elements if panel is non-rectangular
        var contourElems = [];
        var isRect = safeGet(function () { return panel.IsContourRectangle; }, true);
        if (!isRect) {
            var eCount = safeGet(function () { return contour.Count; }, 0);
            for (var ei = 0; ei < eCount; ei++) {
                var el = safeGet(function () { return contour.Objects[ei]; }, null);
                var ep1 = el ? safeGet(function () { return el.Pos1; }, null) : null;
                var ep2 = el ? safeGet(function () { return el.Pos2; }, null) : null;
                if (ep1 && ep2) {
                    contourElems.push({
                        x1: ep1.x - cMin.x,
                        y1: ep1.y - cMin.y,
                        x2: ep2.x - cMin.x,
                        y2: ep2.y - cMin.y
                    });
                }
            }
        }

        var artPos = padPos(safeGet(function () { return panel.ArtPos; }, ""));
        var pName = safeGet(function () { return String(panel.Name || ("Part_" + (pIdx + 1))); }, "Part");
        var baseName = sanitizeFileName((artPos ? (artPos + "_") : ((pIdx + 1) + "_")) + pName);
        var comment = "Pos: " + (artPos || (pIdx + 1)) + " | " + pName + " | " + fmt(L) + "x" + fmt(B) + "x" + fmt(T);

        // Front / Top face program
        var topMpr = buildMprContent(
            { comment: comment + " (Side A)" },
            L, B, T,
            holes.topVert,
            holes.horiz,
            grooves.topGrooves,
            contourElems
        );
        fs.writeFileSync(path.join(outDir, baseName + ".mpr"), topMpr, "utf8");
        exportedFiles++;

        totalVert += holes.topVert.length + holes.botVert.length;
        totalHoriz += holes.horiz.length;
        totalGrooves += grooves.topGrooves.length + grooves.botGrooves.length;

        // Back / Bottom face program (only if back-face drilling or grooves exist)
        if (holes.botVert.length > 0 || grooves.botGrooves.length > 0) {
            var flipped = flipHolesAndGrooves(L, B, holes.botVert, grooves.botGrooves);
            var botMpr = buildMprContent(
                { comment: comment + " (Side B, flipped around " + FLIP_AXIS_FOR_BACK + ")" },
                L, B, T,
                flipped.vert,
                [],
                flipped.grooves,
                []
            );
            fs.writeFileSync(path.join(outDir, baseName + "_B.mpr"), botMpr, "utf8");
            exportedFiles++;
        }
    }

    alert(
        "HOMAG woodWOP (.mpr) export complete!\n" +
        "Folder: " + outDir + "\n" +
        "Files written: " + exportedFiles + " (" + panels.length + " panels)\n" +
        "Operations: " + totalVert + " vertical holes, " + totalHoriz + " edge holes, " + totalGrooves + " grooves"
    );
    Action.Finish();
}

main();
