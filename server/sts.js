// cloud-server/sts.js — IAM STS 临时凭证客户端
// 用用户长期 AK/SK 换取 6h 有效的临时 AK/SK/SecurityToken
import crypto from "node:crypto";

/**
 * 创建临时访问凭证
 * POST /v3.0/OS-CREDENTIAL/securitytokens
 */
export async function createTemporaryCredentials(ak, sk, region = "cn-south-1") {
  const host = `iam.${region}.myhuaweicloud.com`;
  const path = "/v3.0/OS-CREDENTIAL/securitytokens";
  const method = "POST";
  const body = JSON.stringify({
    credential: {
      description: "hc-devkit-sandbox-session",
    },
  });

  const t = new Date();
  const ts = t.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const sha256 = (d) => crypto.createHash("sha256").update(d).digest("hex");
  const hmacSha256 = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-sdk-date:${ts}\n`;
  const signedHeaders = "content-type;host;x-sdk-date";
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

  try {
    const resp = await fetch(`https://${host}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Sdk-Date": ts, Authorization: auth },
      body,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`STS HTTP ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    const cred = data.credential;
    if (!cred?.access || !cred?.secret) {
      throw new Error(`STS response missing credentials: ${JSON.stringify(data).slice(0, 200)}`);
    }

    return {
      ak: cred.access,
      sk: cred.secret,
      securityToken: cred.securitytoken || "",
      expiresAt: cred.expires_at || new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    };
  } catch (err) {
    console.error(`[sts] Failed to create temporary credentials: ${err.message}`);
    throw err;
  }
}
