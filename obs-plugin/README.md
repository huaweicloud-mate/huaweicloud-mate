# 华为云 OBS MetaMCP 插件

这个仓库包含一个共享的华为云 OBS MCP Server，以及面向 Codex 和 OpenCode 的接入包装。Codex/OpenCode 通过本地 MetaMCP 连接，MetaMCP 再路由到 OBS child MCP Server。

## 目录结构

- `packages/obs-mcp-server`：Node/TypeScript MCP Server，暴露 94 个显式 OBS API 工具。
- `.mcp.json`：MetaMCP 使用的 child MCP 配置。
- `codex-plugin`：Codex 插件包装层。
- `.opencode`：OpenCode 配置模板和 skill。
- `.agents/skills/huaweicloud-obs`：Codex/OpenCode 可共享的 skill 说明。

## 安装与构建

```powershell
npm install
npm run build
```

将 `.env.example` 中的变量配置到当前 shell 环境。必填凭据：

- `HUAWEICLOUD_ACCESS_KEY_ID`
- `HUAWEICLOUD_SECRET_ACCESS_KEY`
- `HUAWEICLOUD_OBS_REGION`

可选配置：

- `HUAWEICLOUD_SECURITY_TOKEN`
- `HUAWEICLOUD_OBS_ENDPOINT`
- `HUAWEICLOUD_OBS_PREVIEW_BYTES`

安全开关：

- `HUAWEICLOUD_OBS_ENABLE_WRITE=true`
- `HUAWEICLOUD_OBS_ENABLE_DELETE=true`
- `HUAWEICLOUD_OBS_ENABLE_CONFIG_WRITE=true`

读操作默认可用。写入、删除、截断、批量删除、桶策略/ACL/CORS/生命周期/WORM 等配置变更操作，需要显式打开对应环境变量。对象级危险操作还需要传入 `confirm="<bucket>/<key>"`，桶级危险操作需要传入 `confirm="<bucket>"`。

## 本地 MetaMCP

```powershell
npx -y @mentu/metamcp --config .mcp.json
```

Codex 和 OpenCode 包装层都会启动同一个 MetaMCP 层，由 MetaMCP 路由到 `huaweicloud-obs` child MCP Server。

## 测试

```powershell
npm run build
npm test
npm run lint
```

默认不会运行真实 OBS live tests。当前测试使用 fixture 和本地逻辑校验，不需要华为云凭据。

## 常用工作流

- 列出桶：使用 `obs_list_buckets`。
- 列出对象：使用 `obs_list_objects`。
- 查看对象元数据：使用 `obs_head_object`。
- 下载对象：使用 `obs_get_object`，传入 `outputPath` 可保存完整内容；不传则返回受限预览。
- 上传对象：使用 `obs_put_object`，传入 `filePath`，并开启 `HUAWEICLOUD_OBS_ENABLE_WRITE=true`。
- 大对象上传：使用 multipart 相关工具，例如 `obs_initiate_multipart_upload`、`obs_upload_part`、`obs_complete_multipart_upload`。

## 设计说明

OBS child MCP Server 内部逐项注册 94 个显式 `obs_*` 工具，每个工具都有独立的参数 schema、风险等级和文档链接。Codex/OpenCode 不直接面对这 94 个工具，而是通过 MetaMCP 进行发现和调用，从而保持宿主侧上下文更紧凑。
