// server/incentive.js — 激励服务客户端
// 两个接口: check-coupon-issued (查是否已领), issue-coupon (发券)
// APPCODE 统一配置: INCENTIVE_APPCODE
//
// 认证模式 (二选一):
//   测试环境: 直接设置 INCENTIVE_AUTH_TOKEN 环境变量
//   现网环境: 设置 INCENTIVE_IAM_USERNAME / INCENTIVE_IAM_PASSWORD / INCENTIVE_IAM_DOMAIN_NAME
//             通过 IAM KeystoneCreateUserTokenByPassword 接口动态获取 X-Subject-Token

import { getPool } from "./db.js";
import dns from "node:dns";

const CHECK_URL = process.env.INCENTIVE_CHECK_URL;
const ISSUE_URL = process.env.INCENTIVE_ISSUE_URL;

const INCENTIVE_HW_ID = process.env.INCENTIVE_HW_ID;
const INCENTIVE_APPKEY = process.env.INCENTIVE_APPKEY || "";
const APPCODE = process.env.INCENTIVE_APPCODE || "";

const ACTIVITY_ID = process.env.INCENTIVE_ACTIVITY_ID || "A000330";
const ACTIVITY_PRODUCT_ID = process.env.INCENTIVE_ACTIVITY_PRODUCT_ID || "5649bf1d2bc74d648ac6cd5496ebba91";
const rawAmount = parseInt(process.env.INCENTIVE_FACE_AMOUNT);
if (!rawAmount || rawAmount <= 0) {
  console.error("[incentive] INCENTIVE_FACE_AMOUNT 未配置或无效，请设置后重启");
  process.exit(1);
}
const VOUCHER_FACE_AMOUNT = String(Math.min(rawAmount, 500));
const VOUCHER_CURRENCY = process.env.INCENTIVE_CURRENCY || "CNY";

// ═══ 认证模式 ═══

// 测试环境: 直接使用环境变量中的 token
const INCENTIVE_AUTH_TOKEN = process.env.INCENTIVE_AUTH_TOKEN || "";

// 现网环境: IAM 账密认证
const IAM_ENDPOINT = process.env.INCENTIVE_IAM_ENDPOINT || "https://iam.cn-north-4.myhuaweicloud.com/v3/auth/tokens";
const IAM_USERNAME = process.env.INCENTIVE_IAM_USERNAME;
const IAM_PASSWORD = process.env.INCENTIVE_IAM_PASSWORD;
const IAM_DOMAIN_NAME = process.env.INCENTIVE_IAM_DOMAIN_NAME;

// 运行环境: production = 现网（启用 IAM 认证），其他 = 测试环境（使用 INCENTIVE_AUTH_TOKEN）
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// IAM Token 缓存 (有效期 24h，提前 10min 刷新)
let cachedIamToken = null;
let cachedIamTokenExpiry = 0;

async function fetchIamToken() {
  console.log(`[incentive] fetching IAM token from ${IAM_ENDPOINT}`);
  const resp = await fetch(IAM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf8" },
    body: JSON.stringify({
      auth: {
        identity: {
          methods: ["password"],
          password: {
            user: {
              domain: { name: IAM_DOMAIN_NAME },
              name: IAM_USERNAME,
              password: IAM_PASSWORD,
            },
          },
        },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    let errMsg;
    try { const err = await resp.json(); errMsg = err?.error?.message; } catch (_) { /* ignore parse error */ }
    throw new Error(`IAM token fetch failed: HTTP ${resp.status} ${errMsg || resp.statusText}`);
  }

  const token = resp.headers.get("X-Subject-Token");
  if (!token) throw new Error("IAM response missing X-Subject-Token header");

  const body = await resp.json();
  const expiresAt = body?.token?.expires_at;
  cachedIamTokenExpiry = expiresAt ? new Date(expiresAt).getTime() : Date.now() + 23 * 3600 * 1000;
  cachedIamToken = token;

  console.log(`[incentive] IAM token acquired, expires at ${new Date(cachedIamTokenExpiry).toISOString()}`);
  return token;
}

async function getAuthToken() {
  if (!IS_PRODUCTION) return INCENTIVE_AUTH_TOKEN;

  // 缓存有效时直接返回 (提前 10 分钟过期刷新)
  if (cachedIamToken && Date.now() < cachedIamTokenExpiry - 600000) {
    return cachedIamToken;
  }

  return fetchIamToken();
}

async function buildHeaders(extra = {}) {
  const token = await getAuthToken();
  return {
    "Content-Type": "application/json",
    "X-HW-ID": INCENTIVE_HW_ID,
    "X-HW-APPKEY": INCENTIVE_APPKEY,
    "X-auth-token": token,
    ...extra,
  };
}

export function isBetaAPI() {
  return process.env.NODE_ENV !== "production";
}

async function fetchWithFreshDNS(url, options) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (i === 0 && (err.cause?.code === "ECONNREFUSED" || err.cause?.code === "ENOTFOUND" || err.cause?.code === "EAI_AGAIN")) {
        try {
          const parsed = new URL(url);
          await dns.promises.resolve4(parsed.hostname);
          await dns.promises.resolve6(parsed.hostname);
        } catch {}
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function checkCouponIssued(customerId) {
  const body = JSON.stringify({ customer_id: customerId, scene_type: 40 });
  const maskedCustomerId = customerId.slice(0, 8);
  console.log(`[incentive] check-coupon REQUEST → ${CHECK_URL}`);
  console.log(`[incentive] check-coupon BODY → customer_id=${maskedCustomerId}*** scene_type=40`);
  try {
    const headers = await buildHeaders({ "X-APIG-APPCODE": APPCODE });
    console.log(`[incentive] check-coupon HEADERS → X-APIG-APPCODE:${APPCODE.slice(0,8)}*** X-auth-token:${headers["X-auth-token"].slice(0,8)}***`);
    const resp = await fetchWithFreshDNS(CHECK_URL, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    const { customer_id, ...safeData } = data;
    console.log(`[incentive] check-coupon RESPONSE → HTTP ${resp.status} ${JSON.stringify(safeData, null, 2)}`);
    if (data.error_code) {
      console.error(`[incentive] check error: ${data.error_code} ${data.error_msg}`);
      return { issued: false, serviceError: true, error: data.error_msg };
    }
    return { issued: data.issued_tag === 1, raw: data };
  } catch (err) {
    console.error(`[incentive] check failed: ${err.message}`);
    return { issued: false, serviceError: true, error: err.message };
  }
}

export async function issueCoupon(customerId) {
  const body = JSON.stringify({
    customer_id: customerId,
    activity_id: ACTIVITY_ID,
    activity_product_id: ACTIVITY_PRODUCT_ID,
    face_amount: VOUCHER_FACE_AMOUNT,
    currency_code: VOUCHER_CURRENCY,
    is_send_notify: "0",
    service_resource_type: 1,
  });
  const maskedCustomerId = customerId.slice(0, 8);
  console.log(`[incentive] issue-coupon REQUEST → ${ISSUE_URL}`);
  console.log(`[incentive] issue-coupon BODY → customer_id=${maskedCustomerId}*** activity_id=${ACTIVITY_ID} activity_product_id=${ACTIVITY_PRODUCT_ID} face_amount=${VOUCHER_FACE_AMOUNT} currency_code=${VOUCHER_CURRENCY}`);
  try {
    const headers = await buildHeaders({ "X-APIG-APPCODE": APPCODE });
    console.log(`[incentive] issue-coupon HEADERS → X-APIG-APPCODE:${APPCODE.slice(0,8)}*** X-auth-token:${headers["X-auth-token"].slice(0,8)}***`);
    const resp = await fetchWithFreshDNS(ISSUE_URL, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    const { customer_id, ...issueSafeData } = data;
    console.log(`[incentive] issue-coupon RESPONSE → HTTP ${resp.status} ${JSON.stringify(issueSafeData, null, 2)}`);
    if (data.error_code) {
      console.error(`[incentive] issue error: ${data.error_code} ${data.error_msg}`);
      return { success: false, error: data.error_msg, errorCode: data.error_code };
    }
    const couponId = data.coupon_id || data.data?.coupon_id;
    if (!couponId) {
      console.error(`[incentive] issue response missing coupon_id: ${JSON.stringify(issueSafeData).slice(0, 300)}`);
      return { success: false, error: "发券失败" };
    }
    return { success: true, couponId, raw: data };
  } catch (err) {
    console.error(`[incentive] issue failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
