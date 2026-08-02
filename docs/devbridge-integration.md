# DevBridge × hc-devkit Plugin Integration Design

## 1. DevBridge 核心能力

| 组件 | 说明 |
|------|------|
| **DevBridge CLI** | `devbridge auth login`, `devbridge create`, `devbridge host`, `devbridge connect` |
| **REST API** | `POST /tunnels`, `POST /tunnels/{id}/ports`, `POST /tunnels/{id}/tokens` |
| **Host 模式** | 将本地端口隧道化，暴露为 `https://<tunnelId>.<clusterId>.myhuaweicloud.com` |
| **Connect 模式** | 将远程隧道端口映射到本地 |
| **认证** | 交互登录、AK/SK、临时凭证 |
| **API 地址** | `https://hdspace-partner.cn-north-4.myhuaweicloud.com/open-api-public/v1/relay` |

## 2. 当前痛点

| 问题 | 原因 | 影响 |
|------|------|------|
| Sandbox 冷启动 30-60s | opencode + hcloud + skills 初始化 | 首次 invoke 极慢 |
| K8s pod IP 限内部网络 | 集群只有内网 API | 外部无法直连 sandbox |
| invoke 走 ELB → server → pod IP | 多跳网络 | 延迟高 |
| 沙箱资源上限 100 | 物理节点限制 | 并发瓶颈 |

## 3. 集成方案

### 方案 A: DevBridge Sandbox Tunnel（推荐）

**核心思路**: 每个 sandbox 启动时用 DevBridge Host 暴露 opencode API，server 通过隧道直连。

```
┌────────────┐                          ┌──────────────────────┐
│  opencode  │  MCP                     │   hc-devkit Server   │
│  (local)   │ ────────────────────────→│       (CCE)          │
└────────────┘                          │                      │
                                        │  1. createTask       │
                                        │  2. K8s Job → pod   │
                                        │                     │
                                        │  3. DevBridge API   │
                                        │     创建隧道 + 端口  │
                                        │                     │
                                        │  4. 通过隧道 URL    │
                                        │     直连 sandbox    │
                                        │     :3005           │
                                        └──────┬──────────────┘
                                               │ HTTPS
                                               ▼
                              DevBridge Relay Server
                                     │
                                     │ Tunnel
                                     ▼
                              ┌──────────────────────┐
                              │   Sandbox Pod         │
                              │                      │
                              │  opencode :3005      │
                              │  devbridge host      │
                              │  KooCLI / SDK / TF   │
                              └──────────────────────┘
```

**价值**:
- 直连 sandbox，跳过 K8s 内部网络
- DevBridge 提供 TLS + 认证，无需额外的 NetworkPolicy
- 可以从外部网络访问（调试、监控）
- 隧道复用时支持 sandbox 预热

### 方案 B: DevBridge Local Executor（轻量查询）

**核心思路**: 对于简单 read 查询，跳过 sandbox，用 DevBridge Connect 在用户本地执行 KooCLI。

```
┌──────────┐     MCP      ┌──────────────┐    REST API    ┌──────────────┐
│ opencode │ ────────────→│ hc-devkit    │ ─────────────→│ DevBridge    │
│ (local)  │              │ server       │               │ API          │
└──────────┘              │              │               │              │
                          │ 1. 判断轻量  │               │ 1. 创建隧道  │
                          │    查询     │               │ 2. 创建端口  │
                          │             │               │ 3. 签发token │
                          │ 2. 转发     │               │              │
                          │    intent   │               │              │
                          └──────┬──────┘               └──────┬───────┘
                                 │                             │
                    DevBridge Tunnel                            │
                                 │                             │
                          ┌──────▼──────────────────────────────┘
                          │  用户本地
                          │  devbridge connect <tunnelId>
                          │  hcloud VPC ListVpcs
                          │  → 结果通过隧道返回
                          └──────────────────────────────────
```

### 方案 C: DevBridge Pre-warmed Pool

沙箱预热池——用 DevBridge 保持长连接 sandbox，复用隧道，消除冷启动。

## 4. 推荐架构（方案 A + C 混合）

```
                     DevBridge REST API
                    ┌─────────────────┐
                    │ POST /tunnels   │
                    │ POST /ports     │
                    │ POST /tokens    │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    ┌────▼─────┐      ┌──────▼──────┐      ┌─────▼─────┐
    │ Sandbox  │      │  Sandbox    │      │  Sandbox  │  ← Pre-warmed Pool
    │ Pod 1    │      │  Pod 2      │      │  Pod 3    │
    │          │      │             │      │           │
    │devbridge │      │ devbridge   │      │ devbridge │
    │  host    │      │   host      │      │   host    │
    │opencode  │      │ opencode    │      │ opencode  │
    │  :3005   │      │   :3005     │      │   :3005   │
    └──────────┘      └─────────────┘      └───────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                    ┌────────▼────────┐
                    │  hc-devkit      │
                    │  Server         │
                    │                 │
                    │  SandboxPool    │  ← 管理预热的 sandbox 池
                    │  - allocate()   │
                    │  - release()    │
                    │  - healthCheck()│
                    └─────────────────┘
```

**SandboxPool 工作流**:
1. 启动时创建 N 个预热的 sandbox（每个带 DevBridge tunnel）
2. 请求进来时从池中分配，无需等待冷启动
3. 使用 DevBridge tunnel URL 直连 sandbox opencode API
4. 用完归还池中，TTL 内复用
5. 定期 GC 清理过期 sandbox（DevBridge 隧道自动过期）

## 5. 时序图

### 5.1 Sandbox 预热 + 分配

```
Server Start       DevBridge API      K8s            Sandbox Pod
    │                    │              │                 │
    │ POST /tunnels      │              │                 │
    │ {name:sandbox-N}   │              │                 │
    │───────────────────→│              │                 │
    │←── {tunnelId} ─────│              │                 │
    │                    │              │                 │
    │ POST /ports        │              │                 │
    │ {port:3005,http}   │              │                 │
    │───────────────────→│              │                 │
    │←── OK ─────────────│              │                 │
    │                    │              │                 │
    │                    │ Create Job   │                 │
    │                    │─────────────→│                 │
    │                    │              │  Pod Start      │
    │                    │              │  devbridge host │
    │                    │              │────────────────→│
    │                    │              │  opencode :3005 │
    │                    │              │                 │
    │  Store to Pool     │              │                 │
    │ {tunnelId, userId} │              │                 │
    │                    │              │                 │
```

### 5.2 Invoke with DevBridge Tunnel

```
opencode     Server      SandboxPool    DevBridge Tunnel    Sandbox
   │           │              │               │                │
   │ invoke    │              │               │                │
   │──────────→│              │               │                │
   │           │ verifyJwt    │               │                │
   │           │              │               │                │
   │           │ allocate()   │               │                │
   │           │─────────────→│               │                │
   │           │←── {sandbox}─│               │                │
   │           │              │               │                │
   │           │ POST /tasks  │               │                │
   │           │ {intent}     │               │                │
   │           │─────────────────────────────→│                │
   │           │              │   HTTPS       │ opencode :3005 │
   │           │              │               │───────────────→│
   │           │              │               │ MCP →          │
   │           │              │               │ KooCLI/SDK     │
   │           │              │               │                │
   │           │ SSE stream   │               │                │
   │           │←─────────────────────────────│←───────────────│
   │           │              │               │                │
   │ result    │              │               │                │
   │←──────────│              │               │                │
   │           │ release()    │               │                │
   │           │─────────────→│               │                │
```

## 6. 技术方案

### 6.1 新增组件

```
cloud-server/src/services/
├── devbridge.js          # DevBridge REST API 封装
│   ├── createTunnel(name, expireHours)
│   ├── createPort(tunnelId, port, protocol)
│   ├── createToken(tunnelId, scope)
│   └── deleteTunnel(tunnelId)
│
├── sandbox-pool.js       # 预热沙箱池管理
│   ├── warmup(count)     # 预创建 N 个 sandbox
│   ├── allocate()        # 从池中分配
│   └── release(sandbox)  # 归还池中
│
cloud-server/docker/
├── entrypoint.sh         # 添加: 安装 devbridge CLI
│                         # 添加: devbridge host 启动
│
cloud-server/k8s/
├── deployment-hc-devkit.yaml  # 添加: DEVBRIDGE_API_URL
│                               # 添加: DEVBRIDGE_AK/SK
```

### 6.2 关键参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_POOL_SIZE` | 3 | 预热的 sandbox 数量 |
| `SANDBOX_POOL_TTL` | 600 | 池中 sandbox 最大空闲时间(秒) |
| `DEVBRIDGE_API_URL` | hdspace-partner... | DevBridge API 地址 |
| `DEVBRIDGE_TUNNEL_EXPIRE` | 24 | 隧道有效期(小时) |

## 7. 开发计划

### Phase 1: DevBridge SDK 封装（devbridge.js）
- 实现 REST API 调用
- 认证（AK/SK）
- 隧道 CRUD + 端口管理 + Token 签发

### Phase 2: Sandbox DevBridge Host
- entrypoint.sh 安装 devbridge CLI
- 启动时创建 DevBridge tunnel + host opencode:3005
- 隧道 ID 写入共享状态（Redis）

### Phase 3: Sandbox Pool（sandbox-pool.js）
- 预热池启动/关闭
- 分配/归还逻辑
- 健康检查 + TTL 回收

### Phase 4: 集成测试
- env: DEVBRIDGE_AK, DEVBRIDGE_SK 设为测试凭证
- 验证 invoke 通过 tunnel 完成
- 压测池分配性能

## 8. 依赖

- DevBridge CLI: `curl install.sh | bash`
- DevBridge AK/SK（不同于华为云 AK/SK）
- 构建机需能访问 DevBridge API (cn-north-4)
- Sandbox 镜像需安装 DevBridge CLI
