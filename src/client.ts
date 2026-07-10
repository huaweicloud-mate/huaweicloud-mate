import ObsClient from "esdk-obs-nodejs";
import { ObsConfig, BucketSummary, ListBucketsResult, BucketLocationResult, BucketMetadataResult, ListObjectsParams, ListObjectsResult, ObjectSummary, CreateBucketParams, DeleteBucketParams, MutationResult } from "./types";
import { loadConfig, promisify } from "./utils";

export class HwObsClient {
  private client: any;
  private config: ObsConfig;

  constructor(config: ObsConfig) {
    this.config = config;
    const { accessKeyId, secretAccessKey, server } = config.credentials;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("OBS credentials missing: accessKeyId and secretAccessKey are required");
    }
    this.client = new ObsClient({
      access_key_id: accessKeyId,
      secret_access_key: secretAccessKey,
      server: server || "https://obs.cn-north-4.myhuaweicloud.com",
    });
  }

  static fromEnv(): HwObsClient {
    return new HwObsClient(loadConfig());
  }

  async listBuckets(): Promise<ListBucketsResult> {
    const result = await promisify<any>(this.client.listBuckets.bind(this.client), {});
    const buckets: BucketSummary[] = (result?.InterfaceResult?.Buckets || []).map((b: any) => ({
      name: b.BucketName,
      creationDate: b.CreationDate,
      location: b.Location,
    }));
    return { buckets };
  }

  async getBucketLocation(bucketName: string): Promise<BucketLocationResult> {
    const result = await promisify<any>(this.client.getBucketLocation.bind(this.client), { Bucket: bucketName });
    return { bucketName, location: result?.InterfaceResult?.Location };
  }

  async getBucketMetadata(bucketName: string): Promise<BucketMetadataResult> {
    const result = await promisify<any>(this.client.getBucketMetadata.bind(this.client), { Bucket: bucketName });
    const ir = result?.InterfaceResult || {};
    return {
      bucketName,
      location: ir.Location || ir.LocationObs,
      storageClass: ir.StorageClass || ir.StorageClassObs,
      obsVersion: ir.ObsVersion || ir.ObsVersionObs,
      headers: ir,
    };
  }

  async listObjects(params: ListObjectsParams): Promise<ListObjectsResult> {
    const result = await promisify<any>(this.client.listObjects.bind(this.client), {
      Bucket: params.bucket,
      Prefix: params.prefix || "",
      MaxKeys: params.maxKeys || 100,
      Marker: params.marker,
      Delimiter: params.delimiter,
    });
    const ir = result?.InterfaceResult || {};
    const contents: any[] = ir.Contents || [];
    const objects: ObjectSummary[] = contents.map((o: any) => ({
      key: o.Key,
      size: o.Size,
      etag: o.ETag,
      lastModified: o.LastModified,
      storageClass: o.StorageClass,
    }));
    return {
      bucketName: params.bucket,
      objects,
      isTruncated: !!ir.IsTruncated,
      nextMarker: ir.NextMarker,
    };
  }

  async createBucket(params: CreateBucketParams): Promise<MutationResult> {
    if (!this.config.enableWrite) {
      throw new Error("createBucket is disabled. Set enableWrite=true to enable it.");
    }
    await promisify<any>(this.client.createBucket.bind(this.client), {
      Bucket: params.bucket,
      Location: params.region || this.config.defaultRegion || "cn-north-4",
    });
    return { bucketName: params.bucket, action: "create_bucket", status: "created" };
  }

  async deleteBucket(params: DeleteBucketParams): Promise<MutationResult> {
    if (!this.config.enableDelete) {
      throw new Error("deleteBucket is disabled. Set enableDelete=true to enable it.");
    }
    await promisify<any>(this.client.deleteBucket.bind(this.client), { Bucket: params.bucket });
    return { bucketName: params.bucket, action: "delete_bucket", status: "deleted" };
  }

  close(): void {
    try { (this.client as any).close(); } catch { /* ignore */ }
  }
}
