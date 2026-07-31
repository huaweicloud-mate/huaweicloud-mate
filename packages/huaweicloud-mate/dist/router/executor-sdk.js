"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SDKExecutor = void 0;
const child_process_1 = require("child_process");
const SDK_INSTALLED = new Set();
class SDKExecutor {
    async execute(capabilityId, params, credentials, correlationId) {
        const startTime = Date.now();
        const product = this.extractProduct(capabilityId);
        const method = this.resolveMethod(capabilityId);
        if (!product || !method) {
            return {
                success: false,
                error: {
                    classification: "VALIDATION_FAILED",
                    message: `SDK: cannot resolve product/method from ${capabilityId}`,
                },
                execution: { executor: "sdk", correlationId, duration_ms: Date.now() - startTime },
            };
        }
        const pkg = productToPackage[product];
        if (!pkg) {
            return {
                success: false,
                error: {
                    classification: "PROVIDER_UNAVAILABLE",
                    message: `SDK: no package mapping for product '${product}'`,
                },
                execution: { executor: "sdk", correlationId, duration_ms: Date.now() - startTime },
            };
        }
        await this.ensureSDK(pkg);
        return this.callSDK(pkg, method, params, credentials, correlationId, startTime);
    }
    extractProduct(capabilityId) {
        const m = capabilityId.match(/^huaweicloud\.(\w+)\./);
        return m ? m[1] : null;
    }
    resolveMethod(capabilityId) {
        const parts = capabilityId.split(".");
        if (parts.length < 4)
            return null;
        const action = parts[3];
        const resource = parts[2];
        return camelAction(resource, action);
    }
    async ensureSDK(pkg) {
        if (SDK_INSTALLED.has(pkg))
            return;
        try {
            require.resolve(pkg);
            SDK_INSTALLED.add(pkg);
            return;
        }
        catch { }
        process.stderr.write(`[sdk] Installing ${pkg} on demand...\n`);
        await new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)("npm", ["install", "--no-save", pkg], {
                stdio: ["pipe", "pipe", "pipe"],
                timeout: 120_000,
                cwd: process.env.HOME || "/tmp",
            });
            proc.on("close", (code) => {
                if (code === 0) {
                    SDK_INSTALLED.add(pkg);
                    resolve();
                }
                else {
                    reject(new Error(`npm install ${pkg} failed (exit ${code})`));
                }
            });
            proc.on("error", reject);
        });
    }
    async callSDK(pkg, method, params, credentials, correlationId, startTime) {
        try {
            const mod = require(pkg);
            const ClientClass = findClientClass(mod, method);
            if (!ClientClass) {
                return {
                    success: false,
                    error: { classification: "VALIDATION_FAILED", message: `SDK: no client class for ${method}` },
                    execution: { executor: "sdk", correlationId, duration_ms: Date.now() - startTime },
                };
            }
            const { huaweicloud_access_key: ak, huaweicloud_secret_key: sk } = credentials;
            const region = params.region || credentials.huaweicloud_region || "";
            const client = new ClientClass({
                credential: {
                    ak,
                    sk,
                },
                region,
            });
            delete params.region;
            delete params._service;
            delete params._operation;
            const result = await client[method](params);
            return {
                success: true,
                data: result,
                execution: { executor: "sdk", correlationId, duration_ms: Date.now() - startTime },
            };
        }
        catch (err) {
            return {
                success: false,
                error: {
                    classification: err.statusCode === 401 ? "AUTH_INVALID_CREDENTIALS" : "INTERNAL_ERROR",
                    message: err.message,
                },
                execution: { executor: "sdk", correlationId, duration_ms: Date.now() - startTime },
            };
        }
    }
    async healthCheck() {
        const installed = [];
        for (const pkg of Object.values(productToPackage)) {
            try {
                require.resolve(pkg);
                installed.push(pkg);
            }
            catch { }
        }
        return { sdk: { status: installed.length > 0 ? `available (${installed.length} packages)` : "unavailable" } };
    }
}
exports.SDKExecutor = SDKExecutor;
const productToPackage = {
    ecs: "@huaweicloud/huaweicloud-sdk-ecs",
    obs: "@huaweicloud/huaweicloud-sdk-obs",
    vpc: "@huaweicloud/huaweicloud-sdk-vpc",
    iam: "@huaweicloud/huaweicloud-sdk-iam",
};
function camelAction(resource, action) {
    const r = resource.replace(/_(\w)/g, (_, c) => c.toUpperCase());
    const verbs = {
        list: `list${capitalize(r)}`,
        describe: `show${capitalize(r)}`,
        create: `create${capitalize(r)}`,
        delete: `delete${capitalize(r)}`,
        update: `update${capitalize(r)}`,
    };
    if (verbs[action])
        return verbs[action];
    const parts = action.split("_");
    return parts[0] + parts.slice(1).map(capitalize).join("") + capitalize(r);
}
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
function findClientClass(mod, method) {
    for (const key of Object.keys(mod)) {
        if (key.endsWith("Client") && typeof mod[key] === "function" && mod[key].prototype) {
            if (typeof mod[key].prototype[method] === "function")
                return mod[key];
        }
    }
    for (const key of Object.keys(mod)) {
        if (key.endsWith("Client") && typeof mod[key] === "function" && mod[key].prototype) {
            return mod[key];
        }
    }
    return null;
}
