// Bazis-Mebelshchik 2022+ Script: Order Unit & Part Numbering
//
// Workflow:
//   1. Prompts for <order name>.
//   2. Highlights each top-level inserted unit (block / fragment / assembly)
//      one by one in the 3D scene and prompts for its unit position (<pos ###>).
//   3. Assigns sequential position numbers to all parts (panels) and renames:
//      - Unit: <order name> <pos ###> <position number>
//      - Part: <position number> <part name> <pos ###>, <order name>
//      Also updates ArtPos on every part and unit, and Article.OrderName.

// --- Configuration --------------------------------------------------------
var POS_PREFIX = "pos ";        // Prefix for <pos ###>, e.g. "pos 001"
var POS_PAD_DIGITS = 3;         // Zero-pad width for unit position (3 -> 001)
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
    // If user already typed "pos 001", normalize spacing
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
    // Strip previous "<pos ###>, <order name>" suffix if script is re-run
    s = s.replace(/\s+pos\s+\S+,.*$/i, "").trim();
    // Strip leading "<position number> " if script is re-run
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

    var orderPrompt = "Enter Order Name" + (currentOrder ? " (current: " + currentOrder + ")" : "") + ":";
    var orderName = prompt(orderPrompt);
    if (orderName === null || orderName === undefined) {
        Action.Finish();
        return;
    }
    orderName = String(orderName).trim();
    if (!orderName && currentOrder) {
        orderName = currentOrder;
    }
    if (!orderName) {
        alert("Order Name is required. Operation cancelled.");
        Action.Finish();
        return;
    }

    // Step 1: Highlight each unit in 3D and ask for its unit position
    var assignments = [];
    for (var i = 0; i < units.length; i++) {
        var u = units[i];
        var unitObj = u.obj;
        var origName = "";
        try { origName = String(unitObj.Name || "Unit"); } catch (e) {}

        UnSelectAll();
        try { unitObj.Selected = true; } catch (e) {}

        var suggested = padNumber(i + 1, POS_PAD_DIGITS);
        var msg =
            "Unit " + (i + 1) + " of " + units.length + " (" + origName + ", " + u.panels.length + " parts)\n" +
            "Enter unit position number (default: " + suggested + ", type 'skip' to skip, Cancel to abort):";
        var input = prompt(msg);
        if (input === null || input === undefined) {
            UnSelectAll();
            Action.Finish();
            return;
        }
        var trimmed = String(input).trim();
        if (trimmed.toLowerCase() === "skip") {
            continue;
        }
        var posTag = formatPosTag(trimmed || suggested);
        assignments.push({
            obj: unitObj,
            panels: u.panels,
            posTag: posTag,
            unitIndex: assignments.length + 1
        });
    }

    if (assignments.length === 0) {
        UnSelectAll();
        alert("No units selected for numbering.");
        Action.Finish();
        return;
    }

    // Step 2: Apply Order Name, Unit Names, Part Names, and Sequential Position Numbers
    try { Article.OrderName = orderName; } catch (e) {}

    var partPos = 1;
    var totalParts = 0;

    for (var a = 0; a < assignments.length; a++) {
        var item = assignments[a];
        if (!GLOBAL_PART_SEQUENCE) {
            partPos = 1;
        }

        try { Undo.RecursiveChanging(item.obj); } catch (e) {
            try { Undo.Changing(item.obj); } catch (e2) {}
        }

        var unitPositionNumber = item.unitIndex;
        // Unit name format: <order name> <pos ###> <position number>
        item.obj.Name = orderName + " " + item.posTag + " " + unitPositionNumber;
        try { item.obj.ArtPos = String(unitPositionNumber); } catch (e) {}

        for (var pIdx = 0; pIdx < item.panels.length; pIdx++) {
            var panel = item.panels[pIdx];
            var baseName = cleanBasePartName(panel.Name);
            // Part name format: <position number> <part name> <pos ###>, <order name>
            panel.Name = partPos + " " + baseName + " " + item.posTag + ", " + orderName;
            try { panel.ArtPos = String(partPos); } catch (e) {}
            partPos++;
            totalParts++;
        }
    }

    UnSelectAll();
    Action.Commit();

    alert(
        "Done!\n" +
        "Order: " + orderName + "\n" +
        "Units numbered: " + assignments.length + "\n" +
        "Parts numbered: " + totalParts
    );
    Action.Finish();
}

main();
