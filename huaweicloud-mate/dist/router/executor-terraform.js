"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerraformExecutor = void 0;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const TF_DIR = (0, path_1.join)((0, os_1.homedir)(), ".huaweicloud-tf");
const TF_BINARY = "terraform";
class TerraformExecutor {
    async plan(capabilityId, params, credentials, correlationId) {
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
        const tfDir = (0, path_1.join)(TF_DIR, correlationId);
        (0, fs_1.mkdirSync)(tfDir, { recursive: true });
        const hcl = this.generateHCL(resourceType, params, credentials);
        (0, fs_1.writeFileSync)((0, path_1.join)(tfDir, "main.tf"), hcl);
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
    async apply(tfDir, correlationId) {
        const startTime = Date.now();
        const result = await this.runTerraform(tfDir, ["apply", "-auto-approve", "-no-color"], correlationId);
        return {
            ...result,
            execution: { executor: "terraform", correlationId, duration_ms: Date.now() - startTime },
        };
    }
    generateHCL(resourceType, params, credentials) {
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
    generateResourceBlock(resourceType, name, params) {
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").toLowerCase();
        const block = [`resource "${resourceType}" "${safeName}" {`];
        for (const [key, value] of Object.entries(params)) {
            if (key === "region" || key === "_service" || key === "_operation" || key === "name")
                continue;
            if (value === null || value === undefined)
                continue;
            if (typeof value === "string") {
                block.push(`  ${key} = "${value}"`);
            }
            else if (typeof value === "number" || typeof value === "boolean") {
                block.push(`  ${key} = ${value}`);
            }
            else if (typeof value === "object") {
                block.push(`  ${key} = ${JSON.stringify(value)}`);
            }
        }
        block.push("}");
        return block.join("\n") + "\n";
    }
    resolveResource(capabilityId) {
        return RESOURCE_MAP[capabilityId] || null;
    }
    async runTerraform(cwd, args, correlationId) {
        const startTime = Date.now();
        return new Promise((resolve) => {
            const proc = (0, child_process_1.spawn)(TF_BINARY, args, {
                cwd,
                stdio: ["pipe", "pipe", "pipe"],
                timeout: 120_000,
                env: { ...process.env, TF_IN_AUTOMATION: "true" },
            });
            let stdout = "";
            let stderr = "";
            proc.stdout.on("data", (d) => { stdout += d.toString(); });
            proc.stderr.on("data", (d) => { stderr += d.toString(); });
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
    async healthCheck() {
        try {
            await new Promise((resolve, reject) => {
                const proc = (0, child_process_1.spawn)(TF_BINARY, ["version"], {
                    stdio: ["pipe", "pipe", "pipe"],
                    timeout: 5000,
                });
                proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
                proc.on("error", reject);
            });
            return { terraform: { status: "available" } };
        }
        catch (err) {
            return { terraform: { status: "unavailable", message: err.message } };
        }
    }
}
exports.TerraformExecutor = TerraformExecutor;
const RESOURCE_MAP = {
    "huaweicloud.ecs.server.create.v1": "huaweicloud_compute_instance",
};
