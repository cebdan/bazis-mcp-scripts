// TopSolid'Wood 6.25 COM Bridge (runs on Windows via Node.js, independent of Bazis)
// Watches <repo>/.ts6-ipc/ for atomic JSON request files and executes COM commands
// against TopSolid.Application via cscript.exe (isolated per request so TopSolid dialogs
// never freeze the bridge).

const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const IPC_DIR = process.env.TS6_IPC_DIR || path.join(REPO_ROOT, ".ts6-ipc");
const TEMPLATES_DIR = process.env.TS6_TEMPLATES_DIR || "Y:\\Works\\bazis\\TopSolid_Templates";
const POLL_MS = 100;

if (!fs.existsSync(IPC_DIR)) fs.mkdirSync(IPC_DIR, { recursive: true });

function vbsStr(s) {
  return '"' + String(s || "").replace(/"/g, '""').replace(/[\r\n]+/g, " ") + '"';
}
function fmt(n) {
  if (Math.abs(Number(n) || 0) < 1e-9) return "0";
  return Number(n).toFixed(6).replace(/\.?0+$/, "");
}

function runVbs(vbsCode, timeoutMs) {
  const tmpFile = path.join(os.tmpdir(), `ts6_mcp_${Date.now()}_${Math.random().toString(16).slice(2, 6)}.vbs`);
  fs.writeFileSync(tmpFile, vbsCode, "utf8");
  try {
    const out = cp.execSync(`cscript //Nologo "${tmpFile}"`, {
      encoding: "utf8",
      timeout: timeoutMs || 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return out.trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function handleCommand(cmd, params) {
  const p = params || {};

  if (cmd === "health") {
    const out = runVbs([
      "On Error Resume Next",
      'Set app = CreateObject("TopSolid.Application")',
      "If Err.Number <> 0 Or app Is Nothing Then",
      '  WScript.Echo "ERR|" & Err.Description',
      "  WScript.Quit 0",
      "End If",
      'Dim dname : dname = ""',
      "If app.Documents.Count > 0 Then dname = app.CurrentDocument.Name",
      'WScript.Echo "OK|" & app.Version & "|" & app.Documents.Count & "|" & dname'
    ].join("\r\n"), 10000);
    const parts = out.split("|");
    if (parts[0] !== "OK") throw new Error(parts.slice(1).join("|") || out);
    return {
      ok: true,
      version: parts[1],
      docCount: Number(parts[2] || 0),
      currentDoc: parts[3] || "",
      templatesDir: TEMPLATES_DIR,
    };
  }

  if (cmd === "list_templates") {
    const exists = fs.existsSync(TEMPLATES_DIR);
    const files = exists
      ? fs.readdirSync(TEMPLATES_DIR).filter((f) => f.toLowerCase().endsWith(".top"))
      : [];
    return { ok: true, dir: TEMPLATES_DIR, exists, templates: files };
  }

  if (cmd === "new_doc") {
    const out = runVbs([
      "On Error Resume Next",
      'Set app = CreateObject("TopSolid.Application")',
      'Set doc = app.Documents.Add("top")',
      'If Err.Number <> 0 Then WScript.Echo "ERR|" & Err.Description Else WScript.Echo "OK|" & doc.Name'
    ].join("\r\n"), 15000);
    const parts = out.split("|");
    if (parts[0] !== "OK") throw new Error(parts.slice(1).join("|") || out);
    return { ok: true, name: parts[1] || "" };
  }

  if (cmd === "list_elements") {
    const out = runVbs([
      "On Error Resume Next",
      'Set app = CreateObject("TopSolid.Application")',
      "If app.Documents.Count = 0 Then",
      '  WScript.Echo "EMPTY"',
      "  WScript.Quit 0",
      "End If",
      "Set doc = app.CurrentDocument",
      "Dim i, sh, cmp",
      "For i = 1 To doc.Shapes.Count",
      "  Set sh = doc.Shapes.Item(i)",
      '  WScript.Echo "SHAPE|" & sh.Name & "|" & sh.Designation & "|" & sh.Reference & "|" & sh.Layer & "|" & sh.Operations.Count',
      "Next",
      "For i = 1 To doc.Components.Count",
      "  Set cmp = doc.Components.Item(i)",
      '  WScript.Echo "COMP|" & cmp.Element.Name & "|" & cmp.Element.Designation & "|" & cmp.Code',
      "Next"
    ].join("\r\n"), 15000);
    if (out === "EMPTY" || !out) return { ok: true, shapes: [], components: [] };
    const shapes = [], components = [];
    for (const line of out.split(/\r?\n/)) {
      const a = line.split("|");
      if (a[0] === "SHAPE") {
        shapes.push({ name: a[1], designation: a[2], reference: a[3], layer: Number(a[4] || 0), opsCount: Number(a[5] || 0) });
      } else if (a[0] === "COMP") {
        components.push({ name: a[1], designation: a[2], code: a[3] });
      }
    }
    return { ok: true, shapes, components };
  }

  if (cmd === "create_block") {
    const cx = (Number(p.cx) || 0) * 0.001;
    const cy = (Number(p.cy) || 0) * 0.001;
    const cz = (Number(p.cz) || 0) * 0.001;
    const lx = (Number(p.lx) || 100) * 0.001;
    const ly = (Number(p.ly) || 100) * 0.001;
    const lz = (Number(p.lz) || 18) * 0.001;
    const vbs = [
      "On Error Resume Next",
      'Set app = CreateObject("TopSolid.Application")',
      "Set doc = app.CurrentDocument",
      'If doc Is Nothing Then Set doc = app.Documents.Add("top")',
      `Set blk = doc.Shapes.AddBasicBlock(${fmt(cx)}, ${fmt(cy)}, ${fmt(cz)}, ${fmt(p.xx ?? 1)}, ${fmt(p.xy ?? 0)}, ${fmt(p.xz ?? 0)}, ${fmt(p.yx ?? 0)}, ${fmt(p.yy ?? 1)}, ${fmt(p.yz ?? 0)}, ${fmt(lx)}, ${fmt(ly)}, ${fmt(lz)})`,
      'If Err.Number <> 0 Or blk Is Nothing Then WScript.Echo "ERR|" & Err.Description : WScript.Quit 0',
      p.name ? `blk.Name = ${vbsStr(p.name)}` : "",
      p.designation ? `blk.Designation = ${vbsStr(p.designation)}` : "",
      p.reference ? `blk.Reference = ${vbsStr(p.reference)}` : "",
      p.layer ? `blk.Layer = ${Number(p.layer)}` : "",
      'WScript.Echo "OK|" & blk.Name'
    ].filter(Boolean).join("\r\n");
    const out = runVbs(vbs, 15000);
    const parts = out.split("|");
    if (parts[0] !== "OK") throw new Error(parts.slice(1).join("|") || out);
    return { ok: true, name: parts[1] };
  }

  if (cmd === "insert_component") {
    if (!p.file) throw new Error("Provide 'file' (full path or template name in TopSolid_Templates)");
    const fullPath = path.isAbsolute(p.file) ? p.file : path.join(TEMPLATES_DIR, p.file);
    const ox = (Number(p.ox) || 0) * 0.001;
    const oy = (Number(p.oy) || 0) * 0.001;
    const oz = (Number(p.oz) || 0) * 0.001;
    const vbs = [
      "On Error Resume Next",
      'Set app = CreateObject("TopSolid.Application")',
      "Set doc = app.CurrentDocument",
      'If doc Is Nothing Then WScript.Echo "ERR|No active document" : WScript.Quit 0',
      `Set cs = doc.CoordinateSystems.AddBasic(${fmt(ox)}, ${fmt(oy)}, ${fmt(oz)}, ${fmt(p.xx ?? 1)}, ${fmt(p.xy ?? 0)}, ${fmt(p.xz ?? 0)}, ${fmt(p.yx ?? 0)}, ${fmt(p.yy ?? 1)}, ${fmt(p.yz ?? 0)})`,
      `Set cmp = doc.Components.AddWithPositioningByCoordinateSystems(${vbsStr(fullPath)}, ${vbsStr(p.origin || "")}, cs)`,
      'If Err.Number <> 0 Or cmp Is Nothing Then WScript.Echo "ERR|" & Err.Description Else WScript.Echo "OK|" & cmp.Element.Name'
    ].join("\r\n");
    const out = runVbs(vbs, 20000);
    const parts = out.split("|");
    if (parts[0] !== "OK") throw new Error(parts.slice(1).join("|") || out);
    return { ok: true, component: parts[1], file: fullPath };
  }

  if (cmd === "eval_vbs") {
    if (!p.code) throw new Error("Provide 'code' (VBScript snippet using app and doc)");
    const vbs = [
      "On Error Resume Next",
      'Set app = CreateObject("TopSolid.Application")',
      "Dim doc : Set doc = Nothing",
      "If app.Documents.Count > 0 Then Set doc = app.CurrentDocument",
      String(p.code),
      'If Err.Number <> 0 Then WScript.Echo "VBS_ERR|" & Err.Number & "|" & Err.Description'
    ].join("\r\n");
    const out = runVbs(vbs, Number(p.timeoutMs) || 30000);
    return { ok: true, output: out };
  }

  throw new Error("Unknown TopSolid 6 command: " + cmd);
}

function poll() {
  try {
    const files = fs.readdirSync(IPC_DIR).filter((f) => f.startsWith("req-") && f.endsWith(".json"));
    for (const f of files) {
      const reqPath = path.join(IPC_DIR, f);
      const id = f.slice(4, -5);
      const resTmp = path.join(IPC_DIR, `res-${id}.tmp`);
      const resFinal = path.join(IPC_DIR, `res-${id}.json`);
      let payload;
      try {
        const req = JSON.parse(fs.readFileSync(reqPath, "utf8"));
        try { fs.unlinkSync(reqPath); } catch {}
        const result = handleCommand(req.cmd, req.params);
        payload = { id, ok: true, result };
      } catch (err) {
        try { fs.unlinkSync(reqPath); } catch {}
        payload = { id, ok: false, error: String(err && err.message ? err.message : err) };
      }
      fs.writeFileSync(resTmp, JSON.stringify(payload), "utf8");
      fs.renameSync(resTmp, resFinal);
    }
  } catch (err) {
    console.error("[ts6-bridge] poll error:", err.message);
  }
}

console.log("[ts6-bridge] TopSolid 6.25 COM bridge started.");
console.log("[ts6-bridge] IPC dir: " + IPC_DIR);
console.log("[ts6-bridge] Templates dir: " + TEMPLATES_DIR);
setInterval(poll, POLL_MS);
