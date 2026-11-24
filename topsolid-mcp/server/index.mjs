#!/usr/bin/env node
// Zero-dependency MCP stdio server for TopSolid'Wood 6.25 (COM Automation via Shared-Folder IPC).
// Works on macOS (synced via MEGA) or Windows.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const IPC_DIR = process.env.TS6_IPC_DIR || path.join(REPO_ROOT, ".ts6-ipc");
const TIMEOUT_MS = Number(process.env.TS6_TIMEOUT_MS || 30000);

const TOOLS = [
  {
    name: "ts6_health",
    description: "Check live COM connection to TopSolid'Wood 6.25, version, open document count, and active document name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_list_templates",
    description: "List available TopSolid'Wood 6.25 .top process templates in TopSolid_Templates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_new_doc",
    description: "Create a new empty TopSolid 6.25 design document (.top).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_list_elements",
    description: "List all shapes (panels, designations, layers, operation counts) and inserted components in the active TopSolid 6.25 document.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ts6_create_block",
    description: "Create a native Parasolid rectangular panel (AddBasicBlock) in the active TopSolid 6.25 document (coordinates and dimensions in mm).",
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
    description: "Insert a TopSolid'Wood 6.25 .top process component (Drilling, Groove, Pocket, Rabbet, Moulding) at a 3D coordinate system (in mm).",
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
    description: "Bring TopSolid 6.25 (top625) window to foreground and return its screen bounding box (left, top, width, height).",
    inputSchema: {
      type: "object",
      properties: {
        process: { type: "string", description: "Process name (default 'top625')." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ts6_screenshot",
    description: "Capture a PNG screenshot of the Windows screen or TopSolid 6.25 window and return it as image/png plus pixel bounds.",
    inputSchema: {
      type: "object",
      properties: {
        windowOnly: { type: "boolean", description: "Capture only the TopSolid 6.25 window instead of the full screen." },
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

function ipcCall(cmd, params) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(IPC_DIR)) fs.mkdirSync(IPC_DIR, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const reqTmp = path.join(IPC_DIR, `req-${id}.tmp`);
    const reqFinal = path.join(IPC_DIR, `req-${id}.json`);
    const resFinal = path.join(IPC_DIR, `res-${id}.json`);
    fs.writeFileSync(reqTmp, JSON.stringify({ id, cmd, params: params || {} }), "utf8");
    fs.renameSync(reqTmp, reqFinal);
    const start = Date.now();
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
      } else if (Date.now() - start > TIMEOUT_MS) {
        clearInterval(timer);
        try { fs.unlinkSync(reqFinal); } catch {}
        reject(new Error(`TopSolid 6 bridge timeout (${TIMEOUT_MS}ms). Make sure Start_TopSolid6_Bridge.bat is running on Windows.`));
      }
    }, 30);
  });
}

if (process.argv.includes("--health")) {
  ipcCall("health", {})
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
} else {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const { id, method, params } = msg;
      if (method === "initialize") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "topsolid-mcp", version: "0.1.0" },
          },
        }) + "\n");
      } else if (method === "tools/list") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: TOOLS } }) + "\n");
      } else if (method === "tools/call") {
        const name = params?.name || "";
        const cmd = name.replace(/^ts6_/, "");
        try {
          const res = await ipcCall(cmd, params?.arguments || {});
          const content = [];
          if (cmd === "screenshot" && res?.base64) {
            const { base64, ...meta } = res;
            content.push({ type: "image", data: base64, mimeType: "image/png" });
            content.push({ type: "text", text: JSON.stringify(meta, null, 2) });
          } else {
            content.push({ type: "text", text: JSON.stringify(res, null, 2) });
          }
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { content },
          }) + "\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { isError: true, content: [{ type: "text", text: String(err.message || err) }] },
          }) + "\n");
        }
      } else if (id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
      }
    }
  });
}
