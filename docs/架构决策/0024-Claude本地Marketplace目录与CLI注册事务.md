# ADR-0024：Claude 本地 Marketplace 目录与 CLI 注册事务

状态：Accepted
日期：2026-07-14

## 背景

Claude 插件资产、固定 `.claude-plugin/plugin.json`、根目录 `.mcp.json` 和 Canonical Skill 已生成，但尚无真实 Claude marketplace 来源。只把插件复制到 runtime 私有目录不会使 Claude Code 发现它；直接编辑 `~/.claude/plugins/known_marketplaces.json` 又会绕过 Claude 自身的 scope、策略和缓存语义。

Claude Code 官方提供本地目录 marketplace、`claude plugin validate`、`plugin marketplace add/list/remove` 和独立的 `plugin install/uninstall` 命令。Marketplace 注册和插件安装是两个不同生命周期，本切片只完成前者。

## 决策

1. Claude 专用 marketplace 根固定为 `<runtimeRoot>/hosts/claude`；现有插件目标 `<runtimeRoot>/hosts/claude/huaweicloud-mate` 保持不变。Catalog 固定写入同根的 `.claude-plugin/marketplace.json`，插件 source 固定为 `./huaweicloud-mate`。
2. Marketplace 名称固定为 `huaweicloud-mate-local`，owner 固定为 `hd-vector`。Catalog 只包含一个 `huaweicloud-mate` entry，并把 version 绑定到已验证 Claude plugin manifest。
3. Catalog 是专用受管文件，不合并用户或第三方 marketplace。目标不存在时使用权限受限临时文件和无覆盖 hard-link 创建；内容完全相同时幂等但不声明 ownership，不同时显式冲突。
4. Catalog 回滚只删除本次创建且 SHA-256 未漂移的文件，并用 quarantine 二次复核；用户修改、符号链接、路径重定向或摘要变化时保留现场。空的本次创建目录可清理，新增内容一律保留。
5. CLI 注册前必须从绝对 PATH 解析 `claude`，执行 `claude plugin validate <marketplaceRoot>`，再读取 `claude plugin marketplace list --json`。同名 entry 必须唯一，且 local `path` 精确等于固定 marketplace 根。
6. Entry 不存在时执行用户级 `claude plugin marketplace add <marketplaceRoot> --scope user`，随后以 list JSON 作为权威结果。记录完整 entry 的 canonical SHA-256、source 和固定路径；同路径已有 entry 只验证、不认领。
7. 注册回滚仅处理本次创建且完整 entry hash 未漂移的 marketplace。为兼容仍不支持 remove scope 参数的 Claude Code 版本，执行 `claude plugin marketplace remove huaweicloud-mate-local`；由于应用前拒绝任何同名 entry，本次注册是唯一声明，不会删除安装前已有 scope。
8. Add 后无法读取 list 时返回 `CLAUDE_MARKETPLACE_OUTCOME_UNKNOWN` 并保留 catalog/plugin 依赖；remove 后无法证明 entry 消失时返回回滚冲突，不继续删除依赖。
9. 本切片不执行 `claude plugin install/uninstall`，不修改真实用户配置文件或缓存，不接入 install-state/CLI。自动化测试使用假 runner；另以隔离临时 HOME 对本机 Claude Code 2.1.116 完成真实 add/list/remove 探测，不访问真实 `~/.claude`。

## 结果

- Claude 本地 marketplace 的 catalog 字节、固定 source 和 CLI 注册已具备独立 ownership 证据与安全回滚。
- 真实 CLI `marketplace list --json` 的 `name/source/path/installLocation` 形状已与解析器核对。
- 下一切片可以在此基础上增加 plugin install/list/uninstall activation，再纳入 install-state 与首装回滚编排。

## 安全边界与当前限制

Marketplace 已注册不等于插件已经安装、启用或缓存完成。本 ADR 完成后仍不得开放 `install --host claude`；必须先完成 activation outcome、disabled state、cache 依赖保留和 uninstall ownership 语义。

## 未采用

- 不直接编辑 `known_marketplaces.json`、settings 或 Claude cache。
- 不复用 Codex personal marketplace 文件格式和事务。
- 不把 Codex/Claude 抽象为通用 marketplace SPI。
- 不在本切片删除 marketplace 时顺带管理尚未建立 ownership 的插件安装。

## 参考

- [Claude Code：Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code：Plugins reference](https://code.claude.com/docs/en/plugins-reference)
