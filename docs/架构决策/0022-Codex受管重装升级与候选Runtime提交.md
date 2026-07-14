# ADR-0022：Codex 受管重装升级与候选 Runtime 提交

状态：Accepted
日期：2026-07-14

## 背景

ADR-0021 已开放 Codex 单宿主首装与卸载，但存在 install-state 时仍拒绝重跑 install。直接复用原 `materializeStableRuntime` 会在检查旧宿主 ownership 之前改写 `active-runtime.json`；一旦后续插件刷新、审批或状态提交失败，旧插件可能意外启动尚未完成宿主验证的新 runtime。

Codex 本地插件更新仍沿用个人 marketplace 和 CLI reinstall 约定：marketplace entry 保持固定本地 source，不由升级流程手工改写；插件版本或开发 cachebuster 由候选构建产物提供，安装器通过结构化 CLI remove/add/list 刷新本次拥有的 activation。

## 决策

1. runtime 物化拆成候选落盘与 active pointer 激活两个步骤。候选版本先写入 `versions/<version>` 并完整复验，但不修改 `current/active-runtime.json`。
2. active pointer 使用独立有限事务：严格解析旧 pointer，记录前后精确字节和 SHA-256，提交前再次比较旧 hash；首次创建使用无覆盖 hard-link，替换使用同目录原子 rename。失败补偿只在当前 hash 仍等于候选 pointer 时恢复旧字节，删除新 pointer 时使用 quarantine 二次复核。
3. 重跑 `install --host codex` 先读取并重新绑定单宿主 install-state，要求旧 runtime、插件 tree、personal marketplace entry 和 Codex installed entry 均与记录证据精确一致，active pointer 也必须绑定同一旧版本和 manifest digest。
4. 候选版本与旧 install-state 的 version/digest 完全相同时，不重写资产、pointer 或状态；仍执行稳定 launcher、Codex 插件发现和无云副作用点击式审批探针，返回 `status: unchanged`。
5. 跨版本替换只允许旧插件 asset 和 CLI activation 均为本工具创建的 `changed: true`。安装前已经存在的相同 asset 或 activation 不被升级流程接管；这种情况返回 ownership 冲突。Personal marketplace entry 内容固定不变，其既有 ownership 证据原样延续。
6. 跨版本顺序固定为：候选 runtime 落盘 → 旧 activation remove → 旧 asset hash 安全删除 → 新 asset 物化 → Codex CLI add/list → active pointer CAS 切换 → 稳定 launcher/宿主/审批验证 → install-state CAS 替换。
7. install-state 替换继续是内存事务中的最后提交点；提交后不再执行可能导致升级失败的步骤。旧 runtime 版本目录保留，供失败补偿、诊断和后续清理策略使用。
8. 提交前任一步失败时按新 activation → active pointer → 新 asset 的逆序撤销，再从旧 verified runtime 重新物化旧 asset，并通过 CLI add/list 恢复旧 activation。只有全部补偿成功才返回原始错误；任一补偿冲突统一返回 `UPGRADE_TRANSACTION_ROLLBACK_CONFLICT`。
9. 若 Codex add 后置列表不可读取，activation 结果未知，不删除候选 asset 或其依赖，避免留下宿主缓存引用缺失来源；状态保持旧版本并明确报告需人工诊断的回滚冲突。
10. 升级流程不修改 marketplace 文件、不自动生成版本号，也不运行真实开发机插件更新。测试使用临时 home、候选 runtime 副本和假 Codex runner。

## 结果

- 同版本 install 已成为可验证的幂等重装入口。
- 跨版本 install 能在候选 runtime 不提前生效的前提下刷新 Codex 插件，并在审批或宿主验证失败时恢复旧 state、pointer、asset 和 activation。
- active pointer 现在具备可单独测试的 compare-before-replace 与 hash 安全回滚原语。
- 升级成功后安全卸载继续使用新 install-state，旧 runtime cache 保留。

## 安全边界与当前限制

当前补偿覆盖同一进程内的命令失败、验证失败和 CAS 冲突；尚未引入持久升级 journal，因此操作系统强制终止或断电发生在旧 activation/asset 已撤销之后时，不能承诺自动恢复。后续如补该门禁，只允许增加单用途、严格 schema、无凭证的最小恢复标记，不演进为 v0.2 式事件流、通用 repair 框架或常驻服务。

升级不清理旧 runtime，不迁移稳定 launcher 字节；候选 launcher 与已安装 launcher 不一致时继续返回显式 migration 冲突。当前仅支持单宿主 Codex 状态，不处理多宿主原子升级。

## 未采用

- 不在候选 runtime 验证前切换 active pointer。
- 不覆盖安装前已经存在的相同插件目录或 activation。
- 不用 `--force` 绕过 tree hash、installed entry hash 或 state CAS。
- 不手工改写 personal marketplace 来触发 Codex 缓存刷新。
- 不自动删除旧 runtime 或 credentials。
- 不引入独立 update/repair 命令、daemon、全局锁或通用升级 SPI。
