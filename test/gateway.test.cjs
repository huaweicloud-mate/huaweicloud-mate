const assert = require("node:assert/strict");
const test = require("node:test");

function setCredentials() {
  process.env.HUAWEICLOUD_AK = "test-ak";
  process.env.HUAWEICLOUD_SK = "test-sk";
  process.env.HUAWEICLOUD_REGION = "cn-north-4";
  process.env.HUAWEICLOUD_PROJECT_ID = "test-project";
}

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
