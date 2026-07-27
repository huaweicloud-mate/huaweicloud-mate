# hc-devkit — Huawei Cloud Agent Plugin

操作华为云资源的 MCP 插件。支持 ECS/VPC/OBS/RDS/CCE 等服务的自然语言查询与管理。

## 安装

### 方式 1: 远端 Agent（零安装，推荐）

在 opencode 配置文件（`opencode.json` 或 `~/.config/opencode/opencode.json`）添加：

```json
{
  "mcp": {
    "hc-devkit": {
      "type": "remote",
      "url": "http://113.45.151.224:3000/mcp",
      "enabled": true,
      "timeout": 300000
    }
  }
}
```

重启 opencode 即可使用。

### 方式 2: npm 全局安装（自动缓存 JWT）

```bash
npm install -g hc-devkit
```

opencode 配置：

```json
{
  "mcp": {
    "hc-devkit": {
      "type": "local",
      "command": ["hc-devkit"]
    }
  }
}
```

> npm 方式：`tools/list` 和 `tools/call` 全部透传云端，JWT 自动缓存到 `~/.hc-devkit/jwt`。

## 使用

插件提供 5 个 MCP 工具：

| 工具 | 用途 | 示例 |
|------|------|------|
| `huaweicloud_auth` | 认证，获取 JWT | `huaweicloud_auth(ak="...", sk="...", region="cn-south-1")` |
| `huaweicloud_set_credentials` | 更新 AK/SK | 更新后旧沙箱自动销毁 |
| `huaweicloud_voucher_status` | 查代金券状态 | 返回 `{claimed, amount}` |
| `huaweicloud_voucher_claim` | 领取代金券 | 一人一次，重复调用提示已领取 |
| `huaweicloud_invoke` | 操作华为云资源 | `huaweicloud_invoke("查 cn-south-1 的 VPC")` |

### 典型流程

```
1. huaweicloud_auth(ak, sk, region)   → 认证 + 后台预热沙箱
2. huaweicloud_invoke(intent, token)  → 查询/操作资源
```

认证后沙箱自动预热（10-15s），首次查询 2 分钟内返回，后续同 session 秒级响应。

## 架构

```
opencode (本地) ──MCP──▶ hc-devkit (CCE) ──K8s──▶ Sandbox Pod ──▶ 华为云 API
       │                        │
       │                 ┌──────┴──────┐
       │              Redis(DCS)   MySQL(RDS)
       │              用户/JWT缓存   代金券记录
       │
       └── npm hc-devkit（本地代理，透传云端）
```

| 组件 | 说明 |
|------|------|
| **hc-devkit Server** | Express.js MCP Server, 部署于华为云 CCE LoadBalancer |
| **Sandbox Pod** | 按需创建的 K8s Job, 含 opencode + KooCLI + Skills 运行环境 |
| **Redis (DCS)** | 用户会话, Job 状态缓存 (TTL 24h/30min) |
| **MySQL (RDS)** | 代金券领取记录 (永久) |

## 沙箱 (Sandbox)

每个 sandbox 是一个独立的 K8s Pod，按需为用户创建，30 分钟内复用。

### 组件清单

| 类别 | 组件 | 版本 |
|------|------|------|
| **CLI** | KooCLI (hcloud) | 7.2.12 |
| | Terraform | 1.11.4 |
| | Node.js | 22.23.1 |
| **SDK** | `@huaweicloud/huaweicloud-sdk-core` | 3.1.207 |
| | `@huaweicloud/huaweicloud-sdk-apig` | 3.1.207 |
| **Agent** | opencode-ai | 1.18.6 |
| **Skills** | 华为云 Skills | 69 个 SKILL.md, 12 类 |
| **基础** | Alpine 3.x + gcompat | uid=1000 (非 root) |

### 安全上下文

```
runAsNonRoot: true
runAsUser: 1000
allowPrivilegeEscalation: false
capabilities.drop: ALL
imagePullPolicy: Always
```

### 启动流程

```
Sandbox Pod 启动
  │ initContainer: git clone huaweicloud-skills → /skills
  │
  ├─→ hcloud configure set (非交互式, AK/SK 从 env 读入)
  ├─→ sed agreePrivacy=true (避免交互弹窗)
  ├─→ opencode serve :3005
  └─→ [sandbox] ready
```

## 镜像

| 镜像 | Tag | 用途 |
|------|-----|------|
| Server | `hdkitservice:20260727175927` | MCP + A2A 服务 |
| Sandbox | `sandbox:20260727182548` | 用户隔离执行环境 |

## 开发

```bash
git clone git@github.com:huaweicloud-mate/huaweicloud-mate.git -b dev_poc
cd huaweicloud-mate
npm install

# 本地启动云端服务
npm start

# 测试本地代理
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/hc-devkit.js
```

### 构建与部署

```bash
# 1. 构建 sandbox 镜像（需 x86_64 主机）
docker build -t hdkitservice/sandbox:$TAG -f server/Dockerfile.sandbox .

# 2. 构建 server 镜像
docker build -t hdkitservice/server:$TAG -f server/Dockerfile.server .

# 3. 推送并部署
docker push ... && kubectl -n huaweicloud-agent set image ...
```

> 本地 ARM64 机器不能构建 x86_64 镜像，需通过跳板机 `110.41.83.215` 构建。

## 发布

```bash
npm version patch
git push origin dev_poc --tags   # CI 自动发布到 npm
```

## License

MIT
