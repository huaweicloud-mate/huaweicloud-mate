# @hd_vector/huaweicloud-meta

Huawei Cloud AI Assistant — OBS (Object Storage Service) tools with Promise-based client and MCP server support.

## Installation

```bash
npm install /path/to/huaweicloud-meta
npm install git+ssh://git@github.com/hd-vector/huaweicloud-mate.git
# or from npm registry (coming soon)
npm install @hd_vector/huaweicloud-meta
```

## Usage (Library)

```typescript
import { HwObsClient } from "@hd_vector/huaweicloud-meta";

const client = new HwObsClient({
  credentials: {
    accessKeyId: process.env.HUAWEICLOUD_AK!,
    secretAccessKey: process.env.HUAWEICLOUD_SK!,
    server: "https://obs.cn-north-4.myhuaweicloud.com",
  },
});

const { buckets } = await client.listBuckets();
const { objects } = await client.listObjects({ bucket: "my-bucket" });
```

## MCP Server

```bash
export HUAWEICLOUD_AK=your-ak
export HUAWEICLOUD_SK=your-sk
npx @hd_vector/huaweicloud-meta
```

## API

| Method | Description |
|--------|-------------|
| `listBuckets()` | List all buckets |
| `getBucketLocation(name)` | Get bucket region |
| `getBucketMetadata(name)` | Get bucket metadata |
| `listObjects({ bucket, prefix? })` | List objects |
| `createBucket({ bucket, region? })` | Create bucket |
| `deleteBucket({ bucket })` | Delete bucket |
