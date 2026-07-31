// cloud-server/sandbox.js — K8s Job 管理
// Job 状态持久化到 DCS Redis，Server 重启不丢
import k8s from "@kubernetes/client-node";
import { getJob, setJob, delJob, isRedisAvailable, acquireLock, releaseLock } from "./redis-store.js";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const batchApi = kc.makeApiClient(k8s.BatchV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const NAMESPACE = process.env.NAMESPACE || "huaweicloud-agent";
const MAX_CONCURRENT = parseInt(process.env.MAX_SANDBOXES || "5");
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent/sandbox:latest";
const SANDBOX_STARTUP_TIMEOUT = parseInt(process.env.SANDBOX_STARTUP_TIMEOUT || "90");
const USER_SANDBOX_TTL = parseInt(process.env.USER_SANDBOX_TTL || "300");
const ANON_SANDBOX_TTL = parseInt(process.env.ANON_SANDBOX_TTL || "60");

const jobStatusCache = new Map(); // 本地 Pod 状态缓存，Redis 存 Job 元信息
const MAX_ANON_SANDBOXES = parseInt(process.env.MAX_ANON_SANDBOXES || "3");

async function hasActive(userId) {
  const job = await getJobSafe(userId);
  if (!job) return false;
  const status = jobStatusCache.get(job.jobName);
  return status && status.phase === "Running";
}

async function getJobSafe(userId) {
  try { return await getJob(userId); } catch { return null; }
}

async function reconcileCache() {
  try {
    const { body } = await coreApi.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, "status.phase=Running", "app=sandbox");
    const runningPods = new Set(body.items.map(p => p.metadata?.labels?.["job-name"]).filter(Boolean));
    for (const jobName of jobStatusCache.keys()) {
      if (!runningPods.has(jobName)) {
        jobStatusCache.delete(jobName);
        console.log(`[sandbox] pruned stale cache: ${jobName}`);
      }
    }
  } catch (err) {
    console.log(`[sandbox] reconcile failed: ${err.message}`);
  }
}

async function checkConcurrency() {
  if (jobStatusCache.size >= MAX_CONCURRENT) {
    await reconcileCache();
    if (jobStatusCache.size >= MAX_CONCURRENT) {
      throw new Error(`已达最大并发沙箱数 (${MAX_CONCURRENT})，请稍后重试`);
    }
  }
}

async function checkAnonConcurrency() {
  let anonCount = 0;
  for (const key of jobStatusCache.keys()) {
    if (key.startsWith("sandbox-anon-")) anonCount++;
  }
  if (anonCount >= MAX_ANON_SANDBOXES) {
    await reconcileCache();
    anonCount = 0;
    for (const key of jobStatusCache.keys()) {
      if (key.startsWith("sandbox-anon-")) anonCount++;
    }
    if (anonCount >= MAX_ANON_SANDBOXES) {
      throw new Error(`已达最大匿名沙箱数 (${MAX_ANON_SANDBOXES})，请稍后重试`);
    }
  }
}

async function getOrCreateContainer(userId, user) {
  const existingJob = await getJobSafe(userId);
  if (existingJob) {
    const status = jobStatusCache.get(existingJob.jobName);
    if (status && status.phase === "Running") {
      return { id: status.podName, podIp: status.podIp, sessionId: existingJob.sessionId };
    }
  }

  const lockKey = `lock:sandbox:${userId}`;
  const locked = await acquireLock(lockKey, 60000);
  if (!locked) {
    console.log(`[sandbox] ${userId} sandbox creation already in progress, waiting...`);
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const job = await getJobSafe(userId);
      if (job) {
        const status = jobStatusCache.get(job.jobName);
        if (status && status.phase === "Running") {
          return { id: status.podName, podIp: status.podIp, sessionId: job.sessionId };
        }
      }
    }
    throw new Error(`Sandbox for ${userId} not ready after waiting 60s`);
  }

  try {
    const recheckJob = await getJobSafe(userId);
    if (recheckJob) {
      const status = jobStatusCache.get(recheckJob.jobName);
      if (status && status.phase === "Running") {
        releaseLock(lockKey).catch(err => console.error(`[sandbox] releaseLock failed: ${err.message}`));
        return { id: status.podName, podIp: status.podIp, sessionId: recheckJob.sessionId };
      }
    }

    await checkConcurrency();

    const jobName = `sandbox-${userId.replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`;
    const job = {
    apiVersion: "batch/v1",
    kind: "Job",
      metadata: { name: jobName, namespace: NAMESPACE, labels: { app: "sandbox" } },
      spec: {
        ttlSecondsAfterFinished: USER_SANDBOX_TTL,
        template: {
          metadata: { labels: { app: "sandbox", "job-name": jobName } },
          spec: {
          imagePullSecrets: [{ name: "swr-secret" }],
           restartPolicy: "Never",
           containers: [{
            name: "sandbox",
            image: SANDBOX_IMAGE,
            imagePullPolicy: "Always",
            env: [
              { name: "NODE_PATH", value: "/usr/local/lib/node_modules" },
              { name: "HW_ACCESS_KEY", value: user.ak || "" },
              { name: "HW_SECRET_KEY", value: user.sk || "" },
              ...(user.securityToken ? [{ name: "HW_SECURITY_TOKEN", value: user.securityToken }] : []),
              { name: "DEEPSEEK_API_KEY", value: process.env.DEEPSEEK_API_KEY || "" },
            ],
            resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } },
            volumeMounts: [{ name: "skills", mountPath: "/skills" }, { name: "workspace", mountPath: "/workspace" }, { name: "tmp", mountPath: "/tmp" }, { name: "hcloud-home", mountPath: "/home/node/.hcloud" }, { name: "node-home", mountPath: "/home/node" }],
            securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true, seccompProfile: { type: "RuntimeDefault" } },
            readinessProbe: { httpGet: { path: "/global/health", port: 3005 }, initialDelaySeconds: 10, periodSeconds: 5 },
          }],
          volumes: [{ name: "skills", emptyDir: {} }, { name: "workspace", emptyDir: {} }, { name: "tmp", emptyDir: {} }, { name: "hcloud-home", emptyDir: {} }, { name: "node-home", emptyDir: {} }],
        },
      },
    },
  };

  await batchApi.createNamespacedJob(NAMESPACE, job).catch(async (err) => {
    if (err.statusCode === 409) {
      console.log(`[sandbox] ${userId} job exists, reusing`);
      return;
    }
    throw err;
  });
  const podName = await waitForPodReady(jobName);
  const podIp = await getPodIp(podName);

  let sessionId = null;
  try {
    const sResp = await fetch(`http://${podIp}:3005/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const session = await sResp.json();
    sessionId = session.id;
  } catch (err) { console.error(`[sandbox] session create failed for ${jobName}: ${err.message}`); }

  jobStatusCache.set(jobName, { podName, podIp, phase: "Running" });
  if (isRedisAvailable()) {
    setJob(userId, { jobName, podName, podIp, sessionId: sessionId || "", startTime: Date.now() }).catch((err) => { console.error(`[sandbox] setJob failed: ${err.message}`); });
  }

  console.log(`[sandbox] ${userId} pod ${podName} ready at ${podIp}:3005 session=${sessionId}`);
  return { id: podName, podIp, sessionId };
  } finally {
    releaseLock(lockKey).catch(err => console.error(`[sandbox] releaseLock failed: ${err.message}`));
  }
}

async function waitForPodReady(jobName) {
  for (let i = 0; i < SANDBOX_STARTUP_TIMEOUT; i++) {
    const { body } = await coreApi.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, `job-name=${jobName}`);
    if (body.items.length > 0 && body.items[0].status?.phase === "Running" && body.items[0].status?.conditions?.some(c => c.type === "Ready" && c.status === "True")) {
      return body.items[0].metadata.name;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Sandbox pod for job ${jobName} not ready after ${SANDBOX_STARTUP_TIMEOUT}s`);
}

async function getPodIp(podName) {
  const { body } = await coreApi.readNamespacedPod(podName, NAMESPACE);
  return body.status.podIP;
}

function releaseContainer(userId) {
  if (isRedisAvailable()) delJob(userId).catch((err) => { console.error(`[sandbox] delJob on release failed: ${err.message}`); });
}

async function destroyContainer(userId) {
  try {
    const existing = await getJobSafe(userId);
    if (existing) {
      await batchApi.deleteNamespacedJob(existing.jobName, NAMESPACE).catch((err) => { console.error(`[sandbox] deleteNamespacedJob failed: ${err.message}`); });
      jobStatusCache.delete(existing.jobName);
    }
  } catch (err) { console.error(`[sandbox] destroyContainer failed for ${userId}: ${err.message}`); }
  if (isRedisAvailable()) delJob(userId).catch((err) => { console.error(`[sandbox] delJob on destroy failed: ${err.message}`); });
}

function getConcurrencyStats() {
  return { active: jobStatusCache.size, max: MAX_CONCURRENT };
}

function isAtConcurrencyLimit(userId) {
  if (jobStatusCache.size < MAX_CONCURRENT) return false;
  const jobName = `sandbox-${userId.replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`;
  const existing = jobStatusCache.get(jobName);
  return !existing || existing.phase !== "Running";
}

// ── 启动时从 K8s 调和活跃 Job ──
export async function reconcileActiveJobs() {
  try {
    const { body } = await batchApi.listNamespacedJob(NAMESPACE, undefined, undefined, undefined, undefined, "app=sandbox");
    for (const job of body.items) {
      if (job.status?.active === 1) {
        const jobName = job.metadata.name;
        const pods = await coreApi.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, `job-name=${jobName}`);
        for (const pod of pods.body.items) {
          if (pod.status?.phase === "Running" && pod.status?.podIP) {
            jobStatusCache.set(jobName, { podName: pod.metadata.name, podIp: pod.status.podIP, phase: "Running" });
            console.log(`[sandbox] reconciled existing: ${jobName} @ ${pod.status.podIP}`);
          }
        }
      }
    }
  } catch (err) { console.log(`[sandbox] reconcile skipped: ${err.message}`); }
}

// ── 匿名沙箱（公共只读 AK/SK，不关联用户） ──

async function createAnonymousContainer() {
  const lockKey = `lock:sandbox:anon`;
  const locked = await acquireLock(lockKey, 60000);
  if (!locked) {
    throw new Error("匿名沙箱创建过于频繁，请稍后重试");
  }

  await checkAnonConcurrency();
  await checkConcurrency();

  try {
    const jobName = `sandbox-anon-${Date.now().toString(36)}`;
    const job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: jobName, namespace: NAMESPACE, labels: { app: "sandbox" } },
      spec: {
        ttlSecondsAfterFinished: ANON_SANDBOX_TTL, // 快速清理
        template: {
          metadata: { labels: { app: "sandbox", "job-name": jobName } },
          spec: {
            imagePullSecrets: [{ name: "swr-secret" }],
             restartPolicy: "Never",
             containers: [{
              name: "sandbox",
              image: SANDBOX_IMAGE,
              imagePullPolicy: "Always",
              env: [
                { name: "NODE_PATH", value: "/usr/local/lib/node_modules" },
                { name: "HW_ACCESS_KEY", value: "" },
                { name: "HW_SECRET_KEY", value: "" },
                { name: "DEEPSEEK_API_KEY", value: process.env.DEEPSEEK_API_KEY || "" },
              ],
              resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } },
              volumeMounts: [{ name: "skills", mountPath: "/skills" }, { name: "workspace", mountPath: "/workspace" }, { name: "tmp", mountPath: "/tmp" }, { name: "hcloud-home", mountPath: "/home/node/.hcloud" }, { name: "node-home", mountPath: "/home/node" }],
              securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true, seccompProfile: { type: "RuntimeDefault" } },
              readinessProbe: { httpGet: { path: "/global/health", port: 3005 }, initialDelaySeconds: 10, periodSeconds: 5 },
            }],
            volumes: [{ name: "skills", emptyDir: {} }, { name: "workspace", emptyDir: {} }, { name: "tmp", emptyDir: {} }, { name: "hcloud-home", emptyDir: {} }, { name: "node-home", emptyDir: {} }],
          },
        },
      },
    };

  await batchApi.createNamespacedJob(NAMESPACE, job).catch(async (err) => {
    if (err.statusCode === 409) { console.log(`[sandbox] anon ${jobName} exists`); return; }
    throw err;
  });
  const podName = await waitForPodReady(jobName);
  const podIp = await getPodIp(podName);

  let sessionId = null;
  try {
    const sResp = await fetch(`http://${podIp}:3005/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const session = await sResp.json();
    sessionId = session.id;
  } catch (err) { console.error(`[sandbox] anon session create failed for ${jobName}: ${err.message}`); }

  jobStatusCache.set(jobName, { podName, podIp, phase: "Running" });
  console.log(`[sandbox] anon ${jobName} ready at ${podIp}:3005 session=${sessionId}`);
  return { id: podName, podIp, sessionId };
  } finally {
    releaseLock(lockKey).catch(err => console.error(`[sandbox] releaseLock anon failed: ${err.message}`));
  }
}

async function destroyAnonymousContainer(podId) {
  // 匿名沙箱不追踪，靠 ttlSecondsAfterFinished 自动清理
  // 这里仅从缓存移除
}

export { getOrCreateContainer, createAnonymousContainer, releaseContainer, destroyContainer, getConcurrencyStats, isAtConcurrencyLimit };
