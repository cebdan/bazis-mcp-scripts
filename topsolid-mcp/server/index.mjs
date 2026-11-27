#!/usr/bin/env node
// Zero-dependency MCP server entrypoint for TopSolid 6.xx.
// Modes:
//   (default)                  : stdio MCP server via local/shared .ts6-ipc folder
//   --http                     : Streamable HTTP MCP gateway on Windows (0.0.0.0:8765)
//   --remote <url> [--token t] : stdio -> remote Streamable HTTP proxy
//   --health / --info / --check-updates : one-shot diagnostics (local IPC or --remote)

import { ipcCall, handleRpc } from "./core.mjs";
import { startHttpServer } from "./http.mjs";

const args = process.argv.slice(2);

function getFlagValue(flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

const isHttp = args.includes("--http");
const remoteUrl = getFlagValue("--remote") || process.env.TS6_REMOTE_URL || null;
const remoteToken = getFlagValue("--token") || process.env.TS6_HTTP_TOKEN || "";

async function postRemoteRpc(url, token, payload) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (res.status === 202) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return text ? JSON.parse(text) : null;
}

async function runOneShot(cmdName) {
  if (remoteUrl) {
    const reply = await postRemoteRpc(remoteUrl, remoteToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: `ts6_${cmdName}`, arguments: {} },
    });
    if (reply?.error) throw new Error(reply.error.message || JSON.stringify(reply.error));
    const txt = reply?.result?.content?.find((c) => c.type === "text")?.text;
    if (reply?.result?.isError) throw new Error(txt || "Remote tool error");
    console.log(txt || JSON.stringify(reply?.result, null, 2));
    return;
  }
  const r = await ipcCall(cmdName, {});
  console.log(JSON.stringify(r, null, 2));
}

if (isHttp) {
  const host = getFlagValue("--host") || undefined;
  const port = getFlagValue("--port") ? Number(getFlagValue("--port")) : undefined;
  const ipcDir = getFlagValue("--ipc-dir") || undefined;
  startHttpServer({ host, port, ipcDir });
} else if (args.includes("--health")) {
  runOneShot("health").then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
} else if (args.includes("--info")) {
  runOneShot("bridge_info").then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
} else if (args.includes("--check-updates")) {
  runOneShot("check_updates").then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
} else if (remoteUrl) {
  // stdio -> HTTP proxy mode
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
      try {
        const reply = await postRemoteRpc(remoteUrl, remoteToken, msg);
        if (reply !== null) {
          process.stdout.write(JSON.stringify(reply) + "\n");
        }
      } catch (err) {
        if (msg && msg.id !== undefined) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: String(err?.message || err) },
          }) + "\n");
        }
      }
    }
  });
} else {
  // Local stdio MCP mode (backwards-compatible)
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
      const reply = await handleRpc(msg);
      if (reply !== null) {
        process.stdout.write(JSON.stringify(reply) + "\n");
      }
    }
  });
}
