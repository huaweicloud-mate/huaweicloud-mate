# ADR-0047：npm 发布包隔离安装与 Bin 冒烟

状态：Accepted
日期：2026-07-15

## 背景

`npm pack --dry-run` 可以验证文件 allowlist、条目数量和包体大小，但不能证明真实 tarball 能被 npm 安装，也不能证明生成的 bin shim、生产依赖和包内契约在消费环境中可运行。源码树中的 `node_modules` 或 `dist` 通过测试，仍可能掩盖发布包漏文件、错误 bin 绑定或安装后模块解析失败。

## 决策

`npm run pack:check` 同时执行静态包检查和无云副作用的隔离消费测试：

1. 先用 `npm pack --dry-run --json --ignore-scripts` 验证 allowlist、必需文件、重复路径、条目数与压缩/解压大小预算；
2. 在 OS 临时目录生成唯一真实 tarball，并要求其大小与已检查的 dry-run 报告一致；
3. 使用当前 `npm ci` 已填充的缓存，以 `--offline --ignore-scripts --omit=dev` 语义安装 tarball，不执行包生命周期脚本；
4. 验证已安装 package identity、version、bin 绑定和平台 bin shim；
5. 只通过安装后的 `huaweicloud-mate` bin 运行 `version` 与 `doctor --contracts-only --json`；Doctor 必须报告 schema/state-machine 向量通过且 deferred 为 0；
6. 无论成功或失败都删除该专用临时目录，不在仓库生成 tarball、consumer 项目或锁文件。

五平台 CI 矩阵在各自 runner 上执行该门禁，从而分别覆盖 Windows amd64、Linux amd64/arm64 和 macOS amd64/arm64 的 npm bin 形态；独立 package/release job 仍在 Linux 上重复执行供应链检查。

该 smoke test 不访问华为云、不读取凭证、不触发审批，也不替代五平台 CI、真实宿主加载、npm provenance 或正式云端验收。

## 结果

- 发布包漏依赖、漏契约、错误 bin 或安装后模块解析失败会在候选发布前 fail closed；
- `pack:check` 比单纯清单检查更慢，但仍只使用本轮构建和本机 npm 缓存；
- 公共 npm 身份和 KooCLI 正式制品仍由 `release:check` 独立阻止未授权发布。
