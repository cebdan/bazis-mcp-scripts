// Export Bazis-Mebelshchik 2022 materials & textures into TopSolid'Wood 6.25
// Creates/updates a dedicated "Bazis" section (Panels, Edgebanding, Other) in:
//   - C:\Missler\Config\topmaterials.xml
//   - C:\Missler\Config\top.tex  (+ C:\Missler\Config\Textures\Bazis\*.bmp)
//   - C:\Missler\Config\top.pnl
//   - C:\Missler\Config\top.edg
// Checks existing entries first and only appends missing materials or attaches missing textures.

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

function xmlEscape(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function xmlDecode(s) {
    return String(s || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'");
}

function hashU32(str) {
    var h = 2166136261 >>> 0;
    var buf = Buffer.from(String(str || ""), "utf8");
    for (var i = 0; i < buf.length; i++) {
        h ^= buf[i];
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

function hex8(n) {
    var s = (n >>> 0).toString(16).toUpperCase();
    while (s.length < 8) s = "0" + s;
    return s;
}

function safeAsciiId(s) {
    var out = "";
    var str = String(s || "");
    for (var i = 0; i < str.length && out.length < 28; i++) {
        var c = str.charAt(i);
        if (/[A-Za-z0-9]/.test(c)) out += c.toUpperCase();
        else if (!out.endsWith("_")) out += "_";
    }
    out = out.replace(/^_+|_+$/g, "") || "MAT";
    return out + "_" + hex8(hashU32(str));
}

function safeFilename(s) {
    var out = String(s || "").replace(/[^A-Za-z0-9\-_. ]/g, "").replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
    return out || ("tex_" + hex8(hashU32(s)));
}

function splitBazisMatName(rawName) {
    var parts = String(rawName || "").split(/[\r\n]+/);
    return {
        name: (parts[0] || "").trim(),
        code: parts.length > 1 ? (parts[1] || "").trim() : ""
    };
}

function colorRefToRgb(col) {
    var n = Number(col);
    if (!isFinite(n) || n < 0) return { r: 0.85, g: 0.85, b: 0.85 };
    var iv = Math.floor(n) & 0xFFFFFF;
    return {
        r: (iv & 0xFF) / 255.0,
        g: ((iv >> 8) & 0xFF) / 255.0,
        b: ((iv >> 16) & 0xFF) / 255.0
    };
}

function findMisslerConfigDir() {
    var cands = ["C:\\Missler\\Config", "D:\\Missler\\Config"];
    for (var i = 0; i < cands.length; i++) {
        if (fs.existsSync(cands[i])) return cands[i];
    }
    return "C:\\Missler\\Config";
}

function resolveTextureRoots() {
    var roots = [];
    var appData = process.env.APPDATA || "";
    var userProf = process.env.USERPROFILE || "";
    var settingsPaths = [];
    if (appData) settingsPaths.push(path.join(appData, "Bazis", "Settings.xml"));
    settingsPaths.push("Y:\\Works\\bazis\\Settings\\Settings.xml");

    for (var i = 0; i < settingsPaths.length; i++) {
        try {
            if (!fs.existsSync(settingsPaths[i])) continue;
            var xml = fs.readFileSync(settingsPaths[i], "utf8");
            var m = xml.match(/<PathTEXTUR>([^<]+)<\/PathTEXTUR>/i);
            if (m && m[1]) {
                var p = xmlDecode(m[1]).trim().replace(/\{\{BAZIS_DIR\}\}/g, "Y:\\Works\\bazis");
                if (p && roots.indexOf(p) === -1) roots.push(p);
            }
        } catch (e) {}
    }
    var fallbacks = [
        "Y:\\Works\\bazis\\Textures",
        "Y:\\Works\\bazis",
        userProf ? path.join(userProf, "Documents", "Bazis", "Textures") : "",
        userProf ? path.join(userProf, "Documents", "Bazis") : ""
    ];
    for (var j = 0; j < fallbacks.length; j++) {
        if (fallbacks[j] && roots.indexOf(fallbacks[j]) === -1) roots.push(fallbacks[j]);
    }
    return roots;
}

function resolveTextureFile(relOrAbs, texRoots) {
    var raw = String(relOrAbs || "").trim();
    if (!raw) return "";
    try { if (fs.existsSync(raw)) return raw; } catch (e) {}
    for (var i = 0; i < texRoots.length; i++) {
        var cand = path.join(texRoots[i], raw);
        try { if (fs.existsSync(cand)) return cand; } catch (e) {}
    }
    return "";
}

function parseThicknessFromName(name) {
    var m = String(name || "").match(/(\d+(?:[.,]\d+)?)\s*(?:mm\b)/i);
    if (m) return parseFloat(m[1].replace(",", ".")) || 0;
    var m2 = String(name || "").match(/\b(16|18|19|22|25|28|32|38)\b/);
    if (m2) return parseFloat(m2[1]) || 0;
    return 0;
}

function classifyMaterial(name, hintCat) {
    if (hintCat === "panel" || hintCat === "edge") return hintCat;
    var low = String(name || "").toLowerCase();
    if (low.indexOf("edge") !== -1 || low.indexOf("abs") !== -1 || low.indexOf("pvc") !== -1 || low.indexOf("butt") !== -1) {
        return "edge";
    }
    if (low.indexOf("ldsp") !== -1 || low.indexOf("mdf") !== -1 || low.indexOf("hdf") !== -1 || low.indexOf("board") !== -1 || low.indexOf("panel") !== -1 || low.indexOf("plywood") !== -1) {
        return "panel";
    }
    return "other";
}

function defaultDensity(m) {
    if (m.density > 0.01) return m.density;
    var low = m.name.toLowerCase();
    if (low.indexOf("mdf") !== -1) return 0.78;
    if (low.indexOf("hdf") !== -1) return 0.85;
    if (low.indexOf("abs") !== -1 || low.indexOf("pvc") !== -1 || m.category === "edge") return 1.05;
    if (low.indexOf("glass") !== -1 || low.indexOf("mirror") !== -1) return 2.50;
    if (low.indexOf("steel") !== -1 || low.indexOf("chrome") !== -1 || low.indexOf("metal") !== -1) return 7.85;
    if (low.indexOf("alum") !== -1) return 2.70;
    return 0.72;
}

function collectAllBazisMaterials() {
    var byKey = {};
    var list = [];
    var texRoots = resolveTextureRoots();

    function upsert(entry) {
        if (!entry || !entry.name) return;
        var key = entry.name.toLowerCase();
        var ex = byKey[key];
        if (!ex) {
            byKey[key] = entry;
            list.push(entry);
            return;
        }
        if (!ex.code && entry.code) ex.code = entry.code;
        if (ex.thicknessMm <= 0 && entry.thicknessMm > 0) ex.thicknessMm = entry.thicknessMm;
        if (ex.widthMm <= 0 && entry.widthMm > 0) ex.widthMm = entry.widthMm;
        if (!ex.texturePath && entry.texturePath) {
            ex.texturePath = entry.texturePath;
            ex.textureName = entry.textureName;
        }
        if (entry.category === "panel" || entry.category === "edge") ex.category = entry.category;
        if (entry.hasGrain) ex.hasGrain = true;
    }

    // 1. Scan Bazis Materials.xml (user AppData + shared network Settings)
    var appData = process.env.APPDATA || "";
    var xmlPaths = [];
    if (appData) xmlPaths.push(path.join(appData, "Bazis", "Materials.xml"));
    xmlPaths.push("Y:\\Works\\bazis\\Settings\\Materials.xml");

    for (var i = 0; i < xmlPaths.length; i++) {
        try {
            if (!fs.existsSync(xmlPaths[i])) continue;
            var xml = fs.readFileSync(xmlPaths[i], "utf8");
            var re = /<Material>([\s\S]*?)<\/Material>/g;
            var m;
            while ((m = re.exec(xml)) !== null) {
                var blk = m[1];
                var nmM = blk.match(/<Name>([\s\S]*?)<\/Name>/i);
                if (!nmM) continue;
                var sp = splitBazisMatName(xmlDecode(nmM[1]));
                if (!sp.name) continue;
                var colM = blk.match(/<Color>([^<]+)<\/Color>/i);
                var texM = blk.match(/<Texture>([^<]+)<\/Texture>/i);
                var reflM = blk.match(/<Reflection>([^<]+)<\/Reflection>/i);
                var transM = blk.match(/<Transparency>([^<]+)<\/Transparency>/i);
                var rgb = colM ? colorRefToRgb(colM[1]) : { r: 0.85, g: 0.85, b: 0.85 };
                var rawTex = texM ? xmlDecode(texM[1]).trim() : "";
                var texPath = resolveTextureFile(rawTex, texRoots);
                var texName = rawTex ? path.basename(rawTex).replace(/\.[^.]+$/, "") : "";
                var cat = classifyMaterial(sp.name, "");
                upsert({
                    name: sp.name,
                    code: sp.code,
                    category: cat,
                    thicknessMm: parseThicknessFromName(sp.name),
                    widthMm: 0,
                    lengthMm: 0,
                    density: 0,
                    colorR: rgb.r,
                    colorG: rgb.g,
                    colorB: rgb.b,
                    reflection: reflM ? (parseFloat(reflM[1]) || 0) : 0,
                    transparency: transM ? (parseFloat(transM[1]) || 0) : 0,
                    texturePath: texPath,
                    textureName: texName,
                    hasGrain: !!texPath
                });
            }
        } catch (e) {}
    }

    // 2. Scan active Bazis Model (panels, edgebanding, plastics, 3D bodies)
    function walkModel(container) {
        if (!container || typeof container.Count !== "number") return;
        for (var k = 0; k < container.Count; k++) {
            var obj = container[k];
            if (!obj) continue;
            var cname = "";
            try { cname = String(obj.ClassName || ""); } catch (e) {}
            if (cname === "TFurnPanel") {
                var sp = splitBazisMatName(obj.MaterialName || "");
                var pThk = Number(obj.Thickness) || 0;
                var rgb = colorRefToRgb(obj.Color);
                var pGrain = false;
                try { pGrain = (obj.TextureOrientation !== 0); } catch (e) {}
                if (sp.name) {
                    upsert({
                        name: sp.name,
                        code: sp.code,
                        category: "panel",
                        thicknessMm: pThk,
                        widthMm: 0,
                        lengthMm: 0,
                        density: 0,
                        colorR: rgb.r,
                        colorG: rgb.g,
                        colorB: rgb.b,
                        reflection: 0,
                        transparency: 0,
                        texturePath: "",
                        textureName: "",
                        hasGrain: pGrain
                    });
                }
                try {
                    if (obj.Butts && obj.Butts.Count > 0) {
                        for (var bi = 0; bi < obj.Butts.Count; bi++) {
                            var bt = obj.Butts[bi];
                            if (!bt || !bt.Material) continue;
                            var bsp = splitBazisMatName(bt.Material);
                            if (bsp.name) {
                                upsert({
                                    name: bsp.name,
                                    code: bsp.code,
                                    category: "edge",
                                    thicknessMm: Number(bt.Thickness) || 1,
                                    widthMm: Number(bt.Width) || (pThk > 0 ? pThk + 1 : 19),
                                    lengthMm: 0,
                                    density: 1.05,
                                    colorR: 0.9,
                                    colorG: 0.9,
                                    colorB: 0.9,
                                    reflection: 0,
                                    transparency: 0,
                                    texturePath: "",
                                    textureName: "",
                                    hasGrain: false
                                });
                            }
                        }
                    }
                } catch (e) {}
            } else if (typeof obj.MaterialName === "string" && obj.MaterialName) {
                var bsp2 = splitBazisMatName(obj.MaterialName);
                var rgb2 = colorRefToRgb(obj.Color);
                if (bsp2.name) {
                    upsert({
                        name: bsp2.name,
                        code: bsp2.code,
                        category: classifyMaterial(bsp2.name, "other"),
                        thicknessMm: 0,
                        widthMm: 0,
                        lengthMm: 0,
                        density: 0,
                        colorR: rgb2.r,
                        colorG: rgb2.g,
                        colorB: rgb2.b,
                        reflection: 0,
                        transparency: 0,
                        texturePath: "",
                        textureName: "",
                        hasGrain: false
                    });
                }
            }
            if (typeof obj.Count === "number" && obj.Count > 0) walkModel(obj);
        }
    }
    try { if (typeof Model !== "undefined" && Model) walkModel(Model); } catch (e) {}

    return list;
}

function stageTextureFile(srcPath, texDir, matName) {
    if (!srcPath || !fs.existsSync(srcPath)) return "";
    if (!fs.existsSync(texDir)) fs.mkdirSync(texDir, { recursive: true });
    var ext = path.extname(srcPath).toLowerCase();
    var stem = path.basename(srcPath, ext) || matName;
    var base = safeFilename(stem) + "_" + hex8(hashU32(srcPath));

    if (ext === ".bmp" || ext === ".ttx") {
        var dst = path.join(texDir, base + ext);
        if (!fs.existsSync(dst)) fs.copyFileSync(srcPath, dst);
        return fs.existsSync(dst) ? dst : "";
    }

    var dstBmp = path.join(texDir, base + ".bmp");
    if (fs.existsSync(dstBmp)) return dstBmp;

    // Convert jpg/png to 24-bit BMP via built-in Windows System.Drawing
    try {
        var srcEsc = srcPath.replace(/'/g, "''");
        var dstEsc = dstBmp.replace(/'/g, "''");
        var ps = "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('" + srcEsc + "'); $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.DrawImage($img, 0, 0, $img.Width, $img.Height); $g.Dispose(); $img.Dispose(); $bmp.Save('" + dstEsc + "', [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose();";
        cp.execFileSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", ps], {
            timeout: 15000,
            windowsHide: true
        });
        if (fs.existsSync(dstBmp)) return dstBmp;
    } catch (e) {}

    var dstOrig = path.join(texDir, base + (ext || ".jpg"));
    if (!fs.existsSync(dstOrig)) fs.copyFileSync(srcPath, dstOrig);
    return fs.existsSync(dstOrig) ? dstOrig : "";
}

function ensureTopTex(texPath) {
    if (fs.existsSync(texPath)) {
        var c = fs.readFileSync(texPath, "utf8");
        if (c.indexOf("<Textures") !== -1) return c;
    }
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<Textures>\r\n  <Family name=\"Bazis\">\r\n  </Family>\r\n</Textures>\r\n";
}

function ensureTopMaterials(matPath) {
    var famBlock =
        " <Family name=\"Bazis\">\r\n" +
        "  <IdKey>%BAZIS_ROOT</IdKey>\r\n" +
        "  <Family name=\"Panels\">\r\n" +
        "   <IdKey>%BAZIS_PANELS</IdKey>\r\n" +
        "  </Family>\r\n" +
        "  <Family name=\"Edgebanding\">\r\n" +
        "   <IdKey>%BAZIS_EDGES</IdKey>\r\n" +
        "  </Family>\r\n" +
        "  <Family name=\"Other\">\r\n" +
        "   <IdKey>%BAZIS_OTHER</IdKey>\r\n" +
        "  </Family>\r\n" +
        " </Family>\r\n";
    if (fs.existsSync(matPath)) {
        var c = fs.readFileSync(matPath, "utf8");
        if (c.indexOf("<Materials") !== -1) {
            if (c.indexOf("%BAZIS_ROOT") === -1) {
                var idx = c.indexOf("</Version>");
                if (idx !== -1) {
                    var pos = idx + "</Version>".length;
                    return c.slice(0, pos) + "\r\n" + famBlock + c.slice(pos);
                }
            }
            return c;
        }
    }
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<Materials>\r\n <Version>616204</Version>\r\n" + famBlock + "</Materials>\r\n";
}

function buildMaterialXml(m, texKey) {
    var fam = (m.category === "panel") ? "%BAZIS_PANELS" : (m.category === "edge" ? "%BAZIS_EDGES" : "%BAZIS_OTHER");
    var nameXml = xmlEscape(m.name);
    var codeXml = m.code ? xmlEscape(m.code) : "NONE";
    var texXml = texKey ? xmlEscape(texKey) : "NONE";
    var dens = defaultDensity(m).toFixed(3);
    var grain = m.hasGrain ? 1 : 0;
    var r = Math.max(0, Math.min(1, m.colorR)).toFixed(4);
    var g = Math.max(0, Math.min(1, m.colorG)).toFixed(4);
    var b = Math.max(0, Math.min(1, m.colorB)).toFixed(4);
    var refl = Math.max(0, Math.min(1, m.reflection || 0)).toFixed(3);
    var trans = Math.max(0, Math.min(1, m.transparency || 0)).toFixed(3);
    var pat = (m.category === "panel") ? 6 : 0;

    return (
        " <Material>\r\n" +
        "  <Name>" + nameXml + "</Name>\r\n" +
        "  <Families>" + fam + "</Families>\r\n" +
        "  <Matter>1</Matter>\r\n" +
        "  <Coating>1</Coating>\r\n" +
        "  <Finishing>0</Finishing>\r\n" +
        "  <UserMat>1</UserMat>\r\n" +
        "  <GrainOrientation>" + grain + "</GrainOrientation>\r\n" +
        "  <Density>" + dens + "</Density>\r\n" +
        "  <DensityTol>0</DensityTol>\r\n" +
        "  <YoungModulus>0</YoungModulus>\r\n" +
        "  <PoissonRatio>0</PoissonRatio>\r\n" +
        "  <Expansion>0</Expansion>\r\n" +
        "  <ElasticLimit>0</ElasticLimit>\r\n" +
        "  <ShearModulus>0</ShearModulus>\r\n" +
        "  <ShrinkageFactor>1</ShrinkageFactor>\r\n" +
        "  <ShrinkageFactorMin>1</ShrinkageFactorMin>\r\n" +
        "  <ShrinkageFactorMax>1</ShrinkageFactorMax>\r\n" +
        "  <InjectionPressureMin>1200</InjectionPressureMin>\r\n" +
        "  <InjectionPressureMax>1200</InjectionPressureMax>\r\n" +
        "  <Conductivity>0</Conductivity>\r\n" +
        "  <ThermicInertia>0</ThermicInertia>\r\n" +
        "  <Colour>" + r + " " + g + " " + b + "</Colour>\r\n" +
        "  <Specularity>0.1 1 1 1</Specularity>\r\n" +
        "  <SpecularitySpreading>0.1</SpecularitySpreading>\r\n" +
        "  <Ambient>1 1 1</Ambient>\r\n" +
        "  <Translucency>" + trans + "</Translucency>\r\n" +
        "  <Texture>" + texXml + "</Texture>\r\n" +
        "  <Pattern>" + pat + "</Pattern>\r\n" +
        "  <PatternTopPath>NONE</PatternTopPath>\r\n" +
        "  <PatternUserName>NONE</PatternUserName>\r\n" +
        "  <Designation>" + nameXml + "</Designation>\r\n" +
        "  <Reference>" + codeXml + "</Reference>\r\n" +
        "  <Supplier>Bazis</Supplier>\r\n" +
        "  <Reflection>" + refl + "</Reflection>\r\n" +
        "  <ReflectionAngle>0</ReflectionAngle>\r\n" +
        "  <Refraction>1</Refraction>\r\n" +
        "  <RefractionAngle>0</RefractionAngle>\r\n" +
        "  <Anisotropy>0</Anisotropy>\r\n" +
        "  <FresnelRef>0</FresnelRef>\r\n" +
        "  <ReceiveShadow>1</ReceiveShadow>\r\n" +
        "  <CastShadow>1</CastShadow>\r\n" +
        "  <TextParam>4</TextParam>\r\n" +
        "  <TexParamPosUScl>1</TexParamPosUScl>\r\n" +
        "  <TexParamPosVScl>1</TexParamPosVScl>\r\n" +
        "  <TextParamPosRot>0</TextParamPosRot>\r\n" +
        "  <BumpTexture>NONE</BumpTexture>\r\n" +
        "  <BumpTextParam>4</BumpTextParam>\r\n" +
        "  <BumpTexParamPosUScl>0.05</BumpTexParamPosUScl>\r\n" +
        "  <BumpTexParamPosVScl>0.05</BumpTexParamPosVScl>\r\n" +
        "  <BumpTextParamPosRot>0</BumpTextParamPosRot>\r\n" +
        "  <FinishingColour>1 1 1</FinishingColour>\r\n" +
        "  <FinishingPercent>0</FinishingPercent>\r\n" +
        "  <ModifDate>NONE</ModifDate>\r\n" +
        "  <Other>0</Other>\r\n" +
        " </Material>\r\n"
    );
}

function syncBazisMaterialsToTopSolid() {
    var materials = collectAllBazisMaterials();
    var cfgDir = findMisslerConfigDir();
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    var texDir = path.join(cfgDir, "Textures", "Bazis");
    var topMatPath = path.join(cfgDir, "topmaterials.xml");
    var topTexPath = path.join(cfgDir, "top.tex");
    var topPnlPath = path.join(cfgDir, "top.pnl");
    var topEdgPath = path.join(cfgDir, "top.edg");

    var matXml = ensureTopMaterials(topMatPath);
    var texXml = ensureTopTex(topTexPath);
    var pnlTxt = fs.existsSync(topPnlPath) ? fs.readFileSync(topPnlPath, "utf8") : "";
    var edgTxt = fs.existsSync(topEdgPath) ? fs.readFileSync(topEdgPath, "utf8") : "";

    var addedMat = 0, updatedTex = 0, existingMat = 0, addedTex = 0, addedPnl = 0, addedEdg = 0;
    var matDirty = !fs.existsSync(topMatPath);
    var texDirty = false, pnlDirty = false, edgDirty = false;

    for (var i = 0; i < materials.length; i++) {
        var m = materials[i];
        var texKey = "";
        if (m.texturePath) {
            var staged = stageTextureFile(m.texturePath, texDir, m.name);
            if (staged) {
                texKey = "%BAZIS_TEX_" + safeAsciiId(m.name);
                var keyTag = "<Key>" + xmlEscape(texKey) + "</Key>";
                if (texXml.indexOf(keyTag) === -1) {
                    var texEntry =
                        "    <Texture>\r\n" +
                        "      <Key>" + xmlEscape(texKey) + "</Key>\r\n" +
                        "      <Uri>" + xmlEscape(staged) + "</Uri>\r\n" +
                        "      <Name>" + xmlEscape(m.textureName || m.name) + "</Name>\r\n" +
                        "      <Luminance>0</Luminance>\r\n" +
                        "      <TexturingMode>4</TexturingMode>\r\n" +
                        "      <CoordsU>1</CoordsU>\r\n" +
                        "      <SpanU>0.600000</SpanU>\r\n" +
                        "      <CoordsV>1</CoordsV>\r\n" +
                        "      <SpanV>0.600000</SpanV>\r\n" +
                        "      <Transparent>0</Transparent>\r\n" +
                        "    </Texture>\r\n";
                    var fIdx = texXml.lastIndexOf("  </Family>");
                    if (fIdx !== -1) {
                        texXml = texXml.slice(0, fIdx) + texEntry + texXml.slice(fIdx);
                    } else {
                        var tIdx = texXml.lastIndexOf("</Textures>");
                        if (tIdx !== -1) {
                            texXml = texXml.slice(0, tIdx) + "  <Family name=\"Bazis\">\r\n" + texEntry + "  </Family>\r\n" + texXml.slice(tIdx);
                        }
                    }
                    texDirty = true;
                    addedTex++;
                }
            }
        }

        var nameTag = "<Name>" + xmlEscape(m.name) + "</Name>";
        var pos = matXml.indexOf(nameTag);
        if (pos !== -1) {
            if (texKey) {
                var endPos = matXml.indexOf("</Material>", pos);
                if (endPos !== -1) {
                    var block = matXml.slice(pos, endPos);
                    if (block.indexOf("<Texture>NONE</Texture>") !== -1) {
                        block = block.replace("<Texture>NONE</Texture>", "<Texture>" + xmlEscape(texKey) + "</Texture>");
                        matXml = matXml.slice(0, pos) + block + matXml.slice(endPos);
                        matDirty = true;
                        updatedTex++;
                    }
                }
            }
            existingMat++;
        } else {
            var entry = buildMaterialXml(m, texKey);
            var closeIdx = matXml.lastIndexOf("</Materials>");
            if (closeIdx !== -1) {
                matXml = matXml.slice(0, closeIdx) + entry + matXml.slice(closeIdx);
                matDirty = true;
                addedMat++;
            }
        }

        if (m.category === "panel" && m.thicknessMm > 0.5) {
            if (pnlTxt.indexOf("DESIGNATION\t" + m.name) === -1 && pnlTxt.indexOf("MATTER\t" + m.name) === -1) {
                var lenM = (m.lengthMm > 100 ? m.lengthMm / 1000.0 : 2.800).toFixed(12);
                var widM = (m.widthMm > 100 ? m.widthMm / 1000.0 : 2.070).toFixed(12);
                var thkM = (m.thicknessMm / 1000.0).toFixed(12);
                var refS = m.code ? ("Bazis_" + m.code) : ("Bazis_" + Math.round(m.thicknessMm) + "mm_" + hex8(hashU32(m.name)).slice(0, 6));
                if (pnlTxt.length > 0 && !pnlTxt.endsWith("\n")) pnlTxt += "\r\n";
                if (pnlTxt.length > 0 && !pnlTxt.endsWith("\r\n\r\n")) pnlTxt += "\r\n";
                pnlTxt +=
                    "REFERENCE\t" + refS + "\r\n" +
                    "DESIGNATION\t" + m.name + "\r\n" +
                    "LENGTH\t" + lenM + "\r\n" +
                    "WIDTH\t" + widM + "\r\n" +
                    "THICKNESS\t" + thkM + "\r\n" +
                    "MATTER\t" + m.name + "\r\n" +
                    "COATING\t" + m.name + "\r\n" +
                    "PRICE\t0\r\n" +
                    "NEST_CALIBRATION\t0\r\n";
                pnlDirty = true;
                addedPnl++;
            }
        }

        if (m.category === "edge" && m.thicknessMm > 0.05) {
            if (edgTxt.indexOf("DESIGNATION\t" + m.name) === -1) {
                var eWidM = (m.widthMm > 1 ? m.widthMm / 1000.0 : 0.019).toFixed(12);
                var eThkM = (m.thicknessMm / 1000.0).toFixed(12);
                var eRef = m.code ? ("Bazis_Edge_" + m.code) : ("Bazis_Edge_" + hex8(hashU32(m.name)).slice(0, 6));
                if (edgTxt.length > 0 && !edgTxt.endsWith("\n")) edgTxt += "\r\n";
                if (edgTxt.length > 0 && !edgTxt.endsWith("\r\n\r\n")) edgTxt += "\r\n";
                edgTxt +=
                    "REFERENCE\t" + eRef + "\r\n" +
                    "DESIGNATION\t" + m.name + "\r\n" +
                    "WIDTH\t" + eWidM + "\r\n" +
                    "THICKNESS\t" + eThkM + "\r\n" +
                    "MATTER\t" + m.name + "\r\n" +
                    "COATING\t" + m.name + "\r\n" +
                    "PRICE\t0\r\n";
                edgDirty = true;
                addedEdg++;
            }
        }
    }

    if (texDirty) fs.writeFileSync(topTexPath, texXml, "utf8");
    if (matDirty) fs.writeFileSync(topMatPath, matXml, "utf8");
    if (pnlDirty) fs.writeFileSync(topPnlPath, pnlTxt, "utf8");
    if (edgDirty) fs.writeFileSync(topEdgPath, edgTxt, "utf8");

    return {
        totalScanned: materials.length,
        addedMaterials: addedMat,
        updatedTextures: updatedTex,
        existingMaterials: existingMat,
        addedTextures: addedTex,
        addedPanels: addedPnl,
        addedEdges: addedEdg,
        configDir: cfgDir
    };
}

var res = syncBazisMaterialsToTopSolid();
if (typeof alert === "function") {
    alert(
        "TopSolid'Wood 6.25 Material Sync Complete (Section: Bazis)\n" +
        "Scanned: " + res.totalScanned + " Bazis materials\n" +
        "Added materials: " + res.addedMaterials + " (already existed: " + res.existingMaterials + ")\n" +
        "Added/updated textures: " + res.addedTextures + " / " + res.updatedTextures + "\n" +
        "Added panels (top.pnl): " + res.addedPanels + "\n" +
        "Added edges (top.edg): " + res.addedEdges + "\n" +
        "Target: " + res.configDir + "\\topmaterials.xml" +
        (res.addedMaterials > 0 ? "\n\nNote: Restart TopSolid once so newly added materials appear in the Material Catalog." : "")
    );
}
