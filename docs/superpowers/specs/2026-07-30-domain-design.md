# domainId 获取策略设计

> 日期: 2026-07-30 | 版本: V1.0

## 1. 背景

激励服务在测试环境 (`apigw-beta.huawei.com`) 只有白名单账号能调通 `issue-coupon`。用户需手动提供 domainId。生产环境则通过 AK/SK 动态获取。

## 2. 策略

```
INCENTIVE_API_URL 含 "apigw-beta" ?
  │
  ├─ YES (测试环境) → 用户必须传 domain_id
  │     huaweicloud_auth(ak, sk, region, domain_id="xxx")
  │     → 存 Redis → voucher/claim 直接用
  │
  └─ NO  (生产环境) → hcloud 动态获取
        huaweicloud_auth(ak, sk, region)
        → hcloud IAM KeystoneListAuthDomains → 存 Redis
```

## 3. MCP 工具变更

`huaweicloud_auth` 新增可选参数 `domain_id`:

```
测试环境: auth(ak, sk, region, domain_id="019dd22...")
生产环境: auth(ak, sk, region)
```

## 4. 代码变更

| 文件 | 变更 |
|------|------|
| `mcp-routes.js` | auth handler: 判断环境 → 选用 domain_id 或 hcloud |
| `db.js` | getDomainId 保持不变（生产环境用） |
| 无新增文件 | 逻辑内联在 auth 中 |

## 5. 流程

```
auth(ak, sk, region, domain_id?)
  │
  ├─ isBetaAPI() → true && domain_id
  │     domainId = domain_id  ← 直接用
  │
  ├─ isBetaAPI() → true && !domain_id
  │     返回错误 "测试环境需提供 domain_id"
  │
  └─ isBetaAPI() → false
        domainId = getDomainId(ak, sk)  ← hcloud 实时获取
```
