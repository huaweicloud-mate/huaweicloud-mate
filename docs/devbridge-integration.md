# DevBridge × hc-devkit Plugin Integration Design v2

## 1. DevBridge Sandbox API（5个开放接口）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/open-api-public/v1/sandbox/instances` | POST | 创建沙箱实例 |
| `/open-api-public/v1/sandbox/instances` | GET | 分页查询沙箱列表 |
| `/open-api-public/v1/sandbox/instances/{id}` | GET | 查询沙箱详情 |
| `/open-api-public/v1/devenvs/{devStageId}/connections` | POST | 创建 WSS3 连接 |
| `/open-api-public/v1/sandbox/auto-config` | POST | 自动注入 STS 临时凭证 |

## 2. 关键能力对比

| 能力 | 当前 (K8s Job) | DevBridge Sandbox |
|------|---------------|-------------------|
| 沙箱管理 | 自己创建/删除 K8s Job | 托管，API 调用 |
| 预热 | 无，冷启动 30-60s | 内置预热策略 |
| 资源规格 | 1C/1Gi ~ 2C/2Gi | CPU/memory/GPU 可配 |
| 凭证注入 | entrypoint.sh 手动配置 | `auto-config` 自动 STS |
| 通信方式 | K8s pod IP（内网） | WSS3 WebSocket 连接 |
| 生命周期 | 手动 GC | 托管回收 |
| 并发上限 | 100 (节点限制) | 租户级配额 |
| 网络 | 需 NetworkPolicy | 托管隧道 |

## 3. 新架构（用 DevBridge 替代 K8s Job）

```
opencode ──MCP──→ hc-devkit Server (CCE)
                       │
                       │ DevBridge Sandbox API
                       │
              ┌────────▼──────────────────────┐
              │   DevBridge Sandbox Service    │
              │                                │
              │  POST /sandbox/instances       │
              │  POST /auto-config (STS)       │
              │  POST /devenvs/{id}/connections │
              └────────┬───────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ Sandbox  │ │ Sandbox  │ │ Sandbox  │  ← 预热池
    │ Instance │ │ Instance │ │ Instance │
    │          │ │          │ │          │
    │ opencode │ │ opencode │ │ opencode │
    │ hcloud   │ │ hcloud   │ │ hcloud   │
    │ SDK/TF   │ │ SDK/TF   │ │ SDK/TF   │
    └──────────┘ └──────────┘ └──────────┘
```

## 4. 时序图

### 4.1 创建沙箱实例 + 自动配置 STS

```
hc-devkit Server          DevBridge API         Sandbox Service           Sandbox
     │                        │                       │                     │
     │ POST /sandbox/instances│                       │                     │
     │ {compute,image,meta}   │                       │                     │
     │───────────────────────→│                       │                     │
     │                        │   调度 + 预热分配      │                     │
     │                        │──────────────────────→│                     │
     │                        │                       │  Pod Start          │
     │                        │                       │─────────────────────→│
     │                        │                       │                     │
     │                        │←── {instance_id} ─────│                     │
     │←── {instance_id} ──────│                       │                     │
     │                        │                       │                     │
     │ POST /auto-config      │                       │                     │
     │ {instance_id,          │                       │                     │
     │  enable_sts:true}      │                       │                     │
     │───────────────────────→│                       │                     │
     │                        │  IAM → 临时 AK/SK     │                     │
     │                        │──────────────────────→│                     │
     │                        │  注入 sandbox 环境     │                     │
     │                        │──────────────────────────────────────────────→│
     │←── {sts_expires_at} ───│                       │                     │
     │                        │                       │                     │
     │ 存储: {instance_id,    │                       │                     │
     │        sts_expires_at} │                       │                     │
     │ → Redis                │                       │                     │
```

### 4.2 Invoke 调用（WSS3 连接）

```
opencode    hc-devkit Server      DevBridge API          Sandbox Instance
   │              │                    │                       │
   │ invoke       │                    │                       │
   │─────────────→│                    │                       │
   │              │ verifyJwt          │                       │
   │              │ getUser(Redis)     │                       │
   │              │                    │                       │
   │              │ 分配 sandbox       │                       │
   │              │ (从 Redis 查已有   │                       │
   │              │  或新建 instance)  │                       │
   │              │                    │                       │
   │              │ POST /devenvs/     │                       │
   │              │      {id}/         │                       │
   │              │      connections   │                       │
   │              │───────────────────→│                       │
   │              │                    │   建立 WSS3           │
   │              │                    │───────────────────────→│
   │              │←── {connection_id, │                       │
   │              │     status} ───────│                       │
   │              │                    │                       │
   │              │  通过 WSS3 发送    │                       │
   │              │  opencode task     │                       │
   │              │ {intent, context}  │                       │
   │              │═══════════════════════════════════════════→│
   │              │                    │  opencode 处理        │
   │              │                    │  MCP → KooCLI/SDK/TF  │
   │              │                    │                       │
   │              │  SSE Stream (WSS3) │                       │
   │              │←═══════════════════════════════════════════│
   │              │                    │                       │
   │ result       │                    │                       │
   │←─────────────│                    │                       │
```

### 4.3 Sandbox 实例生命周期

```
              hc-devkit Server                 DevBridge
                                              Sandbox Service
                     │                              │
    INVOKE REQUEST   │                              │
    ─────────────────│                              │
                     │ 检查 Redis: 用户有无有效实例   │
                     │                              │
          ┌──────────┴──────────┐                   │
          │ YES                  │ NO                │
          ▼                      ▼                   │
    GET /instances/{id}    POST /instances           │
    check status !=        {image,compute}           │
    Terminated/Stopped                               │
          │                      │                   │
          │                      ▼                   │
          │              POST /auto-config           │
          │              {enable_sts:true}           │
          │                      │                   │
          └──────────┬───────────┘                   │
                     ▼                               │
              POST /connections                      │
              {source:"hc-devkit"}                   │
                     │                               │
                     ▼                               │
              WSS3 通信 (opencode)                   │
                     │                               │
              TTL 到期 / 显式释放                    │
              (不调用 delete, DevBridge 托管)         │
```

## 5. 实现方案

### 5.1 代码结构

```
server/
├── devbridge-sandbox.js    # DevBridge Sandbox API 封装
│   ├── createInstance(image,cpu,memory,meta)
│   ├── listInstances()
│   ├── getInstance(instanceId)
│   ├── createConnection(instanceId,source)
│   ├── autoConfigSts(instanceId)
│   └── healthCheck(instanceId)
│
├── sandbox.js              # 改造
│   ├── [REMOVE] K8s Job creation
│   ├── [REMOVE] K8s pod management
│   ├── [REMOVE] GC logic (DevBridge 托管)
│   ├── createContainer() → devbridge-sandbox.createInstance()
│   └── destroyContainer() → no-op (DevBridge 托管回收)
│
└── sandbox-pool.js         # 新: 用户实例缓存
    ├── 查 Redis 获取缓存 instanceId
    ├── 校验实例是否有效
    └── 过期后重新创建
```

### 5.2 关键参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `DEVBRIDGE_API_URL` | `hdspace-partner.cn-north-4.myhuaweicloud.com/open-api-public/v1` | API 地址 |
| `DEVBRIDGE_AK` | - | DevBridge Access Key |
| `DEVBRIDGE_SK` | - | DevBridge Secret Key |
| `SANDBOX_IMAGE_ID` | - | 沙箱镜像 ID (需上传 SWR → DevBridge) |
| `SANDBOX_CPU` | 2 | CPU 核数 |
| `SANDBOX_MEMORY` | "4GiB" | 内存大小 |
| `SANDBOX_STS_DURATION` | 24h | 临时凭证有效期 |

### 5.3 状态迁移

```
当前: auth → create Sandbox Job → 30s 等 pod 就绪 → 通过 pod IP 通信
                             ↑ 每次都要等 30s

新:   auth → 查 Redis instanceId → 有效? → createConnection(0s) → WSS3 通信
                    ↓ 无效/不存在
              createInstance → autoConfig → createConnection(~5s)
```

## 6. 优势总结

| 指标 | 当前 K8s Job | DevBridge Sandbox |
|------|-------------|-------------------|
| 首次 invoke | ~35s | ~5s |
| 预热 invoke | ~5s (复用) | ~0s (WSS3 即连) |
| 并发上限 | 100 | 租户配额 |
| 运维成本 | 管理 GC/NetworkPolicy/Job | 零运维 |
| 凭证安全 | env var 明文 | STS 临时凭证 + 自动注入 |
| 外部可达 | ❌ 仅内网 | ✅ WSS3 公网可达 |
