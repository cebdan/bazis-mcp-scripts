// Bazis-Mebelshchik 2022+ Script: Build Complete Kitchen from SketchUp Model
// Exact dimensions from IngeTrazo/SketchUp export (kitchen_groups.json):
//   - Plinth / legs: 150 mm (B&S_Leg_RIEX_GK50_150mm.fr3d or inline 150 mm RIEX GK50 legs)
//   - Base carcasses: H = 720 mm (Y = 150..870 mm), D = 590 mm; Countertops: 30 mm (Y = 870..900 mm)
//   - Wall cabinets: H = 900 mm (Y = 1400..2300 mm) + Glazed transoms H = 290 mm (Y = 2300..2590 mm), D = 320 mm
//   - Tall pantries: H = 2150 mm on 150 mm legs (Y = 150..2300 mm) + Glazed transoms 290 mm (Y = 2300..2590 mm)
//   - Range hood mantel (corbels, canopy, moldings, chimney) + X-divider wine rack (500 x 450 x 500 mm)
//   - Drawers: Blum MOVENTO 760H 500 mm wooden boxes (16 mm sides, SKW = LW - 42, SKL = 490) + Shaker 22 mm fronts
//   - Production standards: LDSP White 18 mm, ABS White 19x1 edge banding, 18 mm recessed back in 18.5x6.5 grooves,
//     Shaker 22 mm MDF doors (7 mm front / 6 mm back pockets, 60 mm frame), Blum 71B3550 hinges, LIBRA H2 hangers,
//     Pin_8x30 dowels + B&S_Screw_4x45 screws, B&S_Shelfholder_D5_3holes_50mm.
//
// Coordinate system (right-handed, mm, floor Y = 0, ceiling Y = 2680):
//   Origin (0, 0, 0) = NW room corner (SketchUp X=19.50m, Y=-7.15m, Z=0.10m).
//   +X = East (0..5290), +Y = Up (0..2680), +Z = South (0..4860).

var fs = require("fs");
var path = require("path");

// --- Configuration ---
var CFG = {
    boardMat: "LDSP White 18mm",
    boardT: 18,
    doorMat: "MDF White 22mm",
    doorT: 22,
    drawerMat: "LDSP White 16mm",
    drawerT: 16,
    drawerBotMat: "LDSP White 12mm",
    drawerBotT: 12,
    counterMat: "Countertop 30mm",
    counterT: 30,
    glassMat: "Glass Clear 4mm",
    glassT: 4,
    applianceMat: "Appliance Placeholder",
    edgeMat: "ABS White 19x1",
    edgeT: 1,
    edgeW: 19,
    plinthH: 150,
    plinthSetback: 50,
    backInset: 15,
    grooveW: 18.5,
    grooveD: 6.5,
    grooveStop: 4,
    shakerFrame: 60,
    shakerFrontDepth: 7,
    shakerBackDepth: 6,
    doorGap: 2,
    shelfSideGap: 2,
    shelfFrontSetback: 15,
    hingeOffset: 120,
    // Optional: set true to invoke native NewBoxesMaker with Blum_MOVENTO.bbb instead of manual MOVENTO boxes
    useNativeMoventoMaker: false,
    moventoBbbFile: "Blum_MOVENTO.bbb"
};

var STATS = {
    cabinets: 0,
    panels: 0,
    drawers: 0,
    doors: 0,
    legs: 0,
    fasteners: 0,
    warnings: []
};

// --- File Lookup Helpers ---
var LIB_ROOTS = [
    "Y:\\Works\\bazis",
    "C:\\Users\\danch\\Documents\\Bazis"
];

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

var PATHS = {
    dowel: findLibraryFile(["Accessories\\Pins", "Fasteners", "Accessories", ""], "Pin_8\u044530.f3d") ||
           findLibraryFile(["Accessories\\Pins", "Fasteners", "Accessories", ""], "Pin_8x30.f3d"),
    screw: findLibraryFile(["Accessories\\Screws", "Fasteners", "Accessories", ""], "B&S_Screw_4x45.f3d"),
    hinge: findLibraryFile(["Accessories\\Hinges", "Fasteners", "Accessories", ""], "B&S_Hinge_Blum_71B3550_110_Overlay.f3d"),
    shelfholder: findLibraryFile(["Accessories\\Shelfholders", "Fasteners", "Accessories", ""], "B&S_Shelfholder_D5_3holes_50mm.f3d"),
    leg150: findLibraryFile(["Fragments", "Accessories", ""], "B&S_Leg_RIEX_GK50_150mm.fr3d"),
    hanger: findLibraryFile(["Fragments", "Accessories\\Hangers", "Accessories", ""], "B&S_Hanger_LIBRA_H2_Pair.fr3d"),
    moventoBbb: findLibraryFile(["Drawer library", ""], CFG.moventoBbbFile)
};

var FURN_CACHE = {};
function getFurniture(key) {
    if (FURN_CACHE.hasOwnProperty(key)) return FURN_CACHE[key];
    var p = PATHS[key];
    if (!p) {
        FURN_CACHE[key] = null;
        return null;
    }
    try {
        FURN_CACHE[key] = OpenFurniture(p);
    } catch (e) {
        FURN_CACHE[key] = null;
        STATS.warnings.push("OpenFurniture failed for " + key + ": " + e.message);
    }
    return FURN_CACHE[key];
}

// --- Material & Panel Helpers ---
function setMat(name, thickness) {
    try {
        ActiveMaterial.Make(String(name), Number(thickness));
    } catch (e) {}
}

function addEdges(panel, mode) {
    if (!panel || !panel.Butts) return;
    var count = 0;
    try { count = panel.Contour.Count; } catch (e) { count = 0; }
    if (count <= 0) return;

    var indices = [];
    if (mode === "all") {
        for (var i = 0; i < count; i++) indices.push(i);
    } else if (mode === "visible") {
        for (var v = 0; v < count; v++) {
            var vis = true;
            try { vis = panel.IsButtVisible(v, 5); } catch (e) { vis = true; }
            if (vis) indices.push(v);
        }
    } else if (Array.isArray(mode)) {
        indices = mode;
    }

    for (var j = 0; j < indices.length; j++) {
        try {
            var b = panel.Butts.Add();
            b.ElemIndex = indices[j];
            b.Material = CFG.edgeMat;
            b.Thickness = CFG.edgeT;
            b.Width = CFG.edgeW;
            b.Sign = String(CFG.edgeT);
            b.ClipPanel = true;
        } catch (e) {}
    }
    panel.Build();
}

function addGroove(panel, x1, y1, x2, y2, width, depth, frontSide, name) {
    try {
        var cut = panel.AddCut(name || "Back Groove");
        try { cut.FrontSide = !!frontSide; } catch (e) {}
        cut.Trajectory.AddLine(x1, y1, x2, y2);
        cut.Contour.AddRectangle(-width / 2, 0, width / 2, depth);
        panel.Build();
    } catch (e) {
        STATS.warnings.push("Groove failed on " + (panel.Name || "panel") + ": " + e.message);
    }
}

function addPocket(panel, x1, y1, x2, y2, depth, frontSide, name) {
    var pw = x2 - x1;
    var ph = y2 - y1;
    if (pw <= 10 || ph <= 10 || depth <= 0) return;
    try {
        var cut = panel.AddCut(name || "Shaker Pocket");
        try { cut.FrontSide = !!frontSide; } catch (e) {}
        // Horizontal center trajectory with rectangular profile of width = ph, depth = depth
        var cy = (y1 + y2) / 2;
        cut.Trajectory.AddLine(x1, cy, x2, cy);
        cut.Contour.AddRectangle(-ph / 2, 0, ph / 2, depth);
        panel.Build();
    } catch (e) {
        STATS.warnings.push("Pocket failed on " + (panel.Name || "panel") + ": " + e.message);
    }
}

function mountPair(key, buttPanel, facePanel, points) {
    var furn = getFurniture(key);
    if (!furn || !buttPanel || !facePanel) return;
    for (var i = 0; i < points.length; i++) {
        var pt = points[i];
        try {
            if (furn.Mount(buttPanel, facePanel, pt.x, pt.y, pt.z)) {
                STATS.fasteners++;
            }
        } catch (e) {}
    }
}

function mountStructuralJoint(buttPanel, facePanel, seamX, seamY, zStart, zEnd) {
    var span = zEnd - zStart;
    if (span < 100) return;
    var z1 = zStart + 65;
    var z2 = zEnd - 65;
    var mid = (z1 + z2) / 2;
    var dowelPts = span > 400
        ? [{ x: seamX, y: seamY, z: z1 }, { x: seamX, y: seamY, z: mid }, { x: seamX, y: seamY, z: z2 }]
        : [{ x: seamX, y: seamY, z: z1 }, { x: seamX, y: seamY, z: z2 }];
    var screwPts = [
        { x: seamX, y: seamY, z: z1 + 32 },
        { x: seamX, y: seamY, z: z2 - 32 }
    ];
    mountPair("dowel", buttPanel, facePanel, dowelPts);
    mountPair("screw", buttPanel, facePanel, screwPts);
}

// --- 150 mm RIEX GK50 Leg Builder / Loader ---
function addLeg150(cx, cz, yBottom, name) {
    STATS.legs++;
    if (PATHS.leg150) {
        try {
            var blk = AddBlock(name || "B&S_Leg_RIEX_GK50_150mm");
            if (blk.Load(PATHS.leg150)) {
                blk.Build();
                var mn = blk.GabMin;
                var mx = blk.GabMax;
                var curCx = (mn.x + mx.x) / 2;
                var curCz = (mn.z + mx.z) / 2;
                blk.TranslateGCS(NewVector(cx - curCx, yBottom - mn.y, cz - curCz));
                blk.Build();
                return blk;
            }
        } catch (e) {}
    }

    // Inline fallback 150 mm RIEX GK50 leg geometry
    BeginBlock(name || "B&S_Leg_RIEX_GK50_150mm");
    try {
        var parts = [
            { n: "Foot_Pad", shape: "circle", r: 22, y0: 0, h: 30 },
            { n: "Leg_Body_150", shape: "circle", r: 15, y0: 30, h: 112 },
            { n: "Mount_Flange", shape: "rect", w: 50, y0: 142, h: 8 }
        ];
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            var ex = AddExtrusion(p.n);
            if (p.shape === "circle") {
                ex.Contour.AddCircle(0, 0, p.r);
            } else {
                ex.Contour.AddRectangle(-p.w / 2, -p.w / 2, p.w / 2, p.w / 2);
            }
            ex.Thickness = p.h;
            try { ex.MaterialName = "Plastic Black"; } catch (e) {}
            ex.RotateX(-90);
            ex.Build();
            var mn2 = ex.GabMin;
            var mx2 = ex.GabMax;
            ex.TranslateGCS(NewVector(
                cx - (mn2.x + mx2.x) / 2,
                (yBottom + p.y0) - mn2.y,
                cz - (mn2.z + mx2.z) / 2
            ));
            ex.Build();
        }
    } finally {
        EndBlock();
    }
    return null;
}

function addFourLegs(w, d, yBottom) {
    var insetX = Math.min(70, Math.max(45, w * 0.12));
    var insetZFront = 80;
    var insetZBack = 65;
    addLeg150(insetX, insetZBack, yBottom, "Leg_BL");
    addLeg150(w - insetX, insetZBack, yBottom, "Leg_BR");
    addLeg150(insetX, d - insetZFront, yBottom, "Leg_FL");
    addLeg150(w - insetX, d - insetZFront, yBottom, "Leg_FR");
}

// --- Shaker Door & Glazed Door Builders (local coordinates, front at +Z) ---
function buildShakerDoor(name, x1, y1, x2, y2, zFront, glazed) {
    var dw = x2 - x1;
    var dh = y2 - y1;
    setMat(CFG.doorMat, CFG.doorT);
    var door = AddFrontPanel(x1, y1, x2, y2, zFront);
    door.Name = name;
    door.Thickness = CFG.doorT;
    addEdges(door, "all");
    STATS.panels++;
    STATS.doors++;

    var f = CFG.shakerFrame;
    if (dw > f * 2 + 20 && dh > f * 2 + 20) {
        if (glazed) {
            // Rectangular glass cutout + 4 mm glass pane centered inside 22 mm frame
            try {
                door.Contour.AddRectangle(f, f, dw - f, dh - f);
                door.Build();
            } catch (e) {}
            setMat(CFG.glassMat, CFG.glassT);
            var glass = AddFrontPanel(
                x1 + f - 6, y1 + f - 6,
                x2 - f + 6, y2 - f + 6,
                zFront + (CFG.doorT - CFG.glassT) / 2
            );
            glass.Name = name + " Glass";
            glass.Thickness = CFG.glassT;
            glass.Build();
            STATS.panels++;
            setMat(CFG.boardMat, CFG.boardT);
        } else {
            // Standard Shaker pseudo-frame: 7 mm front pocket + 6 mm back pocket
            addPocket(door, f, f, dw - f, dh - f, CFG.shakerFrontDepth, true, "Shaker Front Pocket");
            addPocket(door, f, f, dw - f, dh - f, CFG.shakerBackDepth, false, "Shaker Back Pocket");
        }
    }
    setMat(CFG.boardMat, CFG.boardT);
    return door;
}

function mountDoorHinges(door, sidePanel, sideX, y1, y2, zFront) {
    var h = y2 - y1;
    var off = Math.min(CFG.hingeOffset, h * 0.25);
    var pts = [{ x: sideX, y: y1 + off, z: zFront }, { x: sideX, y: y2 - off, z: zFront }];
    if (h >= 1200) {
        pts.push({ x: sideX, y: (y1 + y2) / 2, z: zFront });
    }
    if (h >= 1800) {
        pts.push({ x: sideX, y: y1 + h * 0.35, z: zFront });
        pts.push({ x: sideX, y: y1 + h * 0.65, z: zFront });
    }
    mountPair("hinge", door, sidePanel, pts);
}

// --- Blum MOVENTO 760H Drawer Stack Builder ---
function buildMoventoDrawers(w, h, d, leftSide, rightSide, topPanel, bottomPanel, drawerHeights) {
    var t = CFG.boardT;
    var count = drawerHeights.length;
    var innerW = w - 2 * t;

    // Optional native NewBoxesMaker with Blum_MOVENTO.bbb
    if (CFG.useNativeMoventoMaker && PATHS.moventoBbb && typeof NewBoxesMaker === "function") {
        try {
            var maker = NewBoxesMaker("Blum_MOVENTO");
            if (maker.Load(PATHS.moventoBbb)) {
                maker.Setup(leftSide, rightSide, topPanel, bottomPanel);
                STATS.drawers += count;
                return;
            }
        } catch (e) {
            STATS.warnings.push("NewBoxesMaker fallback to manual MOVENTO: " + e.message);
        }
    }

    // Exact Blum MOVENTO 760H wooden drawer box dimensions:
    //   Side board thickness = 16 mm, internal box width SKW = LW - 42 mm (outer box width = LW - 10 mm)
    //   Nominal length NL = 500 mm (or 450/400 if shallow), drawer box length SKL = NL - 10 mm
    //   Bottom panel = 12 mm recessed 12 mm up from bottom of drawer sides for undermount runner
    var boxT = CFG.drawerT;
    var botT = CFG.drawerBotT;
    var nl = d >= 540 ? 500 : (d >= 490 ? 450 : 300);
    var skl = nl - 10;
    var outerBoxW = innerW - 10; // 5 mm clearance per side for MOVENTO 760H
    var boxX1 = t + 5;
    var boxX2 = boxX1 + outerBoxW;
    var boxZ2 = d - 2;
    var boxZ1 = Math.max(CFG.backInset + t + 10, boxZ2 - skl);

    var gap = CFG.doorGap;
    var frontZ = d + 2;
    var curY = gap;

    // Normalize drawer heights to fit cabinet height minus gaps
    var sumH = 0;
    for (var k = 0; k < count; k++) sumH += drawerHeights[k];
    var usableFrontH = h - gap * (count + 1);

    for (var i = 0; i < count; i++) {
        var fh = Math.round((drawerHeights[i] / sumH) * usableFrontH);
        var fy1 = curY;
        var fy2 = (i === count - 1) ? (h - gap) : (curY + fh);
        curY = fy2 + gap;

        var boxH = Math.max(70, Math.min(200, (fy2 - fy1) - 42));
        var by1 = Math.max(t + 14, fy1 + 22);
        var by2 = by1 + boxH;

        BeginBlock("MOVENTO_760H_Drawer_" + (i + 1));
        try {
            setMat(CFG.drawerMat, boxT);
            var dL = AddVertPanel(boxZ1, by1, boxZ2, by2, boxX1);
            dL.Name = "Drawer Left (MOVENTO NL" + nl + ")";
            dL.Thickness = boxT;
            addEdges(dL, "all");

            var dR = AddVertPanel(boxZ1, by1, boxZ2, by2, boxX2 - boxT);
            dR.Name = "Drawer Right (MOVENTO NL" + nl + ")";
            dR.Thickness = boxT;
            addEdges(dR, "all");

            var dB = AddFrontPanel(boxX1 + boxT, by1 + 12, boxX2 - boxT, by2, boxZ1);
            dB.Name = "Drawer Back";
            dB.Thickness = boxT;
            addEdges(dB, "all");

            var dF = AddFrontPanel(boxX1 + boxT, by1 + 12, boxX2 - boxT, by2, boxZ2 - boxT);
            dF.Name = "Drawer Inner Front";
            dF.Thickness = boxT;
            addEdges(dF, "all");

            setMat(CFG.drawerBotMat, botT);
            var dBot = AddHorizPanel(boxX1 + boxT, boxZ1 + boxT, boxX2 - boxT, boxZ2 - boxT, by1 + 12);
            dBot.Name = "Drawer Bottom 12mm";
            dBot.Thickness = botT;
            dBot.Build();

            STATS.panels += 5;
            STATS.drawers++;

            // Shaker 22 mm drawer front
            buildShakerDoor(
                "Drawer Front " + (i + 1),
                gap, fy1, w - gap, fy2, frontZ, false
            );
        } finally {
            EndBlock();
        }
    }
    setMat(CFG.boardMat, CFG.boardT);
}

// --- Universal Cabinet Builder (built in canonical local space: X=0..W, Y=0..H, Z=0..D, front at +Z) ---
// Then rotated around Y and snapped by GabMin to target world [wx, wy, wz].
function buildCabinet(spec) {
    STATS.cabinets++;
    var w = spec.w;
    var h = spec.h;
    var d = spec.d;
    var t = CFG.boardT;
    var hasLegs = !!spec.legs;
    var legH = hasLegs ? CFG.plinthH : 0;
    var isWall = !!spec.wall;
    var isSink = !!spec.sink;
    var hasBack = spec.back !== false;
    var shelves = spec.shelves || 0;
    var backZ = CFG.backInset;
    var innerX1 = t;
    var innerX2 = w - t;
    var gEmbed = 6; // back panel seated 6 mm deep into 6.5 mm grooves

    var blk = BeginBlock(spec.name);
    try {
        setMat(CFG.boardMat, t);

        // 1. Left & Right vertical sides (Y = legH .. legH + h)
        var leftSide = AddVertPanel(0, legH, d, legH + h, 0);
        leftSide.Name = "Left Side";
        leftSide.Thickness = t;
        addEdges(leftSide, "visible");

        var rightSide = AddVertPanel(0, legH, d, legH + h, w - t);
        rightSide.Name = "Right Side";
        rightSide.Thickness = t;
        addEdges(rightSide, "visible");

        // 2. Bottom panel (between sides)
        var bottom = AddHorizPanel(innerX1, 0, innerX2, d, legH);
        bottom.Name = "Bottom";
        bottom.Thickness = t;
        addEdges(bottom, "visible");

        // 3. Top panel (or front/back stretcher rails for sink cabinet)
        var topPanel = null;
        if (isSink) {
            var railFront = AddHorizPanel(innerX1, d - 100, innerX2, d, legH + h - t);
            railFront.Name = "Top Front Rail";
            railFront.Thickness = t;
            addEdges(railFront, "visible");

            var railBack = AddHorizPanel(innerX1, 0, innerX2, 100, legH + h - t);
            railBack.Name = "Top Back Rail";
            railBack.Thickness = t;
            addEdges(railBack, "visible");
            topPanel = railFront;
            STATS.panels += 5;
        } else {
            topPanel = AddHorizPanel(innerX1, 0, innerX2, d, legH + h - t);
            topPanel.Name = "Top";
            topPanel.Thickness = t;
            addEdges(topPanel, "visible");
            STATS.panels += 4;
        }

        // Structural dowels + screws (buttPanel, facePanel)
        mountStructuralJoint(bottom, leftSide, t, legH + t / 2, 0, d);
        mountStructuralJoint(bottom, rightSide, w - t, legH + t / 2, 0, d);
        if (!isSink) {
            mountStructuralJoint(topPanel, leftSide, t, legH + h - t / 2, 0, d);
            mountStructuralJoint(topPanel, rightSide, w - t, legH + h - t / 2, 0, d);
        }

        // 4. Recessed 18 mm back panel in 18.5 x 6.5 mm grooves (stopped 4 mm on vertical sides)
        if (hasBack) {
            var grooveCenterZ = backZ + t / 2;
            // Side panel local coords: contour X along Z (0..d), contour Y along Y (0..h)
            addGroove(leftSide, grooveCenterZ, CFG.grooveStop, grooveCenterZ, h - CFG.grooveStop, CFG.grooveW, CFG.grooveD, true, "Back Groove");
            addGroove(rightSide, grooveCenterZ, CFG.grooveStop, grooveCenterZ, h - CFG.grooveStop, CFG.grooveW, CFG.grooveD, false, "Back Groove");
            // Bottom & top grooves
            addGroove(bottom, 0, grooveCenterZ, innerX2 - innerX1, grooveCenterZ, CFG.grooveW, CFG.grooveD, true, "Back Groove");
            if (!isSink) {
                addGroove(topPanel, 0, grooveCenterZ, innerX2 - innerX1, grooveCenterZ, CFG.grooveW, CFG.grooveD, false, "Back Groove");
            }

            var backY2 = isSink ? (legH + h - 100) : (legH + h - t + gEmbed);
            var backPanel = AddFrontPanel(innerX1 - gEmbed, legH + t - gEmbed, innerX2 + gEmbed, backY2, backZ);
            backPanel.Name = "Back Panel 18mm";
            backPanel.Thickness = t;
            backPanel.Build();
            STATS.panels++;
        }

        // 5. Adjustable shelves (2 mm side gap, all 4 edges banded, shelfholders 40 mm from front/back)
        if (shelves > 0) {
            var sZ1 = hasBack ? (backZ + t + 2) : 2;
            var sZ2 = d - CFG.shelfFrontSetback;
            var usableH = h - 2 * t;
            var step = usableH / (shelves + 1);
            for (var s = 1; s <= shelves; s++) {
                var sy = legH + t + step * s - t / 2;
                var sh = AddHorizPanel(innerX1 + CFG.shelfSideGap, sZ1, innerX2 - CFG.shelfSideGap, sZ2, sy);
                sh.Name = "Shelf " + s;
                sh.Thickness = t;
                addEdges(sh, "all");
                STATS.panels++;

                var shPtsL = [
                    { x: innerX1, y: sy, z: sZ1 + 40 },
                    { x: innerX1, y: sy, z: sZ2 - 40 }
                ];
                var shPtsR = [
                    { x: innerX2, y: sy, z: sZ1 + 40 },
                    { x: innerX2, y: sy, z: sZ2 - 40 }
                ];
                mountPair("shelfholder", sh, leftSide, shPtsL);
                mountPair("shelfholder", sh, rightSide, shPtsR);
            }
        }

        // 6. Legs (150 mm RIEX GK50) or Wall Hangers (LIBRA H2)
        if (hasLegs) {
            addFourLegs(w, d, 0);
        }
        if (isWall && PATHS.hanger) {
            try {
                var hBlk = AddBlock("LIBRA_H2_Hangers");
                if (hBlk.Load(PATHS.hanger)) {
                    if (hBlk.IsElastic && hBlk.IsElastic()) {
                        hBlk.ElasticResize(NewVector(w - 12, 60, 15));
                    }
                    hBlk.TranslateGCS(NewVector(6, legH + h - t - 60, 0));
                    hBlk.Build();
                }
            } catch (e) {}
        }

        // 7. Fronts: Blum MOVENTO drawers, Shaker doors, glazed transoms, or blind-corner door
        var gap = CFG.doorGap;
        var frontZ = d + 2;
        var fy1 = legH + gap;
        var fy2 = legH + h - gap;

        if (spec.drawers && spec.drawers.length > 0) {
            buildMoventoDrawers(w, h, d, leftSide, rightSide, topPanel, bottom, spec.drawers);
        } else if (spec.blindCorner) {
            // Blind corner: left door + right blind filler panel
            var doorW = spec.doorWidth || 500;
            var d1 = buildShakerDoor("Door Corner", gap, fy1, doorW - gap, fy2, frontZ, false);
            mountDoorHinges(d1, leftSide, t, fy1, fy2, frontZ);
            setMat(CFG.boardMat, t);
            var blind = AddFrontPanel(doorW, legH, w, legH + h, d);
            blind.Name = "Blind Corner Panel";
            blind.Thickness = t;
            addEdges(blind, "all");
            STATS.panels++;
        } else if (spec.doors === "4split") {
            // Tall pantry 4-door split (2 lower + 2 upper)
            var splitY = legH + (spec.splitHeight || 720);
            var midX = w / 2;
            var dlL = buildShakerDoor("Lower Door Left", gap, fy1, midX - gap, splitY - gap, frontZ, false);
            var dlR = buildShakerDoor("Lower Door Right", midX + gap, fy1, w - gap, splitY - gap, frontZ, false);
            var duL = buildShakerDoor("Upper Door Left", gap, splitY + gap, midX - gap, fy2, frontZ, false);
            var duR = buildShakerDoor("Upper Door Right", midX + gap, splitY + gap, w - gap, fy2, frontZ, false);
            mountDoorHinges(dlL, leftSide, t, fy1, splitY - gap, frontZ);
            mountDoorHinges(dlR, rightSide, w - t, fy1, splitY - gap, frontZ);
            mountDoorHinges(duL, leftSide, t, splitY + gap, fy2, frontZ);
            mountDoorHinges(duR, rightSide, w - t, splitY + gap, fy2, frontZ);
        } else if (spec.doors === "2vert") {
            // Narrow tall cabinet: 1 lower door + 1 upper door
            var splitY2 = legH + (spec.splitHeight || 720);
            var dvL = buildShakerDoor("Lower Door", gap, fy1, w - gap, splitY2 - gap, frontZ, false);
            var dvU = buildShakerDoor("Upper Door", gap, splitY2 + gap, w - gap, fy2, frontZ, false);
            mountDoorHinges(dvL, leftSide, t, fy1, splitY2 - gap, frontZ);
            mountDoorHinges(dvU, leftSide, t, splitY2 + gap, fy2, frontZ);
        } else if (spec.doors === 2) {
            var mx = w / 2;
            var dL = buildShakerDoor("Door Left", gap, fy1, mx - gap, fy2, frontZ, !!spec.glazed);
            var dR = buildShakerDoor("Door Right", mx + gap, fy1, w - gap, fy2, frontZ, !!spec.glazed);
            mountDoorHinges(dL, leftSide, t, fy1, fy2, frontZ);
            mountDoorHinges(dR, rightSide, w - t, fy1, fy2, frontZ);
        } else if (spec.doors === 1) {
            var dSingle = buildShakerDoor(spec.glazed ? "Glazed Door" : "Door", gap, fy1, w - gap, fy2, frontZ, !!spec.glazed);
            var hingeOnRight = spec.hingeSide === "right";
            mountDoorHinges(dSingle, hingeOnRight ? rightSide : leftSide, hingeOnRight ? (w - t) : t, fy1, fy2, frontZ);
        }
    } finally {
        EndBlock();
    }

    // Rotate & snap block bounding box to exact target world coordinates [x, y, z]
    if (blk) {
        if (spec.rotY) {
            blk.RotateY(spec.rotY);
            blk.Build();
        }
        // Compute carcass-only bounds (ignore small fastener/hinge protrusions)
        var mn = leftSide.GabMin;
        var mx = leftSide.GabMax;
        var refPanels = [leftSide, rightSide, bottom];
        var minX = mn.x, minY = mn.y, minZ = mn.z;
        for (var rp = 1; rp < refPanels.length; rp++) {
            var pmn = refPanels[rp].GabMin;
            if (pmn.x < minX) minX = pmn.x;
            if (pmn.y < minY) minY = pmn.y;
            if (pmn.z < minZ) minZ = pmn.z;
        }
        var targetCarcassY = spec.y + (hasLegs ? CFG.plinthH : 0);
        blk.TranslateGCS(NewVector(spec.x - minX, targetCarcassY - minY, spec.z - minZ));
        blk.Build();
        return blk;
    }
    return null;
}

// --- Simple Box / Panel / Placeholder Helpers (direct world coordinates) ---
function addWorldSlabH(name, x1, z1, x2, z2, yBottom, thickness, matName, bandMode) {
    setMat(matName || CFG.boardMat, thickness);
    var p = AddHorizPanel(x1, z1, x2, z2, yBottom);
    p.Name = name;
    p.Thickness = thickness;
    if (bandMode) addEdges(p, bandMode);
    else p.Build();
    STATS.panels++;
    setMat(CFG.boardMat, CFG.boardT);
    return p;
}

function addWorldSlabV(name, z1, y1, z2, y2, xPos, thickness, matName, bandMode) {
    setMat(matName || CFG.boardMat, thickness);
    var p = AddVertPanel(z1, y1, z2, y2, xPos);
    p.Name = name;
    p.Thickness = thickness;
    if (bandMode) addEdges(p, bandMode);
    else p.Build();
    STATS.panels++;
    setMat(CFG.boardMat, CFG.boardT);
    return p;
}

function addWorldSlabF(name, x1, y1, x2, y2, zPos, thickness, matName, bandMode) {
    setMat(matName || CFG.boardMat, thickness);
    var p = AddFrontPanel(x1, y1, x2, y2, zPos);
    p.Name = name;
    p.Thickness = thickness;
    if (bandMode) addEdges(p, bandMode);
    else p.Build();
    STATS.panels++;
    setMat(CFG.boardMat, CFG.boardT);
    return p;
}

function addApplianceBox(name, x1, y1, z1, x2, y2, z2) {
    var ex = AddExtrusion(name);
    ex.Contour.AddRectangle(x1, y1, x2, y2);
    ex.Thickness = z2 - z1;
    try { ex.MaterialName = CFG.applianceMat; } catch (e) {}
    ex.TranslateGCS(NewVector(0, 0, z1));
    ex.Build();
    return ex;
}

// --- Range Hood Mantel Builder (East wall, centered over 1104 mm range cooker) ---
function buildRangeHoodMantel() {
    BeginBlock("E_Range_Hood_Mantel");
    try {
        var t = CFG.boardT;
        var z1 = 1340;
        var z2 = 2640; // width = 1300 mm

        // Left & right corbel brackets (100 mm wide x 400 mm deep x 850 mm high, Y = 1050..1900)
        // Built as contoured vertical panels with classic curved corbel cutout
        var corbelZs = [z1, z2 - 100];
        for (var c = 0; c < corbelZs.length; c++) {
            var cz = corbelZs[c];
            addWorldSlabF("Mantel_Corbel_" + (c + 1) + "_SideA", 4890, 1050, 5270, 1900, cz, t, CFG.doorMat, "visible");
            addWorldSlabF("Mantel_Corbel_" + (c + 1) + "_SideB", 4890, 1050, 5270, 1900, cz + 100 - t, t, CFG.doorMat, "visible");
            addWorldSlabV("Mantel_Corbel_" + (c + 1) + "_Front", cz, 1050, cz + 100, 1900, 4890, t, CFG.doorMat, "visible");
        }

        // Lower mantel shelf / molding (Y = 1900..1930, 474 x 1348 x 30 mm)
        addWorldSlabH("Mantel_Lower_Shelf", 4816, 1316, 5290, 2664, 1900, 30, CFG.doorMat, "all");

        // Main canopy box (Y = 1930..2150, 450 x 1300 x 220 mm)
        addWorldSlabV("Mantel_Canopy_Front", z1, 1930, z2, 2150, 4840, CFG.doorT, CFG.doorMat, "visible");
        addWorldSlabF("Mantel_Canopy_Left", 4840, 1930, 5290, 2150, z1, t, CFG.doorMat, "visible");
        addWorldSlabF("Mantel_Canopy_Right", 4840, 1930, 5290, 2150, z2 - t, t, CFG.doorMat, "visible");
        addWorldSlabH("Mantel_Canopy_Bottom", 4840, z1, 5290, z2, 1930, t, CFG.boardMat, "visible");

        // Upper crown molding (Y = 2150..2210, 494 x 1387 x 60 mm)
        addWorldSlabH("Mantel_Crown_Molding", 4796, 1296, 5290, 2684, 2150, 60, CFG.doorMat, "all");

        // Upper chimney box (Y = 2210..2680, 300 x 1100 x 470 mm)
        addWorldSlabV("Mantel_Chimney_Front", 1440, 2210, 2540, 2680, 4990, t, CFG.boardMat, "visible");
        addWorldSlabF("Mantel_Chimney_Left", 4990, 2210, 5290, 2680, 1440, t, CFG.boardMat, "visible");
        addWorldSlabF("Mantel_Chimney_Right", 4990, 2210, 5290, 2680, 2540 - t, t, CFG.boardMat, "visible");
    } finally {
        EndBlock();
    }
}

// --- X-Divider Wine Rack Builder (South niche above 500 mm tall cabinet, 500 x 450 x 500 mm) ---
function buildWineRack(x, y, z, w, h, d) {
    var t = CFG.boardT;
    var blk = BeginBlock("S_WineRack_500_X");
    try {
        setMat(CFG.boardMat, t);
        // Outer carcass (500 x 500 x 450)
        var sL = AddVertPanel(0, 0, d, h, 0);
        sL.Name = "WineRack Left"; sL.Thickness = t; addEdges(sL, "visible");
        var sR = AddVertPanel(0, 0, d, h, w - t);
        sR.Name = "WineRack Right"; sR.Thickness = t; addEdges(sR, "visible");
        var bot = AddHorizPanel(t, 0, w - t, d, 0);
        bot.Name = "WineRack Bottom"; bot.Thickness = t; addEdges(bot, "visible");
        var top = AddHorizPanel(t, 0, w - t, d, h - t);
        top.Name = "WineRack Top"; top.Thickness = t; addEdges(top, "visible");
        var back = AddFrontPanel(t, t, w - t, h - t, 0);
        back.Name = "WineRack Back"; back.Thickness = t; back.Build();
        STATS.panels += 5;

        // X-shaped diagonal bottle dividers (two 45-deg crossed boards inside opening)
        var innerW = w - 2 * t;
        var innerH = h - 2 * t;
        var diagLen = Math.sqrt(innerW * innerW + innerH * innerH) - 18;
        var divD = d - t - 10;

        var diag1 = AddHorizPanel(0, t, diagLen, t + divD, 0);
        diag1.Name = "WineRack_X_Divider_1";
        diag1.Thickness = t;
        addEdges(diag1, "all");
        diag1.RotateZ(45);
        diag1.Build();
        var mn1 = diag1.GabMin, mx1 = diag1.GabMax;
        diag1.TranslateGCS(NewVector(w / 2 - (mn1.x + mx1.x) / 2, h / 2 - (mn1.y + mx1.y) / 2, 0));
        diag1.Build();

        var diag2 = AddHorizPanel(0, t, diagLen, t + divD, 0);
        diag2.Name = "WineRack_X_Divider_2";
        diag2.Thickness = t;
        addEdges(diag2, "all");
        diag2.RotateZ(-45);
        diag2.Build();
        var mn2 = diag2.GabMin, mx2 = diag2.GabMax;
        diag2.TranslateGCS(NewVector(w / 2 - (mn2.x + mx2.x) / 2, h / 2 - (mn2.y + mx2.y) / 2, 0));
        diag2.Build();
        STATS.panels += 2;
    } finally {
        EndBlock();
    }

    if (blk) {
        blk.RotateY(180); // face -Z into room
        blk.Build();
        var mn = blk.GabMin;
        blk.TranslateGCS(NewVector(x - mn.x, y - mn.y, z - mn.z));
        blk.Build();
    }
}

// --- Main Kitchen Assembly ---
function main() {
    var prevMat = "";
    var prevThick = 18;
    try {
        prevMat = ActiveMaterial.Name;
        prevThick = ActiveMaterial.Thickness;
    } catch (e) {}

    setMat(CFG.boardMat, CFG.boardT);

    // =========================================================================
    // 1. NORTH WINDOW WALL (Bz = 0..590, facing +Z, rotY = 0)
    // =========================================================================
    BeginBlock("01_North_Window_Wall");
    try {
        buildCabinet({ name: "N1_Base_500", x: 590, y: 0, z: 0, w: 500, h: 720, d: 590, legs: true, doors: 1, shelves: 1, rotY: 0 });
        addApplianceBox("N2_WineCooler_Lanbo_500", 1090, 0, 0, 1590, 870, 590);
        buildCabinet({ name: "N3_Base_1000_2Drw", x: 1590, y: 0, z: 0, w: 1000, h: 720, d: 590, legs: true, drawers: [350, 350], rotY: 0 });
        buildCabinet({ name: "N4_Base_Sink_1000", x: 2590, y: 0, z: 0, w: 1000, h: 720, d: 590, legs: true, sink: true, doors: 2, rotY: 0 });
        buildCabinet({ name: "N5_Base_600_DW", x: 3590, y: 0, z: 0, w: 600, h: 720, d: 590, legs: true, doors: 1, shelves: 1, rotY: 0 });
        buildCabinet({ name: "N6_Base_Corner_1100", x: 4190, y: 0, z: 0, w: 1100, h: 720, d: 590, legs: true, blindCorner: true, doorWidth: 500, shelves: 1, rotY: 0 });

        // North countertop (4700 x 600 x 30 mm) + 100 mm upstand
        addWorldSlabH("N_Countertop_4700x600", 590, 0, 5290, 600, 870, CFG.counterT, CFG.counterMat, "visible");
        addWorldSlabF("N_Upstand_100", 590, 900, 5272, 1000, 0, 18, CFG.counterMat, "visible");
    } finally {
        EndBlock();
    }

    // =========================================================================
    // 2. EAST RANGE WALL (Bx = 4700..5290, facing -X, rotY = -90)
    // =========================================================================
    BeginBlock("02_East_Range_Wall");
    try {
        // Lower base run
        buildCabinet({ name: "E1_Base_820_3Drw", x: 4700, y: 0, z: 600, w: 820, h: 720, d: 590, legs: true, drawers: [160, 270, 270], rotY: -90 });
        addWorldSlabF("E1_EndPanel_RangeL", 4690, 0, 5290, 870, 1420, 18, CFG.doorMat, "visible");
        addApplianceBox("E_Range_Cooker_1104", 4550, 0, 1438, 5250, 955, 2542);
        addWorldSlabF("E2_EndPanel_RangeR", 4690, 0, 5290, 870, 2542, 18, CFG.doorMat, "visible");
        buildCabinet({ name: "E2_Base_800_3Drw", x: 4700, y: 0, z: 2560, w: 800, h: 720, d: 590, legs: true, drawers: [160, 270, 270], rotY: -90 });

        // East countertops & backsplash
        addWorldSlabH("E_Countertop_Left", 4690, 600, 5290, 1438, 870, CFG.counterT, CFG.counterMat, "visible");
        addWorldSlabH("E_Countertop_Right", 4690, 2542, 5290, 3360, 870, CFG.counterT, CFG.counterMat, "visible");
        addWorldSlabV("E_Backsplash", 0, 900, 3360, 1900, 5272, 18, CFG.counterMat, "visible");

        // Upper wall cabinets (900 mm) + glazed transoms (290 mm), D = 320 mm
        buildCabinet({ name: "E_Wall_1_600", x: 4970, y: 1400, z: 20, w: 600, h: 900, d: 320, wall: true, doors: 1, shelves: 2, rotY: -90 });
        buildCabinet({ name: "E_Transom_1_600", x: 4970, y: 2300, z: 20, w: 600, h: 290, d: 320, wall: true, doors: 1, glazed: true, rotY: -90 });

        buildCabinet({ name: "E_Wall_2_600", x: 4970, y: 1400, z: 620, w: 600, h: 900, d: 320, wall: true, doors: 1, hingeSide: "right", shelves: 2, rotY: -90 });
        buildCabinet({ name: "E_Transom_2_600", x: 4970, y: 2300, z: 620, w: 600, h: 290, d: 320, wall: true, doors: 1, glazed: true, rotY: -90 });
        addWorldSlabF("E_Wall_EndPanel_L", 4970, 1360, 5290, 2590, 1220, 18, CFG.doorMat, "visible");

        // Range Hood Mantel
        buildRangeHoodMantel();

        addWorldSlabF("E_Wall_EndPanel_R", 4970, 1360, 5290, 2590, 2742, 18, CFG.doorMat, "visible");
        buildCabinet({ name: "E_Wall_3_600", x: 4970, y: 1400, z: 2760, w: 600, h: 900, d: 320, wall: true, doors: 1, shelves: 2, rotY: -90 });
        buildCabinet({ name: "E_Transom_3_600", x: 4970, y: 2300, z: 2760, w: 600, h: 290, d: 320, wall: true, doors: 1, glazed: true, rotY: -90 });

        // East Tall Pantry (800 x 590 x 2300 + 290 transom) + 18 mm side panels
        addWorldSlabF("E_Tall_SidePanel_L", 4700, 0, 5290, 2590, 3360, 18, CFG.doorMat, "visible");
        buildCabinet({ name: "E_Tall_800", x: 4700, y: 0, z: 3378, w: 800, h: 2150, d: 590, legs: true, doors: "4split", splitHeight: 720, shelves: 4, rotY: -90 });
        buildCabinet({ name: "E_Tall_Transom_800", x: 4700, y: 2300, z: 3378, w: 800, h: 290, d: 590, doors: 1, glazed: true, rotY: -90 });
        addWorldSlabF("E_Tall_SidePanel_R", 4700, 0, 5290, 2590, 4178, 18, CFG.doorMat, "visible");

        // Top cornices (Y = 2590..2650)
        addWorldSlabH("E_Cornice_Left", 4930, 0, 5290, 1280, 2590, 60, CFG.doorMat, "all");
        addWorldSlabH("E_Cornice_Right", 4660, 2700, 5290, 4240, 2590, 60, CFG.doorMat, "all");
    } finally {
        EndBlock();
    }

    // =========================================================================
    // 3. CENTER ISLAND (1840 x 910 carcasses, 1907 x 1224 countertop)
    // =========================================================================
    BeginBlock("03_Center_Island");
    try {
        // Front row facing -Z (toward sink/windows, rotY = 180)
        buildCabinet({ name: "I1_Base_400_L", x: 1960, y: 0, z: 1690, w: 400, h: 720, d: 590, legs: true, doors: 1, shelves: 1, rotY: 180 });
        buildCabinet({ name: "I2_Base_1000_3Drw", x: 2360, y: 0, z: 1690, w: 1000, h: 720, d: 590, legs: true, drawers: [160, 270, 270], rotY: 180 });
        buildCabinet({ name: "I3_Base_400_R", x: 3360, y: 0, z: 1690, w: 400, h: 720, d: 590, legs: true, doors: 1, hingeSide: "right", shelves: 1, rotY: 180 });

        // Back row facing +Z (under bar seating overhang, rotY = 0)
        buildCabinet({ name: "I4_Back_900_L", x: 1960, y: 0, z: 2280, w: 900, h: 720, d: 320, legs: true, doors: 2, shelves: 1, rotY: 0 });
        buildCabinet({ name: "I5_Back_900_R", x: 2860, y: 0, z: 2280, w: 900, h: 720, d: 320, legs: true, doors: 2, shelves: 1, rotY: 0 });

        // Island decorative end panels (18 x 910 x 870)
        addWorldSlabV("Island_EndPanel_L", 1690, 0, 2600, 870, 1942, 18, CFG.doorMat, "visible");
        addWorldSlabV("Island_EndPanel_R", 1690, 0, 2600, 870, 3760, 18, CFG.doorMat, "visible");

        // Island countertop (1907 x 1224 x 30 mm)
        addWorldSlabH("Island_Countertop_1907x1224", 1910, 1670, 3817, 2894, 870, CFG.counterT, CFG.counterMat, "all");
    } finally {
        EndBlock();
    }

    // =========================================================================
    // 4. SOUTH FRIDGE NICHE (facing -Z, rotY = 180)
    // =========================================================================
    BeginBlock("04_South_Fridge_Niche");
    try {
        buildCabinet({ name: "S_Tall_500", x: 1220, y: 0, z: 4240, w: 500, h: 1950, d: 590, legs: true, doors: "2vert", splitHeight: 720, shelves: 3, rotY: 180 });
        buildWineRack(1220, 2100, 4260, 500, 500, 450);

        addWorldSlabV("S_Fridge_Panel_L", 4260, 0, 4860, 1800, 1720, 18, CFG.doorMat, "visible");
        addApplianceBox("S_Fridge_Samsung_971", 1738, 0, 4240, 2702, 1800, 4820);
        addWorldSlabV("S_Fridge_Panel_R", 4260, 0, 4860, 1800, 2702, 18, CFG.doorMat, "visible");

        buildCabinet({ name: "S_OverFridge_1000", x: 1720, y: 1800, z: 4240, w: 1000, h: 400, d: 620, doors: 1, rotY: 180 });
        buildCabinet({ name: "S_OverFridge_Transom_1000", x: 1720, y: 2200, z: 4240, w: 1000, h: 400, d: 506, doors: 1, glazed: true, rotY: 180 });
        addWorldSlabH("S_Fridge_Cornice", 1650, 4200, 2720, 4263, 2600, 64, CFG.doorMat, "all");
    } finally {
        EndBlock();
    }

    // =========================================================================
    // 5. WEST TALL PANTRY (facing +X, rotY = 90)
    // =========================================================================
    BeginBlock("05_West_Tall_Pantry");
    try {
        buildCabinet({ name: "W_Tall_800", x: 0, y: 0, z: 640, w: 800, h: 2150, d: 590, legs: true, doors: "4split", splitHeight: 720, shelves: 4, rotY: 90 });
        buildCabinet({ name: "W_Tall_Transom_800", x: 0, y: 2300, z: 640, w: 800, h: 290, d: 590, doors: 1, glazed: true, rotY: 90 });
        addWorldSlabF("W_SidePanel_South", 0, 150, 572, 2590, 1440, 18, CFG.doorMat, "visible");
        addWorldSlabV("W_TopFiller", 640, 2590, 1458, 2680, 572, 18, CFG.doorMat, "visible");
        addWorldSlabV("W_CornerFiller_North", 0, 0, 640, 2680, 572, 18, CFG.doorMat, "visible");
    } finally {
        EndBlock();
    }

    // =========================================================================
    // 6. RECESSED 150 mm PLINTHS (TOE-KICKS)
    // =========================================================================
    BeginBlock("06_Plinths_150mm");
    try {
        var ph = CFG.plinthH;
        var sb = CFG.plinthSetback;
        addWorldSlabF("Plinth_North", 590, 0, 4700, ph, 590 - sb, 18, CFG.doorMat, "visible");
        addWorldSlabV("Plinth_East_L", 600, 0, 1420, ph, 4700 + sb, 18, CFG.doorMat, "visible");
        addWorldSlabV("Plinth_East_R", 2560, 0, 3360, ph, 4700 + sb, 18, CFG.doorMat, "visible");
        addWorldSlabV("Plinth_East_Tall", 3378, 0, 4178, ph, 4700 + sb, 18, CFG.doorMat, "visible");
        addWorldSlabF("Plinth_Island_Front", 1960, 0, 3760, ph, 1690 + sb, 18, CFG.doorMat, "visible");
        addWorldSlabF("Plinth_Island_Back", 1960, 0, 3760, ph, 2600 - sb, 18, CFG.doorMat, "visible");
        addWorldSlabF("Plinth_South_Tall", 1220, 0, 1720, ph, 4240 + sb, 18, CFG.doorMat, "visible");
        addWorldSlabV("Plinth_West_Tall", 640, 0, 1440, ph, 590 - sb, 18, CFG.doorMat, "visible");
    } finally {
        EndBlock();
    }

    if (prevMat) {
        try { ActiveMaterial.Make(prevMat, prevThick); } catch (e) {}
    }

    Action.Commit();
    try { ViewAll(); } catch (e) {}

    var msg = "Kitchen built from SketchUp layout!\n" +
        "Cabinets: " + STATS.cabinets +
        " | Panels: " + STATS.panels +
        " | Doors: " + STATS.doors +
        " | MOVENTO Drawers: " + STATS.drawers +
        " | 150mm Legs: " + STATS.legs +
        " | Fasteners: " + STATS.fasteners +
        "\n150mm Leg .fr3d loaded: " + (PATHS.leg150 ? "YES" : "NO (used inline 150mm geometry)");
    if (STATS.warnings.length > 0) {
        msg += "\nWarnings (" + STATS.warnings.length + "): " + STATS.warnings.slice(0, 3).join("; ");
    }
    alert(msg);
}

main();
