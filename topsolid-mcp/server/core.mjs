// Shared zero-dependency MCP core for TopSolid 6.xx (used by both stdio and Streamable HTTP transports).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_IPC_DIR = process.env.TS6_IPC_DIR || path.join(REPO_ROOT, ".ts6-ipc");
export const DEFAULT_TIMEOUT_MS = Number(process.env.TS6_TIMEOUT_MS || 30000);
export const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

let _version = "0.3.0";
try {
  const vMeta = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "version.json"), "utf8"));
  if (vMeta?.version) _version = String(vMeta.version);
} catch {}
export const SERVER_VERSION = _version;

export const TOOLS = [
  {
    name: "ts6_health",
    description: "Check live COM connection to TopSolid, version, open document count, and active document name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_bridge_info",
    description: "Get TopSolid MCP bridge version, PID, uptime, request/error counters, Windows service & Start Menu installation status, paths, and last GitHub update check.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_check_updates",
    description: "Check GitHub for newer versions or commits of topsolid-mcp and compare against the running bridge version.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_list_templates",
    description: "List available TopSolid .top process templates in TopSolid_Templates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_new_doc",
    description: "Create a new empty TopSolid design document (.top).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_list_elements",
    description: "List all shapes (panels, designations, layers, operation counts) and inserted components in the active TopSolid document.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_create_block",
    description: "Create a native Parasolid rectangular panel (AddBasicBlock) in the active TopSolid document (coordinates and dimensions in mm).",
    inputSchema: {
      type: "object",
      properties: {
        cx: { type: "number" }, cy: { type: "number" }, cz: { type: "number" },
        lx: { type: "number" }, ly: { type: "number" }, lz: { type: "number" },
        xx: { type: "number" }, xy: { type: "number" }, xz: { type: "number" },
        yx: { type: "number" }, yy: { type: "number" }, yz: { type: "number" },
        name: { type: "string" }, designation: { type: "string" },
        reference: { type: "string" }, layer: { type: "integer" },
      },
      required: ["cx", "cy", "cz", "lx", "ly", "lz"],
      additionalProperties: false,
    },
  },
  {
    name: "ts6_insert_component",
    description: "Insert a TopSolid .top process component (Drilling, Groove, Pocket, Rabbet, Moulding) at a 3D coordinate system (in mm).",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Template filename in TopSolid_Templates or full Windows path to .top" },
        origin: { type: "string", description: "Optional origin coordinate system name inside the template" },
        ox: { type: "number" }, oy: { type: "number" }, oz: { type: "number" },
        xx: { type: "number" }, xy: { type: "number" }, xz: { type: "number" },
        yx: { type: "number" }, yy: { type: "number" }, yz: { type: "number" },
      },
      required: ["file", "ox", "oy", "oz"],
      additionalProperties: false,
    },
  },
  {
    name: "ts6_eval_vbs",
    description: "Run a VBScript snippet against live TopSolid.Application (app) and CurrentDocument (doc).",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        timeoutMs: { type: "integer" },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "ts6_focus_window",
    description: "Bring the TopSolid window to foreground and return its screen bounding box (left, top, width, height).",
    inputSchema: {
      type: "object",
      properties: {
        process: { type: "string", description: "Optional process name (auto-detects running TopSolid if omitted)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ts6_screenshot",
    description: "Capture a PNG screenshot of the Windows screen or TopSolid window and return it as image/png plus pixel bounds.",
    inputSchema: {
      type: "object",
      properties: {
        windowOnly: { type: "boolean", description: "Capture only the TopSolid window instead of the full screen." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ts6_mouse_click",
    description: "Move cursor to screen pixel (x, y) and click (left, right, double, or move/hover).",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "double", "move"] },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "ts6_send_keys",
    description: "Send keyboard input or hotkeys using Windows SendKeys syntax (e.g. '^s' for Ctrl+S, '{ENTER}', '{ESC}', '%a' for Alt+A).",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "string" },
      },
      required: ["keys"],
      additionalProperties: false,
    },
  },
];

export function ipcCall(cmd, params = {}, opts = {}) {
  const ipcDir = opts.ipcDir || DEFAULT_IPC_DIR;
  let timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (cmd === "eval_vbs" && params && Number(params.timeoutMs) > 0) {
    timeoutMs = Math.max(timeoutMs, Number(params.timeoutMs) + 5000);
  }
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(ipcDir)) fs.mkdirSync(ipcDir, { recursive: true });
    const ts = Date.now();
    const deadline = ts + timeoutMs;
    const id = `${ts}-${Math.random().toString(16).slice(2, 8)}`;
    const reqTmp = path.join(ipcDir, `req-${id}.tmp`);
    const reqFinal = path.join(ipcDir, `req-${id}.json`);
    const resFinal = path.join(ipcDir, `res-${id}.json`);
    fs.writeFileSync(
      reqTmp,
      JSON.stringify({ id, cmd, params: params || {}, ts, deadline }),
      "utf8"
    );
    fs.renameSync(reqTmp, reqFinal);
    const timer = setInterval(() => {
      if (fs.existsSync(resFinal)) {
        clearInterval(timer);
        try {
          const data = JSON.parse(fs.readFileSync(resFinal, "utf8"));
          try { fs.unlinkSync(resFinal); } catch {}
          if (data.ok) resolve(data.result);
          else reject(new Error(data.error || "TopSolid bridge error"));
        } catch (err) {
          reject(err);
        }
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        try { fs.unlinkSync(reqFinal); } catch {}
        reject(new Error(`TopSolid MCP bridge timeout (${timeoutMs}ms). Make sure TopSolid MCP Bridge is running on Windows.`));
      }
    }, 30);
  });
}

export function negotiateProtocolVersion(requested) {
  if (requested && SUPPORTED_PROTOCOL_VERSIONS.includes(String(requested))) {
    return String(requested);
  }
  return "2025-06-18";
}

export async function handleRpc(msg, opts = {}) {
  if (!msg || typeof msg !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const { id, method, params } = msg;

  // Notifications (or client responses without method) produce no JSON-RPC reply
  if (!method || (typeof method === "string" && method.startsWith("notifications/"))) {
    return null;
  }
  if (id === undefined) {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: "topsolid-mcp", version: SERVER_VERSION },
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const name = params?.name || "";
    const cmd = name.replace(/^ts6_/, "");
    try {
      const res = await ipcCall(cmd, params?.arguments || {}, opts);
      const content = [];
      if (cmd === "screenshot" && res?.base64) {
        const { base64, ...meta } = res;
        content.push({ type: "image", data: base64, mimeType: "image/png" });
        content.push({ type: "text", text: JSON.stringify(meta, null, 2) });
      } else {
        content.push({ type: "text", text: JSON.stringify(res, null, 2) });
      }
      return { jsonrpc: "2.0", id, result: { content } };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: String(err?.message || err) }],
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}
