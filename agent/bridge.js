// Bazis MCP HTTP bridge agent script.
// Run inside Bazis-Mebelshchik 2022 via the "Scripts" menu.
// Listens on 0.0.0.0:18765 (configurable) so an MCP server running on macOS
// (Parallels host or LAN) or locally on Windows can drive Bazis over HTTP.

var http = require("http");
var os = require("os");
var fs = require("fs");
var path = require("path");

var HOST = getEnv("BAZIS_BRIDGE_HOST", "127.0.0.1");
var PORT = Number(getEnv("BAZIS_BRIDGE_PORT", "18765"));
var NO_AUTH = getEnv("BAZIS_BRIDGE_NO_AUTH", "") === "1";
var TOKEN = getEnv("BAZIS_BRIDGE_TOKEN", "") || generateToken();
var ENDPOINT_FILES = resolveEndpointFiles();
var IPC_DIR = resolveIpcDir();
var IPC_POLL_MS = Number(getEnv("BAZIS_BRIDGE_IPC_POLL_MS", "50"));

var startedAt = Date.now();
var requestCount = 0;
var server = null;
var ipcTimer = null;
var stopped = false;

function getEnv(key, fallback) {
    if (typeof process !== "undefined" && process.env && process.env[key]) {
        return String(process.env[key]);
    }
    return fallback;
}

function generateToken() {
    try {
        var crypto = require("crypto");
        return crypto.randomBytes(16).toString("hex");
    } catch (e) {
        var s = "";
        for (var i = 0; i < 32; i++) {
            s += Math.floor(Math.random() * 16).toString(16);
        }
        return s;
    }
}

function resolveEndpointFiles() {
    var files = [];
    var explicit = getEnv("BAZIS_BRIDGE_ENDPOINT_FILE", "");
    if (explicit) {
        files.push(explicit);
    }
    // Parallels shared Mac workspace path:
    var repoDir = "Z:\\Documents\\Claude\\bazis-mcp";
    try {
        if (fs.existsSync(repoDir)) {
            files.push(path.join(repoDir, ".bridge-endpoint.json"));
        }
    } catch (e) {
        // Ignore if Z: is not mounted.
    }
    return files;
}

function getLocalIPv4Addresses() {
    var ips = [];
    try {
        var ifaces = os.networkInterfaces();
        var names = Object.keys(ifaces);
        for (var i = 0; i < names.length; i++) {
            var entries = ifaces[names[i]] || [];
            for (var j = 0; j < entries.length; j++) {
                var entry = entries[j];
                var isV4 = entry.family === "IPv4" || entry.family === 4;
                if (isV4 && !entry.internal && entry.address) {
                    ips.push(entry.address);
                }
            }
        }
    } catch (e) {
        // Fallback silently.
    }
    return ips;
}

function buildAdvertisedUrls() {
    var urls = [];
    if (HOST === "0.0.0.0" || HOST === "::") {
        var ips = getLocalIPv4Addresses();
        for (var i = 0; i < ips.length; i++) {
            urls.push("http://" + ips[i] + ":" + PORT);
        }
        urls.push("http://127.0.0.1:" + PORT);
    } else {
        urls.push("http://" + HOST + ":" + PORT);
    }
    return urls;
}

function resolveIpcDir() {
    var explicit = getEnv("BAZIS_BRIDGE_IPC_DIR", "");
    if (explicit) {
        return explicit;
    }
    var repoDir = "Z:\\Documents\\Claude\\bazis-mcp";
    try {
        if (fs.existsSync(repoDir)) {
            return path.join(repoDir, ".bridge-ipc");
        }
    } catch (e) {
        // Ignore if Z: is not mounted.
    }
    return null;
}

function cleanIpcDir() {
    if (!IPC_DIR) return;
    try {
        if (!fs.existsSync(IPC_DIR)) return;
        var entries = fs.readdirSync(IPC_DIR);
        for (var i = 0; i < entries.length; i++) {
            var name = entries[i];
            if (name.indexOf("req-") === 0 || name.indexOf("res-") === 0) {
                try { fs.unlinkSync(path.join(IPC_DIR, name)); } catch (e) {}
            }
        }
    } catch (e) {
        // Ignore cleanup errors.
    }
}

function initIpcDir() {
    if (!IPC_DIR) return false;
    try {
        if (!fs.existsSync(IPC_DIR)) {
            fs.mkdirSync(IPC_DIR);
        }
        cleanIpcDir();
        return true;
    } catch (e) {
        system.log("Bazis MCP bridge: failed to init IPC dir " + IPC_DIR + ": " + e);
        return false;
    }
}

function writeEndpointFiles(urls) {
    var payload = JSON.stringify({
        host: HOST,
        port: PORT,
        urls: urls,
        ipcDir: IPC_DIR ? ".bridge-ipc" : null,
        token: NO_AUTH ? null : TOKEN,
        hostname: safeGet(function () { return os.hostname(); }, ""),
        apiVersion: safeGet(function () { return system.apiVersion; }, null),
        startedAt: new Date(startedAt).toISOString()
    }, null, 2);

    for (var i = 0; i < ENDPOINT_FILES.length; i++) {
        try {
            fs.writeFileSync(ENDPOINT_FILES[i], payload, "utf8");
        } catch (e) {
            system.log("Bazis MCP bridge: failed to write endpoint file " + ENDPOINT_FILES[i] + ": " + e);
        }
    }
}

function removeEndpointFiles() {
    for (var i = 0; i < ENDPOINT_FILES.length; i++) {
        try {
            if (fs.existsSync(ENDPOINT_FILES[i])) {
                fs.unlinkSync(ENDPOINT_FILES[i]);
            }
        } catch (e) {
            // Ignore cleanup errors.
        }
    }
}

function round3(n) {
    if (typeof n !== "number" || isNaN(n)) return null;
    return Math.round(n * 1000) / 1000;
}

function vecToObj(v) {
    if (!v) return null;
    return {
        x: round3(v.x),
        y: round3(v.y),
        z: round3(v.z)
    };
}

function safeGet(fn, fallback) {
    try {
        return fn();
    } catch (e) {
        return fallback;
    }
}

function listLength(col) {
    if (!col) return 0;
    var c = safeGet(function () { return col.Count; }, undefined);
    if (typeof c === "number") return c;
    var l = safeGet(function () { return col.length; }, undefined);
    if (typeof l === "number") return l;
    return 0;
}

function serializeButts(panel) {
    var result = [];
    var buttsObj = safeGet(function () { return panel.Butts; }, null);
    if (!buttsObj) return result;
    var count = safeGet(function () { return buttsObj.Count; }, 0);
    if (count <= 0 || count > 1000) return result;
    for (var i = 0; i < count; i++) {
        var b = safeGet(function () { return buttsObj.Butts ? buttsObj.Butts[i] : buttsObj[i]; }, null);
        if (b) {
            result.push({
                elemIndex: safeGet(function () { return b.ElemIndex; }, null),
                sign: safeGet(function () { return b.Sign; }, ""),
                material: safeGet(function () { return b.Material; }, ""),
                thickness: round3(safeGet(function () { return b.Thickness; }, null)),
                width: round3(safeGet(function () { return b.Width; }, null)),
                clipPanel: safeGet(function () { return b.ClipPanel; }, null)
            });
        }
    }
    return result;
}

function serializeCuts(panel) {
    var result = [];
    var cutsObj = safeGet(function () { return panel.Cuts; }, null);
    if (!cutsObj) return result;
    var count = safeGet(function () { return cutsObj.Count; }, 0);
    if (count <= 0 || count > 500) return result;
    for (var i = 0; i < count; i++) {
        var c = safeGet(function () { return cutsObj.Cuts ? cutsObj.Cuts[i] : cutsObj[i]; }, null);
        if (c) {
            result.push({
                name: safeGet(function () { return c.Name; }, ""),
                sign: safeGet(function () { return c.Sign; }, ""),
                frontSide: safeGet(function () { return c.FrontSide; }, null),
                trajectoryCount: safeGet(function () { return c.Trajectory ? c.Trajectory.Count : 0; }, 0),
                contourCount: safeGet(function () { return c.Contour ? c.Contour.Count : 0; }, 0)
            });
        }
    }
    return result;
}

function serializeContourEdges(panel) {
    var edges = [];
    var contour = safeGet(function () { return panel.Contour; }, null);
    if (!contour) return edges;
    var count = safeGet(function () { return contour.Count; }, 0);
    if (count <= 0 || count > 500) return edges;
    for (var i = 0; i < count; i++) {
        var el = safeGet(function () { return contour.Objects[i]; }, null);
        if (!el) continue;
        var item = {
            index: i,
            type: safeGet(function () { return el.ElType; }, null)
        };
        if (safeGet(function () { return el.IsLine(); }, false)) {
            var ln = safeGet(function () { return el.AsLine(); }, null);
            if (ln) {
                item.kind = "line";
                item.x1 = round3(safeGet(function () { return ln.Pos1.x; }, null));
                item.y1 = round3(safeGet(function () { return ln.Pos1.y; }, null));
                item.x2 = round3(safeGet(function () { return ln.Pos2.x; }, null));
                item.y2 = round3(safeGet(function () { return ln.Pos2.y; }, null));
                if (item.x1 !== null && item.x2 !== null && item.y1 !== null && item.y2 !== null) {
                    item.length = round3(Math.sqrt(Math.pow(item.x2 - item.x1, 2) + Math.pow(item.y2 - item.y1, 2)));
                }
            }
        } else if (safeGet(function () { return el.IsCircle(); }, false)) {
            item.kind = "circle";
        } else if (safeGet(function () { return el.IsArc(); }, false)) {
            item.kind = "arc";
        }
        edges.push(item);
    }
    return edges;
}

function serializeObject(obj, depth, maxDepth) {
    if (!obj) return null;
    var isList = !!safeGet(function () { return obj.List; }, false);
    var panel = safeGet(function () { return obj.AsPanel; }, null);
    var item = {
        uid: safeGet(function () { return obj.UID; }, null),
        name: safeGet(function () { return obj.Name; }, ""),
        artPos: safeGet(function () { return obj.ArtPos; }, ""),
        isList: isList,
        isPanel: !!panel,
        visible: safeGet(function () { return obj.Visible; }, true),
        selected: safeGet(function () { return obj.Selected; }, false),
        position: vecToObj(safeGet(function () { return obj.Position; }, null)),
        gSize: vecToObj(safeGet(function () { return obj.GSize; }, null)),
        gabMin: vecToObj(safeGet(function () { return obj.GabMin; }, null)),
        gabMax: vecToObj(safeGet(function () { return obj.GabMax; }, null))
    };

    if (panel) {
        var butts = serializeButts(panel);
        var cuts = serializeCuts(panel);
        item.panel = {
            thickness: round3(safeGet(function () { return panel.Thickness; }, null)),
            contourWidth: round3(safeGet(function () { return panel.ContourWidth; }, null)),
            contourHeight: round3(safeGet(function () { return panel.ContourHeight; }, null)),
            contourCount: safeGet(function () { return panel.Contour ? panel.Contour.Count : 0; }, 0),
            materialName: safeGet(function () { return panel.MaterialName; }, ""),
            materialWidth: round3(safeGet(function () { return panel.MaterialWidth; }, null)),
            textureOrientation: safeGet(function () { return panel.TextureOrientation; }, null),
            isRectangle: safeGet(function () { return panel.IsContourRectangle; }, null),
            buttsCount: butts.length,
            butts: butts,
            cutsCount: cuts.length,
            cuts: cuts,
            plasticsCount: safeGet(function () { return panel.Plastics ? panel.Plastics.Count : 0; }, 0)
        };
    }

    if (isList && depth < maxDepth) {
        var list = safeGet(function () { return obj.AsList(); }, null);
        if (list) {
            var count = safeGet(function () { return list.Count; }, 0);
            var children = [];
            for (var i = 0; i < count; i++) {
                var child = safeGet(function () { return list.Objects[i]; }, null);
                if (child) {
                    children.push(serializeObject(child, depth + 1, maxDepth));
                }
            }
            item.children = children;
        }
    }

    return item;
}

function findObjectByUidRecursive(listObj, targetUid) {
    var count = safeGet(function () { return listObj.Count; }, 0);
    for (var i = 0; i < count; i++) {
        var child = safeGet(function () { return listObj.Objects[i]; }, null);
        if (!child) continue;
        var uid = safeGet(function () { return child.UID; }, null);
        if (uid === targetUid) return child;
        var isList = !!safeGet(function () { return child.List; }, false);
        if (isList) {
            var nested = safeGet(function () { return child.AsList(); }, null);
            if (nested) {
                var found = findObjectByUidRecursive(nested, targetUid);
                if (found) return found;
            }
        }
    }
    return null;
}

function findObjectByUid(uid) {
    return findObjectByUidRecursive(Model, Number(uid));
}

function getModelSnapshot(maxDepth) {
    var depthLimit = typeof maxDepth === "number" && !isNaN(maxDepth) ? maxDepth : 8;
    var objects = [];
    var count = safeGet(function () { return Model.Count; }, 0);
    for (var i = 0; i < count; i++) {
        var obj = safeGet(function () { return Model.Objects[i]; }, null);
        if (obj) {
            objects.push(serializeObject(obj, 0, depthLimit));
        }
    }
    return {
        filename: safeGet(function () { return Action.ModelFilename || ModelFilename; }, ""),
        article: {
            name: safeGet(function () { return Article.Name; }, ""),
            code: safeGet(function () { return Article.Code; }, ""),
            orderName: safeGet(function () { return Article.OrderName; }, ""),
            orderCode: safeGet(function () { return Article.OrderCode; }, "")
        },
        activeMaterial: {
            name: safeGet(function () { return ActiveMaterial.Name; }, ""),
            thickness: round3(safeGet(function () { return ActiveMaterial.Thickness; }, null)),
            width: round3(safeGet(function () { return ActiveMaterial.Width; }, null))
        },
        bounds: {
            size: vecToObj(safeGet(function () { return Model.GSize; }, null)),
            min: vecToObj(safeGet(function () { return Model.GMin; }, null)),
            max: vecToObj(safeGet(function () { return Model.GMax; }, null))
        },
        count: count,
        selectionCount: safeGet(function () { return Model.SelectionCount; }, 0),
        objects: objects
    };
}

function getBom() {
    var panels = [];
    var byMaterial = {};

    function walk(listObj, trail) {
        var count = safeGet(function () { return listObj.Count; }, 0);
        for (var i = 0; i < count; i++) {
            var obj = safeGet(function () { return listObj.Objects[i]; }, null);
            if (!obj) continue;
            var objName = safeGet(function () { return obj.Name; }, "");
            var panel = safeGet(function () { return obj.AsPanel; }, null);
            if (panel) {
                var w = round3(safeGet(function () { return panel.ContourWidth; }, 0)) || 0;
                var h = round3(safeGet(function () { return panel.ContourHeight; }, 0)) || 0;
                var t = round3(safeGet(function () { return panel.Thickness; }, 0)) || 0;
                var matRaw = safeGet(function () { return panel.MaterialName; }, "");
                var matClean = safeGet(function () { return ExtractMatName(matRaw); }, matRaw);
                var matCode = safeGet(function () { return ExtractMatCode(matRaw); }, "");
                var butts = serializeButts(panel);
                var areaM2 = round3((w * h) / 1000000);

                panels.push({
                    uid: safeGet(function () { return obj.UID; }, null),
                    name: objName,
                    artPos: safeGet(function () { return obj.ArtPos; }, ""),
                    path: trail.join(" / "),
                    width: w,
                    height: h,
                    thickness: t,
                    areaM2: areaM2,
                    material: matClean || matRaw,
                    materialRaw: matRaw,
                    materialCode: matCode,
                    textureOrientation: safeGet(function () { return panel.TextureOrientation; }, null),
                    isRectangle: safeGet(function () { return panel.IsContourRectangle; }, null),
                    butts: butts,
                    cutsCount: safeGet(function () { return panel.Cuts ? panel.Cuts.Count : 0; }, 0),
                    plasticsCount: safeGet(function () { return panel.Plastics ? panel.Plastics.Count : 0; }, 0)
                });

                var key = (matClean || matRaw || "Unknown") + " (" + t + " mm)";
                if (!byMaterial[key]) {
                    byMaterial[key] = { material: matClean || matRaw, thickness: t, count: 0, totalAreaM2: 0 };
                }
                byMaterial[key].count++;
                byMaterial[key].totalAreaM2 = round3(byMaterial[key].totalAreaM2 + (w * h) / 1000000);
            }
            var isList = !!safeGet(function () { return obj.List; }, false);
            if (isList) {
                var nested = safeGet(function () { return obj.AsList(); }, null);
                if (nested) {
                    walk(nested, trail.concat([objName || "Block"]));
                }
            }
        }
    }

    walk(Model, []);

    var summary = [];
    var keys = Object.keys(byMaterial);
    for (var k = 0; k < keys.length; k++) {
        summary.push(byMaterial[keys[k]]);
    }

    return {
        articleName: safeGet(function () { return Article.Name; }, ""),
        panelCount: panels.length,
        materialSummary: summary,
        panels: panels
    };
}

function handleCreatePanel(body) {
    var orientation = body.orientation || "horiz";
    if (body.material && body.material.name && typeof body.material.thickness === "number") {
        ActiveMaterial.Make(body.material.name, body.material.thickness);
    }

    var panel = null;
    if (orientation === "horiz") {
        panel = AddHorizPanel(
            Number(body.x1 || 0),
            Number(body.z1 || 0),
            Number(body.x2 || 600),
            Number(body.z2 || 400),
            Number(body.y || 0)
        );
    } else if (orientation === "vert") {
        panel = AddVertPanel(
            Number(body.z1 || 0),
            Number(body.y1 || 0),
            Number(body.z2 || 400),
            Number(body.y2 || 700),
            Number(body.x || 0)
        );
    } else if (orientation === "front") {
        panel = AddFrontPanel(
            Number(body.x1 || 0),
            Number(body.y1 || 0),
            Number(body.x2 || 600),
            Number(body.y2 || 700),
            Number(body.z || 0)
        );
    } else {
        throw new Error("Unsupported orientation: " + orientation + " (expected horiz, vert, or front)");
    }

    if (body.name) {
        panel.Name = String(body.name);
    }
    if (typeof body.thickness === "number") {
        panel.Thickness = body.thickness;
    }
    if (typeof body.textureOrientation === "number") {
        panel.TextureOrientation = body.textureOrientation;
    }
    panel.Build();

    var snapshot;
    if (body.commit !== false) {
        var prevCount = safeGet(function () { return Model.Count; }, 0);
        Action.Commit();
        var committed = null;
        var newCount = safeGet(function () { return Model.Count; }, 0);
        if (newCount > prevCount) {
            committed = safeGet(function () { return Model.Objects[newCount - 1]; }, null);
        }
        snapshot = committed ? serializeObject(committed, 0, 1) : null;
    } else {
        snapshot = serializeObject(panel, 0, 1);
    }

    if (body.viewAll) {
        ViewAll();
    }

    return snapshot;
}

function handleCreateCarcass(body) {
    var name = body.name || "Cabinet";
    var width = Number(body.width || 600);
    var height = Number(body.height || 720);
    var depth = Number(body.depth || 560);
    var ox = Number(body.x || 0);
    var oy = Number(body.y || 0);
    var oz = Number(body.z || 0);

    var t = typeof body.thickness === "number"
        ? body.thickness
        : (safeGet(function () { return ActiveMaterial.Thickness; }, 16) || 16);

    if (body.materialName) {
        ActiveMaterial.Make(String(body.materialName), t);
    } else if (typeof body.thickness === "number") {
        var curMat = safeGet(function () { return ActiveMaterial.Name; }, "LDSP");
        ActiveMaterial.Make(curMat, t);
    }

    var topMode = body.topMode || "between";       // "between" | "overlay"
    var bottomMode = body.bottomMode || "between"; // "between" | "underlay"
    var plinthHeight = Number(body.plinthHeight || 0);
    var addPlinth = body.addPlinth !== false && plinthHeight > 0;
    var plinthSetback = Number(body.plinthSetback !== undefined ? body.plinthSetback : 30);

    var hasBack = body.backPanel !== false;
    var backThickness = Number(body.backThickness || 4);
    var backInset = Number(body.backInset || 0);
    var shelvesCount = Math.max(0, Math.floor(Number(body.shelves || 0)));
    var shelfSetback = Number(body.shelfSetback !== undefined ? body.shelfSetback : 10);

    if (width <= t * 2 || height <= t * 2 + plinthHeight || depth <= 20) {
        throw new Error("Cabinet dimensions are too small for material thickness " + t + " mm");
    }

    var sideY1 = oy + (bottomMode === "underlay" ? plinthHeight + t : 0);
    var sideY2 = oy + height - (topMode === "overlay" ? t : 0);
    var bottomY = oy + plinthHeight;
    var topY = oy + height - t;

    var innerX1 = ox + t;
    var innerX2 = ox + width - t;
    var zStart = oz + (hasBack && backInset === 0 ? backThickness : 0);
    var zEnd = oz + depth;

    var prevCount = safeGet(function () { return Model.Count; }, 0);
    var prevMatName = safeGet(function () { return ActiveMaterial.Name; }, "");
    var prevMatThick = safeGet(function () { return ActiveMaterial.Thickness; }, t);

    BeginBlock(name);
    try {
        // Left & right sides
        var leftSide = AddVertPanel(zStart, sideY1, zEnd, sideY2, ox);
        leftSide.Name = "Left Side";
        leftSide.Build();

        var rightSide = AddVertPanel(zStart, sideY1, zEnd, sideY2, ox + width - t);
        rightSide.Name = "Right Side";
        rightSide.Build();

        // Bottom
        var bX1 = bottomMode === "underlay" ? ox : innerX1;
        var bX2 = bottomMode === "underlay" ? ox + width : innerX2;
        var bottom = AddHorizPanel(bX1, zStart, bX2, zEnd, bottomY);
        bottom.Name = "Bottom";
        bottom.Build();

        // Top
        var tX1 = topMode === "overlay" ? ox : innerX1;
        var tX2 = topMode === "overlay" ? ox + width : innerX2;
        var top = AddHorizPanel(tX1, zStart, tX2, zEnd, topY);
        top.Name = "Top";
        top.Build();

        // Plinth
        if (addPlinth) {
            var plinthZ = Math.max(zStart, zEnd - plinthSetback - t);
            var plinth = AddFrontPanel(innerX1, oy, innerX2, oy + plinthHeight, plinthZ);
            plinth.Name = "Plinth";
            plinth.Build();
        }

        // Internal shelves
        if (shelvesCount > 0) {
            var innerBottom = bottomY + t;
            var innerTop = topY;
            var usableH = innerTop - innerBottom;
            var step = usableH / (shelvesCount + 1);
            var shelfZ1 = oz + (hasBack ? backInset + backThickness : 0);
            var shelfZ2 = Math.max(shelfZ1 + 10, zEnd - shelfSetback);
            for (var s = 1; s <= shelvesCount; s++) {
                var sy = innerBottom + step * s - t / 2;
                var shelf = AddHorizPanel(innerX1, shelfZ1, innerX2, shelfZ2, sy);
                shelf.Name = "Shelf " + s;
                shelf.Build();
            }
        }

        // Back panel
        if (hasBack) {
            if (body.backMaterialName) {
                ActiveMaterial.Make(String(body.backMaterialName), backThickness);
            } else {
                ActiveMaterial.Make("HDF / Back panel", backThickness);
            }
            var backX1 = backInset > 0 ? innerX1 : ox + 2;
            var backX2 = backInset > 0 ? innerX2 : ox + width - 2;
            var backY1 = backInset > 0 ? bottomY + t : bottomY + 2;
            var backY2 = backInset > 0 ? topY : oy + height - 2;
            var backZ = oz + backInset;
            var back = AddFrontPanel(backX1, backY1, backX2, backY2, backZ);
            back.Name = "Back Panel";
            back.Thickness = backThickness;
            back.Build();

            // Restore carcass material
            if (prevMatName) {
                ActiveMaterial.Make(prevMatName, prevMatThick);
            }
        }
    } finally {
        EndBlock();
    }

    Action.Commit();
    if (body.viewAll !== false) {
        ViewAll();
    }

    var newCount = safeGet(function () { return Model.Count; }, 0);
    var created = newCount > prevCount ? safeGet(function () { return Model.Objects[newCount - 1]; }, null) : null;
    return created ? serializeObject(created, 0, 4) : null;
}

function handleDeleteObject(body) {
    var uids = [];
    if (Array.isArray(body.uids)) {
        uids = body.uids;
    } else if (body.uid !== undefined && body.uid !== null) {
        uids = [body.uid];
    } else {
        throw new Error("Provide 'uid' or 'uids' array");
    }

    var deleted = [];
    var notFound = [];

    for (var i = 0; i < uids.length; i++) {
        var uid = Number(uids[i]);
        var obj = findObjectByUid(uid);
        if (!obj) {
            notFound.push(uid);
            continue;
        }
        var name = safeGet(function () { return obj.Name; }, "");
        DeleteObject(obj);
        deleted.push({ uid: uid, name: name });
    }

    if (deleted.length > 0 && body.commit !== false) {
        Action.Commit();
    }

    return { deleted: deleted, notFound: notFound };
}

function handleTransformObject(body) {
    if (body.uid === undefined || body.uid === null) {
        throw new Error("Provide numeric 'uid'");
    }
    var uid = Number(body.uid);
    var obj = findObjectByUid(uid);
    if (!obj) {
        throw new Error("Object with UID " + uid + " not found");
    }

    if (safeGet(function () { return obj.List; }, false)) {
        Undo.RecursiveChanging(obj);
    } else {
        Undo.Changing(obj);
    }

    if (body.name !== undefined) {
        obj.Name = String(body.name);
    }
    if (typeof body.visible === "boolean") {
        obj.Visible = body.visible;
    }
    if (body.translate) {
        var dx = Number(body.translate.x || 0);
        var dy = Number(body.translate.y || 0);
        var dz = Number(body.translate.z || 0);
        obj.TranslateGCS(NewVector(dx, dy, dz));
    }
    if (body.rotate && typeof body.rotate.angle === "number") {
        var axis = String(body.rotate.axis || "y").toLowerCase();
        var angle = Number(body.rotate.angle);
        if (axis === "x") obj.RotateX(angle);
        else if (axis === "y") obj.RotateY(angle);
        else if (axis === "z") obj.RotateZ(angle);
        else throw new Error("Unsupported rotate axis: " + axis + " (expected x, y, or z)");
    }

    obj.Build();
    if (body.commit !== false) {
        Action.Commit();
    }

    var refreshed = findObjectByUid(uid);
    return refreshed ? serializeObject(refreshed, 0, 2) : null;
}

function handleInspect(body) {
    var inspector = NewModelInspector();
    var opts = body || {};
    var optionMap = [
        ["objIntersection", "ObjIntersectionAnalyze"],
        ["fastIntersection", "FastIntersectionAnalyze"],
        ["fastIncorrect", "FastIncorrectAnalyze"],
        ["panelNotFixed", "PanelNotFixedAnalyze"],
        ["panelTooLarge", "PanelTooLargeAnalyze"],
        ["plasticTooLarge", "PlasticTooLargeAnalyze"],
        ["matNotExists", "MatNotExistsAnalyze"],
        ["matOutOfStock", "MatOutOfStockAnalyze"]
    ];
    for (var i = 0; i < optionMap.length; i++) {
        var key = optionMap[i][0];
        var prop = optionMap[i][1];
        if (typeof opts[key] === "boolean") {
            try { inspector.Options[prop] = opts[key]; } catch (e) {}
        }
    }

    inspector.Run(Model);

    var errors = [];
    var errList = inspector.ErrorList;
    var errCount = listLength(errList);
    for (var j = 0; j < errCount; j++) {
        var err = safeGet(function () { return errList[j]; }, null);
        if (!err) continue;
        var objUids = [];
        var errObjCount = safeGet(function () { return err.ErrorObjectsCount; }, 0);
        for (var k = 0; k < errObjCount; k++) {
            var eo = safeGet(function () { return err.ErrorObjects[k]; }, null);
            if (eo) {
                objUids.push(safeGet(function () { return eo.UID; }, null));
            }
        }
        errors.push({
            type: safeGet(function () { return err.ErrorType; }, null),
            message: safeGet(function () { return err.ErrorMessage; }, ""),
            objectsNames: safeGet(function () { return err.ObjectsNames; }, ""),
            objectUids: objUids
        });
    }

    return {
        errorCount: errors.length,
        errors: errors
    };
}

function handleScene(body) {
    var action = body.action;
    if (action === "view_all") {
        ViewAll();
        return { action: action, done: true };
    }
    if (action === "orient_camera") {
        var d = body.dir || { x: 1, y: -0.7, z: -1 };
        OrientCamera(NewVector(Number(d.x || 0), Number(d.y || 0), Number(d.z || 0)));
        return { action: action, done: true };
    }
    if (action === "new_model") {
        Action.NewModel();
        return { action: action, done: true };
    }
    if (action === "save_model") {
        if (!body.filename) throw new Error("Provide 'filename'");
        Action.SaveModel(String(body.filename));
        return { action: action, filename: String(body.filename), done: true };
    }
    if (action === "load_model") {
        if (!body.filename) throw new Error("Provide 'filename'");
        var ok = Action.LoadModel(String(body.filename));
        return { action: action, filename: String(body.filename), loaded: !!ok };
    }
    if (action === "save_project") {
        if (!body.filename) throw new Error("Provide 'filename'");
        Action.SaveProject(String(body.filename));
        return { action: action, filename: String(body.filename), done: true };
    }
    if (action === "load_project") {
        if (!body.filename) throw new Error("Provide 'filename'");
        var okProj = Action.LoadProject(String(body.filename));
        return { action: action, filename: String(body.filename), loaded: !!okProj };
    }
    if (action === "arrange_positions") {
        var mode = typeof body.mode === "number" ? body.mode : 0;
        var res = Action.ArrangePositions(mode, Model);
        Action.Commit();
        return { action: action, mode: mode, result: !!res };
    }
    throw new Error("Unsupported scene action: " + action);
}

function requirePanelByUid(uid) {
    if (uid === undefined || uid === null) {
        throw new Error("Provide numeric 'uid'");
    }
    var obj = findObjectByUid(Number(uid));
    if (!obj) {
        throw new Error("Object with UID " + uid + " not found");
    }
    var panel = safeGet(function () { return obj.AsPanel; }, null);
    if (!panel) {
        throw new Error("Object with UID " + uid + " is not a panel");
    }
    return { obj: obj, panel: panel, uid: Number(uid) };
}

function applyButtsToPanel(panel, opts) {
    var contour = safeGet(function () { return panel.Contour; }, null);
    var contourCount = contour ? safeGet(function () { return contour.Count; }, 0) : 0;
    if (contourCount <= 0) {
        throw new Error("Panel contour has no edges");
    }

    var edgeIndices = [];
    if (opts.edges === "all" || opts.edges === undefined || opts.edges === null) {
        for (var i = 0; i < contourCount; i++) edgeIndices.push(i);
    } else if (opts.edges === "visible") {
        var dist = typeof opts.visibilityDistance === "number" ? opts.visibilityDistance : 5;
        for (var v = 0; v < contourCount; v++) {
            if (safeGet(function () { return panel.IsButtVisible(v, dist); }, true)) {
                edgeIndices.push(v);
            }
        }
    } else if (Array.isArray(opts.edges)) {
        for (var k = 0; k < opts.edges.length; k++) {
            var idx = Number(opts.edges[k]);
            if (!isNaN(idx) && idx >= 0 && idx < contourCount) {
                edgeIndices.push(idx);
            }
        }
    } else {
        throw new Error("Unsupported 'edges' value (expected array of indices, 'all', or 'visible')");
    }

    if (opts.clearExisting === true) {
        try {
            if (panel.Butts && typeof panel.Butts.Clear === "function") {
                panel.Butts.Clear();
            }
        } catch (e) {}
    }

    var matName = String(opts.material || "PVC 2mm");
    var thickness = typeof opts.thickness === "number" ? opts.thickness : 2;
    var panelThick = safeGet(function () { return panel.Thickness; }, 16) || 16;
    var width = typeof opts.width === "number" ? opts.width : Math.max(panelThick + 3, 19);
    var sign = opts.sign !== undefined && opts.sign !== null ? String(opts.sign) : String(thickness);
    var clipPanel = opts.clipPanel !== false;

    var added = 0;
    for (var j = 0; j < edgeIndices.length; j++) {
        var b = panel.Butts.Add();
        b.ElemIndex = edgeIndices[j];
        b.Material = matName;
        b.Thickness = thickness;
        b.Width = width;
        b.Sign = sign;
        b.ClipPanel = clipPanel;
        if (typeof opts.overhung === "number") b.Overhung = opts.overhung;
        if (typeof opts.allowance === "number") b.Allowance = opts.allowance;
        added++;
    }
    return { added: added, edgeIndices: edgeIndices };
}

function handlePanelButt(body) {
    var found = requirePanelByUid(body.uid);
    var panel = found.panel;

    if (body.action === "inspect_edges") {
        return {
            uid: found.uid,
            name: safeGet(function () { return found.obj.Name; }, ""),
            contourWidth: round3(safeGet(function () { return panel.ContourWidth; }, null)),
            contourHeight: round3(safeGet(function () { return panel.ContourHeight; }, null)),
            edges: serializeContourEdges(panel),
            butts: serializeButts(panel)
        };
    }

    Undo.Changing(panel);
    var res = applyButtsToPanel(panel, body);
    panel.Build();
    if (body.commit !== false) {
        Action.Commit();
    }

    var refreshed = findObjectByUid(found.uid);
    var refPanel = refreshed ? safeGet(function () { return refreshed.AsPanel; }, null) : null;
    return {
        uid: found.uid,
        added: res.added,
        edgeIndices: res.edgeIndices,
        edges: refPanel ? serializeContourEdges(refPanel) : [],
        panel: refreshed ? serializeObject(refreshed, 0, 1) : null
    };
}

function handlePanelCut(body) {
    var found = requirePanelByUid(body.uid);
    var panel = found.panel;

    var name = String(body.name || "Groove");
    var width = Number(body.width !== undefined ? body.width : 4);
    var depth = Number(body.depth !== undefined ? body.depth : 8);
    if (width <= 0 || depth <= 0) {
        throw new Error("Groove 'width' and 'depth' must be positive numbers");
    }

    var contour = panel.Contour;
    var minPt = safeGet(function () { return contour.Min; }, { x: 0, y: 0 });
    var maxPt = safeGet(function () { return contour.Max; }, { x: panel.ContourWidth, y: panel.ContourHeight });
    var x1, y1, x2, y2;

    if (body.trajectory) {
        x1 = Number(body.trajectory.x1);
        y1 = Number(body.trajectory.y1);
        x2 = Number(body.trajectory.x2);
        y2 = Number(body.trajectory.y2);
    } else if (body.side) {
        var side = String(body.side).toLowerCase();
        var offset = Number(body.offset !== undefined ? body.offset : 15);
        var inset = Number(body.endInset || 0);
        if (side === "bottom" || side === "min_y") {
            x1 = minPt.x + inset; x2 = maxPt.x - inset;
            y1 = minPt.y + offset; y2 = y1;
        } else if (side === "top" || side === "max_y") {
            x1 = minPt.x + inset; x2 = maxPt.x - inset;
            y1 = maxPt.y - offset; y2 = y1;
        } else if (side === "left" || side === "min_x" || side === "back") {
            x1 = minPt.x + offset; x2 = x1;
            y1 = minPt.y + inset; y2 = maxPt.y - inset;
        } else if (side === "right" || side === "max_x" || side === "front") {
            x1 = maxPt.x - offset; x2 = x1;
            y1 = minPt.y + inset; y2 = maxPt.y - inset;
        } else {
            throw new Error("Unsupported 'side': " + side + " (expected left/right/top/bottom/back/front)");
        }
    } else {
        throw new Error("Provide 'trajectory' ({x1,y1,x2,y2}) or 'side' with 'offset'");
    }

    Undo.Changing(panel);
    var cut = panel.AddCut(name);
    if (body.sign) cut.Sign = String(body.sign);
    if (typeof body.frontSide === "boolean") {
        try { cut.FrontSide = body.frontSide; } catch (e) {}
    }
    cut.Trajectory.AddLine(x1, y1, x2, y2);
    // Centered rectangle profile of width x depth
    cut.Contour.AddRectangle(-width / 2, 0, width / 2, depth);
    panel.Build();

    if (body.commit !== false) {
        Action.Commit();
    }

    var refreshed = findObjectByUid(found.uid);
    return {
        uid: found.uid,
        cut: {
            name: name,
            width: width,
            depth: depth,
            trajectory: { x1: round3(x1), y1: round3(y1), x2: round3(x2), y2: round3(y2) }
        },
        panel: refreshed ? serializeObject(refreshed, 0, 1) : null
    };
}

function handlePanelCutout(body) {
    var found = requirePanelByUid(body.uid);
    var panel = found.panel;
    var shape = String(body.shape || "rect").toLowerCase();
    var mode = String(body.mode || "subtract").toLowerCase();

    Undo.Changing(panel);
    if (shape === "circle") {
        var cx = Number(body.cx);
        var cy = Number(body.cy);
        var radius = Number(body.radius);
        if (isNaN(cx) || isNaN(cy) || !(radius > 0)) {
            throw new Error("Circle cutout requires numeric cx, cy, and positive radius");
        }
        if (mode === "hole" || mode === "inner") {
            panel.Contour.AddCircle(cx, cy, radius);
        } else {
            var cTmp = NewContour();
            cTmp.AddCircle(cx, cy, radius);
            if (mode === "add") panel.Contour.Addition(cTmp);
            else panel.Contour.Subtraction(cTmp);
        }
    } else if (shape === "rect") {
        var x1 = Number(body.x1);
        var y1 = Number(body.y1);
        var x2 = Number(body.x2);
        var y2 = Number(body.y2);
        if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
            throw new Error("Rect cutout requires numeric x1, y1, x2, y2");
        }
        var rTmp = NewContour();
        if (typeof body.cornerRadius === "number" && body.cornerRadius > 0) {
            rTmp.AddRoundRect(x1, y1, x2, y2, body.cornerRadius);
        } else {
            rTmp.AddRectangle(x1, y1, x2, y2);
        }
        if (mode === "add") panel.Contour.Addition(rTmp);
        else panel.Contour.Subtraction(rTmp);
    } else {
        throw new Error("Unsupported cutout shape: " + shape + " (expected 'rect' or 'circle')");
    }

    panel.Build();
    if (body.commit !== false) {
        Action.Commit();
    }

    var refreshed = findObjectByUid(found.uid);
    return {
        uid: found.uid,
        shape: shape,
        mode: mode,
        panel: refreshed ? serializeObject(refreshed, 0, 1) : null
    };
}

function getFastenerRoots() {
    var roots = [];
    var envDir = getEnv("BAZIS_ACCESSORIES_DIR", "");
    if (envDir && fs.existsSync(envDir)) roots.push(envDir);
    var home = safeGet(function () { return os.homedir(); }, "");
    if (home) {
        var acc = path.join(home, "Documents", "Bazis", "Accessories");
        var frg = path.join(home, "Documents", "Bazis", "Fragments");
        try { if (fs.existsSync(acc)) roots.push(acc); } catch (e) {}
        try { if (fs.existsSync(frg)) roots.push(frg); } catch (e) {}
    }
    return roots;
}

function scanFastenerFiles(filterStr, maxItems) {
    var roots = getFastenerRoots();
    var filter = filterStr ? String(filterStr).toLowerCase() : "";
    var limit = maxItems || 300;
    var items = [];

    function walk(root, dir, depth) {
        if (depth > 4 || items.length >= limit) return;
        var list;
        try { list = fs.readdirSync(dir); } catch (e) { return; }
        for (var i = 0; i < list.length; i++) {
            if (items.length >= limit) return;
            var full = path.join(dir, list[i]);
            var st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (st.isDirectory()) {
                walk(root, full, depth + 1);
            } else if (/\.f3d$/i.test(list[i])) {
                var rel = full.slice(root.length + 1);
                if (!filter || rel.toLowerCase().indexOf(filter) !== -1 || list[i].toLowerCase().indexOf(filter) !== -1) {
                    var parts = rel.split(/[\\/]/);
                    items.push({
                        name: list[i].replace(/\.f3d$/i, ""),
                        category: parts.length > 1 ? parts.slice(0, -1).join("/") : path.basename(root),
                        relativePath: rel,
                        path: full
                    });
                }
            }
        }
    }

    for (var r = 0; r < roots.length; r++) {
        walk(roots[r], roots[r], 0);
    }
    return { roots: roots, count: items.length, files: items };
}

function resolveFastenerPath(fileSpec) {
    if (!fileSpec) throw new Error("Provide 'file' (path or fastener name from bazis_list_fasteners)");
    var spec = String(fileSpec);
    try {
        if (fs.existsSync(spec)) return spec;
    } catch (e) {}

    var roots = getFastenerRoots();
    for (var i = 0; i < roots.length; i++) {
        var candidate = path.join(roots[i], spec);
        try { if (fs.existsSync(candidate)) return candidate; } catch (e) {}
        if (!/\.f3d$/i.test(candidate)) {
            try { if (fs.existsSync(candidate + ".f3d")) return candidate + ".f3d"; } catch (e) {}
        }
    }

    var scanned = scanFastenerFiles(spec, 10);
    if (scanned.files.length > 0) {
        return scanned.files[0].path;
    }
    throw new Error("Fastener file not found: " + spec);
}

function computeSeamPoints(p1, p2, count, indent) {
    var b1Min = p1.GabMin, b1Max = p1.GabMax;
    var b2Min = p2.GabMin, b2Max = p2.GabMax;
    var tol = 2;
    var minX = Math.max(b1Min.x, b2Min.x) - tol;
    var maxX = Math.min(b1Max.x, b2Max.x) + tol;
    var minY = Math.max(b1Min.y, b2Min.y) - tol;
    var maxY = Math.min(b1Max.y, b2Max.y) + tol;
    var minZ = Math.max(b1Min.z, b2Min.z) - tol;
    var maxZ = Math.min(b1Max.z, b2Max.z) + tol;

    var oxMin = Math.max(b1Min.x, b2Min.x), oxMax = Math.min(b1Max.x, b2Max.x);
    var oyMin = Math.max(b1Min.y, b2Min.y), oyMax = Math.min(b1Max.y, b2Max.y);
    var ozMin = Math.max(b1Min.z, b2Min.z), ozMax = Math.min(b1Max.z, b2Max.z);

    if (maxX < minX || maxY < minY || maxZ < minZ) {
        throw new Error("Panels do not touch or overlap; provide explicit 'points' instead");
    }

    var cx = (oxMin + oxMax) / 2;
    var cy = (oyMin + oyMax) / 2;
    var cz = (ozMin + ozMax) / 2;
    var spanX = Math.max(0, oxMax - oxMin);
    var spanY = Math.max(0, oyMax - oyMin);
    var spanZ = Math.max(0, ozMax - ozMin);

    var n = Math.max(1, Math.floor(count || 2));
    var pts = [];
    var axis = "z", lo = ozMin, hi = ozMax;
    if (spanX >= spanY && spanX >= spanZ) { axis = "x"; lo = oxMin; hi = oxMax; }
    else if (spanY >= spanX && spanY >= spanZ) { axis = "y"; lo = oyMin; hi = oyMax; }

    var len = hi - lo;
    var effIndent = Math.min(indent !== undefined ? Number(indent) : 50, len / 3);
    for (var i = 0; i < n; i++) {
        var pos = n === 1
            ? (lo + hi) / 2
            : lo + effIndent + ((len - 2 * effIndent) * i) / (n - 1);
        pts.push({
            x: axis === "x" ? pos : cx,
            y: axis === "y" ? pos : cy,
            z: axis === "z" ? pos : cz
        });
    }
    return pts;
}

function handleListFasteners(query) {
    return scanFastenerFiles(query && query.filter ? query.filter : "", query && query.limit ? Number(query.limit) : 200);
}

function handleMountFastener(body) {
    var fPath = resolveFastenerPath(body.file);
    var furn = OpenFurniture(fPath);
    if (!furn) {
        throw new Error("OpenFurniture failed for: " + fPath);
    }

    var mode = String(body.mode || "between").toLowerCase();
    var mounted = [];
    var prevCount = safeGet(function () { return Model.Count; }, 0);

    if (mode === "between") {
        var p1 = requirePanelByUid(body.panel1Uid).panel;
        var p2 = requirePanelByUid(body.panel2Uid).panel;
        var pts = Array.isArray(body.points) && body.points.length > 0
            ? body.points
            : computeSeamPoints(p1, p2, body.count || 2, body.indent !== undefined ? body.indent : 50);

        for (var i = 0; i < pts.length; i++) {
            var pt = pts[i];
            var m = furn.Mount(p1, p2, Number(pt.x), Number(pt.y), Number(pt.z));
            mounted.push({
                point: { x: round3(Number(pt.x)), y: round3(Number(pt.y)), z: round3(Number(pt.z)) },
                ok: !!m
            });
        }
    } else if (mode === "plane") {
        var p = requirePanelByUid(body.panel1Uid).panel;
        var planePts = Array.isArray(body.points) ? body.points : [];
        if (planePts.length === 0) throw new Error("Provide 'points' array [{x,y,z,angle?}] for mode 'plane'");
        for (var j = 0; j < planePts.length; j++) {
            var pp = planePts[j];
            var m1 = furn.Mount1(p, Number(pp.x), Number(pp.y), Number(pp.z), Number(pp.angle || 0));
            mounted.push({
                point: { x: round3(Number(pp.x)), y: round3(Number(pp.y)), z: round3(Number(pp.z)), angle: Number(pp.angle || 0) },
                ok: !!m1
            });
        }
    } else if (mode === "scheme") {
        var sp1 = requirePanelByUid(body.panel1Uid).panel;
        var sp2 = requirePanelByUid(body.panel2Uid).panel;
        var posMap = { inside: 0, outside: 1, up: 2, down: 3 };
        var fPos = typeof body.position === "number"
            ? body.position
            : (posMap[String(body.position || "inside").toLowerCase()] || 0);
        var bp = body.basisPoint || { x: 0, y: 0, z: 0 };
        var ms = furn.MountScheme(sp1, sp2, fPos, NewVector(Number(bp.x || 0), Number(bp.y || 0), Number(bp.z || 0)));
        mounted.push({ scheme: true, position: fPos, ok: !!ms });
    } else if (mode === "box") {
        var pos = body.position || { x: 0, y: 0, z: 0 };
        var sz = body.size || { x: 100, y: 100, z: 100 };
        var az = body.axisZ || { x: 0, y: 0, z: 1 };
        var ay = body.axisY || { x: 0, y: 1, z: 0 };
        var mb = furn.MountBox(
            NewVector(Number(pos.x), Number(pos.y), Number(pos.z)),
            NewVector(Number(sz.x), Number(sz.y), Number(sz.z)),
            NewVector(Number(az.x), Number(az.y), Number(az.z)),
            NewVector(Number(ay.x), Number(ay.y), Number(ay.z))
        );
        mounted.push({ box: true, ok: !!mb });
    } else {
        throw new Error("Unsupported fastener mode: " + mode + " (expected between, plane, scheme, or box)");
    }

    if (body.commit !== false) {
        Action.Commit();
    }

    var created = [];
    var newCount = safeGet(function () { return Model.Count; }, 0);
    for (var c = prevCount; c < newCount; c++) {
        var co = safeGet(function () { return Model.Objects[c]; }, null);
        if (co) created.push(serializeObject(co, 0, 1));
    }

    return {
        file: fPath,
        mode: mode,
        mountedCount: mounted.length,
        mounted: mounted,
        createdObjects: created
    };
}

function resolveOpeningBounds(body) {
    if (body.carcassUid !== undefined && body.carcassUid !== null) {
        var obj = findObjectByUid(Number(body.carcassUid));
        if (!obj) throw new Error("Carcass object UID " + body.carcassUid + " not found");
        var mn = obj.GabMin;
        var mx = obj.GabMax;
        var wallT = typeof body.carcassThickness === "number" ? body.carcassThickness : 16;
        var plinthH = Number(body.plinthHeight || 0);
        return {
            x: mn.x,
            y: mn.y + plinthH,
            z: mn.z,
            width: mx.x - mn.x,
            height: (mx.y - mn.y) - plinthH,
            depth: mx.z - mn.z,
            wallT: wallT
        };
    }
    return {
        x: Number(body.x || 0),
        y: Number(body.y || 0),
        z: Number(body.z || 0),
        width: Number(body.width || 600),
        height: Number(body.height || 720),
        depth: Number(body.depth || 560),
        wallT: Number(body.carcassThickness || 16)
    };
}

function resolveMakerConfigPath(fileRef, libKey, extraDir) {
    var raw = String(fileRef || "").trim();
    if (!raw) throw new Error("Provide 'configFile' path");
    if (path.isAbsolute(raw)) {
        if (!fs.existsSync(raw)) throw new Error("Maker config file not found: " + raw);
        return path.resolve(raw);
    }

    var searchDirs = [];
    if (extraDir) searchDirs.push(String(extraDir));
    var defs = getLibraryDefs("");
    for (var i = 0; i < defs.length; i++) {
        if (defs[i].key === libKey) searchDirs.push(defs[i].path);
    }
    var bazisBase = getBazisDocumentsRoot();
    if (bazisBase) searchDirs.push(bazisBase);
    for (var e = 0; e < ENDPOINT_FILES.length; e++) {
        searchDirs.push(path.dirname(ENDPOINT_FILES[e]));
    }

    for (var d = 0; d < searchDirs.length; d++) {
        var candidate = path.resolve(path.join(searchDirs[d], raw));
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error("Maker config file '" + raw + "' not found in: " + searchDirs.join(", "));
}

function resolvePanelByUid(uid, label) {
    var obj = findObjectByUid(Number(uid));
    if (!obj) throw new Error(label + " UID " + uid + " not found");
    var p = safeGet(function () { return obj.AsPanel; }, null);
    if (!p) throw new Error(label + " UID " + uid + " is not a panel");
    return p;
}

function resolveSectionPanels(body) {
    var leftP = body.leftPanelUid !== undefined && body.leftPanelUid !== null
        ? resolvePanelByUid(body.leftPanelUid, "leftPanelUid") : null;
    var rightP = body.rightPanelUid !== undefined && body.rightPanelUid !== null
        ? resolvePanelByUid(body.rightPanelUid, "rightPanelUid") : null;
    var topP = body.topPanelUid !== undefined && body.topPanelUid !== null
        ? resolvePanelByUid(body.topPanelUid, "topPanelUid") : null;
    var bottomP = body.bottomPanelUid !== undefined && body.bottomPanelUid !== null
        ? resolvePanelByUid(body.bottomPanelUid, "bottomPanelUid") : null;

    if ((!leftP || !rightP || !topP || !bottomP) && body.carcassUid !== undefined && body.carcassUid !== null) {
        var carcass = findObjectByUid(Number(body.carcassUid));
        if (!carcass) throw new Error("Carcass object UID " + body.carcassUid + " not found");
        var panels = [];
        collectPanelsFromObject(carcass, panels);

        var verts = [];
        var horizs = [];
        for (var i = 0; i < panels.length; i++) {
            var p = panels[i];
            var mn = safeGet(function () { return p.GabMin; }, null);
            var mx = safeGet(function () { return p.GabMax; }, null);
            if (!mn || !mx) continue;
            var dx = mx.x - mn.x;
            var dy = mx.y - mn.y;
            var dz = mx.z - mn.z;
            if (dx <= dy && dx <= dz) {
                verts.push({ panel: p, minX: mn.x, maxX: mx.x });
            } else if (dy <= dx && dy <= dz) {
                horizs.push({ panel: p, minY: mn.y, maxY: mx.y });
            }
        }

        if (verts.length >= 2) {
            verts.sort(function (a, b) { return a.minX - b.minX; });
            if (!leftP) leftP = verts[0].panel;
            if (!rightP) rightP = verts[verts.length - 1].panel;
        }
        if (horizs.length >= 2) {
            horizs.sort(function (a, b) { return a.minY - b.minY; });
            if (!bottomP) bottomP = horizs[0].panel;
            if (!topP) topP = horizs[horizs.length - 1].panel;
        }
    }

    var missing = [];
    if (!leftP) missing.push("leftPanelUid");
    if (!rightP) missing.push("rightPanelUid");
    if (!topP) missing.push("topPanelUid");
    if (!bottomP) missing.push("bottomPanelUid");
    if (missing.length > 0) {
        throw new Error(
            "Native Bazis Maker requires 4 boundary panels (" + missing.join(", ") +
            " missing). Provide leftPanelUid, rightPanelUid, topPanelUid, bottomPanelUid or a carcassUid with left/right/top/bottom panels."
        );
    }

    return { left: leftP, right: rightP, top: topP, bottom: bottomP };
}

function runNativeMaker(kind, body) {
    var isBoxes = kind === "boxes";
    var fn = isBoxes
        ? (typeof NewBoxesMaker === "function" ? NewBoxesMaker : null)
        : (typeof NewDoorsMaker === "function" ? NewDoorsMaker : null);
    if (!fn) {
        throw new Error((isBoxes ? "NewBoxesMaker" : "NewDoorsMaker") + " is not available in this Bazis build");
    }

    var cfgPath = resolveMakerConfigPath(body.configFile, isBoxes ? "drawers" : "doors", body.dir || "");
    var bounds = resolveSectionPanels(body);
    var maker = fn(String(body.name || (isBoxes ? "BoxesMaker" : "DoorsMaker")));

    try { maker.ShowErrors = body.showErrors === true; } catch (e) {}
    if (!isBoxes) {
        try { maker.Silent = body.silent !== false; } catch (e) {}
    }

    var loaded = maker.Load(cfgPath);
    if (!loaded) {
        throw new Error((isBoxes ? "BoxesMaker" : "DoorsMaker") + ".Load() returned false for: " + cfgPath);
    }

    var prevCount = safeGet(function () { return Model.Count; }, 0);
    maker.Setup(bounds.left, bounds.right, bounds.top, bounds.bottom);
    Action.Commit();
    if (body.viewAll) ViewAll();

    var newCount = safeGet(function () { return Model.Count; }, 0);
    var created = [];
    for (var i = prevCount; i < newCount; i++) {
        var obj = safeGet(function () { return Model.Objects[i]; }, null);
        if (obj) created.push(serializeObject(obj, 0, 3));
    }

    return {
        mode: "maker",
        maker: isBoxes ? "BoxesMaker" : "DoorsMaker",
        configFile: cfgPath,
        boundaryUids: {
            left: safeGet(function () { return bounds.left.UID; }, null),
            right: safeGet(function () { return bounds.right.UID; }, null),
            top: safeGet(function () { return bounds.top.UID; }, null),
            bottom: safeGet(function () { return bounds.bottom.UID; }, null)
        },
        createdCount: created.length,
        created: created
    };
}

function handleAddDoors(body) {
    if (body && body.configFile) {
        return runNativeMaker("doors", body);
    }
    var bounds = resolveOpeningBounds(body);
    var count = body.count === 2 ? 2 : 1;
    var mountType = String(body.mountType || "overlay").toLowerCase(); // overlay | inset
    var t = typeof body.thickness === "number" ? body.thickness : 16;
    var gap = typeof body.gap === "number" ? body.gap : 2;
    var wallT = bounds.wallT;
    var blockName = String(body.name || (count === 2 ? "Double Doors" : "Door"));

    var prevMatName = safeGet(function () { return ActiveMaterial.Name; }, "");
    var prevMatThick = safeGet(function () { return ActiveMaterial.Thickness; }, t);
    if (body.materialName) {
        ActiveMaterial.Make(String(body.materialName), t);
    }

    var xStart, xEnd, yStart, yEnd, doorZ;
    if (mountType === "inset") {
        xStart = bounds.x + wallT + gap;
        xEnd = bounds.x + bounds.width - wallT - gap;
        yStart = bounds.y + wallT + gap;
        yEnd = bounds.y + bounds.height - wallT - gap;
        doorZ = bounds.z + bounds.depth - t - 1;
    } else {
        xStart = bounds.x + gap / 2;
        xEnd = bounds.x + bounds.width - gap / 2;
        yStart = bounds.y + gap / 2;
        yEnd = bounds.y + bounds.height - gap / 2;
        doorZ = bounds.z + bounds.depth + gap;
    }

    var totalW = xEnd - xStart;
    if (totalW <= 20 || (yEnd - yStart) <= 20) {
        throw new Error("Door opening is too small");
    }

    var prevCount = safeGet(function () { return Model.Count; }, 0);
    var handleFurn = body.handleFile ? OpenFurniture(resolveFastenerPath(body.handleFile)) : null;

    BeginBlock(blockName);
    try {
        var leafW = count === 2 ? (totalW - gap) / 2 : totalW;
        for (var i = 0; i < count; i++) {
            var lx1 = xStart + i * (leafW + gap);
            var lx2 = lx1 + leafW;
            var leaf = AddFrontPanel(lx1, yStart, lx2, yEnd, doorZ);
            leaf.Name = count === 2 ? (i === 0 ? "Left Door" : "Right Door") : "Door";
            leaf.Thickness = t;
            if (body.edgeMaterial) {
                applyButtsToPanel(leaf, {
                    edges: "all",
                    material: body.edgeMaterial,
                    thickness: typeof body.edgeThickness === "number" ? body.edgeThickness : 2,
                    clipPanel: true
                });
            }
            leaf.Build();

            if (handleFurn) {
                var isLeftLeaf = count === 2 ? (i === 0) : (body.hingeSide === "left");
                var hx = isLeftLeaf ? (lx2 - 45) : (lx1 + 45);
                var hy = yEnd - 80;
                try { handleFurn.Mount1(leaf, hx, hy, doorZ + t, 0); } catch (e) {}
            }
        }
    } finally {
        EndBlock();
        if (prevMatName) {
            ActiveMaterial.Make(prevMatName, prevMatThick);
        }
    }

    Action.Commit();
    if (body.viewAll) ViewAll();

    var newCount = safeGet(function () { return Model.Count; }, 0);
    var created = newCount > prevCount ? safeGet(function () { return Model.Objects[newCount - 1]; }, null) : null;
    return created ? serializeObject(created, 0, 3) : null;
}

function handleAddDrawers(body) {
    if (body && body.configFile) {
        return runNativeMaker("boxes", body);
    }
    var bounds = resolveOpeningBounds(body);
    var count = Math.max(1, Math.min(12, Math.floor(Number(body.count || 1))));
    var mountType = String(body.mountType || "overlay").toLowerCase();
    var wallT = bounds.wallT;
    var boxT = Number(body.boxThickness || 16);
    var bottomT = Number(body.bottomThickness || 4);
    var frontT = Number(body.frontThickness || 16);
    var slideClearance = Number(body.slideClearance !== undefined ? body.slideClearance : 13);
    var frontGap = Number(body.frontGap !== undefined ? body.frontGap : 3);
    var boxHeightRatio = Number(body.boxHeightRatio !== undefined ? body.boxHeightRatio : 0.72);
    var blockName = String(body.name || (count > 1 ? "Drawers (" + count + ")" : "Drawer"));

    var innerX1 = bounds.x + wallT + slideClearance;
    var innerX2 = bounds.x + bounds.width - wallT - slideClearance;
    var boxW = innerX2 - innerX1;
    var innerY1 = bounds.y + wallT;
    var innerY2 = bounds.y + bounds.height - wallT;
    var usableH = innerY2 - innerY1;
    var boxDepth = Number(body.boxDepth || Math.max(100, bounds.depth - 45));

    if (boxW <= boxT * 2 + 20 || usableH <= count * 40) {
        throw new Error("Drawer opening dimensions are too small");
    }

    var frontX1 = mountType === "inset" ? (bounds.x + wallT + frontGap) : (bounds.x + frontGap / 2);
    var frontX2 = mountType === "inset" ? (bounds.x + bounds.width - wallT - frontGap) : (bounds.x + bounds.width - frontGap / 2);
    var frontZ = mountType === "inset" ? (bounds.z + bounds.depth - frontT - 1) : (bounds.z + bounds.depth + 2);
    var boxZEnd = frontZ - 2;
    var boxZStart = Math.max(bounds.z + 10, boxZEnd - boxDepth);

    var totalFrontY1 = mountType === "inset" ? (innerY1 + frontGap) : (bounds.y + frontGap / 2);
    var totalFrontY2 = mountType === "inset" ? (innerY2 - frontGap) : (bounds.y + bounds.height - frontGap / 2);
    var frontH = ((totalFrontY2 - totalFrontY1) - frontGap * (count - 1)) / count;
    var slotH = usableH / count;

    var prevMatName = safeGet(function () { return ActiveMaterial.Name; }, "");
    var prevMatThick = safeGet(function () { return ActiveMaterial.Thickness; }, boxT);
    var prevCount = safeGet(function () { return Model.Count; }, 0);

    BeginBlock(blockName);
    try {
        for (var i = 0; i < count; i++) {
            BeginBlock("Drawer " + (i + 1));
            try {
                var sy1 = innerY1 + i * slotH + 10;
                var boxH = Math.max(40, Math.min(slotH - 25, slotH * boxHeightRatio));
                var sy2 = sy1 + boxH;

                if (body.materialName) ActiveMaterial.Make(String(body.materialName), boxT);
                else ActiveMaterial.Make(prevMatName || "LDSP", boxT);

                var dLeft = AddVertPanel(boxZStart, sy1, boxZEnd, sy2, innerX1);
                dLeft.Name = "Drawer Left";
                dLeft.Thickness = boxT;
                dLeft.Build();

                var dRight = AddVertPanel(boxZStart, sy1, boxZEnd, sy2, innerX2 - boxT);
                dRight.Name = "Drawer Right";
                dRight.Thickness = boxT;
                dRight.Build();

                var dBack = AddFrontPanel(innerX1 + boxT, sy1, innerX2 - boxT, sy2, boxZStart);
                dBack.Name = "Drawer Back";
                dBack.Thickness = boxT;
                dBack.Build();

                var dInnerFront = AddFrontPanel(innerX1 + boxT, sy1, innerX2 - boxT, sy2, boxZEnd - boxT);
                dInnerFront.Name = "Drawer Inner Front";
                dInnerFront.Thickness = boxT;
                dInnerFront.Build();

                // Drawer bottom
                ActiveMaterial.Make(String(body.bottomMaterialName || "HDF / Drawer Bottom"), bottomT);
                var dBottom = AddHorizPanel(innerX1 + 2, boxZStart + 2, innerX2 - 2, boxZEnd - 2, sy1 - bottomT);
                dBottom.Name = "Drawer Bottom";
                dBottom.Thickness = bottomT;
                dBottom.Build();

                // Facade front
                var fy1 = totalFrontY1 + i * (frontH + frontGap);
                var fy2 = fy1 + frontH;
                if (body.frontMaterialName) ActiveMaterial.Make(String(body.frontMaterialName), frontT);
                else ActiveMaterial.Make(body.materialName ? String(body.materialName) : (prevMatName || "LDSP"), frontT);

                var dFront = AddFrontPanel(frontX1, fy1, frontX2, fy2, frontZ);
                dFront.Name = "Drawer Front " + (i + 1);
                dFront.Thickness = frontT;
                if (body.edgeMaterial) {
                    applyButtsToPanel(dFront, {
                        edges: "all",
                        material: body.edgeMaterial,
                        thickness: typeof body.edgeThickness === "number" ? body.edgeThickness : 2,
                        clipPanel: true
                    });
                }
                dFront.Build();
            } finally {
                EndBlock();
            }
        }
    } finally {
        EndBlock();
        if (prevMatName) {
            ActiveMaterial.Make(prevMatName, prevMatThick);
        }
    }

    Action.Commit();
    if (body.viewAll) ViewAll();

    var newCount = safeGet(function () { return Model.Count; }, 0);
    var created = newCount > prevCount ? safeGet(function () { return Model.Objects[newCount - 1]; }, null) : null;
    return created ? serializeObject(created, 0, 4) : null;
}

function collectPanelsFromObject(obj, out) {
    if (!obj) return;
    var p = safeGet(function () { return obj.AsPanel; }, null);
    if (p) out.push(p);
    if (safeGet(function () { return obj.List; }, false)) {
        var list = safeGet(function () { return obj.AsList(); }, null);
        if (list) {
            var c = safeGet(function () { return list.Count; }, 0);
            for (var i = 0; i < c; i++) {
                collectPanelsFromObject(safeGet(function () { return list.Objects[i]; }, null), out);
            }
        }
    }
}

function handleMaterials(body) {
    var action = String((body && body.action) || "get").toLowerCase();

    if (action === "get") {
        var bom = getBom();
        return {
            activeMaterial: {
                name: safeGet(function () { return ActiveMaterial.Name; }, ""),
                thickness: round3(safeGet(function () { return ActiveMaterial.Thickness; }, null)),
                width: round3(safeGet(function () { return ActiveMaterial.Width; }, null))
            },
            usedMaterials: bom.materialSummary
        };
    }

    if (action === "set_active") {
        if (!body.name) throw new Error("Provide 'name' for set_active");
        var thick = typeof body.thickness === "number"
            ? body.thickness
            : (safeGet(function () { return ActiveMaterial.Thickness; }, 16) || 16);
        ActiveMaterial.Make(String(body.name), thick);
        if (typeof body.width === "number") {
            try { ActiveMaterial.Width = body.width; } catch (e) {}
        }
        return {
            activeMaterial: {
                name: safeGet(function () { return ActiveMaterial.Name; }, ""),
                thickness: round3(safeGet(function () { return ActiveMaterial.Thickness; }, null)),
                width: round3(safeGet(function () { return ActiveMaterial.Width; }, null))
            }
        };
    }

    if (action === "assign") {
        var uids = Array.isArray(body.uids) ? body.uids : (body.uid !== undefined ? [body.uid] : []);
        if (uids.length === 0) throw new Error("Provide 'uid' or 'uids' for assign");

        var panels = [];
        for (var i = 0; i < uids.length; i++) {
            var obj = findObjectByUid(Number(uids[i]));
            if (!obj) throw new Error("Object UID " + uids[i] + " not found");
            collectPanelsFromObject(obj, panels);
        }
        if (panels.length === 0) throw new Error("No panels found under the provided UID(s)");

        var updated = [];
        for (var j = 0; j < panels.length; j++) {
            var panel = panels[j];
            Undo.Changing(panel);
            if (body.name !== undefined) panel.MaterialName = String(body.name);
            if (typeof body.thickness === "number") panel.Thickness = body.thickness;
            if (typeof body.textureOrientation === "number") panel.TextureOrientation = body.textureOrientation;
            panel.Build();
            updated.push(safeGet(function () { return panel.UID; }, null));
        }

        if (body.commit !== false) {
            Action.Commit();
        }
        return { updatedCount: updated.length, updatedUids: updated };
    }

    throw new Error("Unsupported materials action: " + action + " (expected get, set_active, or assign)");
}

function csvEscape(val) {
    var s = val === null || val === undefined ? "" : String(val);
    if (s.indexOf(",") !== -1 || s.indexOf("\"") !== -1 || s.indexOf("\n") !== -1) {
        return "\"" + s.replace(/\"/g, "\"\"") + "\"";
    }
    return s;
}

function handleExport(body) {
    var format = String(body.format || "bom_csv").toLowerCase();
    var filename = body.filename ? String(body.filename) : "";
    if (!filename) throw new Error("Provide 'filename' (Windows path, e.g. 'Z:\\\\Documents\\\\Claude\\\\bazis-mcp\\\\out.csv')");

    if (format === "svg") {
        var found = requirePanelByUid(body.uid);
        var ie = NewImportExport();
        if (typeof body.curveQuality === "number") ie.SVG.CurveQuality = body.curveQuality;
        if (typeof body.groupElems === "boolean") ie.SVG.GroupElems = body.groupElems;
        var ok = ie.SVG.Save(filename, found.panel.Contour);
        return { format: "svg", uid: found.uid, filename: filename, saved: !!ok };
    }

    if (format === "bom_json") {
        var bomJson = getBom();
        fs.writeFileSync(filename, JSON.stringify(bomJson, null, 2), "utf8");
        return { format: "bom_json", filename: filename, panelCount: bomJson.panelCount, saved: true };
    }

    if (format === "bom_csv") {
        var bomCsv = getBom();
        var lines = ["UID,Name,Path,Width_mm,Height_mm,Thickness_mm,Area_m2,Material,ButtsCount,CutsCount"];
        for (var i = 0; i < bomCsv.panels.length; i++) {
            var p = bomCsv.panels[i];
            lines.push([
                p.uid, p.name, p.path, p.width, p.height, p.thickness,
                p.areaM2, p.material, p.butts.length, p.cutsCount
            ].map(csvEscape).join(","));
        }
        fs.writeFileSync(filename, lines.join("\r\n") + "\r\n", "utf8");
        return { format: "bom_csv", filename: filename, panelCount: bomCsv.panelCount, saved: true };
    }

    throw new Error("Unsupported export format: " + format + " (expected svg, bom_csv, or bom_json)");
}

function getScriptRoots(extraDir) {
    var roots = [];
    function pushUnique(dir) {
        if (!dir) return;
        try {
            if (!fs.existsSync(dir)) return;
            var norm = path.resolve(dir);
            for (var i = 0; i < roots.length; i++) {
                if (roots[i].toLowerCase() === norm.toLowerCase()) return;
            }
            roots.push(norm);
        } catch (e) {}
    }
    if (extraDir) pushUnique(String(extraDir));
    var envDir = getEnv("BAZIS_SCRIPTS_DIR", "");
    if (envDir) pushUnique(envDir);
    var home = safeGet(function () { return os.homedir(); }, "");
    if (home) {
        pushUnique(path.join(home, "Documents", "Bazis", "Scripts"));
    }
    pushUnique("Z:\\Documents\\Claude\\bazis-mcp\\scripts");
    return roots;
}

function scanScriptFiles(filterStr, maxItems, extraDir, includeBridge) {
    var roots = getScriptRoots(extraDir);
    var filter = filterStr ? String(filterStr).toLowerCase() : "";
    var limit = maxItems || 200;
    var items = [];

    function walk(root, dir, depth) {
        if (depth > 4 || items.length >= limit) return;
        var list;
        try { list = fs.readdirSync(dir); } catch (e) { return; }
        for (var i = 0; i < list.length; i++) {
            if (items.length >= limit) return;
            var entry = list[i];
            var full = path.join(dir, entry);
            var st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (st.isDirectory()) {
                if (entry === "node_modules" || entry === ".git") continue;
                walk(root, full, depth + 1);
            } else if (/\.js$/i.test(entry)) {
                if (!includeBridge && entry.toLowerCase() === "bridge.js") continue;
                var rel = full.slice(root.length + 1);
                if (!filter || rel.toLowerCase().indexOf(filter) !== -1 || entry.toLowerCase().indexOf(filter) !== -1) {
                    var parts = rel.split(/[\\/]/);
                    items.push({
                        name: entry,
                        category: parts.length > 1 ? parts.slice(0, -1).join("/") : path.basename(root),
                        relativePath: rel,
                        path: full,
                        sizeBytes: st.size
                    });
                }
            }
        }
    }

    for (var r = 0; r < roots.length; r++) {
        walk(roots[r], roots[r], 0);
    }
    return { roots: roots, count: items.length, files: items };
}

function resolveScriptPath(fileSpec, extraDir) {
    if (!fileSpec) {
        throw new Error("Provide 'file' (full path, relative path inside Bazis Scripts, or script name from bazis_list_scripts)");
    }
    var spec = String(fileSpec);
    try {
        if (fs.existsSync(spec)) {
            var st = fs.statSync(spec);
            if (!st.isDirectory()) return path.resolve(spec);
        }
    } catch (e) {}

    var roots = getScriptRoots(extraDir);
    for (var i = 0; i < roots.length; i++) {
        var candidate = path.join(roots[i], spec);
        try { if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) return path.resolve(candidate); } catch (e) {}
        if (!/\.js$/i.test(candidate)) {
            try { if (fs.existsSync(candidate + ".js")) return path.resolve(candidate + ".js"); } catch (e) {}
        }
    }

    var scanned = scanScriptFiles(spec, 10, extraDir, false);
    if (scanned.files.length > 0) {
        return scanned.files[0].path;
    }
    throw new Error("Script file not found: " + spec);
}

function handleListScripts(query) {
    var q = query || {};
    return scanScriptFiles(
        q.filter || "",
        q.limit ? Number(q.limit) : 200,
        q.dir || "",
        q.includeBridge === "true" || q.includeBridge === true
    );
}

function handleRunScript(body) {
    var reqBody = body || {};
    var scriptPath = resolveScriptPath(reqBody.file, reqBody.dir);
    if (path.basename(scriptPath).toLowerCase() === "bridge.js") {
        throw new Error("Refusing to recursively launch bridge.js from inside the bridge");
    }

    var mode = String(reqBody.mode || "sandboxed").toLowerCase();
    var allowAlerts = reqBody.allowAlerts === true;
    var allowDialogs = reqBody.allowDialogs === true;
    var autoCommit = reqBody.commit !== false;
    var started = Date.now();
    var countBefore = safeGet(function () { return Model.Count; }, 0);

    if (mode === "include") {
        system.include(scriptPath);
        if (autoCommit) {
            Action.Commit();
        }
        return {
            file: scriptPath,
            mode: "include",
            committed: autoCommit,
            objectCountBefore: countBefore,
            objectCountAfter: safeGet(function () { return Model.Count; }, 0),
            durationMs: Date.now() - started
        };
    }

    if (mode !== "sandboxed") {
        throw new Error("Unsupported run mode: " + mode + " (expected 'sandboxed' or 'include')");
    }

    var logs = [];
    var alerts = [];
    var dialogs = [];
    var state = {
        committed: false,
        finished: false,
        canceled: false,
        requestedContinue: false
    };

    function pushLog() {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            if (typeof arg === "string") {
                parts.push(arg);
            } else {
                try { parts.push(JSON.stringify(arg)); } catch (e) { parts.push(String(arg)); }
            }
        }
        logs.push(parts.join(" "));
    }

    var safeAction = {
        get Interactive() { return safeGet(function () { return Action.Interactive; }, false); },
        set Interactive(v) { try { Action.Interactive = v; } catch (e) {} },
        get ModelFilename() { return safeGet(function () { return Action.ModelFilename; }, ""); },
        get Properties() { return Action.Properties; },
        get Hint() { return safeGet(function () { return Action.Hint; }, ""); },
        set Hint(v) { /* keep bridge hint intact */ },
        set ErrorHint(v) { logs.push("[ErrorHint] " + String(v)); },
        set BlinkHint(v) { logs.push("[BlinkHint] " + String(v)); },
        OnFinish: null,
        OnStart: null,
        OnClick: null,
        OnMove: null,
        Continue: function () {
            state.requestedContinue = true;
            logs.push("[bridge] Intercepted Action.Continue() to keep MCP bridge alive");
        },
        Finish: function () {
            state.finished = true;
        },
        Cancel: function () {
            state.canceled = true;
        },
        Commit: function () {
            state.committed = true;
            return Action.Commit();
        },
        Revert: function () {
            return Action.Revert();
        },
        AsyncExec: function (fn) { return Action.AsyncExec(fn); },
        LoadModel: function (f) { return Action.LoadModel(f); },
        SaveModel: function (f) { return Action.SaveModel(f); },
        LoadProject: function (f) { return Action.LoadProject(f); },
        SaveProject: function (f, p) { return Action.SaveProject(f, p); },
        NewModel: function () { return Action.NewModel(); },
        NewFurniture: function () { return Action.NewFurniture(); },
        NewFragment: function () { return Action.NewFragment(); },
        ArrangePositions: function (m, mod) { return Action.ArrangePositions(m, mod); },
        ReplaceFurniture: function (o, n, f) { return Action.ReplaceFurniture(o, n, f); },
        ChooseMaterial: function () {
            if (allowDialogs) return Action.ChooseMaterial();
            dialogs.push({ type: "ChooseMaterial" });
            return "";
        }
    };

    var includeDepth = 0;
    function runFileInSandbox(targetFile) {
        if (includeDepth > 12) {
            throw new Error("Max include depth exceeded at: " + targetFile);
        }
        var raw = fs.readFileSync(targetFile, "utf8");
        if (raw.charCodeAt(0) === 0xFEFF) {
            raw = raw.slice(1);
        }
        var dir = path.dirname(targetFile);

        var safeSystem = {
            get apiVersion() { return system.apiVersion; },
            get developerApiVersion() { return system.developerApiVersion; },
            log: function (str) {
                logs.push(String(str));
                try { system.log(String(str)); } catch (e) {}
            },
            include: function (rel) {
                var incPath = resolveScriptPath(rel, dir);
                return runFileInSandbox(incPath);
            },
            fileExists: function (f) { return system.fileExists(f); },
            getFileName: function (f) { return system.getFileName(f); },
            getFileNameWithoutExtension: function (f) { return system.getFileNameWithoutExtension(f); },
            writeTextFile: function (f, c) { return system.writeTextFile(f, c); },
            readTextFile: function (f) { return system.readTextFile(f); },
            exec: function (cmd) { return system.exec(cmd); },
            sleep: function (ms) { return system.sleep(ms); },
            askFileName: function (ext) {
                if (allowDialogs) return system.askFileName(ext);
                dialogs.push({ type: "askFileName", ext: ext });
                return "";
            },
            askFileNameSave: function (ext) {
                if (allowDialogs) return system.askFileNameSave(ext);
                dialogs.push({ type: "askFileNameSave", ext: ext });
                return "";
            },
            askFolder: function (cap, def) {
                if (allowDialogs) return system.askFolder(cap, def);
                dialogs.push({ type: "askFolder", caption: cap, defaultFolder: def });
                return "";
            },
            askReadTextFile: function (ext) {
                if (allowDialogs) return system.askReadTextFile(ext);
                dialogs.push({ type: "askReadTextFile", ext: ext });
                return "";
            },
            askWriteTextFile: function (ext, c) {
                if (allowDialogs) return system.askWriteTextFile(ext, c);
                dialogs.push({ type: "askWriteTextFile", ext: ext });
                return "";
            }
        };

        var safeAlert = function (msg) {
            var s = String(msg);
            alerts.push(s);
            if (allowAlerts) {
                alert(s);
            }
        };
        var safePrompt = function (msg) {
            if (allowDialogs) return prompt(msg);
            dialogs.push({ type: "prompt", message: String(msg) });
            return "";
        };
        var safeConfirm = function (msg) {
            if (allowDialogs) return confirm(msg);
            dialogs.push({ type: "confirm", message: String(msg) });
            return false;
        };

        includeDepth++;
        try {
            var fn = new Function(
                "Action", "system", "alert", "prompt", "confirm", "log", "params", "__filename", "__dirname",
                raw
            );
            return fn(safeAction, safeSystem, safeAlert, safePrompt, safeConfirm, pushLog, reqBody.params || {}, targetFile, dir);
        } finally {
            includeDepth--;
        }
    }

    var value = runFileInSandbox(scriptPath);

    if (autoCommit && !state.committed && !state.canceled) {
        Action.Commit();
        state.committed = true;
    }

    var safeValue = value;
    try {
        JSON.stringify(value);
    } catch (e) {
        safeValue = String(value);
    }

    return {
        file: scriptPath,
        mode: "sandboxed",
        committed: state.committed,
        finished: state.finished,
        canceled: state.canceled,
        requestedContinue: state.requestedContinue,
        objectCountBefore: countBefore,
        objectCountAfter: safeGet(function () { return Model.Count; }, 0),
        durationMs: Date.now() - started,
        result: safeValue === undefined ? null : safeValue,
        logs: logs,
        alerts: alerts,
        dialogs: dialogs
    };
}

function getBazisDocumentsRoot() {
    var envRoot = getEnv("BAZIS_DOCS_DIR", "");
    if (envRoot) return path.resolve(envRoot);
    var home = safeGet(function () { return os.homedir(); }, "");
    if (home) {
        return path.join(home, "Documents", "Bazis");
    }
    return "C:\\Users\\Public\\Documents\\Bazis";
}

function getLibraryDefs(extraDir) {
    var base = getBazisDocumentsRoot();
    var defs = [
        { key: "fragments", name: "Fragments", defaultExt: ".fr3d", path: path.join(base, "Fragments") },
        { key: "accessories", name: "Accessories", defaultExt: ".f3d", path: path.join(base, "Accessories") },
        { key: "templates", name: "Templates", defaultExt: ".b3d", path: path.join(base, "Templates") },
        { key: "blum", name: "Blum", defaultExt: ".f3d", path: path.join(base, "Blum") },
        { key: "doors", name: "Doors library", defaultExt: ".bdl", path: path.join(base, "Doors library") },
        { key: "drawers", name: "Drawer library", defaultExt: ".bbb", path: path.join(base, "Drawer library") }
    ];
    var envLib = getEnv("BAZIS_LIBRARIES_DIR", "");
    if (envLib) {
        defs.push({ key: "env", name: "Custom (BAZIS_LIBRARIES_DIR)", defaultExt: ".fr3d", path: path.resolve(envLib) });
    }
    if (extraDir) {
        defs.push({ key: "custom", name: "Custom", defaultExt: ".fr3d", path: path.resolve(String(extraDir)) });
    }
    for (var i = 0; i < defs.length; i++) {
        try {
            defs[i].exists = fs.existsSync(defs[i].path);
        } catch (e) {
            defs[i].exists = false;
        }
    }
    return defs;
}

function ensureDirRecursive(dirPath) {
    var resolved = path.resolve(dirPath);
    if (fs.existsSync(resolved)) return;
    var parent = path.dirname(resolved);
    if (parent && parent !== resolved && !fs.existsSync(parent)) {
        ensureDirRecursive(parent);
    }
    fs.mkdirSync(resolved);
}

function handleListLibrary(query) {
    var q = query || {};
    var libFilter = String(q.library || "all").toLowerCase();
    var textFilter = q.filter ? String(q.filter).toLowerCase() : "";
    var limit = q.limit ? Number(q.limit) : 200;
    var extList = [".b3d", ".fr3d", ".f3d", ".bdl", ".bbb", ".frw"];
    if (q.extensions) {
        var rawExts = Array.isArray(q.extensions) ? q.extensions : String(q.extensions).split(",");
        extList = [];
        for (var e = 0; e < rawExts.length; e++) {
            var cleaned = String(rawExts[e]).trim().toLowerCase();
            if (!cleaned) continue;
            if (cleaned.charAt(0) !== ".") cleaned = "." + cleaned;
            extList.push(cleaned);
        }
    }

    var defs = getLibraryDefs(q.dir || "");
    var selected = [];
    for (var i = 0; i < defs.length; i++) {
        if (libFilter === "all" || defs[i].key === libFilter || defs[i].name.toLowerCase() === libFilter) {
            selected.push(defs[i]);
        }
    }
    if (selected.length === 0) {
        throw new Error("Unknown library '" + libFilter + "' (expected all, fragments, accessories, templates, blum, doors, drawers, or provide 'dir')");
    }

    var items = [];
    function walk(def, dir, depth) {
        if (depth > 5 || items.length >= limit) return;
        var list;
        try { list = fs.readdirSync(dir); } catch (err) { return; }
        for (var j = 0; j < list.length; j++) {
            if (items.length >= limit) return;
            var entry = list[j];
            var full = path.join(dir, entry);
            var st;
            try { st = fs.statSync(full); } catch (err2) { continue; }
            if (st.isDirectory()) {
                walk(def, full, depth + 1);
            } else {
                var ext = path.extname(entry).toLowerCase();
                if (extList.indexOf(ext) === -1) continue;
                var rel = full.slice(def.path.length + 1);
                if (!textFilter || rel.toLowerCase().indexOf(textFilter) !== -1 || entry.toLowerCase().indexOf(textFilter) !== -1) {
                    var parts = rel.split(/[\\/]/);
                    items.push({
                        name: entry.slice(0, entry.length - ext.length),
                        filename: entry,
                        ext: ext,
                        library: def.key,
                        category: parts.length > 1 ? parts.slice(0, -1).join("/") : def.name,
                        relativePath: rel,
                        path: full,
                        sizeBytes: st.size
                    });
                }
            }
        }
    }

    for (var s = 0; s < selected.length; s++) {
        if (selected[s].exists) {
            walk(selected[s], selected[s].path, 0);
        }
    }

    return {
        baseDir: getBazisDocumentsRoot(),
        libraries: defs,
        count: items.length,
        files: items
    };
}

function resolveLibraryFile(fileSpec, libraryKey, extraDir) {
    if (!fileSpec) {
        throw new Error("Provide 'file' (full path, relative path in library, or name from bazis_list_library)");
    }
    var spec = String(fileSpec);
    try {
        if (fs.existsSync(spec) && !fs.statSync(spec).isDirectory()) {
            return path.resolve(spec);
        }
    } catch (e) {}

    var defs = getLibraryDefs(extraDir);
    var libFilter = String(libraryKey || "all").toLowerCase();
    var exts = ["", ".fr3d", ".b3d", ".f3d"];
    for (var i = 0; i < defs.length; i++) {
        if (libFilter !== "all" && defs[i].key !== libFilter && defs[i].name.toLowerCase() !== libFilter) {
            continue;
        }
        if (!defs[i].exists) continue;
        for (var e = 0; e < exts.length; e++) {
            var candidate = path.join(defs[i].path, spec + exts[e]);
            try {
                if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
                    return path.resolve(candidate);
                }
            } catch (err) {}
        }
    }

    var scanned = handleListLibrary({
        library: libraryKey || "all",
        dir: extraDir || "",
        filter: spec,
        extensions: [".fr3d", ".b3d", ".f3d"],
        limit: 10
    });
    if (scanned.files.length > 0) {
        return scanned.files[0].path;
    }

    throw new Error("Library file not found: " + spec);
}

function handleOpenLibrary(body) {
    var reqBody = body || {};
    var filePath = resolveLibraryFile(reqBody.file, reqBody.library, reqBody.dir);
    var mode = String(reqBody.mode || "insert").toLowerCase();

    if (mode === "open") {
        var loaded = Action.LoadModel(filePath);
        if (reqBody.viewAll !== false) {
            try { ViewAll(); } catch (e) {}
        }
        return {
            mode: "open",
            file: filePath,
            loaded: !!loaded,
            model: getModelSnapshot(3)
        };
    }

    if (mode === "insert") {
        var wrapInBlock = reqBody.wrapInBlock !== false;
        var blockName = String(reqBody.name || path.basename(filePath, path.extname(filePath)));
        var prevCount = safeGet(function () { return Model.Count; }, 0);
        var ok = false;
        var isElastic = false;
        var resizedSize = null;

        if (wrapInBlock) {
            var blk = AddBlock(blockName);
            ok = blk.Load(filePath);
            if (!ok) {
                try { DeleteNewObjects(); } catch (e) {}
                throw new Error("Block.Load() returned false for: " + filePath);
            }
            isElastic = !!safeGet(function () { return blk.IsElastic(); }, false);
            if (reqBody.elasticSize && isElastic) {
                var es = reqBody.elasticSize;
                var resVec = blk.ElasticResize(NewVector(Number(es.x), Number(es.y), Number(es.z)));
                resizedSize = vecToObj(resVec);
            }
            if (reqBody.position) {
                var pos = reqBody.position;
                blk.TranslateGCS(NewVector(Number(pos.x || 0), Number(pos.y || 0), Number(pos.z || 0)));
            }
            if (reqBody.rotate && typeof reqBody.rotate.angle === "number") {
                var axis = String(reqBody.rotate.axis || "y").toLowerCase();
                var ang = Number(reqBody.rotate.angle);
                if (axis === "x") blk.RotateX(ang);
                else if (axis === "y") blk.RotateY(ang);
                else if (axis === "z") blk.RotateZ(ang);
            }
            blk.Build();
        } else {
            ok = Model.Load(filePath);
            if (!ok) {
                throw new Error("Model.Load() returned false for: " + filePath);
            }
        }

        if (reqBody.commit !== false) {
            Action.Commit();
        }
        if (reqBody.viewAll !== false) {
            try { ViewAll(); } catch (e) {}
        }

        var created = [];
        var newCount = safeGet(function () { return Model.Count; }, 0);
        for (var i = prevCount; i < newCount; i++) {
            var co = safeGet(function () { return Model.Objects[i]; }, null);
            if (co) created.push(serializeObject(co, 0, 3));
        }

        return {
            mode: "insert",
            file: filePath,
            loaded: !!ok,
            isElastic: isElastic,
            resizedSize: resizedSize,
            createdCount: created.length,
            created: created
        };
    }

    throw new Error("Unsupported library open mode: " + mode + " (expected 'insert' or 'open')");
}

function handleSaveLibrary(body) {
    var reqBody = body || {};
    if (!reqBody.file) {
        throw new Error("Provide 'file' (filename, relative path inside library, or full Windows path)");
    }

    var libKey = String(reqBody.library || "fragments").toLowerCase();
    var defs = getLibraryDefs(reqBody.dir || "");
    var targetDef = null;
    for (var i = 0; i < defs.length; i++) {
        if (defs[i].key === libKey || defs[i].name.toLowerCase() === libKey) {
            targetDef = defs[i];
            break;
        }
    }

    var rawFile = String(reqBody.file);
    var targetPath;
    if (path.isAbsolute(rawFile)) {
        targetPath = path.resolve(rawFile);
    } else if (reqBody.dir) {
        targetPath = path.resolve(path.join(String(reqBody.dir), rawFile));
    } else if (targetDef) {
        targetPath = path.resolve(path.join(targetDef.path, rawFile));
    } else {
        throw new Error("Unknown library '" + libKey + "' (expected fragments, accessories, templates, blum, or provide absolute path / 'dir')");
    }

    var currentExt = path.extname(targetPath).toLowerCase();
    if (!currentExt) {
        var fmt = reqBody.format ? String(reqBody.format).toLowerCase().replace(/^\./, "") : "";
        var defaultExt = fmt ? ("." + fmt) : (targetDef ? targetDef.defaultExt : ".fr3d");
        targetPath += defaultExt;
    }

    var overwrite = reqBody.overwrite === true;
    if (!overwrite && fs.existsSync(targetPath)) {
        throw new Error("Target file already exists (pass overwrite: true to replace): " + targetPath);
    }

    ensureDirRecursive(path.dirname(targetPath));

    if (reqBody.articleName !== undefined) {
        Article.Name = String(reqBody.articleName);
    }
    if (reqBody.articleCode !== undefined) {
        Article.Code = String(reqBody.articleCode);
    }
    if (typeof reqBody.datumMode === "number") {
        try { Article.DatumMode = reqBody.datumMode; } catch (e) {}
    }

    if (reqBody.commit !== false) {
        Action.Commit();
    }

    Action.SaveModel(targetPath);

    var exists = false;
    var sizeBytes = 0;
    try {
        if (fs.existsSync(targetPath)) {
            exists = true;
            sizeBytes = fs.statSync(targetPath).size;
        }
    } catch (e) {}

    return {
        saved: exists,
        path: targetPath,
        library: targetDef ? targetDef.key : "custom",
        format: path.extname(targetPath).toLowerCase().replace(/^\./, ""),
        sizeBytes: sizeBytes,
        articleName: safeGet(function () { return Article.Name; }, ""),
        articleCode: safeGet(function () { return Article.Code; }, "")
    };
}

// =========================================================================
// Bazis Binary XML (.bbb / .bdl) codec & Drawer Library generator
// Format: magic 01 00 00 ff 00 + uint32 stringCount + length-prefixed UTF-8
//         strings + recursive tree (uint32 nameIdx, uint32 childCount,
//         uint8 valType [0=null,1=false,2=true,3=int8,4=int32,5=float64,
//         6=utf16le string,8=empty string], payload, children).
// =========================================================================

function parseBazisBinaryXml(buf) {
    if (!buf || buf.length < 9 || buf[0] !== 1 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0xff || buf[4] !== 0) {
        throw new Error("Invalid Bazis Binary XML magic header (expected 01 00 00 ff 00)");
    }
    var off = 5;
    var sc = buf.readUInt32LE(off); off += 4;
    var strings = [];
    for (var i = 0; i < sc; i++) {
        var len = buf.readUInt32LE(off); off += 4;
        strings.push(buf.slice(off, off + len).toString("utf8"));
        off += len;
    }
    function readNode() {
        var nameIdx = buf.readUInt32LE(off); off += 4;
        if (nameIdx >= strings.length) {
            throw new Error("Corrupt Bazis Binary XML: string index " + nameIdx + " out of range");
        }
        var name = strings[nameIdx];
        var cc = buf.readUInt32LE(off); off += 4;
        var t = buf[off++];
        var v = null;
        if (t === 0) {
            v = null;
        } else if (t === 1) {
            v = false;
        } else if (t === 2) {
            v = true;
        } else if (t === 3) {
            v = buf.readInt8(off); off += 1;
        } else if (t === 4) {
            v = buf.readInt32LE(off); off += 4;
        } else if (t === 5) {
            v = buf.readDoubleLE(off); off += 8;
        } else if (t === 6) {
            var charLen = buf.readUInt32LE(off); off += 4;
            v = buf.slice(off, off + charLen * 2).toString("utf16le");
            off += charLen * 2;
        } else if (t === 8) {
            v = "";
        } else {
            throw new Error("Unsupported Bazis Binary XML value type " + t + " for node '" + name + "' at offset " + (off - 1));
        }
        var children = [];
        for (var j = 0; j < cc; j++) {
            children.push(readNode());
        }
        return { name: name, t: t, v: v, children: children };
    }
    var root = readNode();
    return { root: root, bytesRead: off, totalBytes: buf.length };
}

function encodeBazisBinaryXml(root) {
    var strMap = {};
    var strings = [];
    function collect(node) {
        if (!strMap[node.name]) {
            strMap[node.name] = true;
            strings.push(node.name);
        }
        var ch = node.children || [];
        for (var i = 0; i < ch.length; i++) collect(ch[i]);
    }
    collect(root);
    strings.sort(function (a, b) {
        if (a.length !== b.length) return a.length - b.length;
        return a < b ? -1 : (a > b ? 1 : 0);
    });
    var idxMap = {};
    for (var s = 0; s < strings.length; s++) idxMap[strings[s]] = s;

    var chunks = [];
    var hdr = Buffer.alloc(9);
    hdr[0] = 1; hdr[1] = 0; hdr[2] = 0; hdr[3] = 0xff; hdr[4] = 0;
    hdr.writeUInt32LE(strings.length, 5);
    chunks.push(hdr);

    for (var i = 0; i < strings.length; i++) {
        var sb = Buffer.from(strings[i], "utf8");
        var lb = Buffer.alloc(4);
        lb.writeUInt32LE(sb.length, 0);
        chunks.push(lb, sb);
    }

    function writeNode(node) {
        var ch = node.children || [];
        var t = node.t;
        var v = node.v;
        if (t === 6 && (!v || String(v).length === 0)) {
            t = 8;
        }
        var nh = Buffer.alloc(9);
        nh.writeUInt32LE(idxMap[node.name], 0);
        nh.writeUInt32LE(ch.length, 4);
        nh[8] = t;
        chunks.push(nh);

        if (t === 3) {
            var b1 = Buffer.alloc(1); b1.writeInt8(Number(v || 0), 0); chunks.push(b1);
        } else if (t === 4) {
            var b4 = Buffer.alloc(4); b4.writeInt32LE(Number(v || 0), 0); chunks.push(b4);
        } else if (t === 5) {
            var b8 = Buffer.alloc(8); b8.writeDoubleLE(Number(v || 0), 0); chunks.push(b8);
        } else if (t === 6) {
            var strBuf = Buffer.from(String(v), "utf16le");
            var strLen = Buffer.alloc(4);
            strLen.writeUInt32LE(strBuf.length / 2, 0);
            chunks.push(strLen, strBuf);
        }
        for (var j = 0; j < ch.length; j++) writeNode(ch[j]);
    }
    writeNode(root);
    return Buffer.concat(chunks);
}

function bbbNode(name, t, v, children) {
    return { name: name, t: t, v: v, children: children || [] };
}
function bbbContainer(name, children) { return bbbNode(name, 0, null, children || []); }
function bbbBool(name, val) { return bbbNode(name, val ? 2 : 1, !!val, []); }
function bbbInt8(name, val) { return bbbNode(name, 3, Math.max(-128, Math.min(127, Math.round(Number(val || 0)))), []); }
function bbbInt32(name, val) { return bbbNode(name, 4, Math.round(Number(val || 0)), []); }
function bbbFloat(name, val) { return bbbNode(name, 5, Number(val || 0), []); }
function bbbStr(name, val) {
    var s = val === undefined || val === null ? "" : String(val);
    return s.length === 0 ? bbbNode(name, 8, "", []) : bbbNode(name, 6, s, []);
}

function bbbFindChild(node, name) {
    var ch = (node && node.children) || [];
    for (var i = 0; i < ch.length; i++) {
        if (ch[i].name === name) return ch[i];
    }
    return null;
}

function bbbBuildHolesArray(nodeName, values) {
    var arr = Array.isArray(values) ? values : [];
    var params = [];
    for (var i = 0; i < arr.length; i++) {
        params.push(bbbFloat("Value" + (i + 1), arr[i]));
    }
    return bbbContainer(nodeName, [
        bbbInt8("ItemsCount", arr.length),
        bbbContainer("Params", params)
    ]);
}

function bbbBuildBoxWidthList(lengths, currentWidth) {
    var list = Array.isArray(lengths) && lengths.length > 0 ? lengths : [
        { width: 300, materialName: "Drawer Runner 300", holesNiche: [37, 32, 128, 32] },
        { width: 350, materialName: "Drawer Runner 350", holesNiche: [37, 32, 160, 32] },
        { width: 400, materialName: "Drawer Runner 400", holesNiche: [37, 32, 192, 32] },
        { width: 450, materialName: "Drawer Runner 450", holesNiche: [37, 32, 224, 32] },
        { width: 500, materialName: "Drawer Runner 500", holesNiche: [37, 32, 224, 32] }
    ];
    var children = [];
    for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var w = Number(item.width || 500);
        children.push(bbbContainer("BoxWidth", [
            bbbFloat("Width", w),
            bbbBuildHolesArray("HolesBox", item.holesBox || []),
            bbbBuildHolesArray("HolesNiche", item.holesNiche || [37, 32, 128, 32]),
            bbbContainer("Material", [
                bbbContainer("PogonMat", [
                    bbbStr("MaterialName", item.pogonMaterialName || ""),
                    bbbFloat("Thickness", item.pogonThickness || 0),
                    bbbFloat("Width", item.pogonWidth || 0)
                ]),
                bbbStr("MaterialName", item.materialName || ("Runner " + w)),
                bbbFloat("Thickness", 0),
                bbbFloat("Width", 0),
                bbbContainer("ButtMaterial", [
                    bbbFloat("Thick", 0),
                    bbbFloat("Overhung", 0),
                    bbbFloat("Allowance", 0)
                ])
            ]),
            bbbContainer("HolesSidePlast", []),
            bbbContainer("HolesSideTorec", [])
        ]));
    }
    var cur = typeof currentWidth === "number" ? currentWidth : Number(list[list.length - 1].width || 500);
    children.push(bbbFloat("CurrentWidth", cur));
    return bbbContainer("BoxWidthList", children);
}

function bbbBuildCutNode(nodeName, cfg) {
    var c = cfg || {};
    return bbbContainer(nodeName, [
        bbbStr("CutType", c.cutType || "ctNone"),
        bbbStr("Name", c.name || ""),
        bbbStr("Sign", c.sign || ""),
        bbbFloat("Depth", c.depth || 0),
        bbbFloat("Width", c.width || 0),
        bbbFloat("Offset", c.offset || 0),
        bbbFloat("Offset2", c.offset2 || 0),
        bbbFloat("Angle", c.angle || 0),
        bbbFloat("Radius", c.radius || 0),
        bbbStr("Fragment", c.fragment || "")
    ]);
}

function bbbBuildFastSetupNode(nodeName, cfg) {
    var c = cfg || {};
    return bbbContainer(nodeName, [
        bbbBool("SetupFastener", c.setupFastener !== false),
        bbbFloat("OffsetSide", c.offsetSide !== undefined ? c.offsetSide : 20),
        bbbFloat("SizeInter", c.sizeInter !== undefined ? c.sizeInter : 200),
        bbbInt8("FastMainCountBefore", c.fastMainCountBefore !== undefined ? c.fastMainCountBefore : 2),
        bbbInt8("FastAdditionalCountBefore", c.fastAdditionalCountBefore || 0),
        bbbInt8("FastMainCountAfter", c.fastMainCountAfter !== undefined ? c.fastMainCountAfter : 3),
        bbbInt8("FastAdditionalCountAfter", c.fastAdditionalCountAfter || 0),
        bbbFloat("Step", c.step !== undefined ? c.step : 32)
    ]);
}

function bbbBuildDefaultGuideFast() {
    return bbbContainer("FastGuideRails", [
        bbbFloat("x", 0),
        bbbFloat("y", 0),
        bbbFloat("d", 2),
        bbbFloat("h", 5),
        bbbStr("Name", ""),
        bbbStr("Elements", ""),
        bbbInt32("Color", 536870911),
        bbbStr("Path", ""),
        bbbInt8("Class", 6)
    ]);
}

function bbbBuildStandartBox(spec) {
    var s = spec || {};
    var cutBottom = s.cutForBottom || (
        (s.bottomType === "bbtCutsAllPanels" || s.bottomType === "bbtCutsSides")
            ? { cutType: "ctRectangle", name: "Bottom groove", depth: 5, width: 4, offset: 12 }
            : { cutType: "ctNone" }
    );
    return bbbContainer("StandartBox", [
        bbbStr("BoxConstruction", s.construction || "bctVertFront"),
        bbbStr("BoxBottomType", s.bottomType || "bbtCutsAllPanels"),
        bbbFloat("BottomInsertDepth", s.bottomInsertDepth || 0),
        bbbStr("BoxGuideRailsType", s.guideRailsType || "bgrtUnderBottom"),
        bbbFloat("MaxSideThickness", s.maxSideThickness !== undefined ? s.maxSideThickness : 16),
        bbbFloat("OffsetSide", s.offsetSide !== undefined ? s.offsetSide : 21),
        bbbFloat("OffsetBottomPanel", s.offsetBottomPanel || 0),
        bbbBool("BackPanelYEqalsTopPanelY", !!s.backPanelYEqualsTop),
        bbbBool("FalsityPanelYEqalsTopPanelY", !!s.falsityPanelYEqualsTop),
        bbbBool("BackPanelOnBottom", !!s.backPanelOnBottom),
        bbbBool("FalsityPanelOnBottom", !!s.falsityPanelOnBottom),
        bbbFloat("CutDepthEps", s.cutDepthEps !== undefined ? s.cutDepthEps : 1),
        bbbFloat("RailsInCutDepth", s.railsInCutDepth || 0),
        bbbBool("CutInFacade", s.cutInFacade !== undefined ? !!s.cutInFacade : false),
        bbbStr("CutInFacadeType", s.cutInFacadeType || "ciftCutter"),
        bbbFloat("CutFacadeAdd", s.cutFacadeAdd !== undefined ? s.cutFacadeAdd : 5),
        bbbFloat("CutForRailsBackWidth", s.cutForRailsBackWidth !== undefined ? s.cutForRailsBackWidth : 30),
        bbbFloat("CutForRailsFalsityWidth", s.cutForRailsFalsityWidth !== undefined ? s.cutForRailsFalsityWidth : 30),
        bbbBuildCutNode("CutForBottom", cutBottom),
        bbbBuildCutNode("CutForRails", s.cutForRails || { cutType: "ctNone" }),
        bbbFloat("BoxDepthMinus", s.boxDepthMinus !== undefined ? s.boxDepthMinus : 10),
        bbbBool("BokBaza", !!s.bokBaza),
        bbbFloat("Rez1", 0),
        bbbFloat("Rez2", 0),
        bbbBuildFastSetupNode("FastSetupBox", s.fastSetupBox || { offsetSide: 20, sizeInter: 200, step: 32 }),
        bbbBuildFastSetupNode("FastSetupFacadeHor", s.fastSetupFacadeHor || { offsetSide: 40, sizeInter: 500, step: 20 }),
        bbbBuildFastSetupNode("FastSetupFacadeVert", s.fastSetupFacadeVert || { offsetSide: 30, sizeInter: 200, step: 20 }),
        bbbBuildFastSetupNode("FastSetupBottom", s.fastSetupBottom || { offsetSide: 100, sizeInter: 0, fastMainCountBefore: 0, fastMainCountAfter: 0, step: 0 }),
        bbbStr("Name", s.name || "Custom StandartBox"),
        bbbStr("PictureFile", s.pictureFile || ""),
        bbbFloat("OffsetTop", s.offsetTop !== undefined ? s.offsetTop : 7),
        bbbFloat("OffsetBottomFast", s.offsetBottomFast !== undefined ? s.offsetBottomFast : 37),
        bbbFloat("OffsetFastSideBottom", s.offsetFastSideBottom !== undefined ? s.offsetFastSideBottom : 21.5),
        bbbFloat("OffsetFastHole2", s.offsetFastHole2 !== undefined ? s.offsetFastHole2 : 12),
        bbbFloat("KorpPlus", s.korpPlus !== undefined ? s.korpPlus : 3),
        bbbBuildBoxWidthList(s.lengths, s.currentWidth),
        bbbBool("Validate", s.validate !== false),
        bbbContainer("FastSides", [
            bbbFloat("d1", 8), bbbFloat("d2", 5), bbbFloat("h", 52), bbbFloat("h1", 0),
            bbbStr("Name", (s.fastSidesName !== undefined) ? s.fastSidesName : "Confirmat 6x50"),
            bbbStr("Elements", ""), bbbInt8("Color", -1), bbbStr("Path", "Confirmat"), bbbInt8("Class", 1)
        ]),
        bbbContainer("FastFacade", [
            bbbFloat("D", 7), bbbFloat("H", 28), bbbFloat("Y", 8), bbbFloat("D1", 5),
            bbbFloat("H1", -1), bbbFloat("A1", 0), bbbFloat("D2", 15), bbbFloat("H2", 13), bbbFloat("x2", 34),
            bbbStr("Name", (s.fastFacadeName !== undefined) ? s.fastFacadeName : "Minifix"),
            bbbStr("Elements", ""), bbbInt32("Color", 8388736), bbbStr("Path", "Connectors"), bbbInt8("Class", 2)
        ]),
        bbbContainer("FastBottom", [
            bbbFloat("d1", 1.6), bbbFloat("d2", 1.6), bbbFloat("h", 25), bbbFloat("h1", 0),
            bbbStr("Name", (s.fastBottomName !== undefined) ? s.fastBottomName : "Screw 3.5x16"),
            bbbStr("Elements", ""), bbbInt32("Color", 8421504), bbbStr("Path", "Screws"), bbbInt8("Class", 1)
        ]),
        bbbBuildDefaultGuideFast(),
        bbbContainer("HolesBack", [])
    ]);
}

function bbbBuildSysBox(spec) {
    var s = spec || {};
    return bbbContainer("SysBox", [
        bbbStr("FacadeType", s.facadeType || "bsftFacade"),
        bbbFloat("FalsityWidthMinus", s.falsityWidthMinus !== undefined ? s.falsityWidthMinus : 96.5),
        bbbFloat("FalsityHeight", s.falsityHeight !== undefined ? s.falsityHeight : 69),
        bbbFloat("BackWidthMinus", s.backWidthMinus !== undefined ? s.backWidthMinus : 87),
        bbbFloat("BackHeight", s.backHeight !== undefined ? s.backHeight : 83.6),
        bbbBool("BackTop", !!s.backTop),
        bbbFloat("SideHeight", s.sideHeight !== undefined ? s.sideHeight : 83.6),
        bbbFloat("BottomWidthMinus", s.bottomWidthMinus !== undefined ? s.bottomWidthMinus : 75),
        bbbFloat("MinusFalsityDSPBackDSP", s.minusFalsityDSPBackDSP !== undefined ? s.minusFalsityDSPBackDSP : 24),
        bbbFloat("MinusFalsityDSPBackNotDSP", s.minusFalsityDSPBackNotDSP !== undefined ? s.minusFalsityDSPBackNotDSP : 24),
        bbbFloat("MinusFalsityNotDSPBackDSP", s.minusFalsityNotDSPBackDSP !== undefined ? s.minusFalsityNotDSPBackDSP : 24),
        bbbFloat("MinusFalsityNotDSPBackNotDSP", s.minusFalsityNotDSPBackNotDSP !== undefined ? s.minusFalsityNotDSPBackNotDSP : 24),
        bbbFloat("BottomInsertFrontPanel", s.bottomInsertFrontPanel || 0),
        bbbFloat("BottomInsertBackPanel", s.bottomInsertBackPanel || 0),
        bbbBool("HolesFrontBaseTop", !!s.holesFrontBaseTop),
        bbbBool("HolesBackBaseTop", !!s.holesBackBaseTop),
        bbbStr("Name", s.name || "Custom SysBox"),
        bbbStr("PictureFile", s.pictureFile || ""),
        bbbFloat("OffsetTop", s.offsetTop !== undefined ? s.offsetTop : 14),
        bbbFloat("OffsetBottomFast", s.offsetBottomFast !== undefined ? s.offsetBottomFast : 37),
        bbbFloat("OffsetFastSideBottom", s.offsetFastSideBottom !== undefined ? s.offsetFastSideBottom : 33),
        bbbFloat("OffsetFastHole2", s.offsetFastHole2 || 0),
        bbbFloat("KorpPlus", s.korpPlus !== undefined ? s.korpPlus : 3),
        bbbBuildBoxWidthList(s.lengths, s.currentWidth),
        bbbBool("Validate", s.validate !== false),
        bbbBuildDefaultGuideFast(),
        bbbContainer("HoleListFront", []),
        bbbContainer("HoleListBack", []),
        bbbContainer("HoleListBottom", [])
    ]);
}

function summarizeBbbBox(node, index) {
    var nameNode = bbbFindChild(node, "Name");
    var bwList = bbbFindChild(node, "BoxWidthList");
    var lengths = [];
    if (bwList && bwList.children) {
        for (var i = 0; i < bwList.children.length; i++) {
            var c = bwList.children[i];
            if (c.name === "BoxWidth") {
                var wNode = bbbFindChild(c, "Width");
                var matNode = bbbFindChild(c, "Material");
                var matName = matNode ? bbbFindChild(matNode, "MaterialName") : null;
                var hn = bbbFindChild(c, "HolesNiche");
                var hnParams = hn ? bbbFindChild(hn, "Params") : null;
                var holes = [];
                if (hnParams && hnParams.children) {
                    for (var h = 0; h < hnParams.children.length; h++) holes.push(hnParams.children[h].v);
                }
                lengths.push({
                    width: wNode ? wNode.v : null,
                    materialName: matName ? matName.v : "",
                    holesNiche: holes
                });
            }
        }
    }
    var summary = {
        index: index,
        kind: node.name,
        name: nameNode ? nameNode.v : "",
        lengthsCount: lengths.length,
        lengths: lengths
    };
    var scalarKeys = [
        "BoxConstruction", "BoxBottomType", "BoxGuideRailsType", "MaxSideThickness",
        "OffsetSide", "OffsetTop", "OffsetBottomFast", "OffsetFastSideBottom", "KorpPlus",
        "BoxDepthMinus", "FacadeType", "SideHeight", "BackHeight", "BackWidthMinus",
        "BottomWidthMinus", "FalsityWidthMinus", "FalsityHeight"
    ];
    for (var k = 0; k < scalarKeys.length; k++) {
        var sc = bbbFindChild(node, scalarKeys[k]);
        if (sc) summary[scalarKeys[k]] = sc.v;
    }
    return summary;
}

function handleBbbRead(body) {
    var reqBody = body || {};
    var filePath = resolveMakerConfigPath(reqBody.file, "drawers", reqBody.dir || "");
    var buf = fs.readFileSync(filePath);
    var parsed = parseBazisBinaryXml(buf);
    var root = parsed.root;
    var mode = String(reqBody.mode || "summary").toLowerCase();

    if (mode === "full") {
        return {
            path: filePath,
            sizeBytes: buf.length,
            rootName: root.name,
            ast: root
        };
    }

    var activeIdxNode = bbbFindChild(root, "ActiveIndex");
    var boxes = [];
    for (var i = 0; i < root.children.length; i++) {
        var ch = root.children[i];
        if (ch.name === "StandartBox" || ch.name === "SysBox" || ch.name === "BoardBox") {
            boxes.push(ch);
        }
    }

    if (mode === "item") {
        var target = null;
        if (typeof reqBody.index === "number" && reqBody.index >= 0 && reqBody.index < boxes.length) {
            target = boxes[reqBody.index];
        } else if (reqBody.name) {
            var needle = String(reqBody.name).toLowerCase();
            for (var j = 0; j < boxes.length; j++) {
                var nn = bbbFindChild(boxes[j], "Name");
                if (nn && String(nn.v || "").toLowerCase().indexOf(needle) !== -1) {
                    target = boxes[j];
                    break;
                }
            }
        }
        if (!target) throw new Error("Box item not found (provide valid 'index' or 'name')");
        return {
            path: filePath,
            sizeBytes: buf.length,
            rootName: root.name,
            item: target
        };
    }

    var summaries = [];
    for (var b = 0; b < boxes.length; b++) {
        summaries.push(summarizeBbbBox(boxes[b], b));
    }
    return {
        path: filePath,
        sizeBytes: buf.length,
        rootName: root.name,
        activeIndex: activeIdxNode ? activeIdxNode.v : 0,
        boxCount: summaries.length,
        boxes: summaries
    };
}

function handleBbbWrite(body) {
    var reqBody = body || {};
    if (!reqBody.file) throw new Error("Provide 'file' (e.g. 'Blum.bbb' or full Windows path)");

    var rawFile = String(reqBody.file);
    var targetPath;
    if (path.isAbsolute(rawFile)) {
        targetPath = path.resolve(rawFile);
    } else if (reqBody.dir) {
        targetPath = path.resolve(path.join(String(reqBody.dir), rawFile));
    } else {
        targetPath = path.resolve(path.join(getBazisDocumentsRoot(), "Drawer library", rawFile));
    }
    if (!path.extname(targetPath)) {
        targetPath += ".bbb";
    }

    var existsBefore = fs.existsSync(targetPath);
    var append = reqBody.append === true;
    var overwrite = reqBody.overwrite === true;
    if (existsBefore && !overwrite && !append) {
        throw new Error("Target .bbb file already exists (pass overwrite: true or append: true): " + targetPath);
    }

    var root;
    if (reqBody.ast && typeof reqBody.ast === "object") {
        root = reqBody.ast;
    } else {
        var newBoxNodes = [];
        var specs = Array.isArray(reqBody.boxes) ? reqBody.boxes : [];
        if (specs.length === 0) {
            throw new Error("Provide either 'boxes' (array of StandartBox/SysBox specs) or 'ast'");
        }
        for (var i = 0; i < specs.length; i++) {
            var sp = specs[i];
            if (sp && sp.children && typeof sp.t === "number" && sp.name) {
                newBoxNodes.push(sp);
            } else {
                var kind = String((sp && sp.kind) || "SysBox").toLowerCase();
                if (kind === "standartbox" || kind === "standardbox" || kind === "standart" || kind === "standard") {
                    newBoxNodes.push(bbbBuildStandartBox(sp));
                } else {
                    newBoxNodes.push(bbbBuildSysBox(sp));
                }
            }
        }

        if (append && existsBefore) {
            var prevParsed = parseBazisBinaryXml(fs.readFileSync(targetPath));
            root = prevParsed.root;
            for (var n = 0; n < newBoxNodes.length; n++) {
                var newNameNode = bbbFindChild(newBoxNodes[n], "Name");
                var newName = newNameNode ? String(newNameNode.v || "") : "";
                var replaced = false;
                if (newName) {
                    for (var e = 0; e < root.children.length; e++) {
                        var exName = bbbFindChild(root.children[e], "Name");
                        if (exName && String(exName.v || "") === newName) {
                            root.children[e] = newBoxNodes[n];
                            replaced = true;
                            break;
                        }
                    }
                }
                if (!replaced) root.children.push(newBoxNodes[n]);
            }
            if (typeof reqBody.activeIndex === "number") {
                var ai = bbbFindChild(root, "ActiveIndex");
                if (ai) ai.v = reqBody.activeIndex;
            }
        } else {
            var children = [bbbInt8("ActiveIndex", typeof reqBody.activeIndex === "number" ? reqBody.activeIndex : 0)];
            for (var k = 0; k < newBoxNodes.length; k++) children.push(newBoxNodes[k]);
            root = bbbContainer("BoxesLibrary", children);
        }
    }

    ensureDirRecursive(path.dirname(targetPath));
    var outBuf = encodeBazisBinaryXml(root);
    fs.writeFileSync(targetPath, outBuf);

    var bazisLoadOk = null;
    if (reqBody.validateWithBazis !== false && typeof NewBoxesMaker === "function") {
        try {
            var testMaker = NewBoxesMaker("validate");
            try { testMaker.ShowErrors = false; } catch (e) {}
            bazisLoadOk = !!testMaker.Load(targetPath);
        } catch (e) {
            bazisLoadOk = false;
        }
    }

    var boxCount = 0;
    for (var c = 0; c < (root.children || []).length; c++) {
        var cn = root.children[c].name;
        if (cn === "StandartBox" || cn === "SysBox" || cn === "BoardBox") boxCount++;
    }

    return {
        saved: true,
        path: targetPath,
        sizeBytes: outBuf.length,
        boxCount: boxCount,
        bazisLoadOk: bazisLoadOk
    };
}

// =========================================================================
// Bazis Firebird 2.5 Materials Database (.fdb) helpers & handlers
// =========================================================================

function resolveFirebirdConfig(reqBody) {
    var b = reqBody || {};
    var isqlCandidates = [
        getEnv("BAZIS_FIREBIRD_ISQL", ""),
        "C:\\Program Files (x86)\\BazisSoft\\BazisFirebird 2.5\\bin\\isql.exe",
        "C:\\Program Files\\BazisSoft\\BazisFirebird 2.5\\bin\\isql.exe",
        "C:\\Program Files\\Firebird\\Firebird_2_5\\bin\\isql.exe",
        "C:\\Program Files (x86)\\Firebird\\Firebird_2_5\\bin\\isql.exe"
    ];
    var isqlPath = "";
    for (var i = 0; i < isqlCandidates.length; i++) {
        if (isqlCandidates[i] && fs.existsSync(isqlCandidates[i])) {
            isqlPath = isqlCandidates[i];
            break;
        }
    }
    if (!isqlPath) {
        throw new Error("Firebird isql.exe not found (set BAZIS_FIREBIRD_ISQL)");
    }

    var port = String(b.port || getEnv("BAZIS_DB_PORT", "") || "");
    if (!port) {
        port = "14357";
        try {
            var fbRoot = path.dirname(path.dirname(isqlPath));
            var confPath = path.join(fbRoot, "firebird.conf");
            if (fs.existsSync(confPath)) {
                var conf = fs.readFileSync(confPath, "utf8");
                var m = conf.match(/^\s*RemoteServicePort\s*=\s*(\d+)/mi);
                if (m) port = m[1];
            }
        } catch (e) {}
    }

    var dbPath = String(b.dbPath || getEnv("BAZIS_DB_PATH", "") || "");
    if (!dbPath) {
        var base = getBazisDocumentsRoot();
        var candidates = [
            path.join(base, "Training material DB", "Training material DB.fdb"),
            path.join(base, "Materials.fdb"),
            path.join(base, "Base.fdb")
        ];
        for (var j = 0; j < candidates.length; j++) {
            if (fs.existsSync(candidates[j])) {
                dbPath = candidates[j];
                break;
            }
        }
        if (!dbPath && fs.existsSync(base)) {
            var foundFdb = [];
            (function scanFdb(dir, depth) {
                if (depth < 0 || foundFdb.length > 0) return;
                try {
                    var items = fs.readdirSync(dir);
                    for (var k = 0; k < items.length; k++) {
                        var full = path.join(dir, items[k]);
                        try {
                            var st = fs.statSync(full);
                            if (st.isDirectory()) scanFdb(full, depth - 1);
                            else if (items[k].toLowerCase().endsWith(".fdb")) foundFdb.push(full);
                        } catch (e) {}
                    }
                } catch (e) {}
            })(base, 3);
            if (foundFdb.length > 0) dbPath = foundFdb[0];
        }
    }
    if (!dbPath || !fs.existsSync(dbPath)) {
        throw new Error("Bazis Firebird .fdb database not found (pass dbPath or set BAZIS_DB_PATH)");
    }

    return {
        isqlPath: isqlPath,
        host: String(b.host || getEnv("BAZIS_DB_HOST", "localhost")),
        port: port,
        dbPath: path.resolve(dbPath),
        user: String(b.user || getEnv("BAZIS_DB_USER", "SYSDBA")),
        password: String(b.password || getEnv("BAZIS_DB_PASS", "masterkey"))
    };
}

function sqlQuote(val) {
    if (val === null || val === undefined) return "NULL";
    return "'" + String(val).replace(/'/g, "''") + "'";
}

function runFirebirdSql(cfg, sqlText) {
    var tmpDir = process.env.TEMP || "C:\\Windows\\Temp";
    var tag = "fb_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
    var inFile = path.join(tmpDir, tag + "_in.sql");
    var outFile = path.join(tmpDir, tag + "_out.txt");
    var errFile = path.join(tmpDir, tag + "_err.txt");

    fs.writeFileSync(inFile, sqlText + "\r\nQUIT;\r\n", "utf8");
    var connStr = cfg.host + "/" + cfg.port + ":" + cfg.dbPath;
    var sh = NewCOMObject("WScript.Shell");
    var cmd =
        "cmd.exe /c \"\"" + cfg.isqlPath + "\" -user " + cfg.user +
        " -password " + cfg.password +
        " -ch UTF8 -i \"" + inFile + "\" -o \"" + outFile + "\" \"" + connStr +
        "\" 2>\"" + errFile + "\"\"";
    var rc = sh.Run(cmd, 0, true);
    var out = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
    var err = fs.existsSync(errFile) ? fs.readFileSync(errFile, "utf8") : "";
    try { fs.unlinkSync(inFile); } catch (e) {}
    try { fs.unlinkSync(outFile); } catch (e) {}
    try { fs.unlinkSync(errFile); } catch (e) {}

    var cleanErr = err.split(/\r?\n/).filter(function (l) {
        return l.trim() && l.indexOf("can't format message") === -1;
    }).join("\n");

    if (rc !== 0 && cleanErr) {
        throw new Error("Firebird SQL error (rc=" + rc + "): " + cleanErr);
    }
    return { rc: rc, stdout: out, stderr: cleanErr };
}

function ensureFirebirdBackup(dbPath) {
    var d = new Date();
    var ymd = String(d.getFullYear()) +
        String(d.getMonth() + 1 < 10 ? "0" + (d.getMonth() + 1) : (d.getMonth() + 1)) +
        String(d.getDate() < 10 ? "0" + d.getDate() : d.getDate());
    var bakPath = dbPath + ".bak_" + ymd;
    if (!fs.existsSync(bakPath)) {
        fs.copyFileSync(dbPath, bakPath);
    }
    return bakPath;
}

function handleDbInfo(query) {
    var cfg = resolveFirebirdConfig(query || {});
    var sql = [
        "SET HEADING OFF;",
        "SELECT 'COUNT|MATERIAL|' || COUNT(*) FROM MATERIAL;",
        "SELECT 'COUNT|GROUP_MATERIAL|' || COUNT(*) FROM GROUP_MATERIAL;",
        "SELECT 'COUNT|OPERATION|' || COUNT(*) FROM OPERATION;",
        "SELECT 'COUNT|MEASURE|' || COUNT(*) FROM MEASURE;",
        "SELECT 'TYPE|' || ID_TM || '|' || COALESCE(NAME_TYPE, '') FROM TYPE_MATERIAL ORDER BY ID_TM;",
        "SELECT 'MEAS|' || ID_MS || '|' || COALESCE(NAME_MEAS, '') FROM MEASURE ORDER BY ID_MS;",
        "SELECT FIRST 40 'GRP|' || ID_GRM || '|' || COALESCE(ENTRY, 0) || '|' || COALESCE(ID_TM, 0) || '|' || COALESCE(NAME_GROUP, '') FROM GROUP_MATERIAL ORDER BY ID_GRM;"
    ].join("\r\n");

    var res = runFirebirdSql(cfg, sql);
    var counts = {};
    var types = [];
    var measures = [];
    var groups = [];
    var lines = res.stdout.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (!l) continue;
        var p = l.split("|");
        if (p[0] === "COUNT" && p.length >= 3) counts[p[1]] = Number(p[2]);
        else if (p[0] === "TYPE" && p.length >= 3) types.push({ id: Number(p[1]), name: p.slice(2).join("|").trim() });
        else if (p[0] === "MEAS" && p.length >= 3) measures.push({ id: Number(p[1]), name: p.slice(2).join("|").trim() });
        else if (p[0] === "GRP" && p.length >= 5) groups.push({ id: Number(p[1]), parentId: Number(p[2]), typeId: Number(p[3]), name: p.slice(4).join("|").trim() });
    }

    return {
        dbPath: cfg.dbPath,
        sizeBytes: fs.statSync(cfg.dbPath).size,
        host: cfg.host,
        port: cfg.port,
        isqlPath: cfg.isqlPath,
        counts: counts,
        materialTypes: types,
        measures: measures,
        groupsSample: groups
    };
}

function handleDbQuery(body) {
    var reqBody = body || {};
    var cfg = resolveFirebirdConfig(reqBody);

    if (reqBody.sql) {
        var rawSql = String(reqBody.sql).trim();
        if (!/^SELECT\b/i.test(rawSql) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|EXECUTE)\b/i.test(rawSql)) {
            throw new Error("bazis_db_query only permits read-only SELECT queries; use bazis_db_execute for writes");
        }
        var resRaw = runFirebirdSql(cfg, "SET HEADING ON;\r\n" + rawSql + (rawSql.slice(-1) === ";" ? "" : ";"));
        return { mode: "sql", dbPath: cfg.dbPath, output: resRaw.stdout.trim() };
    }

    var limit = Math.max(1, Math.min(200, Math.floor(Number(reqBody.limit || 50))));
    var where = ["1=1"];
    if (reqBody.search) {
        var needle = String(reqBody.search).toUpperCase().replace(/'/g, "''");
        where.push("(UPPER(COALESCE(m.NAME_MAT, '')) LIKE '%" + needle + "%' OR UPPER(COALESCE(m.ARTICLE, '')) LIKE '%" + needle + "%')");
    }
    if (reqBody.article) {
        var art = String(reqBody.article).toUpperCase().replace(/'/g, "''");
        where.push("UPPER(COALESCE(m.ARTICLE, '')) LIKE '%" + art + "%'");
    }
    if (typeof reqBody.groupId === "number") {
        where.push("m.ID_GRM = " + Math.floor(reqBody.groupId));
    }

    var sep = "\x1f";
    var sql = [
        "SET HEADING OFF;",
        "SELECT FIRST " + limit +
        " 'ROW' || '" + sep + "' || m.ID_M || '" + sep + "' || m.ID_GRM || '" + sep + "' || COALESCE(g.NAME_GROUP, '') || '" + sep +
        "' || COALESCE(m.NAME_MAT, '') || '" + sep + "' || COALESCE(m.ARTICLE, '') || '" + sep + "' || COALESCE(m.PRICE, 0) || '" + sep +
        "' || COALESCE(ms.NAME_MEAS, '') || '" + sep + "' || COALESCE(m.COMMENT, '')",
        "FROM MATERIAL m",
        "LEFT JOIN GROUP_MATERIAL g ON g.ID_GRM = m.ID_GRM",
        "LEFT JOIN MEASURE ms ON ms.ID_MS = m.ID_MS",
        "WHERE " + where.join(" AND "),
        "ORDER BY m.ID_M;"
    ].join("\r\n");

    var res = runFirebirdSql(cfg, sql);
    var rows = [];
    var lines = res.stdout.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (l.indexOf("ROW" + sep) !== 0) continue;
        var parts = l.split(sep);
        rows.push({
            id: Number(parts[1]),
            groupId: Number(parts[2]),
            groupName: (parts[3] || "").trim(),
            name: (parts[4] || "").trim(),
            article: (parts[5] || "").trim(),
            price: Number(parts[6] || 0),
            measure: (parts[7] || "").trim(),
            comment: (parts[8] || "").trim()
        });
    }
    return {
        mode: "search",
        dbPath: cfg.dbPath,
        count: rows.length,
        rows: rows
    };
}

function handleDbExecute(body) {
    var reqBody = body || {};
    var cfg = resolveFirebirdConfig(reqBody);
    var backupPath = null;
    if (reqBody.backup !== false) {
        backupPath = ensureFirebirdBackup(cfg.dbPath);
    }

    if (reqBody.action === "upsert_material") {
        if (!reqBody.name && typeof reqBody.id !== "number") {
            throw new Error("upsert_material requires 'name' (and optionally 'id' to update an existing material)");
        }
        var stmt;
        if (typeof reqBody.id === "number") {
            var sets = [];
            if (reqBody.name !== undefined) sets.push("NAME_MAT = " + sqlQuote(reqBody.name));
            if (reqBody.article !== undefined) sets.push("ARTICLE = " + sqlQuote(reqBody.article));
            if (typeof reqBody.groupId === "number") sets.push("ID_GRM = " + Math.floor(reqBody.groupId));
            if (typeof reqBody.measureId === "number") sets.push("ID_MS = " + Math.floor(reqBody.measureId));
            if (typeof reqBody.price === "number") sets.push("PRICE = " + Number(reqBody.price));
            if (reqBody.comment !== undefined) sets.push("COMMENT = " + sqlQuote(reqBody.comment));
            if (typeof reqBody.weight === "number") sets.push("WEIGHT = " + Number(reqBody.weight));
            if (sets.length === 0) throw new Error("No fields provided to update");
            stmt = "UPDATE MATERIAL SET " + sets.join(", ") + " WHERE ID_M = " + Math.floor(reqBody.id) + ";\r\nCOMMIT;";
            runFirebirdSql(cfg, stmt);
            return { ok: true, action: "updated", id: Math.floor(reqBody.id), backupPath: backupPath };
        } else {
            var grm = typeof reqBody.groupId === "number" ? Math.floor(reqBody.groupId) : 1;
            var ms = typeof reqBody.measureId === "number" ? Math.floor(reqBody.measureId) : 1;
            var price = typeof reqBody.price === "number" ? Number(reqBody.price) : 0;
            var weight = typeof reqBody.weight === "number" ? Number(reqBody.weight) : 0;
            stmt =
                "INSERT INTO MATERIAL (ID_GRM, ID_MS, NAME_MAT, ARTICLE, PRICE, COMMENT, WEIGHT) VALUES (" +
                grm + ", " + ms + ", " + sqlQuote(reqBody.name) + ", " +
                sqlQuote(reqBody.article || "") + ", " + price + ", " +
                sqlQuote(reqBody.comment || "") + ", " + weight + ");\r\nCOMMIT;\r\n" +
                "SET HEADING OFF;\r\nSELECT MAX(ID_M) FROM MATERIAL;";
            var insRes = runFirebirdSql(cfg, stmt);
            var idMatch = insRes.stdout.match(/\d+/);
            return {
                ok: true,
                action: "inserted",
                id: idMatch ? Number(idMatch[0]) : null,
                name: String(reqBody.name),
                article: String(reqBody.article || ""),
                backupPath: backupPath
            };
        }
    }

    if (!reqBody.sql || typeof reqBody.sql !== "string") {
        throw new Error("Provide 'sql' string or action='upsert_material'");
    }
    var rawSql = String(reqBody.sql).trim();
    if (/\b(DROP\s+DATABASE|DROP\s+TABLE)\b/i.test(rawSql)) {
        throw new Error("DROP DATABASE / DROP TABLE is blocked for safety");
    }
    var fullSql = rawSql + (rawSql.slice(-1) === ";" ? "" : ";") + "\r\nCOMMIT;";
    var execRes = runFirebirdSql(cfg, fullSql);
    return {
        ok: true,
        action: "sql",
        dbPath: cfg.dbPath,
        backupPath: backupPath,
        output: execRes.stdout.trim()
    };
}

// =========================================================================
// Advanced editing tools: 2D rubber-band/contour editing, 3D elastic/copy/
// mirror/group, panel plastics, and Extrusion/Trajectory profiles
// =========================================================================

function handlePanelEditContour(body) {
    var reqBody = body || {};
    if (reqBody.uid === undefined || reqBody.uid === null) {
        throw new Error("Provide 'uid' of the target panel");
    }
    var panel = resolvePanelByUid(reqBody.uid, "uid");
    var action = String(reqBody.action || "elastic").toLowerCase();

    try { Undo.Changing(panel); } catch (e) {}

    var c = panel.Contour;
    var details = {};

    if (action === "elastic") {
        var x1 = Number(reqBody.x1 || 0);
        var y1 = Number(reqBody.y1 || 0);
        var x2 = Number(reqBody.x2 || 0);
        var y2 = Number(reqBody.y2 || 0);
        var dx = Number(reqBody.dx || 0);
        var dy = Number(reqBody.dy || 0);
        c.Elastic(x1, y1, x2, y2, dx, dy);
        details = { x1: x1, y1: y1, x2: x2, y2: y2, dx: dx, dy: dy };
    } else if (action === "fit") {
        var fx1 = Number(reqBody.x1 || 0);
        var fy1 = Number(reqBody.y1 || 0);
        var fx2 = Number(reqBody.x2 || 0);
        var fy2 = Number(reqBody.y2 || 0);
        c.Fit(fx1, fy1, fx2, fy2);
        details = { x1: fx1, y1: fy1, x2: fx2, y2: fy2 };
    } else if (action === "rounding" || action === "fillet") {
        var corners = Array.isArray(reqBody.corners) && reqBody.corners.length > 0
            ? reqBody.corners
            : [{ x: Number(reqBody.x || 0), y: Number(reqBody.y || 0), radius: Number(reqBody.radius || 10) }];
        for (var i = 0; i < corners.length; i++) {
            var r = corners[i];
            c.Rounding(Number(r.x || 0), Number(r.y || 0), Number(r.radius !== undefined ? r.radius : (reqBody.radius || 10)));
        }
        details = { cornersApplied: corners.length };
    } else if (action === "chamfer" || action === "facet") {
        var fCorners = Array.isArray(reqBody.corners) && reqBody.corners.length > 0
            ? reqBody.corners
            : [{ x: Number(reqBody.x || 0), y: Number(reqBody.y || 0), length: Number(reqBody.length || 10) }];
        for (var j = 0; j < fCorners.length; j++) {
            var f = fCorners[j];
            c.Facet(Number(f.x || 0), Number(f.y || 0), Number(f.length !== undefined ? f.length : (reqBody.length || 10)));
        }
        details = { cornersApplied: fCorners.length };
    } else if (action === "symmetry" || action === "mirror") {
        var sx1 = Number(reqBody.x1 || 0);
        var sy1 = Number(reqBody.y1 || 0);
        var sx2 = Number(reqBody.x2 || 0);
        var sy2 = Number(reqBody.y2 || 0);
        var copy = reqBody.copy === true;
        c.Symmetry(sx1, sy1, sx2, sy2, copy);
        details = { x1: sx1, y1: sy1, x2: sx2, y2: sy2, copy: copy };
    } else if (action === "offset" || action === "equidistant") {
        var offset = Number(reqBody.offset || 0);
        var side = reqBody.side !== false;
        var rounding = reqBody.rounding === true;
        var clone = NewContour();
        clone.Addition(c);
        if (reqBody.replace !== false) {
            c.Clear();
        }
        c.AddEquidistant(clone, offset, side, rounding);
        details = { offset: offset, side: side, rounding: rounding };
    } else if (action === "load_frw") {
        if (!reqBody.file) throw new Error("Provide 'file' path to a .frw contour file");
        var loaded = c.Load(String(reqBody.file));
        if (!loaded) throw new Error("Contour.Load failed for: " + reqBody.file);
        details = { file: String(reqBody.file), loaded: true };
    } else {
        throw new Error("Unsupported contour action: " + action);
    }

    panel.Build();
    Action.Commit();
    if (reqBody.viewAll) ViewAll();

    var refreshed = findObjectByUid(Number(reqBody.uid));
    return {
        action: action,
        details: details,
        panel: refreshed ? serializeObject(refreshed, 0, 2) : null
    };
}

function handleObjectEdit(body) {
    var reqBody = body || {};
    var action = String(reqBody.action || "").toLowerCase();
    if (!action) throw new Error("Provide 'action' ('elastic_resize', 'copy', 'mirror', or 'group')");

    if (action === "group") {
        var uids = Array.isArray(reqBody.uids) ? reqBody.uids : [];
        if (uids.length === 0) throw new Error("Provide non-empty 'uids' array for action='group'");
        var objs = [];
        for (var g = 0; g < uids.length; g++) {
            var o = findObjectByUid(Number(uids[g]));
            if (!o) throw new Error("Object UID " + uids[g] + " not found");
            objs.push(o);
        }
        var groupName = String(reqBody.name || "Group");
        var isAssembly = reqBody.asAssembly === true;
        var prevCount = safeGet(function () { return Model.Count; }, 0);
        var container = isAssembly ? AddAssembly(groupName) : AddBlock(groupName);
        for (var k = 0; k < objs.length; k++) {
            try { Undo.Changing(objs[k]); } catch (e) {}
            objs[k].Owner = container;
        }
        Action.Commit();
        if (reqBody.viewAll) ViewAll();
        var newCount = safeGet(function () { return Model.Count; }, 0);
        var created = newCount > prevCount ? safeGet(function () { return Model.Objects[newCount - 1]; }, null) : null;
        return {
            action: "group",
            asAssembly: isAssembly,
            groupedCount: objs.length,
            object: created ? serializeObject(created, 0, 3) : null
        };
    }

    if (reqBody.uid === undefined || reqBody.uid === null) {
        throw new Error("Provide 'uid' of the target object");
    }
    var target = findObjectByUid(Number(reqBody.uid));
    if (!target) throw new Error("Object UID " + reqBody.uid + " not found");

    if (action === "elastic_resize") {
        var isEl = safeGet(function () { return typeof target.IsElastic === "function" && target.IsElastic(); }, false);
        if (!isEl) {
            throw new Error("Object UID " + reqBody.uid + " is not elastic (IsElastic() === false)");
        }
        var sz = reqBody.size || {};
        var curMin = safeGet(function () { return target.GabMin; }, { x: 0, y: 0, z: 0 });
        var curMax = safeGet(function () { return target.GabMax; }, { x: 0, y: 0, z: 0 });
        var nx = typeof sz.x === "number" ? sz.x : (curMax.x - curMin.x);
        var ny = typeof sz.y === "number" ? sz.y : (curMax.y - curMin.y);
        var nz = typeof sz.z === "number" ? sz.z : (curMax.z - curMin.z);
        try { Undo.RecursiveChanging(target); } catch (e) { try { Undo.Changing(target); } catch (e2) {} }
        target.ElasticResize(NewVector(nx, ny, nz));
        Action.Commit();
        if (reqBody.viewAll) ViewAll();
        var after = findObjectByUid(Number(reqBody.uid));
        return {
            action: "elastic_resize",
            requestedSize: { x: nx, y: ny, z: nz },
            object: after ? serializeObject(after, 0, 3) : null
        };
    }

    if (action === "copy") {
        var count = Math.max(1, Math.min(50, Math.floor(Number(reqBody.count || 1))));
        var off = reqBody.offset || { x: 0, y: 0, z: 0 };
        var dx = Number(off.x || 0);
        var dy = Number(off.y || 0);
        var dz = Number(off.z || 0);
        var prevC = safeGet(function () { return Model.Count; }, 0);
        for (var ci = 1; ci <= count; ci++) {
            var copyObj = AddCopy(target);
            if (reqBody.name) {
                copyObj.Name = count > 1 ? (String(reqBody.name) + " " + ci) : String(reqBody.name);
            }
            if (dx !== 0 || dy !== 0 || dz !== 0) {
                copyObj.Translate(dx * ci, dy * ci, dz * ci);
            }
        }
        Action.Commit();
        if (reqBody.viewAll) ViewAll();
        var newC = safeGet(function () { return Model.Count; }, 0);
        var copies = [];
        for (var m = prevC; m < newC; m++) {
            var co = safeGet(function () { return Model.Objects[m]; }, null);
            if (co) copies.push(serializeObject(co, 0, 2));
        }
        return {
            action: "copy",
            sourceUid: Number(reqBody.uid),
            createdCount: copies.length,
            created: copies
        };
    }

    if (action === "mirror" || action === "symmetry") {
        var pos = reqBody.point || { x: 0, y: 0, z: 0 };
        var norm = reqBody.normal || null;
        if (!norm) {
            var pl = String(reqBody.plane || "yz").toLowerCase();
            var coord = typeof reqBody.coord === "number" ? reqBody.coord : 0;
            if (pl === "yz" || pl === "x") {
                pos = { x: coord, y: 0, z: 0 };
                norm = { x: 1, y: 0, z: 0 };
            } else if (pl === "xz" || pl === "y") {
                pos = { x: 0, y: coord, z: 0 };
                norm = { x: 0, y: 1, z: 0 };
            } else if (pl === "xy" || pl === "z") {
                pos = { x: 0, y: 0, z: coord };
                norm = { x: 0, y: 0, z: 1 };
            } else {
                throw new Error("Invalid mirror plane '" + pl + "' (use 'yz', 'xz', 'xy', or explicit point + normal)");
            }
        }
        var prevM = safeGet(function () { return Model.Count; }, 0);
        var mirrored = AddSymmetry(target, NewVector(Number(pos.x || 0), Number(pos.y || 0), Number(pos.z || 0)), NewVector(Number(norm.x || 0), Number(norm.y || 0), Number(norm.z || 0)));
        if (reqBody.name && mirrored) {
            mirrored.Name = String(reqBody.name);
        }
        if (reqBody.deleteOriginal === true) {
            DeleteObject(target);
        }
        Action.Commit();
        if (reqBody.viewAll) ViewAll();
        var newM = safeGet(function () { return Model.Count; }, 0);
        var createdObj = newM > prevM ? safeGet(function () { return Model.Objects[newM - 1]; }, null) : null;
        return {
            action: "mirror",
            point: pos,
            normal: norm,
            deleteOriginal: reqBody.deleteOriginal === true,
            object: createdObj ? serializeObject(createdObj, 0, 2) : null
        };
    }

    throw new Error("Unsupported object edit action: " + action);
}

function handlePanelPlastic(body) {
    var reqBody = body || {};
    if (reqBody.uid === undefined || reqBody.uid === null) {
        throw new Error("Provide 'uid' of the target panel");
    }
    var panel = resolvePanelByUid(reqBody.uid, "uid");
    var action = String(reqBody.action || "add").toLowerCase();
    var side = String(reqBody.side || "front").toLowerCase(); // front | back | both

    try { Undo.Changing(panel); } catch (e) {}

    if (action === "clear") {
        var plastics = safeGet(function () { return panel.Plastics; }, null);
        var removed = 0;
        if (plastics) {
            var count = safeGet(function () { return plastics.Count; }, 0);
            for (var i = count - 1; i >= 0; i--) {
                var pl = plastics[i];
                var isFront = safeGet(function () { return !!pl.Front; }, true);
                if (side === "both" || (side === "front" && isFront) || (side === "back" && !isFront)) {
                    plastics.Delete(i);
                    removed++;
                }
            }
        }
        panel.Build();
        Action.Commit();
        var afterClear = findObjectByUid(Number(reqBody.uid));
        return { action: "clear", side: side, removed: removed, panel: afterClear ? serializeObject(afterClear, 0, 2) : null };
    }

    if (!reqBody.material) {
        throw new Error("Provide 'material' name for panel plastic/laminate");
    }
    var thickness = typeof reqBody.thickness === "number" ? reqBody.thickness : 0.8;
    var matStr = String(reqBody.material);
    var prevMatName = safeGet(function () { return ActiveMaterial.Name; }, "");
    var prevMatThick = safeGet(function () { return ActiveMaterial.Thickness; }, 16);
    var added = 0;

    try {
        var sides = side === "both" ? [true, false] : [side !== "back"];
        for (var s = 0; s < sides.length; s++) {
            var p = panel.AddPlastic(matStr, sides[s]);
            if (p && typeof thickness === "number") {
                try { p.Thickness = thickness; } catch (e) {}
            }
            added++;
        }
        panel.Build();
    } finally {
        if (prevMatName) {
            try { ActiveMaterial.Make(prevMatName, prevMatThick); } catch (e) {}
        }
    }

    Action.Commit();
    var refreshed = findObjectByUid(Number(reqBody.uid));
    return {
        action: "add",
        material: matStr,
        thickness: thickness,
        side: side,
        added: added,
        panel: refreshed ? serializeObject(refreshed, 0, 2) : null
    };
}

function fillContour2DFromSpec(contour, spec) {
    var s = spec || {};
    if (s.frwFile) {
        if (!contour.Load(String(s.frwFile))) {
            throw new Error("Failed to load .frw contour: " + s.frwFile);
        }
        return;
    }
    if (Array.isArray(s.points) && s.points.length >= 2) {
        var pts = s.points;
        for (var i = 0; i < pts.length - 1; i++) {
            contour.AddLine(Number(pts[i].x || 0), Number(pts[i].y || 0), Number(pts[i + 1].x || 0), Number(pts[i + 1].y || 0));
        }
        if (s.closed !== false && pts.length >= 3) {
            var last = pts[pts.length - 1];
            var first = pts[0];
            if (last.x !== first.x || last.y !== first.y) {
                contour.AddLine(Number(last.x || 0), Number(last.y || 0), Number(first.x || 0), Number(first.y || 0));
            }
        }
        return;
    }
    var shape = String(s.shape || "rect").toLowerCase();
    if (shape === "circle") {
        contour.AddCircle(Number(s.cx || 0), Number(s.cy || 0), Number(s.radius || 10));
    } else {
        var w = Number(s.width || 40);
        var h = Number(s.height || 20);
        var x1 = s.x1 !== undefined ? Number(s.x1) : 0;
        var y1 = s.y1 !== undefined ? Number(s.y1) : 0;
        var x2 = s.x2 !== undefined ? Number(s.x2) : (x1 + w);
        var y2 = s.y2 !== undefined ? Number(s.y2) : (y1 + h);
        contour.AddRectangle(x1, y1, x2, y2);
    }
}

function handleCreateProfile(body) {
    var reqBody = body || {};
    var mode = String(reqBody.mode || "extrusion").toLowerCase();
    var name = String(reqBody.name || (mode === "trajectory" ? "Trajectory Profile" : "Extrusion Profile"));
    var prevCount = safeGet(function () { return Model.Count; }, 0);

    var obj;
    if (mode === "trajectory") {
        obj = AddTrajectory(name);
        fillContour2DFromSpec(obj.Contour2D, reqBody.profile || { shape: "rect", width: 40, height: 20 });
        var trajSpec = reqBody.trajectory || { points: [{ x: 0, y: 0 }, { x: 600, y: 0 }], closed: false };
        if (trajSpec.closed === undefined && Array.isArray(trajSpec.points)) {
            trajSpec.closed = false;
        }
        fillContour2DFromSpec(obj.Trajectory2D, trajSpec);
    } else {
        obj = AddExtrusion(name);
        fillContour2DFromSpec(obj.Contour, reqBody.profile || {
            shape: reqBody.shape || "rect",
            width: reqBody.width || 40,
            height: reqBody.height || 20,
            radius: reqBody.radius,
            points: reqBody.points,
            frwFile: reqBody.frwFile
        });
        obj.Thickness = Number(reqBody.length !== undefined ? reqBody.length : (reqBody.thickness || 600));
    }

    if (reqBody.materialName) {
        try { obj.MaterialName = String(reqBody.materialName); } catch (e) {}
    }
    if (reqBody.position && typeof reqBody.position === "object") {
        obj.Translate(
            Number(reqBody.position.x || 0),
            Number(reqBody.position.y || 0),
            Number(reqBody.position.z || 0)
        );
    }
    if (reqBody.rotate && typeof reqBody.rotate === "object") {
        var axis = String(reqBody.rotate.axis || "y").toLowerCase();
        var angle = Number(reqBody.rotate.angle || 0);
        if (axis === "x") obj.RotateX(angle);
        else if (axis === "z") obj.RotateZ(angle);
        else obj.RotateY(angle);
    }

    obj.Build();
    Action.Commit();
    if (reqBody.viewAll) ViewAll();

    var newCount = safeGet(function () { return Model.Count; }, 0);
    var created = newCount > prevCount ? safeGet(function () { return Model.Objects[newCount - 1]; }, null) : null;
    return {
        mode: mode,
        object: created ? serializeObject(created, 0, 2) : null
    };
}

function handleScreenshot(body) {
    var reqBody = body || {};
    var target = String(reqBody.target || "bazis").toLowerCase(); // bazis | screen
    var returnBase64 = reqBody.returnBase64 !== false;

    if (reqBody.orientCamera) {
        var oc = reqBody.orientCamera;
        var vec = null;
        if (typeof oc === "string") {
            var preset = oc.toLowerCase();
            if (preset === "front") vec = NewVector(0, 0, -1);
            else if (preset === "back") vec = NewVector(0, 0, 1);
            else if (preset === "left") vec = NewVector(1, 0, 0);
            else if (preset === "right") vec = NewVector(-1, 0, 0);
            else if (preset === "top") vec = NewVector(0, -1, 0);
            else if (preset === "iso") vec = NewVector(-1, -0.7, -1);
        } else if (typeof oc === "object") {
            vec = NewVector(Number(oc.x || 0), Number(oc.y || 0), Number(oc.z || -1));
        }
        if (vec) {
            try { OrientCamera(vec); } catch (e) {}
        }
    }
    if (reqBody.viewAll === true) {
        try { ViewAll(); } catch (e) {}
    }
    if (reqBody.orientCamera || reqBody.viewAll === true) {
        try { system.sleep(150); } catch (e) {}
    }

    var tmpDir = process.env.TEMP || "C:\\Windows\\Temp";
    var tag = "bazis_shot_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    var psFile = path.join(tmpDir, tag + ".ps1");
    var isTempOut = !reqBody.filename;
    var outFile = isTempOut ? path.join(tmpDir, tag + ".png") : path.resolve(String(reqBody.filename));
    ensureDirRecursive(path.dirname(outFile));

    var psLines = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "Add-Type @\"",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public class BazisWin32Shot {",
        "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
        "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);",
        "}",
        "\"@",
        "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "$x = $bounds.X; $y = $bounds.Y; $w = $bounds.Width; $h = $bounds.Height"
    ];
    if (target !== "screen") {
        psLines.push("$proc = Get-Process | Where-Object { $_.ProcessName -like \"Bazis*\" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1");
        psLines.push("if ($proc) {");
        psLines.push("  $r = New-Object BazisWin32Shot+RECT");
        psLines.push("  if ([BazisWin32Shot]::GetWindowRect($proc.MainWindowHandle, [ref]$r)) {");
        psLines.push("    $rw = $r.Right - $r.Left; $rh = $r.Bottom - $r.Top");
        psLines.push("    if ($rw -gt 100 -and $rh -gt 100) { $x = $r.Left; $y = $r.Top; $w = $rw; $h = $rh }");
        psLines.push("  }");
        psLines.push("}");
    }
    psLines.push("$bmp = New-Object System.Drawing.Bitmap($w, $h)");
    psLines.push("$g = [System.Drawing.Graphics]::FromImage($bmp)");
    psLines.push("$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)");
    psLines.push("$bmp.Save(\"" + outFile.replace(/\\/g, "\\\\") + "\", [System.Drawing.Imaging.ImageFormat]::Png)");
    psLines.push("$g.Dispose(); $bmp.Dispose()");

    fs.writeFileSync(psFile, psLines.join("\r\n"), "utf8");
    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) {}

    var sh = NewCOMObject("WScript.Shell");
    var rc = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"" + psFile + "\"", 0, true);
    try { fs.unlinkSync(psFile); } catch (e) {}

    if (!fs.existsSync(outFile)) {
        throw new Error("Screenshot capture failed (rc=" + rc + ")");
    }
    var buf = fs.readFileSync(outFile);
    var width = buf.length >= 24 ? buf.readUInt32BE(16) : null;
    var height = buf.length >= 24 ? buf.readUInt32BE(20) : null;
    var b64 = returnBase64 ? buf.toString("base64") : null;
    if (isTempOut) {
        try { fs.unlinkSync(outFile); } catch (e) {}
    }

    var res = {
        captured: true,
        target: target,
        mimeType: "image/png",
        width: width,
        height: height,
        sizeBytes: buf.length,
        savedPath: isTempOut ? null : outFile
    };
    if (b64) res.base64 = b64;
    return res;
}

function handleEval(body) {
    if (!body || typeof body.code !== "string") {
        throw new Error("Request body must contain string field 'code'");
    }
    var logs = [];
    var log = function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            if (typeof arg === "string") {
                parts.push(arg);
            } else {
                try {
                    parts.push(JSON.stringify(arg));
                } catch (e) {
                    parts.push(String(arg));
                }
            }
        }
        logs.push(parts.join(" "));
    };

    var fn = new Function("log", "params", body.code);
    var value = fn(log, body.params || {});

    if (body.commit === true) {
        Action.Commit();
    }

    var safeValue = value;
    try {
        JSON.stringify(value);
    } catch (e) {
        safeValue = String(value);
    }

    return {
        result: safeValue === undefined ? null : safeValue,
        logs: logs
    };
}

function isLoopbackAddress(addr) {
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function isAuthorized(req) {
    if (NO_AUTH) return true;
    var remote = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    if (isLoopbackAddress(remote)) return true;

    var authHeader = req.headers["authorization"] || "";
    if (authHeader === "Bearer " + TOKEN) return true;
    var tokenHeader = req.headers["x-bazis-token"] || "";
    if (tokenHeader === TOKEN) return true;
    return false;
}

function parseQuery(rawUrl) {
    var out = {};
    var idx = rawUrl.indexOf("?");
    if (idx === -1) return out;
    var qs = rawUrl.slice(idx + 1).split("&");
    for (var i = 0; i < qs.length; i++) {
        var kv = qs[i].split("=");
        if (kv[0]) {
            out[decodeURIComponent(kv[0])] = kv[1] !== undefined ? decodeURIComponent(kv[1]) : "";
        }
    }
    return out;
}

function sendJson(res, statusCode, payload) {
    var text = JSON.stringify(payload, null, 2);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text, "utf8")
    });
    res.end(text);
}

function readJsonBody(req, callback) {
    var chunks = [];
    req.on("data", function (chunk) {
        chunks.push(chunk);
    });
    req.on("end", function () {
        var raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
            callback(null, {});
            return;
        }
        try {
            callback(null, JSON.parse(raw));
        } catch (e) {
            callback(new Error("Invalid JSON body: " + e.message));
        }
    });
    req.on("error", function (err) {
        callback(err);
    });
}

// UI controls in Bazis Properties panel.
var advertisedUrls = buildAdvertisedUrls();

var urlProp = Action.Properties.NewString("MCP Bridge URL");
urlProp.Value = advertisedUrls[0] || ("http://" + HOST + ":" + PORT);
urlProp.Enabled = false;

var tokenProp = Action.Properties.NewString("Bridge Token");
tokenProp.Value = NO_AUTH ? "(disabled)" : TOKEN;
tokenProp.Enabled = false;

var statusProp = Action.Properties.NewString("Status");
statusProp.Value = "Starting...";
statusProp.Enabled = false;

var reloadBtn = Action.Properties.NewButton("Reload MCP Bridge");
var stopBtn = Action.Properties.NewButton("Stop MCP Bridge");

function resolveBridgeScriptPath() {
    var candidates = [
        path.join(getBazisDocumentsRoot(), "Scripts", "bridge.js")
    ];
    if (typeof __filename === "string" && __filename) {
        candidates.unshift(__filename);
    }
    for (var i = 0; i < candidates.length; i++) {
        try {
            if (fs.existsSync(candidates[i])) return candidates[i];
        } catch (e) {}
    }
    return candidates[candidates.length - 1];
}

function reloadBridge() {
    if (stopped) return;
    stopped = true;
    statusProp.Value = "Reloading...";
    Action.Hint = "Reloading Bazis MCP Bridge...";
    if (ipcTimer) {
        try { clearInterval(ipcTimer); } catch (e) {}
        ipcTimer = null;
    }

    var doExec = function () {
        setTimeout(function () {
            try {
                var scriptPath = resolveBridgeScriptPath();
                if (!fs.existsSync(scriptPath)) {
                    alert("Reload failed: bridge.js not found at " + scriptPath);
                    Action.Finish();
                    return;
                }
                var code = fs.readFileSync(scriptPath, "utf8");
                if (code.charCodeAt(0) === 0xFEFF) code = code.slice(1);
                try { Action.Properties.Clear(); } catch (e) {}
                var fn = new Function(code);
                fn();
            } catch (err) {
                system.log("Bazis MCP bridge reload error: " + (err && err.stack ? err.stack : err));
                alert("Bazis MCP bridge reload failed:\n" + (err && err.message ? err.message : String(err)));
                Action.Finish();
            }
        }, 120);
    };

    if (server) {
        var srv = server;
        server = null;
        try {
            srv.close(doExec);
        } catch (e) {
            doExec();
        }
    } else {
        doExec();
    }
}

function shutdown(fromFinish) {
    if (stopped) return;
    stopped = true;
    statusProp.Value = "Stopped";
    Action.Hint = "";
    if (ipcTimer) {
        try { clearInterval(ipcTimer); } catch (e) {}
        ipcTimer = null;
    }
    cleanIpcDir();
    removeEndpointFiles();
    if (server) {
        try {
            server.close();
        } catch (e) {
            system.log("Bazis MCP bridge close error: " + e);
        }
        server = null;
    }
    if (!fromFinish) {
        Action.Finish();
    }
}

reloadBtn.OnClick = function () {
    reloadBridge();
};

stopBtn.OnClick = function () {
    shutdown(false);
};

Action.OnFinish = function () {
    shutdown(true);
};

function dispatchRequest(method, urlPath, query, body, transportLabel) {
    requestCount++;
    statusProp.Value = "Running (" + requestCount + " req via " + transportLabel + ", last: " + method + " " + urlPath + ")";

    try {
        if (method === "GET" && urlPath === "/health") {
            return {
                status: 200,
                payload: {
                    ok: true,
                    transport: transportLabel,
                    apiVersion: safeGet(function () { return system.apiVersion; }, null),
                    developerApiVersion: safeGet(function () { return system.developerApiVersion; }, null),
                    modelFilename: safeGet(function () { return Action.ModelFilename || ModelFilename; }, ""),
                    articleName: safeGet(function () { return Article.Name; }, ""),
                    objectCount: safeGet(function () { return Model.Count; }, 0),
                    urls: advertisedUrls,
                    ipcActive: !!ipcTimer,
                    requestCount: requestCount,
                    uptimeMs: Date.now() - startedAt
                }
            };
        }

        if (method === "GET" && urlPath === "/model") {
            var maxDepth = query && query.maxDepth !== undefined ? Number(query.maxDepth) : 8;
            return { status: 200, payload: { ok: true, model: getModelSnapshot(maxDepth) } };
        }

        if (method === "GET" && urlPath === "/bom") {
            return { status: 200, payload: { ok: true, bom: getBom() } };
        }

        if (method === "GET" && urlPath === "/inspect") {
            return { status: 200, payload: { ok: true, inspection: handleInspect({}) } };
        }

        if (method === "GET" && urlPath === "/fasteners") {
            return { status: 200, payload: { ok: true, fasteners: handleListFasteners(query || {}) } };
        }

        if (method === "GET" && urlPath === "/materials") {
            return { status: 200, payload: { ok: true, materials: handleMaterials({ action: "get" }) } };
        }

        if (method === "GET" && urlPath === "/scripts") {
            return { status: 200, payload: { ok: true, scripts: handleListScripts(query || {}) } };
        }

        if (method === "GET" && urlPath === "/library") {
            return { status: 200, payload: { ok: true, library: handleListLibrary(query || {}) } };
        }

        if (method === "GET" && urlPath === "/db/info") {
            return { status: 200, payload: { ok: true, db: handleDbInfo(query || {}) } };
        }

        if (method === "POST") {
            var reqBody = body || {};
            if (urlPath === "/panel") {
                return { status: 200, payload: { ok: true, panel: handleCreatePanel(reqBody) } };
            } else if (urlPath === "/panel/butt") {
                return { status: 200, payload: { ok: true, result: handlePanelButt(reqBody) } };
            } else if (urlPath === "/panel/cut") {
                return { status: 200, payload: { ok: true, result: handlePanelCut(reqBody) } };
            } else if (urlPath === "/panel/cutout") {
                return { status: 200, payload: { ok: true, result: handlePanelCutout(reqBody) } };
            } else if (urlPath === "/panel/contour") {
                return { status: 200, payload: { ok: true, result: handlePanelEditContour(reqBody) } };
            } else if (urlPath === "/panel/plastic") {
                return { status: 200, payload: { ok: true, result: handlePanelPlastic(reqBody) } };
            } else if (urlPath === "/object/edit") {
                return { status: 200, payload: { ok: true, result: handleObjectEdit(reqBody) } };
            } else if (urlPath === "/profile") {
                return { status: 200, payload: { ok: true, result: handleCreateProfile(reqBody) } };
            } else if (urlPath === "/carcass") {
                return { status: 200, payload: { ok: true, carcass: handleCreateCarcass(reqBody) } };
            } else if (urlPath === "/doors") {
                return { status: 200, payload: { ok: true, doors: handleAddDoors(reqBody) } };
            } else if (urlPath === "/drawers") {
                return { status: 200, payload: { ok: true, drawers: handleAddDrawers(reqBody) } };
            } else if (urlPath === "/fasteners/mount") {
                return { status: 200, payload: { ok: true, result: handleMountFastener(reqBody) } };
            } else if (urlPath === "/materials") {
                return { status: 200, payload: { ok: true, materials: handleMaterials(reqBody) } };
            } else if (urlPath === "/export") {
                return { status: 200, payload: { ok: true, export: handleExport(reqBody) } };
            } else if (urlPath === "/scripts/run") {
                return { status: 200, payload: { ok: true, script: handleRunScript(reqBody) } };
            } else if (urlPath === "/library/open") {
                return { status: 200, payload: { ok: true, result: handleOpenLibrary(reqBody) } };
            } else if (urlPath === "/library/save") {
                return { status: 200, payload: { ok: true, result: handleSaveLibrary(reqBody) } };
            } else if (urlPath === "/bbb/read") {
                return { status: 200, payload: { ok: true, bbb: handleBbbRead(reqBody) } };
            } else if (urlPath === "/bbb/write") {
                return { status: 200, payload: { ok: true, bbb: handleBbbWrite(reqBody) } };
            } else if (urlPath === "/db/query") {
                return { status: 200, payload: { ok: true, db: handleDbQuery(reqBody) } };
            } else if (urlPath === "/db/execute") {
                return { status: 200, payload: { ok: true, db: handleDbExecute(reqBody) } };
            } else if (urlPath === "/object/delete") {
                return { status: 200, payload: { ok: true, result: handleDeleteObject(reqBody) } };
            } else if (urlPath === "/object/transform") {
                return { status: 200, payload: { ok: true, object: handleTransformObject(reqBody) } };
            } else if (urlPath === "/inspect") {
                return { status: 200, payload: { ok: true, inspection: handleInspect(reqBody) } };
            } else if (urlPath === "/scene") {
                return { status: 200, payload: { ok: true, result: handleScene(reqBody) } };
            } else if (urlPath === "/screenshot") {
                return { status: 200, payload: { ok: true, screenshot: handleScreenshot(reqBody) } };
            } else if (urlPath === "/eval") {
                var evalRes = handleEval(reqBody);
                return { status: 200, payload: { ok: true, result: evalRes.result, logs: evalRes.logs } };
            } else if (urlPath === "/reload") {
                setTimeout(function () { reloadBridge(); }, 50);
                return { status: 200, payload: { ok: true, reloading: true } };
            } else if (urlPath === "/stop") {
                setTimeout(function () { shutdown(false); }, 50);
                return { status: 200, payload: { ok: true, stopping: true } };
            }
        }

        return { status: 404, payload: { ok: false, error: "Not found: " + method + " " + urlPath } };
    } catch (e) {
        return {
            status: 500,
            payload: {
                ok: false,
                error: e && e.message ? e.message : String(e),
                stack: e && e.stack ? String(e.stack) : null
            }
        };
    }
}

var ipcBusy = false;
function pollIpcDir() {
    if (stopped || ipcBusy || !IPC_DIR) return;
    ipcBusy = true;
    try {
        var entries = fs.readdirSync(IPC_DIR);
        for (var i = 0; i < entries.length; i++) {
            var fname = entries[i];
            if (fname.indexOf("req-") !== 0 || fname.slice(-5) !== ".json") continue;
            var reqPath = path.join(IPC_DIR, fname);
            var raw;
            try {
                raw = fs.readFileSync(reqPath, "utf8");
                fs.unlinkSync(reqPath);
            } catch (readErr) {
                continue;
            }
            var reqObj;
            try {
                reqObj = JSON.parse(raw);
            } catch (parseErr) {
                continue;
            }
            var reqId = reqObj.id || fname.slice(4, -5);
            var rawUrl = reqObj.path || "/";
            var urlPath = rawUrl.split("?")[0];
            var query = reqObj.query || parseQuery(rawUrl);
            var result = dispatchRequest(reqObj.method || "GET", urlPath, query, reqObj.body || {}, "ipc");

            var resTmp = path.join(IPC_DIR, "res-" + reqId + ".tmp");
            var resFinal = path.join(IPC_DIR, "res-" + reqId + ".json");
            try {
                fs.writeFileSync(resTmp, JSON.stringify({
                    id: reqId,
                    status: result.status,
                    data: result.payload
                }), "utf8");
                fs.renameSync(resTmp, resFinal);
            } catch (writeErr) {
                system.log("Bazis MCP bridge IPC write error: " + writeErr);
            }
        }
    } catch (e) {
        // Ignore transient shared-folder errors.
    } finally {
        ipcBusy = false;
    }
}

server = http.createServer(function (req, res) {
    if (!isAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized: missing or invalid token" });
        return;
    }

    var method = req.method || "GET";
    var rawUrl = req.url || "/";
    var urlPath = rawUrl.split("?")[0];
    var query = parseQuery(rawUrl);

    if (method === "POST") {
        readJsonBody(req, function (err, body) {
            if (err) {
                sendJson(res, 400, { ok: false, error: err.message });
                return;
            }
            var out = dispatchRequest(method, urlPath, query, body, "http");
            sendJson(res, out.status, out.payload);
        });
        return;
    }

    var out = dispatchRequest(method, urlPath, query, {}, "http");
    sendJson(res, out.status, out.payload);
});

server.on("error", function (err) {
    statusProp.Value = "Error: " + err.message;
    system.log("Bazis MCP bridge server error: " + err.message);
    alert("Bazis MCP bridge failed to start on " + HOST + ":" + PORT + "\n" + err.message);
    shutdown(false);
});

server.listen(PORT, HOST, function () {
    advertisedUrls = buildAdvertisedUrls();
    var ipcReady = initIpcDir();
    if (ipcReady) {
        ipcTimer = setInterval(pollIpcDir, IPC_POLL_MS);
    }
    urlProp.Value = (advertisedUrls[0] || ("http://" + HOST + ":" + PORT)) + (ipcReady ? " + Shared IPC" : "");
    writeEndpointFiles(advertisedUrls);
    statusProp.Value = "Listening (" + (ipcReady ? "Shared IPC + " : "") + advertisedUrls.join(", ") + ")";
    Action.Hint = "Bazis MCP Bridge ready (" + urlProp.Value + ")";
    system.log("Bazis MCP bridge listening on " + advertisedUrls.join(", ") + (ipcReady ? " + IPC " + IPC_DIR : ""));
});

Action.Continue();
