# 智慧校园 · API 参考

所有接口均位于 `/api` 下；除 `/api/health`（`GET`）外均使用 `POST` + JSON。示例中的 base URL 默认为 `http://localhost:3000`。

> **命名约定**：所有接口路径统一使用 kebab-case（小写单词 + `-`），例如
> `/api/new-submission`、`/api/get-auths`、`/api/reset-password`

## 0. 通用约定

### 0.1 请求头

```http
Content-Type: application/json
```

### 0.2 鉴权

- 除 `/api/health`、`/api/login-try`、`/api/get-auths`、`/api/refresh-key`、`/api/reset-password`、`/api/register`、`/api/upgrade-pubkey`、`/multi-api` 外，均需要请求体中的 `auth`：一个班级密钥，例如 `SC-STU-DEMO-2026`。
- 密钥同时决定 **班级** 与 **角色**，不允许跨班操作。
- `/api/del-object` 按原始需求只传 `id`；也接受可选的 `auth`，缺省时使用浏览器登录 cookie（`sc_sid`）鉴权。
- 角色：`student`（学生）、`teacher`（老师）、`admin`（管理员）。家长使用学生密钥，不具备教师/管理员权限。
- **学生 / 家长只是前台展示视角**（v0.1.6）：页面上的「学生视角 / 家长视角」只改变文案与 `page_role`，
  数据范围与权限完全一致；API 中没有任何「家长」参数，也不需要传。

### 0.3 响应与错误

成功响应都会包含 `"ok": true`，并额外包含需求指定的字段：

```json
{ "ok": true, "id": "up_xxxxxxxxxxxx" }
```

失败响应为：

```json
{ "ok": false, "msg": "human-readable error message" }
```

> v0.1.2 起，API 的字段、错误与 `msg` 统一使用英文；页面 UI 文案由 `strings/zh-CN.txt` 提供。

| HTTP | 含义 |
| --- | --- |
| 200 | 成功 |
| 400 | 参数/格式错误（如非法正则、附件格式错误） |
| 401 | 缺少或无效的 `auth` / 登录会话 |
| 403 | 权限不足（如学生调用下载） |
| 404 | 对象不存在，或不属于当前班级 |
| 422 | JSON 字段缺失或类型错误（框架级） |
| 413 | 请求体超过 32MB |

### 0.4 ID 与格式

- 班级：`cls_*`
- 身份/密钥记录：`auth_*`（密钥本身是 `SC-XXX-XXXXXXXX`）
- 征集：`sub_*`
- 提交：`up_*`
- 回复：`rep_*`
- 班级自定义征集模式：`mode_*`（内置模式的 ID 为 `builtin_<name>`）
- 登录挑战会话：`login_*`（仅在 `/api/login-try` 响应中出现，300 秒有效）

### 0.5 时间

- 请求接受：
  - `2026-11-01T20:00`
  - `2026-11-01 20:00:00`
  - `2026-11-01`
  - `2026-11-01T12:00:00Z`
  - `2026-11-01T20:00:00+08:00`
  - Unix 时间戳（秒）
- 无时区输入按 **北京时间（UTC+8）** 解释。
- 响应中的 `deadLine` / `createdAt` 为 `2026-11-01T20:00:00+08:00` 形式。
- `deadLine: null` 或空字符串表示无截止时间。

### 0.6 附件

`data` 必须为数组，最多 8 项，base64 文本总长度上限约 24MB（原始数据约 18MB）。

推荐：

```json
[
  {
    "name": "作业第1页.png",
    "mime": "image/png",
    "data": "iVBORw0KGgoAAAANSUhEUg..."
  }
]
```

兼容：

- `"data:image/png;base64,iVBOR..."`；
- 裸 base64 字符串（会按 `application/octet-stream` 保存）。

服务端会校验 MIME 与 base64，并统一保存为对象数组（data URL 字符串会保持字符串形式）。图片在页面中内联预览，其他附件提供下载。

---

## 1. `/api/upload`

上传一份提交到指定征集（任意角色）。类型为 `notice` 的公示版禁用提交，会返回 `403`；
类型为 `survey` 的问卷征集会在服务端再校验一次必填题（见 [1.1 问卷模式](#11-问卷模式survey)）。

### 请求

```json
{
  "auth": "SC-STU-DEMO-2026",
  "which": "sub_xxxxxxxxxxxx",
  "title": "周末练习 · 第 1 页",
  "desc": "已完成 P42–P45，第 3 题不太确定。",
  "data": [
    {
      "name": "page1.png",
      "mime": "image/png",
      "data": "iVBORw0KGgo..."
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 班级密钥 |
| `which` | string | ✅ | 征集 ID，必须在同一班级 |
| `title` | string | ✅ | 提交标题，≤200 字 |
| `desc` | string | — | 说明，≤5000 字 |
| `data` | array | — | 附件数组，默认 `[]` |

### 响应

```json
{ "ok": true, "id": "up_xxxxxxxxxxxx" }
```

### 示例

```bash
curl -s http://localhost:3000/api/upload \
  -H 'Content-Type: application/json' \
  -d '{
    "auth":"SC-STU-DEMO-2026",
    "which":"SUB_ID",
    "title":"周末练习",
    "desc":"已完成",
    "data":[{"name":"hello.txt","mime":"text/plain","data":"aGVsbG8="}]
  }'
```

说明：学生始终以自己的身份记录 `studentID` / `shortStudentID`；老师/管理员上传时这两项为空/0。截止后仍允许补交。

### 1.1 问卷模式（`survey`）

征集类型为 `survey` 时，简介（`desc`）里可以用 `<input/>`、`<checkbox/>`、`<switch/>` 定义题目，
页面会把它渲染成可填写的表单，并在末尾提供提交按钮。提交仍然走 `/api/upload`，
只是按固定约定打包：

```json
{
  "auth": "SC-STU-DEMO-2026",
  "which": "sub_xxxxxxxxxxxx",
  "title": "bot-upload",
  "desc": "{\"form_name\":\"陈小满\",\"form_club\":\"math,art\",\"form_notify\":\"on\"}",
  "data": []
}
```

- `title` 固定为 `bot-upload`（页面上的自动提交使用该标题，便于筛选）；
- `desc` 是 `{控件 id: 值}` 的 JSON **字符串**，键与简介里控件的 `id` 一一对应；
- 值的约定：
  - `input` → 输入内容（去除首尾空格）；
  - `switch` → `"on"` / `"off"`；
  - `checkbox` → 勾选时为其 `value`（缺省 `"on"`），未勾选为空字符串；同一 `id` 出现多次时为多选组，勾选项以 `,` 连接。

必填校验：简介里的控件带 `required` 时，如果 `desc` 能解析成 JSON 对象，缺少必填键（或值为空、`false`）
会返回 `400`：

```json
{ "ok": false, "msg": "missing required survey fields: form_name" }
```

不是 JSON 对象的 `desc`（普通文字说明）不会被拦截，因此「仍允许 API 直接提交」的约定依然成立。

### 1.2 答题卡模式（`answer sheet`）

答题卡是问卷的派生模式：表单项目在 `id` 之外**必须**再带 `data-answer`（正确答案）与 `data-score`（分值），
所有项目都必填，提交时由前端自动批改，并把正误与分数追加在提交内容（`desc`）末尾的 `__grade` 对象里。

```json
{
  "auth": "SC-STU-DEMO-2026",
  "which": "sub_xxxxxxxxxxxx",
  "title": "bot-upload",
  "desc": "{\"form_q1\":\"2\",\"form_q2\":\"b\",\"form_q3\":\"off\",\"__grade\":{\"score\":8,\"full\":10,\"right\":2,\"count\":3,\"detail\":{\"form_q1\":{\"ok\":true,\"score\":5,\"answer\":\"2\"},\"form_q2\":{\"ok\":true,\"score\":3,\"answer\":\"b\"},\"form_q3\":{\"ok\":false,\"score\":0,\"answer\":\"on\"}}}}"
}
```

| `__grade` 字段 | 说明 |
| --- | --- |
| `score` / `full` | 实得分 / 满分 |
| `right` / `count` | 答对题数 / 总题数 |
| `detail[<id>]` | 单题结果：`ok`（是否正确）、`score`（得分）、`answer`（正确答案） |

比对规则（前端）：

- `input`：先做 `trim` + 忽略大小写比较，`data-answer` 可用 `|` 给多个可接受答案（如 `A|a|甲`）；
- `checkbox`：多选组成集合比较（与顺序无关），`data-answer` 用 `,` / `，` / `、` 分隔正确选项；
  单选项勾选时的值为其 `value`（缺省 `on`），未勾选为空字符串，即 `data-answer="on"` 表示「应勾选」；
- `switch`：`on` / `off` 比较（也接受 `true`/`false`、`1`/`0`）。

发布答题卡时服务端会校验简介：至少有一项合法的 `<input/>` / `<checkbox/>` / `<switch/>`，
且每项都带 `id`（`form_` 前缀）、`data-answer`、`data-score`（多选组的后续选项可省略后两者），
否则 `/api/new-submission` 返回 `400`。提交时服务端要求所有题目的 id 都出现在 `desc` 的 JSON 里。

> 前端批改意味着正确答案会随页面下发（`data-answer` 属性），适合练习、自测类场景；
> 需要防作弊的正式考试请改为服务端批改。

```bash
# 老师发布问卷：简介里写题目
curl -s $BASE/api/new-submission -H 'Content-Type: application/json' -d '{
  "auth":"SC-TEA-DEMO-2026",
  "name":"秋季活动问卷",
  "type":"survey",
  "desc":"姓名：<input id=\"form_name\" required/>\n想参加的社团：<checkbox id=\"form_club\" value=\"math\"/>数学社 <checkbox id=\"form_club\" value=\"art\"/>美术社\n接收通知：<switch id=\"form_notify\"/>"
}'

# 学生按 JSON 答案提交
curl -s $BASE/api/upload -H 'Content-Type: application/json' -d "{
  \"auth\":\"SC-STU-DEMO-2026\",
  \"which\":\"$SUB\",
  \"title\":\"bot-upload\",
  \"desc\":\"{\\\"form_name\\\":\\\"陈小满\\\",\\\"form_club\\\":\\\"math,art\\\",\\\"form_notify\\\":\\\"on\\\"}\"
}"
```

---

## 2. `/api/download`

查看/下载某征集的提交（**老师 / 管理员**）。

### 请求

```json
{
  "auth": "SC-TEA-DEMO-2026",
  "which": "sub_xxxxxxxxxxxx",
  "match_mode": "All"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 老师/管理员密钥 |
| `which` | string | ✅ | 征集 ID |
| `match_mode` | string / object | — | 缺省为 `"All"` |

### MatchMode

| 写法 | 说明 |
| --- | --- |
| `"All"` / `{"All":null}` | 全部提交 |
| `{"Random":3}` / `{"Random":{"quantity":3}}` | 随机取 3 条（保持时间顺序） |
| `{"StudentID":"G2603-01"}` | 按学号精确匹配 |
| `{"ShortStudentID":1}` | 按班内短学号匹配 |
| `{"TitleReGex":"^函数"}` | 对标题做正则匹配；非法正则返回 400 |
| `{"Before":"2026-11-01T20:00"}` | 提交时间早于指定时间 |
| `{"Before":"7d"}` | 提交时间早于 7 天前（支持 `s/m/h/d/w`） |

也支持显式对象：

```json
{ "type": "Random", "quantity": 3 }
{ "type": "Before", "time": "7d" }
```

### 响应

```json
{
  "ok": true,
  "datas": [
    {
      "id": "up_xxxxxxxxxxxx",
      "studentID": "G2603-01",
      "shortStudentID": 1,
      "title": "周末练习",
      "desc": "已完成",
      "data": [],
      "reply": ["整体完成得很好。", "注意第 3 题的链式法则。"],
      "replyIDs": ["rep_aaaaaaaaaaaa", "rep_bbbbbbbbbbbb"],
      "uploader": "陈小满",
      "role": "student",
      "createdAt": "2026-10-24T11:00:00+08:00"
    }
  ]
}
```

- 需求字段：`studentID`、`shortStudentID`、`title`、`desc`、`data`、`reply`。
- `reply` 是回复内容字符串数组，按时间升序；`replyIDs` 与它一一对应（用于管理员逐条删除回复）。
- 额外字段 `id`、`submissionID`、`uploader`、`role`、`createdAt` 便于页面与工具使用。
- 老师/管理员上传的提交 `studentID` 为空字符串、`shortStudentID` 为 0。

---

## 3. `/api/new-submission`

发布征集（**老师 / 管理员**）。

### 请求

```json
{
  "auth": "SC-TEA-DEMO-2026",
  "name": "函数与导数 · 周末练习",
  "desc": "完成练习册 P42–P45，拍照上传。",
  "type": "homework",
  "deadLine": "2026-11-01T20:00",
  "hidden": false,
  "teacherOnly": false,
  "adminOnly": false,
  "invisible": false
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 老师/管理员密钥 |
| `name` | string | ✅ | 征集名称，≤200 字 |
| `desc` | string | — | 说明，≤2000 字 |
| `type` | string | — | 模式名；例：`homework`、`open call`、`leave request`、`survey`（问卷）、`answer sheet`（答题卡）、`notice`，缺省 `homework`；也可传 `hidden`、`teacher only`、`admin only`、`invisible` 或班级自定义模式 |
| `deadLine` | string / number / null | — | 截止时间 |
| `hidden` | bool | — | 单条征集隐藏（打开 `show-hiddens` 后可见） |
| `teacherOnly` | bool | — | 单条征集仅教师可见 |
| `adminOnly` | bool | — | 单条征集仅管理员可见 |
| `invisible` | bool | — | 单条征集不显示（只能按 ID 直接访问） |

单条覆盖属性与模式属性取并集。抽象类别（如内置 `separate list`）不能直接发布，返回 `400`；
`adminOnly` 模式只有管理员可以发布。响应除 `id` 外还返回 `type` / `baseType` 与最终可见性字段。

### 响应

```json
{
  "ok": true,
  "id": "sub_xxxxxxxxxxxx",
  "type": "homework",
  "baseType": "homework",
  "hidden": false,
  "teacherOnly": false,
  "adminOnly": false,
  "invisible": false
}
```

---

## 4. `/api/all-submission`

查看当前班级的征集列表。学生视角只统计自己的提交；老师/管理员统计全班。

### 请求

```json
{
  "auth": "SC-STU-DEMO-2026",
  "match_mode": "All",
  "show-hiddens": false,
  "category": "每周汇报",
  "submissionID": null
}
```

- `match_mode` 可选，缺省 `All`。
- `submissionID`（也接受 `id` / `which`）按征集 ID 直接读取，返回单个元素的 `datas`；
  即使征集是隐藏 / 不显示也能读取（仍按角色校验：教师不能读取仅管理员征集）。
- 支持的匹配：`All`、`Random`、`StudentID`、`ShortStudentID`、`TitleReGex`（作用于征集名称）、`Before`（作用于截止时间）。`StudentID` / `ShortStudentID` 返回该学生提交过的征集。
- `show-hiddens`（也接受 `showHiddens` / `show_hiddens`）为 `true` 时，隐藏征集才会出现在列表中；
  不显示征集（`invisible`）即使打开该开关也不会出现。
- `category`（也接受 `tab`）按「单独列出」类别筛选，可传模式名或中文显示名称；
  结果为该类别及其所有子类别下的征集。

### 响应

```json
{
  "ok": true,
  "datas": [
    {
      "id": "sub_xxxxxxxxxxxx",
      "name": "函数与导数 · 周末练习",
      "desc": "完成练习册 P42–P45，拍照上传。",
      "deadLine": "2026-11-01T20:00:00+08:00",
      "type": "homework",
      "displayName": "作业",
      "typeDisplayName": "作业",
      "baseType": "homework",
      "hidden": false,
      "teacherOnly": false,
      "adminOnly": false,
      "invisible": false,
      "separateList": false,
      "abstract": false,
      "visibility": "normal",
      "inheritModes": ["homework"],
      "createdAt": "2026-10-20T10:00:00+08:00",
      "createdBy": "林书言",
      "createdByID": "auth_xxxxxxxxxxxx",
      "uploadCount": 2,
      "myUploadCount": 1,
      "pendingCount": 1,
      "latestUploadID": "up_xxxxxxxxxxxx"
    }
  ],
  "tabs": [
    {
      "id": "mode_xxxxxxxxxxxx",
      "name": "weekly report",
      "modeName": "weekly report",
      "displayName": "每周汇报",
      "normalized": "weekly report",
      "count": 2,
      "separateList": true
    }
  ],
  "separateLists": ["与 tabs 相同"],
  "showHiddens": false,
  "category": null
}
```

- 学生视角：`uploadCount` 与 `myUploadCount` 都表示本人提交次数；`pendingCount` 表示本人尚未收到回复的提交数。
- 老师/管理员视角：`uploadCount` 为全班提交数，`pendingCount` 为全班待回复数。
- `deadLine` 可能为 `null`。
- `baseType` 是征集的实际行为类型：内置模式与 `type` 相同；班级自定义模式返回它继承的基类
  （例如 `"type": "maths multiple-choise homework"`、`"baseType": "answer sheet"`）。
- `displayName` / `typeDisplayName` 是模式的显示名称（内置模式为中文 UI 文案，自定义模式取创建时的
  `displayName`），可直接用于列表标签。
- 可见性字段：`hidden`、`teacherOnly`、`adminOnly`、`invisible`、`separateList`、`abstract`；
  `visibility` 是 `normal` / `hidden` / `teacher_only` / `admin_only` / `invisible` 之一。
  列表结果已按当前 `auth` 的角色与 `show-hiddens` 过滤；按 ID 直接调用见 `/api/download`。
- `inheritModes` 是模式继承链（含自身，规范化名称），便于客户端做分类聚合。
- `tabs` 列出所有继承「单独列出征集」的具体类别（不包含抽象基类自身），每个标签页的 `count`
  是该类别及其子类别下当前可见的征集数；`displayName` 支持中文。
- `createdByID` 是发布者 auth ID，便于客户端判断「是不是我发布的」。
- 时间状态由页面根据 `deadLine` 计算，API 不再返回展示文案。
- 截至截止时间的 `notice` 公示版会排在普通征集之前；未设置截止时间的公示版同样置顶。

---

## 4.1 `/api/my-uploads`（个人所有提交）

查询**当前身份**（`auth`）在班级内的全部提交。学生 / 家长与老师 / 管理员都可以调用；返回范围始终是本人，不会返回其他成员的提交。

### 请求

```json
{
  "auth": "SC-STU-DEMO-2026",
  "submissionID": "sub_xxxxxxxxxxxx",
  "uploadID": "up_xxxxxxxxxxxx",
  "match_mode": "All",
  "limit": 500
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 班级密钥 |
| `submissionID` | string | — | 只看某个征集下的本人提交（也接受 `which`） |
| `uploadID` | string | — | 只看某一条提交（也接受 `id`） |
| `match_mode` | string / object | — | 与 `/api/download` 相同的 MatchMode，作用于提交标题 / 学号 / 时间 |
| `limit` | int | — | 默认 500，最大 2000 |

### 响应

```json
{
  "ok": true,
  "datas": [
    {
      "id": "up_xxxxxxxxxxxx",
      "submissionID": "sub_xxxxxxxxxxxx",
      "submissionName": "函数与导数 · 周末练习",
      "studentID": "G2603-01",
      "shortStudentID": 1,
      "title": "周末练习",
      "desc": "已完成",
      "data": [],
      "reply": ["整体完成得很好。"],
      "replyIDs": ["rep_xxxxxxxxxxxx"],
      "uploader": "陈小满",
      "role": "student",
      "createdAt": "2026-10-24T11:00:00+08:00",
      "submissionCreatedBy": "auth_xxxxxxxxxxxx",
      "submissionCreatedName": "林书言"
    }
  ]
}
```

兼容别名：`/api/my-upload`、`/api/all-my-uploads`、`/api/all-my-upload`。

---

## 4.2 `/api/my-submissions`（个人发布的所有征集）

查询当前身份发布的征集（`submissions.created_by = 当前 auth`）。学生 / 家长通常为空数组，老师 / 管理员用于「我发布的征集」视图。

### 请求

```json
{ "auth": "SC-TEA-DEMO-2026", "match_mode": "All", "limit": 500 }
```

`match_mode` 与 `/api/all-submission` 一致（作用于征集名称 / 截止时间等）。`limit` 默认 500，最大 2000。

### 响应

`datas` 的字段与 `/api/all-submission` 完全一致（含 `baseType`、`createdByID`、`uploadCount`、`myUploadCount`、`pendingCount`、`latestUploadID`），按发布时间倒序。

兼容别名：`/api/my-submission`、`/api/all-my-submissions`、`/api/all-my-submission`。

---

## 4.3 `/api/pending-uploads`（老师 / 管理员：待回复提交，个人发布优先）

老师 / 管理员前端「我发布的待回复提交」使用该接口。返回所有尚未回复的提交，**自己发布的征集中的提交排在最前**，其余按提交时间倒序。

### 请求

```json
{ "auth": "SC-TEA-DEMO-2026", "ownOnly": false, "limit": 100 }
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 老师 / 管理员密钥；学生返回 403 |
| `ownOnly` | bool | — | `true` 时只返回自己发布的征集中的待回复提交 |
| `limit` | int | — | 默认 100，最大 1000 |

### 响应

`datas` 字段与 `/api/my-uploads` 相同，并额外包含：

```json
{ "id": "up_xxxxxxxxxxxx", "mine": true, "submissionID": "sub_...", "submissionName": "..." }
```

`mine` 表示该提交所属征集是否由当前教师发布。Web 首页 / 提交列表与小程序首页都使用该顺序。

---

## 4.4 `/api/new-mode`（管理员：为班级新增征集模式）

### 请求（需求字段）

```json
{
  "auth": "SC-ADM-DEMO-2026",
  "modeName": "maths multiple-choise homework",
  "displayName": "数学选择题作业",
  "extendModes": ["homework", "answer sheet"],
  "abstract": false
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 管理员密钥 |
| `modeName` | string | ✅ | 模式名称，1–60 字，不能包含控制字符 |
| `displayName` | string | — | 显示名称（支持中文），最多 60 字；缺省使用 `modeName` |
| `extendModes` | string[] | — | 继承的内置模式或本班已有自定义模式，最多 16 项；**可见性也在这里定义** |
| `abstract` | bool | — | 抽象类别：不能直接发布，只能被继承（抽象属性不继承，是唯一需要显式声明的属性） |

> v0.1.11 起，可见性不再通过 `hidden` / `teacherOnly` / `adminOnly` / `invisible` /
> `separateList` 字段单独声明，而是把对应内置模式写入 `extendModes`。旧的可见性字段会被忽略。

`extendModes` 可继承：`homework`、`open call`、`leave request`、`survey`、`answer sheet`、`notice`、`other`，以及本班已经定义的自定义模式。行为基类按「答题卡 > 问卷 > 公示 > 作业 > 公开征集 > 请假 > 其他」的顺序确定。

可见性类别同样作为父模式写在 `extendModes` 中：

| 模式名 | 含义 |
| --- | --- |
| `hidden` | 隐藏征集 |
| `teacher only` | 仅教师征集 |
| `admin only` | 仅管理员征集 |
| `invisible` | 不显示征集 |
| `separate list` | 单独列出征集（抽象类别，只能继承） |

例如：

```json
{
  "auth": "SC-ADM-DEMO-2026",
  "modeName": "secret weekly report",
  "displayName": "秘密周报",
  "extendModes": ["homework", "hidden", "separate list"]
}
```

可见性属性会沿继承链向下传递；`abstract` 不传递。允许嵌套继承（`A -> B -> C`），
但任意两个父模式的继承链（含父模式自身）不能有交集，否则视为菱形继承并返回 `400`。

### 响应（成功）

```json
{
  "ok": true,
  "success": true,
  "id": "mode_xxxxxxxxxxxx",
  "modeName": "maths multiple-choise homework",
  "displayName": "数学选择题作业",
  "extendModes": ["homework", "answer sheet"],
  "baseType": "answer sheet",
  "hidden": false,
  "teacherOnly": false,
  "adminOnly": false,
  "invisible": false,
  "separateList": false,
  "abstract": false,
  "createdAt": "2026-11-01T20:00:00+08:00",
  "createdBy": "赵明远"
}
```

失败时返回 `{ "ok": false, "msg": "..." }`：重复模式、未知继承模式、菱形继承返回 `400`；非管理员返回 `403`。

发布时把 `modeName` 作为 `/api/new-submission` 的 `type`（也接受 `mode` / `modeName`）。服务端会解析该模式并按其 `baseType` 执行答题卡校验、问卷表单与公示版禁用提交等行为；`/api/all-submission` 的 `type` 保留自定义名称，`baseType` 给出实际行为。

---

## 4.5 `/api/all-modes`（班级可用征集模式）

```json
{ "auth": "SC-STU-DEMO-2026" }
```

```json
{
  "ok": true,
  "modes": [
    {
      "id": "builtin_homework",
      "name": "homework",
      "modeName": "homework",
      "displayName": "作业",
      "normalized": "homework",
      "baseType": "homework",
      "extendModes": [],
      "inheritModes": ["homework"],
      "builtin": true,
      "hidden": false,
      "teacherOnly": false,
      "adminOnly": false,
      "invisible": false,
      "separateList": false,
      "abstract": false,
      "visibility": "normal"
    },
    {
      "id": "builtin_separate_list",
      "name": "separate list",
      "modeName": "separate list",
      "displayName": "单独列出征集",
      "baseType": "other",
      "separateList": true,
      "abstract": true,
      "builtin": true
    },
    {
      "id": "mode_xxxxxxxxxxxx",
      "name": "maths multiple-choise homework",
      "modeName": "maths multiple-choise homework",
      "displayName": "数学选择题作业",
      "baseType": "answer sheet",
      "extendModes": ["homework", "answer sheet"],
      "inheritModes": ["maths multiple-choise homework", "homework", "answer sheet"],
      "builtin": false,
      "visibility": "normal"
    }
  ],
  "tabs": ["与 modes 中 separateList=true 且 abstract=false 的项相同"],
  "separateLists": ["与 tabs 相同"],
  "datas": ["与 modes 相同"]
}
```

兼容别名：`/api/class-modes`。Web 发布页、账号中心管理员区与小程序发布页均从这里读取可选模式 / 显示新增结果。

---

## 4.6 `/api/del-mode`（管理员：删除班级自定义征集模式）

删除本班通过 `/api/new-mode` 创建的模式。内置模式不能删除；删除只影响模式的复用与显示，
不会级联删除已经发布的征集。

### 请求

```json
{ "auth": "SC-ADM-DEMO-2026", "id": "mode_xxxxxxxxxxxx" }
```

也支持按模式名 / 显示名称删除：

```json
{ "auth": "SC-ADM-DEMO-2026", "modeName": "maths multiple-choise homework" }
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 管理员密钥 |
| `id` | string | — | 模式 ID（`mode_*`）；与 `modeName` 至少填一个 |
| `modeName` | string | — | 模式名称；也接受 `mode_name` / `name`，以及创建时填写的 `displayName` |
| `force` | bool | — | 仍有征集引用该模式时是否强制删除，默认 `false` |

### 响应（成功）

```json
{
  "ok": true,
  "success": true,
  "msg": "submission mode deleted",
  "id": "mode_xxxxxxxxxxxx",
  "modeName": "maths multiple-choise homework",
  "displayName": "数学选择题作业",
  "extendModes": ["homework", "answer sheet"],
  "baseType": "answer sheet",
  "flags": { "hidden": false, "teacherOnly": false, "adminOnly": false, "invisible": false, "separateList": false, "abstract": false },
  "deleted": { "id": "mode_xxxxxxxxxxxx", "modeName": "maths multiple-choise homework", "builtin": false, "inheritModes": ["..."] }
}
```

### 约束与错误

| 场景 | HTTP | msg |
| --- | --- | --- |
| 非管理员 | 403 | `only admins can delete submission modes` |
| 缺少 `id` 与 `modeName` | 400 | `id or modeName is required` |
| 删除内置模式 | 400 | `builtin submission modes cannot be deleted: ...` |
| 仍被其他模式继承 | 400 | `submission mode is inherited by other modes: ...` |
| 仍有征集引用且未传 `force` | 400 | `submission mode is still used by N submission(s); pass force=true to delete anyway` |
| 模式不存在或不属于当前班级 | 404 | `submission mode not found` |

- 删除前请先删除或改造继承该模式的子模式；继承链不会自动级联。
- `force:true` 删除后，已有征集仍保留 `type` 与 `baseType`，问卷 / 答题卡 / 公示行为不变；
  但这些征集不再继承被删模式的 `displayName` 与可见性属性。

---

## 5. `/api/reply`

回复一条提交（**老师 / 管理员**）。

### 请求

```json
{
  "auth": "SC-TEA-DEMO-2026",
  "uploadID": "up_xxxxxxxxxxxx",
  "content": "整体完成得很好，第 3 题注意链式法则。"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 老师/管理员密钥 |
| `uploadID` | string | ✅ | 提交 ID（也接受 `upload_id`） |
| `content` | string | ✅ | 回复内容，≤5000 字 |

### 响应

```json
{ "ok": true, "id": "rep_xxxxxxxxxxxx" }
```

---

## 6. `/api/new-class`

创建班级（**管理员**）。

### 请求

```json
{
  "auth": "SC-ADM-DEMO-2026",
  "name": "高一（4）班",
  "desc": "2026 级 · 新班级"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 管理员密钥 |
| `desc` | string | 与 `name` 至少一个 | 班级描述（原始需求字段） |
| `name` | string | 可选 | 班级名称（扩展字段）；缺省时从 `desc` 推导 |

### 响应

```json
{
  "ok": true,
  "id": "cls_xxxxxxxxxxxx",
  "code": "C3X9EZ",
  "auth": "SC-ADM-XXXXXXXX",
  "authID": "auth_xxxxxxxxxxxx"
}
```

创建成功时会自动签发一个绑定到当前用户账号（若已绑定）的管理员密钥，方便立即进入新班级。`id` 为需求要求的班级 ID，其余为扩展字段。

---

## 7. `/api/new-user`

在指定班级批量生成成员密钥（**管理员**）。

> 只能在自己当前 `auth` 所属班级内新增成员；跨班级请求返回 400。

### 请求

```json
{
  "auth": "SC-ADM-DEMO-2026",
  "classID": "cls_xxxxxxxxxxxx",
  "quantity": 3,
  "type": "Student"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 管理员密钥 |
| `classID` | string | ✅ | 班级 ID，必须与管理员当前班级一致 |
| `quantity` | int | ✅ | 1–100 |
| `type` | string | ✅ | `Student` / `Teacher` / `Admin`（大小写不敏感，也接受中文） |

### 响应

```json
{
  "ok": true,
  "IDs": ["auth_xxxxxxxxxxxx", "auth_yyyyyyyyyyyy"],
  "keys": ["SC-STU-XXXXXXXX", "SC-STU-YYYYYYYY"],
  "members": [
    {
      "id": "auth_xxxxxxxxxxxx",
      "key": "SC-STU-XXXXXXXX",
      "role": "student",
      "studentID": "C3X9EZ-01",
      "displayName": "学生 01"
    }
  ]
}
```

- 需求字段 `IDs` 为 auth 记录 ID。
- `keys` 是对应登录密钥；**密钥只在响应中出现一次**，请及时保存并分发。
- 新成员处于「未认领」状态：成员在 `/user` 注册账号并绑定密钥，或登录已有账号后添加密钥。

---

## 8. `/api/del-key`

删除当前使用的 auth 密钥（任意角色）。

### 请求

```json
{ "auth": "SC-STU-DEMO-2026" }
```

### 响应

```json
{ "ok": true, "msg": "key deleted" }
```

删除后该密钥立即失效，相关登录会话会在下一次请求时被清除；该 auth 的历史提交会保留（展示提交时的姓名/学号快照）。

---

## 9. `/api/rename-auth`（v0.1.1）

修改当前 auth（班级身份）的显示名称。任何持有有效 auth 密钥的角色都可以改名。

### 请求

```json
{
  "auth": "SC-TEA-DEMO-2026",
  "name": "林书言"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `auth` | string | ✅ | 要改名的 auth 密钥 |
| `name` | string | ✅ | 新显示名称；去除首尾空白后 1–40 个字符，不能包含控制字符 |

### 响应

```json
{
  "ok": true,
  "name": "林书言",
  "msg": "identity name updated"
}
```

失败时返回 `400`（名称为空 / 过长 / 含控制字符）或 `401`（密钥无效）。
改名会同步刷新该 auth 在 `uploads`、`replies`、`submissions` 中的历史显示名称快照，因此已存在的提交/回复/征集也会立即显示新名称。

```bash
curl -s http://localhost:3000/api/rename-auth \
  -H 'Content-Type: application/json' \
  -d '{"auth":"SC-TEA-DEMO-2026","name":"林老师"}'
```

## 10. `/api/del-object`

按对象 ID 删除（**管理员**）。这是原始需求中唯一没有 `auth` 字段的接口，因此也支持使用登录 cookie 鉴权。

### 请求（两种方式）

```json
{ "auth": "SC-ADM-DEMO-2026", "id": "sub_xxxxxxxxxxxx" }
```

```json
{ "id": "rep_xxxxxxxxxxxx" }
```

第二种方式需要浏览器已通过角色登录（携带 `sc_sid` cookie）。建议服务端调用时仍显式传 `auth`。

### 支持的对象

| 前缀 | 对象 | 说明 |
| --- | --- | --- |
| `sub_` | 征集 | 级联删除其提交与回复 |
| `up_` | 提交 | 级联删除其回复 |
| `rep_` | 回复 | 仅删除该回复 |
| `cls_` | 班级 | 仅能删除自己当前管理的班级，级联删除班级数据 |
| `auth_` | 身份密钥 | 仅能删除当前班级的 auth |
| `mode_` | 征集模式 | 删除班级自定义模式；与 `/api/del-mode` 相同，可传 `force` |

### 响应

```json
{ "ok": true, "msg": "deleted" }
```

失败示例：

```json
{ "ok": false, "msg": "you can only delete objects in the current class" }
```

---

## 11. `/api/health`

公开健康检查（扩展接口）。

```bash
curl http://localhost:3000/api/health
```

```json
{ "ok": true, "service": "smart-campus", "time": 1792814400 }
```

---

## 12. 用户登录（非对称挑战，v0.1.7）

v0.1.7 起，**用户名 + 密码不再发送给服务端**。浏览器用密钥派生函数从密码派生
X25519 私钥，注册 / 重置密码时只上传公钥；登录时服务端用公钥加密一个随机挑战，
客户端解密后回答。以下接口都是公开接口，不需要请求体中的 `auth`。

### 12.1 密钥派生约定

| 参数 | 值 |
| --- | --- |
| KDF | PBKDF2-HMAC-SHA256 |
| 迭代次数 | `210000` |
| 盐 | `smart-campus/auth/v1:` + 用户名小写（trim 后） |
| 输出长度 | 32 字节 |
| 私钥 | 上述 32 字节，作为 X25519 标量 |
| 公钥 | `X25519(private, basepoint)`，32 字节 |

`/api/login-try` 会在响应的 `kdf` 字段回显服务端实际使用的参数与盐，客户端应优先使用
该字段，以免用户名大小写导致派生结果不一致。

> 密码和私钥永远不离开客户端；服务端只保存 32 字节公钥（base64）。
> 旧账号的密码哈希只用于一次性的公钥迁移，迁移后会被清空。

### 12.2 `byte[]` 的 JSON 编码

响应中的 `challengeEncrypt`、`answerEncryptingKey` 使用**标准 base64** 字符串。
请求中的 `encryptedAnswer`、`newPasswordPubKey` 等字段既接受 base64 字符串，
也接受由 0–255 整数组成的 JSON 数组；推荐使用 base64。

### 12.3 `/api/register`

创建账号并可选绑定一个未认领的班级密钥。

```json
{
  "username": "alice",
  "passwordPubKey": "BASE64_X25519_PUBLIC_KEY",
  "key": "SC-STU-XXXXXXXX",
  "displayName": "Alice"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `username` | string | ✅ | 2–32 位，中英文 / 数字 / `_` / `-`，大小写不敏感 |
| `passwordPubKey` | byte[] | ✅ | 32 字节 X25519 公钥；也接受 `pubkey` / `publicKey` |
| `key` | string | — | 可选，绑定一个尚未被认领的 auth 密钥 |
| `displayName` | string | — | 显示名称，缺省为用户名 |

```json
{
  "ok": true,
  "id": 4,
  "userID": 4,
  "username": "alice",
  "displayName": "alice",
  "boundAuth": "SC-STU-XXXXXXXX"
}
```

失败：用户名已存在返回 `400`（`code: "username_taken"`），公钥格式错误返回 `400`。
注册只保存公钥，不接收密码；注册后请立即调用 `/api/login-try` + `/api/get-auths`
完成一次挑战验证。

### 12.4 `/api/login-try`

```json
{ "username": "student" }
```

响应（`ok: true`）：

```json
{
  "ok": true,
  "loginSessionID": "login_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "challengeEncrypt": "BASE64_92_BYTES",
  "answerEncryptingKey": "BASE64_32_BYTES",
  "expiresIn": 300,
  "username": "student",
  "displayName": "陈小满",
  "kdf": {
    "name": "PBKDF2-HMAC-SHA256",
    "iterations": 210000,
    "salt": "smart-campus/auth/v1:student",
    "privateKey": "X25519",
    "challengeEncryption": "X25519-HKDF-SHA256-AES-256-GCM",
    "answerEncryption": "AES-256-GCM"
  }
}
```

- `loginSessionID` 有效期 **300 秒**，内存保存，服务重启后失效。
- `challengeEncrypt` 是 ECIES 密文：`临时公钥(32) || nonce(12) || AES-GCM 密文与 tag`。
- `answerEncryptingKey` 是 32 字节一次性对称密钥，用于加密回答。
- 账号尚未设置公钥时返回 `401`，并带 `"code": "pubkey_missing"`；客户端可用
  `/api/upgrade-pubkey` 做一次旧密码迁移。

### 12.5 `/api/get-auths`

```json
{
  "loginSessionID": "login_XXXXXXXX",
  "encryptedAnswer": "BASE64_60_BYTES"
}
```

响应：

```json
{
  "ok": true,
  "auths": ["SC-STU-DEMO-2026"],
  "authIDs": ["auth_xxxxxxxxxxxx"],
  "members": [
    {
      "id": "auth_xxxxxxxxxxxx",
      "key": "SC-STU-DEMO-2026",
      "classID": "cls_xxxxxxxxxxxx",
      "className": "高一（3）班",
      "role": "student",
      "studentID": "G2603-01",
      "shortStudentID": 1,
      "displayName": "陈小满"
    }
  ],
  "user": { "id": 3, "username": "student", "displayName": "陈小满" }
}
```

- `auths` 是需求中的字段：该账号绑定的全部 auth **密钥**（可直接用于其他 API 的 `auth` 参数）。
- `authIDs` / `members` / `user` 是便于客户端使用的扩展字段。
- 验证成功会同时写入浏览器账号会话 cookie（`sc_uid`，HttpOnly、SameSite=Lax）；
  纯 API 客户端可以忽略 cookie，只使用 `auths`。
- 答案错误或会话过期返回 `401`。同一会话连续失败 5 次后作废。

### 12.6 `/api/refresh-key`（auth 泄漏处置）

通过账号挑战后轮换一个已绑定到该账号的 auth 密钥。新 auth 继承旧 auth 的班级、角色、
学号、短学号、显示名称与绑定用户，并把旧 auth 名下的征集、提交、回复与班级创建者引用
迁移到新 auth；随后删除旧 auth，旧密钥立即失效。

#### 请求

```json
{
  "loginSessionID": "login_XXXXXXXX",
  "encryptedAnswer": "BASE64_60_BYTES",
  "authRefreshing": "SC-STU-DEMO-2026"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `loginSessionID` | string | ✅ | `/api/login-try` 返回的挑战会话 |
| `encryptedAnswer` | byte[] | ✅ | 用 `answerEncryptingKey` 加密后的挑战回答（60 字节；base64 或整数数组） |
| `authRefreshing` | string | ✅ | 要轮换的旧 auth 密钥，必须已绑定到当前登录账号 |

#### 响应

```json
{ "ok": true, "newAuth": "SC-STU-XXXXXXXX" }
```

- `newAuth` 是新 auth 的密钥，请立即保存；旧密钥不能再用。
- 轮换后：
  - 新 auth 保留原 `classID` / `role` / `studentID` / `shortStudentID` / `displayName` 与创建时间；
  - 原 auth 创建的征集、提交、回复、班级创建者引用全部迁移到新 auth；
  - 旧 auth 记录被删除，绑在旧 auth 上的 `sc_sid` 角色会话与本次账号挑战会话立即失效；
  - 账号会话 `sc_uid` 不受影响，账号中心会列出新密钥。
- 错误：`400`（`authRefreshing` 为空）、`401`（挑战失败 / 会话过期 / 旧密钥无效；旧密钥无效时
  `code` 为 `"auth_invalid"`）、`403`（旧密钥属于其他账号，或尚未绑定账号）。
- 旧密钥未被认领（`user_id` 为空）时不能直接轮换；请先在 `/user` 登录并绑定该密钥。
- 轮换使用新随机密钥，不会复用旧值；旧密钥本身不能替代账号挑战，调用者必须能通过挑战验证。
- 账号中心 `/user` 已提供「轮换密钥」入口：输入当前密码后由浏览器完成挑战并调用本接口，成功后展示新密钥并刷新身份列表。

```bash
# encryptedAnswer 需由客户端按 12.9 的流程生成（可参考 scripts/auth-client.js）
curl -s http://localhost:3000/api/refresh-key \
  -H 'Content-Type: application/json' \
  -d '{
    "loginSessionID":"login_XXXXXXXX",
    "encryptedAnswer":"BASE64_60_BYTES",
    "authRefreshing":"SC-STU-DEMO-2026"
  }'
```

> 该接口用于密钥泄漏、成员转班/离职等场景。轮换后客户端应改用 `newAuth`；
> 旧的 `sc_sid` 会话已失效，需要重新进入身份或刷新登录状态。

### 12.7 `/api/reset-password`

验证挑战后替换公钥（即修改密码）。

```json
{
  "loginSessionID": "login_XXXXXXXX",
  "encryptedAnswer": "BASE64_60_BYTES",
  "newPasswordPubKey": "BASE64_NEW_X25519_PUBLIC_KEY"
}
```

```json
{ "ok": true, "msg": "password reset" }
```

- `newPasswordPubKey` 必须是用**新密码**派生的 32 字节 X25519 公钥。
- 成功后旧密码立即失效，该账号的所有旧登录会话与临时挑战会话都会作废；
  当前浏览器会收到一个新的 `sc_uid` cookie。
- 失败返回 `401`（挑战错误 / 会话过期）或 `400`（公钥格式错误）。

### 12.8 `/api/upgrade-pubkey`（旧账号迁移）

仅用于老数据库中没有公钥的账号。它仍然校验旧密码哈希，成功后清空旧哈希。

```json
{
  "username": "student",
  "password": "student123",
  "pubkey": "BASE64_X25519_PUBLIC_KEY"
}
```

```json
{ "ok": true, "msg": "public key upgraded", "username": "student" }
```

新账号不需要此接口；浏览器在 `/api/login-try` 返回 `pubkey_missing` 时会自动调用一次。

### 12.9 挑战与回答的加密细节

**服务端 → 客户端（挑战）**

1. 生成临时 X25519 密钥对 `(eph_sk, eph_pk)`。
2. `shared = X25519(eph_sk, user_pk)`。
3. `key = HKDF-SHA256(ikm=shared, salt=空, info="smart-campus/challenge/v1")`。
4. `nonce` = 12 字节随机数；`AES-256-GCM(key, nonce, challenge, aad=空)`。
5. `challengeEncrypt = eph_pk(32) || nonce(12) || ciphertext(32) || tag(16)`（92 字节）。

**客户端 → 服务端（回答）**

1. 客户端用私钥与 `eph_pk` 做 X25519，按相同 HKDF / AES-GCM 规则解密，得到 32 字节挑战。
2. `nonce` = 12 字节随机数；用 `answerEncryptingKey` 做 AES-256-GCM 加密挑战。
3. `encryptedAnswer = nonce(12) || ciphertext(32) || tag(16)`（60 字节）。

服务端解密后与原始挑战做常数时间比较。`answerEncryptingKey` 虽然随响应下发，但
攻击者没有用户私钥就无法解开挑战，因此无法伪造回答；生产环境仍应使用 HTTPS。

> 挑战密文可以被攻击者离线用于猜测密码（PBKDF2 + X25519 + AES-GCM），因此用户应使用
> 强密码；服务端使用 210,000 次 PBKDF2 迭代来提高离线破解成本。登录挑战 300 秒过期，
> 同一挑战连续失败 5 次即作废。

### 12.10 浏览器与命令行客户端

- 浏览器：`/static/auth.js`（源码 `src/assets/auth.js`）实现 KDF、X25519、HKDF、
  AES-GCM，并自动接管 `/login/account` 的登录 / 注册表单与 `/user` 的改密表单。
- 命令行 / 测试：`scripts/auth-client.js` 复用同一份密码学实现。

```bash
BASE=http://127.0.0.1:3000
node scripts/auth-client.js login --base "$BASE" --username student --password student123
# -> {"ok":true,"auths":["SC-STU-DEMO-2026"],...,"cookie":"sc_uid=..."}

node scripts/auth-client.js register --base "$BASE" --username alice --password pass1234 --key SC-STU-XXXXXXXX
node scripts/auth-client.js reset --base "$BASE" --username alice --old-password pass1234 --new-password pass5678
```

---

## 13. `/multi-api`（批量调用）

在一个 HTTP 请求中按数组顺序调用多个内部 API。子请求各自使用自己的 `auth`，因此同一批次可以混合学生 / 老师 / 管理员身份，权限仍按各自身份分别校验。

兼容别名：`/api/multi-api` 与 `/multi-api` 等价；但作为子请求路径时仍被禁止。

### 请求

```json
{
  "apis": [
    { "api": "/api/health" },
    { "api": "/api/all-submission", "data": { "auth": "SC-STU-DEMO-2026" } },
    { "path": "/api/upload", "body": { "auth": "SC-STU-DEMO-2026", "which": "sub_x", "title": "t" } },
    { "api": "/api/rename-auth", "auth": "SC-TEA-DEMO-2026", "name": "林老师" }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `apis` | array | ✅ | 子请求数组，最多 100 项 |
| `apis[].api` | string | ✅ | 内部 API 路径；也接受 `path` / `endpoint` / `url` / `route` / `uri` |
| `apis[].body` | object | — | 子请求 JSON 体；也接受 `params` / `request` / `payload` / `json` |
| `apis[].data` | object | — | 作为子请求体的简便写法；仅当它是对象时生效 |

路径与请求体的兼容写法：

- 路径可写 `/api/upload`、`api/upload` 或 `upload`，服务端会规范化为 `/api/upload`；query / fragment 会被忽略。
- 可以直接内联字段：`{"api": "/api/rename-auth", "auth": "...", "name": "..."}`
  会把除路径字段外的字段作为子请求体。
- 本次新增的 `/api/my-uploads`、`/api/my-submissions`、`/api/pending-uploads`、
  `/api/new-mode`、`/api/all-modes`、`/api/del-mode` 都可以作为子请求；它们不在禁止列表中。
- 单个子请求也可以写成字符串 `"/api/health"`，或数组 `["/api/health", {}]`。
- `data` 作为包装体时必须是对象；上传接口的附件数组请用内联 `data`（数组）或显式 `body`。

### 响应

```json
{
  "ok": true,
  "results": [
    { "ok": true, "service": "smart-campus", "time": 1792814400 },
    { "ok": true, "datas": [ ... ] },
    { "ok": false, "code": "api_not_allowed", "msg": "api is not allowed in multi-api: /api/login-try" }
  ]
}
```

- `results` 的长度与 `apis` 严格一致，索引一一对应。
- 每个 `results[i]` 都有自己的 `ok`：成功时通常是该 API 的原始响应 JSON；失败时 `ok:false`，带 `msg`，可能带 `code`。
- 顶层 `ok:true` 只表示批量请求已被处理；即使部分子请求失败，HTTP 状态仍为 `200`，请逐项检查 `results[i].ok`。
- 顶层请求格式错误（缺少 `apis` / 不是数组）返回 `422`；超过 100 项返回 `400`。

### 禁止调用的接口

为避免一次性挑战、会话状态和 cookie 回传问题，以下接口不能出现在 `apis` 中，命中时返回
`ok:false` 且 `code:"api_not_allowed"`：

- `/api/login-try`
- `/api/get-auths`
- `/api/reset-password`
- `/api/refresh-key`
- `/api/multi-api`（禁止嵌套；`/multi-api` 作为路径也会被拒绝）

### 执行顺序与副作用

- 子请求按数组顺序串行执行；前面子请求的写操作对后面的子请求可见。
- 子请求的 `Set-Cookie` 不会回传给客户端；需要建立浏览器会话的接口请直接调用。
- `del-object` 在子请求中仍可使用 `/multi-api` 请求本身携带的 `sc_sid` cookie（当子请求未传 `auth` 时）。
- 每个子请求都是普通 API 调用：该失败的失败、该写库的写库，不会因为同批次其他项失败而回滚。

### 示例

```bash
curl -s http://localhost:3000/multi-api \
  -H 'Content-Type: application/json' \
  -d '{
    "apis": [
      {"api": "/api/health"},
      {"api": "/api/all-submission", "data": {"auth": "SC-STU-DEMO-2026"}},
      {"api": "/api/rename-auth", "auth": "SC-TEA-DEMO-2026", "name": "林老师"},
      {"api": "/api/login-try", "username": "student"},
      {"path": "/api/not-real"}
    ]
  }'
```

---

## 14. curl 全流程示例

```bash
BASE=http://localhost:3000

# 1. 老师发布征集
SUB=$(curl -s $BASE/api/new-submission \
  -H 'Content-Type: application/json' \
  -d '{"auth":"SC-TEA-DEMO-2026","name":"API 示例征集","desc":"示例","type":"homework","deadLine":"2026-12-31T20:00"}' \
  | jq -r .id)

# 2. 学生上传
UP=$(curl -s $BASE/api/upload \
  -H 'Content-Type: application/json' \
  -d "{\"auth\":\"SC-STU-DEMO-2026\",\"which\":\"$SUB\",\"title\":\"我的提交\",\"desc\":\"已完成\",\"data\":[{\"name\":\"hello.txt\",\"mime\":\"text/plain\",\"data\":\"aGVsbG8=\"}]}" \
  | jq -r .id)

# 3. 老师回复
curl -s $BASE/api/reply \
  -H 'Content-Type: application/json' \
  -d "{\"auth\":\"SC-TEA-DEMO-2026\",\"uploadID\":\"$UP\",\"content\":\"收到，做得不错。\"}"

# 4. 老师按标题正则下载
curl -s $BASE/api/download \
  -H 'Content-Type: application/json' \
  -d "{\"auth\":\"SC-TEA-DEMO-2026\",\"which\":\"$SUB\",\"match_mode\":{\"TitleReGex\":\"提交\"}}" | jq .

# 5. 学生查看本人视角的征集
curl -s $BASE/api/all-submission \
  -H 'Content-Type: application/json' \
  -d '{"auth":"SC-STU-DEMO-2026"}' | jq .

# 6. 管理员删除征集
curl -s $BASE/api/del-object \
  -H 'Content-Type: application/json' \
  -d "{\"auth\":\"SC-ADM-DEMO-2026\",\"id\":\"$SUB\"}"

# 7. 管理员删除自定义征集模式（未被继承且未被引用时）
curl -s $BASE/api/del-mode \
  -H 'Content-Type: application/json' \
  -d '{"auth":"SC-ADM-DEMO-2026","modeName":"maths multiple-choise homework"}'
```

问卷与答题卡征集（`type: "survey"` / `"answer sheet"`）的提交见 [1.1 问卷模式](#11-问卷模式survey)
与 [1.2 答题卡模式](#12-答题卡模式answer-sheet)。

---

## 15. 页面使用的接口

页面本身由服务端渲染，首页、提交、回复、上传、删除、账号中心等交互按需调用上述 API；账号中心的密码、偏好、身份绑定、创建班级使用同源表单 POST（`/user/*`），避免在浏览器中暴露密码到 JSON 请求。上传页在浏览器内使用 `FileReader` 将文件转换为 base64 后调用 `/api/upload`。

征集类型管理页（Web `/home/<mob|pc>/admin/modes/`，小程序 `pages/modemanage/modemanage`）
通过 `/api/all-modes` 读取列表、`/api/new-mode` 新增、`/api/del-mode` 删除；删除仍被征集的类型时，
前端在二次确认后带 `force: true` 重试。
