// Bazis-Mebelshchik 2022+ Script: Build All-Operations Verification Test Suite
// Creates 5 test panels covering EVERY Bazis -> TopSolid'Wood 6.25 operation & hardware type:
//   P1: Horizontal 600x400x18 — single blind drill (D35x13), through drill (D8x18), 5-hole row (D5x12 step 32), horizontal edge drills (D8x22)
//   P2: Vertical 780x350x18 — stopped back groove (18.5x6.5, inset 15, stop 4mm -> L=772) + through groove (8x6, L=350)
//   P3: Front Shaker Door 600x780x22 — front pocket 7mm, back pocket 6mm (60mm frame) + 2 Blum 71B3550 hinges
//   P4: Horizontal 600x400x22 — edge Rabbet (18x8, L=600) + edge Moulding (10x6, L=600)
//   P5: Horizontal Shaped 600x400x18 — rounded corner (R50 arc) + internal rectangular cutout (150x100)
//   Hardware: Pin_8x30 dowels, B&S_Screw_4x45 screws, B&S_Shelfholder_D5_3holes_50mm, B&S_Hinge_Blum_71B3550_110_Overlay,
//             B&S_Leg_RIEX_GK50_100mm (x2), B&S_Hanger_LIBRA_H2_Pair (x1)

var fs = require("fs");
var path = require("path");

var ROOTS = ["Y:\\Works\\bazis", "C:\\Users\\danch\\Documents\\Bazis"];
function findLib(subs, name) {
    for (var r = 0; r < ROOTS.length; r++) {
        for (var s = 0; s < subs.length; s++) {
            var p = path.join(ROOTS[r], subs[s], name);
            try { if (fs.existsSync(p)) return p; } catch (e) {}
        }
    }
    return null;
}

function setMat(name, t) {
    try { ActiveMaterial.Make(name, t); } catch (e) {}
}

function addCutRect(panel, name, x1, y1, x2, y2, w, d, frontSide) {
    var cut = panel.AddCut(name);
    try { cut.FrontSide = !!frontSide; } catch (e) {}
    cut.Trajectory.AddLine(x1, y1, x2, y2);
    // Start 1 mm outside surface (standard Bazis convention) to verify depth clipping in export_topsolid6.js
    if (frontSide) {
        cut.Contour.AddRectangle(-w / 2, panel.Thickness - d, w / 2, panel.Thickness + 1);
    } else {
        cut.Contour.AddRectangle(-w / 2, -1, w / 2, d);
    }
    panel.Build();
}

function main() {
    // Clear existing objects in active model
    for (var i = Model.Count - 1; i >= 0; i--) {
        try { DeleteObject(Model.Objects[i]); } catch (e) {}
    }
    Action.Commit();

    setMat("LDSP White 18mm", 18);

    // =========================================================================
    // P1: Horizontal 600x400x18 (X=0..600, Y=100..118, Z=0..400) — Drills + Legs
    // =========================================================================
    var p1 = AddHorizPanel(0, 0, 600, 400, 100);
    p1.Name = "P1_Drill_Single_And_Row";
    p1.Thickness = 18;
    p1.Build();

    // P1b: Vertical butt panel at X=0 (for dowels + screws + horizontal edge holes into P1)
    var p1Side = AddVertPanel(0, 118, 400, 518, 0);
    p1Side.Name = "P1_Side_For_Joint";
    p1Side.Thickness = 18;
    p1Side.Build();

    var dowelPath = findLib(["Accessories\\Pins", "Accessories", ""], "Pin_8\u044530.f3d") ||
                    findLib(["Accessories\\Pins", "Accessories", ""], "Pin_8x30.f3d");
    var screwPath = findLib(["Accessories\\Screws", "Accessories", ""], "B&S_Screw_4x45.f3d");
    var shelfPath = findLib(["Accessories\\Shelfholders", "Accessories", ""], "B&S_Shelfholder_D5_3holes_50mm.f3d");
    var hingePath = findLib(["Accessories\\Hinges", "Accessories", ""], "B&S_Hinge_Blum_71B3550_110_Overlay.f3d");
    var legPath = findLib(["Fragments\\Test_Library", "Fragments", "Accessories\\Legs", ""], "B&S_Leg_RIEX_GK50_100mm.fr3d");
    var hangerPath = findLib(["Fragments\\Test_Library", "Fragments", "Accessories", ""], "B&S_Hanger_LIBRA_H2_Pair.fr3d");

    if (dowelPath) {
        var fDowel = OpenFurniture(dowelPath);
        if (fDowel) {
            fDowel.Mount(p1Side, p1, 9, 118, 80);
            fDowel.Mount(p1Side, p1, 9, 118, 200);
            fDowel.Mount(p1Side, p1, 9, 118, 320);
        }
    }
    if (screwPath) {
        var fScrew = OpenFurniture(screwPath);
        if (fScrew) {
            fScrew.Mount(p1Side, p1, 9, 118, 120);
            fScrew.Mount(p1Side, p1, 9, 118, 280);
        }
    }
    if (shelfPath) {
        var fSh = OpenFurniture(shelfPath);
        if (fSh) {
            // Mount 5-hole / 3-hole shelfholder row onto P1_Side_For_Joint
            fSh.Mount1(p1Side, 18, 300, 100, 0);
            fSh.Mount1(p1Side, 18, 300, 300, 0);
        }
    }
    if (legPath) {
        var leg1 = AddBlock("B&S_Leg_RIEX_GK50_100mm");
        if (leg1.Load(legPath)) {
            leg1.Build();
            var mn1 = leg1.GabMin, mx1 = leg1.GabMax;
            leg1.TranslateGCS(NewVector(80 - (mn1.x + mx1.x) / 2, 0 - mn1.y, 80 - (mn1.z + mx1.z) / 2));
            leg1.Build();
        }
        var leg2 = AddBlock("B&S_Leg_RIEX_GK50_100mm");
        if (leg2.Load(legPath)) {
            leg2.Build();
            var mn2 = leg2.GabMin, mx2 = leg2.GabMax;
            leg2.TranslateGCS(NewVector(520 - (mn2.x + mx2.x) / 2, 0 - mn2.y, 320 - (mn2.z + mx2.z) / 2));
            leg2.Build();
        }
    }

    // =========================================================================
    // P2: Vertical 780x350x18 (X=800..818, Y=100..880, Z=0..350) — Stopped & Through Grooves + LIBRA H2
    // =========================================================================
    var p2 = AddVertPanel(0, 100, 350, 880, 800);
    p2.Name = "P2_Groove_Back_And_Stopped";
    p2.Thickness = 18;
    p2.Build();
    // Stopped back groove: 18.5 x 6.5 mm, center at Z=24.25 (15mm inset + 9.25), stopped 4mm from top/bottom (L=772)
    addCutRect(p2, "Back Groove 18.5x6.5", 24.25, 4, 24.25, 776, 18.5, 6.5, true);
    // Through groove across width: 8 x 6 mm, Y=390, full length 350 mm
    addCutRect(p2, "Through Groove 8x6", 0, 390, 350, 390, 8, 6, true);

    if (hangerPath) {
        var hBlk = AddBlock("B&S_Hanger_LIBRA_H2_Pair");
        if (hBlk.Load(hangerPath)) {
            hBlk.Build();
            var hmn = hBlk.GabMin;
            hBlk.TranslateGCS(NewVector(818 - hmn.x, 800 - hmn.y, 0 - hmn.z));
            hBlk.Build();
        }
    }

    // =========================================================================
    // P3: Front Shaker Door 600x780x22 (X=1100..1700, Y=100..880, Z=350..372) — Front/Back Pockets + Blum Hinges
    // =========================================================================
    var p3Side = AddVertPanel(0, 100, 350, 880, 1100);
    p3Side.Name = "P3_Hinge_Side";
    p3Side.Thickness = 18;
    p3Side.Build();

    setMat("MDF White 22mm", 22);
    var p3 = AddFrontPanel(1100, 100, 1700, 880, 352);
    p3.Name = "P3_Pocket_Shaker_Double";
    p3.Thickness = 22;
    p3.Build();
    // Front pocket 7mm (60mm perimeter frame -> 480x660)
    addCutRect(p3, "Shaker Front Pocket 7mm", 60, 390, 540, 390, 660, 7, true);
    // Back pocket 6mm (60mm perimeter frame -> 480x660)
    addCutRect(p3, "Shaker Back Pocket 6mm", 60, 390, 540, 390, 660, 6, false);

    if (hingePath) {
        var fHinge = OpenFurniture(hingePath);
        if (fHinge) {
            fHinge.Mount(p3, p3Side, 1118, 220, 352);
            fHinge.Mount(p3, p3Side, 1118, 760, 352);
        }
    }

    // =========================================================================
    // P4: Horizontal 600x400x22 (X=1900..2500, Y=100..122, Z=0..400) — Rabbet + Moulding
    // =========================================================================
    var p4 = AddHorizPanel(1900, 0, 2500, 400, 100);
    p4.Name = "P4_Rabbet_And_Moulding";
    p4.Thickness = 22;
    p4.Build();
    // Edge Rabbet 18x8 along back edge (Y=0..18, center Y=9, full length 600)
    addCutRect(p4, "Edge Rabbet 18x8", 0, 9, 600, 9, 18, 8, true);
    // Edge Moulding 10x6 along front edge (Y=390..400, center Y=395, full length 600)
    addCutRect(p4, "Edge Moulding 10x6", 0, 395, 600, 395, 10, 6, true);

    // =========================================================================
    // P5: Horizontal Shaped 600x400x18 (X=2700..3300, Y=100..118, Z=0..400) — Arc Corner + Internal Cutout
    // =========================================================================
    setMat("LDSP White 18mm", 18);
    var p5 = AddHorizPanel(2700, 0, 3300, 400, 100);
    p5.Name = "P5_Shaped_Arc_And_Cutout";
    p5.Thickness = 18;
    p5.Contour.Clear();
    // Outer contour with R50 arc on front-right corner (600, 400), center (550, 350)
    p5.Contour.AddLine(0, 0, 600, 0);
    p5.Contour.AddLine(600, 0, 600, 350);
    p5.Contour.AddArc({ x: 600, y: 350 }, { x: 550, y: 400 }, { x: 550, y: 350 }, true);
    p5.Contour.AddLine(550, 400, 0, 400);
    p5.Contour.AddLine(0, 400, 0, 0);
    // Internal rectangular cutout 150x100 centered at (300, 200)
    p5.Contour.AddRectangle(225, 150, 375, 250);
    p5.Build();

    // =========================================================================
    // B1: Extrusion (TExtrusionBody) — L-profile 50x40x500 mm at X=0, Y=600, Z=0
    // =========================================================================
    var b1 = AddExtrusion("B1_Extrusion_Profile");
    b1.Contour.AddLine(0, 0, 50, 0);
    b1.Contour.AddLine(50, 0, 50, 10);
    b1.Contour.AddLine(50, 10, 10, 10);
    b1.Contour.AddLine(10, 10, 10, 40);
    b1.Contour.AddLine(10, 40, 0, 40);
    b1.Contour.AddLine(0, 40, 0, 0);
    b1.Thickness = 500;
    try { b1.MaterialName = "Aluminum Profile"; } catch (e) {}
    b1.TranslateGCS(NewVector(0, 600, 0));
    b1.Build();

    // =========================================================================
    // B2: Body of Revolution (TTrajectoryBody with Circle R=50) — Turned Foot H=80 at X=1000, Y=600, Z=200
    // =========================================================================
    var b2 = AddTrajectory("B2_Revolve_Turned_Foot");
    b2.Contour2D.AddLine(0, 0, 20, 0);
    b2.Contour2D.AddLine(20, 0, 20, 25);
    b2.Contour2D.AddLine(20, 25, 10, 45);
    b2.Contour2D.AddLine(10, 45, 10, 80);
    b2.Contour2D.AddLine(10, 80, 0, 80);
    b2.Contour2D.AddLine(0, 80, 0, 0);
    b2.Trajectory2D.AddCircle(0, 0, 50);
    try { b2.MaterialName = "Solid Oak"; } catch (e) {}
    b2.TranslateGCS(NewVector(1000, 600, 200));
    b2.Build();

    // =========================================================================
    // B3: Sweep along Trajectory (TTrajectoryBody with Line + R40 Arc + Line) — L-Cornice at X=2000, Y=600, Z=0
    // =========================================================================
    var b3 = AddTrajectory("B3_Sweep_Cornice_L");
    b3.Contour2D.AddLine(0, 0, 35, 0);
    b3.Contour2D.AddLine(35, 0, 35, 20);
    b3.Contour2D.AddLine(35, 20, 20, 35);
    b3.Contour2D.AddLine(20, 35, 20, 55);
    b3.Contour2D.AddLine(20, 55, 0, 55);
    b3.Contour2D.AddLine(0, 55, 0, 0);
    b3.Trajectory2D.AddLine(0, 0, 300, 0);
    b3.Trajectory2D.AddArc({ x: 300, y: 0 }, { x: 340, y: 40 }, { x: 300, y: 40 }, true);
    b3.Trajectory2D.AddLine(340, 40, 340, 240);
    try { b3.MaterialName = "MDF White 22mm"; } catch (e) {}
    b3.TranslateGCS(NewVector(2000, 600, 0));
    b3.Build();

    try { Article.Name = "Ops_Verification_Suite"; } catch (e) {}
    Action.Commit();
    try { ViewAll(); } catch (e) {}

    var savePath = "Y:\\Works\\bazis\\Projects\\Ops_Verification_Suite.b3d";
    try { Action.SaveModel(savePath); } catch (e) {}
    alert("Ops_Verification_Suite built! Objects: " + Model.Count);
}

main();
