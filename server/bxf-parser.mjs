// Zero-dependency parser for Blum E-SERVICES BXF 2.x (.bxf2) XML files.
// Extracts official Blum dimensions, article numbers, groove parameters, and
// cabinet-side System 32 drilling coordinates, converting them into Bazis
// Drawer Library (.bbb) StandartBox / SysBox specifications.

function parseAttrs(attrStr) {
  const attrs = {};
  const re = /([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrStr || "")) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function getTagText(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function getAllBlocks(xml, tagName) {
  const out = [];
  const re = new RegExp(
    `<${tagName}(\\s[^>]*)?\\/>|<${tagName}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
    "g"
  );
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({
      attrs: parseAttrs(m[1] || m[2] || ""),
      body: m[3] || "",
    });
  }
  return out;
}

function parseVec3(str) {
  const parts = String(str || "")
    .trim()
    .split(/\s+/)
    .map(Number);
  return { x: parts[0] || 0, y: parts[1] || 0, z: parts[2] || 0 };
}

function parseTransformations(blockBody) {
  let tx = 0;
  let ty = 0;
  let tz = 0;
  const transforms = getAllBlocks(blockBody, "transformation");
  for (const t of transforms) {
    if (t.attrs.translation) {
      const v = parseVec3(t.attrs.translation);
      tx += v.x;
      ty += v.y;
      tz += v.z;
    }
  }
  return { x: tx, y: ty, z: tz };
}

export function parseBxf2Xml(xmlText) {
  const xml = String(xmlText || "");
  if (!xml.includes("<bxf")) {
    throw new Error("Input is not a valid Blum BXF2 XML document");
  }

  const bxfVersion = getTagText(xml, "version");
  const author = getTagText(xml, "author");

  // 1. Parse articles
  const articlesBlock = getAllBlocks(xml, "articles")[0]?.body || "";
  const articles = getAllBlocks(articlesBlock, "article").map((a) => ({
    id: a.attrs.id || "",
    itemNumber: a.attrs.itemNumber || "",
    articleNumber: a.attrs.articleNumber || "",
    totalQuantity: Number(a.attrs.totalQuantity || 1),
    description: getTagText(a.body, "description"),
    material: getTagText(a.body, "material"),
  }));

  // 2. Parse machinings (Drilling / Groove)
  const machiningsBlock = getAllBlocks(xml, "machinings")[0]?.body || "";
  const machinings = {};
  for (const m of getAllBlocks(machiningsBlock, "machining")) {
    machinings[m.attrs.id] = {
      id: m.attrs.id,
      type: m.attrs["xsi:type"] || "",
      radius: Number(m.attrs.radius || 0),
      depth: Number(m.attrs.depth || 0),
      length: Number(m.attrs.length || 0),
    };
  }

  // 3. Parse machiningGroups (runner drilling pattern on cabinet side)
  const mgBlock = getAllBlocks(xml, "machiningGroups")[0]?.body || "";
  const machiningGroups = {};
  for (const mg of getAllBlocks(mgBlock, "machiningGroup")) {
    const links = getAllBlocks(mg.body, "machiningLink").map((ml) => ({
      id: ml.attrs.id,
      referenceId: ml.attrs.referenceId,
      translation: parseTransformations(ml.body),
      machining: machinings[ml.attrs.referenceId] || null,
    }));
    machiningGroups[mg.attrs.id] = links;
  }

  // 4. Parse container transform (runner datum relative to cabinet front & bottom)
  const containersBlock = getAllBlocks(xml, "containers")[0]?.body || "";
  const fuLink = getAllBlocks(containersBlock, "functionUnitLink")[0];
  const containerTrans = fuLink ? parseTransformations(fuLink.body) : { x: 0, y: 37, z: -37 };

  // 5. Parse parts (wooden panels: sides, back, base, front, front piece)
  const partsBlock = getAllBlocks(xml, "parts")[0]?.body || "";
  const parts = {};
  for (const p of getAllBlocks(partsBlock, "part")) {
    const ext = parseVec3(getTagText(p.body, "extent"));
    const mLinks = getAllBlocks(p.body, "machiningLink").map((ml) => ({
      referenceId: ml.attrs.referenceId,
      translation: parseTransformations(ml.body),
      machining: machinings[ml.attrs.referenceId] || null,
    }));
    parts[p.attrs.id] = {
      id: p.attrs.id,
      modelKey: p.attrs.modelKey || "",
      description: getTagText(p.body, "description"),
      extent: { x: Math.abs(ext.x), y: Math.abs(ext.y), z: Math.abs(ext.z) },
      machiningLinks: mLinks,
    };
  }

  // 6. Parse functionUnit (description, partLinks, componentLinks)
  const fuBlock = getAllBlocks(xml, "functionUnits")[0]?.body || "";
  const fu = getAllBlocks(fuBlock, "functionUnit")[0];
  const fuDescription = fu ? getTagText(fu.body, "description") : "";
  const partLinks = fu
    ? getAllBlocks(fu.body, "partLink").map((pl) => ({
        referenceId: pl.attrs.referenceId,
        description: getTagText(pl.body, "description"),
        translation: parseTransformations(pl.body),
        part: parts[pl.attrs.referenceId] || null,
      }))
    : [];
  const componentLinks = fu
    ? getAllBlocks(fu.body, "componentLink").map((cl) => ({
        referenceId: cl.attrs.referenceId,
        translation: parseTransformations(cl.body),
      }))
    : [];

  // Infer inner cabinet width (LW) from left/right componentLinks X offset
  let cabinetInnerWidth = 0;
  for (const cl of componentLinks) {
    const ax = Math.abs(cl.translation.x);
    if (ax > cabinetInnerWidth) cabinetInnerWidth = ax;
  }

  // Infer nominal length (NL) from description or runner article
  let nominalLength = 0;
  const nlMatch =
    fuDescription.match(/Nominal\s+length\s*=\s*(\d+)/i) ||
    (articles[0]?.description || "").match(/NL\s*=\s*(\d+)/i);
  if (nlMatch) nominalLength = Number(nlMatch[1]);

  // Identify drawer parts
  const leftSideLink = partLinks.find(
    (p) => p.part?.modelKey === "H-ZARG-li" || /drawer\s+side,\s*left/i.test(p.description)
  );
  const backLink = partLinks.find(
    (p) => p.part?.modelKey === "H-RUEW-FSys" || /drawer\s+back/i.test(p.description)
  );
  const baseLink = partLinks.find(
    (p) => p.part?.modelKey === "ZUSCHN-FSys" || /drawer\s+base/i.test(p.description)
  );
  const frontPieceLink = partLinks.find(
    (p) => p.part?.modelKey === "H-VSTK-FSys" || /drawer\s+front\s+piece/i.test(p.description)
  );

  // Extract cabinet-side drilling offsets from front edge (in mm, sorted ascending)
  const frontDatum = Math.abs(containerTrans.z) || 37;
  const firstGroup = Object.values(machiningGroups)[0] || [];
  const absOffsets = [];
  for (const ml of firstGroup) {
    // Runner Y axis in BXF2 maps along cabinet depth from front datum
    const pos = Math.round((frontDatum + ml.translation.y) * 100) / 100;
    if (pos > 0 && !absOffsets.includes(pos)) absOffsets.push(pos);
  }
  absOffsets.sort((a, b) => a - b);

  // Convert absolute offsets to Bazis cumulative HolesNiche deltas
  const holesNiche = [];
  let prev = 0;
  for (const pos of absOffsets) {
    const delta = Math.round((pos - prev) * 100) / 100;
    if (delta > 0) holesNiche.push(delta);
    prev = pos;
  }

  // Primary runner/drawer article for Bazis MaterialName
  const mainArticle = articles[0] || null;
  const materialName = mainArticle
    ? `Blum ${mainArticle.articleNumber}${mainArticle.itemNumber ? `\r${mainArticle.itemNumber}` : ""}`
    : `Blum NL ${nominalLength || 500}`;

  // Determine whether this is a wooden StandartBox (has wooden left/right sides)
  // or a metal-side SysBox (LEGRABOX / TANDEMBOX / MERIVOBOX)
  const isStandartBox = !!leftSideLink;

  // Extract bottom groove from left side if present
  let cutForBottom = null;
  if (leftSideLink && leftSideLink.part) {
    const grooveLink = leftSideLink.part.machiningLinks.find(
      (ml) => ml.machining && ml.machining.type === "Groove"
    );
    if (grooveLink) {
      const gWidth = grooveLink.machining.radius * 2;
      const gDepth = grooveLink.machining.depth;
      const gOffset = Math.max(0, Math.round((grooveLink.translation.y - grooveLink.machining.radius) * 100) / 100);
      cutForBottom = {
        cutType: "ctRectangle",
        name: "Blum BXF2 groove",
        depth: gDepth,
        width: gWidth,
        offset: gOffset,
      };
    }
  }

  // Build Bazis .bbb box spec
  const baseLength = baseLink?.part?.extent.y || leftSideLink?.part?.extent.x || (nominalLength ? nominalLength - 10 : 490);
  const effectiveNL = nominalLength || Math.round((baseLength + 10) / 10) * 10;
  const offsetBottomFast = Math.abs(containerTrans.y) || 37;

  // Clean series name (strip nominal length so multiple lengths merge cleanly)
  const seriesName = fuDescription
    ? fuDescription.replace(/\s*\|\s*Nominal\s+length\s*=\s*\d+\s*mm/i, "").trim()
    : mainArticle?.articleNumber || "Blum Drawer";

  const lengthEntry = {
    width: effectiveNL,
    materialName,
    holesNiche: holesNiche.length > 0 ? holesNiche : [37, 32, 128, 32],
    holesBox: [],
  };

  let boxSpec;
  if (isStandartBox) {
    const sideThick = leftSideLink.part.extent.z || 16;
    const backW = backLink?.part?.extent.x || 0;
    const offsetSide =
      cabinetInnerWidth > 0 && backW > 0
        ? Math.round(((cabinetInnerWidth - backW) / 2) * 100) / 100
        : 21;
    const boxDepthMinus = Math.max(0, Math.round((effectiveNL - (leftSideLink.part.extent.x || baseLength)) * 100) / 100);
    const offsetFastSideBottom = Math.abs(leftSideLink.translation.y) || 21.5;

    boxSpec = {
      kind: "StandartBox",
      name: `${seriesName} (${sideThick}mm)`,
      guideRailsType: "bgrtUnderBottom",
      construction: frontPieceLink ? "bctFPVertFront" : "bctVertFront",
      bottomType: cutForBottom ? "bbtCutsSides" : "bbtAddOnPanelDVP",
      maxSideThickness: sideThick,
      offsetSide,
      boxDepthMinus,
      offsetTop: 7,
      offsetBottomFast,
      offsetFastSideBottom,
      offsetFastHole2: 12,
      korpPlus: 3,
      cutForBottom: cutForBottom || { cutType: "ctNone" },
      lengths: [lengthEntry],
    };
  } else {
    const backW = backLink?.part?.extent.x || 0;
    const backH = backLink?.part?.extent.y || 84;
    const baseW = baseLink?.part?.extent.x || 0;
    const bottomWidthMinus = cabinetInnerWidth > 0 && baseW > 0 ? Math.round((cabinetInnerWidth - baseW) * 100) / 100 : 35;
    const backWidthMinus = cabinetInnerWidth > 0 && backW > 0 ? Math.round((cabinetInnerWidth - backW) * 100) / 100 : 38;
    const lengthMinus = Math.max(0, Math.round((effectiveNL - baseLength) * 100) / 100);

    boxSpec = {
      kind: "SysBox",
      name: seriesName,
      facadeType: frontPieceLink ? "bsftFalsity" : "bsftFacade",
      sideHeight: backH,
      backHeight: backH,
      bottomWidthMinus,
      backWidthMinus,
      falsityWidthMinus: backWidthMinus,
      falsityHeight: backH,
      minusFalsityDSPBackDSP: lengthMinus,
      minusFalsityDSPBackNotDSP: lengthMinus,
      minusFalsityNotDSPBackDSP: lengthMinus,
      minusFalsityNotDSPBackNotDSP: lengthMinus,
      offsetTop: 14,
      offsetBottomFast,
      offsetFastSideBottom: 33,
      korpPlus: 3,
      lengths: [lengthEntry],
    };
  }

  return {
    bxfVersion,
    author,
    description: fuDescription,
    cabinetInnerWidth,
    nominalLength: effectiveNL,
    articles,
    absoluteDrillingOffsetsMm: absOffsets,
    holesNicheDeltasMm: holesNiche,
    groove: cutForBottom,
    boxSpec,
  };
}

export function mergeBxfSpecs(parsedList, customName) {
  if (!parsedList || parsedList.length === 0) {
    throw new Error("No BXF2 files provided");
  }
  const base = JSON.parse(JSON.stringify(parsedList[0].boxSpec));
  if (customName) base.name = String(customName);

  const byWidth = new Map();
  for (const item of parsedList) {
    for (const len of item.boxSpec.lengths || []) {
      byWidth.set(Number(len.width), len);
    }
  }
  base.lengths = Array.from(byWidth.values()).sort((a, b) => a.width - b.width);
  return base;
}
