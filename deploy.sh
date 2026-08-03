#!/bin/bash
# deploy.sh — 本地构建镜像、推送 SWR、部署到 CCE
# 用法: ./deploy.sh <service>  例: ./deploy.sh hc-devkit
# 流程: npm test → 打包源码 → SSH 构建机 → docker build → push SWR → kubectl deploy
set -euo pipefail

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "用法: ./deploy.sh <service>"
  echo "可用服务: hc-devkit, hdkitservice"
  exit 1
fi

# --- 配置 ---
BUILD_HOST="${BUILD_HOST:-root@110.41.83.215}"
BUILD_PASS="${BUILD_PASS:-hw@123456}"
SWR_REGISTRY="swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent"
SWR_USER="${SWR_USER:-cn-south-1@HST3U79GBHYSKXVRNOSL}"
SWR_PASS="${SWR_PASS:-d789bfbba11f5b21a4f3866355e2bd41330024a8fc4df3526c485b92453d05f3}"
K8S_NAMESPACE="${K8S_NAMESPACE:-huaweicloud-agent}"

TAG="$(date +%Y%m%d%H%M%S)"
IMAGE="${SWR_REGISTRY}/${SERVICE}:${TAG}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Deploying ${SERVICE}:${TAG}"
echo ""

# --- Step 1: Pull latest + npm test ---
echo "==> [1/5] Pulling latest code & running tests..."
cd "${SCRIPT_DIR}"
git pull --rebase || true
npm test || { echo "Tests failed, aborting."; exit 1; }

# --- Step 2: Package source ---
echo "==> [2/5] Packaging source..."
tar czf /tmp/deploy-build.tgz \
  --exclude='node_modules' \
  --exclude='.terraform' \
  --exclude='terraform.tfstate' \
  -C "${SCRIPT_DIR}" \
  package.json package-lock.json \
  server/ \
  server/Dockerfile.server.hcloud

# --- Step 3: Upload to build host ---
echo "==> [3/5] Uploading to build host..."
sshpass -p "${BUILD_PASS}" scp -o StrictHostKeyChecking=no /tmp/deploy-build.tgz "${BUILD_HOST}:/tmp/deploy-build.tgz"

# --- Step 4: Build + Push ---
echo "==> [4/5] Building & pushing Docker image..."
sshpass -p "${BUILD_PASS}" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${BUILD_HOST}" "
  set -e
  rm -rf /tmp/deploy-build && mkdir -p /tmp/deploy-build && cd /tmp/deploy-build
  tar xzf /tmp/deploy-build.tgz

  echo '${SWR_PASS}' | docker login -u '${SWR_USER}' --password-stdin ${SWR_REGISTRY} 2>/dev/null
  docker build --network host -t ${IMAGE} -f server/Dockerfile.server.hcloud .
  docker push ${IMAGE}
  echo 'BUILD_OK'
"

# --- Step 5: Deploy to CCE ---
echo "==> [5/5] Deploying to CCE..."
sshpass -p "${BUILD_PASS}" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${BUILD_HOST}" "
  KUBECONFIG=/tmp/kubeconfig.json kubectl -n ${K8S_NAMESPACE} set image deployment/${SERVICE} server=${IMAGE}
  KUBECONFIG=/tmp/kubeconfig.json kubectl -n ${K8S_NAMESPACE} rollout status deployment/${SERVICE} --timeout=30s
"

echo ""
echo "==> Done: ${SERVICE}:${TAG}"
echo "    MCP: http://113.45.151.224/SERVICE_PORT/mcp"
