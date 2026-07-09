/**
 * child-manager.ts — ChildManager：STDIO 子进程管理
 *
 * 管理子 MCP Server 的生命周期：启动、listTools、callTool、关闭。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolEntry } from "./catalog.js";
import type { ChildServerConfig } from "./config.js";

interface ChildSession {
  config: ChildServerConfig;
  client: Client;
  transport: StdioClientTransport;
}

export class ChildManager {
  private children: Map<string, ChildSession> = new Map();

  /** 启动所有子 server 并建立 MCP 连接 */
  async startAll(configs: ChildServerConfig[]): Promise<void> {
    for (const cfg of configs) {
      try {
        await this.startOne(cfg);
      } catch (err) {
        console.error(
          `[child-manager] 子 server "${cfg.name}" 启动失败:`,
          err
        );
      }
    }
  }

  /** 启动单个子 server */
  private async startOne(cfg: ChildServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
    });

    const client = new Client(
      { name: "gateway", version: "0.1.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    this.children.set(cfg.name, { config: cfg, client, transport });
    console.error(`[child-manager] ✅ 子 server "${cfg.name}" 已连接`);
  }

  /** 获取已连接的 server 名列表 */
  listServers(): string[] {
    return Array.from(this.children.keys());
  }

  /** 获取某个子 server 的全部 tool 列表 */
  async listTools(serverName: string): Promise<ToolEntry[]> {
    const session = this.children.get(serverName);
    if (!session) {
      throw new Error(`子 server "${serverName}" 未连接`);
    }

    const result = await session.client.listTools();
    return result.tools.map((t) => ({
      server: serverName,
      tool: t.name,
      description: t.description || "",
      inputSchema: (t.inputSchema || {}) as Record<string, unknown>,
    }));
  }

  /** 转发 tool 调用到子 server */
  async call(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const session = this.children.get(serverName);
    if (!session) {
      throw new Error(
        `子 server "${serverName}" 未连接，可用 server: ${this.listServers().join(", ")}`
      );
    }

    const result = await session.client.callTool({
      name: toolName,
      arguments: args,
    });

    // 提取文本内容
    const texts: string[] = [];
    if (result.content) {
      for (const item of result.content as Array<{ type: string; text?: string }>) {
        if (item.type === "text" && item.text) {
          texts.push(item.text);
        }
      }
    }
    return texts.join("\n") || JSON.stringify(result);
  }

  /** 关闭所有子 server */
  async shutdownAll(): Promise<void> {
    for (const [name, session] of this.children) {
      try {
        await session.client.close();
        console.error(`[child-manager] 已关闭 "${name}"`);
      } catch (err) {
        console.error(`[child-manager] 关闭 "${name}" 失败:`, err);
      }
    }
    this.children.clear();
  }
}
