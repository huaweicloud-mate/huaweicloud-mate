# ADR-0038：Companion 已验签入口私有管道加载

状态：Accepted
日期：2026-07-15

## 背景

审批 launcher 会校验 runtime manifest 中的 companion 与契约工件，随后使用 `fork(entryPath)` 启动 companion。`fork` 会让子进程再次按路径读取入口，因此入口在摘要校验到进程加载之间仍可被同账号写入者替换。审批请求已经使用私有父子 IPC，不需要为解决入口加载再开放端口、文件或 Agent 可调用接口。

## 决策

1. 由正式 runtime manifest 创建的 launcher 必须保留校验时读取的 companion 入口字节，不再 `fork` 入口路径。
2. launcher 启动固定的最小 Node bootstrap。bootstrap 不含审批 UI、密钥生成、批准、签名或 receipt 逻辑，只从继承的私有 stdin 接收已验签入口字节，在内存 `data:` module 中导入并调用导出的 `runApprovalCompanionProcess`。
3. companion bundle 的逻辑 `import.meta.url` 一次性绑定到已验证版本目录中的原入口文件 URL，使契约目录定位保持不变；同一子进程不得重新绑定。
4. bootstrap 完成导入并注册审批消息监听器后，通过私有 IPC 发送严格的内部 ready 消息；Router 只在收到该消息后发送 review，防止启动竞态丢失请求。
5. 源码字节上限为 64 MiB，仍使用最小环境、`shell:false`、隐藏窗口、私有 stdin/IPC、无 stdout 和有界总超时。入口源码、审批上下文和密钥均不进入 argv 或环境变量。
6. 直接构造 launcher 的测试 fixture 默认保留路径模式；正式 `fromRuntimeManifest` 固定启用已验签字节模式，不能由 Agent 或 Tool 参数切换。

## 结果

- companion 实际执行的入口字节与 launcher 已验证 SHA-256 的字节相同。
- 无交互测试使用正式 runtime manifest 启动该链路，并在创建 session 后对过期请求 fail closed，不打开浏览器或签发 receipt。
- 本 ADR 决策时 companion 随后仍会从版本目录读取契约资产；该窗口已由 ADR-0039 改为父子从同轮已验签内存文本分别编译。本措施仍不抵抗同账号同时替换 launcher、pointer、manifest 和全树，也不替代四宿主私有句柄、调试和 loopback 隔离验收。
