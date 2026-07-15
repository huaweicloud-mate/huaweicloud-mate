/*
 * Imports the operation metadata exposed by the official Huawei Cloud Node.js
 * SDKs.  This is a build-time tool: runtime remains the lightweight MCP
 * gateway and does not bundle either SDK.
 */
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const root = join(__dirname, "..");
const generated = join(root, "src", "generated");
const versions = {
  ecs: { name: "@huaweicloud/huaweicloud-sdk-ecs", version: "3.1.205" },
  obs: { name: "esdk-obs-nodejs", version: "3.26.2" },
};

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function npmInvocation(args) {
  // execFile cannot reliably spawn a .cmd shim from all supported Node 24
  // Windows builds. Invoke npm's JavaScript entry point with this Node binary.
  if (process.platform === "win32") {
    const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    return { command: process.execPath, args: [npmCli, ...args] };
  }
  return { command: "npm", args };
}

function unpack(packageInfo, workspace) {
  mkdirSync(workspace, { recursive: true });
  const invocation = npmInvocation(["pack", `${packageInfo.name}@${packageInfo.version}`, "--pack-destination", workspace, "--json"]);
  const packed = JSON.parse(run(invocation.command, invocation.args));
  const archive = join(workspace, packed[0].filename);
  const destination = join(workspace, "package");
  mkdirSync(destination);
  run("tar", ["-xf", archive, "-C", destination]);
  return join(destination, "package");
}

function snakeCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

function pascalCase(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function functionBlocks(source) {
  const factory = source.slice(source.indexOf("const ParamCreater"));
  const start = /^        ([a-z][A-Za-z0-9_]*)\([^\r\n]*Request\) \{/gm;
  const entries = [];
  let match;
  while ((match = start.exec(factory))) {
    let depth = 0;
    let end = match.index;
    for (; end < factory.length; end += 1) {
      if (factory[end] === "{") depth += 1;
      if (factory[end] === "}" && --depth === 0) { end += 1; break; }
    }
    entries.push({ name: match[1], body: factory.slice(match.index, end), prefix: factory.slice(Math.max(0, match.index - 2000), match.index) });
  }
  return entries;
}

function schemaForEcsType(type, modelDirectory, cache, stack = new Set()) {
  const normalized = type.replace(/\s*\|\s*undefined/g, "").trim();
  if (normalized === "string") return { type: "string" };
  if (normalized === "number") return { type: "number" };
  if (normalized === "boolean") return { type: "boolean" };
  const array = /^(?:Array<(.+)>|(.+)\[\])$/.exec(normalized);
  if (array) return { type: "array", items: schemaForEcsType(array[1] || array[2], modelDirectory, cache, stack) };
  if (["any", "object", "unknown"].includes(normalized) || normalized.includes("Record<")) return {};
  return schemaForEcsModel(normalized, modelDirectory, cache, stack);
}

function schemaForEcsModel(className, modelDirectory, cache, stack = new Set()) {
  if (cache.has(className)) return cache.get(className);
  if (stack.has(className)) return {};
  const filename = join(modelDirectory, `${className}.d.ts`);
  let source;
  try { source = readFileSync(filename, "utf8"); } catch { return {}; }
  const nextStack = new Set(stack);
  nextStack.add(className);
  const aliases = [...source.matchAll(/private '([^']+)'\?;/g)].map((entry) => entry[1]);
  const directProperties = [...source.matchAll(/^\s+(\w+)\??:\s*([^;]+);/gm)];
  const getters = [...source.matchAll(/get (\w+)\(\): ([^;]+);/g)];
  const properties = {};
  directProperties.forEach((entry) => {
    properties[entry[1]] = schemaForEcsType(entry[2], modelDirectory, cache, nextStack);
  });
  getters.forEach((entry, index) => {
    const name = aliases[index] || entry[1];
    properties[name] = schemaForEcsType(entry[2], modelDirectory, cache, nextStack);
  });
  const schema = Object.keys(properties).length ? { type: "object", properties } : {};
  cache.set(className, schema);
  return schema;
}

function ecsCatalog(source, modelDirectory) {
  const schemaCache = new Map();
  return functionBlocks(source).map(({ name, body, prefix }) => {
    const method = /method:\s*"([A-Z]+)"/.exec(body)?.[1];
    const path = /url:\s*"([^"]+)"/.exec(body)?.[1];
    if (!method || !path) throw new Error(`Could not parse method/path for ECS operation ${name}.`);
    const assigned = new Map();
    for (const entry of body.matchAll(/(\w+)\s*=\s*\w+Request\['([^']+)'\]/g)) assigned.set(entry[1], entry[2]);
    const requiredVariables = [...body.matchAll(/RequiredError\('(\w+)'/g)].map((entry) => entry[1]);
    const pathParameters = {};
    for (const entry of body.matchAll(/'([^']+)'\s*:\s*(\w+),/g)) {
      const input = assigned.get(entry[2]);
      if (input && entry[1] !== "Content-Type") pathParameters[entry[1]] = input;
    }
    const queryParameters = {};
    for (const entry of body.matchAll(/localVarQueryParameter\['([^']+)'\]\s*=\s*(\w+);/g)) {
      const input = assigned.get(entry[2]);
      if (input) queryParameters[entry[1]] = input;
    }
    const headerParameters = {};
    for (const entry of body.matchAll(/localVarHeaderParameter\['([^']+)'\]\s*=\s*String\((\w+)\);/g)) {
      const input = assigned.get(entry[2]);
      if (input && entry[1].toLowerCase() !== "content-type") headerParameters[entry[1]] = input;
    }
    const summary = /@summary\s+([^\r\n]+)/.exec(prefix)?.[1]?.trim() || `ECS API Explorer operation ${pascalCase(name)}.`;
    const required = [...new Set(requiredVariables.map((variable) => assigned.get(variable) || variable))];
    const inputNames = [...new Set([...Object.values(pathParameters), ...Object.values(queryParameters), ...Object.values(headerParameters), ...required])];
    const requestClass = `${pascalCase(name)}Request`;
    let bodySchema;
    let inputSchemas = {};
    try {
      const requestModel = readFileSync(join(modelDirectory, `${requestClass}.d.ts`), "utf8");
      const bodyType = /get body\(\): ([^;]+);/.exec(requestModel)?.[1] || /^\s*body\??:\s*([^;]+);/m.exec(requestModel)?.[1];
      if (bodyType) bodySchema = schemaForEcsType(bodyType, modelDirectory, schemaCache);
      const requestSchema = schemaForEcsModel(requestClass, modelDirectory, schemaCache);
      if (requestSchema.properties) inputSchemas = requestSchema.properties;
    } catch { /* Some generated requests have no model class. */ }
    return {
      id: `api_${snakeCase(name)}`,
      apiName: pascalCase(name),
      method,
      path,
      description: summary,
      required,
      pathParameters,
      queryParameters,
      headerParameters,
      inputNames,
      ...(bodySchema ? { bodySchema } : {}),
      inputSchemas,
    };
  });
}

function obsCatalog(modelPath) {
  // obsModel.js has no dependencies and exports the fully expanded operation
  // descriptors used by the official OBS SDK.
  const operations = require(modelPath);
  return Object.entries(operations)
    .filter(([, definition]) => definition && typeof definition.httpMethod === "string")
    .map(([apiName, definition]) => ({
      id: `api_${snakeCase(apiName)}`,
      apiName,
      method: definition.httpMethod,
      description: `OBS API Explorer operation ${apiName}.`,
      urlPath: definition.urlPath,
      parameters: definition.parameters || {},
      data: definition.data || {},
    }));
}

function main() {
  const workspace = mkdtempSync(join(tmpdir(), "huaweicloud-mate-catalog-"));
  try {
    const ecs = unpack(versions.ecs, join(workspace, "ecs"));
    const obs = unpack(versions.obs, join(workspace, "obs"));
    const ecsOperations = ecsCatalog(readFileSync(join(ecs, "v2", "EcsClient.js"), "utf8"), join(ecs, "v2", "model"));
    const obsOperations = obsCatalog(join(obs, "lib", "obsModel.js"));
    if (ecsOperations.length !== 99 || obsOperations.length !== 81) throw new Error(`Unexpected catalog size: ECS=${ecsOperations.length}, OBS=${obsOperations.length}. Review upstream SDK changes before updating the expected counts.`);
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, "ecs-catalog.json"), `${JSON.stringify(ecsOperations, null, 2)}\n`);
    writeFileSync(join(generated, "obs-catalog.json"), `${JSON.stringify(obsOperations, null, 2)}\n`);
    writeFileSync(join(generated, "catalog-manifest.json"), `${JSON.stringify({ sources: versions, counts: { ecs: ecsOperations.length, obs: obsOperations.length } }, null, 2)}\n`);
    process.stdout.write(`Generated ECS (${ecsOperations.length}) and OBS (${obsOperations.length}) operation catalogs.\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

main();
