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

test("catalog returns an API Explorer source URL for every ECS and OBS operation", { concurrency: false }, () => {
  const { provision } = require("../build/gateway.js");
  for (const service of ["ecs", "obs"]) {
    for (const operation of provision(service).operations) {
      assert.ok(operation.sourceUrl?.includes(`/openapi/${service.toUpperCase()}/doc?api=`));
    }
  }
});
