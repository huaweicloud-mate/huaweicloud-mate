import { localObsProviderId } from "../providers/obs/executor.js";
import { digestCanonicalJson } from "../router/canonical.js";
import type { RouterCapabilityRegistration } from "../router/types.js";

const listBucketsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const listBucketsOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ownerAccountId", "buckets"],
  properties: {
    ownerAccountId: { type: "string", minLength: 1, maxLength: 256 },
    buckets: {
      type: "array",
      maxItems: 10_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "creationDate"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 255 },
          creationDate: { type: "string", minLength: 1, maxLength: 128 },
          location: { type: "string", minLength: 1, maxLength: 128 },
          type: { enum: ["OBJECT", "POSIX"] },
        },
      },
    },
  },
} as const;

const createBucketInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bucketName"],
  properties: {
    bucketName: {
      type: "string",
      minLength: 3,
      maxLength: 63,
      pattern: "^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$",
    },
  },
} as const;

const createBucketOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bucketName", "region", "location"],
  properties: {
    bucketName: { type: "string", minLength: 3, maxLength: 63 },
    region: { type: "string", minLength: 1, maxLength: 128 },
    location: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

const getObjectTextInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bucketName", "objectKey"],
  properties: {
    bucketName: createBucketInputSchema.properties.bucketName,
    objectKey: { type: "string", minLength: 1, maxLength: 1024 },
  },
} as const;

const getObjectTextOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "bucketName",
    "objectKey",
    "region",
    "contentType",
    "contentLength",
    "text",
  ],
  properties: {
    bucketName: { type: "string", minLength: 3, maxLength: 63 },
    objectKey: { type: "string", minLength: 1, maxLength: 1024 },
    region: { type: "string", minLength: 1, maxLength: 128 },
    contentType: {
      enum: [
        "application/json",
        "application/json; charset=utf-8",
        "application/xml",
        "application/xml; charset=utf-8",
        "text/csv",
        "text/csv; charset=utf-8",
        "text/plain",
        "text/plain; charset=utf-8",
        "text/xml",
        "text/xml; charset=utf-8",
      ],
    },
    contentLength: { type: "integer", minimum: 0, maximum: 65_536 },
    text: { type: "string", maxLength: 65_536 },
    etag: { type: "string", minLength: 1, maxLength: 512 },
    lastModified: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;

const deleteBucketOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bucketName", "region", "deleted"],
  properties: {
    bucketName: { type: "string", minLength: 3, maxLength: 63 },
    region: { type: "string", minLength: 1, maxLength: 128 },
    deleted: { const: true },
  },
} as const;

export const obsCapabilityRegistrations: readonly RouterCapabilityRegistration[] = [
  {
    definition: {
      schemaVersion: "huaweicloud-agent-capability/v1-lite",
      capabilityId: "huaweicloud.obs.object.text.read.v1",
      product: "obs",
      summary: "Read one bounded UTF-8 text object from OBS after trusted approval",
      inputSchema: getObjectTextInputSchema,
      outputSchema: getObjectTextOutputSchema,
      scope: { region: "required", project: "forbidden" },
      operationKind: "read",
      riskTags: ["sensitive-read"],
      confirmationRequired: true,
      executors: {
        providerMcp: {
          providerId: localObsProviderId,
          tool: "obs_get_object_text",
          inputSchemaDigest: digestCanonicalJson(getObjectTextInputSchema),
        },
      },
      defaultExecutor: "provider-mcp",
      outputPolicy: {
        sensitivePaths: [],
        maxBytes: 128 * 1024,
        allowProviderText: false,
      },
      examples: [{ bucketName: "example-private-bucket", objectKey: "notes/readme.txt" }],
    },
    summarize: (argumentsValue, scope) => ({
      resources: [
        `obs/object/${String(argumentsValue.bucketName)}/${String(argumentsValue.objectKey)}`,
      ],
      effects: [
        `Read up to 64 KiB of UTF-8 text into Agent context from ${scope.region ?? "the selected region"}`,
        "Object content may contain confidential or credential-like material",
      ],
    }),
  },
  {
    definition: {
      schemaVersion: "huaweicloud-agent-capability/v1-lite",
      capabilityId: "huaweicloud.obs.bucket.list.v1",
      product: "obs",
      summary: "List OBS buckets owned by the authenticated Huawei Cloud account",
      inputSchema: listBucketsInputSchema,
      outputSchema: listBucketsOutputSchema,
      scope: { region: "optional", project: "forbidden" },
      operationKind: "read",
      riskTags: [],
      confirmationRequired: false,
      executors: {
        providerMcp: {
          providerId: localObsProviderId,
          tool: "obs_list_buckets",
          inputSchemaDigest: digestCanonicalJson(listBucketsInputSchema),
        },
      },
      defaultExecutor: "provider-mcp",
      outputPolicy: {
        sensitivePaths: [],
        maxBytes: 1024 * 1024,
        allowProviderText: false,
      },
      examples: [{}],
    },
    summarize: () => ({
      resources: ["OBS bucket inventory"],
      effects: ["Read bucket names, creation times, types, and regions"],
    }),
  },
  {
    definition: {
      schemaVersion: "huaweicloud-agent-capability/v1-lite",
      capabilityId: "huaweicloud.obs.bucket.create.v1",
      product: "obs",
      summary: "Create a private OBS bucket in the selected Huawei Cloud region",
      inputSchema: createBucketInputSchema,
      outputSchema: createBucketOutputSchema,
      scope: { region: "required", project: "forbidden" },
      operationKind: "write",
      riskTags: ["privileged", "cost"],
      confirmationRequired: true,
      executors: {
        providerMcp: {
          providerId: localObsProviderId,
          tool: "obs_create_bucket",
          inputSchemaDigest: digestCanonicalJson(createBucketInputSchema),
        },
      },
      defaultExecutor: "provider-mcp",
      outputPolicy: {
        sensitivePaths: [],
        maxBytes: 65_536,
        allowProviderText: false,
      },
      examples: [{ bucketName: "example-private-bucket" }],
    },
    summarize: (argumentsValue, scope) => ({
      resources: [`obs/bucket/${String(argumentsValue.bucketName)}`],
      effects: [
        `Create one private OBS bucket in ${scope.region ?? "the selected region"}`,
        "Enable future billable object storage and request usage",
      ],
    }),
  },
  {
    definition: {
      schemaVersion: "huaweicloud-agent-capability/v1-lite",
      capabilityId: "huaweicloud.obs.bucket.delete.v1",
      product: "obs",
      summary: "Permanently delete an empty OBS bucket in the selected Huawei Cloud region",
      inputSchema: createBucketInputSchema,
      outputSchema: deleteBucketOutputSchema,
      scope: { region: "required", project: "forbidden" },
      operationKind: "write",
      riskTags: ["destructive", "privileged"],
      confirmationRequired: true,
      executors: {
        providerMcp: {
          providerId: localObsProviderId,
          tool: "obs_delete_bucket",
          inputSchemaDigest: digestCanonicalJson(createBucketInputSchema),
        },
      },
      defaultExecutor: "provider-mcp",
      outputPolicy: {
        sensitivePaths: [],
        maxBytes: 65_536,
        allowProviderText: false,
      },
      examples: [{ bucketName: "example-empty-bucket" }],
    },
    summarize: (argumentsValue, scope) => ({
      resources: [`obs/bucket/${String(argumentsValue.bucketName)}`],
      effects: [
        `Permanently delete one empty OBS bucket in ${scope.region ?? "the selected region"}`,
        "The bucket name may become available to another account after deletion",
      ],
    }),
  },
];
