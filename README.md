# hdkitservice — Huawei Cloud Agent Plugin

操作华为云资源的 MCP 插件。支持 ECS/OBS/VPC 等服务的自然语言查询与管理。

## 安装

### 方式 1: 远端 Agent（零安装）

在 opencode 配置文件（`opencode.json` 或 `~/.config/opencode/opencode.json`）添加：

```json
{
  "mcp": {
    "hdkitservice": {
      "type": "remote",
      "url": "http://113.45.151.224:3000/mcp",
      "enabled": true,
      "timeout": 300000
    }
  }
}
```

重启 opencode 即可使用。

### 方式 2: npm 全局安装（自动管理凭据）

```bash
npm install -g hdkitservice
```

opencode 配置：

```json
{
  "mcp": {
    "hdkitservice": {
      "type": "local",
      "command": ["hdkitservice"]
    }
  }
}
```

> npm 方式会自动缓存 JWT 到 `~/.hdkitservice/jwt`，无需手动传 token。

## 使用

插件提供以下 MCP 工具：

| 工具 | 用途 | 示例 |
|------|------|------|
| `huaweicloud_auth` | 认证，获取 JWT | `huaweicloud_auth(ak="...", sk="...", region="cn-south-1")` |
| `huaweicloud_set_credentials` | 更新 AK/SK | 更新后旧沙箱自动销毁 |
| `huaweicloud_voucher_status` | 查代金券状态 | 返回 `{claimed, amount}` |
| `huaweicloud_voucher_claim` | 领取代金券 | 一人一次，重复调用提示已领取 |
| `huaweicloud_invoke` | 操作华为云资源 | `huaweicloud_invoke("查 cn-south-1 的 ECS")` |

### 首次使用

```
1. 认证 hdkitservice <AK> <SK> cn-south-1
   → 自动检查代金券，未领会询问是否领取

2. 查 ECS
   → Sandbox 自动拉起，返回资源列表
```

### 无 AK/SK（Mock 模式）

```
认证 hdkitservice    ← 不提供 AK/SK
查 ECS               ← 返回 mock 数据
设置凭据 <AK> <SK>   ← 随时可升级为真实查询
```

## 架构

```
opencode (本地) ──MCP──▶ hdkitservice (CCE) ──K8s──▶ Sandbox Pod ──▶ 华为云 API
                              │
                       ┌──────┴──────┐
                    Redis(DCS)   MySQL(RDS)
                    临时数据      持久记录
```

- **hdkitservice**: Express.js MCP Server, 部署于华为云 CCE
- **Sandbox**: 按需创建的 K8s Job, 含 opencode + huaweicloud-mate + KooCLI
- **Redis (DCS)**: 用户会话、Job 状态缓存 (TTL 24h/30min)
- **MySQL (RDS)**: 代金券领取记录 (永久)

## 开发

```bash
git clone git@github.com:huaweicloud-mate/huaweicloud-mate.git -b dev_poc
cd huaweicloud-mate
npm install

# 本地启动云端服务
npm start

# 本地测试本地代理
node bin/hdkitservice.js
```

## 发布

```bash
npm version patch
git push origin dev_poc --tags   # CI 自动发布到 npm
```

## License

MIT
