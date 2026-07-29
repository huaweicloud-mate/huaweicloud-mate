// server/incentive.js — 激励服务客户端
// 两个接口: check-coupon-issued (查是否已领), issue-coupon (发券)

const INCENTIVE_BASE = process.env.INCENTIVE_API_URL || "https://apigw-beta.huawei.com/api/v1/hdincentiveservice/coupon";
const INCENTIVE_HW_ID = process.env.INCENTIVE_HW_ID || "com.huawei.cloudbu.developer.community";
const INCENTIVE_APPKEY = process.env.INCENTIVE_APPKEY || "";
const INCENTIVE_APPCODE = process.env.INCENTIVE_APPCODE || "";
const INCENTIVE_AUTH_TOKEN = process.env.INCENTIVE_AUTH_TOKEN || "";

const ACTIVITY_ID = process.env.INCENTIVE_ACTIVITY_ID || "A000330";
const ACTIVITY_PRODUCT_ID = process.env.INCENTIVE_ACTIVITY_PRODUCT_ID || "5649bf1d2bc74d648ac6cd5496ebba91";
const VOUCHER_FACE_AMOUNT = process.env.INCENTIVE_FACE_AMOUNT || "100";
const VOUCHER_CURRENCY = process.env.INCENTIVE_CURRENCY || "CNY";
const MAX_VOUCHERS = parseInt(process.env.INCENTIVE_MAX_VOUCHERS || "0"); // 0=不限制

const headers = {
  "Content-Type": "application/json",
  "X-HW-ID": INCENTIVE_HW_ID,
  "X-HW-APPKEY": INCENTIVE_APPKEY,
  "X-APIG-APPCODE": INCENTIVE_APPCODE,
  "X-auth-token": INCENTIVE_AUTH_TOKEN,
};

/**
 * 查询用户是否已领取代金券
 * @returns { issued: boolean, raw: object }
 */
export async function checkCouponIssued(customerId) {
  try {
    const resp = await fetch(`${INCENTIVE_BASE}/check-coupon-issued`, {
      method: "POST", headers,
      body: JSON.stringify({ customer_id: customerId, scene_type: 40 }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    if (data.error_code) {
      console.error(`[incentive] check-coupon error: ${data.error_code} ${data.error_msg}`);
      return { issued: false, error: data.error_msg };
    }
    return { issued: data.issued_tag === 1, raw: data };
  } catch (err) {
    console.error(`[incentive] check-coupon failed: ${err.message}`);
    return { issued: false, error: err.message };
  }
}

/**
 * 查询 hdkitservice 本地是否已达领取上限
 */
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

/**
 * 发放代金券
 * @returns { success: boolean, couponId?: string, error?: string }
 */
export async function issueCoupon(customerId) {
  try {
    const resp = await fetch(`${INCENTIVE_BASE}/issue-coupon`, {
      method: "POST", headers,
      body: JSON.stringify({
        customer_id: customerId,
        activity_id: ACTIVITY_ID,
        activity_product_id: ACTIVITY_PRODUCT_ID,
        face_amount: VOUCHER_FACE_AMOUNT,
        currency_code: VOUCHER_CURRENCY,
        is_send_notify: "0",
        service_resource_type: 1,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    if (data.error_code) {
      console.error(`[incentive] issue-coupon error: ${data.error_code} ${data.error_msg}`);
      return { success: false, error: data.error_msg };
    }
    return { success: true, couponId: data.coupon_id, raw: data };
  } catch (err) {
    console.error(`[incentive] issue-coupon failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
