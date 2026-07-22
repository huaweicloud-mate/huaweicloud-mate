import type { CapabilityEntry } from "./types.js";
export declare class Catalog {
    private index;
    constructor();
    /** 从文件加载能力索引 */
    private load;
    /** 搜索能力 */
    search(query: string, limit?: number): Partial<CapabilityEntry>[];
    /** 获取单个能力完整信息 */
    get(capabilityId: string): CapabilityEntry | undefined;
    /** 简单中文分词 */
    private tokenize;
}
