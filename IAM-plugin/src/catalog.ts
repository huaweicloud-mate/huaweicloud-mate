/**
 * catalog.ts — ToolCatalog：内存索引 + 关键词搜索
 *
 * 完整 schema 存这里，mcp_discover 只返回轻量摘要（不含 inputSchema）。
 */

/** 华为云领域关键词 — 用于意图守卫，避免在非华为云相关问题上误调用 */
const DOMAIN_KEYWORDS = [
  "华为云", "huawei", "cloud", "iam", "ecs", "obs", "vpc",
  "安全组", "用户组", "策略", "权限", "项目", "region",
  "ak", "sk", "access key", "secret key", "弹性云", "对象存储",
  "虚拟私有云", "identity", "user", "group", "role", "policy",
];

export function isQueryHuaweiRelated(query: string): boolean {
  const q = query.toLowerCase();
  return DOMAIN_KEYWORDS.some(kw => q.includes(kw));
}

export interface ToolEntry {
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface SearchResult {
  server: string;
  tool: string;
  description: string;
  score: number;
}

export class ToolCatalog {
  private tools: ToolEntry[] = [];

  /** 启动时加载所有子 server 的 tool */
  load(serverName: string, tools: ToolEntry[]): void {
    // 先清旧数据再加载（支持热重载）
    this.tools = this.tools.filter((t) => t.server !== serverName);
    for (const t of tools) {
      this.tools.push({ ...t, server: serverName });
    }
  }

  /** 返回 tool 总数 */
  get count(): number {
    return this.tools.length;
  }

  /** 列出所有 tool 摘要 */
  listAll(): SearchResult[] {
    return this.tools.map((t) => ({
      server: t.server,
      tool: t.tool,
      description: t.description,
      score: 1.0,
    }));
  }

  /** 关键词搜索：server 名 + tool 名 + description 子串匹配，打分排序 */
  search(query: string): SearchResult[] {
    if (!query || query.trim().length === 0) {
      return this.listAll();
    }

    // 意图守卫：非华为云相关查询直接返回空，避免 LLM 误调用
    if (!isQueryHuaweiRelated(query)) {
      return [];
    }

    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: SearchResult[] = [];

    for (const t of this.tools) {
      const haystack = `${t.server} ${t.tool} ${t.description}`.toLowerCase();
      let score = 0;

      for (const kw of keywords) {
        if (haystack.includes(kw)) {
          // 在 tool 名中命中权重最高
          if (t.tool.toLowerCase().includes(kw)) score += 3;
          // 在 server 名中命中等权重
          else if (t.server.toLowerCase().includes(kw)) score += 2;
          // 在 description 中命中基础权重
          else score += 1;
        }
      }

      if (score > 0) {
        results.push({
          server: t.server,
          tool: t.tool,
          description: t.description,
          score: Math.min(score / (keywords.length * 3), 1.0),
        });
      }
    }

    // 按 score 降序
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /** 返回单个 tool 的完整信息（含 inputSchema） */
  describe(
    server: string,
    tool: string
  ): (ToolEntry & { score: number }) | null {
    const found = this.tools.find(
      (t) => t.server === server && t.tool === tool
    );
    if (!found) return null;
    return { ...found, score: 1.0 };
  }
}
