/**
 * CapabilityCatalog — 能力目录
 *
 * 阶段一：启动时从 capability_index.json 加载到内存
 * 阶段二：提供 search/get 查询接口
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { CapabilityEntry, CapabilityIndex } from "./types.js";

const INDEX_PATH = join(__dirname, "..", "..", "data", "capability_index.json");

export class Catalog {
  private index: CapabilityIndex;

  constructor() {
    this.index = this.load();
    process.stderr.write(
      `[catalog] Loaded ${Object.keys(this.index.catalog).length} capabilities\n`
    );
  }

  /** 从文件加载能力索引 */
  private load(): CapabilityIndex {
    try {
      const raw = readFileSync(INDEX_PATH, "utf-8");
      return JSON.parse(raw);
    } catch (err: any) {
      process.stderr.write(`[catalog] WARN: Cannot load index: ${err.message}\n`);
      // 返回空索引，Router 仍可启动，但所有能力搜索返回空
      return { catalog: {}, by_product: {}, by_action: {}, search_index: {} };
    }
  }

  /** 搜索能力 */
  search(query: string, limit = 20): Partial<CapabilityEntry>[] {
    const keywords = this.tokenize(query);
    const matched = new Set<string>();

    for (const kw of keywords) {
      const ids = this.index.search_index[kw];
      if (ids) ids.forEach((id) => matched.add(id));
    }

    // 按 product/action 索引补充
    for (const kw of keywords) {
      const prodIds = this.index.by_product[kw];
      if (prodIds) prodIds.forEach((id) => matched.add(id));

      const actIds = this.index.by_action[kw];
      if (actIds) actIds.forEach((id) => matched.add(id));
    }

    return [...matched]
      .slice(0, limit)
      .map((id) => {
        const e = this.index.catalog[id];
        return {
          capabilityId: e.capabilityId,
          product: e.product,
          resource: e.resource,
          action: e.action,
          summary: e.summary,
          risk: { level: e.risk.level },
          executor_types: Object.entries(e.executors)
            .filter(([, v]) => v !== null)
            .map(([k]) => k),
        };
      });
  }

  /** 获取单个能力完整信息 */
  get(capabilityId: string): CapabilityEntry | undefined {
    return this.index.catalog[capabilityId];
  }

  /** 简单中文分词 */
  private tokenize(text: string): string[] {
    const tokens: string[] = [];
    // 英文/Numbers
    const en = text.match(/[a-zA-Z0-9]+/g) || [];
    tokens.push(...en.map((t) => t.toLowerCase()));
    // 中文字符作为关键词
    const cn = text.match(/[\u4e00-\u9fff]{1,4}/g) || [];
    tokens.push(...cn);
    return [...new Set(tokens)];
  }
}
