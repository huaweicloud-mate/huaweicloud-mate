/**
 * config.ts — 默认配置，全部可通过环境变量覆盖
 *
 * 子 server 路径基于本文件自身位置解析，不依赖 CWD。
 */

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ChildServerConfig {
  /** 在 catalog / mcp_call 中引用的 server 名 */
  name: string;
  /** 启动子 server 的命令 */
  command: string;
  /** 命令参数 */
  args: string[];
  /** 子进程工作目录（用于 .env 加载等） */
  cwd: string;
}

export interface GatewayConfig {
  /** 子 MCP Server 列表 */
  children: ChildServerConfig[];
  /** discover 搜索返回的最大结果数 */
  maxSearchResults: number;
}

/** 获取子 server 的绝对路径（生产用 JS，开发用 TS + tsx） */
function resolveChildServer(relativePath: string): { command: string; args: string[] } {
  // 判断是否在 dist 目录下运行（生产模式）
  const isProduction = __dirname.includes(path.sep + "dist");

  if (isProduction) {
    // 生产模式：dist/src/config.js → dist/servers/huawei-iam-server.js
    const absPath = path.resolve(__dirname, "..", "servers", path.basename(relativePath, ".ts") + ".js");
    return { command: "node", args: [absPath] };
  } else {
    // 开发模式：src/config.ts → servers/huawei-iam-server.ts
    const absPath = path.resolve(__dirname, "..", relativePath);
    return { command: "npx", args: ["tsx", absPath] };
  }
}

/** 获取插件根目录（兼容 dev / production） */
export function pluginRoot(): string {
  const isProduction = __dirname.includes(path.sep + "dist");
  return isProduction
    ? path.resolve(__dirname, "..", "..")   // dist/src/ → 包根目录
    : path.resolve(__dirname, "..");         // src/ → 包根目录
}

export function loadConfig(): GatewayConfig {
  const child = resolveChildServer("servers/huawei-iam-server.ts");
  const root = pluginRoot();

  return {
    children: [
      {
        name: "huawei-iam",
        ...child,
        cwd: root,
      },
    ],
    maxSearchResults: 10,
  };
}