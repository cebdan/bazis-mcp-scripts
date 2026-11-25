// B&S_Shelf_Driver.js — Parametric Shelf Driver Block for Bazis-Mebelshchik 2022
// Works like Drawer Maker (Master Box):
//   1. Pick 4 bounding panels (Left, Right, Bottom, Top) — auto-detects clear niche & recessed back panel
//      OR press ESC on first prompt to place by 2 corner points (line/niche mode)
//      OR pre-select an existing "B&S_ShelfDriver" block to edit its parameters in place!
//   2. Live 3D preview via Action.Properties (Count, Distribution, Step, Side Gap, Front/Back Setback,
//      Thickness, Edge Banding, Mount Type: Shelfholders / Fixed Dowels+Screws / None).
//   3. Follows B&S production standards: 18mm board, ABS White 19x1 (1mm, clipPanel=true) on all 4 sides,
//      2mm side gap per side, B&S_Shelfholder_D5_3holes_50mm.f3d at 40mm from front/back edges.

var fs = require("fs");
var path = require("path");

var DEFAULTS = {
    count: 2,
    distMode: 0,        // 0 = Equal Compartments, 1 = Fixed Step From Bottom, 2 = Fixed Step From Top
    stepMm: 300,
    thickness: 18,
    material: "LDSP White 18mm",
    edgeMat: "ABS White 19x1",
    edgeT: 1,
    edgeW: 19,
    allEdges: true,
    sideGap: 2,
    frontSetback: 10,
    backSetback: 5,
    mountMode: 0,       // 0 = Shelfholders (D5 3-hole), 1 = Fixed (Dowels + Screws), 2 = None
    holderInset: 40,
    fallbackDepth: 310
};

// --- Portable Library Discovery ---
var LIB_ROOTS = [
    "Y:\\Works\\bazis",
    "C:\\Users\\danch\\Documents\\Bazis"
];
try {
    var parentDir = path.resolve(__dirname, "..");
    if (LIB_ROOTS.indexOf(parentDir) < 0) LIB_ROOTS.unshift(parentDir);
} catch (e) {}

function findLibraryFile(subDirs, fileName) {
    for (var r = 0; r < LIB_ROOTS.length; r++) {
        for (var s = 0; s < subDirs.length; s++) {
            var p = path.join(LIB_ROOTS[r], subDirs[s], fileName);
            try {
                if (fs.existsSync(p)) return p;
            } catch (e) {}
        }
    }
    return null;
}

var FURN_PATHS = {
    shelfholder: findLibraryFile(["Accessories\\Shelfholders", "Fasteners", "Accessories", ""], "B&S_Shelfholder_D5_3holes_50mm.f3d"),
    dowel: findLibraryFile(["Accessories\\Pins", "Fasteners", "Accessories", ""], "Pin_8\u044530.f3d") ||
           findLibraryFile(["Accessories\\Pins", "Fasteners", "Accessories", ""], "Pin_8x30.f3d"),
    screw: findLibraryFile(["Accessories\\Screws", "Fasteners", "Accessories", ""], "B&S_Screw_4x45.f3d")
};

var FURN_CACHE = {};
function getFurniture(key) {
    if (FURN_CACHE.hasOwnProperty(key)) return FURN_CACHE[key];
    var p = FURN_PATHS[key];
    if (!p) {
        FURN_CACHE[key] = null;
        return null;
    }
    try {
        FURN_CACHE[key] = OpenFurniture(p);
    } catch (e) {
        FURN_CACHE[key] = null;
    }
    return FURN_CACHE[key];
}

// --- Geometry Helpers ---
function getGlobalBox(obj) {
    // Use true 8-corner ToGlobal() transform for panels (works reliably even inside nested fragments!)
    if (obj && obj.Contour && obj.ToGlobal) {
        var cMin = obj.Contour.Min;
        var cMax = obj.Contour.Max;
        var t = obj.Thickness || 0;
        var xs = [cMin.x, cMax.x], ys = [cMin.y, cMax.y], zs = [0, t];
        var minX = 1e12, maxX = -1e12, minY = 1e12, maxY = -1e12, minZ = 1e12, maxZ = -1e12;
        for (var ix = 0; ix < 2; ix++) {
            for (var iy = 0; iy < 2; iy++) {
                for (var iz = 0; iz < 2; iz++) {
                    var g = obj.ToGlobal(NewVector(xs[ix], ys[iy], zs[iz]));
                    if (g.x < minX) minX = g.x;
                    if (g.x > maxX) maxX = g.x;
                    if (g.y < minY) minY = g.y;
                    if (g.y > maxY) maxY = g.y;
                    if (g.z < minZ) minZ = g.z;
                    if (g.z > maxZ) maxZ = g.z;
                }
            }
        }
        return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, minZ: minZ, maxZ: maxZ };
    }
    return {
        minX: obj.GMin.x, maxX: obj.GMax.x,
        minY: obj.GMin.y, maxY: obj.GMax.y,
        minZ: obj.GMin.z, maxZ: obj.GMax.z
    };
}

function findObjectByUid(uid, container) {
    if (!uid) return null;
    var root = container || Model;
    for (var i = 0; i < root.Count; i++) {
        var o = root.Objects[i];
        if (!o) continue;
        if (o.UID === uid) return o;
        if (o.Count > 0) {
            var found = findObjectByUid(uid, o);
            if (found) return found;
        }
    }
    return null;
}

// Detect any recessed vertical back panel inside the niche (so shelves stop cleanly before it)
function detectBackPanelFrontZ(x1, x2, y1, y2, zMin, zMax, excludeUids) {
    var bestZ = zMin;
    function walk(container) {
        for (var i = 0; i < container.Count; i++) {
            var o = container.Objects[i];
            if (!o || o.Visible === false) continue;
            if (o.AsPanel) {
                var p = o.AsPanel;
                if (excludeUids.indexOf(p.UID) >= 0) continue;
                var b = getGlobalBox(p);
                var dx = b.maxX - b.minX;
                var dy = b.maxY - b.minY;
                var dz = b.maxZ - b.minZ;
                // Candidate back panel: thin along Z, overlaps niche X and Y, sits in rear half of niche
                if (dz <= 30 && dx > (x2 - x1) * 0.6 && dy > (y2 - y1) * 0.6) {
                    var overlapsX = (b.maxX > x1 + 5 && b.minX < x2 - 5);
                    var overlapsY = (b.maxY > y1 + 5 && b.minY < y2 - 5);
                    var inRear = (b.maxZ > zMin - 2 && b.maxZ < zMin + (zMax - zMin) * 0.4);
                    if (overlapsX && overlapsY && inRear && b.maxZ > bestZ) {
                        bestZ = b.maxZ;
                    }
                }
            } else if (o.Count > 0) {
                walk(o);
            }
        }
    }
    walk(Model);
    return bestZ;
}

function addAllEdges(panel, matName, edgeT, edgeW) {
    if (!panel || !panel.Butts) return;
    var cnt = 0;
    try { cnt = panel.Contour.Count; } catch (e) { cnt = 0; }
    for (var i = 0; i < cnt; i++) {
        try {
            var b = panel.Butts.Add();
            b.ElemIndex = i;
            b.Material = matName;
            b.Thickness = edgeT;
            b.Width = edgeW;
            b.Sign = String(edgeT);
            b.ClipPanel = true;
        } catch (e) {}
    }
    panel.Build();
}

function mountFastenerAt(key, buttPanel, facePanel, x, y, z) {
    var furn = getFurniture(key);
    if (!furn || !buttPanel || !facePanel) return;
    try {
        furn.Mount(buttPanel, facePanel, x, y, z);
    } catch (e) {}
}

// --- Check if an existing B&S_ShelfDriver block is selected for re-editing ---
var editingBlock = null;
var savedState = null;
try {
    if (Model.SelectionCount === 1) {
        var sel = Model.Selections[0];
        if (sel && sel.UserProperty && sel.UserProperty["BS_ShelfDriver"]) {
            var raw = String(sel.UserProperty["BS_ShelfDriver"]);
            if (raw && raw.charAt(0) === "{") {
                savedState = JSON.parse(raw);
                editingBlock = sel;
            }
        }
    }
} catch (e) {
    editingBlock = null;
    savedState = null;
}

// --- Acquire Niche (from existing block, 4 panels, or 2 points) ---
var niche = null;
var leftPanel = null;
var rightPanel = null;
var leftUid = 0;
var rightUid = 0;
var bottomUid = 0;
var topUid = 0;

if (savedState && savedState.niche) {
    niche = savedState.niche;
    leftUid = savedState.leftUid || 0;
    rightUid = savedState.rightUid || 0;
    bottomUid = savedState.bottomUid || 0;
    topUid = savedState.topUid || 0;
    var lpObj = findObjectByUid(leftUid);
    var rpObj = findObjectByUid(rightUid);
    leftPanel = lpObj && lpObj.AsPanel ? lpObj.AsPanel : null;
    rightPanel = rpObj && rpObj.AsPanel ? rpObj.AsPanel : null;
} else {
    var pLeft = null;
    try {
        pLeft = GetPanel("Select LEFT side panel (or press ESC for 2-point line mode)");
    } catch (e) {
        pLeft = null;
    }

    if (pLeft) {
        var pRight = GetPanel("Select RIGHT side panel");
        if (!pRight) Action.Cancel();
        var pBot = GetPanel("Select BOTTOM panel");
        if (!pBot) Action.Cancel();
        var pTop = GetPanel("Select TOP panel");
        if (!pTop) Action.Cancel();

        var bL = getGlobalBox(pLeft);
        var bR = getGlobalBox(pRight);
        var bB = getGlobalBox(pBot);
        var bT = getGlobalBox(pTop);

        // Normalize Left/Right and Bottom/Top regardless of click order
        if (bL.minX > bR.minX) {
            var tmpP = pLeft; pLeft = pRight; pRight = tmpP;
            var tmpB = bL; bL = bR; bR = tmpB;
        }
        if (bB.minY > bT.minY) {
            var tmpPB = pBot; pBot = pTop; pTop = tmpPB;
            var tmpBB = bB; bB = bT; bT = tmpBB;
        }

        leftPanel = pLeft;
        rightPanel = pRight;
        leftUid = pLeft.UID;
        rightUid = pRight.UID;
        bottomUid = pBot.UID;
        topUid = pTop.UID;

        var x1 = bL.maxX;
        var x2 = bR.minX;
        var y1 = bB.maxY;
        var y2 = bT.minY;
        var zMin = Math.max(bL.minZ, bR.minZ);
        var zMax = Math.min(bL.maxZ, bR.maxZ);
        var backZ = detectBackPanelFrontZ(x1, x2, y1, y2, zMin, zMax, [leftUid, rightUid, bottomUid, topUid]);

        if (x2 - x1 < 40 || y2 - y1 < 40 || zMax - backZ < 40) {
            alert("Invalid niche dimensions (" + Math.round(x2 - x1) + " x " + Math.round(y2 - y1) + " x " + Math.round(zMax - backZ) + " mm).");
            Action.Cancel();
        }

        niche = {
            mode: "panels",
            x1: x1, x2: x2,
            y1: y1, y2: y2,
            zBack: backZ,
            zFront: zMax
        };
    } else {
        // 2-Point Line / Niche Mode
        var pt1 = GetPoint("Pick FIRST corner point of shelf niche (bottom-left)");
        if (!pt1) Action.Cancel();
        var pt2 = GetPoint("Pick SECOND corner point of shelf niche (top-right)");
        if (!pt2) Action.Cancel();

        var px1 = Math.min(pt1.x, pt2.x);
        var px2 = Math.max(pt1.x, pt2.x);
        var py1 = Math.min(pt1.y, pt2.y);
        var py2 = Math.max(pt1.y, pt2.y);
        var pzFront = Math.max(pt1.z, pt2.z);
        var pzSpan = Math.abs(pt2.z - pt1.z);
        var depth = pzSpan > 50 ? pzSpan : DEFAULTS.fallbackDepth;

        if (px2 - px1 < 40 || py2 - py1 < 40) {
            alert("Niche width and height must be at least 40 mm.");
            Action.Cancel();
        }

        niche = {
            mode: "points",
            x1: px1, x2: px2,
            y1: py1, y2: py2,
            zBack: pzFront - depth,
            zFront: pzFront
        };
    }
}

// --- Interactive Action.Properties UI ---
var props = Action.Properties;
var init = savedState || DEFAULTS;

var pCount = props.NewNumber("Shelf Count", init.count !== undefined ? init.count : DEFAULTS.count);
var pDist = props.NewCombo("Distribution", "Equal Compartments\nFixed Step From Bottom\nFixed Step From Top");
pDist.ItemIndex = init.distMode !== undefined ? init.distMode : DEFAULTS.distMode;

var pStep = props.NewNumber("Fixed Step (mm)", init.stepMm !== undefined ? init.stepMm : DEFAULTS.stepMm);
var pThick = props.NewNumber("Thickness (mm)", init.thickness !== undefined ? init.thickness : DEFAULTS.thickness);
var pSideGap = props.NewNumber("Side Gap per Side (mm)", init.sideGap !== undefined ? init.sideGap : DEFAULTS.sideGap);
var pFrontSet = props.NewNumber("Front Setback (mm)", init.frontSetback !== undefined ? init.frontSetback : DEFAULTS.frontSetback);
var pBackSet = props.NewNumber("Back Setback (mm)", init.backSetback !== undefined ? init.backSetback : DEFAULTS.backSetback);
var pDepth = props.NewNumber("Niche Depth (mm)", Math.round((niche.zFront - niche.zBack) * 10) / 10);
var pEdges = props.NewBool("Edge Banding (4 sides, 1mm)");
pEdges.Value = init.allEdges !== undefined ? !!init.allEdges : DEFAULTS.allEdges;

var pMount = props.NewCombo("Mount Type", "Shelfholders (D5 3-hole +/-50mm)\nFixed (Dowels 8x30 + Screws 4x45)\nNone (Panels only)");
pMount.ItemIndex = init.mountMode !== undefined ? init.mountMode : DEFAULTS.mountMode;
var pInset = props.NewNumber("Holder/Fastener Inset (mm)", init.holderInset !== undefined ? init.holderInset : DEFAULTS.holderInset);

var btnOk = props.NewButton("Apply / Finish");
var btnCancel = props.NewButton("Cancel");

// --- Build / Live Preview Function ---
function buildShelves() {
    DeleteNewObjects();

    var count = Math.max(1, Math.min(20, Math.round(Number(pCount.Value) || 1)));
    var distMode = pDist.ItemIndex;
    var stepMm = Math.max(40, Number(pStep.Value) || 300);
    var thick = Math.max(4, Number(pThick.Value) || 18);
    var sideGap = Math.max(0, Number(pSideGap.Value) || 0);
    var frontSet = Math.max(0, Number(pFrontSet.Value) || 0);
    var backSet = Math.max(0, Number(pBackSet.Value) || 0);
    var nicheDepth = Math.max(50, Number(pDepth.Value) || (niche.zFront - niche.zBack));
    var allEdges = !!pEdges.Value;
    var mountMode = pMount.ItemIndex;
    var inset = Math.max(15, Number(pInset.Value) || 40);

    var zFront = niche.zFront;
    var zBack = zFront - nicheDepth;
    var shelfX1 = niche.x1 + sideGap;
    var shelfX2 = niche.x2 - sideGap;
    var shelfZ1 = zBack + backSet;
    var shelfZ2 = zFront - frontSet;
    var shelfW = shelfX2 - shelfX1;
    var shelfD = shelfZ2 - shelfZ1;
    var clearH = niche.y2 - niche.y1;

    if (shelfW < 20 || shelfD < 20 || clearH < thick + 10) {
        Action.Hint = "Shelf dimensions too small for current niche/setbacks.";
        return;
    }

    // Compute shelf bottom Y positions
    var yList = [];
    if (distMode === 0) {
        // Equal compartments
        var compH = (clearH - count * thick) / (count + 1);
        for (var i = 0; i < count; i++) {
            yList.push(niche.y1 + compH * (i + 1) + thick * i);
        }
    } else if (distMode === 1) {
        // Fixed step from bottom
        for (var j = 0; j < count; j++) {
            var yb = niche.y1 + stepMm * (j + 1) + thick * j;
            if (yb + thick <= niche.y2 - 5) yList.push(yb);
        }
    } else {
        // Fixed step from top
        for (var k = 0; k < count; k++) {
            var yt = niche.y2 - stepMm * (k + 1) - thick * (k + 1);
            if (yt >= niche.y1 + 5) yList.push(yt);
        }
        yList.sort(function (a, b) { return a - b; });
    }

    if (yList.length === 0) {
        Action.Hint = "No shelves fit within clear height (" + Math.round(clearH) + " mm).";
        return;
    }

    try {
        ActiveMaterial.Make(DEFAULTS.material, thick);
    } catch (e) {}

    var blk = BeginBlock("B&S_ShelfDriver");
    for (var s = 0; s < yList.length; s++) {
        var sy = yList[s];
        var sh = AddHorizPanel(shelfX1, shelfZ1, shelfX2, shelfZ2, sy);
        sh.Name = yList.length === 1 ? "Shelf" : ("Shelf " + (s + 1));
        if (allEdges) {
            addAllEdges(sh, DEFAULTS.edgeMat, DEFAULTS.edgeT, DEFAULTS.edgeW);
        }

        // Mount shelfholders or fixed fasteners when bounding side panels are known
        if (leftPanel && rightPanel && mountMode !== 2) {
            var z1 = shelfZ1 + inset;
            var z2 = shelfZ2 - inset;
            if (z2 < z1) {
                z1 = (shelfZ1 + shelfZ2) / 2;
                z2 = z1;
            }
            if (mountMode === 0) {
                // Adjustable shelfholders (B&S_Shelfholder_D5_3holes_50mm.f3d)
                mountFastenerAt("shelfholder", sh, leftPanel, niche.x1, sy, z1);
                mountFastenerAt("shelfholder", sh, leftPanel, niche.x1, sy, z2);
                mountFastenerAt("shelfholder", sh, rightPanel, niche.x2, sy, z1);
                mountFastenerAt("shelfholder", sh, rightPanel, niche.x2, sy, z2);
            } else if (mountMode === 1) {
                // Fixed shelves: dowels + screws (buttPanel = shelf, facePanel = sidePanel)
                var ym = sy + thick / 2;
                var zMid = (z1 + z2) / 2;
                mountFastenerAt("dowel", sh, leftPanel, niche.x1, ym, z1);
                mountFastenerAt("dowel", sh, leftPanel, niche.x1, ym, z2);
                mountFastenerAt("dowel", sh, rightPanel, niche.x2, ym, z1);
                mountFastenerAt("dowel", sh, rightPanel, niche.x2, ym, z2);
                if (shelfD > 200) {
                    mountFastenerAt("screw", sh, leftPanel, niche.x1, ym, zMid);
                    mountFastenerAt("screw", sh, rightPanel, niche.x2, ym, zMid);
                }
            }
        }
    }
    EndBlock();

    // Persist driver parameters on the block for future re-editing
    try {
        var state = {
            count: count,
            distMode: distMode,
            stepMm: stepMm,
            thickness: thick,
            sideGap: sideGap,
            frontSetback: frontSet,
            backSetback: backSet,
            allEdges: allEdges,
            mountMode: mountMode,
            holderInset: inset,
            leftUid: leftUid,
            rightUid: rightUid,
            bottomUid: bottomUid,
            topUid: topUid,
            niche: {
                mode: niche.mode,
                x1: niche.x1, x2: niche.x2,
                y1: niche.y1, y2: niche.y2,
                zBack: zBack, zFront: zFront
            }
        };
        blk.UserProperty["BS_ShelfDriver"] = JSON.stringify(state);
    } catch (e) {}

    var compInfo = distMode === 0
        ? (" | Compartments: " + Math.round((clearH - yList.length * thick) / (yList.length + 1)) + " mm")
        : (" | Step: " + Math.round(stepMm) + " mm");
    Action.Hint = "B&S Shelf Driver: " + yList.length + " shelves (" +
        Math.round(shelfW) + " x " + Math.round(shelfD) + " x " + thick + " mm)" + compInfo +
        " — Adjust properties and click Apply / Finish";
}

props.OnChange = function () {
    buildShelves();
};

btnOk.OnClick = function () {
    if (editingBlock) {
        try { DeleteObject(editingBlock); } catch (e) {}
    }
    Action.Commit();
    Action.Finish();
};

btnCancel.OnClick = function () {
    Action.Cancel();
};

// Initial live build
buildShelves();
Action.Continue();
