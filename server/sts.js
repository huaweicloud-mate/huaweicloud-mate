// cloud-server/sts.js — IAM STS 临时凭证客户端
// 创建一次性 K8s Job，用 sandbox 镜像运行 hcloud CLI
import k8s from "@kubernetes/client-node";
import crypto from "node:crypto";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const batchApi = kc.makeApiClient(k8s.BatchV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const NAMESPACE = process.env.NAMESPACE || "huaweicloud-agent";
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent/sandbox:latest";

export async function createTemporaryCredentials(ak, sk, region = "cn-south-1") {
  const jobName = `sts-${crypto.randomUUID().slice(0, 8)}`;

  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobName, namespace: NAMESPACE },
    spec: {
      ttlSecondsAfterFinished: 120,
      template: {
        spec: {
          restartPolicy: "Never",
          imagePullSecrets: [{ name: "swr-secret" }],
          containers: [{
            name: "sts",
            image: SANDBOX_IMAGE,
            env: [
              { name: "HCLOUD_ACCESS_KEY", value: ak },
              { name: "HCLOUD_SECRET_KEY", value: sk },
            ],
            command: ["sh", "-c"],
            args: [
              `hcloud configure set --cli-region=${region} --agree-privacy-policy=true >/dev/null 2>&1; hcloud IAM CreateTemporaryAccessKeyByToken --region=${region} --auth.identity.methods.1=token --auth.identity.token.duration_seconds=21600 --agree-privacy-policy=true 2>/dev/null`,
            ],
          }],
        },
      },
    },
  };

  try {
    await batchApi.createNamespacedJob(NAMESPACE, job);

    for (let i = 0; i < 30; i++) {
      const { body } = await batchApi.readNamespacedJob(jobName, NAMESPACE);
      if (body.status?.succeeded >= 1) break;
      if (body.status?.failed >= 1) throw new Error("STS job failed");
      await new Promise(r => setTimeout(r, 1000));
    }

    const { body: pods } = await coreApi.listNamespacedPod(
      NAMESPACE, undefined, undefined, undefined, undefined, `job-name=${jobName}`
    );
    if (!pods?.items?.length) throw new Error("No STS pod");
    const podName = pods.items[0].metadata.name;

    const logResp = await coreApi.readNamespacedPodLog(podName, NAMESPACE, "sts");
    const stdout = typeof logResp === "string" ? logResp : (logResp?.body || "");

    const cleanLines = stdout.split("\n").filter(l => l.trim().startsWith("{"));
    const cleanOutput = cleanLines.join("\n");
    const match = cleanOutput.match(/\{[\s\S]*"credential"[\s\S]*\}/);
    if (!match) throw new Error(`No credential JSON: ${stdout.slice(0, 300)}`);

    const data = JSON.parse(match[0]);
    const cred = data.credential;
    if (!cred?.access) throw new Error(`Missing access: ${match[0].slice(0, 200)}`);

    return {
      ak: cred.access,
      sk: cred.secret,
      securityToken: cred.securitytoken || "",
      expiresAt: cred.expires_at || new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    };
  } catch (err) {
    console.error(`[sts] ${err.message}`);
    throw err;
  }
}
