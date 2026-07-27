// cloud-server/sandbox.js — K8s Job 管理
// 每用户一个 K8s Job，执行完 ttlSecondsAfterFinished 自动清理
import k8s from "@kubernetes/client-node";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const batchApi = kc.makeApiClient(k8s.BatchV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const NAMESPACE = process.env.NAMESPACE || "default";
const MAX_CONCURRENT = parseInt(process.env.MAX_SANDBOXES || "5");
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent/sandbox:latest";

const activeJobs = new Map();
const jobStatusCache = new Map();

function hasActive(userId) {
  const info = activeJobs.get(userId);
  if (!info) return false;
  if (Date.now() - info.startTime > 1800000) {
    activeJobs.delete(userId);
    return false;
  }
  const status = jobStatusCache.get(info.jobName);
  return status && status.phase === "Running";
}

async function getOrCreateContainer(userId, user) {
  if (hasActive(userId)) {
    const info = activeJobs.get(userId);
    const status = jobStatusCache.get(info.jobName);
    return { id: status.podName, podIp: status.podIp, sessionId: info.sessionId };
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
          containers: [{
            name: "sandbox",
            image: SANDBOX_IMAGE,
            env: [
              { name: "HW_ACCESS_KEY", value: user.ak || "" },
              { name: "HW_SECRET_KEY", value: user.sk || "" },
              { name: "DEEPSEEK_API_KEY", value: process.env.DEEPSEEK_API_KEY || "" },
            ],
            resources: {
              requests: { cpu: "1", memory: "1Gi" },
              limits: { cpu: "2", memory: "2Gi" },
            },
            readinessProbe: {
              httpGet: { path: "/global/health", port: 3005 },
              initialDelaySeconds: 10,
              periodSeconds: 5,
            },
          }],
        },
      },
    },
  };

  const { body } = await batchApi.createNamespacedJob(NAMESPACE, job).catch(async (err) => {
    if (err.statusCode === 409) {
      console.log(`[sandbox] ${userId} job exists, reusing`);
      const existing = await batchApi.readNamespacedJob(jobName, NAMESPACE);
      return existing;
    }
    throw err;
  });
  const podName = await waitForPodReady(jobName);
  const podIp = await getPodIp(podName);

  // Create opencode session and store it
  let sessionId = null;
  try {
    const sResp = await fetch(`http://${podIp}:3005/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const session = await sResp.json();
    sessionId = session.id;
  } catch { /* session creation failed, will create new each time */ }

  activeJobs.set(userId, { jobName, startTime: Date.now(), sessionId });
  jobStatusCache.set(jobName, { podName, podIp, phase: "Running" });

  console.log(`[sandbox] ${userId} pod ${podName} ready at ${podIp}:3005 session=${sessionId}`);
  return { id: podName, podIp, sessionId };
}

async function waitForPodReady(jobName) {
  for (let i = 0; i < 90; i++) {
    const { body } = await coreApi.listNamespacedPod(
      NAMESPACE, undefined, undefined, undefined, undefined,
      `job-name=${jobName}`
    );
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

async function execInContainer(container, cmd) {
  const resp = await fetch(`http://${container.podIp}:3005/`);
  if (!resp.ok) throw new Error("Sandbox not healthy");
  return "ok";
}

function releaseContainer(userId) {
  activeJobs.delete(userId);
}

async function destroyContainer(userId) {
  const info = activeJobs.get(userId);
  if (info) {
    await batchApi.deleteNamespacedJob(info.jobName, NAMESPACE);
    activeJobs.delete(userId);
    jobStatusCache.delete(info.jobName);
  }
}

function getConcurrencyStats() {
  return { active: activeJobs.size, max: MAX_CONCURRENT };
}

export { getOrCreateContainer, execInContainer, releaseContainer, destroyContainer, getConcurrencyStats };
