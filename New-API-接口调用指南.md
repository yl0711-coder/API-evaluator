# New API 管理接口调用指南

面向需要通过 HTTP 接口（而非 Web 界面）操作 New API 的开发者。内容基于本仓库 `1.0.0-rc.4` 源码整理，所有结论都标注了源码位置，便于自行核对。

> 注意区分两套接口：
> - **中继接口**（`/v1/*`）：给 AI 客户端用的，用 `sk-xxx` 令牌调用，走 OpenAI 兼容协议。
> - **管理接口**（`/api/*`）：本文档的主题，管理渠道、令牌、用户、模型等，用**系统访问令牌**调用。
> 两者的认证方式完全不同，不要混用。

---

## 一、认证机制

管理接口需要**同时**带两个请求头，缺一个就 401（`middleware/auth.go:36-122`）：

| 请求头 | 值 | 说明 |
|---|---|---|
| `Authorization` | 系统访问令牌 | 注意：**不加** `Bearer ` 前缀，直接放令牌原文 |
| `New-Api-User` | 用户 ID（数字） | 必须与令牌所属用户的 ID 一致，否则报"用户 ID 不匹配" |

### 获取系统访问令牌

两种方式：

1. **Web 界面**：登录后进入「个人设置」，点击生成系统访问令牌。
2. **接口生成**：`GET /api/user/self/token`（`controller/user.go:290`）。每次调用都会**重新生成并覆盖旧令牌**，旧的立即失效，谨慎使用。

令牌是 29-32 位随机字符串，存在 `users.access_token` 字段。

### 为什么需要 `New-Api-User`

`authHelper` 校验完 `Authorization` 拿到用户 id 后，会再比对 `New-Api-User` 头（`middleware/auth.go:96-122`）。这是一层防误操作/防 CSRF 的设计，不是可选项。

```powershell
$headers = @{
  "Authorization" = "你的系统访问令牌"
  "New-Api-User"  = "1"
}
```

### 权限分级

| 中间件 | 要求 | 典型接口 |
|---|---|---|
| `TryUserAuth()` | 可匿名，登录后返回更多内容 | `/api/pricing` |
| `UserAuth()` | 普通用户 | 令牌管理、自己的日志 |
| `AdminAuth()` | 管理员 | 渠道、用户、模型元数据、全站日志 |
| `RootAuth()` | 超级管理员 | 系统设置、倍率同步 |

---

## 二、通用约定

### 响应格式

管理接口统一返回 HTTP 200，**业务成败看 body 里的 `success` 字段**（`common/gin.go:181-201`）：

```json
{ "success": true,  "message": "",       "data": { ... } }
{ "success": false, "message": "错误原因" }
```

所以不要只判断 HTTP 状态码，一定要判 `success`。

### 分页（重要坑点）

分页参数解析在 `common/page_info.go:41-82`，有几个反直觉的地方：

| 参数 | 说明 |
|---|---|
| `p` | **页码**，从 1 开始。也兼容 `page`，但 `p` 是主参数 |
| `page_size` | 每页条数，兼容 `ps` / `size` |

**服务端硬上限 100**（`common/page_info.go:77`）：
```go
if pageInfo.PageSize > 100 {
    pageInfo.PageSize = 100
}
```

传 `page_size=1000` 不会报错，会被静默改成 100。想拿全量数据必须循环翻页，用返回的 `total` 判断何时结束。

分页接口的响应结构：
```json
{
  "success": true,
  "data": { "page": 1, "page_size": 100, "total": 253, "items": [ ... ] }
}
```

### 更新操作的"全量写回"陷阱

部分 `PUT` 接口内部用 GORM 的 `Select(...)` 指定了固定列清单强制覆盖。这意味着**你没传的字段会被写成零值**，而不是保持原样。

安全做法一律是：**先 GET 读出完整对象 → 只改目标字段 → 把完整对象 PUT 回去**。

令牌更新接口（`controller/token.go:274-302`）做得比较好，它内部先 `GetTokenByIds` 读出原记录再逐字段赋值，但仍然要求你把 `name`、`expired_time`、`remain_quota` 等都带上，漏传照样会被覆盖。模型元数据接口（`PUT /api/models/`）也是同样的要求。

---

## 三、令牌（Token）接口

路由定义在 `router/api-router.go:260-271`，整组是 `UserAuth()` 权限。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/token/` | GET | 列出当前用户的令牌（分页，密钥脱敏） |
| `/api/token/search` | GET | 搜索，参数 `keyword`、`token` |
| `/api/token/:id` | GET | 单个令牌详情（密钥脱敏） |
| `/api/token/:id/key` | POST | **取完整密钥明文** |
| `/api/token/batch/keys` | POST | 批量取明文，body `{"ids":[1,2,3]}`，上限 100 |
| `/api/token/` | POST | 新建令牌 |
| `/api/token/` | PUT | 更新令牌，`?status_only=true` 只改状态 |
| `/api/token/:id` | DELETE | 删除 |
| `/api/token/batch` | POST | 批量删除 |

### 令牌字段（`model/token.go:14-32`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 主键 |
| `key` | string | 密钥。列表接口里是脱敏值 |
| `name` | string | 名称，最长 50 字符 |
| `status` | int | 1=启用，2=禁用，3=过期，4=耗尽 |
| `expired_time` | int64 | Unix 秒，`-1` = 永不过期 |
| `remain_quota` | int | 剩余额度（quota 单位） |
| `unlimited_quota` | bool | 无限额度 |
| `model_limits_enabled` | bool | 是否启用模型白名单 |
| `model_limits` | string | 逗号分隔的模型名 |
| `allow_ips` | *string | IP 白名单，换行分隔 |
| `group` | string | **分组**，空串 = 跟随用户分组 |
| `used_quota` | int | 已用额度 |
| `cross_group_retry` | bool | 跨分组重试，仅 auto 分组有效 |

### 关于密钥明文

`GET` 类接口返回的 `key` 都经过 `buildMaskedTokenResponse()` 脱敏（`controller/token.go:17-24`），形如 `sk-1**********abcd`，**不能直接使用**。

要明文必须走那两个 POST 接口：

```powershell
# 单个
Invoke-RestMethod -Uri "http://localhost:3000/api/token/5/key" `
  -Method POST -Headers $headers
# → { "success": true, "data": { "key": "sk-xxxxxxxx" } }

# 批量
$body = @{ ids = @(1,2,3) } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/api/token/batch/keys" `
  -Method POST -Headers $headers -Body $body -ContentType "application/json"
# → { "success": true, "data": { "keys": { "1": "sk-aaa", "2": "sk-bbb" } } }
```

这两个接口挂了 `CriticalRateLimit()` 和 `DisableCache()`，调用频率受限，别在循环里高频打。

### 只能读自己的令牌

所有令牌接口内部都用当前登录用户 id 做过滤（`controller/token.go:81-94`）：

```go
userId := c.GetInt("id")
token, err := model.GetTokenByIds(id, userId)
```

底层 SQL 是 `id = ? and user_id = ?`（`model/token.go:234`）。所以：

- 哪怕你是 root，传别人的 token id 也只会返回"记录不存在"。
- **系统里没有任何接口能让管理员读取其他用户的令牌明文。**

### 安全提醒

令牌密钥在数据库里是**明文存储**的（`model/token.go:17`，普通 varchar，无哈希）。接口层的用户隔离拦不住数据库层——有库权限的人可以直接查 `tokens` 表拿到所有人的明文。做备份、导出、给第三方开只读库账号时要留意。

---

## 四、从令牌推导可用模型

这是一条常用链路：给定一个令牌，算出它到底能调哪些模型。

```
令牌 id
  └─ GET /api/token/:id           → group 字段
       └─ group 为空？回落到用户的 group
            └─ service.GetUserUsableGroups(group)  → 实际可用分组集合
                 └─ abilities 表查询               → 分组下启用的模型列表
```

### 第一步：拿分组

`Token.Group` 是 `json:"group"`（`model/token.go:29`），脱敏函数只清 `Key` 不动 `Group`，所以普通列表接口就带出来了。

**坑**：`group` 默认是空字符串。空值含义是"跟随用户自身的分组"，不是"无分组"。遇到 `"group": ""` 要去读该用户的 `group` 字段（`GET /api/user/self` 或管理端 `GET /api/user/:id`）。

### 第二步：分组 → 模型

真正的映射表是数据库里的 `abilities` 表，由渠道配置自动维护（每个渠道的「模型列表 × 分组」展开成多行）。底层查询是一条 SQL（`model/ability.go:41-46`）：

```sql
SELECT DISTINCT model FROM abilities WHERE `group` = ? AND enabled = true
```

对应两个接口：

| 接口 | 权限 | 返回 |
|---|---|---|
| `GET /api/user/self/models` | UserAuth | 当前用户所有可用分组下的模型名数组 |
| `GET /api/pricing` | TryUserAuth | 模型详情列表，每条带 `enable_groups` |

`/api/user/self/models` 的实现（`controller/user.go:528-536`）就是上面那条链路的代码化：

```go
groups := service.GetUserUsableGroups(user.Group)
for group := range groups {
    for _, g := range model.GetGroupEnabledModels(group) { ... }
}
```

### 按任意分组反查：用 /api/pricing

`/api/pricing` 返回的 `data` 里每个模型都带 `enable_groups`（`model/pricing.go:34`），可以在客户端按分组过滤，一次拿到全量映射：

```powershell
$p = Invoke-RestMethod -Uri "http://localhost:3000/api/pricing" -Headers $headers
$p.data | Where-Object {
  $_.enable_groups -contains "vip" -or $_.enable_groups -contains "all"
} | Select-Object model_name, tags, model_ratio, quota_type
```

`enable_groups` 里出现 `"all"` 表示该模型对所有分组开放（`controller/pricing.go:22-25` 有专门的短路判断），过滤时别漏掉这种。

### `/api/pricing` 完整返回结构

```json
{
  "success": true,
  "data": [ /* Pricing 数组 */ ],
  "vendors": [ /* 厂商列表 */ ],
  "group_ratio": { "default": 1, "vip": 0.8 },
  "usable_group": { "default": "默认分组" },
  "supported_endpoint": { ... },
  "auto_groups": [ ... ],
  "pricing_version": "a42d372ccf0b5dd13ecf71203521f9d2"
}
```

`Pricing` 主要字段（`model/pricing.go:18-39`）：`model_name`、`description`、`icon`、`tags`、`vendor_id`、`quota_type`（0=按量计费 1=按次计费）、`model_ratio`、`model_price`、`completion_ratio`、`enable_groups`、`supported_endpoint_types`、`billing_mode`、`billing_expr`。

### 一个重要限制

`/api/pricing` 和 `/api/user/self/models` 都会**按调用者自己的可用分组过滤**（`controller/pricing.go:58-59`）。即使用管理员令牌调，看到的也只是**你这个账号能用的分组**对应的模型，不是全站视图。

要拿不受过滤的全量映射，走管理端：

| 接口 | 权限 | 用途 |
|---|---|---|
| `GET /api/group/` | AdminAuth | 列出所有分组 |
| `GET /api/channel/models_enabled` | AdminAuth | 所有已启用模型 |
| `GET /api/channel/?p=1&page_size=100` | AdminAuth | 逐个渠道读 `models` + `group` 自行拼映射 |
| `GET /api/user/self/groups` | UserAuth | 当前用户可用分组 + 倍率 + 描述（`controller/group.go:26`） |

**实践建议**：如果目标就是"这个令牌能调什么"，最省事也最可靠的办法是**直接用那个令牌去调 `GET /api/user/self/models`**，让服务端把整套分组逻辑跑完，别自己在客户端拼分组关系。

---

## 五、其他常用接口（补充）

以下是上面没覆盖但日常会用到的部分。

### 用户

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/user/self` | GET | UserAuth | 当前用户信息（含 `group`、`quota`、`used_quota`） |
| `/api/user/self` | PUT | UserAuth | 修改自己的资料 |
| `/api/user/self/groups` | GET | UserAuth | 可用分组及倍率 |
| `/api/user/self/models` | GET | UserAuth | 可用模型名数组 |
| `/api/user/self/token` | GET | UserAuth | **重新生成**系统访问令牌（旧的失效） |
| `/api/user/self/aff` | GET | UserAuth | 邀请码 |
| `/api/user/self/topup/self` | GET | UserAuth | 自己的充值记录 |

### 额度概念

用户有两个额度字段，容易混淆：

- `quota` — **剩余额度**，能实际花的余额。消费减少、充值增加。
- `used_quota` — **已用额度**，累计消费，只增不减。

Web 界面「用户管理」里显示的**总额度 = `used_quota` + `quota`**（`web/default/src/features/users/components/users-columns.tsx`），是个"这个账号历史累计拥有过多少额度"的统计值，只在充值/赠送时增长，消费不会让它减少（消费只是把额度从"剩余"挪到"已用"）。所以它会随充值持续变大，这是设计如此，不是 bug。判断"还能花多少"要看 `quota`。

额度换算：默认 `500000 quota ≈ $1`，由 `QuotaPerUnit` 配置决定，部署可改。

### 日志与统计

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/api/log/` | GET | AdminAuth | 全站日志（分页） |
| `/api/log/search` | GET | AdminAuth | 全站日志搜索 |
| `/api/log/self` | GET | UserAuth | 自己的日志 |
| `/api/log/self/search` | GET | UserAuth | 自己的日志搜索 |
| `/api/log/stat` | GET | AdminAuth | 全站统计 |
| `/api/log/self/stat` | GET | UserAuth | 自己的统计 |
| `/api/log/token` | GET | TokenAuth | **用 `sk-xxx` 令牌查该令牌的日志**（认证方式不同） |
| `/api/data/` | GET | AdminAuth | 按日额度统计 |
| `/api/data/self` | GET | UserAuth | 自己的按日统计 |

日志接口常用查询参数：`p`、`page_size`、`start_timestamp`、`end_timestamp`、`token_name`、`model_name`、`username`、`channel`、`type`。

### 渠道（AdminAuth，`router/api-router.go:217-259`）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/channel/` | GET | 列表（分页） |
| `/api/channel/search` | GET | 搜索 |
| `/api/channel/:id` | GET | 详情 |
| `/api/channel/` | POST | 新建（支持批量，见下） |
| `/api/channel/` | PUT | 更新 |
| `/api/channel/:id` | DELETE | 删除 |
| `/api/channel/test/:id` | GET | 测试连通性 |
| `/api/channel/update_balance/:id` | GET | 刷新余额 |
| `/api/channel/models` | GET | 所有支持的模型 |
| `/api/channel/models_enabled` | GET | 已启用的模型 |
| `/api/channel/fetch_models/:id` | GET | 从上游拉取模型列表 |
| `/api/channel/tag/models` | GET | 按标签查模型 |

新建渠道的 body 有个 `mode` 字段（`controller/channel.go:524,563`），三种模式：

- `single` — 单个渠道
- `batch` — 多个 key，每个 key 建一个独立渠道
- `multi_to_single` — 多个 key 汇入同一个渠道（轮询池）

### 模型元数据（AdminAuth，`router/api-router.go:350-361`）

管的是模型的展示信息（模型广场里的图标、描述、标签），**与渠道、与定价是三套独立配置**。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/models/` | GET | 列表 |
| `/api/models/search` | GET | 搜索 |
| `/api/models/:id` | GET | 详情 |
| `/api/models/` | POST | 新建 |
| `/api/models/` | PUT | 更新（`?status_only=true` 只改状态） |
| `/api/models/:id` | DELETE | 删除 |
| `/api/models/sync_upstream` | POST | 从上游同步 |
| `/api/models/missing` | GET | 有渠道但缺元数据的模型 |

`Model` 字段（`model/model_meta.go:23-44`）：`model_name`、`description`、`icon`、`tags`（**逗号分隔字符串**，不是数组）、`vendor_id`、`endpoints`、`status`、`sync_official`、`name_rule`。

**这个 PUT 是典型的全量覆盖**（`model/model_meta.go:76-82` 用 `Select()` 锁定列清单），只传 `{id, tags}` 会把 `model_name`、`status` 等清空。必须先 GET 完整对象再改再回写。

### 系统设置（RootAuth）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/option/` | GET | 读所有配置项 |
| `/api/option/` | PUT | 改单项，body `{"key":"...","value":"..."}` |
| `/api/ratio_sync/channels` | GET | 可同步倍率的渠道 |
| `/api/ratio_sync/fetch` | GET | 拉取上游倍率 |

系统公告用这个接口写：`key` 为 `Notice`（顶部横幅，支持 Markdown），或 `console_setting.announcements`（公告列表，JSON 数组，需配合 `console_setting.announcements_enabled` 开关）。

---

## 六、完整示例脚本

PowerShell 版，演示"遍历令牌 → 取分组 → 算可用模型"：

```powershell
$base = "http://localhost:3000"
$headers = @{
  "Authorization" = "你的系统访问令牌"
  "New-Api-User"  = "1"
}

# 1. 分页拉取全部令牌（注意 page_size 上限 100）
$all = @()
$page = 1
do {
    $r = Invoke-RestMethod -Uri "$base/api/token/?p=$page&page_size=100" -Headers $headers
    if (-not $r.success) { throw "请求失败: $($r.message)" }
    $all += $r.data.items
    $total = $r.data.total
    $page++
} while ($all.Count -lt $total)

Write-Host "共 $($all.Count) 个令牌"

# 2. 当前用户的分组（用于 group 为空时回落）
$self = Invoke-RestMethod -Uri "$base/api/user/self" -Headers $headers
$userGroup = $self.data.group

# 3. 拉取定价表，构建 分组→模型 映射
$pricing = Invoke-RestMethod -Uri "$base/api/pricing" -Headers $headers

function Get-ModelsForGroup($g) {
    $pricing.data | Where-Object {
        $_.enable_groups -contains $g -or $_.enable_groups -contains "all"
    } | Select-Object -ExpandProperty model_name
}

# 4. 汇总输出
foreach ($t in $all) {
    $g = if ([string]::IsNullOrEmpty($t.group)) { $userGroup } else { $t.group }
    $models = Get-ModelsForGroup $g
    Write-Host "令牌 [$($t.name)] id=$($t.id) 分组=$g 可用模型数=$($models.Count)"
}
```

curl 等价写法：

```bash
curl -X GET "http://localhost:3000/api/token/?p=1&page_size=100" \
  -H "Authorization: 你的系统访问令牌" \
  -H "New-Api-User: 1"

curl -X POST "http://localhost:3000/api/token/batch/keys" \
  -H "Authorization: 你的系统访问令牌" \
  -H "New-Api-User: 1" \
  -H "Content-Type: application/json" \
  -d '{"ids":[1,2,3]}'
```

---

## 七、常见错误排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 401 未登录 | 缺 `Authorization` 头 | 补上，注意**不要**加 `Bearer ` 前缀 |
| 401 用户 ID 未提供 | 缺 `New-Api-User` 头 | 补上 |
| 401 用户 ID 不匹配 | `New-Api-User` 与令牌所属用户不一致 | 改成正确的用户 id |
| `success: false` 访问令牌无效 | 令牌错误或已被重新生成覆盖 | 重新获取。注意调 `/api/user/self/token` 会覆盖旧令牌 |
| 返回条数总是 100 | `page_size` 被硬上限截断 | 循环翻页，用 `total` 判断结束 |
| 分页拿不到第二页 | 用了 `page` 而非 `p` | 改用 `p` |
| 更新后字段被清空 | 全量覆盖型 PUT，漏传字段 | 先 GET 完整对象，改完再整体 PUT |
| 取别人的令牌返回"记录不存在" | 接口按 user_id 强制隔离 | 设计如此，无接口可绕过 |
| `status_code=500, not implemented` | 该渠道适配器没实现这种请求类型 | 见下 |
| `do request failed: upstream error: do request failed` | 真实错误被屏蔽了 | 见下 |

### `not implemented` 报错

含义是**当前渠道类型不支持你请求的接口类型**。New API 支持聊天/embedding/语音/图片/rerank/responses/gemini 等多种格式，但 28 个渠道适配器里很多只实现了一部分，未实现的方法直接返回 `errors.New("not implemented")`（例如 `relay/channel/deepseek/adaptor.go:46-54`）。

错误往上传到 `types.NewError()` 时，因为没指定状态码，被默认赋成 500（`types/error.go:244-259`）。

典型场景：用 DeepSeek 渠道调 `/v1/embeddings` 或 `/v1/audio/speech`。排查方向是核对「渠道类型」与「请求的接口路径」是否匹配。

另外 `/v1/files`、`/v1/fine-tunes`、`/v1/images/variations` 等路径在路由层就直接挂了 `RelayNotImplemented`（`router/relay-router.go:153-165`），返回 HTTP 501，全站都不支持。

### `do request failed` 报错

用户可见的这句话是**故意脱敏的**（`relay/channel/api_request.go:518-521`），真实的 Go 错误只写进服务端日志：

```go
logger.LogError(c, "do request failed: "+err.Error())
return nil, types.NewError(err, types.ErrorCodeDoRequestFailed,
    types.ErrOptionWithHideErrMsg("upstream error: do request failed"))
```

拿真实原因要去看容器日志：

```powershell
docker logs --tail=100 new-api | Select-String "do request"
```

会看到类似 `Post "https://api.deepseek.com/v1/chat/completions": EOF` 这种具体错误，再针对性排查（网络、证书、上游限流等）。

注意 `docker compose logs` 必须在 `docker-compose.yml` 所在目录执行，否则报 `no configuration file provided`；`docker logs <容器名>` 在任意目录都能用。

---

## 八、源码索引

需要核对细节时的定位表：

| 主题 | 位置 |
|---|---|
| 认证中间件（双请求头校验） | `middleware/auth.go:36-155` |
| 分页参数解析与 100 上限 | `common/page_info.go:41-82` |
| 统一响应格式 | `common/gin.go:181-221` |
| 路由总表 | `router/api-router.go` |
| 中继路由 / 未实现路径 | `router/relay-router.go:100-165` |
| 令牌控制器 | `controller/token.go` |
| 令牌脱敏逻辑 | `controller/token.go:17-32` |
| 取明文密钥 | `controller/token.go:80-95`（单个）、`338-359`（批量） |
| 令牌模型与字段 | `model/token.go:14-32` |
| 令牌按 user_id 隔离查询 | `model/token.go:228-236` |
| 分组→模型映射 SQL | `model/ability.go:41-46` |
| 用户可用模型推导 | `controller/user.go:518-543` |
| 用户可用分组 | `controller/group.go:26-51` |
| 定价接口与分组过滤 | `controller/pricing.go:12-77` |
| Pricing 结构体 | `model/pricing.go:18-39` |
| 渠道控制器与三种新建模式 | `controller/channel.go:524-661` |
| 渠道模型 | `model/channel.go:22-59` |
| 模型元数据控制器 | `controller/model_meta.go` |
| 模型元数据结构与覆盖式 Update | `model/model_meta.go:23-44,76-82` |
| 错误类型与默认 500 | `types/error.go:244-299` |
| 上游请求错误脱敏 | `relay/channel/api_request.go:505-530` |
| 计费表达式系统说明 | `pkg/billingexpr/expr.md` |

---

## 九、给新接手的人的几条提醒

1. **判 `success` 不判 HTTP 状态码**。管理接口业务失败也返回 200。
2. **分页用 `p`，每页最多 100**。这两个都很容易踩。
3. **更新前先读**。全量覆盖型 PUT 会把漏传的字段清零。
4. **令牌明文只能取自己的**，没有管理员越权接口，但数据库里是明文存储。
5. **渠道、模型元数据、定价倍率是三套独立配置**，改一处不会自动影响另外两处。
6. `/api/user/self/token` 是**重新生成**而非查询，误调会让现有集成全部失效。
7. 涉及计费/倍率的改动，先读 `pkg/billingexpr/expr.md`，那套表达式系统有自己的设计约定。









