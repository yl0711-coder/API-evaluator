# 用户侧 API 使用指南：导出密钥、查看分组与模型

面向共用账号的协作方。本文只涉及**用户级**接口，不需要管理员权限。

所有路径以部署域名为前缀，下文统一记作 `$BASE`（例如 `https://api.example.com`）。

---

## 0. 统一响应格式

所有 `/api/v1/*` 接口都包一层信封（`backend/internal/pkg/response/response.go:15`）：

```json
{
  "code": 0,
  "message": "success",
  "data": { }
}
```

成功时 `code` 为 `0`，业务数据在 `data` 里。出错时 HTTP 状态码非 200，`code` 等于 HTTP 状态码，`message` 是错误描述，可能带 `reason` / `metadata`。

分页接口的 `data` 结构固定为（`response.go:24`）：

```json
{
  "items": [],
  "total": 42,
  "page": 1,
  "page_size": 20,
  "pages": 3
}
```

---

## 1. 登录取 token

### POST /api/v1/auth/login

无需认证。限流 20 次/分钟，超限返回 429。

请求体（`backend/internal/handler/auth_handler.go:77`）：

```json
{
  "email": "shared@example.com",
  "password": "••••••"
}
```

如果站点开了人机验证，还需要带 `turnstile_token` 或 `tencent_captcha_ticket` + `tencent_captcha_randstr`。

成功响应（`auth_handler.go:94`）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "access_token": "eyJhbGci...",
    "refresh_token": "...",
    "expires_in": 3600,
    "token_type": "Bearer",
    "user": { "id": 12, "email": "shared@example.com", "...": "..." }
  }
}
```

curl：

```bash
curl -s -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"shared@example.com","password":"YOUR_PASSWORD"}'
```

后续所有请求都带上：

```
Authorization: Bearer <access_token>
```

### 账号开了 TOTP 的情况

`/auth/login` 不会直接返回 token，而是返回（`auth_handler.go:286`）：

```json
{
  "code": 0,
  "data": {
    "requires_2fa": true,
    "temp_token": "...",
    "user_email_masked": "sh***@example.com"
  }
}
```

再调 **POST /api/v1/auth/login/2fa**，请求体（`auth_handler.go:294`）：

```json
{ "temp_token": "上一步的 temp_token", "totp_code": "123456" }
```

响应与普通登录一致。

### token 刷新

`access_token` 有效期见 `expires_in`（秒）。过期后用 **POST /api/v1/auth/refresh** 换新的：

```json
{ "refresh_token": "..." }
```

返回新的 `access_token` + `refresh_token`。限流 30 次/分钟。

### 会话绑定（重要）

签发 token 时会记录客户端 IP 和 User-Agent，后续请求任一变化即撤销会话，返回 401（`backend/internal/server/middleware/jwt_auth.go:92`）。

影响：

- **不要把浏览器里的 token 复制到别的机器/脚本用**，几乎必然 401。
- 在**要跑脚本的那台机器上**调 `/auth/login` 重新取 token，之后固定用同一个 HTTP 客户端（UA 一致）。
- 该功能可由管理员在系统设置里关闭。持续 401 且 IP 会漂移（家宽、移动网络、出口负载均衡）时，找管理员确认这项配置。

另外，**修改账号密码会让所有已签发 token 立即失效**（TokenVersion 校验，`jwt_auth.go` 附近）。共用账号要注意别互相踢下线。

---

## 2. 导出密钥

### GET /api/v1/keys

列出当前登录账号的全部 API 密钥。只返回本账号的密钥，按 `user_id` 过滤，无法读到别的用户。

查询参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `page` | int | 页码，默认 1 |
| `page_size` | int | 每页条数，默认 20，**上限 1000**（`response.go:182`；也接受 `limit` 同义） |
| `search` | string | 按名称模糊搜索，超 100 字符会被截断 |
| `status` | string | `active` / `inactive` |
| `group_id` | int | 按分组过滤 |
| `sort_by` | string | 默认 `created_at` |
| `sort_order` | string | `asc` / `desc`，默认 `desc` |

`data.items[]` 每项字段（`backend/internal/handler/dto/types.go:53`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 密钥 ID |
| `key` | string | **完整明文密钥**，可直接用于网关调用 |
| `name` | string | 名称 |
| `group_id` | int \| null | 绑定的分组 |
| `status` | string | `active` / `inactive` |
| `quota` | float | 配额上限（USD），0 = 不限 |
| `quota_used` | float | 已用配额（USD） |
| `expires_at` | string \| null | 过期时间，null = 永不过期 |
| `rate_limit_5h` / `_1d` / `_7d` | float | 限速阈值（USD），0 = 不限 |
| `usage_5h` / `usage_1d` / `usage_7d` | float | 当前窗口用量 |
| `reset_5h_at` / `reset_1d_at` / `reset_7d_at` | string | 窗口重置时间，窗口已过期时该字段不出现 |
| `current_concurrency` | int | 实时并发数 |
| `ip_whitelist` / `ip_blacklist` | string[] | IP 名单 |
| `last_used_at` | string \| null | 最后使用时间 |
| `last_used_ip` | string \| null | 最后使用 IP |
| `created_at` / `updated_at` | string | 时间戳 |
| `group` | object \| null | 分组概要，见第 3 节 |

`key` 字段是明文完整值，没有掩码。前端列表页显示的掩码只是 UI 层处理（`frontend/src/utils/maskApiKey.ts`），接口本身返回全量。

### 一次性导出全部（推荐）

```bash
TOKEN="eyJhbGci..."

curl -s "$BASE/api/v1/keys?page=1&page_size=1000" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data.items[] | [.name, .key, .status, .quota, .quota_used, (.expires_at // "")] | @csv' \
  > api-keys.csv
```

先确认条数够不够，对比 `data.total` 与实际导出行数：

```bash
curl -s "$BASE/api/v1/keys?page=1&page_size=1000" \
  -H "Authorization: Bearer $TOKEN" | jq '{total: .data.total, got: (.data.items | length)}'
```

超过 1000 条就翻页（`page=2`、`page=3`…，直到 `page > data.pages`）。

### 只要能用的密钥

```bash
curl -s "$BASE/api/v1/keys?page=1&page_size=1000&status=active" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data.items[].key'
```

### 浏览器控制台版（无需装 curl / jq）

在已登录的面板页面按 F12，控制台执行：

```js
const token = localStorage.getItem('auth_token')
const r = await fetch('/api/v1/keys?page=1&page_size=1000', {
  headers: { Authorization: `Bearer ${token}` }
}).then(r => r.json())

const rows = r.data.items
console.log('total:', r.data.total, 'exported:', rows.length)

const csv = 'name,key,status,quota,quota_used,expires_at\n' +
  rows.map(k => [k.name, k.key, k.status, k.quota, k.quota_used, k.expires_at ?? ''].join(',')).join('\n')
const a = document.createElement('a')
a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
a.download = 'api-keys.csv'
a.click()
```

同源请求，token 从 localStorage 现取，不受 CORS 和会话绑定影响。

### GET /api/v1/keys/:id

取单个密钥详情，字段同上。非本账号的密钥返回 404（所有权校验，`backend/internal/handler/api_key_handler.go:172`）。

### 跨域调用注意

如果是从别的网站前端 JS 直接调这些接口，会被 CORS 拦住。`cors.allowed_origins` 默认为空数组（`backend/internal/config/config.go:1960`），此时所有带 `Origin` 的跨域请求一律拒绝，预检直接 403（`cors.go:90`）。需要管理员把来源域名加进白名单。服务端脚本（curl / Node / Python）不受此限制。

---

## 3. 查看分组

### GET /api/v1/groups/available

当前账号可绑定的分组列表。`data` 是数组，不分页。

字段（`dto.Group`，`dto/types.go:90`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 分组 ID，创建密钥时作为 `group_id` |
| `name` | string | 名称 |
| `description` | string | 描述 |
| `platform` | string | 平台标识 |
| `rate_multiplier` | float | 计费倍率 |
| `is_exclusive` | bool | 是否专属分组 |
| `status` | string | 状态 |
| `subscription_type` | string | 订阅类型 |
| `daily_limit_usd` / `weekly_limit_usd` / `monthly_limit_usd` | float \| null | 周期额度上限 |
| `peak_rate_enabled` | bool | 是否启用高峰倍率 |
| `peak_start` / `peak_end` | string | 高峰时段 |
| `peak_rate_multiplier` | float | 高峰倍率 |
| `long_context_pricing_enabled` | bool | 长上下文单独计价 |
| `allow_image_generation` | bool | 是否允许生图 |
| `image_rate_independent` | bool | 生图是否走独立倍率 |
| `image_rate_multiplier` | float | 生图倍率 |
| `image_price_1k` / `_2k` / `_4k` | float \| null | 生图单价 |
| `video_*` | 见源码 | 视频相关计价 |

```bash
curl -s "$BASE/api/v1/groups/available" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data[] | "\(.id)\t\(.name)\t\(.platform)\t×\(.rate_multiplier)"'
```

### GET /api/v1/groups/rates

当前账号的**专属倍率覆盖**。`data` 是 `{分组ID: 倍率}` 的映射，只包含有专属配置的分组。没有覆盖的分组按 `groups/available` 里的 `rate_multiplier` 计费。

```json
{ "code": 0, "data": { "3": 0.8, "7": 1.2 } }
```

---

## 4. 查看模型

### GET /api/v1/model-plaza （推荐）

模型广场。一次拿到「分组 → 模型 → 定价」的完整视图，是了解站点能力最快的入口。

挂 OptionalJWT：带 token 会额外显示已授权的专属分组和账号专属倍率；不带 token 只显示公开分组。建议带上 token。

需要管理员开启该功能，未开启返回 404 `Model plaza is not enabled`。若开启了 `require_auth` 则必须带 token，否则 401。

响应结构（`backend/internal/handler/model_plaza_handler.go:77`）：

```json
{
  "code": 0,
  "data": {
    "description": "站点说明文案",
    "groups": [
      {
        "id": 3,
        "name": "标准组",
        "description": "...",
        "platform": "anthropic",
        "subscription_type": "",
        "rate_multiplier": 1.0,
        "user_rate_multiplier": 0.8,
        "peak_rate_enabled": false,
        "peak_start": "",
        "peak_end": "",
        "peak_rate_multiplier": 1.0,
        "is_exclusive": false,
        "image_rate_independent": false,
        "image_rate_multiplier": 1.0,
        "models": [
          {
            "name": "claude-sonnet-4-5",
            "platform": "anthropic",
            "pricing": {
              "billing_mode": "token",
              "input_price": 0.000003,
              "output_price": 0.000015,
              "cache_write_price": 0.00000375,
              "cache_read_price": 0.0000003,
              "image_input_price": null,
              "image_output_price": null,
              "per_request_price": null,
              "intervals": []
            },
            "official_pricing": {
              "input_price": 0.000003,
              "output_price": 0.000015,
              "cache_write_price": 0.00000375,
              "cache_read_price": 0.0000003
            }
          }
        ]
      }
    ]
  }
}
```

`pricing` 是本站实际计费价，`official_pricing` 是官方参考价（LiteLLM 数据源），拿不到时为 `null`。`user_rate_multiplier` 只在该账号有专属倍率时出现。

列出所有分组及其模型：

```bash
curl -s "$BASE/api/v1/model-plaza" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data.groups[] | "\(.name) [\(.platform)] ×\(.rate_multiplier)\n" + (.models[] | "  - \(.name)")'
```

只要模型名去重列表：

```bash
curl -s "$BASE/api/v1/model-plaza" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '[.data.groups[].models[].name] | unique | .[]'
```

### GET /api/v1/channels/available

可用渠道视图，按渠道组织（渠道 → 平台 → 分组/模型）。

需要管理员开启 `available-channels` 开关，**默认关闭**；未开启时返回空数组 `[]`（不报错），所以拿到空结果先确认开关状态（`backend/internal/handler/available_channel_handler.go:129`）。

字段做了白名单裁剪，只含 `name` / `description` / `platforms`，不含内部 ID 和管理字段。

### GET /v1/models（网关接口）

用 **API 密钥**而非 JWT 认证，返回该密钥所属分组实际可调用的模型清单。这是验证「某个密钥到底能用哪些模型」最直接的方式。

```bash
curl -s "$BASE/v1/models" -H "Authorization: Bearer sk-xxxxxxxx"
```

注意这里的 `Authorization` 填的是**导出的 API 密钥**，不是登录 JWT。路径也没有 `/api/v1` 前缀（`backend/internal/server/routes/gateway.go:182`）。

### GET /v1/sub2api/billing（网关接口）

同样用 API 密钥认证，返回该密钥的配额和计费状态。适合在测试脚本里做前置检查。

---

## 5. 其他可能用得上的

| 接口 | 说明 |
|---|---|
| `GET /api/v1/auth/me` | 当前登录用户信息，用来验证 token 是否有效 |
| `GET /api/v1/user/profile` | 账号资料、余额 |
| `GET /api/v1/usage?page=1&page_size=100` | 调用记录（重查询，有额外限流） |
| `GET /api/v1/usage/stats` | 用量统计 |
| `GET /api/v1/user/api-keys/:id/usage/daily` | 单个密钥的每日用量 |
| `GET /api/v1/subscriptions/active` | 当前生效的订阅 |
| `GET /health` | 健康检查，无需认证 |

创建 / 修改 / 删除密钥分别是 `POST /api/v1/keys`、`PUT /api/v1/keys/:id`、`DELETE /api/v1/keys/:id`，请求字段见 `backend/internal/handler/api_key_handler.go:33`（创建）和 `:49`（更新）。创建时可设 `quota`、`expires_in_days`、`rate_limit_5h/1d/7d`，适合开临时测试密钥。

---

## 6. 限流与错误处理

面板接口有两层按用户限流：全局限流对所有认证接口生效，`usage` 和 `channel-monitor-v2` 等重查询接口叠加更严格的 Heavy 限流。阈值由管理员在系统设置里调整。

批量拉取时的建议：

- 用 `page_size=1000` 一次拿完，别用小分页循环刷。
- 命中 429 就退避重试，别立即重发。
- 401 先按第 1 节的会话绑定排查，而不是反复重登。

常见状态码：

| 码 | 含义 |
|---|---|
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | 未认证 / token 过期 / 会话被撤销 |
| 403 | 权限不足；跨域预检被拒也是这个码 |
| 404 | 资源不存在；或功能未启用（如模型广场） |
| 429 | 触发限流 |

---

## 7. 安全须知

导出结果里的 `key` 是**完整可用的明文凭证**，任何持有者都能直接调用网关消耗账号配额，账单记在本账号名下。

- 不要走明文渠道（微信、邮件正文）传输导出文件，用加密压缩包或一次性链接。
- 不要把响应体打进日志或提交进 git，导出的 CSV 建议加进 `.gitignore`。
- 测试结束后轮换这批密钥（删除重建），或至少给测试专用密钥设好 `quota` 和 `expires_in_days`。
- 密码和 JWT 不要写进脚本硬编码，用环境变量传。
