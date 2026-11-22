// Bazis-Mebelshchik 2022+ Script: Import Blum E-SERVICES BXF2 (.bxf2)
//
// Workflow:
//   1. Prompts to select a Blum E-SERVICES .bxf2 XML file.
//   2. Prompts to choose target document type: Fragment (.fr3d) or Model (.b3d).
//   3. Prompts for the save location and filename.
//   4. Parses BXF2 parts, 3D transformations, grooves, and Blum hardware articles,
//      builds the 3D panels in Bazis, saves the file, and displays a summary.

function parseAttrs(attrStr) {
    var attrs = {};
    var re = /([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g;
    var m;
    while ((m = re.exec(attrStr || "")) !== null) {
        attrs[m[1]] = m[2];
    }
    return attrs;
}

function getTagText(xml, tagName) {
    var re = new RegExp("<" + tagName + "[^>]*>([\\s\\S]*?)<\\/" + tagName + ">");
    var m = xml.match(re);
    return m ? m[1].trim() : "";
}

function getAllBlocks(xml, tagName) {
    var out = [];
    var re = new RegExp(
        "<" + tagName + "(\\s[^>]*)?\\/>|<" + tagName + "(\\s[^>]*)?>([\\s\\S]*?)<\\/" + tagName + ">",
        "g"
    );
    var m;
    while ((m = re.exec(xml)) !== null) {
        out.push({
            attrs: parseAttrs(m[1] || m[2] || ""),
            body: m[3] || ""
        });
    }
    return out;
}

function parseNums(str) {
    var parts = String(str || "").trim().split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) out.push(Number(parts[i]) || 0);
    return out;
}

function rotatePointAxisAngle(pt, ax, ay, az, deg) {
    var len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-9 || Math.abs(deg) < 1e-9) return { x: pt.x, y: pt.y, z: pt.z };
    var ux = ax / len, uy = ay / len, uz = az / len;
    var rad = deg * Math.PI / 180;
    var c = Math.cos(rad);
    var s = Math.sin(rad);
    var dot = ux * pt.x + uy * pt.y + uz * pt.z;
    var cx = uy * pt.z - uz * pt.y;
    var cy = uz * pt.x - ux * pt.z;
    var cz = ux * pt.y - uy * pt.x;
    return {
        x: pt.x * c + cx * s + ux * dot * (1 - c),
        y: pt.y * c + cy * s + uy * dot * (1 - c),
        z: pt.z * c + cz * s + uz * dot * (1 - c)
    };
}

function parseTransformSteps(blockBody) {
    var steps = [];
    var tBlocks = getAllBlocks(blockBody, "transformation");
    for (var i = 0; i < tBlocks.length; i++) {
        var a = tBlocks[i].attrs;
        if (a.rotation) {
            var r = parseNums(a.rotation);
            steps.push({ type: "rot", ax: r[0] || 0, ay: r[1] || 0, az: r[2] || 0, deg: r[3] || 0 });
        }
        if (a.translation) {
            var t = parseNums(a.translation);
            steps.push({ type: "trans", x: t[0] || 0, y: t[1] || 0, z: t[2] || 0 });
        }
    }
    return steps;
}

function applySteps(pt, steps) {
    var cur = { x: pt.x, y: pt.y, z: pt.z };
    for (var i = 0; i < steps.length; i++) {
        var st = steps[i];
        if (st.type === "rot") {
            cur = rotatePointAxisAngle(cur, st.ax, st.ay, st.az, st.deg);
        } else if (st.type === "trans") {
            cur = { x: cur.x + st.x, y: cur.y + st.y, z: cur.z + st.z };
        }
    }
    return cur;
}

function parseBxf2ForBazis(xml) {
    if (!xml || xml.indexOf("<bxf") === -1) {
        throw new Error("Selected file is not a valid Blum BXF2 XML document.");
    }

    var machinings = {};
    var mBlock = (getAllBlocks(xml, "machinings")[0] || {}).body || "";
    var mList = getAllBlocks(mBlock, "machining");
    for (var mi = 0; mi < mList.length; mi++) {
        var ma = mList[mi].attrs;
        machinings[ma.id] = {
            id: ma.id,
            type: ma["xsi:type"] || "",
            radius: Number(ma.radius || 0),
            depth: Number(ma.depth || 0),
            length: Number(ma.length || 0)
        };
    }

    var parts = {};
    var pBlock = (getAllBlocks(xml, "parts")[0] || {}).body || "";
    var pList = getAllBlocks(pBlock, "part");
    for (var pi = 0; pi < pList.length; pi++) {
        var pa = pList[pi].attrs;
        var pb = pList[pi].body;
        var ext = parseNums(getTagText(pb, "extent"));
        var grooves = [];
        var mLinks = getAllBlocks(pb, "machiningLink");
        for (var li = 0; li < mLinks.length; li++) {
            var mach = machinings[mLinks[li].attrs.referenceId];
            if (mach && mach.type === "Groove") {
                var tSteps = parseTransformSteps(mLinks[li].body);
                var origin = applySteps({ x: 0, y: 0, z: 0 }, tSteps);
                grooves.push({
                    width: mach.radius * 2,
                    depth: mach.depth,
                    length: mach.length,
                    offsetY: origin.y - mach.radius
                });
            }
        }
        parts[pa.id] = {
            id: pa.id,
            modelKey: pa.modelKey || "",
            description: getTagText(pb, "description") || pa.modelKey || "Part",
            ex: ext[0] || 0,
            ey: ext[1] || 0,
            ez: ext[2] || 0,
            grooves: grooves
        };
    }

    var articles = [];
    var aBlock = (getAllBlocks(xml, "articles")[0] || {}).body || "";
    var aList = getAllBlocks(aBlock, "article");
    for (var ai = 0; ai < aList.length; ai++) {
        var aa = aList[ai].attrs;
        articles.push({
            articleNumber: aa.articleNumber || "",
            itemNumber: aa.itemNumber || "",
            qty: Number(aa.totalQuantity || 1),
            description: getTagText(aList[ai].body, "description")
        });
    }

    var fuBlock = (getAllBlocks(xml, "functionUnits")[0] || {}).body || "";
    var fuList = getAllBlocks(fuBlock, "functionUnit");
    var fu = fuList[0] || { body: "" };
    var unitTitle = getTagText(fu.body, "description") || "Blum BXF2 Import";

    var placedParts = [];
    var partLinks = getAllBlocks(fu.body, "partLink");
    for (var k = 0; k < partLinks.length; k++) {
        var pl = partLinks[k];
        var part = parts[pl.attrs.referenceId];
        if (!part) continue;
        var steps = parseTransformSteps(pl.body);
        var xLo = Math.min(0, part.ex), xHi = Math.max(0, part.ex);
        var yLo = Math.min(0, part.ey), yHi = Math.max(0, part.ey);
        var zLo = Math.min(0, part.ez), zHi = Math.max(0, part.ez);

        var xs = [xLo, xHi], ys = [yLo, yHi], zs = [zLo, zHi];
        var minX = Infinity, minY = Infinity, minZ = Infinity;
        var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (var ix = 0; ix < 2; ix++) {
            for (var iy = 0; iy < 2; iy++) {
                for (var iz = 0; iz < 2; iz++) {
                    var tp = applySteps({ x: xs[ix], y: ys[iy], z: zs[iz] }, steps);
                    if (tp.x < minX) minX = tp.x;
                    if (tp.y < minY) minY = tp.y;
                    if (tp.z < minZ) minZ = tp.z;
                    if (tp.x > maxX) maxX = tp.x;
                    if (tp.y > maxY) maxY = tp.y;
                    if (tp.z > maxZ) maxZ = tp.z;
                }
            }
        }
        placedParts.push({
            name: getTagText(pl.body, "description") || part.description,
            minX: minX, maxX: maxX,
            minY: minY, maxY: maxY,
            minZ: minZ, maxZ: maxZ,
            grooves: part.grooves
        });
    }

    // Shift assembly so its bounding box starts cleanly at (0, 0, 0)
    if (placedParts.length > 0) {
        var gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
        for (var s = 0; s < placedParts.length; s++) {
            if (placedParts[s].minX < gMinX) gMinX = placedParts[s].minX;
            if (placedParts[s].minY < gMinY) gMinY = placedParts[s].minY;
            if (placedParts[s].minZ < gMinZ) gMinZ = placedParts[s].minZ;
        }
        for (var u = 0; u < placedParts.length; u++) {
            placedParts[u].minX = Math.round((placedParts[u].minX - gMinX) * 100) / 100;
            placedParts[u].maxX = Math.round((placedParts[u].maxX - gMinX) * 100) / 100;
            placedParts[u].minY = Math.round((placedParts[u].minY - gMinY) * 100) / 100;
            placedParts[u].maxY = Math.round((placedParts[u].maxY - gMinY) * 100) / 100;
            placedParts[u].minZ = Math.round((placedParts[u].minZ - gMinZ) * 100) / 100;
            placedParts[u].maxZ = Math.round((placedParts[u].maxZ - gMinZ) * 100) / 100;
        }
    }

    return {
        title: unitTitle,
        parts: placedParts,
        articles: articles
    };
}

function main() {
    var bxfPath = system.askFileName("bxf2");
    if (!bxfPath) {
        Action.Finish();
        return;
    }

    var xml = fs.readFileSync(bxfPath, "utf8");
    var data = parseBxf2ForBazis(xml);

    if (data.parts.length === 0) {
        alert("No 3D parts found in BXF2 file:\n" + bxfPath);
        Action.Finish();
        return;
    }

    var saveAsFragment = confirm(
        "Choose document & save type for:\n" + data.title + "\n\n" +
        "Yes = Fragment (.fr3d)\n" +
        "No  = Model (.b3d)"
    );

    var targetExt = saveAsFragment ? "fr3d" : "b3d";
    var savePath = system.askFileNameSave(targetExt);
    if (savePath && !new RegExp("\\." + targetExt + "$", "i").test(savePath)) {
        savePath += "." + targetExt;
    }

    if (saveAsFragment) {
        Action.NewFragment();
    } else {
        Action.NewModel();
    }

    Article.Name = data.title;
    if (data.articles.length > 0) {
        try { Article.Code = data.articles[0].articleNumber; } catch (e) {}
        var notes = [];
        for (var a = 0; a < data.articles.length; a++) {
            notes.push(data.articles[a].articleNumber + " (" + data.articles[a].itemNumber + ") x" + data.articles[a].qty + " - " + data.articles[a].description);
        }
        try { Article.Notes = notes.join("\n"); } catch (e) {}
    }

    var groovesAdded = 0;
    BeginBlock(data.title);
    for (var i = 0; i < data.parts.length; i++) {
        var p = data.parts[i];
        var dx = Math.round((p.maxX - p.minX) * 100) / 100;
        var dy = Math.round((p.maxY - p.minY) * 100) / 100;
        var dz = Math.round((p.maxZ - p.minZ) * 100) / 100;
        var thick = Math.min(dx, dy, dz);
        if (thick <= 0) continue;

        ActiveMaterial.Make("Board " + thick + "mm", thick);
        var panel;
        if (dx <= dy && dx <= dz) {
            panel = AddVertPanel(p.minZ, p.minY, p.maxZ, p.maxY, p.minX);
        } else if (dy <= dx && dy <= dz) {
            panel = AddHorizPanel(p.minX, p.minZ, p.maxX, p.maxZ, p.minY);
        } else {
            panel = AddFrontPanel(p.minX, p.minY, p.maxX, p.maxY, p.minZ);
        }
        panel.Name = p.name;
        panel.Thickness = thick;

        if (p.grooves && p.grooves.length > 0) {
            for (var g = 0; g < p.grooves.length; g++) {
                var gr = p.grooves[g];
                try {
                    var cut = panel.AddCut("Blum Groove");
                    var len = gr.length > 0 ? gr.length : Math.max(dx, dy, dz);
                    var yPos = Math.max(0, gr.offsetY);
                    cut.Trajectory.AddLine(0, yPos, len, yPos);
                    cut.Contour.AddRectangle(0, 0, gr.width, -gr.depth);
                    groovesAdded++;
                } catch (e) {}
            }
        }

        panel.Build();
    }
    EndBlock();

    Action.Commit();
    ViewAll();

    if (savePath) {
        Action.SaveModel(savePath);
    }

    alert(
        "BXF2 import complete!\n" +
        "Title: " + data.title + "\n" +
        "Type: " + (saveAsFragment ? "Fragment (.fr3d)" : "Model (.b3d)") + "\n" +
        "Panels created: " + data.parts.length + "\n" +
        "Grooves added: " + groovesAdded + "\n" +
        "Blum articles: " + data.articles.length + "\n" +
        "Saved to: " + (savePath || "(not saved)")
    );
    Action.Finish();
}

main();
