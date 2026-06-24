# 给 AI 助手：如何批量写入模型「标签(tags)」字段

> 适用对象：协助操作 new-api 后台的 AI 助手。
> 目标：在**不修改项目代码**的前提下，把外部（如测试程序）产出的标签批量写到各模型上，使「模型广场」按标签分类生效。
> 本文所有结论均来自源码核对，文末附依据。

---

## 0. 一句话结论

模型的标签是数据库 `models` 表里的一个普通字段 `tags`（逗号分隔字符串）。后台已暴露**管理员 REST API**，按「**GET 取出整条 → 只改 tags → 原样 PUT 回去**」的方式调用即可，无需改代码、无需直接动数据库。

---

## 1. 字段定义

- 后端结构体字段：`Model.Tags string`，JSON 名为 `tags`，DB 类型 `varchar(255)`
  - 位置：`model/model_meta.go:28`
- 取值格式：**英文逗号 `,` 分隔的字符串**，例如 `"对话,推荐,长上下文"`
- 前端模型广场读取同一字段 `tags`，按逗号拆分后做分组/筛选（`web/default/src/features/pricing/...`）

---

## 2. 用到的接口

| 操作 | 方法 & 路径 | 控制器 |
|---|---|---|
| 取模型列表（分页） | `GET /api/models/?p=<页码>&page_size=<页大小>` | `GetAllModelsMeta` |
| 取单个模型 | `GET /api/models/:id` | `GetModelMeta` |
| 更新模型 | `PUT /api/models/` | `UpdateModelMeta` |

- 路由定义：`router/api-router.go:356-360`
- 更新成功后后台会自动调用 `RefreshPricing()`，模型广场**立即生效**，无需重启。

---

## 3. 鉴权（最容易踩坑，务必照做）

这是**管理员接口**，每个请求都要带**两个请求头**（`middleware/auth.go:36-104`）：

| 请求头 | 值 | 说明 |
|---|---|---|
| `Authorization` | `<系统访问令牌>` | 控制台 → **个人设置 → 生成系统访问令牌**。原样填入，**不要**加 `Bearer ` 前缀。 |
| `New-Api-User` | `<管理员用户ID>` | root 管理员通常是 `1`。 |

⚠️ 这个「系统访问令牌」**不是**用来调模型推理的那个 `sk-...` 令牌（那是 Token，给终端用户用的）。两者完全不同，别混。

鉴权失败的典型返回：`未登录或登录已过期` / `无权进行此操作` / `访问令牌无效`。

---

## 4. 两个必须遵守的规则（否则会损坏数据）

### 规则 A：必须「整条读出 → 改 tags → 整条写回」

更新逻辑用了 `Select(...)` **强制覆盖**这一整批列：
`model_name, description, icon, tags, vendor_id, endpoints, status, sync_official, name_rule`
（依据 `model/model_meta.go:76-82`）

也就是说：如果你只 PUT `{ "id":1, "tags":"x" }`，那么 `model_name` 会被写成空串、`status` 会被写成 0……**整个模型被破坏**。

✅ 正确做法：先 `GET` 拿到完整对象，**只修改其中的 `tags`**，把**整个对象**再 PUT 回去。其余字段值原封不动即可。

> 备注：返回对象里那些 `bound_channels / enable_groups / matched_models` 等是只读附加字段（`gorm:"-"`），原样带回去不会被写库，无需理会。

### 规则 B：列表接口分页上限是 100

`page_size` 会被服务端**强制截断到 100**（`common/page_info.go:77`），且页码参数名是 **`p`**（不是 `page`）。
所以模型超过 100 个时**必须翻页循环**拉取，不能指望一次 `page_size=1000` 拿全。

返回结构为：`{ "success": true, "data": { "items": [...], "total": N } }`。

---

## 5. 标准操作流程

1. 拿到 `系统访问令牌` 和 `管理员用户ID`。
2. 循环 `p=1,2,3...` 调 `GET /api/models/?p=$p&page_size=100`，直到取满 `total` 条，得到全部模型。
3. 对每个模型，按「模型名 → 标签」映射查找；命中则把对象的 `tags` 改为目标值。
4. 把**整个对象** `PUT /api/models/` 写回。
5. 刷新模型广场验证。

---

## 6. 参考实现（PowerShell，Windows 环境直接可用）

```powershell
$base  = "http://localhost:3000"
$token = "你的系统访问令牌"      # 个人设置里生成
$uid   = "1"                     # 管理员用户 ID
$headers = @{ "Authorization" = $token; "New-Api-User" = $uid }

# 外部测试程序产出的结果：模型名 -> 标签（多个用英文逗号分隔）
$tagMap = @{
  "deepseek-chat"     = "对话,推荐"
  "deepseek-reasoner" = "推理,深度思考"
}

# 1) 翻页拉取全部模型（page_size 上限 100，页码参数是 p）
$all = @(); $p = 1
do {
  $resp  = Invoke-RestMethod -Uri "$base/api/models/?p=$p&page_size=100" -Headers $headers
  $items = $resp.data.items
  if ($items) { $all += $items }
  $total = $resp.data.total
  $p++
} while ($all.Count -lt $total -and $items.Count -gt 0)

# 2) 命中映射的，改 tags 后「整条」写回
foreach ($m in $all) {
  if ($tagMap.ContainsKey($m.model_name)) {
    $m.tags = $tagMap[$m.model_name]
    $body   = $m | ConvertTo-Json -Depth 10
    $bytes  = [System.Text.Encoding]::UTF8.GetBytes($body)   # 中文标签防乱码
    Invoke-RestMethod -Uri "$base/api/models/" -Method Put `
      -Headers $headers -ContentType "application/json" -Body $bytes | Out-Null
    Write-Host "已更新: $($m.model_name) -> $($m.tags)"
  }
}
```

### 等价 curl（跨平台）思路
```
# 取列表
curl -s "http://localhost:3000/api/models/?p=1&page_size=100" \
  -H "Authorization: <系统访问令牌>" -H "New-Api-User: 1"
# 改完整对象后写回
curl -s -X PUT "http://localhost:3000/api/models/" \
  -H "Authorization: <系统访问令牌>" -H "New-Api-User: 1" \
  -H "Content-Type: application/json" \
  -d '<完整模型对象 JSON，仅修改了 tags>'
```

---

## 7. 备选方案与取舍

| 方案 | 是否改代码 | 优点 | 缺点 |
|---|---|---|---|
| **管理 API（本文推荐）** | 否 | 自动刷新缓存、最安全、跨库无差异 | 需先拿访问令牌 |
| 直接改数据库 `UPDATE models SET tags=...` | 否 | 简单粗暴 | 不会刷新内存缓存，需重启/触发刷新；易写错；要进 Docker 连库 |
| 让测试程序自己发上述 HTTP 请求 | 否 | 测试完一步到位 | 同样要处理鉴权与「整条写回」规则 |

**首选管理 API。** 不碰代码、不碰库内部、自动 `RefreshPricing`。

---

## 8. 排错速查

- `未登录或登录已过期`：缺 `Authorization` 头，或令牌错。
- `无权进行此操作`：`New-Api-User` 不是管理员，或与令牌所属用户不符。
- 写回后**模型名变空 / 模型消失**：违反了规则 A——你发的是部分字段。改为「整条写回」。
- 模型只更新了前 100 个：违反了规则 B——没翻页。
- 中文标签乱码：PUT body 用 UTF-8 字节发送（见脚本 `GetBytes`）。
- 标签没分类：确认 `tags` 用的是**英文逗号**分隔，不是中文「，」。

---

## 9. 源码依据一览

- 字段：`model/model_meta.go:23-44`（`Tags` 字段）
- 更新只 Select 这批列：`model/model_meta.go:76-82`
- 控制器：`controller/model_meta.go:17-145`（List / Get / Update）
- 路由 + 管理员鉴权：`router/api-router.go:350-362`（`modelsRoute.Use(middleware.AdminAuth())`）
- 鉴权双头：`middleware/auth.go:36-104`（`Authorization` + `New-Api-User`）
- 分页参数与上限：`common/page_info.go:41-82`（参数名 `p`、`page_size`，上限 100）
