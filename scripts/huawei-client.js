// scripts/huawei-client.js — 华为云 IAM AK/SK 签名客户端
// 用于通过华为云 API 管理 ECS（启动/停止/获取临时 SSH 凭证等）
// 当前默认走 SSH 直连，此模块为高级 API 调用预留

import crypto from "node:crypto";

// 华为云 AK/SK 签名 v4 (参考华为云 API 签名指南)
// https://support.huaweicloud.com/devg-apisign/api-sign-algorithm.html

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function hmacSha256Hex(key, data) {
  return hmacSha256(key, data).toString("hex");
}

// 构建华为云 SigV4 签名的 CanonicalRequest
export function signRequest(ak, sk, region, service, method, uri, query, headers, body) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const datestamp = timestamp.slice(0, 8);

  // 1. Canonical Request
  const canonicalHeaders = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
    .join("\n");
  const signedHeaders = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort()
    .join(";");

  const payloadHash = sha256Hex(body || "");
  const canonicalRequest = [
    method.toUpperCase(),
    uri || "/",
    query || "",
    canonicalHeaders + "\n",
    signedHeaders,
    payloadHash,
  ].join("\n");

  // 2. String to Sign
  const algorithm = "SDK-HMAC-SHA256";
  const credentialScope = `${datestamp}/${region}/${service}/sdk_request`;
  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // 3. Signature
  const kDate = hmacSha256(Buffer.from(sk, "utf-8"), datestamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "sdk_request");
  const signature = hmacSha256Hex(kSigning, stringToSign);

  // 4. Authorization Header
  const authorization = `${algorithm} Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, timestamp, payloadHash };
}
