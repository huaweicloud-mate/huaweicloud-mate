// server/incentive.js — 激励服务客户端
// 两个接口: check-coupon-issued (查是否已领), issue-coupon (发券)
// APPCODE 分开配置: INCENTIVE_CHECK_APPCODE / INCENTIVE_ISSUE_APPCODE

const CHECK_URL = process.env.INCENTIVE_CHECK_URL || `${process.env.INCENTIVE_API_URL || "https://apigw-beta.huawei.com/api/v1/hdincentiveservice/coupon"}/check-coupon-issued`;
const ISSUE_URL = process.env.INCENTIVE_ISSUE_URL || `${process.env.INCENTIVE_API_URL || "https://apigw-beta.huawei.com/api/v1/hdincentiveservice/coupon"}/issue-coupon`;

const INCENTIVE_HW_ID = process.env.INCENTIVE_HW_ID || "com.huawei.cloudbu.developer.community";
const INCENTIVE_APPKEY = process.env.INCENTIVE_APPKEY || "";
const INCENTIVE_AUTH_TOKEN = process.env.INCENTIVE_AUTH_TOKEN || "";

// 两个接口的 APPCODE 不同
const CHECK_APPCODE = process.env.INCENTIVE_CHECK_APPCODE || process.env.INCENTIVE_APPCODE || "5MkJTaYq6L6S8xBm1TtOcLoBOfuDKkrV2bj3T8fvlGWtLp2WaJzKCP5darNWFa19";
const ISSUE_APPCODE = process.env.INCENTIVE_ISSUE_APPCODE || process.env.INCENTIVE_APPCODE || "dqNEJDPTs24IglOAwhA7UfFaknYd15s1F5lTxY3co0u02CLQCCckclhdkL2LGj94";

const ACTIVITY_ID = process.env.INCENTIVE_ACTIVITY_ID || "A000330";
const ACTIVITY_PRODUCT_ID = process.env.INCENTIVE_ACTIVITY_PRODUCT_ID || "5649bf1d2bc74d648ac6cd5496ebba91";
const VOUCHER_FACE_AMOUNT = process.env.INCENTIVE_FACE_AMOUNT || "100";
const VOUCHER_CURRENCY = process.env.INCENTIVE_CURRENCY || "CNY";
const MAX_VOUCHERS = parseInt(process.env.INCENTIVE_MAX_VOUCHERS || "0");

// 判断当前是否为测试环境
export function isBetaAPI() {
  const url = process.env.INCENTIVE_API_URL || CHECK_URL || "";
  return url.includes("apigw-beta");
}

const baseHeaders = {
  "Content-Type": "application/json",
  "X-HW-ID": INCENTIVE_HW_ID,
  "X-HW-APPKEY": INCENTIVE_APPKEY,
  "X-auth-token": INCENTIVE_AUTH_TOKEN,
};

export async function checkCouponIssued(customerId) {
  const body = JSON.stringify({ customer_id: customerId, scene_type: 40 });
  const maskedCustomerId = customerId.slice(0, 8);
  console.log(`[incentive] check-coupon REQUEST → ${CHECK_URL}`);
  console.log(`[incentive] check-coupon BODY → customer_id=${maskedCustomerId}*** scene_type=40`);
  console.log(`[incentive] check-coupon HEADERS → X-APIG-APPCODE:${CHECK_APPCODE.slice(0,8)}*** X-auth-token:${INCENTIVE_AUTH_TOKEN.slice(0,8)}***`);
  try {
    const resp = await fetch(CHECK_URL, {
      method: "POST",
      headers: { ...baseHeaders, "X-APIG-APPCODE": CHECK_APPCODE },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    const { customer_id, ...safeData } = data;
    console.log(`[incentive] check-coupon RESPONSE → HTTP ${resp.status} ${JSON.stringify(safeData).slice(0, 200)}`);
    if (data.error_code) {
      console.error(`[incentive] check error: ${data.error_code} ${data.error_msg}`);
      return { issued: false, error: data.error_msg };
    }
    return { issued: data.issued_tag === 1, raw: data };
  } catch (err) {
    console.error(`[incentive] check failed: ${err.message}`);
    return { issued: false, error: err.message };
  }
}

export async function checkLocalQuota() {
  if (MAX_VOUCHERS <= 0) return { reached: false };
  try {
    const { default: mysql } = await import("mysql2/promise");
    const pool = mysql.createPool({
      host: process.env.MYSQL_HOST || "10.0.1.242",
      port: parseInt(process.env.MYSQL_PORT || "3306"),
      user: process.env.MYSQL_USER || "root",
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || "hdkitservice",
      connectTimeout: 5000,
    });
    const [rows] = await pool.execute("SELECT COUNT(*) as cnt FROM voucher_records WHERE status = 1");
    await pool.end();
    const cnt = rows[0]?.cnt || 0;
    return { reached: cnt >= MAX_VOUCHERS, count: cnt, max: MAX_VOUCHERS };
  } catch (err) {
    console.error(`[incentive] quota check failed: ${err.message}`);
    return { reached: false };
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
    const resp = await fetch(ISSUE_URL, {
      method: "POST",
      headers: { ...baseHeaders, "X-APIG-APPCODE": ISSUE_APPCODE },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    const { customer_id, ...issueSafeData } = data;
    console.log(`[incentive] issue-coupon RESPONSE → HTTP ${resp.status} ${JSON.stringify(issueSafeData).slice(0, 300)}`);
    if (data.error_code) {
      console.error(`[incentive] issue error: ${data.error_code} ${data.error_msg}`);
      return { success: false, error: data.error_msg, errorCode: data.error_code };
    }
    const couponId = data.coupon_id || data.data?.coupon_id || `vc_${Date.now()}`;
    return { success: true, couponId, raw: data };
  } catch (err) {
    console.error(`[incentive] issue failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
