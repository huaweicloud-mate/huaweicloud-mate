export interface ObsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  server?: string;
}

export interface ObsConfig {
  credentials: ObsCredentials;
  defaultRegion?: string;
  enableWrite?: boolean;
  enableDelete?: boolean;
}

export interface BucketSummary {
  name: string;
  creationDate?: string;
  location?: string;
}

export interface ListBucketsResult {
  buckets: BucketSummary[];
}

export interface BucketLocationResult {
  bucketName: string;
  location?: string;
}

export interface BucketMetadataResult {
  bucketName: string;
  location?: string;
  storageClass?: string;
  obsVersion?: string;
  headers: Record<string, string | undefined>;
}

export interface ObjectSummary {
  key: string;
  size?: number;
  etag?: string;
  lastModified?: string;
  storageClass?: string;
}

export interface ListObjectsParams {
  bucket: string;
  prefix?: string;
  maxKeys?: number;
  marker?: string;
  delimiter?: string;
}

export interface ListObjectsResult {
  bucketName: string;
  objects: ObjectSummary[];
  isTruncated: boolean;
  nextMarker?: string;
}

export interface CreateBucketParams {
  bucket: string;
  region?: string;
  storageClass?: string;
}

export interface DeleteBucketParams {
  bucket: string;
}

export interface MutationResult {
  bucketName: string;
  action: string;
  status: string;
}

export interface ObsTool {
  name: string;
  description: string;
  isRead: boolean;
  inputSchema: { type: "object"; properties: Record<string, any>; required?: string[] };
  handler: (args: any) => Promise<any>;
}
