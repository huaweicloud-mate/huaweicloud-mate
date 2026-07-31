import type { AuditEntry } from "./types.js";
export declare class JsonlAuditWriter {
    private path;
    constructor();
    write(entry: AuditEntry): void;
}
