// cloud-server/auth.js �� AK/SK ǩ����֤ + JWT ǩ��
// �û��״������� AK/SK ǩ�� �� ��֤ͨ�� �� ���� JWT
// ��������� JWT �� ��ȥ�ظ�ǩ������

import crypto from "node:crypto";
import jwt from "jsonwebtoken";

// ��������Ӧ�ӻ�������/Secrets Manager ��ȡ
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");
const JWT_EXPIRES = process.env.JWT_EXPIRES || "12h";       // JWT ��Ч��
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || "1800000"); // ɳ����г�ʱ 30min

// ========== �û�ע������������������ݿ⣩ ==========
// ��ʽ: { userId: { ak, sk, projectId, openaiKey?, createdAt } }
const userStore = new Map();

// ��ʼ������Ա/�����û������������� API ע�ᣩ
userStore.set("demo-user", {
  userId: "demo-user",
  ak: process.env.DEMO_AK || "",
  sk: process.env.DEMO_SK || "",
  projectId: process.env.DEMO_PROJECT_ID || "",
  openaiKey: process.env.DEMO_OPENAI_KEY || "",
  createdAt: Date.now(),
});

// 预注册 demo 用户（从环境变量注入，POC 阶段用）
if (process.env.DEMO_AK && process.env.DEMO_SK) {
  userStore.set("demo-user", {
    userId: "demo-user",
    ak: process.env.DEMO_AK,
    sk: process.env.DEMO_SK,
    projectId: process.env.DEMO_PROJECT_ID || "",
    createdAt: Date.now(),
  });
}

// ========== AK/SK ǩ����֤ ==========
// ��Ϊ�� SigV4 ǩ����֤�߼����ο���Ϊ�� API ǩ���ĵ���

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256Hex(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

// ��֤ AK/SK ǩ��
// �ͻ��˷���: Authorization: SDK-HMAC-SHA256 Access={AK}, SignedHeaders=..., Signature={sig}
// ����: X-HW-Timestamp, X-HW-Body-Sha256 (��ѡ)
function verifySignature(ak, signature, timestamp, method, path, headers, body) {
  const user = findUserByAk(ak);
  if (!user) return { valid: false, error: "AK ��Ч" };

  // ���طţ�timestamp ƫ����� 15 ����
  const reqTime = parseTimestamp(timestamp);
  if (Math.abs(Date.now() - reqTime) > 900000) {
    return { valid: false, error: "����ʱ������ڣ�����ƫ�� ��15���ӣ�" };
  }

  // ���¼���ǩ��
  const sk = user.sk;
  const region = "cn-south-1";
  const service = "codex-agent";

  // �򻯵Ļ�Ϊ�� SigV4 ��ǩ
  const datestamp = timestamp.slice(0, 8);
  const payloadHash = sha256Hex(body || "");
  const canonicalHeaders = `host:${headers.host || ""}\nx-hw-timestamp:${timestamp}`;
  const signedHeaders = "host;x-hw-timestamp";

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    "",
    canonicalHeaders + "\n",
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${datestamp}/${region}/${service}/sdk_request`;
  const stringToSign = [
    "SDK-HMAC-SHA256",
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = crypto.createHmac("sha256", sk).update(datestamp).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("sdk_request").digest();
  const expectedSig = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  if (signature !== expectedSig) {
    return { valid: false, error: "ǩ����ƥ��" };
  }

  return { valid: true, user };
}

function parseTimestamp(ts) {
  // ��ʽ: 20230720T123456Z
  const y = ts.slice(0, 4), m = ts.slice(4, 6) - 1, d = ts.slice(6, 8);
  const h = ts.slice(9, 11), min = ts.slice(11, 13), s = ts.slice(13, 15);
  return Date.UTC(y, m, d, h, min, s);
}

function findUserByAk(ak) {
  for (const user of userStore.values()) {
    if (user.ak === ak) return user;
  }
  return null;
}

// ========== JWT ǩ������֤ ==========

function issueJwt(userId) {
  return jwt.sign({ sub: userId, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES,
  });
}

function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ========== �û����� ==========

function registerUser({ userId, ak, sk, projectId, openaiKey }) {
  if (userStore.has(userId)) {
    return { ok: false, error: "�û��Ѵ���" };
  }
  userStore.set(userId, { userId, ak, sk, projectId, openaiKey, createdAt: Date.now() });
  return { ok: true };
}

// ========== Auth �м�� ==========

// ��ʽ A: AK/SK ǩ����֤ �� ǩ�� JWT
export function authWithAkSk(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/SDK-HMAC-SHA256 Access=([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "��Ҫ AK/SK ǩ����֤" });

  const [, ak, , signature] = match;
  const timestamp = req.headers["x-hw-timestamp"] || "";

  const result = verifySignature(ak, signature, timestamp, req.method, req.path, req.headers, req.body ? JSON.stringify(req.body) : "");
  if (!result.valid) return res.status(401).json({ error: result.error });

  req.userId = result.user.userId;
  req.user = result.user;
  req.authMethod = "aksk";

  // ǩ�� JWT���ͻ����´ο��� JWT ��ǩ��
  req.issuedJwt = issueJwt(result.user.userId);
  next();
}

// ��ʽ B: JWT ��֤���� AK/SK ǩ����
export function authWithJwt(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "��Ҫ Bearer Token �� AK/SK ǩ��" });
  }

  const token = authHeader.slice(7);
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ error: "JWT ��Ч���ѹ���" });

  const user = userStore.get(payload.sub);
  if (!user) return res.status(401).json({ error: "�û�������" });

  req.userId = payload.sub;
  req.user = user;
  req.authMethod = "jwt";
  next();
}

// �����֤�����ַ�ʽ����
export function authFlexible(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authWithJwt(req, res, next);
  }
  return authWithAkSk(req, res, next);
}

// ========== 登录码管理 ==========
const CODE_TTL_MS = 30000; // 30 秒
const loginCodeStore = new Map(); // code → { createdAt, confirmed, userId }

function generateLoginCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆字符 I/O/0/1
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (loginCodeStore.has(code));
  loginCodeStore.set(code, { createdAt: Date.now(), confirmed: false, userId: null });
  return code;
}

function confirmLoginCode(code) {
  const entry = loginCodeStore.get(code);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CODE_TTL_MS) {
    loginCodeStore.delete(code);
    return null;
  }
  // 取第一个已注册用户
  const users = Array.from(userStore.values());
  if (users.length === 0) return null;
  const userId = users[0].userId;
  entry.confirmed = true;
  entry.userId = userId;
  return issueJwt(userId);
}

function pollLoginCode(code) {
  const entry = loginCodeStore.get(code);
  if (!entry) return { confirmed: false, expired: true };
  if (Date.now() - entry.createdAt > CODE_TTL_MS) {
    loginCodeStore.delete(code);
    return { confirmed: false, expired: true };
  }
  if (entry.confirmed) {
    const token = issueJwt(entry.userId);
    loginCodeStore.delete(code);
    return { confirmed: true, token };
  }
  return { confirmed: false };
}

export { issueJwt, registerUser, verifyJwt, userStore, JWT_SECRET, SESSION_TIMEOUT_MS, generateLoginCode, confirmLoginCode, pollLoginCode };
