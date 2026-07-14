# ADR-0012：四宿主路径绑定与 Canonical Skill 生成

状态：Accepted
日期：2026-07-14

## 背景

ADR-0011 已冻结版本化运行时与稳定 launcher，但宿主模板仍只有 schema 和严格注册表，没有可安装的真实路径、配置形态或 Skills 产物。继续实现配置写入前，必须先把四宿主的用户级路径和原生 MCP 结构固化，避免 Installer 猜测路径。

## 决策

1. Codex 与 Claude Code 使用 `plugin-manifest`：安装器把随包生成的自包含插件复制到稳定的 `runtime/hosts/<host>/huaweicloud-mate`，再把插件根 `.mcp.json` 渲染为 `process.execPath + current/hcloud-agent.mjs + router --stdio`。
2. OpenCode 使用用户级 `~/.config/opencode/opencode.json`，在 `mcp.huaweicloud-agent` 写入 `type: local`、`command[]` 和 `enabled: true`；Skills 写入 `~/.config/opencode/skills/huaweicloud`。
3. 华为云码道使用用户级 `~/.codeartsdoer/codearts_cli.jsonc`，采用同样的 `mcp.huaweicloud-agent` 本地命令数组；Skills 写入 `~/.codeartsdoer/skills/huaweicloud`。官方同时支持 `.json` 与 `.jsonc`，首版选择 `.jsonc` 并要求后续合并器保留注释。
4. 仓库只维护 `skills/canonical/huaweicloud/SKILL.md`。构建过程生成 Codex、Claude Code 和通用目录布局，不允许长期维护四份内容副本。
5. 模板解析只接受四个固定根 token，并拒绝 `.`、`..`、空路径段、非绝对运行时绑定和不指向 `runtime/current/hcloud-agent.mjs` 的 launcher。
6. 源插件中的 `.mcp.json` 只是可校验的渲染模板。安装器完成绝对路径渲染前，不得把它报告为已安装或可运行配置。

## 依据

- Codex manifest 按项目使用的 Codex `plugin-creator` 校验器约束，并在构建后执行实际校验。
- [Claude Code 插件参考](https://code.claude.com/docs/en/plugins-reference) 与 [Claude Code MCP](https://code.claude.com/docs/en/mcp) 定义插件根的 `.claude-plugin/plugin.json`、`skills/` 和 `.mcp.json`。
- [OpenCode 配置](https://opencode.ai/docs/config) 与 [OpenCode MCP](https://opencode.ai/docs/mcp-servers) 定义全局配置、`mcp` 对象和本地 `command[]`；[OpenCode Skills](https://opencode.ai/docs/skills) 定义全局 Skills 目录。
- [华为云码道默认 MCP 配置](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0017.html) 与 [码道 Skills](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0019.html) 定义用户级配置和 Skills 目录。

## 结果

- 四宿主模板、配置 fragment 和文件路径可以确定性生成，并被完整安装清单覆盖。
- Codex 与 Claude Code 插件资产可以分别通过随 Codex 提供的校验器和本机 Claude CLI 校验。
- 本 ADR 不开放 `install`，也不宣称已经修改任何用户宿主配置。下一步仍需实现冲突检测、备份、JSON/JSONC 原子合并、失败回滚、最小 install-state 与安全卸载。

## 未采用

- 不把 OpenCode 或码道包装成额外 Hook/plugin；首版只写其原生 MCP 配置和 Skills。
- 不恢复通用 Adapter SPI、动态模板下载或任意命令字段。
- 不在模板中保存开发机绝对路径，也不使用运行时 `npx -y`。
