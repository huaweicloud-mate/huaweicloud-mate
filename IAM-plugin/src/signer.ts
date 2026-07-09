/**
 * signer.ts — 华为云 AK/SK 请求签名模块
 *
 * 实现 SDK-HMAC-SHA256 签名算法，遵循华为云 API 签名认证机制：
 *   StringToSign = Algorithm + \n + RequestDateTime + \n + HashedCanonicalRequest
 *   signature = HexEncode(HMAC(SK, StringToSign))
 *
 * 参考: https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-001.html
 */

import crypto from "crypto";

// ---- 工具函数 ----

function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

/** ISO 8601 UTC: 20250709T081530Z */
function sdkDate(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** URI 编码每个路径段 + 末尾补 "/" */
function canonicalURI(pathname: string): string {
  const encoded = pathname
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");
  return encoded.endsWith("/") ? encoded : encoded + "/";
}

/** 排序后的规范化 query string */
function canonicalQueryString(searchParams: URLSearchParams): string {
  const params: [string, string][] = [];
  searchParams.forEach((v, k) => params.push([encodeURIComponent(k), encodeURIComponent(v)]));
  params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return params.map(([k, v]) => `${k}=${v}`).join("&");
}

// ---- 签名主函数 ----

export interface SignOptions {
  extraHeaders?: Record<string, string>;
}

/**
 * 对请求计算 AK/SK 签名，返回需附加的 headers
 */
export function signRequest(
  ak: string,
  sk: string,
  method: string,
  url: string,
  body: string = "",
  opts: SignOptions = {}
): Record<string, string> {
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const date = sdkDate();
  const payloadHash = sha256(body);

  // 收集签名头
  const headersToSign: Record<string, string> = {
    host,
    "x-sdk-date": date,
  };
  if (body) {
    headersToSign["content-type"] = "application/json";
  }
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) {
      headersToSign[k.toLowerCase()] = v;
    }
  }

  const sortedNames = Object.keys(headersToSign).sort();
  const canonicalHeaders =
    sortedNames.map((n) => `${n}:${headersToSign[n].trim()}`).join("\n") + "\n";
  const signedHeadersStr = sortedNames.join(";");

  // Step 1: 规范请求
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalURI(parsedUrl.pathname),
    canonicalQueryString(parsedUrl.searchParams),
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join("\n");

  const hashedCanonical = sha256(canonicalRequest);

  // Step 2: 创建待签字符串
  // Algorithm + \n + RequestDateTime + \n + HashedCanonicalRequest
  const stringToSign = `SDK-HMAC-SHA256\n${date}\n${hashedCanonical}`;

  // Step 3: 计算签名 — 直接用 SK 做 HMAC 密钥，无派生链
  // signature = HexEncode(HMAC(Secret Access Key, string to sign))
  const signature = hmacSha256(sk, stringToSign).toString("hex");

  // --- debug ---
  if (process.env.HUAWEI_DEBUG_SIGN) {
    console.error(`[signer] version: standard`);
    console.error(`[signer] canonicalRequest: ${canonicalRequest.split("\n").join("|")}`);
    console.error(`[signer] stringToSign:     ${stringToSign.split("\n").join("|")}`);
    console.error(`[signer] signature:       ${signature}`);
  }

  // Step 4: 构造 Authorization
  const authorization = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  const result: Record<string, string> = {
    Host: host,
    "X-Sdk-Date": date,
    Authorization: authorization,
    ...(opts.extraHeaders || {}),
  };
  if (body) result["Content-Type"] = "application/json";

  return result;
}

/**
 * 发送带 AK/SK 签名的 HTTP 请求
 */
export async function signedFetch(
  ak: string,
  sk: string,
  method: string,
  url: string,
  body?: unknown,
  opts: SignOptions = {}
): Promise<Response> {
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = signRequest(ak, sk, method, url, bodyStr, opts);
  const fetchHeaders: Record<string, string> = { ...headers };
  delete fetchHeaders.Host; // fetch 自动设

  return fetch(url, {
    method,
    headers: fetchHeaders,
    body: bodyStr || undefined,
  });
}
