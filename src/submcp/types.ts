import type { JsonObject } from "../openapi";

export interface SubMcpOperation {
  id: string;
  description: string;
  isReadOnly: boolean;
  requiresConfirmation?(input: JsonObject): boolean;
  inputSchema: JsonObject;
  sourceUrl: string;
  execute(input: JsonObject): Promise<unknown>;
}

export interface SubMcp {
  id: "ecs" | "obs";
  title: string;
  description: string;
  sourceUrl: string;
  operations: SubMcpOperation[];
}

export interface SubMcpDescriptor {
  id: SubMcp["id"];
  title: string;
  description: string;
  sourceUrl: string;
}
