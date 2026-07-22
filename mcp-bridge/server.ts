#!/usr/bin/env node
/**
 * MCP Bridge — 端口 3001 前置代理
 *
 * 对外暴露 MCP 协议 + 转发其他请求到 OpenCode Server
 * 每个 huaweicloud_invoke 请求创建独立 session，不复用
 */
import { createServer, request as httpRequest } from "http";
import type { IncomingMessage, ServerResponse } from "http";

const BACKEND = process.env.BACKEND || "http://127.0.0.1:3005";
const PORT = parseInt(process.env.PORT || "3001", 10);

function proxy(req: IncomingMessage, res: ServerResponse, body?: string) {
  const backendUrl = new URL(BACKEND);
  const opts = {
    hostname: backendUrl.hostname,
    port: backendUrl.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${backendUrl.hostname}:${backendUrl.port}` },
  };
  delete (opts.headers as any)["mcp-session-id"];

  const proxyReq = httpRequest(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => {
    res.writeHead(502);
    res.end("Backend unavailable");
  });
  if (body !== undefined) {
    proxyReq.write(body);
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
  }
}

async function invokeAgent(intent: string): Promise<string> {
  const sResp = await fetch(`${BACKEND}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!sResp.ok) throw new Error(`Failed to create session: HTTP ${sResp.status}`);
  const session = await sResp.json() as any;
  const sessionId = session.id as string;
  process.stderr.write(`[bridge] session: ${sessionId}\n`);

  const mResp = await fetch(`${BACKEND}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: intent }] }),
  });
  if (!mResp.ok) throw new Error(`Agent ${mResp.status}: ${(await mResp.text()).slice(0, 200)}`);

  const data = await mResp.json() as any;
  if (data.parts) {
    const texts = data.parts.filter((p: any) => p.type === "text").map((p: any) => p.text);
    if (texts.length > 0) return texts.join("\n");
    const reasonings = data.parts.filter((p: any) => p.type === "reasoning").map((p: any) => p.text);
    if (reasonings.length > 0) return "[thinking] " + reasonings[reasonings.length - 1].slice(-500);
  }
  return JSON.stringify(data, null, 2);
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", backend: BACKEND }));
    return;
  }

  if (req.method === "POST" && req.url === "/mcp") {
    const body = await new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c: Buffer) => { b += c.toString(); });
      req.on("end", () => resolve(b));
    });

    let call: any = null;
    try { call = JSON.parse(body); } catch {}

    if (call?.method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "bridge-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "华为云Agent", version: "2.0.0" } } }));
      return;
    }

    if (call?.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { tools: [{ name: "huaweicloud_invoke", description: "使用自然语言操作华为云资源。六执行通道覆盖全部场景。\n查询 → MCP │ 批量 → KooCLI │ 编程 → SDK │ 编排 → Terraform\n示例: \"查询 cn-north-4 的 ECS\" / \"创建一个 OBS 桶\" / \"配置 VPC + 三台 ECS + 安全组\"", inputSchema: { type: "object", properties: { intent: { type: "string", description: "华为云操作的自然语言描述" } }, required: ["intent"] } }] } }));
      return;
    }

    if (call?.method === "tools/call") {
      const { name, arguments: args } = call.params || {};
      if (name === "huaweicloud_invoke") {
        const intent = args?.intent || "";
        process.stderr.write(`[bridge] intent: ${intent}\n`);
        try {
          const text = await invokeAgent(intent);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text }] } }));
        } catch (err: any) {
          process.stderr.write(`[bridge] error: ${err.message}\n`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } }));
        }
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `Unknown tool: ${name}` } }));
      return;
    }

    if (call?.method === "notifications/initialized") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: {} }));
      return;
    }

    proxy(req, res, body);
    return;
  }

  proxy(req, res);
});

process.on("uncaughtException", (e) => process.stderr.write(`[bridge] crash: ${e.message}\n`));
process.on("unhandledRejection", (e: any) => process.stderr.write(`[bridge] reject: ${e?.message || e}\n`));

server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`[bridge] :${PORT} → ${BACKEND}\n`);
});
