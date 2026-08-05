# HuaweiCloud DevKit Plugin — 架构与时序图

## 1. 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         用户侧 (Local)                               │
│                                                                     │
│  ┌──────────┐     MCP stdio     ┌─────────────────┐                │
│  │ opencode │ ────────────────→ │ hc-devkit (npm) │                │
│  │  (Agent) │ ←──────────────── │ local proxy     │                │
│  └──────────┘                  │ JWT auto-cache  │                │
│       │                         └────────┬────────┘                │
│       │  MCP remote (HTTP)              │                          │
│       │  ┌──────────────────────────────┘                          │
└───────┼──┼─────────────────────────────────────────────────────────┘
        │  │
   ┌────▼──▼──────────────────────────────────────────────────────────┐
   │                   ELB 113.45.151.224                             │
   │              client_timeout=300s keepalive=300s                  │
   └────┬────────────────┬────────────────────────────────────────────┘
        │ :3000          │ :3001
   ┌────▼──────┐   ┌─────▼──────┐
   │hdkitservice│   │ hc-devkit  │  ← CCE namespace: huaweicloud-agent
   │(dev_poc)   │   │ (main)     │
   └─────┬──────┘   └─────┬──────┘
         │                │
         │   ┌────────────┼────────────┐
         │   │                         │
    ┌────▼───▼──┐              ┌───────▼───────┐
    │   MySQL   │              │   DCS Redis   │
    │ voucher / │              │ user / job /  │
    │ tasks     │              │ akidx state   │
    └───────────┘              └───────────────┘
         │
         │  K8s Job API
  ┌──────▼─────────────────────────────────────────────┐
  │              Sandbox Pod                            │
  │                                                     │
  │  ┌──────────────────────────────────────────────┐   │
  │  │              /entrypoint.sh                   │   │
  │  │                                               │   │
  │  │  1. git clone gitcode.com → /skills           │   │
  │  │  2. hcloud configure set (AK/SK)              │   │
  │  │  3. ~/.hcloud/credentials (明文)              │   │
  │  │  4. HUAWEICLOUD_SDK_AK/SK export              │   │
  │  │  5. ln -sf hcloud → ~/.hcloud-agent/...       │   │
  │  │  6. opencode serve :3005                      │   │
  │  └──────────────────────────────────────────────┘   │
  │                                                     │
  │  ┌───────────────┐  ┌─────────────────────────┐     │
  │  │   opencode    │  │  huaweicloud-mate MCP   │     │
  │  │   (Agent)     │──│  5 tools router         │     │
  │  └───────┬───────┘  └───────────┬─────────────┘     │
  │          │                      │                    │
  │   ┌──────▼──────────────────────▼─────────────┐     │
  │   │          Executor Router                    │     │
  │   │  MCP → KooCLI → SDK → Terraform             │     │
  │   └──────┬──────────────┬──────────────┬───────┘     │
  │          │              │              │              │
  │   ┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼─────────┐  │
  │   │   KooCLI    │ │  SDK       │ │  Terraform    │  │
  │   │  (hcloud)   │ │ @huawei/   │ │   1.11.4      │  │
  │   └─────────────┘ │ sdk-core   │ └───────────────┘  │
  │                    └────────────┘                    │
  │  ┌──────────────────────────────────────────────┐   │
  │  │   Skills 69 SKILL.md   │ Capability Index    │   │
  │  └──────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────┘
                          │
                          ▼ Huawei Cloud API
```

## 2. 认证流程

```
User(opencode)          hc-devkit Server          Redis           MySQL       Incentive API
     │                        │                      │               │               │
     │ huaweicloud_auth       │                      │               │               │
     │ {ak,sk,region,...}     │                      │               │               │
     │───────────────────────→│                      │               │               │
     │                        │                      │               │               │
     │                        │--- 签名验证 ──────────│               │               │
     │                        │                      │               │               │
     │                        │--- 查 akidx ─────────→│               │               │
     │                        │←── userId ────────────│               │               │
     │                        │                      │               │               │
     │                        │--- 获取/解析 domainId                  │               │
     │                        │    (测试环境: user提供)                 │               │
     │                        │    (生产环境: hcloud实时获取)           │               │
     │                        │                      │               │               │
     │                        │--- setUser ──────────→│               │               │
     │                        │   {ak,sk,domainId,    │               │               │
     │                        │    ak_hash}           │               │               │
     │                        │                      │               │               │
     │                        │--- 查券: checkCouponIssued ───────────→│               │
     │                        │                      │               │               │
     │                        │                      │               │   GET check-   │
     │                        │                      │               │── coupon-issued│
     │                        │                      │               │←─ {issued_tag}─│
     │                        │                      │               │               │
     │                        │--- 查券: getVoucher ──────────────────→│               │
     │                        │←── {status,amount} ────────────────────│               │
     │                        │                      │               │               │
     │ issue JWT              │                      │               │               │
     │ {sub:userId,           │                      │               │               │
     │  exp:12h}              │                      │               │               │
     │←───────────────────────│                      │               │               │
     │                        │                      │               │               │
     │ [预热 sandbox 后台]     │                      │               │               │
```

## 3. Invoke 调用流程

```
User(opencode)    hc-devkit Server      K8s           Sandbox Pod       Huawei Cloud
     │                  │                 │               │                 │
     │ huaweicloud_invoke│                │               │                 │
     │ {intent, token}   │                 │               │                 │
     │──────────────────→│                 │               │                 │
     │                   │                 │               │                 │
     │                   │ verifyJwt       │               │                 │
     │                   │ getUser(Redis)  │               │                 │
     │                   │                 │               │                 │
     │                   │ checkAkHash     │               │                 │
     │                   │ (AK变更检测)     │               │                 │
     │                   │                 │               │                 │
     │                   │ createTask      │               │                 │
     │                   │  └→ getOrCreateContainer      │                 │
     │                   │       ├─ 有缓存 → 复用        │                 │
     │                   │       └─ 无缓存 → 新建 Job ──→│                 │
     │                   │                 │   创建 Pod   │                 │
     │                   │                 │               │                 │
     │                   │                 │  entrypoint.sh                │
     │                   │                 │  ├─ git clone skills          │
     │                   │                 │  ├─ hcloud configure          │
     │                   │                 │  ├─ 写 credentials 文件       │
     │                   │                 │  ├─ export SDK 变量           │
     │                   │                 │  └─ opencode serve :3005      │
     │                   │                 │               │                 │
     │                   │    POST /tasks  │               │                 │
     │                   │    {intent}     │               │                 │
     │                   │─────────────→   │───────────────→                 │
     │                   │                 │  opencode 处理                 │
     │                   │                 │  ├─ MCP: cloud_capability_search
     │                   │                 │  ├─ MCP: cloud_action_plan
     │                   │                 │  ├─ KooCLI: hcloud ...         │
     │                   │                 │  │             ────────────────→│
     │                   │                 │  │             ←────────────────│
     │                   │                 │  └─ SDK/Terraform ...          │
     │                   │                 │               │                 │
     │                   │    SSE stream   │               │                 │
     │                   │    {progress}   │               │                 │
     │                   │←───────────────│←──────────────│                 │
     │                   │                 │               │                 │
     │  result (SSE/MCP) │                 │               │                 │
     │←──────────────────│                 │               │                 │
```

## 4. 代金券领券流程

```
User(opencode)    hc-devkit Server       Redis        MySQL      Incentive API
     │                  │                   │            │              │
     │ huaweicloud_     │                   │            │              │
     │ voucher_claim    │                   │            │              │
     │ {token}          │                   │            │              │
     │─────────────────→│                   │            │              │
     │                  │                   │            │              │
     │                  │ verifyJwt(token)  │            │              │
     │                  │ getUser(sub)      │            │              │
     │                  │──────────────────→│            │              │
     │                  │←── {ak,sk,        │            │              │
     │                  │     domainId,     │            │              │
     │                  │     ak_hash} ─────│            │              │
     │                  │                   │            │              │
     │                  │ check: domainId?  │            │              │
     │                  │ check: ak_hash?   │            │              │
     │                  │ (防AK变更冒领)     │            │              │
     │                  │                   │            │              │
     │                  │ 双检: 本地 + 激励  │            │              │
     │                  │ getVoucher ───────────────────→│              │
     │                  │←── {status:1?} ──────────────-│              │
     │                  │                   │            │              │
      │                  │ checkCouponIssued              │              │
      │                  │─────────────────────────────────────────────→│
      │                  │←── {issued_tag} ─────────────────────────────│
      │                  │                   │            │              │
      │                  │ issueCoupon ────────────────────────────────→│
     │                  │←── {coupon_id,                   │              │
     │                  │     success:true}────────────────────────────│
     │                  │                   │            │              │
     │                  │ claimVoucher(DB)               │              │
     │                  │───────────────────────────────→│              │
     │                  │←── OK ─────────────────────────│              │
     │                  │                   │            │              │
     │  {success:true,   │                   │            │              │
     │   amount:10,      │                   │            │              │
     │   voucherId:xxx}  │                   │            │              │
     │←──────────────────│                   │            │              │
```

## 5. Sandbox GC 流程

```
     Server (每5分)               K8s API                Sandbox Pod
         │                           │                       │
         │ startSandboxGC()          │                       │
         │ listNamespacedPod         │                       │
         │ {app=sandbox}             │                       │
         │──────────────────────────→│                       │
         │←── [pod1,pod2,...] ───────│                       │
         │                           │                       │
         │ For each pod:             │                       │
         │  ├─ age > TTL?            │                       │
         │  │   (user=300s anon=60s) │                       │
         │  ├─ health check?         │                       │
         │  │   GET :3005/health ────────────────────────────→│
         │  │   ←── 200/fail ────────────────────────────────│
         │  │                       │                       │
         │  └─ if expired/unhealthy→│                       │
         │     deleteNamespacedJob  │                       │
         │──────────────────────────→│                       │
         │                           │  Terminate Pod       │
         │                           │──────────────────────→│
```

## 6. 部署流水线

```
 本地开发                          CCE 环境
 ────────                         ────────

 改代码
   │
   ├─ npm test ──→ 通过?
   │                  │
   │                  ├─ deploy.sh hc-devkit
   │                  │      │
   │                  │      ├─ tar 源码
   │                  │      ├─ SCP → 构建机(110.41.83.215)
   │                  │      ├─ docker build + push SWR
   │                  │      └─ kubectl set image + rollout
   │                  │
   │                  └─ 验证 (curl MCP endpoint)
   │
   ├─ git commit & push
   │
   └─ CD Pipeline (cd-staging.yml)
          │
          ├─ npm ci + test
          ├─ docker build + push SWR
          └─ SSH 构建机 → kubectl deploy
```
