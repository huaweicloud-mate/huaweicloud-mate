# huaweicloud-mate 插件架构（基于实际代码）

> 来源: `/home/developer/Desktop/huaweicloud-mate/src/router/`  
> 代码: 1,847 行 / 10 个 TS 模块

---

## 总架构

```mermaid
flowchart TB
    subgraph AGENT["Agent 层"]
        OC["OpenCode"]
        CC["Claude Code"]
        CX["Codex"]
    end

    subgraph ROUTER["huaweicloud-mate Router (src/router/index.ts 314行)"]
        direction TB
        
        subgraph TOOLS["5 个 MCP 工具"]
            T1["cloud_capability_search<br/>→ Catalog.search()"]
            T2["cloud_capability_describe<br/>→ Catalog.get()"]
            T3["cloud_targets_status<br/>→ Credential + HealthCheck"]
            T4["cloud_action_plan<br/>→ Policy.evaluate()"]
            T5["cloud_action_execute<br/>→ executeAction()"]
        end

        EXEC["executeAction() (78行)"]
    end

    subgraph MODULES["7 个核心模块"]
        CAT["Catalog.ts (88行)<br/>load JSON → search_index 分词"]
        POL["Policy.ts (115行)<br/>风险分级 + plan_token TTL"]
        CRED["Credential.ts (87行)<br/>~/.hcloud/credentials INI"]
        AUDIT["Audit.ts (44行)<br/>JSONL 审计日志"]
        EXECR["ExecutorRouter.ts (455行)<br/>MCP spawn + KooCLI spawn"]
        KINST["KooCLI Installer.ts (198行)<br/>自动下载+SHA256+安装"]
        TYPES["Types.ts (84行)<br/>CapabilityEntry/Result 等类型"]
    end

    subgraph EXECUTORS["执行器层"]
        subgraph MCP_PATH["MCP 路径 (resolveMCPServer → callMCPServer)"]
            ECS_MOCK["ecs-mock-server<br/>Node stdio"]
            OBS_REAL["obs-server<br/>Python stdio"]
            NAT_REAL["nat-server<br/>Python stdio"]
        end
        subgraph CLI_PATH["KooCLI 路径"]
            HCLOUD["hcloud v7.2.12<br/>子进程 spawn"]
        end
    end

    subgraph DATA["数据层"]
        CATALOG_JSON["capability_index.json<br/>15,475 能力 / 210 产品 / 17MB"]
        CRED_FILE["~/.hcloud/credentials<br/>AK/SK 配置文件"]
        AUDIT_FILE["~/.hcloud-agent/logs/<br/>audit-{date}.jsonl"]
    end

    %% Agent → Router
    OC -->|"MCP stdio"| ROUTER
    CC -->|"MCP stdio"| ROUTER
    CX -->|"MCP stdio"| ROUTER

    %% Router → Modules
    T1 --> CAT
    T2 --> CAT
    T3 --> CRED
    T3 --> EXECR
    T4 --> POL
    T5 --> EXEC

    EXEC --> CAT
    EXEC --> POL
    EXEC --> CRED
    EXEC --> AUDIT
    EXEC --> EXECR

    %% Modules → Data
    CAT -->|"load JSON"| CATALOG_JSON
    CRED -->|"read INI"| CRED_FILE
    AUDIT -->|"write"| AUDIT_FILE

    %% Modules → Executors
    EXECR -->|"executor=mcp"| MCP_PATH
    EXECR -->|"executor=koocli"| CLI_PATH
    KINST -->|"install binary"| HCLOUD

    %% Executors → Cloud
    ECS_MOCK -.->|"mock data"| API
    OBS_REAL --->|"AK/SK 签名"| API
    NAT_REAL --->|"AK/SK 签名"| API
    HCLOUD --->|"--cli-access-key/secret-key"| API

    subgraph CLOUD["☁️ 华为云"]
        API["产品 API (OBS/ECS/NAT/VPC/...)"]
    end

    %% Styles
    classDef agent fill:#667eea,color:#fff
    classDef router fill:#f093fb,color:#1a1a2e
    classDef module fill:#4facfe,color:#1a1a2e
    classDef exec fill:#43e97b,color:#1a1a2e
    classDef data fill:#ffd93d,color:#1a1a2e
    classDef cloud fill:#fa709a,color:#1a1a2e

    class OC,CC,CX agent
    class ROUTER,TOOLS,EXEC router
    class CAT,POL,CRED,AUDIT,EXECR,KINST,TYPES module
    class ECS_MOCK,OBS_REAL,NAT_REAL,HCLOUD exec
    class CATALOG_JSON,CRED_FILE,AUDIT_FILE data
    class API cloud
```

---

## executeAction() 数据流（核心）

```mermaid
flowchart TD
    A["cloud_action_execute({capabilityId, executor, params})"] --> B{"planToken?"}
    B -->|"yes"| C["Policy.verifyAndConsume()"]
    B -->|"no"| D["直接用 args 参数"]
    C --> D

    D --> E["Catalog.get(capabilityId)<br/>获取 capEntry"]
    
    E --> F{"executor?"}
    
    F -->|"koocli"| G["注入 params._service<br/>注入 params._operation<br/>注入 params.region"]
    F -->|"mcp"| H["取 toolOverride =<br/>capEntry.executors.mcp.tool"]
    
    G --> I["ExecutorRouter.execute()"]
    H --> I

    I --> J{"executor 类型"}
    J -->|"mcp"| K["resolveMCPServer(capId)<br/>→ obs-server / nat-server / ecs-mock"]
    J -->|"koocli"| L["取 _service + _operation"]
    
    K --> M["spawn(bin, args, {env:AK/SK})<br/>stdin→write initialize<br/>stdin→write tools/call<br/>stdout→parse JSON-RPC"]
    L --> N["spawn(hcloud, [service,op,<br/>--cli-output=json,<br/>--cli-access-key=...,<br/>--cli-secret-key=...,<br/>--region=...])<br/>stdout→JSON parse→redact"]

    M --> O["audit.write() → JSONL"]
    N --> O
    O --> P["return {success, data, execution}"]
```

---

## 模块依赖关系

```mermaid
flowchart LR
    INDEX["index.ts<br/>(入口)"]
    
    INDEX --> CAT["catalog.ts"]
    INDEX --> POL["policy.ts"]
    INDEX --> CRED["credential.ts"]
    INDEX --> AUDIT["audit.ts"]
    INDEX --> EXECR["executor-router.ts"]
    INDEX --> TYPES["types.ts"]

    EXECR --> KINST["koocli-installer.ts"]
    EXECR --> TYPES

    CAT --> TYPES
    CRED --> TYPES

    style INDEX fill:#f093fb,color:#1a1a2e
    style EXECR fill:#4facfe,color:#1a1a2e
    style KINST fill:#43e97b,color:#1a1a2e
```

---

## 启动流程

```mermaid
sequenceDiagram
    participant Agent as 🤖 Agent
    participant Router as index.ts
    participant KInst as koocli-installer.ts
    participant Cat as catalog.ts
    participant Cred as credential.ts
    participant Audit as audit.ts
    participant ExecR as executor-router.ts

    Agent->>Router: MCP stdio connect

    Router->>KInst: ensureKooCLI()
    KInst->>KInst: 检测 ~/.hcloud-agent/koocli/current/hcloud
    alt 已安装 v7.2.12
        KInst-->>Router: "Already installed ✅"
    else 未安装/版本不对
        KInst->>KInst: 下载 CDN → SHA256 → 解压 → chmod
        KInst-->>Router: "Installed v7.2.12 ✅"
    end

    Router->>Cat: new Catalog()
    Cat->>Cat: load capability_index.json (17MB → 内存)
    Cat-->>Router: "Loaded 15475 capabilities"

    Router->>Cred: new CredentialBroker()
    Cred->>Cred: parse ~/.hcloud/credentials (INI)
    Cred-->>Router: "Loaded"

    Router->>Audit: new JsonlAuditWriter()
    Router->>ExecR: new ExecutorRouter()

    Router->>Router: new Server + register 5 tools
    Router-->>Agent: tools/list [5 工具]
```

---

## 关键代码大小

```
src/router/
├── index.ts              314 行  入口 + 5 工具 + executeAction
├── executor-router.ts    455 行  MCP/KooCLI 双路径 + 健康检查
├── koocli-installer.ts   198 行  KooCLI 自动安装
├── policy.ts             115 行  风险分级 + plan_token
├── catalog.ts             88 行  能力目录 17MB JSON 加载
├── credential.ts          87 行  ~/.hcloud/credentials INI
├── types.ts               84 行  类型定义
├── audit.ts               44 行  JSONL 审计日志
├── mock/ecs-mock-server.ts 130 行  ECS Mock (3 tools)
└──────────────────────────
  总计: 1,847 行
```
