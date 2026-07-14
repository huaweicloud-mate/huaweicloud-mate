# ADR-0023：Codex 升级中断恢复标记与保守收敛

状态：Accepted
日期：2026-07-14

## 背景

ADR-0022 已实现 Codex 受管升级的同进程补偿，但旧 activation 或 asset 被删除后若进程被强制终止，内存中的候选 asset、activation 和 active pointer 证据会丢失。下一次 `install` 因旧 install-state 与实际宿主状态不一致而只能报冲突，无法在重试升级前安全恢复旧版本。

该缺口只需要覆盖单宿主 Codex 升级，不应扩展为 Proposed v0.2 式事件流、通用 repair、后台服务或跨宿主事务框架。

## 决策

1. 跨版本升级在第一次撤销旧 activation 前创建固定文件 `codex-upgrade-recovery.json`。标记使用严格 schema、16 KiB 上限、普通文件与 `0600` 权限检查，以及 SHA-256 compare-and-swap 写入。
2. 标记只保存旧 install-state/pointer 摘要、旧/候选 runtime version 与 install manifest 摘要、候选 asset tree hash，以及可选的候选 activation/pointer 摘要。不保存凭证、任意路径、命令、审批 receipt 或云资源参数。
3. 候选 asset tree hash 在破坏旧安装前由 verified runtime 和固定宿主计划确定性渲染，预览 staging 随即删除；恢复时重新计算并比对，不能仅信任标记内容。
4. 候选 activation 成功并可读取后立即用 CAS 追加 installed entry 摘要；active pointer 切换后再追加 pointer 摘要。标记证据只允许按固定顺序增加，不作为通用步骤日志。
5. 下一次 `install --host codex` 在普通 ownership 预检之前处理标记。若 install-state 仍是旧摘要，只接受旧或候选的精确 activation、asset 和 pointer，按 activation → pointer → asset 的依赖顺序撤销候选并恢复旧版本，完整复验后删除标记，再重新执行本次 install。
6. 若 install-state 已提交为候选版本，只在候选 state、asset、marketplace、activation 和 pointer 均精确通过验证时删除残留标记，把该中断视为已完成提交。
7. Codex add 已发生但 installed entry 尚未写入标记的窗口仍然 fail closed：若当前 entry 既不匹配旧证据、又没有候选证据，保留候选依赖和恢复标记并返回 `UPGRADE_RECOVERY_CONFLICT`，不猜测或强制删除。
8. 常规同进程失败完成旧版本补偿后同时删除标记；补偿或标记清理冲突时保留标记供下一次 install 重新验证。install-state 仍是最终提交点，提交后的标记清理失败不反向回滚已提交升级。
9. 恢复入口不新增 CLI 命令，不读取真实凭证，不运行云操作，也不修改 personal marketplace。测试继续使用临时 home、候选 runtime 副本和假 Codex runner。

## 结果

- 旧 activation/asset 已撤销、候选 asset/activation 已建立或 pointer 已切换等可证明现场，能在下一次 install 前自动恢复旧版本并安全重试。
- install-state 已提交但进程尚未来得及删除标记时，下一次 install 能验证候选版本并幂等清理。
- 未记录的 activation 结果、用户修改或第三方内容继续保留现场并显式冲突。
- 恢复状态仍是一个单用途标记，而不是通用升级 journal。

## 安全边界与当前限制

本决策不保证在无法读取 Codex installed entry、候选 runtime 被删除、标记被篡改或用户修改受管资源时自动恢复；这些情况必须 fail closed。它不负责卸载恢复、旧 runtime 清理、多宿主事务、进程锁或并发安装队列。

## 未采用

- 不保存任意补偿命令、文件路径、凭证或完整状态快照。
- 不增加 `repair`、`resume`、`--force` 或后台 daemon。
- 不在证据不完整时按目录名或当前内容猜测 ownership。
- 不把恢复标记升级为事件流、通用事务日志或 Adapter SPI。
