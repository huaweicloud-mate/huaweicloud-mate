import type { SubMcp, SubMcpDescriptor } from "./types";

export const subMcpDescriptors: SubMcpDescriptor[] = [
  {
    id: "ecs",
    title: "Elastic Cloud Server (ECS)",
    description: "ECS OpenAPI child MCP. Loaded only when the caller provisions or invokes ECS.",
    sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/ECS/doc?api=NovaListVersions",
  },
  {
    id: "obs",
    title: "Object Storage Service (OBS)",
    description: "OBS OpenAPI child MCP. Loaded only when the caller provisions or invokes OBS.",
    sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/OBS/doc?api=AppendObject",
  },
];

const loaders: Record<SubMcp["id"], () => Promise<{ subMcp: SubMcp }>> = {
  ecs: () => import("./ecs.js"),
  obs: () => import("./obs.js"),
};

const loaded = new Map<SubMcp["id"], Promise<SubMcp>>();

export function findSubMcpDescriptor(id: string): SubMcpDescriptor {
  const descriptor = subMcpDescriptors.find((candidate) => candidate.id === id);
  if (!descriptor) throw new Error(`Unknown Huawei Cloud child MCP: ${id}`);
  return descriptor;
}

export async function loadSubMcp(id: string): Promise<SubMcp> {
  const descriptor = findSubMcpDescriptor(id);
  let child = loaded.get(descriptor.id);
  if (!child) {
    child = loaders[descriptor.id]().then(({ subMcp }) => subMcp);
    loaded.set(descriptor.id, child);
  }
  return child;
}
