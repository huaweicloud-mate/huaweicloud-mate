# ADR-0029：Claude 升级中断恢复标记与保守收敛

状态：Accepted
日期：2026-07-14

## 背景

Claude 跨版本升级会依次撤销旧 plugin activation、catalog 和插件资产，再安装候选资产、catalog、activation，切换 active runtime，最后提交 install-state。常规异常可以在同一进程内逆序回滚，但进程强制终止或 Claude CLI 返回结果未知时，下一次运行必须区分旧版、候选版、已恢复旧版和已提交候选版。

Claude 的 plugin list 证据可能包含重装后变化的时间字段，因此恢复旧 activation 后不能假定旧 install-state 字节仍然完全相同。

## 决策

1. 跨版本升级在首次宿主变更前写入权限受限、严格 schema、CAS 更新的 `claude-upgrade-recovery.json`；标记不含凭证。
2. 标记绑定旧 install-state、旧 active pointer、候选 runtime manifest、候选资产 tree hash、候选 catalog hash，以及执行后逐步补充的 activation/pointer 证据。
3. 下一次 `install --host claude` 在任何新变更前恢复：
   - install-state 已提交候选时，只验证候选 asset/catalog/activation/pointer 并删除陈旧标记；
   - install-state 仍是旧版时，识别并撤销候选 activation/catalog/asset，恢复旧 pointer 和依赖；
   - Claude 实际已安装候选但进程尚未记录 CLI 返回证据时，可通过固定候选版本做只读发现并补录证据；
   - 任一身份、hash、版本或固定路径无法证明时 fail closed。
4. 恢复旧 activation 后重新生成 install-state；先把预期恢复 state hash 和 activation 证据写入恢复标记，再 CAS 提交 state，覆盖恢复过程中再次终止的窗口。
5. install-state 是升级最终提交点。提交后标记删除失败不会回滚已验证候选；下次 install 只验证并清理。
6. 恢复标记存在时禁止 uninstall，也禁止用其他宿主 install 处理该现场。

## 结果

- Claude 与 Codex 均支持常规升级失败回滚和强制终止后的保守收敛。
- `OUTCOME_UNKNOWN` 不会触发未经证明的第二次安装或跨执行器重试。
- 候选 runtime 目录可以作为无副作用缓存保留；宿主可见状态最终只对应一个已验证版本。
- 不增加 daemon、repair 命令、通用事务框架或 Proposed v0.2 的复杂治理层。
