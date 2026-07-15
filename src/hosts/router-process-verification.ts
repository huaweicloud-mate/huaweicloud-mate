import { spawn } from "node:child_process";

import { InstallerError } from "../installer/errors.js";
import type { MaterializedRuntime } from "../installer/runtime.js";

const expectedRouterTools = [
  "cloud_action_execute",
  "cloud_capabilities_search",
  "cloud_capability_describe",
] as const;
const protocolVersion = "2025-11-25";
const probeTimeoutMs = 15_000;
const maxProbeOutputBytes = 1024 * 1024;

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

function failed(message: string): never {
  throw new InstallerError("HOST_VERIFICATION_FAILED", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactRouterToolSet(names: readonly string[]): boolean {
  return names.length === expectedRouterTools.length &&
    [...names].sort().join("\n") === expectedRouterTools.join("\n");
}

function responseResult(response: JsonRpcResponse, id: number): unknown {
  if (
    response.jsonrpc !== "2.0" ||
    response.id !== id ||
    response.error !== undefined ||
    response.result === undefined
  ) {
    return failed("Stable Router returned an invalid MCP response");
  }
  return response.result;
}

export async function verifyStableRouterProcess(
  runtime: MaterializedRuntime,
): Promise<void> {
  const child = spawn(
    runtime.nodePath,
    [runtime.stableLauncherPath, "router", "--stdio"],
    {
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let outputBytes = 0;
  let stdoutBuffer = "";
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const pending = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  const terminate = (message: string): void => {
    if (settled) return;
    settled = true;
    const error = new Error(message);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    child.kill();
  };
  const consumeLine = (line: string): void => {
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return terminate("Stable Router emitted invalid JSON-RPC");
    }
    if (!isRecord(value) || typeof value.id !== "number") {
      return terminate("Stable Router emitted an unexpected JSON-RPC message");
    }
    const waiter = pending.get(value.id);
    if (waiter === undefined) {
      return terminate("Stable Router emitted an unsolicited JSON-RPC response");
    }
    pending.delete(value.id);
    waiter.resolve(value as unknown as JsonRpcResponse);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > maxProbeOutputBytes) {
      terminate("Stable Router process probe output exceeded the limit");
      return;
    }
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      consumeLine(line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > maxProbeOutputBytes) {
      terminate("Stable Router process probe output exceeded the limit");
    }
  });
  child.stdin.on("error", () => terminate("Stable Router process input failed"));
  child.once("error", () => terminate("Stable Router process could not start"));
  child.once("close", () => terminate("Stable Router process exited during the probe"));

  const request = async (id: number, method: string, params?: unknown) => {
    if (settled || child.stdin.destroyed) {
      return failed("Stable Router process is unavailable");
    }
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })}\n`);
    return response;
  };

  try {
    timer = setTimeout(
      () => terminate("Stable Router process probe timed out"),
      probeTimeoutMs,
    );
    const initialized = responseResult(
      await request(1, "initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: {
          name: "huaweicloud-mate-install-verifier",
          version: runtime.pluginVersion,
        },
      }),
      1,
    );
    if (
      !isRecord(initialized) ||
      initialized.protocolVersion !== protocolVersion ||
      !isRecord(initialized.serverInfo) ||
      initialized.serverInfo.name !== "huaweicloud-mate" ||
      !isRecord(initialized.capabilities) ||
      !isRecord(initialized.capabilities.tools)
    ) {
      return failed("Stable Router returned invalid MCP initialization evidence");
    }
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })}\n`);
    const listed = responseResult(await request(2, "tools/list", {}), 2);
    if (!isRecord(listed) || !Array.isArray(listed.tools)) {
      return failed("Stable Router returned an invalid MCP tool list");
    }
    const names = listed.tools.map((tool) =>
      isRecord(tool) && typeof tool.name === "string" ? tool.name : ""
    );
    if (!hasExactRouterToolSet(names)) {
      return failed("Stable Router exposed an unexpected MCP tool set");
    }
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    return failed("Stable Router MCP process probe failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    settled = true;
    pending.clear();
    child.stdin.end();
    child.kill();
  }
}
