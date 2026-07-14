# ADR-0026：Claude 单宿主安装状态与依赖安全清理

状态：Accepted<br>
日期：2026-07-14

## 背景

ADR-0024 与 ADR-0025 已分别建立 Claude catalog、CLI marketplace registration 和 plugin activation 的独立证据。要开放用户入口，还必须把这些证据绑定到固定 runtime/host 计划，并解决失败回滚和卸载时的依赖关系：预先存在的 activation 依赖 marketplace、catalog 和 plugin asset，不能因为下层资源碰巧由本次创建就将其删除。

Windows 上 Claude 可能由 npm shim 暴露为 `claude.cmd`，实际转发到包内原生 `claude.exe`。直接执行 `.cmd` 需要 shell，会扩大参数解释和命令注入面；完全忽略 shim 又会使官方原生程序无法被当前安装形态发现。

## 决策

1. Claude host 的 install-state 在单个 `registration` 节点中嵌套 catalog 文件 ownership、CLI marketplace entry 和 plugin activation；不存 executable path、命令输出、MCP 参数、凭证或用户配置内容。
2. 状态读取保持严格 exact-key 解析，并验证固定 marketplace/plugin identity、plugin version、catalog/plugin 路径、activation cache 路径尾部、所有 SHA-256 和 createdPaths。绑定时从已验证 runtime 内置模板重新生成 Claude 计划，状态绝对路径本身不授予删除权。
3. 首装顺序固定为 runtime → plugin asset → catalog → CLI marketplace registration → plugin activation → 完整宿主/审批复核 → install-state 最终提交点。失败按逆序回滚；结果未知或任一 ownership/entry hash 漂移时保留依赖现场。
4. `install --host claude` 支持首次安装和同版本、同 manifest 的完整复核；同版本复核重新验证 asset、catalog、registration、activation、稳定 launcher 和无云审批探针。尚无 Claude 升级恢复标记前，不执行跨版本替换，明确要求先卸载再安装不同版本。
5. `uninstall --host claude` 在任何写操作前完成本次可删除资源的预检，再按 activation → CLI registration → catalog → asset → state 执行。只有上层资源由本次拥有且已成功撤销，才允许继续删除其下层依赖。
6. 若 activation 为安装前已有，则 registration/catalog/asset 全部保留；若 registration 为安装前已有，则 catalog/asset 保留；若 catalog 为安装前已有，则 asset 保留。卸载始终保留已验证 runtime、credentials、插件持久数据和 Claude 自有 orphan cache。
7. Windows runner 不执行任意 `.cmd/.ps1`。它只解析不超过 8 KiB、UTF-8、包含唯一 `"%dp0%\\...<command>.exe|.com" %*` 目标的 npm native shim；相对目标不得含 `.`/`..`，必须位于 shim 同目录树内且 basename 与请求命令一致。解析成功后直接以 `shell: false` 执行真实原生程序。
8. 本切片不修改 Claude 内部 JSON/cache，不在真实用户目录执行安装自动化测试，也不实现 Claude 跨版本升级。

## 结果

- `install/uninstall --host claude` 已形成单宿主、用户级、可验证且无密码输入的闭环。
- 安装前已有资源不再因下层 ownership 组合而被间接破坏。
- npm 暴露的原生 Claude 可执行文件可被安全发现，同时任意批处理脚本仍不会执行。
- Claude 受管升级继续保持显式门禁，不复用 Codex 恢复证据或假装已有跨版本事务。

## 不采用

- 不以 state 内路径直接删除文件。
- 不在 activation 未认领时删除其 marketplace 或 asset。
- 不用 `shell: true` 执行 npm shim。
- 不把 Claude 强行并入 Codex marketplace 或升级实现。
