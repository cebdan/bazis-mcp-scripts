// Zero-dependency MCP Streamable HTTP gateway (2025-03-26 / 2025-06-18, non-SSE stateless mode)
// Runs on Windows alongside ts6_bridge.ps1 and communicates via local .ts6-ipc folder.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { handleRpc, SERVER_VERSION, DEFAULT_IPC_DIR } from "./core.mjs";

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export const DEFAULT_ALLOW_FROM = [
  "127.0.0.1",
  "::1",
  "10.211.55.0/24",
  "10.37.129.0/24",
  "192.168.0.0/16",
  "10.0.0.0/8",
  "172.16.0.0/12",
];

function getDefaultConfigPath() {
  if (process.env.TS6_CONFIG_PATH) return process.env.TS6_CONFIG_PATH;
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "TopSolid6MCP", "config.json");
  }
  return path.join(os.homedir(), ".config", "TopSolid6MCP", "config.json");
}

function getDefaultLogPath() {
  if (process.env.TS6_LOG_PATH) return process.env.TS6_LOG_PATH;
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "TopSolid6MCP", "bridge.log");
  }
  return null;
}

function loadConfigFile(cfgPath) {
  try {
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, "utf8")) || {};
    }
  } catch {}
  return {};
}

function saveConfigFile(cfgPath, cfg) {
  try {
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch {}
}

function resolveOrGenerateToken(cfgPath, cfg) {
  if (process.env.TS6_HTTP_TOKEN && process.env.TS6_HTTP_TOKEN.trim()) {
    return { token: process.env.TS6_HTTP_TOKEN.trim(), generated: false };
  }
  if (cfg.httpToken && String(cfg.httpToken).trim()) {
    return { token: String(cfg.httpToken).trim(), generated: false };
  }
  const token = crypto.randomBytes(32).toString("base64url");
  cfg.httpToken = token;
  saveConfigFile(cfgPath, cfg);
  return { token, generated: true };
}

function parseIpv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let val = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    val = ((val << 8) | n) >>> 0;
  }
  return val;
}

function normalizeRemoteIp(rawIp) {
  const s = String(rawIp || "").trim();
  if (s.startsWith("::ffff:")) return s.slice(7);
  return s;
}

function ipMatchesRule(ip, rule) {
  const r = String(rule || "").trim();
  if (!r) return false;
  if (r === "*" || r === "0.0.0.0/0") return true;
  if (ip === r) return true;
  if (r.includes("/")) {
    const [netStr, prefixStr] = r.split("/");
    const prefix = Number(prefixStr);
    const ipNum = parseIpv4(ip);
    const netNum = parseIpv4(netStr);
    if (ipNum !== null && netNum !== null && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
      const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
      return (ipNum & mask) === (netNum & mask);
    }
  }
  return false;
}

function isIpAllowed(rawIp, allowList) {
  const ip = normalizeRemoteIp(rawIp);
  if (!ip) return false;
  for (const rule of allowList) {
    if (ipMatchesRule(ip, rule)) return true;
  }
  return false;
}

function isOriginAllowed(originHeader) {
  if (!originHeader) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(originHeader).trim());
}

function checkBearerToken(authHeader, expectedToken) {
  if (!authHeader || typeof authHeader !== "string") return false;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const provided = Buffer.from(m[1].trim(), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > limitBytes) {
        aborted = true;
        reject(Object.assign(new Error("Payload Too Large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        reject(Object.assign(new Error("Empty request body"), { statusCode: 400 }));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
      }
    });
    req.on("error", (err) => {
      if (!aborted) reject(err);
    });
  });
}

function writeLogLine(logPath, line) {
  process.stdout.write(line + "\n");
  if (logPath) {
    try {
      fs.appendFileSync(logPath, line + "\r\n", "utf8");
    } catch {}
  }
}

export function startHttpServer(cliOpts = {}) {
  const cfgPath = getDefaultConfigPath();
  const cfg = loadConfigFile(cfgPath);
  const logPath = getDefaultLogPath();

  const host = cliOpts.host || process.env.TS6_HTTP_HOST || cfg.httpHost || "0.0.0.0";
  const port = Number(cliOpts.port || process.env.TS6_HTTP_PORT || cfg.httpPort || 8765);
  const ipcDir = cliOpts.ipcDir || process.env.TS6_IPC_DIR || cfg.ipcDir || DEFAULT_IPC_DIR;

  let allowFrom = DEFAULT_ALLOW_FROM;
  if (process.env.TS6_HTTP_ALLOW_FROM) {
    allowFrom = process.env.TS6_HTTP_ALLOW_FROM.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(cfg.httpAllowFrom) && cfg.httpAllowFrom.length > 0) {
    allowFrom = cfg.httpAllowFrom.map((s) => String(s).trim()).filter(Boolean);
  }

  const { token, generated } = resolveOrGenerateToken(cfgPath, cfg);

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const remoteIp = normalizeRemoteIp(req.socket?.remoteAddress);
    const urlPath = (req.url || "/").split("?")[0];

    const finishLog = (rpcMethod, toolName, statusLabel) => {
      const ts = new Date().toTimeString().slice(0, 8);
      const ms = Date.now() - t0;
      const tPart = toolName ? ` ${toolName}` : "";
      writeLogLine(logPath, `[${ts}] [HTTP] ${remoteIp} ${req.method} ${urlPath} ${rpcMethod || "-"}${tPart} ${ms}ms ${statusLabel}`);
    };

    // 1. IP allowlist check
    if (!isIpAllowed(remoteIp, allowFrom)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden IP" }));
      finishLog("-", "", "403-ip");
      return;
    }

    // 2. Origin check (DNS rebinding guard)
    if (!isOriginAllowed(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden Origin" }));
      finishLog("-", "", "403-origin");
      return;
    }

    // 3. Unauthenticated healthz endpoint
    if (req.method === "GET" && urlPath === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: SERVER_VERSION }));
      return;
    }

    if (urlPath !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    // 4. GET /mcp -> 405 (non-SSE stateless mode)
    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST, DELETE" });
      res.end();
      finishLog("GET", "", "405");
      return;
    }

    // 5. Bearer auth required for /mcp
    if (!checkBearerToken(req.headers.authorization, token)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer realm=\"topsolid-mcp\"",
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      finishLog("-", "", "401");
      return;
    }

    // 6. DELETE /mcp -> 200 (stateless session close)
    if (req.method === "DELETE") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      finishLog("DELETE", "", "200");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, DELETE" });
      res.end();
      return;
    }

    // 7. POST /mcp (single JSON-RPC object or batch array)
    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (err) {
      const code = err.statusCode || 400;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: err.message || "Parse error" },
      }));
      finishLog("parse", "", `err-${code}`);
      return;
    }

    const isBatch = Array.isArray(body);
    const items = isBatch ? body : [body];
    if (isBatch && items.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Empty batch" },
      }));
      finishLog("batch", "", "400");
      return;
    }

    let hasInit = false;
    let firstMethod = "";
    let firstTool = "";
    let anyErr = false;
    const replies = [];

    for (const item of items) {
      if (item && typeof item === "object") {
        if (!firstMethod && item.method) firstMethod = String(item.method);
        if (!firstTool && item.method === "tools/call" && item.params?.name) {
          firstTool = String(item.params.name);
        }
        if (item.method === "initialize") hasInit = true;
      }
      const reply = await handleRpc(item, { ipcDir });
      if (reply !== null) {
        if (reply.error || reply.result?.isError) anyErr = true;
        replies.push(reply);
      }
    }

    if (replies.length === 0) {
      res.writeHead(202);
      res.end();
      finishLog(firstMethod || "notify", firstTool, "202");
      return;
    }

    const headers = { "Content-Type": "application/json" };
    if (hasInit) {
      headers["Mcp-Session-Id"] = crypto.randomUUID();
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(isBatch ? replies : replies[0]));
    finishLog(firstMethod || "rpc", firstTool, anyErr ? "err" : "ok");
  });

  server.listen(port, host, () => {
    const ts = new Date().toTimeString().slice(0, 8);
    writeLogLine(
      logPath,
      `[${ts}] [HTTP] TopSolid MCP Streamable HTTP v${SERVER_VERSION} listening on http://${host}:${port}/mcp (IPC=${ipcDir})`
    );
    if (generated) {
      process.stdout.write(`[HTTP] Generated new Bearer token (saved to ${cfgPath}): ${token}\n`);
    }
  });

  server.on("error", (err) => {
    const ts = new Date().toTimeString().slice(0, 8);
    writeLogLine(logPath, `[${ts}] [HTTP] Server error: ${err.message}`);
    process.exit(1);
  });

  return server;
}
