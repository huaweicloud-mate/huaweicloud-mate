import { ObsConfig } from "./types";

export function loadConfig(): ObsConfig {
  return {
    credentials: {
      accessKeyId: process.env.HUAWEICLOUD_OBS_ACCESS_KEY_ID || process.env.HUAWEICLOUD_AK || "",
      secretAccessKey: process.env.HUAWEICLOUD_OBS_SECRET_ACCESS_KEY || process.env.HUAWEICLOUD_SK || "",
      server: process.env.HUAWEICLOUD_OBS_SERVER || "https://obs.cn-north-4.myhuaweicloud.com",
    },
    defaultRegion: process.env.HUAWEICLOUD_OBS_DEFAULT_REGION || "cn-north-4",
    enableWrite: process.env.HUAWEICLOUD_OBS_ENABLE_WRITE === "true",
    enableDelete: process.env.HUAWEICLOUD_OBS_ENABLE_DELETE === "true",
  };
}

export function promisify<T>(fn: (args: any, cb: (err: any, result: T) => void) => void, params: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn(params, (err: any, result: T) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}
