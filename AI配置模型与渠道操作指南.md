# 给 AI 助手：new-api「配置渠道 + 配置模型」操作指南

> 适用对象：协助操作 new-api 后台的 AI 助手。
> 目标：在**不修改项目代码**的前提下，通过管理 REST API 完成渠道与模型的配置（增删改、批量、同步、定价）。
> 配套文档：标签批量写入见 [`AI批量写入模型标签指南.md`](./AI批量写入模型标签指南.md)。
> 本文所有路由/字段均经源码核对，附 `文件:行号`。

---

## 0. 先搞清三个概念（最关键，别配错地方）

| 概念 | 是什么 | 在哪配 | 决定什么 |
|---|---|---|---|
| **渠道 (channel)** | 指向某个上游供应商的转发配置（含上游 key、地址、可用模型列表） | `/api/channel` | **模型能不能真正被调用**（路由 + 负载均衡） |
| **模型元数据 (model)** | 模型的展示信息（名称、图标、标签、供应商、端点、定价归类） | `/api/models` | 模型广场的**展示/分类**，不负责能否调用 |
| **定价/倍率 (ratio)** | 每个模型的计费倍率 | `/api/option`（key=`ModelRatio` 等） | **计费金额** |

> 一句话：**要让某模型可用 → 配渠道（channel.models）**；要让它在模型广场好看、能分类 → 配模型元数据；要算钱 → 配倍率。三者独立。

---

## 1. 通用约定（所有接口都适用）

### 1.1 鉴权：每个请求必带两个头

这些都是管理员接口（`middleware/auth.go:36-104`）：

| 请求头 | 值 | 说明 |
|---|---|---|
| `Authorization` | `<系统访问令牌>` | 控制台 → **个人设置 → 生成系统访问令牌**。原样填，**不要**加 `Bearer`。 |
| `New-Api-User` | `<管理员用户ID>` | root 通常是 `1`。 |

⚠️ 这个「系统访问令牌」**不是**调模型推理用的 `sk-` 令牌（那是给终端用户的 Token），两者完全不同。

### 1.2 两种权限级别

- **AdminAuth**（管理员）：渠道、模型元数据、供应商、预填组。
- **RootAuth**（超级管理员 root）：系统配置 `/api/option`、定价倍率同步 `/api/ratio_sync`。
  本文凡标 **RootAuth** 的接口，普通管理员调用会返回「无权进行此操作」。

### 1.3 响应结构

成功统一是 `{ "success": true, "data": ... }`；列表类返回 `data.items` + `data.total`。
失败是 `{ "success": false, "message": "原因" }`（注意：很多失败也返回 HTTP 200，要看 `success` 字段，不能只看状态码）。

### 1.4 分页

参数名是 **`p`**（页码）和 `page_size`（页大小）。**`page_size` 被服务端强制截到 100**（`common/page_info.go:77`）。数据超过 100 条必须翻页循环。

### 1.5 一条铁律：更新模型用「整条写回」

`PUT /api/models/` 用了 `Select(...)` 强制覆盖一整批列（`model/model_meta.go:76-82`）。只发部分字段会把其它字段清空。**必须先 GET 整条 → 只改目标字段 → 整条 PUT 回去。**（渠道的 `PUT /api/channel/` 用的是 patch 语义，相对宽松，但也建议带全字段。）

---

## 2. 配置渠道 (channel)

路由组 `/api/channel`，**AdminAuth**（`api-router.go:217-259`，控制器 `controller/channel.go`）。

### 2.1 渠道接口总表

| 功能 | 路由 | 方法 | 控制器 | 鉴权 |
|---|---|---|---|---|
| 列出所有渠道 | `/api/channel/` | GET | `GetAllChannels` | Admin |
| 搜索渠道 | `/api/channel/search` | GET | `SearchChannels` | Admin |
| 取单个渠道 | `/api/channel/:id` | GET | `GetChannel` | Admin |
| **新建渠道（单/批量/多key）** | `/api/channel/` | **POST** | `AddChannel` | Admin |
| **更新渠道** | `/api/channel/` | **PUT** | `UpdateChannel` | Admin |
| 复制渠道为新渠道 | `/api/channel/copy/:id` | POST | `CopyChannel` | Admin |
| 删除单个渠道 | `/api/channel/:id` | DELETE | `DeleteChannel` | Admin |
| 批量删除渠道 | `/api/channel/batch` | POST | `DeleteChannelBatch` | Admin |
| 删除所有禁用渠道 | `/api/channel/disabled` | DELETE | `DeleteDisabledChannel` | Admin |
| 批量设置标签 | `/api/channel/batch/tag` | POST | `BatchSetChannelTag` | Admin |
| 按标签批量启用 | `/api/channel/tag/enabled` | POST | `EnableTagChannels` | Admin |
| 按标签批量禁用 | `/api/channel/tag/disabled` | POST | `DisableTagChannels` | Admin |
| 按标签批量编辑 | `/api/channel/tag` | PUT | `EditTagChannels` | Admin |
| 一键测试所有渠道 | `/api/channel/test` | GET | `TestAllChannels` | Admin |
| 测试单个渠道 | `/api/channel/test/:id` | GET | `TestChannel` | Admin |
| 一键更新所有余额 | `/api/channel/update_balance` | GET | `UpdateAllChannelsBalance` | Admin |
| 更新单个渠道余额 | `/api/channel/update_balance/:id` | GET | `UpdateChannelBalance` | Admin |
| 修复渠道能力 | `/api/channel/fix` | POST | `FixChannelsAbilities` | Admin |
| 拉取上游模型列表（按 id） | `/api/channel/fetch_models/:id` | GET | `FetchUpstreamModels` | Admin |
| 预拉上游模型列表（按参数） | `/api/channel/fetch_models` | POST | `FetchModels` | **Root** |
| 列出系统已知模型 | `/api/channel/models` | GET | `ChannelListModels` | Admin |
| 一键检测所有渠道模型更新 | `/api/channel/upstream_updates/detect_all` | POST | `DetectAllChannelUpstreamModelUpdates` | Admin |
| 一键应用所有渠道模型更新 | `/api/channel/upstream_updates/apply_all` | POST | `ApplyAllChannelUpstreamModelUpdates` | Admin |

### 2.2 新建渠道请求体（POST /api/channel/）

外层 `AddChannelRequest`（`channel.go:524`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | string | `single`=建1个 / `batch`=每个key建1个独立渠道 / `multi_to_single`=建1个多key轮询渠道 |
| `multi_key_mode` | string | 仅 `multi_to_single` 用 |
| `batch_add_set_key_prefix_2_name` | bool | 批量建时把 key 前8位拼到名字后做区分 |
| `channel` | object | 渠道对象，见下 |

`channel` 对象核心字段（`model/channel.go:22`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | int | ✔ | 渠道类型（DeepSeek=43、OpenAI 等，见 `constant/channel.go`） |
| `key` | string | ✔ | 上游 API Key；batch/multi 模式多个 key 用换行 `\n` 分隔 |
| `name` | string | ✔ | 渠道名称 |
| `base_url` | string | | 自定义上游地址，留空走默认 |
| `models` | string | ✔ | 该渠道可用模型，**逗号分隔**（如 `deepseek-chat,deepseek-reasoner`） |
| `group` | string | | 分组，默认 `default`，多个逗号分隔 |
| `model_mapping` | string | | 模型名映射（JSON 串） |
| `priority` | int | | 优先级 |
| `weight` | uint | | 权重 |
| `tag` | string | | 渠道标签 |
| `setting` / `param_override` / `header_override` | string | | 额外设置 / 参数覆盖 / 头覆盖（JSON 串） |

> 创建校验 `validateChannel`（`channel.go:433`）：`key` 不能为空，`setting` 等 JSON 必须合法。

### 2.3 示例：新建一个 DeepSeek 渠道（single）

```json
POST /api/channel/
{
  "mode": "single",
  "channel": {
    "type": 43,
    "name": "我的 DeepSeek",
    "key": "sk-上游key",
    "base_url": "https://api.deepseek.com",
    "models": "deepseek-chat,deepseek-reasoner",
    "group": "default"
  }
}
```

### 2.4 示例：一次建多个独立渠道（batch）

```json
POST /api/channel/
{
  "mode": "batch",
  "batch_add_set_key_prefix_2_name": true,
  "channel": {
    "type": 43, "name": "DS", "base_url": "https://api.deepseek.com",
    "models": "deepseek-chat",
    "key": "sk-key1\nsk-key2\nsk-key3"
  }
}
```

---

## 3. 配置模型 (model)

### 3.1 模型元数据 — 增删改查

路由组 `/api/models`，**AdminAuth**（`api-router.go:350-362`，`controller/model_meta.go`）。

| 功能 | 路由 | 方法 | 控制器 |
|---|---|---|---|
| 分页列出模型 | `/api/models/` | GET | `GetAllModelsMeta` |
| 搜索模型 | `/api/models/search` | GET | `SearchModelsMeta` |
| 取单个模型 | `/api/models/:id` | GET | `GetModelMeta` |
| **新建模型** | `/api/models/` | POST | `CreateModelMeta` |
| **更新模型** | `/api/models/` | PUT | `UpdateModelMeta`（`?status_only=true` 只改状态） |
| 删除模型 | `/api/models/:id` | DELETE | `DeleteModelMeta` |

模型对象字段（`model/model_meta.go:23`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `model_name` | string | 模型名（必填、唯一） |
| `description` | string | 描述 |
| `icon` | string | 图标 |
| `tags` | string | 标签，英文逗号分隔 |
| `vendor_id` | int | 所属供应商 ID |
| `endpoints` | string | 支持的端点类型 |
| `status` | int | 1启用 / 0禁用 |
| `sync_official` | int | 是否随官方同步 |
| `name_rule` | int | 名称匹配规则 |

> 更新务必遵守 §1.5「整条写回」。

### 3.2 上游模型同步 — 一键批量配模型

同 `/api/models` 组，Admin（`controller/model_sync.go`）：

| 功能 | 路由 | 方法 | 控制器 |
|---|---|---|---|
| 列出"上游有本地缺"的模型 | `/api/models/missing` | GET | `GetMissingModels` |
| 同步前预览差异 | `/api/models/sync_upstream/preview` | GET | `SyncUpstreamPreview` |
| **一键同步上游模型定义** | `/api/models/sync_upstream` | POST | `SyncUpstreamModels` |

### 3.3 供应商 (vendor) — 模型的归属方

路由组 `/api/vendors`，Admin（`api-router.go:339-348`，`controller/vendor_meta.go`）。模型的 `vendor_id` 指向它。

| 功能 | 路由 | 方法 | 控制器 |
|---|---|---|---|
| 列出供应商 | `/api/vendors/` | GET | `GetAllVendors` |
| 搜索供应商 | `/api/vendors/search` | GET | `SearchVendors` |
| 取单个供应商 | `/api/vendors/:id` | GET | `GetVendorMeta` |
| 新建供应商 | `/api/vendors/` | POST | `CreateVendorMeta` |
| 更新供应商 | `/api/vendors/` | PUT | `UpdateVendorMeta` |
| 删除供应商 | `/api/vendors/:id` | DELETE | `DeleteVendorMeta` |

### 3.4 预填组 (prefill_group) — 配置模板

路由组 `/api/prefill_group`，Admin（`api-router.go:320-327`，`controller/prefill_group.go`）。把「标签+分组」存成模板一键套用。

| 功能 | 路由 | 方法 |
|---|---|---|
| 列出 | `/api/prefill_group/` | GET |
| 新建 | `/api/prefill_group/` | POST |
| 更新 | `/api/prefill_group/` | PUT |
| 删除 | `/api/prefill_group/:id` | DELETE |

### 3.5 模型定价 / 倍率（注意是 RootAuth）

读取公开（带用户态），**写入需 root**：

| 功能 | 路由 | 方法 | 控制器 | 鉴权 |
|---|---|---|---|---|
| 读取所有模型价格/倍率 | `/api/pricing` | GET | `GetPricing` | TryUserAuth |
| 写倍率（key=`ModelRatio`/`ModelPrice`/`CompletionRatio`，value=JSON串） | `/api/option/` | PUT | `UpdateOption` | **Root** |
| 一键重置倍率为默认 | `/api/option/rest_model_ratio` | POST | `ResetModelRatio` | **Root** |
| 列出可同步倍率的渠道 | `/api/ratio_sync/channels` | GET | `GetSyncableChannels` | **Root** |
| 一键从上游拉取倍率 | `/api/ratio_sync/fetch` | POST | `FetchUpstreamRatios` | **Root** |

> 定价不在 `/api/models/` 里，而是系统配置项；`UpdateOption` 每次只写一个 key（`controller/option.go`），不支持一次批量多 key。

---

## 4. 推荐编排：从零「一键配好」一个可用模型

顺序很重要（先有渠道才能调用，元数据/定价是锦上添花）：

```
1) POST /api/channel/            建渠道（带 models 列表）→ 模型即可被调用
2) POST /api/models/sync_upstream 或 POST /api/models/  补全模型元数据
3) PUT  /api/models/             给模型写 tags / vendor_id（整条写回）
4) PUT  /api/option/ (ModelRatio) 或 POST /api/ratio_sync/fetch  配/拉倍率（需 root）
5) GET  /api/channel/test/:id    测试渠道连通
```

---

## 5. 参考脚本（PowerShell，Windows 可直接跑）

```powershell
$base  = "http://localhost:3000"
$token = "你的系统访问令牌"        # 个人设置里生成
$uid   = "1"                       # 管理员用户 ID
$H = @{ "Authorization" = $token; "New-Api-User" = $uid }

function Put-Json($url, $obj) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 10))
  Invoke-RestMethod -Uri $url -Method Put -Headers $H -ContentType "application/json" -Body $bytes
}
function Post-Json($url, $obj) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 10))
  Invoke-RestMethod -Uri $url -Method Post -Headers $H -ContentType "application/json" -Body $bytes
}

# 1) 新建一个 DeepSeek 渠道
Post-Json "$base/api/channel/" @{
  mode = "single"
  channel = @{
    type = 43; name = "我的 DeepSeek"; key = "sk-上游key"
    base_url = "https://api.deepseek.com"
    models = "deepseek-chat,deepseek-reasoner"; group = "default"
  }
}

# 2) 一键同步上游模型定义
Post-Json "$base/api/models/sync_upstream" @{}

# 3) 给某模型写标签（整条读出→改→整条写回）
$all = @(); $p = 1
do {
  $r = Invoke-RestMethod -Uri "$base/api/models/?p=$p&page_size=100" -Headers $H
  if ($r.data.items) { $all += $r.data.items }
  $total = $r.data.total; $p++
} while ($all.Count -lt $total -and $r.data.items.Count -gt 0)

$m = $all | Where-Object { $_.model_name -eq "deepseek-chat" } | Select-Object -First 1
if ($m) { $m.tags = "对话,推荐"; Put-Json "$base/api/models/" $m }
```

---

## 6. 排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `未登录或登录已过期` | 缺 `Authorization` 或令牌错 | 补头/换令牌 |
| `无权进行此操作` | 调了 RootAuth 接口但不是 root，或 `New-Api-User` 不符 | 用 root 账号的令牌 |
| 更新后模型名变空/模型消失 | 违反「整条写回」 | 改为先 GET 整条再 PUT |
| 只更新了前 100 条 | 没翻页 | 用 `p` 循环到 `total` |
| 新建渠道报 key 为空 | `channel.key` 没填 | 补 key |
| 模型能配但调用 404/无渠道 | 只配了元数据没配渠道 | 渠道 `models` 加上该模型并启用 |
| 中文乱码 | body 未按 UTF-8 字节发送 | 用脚本里的 `GetBytes` |
| 标签没分类 | 用了中文逗号「，」 | 改英文逗号 `,` |

---

## 7. 源码依据一览

- 渠道路由：`router/api-router.go:217-259`
- 新建渠道：`controller/channel.go:563`（`AddChannel`）、请求体 `:524`、校验 `:433`
- 渠道字段：`model/channel.go:22`
- 模型路由：`router/api-router.go:350-362`；控制器 `controller/model_meta.go:17-161`
- 模型字段 / 整条写回：`model/model_meta.go:23-44`、`:76-82`
- 上游同步：`controller/model_sync.go`
- 供应商：`router/api-router.go:339-348`、`controller/vendor_meta.go`
- 预填组：`router/api-router.go:320-327`、`controller/prefill_group.go`
- 定价/倍率：`api-router.go:179-188`（option，Root）、`:211-216`（ratio_sync，Root）、`:33`（pricing）
- 鉴权双头：`middleware/auth.go:36-104`
- 分页上限：`common/page_info.go:41-82`
