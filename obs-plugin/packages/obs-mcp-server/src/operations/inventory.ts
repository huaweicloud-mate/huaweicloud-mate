import type { BodyKind, OperationGroup, OperationRisk, OperationSpec } from "./types.js";
import { makeInputSchema } from "./schemas.js";

interface RawOperation {
  apiName: string;
  title: string;
  method: OperationSpec["method"];
  pathKind: OperationSpec["pathKind"];
  group: OperationGroup;
  risk: OperationRisk;
  doc: string;
  subresource?: string;
  bodyKind?: BodyKind;
  responseKind?: OperationSpec["responseKind"];
  requiresConfirm?: OperationSpec["requiresConfirm"];
  extraQueryKeys?: string[];
  aliases?: string[];
}

const doc = (id: string) => `https://support.huaweicloud.com/api-obs/${id}.html`;

const rawOperations: RawOperation[] = [
  { apiName: "ListBuckets", title: "获取桶列表", method: "GET", pathKind: "service", group: "bucket_read", risk: "read", doc: doc("obs_04_0020"), responseKind: "xml" },
  { apiName: "CreateBucket", title: "创建桶", method: "PUT", pathKind: "bucket", group: "bucket_basic", risk: "write", doc: doc("obs_04_0021"), bodyKind: "xml", responseKind: "empty" },
  { apiName: "ListObjects", title: "列举桶内对象", method: "GET", pathKind: "bucket", group: "bucket_read", risk: "read", doc: doc("obs_04_0022"), responseKind: "xml" },
  { apiName: "GetBucketMetadata", title: "获取桶元数据", method: "HEAD", pathKind: "bucket", group: "bucket_read", risk: "read", doc: doc("obs_04_0023"), responseKind: "headers" },
  { apiName: "GetBucketLocation", title: "获取桶区域位置", method: "GET", pathKind: "bucket", group: "bucket_read", risk: "read", doc: doc("obs_04_0024"), subresource: "location", responseKind: "xml" },
  { apiName: "DeleteBucket", title: "删除桶", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0025"), responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "SetBucketPolicy", title: "设置桶策略", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0027"), subresource: "policy", bodyKind: "json", responseKind: "empty" },
  { apiName: "GetBucketPolicy", title: "获取桶策略", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0028"), subresource: "policy", responseKind: "text" },
  { apiName: "DeleteBucketPolicy", title: "删除桶策略", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0029"), subresource: "policy", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "SetBucketAcl", title: "设置桶ACL", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0030"), subresource: "acl", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketAcl", title: "获取桶ACL", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0031"), subresource: "acl", responseKind: "xml" },
  { apiName: "SetBucketLogging", title: "设置桶日志管理配置", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0032"), subresource: "logging", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketLogging", title: "获取桶日志管理配置", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0033"), subresource: "logging", responseKind: "xml" },
  { apiName: "SetBucketLifecycle", title: "设置桶的生命周期配置", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0034"), subresource: "lifecycle", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketLifecycle", title: "获取桶的生命周期配置", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0035"), subresource: "lifecycle", responseKind: "xml" },
  { apiName: "DeleteBucketLifecycle", title: "删除桶的生命周期配置", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0036"), subresource: "lifecycle", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "SetBucketVersioning", title: "设置桶的多版本状态", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0037"), subresource: "versioning", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketVersioning", title: "获取桶的多版本状态", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0038"), subresource: "versioning", responseKind: "xml" },
  { apiName: "PutBucketStoragePolicy", title: "设置桶默认存储类型", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0044"), subresource: "storageClass", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketStoragePolicy", title: "获取桶默认存储类型", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0045"), subresource: "storageClass", responseKind: "xml" },
  { apiName: "SetBucketReplication", title: "设置桶的跨区域复制配置", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0046"), subresource: "replication", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketReplication", title: "获取桶的跨区域复制配置", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0047"), subresource: "replication", responseKind: "xml" },
  { apiName: "DeleteBucketReplication", title: "删除桶的跨区域复制配置", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0048"), subresource: "replication", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "SetBucketTagging", title: "设置桶标签", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0049"), subresource: "tagging", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketTagging", title: "获取桶标签", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0050"), subresource: "tagging", responseKind: "xml" },
  { apiName: "DeleteBucketTagging", title: "删除桶标签", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0051"), subresource: "tagging", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "SetBucketQuota", title: "设置桶配额", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0052"), subresource: "quota", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketQuota", title: "获取桶配额", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0053"), subresource: "quota", responseKind: "xml" },
  { apiName: "GetBucketStorageInfo", title: "获取桶存量信息", method: "GET", pathKind: "bucket", group: "bucket_read", risk: "read", doc: doc("obs_04_0054"), subresource: "storageinfo", responseKind: "xml" },
  { apiName: "SetBucketInventory", title: "设置桶清单", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0055"), subresource: "inventory", bodyKind: "xml", responseKind: "empty", extraQueryKeys: ["id"] },
  { apiName: "GetBucketInventory", title: "获取桶清单", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0056"), subresource: "inventory", responseKind: "xml", extraQueryKeys: ["id"] },
  { apiName: "ListBucketInventory", title: "列举桶清单", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0057"), subresource: "inventory", responseKind: "xml" },
  { apiName: "DeleteBucketInventory", title: "删除桶清单", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0058"), subresource: "inventory", responseKind: "empty", requiresConfirm: "bucket", extraQueryKeys: ["id"] },
  { apiName: "SetBucketCustomdomain", title: "设置桶的自定义域名", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0059"), subresource: "customdomain", responseKind: "empty", extraQueryKeys: ["domain"] },
  { apiName: "GetBucketCustomdomain", title: "获取桶的自定义域名", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0060"), subresource: "customdomain", responseKind: "xml" },
  { apiName: "DeleteBucketCustomdomain", title: "删除桶的自定义域名", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0061"), subresource: "customdomain", responseKind: "empty", requiresConfirm: "bucket", extraQueryKeys: ["domain"] },
  { apiName: "SetBucketEncryption", title: "设置桶的加密配置", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0062"), subresource: "encryption", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketEncryption", title: "获取桶的加密配置", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0063"), subresource: "encryption", responseKind: "xml" },
  { apiName: "DeleteBucketEncryption", title: "删除桶的加密配置", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0064"), subresource: "encryption", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "SetDirectcoldaccess", title: "设置桶归档存储对象直读策略", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0065"), subresource: "directcoldaccess", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetDirectcoldaccess", title: "获取桶归档存储对象直读策略", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0066"), subresource: "directcoldaccess", responseKind: "xml" },
  { apiName: "DeleteDirectcoldaccess", title: "删除桶归档存储对象直读策略", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0067"), subresource: "directcoldaccess", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "PutMirrorBackToSource", title: "设置镜像回源规则", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0119"), subresource: "mirrorBackToSource", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetMirrorBackToSource", title: "获取镜像回源规则", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0120"), subresource: "mirrorBackToSource", responseKind: "xml" },
  { apiName: "DeleteMirrorBackToSource", title: "删除镜像回源规则", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0121"), subresource: "mirrorBackToSource", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "PutDisPolicy", title: "设置DIS通知策略", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0139"), subresource: "notification", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetDisPolicy", title: "获取DIS通知策略", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0140"), subresource: "notification", responseKind: "xml" },
  { apiName: "DeleteDisPolicy", title: "删除DIS通知策略", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0141"), subresource: "notification", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "PutDecompressPolicy", title: "设置在线解压策略", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0148"), subresource: "obscompresspolicy", bodyKind: "xml", responseKind: "empty", aliases: ["SetBucketObsCompressPolicy"] },
  { apiName: "GetDecompressPolicy", title: "获取在线解压策略", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0149"), subresource: "obscompresspolicy", responseKind: "xml", aliases: ["GetBucketObsCompressPolicy"] },
  { apiName: "DeleteDecompressPolicy", title: "删除在线解压策略", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0150"), subresource: "obscompresspolicy", responseKind: "empty", requiresConfirm: "bucket", aliases: ["DeleteBucketObsCompressPolicy"] },
  { apiName: "SetBucketObjectLock", title: "配置桶级默认WORM策略", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0167"), subresource: "wormPolicy", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketObjectLock", title: "获取桶级默认WORM策略", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0168"), subresource: "wormPolicy", responseKind: "xml" },
  { apiName: "SetBucketWebsite", title: "设置桶的网站配置", method: "PUT", pathKind: "bucket", group: "website_cors_options", risk: "config_write", doc: doc("obs_04_0071"), subresource: "website", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketWebsite", title: "获取桶的网站配置", method: "GET", pathKind: "bucket", group: "website_cors_options", risk: "read", doc: doc("obs_04_0072"), subresource: "website", responseKind: "xml" },
  { apiName: "DeleteBucketWebsite", title: "删除桶的网站配置", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0073"), subresource: "website", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "SetBucketCors", title: "设置桶的CORS配置", method: "PUT", pathKind: "bucket", group: "website_cors_options", risk: "config_write", doc: doc("obs_04_0074"), subresource: "cors", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketCors", title: "获取桶的CORS配置", method: "GET", pathKind: "bucket", group: "website_cors_options", risk: "read", doc: doc("obs_04_0075"), subresource: "cors", responseKind: "xml" },
  { apiName: "DeleteBucketCors", title: "删除桶的CORS配置", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0076"), subresource: "cors", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "OptionsBucket", title: "OPTIONS桶", method: "OPTIONS", pathKind: "bucket", group: "website_cors_options", risk: "read", doc: doc("obs_04_0077"), responseKind: "headers" },
  { apiName: "OptionsObject", title: "OPTIONS对象", method: "OPTIONS", pathKind: "object", group: "website_cors_options", risk: "read", doc: doc("obs_04_0078"), responseKind: "headers" },
  { apiName: "PutObject", title: "PUT上传", method: "PUT", pathKind: "object", group: "object_write", risk: "write", doc: doc("obs_04_0080"), bodyKind: "file", responseKind: "headers" },
  { apiName: "PostObject", title: "POST上传", method: "POST", pathKind: "bucket", group: "object_write", risk: "write", doc: doc("obs_04_0081"), bodyKind: "file", responseKind: "xml" },
  { apiName: "CopyObject", title: "复制对象", method: "PUT", pathKind: "object", group: "object_write", risk: "write", doc: doc("obs_04_0082"), responseKind: "xml" },
  { apiName: "GetObject", title: "下载对象", method: "GET", pathKind: "object", group: "object_read", risk: "read", doc: doc("obs_04_0083"), responseKind: "binary" },
  { apiName: "HeadObject", title: "获取对象元数据", method: "HEAD", pathKind: "object", group: "object_read", risk: "read", doc: doc("obs_04_0084"), responseKind: "headers" },
  { apiName: "DeleteObject", title: "删除对象", method: "DELETE", pathKind: "object", group: "object_delete_danger", risk: "delete", doc: doc("obs_04_0085"), responseKind: "empty", requiresConfirm: "object" },
  { apiName: "DeleteObjects", title: "批量删除对象", method: "POST", pathKind: "bucket", group: "object_delete_danger", risk: "delete", doc: doc("obs_04_0086"), subresource: "delete", bodyKind: "xml", responseKind: "xml", requiresConfirm: "bucket" },
  { apiName: "RestoreObject", title: "恢复归档存储或深度归档存储对象", method: "POST", pathKind: "object", group: "object_write", risk: "write", doc: doc("obs_04_0087"), subresource: "restore", bodyKind: "xml", responseKind: "empty" },
  { apiName: "AppendObject", title: "追加写对象", method: "POST", pathKind: "object", group: "object_write", risk: "write", doc: doc("obs_04_0088"), subresource: "append", bodyKind: "file", responseKind: "headers", extraQueryKeys: ["position"] },
  { apiName: "SetObjectAcl", title: "设置对象ACL", method: "PUT", pathKind: "object", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0089"), subresource: "acl", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetObjectAcl", title: "获取对象ACL", method: "GET", pathKind: "object", group: "object_read", risk: "read", doc: doc("obs_04_0090"), subresource: "acl", responseKind: "xml" },
  { apiName: "SetObjectMetadata", title: "修改对象元数据", method: "PUT", pathKind: "object", group: "object_write", risk: "write", doc: doc("obs_04_0091"), subresource: "metadata", responseKind: "headers" },
  { apiName: "UploadModifyObject", title: "修改写对象", method: "PUT", pathKind: "object", group: "special_posix_pfs", risk: "destructive", doc: doc("obs_04_0092"), subresource: "modify", bodyKind: "file", responseKind: "headers", requiresConfirm: "object", extraQueryKeys: ["position"] },
  { apiName: "TruncateObject", title: "截断对象", method: "PUT", pathKind: "object", group: "special_posix_pfs", risk: "destructive", doc: doc("obs_04_0093"), subresource: "truncate", responseKind: "headers", requiresConfirm: "object", extraQueryKeys: ["length"] },
  { apiName: "RenameObject", title: "重命名对象", method: "POST", pathKind: "object", group: "special_posix_pfs", risk: "destructive", doc: doc("obs_04_0094"), subresource: "rename", responseKind: "headers", requiresConfirm: "object", extraQueryKeys: ["name"] },
  { apiName: "Callback", title: "回调", method: "POST", pathKind: "object", group: "object_write", risk: "write", doc: doc("obs_04_0095"), bodyKind: "json", responseKind: "text" },
  { apiName: "PutObjectTagging", title: "设置对象标签", method: "PUT", pathKind: "object", group: "object_write", risk: "write", doc: doc("obs_04_0172"), subresource: "tagging", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetObjectTagging", title: "获取对象标签", method: "GET", pathKind: "object", group: "object_read", risk: "read", doc: doc("obs_04_0164"), subresource: "tagging", responseKind: "xml" },
  { apiName: "DeleteObjectTagging", title: "删除对象标签", method: "DELETE", pathKind: "object", group: "object_delete_danger", risk: "delete", doc: doc("obs_04_0165"), subresource: "tagging", responseKind: "empty", requiresConfirm: "object" },
  { apiName: "SetObjectLock", title: "配置对象级WORM保护策略", method: "PUT", pathKind: "object", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0166"), subresource: "wormPolicy", bodyKind: "xml", responseKind: "empty" },
  { apiName: "ListMultipartUploads", title: "列举桶中已初始化多段任务", method: "GET", pathKind: "bucket", group: "multipart_large", risk: "read", doc: doc("obs_04_0097"), subresource: "uploads", responseKind: "xml" },
  { apiName: "InitiateMultipartUpload", title: "初始化上传段任务", method: "POST", pathKind: "object", group: "multipart_large", risk: "write", doc: doc("obs_04_0098"), subresource: "uploads", responseKind: "xml" },
  { apiName: "UploadPart", title: "上传段", method: "PUT", pathKind: "object", group: "multipart_large", risk: "write", doc: doc("obs_04_0099"), bodyKind: "file", responseKind: "headers", extraQueryKeys: ["partNumber", "uploadId"] },
  { apiName: "CopyPart", title: "拷贝段", method: "PUT", pathKind: "object", group: "multipart_large", risk: "write", doc: doc("obs_04_0100"), responseKind: "headers", extraQueryKeys: ["partNumber", "uploadId"] },
  { apiName: "ListParts", title: "列举已上传未合并的段", method: "GET", pathKind: "object", group: "multipart_large", risk: "read", doc: doc("obs_04_0101"), responseKind: "xml", extraQueryKeys: ["uploadId"] },
  { apiName: "CompleteMultipartUpload", title: "合并段", method: "POST", pathKind: "object", group: "multipart_large", risk: "destructive", doc: doc("obs_04_0102"), bodyKind: "xml", responseKind: "xml", requiresConfirm: "object", extraQueryKeys: ["uploadId"] },
  { apiName: "AbortMultipartUpload", title: "取消多段上传任务", method: "DELETE", pathKind: "object", group: "multipart_large", risk: "delete", doc: doc("obs_04_0103"), responseKind: "empty", requiresConfirm: "object", extraQueryKeys: ["uploadId"] },
  { apiName: "SetBucketPublicAccessBlock", title: "设置桶公共访问阻止配置", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0005"), subresource: "publicAccessBlock", bodyKind: "xml", responseKind: "empty" },
  { apiName: "GetBucketPublicAccessBlock", title: "获取桶公共访问阻止配置", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0005"), subresource: "publicAccessBlock", responseKind: "xml" },
  { apiName: "DeleteBucketPublicAccessBlock", title: "删除桶公共访问阻止配置", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0005"), subresource: "publicAccessBlock", responseKind: "empty", requiresConfirm: "bucket" },
  { apiName: "SetBucketObsCompressPolicy", title: "设置桶在线解压策略(API Explorer别名)", method: "PUT", pathKind: "bucket", group: "bucket_config_xml", risk: "config_write", doc: doc("obs_04_0148"), subresource: "obscompresspolicy", bodyKind: "xml", responseKind: "empty", aliases: ["PutDecompressPolicy"] },
  { apiName: "GetBucketObsCompressPolicy", title: "获取桶在线解压策略(API Explorer别名)", method: "GET", pathKind: "bucket", group: "bucket_config_xml", risk: "read", doc: doc("obs_04_0149"), subresource: "obscompresspolicy", responseKind: "xml", aliases: ["GetDecompressPolicy"] },
  { apiName: "DeleteBucketObsCompressPolicy", title: "删除桶在线解压策略(API Explorer别名)", method: "DELETE", pathKind: "bucket", group: "dangerous_bucket_config", risk: "delete", doc: doc("obs_04_0150"), subresource: "obscompresspolicy", responseKind: "empty", requiresConfirm: "bucket", aliases: ["DeleteDecompressPolicy"] }
];

export const OBS_API_COUNT = 94;

export const obsOperations: OperationSpec[] = rawOperations.map((operation) => {
  const bodyKind = operation.bodyKind ?? "none";
  const responseKind = operation.responseKind ?? "empty";
  return {
    ...operation,
    toolName: `obs_${toSnakeCase(operation.apiName)}`,
    description: `${operation.title} (${operation.apiName}). Risk: ${operation.risk}. Docs: ${operation.doc}`,
    bodyKind,
    responseKind,
    docsUrl: operation.doc,
    inputSchema: makeInputSchema({
      pathKind: operation.pathKind,
      bodyKind,
      requiresConfirm: operation.requiresConfirm,
      includeRange: operation.apiName === "GetObject",
      includeOutputPath: operation.apiName === "GetObject"
    })
  };
});

export function getOperationByToolName(toolName: string): OperationSpec | undefined {
  return obsOperations.find((operation) => operation.toolName === toolName);
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
