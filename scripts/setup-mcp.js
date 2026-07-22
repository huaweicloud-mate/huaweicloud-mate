// scripts/setup-mcp.js
import { decryptEnv } from "./crypto.js";
import { signRequest } from "./huawei-client.js";

const creds = decryptEnv(process.cwd());
const API_BASE = creds.API_BASE || "http://localhost:3000";

async function main() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const url = `${API_BASE}/auth`;
  const headers = { "Content-Type": "application/json", "X-HW-Timestamp": timestamp, "Host": new URL(url).host };
  const bodyStr = JSON.stringify({ userId: creds.HUAWEI_AK });

  const { authorization } = signRequest(creds.HUAWEI_AK, creds.HUAWEI_SK, creds.HUAWEI_REGION || "cn-north-4", "codex-agent", "POST", new URL(url).pathname, "", headers, bodyStr);
  headers["Authorization"] = authorization;

  const resp = await fetch(url, { method: "POST", headers, body: bodyStr });
  const data = await resp.json();
  console.log(`JWT: ${data.token}`);
  console.log(`\n配置到 opencode.json:`);
  console.log(JSON.stringify({
    mcp: {
      "huaweicloud-agent": {
        type: "remote",
        url: `${API_BASE}/mcp`,
        timeout: 300000,
        headers: { Authorization: `Bearer ${data.token}` }
      }
    }
  }, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
