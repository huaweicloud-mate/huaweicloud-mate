const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

function setCredentials() {
  process.env.HUAWEICLOUD_AK = "test-ak";
  process.env.HUAWEICLOUD_SK = "test-sk";
  process.env.HUAWEICLOUD_REGION = "cn-north-4";
  process.env.HUAWEICLOUD_PROJECT_ID = "test-project";
}

test("Windows DPAPI credential storage can be read and cleared for the current user", { concurrency: false, skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "huaweicloud-mate-test-"));
  const credentialFile = join(directory, "credentials.dpapi");
  const originalCredentialFile = process.env.HUAWEICLOUD_CREDENTIAL_FILE;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "$secure = ConvertTo-SecureString -String $env:HUAWEICLOUD_TEST_STORED -AsPlainText -Force; [System.IO.File]::WriteAllText($env:HUAWEICLOUD_CREDENTIAL_FILE, (ConvertFrom-SecureString -SecureString $secure))"], {
      env: { ...process.env, HUAWEICLOUD_CREDENTIAL_FILE: credentialFile, HUAWEICLOUD_TEST_STORED: JSON.stringify({ accessKey: "stored-ak", secretKey: "stored-sk", region: "cn-north-4", projectId: "stored-project" }) },
    });
    process.env.HUAWEICLOUD_CREDENTIAL_FILE = credentialFile;
    const credentials = require("../build/credentials.js");
    assert.deepEqual(credentials.loadStoredCredentials(), { accessKey: "stored-ak", secretKey: "stored-sk", region: "cn-north-4", projectId: "stored-project" });
    credentials.clearStoredCredentials();
    assert.equal(existsSync(credentialFile), false);
  } finally {
    if (originalCredentialFile === undefined) delete process.env.HUAWEICLOUD_CREDENTIAL_FILE;
    else process.env.HUAWEICLOUD_CREDENTIAL_FILE = originalCredentialFile;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ECS deletion keeps EIPs and data disks by default after confirmation", { concurrency: false }, async () => {
  setCredentials();
  const gateway = require("../build/gateway.js");
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ job_id: "delete-job" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const input = { serverIds: ["server-1"] };
    const pending = await gateway.call("ecs", "delete_servers", input);
    assert.equal(pending.status, "confirmation_required");
    assert.equal(request, undefined);
    const result = await gateway.call("ecs", "delete_servers", input, pending.confirmationToken);
    assert.equal(result.body.job_id, "delete-job");
    assert.equal(request.options.method, "POST");
    assert.deepEqual(JSON.parse(request.options.body), { servers: [{ id: "server-1" }], delete_publicip: false, delete_volume: false });
  } finally {
    global.fetch = originalFetch;
  }
});

test("OBS append signs content and requires confirmation", { concurrency: false }, async () => {
  setCredentials();
  const gateway = require("../build/gateway.js");
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(null, { status: 200, headers: { "x-obs-request-id": "append-request", "x-obs-next-append-position": "5" } });
  };
  try {
    const input = { bucket: "example-bucket", key: "notes.txt", position: 0, contentBase64: Buffer.from("hello").toString("base64"), contentType: "text/plain" };
    const pending = await gateway.call("obs", "append_object", input);
    assert.equal(pending.status, "confirmation_required");
    assert.equal(request, undefined);
    const result = await gateway.call("obs", "append_object", input, pending.confirmationToken);
    assert.equal(result.requestId, "append-request");
    assert.equal(result.headers["x-obs-next-append-position"], "5");
    assert.equal(request.url, "https://example-bucket.obs.cn-north-4.myhuaweicloud.com/notes.txt?append&position=0");
    assert.equal(request.options.headers["content-type"], "text/plain");
    assert.match(request.options.headers.authorization, /^OBS test-ak:/);
    assert.equal(Buffer.from(request.options.body).toString(), "hello");
  } finally {
    global.fetch = originalFetch;
  }
});

test("OBS standard upload signs content and requires confirmation", { concurrency: false }, async () => {
  setCredentials();
  const gateway = require("../build/gateway.js");
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(null, { status: 200, headers: { "etag": "etag-1", "x-obs-request-id": "put-request" } });
  };
  try {
    const input = { bucket: "example-bucket", key: "reports/today.txt", contentBase64: Buffer.from("report").toString("base64"), contentType: "text/plain" };
    const pending = await gateway.call("obs", "put_object", input);
    assert.equal(pending.status, "confirmation_required");
    assert.equal(request, undefined);
    const result = await gateway.call("obs", "put_object", input, pending.confirmationToken);
    assert.equal(result.requestId, "put-request");
    assert.equal(request.url, "https://example-bucket.obs.cn-north-4.myhuaweicloud.com/reports/today.txt");
    assert.equal(request.options.method, "PUT");
    assert.equal(request.options.headers["content-type"], "text/plain");
    assert.match(request.options.headers.authorization, /^OBS test-ak:/);
    assert.equal(Buffer.from(request.options.body).toString(), "report");
  } finally {
    global.fetch = originalFetch;
  }
});

test("OBS object reads use a bounded Range request and return base64", { concurrency: false }, async () => {
  setCredentials();
  const gateway = require("../build/gateway.js");
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response("hello", { status: 206, headers: { "content-length": "5", "x-obs-request-id": "get-request" } });
  };
  try {
    const result = await gateway.call("obs", "get_object", { bucket: "example-bucket", key: "reports/today.txt", maxBytes: 64 });
    assert.equal(result.requestId, "get-request");
    assert.equal(result.contentBase64, Buffer.from("hello").toString("base64"));
    assert.equal(request.url, "https://example-bucket.obs.cn-north-4.myhuaweicloud.com/reports/today.txt");
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.headers.range, "bytes=0-63");
    assert.match(request.options.headers.authorization, /^OBS test-ak:/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("OBS server-side copies sign the encoded source header and require confirmation", { concurrency: false }, async () => {
  setCredentials();
  const gateway = require("../build/gateway.js");
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response("<CopyObjectResult><ETag>copied-etag</ETag></CopyObjectResult>", { status: 200, headers: { "x-obs-request-id": "copy-request" } });
  };
  try {
    const input = { bucket: "target-bucket", key: "archive/copy.txt", sourceBucket: "source-bucket", sourceKey: "reports/source file.txt", sourceVersionId: "version-1" };
    const pending = await gateway.call("obs", "copy_object", input);
    assert.equal(pending.status, "confirmation_required");
    assert.equal(request, undefined);
    const result = await gateway.call("obs", "copy_object", input, pending.confirmationToken);
    assert.equal(result.etag, "copied-etag");
    assert.equal(result.requestId, "copy-request");
    assert.equal(request.url, "https://target-bucket.obs.cn-north-4.myhuaweicloud.com/archive/copy.txt");
    assert.equal(request.options.method, "PUT");
    assert.equal(request.options.headers["x-obs-copy-source"], "/source-bucket/reports/source%20file.txt?versionId=version-1");
    assert.match(request.options.headers.authorization, /^OBS test-ak:/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ECS availability-zone discovery uses the documented project endpoint", { concurrency: false }, async () => {
  setCredentials();
  const { listEcsAvailabilityZones } = require("../build/openapi.js");
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ availability_zones: [{ name: "cn-north-4a" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await listEcsAvailabilityZones({});
    assert.equal(result.body.availability_zones[0].name, "cn-north-4a");
    assert.equal(request.url, "https://ecs.cn-north-4.myhuaweicloud.com/v1/test-project/availability-zones");
    assert.equal(request.options.method, "GET");
    assert.match(request.options.headers.authorization, /^SDK-HMAC-SHA256 Access=test-ak,/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ECS child MCP generic OpenAPI request expands project tokens and protects mutations", { concurrency: false }, async () => {
  setCredentials();
  const gateway = require("../build/gateway.js");
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const read = await gateway.call("ecs", "openapi_request", { method: "GET", path: "/v1/{project_id}/cloudservers/detail", query: { limit: 1 } });
    assert.equal(read.body.ok, true);
    assert.equal(requests[0].url, "https://ecs.cn-north-4.myhuaweicloud.com/v1/test-project/cloudservers/detail?limit=1");
    assert.match(requests[0].options.headers.authorization, /^SDK-HMAC-SHA256 Access=test-ak,/);
    const input = { method: "POST", path: "/v1/{projectId}/cloudservers/action", body: { "os-start": { servers: [{ id: "server-1" }] } } };
    const pending = await gateway.call("ecs", "openapi_request", input);
    assert.equal(pending.status, "confirmation_required");
    assert.equal(requests.length, 1);
    await gateway.call("ecs", "openapi_request", input, pending.confirmationToken);
    assert.equal(requests[1].options.method, "POST");
  } finally {
    global.fetch = originalFetch;
  }
});

test("OBS child MCP generic OpenAPI request bounds object reads and protects writes", { concurrency: false }, async () => {
  setCredentials();
  const gateway = require("../build/gateway.js");
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain", "x-obs-request-id": "generic-request" } });
  };
  try {
    const read = await gateway.call("obs", "openapi_request", { method: "GET", bucket: "example-bucket", key: "object.txt", maxResponseBytes: 32 });
    assert.equal(read.body, "ok");
    assert.equal(requests[0].options.headers.range, "bytes=0-31");
    const input = { method: "PUT", bucket: "example-bucket", key: "object.txt", headers: { "x-obs-meta-source": "agent" }, contentBase64: Buffer.from("write").toString("base64") };
    const pending = await gateway.call("obs", "openapi_request", input);
    assert.equal(pending.status, "confirmation_required");
    assert.equal(requests.length, 1);
    await gateway.call("obs", "openapi_request", input, pending.confirmationToken);
    assert.equal(requests[1].options.method, "PUT");
    assert.equal(requests[1].options.headers["x-obs-meta-source"], "agent");
    assert.match(requests[1].options.headers.authorization, /^OBS test-ak:/);
    assert.equal(Buffer.from(requests[1].options.body).toString(), "write");
  } finally {
    global.fetch = originalFetch;
  }
});

test("stdio MCP gateway exposes only the dynamic discovery, provision, and call tools", { concurrency: false }, async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["build/server.js"], cwd: process.cwd(), stderr: "pipe" });
  const client = new Client({ name: "huaweicloud-mate-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["huaweicloud_call", "huaweicloud_discover", "huaweicloud_provision"]);
    const discovered = await client.callTool({ name: "huaweicloud_discover", arguments: {} });
    assert.deepEqual(JSON.parse(discovered.content[0].text).map((child) => child.id), ["ecs", "obs"]);
    const provisioned = await client.callTool({ name: "huaweicloud_provision", arguments: { service: "ecs" } });
    assert.equal(JSON.parse(provisioned.content[0].text).subMcp, "ecs");
  } finally {
    await client.close();
  }
});

test("root discovery exposes exactly the ECS and OBS child MCPs", { concurrency: false }, () => {
  const { discover } = require("../build/gateway.js");
  assert.deepEqual(discover().map((child) => child.id), ["ecs", "obs"]);
  assert.ok(discover().every((child) => child.provider === "openapi-child-mcp"));
});

test("each dynamically loaded child MCP returns API Explorer source URLs", { concurrency: false }, async () => {
  const { provision } = require("../build/gateway.js");
  for (const service of ["ecs", "obs"]) {
    const child = await provision(service);
    assert.equal(child.subMcp, service);
    for (const operation of child.operations) {
      assert.ok(operation.sourceUrl?.includes(`/openapi/${service.toUpperCase()}/doc?api=`));
    }
  }
});

test("generated catalog pins all official ECS and OBS operations", { concurrency: false }, async () => {
  const manifest = require("../build/generated/catalog-manifest.json");
  const { provision } = require("../build/gateway.js");
  assert.deepEqual(manifest.counts, { ecs: 99, obs: 81 });
  assert.equal(manifest.sources.ecs.version, "3.1.205");
  assert.equal(manifest.sources.obs.version, "3.26.2");
  for (const [service, expected] of [["ecs", 99], ["obs", 81]]) {
    const child = await provision(service);
    const generated = child.operations.filter((operation) => operation.id.startsWith("api_"));
    assert.equal(generated.length, expected);
    assert.equal(new Set(generated.map((operation) => operation.id)).size, expected);
    assert.ok(generated.every((operation) => operation.sourceUrl.includes(`/openapi/${service.toUpperCase()}/doc?api=`)));
  }
});

test("generated ECS and OBS catalog entries map to their official request shape", { concurrency: false }, async () => {
  setCredentials();
  const gateway = require("../build/gateway.js");
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(options.method === "HEAD" ? null : JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const ecsResult = await gateway.call("ecs", "api_show_server", { server_id: "server-1" });
    assert.equal(ecsResult.body.ok, true);
    assert.equal(requests[0].url, "https://ecs.cn-north-4.myhuaweicloud.com/v1/test-project/cloudservers/server-1");
    assert.equal(requests[0].options.method, "GET");
    assert.match(requests[0].options.headers.authorization, /^SDK-HMAC-SHA256 Access=test-ak,/);
    const obsResult = await gateway.call("obs", "api_head_bucket", { Bucket: "example-bucket" });
    assert.equal(obsResult.status, 200);
    assert.equal(requests[1].url, "https://example-bucket.obs.cn-north-4.myhuaweicloud.com/");
    assert.equal(requests[1].options.method, "HEAD");
    assert.match(requests[1].options.headers.authorization, /^OBS test-ak:/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("generated ECS body schema preserves nested API field types", { concurrency: false }, async () => {
  const { provision, call } = require("../build/gateway.js");
  const catalog = await provision("ecs");
  const operation = catalog.operations.find((entry) => entry.id === "api_batch_start_servers");
  assert.equal(operation.inputSchema.properties.body.properties["os-start"].properties.servers.items.properties.id.type, "string");
  await assert.rejects(() => call("ecs", "api_batch_start_servers", { body: { "os-start": { servers: [{ id: 1 }] } } }), /body\.os-start\.servers\[0\]\.id must be a string/);
});
