"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Catalog = void 0;
/**
 * CapabilityCatalog — 能力目录
 *
 * 阶段一：启动时从 capability_index.json 加载到内存
 * 阶段二：提供 search/get 查询接口
 */
const fs_1 = require("fs");
const path_1 = require("path");
const INDEX_PATH = (0, path_1.join)(__dirname, "..", "..", "data", "capability_index.json");
class Catalog {
    index;
    constructor() {
        this.index = this.load();
        process.stderr.write(`[catalog] Loaded ${Object.keys(this.index.catalog).length} capabilities\n`);
    }
    /** 从文件加载能力索引 */
    load() {
        try {
            const raw = (0, fs_1.readFileSync)(INDEX_PATH, "utf-8");
            return JSON.parse(raw);
        }
        catch (err) {
            process.stderr.write(`[catalog] WARN: Cannot load index: ${err.message}\n`);
            // 返回空索引，Router 仍可启动，但所有能力搜索返回空
            return { catalog: {}, by_product: {}, by_action: {}, search_index: {} };
        }
    }
    /** 搜索能力 */
    search(query, limit = 20) {
        const keywords = this.tokenize(query);
        const matched = new Set();
        for (const kw of keywords) {
            const ids = this.index.search_index[kw];
            if (ids)
                ids.forEach((id) => matched.add(id));
        }
        // 按 product/action 索引补充
        for (const kw of keywords) {
            const prodIds = this.index.by_product[kw];
            if (prodIds)
                prodIds.forEach((id) => matched.add(id));
            const actIds = this.index.by_action[kw];
            if (actIds)
                actIds.forEach((id) => matched.add(id));
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
    get(capabilityId) {
        return this.index.catalog[capabilityId];
    }
    /** 简单中文分词 */
    tokenize(text) {
        const tokens = [];
        // 英文/Numbers
        const en = text.match(/[a-zA-Z0-9]+/g) || [];
        tokens.push(...en.map((t) => t.toLowerCase()));
        // 中文字符作为关键词
        const cn = text.match(/[\u4e00-\u9fff]{1,4}/g) || [];
        tokens.push(...cn);
        return [...new Set(tokens)];
    }
}
exports.Catalog = Catalog;
