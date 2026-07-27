// cloud-server/sandbox.js — K8s Job 管理
// Job 状态持久化到 DCS Redis，Server 重启不丢
import k8s from "@kubernetes/client-node";
import { getJob, setJob, delJob, isRedisAvailable } from "./redis-store.js";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const batchApi = kc.makeApiClient(k8s.BatchV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const NAMESPACE = process.env.NAMESPACE || "huaweicloud-agent";
const MAX_CONCURRENT = parseInt(process.env.MAX_SANDBOXES || "5");
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent/sandbox:latest";

const jobStatusCache = new Map(); // 本地 Pod 状态缓存，Redis 存 Job 元信息
const PUBLIC_AK = process.env.PUBLIC_READONLY_AK || "";
const PUBLIC_SK = process.env.PUBLIC_READONLY_SK || "";
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

async function getOrCreateContainer(userId, user) {
  const existingJob = await getJobSafe(userId);
  if (existingJob) {
    const status = jobStatusCache.get(existingJob.jobName);
    if (status && status.phase === "Running") {
      return { id: status.podName, podIp: status.podIp, sessionId: existingJob.sessionId };
    }
  }

  const jobName = `sandbox-${userId.replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`;
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobName, namespace: NAMESPACE },
    spec: {
      ttlSecondsAfterFinished: 1800,
      template: {
        spec: {
          imagePullSecrets: [{ name: "swr-secret" }],
          restartPolicy: "Never",
          initContainers: [{
            name: "git-sync",
            image: "alpine/git:latest",
            command: ["sh", "-c", "git clone --depth 1 https://gitcode.com/huaweicloud/huaweicloud-skills.git /data/skills && cp -r /data/skills/skills/* /skills/"],
            volumeMounts: [{ name: "skills", mountPath: "/skills" }],
          }],
          containers: [{
            name: "sandbox",
            image: SANDBOX_IMAGE,
            imagePullPolicy: "Always",
            env: [
              { name: "NODE_PATH", value: "/usr/local/lib/node_modules" },
              { name: "HW_ACCESS_KEY", value: user.ak || "" },
              { name: "HW_SECRET_KEY", value: user.sk || "" },
              { name: "DEEPSEEK_API_KEY", value: process.env.DEEPSEEK_API_KEY || "" },
            ],
            resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } },
            volumeMounts: [{ name: "skills", mountPath: "/skills" }],
            securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
            readinessProbe: { httpGet: { path: "/global/health", port: 3005 }, initialDelaySeconds: 10, periodSeconds: 5 },
          }],
          volumes: [{ name: "skills", emptyDir: {} }],
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
  } catch {}

  jobStatusCache.set(jobName, { podName, podIp, phase: "Running" });
  if (isRedisAvailable()) {
    setJob(userId, { jobName, podName, podIp, sessionId: sessionId || "", startTime: Date.now() }).catch(() => {});
  }

  console.log(`[sandbox] ${userId} pod ${podName} ready at ${podIp}:3005 session=${sessionId}`);
  return { id: podName, podIp, sessionId };
}

async function waitForPodReady(jobName) {
  for (let i = 0; i < 90; i++) {
    const { body } = await coreApi.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, `job-name=${jobName}`);
    if (body.items.length > 0 && body.items[0].status?.phase === "Running" && body.items[0].status?.conditions?.some(c => c.type === "Ready" && c.status === "True")) {
      return body.items[0].metadata.name;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Sandbox pod for job ${jobName} not ready after 90s`);
}

async function getPodIp(podName) {
  const { body } = await coreApi.readNamespacedPod(podName, NAMESPACE);
  return body.status.podIP;
}

function releaseContainer(userId) {
  if (isRedisAvailable()) delJob(userId).catch(() => {});
}

async function destroyContainer(userId) {
  try {
    const existing = await getJobSafe(userId);
    if (existing) {
      await batchApi.deleteNamespacedJob(existing.jobName, NAMESPACE).catch(() => {});
      jobStatusCache.delete(existing.jobName);
    }
  } catch {}
  if (isRedisAvailable()) delJob(userId).catch(() => {});
}

function getConcurrencyStats() {
  return { active: jobStatusCache.size, max: MAX_CONCURRENT };
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
  const jobName = `sandbox-anon-${Date.now().toString(36)}`;
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobName, namespace: NAMESPACE },
    spec: {
      ttlSecondsAfterFinished: 300, // 5min 快速清理
      template: {
        spec: {
          imagePullSecrets: [{ name: "swr-secret" }],
          restartPolicy: "Never",
          initContainers: [{
            name: "git-sync",
            image: "alpine/git:latest",
            command: ["sh", "-c", "git clone --depth 1 https://gitcode.com/huaweicloud/huaweicloud-skills.git /data/skills && cp -r /data/skills/skills/* /skills/"],
            volumeMounts: [{ name: "skills", mountPath: "/skills" }],
          }],
          containers: [{
            name: "sandbox",
            image: SANDBOX_IMAGE,
            imagePullPolicy: "Always",
            env: [
              { name: "NODE_PATH", value: "/usr/local/lib/node_modules" },
              { name: "HW_ACCESS_KEY", value: PUBLIC_AK },
              { name: "HW_SECRET_KEY", value: PUBLIC_SK },
              { name: "DEEPSEEK_API_KEY", value: process.env.DEEPSEEK_API_KEY || "" },
            ],
            resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } },
            volumeMounts: [{ name: "skills", mountPath: "/skills" }],
            securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
            readinessProbe: { httpGet: { path: "/global/health", port: 3005 }, initialDelaySeconds: 10, periodSeconds: 5 },
          }],
          volumes: [{ name: "skills", emptyDir: {} }],
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
  } catch {}

  jobStatusCache.set(jobName, { podName, podIp, phase: "Running" });
  console.log(`[sandbox] anon ${jobName} ready at ${podIp}:3005 session=${sessionId}`);
  return { id: podName, podIp, sessionId };
}

async function destroyAnonymousContainer(podId) {
  // 匿名沙箱不追踪，靠 ttlSecondsAfterFinished 自动清理
  // 这里仅从缓存移除
}

export { getOrCreateContainer, createAnonymousContainer, releaseContainer, destroyContainer, getConcurrencyStats };
