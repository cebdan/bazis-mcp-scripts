// Bazis-Mebelshchik 2022+ Script: Export Cutting List to OptiCut 5.xx (.csv)
//
// Exports all panels in the active model to an OptiCut 5.xx compatible
// semicolon-delimited CSV file with grain orientation, 4-side edge banding
// (Top/Bottom/Left/Right), CNC position number (ArtPos), unit name, and order.
//
// In OptiCut 5.xx:
//   File -> Import -> Panels Cutting List -> Import Options:
//     Separator: Semicolon (;)
//     Columns:   Reference; Material; Height; Width; Thickness; Quantity; Grain;
//                Edging_Top; Edging_Bottom; Edging_Left; Edging_Right;
//                Pos; Unit; Order

// --- Configuration --------------------------------------------------------
var SEPARATOR = ";";            // ";" (OptiCut default), "\t" (Tab), or ","
var INCLUDE_HEADER = true;      // Include column header line
var GROUP_IDENTICAL = false;    // false = 1 row per CNC part (Qty=1); true = merge identical parts
var DECIMAL_PLACES = 1;         // Rounding precision in mm
var USE_CUT_SIZE = true;        // true = net cut size (ContourWidth/Height); false = finished size (GSize)
// --------------------------------------------------------------------------

function safeGet(fn, fallback) {
    try {
        var v = fn();
        return v === undefined || v === null ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function cleanMaterialName(raw) {
    var s = String(raw || "").trim();
    if (!s) return "Unknown";
    if (typeof ExtractMatName === "function") {
        try {
            var extracted = ExtractMatName(s);
            if (extracted) s = String(extracted).trim();
        } catch (e) {}
    }
    var cr = s.indexOf("\r");
    if (cr !== -1) s = s.slice(0, cr).trim();
    var nl = s.indexOf("\n");
    if (nl !== -1) s = s.slice(0, nl).trim();
    return s || "Unknown";
}

function csvCell(val) {
    var s = String(val === undefined || val === null ? "" : val);
    s = s.replace(/\r?\n/g, " ");
    if (s.indexOf(SEPARATOR) !== -1 || s.indexOf("\"") !== -1) {
        return "\"" + s.replace(/"/g, "\"\"") + "\"";
    }
    return s;
}

function fmtNum(n) {
    var num = Number(n || 0);
    if (!isFinite(num)) return "0";
    var factor = Math.pow(10, DECIMAL_PLACES);
    var rounded = Math.round(num * factor) / factor;
    return String(rounded);
}

// Map each butt on panel.Butts to Top / Bottom / Left / Right based on the
// midpoint of its contour edge in the panel's local 2D contour coordinates.
function extractFourSideEdging(panel, swapAxes) {
    var edges = { top: "", bottom: "", left: "", right: "" };
    var butts = safeGet(function () { return panel.Butts; }, null);
    var contour = safeGet(function () { return panel.Contour; }, null);
    if (!butts || !contour) return edges;

    var bCount = safeGet(function () { return butts.Count; }, 0);
    if (bCount <= 0) return edges;

    var cMin = safeGet(function () { return contour.Min; }, { x: 0, y: 0 });
    var cMax = safeGet(function () { return contour.Max; }, { x: 0, y: 0 });
    var cx = (cMin.x + cMax.x) / 2;
    var cy = (cMin.y + cMax.y) / 2;
    var spanX = Math.max(1, cMax.x - cMin.x);
    var spanY = Math.max(1, cMax.y - cMin.y);

    for (var i = 0; i < bCount; i++) {
        var butt = safeGet(function () { return butts[i]; }, null);
        if (!butt) continue;
        var mat = cleanMaterialName(safeGet(function () { return butt.Material; }, ""));
        var thick = safeGet(function () { return butt.Thickness; }, 0);
        var label = mat + (thick > 0 ? (" (" + fmtNum(thick) + "mm)") : "");

        var elemIdx = safeGet(function () { return butt.ElemIndex; }, -1);
        var elem = elemIdx >= 0 ? safeGet(function () { return contour.Objects[elemIdx]; }, null) : null;
        if (!elem) continue;

        var p1 = safeGet(function () { return elem.Pos1; }, null);
        var p2 = safeGet(function () { return elem.Pos2; }, null);
        if (!p1 || !p2) continue;

        var mx = (p1.x + p2.x) / 2;
        var my = (p1.y + p2.y) / 2;
        var nx = (mx - cx) / (spanX / 2);
        var ny = (my - cy) / (spanY / 2);

        var side;
        if (Math.abs(ny) >= Math.abs(nx)) {
            side = ny >= 0 ? "top" : "bottom";
        } else {
            side = nx >= 0 ? "right" : "left";
        }

        if (swapAxes) {
            if (side === "top") side = "right";
            else if (side === "bottom") side = "left";
            else if (side === "left") side = "top";
            else if (side === "right") side = "bottom";
        }

        if (!edges[side]) edges[side] = label;
    }

    return edges;
}

function collectPanels(obj, topUnitName, out) {
    if (!obj) return;
    var visible = safeGet(function () { return obj.Visible; }, true);
    if (!visible) return;

    var panel = safeGet(function () { return obj.AsPanel; }, null);
    if (panel) {
        out.push({ panel: panel, unitName: topUnitName });
        return;
    }

    if (safeGet(function () { return obj.List; }, false)) {
        var list = safeGet(function () { return obj.AsList(); }, null);
        if (list) {
            var count = safeGet(function () { return list.Count; }, 0);
            for (var i = 0; i < count; i++) {
                collectPanels(safeGet(function () { return list.Objects[i]; }, null), topUnitName, out);
            }
        }
    }
}

function main() {
    var collected = [];
    for (var i = 0; i < Model.Count; i++) {
        var rootObj = Model.Objects[i];
        if (!rootObj) continue;
        var unitName = safeGet(function () { return String(rootObj.Name || ""); }, "");
        collectPanels(rootObj, unitName, collected);
    }

    if (collected.length === 0) {
        alert("No visible panels found in the current model to export.");
        Action.Finish();
        return;
    }

    var outPath = system.askFileNameSave("csv");
    if (!outPath) {
        Action.Finish();
        return;
    }
    if (!/\.csv$/i.test(outPath) && !/\.txt$/i.test(outPath)) {
        outPath += ".csv";
    }

    var orderName = safeGet(function () { return String(Article.OrderName || Article.Name || ""); }, "");
    var rawRows = [];

    for (var k = 0; k < collected.length; k++) {
        var panel = collected[k].panel;
        var unitName = collected[k].unitName;

        var matName = cleanMaterialName(safeGet(function () { return panel.MaterialName; }, ""));
        var thickness = safeGet(function () { return panel.Thickness; }, 0);
        var partName = safeGet(function () { return String(panel.Name || "Panel"); }, "Panel");
        var artPos = safeGet(function () { return String(panel.ArtPos || ""); }, "");
        var texOrient = safeGet(function () { return Number(panel.TextureOrientation || 0); }, 0);

        var cw = safeGet(function () { return panel.ContourWidth; }, 0);
        var ch = safeGet(function () { return panel.ContourHeight; }, 0);
        if (!USE_CUT_SIZE || cw <= 0 || ch <= 0) {
            var gs = safeGet(function () { return panel.GSize; }, null);
            if (gs) {
                var dims = [gs.x, gs.y, gs.z].sort(function (a, b) { return b - a; });
                cw = dims[0];
                ch = dims[1];
            }
        }

        // In OptiCut, Height is along the grain and Width is across the grain.
        // Bazis TextureOrientation: 0 = None, 1 = Horizontal (along X/Width), 2 = Vertical (along Y/Height)
        var grain = texOrient === 0 ? 0 : 1;
        var swapAxes = (texOrient === 2);
        var optiHeight = swapAxes ? ch : cw;
        var optiWidth = swapAxes ? cw : ch;
        if (grain === 0 && optiWidth > optiHeight) {
            var tmp = optiHeight;
            optiHeight = optiWidth;
            optiWidth = tmp;
            swapAxes = !swapAxes;
        }

        var edging = extractFourSideEdging(panel, swapAxes);

        rawRows.push({
            reference: partName,
            material: matName + (thickness > 0 ? (" " + fmtNum(thickness) + "mm") : ""),
            height: fmtNum(optiHeight),
            width: fmtNum(optiWidth),
            thickness: fmtNum(thickness),
            quantity: 1,
            grain: grain,
            edgeTop: edging.top,
            edgeBottom: edging.bottom,
            edgeLeft: edging.left,
            edgeRight: edging.right,
            pos: artPos,
            unit: unitName,
            order: orderName
        });
    }

    var finalRows = rawRows;
    if (GROUP_IDENTICAL) {
        var map = {};
        finalRows = [];
        for (var r = 0; r < rawRows.length; r++) {
            var row = rawRows[r];
            var key = [
                row.material, row.reference, row.height, row.width, row.thickness,
                row.grain, row.edgeTop, row.edgeBottom, row.edgeLeft, row.edgeRight
            ].join("|");
            if (map[key]) {
                map[key].quantity += 1;
            } else {
                map[key] = row;
                finalRows.push(row);
            }
        }
    }

    var lines = [];
    if (INCLUDE_HEADER) {
        lines.push([
            "Reference", "Material", "Height", "Width", "Thickness", "Quantity", "Grain",
            "Edging_Top", "Edging_Bottom", "Edging_Left", "Edging_Right",
            "Pos", "Unit", "Order"
        ].join(SEPARATOR));
    }

    for (var f = 0; f < finalRows.length; f++) {
        var it = finalRows[f];
        lines.push([
            csvCell(it.reference),
            csvCell(it.material),
            csvCell(it.height),
            csvCell(it.width),
            csvCell(it.thickness),
            csvCell(it.quantity),
            csvCell(it.grain),
            csvCell(it.edgeTop),
            csvCell(it.edgeBottom),
            csvCell(it.edgeLeft),
            csvCell(it.edgeRight),
            csvCell(it.pos),
            csvCell(it.unit),
            csvCell(it.order)
        ].join(SEPARATOR));
    }

    var content = "\uFEFF" + lines.join("\r\n") + "\r\n";
    if (typeof fs !== "undefined" && fs.writeFileSync) {
        fs.writeFileSync(outPath, content, "utf8");
    } else {
        system.writeTextFile(outPath, content);
    }

    alert(
        "OptiCut 5.xx export complete!\n" +
        "File: " + outPath + "\n" +
        "Rows exported: " + finalRows.length + " (total panels: " + collected.length + ")\n" +
        "Separator: " + (SEPARATOR === "\t" ? "TAB" : SEPARATOR)
    );
    Action.Finish();
}

main();
