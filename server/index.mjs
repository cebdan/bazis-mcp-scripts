#!/usr/bin/env node
// Zero-dependency MCP stdio server for Bazis-Mebelshchik 2022.
// Runs on macOS (or Windows) and communicates over HTTP with agent/bridge.js
// running inside Bazis 2022.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeBxfSpecs, parseBxf2Xml } from "./bxf-parser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_ENDPOINT_FILE = path.join(REPO_ROOT, ".bridge-endpoint.json");
const REQUEST_TIMEOUT_MS = Number(process.env.BAZIS_BRIDGE_TIMEOUT_MS || 15000);

const SERVER_INFO = {
  name: "bazis-mcp",
  version: "0.1.0",
};

const SUPPORTED_PROTOCOLS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);

let cachedGoodUrl = null;
let cachedTokenKey = null;

function logErr(msg) {
  process.stderr.write(`[bazis-mcp] ${msg}\n`);
}

function readEndpointFile() {
  const filePath = process.env.BAZIS_BRIDGE_ENDPOINT_FILE || DEFAULT_ENDPOINT_FILE;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.urls) && data.urls.length > 0) {
      return data;
    }
  } catch (err) {
    logErr(`Failed to read endpoint file ${filePath}: ${err.message}`);
  }
  return null;
}

function resolveIpcDir(ep) {
  const explicit = process.env.BAZIS_BRIDGE_IPC_DIR;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }
  if (ep && ep.ipcDir) {
    const candidate = path.isAbsolute(ep.ipcDir)
      ? ep.ipcDir
      : path.join(REPO_ROOT, ep.ipcDir);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const defaultDir = path.join(REPO_ROOT, ".bridge-ipc");
  if (ep && fs.existsSync(defaultDir)) {
    return defaultDir;
  }
  return null;
}

function resolveBridgeTargets() {
  const envUrl = process.env.BAZIS_BRIDGE_URL;
  const envToken = process.env.BAZIS_BRIDGE_TOKEN || null;

  if (envUrl) {
    return {
      ipcDir: null,
      urls: [envUrl.replace(/\/+$/, "")],
      token: envToken,
      source: "BAZIS_BRIDGE_URL",
    };
  }

  const ep = readEndpointFile();
  if (ep) {
    const ipcDir = resolveIpcDir(ep);
    const urls = (ep.urls || []).map((u) => String(u).replace(/\/+$/, ""));
    const token = envToken || ep.token || null;
    if (cachedGoodUrl && cachedTokenKey === token && urls.includes(cachedGoodUrl)) {
      const reordered = [cachedGoodUrl, ...urls.filter((u) => u !== cachedGoodUrl)];
      return { ipcDir, urls: reordered, token, source: ".bridge-endpoint.json" };
    }
    return { ipcDir, urls, token, source: ".bridge-endpoint.json" };
  }

  return {
    ipcDir: resolveIpcDir(null),
    urls: ["http://127.0.0.1:18765"],
    token: envToken,
    source: "default",
  };
}

function ipcJsonRequest(ipcDir, method, urlPath, body, timeoutMs) {
  const effectiveTimeout = timeoutMs || REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const reqId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const reqTmp = path.join(ipcDir, `req-${reqId}.tmp`);
    const reqFinal = path.join(ipcDir, `req-${reqId}.json`);
    const resFinal = path.join(ipcDir, `res-${reqId}.json`);

    try {
      fs.writeFileSync(
        reqTmp,
        JSON.stringify({
          id: reqId,
          method,
          path: urlPath,
          body: body !== undefined && body !== null ? body : {},
        }),
        "utf8"
      );
      fs.renameSync(reqTmp, reqFinal);
    } catch (err) {
      try { fs.unlinkSync(reqTmp); } catch {}
      err._networkError = true;
      reject(err);
      return;
    }

    const deadline = Date.now() + effectiveTimeout;
    const poll = setInterval(() => {
      if (fs.existsSync(resFinal)) {
        clearInterval(poll);
        try {
          const raw = fs.readFileSync(resFinal, "utf8");
          try { fs.unlinkSync(resFinal); } catch {}
          const parsed = JSON.parse(raw);
          resolve({ status: parsed.status || 200, data: parsed.data || {} });
        } catch (err) {
          reject(new Error(`Failed to parse IPC response: ${err.message}`));
        }
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        try { fs.unlinkSync(reqFinal); } catch {}
        const err = new Error(`Shared-folder IPC timed out after ${effectiveTimeout} ms`);
        err._networkError = true;
        reject(err);
      }
    }, 25);
  });
}

function httpJsonRequest(baseUrl, method, urlPath, body, token, timeoutMs) {
  const effectiveTimeout = timeoutMs || REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    } catch (err) {
      reject(new Error(`Invalid bridge URL "${baseUrl}": ${err.message}`));
      return;
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const payload = body !== undefined && body !== null ? JSON.stringify(body) : null;

    const headers = {
      Accept: "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      headers["X-Bazis-Token"] = token;
    }
    if (payload !== null) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = Buffer.byteLength(payload, "utf8");
    }

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        timeout: effectiveTimeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = { ok: false, raw: text };
          }
          resolve({ status: res.statusCode || 0, data: json });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out after ${effectiveTimeout} ms`));
    });
    req.on("error", (err) => {
      err._networkError = true;
      reject(err);
    });

    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

async function probeFastestUrl(urls, token) {
  if (urls.length <= 1) return urls[0];
  try {
    return await Promise.any(
      urls.map(async (u) => {
        const res = await httpJsonRequest(u, "GET", "/health", null, token, 2500);
        if (res.status >= 200 && res.status < 500) {
          return u;
        }
        throw new Error(`HTTP ${res.status}`);
      })
    );
  } catch {
    return null;
  }
}

async function callBridge(method, urlPath, body) {
  const { ipcDir, urls, token, source } = resolveBridgeTargets();
  const attempts = [];

  if (ipcDir) {
    try {
      const { status, data } = await ipcJsonRequest(ipcDir, method, urlPath, body);
      if (status < 200 || status >= 300 || (data && data.ok === false)) {
        const detail = (data && (data.error || data.raw)) || `Status ${status}`;
        const stack = data && data.stack ? `\n${data.stack}` : "";
        throw new Error(`Bazis bridge error (${status}): ${detail}${stack}`);
      }
      return data;
    } catch (err) {
      if (err && err._networkError) {
        attempts.push(`ipc(${ipcDir}): ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  let orderedUrls = urls;
  if (orderedUrls.length > 1 && !(cachedGoodUrl && cachedTokenKey === token && orderedUrls.includes(cachedGoodUrl))) {
    const fastest = await probeFastestUrl(orderedUrls, token);
    if (fastest) {
      orderedUrls = [fastest, ...orderedUrls.filter((u) => u !== fastest)];
    }
  }

  for (const baseUrl of orderedUrls) {
    try {
      const { status, data } = await httpJsonRequest(baseUrl, method, urlPath, body, token);
      cachedGoodUrl = baseUrl;
      cachedTokenKey = token;

      if (status === 401) {
        throw new Error(
          `Unauthorized (401) from ${baseUrl}. Check BAZIS_BRIDGE_TOKEN or restart bridge.js in Bazis.`
        );
      }
      if (status < 200 || status >= 300 || (data && data.ok === false)) {
        const detail = (data && (data.error || data.raw)) || `HTTP ${status}`;
        const stack = data && data.stack ? `\n${data.stack}` : "";
        throw new Error(`Bazis bridge error (${status}): ${detail}${stack}`);
      }
      return data;
    } catch (err) {
      if (err && err._networkError) {
        if (cachedGoodUrl === baseUrl) cachedGoodUrl = null;
        attempts.push(`${baseUrl}: ${err.message}`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    [
      `Could not connect to Bazis MCP bridge (source: ${source}).`,
      `Tried: ${attempts.join("; ")}`,
      `Make sure Bazis-Mebelshchik 2022 is open and bridge.js is running via the "Scripts" menu.`,
    ].join("\n")
  );
}

const TOOLS = [
  {
    name: "bazis_health",
    description:
      "Check connectivity to the Bazis-Mebelshchik 2022 HTTP bridge and return API version, active model name, object count, and advertised bridge URLs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "bazis_get_model",
    description:
      "Inspect the currently open Bazis 3D model: article metadata, filename, active material, overall bounding box, and recursive tree of objects/blocks/panels with UIDs and dimensions (mm).",
    inputSchema: {
      type: "object",
      properties: {
        maxDepth: {
          type: "integer",
          description: "Maximum nesting depth for blocks/assemblies (default 8).",
          minimum: 0,
          maximum: 20,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_get_bom",
    description:
      "Extract a Bill of Materials / cut list of every panel in the active Bazis model, including block path, contour width/height, thickness, material, edge banding (butts), cuts, plastics, and area summary by material.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "bazis_create_panel",
    description:
      "Create a single rectangular panel in Bazis (horizontal, vertical, or frontal) in millimeters and commit it to the model. Coordinate system: X = width (left-to-right), Y = height (bottom-to-top), Z = depth (back-to-front).",
    inputSchema: {
      type: "object",
      properties: {
        orientation: {
          type: "string",
          enum: ["horiz", "vert", "front"],
          description:
            "Panel orientation: 'horiz' (X-Z plane at height y), 'vert' (Z-Y plane at position x), or 'front' (X-Y plane at depth z).",
        },
        name: { type: "string", description: "Panel name shown in Bazis model tree." },
        x1: { type: "number", description: "Start X coordinate in mm (horiz, front)." },
        x2: { type: "number", description: "End X coordinate in mm (horiz, front)." },
        y1: { type: "number", description: "Start Y coordinate in mm (vert, front)." },
        y2: { type: "number", description: "End Y coordinate in mm (vert, front)." },
        z1: { type: "number", description: "Start Z coordinate in mm (horiz, vert)." },
        z2: { type: "number", description: "End Z coordinate in mm (horiz, vert)." },
        x: { type: "number", description: "X position in mm (vert panel)." },
        y: { type: "number", description: "Y position in mm (horiz panel)." },
        z: { type: "number", description: "Z position in mm (front panel)." },
        thickness: { type: "number", description: "Panel thickness in mm (optional; defaults to active material)." },
        material: {
          type: "object",
          description: "Optional material to activate before creating the panel.",
          properties: {
            name: { type: "string" },
            thickness: { type: "number" },
          },
          required: ["name", "thickness"],
          additionalProperties: false,
        },
        textureOrientation: {
          type: "integer",
          enum: [0, 1, 2],
          description: "0 = None, 1 = Horizontal, 2 = Vertical.",
        },
        viewAll: {
          type: "boolean",
          description: "Zoom camera to fit all objects after creating the panel.",
        },
      },
      required: ["orientation"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_create_carcass",
    description:
      "Create a parametric cabinet carcass block in Bazis (left/right sides, top, bottom, optional plinth, back panel, and evenly spaced internal shelves). All dimensions in millimeters.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Block name (default 'Cabinet')." },
        width: { type: "number", description: "Overall cabinet width along X in mm (default 600)." },
        height: { type: "number", description: "Overall cabinet height along Y in mm (default 720)." },
        depth: { type: "number", description: "Overall cabinet depth along Z in mm (default 560)." },
        x: { type: "number", description: "Origin X offset in mm (default 0)." },
        y: { type: "number", description: "Origin Y offset in mm (default 0)." },
        z: { type: "number", description: "Origin Z offset in mm (default 0)." },
        thickness: { type: "number", description: "Board thickness in mm (default active material or 16)." },
        materialName: { type: "string", description: "Optional material name for carcass panels." },
        topMode: {
          type: "string",
          enum: ["between", "overlay"],
          description: "'between' (top sits between sides, default) or 'overlay' (top rests on sides).",
        },
        bottomMode: {
          type: "string",
          enum: ["between", "underlay"],
          description: "'between' (bottom sits between sides, default) or 'underlay' (sides rest on bottom).",
        },
        plinthHeight: { type: "number", description: "Plinth / toe-kick height in mm (default 0)." },
        addPlinth: { type: "boolean", description: "Add front plinth panel when plinthHeight > 0 (default true)." },
        plinthSetback: { type: "number", description: "Front plinth recess from front edge in mm (default 30)." },
        backPanel: { type: "boolean", description: "Include back panel (default true)." },
        backThickness: { type: "number", description: "Back panel thickness in mm (default 4)." },
        backMaterialName: { type: "string", description: "Optional material name for back panel." },
        backInset: {
          type: "number",
          description: "0 for overlay/nailed back at z=0 (default), or >0 for inset back inside sides.",
        },
        shelves: { type: "integer", minimum: 0, description: "Number of evenly spaced internal shelves (default 0)." },
        shelfSetback: { type: "number", description: "Shelf front setback in mm (default 10)." },
        viewAll: { type: "boolean", description: "Zoom camera to fit model after creating (default true)." },
      },
      required: ["width", "height", "depth"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_delete_object",
    description: "Delete one or more objects/blocks/panels from the Bazis model by UID.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "integer", description: "Single object UID to delete." },
        uids: {
          type: "array",
          items: { type: "integer" },
          description: "Array of object UIDs to delete in one commit.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_transform_object",
    description:
      "Modify an existing Bazis object/block by UID (rename, toggle visibility, translate by dx/dy/dz in global coordinates, or rotate around x/y/z axis in degrees) with Undo support.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "integer", description: "Object UID from bazis_get_model or bazis_get_bom." },
        name: { type: "string", description: "New object name." },
        visible: { type: "boolean", description: "Set visibility." },
        translate: {
          type: "object",
          description: "Global translation delta in mm.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { type: "number" },
          },
          additionalProperties: false,
        },
        rotate: {
          type: "object",
          description: "Rotation around a local axis in degrees.",
          properties: {
            axis: { type: "string", enum: ["x", "y", "z"] },
            angle: { type: "number" },
          },
          required: ["axis", "angle"],
          additionalProperties: false,
        },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_check_model",
    description:
      "Run Bazis built-in Model Inspector (NewModelInspector) on the active model to detect object/fastener intersections, unfixed panels, oversized panels, or missing materials.",
    inputSchema: {
      type: "object",
      properties: {
        objIntersection: { type: "boolean" },
        fastIntersection: { type: "boolean" },
        fastIncorrect: { type: "boolean" },
        panelNotFixed: { type: "boolean" },
        panelTooLarge: { type: "boolean" },
        plasticTooLarge: { type: "boolean" },
        matNotExists: { type: "boolean" },
        matOutOfStock: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_panel_butt",
    description:
      "Inspect contour edges or apply edge banding (butts) to a panel by UID. Use action='inspect_edges' to list edge indices and lengths, or omit action to apply edge banding to 'all', 'visible', or specific edge indices.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "integer", description: "Target panel UID." },
        action: {
          type: "string",
          enum: ["apply", "inspect_edges"],
          description: "'inspect_edges' returns contour edge indices and existing butts without modifying; default 'apply'.",
        },
        edges: {
          oneOf: [
            { type: "string", enum: ["all", "visible"] },
            { type: "array", items: { type: "integer" } },
          ],
          description: "Edges to band: 'all' (default), 'visible' (unoccluded edges), or array of contour edge indices.",
        },
        visibilityDistance: { type: "number", description: "Probe distance in mm when edges='visible' (default 5)." },
        clearExisting: { type: "boolean", description: "Clear existing butts before applying (default false)." },
        material: { type: "string", description: "Edge banding material name (default 'PVC 2mm')." },
        thickness: { type: "number", description: "Edge thickness in mm (default 2)." },
        width: { type: "number", description: "Edge tape width in mm (default panel thickness + 3)." },
        sign: { type: "string", description: "Designation/sign for drawings (defaults to thickness string)." },
        clipPanel: { type: "boolean", description: "Trim panel contour by edge thickness (default true)." },
        overhung: { type: "number", description: "Optional tape overhang in mm." },
        allowance: { type: "number", description: "Optional milling allowance in mm." },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_panel_cut",
    description:
      "Add a straight groove / dado to a panel by UID, either by explicit 2D local trajectory ({x1,y1,x2,y2}) or relative to a side ('left','right','top','bottom','back','front') with an offset in mm.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "integer", description: "Target panel UID." },
        name: { type: "string", description: "Groove name (default 'Groove')." },
        sign: { type: "string", description: "Optional groove designation." },
        width: { type: "number", description: "Groove width in mm (default 4)." },
        depth: { type: "number", description: "Groove depth in mm (default 8)." },
        frontSide: { type: "boolean", description: "Cut on the front face (true) or back face (false)." },
        side: {
          type: "string",
          enum: ["left", "right", "top", "bottom", "back", "front", "min_x", "max_x", "min_y", "max_y"],
          description: "Side along which to cut the groove.",
        },
        offset: { type: "number", description: "Offset from the chosen side in mm (default 15)." },
        endInset: { type: "number", description: "Inset from both ends of the groove in mm (default 0)." },
        trajectory: {
          type: "object",
          description: "Explicit 2D local trajectory endpoints in mm (overrides 'side').",
          properties: {
            x1: { type: "number" },
            y1: { type: "number" },
            x2: { type: "number" },
            y2: { type: "number" },
          },
          required: ["x1", "y1", "x2", "y2"],
          additionalProperties: false,
        },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_panel_cutout",
    description:
      "Modify a panel's 2D contour by subtracting/adding a rectangle (with optional cornerRadius) or circle, or adding an inner circular hole.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "integer", description: "Target panel UID." },
        shape: { type: "string", enum: ["rect", "circle"], description: "Cutout shape (default 'rect')." },
        mode: {
          type: "string",
          enum: ["subtract", "add", "hole", "inner"],
          description: "'subtract' (default), 'add', or 'hole'/'inner' (for circular inner holes).",
        },
        x1: { type: "number", description: "Rect start X in panel local 2D coords (mm)." },
        y1: { type: "number", description: "Rect start Y in panel local 2D coords (mm)." },
        x2: { type: "number", description: "Rect end X in panel local 2D coords (mm)." },
        y2: { type: "number", description: "Rect end Y in panel local 2D coords (mm)." },
        cornerRadius: { type: "number", description: "Optional corner radius for rect shape (mm)." },
        cx: { type: "number", description: "Circle center X in panel local 2D coords (mm)." },
        cy: { type: "number", description: "Circle center Y in panel local 2D coords (mm)." },
        radius: { type: "number", description: "Circle radius in mm." },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_list_fasteners",
    description:
      "List available Bazis fastener/accessory/fragment (.f3d) files from the user's Bazis Accessories and Fragments libraries.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional case-insensitive substring filter." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max files to return (default 200)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_mount_fastener",
    description:
      "Mount a Bazis fastener/accessory (.f3d) between two panels ('between' — auto-computes evenly spaced seam points if 'points' omitted), onto a panel plane ('plane'), as a fastener scheme ('scheme'), or as a box section ('box').",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Full path, relative path, or name substring from bazis_list_fasteners." },
        mode: {
          type: "string",
          enum: ["between", "plane", "scheme", "box"],
          description: "Mount mode (default 'between').",
        },
        panel1Uid: { type: "integer", description: "First panel UID (required for between, plane, scheme)." },
        panel2Uid: { type: "integer", description: "Second panel UID (required for between, scheme)." },
        count: { type: "integer", minimum: 1, description: "Number of auto-spaced fasteners along seam for 'between' (default 2)." },
        indent: { type: "number", description: "End indent along seam in mm for 'between' (default 50)." },
        points: {
          type: "array",
          description: "Explicit 3D mount points [{x,y,z,angle?}] in mm.",
          items: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              z: { type: "number" },
              angle: { type: "number" },
            },
            required: ["x", "y", "z"],
            additionalProperties: false,
          },
        },
        position: {
          oneOf: [
            { type: "string", enum: ["inside", "outside", "up", "down"] },
            { type: "integer" },
            {
              type: "object",
              properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
              additionalProperties: false,
            },
          ],
          description: "For 'scheme': inside/outside/up/down. For 'box': {x,y,z} origin.",
        },
        basisPoint: {
          type: "object",
          description: "Basis point {x,y,z} for 'scheme' mode.",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
          additionalProperties: false,
        },
        size: {
          type: "object",
          description: "Box size {x,y,z} for 'box' mode.",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
          additionalProperties: false,
        },
        axisZ: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
          additionalProperties: false,
        },
        axisY: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
          additionalProperties: false,
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_add_doors",
    description:
      "Add cabinet doors either via native Bazis DoorsMaker (pass configFile + carcassUid or leftPanelUid/rightPanelUid/topPanelUid/bottomPanelUid) or parametrically (1 or 2 overlay/inset doors with optional edge banding and handles).",
    inputSchema: {
      type: "object",
      properties: {
        configFile: { type: "string", description: "Optional native Bazis DoorsMaker config file path or name (saved via DoorsMaker). When provided, runs NewDoorsMaker().Load(configFile) + Setup(left, right, top, bottom)." },
        dir: { type: "string", description: "Optional directory to search for configFile." },
        leftPanelUid: { type: "integer", description: "Left section boundary panel UID for DoorsMaker (auto-detected from carcassUid if omitted)." },
        rightPanelUid: { type: "integer", description: "Right section boundary panel UID for DoorsMaker (auto-detected from carcassUid if omitted)." },
        topPanelUid: { type: "integer", description: "Top section boundary panel UID for DoorsMaker (auto-detected from carcassUid if omitted)." },
        bottomPanelUid: { type: "integer", description: "Bottom section boundary panel UID for DoorsMaker (auto-detected from carcassUid if omitted)." },
        silent: { type: "boolean", description: "DoorsMaker.Silent flag (default true)." },
        showErrors: { type: "boolean", description: "DoorsMaker.ShowErrors flag (default false)." },
        carcassUid: { type: "integer", description: "Optional existing carcass block UID to auto-size doors (or auto-detect section boundary panels for DoorsMaker)." },
        name: { type: "string", description: "Door block name." },
        count: { type: "integer", enum: [1, 2], description: "Number of door leaves (1 or 2, default 1)." },
        mountType: { type: "string", enum: ["overlay", "inset"], description: "'overlay' (default) or 'inset'." },
        hingeSide: { type: "string", enum: ["left", "right"], description: "Hinge side for single door handle placement." },
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        depth: { type: "number" },
        carcassThickness: { type: "number", description: "Carcass wall thickness in mm (default 16)." },
        plinthHeight: { type: "number", description: "Plinth height to exclude from bottom when using carcassUid (default 0)." },
        thickness: { type: "number", description: "Door leaf thickness in mm (default 16)." },
        gap: { type: "number", description: "Reveal/gap in mm (default 2)." },
        materialName: { type: "string" },
        edgeMaterial: { type: "string", description: "Optional edge banding material applied to all 4 door edges." },
        edgeThickness: { type: "number", description: "Edge banding thickness in mm (default 2)." },
        handleFile: { type: "string", description: "Optional handle .f3d file/name to mount on doors." },
        viewAll: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_add_drawers",
    description:
      "Add drawers either via native Bazis BoxesMaker (pass configFile + carcassUid or leftPanelUid/rightPanelUid/topPanelUid/bottomPanelUid) or parametrically (1 to 12 stacked drawer boxes with sides, back, inner front, bottom, and facade front).",
    inputSchema: {
      type: "object",
      properties: {
        configFile: { type: "string", description: "Optional native Bazis BoxesMaker config file path or name (saved via BoxesMaker). When provided, runs NewBoxesMaker().Load(configFile) + Setup(left, right, top, bottom)." },
        dir: { type: "string", description: "Optional directory to search for configFile." },
        leftPanelUid: { type: "integer", description: "Left section boundary panel UID for BoxesMaker (auto-detected from carcassUid if omitted)." },
        rightPanelUid: { type: "integer", description: "Right section boundary panel UID for BoxesMaker (auto-detected from carcassUid if omitted)." },
        topPanelUid: { type: "integer", description: "Top section boundary panel UID for BoxesMaker (auto-detected from carcassUid if omitted)." },
        bottomPanelUid: { type: "integer", description: "Bottom section boundary panel UID for BoxesMaker (auto-detected from carcassUid if omitted)." },
        showErrors: { type: "boolean", description: "BoxesMaker.ShowErrors flag (default false)." },
        carcassUid: { type: "integer", description: "Optional existing carcass block UID (used for parametric sizing or auto-detecting section boundary panels for BoxesMaker)." },
        name: { type: "string", description: "Drawers block name." },
        count: { type: "integer", minimum: 1, maximum: 12, description: "Number of stacked drawers (default 1)." },
        mountType: { type: "string", enum: ["overlay", "inset"], description: "Facade style (default 'overlay')." },
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        depth: { type: "number" },
        carcassThickness: { type: "number", description: "Carcass wall thickness in mm (default 16)." },
        plinthHeight: { type: "number", description: "Plinth height to exclude when using carcassUid (default 0)." },
        boxThickness: { type: "number", description: "Drawer box panel thickness in mm (default 16)." },
        bottomThickness: { type: "number", description: "Drawer bottom thickness in mm (default 4)." },
        frontThickness: { type: "number", description: "Facade front thickness in mm (default 16)." },
        boxDepth: { type: "number", description: "Drawer box depth in mm (default opening depth - 45)." },
        slideClearance: { type: "number", description: "Per-side slide clearance in mm (default 13)." },
        frontGap: { type: "number", description: "Gap between drawer fronts in mm (default 3)." },
        boxHeightRatio: { type: "number", description: "Box height as fraction of slot height (default 0.72)." },
        materialName: { type: "string", description: "Drawer box material." },
        bottomMaterialName: { type: "string", description: "Drawer bottom material." },
        frontMaterialName: { type: "string", description: "Drawer facade material." },
        edgeMaterial: { type: "string", description: "Optional edge banding for drawer fronts." },
        edgeThickness: { type: "number", description: "Edge banding thickness in mm (default 2)." },
        viewAll: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_materials",
    description:
      "Inspect active & used materials ('get'), set the active material for subsequent panels ('set_active'), or assign a material/thickness/textureOrientation to existing panel or block UID(s) ('assign').",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set_active", "assign"], description: "Action (default 'get')." },
        name: { type: "string", description: "Material name (for set_active / assign)." },
        thickness: { type: "number", description: "Material thickness in mm." },
        width: { type: "number", description: "Optional material width in mm (set_active)." },
        textureOrientation: { type: "integer", enum: [0, 1, 2], description: "0=None, 1=Horizontal, 2=Vertical (assign)." },
        uid: { type: "integer", description: "Single panel or block UID (assign)." },
        uids: { type: "array", items: { type: "integer" }, description: "Array of panel/block UIDs (assign)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_export",
    description:
      "Export a panel contour to SVG ('svg'), or export the model Bill of Materials to CSV ('bom_csv') or JSON ('bom_json') at a Windows file path (use Z:\\Documents\\Claude\\bazis-mcp\\... to share directly with macOS).",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["bom_csv", "bom_json", "svg"], description: "Export format (default 'bom_csv')." },
        filename: { type: "string", description: "Destination Windows path (e.g. 'Z:\\\\Documents\\\\Claude\\\\bazis-mcp\\\\bom.csv')." },
        uid: { type: "integer", description: "Panel UID (required when format='svg')." },
        curveQuality: { type: "number", description: "SVG curve quality 0-100." },
        groupElems: { type: "boolean", description: "SVG group elements into polylines/polygons." },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_scene_action",
    description:
      "Perform a document or viewport action in Bazis: zoom to fit ('view_all'), orient camera ('orient_camera'), create a new empty model ('new_model'), save/load model or project, or arrange part positions ('arrange_positions').",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "view_all",
            "orient_camera",
            "new_model",
            "save_model",
            "load_model",
            "save_project",
            "load_project",
            "arrange_positions",
          ],
        },
        filename: {
          type: "string",
          description: "Windows file path for save/load actions (e.g. 'C:\\\\Projects\\\\cabinet.b3d').",
        },
        dir: {
          type: "object",
          description: "Camera direction vector for orient_camera.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { type: "number" },
          },
          additionalProperties: false,
        },
        mode: {
          type: "integer",
          enum: [0, 1, 2],
          description: "For arrange_positions: 0 = All, 1 = New, 2 = Check.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_list_scripts",
    description:
      "List available Bazis JavaScript (.js) scripts from the user's Bazis Scripts folder (and optional custom directory or Z:\\Documents\\Claude\\bazis-mcp\\scripts).",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional case-insensitive substring filter." },
        dir: { type: "string", description: "Optional extra Windows directory path to scan." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max scripts to return (default 200)." },
        includeBridge: { type: "boolean", description: "Include bridge.js in listing (default false)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_run_script",
    description:
      "Run an existing Bazis .js script file inside Bazis 2022. By default runs in 'sandboxed' mode, which intercepts Action.Finish()/Cancel()/Continue() so the MCP bridge stays alive, captures system.log()/alert() output, and suppresses blocking ask*/prompt/confirm dialogs (unless allowAlerts/allowDialogs are true). Set mode='include' for raw system.include().",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Script name, relative path inside Bazis Scripts, or full Windows path (e.g. 'probe.js' or 'Z:\\\\Documents\\\\Claude\\\\bazis-mcp\\\\scripts\\\\my_cabinet.js').",
        },
        dir: { type: "string", description: "Optional extra Windows directory to search when resolving relative 'file'." },
        params: { type: "object", description: "Optional JSON object exposed as 'params' inside the script." },
        mode: {
          type: "string",
          enum: ["sandboxed", "include"],
          description: "'sandboxed' (default, safe for MCP bridge) or 'include' (raw system.include).",
        },
        commit: { type: "boolean", description: "Auto-call Action.Commit() after script finishes if not already committed (default true)." },
        allowAlerts: { type: "boolean", description: "Allow modal alert() popups in Bazis UI (default false; captured into alerts[])." },
        allowDialogs: { type: "boolean", description: "Allow interactive file/folder/prompt/confirm dialogs (default false; captured into dialogs[])." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_list_library",
    description:
      "List Bazis library folders and files (Fragments .fr3d, Accessories .f3d, Templates .b3d, Blum, Doors library .bdl, Drawer library .bbb, or custom directory).",
    inputSchema: {
      type: "object",
      properties: {
        library: {
          type: "string",
          enum: ["all", "fragments", "accessories", "templates", "blum", "doors", "drawers", "custom"],
          description: "Which library to scan (default 'all').",
        },
        filter: { type: "string", description: "Case-insensitive substring filter on filename/relativePath." },
        extensions: {
          type: "array",
          items: { type: "string" },
          description: "Optional extension filter (e.g. ['.fr3d', '.b3d']).",
        },
        dir: { type: "string", description: "Optional custom Windows directory path to include/scan." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max files to return (default 200)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_open_library",
    description:
      "Open a model/fragment from a Bazis library (.fr3d, .b3d, .f3d) either by inserting it into the current scene ('insert', default — supports positioning, rotation, and elastic resizing for elastic fragments) or replacing the active document ('open').",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "File name, relative path in library, or full Windows path (e.g. 'Fragment cabinet.fr3d' or 'Shelf el').",
        },
        library: {
          type: "string",
          enum: ["all", "fragments", "accessories", "templates", "blum", "custom"],
          description: "Library to resolve relative 'file' in (default 'all').",
        },
        dir: { type: "string", description: "Optional custom Windows directory." },
        mode: {
          type: "string",
          enum: ["insert", "open"],
          description: "'insert' adds into current model (default); 'open' opens as active document via Action.LoadModel.",
        },
        name: { type: "string", description: "Block name when mode='insert' and wrapInBlock=true." },
        wrapInBlock: { type: "boolean", description: "Load into a new named Block (default true) or directly into Model (false)." },
        position: {
          type: "object",
          description: "Global translation {x,y,z} in mm after loading (mode='insert', wrapInBlock=true).",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
          additionalProperties: false,
        },
        rotate: {
          type: "object",
          description: "Optional rotation {axis:'x'|'y'|'z', angle} in degrees (mode='insert', wrapInBlock=true).",
          properties: {
            axis: { type: "string", enum: ["x", "y", "z"] },
            angle: { type: "number" },
          },
          required: ["axis", "angle"],
          additionalProperties: false,
        },
        elasticSize: {
          type: "object",
          description: "If loaded fragment is elastic (IsElastic()), resize it to {x,y,z} mm via ElasticResize.",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
          required: ["x", "y", "z"],
          additionalProperties: false,
        },
        viewAll: { type: "boolean", description: "Zoom to fit after opening/inserting (default true)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_save_library",
    description:
      "Save the active Bazis model/fragment/furniture into a Bazis library folder (Fragments .fr3d, Accessories .f3d, Templates .b3d, Blum, or custom dir). Automatically creates subfolders and appends the library's default extension if omitted.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Target filename, relative path (e.g. 'Custom\\\\BaseCabinet600.fr3d'), or full Windows path.",
        },
        library: {
          type: "string",
          enum: ["fragments", "accessories", "templates", "blum", "custom"],
          description: "Target library folder when 'file' is relative (default 'fragments').",
        },
        dir: { type: "string", description: "Optional custom Windows directory to save into." },
        format: {
          type: "string",
          enum: ["fr3d", "b3d", "f3d"],
          description: "Optional file extension if 'file' has none (defaults to library's default extension).",
        },
        articleName: { type: "string", description: "Optional Article.Name to set before saving." },
        articleCode: { type: "string", description: "Optional Article.Code to set before saving." },
        datumMode: {
          type: "integer",
          enum: [0, 1, 2, 3, 4, 5, 6, 7],
          description: "Optional Article.DatumMode (0=None, 1=Face, 2=FaceFace, 3=FaceButt, 4=FaceEdge, 5=ParallelFaces, 6=Box, 7=Scheme).",
        },
        overwrite: { type: "boolean", description: "Allow overwriting an existing file (default false)." },
        commit: { type: "boolean", description: "Call Action.Commit() before saving (default true)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_bbb_read",
    description:
      "Decode a Bazis Drawer Library (.bbb) or Binary XML config file into structured JSON. Use mode='summary' (default) to list all drawer systems, dimensions, and runner lengths; mode='item' (with index or name) to inspect one drawer AST; or mode='full' for the complete AST.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Filename in Bazis Drawer library (e.g. 'Hettich.bbb', 'Blum.bbb'), relative path, or full Windows path.",
        },
        dir: { type: "string", description: "Optional directory to search for the file." },
        mode: {
          type: "string",
          enum: ["summary", "item", "full"],
          description: "'summary' (default), 'item', or 'full'.",
        },
        index: { type: "integer", description: "0-based box index when mode='item'." },
        name: { type: "string", description: "Case-insensitive box name substring when mode='item'." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_bbb_write",
    description:
      "Create or update a native Bazis Drawer Library (.bbb) file (e.g. Blum.bbb, GTV.bbb, Boyard.bbb) from high-level StandartBox/SysBox drawer specs or a raw decoded AST, and automatically verify it with NewBoxesMaker().Load() in Bazis 2022.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Target filename in Bazis Drawer library (e.g. 'Blum.bbb') or full Windows path.",
        },
        dir: { type: "string", description: "Optional custom Windows directory." },
        overwrite: { type: "boolean", description: "Allow overwriting an existing .bbb file (default false)." },
        append: { type: "boolean", description: "Merge/update boxes by name into an existing .bbb file (default false)." },
        activeIndex: { type: "integer", description: "Active drawer index in the library (default 0)." },
        validateWithBazis: { type: "boolean", description: "Verify written file via NewBoxesMaker().Load() (default true)." },
        boxes: {
          type: "array",
          description:
            "Array of high-level StandartBox (wooden box on runners: TANDEM/MOVENTO/Quadro/ball-bearing) or SysBox (metal-side system: TANDEMBOX/LEGRABOX/MERIVOBOX/InnoTech) specs, or raw AST box nodes.",
          items: { type: "object" },
        },
        ast: {
          type: "object",
          description: "Optional raw Bazis Binary XML root AST (e.g. modified from bazis_bbb_read mode='full').",
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_bxf_to_bbb",
    description:
      "Convert one or more Blum E-SERVICES 'Bazis (*.bxf2)' XML export files (local macOS paths, e.g. '~/Downloads/MOVENTO-....bxf2') into a native Bazis Drawer Library (.bbb) configuration with official Blum article numbers, groove dimensions, and System 32 drilling patterns, and write/verify it in Bazis Drawer library.",
    inputSchema: {
      type: "object",
      properties: {
        bxfFile: {
          type: "string",
          description: "Path to a single .bxf2 file on macOS (supports ~/...).",
        },
        bxfFiles: {
          type: "array",
          items: { type: "string" },
          description: "Array of .bxf2 file paths (e.g. multiple nominal lengths of the same Blum series) merged into one drawer config.",
        },
        targetFile: {
          type: "string",
          description: "Target .bbb filename in Bazis Drawer library (default 'Blum_EServices.bbb') or full Windows path.",
        },
        name: {
          type: "string",
          description: "Optional custom drawer configuration name in Bazis.",
        },
        append: {
          type: "boolean",
          description: "Merge into existing target .bbb without overwriting other drawer configs (default true).",
        },
        overwrite: {
          type: "boolean",
          description: "Overwrite target .bbb completely instead of merging (default false).",
        },
        dryRun: {
          type: "boolean",
          description: "If true, only parse and return the extracted Blum spec without writing to Bazis.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_db_info",
    description:
      "Inspect the Bazis Firebird 2.5 Materials Database (.fdb): returns database path, port, file size, table row counts, material types, units of measure, and sample material groups.",
    inputSchema: {
      type: "object",
      properties: {
        dbPath: { type: "string", description: "Optional explicit Windows path to the .fdb file." },
        port: { type: "string", description: "Optional Firebird port (auto-detected from firebird.conf, default 14357)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_db_query",
    description:
      "Search materials in the Bazis Firebird 2.5 Materials Database (by name/article/groupId) or execute a read-only SQL SELECT query.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive substring search in material name and article." },
        article: { type: "string", description: "Case-insensitive substring filter on ARTICLE." },
        groupId: { type: "integer", description: "Filter by GROUP_MATERIAL.ID_GRM." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max rows to return (default 50)." },
        sql: { type: "string", description: "Optional read-only Firebird SQL SELECT statement." },
        dbPath: { type: "string", description: "Optional explicit Windows path to the .fdb file." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_db_execute",
    description:
      "Insert or update materials in the Bazis Firebird 2.5 Materials Database (action='upsert_material') or execute a write SQL statement (INSERT/UPDATE/DELETE). Automatically creates a dated .fdb backup before writing unless backup=false.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["upsert_material", "sql"], description: "Structured 'upsert_material' or raw 'sql'." },
        id: { type: "integer", description: "Existing MATERIAL.ID_M to update (omit to insert a new material)." },
        name: { type: "string", description: "Material name (NAME_MAT) for upsert_material." },
        article: { type: "string", description: "Material article code (ARTICLE) for upsert_material." },
        groupId: { type: "integer", description: "Material group ID (ID_GRM, default 1)." },
        measureId: { type: "integer", description: "Unit of measure ID (ID_MS, default 1)." },
        price: { type: "number", description: "Unit price (PRICE)." },
        weight: { type: "number", description: "Unit weight (WEIGHT)." },
        comment: { type: "string", description: "Material comment (COMMENT)." },
        sql: { type: "string", description: "Write SQL statement(s) when action is omitted or 'sql' (auto-committed)." },
        backup: { type: "boolean", description: "Create dated .fdb backup before writing (default true)." },
        dbPath: { type: "string", description: "Optional explicit Windows path to the .fdb file." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_panel_edit_contour",
    description:
      "Edit a panel's 2D contour by UID: rubber-band stretch ('elastic'), fit to rectangle ('fit'), corner rounding/fillet ('rounding'), corner chamfer ('chamfer'), 2D mirror ('symmetry'), equidistant offset ('offset'), or load a .frw contour ('load_frw').",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "integer", description: "Target panel UID." },
        action: {
          type: "string",
          enum: ["elastic", "fit", "rounding", "chamfer", "symmetry", "offset", "load_frw"],
          description: "Contour edit operation (default 'elastic').",
        },
        x1: { type: "number", description: "Selection/fit/axis start X (local 2D mm)." },
        y1: { type: "number", description: "Selection/fit/axis start Y (local 2D mm)." },
        x2: { type: "number", description: "Selection/fit/axis end X (local 2D mm)." },
        y2: { type: "number", description: "Selection/fit/axis end Y (local 2D mm)." },
        dx: { type: "number", description: "Rubber-band stretch delta X in mm (for action='elastic')." },
        dy: { type: "number", description: "Rubber-band stretch delta Y in mm (for action='elastic')." },
        x: { type: "number", description: "Single corner X (for rounding/chamfer)." },
        y: { type: "number", description: "Single corner Y (for rounding/chamfer)." },
        radius: { type: "number", description: "Corner rounding radius in mm (for action='rounding')." },
        length: { type: "number", description: "Corner chamfer length in mm (for action='chamfer')." },
        corners: {
          type: "array",
          description: "Optional list of corners [{x, y, radius|length}] for batch rounding/chamfer.",
          items: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              radius: { type: "number" },
              length: { type: "number" },
            },
          },
        },
        copy: { type: "boolean", description: "Keep original contour when mirroring (for action='symmetry')." },
        offset: { type: "number", description: "Equidistant offset in mm (for action='offset')." },
        side: { type: "boolean", description: "Offset direction flag (default true)." },
        rounding: { type: "boolean", description: "Round offset corners (default false)." },
        replace: { type: "boolean", description: "Replace original contour with offset contour (default true)." },
        file: { type: "string", description: "Windows path to .frw contour file (for action='load_frw')." },
        viewAll: { type: "boolean" },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_object_edit",
    description:
      "3D object editing operations: elastic resize of an elastic block/fragment ('elastic_resize'), copy or linear array ('copy'), 3D mirror/symmetry ('mirror'), or group multiple UIDs into a block/assembly ('group').",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["elastic_resize", "copy", "mirror", "group"],
          description: "3D editing operation.",
        },
        uid: { type: "integer", description: "Target object UID (for elastic_resize, copy, mirror)." },
        uids: {
          type: "array",
          items: { type: "integer" },
          description: "Array of object UIDs to group (for action='group').",
        },
        name: { type: "string", description: "Name for the copied, mirrored, or grouped object." },
        asAssembly: { type: "boolean", description: "Create an Assembly instead of a Block (for action='group')." },
        size: {
          type: "object",
          description: "Target 3D bounding size {x, y, z} in mm (for action='elastic_resize').",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
        count: { type: "integer", minimum: 1, maximum: 50, description: "Number of copies (for action='copy', default 1)." },
        offset: {
          type: "object",
          description: "Per-copy translation offset {x, y, z} in mm (for action='copy').",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
        plane: { type: "string", enum: ["yz", "xz", "xy"], description: "Mirror plane shortcut (default 'yz')." },
        coord: { type: "number", description: "Coordinate of the mirror plane along its normal axis (default 0)." },
        point: {
          type: "object",
          description: "Explicit point on the mirror plane {x, y, z}.",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
        normal: {
          type: "object",
          description: "Explicit mirror plane normal vector {x, y, z}.",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
        deleteOriginal: { type: "boolean", description: "Delete the original object after mirroring (default false)." },
        viewAll: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_panel_plastic",
    description:
      "Add or clear laminate / veneer / plastic facing on a panel's front, back, or both faces by UID.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "integer", description: "Target panel UID." },
        action: { type: "string", enum: ["add", "clear"], description: "'add' (default) or 'clear'." },
        side: { type: "string", enum: ["front", "back", "both"], description: "Target panel face(s) (default 'front')." },
        material: { type: "string", description: "Plastic/laminate material name (required for action='add')." },
        thickness: { type: "number", description: "Plastic thickness in mm (default 0.8)." },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "bazis_create_profile",
    description:
      "Create a 3D profile by linear extrusion ('extrusion' via AddExtrusion) or swept along a 2D path ('trajectory' via AddTrajectory) — useful for moldings, plinths, handle profiles, cornices, and frames.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["extrusion", "trajectory"], description: "'extrusion' (default) or 'trajectory'." },
        name: { type: "string", description: "Object name." },
        materialName: { type: "string", description: "Profile material name." },
        length: { type: "number", description: "Extrusion length in mm (for mode='extrusion', default 600)." },
        profile: {
          type: "object",
          description: "2D cross-section spec: { shape: 'rect'|'circle', width, height, radius, points: [{x,y}], closed, frwFile }.",
        },
        trajectory: {
          type: "object",
          description: "2D sweep path spec (for mode='trajectory'): { points: [{x,y}], closed, shape, width, height, frwFile }.",
        },
        position: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
        rotate: {
          type: "object",
          properties: {
            axis: { type: "string", enum: ["x", "y", "z"] },
            angle: { type: "number" },
          },
        },
        viewAll: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_screenshot",
    description:
      "Capture a PNG screenshot of the live Bazis-Mebelshchik application window ('bazis', default) or full primary display ('screen'). Optionally calls ViewAll() or orients the 3D camera first, saves to a Windows file if filename is provided, and returns a native MCP image block so vision-capable clients see the 3D scene directly.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["bazis", "screen"],
          description: "Capture target: 'bazis' main window (default) or 'screen' (full primary monitor).",
        },
        filename: {
          type: "string",
          description: "Optional Windows path to save the PNG file (e.g. 'Z:\\\\path\\\\shot.png').",
        },
        viewAll: { type: "boolean", description: "Call ViewAll() before capturing (default false)." },
        orientCamera: {
          description: "Optional camera preset ('iso', 'front', 'back', 'left', 'right', 'top') or {x, y, z} direction vector before capturing.",
          oneOf: [
            { type: "string", enum: ["iso", "front", "back", "left", "right", "top"] },
            {
              type: "object",
              properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
            },
          ],
        },
        returnBase64: {
          type: "boolean",
          description: "Return PNG inline as an MCP image content block (default true).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bazis_eval",
    description:
      "Execute arbitrary JavaScript inside Bazis-Mebelshchik 2022 with full access to the Bazis API (Model, Action, ActiveMaterial, Undo, AddHorizPanel, AddVertPanel, AddFrontPanel, BeginBlock/EndBlock, etc.). Inside 'code', use 'log(...)' to capture output, 'params' for input parameters, and 'return ...' for the JSON-serializable return value. Note: calling Action.Commit() invalidates pre-commit JS handles to newly created objects—read committed objects back from Model after committing.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript function body to execute inside Bazis.",
        },
        params: {
          type: "object",
          description: "Optional JSON object exposed as 'params' inside the script.",
        },
        commit: {
          type: "boolean",
          description: "If true, automatically call Action.Commit() after code executes (default false).",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
];

async function executeTool(name, args) {
  const params = args || {};
  switch (name) {
    case "bazis_health":
      return callBridge("GET", "/health");
    case "bazis_get_model": {
      const qs =
        params.maxDepth !== undefined
          ? `?maxDepth=${encodeURIComponent(String(params.maxDepth))}`
          : "";
      return callBridge("GET", `/model${qs}`);
    }
    case "bazis_get_bom":
      return callBridge("GET", "/bom");
    case "bazis_create_panel":
      return callBridge("POST", "/panel", params);
    case "bazis_create_carcass":
      return callBridge("POST", "/carcass", params);
    case "bazis_panel_butt":
      return callBridge("POST", "/panel/butt", params);
    case "bazis_panel_cut":
      return callBridge("POST", "/panel/cut", params);
    case "bazis_panel_cutout":
      return callBridge("POST", "/panel/cutout", params);
    case "bazis_panel_edit_contour":
      return callBridge("POST", "/panel/contour", params);
    case "bazis_panel_plastic":
      return callBridge("POST", "/panel/plastic", params);
    case "bazis_object_edit":
      return callBridge("POST", "/object/edit", params);
    case "bazis_create_profile":
      return callBridge("POST", "/profile", params);
    case "bazis_list_fasteners": {
      const q = [];
      if (params.filter) q.push(`filter=${encodeURIComponent(String(params.filter))}`);
      if (params.limit !== undefined) q.push(`limit=${encodeURIComponent(String(params.limit))}`);
      return callBridge("GET", `/fasteners${q.length ? `?${q.join("&")}` : ""}`);
    }
    case "bazis_mount_fastener":
      return callBridge("POST", "/fasteners/mount", params);
    case "bazis_add_doors":
      return callBridge("POST", "/doors", params);
    case "bazis_add_drawers":
      return callBridge("POST", "/drawers", params);
    case "bazis_materials":
      return callBridge("POST", "/materials", params);
    case "bazis_export":
      return callBridge("POST", "/export", params);
    case "bazis_list_scripts": {
      const q = [];
      if (params.filter) q.push(`filter=${encodeURIComponent(String(params.filter))}`);
      if (params.dir) q.push(`dir=${encodeURIComponent(String(params.dir))}`);
      if (params.limit !== undefined) q.push(`limit=${encodeURIComponent(String(params.limit))}`);
      if (params.includeBridge) q.push(`includeBridge=true`);
      return callBridge("GET", `/scripts${q.length ? `?${q.join("&")}` : ""}`);
    }
    case "bazis_run_script":
      return callBridge("POST", "/scripts/run", params);
    case "bazis_list_library": {
      const q = [];
      if (params.library) q.push(`library=${encodeURIComponent(String(params.library))}`);
      if (params.filter) q.push(`filter=${encodeURIComponent(String(params.filter))}`);
      if (params.dir) q.push(`dir=${encodeURIComponent(String(params.dir))}`);
      if (Array.isArray(params.extensions) && params.extensions.length > 0) {
        q.push(`extensions=${encodeURIComponent(params.extensions.join(","))}`);
      }
      if (params.limit !== undefined) q.push(`limit=${encodeURIComponent(String(params.limit))}`);
      return callBridge("GET", `/library${q.length ? `?${q.join("&")}` : ""}`);
    }
    case "bazis_open_library":
      return callBridge("POST", "/library/open", params);
    case "bazis_save_library":
      return callBridge("POST", "/library/save", params);
    case "bazis_bbb_read":
      return callBridge("POST", "/bbb/read", params);
    case "bazis_bbb_write":
      return callBridge("POST", "/bbb/write", params);
    case "bazis_bxf_to_bbb": {
      const rawPaths = [];
      if (params.bxfFile) rawPaths.push(String(params.bxfFile));
      if (Array.isArray(params.bxfFiles)) {
        for (const p of params.bxfFiles) rawPaths.push(String(p));
      }
      if (rawPaths.length === 0) {
        throw new Error("Provide 'bxfFile' or 'bxfFiles' (path to Blum E-SERVICES .bxf2 file)");
      }
      const parsedList = rawPaths.map((p) => {
        const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
        const resolved = path.resolve(expanded);
        if (!fs.existsSync(resolved)) {
          throw new Error(`BXF2 file not found: ${resolved}`);
        }
        const xml = fs.readFileSync(resolved, "utf8");
        return parseBxf2Xml(xml);
      });
      const mergedBox = mergeBxfSpecs(parsedList, params.name);
      if (params.dryRun) {
        return { ok: true, dryRun: true, parsed: parsedList, mergedBox };
      }
      const writeRes = await callBridge("POST", "/bbb/write", {
        file: params.targetFile || "Blum_EServices.bbb",
        append: params.overwrite ? false : params.append !== false,
        overwrite: params.overwrite === true,
        validateWithBazis: true,
        boxes: [mergedBox],
      });
      return {
        ok: true,
        sourceFiles: rawPaths,
        parsedSummary: parsedList.map((p) => ({
          description: p.description,
          nominalLength: p.nominalLength,
          cabinetInnerWidth: p.cabinetInnerWidth,
          articles: p.articles.map((a) => `${a.articleNumber} (${a.itemNumber})`),
          drillingOffsetsMm: p.absoluteDrillingOffsetsMm,
          groove: p.groove,
        })),
        bbb: writeRes.bbb || writeRes,
      };
    }
    case "bazis_db_info": {
      const q = [];
      if (params.dbPath) q.push(`dbPath=${encodeURIComponent(String(params.dbPath))}`);
      if (params.port) q.push(`port=${encodeURIComponent(String(params.port))}`);
      return callBridge("GET", `/db/info${q.length ? `?${q.join("&")}` : ""}`);
    }
    case "bazis_db_query":
      return callBridge("POST", "/db/query", params);
    case "bazis_db_execute":
      return callBridge("POST", "/db/execute", params);
    case "bazis_delete_object":
      return callBridge("POST", "/object/delete", params);
    case "bazis_transform_object":
      return callBridge("POST", "/object/transform", params);
    case "bazis_check_model":
      return callBridge("POST", "/inspect", params);
    case "bazis_scene_action":
      return callBridge("POST", "/scene", params);
    case "bazis_screenshot":
      return callBridge("POST", "/screenshot", params);
    case "bazis_eval":
      return callBridge("POST", "/eval", params);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  writeMessage({ jsonrpc: "2.0", id, error: err });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    const protocolVersion =
      requested && SUPPORTED_PROTOCOLS.has(requested) ? requested : "2024-11-05";
    sendResult(id, {
      protocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  }

  if (method === "ping") {
    if (!isNotification) sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === "resources/list") {
    sendResult(id, { resources: [] });
    return;
  }

  if (method === "prompts/list") {
    sendResult(id, { prompts: [] });
    return;
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    const toolArgs = params && params.arguments;
    if (!toolName) {
      sendError(id, -32602, "Missing required parameter: name");
      return;
    }
    try {
      const result = await executeTool(toolName, toolArgs);
      if (toolName === "bazis_screenshot" && result && result.screenshot && result.screenshot.base64) {
        const b64 = result.screenshot.base64;
        const meta = Object.assign({}, result.screenshot);
        delete meta.base64;
        sendResult(id, {
          content: [
            {
              type: "image",
              data: b64,
              mimeType: meta.mimeType || "image/png",
            },
            {
              type: "text",
              text: JSON.stringify({ ok: true, screenshot: meta }, null, 2),
            },
          ],
        });
      } else {
        sendResult(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        });
      }
    } catch (err) {
      sendResult(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: err && err.message ? err.message : String(err),
          },
        ],
      });
    }
    return;
  }

  if (!isNotification) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

const cliIdx = process.argv.findIndex((a) => a === "--call" || a === "--eval" || a === "--health");
if (cliIdx !== -1) {
  const flag = process.argv[cliIdx];
  let job;
  if (flag === "--health") {
    job = callBridge("GET", "/health");
  } else if (flag === "--eval") {
    // --eval '<js body>' or --eval @file.js ; optional JSON params as next arg
    let code = process.argv[cliIdx + 1] || "";
    if (code.startsWith("@")) code = fs.readFileSync(code.slice(1), "utf8");
    const p = process.argv[cliIdx + 2];
    job = callBridge("POST", "/eval", { code, params: p ? JSON.parse(p) : {} });
  } else {
    // --call <tool> '<json args>'
    const tool = process.argv[cliIdx + 1];
    const a = process.argv[cliIdx + 2];
    job = executeTool(tool, a ? JSON.parse(a) : {});
  }
  job
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
} else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "").trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        logErr(`Invalid JSON on stdin: ${err.message}`);
        sendError(null, -32700, "Parse error");
        continue;
      }

      handleRequest(msg).catch((err) => {
        logErr(`Unhandled error for ${msg.method}: ${err.stack || err.message}`);
        if (msg.id !== undefined && msg.id !== null) {
          sendError(msg.id, -32603, err.message || "Internal error");
        }
      });
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });
}
