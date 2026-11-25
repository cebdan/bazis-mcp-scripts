// Bazis-Mebelshchik 2022+ Script: Create 150 mm Adjustable Cabinet Leg Fragment
// Output: B&S_Leg_RIEX_GK50_150mm.fr3d (RIEX GK50 style, 150 mm nominal height)
//
// Geometry (local coordinates, centered at X=0, Z=0, Y=0..150 mm):
//   - Adjustable foot pad:   D44 mm, Y = 0..30 mm
//   - Main cylindrical body: D30 mm, Y = 30..142 mm
//   - Top mounting flange:   50 x 50 x 8 mm, Y = 142..150 mm
//
// Run inside an empty Bazis model/fragment window to create and save the .fr3d file.

var fs = require("fs");
var path = require("path");

var LEG_NAME = "B&S_Leg_RIEX_GK50_150mm";
var TOTAL_H = 150;
var FOOT_H = 30;
var FOOT_R = 22;     // D44 mm
var BODY_R = 15;     // D30 mm
var FLANGE_H = 8;
var FLANGE_W = 50;   // 50 x 50 mm
var BODY_H = TOTAL_H - FOOT_H - FLANGE_H; // 112 mm
var MAT_NAME = "Plastic Black";

function resolveSavePath() {
    var candidates = [
        "Y:\\Works\\bazis\\Fragments",
        "C:\\Users\\danch\\Documents\\Bazis\\Fragments"
    ];
    for (var i = 0; i < candidates.length; i++) {
        try {
            if (fs.existsSync(candidates[i])) {
                return path.join(candidates[i], LEG_NAME + ".fr3d");
            }
        } catch (e) {}
    }
    try {
        var userProfile = process.env.USERPROFILE || "C:\\Users\\Public";
        var fallbackDir = path.join(userProfile, "Documents", "Bazis", "Fragments");
        if (!fs.existsSync(fallbackDir)) {
            fs.mkdirSync(fallbackDir, { recursive: true });
        }
        return path.join(fallbackDir, LEG_NAME + ".fr3d");
    } catch (e) {}
    return LEG_NAME + ".fr3d";
}

function addVerticalCylinder(name, radius, yBottom, height) {
    var cyl = AddExtrusion(name);
    cyl.Contour.AddCircle(0, 0, radius);
    cyl.Thickness = height;
    try { cyl.MaterialName = MAT_NAME; } catch (e) {}
    // Default extrusion is along +Z (0..height); rotate -90 deg around X so it stands along +Y
    cyl.RotateX(-90);
    cyl.Build();
    var curMin = cyl.GabMin;
    var curMax = cyl.GabMax;
    var cx = (curMin.x + curMax.x) / 2;
    var cz = (curMin.z + curMax.z) / 2;
    cyl.TranslateGCS(NewVector(-cx, yBottom - curMin.y, -cz));
    cyl.Build();
    return cyl;
}

function addMountingFlange(name, width, yBottom, height) {
    var fl = AddExtrusion(name);
    fl.Contour.AddRectangle(-width / 2, -width / 2, width / 2, width / 2);
    fl.Thickness = height;
    try { fl.MaterialName = MAT_NAME; } catch (e) {}
    fl.RotateX(-90);
    fl.Build();
    var curMin = fl.GabMin;
    var curMax = fl.GabMax;
    var cx = (curMin.x + curMax.x) / 2;
    var cz = (curMin.z + curMax.z) / 2;
    fl.TranslateGCS(NewVector(-cx, yBottom - curMin.y, -cz));
    fl.Build();
    return fl;
}

function main() {
    var prevMat = "";
    var prevThick = 18;
    try {
        prevMat = ActiveMaterial.Name;
        prevThick = ActiveMaterial.Thickness;
    } catch (e) {}

    BeginBlock(LEG_NAME);
    try {
        addVerticalCylinder("RIEX_GK50_Foot_Pad", FOOT_R, 0, FOOT_H);
        addVerticalCylinder("RIEX_GK50_Body_150", BODY_R, FOOT_H, BODY_H);
        addMountingFlange("RIEX_GK50_Flange", FLANGE_W, FOOT_H + BODY_H, FLANGE_H);
    } finally {
        EndBlock();
        if (prevMat) {
            try { ActiveMaterial.Make(prevMat, prevThick); } catch (e) {}
        }
    }

    try {
        Article.Name = LEG_NAME;
        Article.Code = "BS-LEG-GK50-150";
    } catch (e) {}

    Action.Commit();
    try { ViewAll(); } catch (e) {}

    var outPath = resolveSavePath();
    try {
        Action.SaveModel(outPath);
        alert("Created and saved 150 mm leg fragment:\n" + outPath);
    } catch (e) {
        alert("Created 150 mm leg geometry in model, but auto-save failed (" + e.message + ").\nSave manually as: " + LEG_NAME + ".fr3d");
    }
}

main();
