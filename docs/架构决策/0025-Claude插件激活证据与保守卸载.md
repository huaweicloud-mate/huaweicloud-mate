# ADR-0025：Claude 插件激活证据与保守卸载

状态：Accepted<br>
日期：2026-07-14

## 背景

ADR-0024 已完成 Claude 本地 catalog 和 marketplace CLI 注册，但 marketplace 可发现不等于插件已经安装或启用。首装事务还需要区分“安装前已有的插件”和“本次创建的安装”，并在失败时只撤销后者；直接编辑 Claude 的 `installed_plugins.json`、settings 或 cache 会绕过宿主语义，也无法安全处理用户禁用、版本漂移和命令结果未知。

Claude Code 2.1.116 的 `plugin list --json` 为数组，已安装插件包含 `id`、`version`、`scope`、`enabled`、`installPath` 和时间字段。`install/uninstall` 的退出码不是充分 ownership 证据，结构化 list 后置条件必须是权威结果。

## 决策

1. 激活只接受已通过文件复验的 Claude catalog 和已通过 CLI 复验的 marketplace registration，固定插件 ID 为 `huaweicloud-mate@huaweicloud-mate-local`，固定 scope 为 `user`。
2. 安装前后都执行 `claude plugin list --json`。受管 ID 必须唯一；entry 的 version 必须等于 catalog/plugin manifest 版本，scope 必须为 `user`，enabled 必须为 `true`，installPath 必须是绝对路径且尾部为 `huaweicloud-mate-local/huaweicloud-mate/<version>`。
3. 安装前已有且完整匹配的启用项只记录 `changed: false`，不声称卸载权。用户已禁用、版本不同、重复 identity 或 cache 路径形状不一致时停止，不自动启用、升级或覆盖。
4. entry 不存在时执行 `claude plugin install huaweicloud-mate@huaweicloud-mate-local --scope user`。随后 list 的结构化结果为权威后置条件；即使命令退出非零，只要后置条件完整成立即可记录成功。
5. activation 证据记录固定 identity、版本、scope、绝对 installPath 和完整 entry 的 canonical SHA-256。证据不记录 MCP 参数、凭证、命令输出或用户配置内容。
6. install 已尝试但 list 读取或解析失败时返回 `CLAUDE_ACTIVATION_OUTCOME_UNKNOWN`，保留 plugin asset、catalog 和 marketplace registration，禁止继续依赖清理。
7. 回滚仅处理 `changed: true` 且当前 entry 与安装后 hash、版本和路径完全一致的安装。执行 `claude plugin uninstall ... --scope user --keep-data`，再以 list 中受管 ID 消失作为成功后置条件；命令退出码本身不决定结果。
8. `--keep-data` 明确保留插件持久数据。Claude 自身将卸载 cache 标为 orphan 时，本工具不直接删除该 cache；cache 清理由宿主负责，不扩大 install-state 的删除授权。
9. 本切片不直接修改 Claude settings、`known_marketplaces.json`、`installed_plugins.json` 或 cache，也不开放 `install --host claude`；下一步把 catalog、registration、activation 证据纳入 install-state 和单宿主事务。

## 结果

- Claude marketplace 可发现性和插件启用状态拥有相互独立、可验证的 ownership 证据。
- 首装失败可以先安全撤销 activation，再按依赖顺序撤销 marketplace registration、catalog 和 plugin asset。
- 用户禁用、用户升级、宿主缓存漂移或结果未知时都会保留现场，不以“清理”为由删除可能属于用户的状态。

## 不采用

- 不直接编辑 Claude 内部配置或 cache。
- 不把 marketplace registration 当作 plugin activation。
- 不在回滚时删除持久数据或 orphan cache。
- 不复用 Codex 的 list JSON 形状或命令参数。

## 参考

- [Claude Code：Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code：Plugins reference](https://code.claude.com/docs/en/plugins-reference)
