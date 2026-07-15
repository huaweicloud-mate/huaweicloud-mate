# ADR-0037：稳定 Launcher 加载已验签 CLI 字节

状态：Accepted
日期：2026-07-15

## 背景

稳定 launcher 会逐文件读取并校验活动版本的 install manifest、大小和 SHA-256，随后再通过文件 URL 导入 `runtime/cli.js`。文件 URL 导入会让 Node 再次按路径读取入口文件，因此同账号写入者仍可能在校验完成到模块加载之间替换 CLI。用户级 ACL 不能抵抗同账号攻击，但入口文件没有必要保留这段二次读取窗口。

## 决策

1. launcher 校验每个 artifact 时保留已读取的 `runtime/cli.js` 字节；全部 manifest、package identity 和 artifact 验证完成后，从这些已验签字节构造内存 `data:` module 并导入，不再按路径重读 CLI 入口。
2. runtime bundle 构建时把内部 `import.meta.url` 引用绑定到一个进程级逻辑 URL。launcher 在内存导入前将它一次性、不可写地设为已验证版本目录中的 `runtime/cli.js` 文件 URL，使 contracts、runtime manifest、host templates 和 installer source 仍从固定版本目录解析。
3. 同一进程不得把逻辑 URL 重新绑定到另一个 runtime；发现既有不同绑定时 fail closed。
4. bundle 直接作为文件执行时，构建 banner 将逻辑 URL 初始化为其真实 `import.meta.url`，保留开发诊断兼容性。
5. companion 和其他运行时资产仍在各自使用边界复核 manifest/SHA-256；该措施缩小 CLI 入口 TOCTOU，不宣称抵抗能同时替换 launcher、pointer、manifest 和全部文件的同账号攻击者。

## 结果

- 主 CLI 实际执行的字节与 launcher 已计算 SHA-256 的字节完全相同。
- 稳定 launcher 的 version、doctor、Router MCP 握手和 companion 定位保持不变。
- 正式真实性仍依赖 npm provenance、受保护发布和四宿主进程/loopback 隔离验收。
