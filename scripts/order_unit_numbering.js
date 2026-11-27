// Bazis-Mebelshchik 2022+ Script: Order Unit & Part Numbering
//
// Interactive workflow in Bazis Properties panel (free 3D orbit/zoom while reviewing):
//   1. Highlights each top-level unit (block / fragment / assembly with panels) one by one.
//   2. Click "Approve" to assign the shown Unit Position (default +10 step) and move to next unit.
//   3. Click "Skip" to leave the current unit untouched and move to next unit.
//   4. Click "Approve All Remaining" to auto-number the rest, or "Cancel" to abort.
//   5. Renames every approved unit & its parts:
//      - Unit: <order name> <pos ###> <position number>
//      - Part: <position number> <part name> <pos ###>, <order name>
//      Also updates ArtPos on every part and unit, and Article.OrderName.

// --- Configuration --------------------------------------------------------
var POS_PREFIX = "pos ";         // Prefix for <pos ###>, e.g. "pos 010"
var POS_PAD_DIGITS = 3;          // Zero-pad width for unit position (3 -> 010)
var POS_START = 10;              // Default position number for the first unit
var POS_STEP = 10;               // Increment for each next suggested unit position (+10)
var GLOBAL_PART_SEQUENCE = true; // true = 1..N across entire order; false = restart at 1 per unit
// --------------------------------------------------------------------------

function padNumber(num, width) {
    var s = String(num);
    while (s.length < width) s = "0" + s;
    return s;
}

function formatPosTag(rawInput) {
    var trimmed = String(rawInput || "").trim();
    if (!trimmed) return "";
    if (/^pos\s+/i.test(trimmed)) {
        var rest = trimmed.replace(/^pos\s+/i, "").trim();
        if (/^\d+$/.test(rest)) return POS_PREFIX + padNumber(parseInt(rest, 10), POS_PAD_DIGITS);
        return POS_PREFIX + rest;
    }
    if (/^\d+$/.test(trimmed)) {
        return POS_PREFIX + padNumber(parseInt(trimmed, 10), POS_PAD_DIGITS);
    }
    return POS_PREFIX + trimmed;
}

function collectPanels(obj, out) {
    if (!obj) return;
    try {
        var p = obj.AsPanel;
        if (p) {
            out.push(p);
            return;
        }
    } catch (e) {}
    try {
        if (obj.List) {
            var list = obj.AsList();
            if (list) {
                for (var i = 0; i < list.Count; i++) {
                    collectPanels(list.Objects[i], out);
                }
            }
        }
    } catch (e) {}
}

function cleanBasePartName(rawName) {
    var s = String(rawName || "Panel").trim();
    s = s.replace(/\s+pos\s+\S+,.*$/i, "").trim();
    s = s.replace(/^\d+\s+/, "").trim();
    return s || "Panel";
}

function collectTopLevelUnits() {
    var units = [];
    for (var i = 0; i < Model.Count; i++) {
        var obj = Model.Objects[i];
        if (!obj) continue;
        var isList = false;
        try { isList = !!obj.List; } catch (e) {}
        if (!isList) continue;
        var panels = [];
        collectPanels(obj, panels);
        if (panels.length > 0) {
            units.push({ obj: obj, panels: panels });
        }
    }
    return units;
}

function main() {
    var units = collectTopLevelUnits();
    if (units.length === 0) {
        alert("No library units (blocks / fragments with panels) found in the current model.");
        Action.Finish();
        return;
    }

    var currentOrder = "";
    try { currentOrder = String(Article.OrderName || "").trim(); } catch (e) {}
    if (!currentOrder) {
        try { currentOrder = String(Article.Name || "").trim(); } catch (e) {}
    }

    var state = {
        index: 0,
        nextPosNum: POS_START,
        assignments: [],
        skippedCount: 0,
        finished: false
    };

    // Build interactive Bazis Properties panel (user can orbit/zoom 3D while approving/skipping)
    var orderProp = Action.Properties.NewString("Order Name", currentOrder);
    var unitProp = Action.Properties.NewString("Current Unit", "");
    unitProp.Enabled = false;
    var posProp = Action.Properties.NewString("Unit Position", padNumber(POS_START, POS_PAD_DIGITS));
    var seqProp = Action.Properties.NewBool("Sequential Part Pos (1..N)", true);
    var progressProp = Action.Properties.NewString("Progress", "");
    progressProp.Enabled = false;

    var approveBtn = Action.Properties.NewButton("Approve");
    var skipBtn = Action.Properties.NewButton("Skip");
    var approveAllBtn = Action.Properties.NewButton("Approve All Remaining");
    var cancelBtn = Action.Properties.NewButton("Cancel");

    function highlightCurrentUnit() {
        UnSelectAll();
        if (state.index >= units.length) return;
        var u = units[state.index];
        var origName = "";
        try { origName = String(u.obj.Name || "Unit"); } catch (e) {}
        try { u.obj.Selected = true; } catch (e) {}
        unitProp.Value = (state.index + 1) + "/" + units.length + ": " + origName + " (" + u.panels.length + " parts)";
        posProp.Value = padNumber(state.nextPosNum, POS_PAD_DIGITS);
        progressProp.Value =
            "Approved: " + state.assignments.length +
            " | Skipped: " + state.skippedCount +
            " | Left: " + (units.length - state.index);
        Action.Hint = "Review highlighted unit " + (state.index + 1) + "/" + units.length + " -> click Approve or Skip";
    }

    function applyAndFinish() {
        if (state.finished) return;
        state.finished = true;
        UnSelectAll();

        var orderName = String(orderProp.Value || "").trim();
        if (!orderName) {
            state.finished = false;
            alert("Order Name is required.");
            return;
        }

        if (state.assignments.length === 0) {
            alert("No units approved for numbering (skipped: " + state.skippedCount + ").");
            Action.Finish();
            return;
        }

        var numberPartsSequentially = !!seqProp.Value;
        try { Article.OrderName = orderName; } catch (e) {}

        var partPos = 1;
        var totalParts = 0;

        for (var a = 0; a < state.assignments.length; a++) {
            var item = state.assignments[a];
            if (!GLOBAL_PART_SEQUENCE) {
                partPos = 1;
            }

            try { Undo.RecursiveChanging(item.obj); } catch (e) {
                try { Undo.Changing(item.obj); } catch (e2) {}
            }

            var unitPositionNumber = item.unitIndex;
            item.obj.Name = orderName + " " + item.posTag + " " + unitPositionNumber;
            try { item.obj.ArtPos = String(unitPositionNumber); } catch (e) {}

            for (var pIdx = 0; pIdx < item.panels.length; pIdx++) {
                var panel = item.panels[pIdx];
                var baseName = cleanBasePartName(panel.Name);
                if (numberPartsSequentially) {
                    panel.Name = partPos + " " + baseName + " " + item.posTag + ", " + orderName;
                    try { panel.ArtPos = String(partPos); } catch (e) {}
                    partPos++;
                } else {
                    var existingPos = "";
                    try { existingPos = String(panel.ArtPos || "").trim(); } catch (e) {}
                    panel.Name = (existingPos ? (existingPos + " ") : "") + baseName + " " + item.posTag + ", " + orderName;
                }
                totalParts++;
            }
        }

        UnSelectAll();
        Action.Commit();

        alert(
            "Done!\n" +
            "Order: " + orderName + "\n" +
            "Units approved: " + state.assignments.length + " (skipped: " + state.skippedCount + ")\n" +
            "Parts updated: " + totalParts + "\n" +
            "Sequential part positions (CNC/cutting): " + (numberPartsSequentially ? "Yes (1.." + (partPos - 1) + ")" : "No (kept existing)")
        );
        Action.Finish();
    }

    function approveCurrent() {
        if (state.finished || state.index >= units.length) return;
        var orderName = String(orderProp.Value || "").trim();
        if (!orderName) {
            alert("Please enter Order Name first.");
            return;
        }
        var u = units[state.index];
        var rawPos = String(posProp.Value || "").trim() || padNumber(state.nextPosNum, POS_PAD_DIGITS);
        var posTag = formatPosTag(rawPos);

        var numMatch = rawPos.match(/(\d+)/);
        if (numMatch) {
            state.nextPosNum = parseInt(numMatch[1], 10) + POS_STEP;
        } else {
            state.nextPosNum += POS_STEP;
        }

        state.assignments.push({
            obj: u.obj,
            panels: u.panels,
            posTag: posTag,
            unitIndex: state.assignments.length + 1
        });
        state.index++;

        if (state.index >= units.length) {
            applyAndFinish();
        } else {
            highlightCurrentUnit();
        }
    }

    approveBtn.OnClick = function () {
        approveCurrent();
    };

    skipBtn.OnClick = function () {
        if (state.finished || state.index >= units.length) return;
        state.skippedCount++;
        state.index++;
        if (state.index >= units.length) {
            applyAndFinish();
        } else {
            highlightCurrentUnit();
        }
    };

    approveAllBtn.OnClick = function () {
        if (state.finished) return;
        var orderName = String(orderProp.Value || "").trim();
        if (!orderName) {
            alert("Please enter Order Name first.");
            return;
        }
        while (state.index < units.length) {
            var u = units[state.index];
            var rawPos = (state.index === 0 || state.assignments.length === 0)
                ? (String(posProp.Value || "").trim() || padNumber(state.nextPosNum, POS_PAD_DIGITS))
                : padNumber(state.nextPosNum, POS_PAD_DIGITS);
            var posTag = formatPosTag(rawPos);
            var numMatch = rawPos.match(/(\d+)/);
            if (numMatch) {
                state.nextPosNum = parseInt(numMatch[1], 10) + POS_STEP;
            } else {
                state.nextPosNum += POS_STEP;
            }
            state.assignments.push({
                obj: u.obj,
                panels: u.panels,
                posTag: posTag,
                unitIndex: state.assignments.length + 1
            });
            state.index++;
        }
        applyAndFinish();
    };

    cancelBtn.OnClick = function () {
        if (state.finished) return;
        state.finished = true;
        UnSelectAll();
        Action.Cancel();
    };

    highlightCurrentUnit();
    Action.Continue();
}

main();
