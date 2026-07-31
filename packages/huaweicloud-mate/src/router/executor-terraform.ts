import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { CredentialConfig, ExecutionResult } from "./types.js";

const TF_DIR = join(homedir(), ".huaweicloud-tf");
const TF_BINARY = "terraform";

interface TerraformResult extends ExecutionResult {
  planOutput?: string;
  applyOutput?: string;
  tfDir?: string;
}

export class TerraformExecutor {
  async plan(
    capabilityId: string,
    params: Record<string, any>,
    credentials: CredentialConfig,
    correlationId: string
  ): Promise<TerraformResult> {
    const startTime = Date.now();
    const resourceType = this.resolveResource(capabilityId);

    if (!resourceType) {
      return {
        success: false,
        error: {
          classification: "VALIDATION_FAILED",
          message: `Terraform: unknown resource mapping for ${capabilityId}`,
        },
        execution: { executor: "terraform", correlationId, duration_ms: Date.now() - startTime },
      };
    }

    const tfDir = join(TF_DIR, correlationId);
    mkdirSync(tfDir, { recursive: true });

    const hcl = this.generateHCL(resourceType, params, credentials);
    writeFileSync(join(tfDir, "main.tf"), hcl);

    const initResult = await this.runTerraform(tfDir, ["init"], correlationId);
    if (!initResult.success) {
      return { ...initResult, tfDir };
    }

    const planResult = await this.runTerraform(tfDir, ["plan", "-no-color"], correlationId);

    return {
      ...planResult,
      tfDir,
      execution: { executor: "terraform", correlationId, duration_ms: Date.now() - startTime },
    };
  }

  async apply(
    tfDir: string,
    correlationId: string
  ): Promise<TerraformResult> {
    const startTime = Date.now();
    const result = await this.runTerraform(tfDir, ["apply", "-auto-approve", "-no-color"], correlationId);
    return {
      ...result,
      execution: { executor: "terraform", correlationId, duration_ms: Date.now() - startTime },
    };
  }

  private generateHCL(resourceType: string, params: Record<string, any>, credentials: CredentialConfig): string {
    const { huaweicloud_access_key: ak, huaweicloud_secret_key: sk } = credentials;
    const region = params.region || credentials.huaweicloud_region || "";
    const name = params.name || params.server_name || params.instance_name || resourceType;

    let hcl = `terraform {
  required_providers {
    huaweicloud = {
      source  = "huaweicloud/huaweicloud"
      version = "~> 1.60"
    }
  }
}

provider "huaweicloud" {
  access_key = "${ak}"
  secret_key = "${sk}"
  region     = "${region}"
}

`;

    hcl += this.generateResourceBlock(resourceType, name, params);
    return hcl;
  }

  private generateResourceBlock(resourceType: string, name: string, params: Record<string, any>): string {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").toLowerCase();

    const block = [`resource "${resourceType}" "${safeName}" {`];

    for (const [key, value] of Object.entries(params)) {
      if (key === "region" || key === "_service" || key === "_operation" || key === "name") continue;
      if (value === null || value === undefined) continue;
      if (typeof value === "string") {
        block.push(`  ${key} = "${value}"`);
      } else if (typeof value === "number" || typeof value === "boolean") {
        block.push(`  ${key} = ${value}`);
      } else if (typeof value === "object") {
        block.push(`  ${key} = ${JSON.stringify(value)}`);
      }
    }

    block.push("}");
    return block.join("\n") + "\n";
  }

  private resolveResource(capabilityId: string): string | null {
    return RESOURCE_MAP[capabilityId] || null;
  }

  private async runTerraform(
    cwd: string,
    args: string[],
    correlationId: string
  ): Promise<TerraformResult> {
    const startTime = Date.now();
    return new Promise((resolve) => {
      const proc = spawn(TF_BINARY, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
        env: { ...process.env, TF_IN_AUTOMATION: "true" },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        const output = `${stdout}\n${stderr}`;
        resolve({
          success: code === 0,
          data: code === 0 ? { output } : undefined,
          error: code !== 0 ? {
            classification: "INTERNAL_ERROR",
            message: `Terraform ${args[0]} failed (exit ${code}): ${stderr.slice(0, 500)}`,
          } : undefined,
          execution: { executor: "terraform", correlationId, duration_ms: Date.now() - startTime },
        });
      });

      proc.on("error", (err) => {
        resolve({
          success: false,
          error: {
            classification: "PROVIDER_UNAVAILABLE",
            message: `Terraform not found: ${err.message}. Install: https://developer.hashicorp.com/terraform/install`,
          },
          execution: { executor: "terraform", correlationId, duration_ms: Date.now() - startTime },
        });
      });
    });
  }

  async healthCheck(): Promise<Record<string, { status: string; message?: string }>> {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(TF_BINARY, ["version"], {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        });
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
        proc.on("error", reject);
      });
      return { terraform: { status: "available" } };
    } catch (err: any) {
      return { terraform: { status: "unavailable", message: err.message } };
    }
  }
}

const RESOURCE_MAP: Record<string, string> = {
  "huaweicloud.ecs.server.create.v1": "huaweicloud_compute_instance",
};
