# ADR-0011：版本化运行时与稳定 Launcher

状态：Accepted

日期：2026-07-14

## 背景

Proposed v0.3-lite 要求 `npx` 只作为安装入口，四宿主长期运行的 Router 不能依赖 npm 临时 cache。审批 companion 又必须从固定路径启动并在执行前验证制品，因此只校验开发目录内的局部 runtime manifest 还不够：安装器需要先把完整运行时物化到固定用户目录，并在候选版本校验失败时保留旧活动版本。

当前 TypeScript 输出还依赖 npm 安装树中的生产依赖。直接复制 `dist` 会在离开原 npm cache 后失去模块解析环境，不符合稳定运行路径要求。

## 决策

1. 构建阶段生成两个自包含入口：Router/CLI bundle 与 approval companion bundle。bundler 只在构建期使用，运行时不依赖 bundler、原 npm cache 或原 `node_modules`。
2. 构建阶段生成 `install-manifest.json`，严格绑定 package 名称、插件版本，以及除清单自身外完整 `dist` 内每个普通文件的相对路径、字节数和 SHA-256；active pointer 再绑定清单自身的 SHA-256。路径穿越、重复/乱序路径、symlink、未知字段、超限文件和摘要失配全部 fail closed。
3. Installer 先验证来源目录，再把清单中的精确文件复制到 `runtime/versions/<pluginVersion>` 的随机 staging 目录。复制完成后重新验证全部制品，最后才原子改名为版本目录；已有同版本目录若内容不同则报冲突，不覆盖或“修复”。
4. `runtime/current` 保存稳定 `hcloud-agent.mjs` 和最小 `active-runtime.json`。活动指针只包含安全版本号与完整安装清单摘要，不接受任意绝对路径。
5. 稳定 launcher 每次启动都把活动版本限制在同一 `versions` 目录内，校验 active pointer、安装清单、全部路径层级和全部制品摘要，再导入自包含 Router/CLI。宿主最终展开为固定 Node 可执行路径、稳定 launcher 路径和 `[router, --stdio]`，不运行 `npx -y`。
6. 候选来源校验、复制、复验或 launcher 写入失败时不得更新 active pointer。active pointer 是运行时物化阶段最后写入的状态。既有稳定 launcher 与新包不一致时首版拒绝隐式覆盖，要求未来通过显式 installer migration 演进 bootstrap，避免升级失败破坏旧活动版本。

默认用户级根目录保持既有决策：Windows `%LOCALAPPDATA%\hcloud-agent\runtime`，macOS `~/Library/Application Support/hcloud-agent/runtime`，Linux `${XDG_DATA_HOME:-~/.local/share}/hcloud-agent/runtime`。

## 安全边界

完整清单和启动前校验可以发现不完整复制、意外漂移、单独制品替换、symlink 替换和损坏候选版本；它也确保安装失败不会主动把 `current` 切向未验证候选版本。

它不能抵抗拥有当前账号任意文件写权限的攻击者同时替换稳定 launcher、active pointer、版本目录和全部摘要。正式发布仍必须依赖 npm provenance/制品签名、用户目录 ACL、安装目录写入隔离，以及四宿主对同账号 Agent 进程能力的验证。完成这些门禁前不得把本地摘要描述为抵抗同账号任意代码执行的“真实性证明”。摘要校验到模块加载之间仍存在同账号 TOCTOU 风险。

本决策不引入密码、OS Keyring、管理员权限、常驻 daemon、动态 Registry 或独立更新服务。

## 当前实现边界

- 已完成完整安装清单、版本化物化、稳定 launcher、active pointer、重复安装复用、已验证新版本切换并保留旧目录、同版本冲突、候选失败不切换、篡改 fail closed，以及从稳定路径启动 stdio MCP 三工具的自动化测试。
- 已完成 host template 注册表的严格四宿主集合与固定 launcher/approval 绑定校验器。
- 尚未公开 `install/uninstall` 命令，也未写入真实宿主配置、Canonical Skills 或 install-state；四宿主具体配置路径和 merge 实现需要在绑定后进入下一切片。
