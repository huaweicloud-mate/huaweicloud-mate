import { describe, expect, it, vi } from "vitest";

import {
  createObsAuthorization,
  ObsClient,
  parseObsListBucketsXml,
} from "../../src/providers/obs/client.js";

const successXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ListAllMyBucketsResult xmlns="http://obs.cn-north-4.myhuaweicloud.com/doc/2015-06-30/">
  <Owner><ID>domain-123</ID></Owner>
  <Buckets>
    <Bucket>
      <Name>example-bucket</Name>
      <CreationDate>2026-07-01T00:00:00.000Z</CreationDate>
      <Location>cn-north-4</Location>
      <BucketType>OBJECT</BucketType>
    </Bucket>
  </Buckets>
</ListAllMyBucketsResult>`;

describe("OBS client", () => {
  it("implements the documented OBS header signature", () => {
    expect(
      createObsAuthorization(
        { accessKey: "test-ak", secretKey: "test-sk" },
        "Tue, 14 Jul 2026 01:02:03 GMT",
      ),
    ).toBe("OBS test-ak:wwMbvGnO/k1QrjyYZP7wU7WjvvA=");
  });

  it("signs and parses a bounded list-buckets response", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://obs.cn-north-4.myhuaweicloud.com/");
      const headers = new Headers(init?.headers);
      expect(headers.get("date")).toBe("Tue, 14 Jul 2026 01:02:03 GMT");
      expect(headers.get("authorization")).toBe(
        "OBS test-ak:wwMbvGnO/k1QrjyYZP7wU7WjvvA=",
      );
      expect(init?.redirect).toBe("error");
      return new Response(successXml, {
        status: 200,
        headers: { "x-obs-request-id": "request-123" },
      });
    });
    const client = new ObsClient({
      fetch: request,
      now: () => new Date("2026-07-14T01:02:03.000Z"),
    });

    await expect(
      client.listBuckets({
        accessKey: "test-ak",
        secretKey: "test-sk",
        region: "cn-north-4",
      }),
    ).resolves.toEqual({
      ownerAccountId: "domain-123",
      buckets: [
        {
          name: "example-bucket",
          creationDate: "2026-07-01T00:00:00.000Z",
          location: "cn-north-4",
          type: "OBJECT",
        },
      ],
      requestId: "request-123",
    });
  });

  it("rejects active XML content and unknown bucket fields", () => {
    expect(() =>
      parseObsListBucketsXml(
        `<!DOCTYPE root [<!ENTITY x SYSTEM "file:///secret">]>${successXml}`,
      )
    ).toThrowError(expect.objectContaining({ code: "OUTPUT_REJECTED" }));
    expect(() =>
      parseObsListBucketsXml(
        successXml.replace("</Bucket>", "<Unknown>value</Unknown></Bucket>"),
      )
    ).toThrowError(expect.objectContaining({ code: "OUTPUT_REJECTED" }));
  });

  it("maps authentication failures without returning secret material", async () => {
    const client = new ObsClient({
      fetch: vi.fn(async () => new Response(
        "<Error><Code>SignatureDoesNotMatch</Code><Message>test-sk</Message></Error>",
        { status: 403 },
      )),
    });

    let failure: unknown;
    try {
      await client.listBuckets({ accessKey: "test-ak", secretKey: "test-sk" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(String(failure)).not.toContain("test-ak");
    expect(String(failure)).not.toContain("test-sk");
  });

  it("creates a bucket with a fixed virtual-host endpoint and signed body", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://test-bucket.obs.cn-north-4.myhuaweicloud.com/",
      );
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("PUT");
      expect(headers.get("content-type")).toBe("application/xml");
      expect(headers.get("authorization")).toBe(
        "OBS test-ak:Q1IDEW9UVypUVU3Hi+PbIvvTFe0=",
      );
      expect(String(init?.body)).toContain("<Location>cn-north-4</Location>");
      return new Response("", {
        status: 200,
        headers: {
          location: "/test-bucket",
          "x-obs-request-id": "create-request-123",
        },
      });
    });
    const client = new ObsClient({
      fetch: request,
      now: () => new Date("2026-07-14T01:02:03.000Z"),
    });

    await expect(client.createBucket({
      accessKey: "test-ak",
      secretKey: "test-sk",
      bucketName: "test-bucket",
      region: "cn-north-4",
    })).resolves.toEqual({
      bucketName: "test-bucket",
      region: "cn-north-4",
      location: "/test-bucket",
      requestId: "create-request-123",
    });
  });

  it("classifies an interrupted write as outcome unknown without retrying", async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error("socket reset"); });
    const client = new ObsClient({ fetch: request });

    await expect(client.createBucket({
      accessKey: "test-ak",
      secretKey: "test-sk",
      bucketName: "test-bucket",
      region: "cn-north-4",
    })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("reads one bounded UTF-8 text object with a fixed signed request", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://test-bucket.obs.cn-north-4.myhuaweicloud.com/notes/read%20me.txt",
      );
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(headers.get("authorization")).toBe(
        "OBS test-ak:O7zfQ/v72C+nhvmYf+Va7LKcvug=",
      );
      return new Response("approved sensitive text", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          etag: '"etag-123"',
          "last-modified": "Tue, 14 Jul 2026 00:00:00 GMT",
          "x-obs-request-id": "object-request-123",
        },
      });
    });
    const client = new ObsClient({
      fetch: request,
      now: () => new Date("2026-07-14T01:02:03.000Z"),
    });

    await expect(client.getObjectText({
      accessKey: "test-ak",
      secretKey: "test-sk",
      bucketName: "test-bucket",
      objectKey: "notes/read me.txt",
      region: "cn-north-4",
    })).resolves.toEqual({
      bucketName: "test-bucket",
      objectKey: "notes/read me.txt",
      region: "cn-north-4",
      contentType: "text/plain; charset=utf-8",
      contentLength: 23,
      text: "approved sensitive text",
      etag: '"etag-123"',
      lastModified: "Tue, 14 Jul 2026 00:00:00 GMT",
      requestId: "object-request-123",
    });
  });

  it("rejects unsupported or oversized object content before returning it", async () => {
    const binary = new ObsClient({
      fetch: vi.fn(async () => new Response(new Uint8Array([0xff]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })),
    });
    await expect(binary.getObjectText({
      accessKey: "test-ak",
      secretKey: "test-sk",
      bucketName: "test-bucket",
      objectKey: "secret.bin",
      region: "cn-north-4",
    })).rejects.toMatchObject({ code: "OUTPUT_REJECTED" });

    const oversized = new ObsClient({
      fetch: vi.fn(async () => new Response("not-read", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": "65537",
        },
      })),
    });
    await expect(oversized.getObjectText({
      accessKey: "test-ak",
      secretKey: "test-sk",
      bucketName: "test-bucket",
      objectKey: "large.txt",
      region: "cn-north-4",
    })).rejects.toMatchObject({ code: "OUTPUT_REJECTED" });
  });

  it("deletes an empty bucket with a signed request and no retry", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://test-bucket.obs.cn-north-4.myhuaweicloud.com/",
      );
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("DELETE");
      expect(init?.body).toBeUndefined();
      expect(headers.get("authorization")).toBe(
        "OBS test-ak:LDvxkUq9Cpqal6hzPtcXKJsiW78=",
      );
      return new Response(null, {
        status: 204,
        headers: { "x-obs-request-id": "delete-request-123" },
      });
    });
    const client = new ObsClient({
      fetch: request,
      now: () => new Date("2026-07-14T01:02:03.000Z"),
    });

    await expect(client.deleteBucket({
      accessKey: "test-ak",
      secretKey: "test-sk",
      bucketName: "test-bucket",
      region: "cn-north-4",
    })).resolves.toEqual({
      bucketName: "test-bucket",
      region: "cn-north-4",
      deleted: true,
      requestId: "delete-request-123",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not retry when a bucket deletion outcome is unknown", async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error("socket reset after dispatch");
    });
    const client = new ObsClient({ fetch: request });

    await expect(client.deleteBucket({
      accessKey: "test-ak",
      secretKey: "test-sk",
      bucketName: "test-bucket",
      region: "cn-north-4",
    })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("maps non-empty bucket deletion to a secret-free conflict", async () => {
    const client = new ObsClient({
      fetch: vi.fn(async () => new Response(
        "<Error><Code>BucketNotEmpty</Code><Message>test-sk</Message></Error>",
        { status: 409 },
      )),
    });

    let failure: unknown;
    try {
      await client.deleteBucket({
        accessKey: "test-ak",
        secretKey: "test-sk",
        bucketName: "test-bucket",
        region: "cn-north-4",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "CONFLICT" });
    expect(String(failure)).not.toContain("test-ak");
    expect(String(failure)).not.toContain("test-sk");
  });
});
