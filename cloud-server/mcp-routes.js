// cloud-server/mcp-routes.js — MCP over HTTP 端点
import { createTask, streamTask } from "./task-manager.js";
import { verifyJwt, userStore, generateLoginCode } from "./auth.js";
import QRCode from "qrcode";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPABILITY_INDEX = JSON.parse(readFileSync(join(__dirname, "..", "huaweicloud-mate", "data", "capability_index.json"), "utf8"));
const { catalog, search_index } = CAPABILITY_INDEX;

// 判断 intent 是否只需要能力查询（不需要调 API）
const CAPABILITY_PATTERNS = [
  /规格|支持什么|有哪些|怎么创建|怎么用|怎么配置|文档|说明|参数|限制|价格|计费|介绍/,
  /how\s|what\s|supported|available|pricing|document/,
  /规格说明|产品介绍|功能列表|操作指南|API文档/,
];
const OPERATION_PATTERNS = [
  /我(的|当前|名下)|查一下|查询|列出|创建|删除|修改|启|停|重启|扩容|缩容/,
  /list\s|create\s|delete\s|modify\s|start\s|stop\s|restart/,
  /账号下|项目中/,
];

function isCapabilityOnly(intent) {
  for (const p of OPERATION_PATTERNS) {
    if (p.test(intent)) return false;
  }
  for (const p of CAPABILITY_PATTERNS) {
    if (p.test(intent)) return true;
  }
  return false;
}

function searchCapabilities(query) {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  const matchedIds = new Set();
  for (const key of Object.keys(search_index)) {
    const kl = key.toLowerCase();
    if (words.some(w => kl.includes(w))) {
      search_index[key].forEach(id => matchedIds.add(id));
    }
  }
  if (matchedIds.size === 0) {
    for (const [id] of Object.entries(catalog)) {
      if (words.some(w => id.includes(w))) matchedIds.add(id);
    }
  }
  return Array.from(matchedIds).slice(0, 10).map(id => {
    const e = catalog[id] || {};
    return { id, summary: e.summary || id, operation: e.executors?.koocli?.operation || "", resource: e.resource || "" };
  });
}

export function mcpRouter(app) {

  // MCP initialize / tools/list
  app.post("/mcp", (req, res, next) => {
    const call = req.body;
    if (!call || !call.method) return next();
    if (call.method === "initialize") {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "Huawei Cloud Agent", version: "2.0.0" },
        },
      });
    }
    if (call.method === "tools/list") {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          tools: [{
            name: "huaweicloud_invoke",
            description:
              "使用自然语言操作华为云资源。支持查询、创建、修改、删除资源。\n" +
              "示例: '查 cn-south-1 的 ECS' / '列出 OBS 桶' / '查看 VPC' / 'ECS 有哪些规格'",
            inputSchema: {
              type: "object",
              properties: {
                intent: { type: "string", description: "华为云操作的自然语言描述" },
              },
              required: ["intent"],
            },
          }],
        },
      });
    }
    if (call.method === "notifications/initialized") {
      return res.json({ jsonrpc: "2.0", id: call.id, result: {} });
    }
    next();
  });

  // tools/call — 单入口，内部路由
  app.post("/mcp", async (req, res) => {
    const call = req.body;

    if (!call || call.method !== "tools/call") {
      return res.status(400).json({ error: "invalid MCP request" });
    }

    const { name, arguments: args } = call.params || {};
    if (name !== "huaweicloud_invoke") {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      });
    }

    const intent = args?.intent || "";
    if (!intent) {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: { content: [{ type: "text", text: "请提供 intent" }], isError: true },
      });
    }

    // 内部判断：能力查询 → 本地搜索，无需鉴权
    if (isCapabilityOnly(intent)) {
      const q = intent.replace(/cn-\w+-\d+|区域|的|吗|么|呢/g, "").trim();
      const results = searchCapabilities(q);
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          content: [{
            type: "text",
            text: results.length > 0
              ? `[能力索引] "${intent}":\n${results.map((r, i) => `${i + 1}. ${r.summary} (${r.operation || r.resource})`).join("\n")}`
              : `未找到 "${intent}" 相关能力，尝试更具体的关键词`,
          }],
        },
      });
    }

    // 资源操作 → JWT 鉴权
    const authHeader = req.headers.authorization || "";
    let userId = null;
    let user = null;
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const payload = verifyJwt(token);
      if (payload) {
        const u = userStore.get(payload.sub);
        if (u) {
          userId = payload.sub;
          user = u;
        }
      }
    }

    if (!userId) {
      const code = generateLoginCode();
      const qrPath = `/tmp/qrcode-login-${code}.png`;
      await QRCode.toFile(qrPath, `http://127.0.0.1:3000/auth/confirm/${code}`, { type: "png", width: 400, margin: 2 });
      const qrUrl = `http://127.0.0.1:3000/auth/qr/${code}.png`;
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              type: "AUTH_REQUIRED",
              code,
              qrImage: qrUrl,
              message: `扫码或粘贴确认码 ${code} 到聊天框完成登录，有效期 30 秒`
            }),
          }],
        },
      });
    }

    try {
      const task = await createTask(userId, intent, { source: "mcp" }, user);

      const text = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("任务超时"));
        }, 300000);

        const unsubscribe = streamTask(task.id, (event) => {
          if (event.status === "completed") {
            clearTimeout(timeout);
            unsubscribe();
            resolve(task.output || event.message || "任务完成");
          } else if (event.status === "failed") {
            clearTimeout(timeout);
            unsubscribe();
            reject(new Error(event.error || "任务失败"));
          }
        });
      });

      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: { content: [{ type: "text", text }] },
      });
    } catch (err) {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
      });
    }
  });
}
