# ADR-0033：用户级 Runtime 递归权限门禁

状态：Accepted
日期：2026-07-15

## 背景

版本化 runtime 保存稳定 launcher、活动版本指针、install-state、升级恢复证据、事务备份和私有 KooCLI。完整 SHA-256 清单只能发现内容漂移；如果目录仍继承宽泛写权限，其他本机账号可以在安装或卸载事务之间替换这些证据。

## 决策

1. 正式 CLI 的 `install` 在读取既有状态或写入任何 runtime 内容前，必须先建立并收紧固定 runtime 根目录；`uninstall` 在读取状态或恢复证据前必须复核同一权限门禁。
2. POSIX 递归拒绝 symlink 和特殊文件，要求当前 UID 所有；目录规范为 `0700`，普通文件规范为 `0600`，原本具备 owner execute 的文件保留为 `0700`。复核时任何 group/other 权限均 fail closed。
3. Windows 通过无 shell 的固定 `whoami`/`icacls` 参数获取当前 SID，递归 reset ACL、移除继承、仅授予当前 SID 的 `(OI)(CI)(F)`，再执行 SID 复核。`/L` 禁止 ACL 遍历跟随符号链接。
4. 权限遍历最多接受 16,384 个条目和 32 层目录；symlink、junction、设备等非常规条目或命令失败统一返回 `RUNTIME_PERMISSIONS_FAILED`。
5. 门禁覆盖 `versions`、`current`、install-state、升级 recovery/backup 证据和 `tools/koocli`。私有 KooCLI 在门禁之后安装，因此新目录继承同一 Windows ACL；受管重装会先递归修复既有树。

## 结果

- 用户级安装不需要管理员权限，同时阻止其他本机账号修改 runtime。
- Windows ACL 使用真实临时目录集成测试；POSIX owner/mode 与 Windows 固定命令序列另有单元测试。
- 该门禁不抵抗当前账号下的任意代码执行，也不替代 npm provenance、稳定 launcher 的摘要复验或四宿主进程/loopback 隔离。
