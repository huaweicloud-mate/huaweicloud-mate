"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutorRouter = void 0;
/**
 * ExecutorRouter — 执行器路由
 *
 * MCP (stdin/stdout) + KooCLI (子进程) + SDK (进程内) + Terraform (plan/apply)
 */
const child_process_1 = require("child_process");
const path_1 = require("path");
const executor_sdk_js_1 = require("./executor-sdk.js");
const executor_terraform_js_1 = require("./executor-terraform.js");
/** KooCLI 安装路径 — 由 koocli-installer 在启动时自动安装 */
const koocli_installer_js_1 = require("./koocli-installer.js");
/** Mock MCP Server 路径 — 本地联调用 */
const MOCK_ECS_SERVER = (0, path_1.join)(__dirname, "..", "..", "dist", "mock", "ecs-mock-server.js");
const MCP_SERVERS = {
    // Mock（本地联调）
    "ecs-mock-server": { bin: "node", args: [(0, path_1.join)(__dirname, "..", "mock", "ecs-mock-server.js")] },
    // 产品部开发的真实 MCP Server（来自 huaweicloud-mcp 仓库）
    "obs-server": { bin: "python3", args: [(0, path_1.join)(__dirname, "..", "..", "..", "huaweicloud-mcp", "src", "obs-server", "server.py")] },
    "nat-server": { bin: "python3", args: ["-m", "huaweicloud.nat.server"],
        env: { PYTHONPATH: (0, path_1.join)(__dirname, "..", "..", "..", "huaweicloud-mcp", "src", "nat-server") } },
};
class ExecutorRouter {
    sdkExecutor = new executor_sdk_js_1.SDKExecutor();
    terraformExecutor = new executor_terraform_js_1.TerraformExecutor();
    async execute(capabilityId, executor, params, credentials, correlationId, toolOverride) {
        if (executor === "mcp") {
            return this.executeMCP(capabilityId, params, credentials, correlationId, undefined, toolOverride);
        }
        if (executor === "koocli") {
            return this.executeKooCLI(capabilityId, params, credentials, correlationId, undefined);
        }
        if (executor === "sdk") {
            return this.sdkExecutor.execute(capabilityId, params, credentials, correlationId);
        }
        if (executor === "terraform") {
            const planResult = await this.terraformExecutor.plan(capabilityId, params, credentials, correlationId);
            if (!planResult.success)
                return planResult;
            return this.terraformExecutor.apply(planResult.tfDir, correlationId);
        }
        throw new Error(`Unsupported executor: ${executor}`);
    }
    /** MCP 路径：直接 spawn MCP Server 子进程，通过 stdio JSON-RPC 通信 */
    async executeMCP(capabilityId, params, credentials, correlationId, _startTime, toolOverride) {
        const startTime = Date.now();
        const entry = this.resolveMCPServer(capabilityId, toolOverride);
        if (!entry) {
            return {
                success: false,
                error: {
                    classification: "PROVIDER_UNAVAILABLE",
                    message: `MCP Server 未找到。capabilityId=${capabilityId}`,
                },
                execution: { executor: "mcp", correlationId, duration_ms: Date.now() - startTime },
            };
        }
        return this.callMCPServer(entry, params, credentials, correlationId, startTime);
    }
    /** 根据 capabilityId 找到对应的 MCP Server */
    resolveMCPServer(capabilityId, toolOverride) {
        const match = capabilityId.match(/^huaweicloud\.(\w+)\./);
        if (!match)
            return null;
        const product = match[1];
        const serverConfig = MCP_SERVERS[`${product}-server`] || MCP_SERVERS[`${product}-mock-server`];
        if (!serverConfig)
            return null;
        // tool 名：优先使用 Catalog 中的真实名称，否则自动生成
        const parts = capabilityId.split(".");
        const resource = parts[2];
        const action = parts[3];
        const plural = resource.endsWith("s") ? resource : resource + "s";
        const generated = `${parts[1]}_${action}_${plural}`;
        return { ...serverConfig, tool: toolOverride || generated };
    }
    /** 通过 stdio 调用 MCP Server */
    async callMCPServer(server, params, credentials, correlationId, startTime) {
        return new Promise((resolve) => {
            const env = {
                ...process.env,
                ...(server.env || {}), // Server 专属环境变量 (如 PYTHONPATH)
                HUAWEICLOUD_ACCESS_KEY: credentials.huaweicloud_access_key,
                HUAWEICLOUD_SECRET_KEY: credentials.huaweicloud_secret_key,
                HUAWEICLOUD_REGION: credentials.huaweicloud_region || "",
            };
            const proc = (0, child_process_1.spawn)(server.bin, server.args, {
                env,
                stdio: ["pipe", "pipe", "pipe"],
                timeout: 30_000,
            });
            let stdout = "";
            let stderr = "";
            let resolved = false;
            const done = (result) => {
                if (!resolved) {
                    resolved = true;
                    proc.kill();
                    resolve(result);
                }
            };
            proc.stdout.on("data", (data) => {
                stdout += data.toString();
                // 尝试解析 JSON-RPC 响应（MCP 一行一个 JSON）
                const lines = stdout.split("\n");
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.id && (msg.result !== undefined || msg.error)) {
                            // 这是对 call_tool 的响应
                            const text = msg.result?.content?.[0]?.text;
                            if (text) {
                                done({
                                    success: true,
                                    data: JSON.parse(text),
                                    execution: { executor: "mcp", correlationId, duration_ms: Date.now() - startTime },
                                });
                            }
                            else if (msg.error) {
                                done({
                                    success: false,
                                    error: { classification: "INTERNAL_ERROR", message: JSON.stringify(msg.error) },
                                    execution: { executor: "mcp", correlationId, duration_ms: Date.now() - startTime },
                                });
                            }
                        }
                    }
                    catch { }
                }
            });
            proc.stderr.on("data", (data) => {
                stderr += data.toString();
            });
            proc.on("close", (code) => {
                if (!resolved) {
                    done({
                        success: false,
                        error: {
                            classification: "INTERNAL_ERROR",
                            message: `MCP Server 异常退出 (exit ${code}): ${stderr.slice(0, 500)}`,
                        },
                        execution: { executor: "mcp", correlationId, duration_ms: Date.now() - startTime },
                    });
                }
            });
            proc.on("error", (err) => {
                done({
                    success: false,
                    error: { classification: "INTERNAL_ERROR", message: `MCP Server 启动失败: ${err.message}` },
                    execution: { executor: "mcp", correlationId, duration_ms: Date.now() - startTime },
                });
            });
            // 发送 MCP initialize
            proc.stdin.write(JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "huaweicloud-mate", version: "1.0.0" } },
            }) + "\n");
            // 等待 initialize 响应后再发 tools/call（真实 MCP Server 需要完整握手）
            setTimeout(() => {
                proc.stdin.write(JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/call",
                    params: { name: server.tool, arguments: params },
                }) + "\n");
            }, 500); // 给 Python asyncio 事件循环足够时间处理 initialize
        });
    }
    /** KooCLI 路径：子进程执行 */
    async executeKooCLI(capabilityId, params, credentials, correlationId, _startTime) {
        const startTime = Date.now();
        // 对于 Capability Catalog 中的 KooCLI 条目，params 中应包含 service 和 operation
        // 对于未映射的调用，尝试从 capabilityId 推断
        const service = params._service || "";
        const operation = params._operation || "";
        if (!service || !operation) {
            return {
                success: false,
                error: {
                    classification: "VALIDATION_FAILED",
                    message: `KooCLI 调用需要 _service 和 _operation 参数。capabilityId=${capabilityId}`,
                },
                execution: {
                    executor: "koocli",
                    correlationId,
                    duration_ms: Date.now() - startTime,
                },
            };
        }
        // 构建 KooCLI 参数数组 (AK/SK 通过 CLI 参数传递)
        const args = [
            koocli_installer_js_1.KooCLI_BINARY_PATH, service, operation,
            "--cli-output=json",
            "--cli-access-key", credentials.huaweicloud_access_key,
            "--cli-secret-key", credentials.huaweicloud_secret_key,
            "--cli-skip-secure-verify=true",
        ];
        for (const [key, value] of Object.entries(params)) {
            if (key.startsWith("_") || value === null || value === undefined)
                continue;
            // 跳过已由 service/operation 处理的参数
            if (key === "service" || key === "operation")
                continue;
            args.push(`--${key}=${value}`);
        }
        const env = {
            ...process.env,
            HUAWEICLOUD_ACCESS_KEY: credentials.huaweicloud_access_key,
            HUAWEICLOUD_SECRET_KEY: credentials.huaweicloud_secret_key,
            HUAWEICLOUD_REGION: credentials.huaweicloud_region || "",
        };
        return new Promise((resolve) => {
            const proc = (0, child_process_1.spawn)(koocli_installer_js_1.KooCLI_BINARY_PATH, args.slice(1), {
                env,
                stdio: ["pipe", "pipe", "pipe"],
                timeout: 30_000,
            });
            proc.stdin.write("y\n"); // 接受隐私政策（首次运行）
            let stdout = "";
            let stderr = "";
            proc.stdout.on("data", (data) => {
                stdout += data.toString();
                if (stdout.length > 1_000_000) {
                    proc.kill();
                }
            });
            proc.stderr.on("data", (data) => {
                stderr += data.toString();
            });
            proc.on("close", (code) => {
                // 脱敏
                stdout = this.redact(stdout, credentials);
                stderr = this.redact(stderr, credentials);
                if (code === 0) {
                    try {
                        const data = JSON.parse(stdout);
                        resolve({
                            success: true,
                            data,
                            execution: {
                                executor: "koocli",
                                correlationId,
                                duration_ms: Date.now() - startTime,
                            },
                        });
                    }
                    catch {
                        resolve({
                            success: true,
                            data: { raw: stdout.slice(0, 1000) },
                            execution: {
                                executor: "koocli",
                                correlationId,
                                duration_ms: Date.now() - startTime,
                            },
                        });
                    }
                }
                else {
                    resolve({
                        success: false,
                        error: {
                            classification: this.classifyError(stderr),
                            message: stderr.slice(0, 500) || `Exit code: ${code}`,
                        },
                        execution: {
                            executor: "koocli",
                            correlationId,
                            duration_ms: Date.now() - startTime,
                        },
                    });
                }
            });
            proc.on("error", (err) => {
                resolve({
                    success: false,
                    error: {
                        classification: "INTERNAL_ERROR",
                        message: `KooCLI 执行失败: ${err.message}`,
                    },
                    execution: {
                        executor: "koocli",
                        correlationId,
                        duration_ms: Date.now() - startTime,
                    },
                });
            });
        });
    }
    /** 脱敏 — 把 AK/SK 替换为 REDACTED */
    redact(text, creds) {
        let result = text;
        if (creds.huaweicloud_access_key) {
            result = result.replaceAll(creds.huaweicloud_access_key, "***REDACTED***");
        }
        if (creds.huaweicloud_secret_key) {
            result = result.replaceAll(creds.huaweicloud_secret_key, "***REDACTED***");
        }
        return result;
    }
    /** 错误分类 */
    classifyError(stderr) {
        const patterns = [
            [/APIGW\.0301/, "AUTH_INVALID_CREDENTIALS"],
            [/APIGW\.0305/, "RATE_LIMITED"],
            [/APIGW\.0311/, "PERMISSION_DENIED"],
            [/APIGW\.0308/, "RESOURCE_NOT_FOUND"],
            [/APIGW\.0303/, "VALIDATION_FAILED"],
            [/timeout|ETIMEDOUT/i, "UPSTREAM_TIMEOUT"],
            [/ENOENT|not found/, "PROVIDER_UNAVAILABLE"],
        ];
        for (const [pattern, cls] of patterns) {
            if (pattern.test(stderr))
                return cls;
        }
        return "UNKNOWN";
    }
    /** 健康检查 */
    async healthCheck() {
        const result = {};
        // MCP 健康检查：探测每个已注册的 MCP Server
        for (const [name, cfg] of Object.entries(MCP_SERVERS)) {
            try {
                await this.probeMCPServer(name, cfg);
                result[name] = { status: "available" };
            }
            catch (err) {
                result[name] = { status: "unavailable", message: err.message };
            }
        }
        // KooCLI 健康检查
        try {
            await new Promise((resolve, reject) => {
                const proc = (0, child_process_1.spawn)(koocli_installer_js_1.KooCLI_BINARY_PATH, ["--version"], {
                    stdio: ["pipe", "pipe", "pipe"],
                    timeout: 5000,
                });
                proc.stdin.write("y\n");
                proc.on("close", (code) => {
                    if (code === 0)
                        resolve();
                    else
                        reject(new Error(`Exit ${code}`));
                });
                proc.on("error", reject);
            });
            result["koocli"] = { status: "available" };
        }
        catch (err) {
            result["koocli"] = { status: "unavailable", message: err.message };
        }
        // SDK 健康检查
        try {
            const sdkHealth = await this.sdkExecutor.healthCheck();
            Object.assign(result, sdkHealth);
        }
        catch { }
        // Terraform 健康检查
        try {
            const tfHealth = await this.terraformExecutor.healthCheck();
            Object.assign(result, tfHealth);
        }
        catch { }
        return result;
    }
    /** 探测单个 MCP Server：spawn → initialize → 验证响应 */
    async probeMCPServer(name, cfg) {
        return new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)(cfg.bin, cfg.args, {
                env: { ...process.env, ...(cfg.env || {}) },
                stdio: ["pipe", "pipe", "pipe"],
                timeout: 8000,
            });
            let stdout = "";
            const timer = setTimeout(() => {
                proc.kill();
                reject(new Error("Health probe timeout"));
            }, 7000);
            proc.stdout.on("data", (data) => {
                stdout += data.toString();
                try {
                    const msg = JSON.parse(stdout.split("\n")[0]);
                    if (msg.id && msg.result) {
                        clearTimeout(timer);
                        proc.kill();
                        resolve();
                    }
                }
                catch { }
            });
            proc.on("close", (code) => {
                clearTimeout(timer);
                if (code === 0)
                    reject(new Error("Server exited without response"));
                reject(new Error(`Exit ${code}`));
            });
            proc.on("error", (err) => {
                clearTimeout(timer);
                reject(err);
            });
            // 发送 initialize
            proc.stdin.write(JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "health-probe", version: "1.0" } },
            }) + "\n");
        });
    }
}
exports.ExecutorRouter = ExecutorRouter;
