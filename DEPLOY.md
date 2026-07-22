# Huawei Cloud Agent — 部署 & 测试命令

> CCE 区域: cn-south-1 | 项目: /home/developer/Desktop/huaweicloud-agent-demo

## 前置条件

```bash
# 确认已安装
docker --version      # >= 24
terraform --version   # >= 1.5
kubectl version --client  # >= 1.29

# 设置华为云凭证
export HW_ACCESS_KEY="你的AK"
export HW_SECRET_KEY="你的SK"
export HW_REGION="cn-south-1"
export DEEPSEEK_API_KEY="sk-..."
```

---

## 1. 构建镜像

```bash
cd /home/developer/Desktop/huaweicloud-agent-demo

# 构建 A2A Server 镜像
docker build -t huaweicloud-agent/server:latest -f cloud-server/Dockerfile.server cloud-server/

# 构建沙箱镜像
docker build -t huaweicloud-agent/sandbox:latest -f cloud-server/Dockerfile.sandbox cloud-server/
```

---

## 2. 推送到 SWR cn-south-1

```bash
# 登录 SWR
docker login -u cn-south-1@${HW_ACCESS_KEY} -p ${HW_SECRET_KEY} swr.cn-south-1.myhuaweicloud.com

# 打标签
docker tag huaweicloud-agent/server:latest swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent/server:latest
docker tag huaweicloud-agent/sandbox:latest swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent/sandbox:latest

# 推送
docker push swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent/server:latest
docker push swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent/sandbox:latest
```

---

## 3. Terraform 创建 CCE 集群

```bash
cd cloud-server/terraform

# 初始化
terraform init

# 预览
terraform plan \
  -var "region=cn-south-1" \
  -var "cluster_name=huaweicloud-agent"

# 创建（约需 5-10 分钟）
terraform apply -auto-approve \
  -var "region=cn-south-1" \
  -var "cluster_name=huaweicloud-agent"

# 获取 kubectl 配置
EIP=$(terraform output -raw eip)
# 或者从华为云控制台下载 kubeconfig
```

---

## 4. 配置 kubectl

```bash
# 从华为云 CCE 控制台下载 kubeconfig 文件后：
export KUBECONFIG=/path/to/kubeconfig.yaml
kubectl cluster-info
```

---

## 5. K8s 部署

```bash
cd /home/developer/Desktop/huaweicloud-agent-demo

# 创建命名空间
kubectl create namespace huaweicloud-agent

# 更新 configmap 中的凭证
kubectl create configmap a2a-server-config \
  --namespace huaweicloud-agent \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY}" \
  --from-literal=SANDBOX_IMAGE="swr.cn-south-1.myhuaweicloud.com/huaweicloud-agent/sandbox:latest" \
  --dry-run=client -o yaml | kubectl apply -f -

# 部署
kubectl apply -f cloud-server/k8s/rbac.yaml
kubectl apply -f cloud-server/k8s/deployment.yaml
kubectl apply -f cloud-server/k8s/service.yaml
kubectl apply -f cloud-server/k8s/ingress.yaml

# 等待就绪
kubectl -n huaweicloud-agent wait --for=condition=available deployment/a2a-server --timeout=120s
kubectl -n huaweicloud-agent get pods
```

---

## 6. 测试

```bash
EIP=$(kubectl -n huaweicloud-agent get ingress a2a-server -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
# 如果 Ingress 还没分配 IP，直接用 NodePort 或 curl Service IP

# 健康检查
curl -s http://${EIP}/api/v1/health | jq .

# AgentCard
curl -s http://${EIP}/.well-known/agent.json | jq .name
# 预期: "Huawei Cloud Agent"

# 注册用户（首次使用）
curl -s -X POST http://${EIP}/api/v1/register \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"test\",\"ak\":\"${HW_ACCESS_KEY}\",\"sk\":\"${HW_SECRET_KEY}\",\"projectId\":\"cn-south-1\"}" | jq .

# 创建任务（A2A 通道）- 用返回的 JWT
TOKEN="<上一步返回的token>"
curl -s --max-time 300 -X POST http://${EIP}/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"description":"查询 cn-south-1 的 ECS 数量"}' | jq .

# MCP 通道
curl -s -X POST http://${EIP}/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' | jq .

# 查看 Job 状态
kubectl -n huaweicloud-agent get jobs
kubectl -n huaweicloud-agent logs job/sandbox-test
```

---

## 7. 本地客户端连接

部署成功后，回到本地：

```bash
# Codex Plugin
cd /home/developer/Desktop/huaweicloud-agent-demo/scripts
node setup.js   # API_BASE 填 http://<EIP>:3000

# OpenCode MCP
node setup-mcp.js  # 把输出的 JSON 写入 opencode.json
```

---

## 故障排查

```bash
# A2A Server 日志
kubectl -n huaweicloud-agent logs deployment/a2a-server

# Job 状态
kubectl -n huaweicloud-agent describe job sandbox-xxxxx

# 沙箱 Pod 日志
kubectl -n huaweicloud-agent logs job/sandbox-xxxxx -c sandbox
```
