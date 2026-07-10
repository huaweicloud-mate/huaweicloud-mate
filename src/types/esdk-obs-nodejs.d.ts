declare module "esdk-obs-nodejs" {
  interface ObsClientOptions {
    access_key_id: string;
    secret_access_key: string;
    server: string;
    [key: string]: any;
  }

  class ObsClient {
    constructor(options: ObsClientOptions);
    listBuckets(params: any, callback: (err: any, result: any) => void): void;
    getBucketLocation(params: any, callback: (err: any, result: any) => void): void;
    getBucketMetadata(params: any, callback: (err: any, result: any) => void): void;
    listObjects(params: any, callback: (err: any, result: any) => void): void;
    createBucket(params: any, callback: (err: any) => void): void;
    deleteBucket(params: any, callback: (err: any) => void): void;
  }

  export default ObsClient;
}
