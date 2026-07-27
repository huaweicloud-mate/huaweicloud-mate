// cloud-server/db.js — MySQL 数据库操作
import mysql from "mysql2/promise";
import crypto from "node:crypto";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "mysql",
  port: parseInt(process.env.MYSQL_PORT || "3306"),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD ,
  database: process.env.MYSQL_DATABASE || "hdkitservice",
  waitForConnections: true,
  connectionLimit: 5,
});

// 建表
pool.execute(`CREATE TABLE IF NOT EXISTS voucher_records (
  domain_id  VARCHAR(32)  PRIMARY KEY,
  ak_hash    VARCHAR(64)  NOT NULL,
  voucher_id VARCHAR(64),
  amount     INT          DEFAULT 100,
  status     TINYINT      DEFAULT 1,
  claimed_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ak_hash (ak_hash)
)`).catch(() => {});

export async function getDomainId(ak, sk) {
  try {
    const region = "cn-south-1";
    const host = `iam.${region}.myhuaweicloud.com`;
    const path = "/v3/auth/domains";
    const method = "GET";

    const t = new Date();
    const ts = t.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

    const body = "";
    const sha256 = (d) => crypto.createHash("sha256").update(d).digest("hex");
    const hmacSha256 = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

    const canonicalHeaders = `host:${host}\nx-sdk-date:${ts}\n`;
    const signedHeaders = "host;x-sdk-date";
    const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;

    const datestamp = t.toISOString().slice(0, 10).replace(/-/g, "");
    const scope = `${datestamp}/${region}/iam/sdk_request`;
    const stringToSign = `SDK-HMAC-SHA256\n${ts}\n${scope}\n${sha256(canonicalRequest)}`;

    const kDate = hmacSha256(sk, datestamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, "iam");
    const kSigning = hmacSha256(kService, "sdk_request");
    const sig = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    const auth = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

    const resp = await fetch(`https://${host}${path}`, {
      method, headers: { "X-Sdk-Date": ts, "Authorization": auth },
    });
    const data = await resp.json();
    return data?.domains?.[0]?.id || null;
  } catch {
    return null;
  }
}

export async function getVoucher(domainId) {
  const [rows] = await pool.execute("SELECT * FROM voucher_records WHERE domain_id = ?", [domainId]);
  return rows[0] || null;
}

export async function claimVoucher(domainId, akHash, voucherId, amount) {
  await pool.execute(
    "INSERT INTO voucher_records (domain_id, ak_hash, voucher_id, amount, status) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE voucher_id=?, amount=?, status=1",
    [domainId, akHash, voucherId, amount, voucherId, amount]
  );
}

export async function markVoucherClaimed(domainId, akHash) {
  await pool.execute(
    "INSERT INTO voucher_records (domain_id, ak_hash, status) VALUES (?, ?, 2) ON DUPLICATE KEY UPDATE status=2",
    [domainId, akHash]
  );
}
