# 智慧校园 · Campus OS

一个面向班级的智慧校园 Web 服务：**征集发布 → 学生提交（含附件）→ 老师/管理员回复**，并提供班级、成员密钥与多身份账号管理。原生 HTML / CSS / JavaScript 前端，无 CDN、无前端构建步骤，支持手机版与电脑版布局。

- 技术栈：Rust 2021 · Axum 0.8 · rusqlite（SQLite，bundled）· serde · sha2 · ring（X25519 / HKDF / AES-GCM）· regex · pulldown-cmark
- 数据库：SQLite，首次启动自动建表并写入演示数据
- 需求来源：[`doc/requirements.md`](doc/requirements.md)
- 完整 API 文档：[`doc/api.md`](doc/api.md)
- 当前版本：**v0.1.12**

---

## 1. 快速开始

环境要求：Rust 1.80+；运行 `scripts/smoke.sh` 需要 Node.js 22+。

```bash
cargo run
# 打开 http://localhost:3000
```

首次启动会在当前目录创建 `smartcampus.db` 并写入演示班级、征集、提交和回复；同时读取 `strings/*.txt`、同步到 `strings.db`，并在 `./log/` 写入运行日志。删除 `smartcampus.db` 即可重新生成演示数据。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SC_DB` | `smartcampus.db` | SQLite 数据库路径 |
| `SC_PORT` | `3000` | 监听端口（用于日志中的地址展示） |
| `SC_BIND` | `0.0.0.0:<SC_PORT>` | 完整监听地址，例如 `127.0.0.1:3000` |
| `SC_STRINGS_DIR` | `strings` | UI 字符串目录，启动时读取其中的 `*.txt` |
| `SC_STRINGS_DB` | `strings.db` | 字符串同步数据库 |
| `SC_LANG` | `zh-CN` | 运行时选择的语言（对应 `strings/<lang>.txt`） |
| `SC_TLS_CERT` | — | PEM 证书链路径；与 `SC_TLS_KEY` 同时设置时启用 HTTPS |
| `SC_TLS_KEY` | — | PEM 私钥路径；与 `SC_TLS_CERT` 同时设置时启用 HTTPS |
| `SC_LOG_DIR` | `log` | 日志目录；不存在时自动创建 |
| `SC_LOG_LEVEL` | `info` | 日志级别：`off` / `error` / `warn` / `info` / `debug` |

```bash
SC_DB=./campus.db SC_BIND=127.0.0.1:8080 cargo run
```

### 日志

- 默认写入 `./log/app-YYYY-MM-DD.log`，每天自动切换；启动时自动创建 `log/`。
- 记录：启动信息、HTTP 方法 / 路径 / 状态码 / 耗时、4xx（WARN）、5xx（ERROR）、panic、账号中心操作错误。
- **不记录**：请求体、密码、班级密钥、cookie、`encryptedAnswer`、附件内容。
- 静态资源、favicon 与成功的 `/api/health` 只在 `debug` 级别记录；日志写入失败不影响服务。
- 日志按天追加，不自动删除历史文件；生产环境请配置清理策略并限制目录权限。

### 启用 HTTPS（TLS）

服务内置 Rustls 支持。使用受信任证书（Let's Encrypt 或公司 CA 签发的 PEM 证书链）启动：

```bash
SC_BIND=0.0.0.0:3443 \
SC_TLS_CERT=/etc/ssl/campus/fullchain.pem \
SC_TLS_KEY=/etc/ssl/campus/privkey.pem \
cargo run
# 打开 https://localhost:3443
```

本地开发可生成自签名证书（浏览器会提示不受信任，可手动信任）：

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

SC_TLS_CERT=certs/cert.pem SC_TLS_KEY=certs/key.pem cargo run
# 打开 https://localhost:3000
```

`SC_TLS_CERT` 和 `SC_TLS_KEY` 必须同时配置；都不配置时保持 HTTP 模式。生产环境更推荐由 Nginx/Caddy 终止 TLS 并转发到本服务的 HTTP 端口，同时确保私钥文件仅服务账号可读。证书路径相对于启动目录解析。

### 演示账号与密钥

| 身份 | 角色密钥 | 绑定账号 | 说明 |
| --- | --- | --- | --- |
| 家长 | `SC-STU-DEMO-2026` | `student` / `student123` | 家长使用孩子的学生密钥登录 |
| 学生 | `SC-STU-DEMO-2026` | `student` / `student123` | 高一（3）班 · 陈小满 |
| 老师 | `SC-TEA-DEMO-2026` | `teacher` / `teacher123` | 高一（3）班 · 林书言 |
| 管理员 | `SC-ADM-DEMO-2026` | `admin` / `admin123` | 高一（3）班 · 赵明远 |
| 管理员（第二班级） | `SC-ADM-DEMO-2027` | `admin` / `admin123` | 高二（1）班，可在账号中心切换 |
| 未认领学生 | `SC-STU-DEMO-2026-02`、`SC-STU-DEMO-2026-03` | — | 可在账号中心绑定 |
| 未认领老师 | `SC-TEA-DEMO-2027` | — | 高二（1）班 |
| 未认领学生 | `SC-STU-DEMO-2027` | — | 高二（1）班 |

> **Auth 模型**：一个 `auth`（班级密钥）只属于一个班级、拥有一个角色；一个 `user` 可以绑定多个 `auth`。切换班级 = 切换身份 = 切换密钥。家长没有独立角色，使用孩子的学生密钥以「家长模式」登录。

登录方式：

- `/login` 统一跳转到 `/login/account`；
- `/login/account`：用户名 + 密码。密码**不会发送到服务器**：浏览器用 PBKDF2 派生 X25519 私钥，只把公钥上传；登录时解密服务端下发的随机挑战。首次使用可直接注册并绑定班级密钥；
- `/user`：账号中心。登录后可「进入」任一已绑定身份（创建 `sc_sid` 角色会话），也可以绑定新密钥；
- 角色密钥（`SC-...`）仍然用于 `/api/*` 的 `auth` 参数；没有账号时需先注册并绑定密钥。
- 演示账号：`student` / `student123`、`teacher` / `teacher123`、`admin` / `admin123`。

---

## 2. 页面路由

所有 `/home/*` 页面均以「班级 + 身份」为上下文，路径中的 `*` 对应 `mob` 或 `pc` 视图。

| 路径 | 说明 |
| --- | --- |
| `/` | 已登录 → `/home`；否则 → `/login` |
| `/login` | `303` 跳转到 `/login/account` |
| `/login/account` | 账号登录 / 注册页（非对称挑战）；已有账号会话时跳转 `/user` |
| `/home` | 跳转到当前身份的空间 |
| `/home/<mob\|pc>/<parent\|student\|teacher\|admin>/` | 首页（最近征集、最近/待回复提交、账号入口） |
| `…/submissions/` | 所有征集；老师/管理员可发布；头部含「单独列出」标签页与「显示隐藏」开关（`?show-hiddens=1`、`?tab=<模式名>`） |
| `…/submissions/new` | 发布征集（老师/管理员） |
| `…/modes/` | 征集类型管理：管理员查看 / 新增 / 删除本班自定义类型 |
| `…/uploads/` | 学生：自己的提交；老师/管理员：全班提交，可筛选待回复/已回复 |
| `…/submission/<id>/` | 有提交则跳转最后一条本站提交，否则跳上传表单；公示版（notice）跳转详情页 |
| `…/submission/<id>/upload` | 上传表单（支持多附件、拖拽、预览）；公示版禁用并跳转详情页；问卷/答题卡改为填写简介里的题目 |
| `…/submission/<id>/all` | 该征集下的提交（学生仅自己，老师/管理员全班）；公示版仅渲染详情；问卷/答题卡渲染可填写的表单 |
| `…/upload/<id>/` | 提交详情：附件预览、回复列表、重新上传、管理员删除 |
| `/user` | 账号中心：偏好设置、密码、绑定/删除/轮换身份、创建班级、生成成员密钥；未登录 → `/login/account` |
| `/docs` | 文档与相关：展示仓库根目录 `README.md`（Web 渲染 Markdown；未登录也可访问） |
| `/logout` | POST，退出登录 |

兼容说明：

- 路径同时接受带/不带末尾 `/` 的形式；`/home/*/teachers` 也会被识别为老师空间。
- 页面内部使用带末尾 `/` 的规范 URL，因此相对路径 `./submissions` 等同样可用。
- 登录后 URL 中的 `mob` / `pc` 决定界面形态；账号偏好里的「默认视图」用于账号中心与后续进入。

---

## 3. API

所有接口为 `POST`，请求与响应均为 JSON（`Content-Type: application/json`）。角色密钥通过请求体的 `auth` 字段传递；`/api/del-object` 可按需求只传 `id`，此时回退使用登录 cookie 鉴权。`/multi-api` 可在一个请求中顺序调用多个内部 API（子请求各自携带 `auth`）。

> **语言约定**：API 字段、错误与 `msg` 使用英文；页面 UI 文案全部来自 `strings/zh-CN.txt`。

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `/api/upload` | 任意身份 | 上传提交（标题、说明、base64 附件）；公示版（notice）返回 403 |
| `/api/download` | 老师 / 管理员 | 按条件下载/查看某征集的提交与回复 |
| `/api/new-submission` | 老师 / 管理员 | 发布征集 |
| `/api/all-submission` | 任意身份 | 学生：本人视角；老师/管理员：全班视角；支持 `show-hiddens` / `category`，返回 `tabs` 与模式 `displayName` |
| `/api/my-uploads` | 任意身份 | 查询当前身份的全部提交（可按征集 / 提交 ID 过滤） |
| `/api/my-submissions` | 任意身份 | 查询当前身份发布的所有征集 |
| `/api/pending-uploads` | 老师 / 管理员 | 待回复提交，自己发布的征集优先（`ownOnly` 可只看自己的） |
| `/api/new-mode` | 管理员 | 为班级新增自定义征集模式（继承 + 显示名称；可见性通过 `extendModes` 定义；拒绝菱形继承） |
| `/api/all-modes` | 任意身份 | 列出班级可用的征集模式（内置 + 自定义，含 `displayName` / 可见性 / 单独列出） |
| `/api/del-mode` | 管理员 | 删除班级自定义征集模式（按 `id` / `modeName` / 显示名；内置或被继承时拒绝，仍被引用需 `force`） |
| `/api/reply` | 老师 / 管理员 | 回复一条提交 |
| `/api/new-class` | 管理员 | 创建班级（自动生成一个绑定到当前用户的管理员密钥） |
| `/api/new-user` | 管理员 | 在本班批量生成成员密钥 |
| `/api/del-key` | 任意身份 | 删除当前 `auth` 密钥 |
| `/api/rename-auth` | 任意身份 | 修改当前 `auth` 的显示名称 |
| `/api/del-object` | 管理员 | 按 id 删除征集 / 提交 / 回复 / 班级 / auth / 征集模式 |
| `/api/health` | 公开 | 健康检查 |
| `/api/docs` | 公开 | 返回仓库根目录 `README.md` 原文（`title` / `fileName` / `content` / `format`），供小程序按纯文本展示 |
| `/api/register` | 公开 | 提交用户名 + X25519 公钥创建账号（可选绑定密钥） |
| `/api/login-try` | 公开 | 返回挑战密文与回答加密密钥 |
| `/api/get-auths` | 公开（需登录会话） | 验证挑战后返回该账号的全部 auth 密钥 |
| `/api/refresh-key` | 公开（需登录会话） | 验证挑战后轮换 auth 密钥：新密钥继承全部数据，旧密钥立即删除 |
| `/api/reset-password` | 公开（需登录会话） | 验证挑战后替换公钥（修改密码） |
| `/api/upgrade-pubkey` | 公开 | 旧账号一次性迁移：校验旧密码哈希并写入公钥 |
| `/multi-api` | 公开（子请求各自鉴权） | 批量调用多个内部 API，`results` 与 `apis` 索引严格对应；禁止两次确认接口 |

详细字段、匹配模式、示例与错误码见 **[`doc/api.md`](doc/api.md)**。

---

## 4. 数据模型与关键设计

### 4.1 user 与 auth

```
users  1 ─── n  auths  n ─── 1  classes
                 │
                 ├─ submissions (created_by)
                 ├─ uploads     (auth_id / student_id / short_id)
                 └─ replies     (auth_id)
```

- `users`：用户名、公开的 X25519 公钥（`pubkey`）、显示名称、偏好设置；密码本身不落库。旧数据库的 `salt` / `pwhash` 仅用于一次性公钥迁移。
- `classes`：班级名称、简介、班级代码。
- `auths`：班级密钥（`key`）、所属班级、绑定用户、角色（student / teacher / admin）、学生学号与短学号、显示名称（可通过 `/api/rename-auth` 修改）。
- `submissions`：班级征集，含类型、说明、截止时间。类型为 `notice` 的公示版仅展示详情、不开放提交；未到截止时间的公示版会置顶。
- `uploads`：提交，含附件 JSON、提交人身份快照（姓名、学号、角色）。
- `replies`：老师/管理员回复，按时间排序。
- 删除班级会级联删除该班级的 auth、征集、提交、回复与自定义模式；删除 auth 不会删除历史提交（保留提交人快照）。删除征集/提交会级联删除其下提交/回复。删除自定义模式不会级联删除征集。
- 身份改名会同步刷新该 auth 在历史提交、回复与征集中的显示名称快照。
- `/api/refresh-key` 会先把旧 auth 的征集 / 提交 / 回复引用迁移到新 auth，再删除旧记录；历史展示快照保持不变。

### 4.2 权限矩阵

| 能力 | 学生 | 家长 | 老师 | 管理员 |
| --- | --- | --- | --- | --- |
| 查看班级征集 | ✅ | ✅ | ✅ | ✅ |
| 上传 / 重新上传 | ✅ | ✅ | ✅ | ✅ |
| 查看全班提交 | ❌（仅自己） | ❌（仅孩子） | ✅ | ✅ |
| 发布征集 | ❌ | ❌ | ✅ | ✅ |
| 回复提交 | ❌ | ❌ | ✅ | ✅ |
| 删除回复 / 提交 / 征集 | ❌ | ❌ | ❌ | ✅ |
| 新增 / 删除征集模式 | ❌ | ❌ | ❌ | ✅ |
| 创建班级 / 生成成员密钥 | ❌ | ❌ | ❌ | ✅ |
| 删除当前密钥 | ✅ | ✅ | ✅ | ✅ |
| 轮换自身 auth 密钥（需账号挑战） | ✅ | ✅ | ✅ | ✅ |
| 修改自身 auth 名称 | ✅ | ✅ | ✅ | ✅ |

学生/家长的直接访问也做服务端校验：即使手动拼出其他同学的 `/upload/<id>/` 地址也返回 404。

> **学生 / 家长只是前台视角**：家长使用孩子的学生 `auth`，二者数据范围完全相同，区别只在页面文案。服务端只按 `auth.role`（student / teacher / admin）判权限，视角只影响 `page_role` 与展示；`/api/*` 中没有「家长」概念。

### 4.3 登录与会话（非对称）

- 账号登录流程：客户端用 PBKDF2-HMAC-SHA256（210,000 次，盐为 `smart-campus/auth/v1:` + 小写用户名）从密码派生 32 字节 X25519 私钥 → 公钥在注册 / 改密时上传。登录时 `/api/login-try` 用公钥加密随机挑战，客户端解密后用一次性对称密钥加密回答；`/api/get-auths` 验证通过后返回该账号的全部 auth 密钥，并写入 `sc_uid` 会话。
- 密码和私钥不会发送到服务端；服务端只保存公钥。旧数据库中的 `pwhash` 仅用于 `/api/upgrade-pubkey` 的一次性迁移，迁移成功或重置密码后会清空。
- **auth 泄漏处置**：`/api/refresh-key` 在完成账号挑战后，用旧 `auth` 换一个新密钥。新 auth 继承旧 auth 的班级、角色、学号、显示名称与全部历史数据；旧 auth 立即删除，绑在旧 auth 上的角色会话同步失效。
- 账号中心每个身份右侧提供「轮换密钥」按钮：弹窗内输入当前密码，完成挑战后展示新密钥并提供复制。
- `sc_uid`（HttpOnly、SameSite=Lax、7 天）是 `/user` 与账号相关操作的唯一用户来源；`sc_sid`（同样 HttpOnly）代表班级空间身份，保存 `auth_id / 页面角色 / 视图模式`。
- 未登录访问 `/user` 会 `303` 跳转到 `/login/account`；仅持有角色 `sc_sid` 时同样不会进入账号中心。
- 两个会话可以同时存在且互不覆盖：`/user` 始终显示 `sc_uid` 对应的账号。
- 登录挑战会话保存在内存，5 分钟有效；同一会话连续 5 次回答错误后作废。
- 会话保存在内存中：**重启服务后需要重新登录**，但业务数据全部持久化在 SQLite。

### 4.4 附件格式

`data` 为数组（最多 8 个、总计约 18MB 原始数据），推荐元素格式：

```json
{
  "name": "作业第1页.png",
  "mime": "image/png",
  "data": "iVBORw0KGgoAAAANSUhEUg..."
}
```

同时兼容：

- `"data:image/png;base64,..."` data URL 字符串；
- 裸 base64 字符串（会包装为 `application/octet-stream`）。

图片在详情页内联预览（灯箱放大），其他类型提供下载。MIME 与 base64 会在写入前校验，避免在页面中注入非 data URL 内容。附件内容存储在 SQLite 中，适合演示/小规模班级；生产环境建议改为对象存储。

### 4.5 时间

- 所有页面与 API 时间统一使用 **北京时间（UTC+8）** 展示。
- 输入接受 `2026-11-01T20:00`、`2026-11-01 20:00:00`、`2026-11-01`、带 `Z` / `+08:00` 的 ISO 时间或 Unix 时间戳。
- API 返回 `deadLine` / `createdAt` 为带 `+08:00` 的 ISO-8601 字符串。
- 截止时间用于展示和 `Before` 匹配；**到截止后仍允许补交**，页面会提示「已截止」。

### 4.6 MatchMode

`/api/download` 与 `/api/all-submission` 的 `match_mode` 支持：

```json
"All"
{ "Random": 3 }
{ "StudentID": "G2603-01" }
{ "ShortStudentID": 1 }
{ "TitleReGex": "^函数" }
{ "Before": "2026-11-01T20:00" }
```

也支持显式对象写法 `{"type":"Random","quantity":3}`，`Before` 接受 ISO 时间或 `7d`/`12h`/`30m` 相对时长。`TitleReGex` 对上传标题（`/api/download`）或征集名称（`/api/all-submission`）做正则匹配；`Before` 对提交时间或截止时间做过滤。

### 4.7 本地化字符串

所有页面 UI 文案集中在 [`strings/zh-CN.txt`](strings/zh-CN.txt)，格式为：

```txt
title:
智慧校园
common_done:
完成
```

- 每个条目由两行组成：第一行是 `key:`，第二行是该 key 的内容；内容行原样保留；空行与 `#` 注释可以出现在条目之间。
- 修改文案后运行 `python3 scripts/mp_strings.py`：按 key A-Z 排序并重新生成 [`miniprogram/utils/strings.js`](miniprogram/utils/strings.js)；`--check` 只校验、不写文件。
- 启动时读取 `strings/` 下所有 `*.txt`，与 `strings.db` 比较并同步。
- 页面 HTML 支持 `@[strings/key]` 标签，渲染完成后自动替换；缺失 key 会保留原标签。
- 动态文案使用 `{}` 占位符：Rust 用 `strings::t("key")` / `f1` / `f2`；前端用 `S("key", arg, ...)`。
- 需要新语言时增加 `strings/en-US.txt`，并用 `SC_LANG=en-US` 启动（缺失 key 回退 `zh-CN`）。

API 不使用该字符串库：API 的错误与成功消息统一为英文。

### 4.8 数据库访问边界

- `src/db.rs` 是业务数据库的唯一访问层：**所有 SQL、事务、连接生命周期、行映射**都在这里；`db::Database` 封装 `Mutex<Connection>`，页面/API/工具层只调用 `db::*` 函数。
- `src/schema.sql` 只包含建表 DDL，由 `db.rs` 通过 `include_str!` 加载；查询、写入、事务不会出现在其他模块。
- `src/strings.rs` 独立负责 `strings.db` 的建表、同步与读取。
- 可用下面的命令验证没有数据库逻辑泄漏：

```bash
grep -RInE 'query_row|query_map|\.prepare\(|params!|rusqlite' src \
  --include='*.rs' | grep -v 'src/db.rs' | grep -v 'src/strings.rs'
# 期望：无输出
```

### 4.9 问卷模式

征集类型为 `survey`（「问卷」）时，简介不再是纯文本，而是问卷定义：

```text
姓名：<input id="form_name" required/>

想参加的社团：<checkbox id="form_club" value="math"/>数学社 <checkbox id="form_club" value="art"/>美术社
接收通知：<switch id="form_notify"/>
备注：<input id="form_note" placeholder="写点什么"/>
```

- 允许的标签只有 `input`、`checkbox`、`switch`；**`id` 必填且必须以 `form_` 开头**，`required` 可选；`input` 还支持 `type`（`text`/`number`/`email`/`tel`/`url`/`date`/`time`）、`placeholder`、`value`，`checkbox` 支持 `value`。不合法或未知标签会按普通文本转义显示。
- 题目标签自动从简介文字推断：`input` 取前文，`checkbox` / `switch` 取后文，多选组的组标题取组前文本。
- 同一 `id` 的多个 `checkbox` 视为多选组（DOM id 依次为 `form_x`、`form_x__2`…，答案键仍是 `form_x`）。
- 问卷模式下不再显示标题/说明/附件表单，简介被渲染成可填写控件，末尾是一个「提交问卷」按钮；`/submission/<id>/all` 详情页同样可以就地填写。
- 提交按钮把答案打包成 `{控件 id: 值}` 的 JSON 字符串，以 `title: "bot-upload"` 调用 `/api/upload`（`desc` 即该 JSON），随后跳转到提交详情页。
- 答案的值约定：`input` → 输入内容；`switch` → `on` / `off`；`checkbox` → 勾选时为 `value`（缺省 `on`），未勾选为空字符串，多选组以 `,` 连接。服务端在 `desc` 可解析为 JSON 对象时校验 `required` 控件，缺少必填项返回 `400`；非 JSON 的说明文本仍可直接通过 API 提交。
- 提交详情页会把 JSON 答案按简介顺序渲染成「题目 / 回答」列表，`/api/download` 返回的 `desc` 仍是原始 JSON 字符串。

### 4.10 答题卡模式（问卷派生）

征集类型为 `answer sheet`（「答题卡」）时，控件在 `id` 之外**必须**再写 `data-answer` 与 `data-score`：

```text
1 + 1 = <input id="form_q1" data-answer="2" data-score="5"/>
选出正确答案：<checkbox id="form_q2" value="a" data-answer="b" data-score="3"/>A <checkbox id="form_q2" value="b"/>B
地球是圆的：<switch id="form_q3" data-answer="on" data-score="2"/>
```

- **所有项目都必填**：渲染时统一加 `required`（多选组用 `data-survey-required` + 前端校验），`*` 标记与「全部必答」提示。
- **前端自动批改**：提交时浏览器逐题比对 `data-answer`，按 `data-score` 计分，结果作为 `__grade` 对象**追加在提交内容（`desc`）末尾**：`{score, full, right, count, detail: {id: {ok, score, answer}}}`。
- 比对规则：`input` 去空白、忽略大小写，可用 `|` 给多个可接受答案；`checkbox` 多选组按集合比较（`,`/`，`/`、` 分隔）；`switch` 比较 `on` / `off`（也接受 `true`/`false`、`1`/`0`）。
- 提交详情页展示「自动批改结果」卡片（总分、答对题数、逐题 ✅/❌ 与得分，错题附正确答案），提交列表也会显示 `得分 / 满分` 标签。
- 发布时服务端校验简介（至少一项合法题目、每项都带 `id` + `data-answer` + `data-score`；多选组后续选项可省略后两者），不合法返回 `400`；提交时服务端要求所有题目作答。
- 已知限制：前端批改意味着正确答案随页面下发（`data-answer`），适合练习/自测，正式考试应改为服务端批改。

### 4.11 个人查询与待回复优先

- `/api/my-uploads` 只返回当前 `auth` 的提交，学生与教职工都可用；支持 `submissionID` / `uploadID` / `match_mode` 过滤，返回 `replyIDs` 方便逐条删除回复。
- `/api/my-submissions` 只返回 `created_by = 当前 auth` 的征集，字段与 `/api/all-submission` 一致。
- `/api/pending-uploads` 返回尚未回复的提交，并按「自己发布的征集优先、其余按时间倒序」排序；Web 首页、提交列表与小程序首页都使用这个顺序。

### 4.12 班级自定义征集模式

- 管理员调用 `/api/new-mode`，为班级新增 `modeName` + `extendModes`；例如 `maths multiple-choise homework` 继承 `homework` 与 `answer sheet`，实际行为是答题卡。
- 模式存储在 `class_modes` 表；创建时解析并固化 `base_type`，发布征集时把自定义模式名写入 `submissions.type`，把实际行为写入 `submissions.base_type`。
- `/api/all-modes` 返回内置与自定义模式；Web 发布页与小程序发布页都会动态展示，账号中心管理员区提供新增入口。小程序离线模拟（`miniprogram/utils/mock`）实现了同一套接口。

### 4.13 小程序敏感操作弹窗

- 组件 `miniprogram/components/confirm-dialog`：居中、遮罩层拦截滑动与点击、只能确认或取消。
- 删除征集 / 提交 / 回复、解除身份绑定、删除密钥、轮换（重置）密钥、重置离线数据等操作都通过弹窗二次确认；弹窗展示被操作对象的名称、ID、类型、发布者等信息。
- 轮换密钥的弹窗附带密码输入框（密码只在本机派生挑战，不发送到服务器）。
- 删除回复使用 `/api/download` 的 `replyIDs`，小程序管理员可以逐条删除回复。

### 4.14 学生 / 家长视角（仅前台）

家长没有独立 `auth`，一直使用孩子的学生密钥。是否显示成「家长口吻」属于**纯展示**差异：

| 视角 | 页面角色 | 文案示例 | 数据范围 |
| --- | --- | --- | --- |
| 学生视角 | `student` | 「我的上传」「我的提交」「尚未提交」 | 自己的提交（由 `auth` 决定） |
| 家长视角 | `parent` | 「孩子提交」「孩子尚未提交」 | 同一个 `auth`，范围完全相同 |

- 在账号中心的「显示模式（学生身份）」里选择家长 / 学生视角，或从班级空间顶栏切换；选择会被记住（写进账号偏好）。
- 班级空间顶栏有「学生视角 / 家长视角」快捷切换（只对学生身份出现）；直接改 URL `/home/<mob|pc>/<student|parent>/` 同样生效。
- 老师 / 管理员身份没有家长视角：请求 `/home/*/parent/` 会跳回自己的空间。
- **API 不变**：`/api/*` 只认 `auth` 与其中的 `role`。

### 4.15 征集可见性类别与单独列出

征集模式新增五类可见性 / 列表属性，既能直接作为 `/api/new-submission` 的 `type`，也能被班级自定义模式继承：

| 属性 | 内置模式名 | 行为 |
| --- | --- | --- |
| 隐藏征集 | `hidden` | 默认不出现在 `/api/all-submission`；`show-hiddens: true` 时出现 |
| 仅教师征集 | `teacher only` | 学生不可见；教师与管理员可见 |
| 仅管理员征集 | `admin only` | 只有管理员可见；教师直接按 ID 访问也返回 404 |
| 不显示征集 | `invisible` | 永不进入全部征集列表，`show-hiddens` 也不显示；只能按征集 ID 调用 API / 直接打开页面 |
| 单独列出征集 | `separate list` | 抽象类别，不能直接发布，只能被继承；子类别会出现在征集列表头部标签页 |

- **可见性通过继承定义**：`/api/new-mode` 的 `hidden` / `teacherOnly` / `adminOnly` / `invisible` / `separateList` 字段已不再生效，必须把对应内置模式写进 `extendModes`（例如 `["homework", "hidden", "separate list"]`）。只有 `abstract` 例外：抽象属性不继承，需要在创建模式时显式声明。
- 可见性直接按 ID 访问的规则：`teacher only` / `admin only` 会拦截无权角色；`hidden` / `invisible` 只影响列表，按 ID 访问仍然可用。
- 单条征集也可以通过 `/api/new-submission` 的 `hidden` / `teacherOnly` / `adminOnly` / `invisible` 覆盖可见性，最终属性 = 模式属性 ∪ 单条覆盖属性。
- `/api/all-submission` 的 `tabs` 返回所有继承 `separate list` 的具体类别（不含抽象基类自身）：`{id, name, displayName, count, separateList}`；`category` 可传模式名或中文显示名称。
- 内置模式的 `displayName` 由 `strings/zh-CN.txt` 本地化；班级自定义模式在 `/api/new-mode` 里可传 `displayName`。
- 嵌套继承允许 `A -> B -> C`；任意两个父模式的继承链（含父模式自身）有交集时视为菱形继承，`/api/new-mode` 返回 400 并说明冲突祖先。

### 4.16 征集类型管理、删除与手动输入

- **管理页**：Web 管理员在 `/home/<mob|pc>/admin/modes/` 查看本班自定义类型列表，页面包含列表、新增表单与删除按钮；侧边栏「征集类型」、征集列表页的「征集类型」按钮均可进入。小程序新增 `pages/modemanage/modemanage`，账号中心管理员区的「管理征集类型」按钮可进入。
- **删除交互**：删除前二次确认；被继承时提示先删除子类型；仍被征集引用时再次询问是否强制删除，Web 调用 `/api/del-mode` 的 `force`，小程序同样走 `force: true` 流程。
- **删除模式**：`POST /api/del-mode`（管理员）接受 `id`（`mode_*`）或 `modeName`（也接受 `mode_name` / `name` / `displayName`）。内置模式（`builtin_*`）不能删除；仍被其他自定义模式继承时返回 400；仍有征集引用时默认返回 400，传 `"force": true` 才会删除。`force` 删除不会级联删除征集。
- **通用删除**：`/api/del-object` 也支持 `mode_*`，行为与 `/api/del-mode` 一致（可传 `force`）。
- **手动输入**：Web 发布页与小程序发布页在「类型」下拉旁新增「手动输入」复选框。勾选后下拉被禁用，必须填写「征集类型原始名称」；未填写时前端提示并阻止提交。提交时该原始名称直接作为 `/api/new-submission` 的 `type`：命中内置 / 自定义模式时沿用其行为与可见性，否则按 `other` 处理。

---

## 5. 界面

- **登录**：品牌页 + 用户名/密码（密码在浏览器内派生 X25519 密钥，不上传）+ 注册并绑定班级密钥 + 手机/电脑视图切换。
- **首页**：按角色生成欢迎区、统计卡片、最近征集、待回复/最近提交。
- **征集**：卡片式列表、类型与截止状态标签、发布表单；类型可选择内置 / 自定义模式，或勾选「手动输入」后填写原始名称；列表头部有「单独列出」标签页与「显示隐藏」开关。
- **征集类型管理**：管理员可在独立页面查看本班自定义类型（显示名称、原始名称、行为基类、继承链、可见性标签），新增类型并删除。
- **提交**：拖拽上传、多个附件、图片缩略图、base64 编码由浏览器完成。
- **详情**：图片灯箱、附件下载、回复时间线、快捷回复、管理员删除。
- **问卷**：简介中的输入框 / 复选框 / 开关渲染为扁平控件（开关以勾选框呈现），末尾一键提交，答案自动整理成键值列表。
- **答题卡**：全部必答，提交后由浏览器自动批改，详情页显示得分卡。
- **视角**：学生身份在顶栏一键切换「学生视角 / 家长视角」。
- **账号中心**：深/浅/跟随系统主题、默认视图、学生身份显示模式、显示名称、密码、多身份密钥（显示/复制/改名/轮换/进入/删除）、创建班级、生成成员密钥。
- **文档与相关**：Web `/docs` 与小程序 `pages/docs/docs` 展示仓库根目录 `README.md`；Web 复用主布局并渲染 Markdown，小程序通过 `/api/docs` 获取原文后以纯文本显示。
- 断点：>1120px 侧边栏电脑版；≤920px 顶栏 + 底部导航手机版；≤640px 单列紧凑布局。
- 主题会记住到 `localStorage`；未登录页也支持系统深色模式。

### 5.1 结构与样式分离

- `src/view.rs`、`src/tools.rs` 生成的 HTML 只使用语义 class，**不含任何 `style=` 行内样式**；`src/assets/app.js` 也只通过 class 切换状态。
- `src/assets/app.css` 只保留必要内容：浏览器差异重置、浅色 / 深色主题变量、电脑 / 手机双端布局与扁平控件样式；不含阴影、渐变、模糊、动画等装饰性效果。
- 配色以 `#0010ff` 为强调色；危险状态使用 `#ff0000`，警告状态使用 `#eedd00`。
- 深色模式使用 `<html data-theme="dark">`；没有执行脚本的页面由 `prefers-color-scheme` 兜底。
- 参考备份 `src/assets/app.css.bak` 保留改造前的复杂实现，仅作对照，不参与构建。

---

## 6. 测试

```bash
cargo test          # 时间/编码/MatchMode/附件/改名校验/问卷解析与校验/字符串解析同步/数据库种子/X25519+AES-GCM 等单元测试
./scripts/smoke.sh  # 启动临时服务并在真实 HTTP 层跑一遍主流程（依赖 sqlite3、node）
python3 scripts/mp_strings.py --check  # 检查字符串 A-Z 排序与小程序 strings.js 是否为最新
```

`scripts/smoke.sh` 在临时 SQLite 上验证：字符串同步、页面无未替换标签、页面无行内样式、CSS 颜色变量、非对称登录（`login-try` / `get-auths` / 注册 / 改密 / 旧账号迁移 / 错误答案）、发布征集、上传、下载、匹配模式、回复、账号中心表单、账号与角色会话隔离、改名、权限拒绝、创建/删除班级与成员、删除密钥与对象，并自动清理进程与数据。另覆盖学生 / 家长视角、答题卡发布与批改、个人查询与待回复优先、自定义模式（含继承与菱形拒绝）、可见性类别与 `show-hiddens`、`/api/del-mode` 与手动输入、类型管理页、`/docs` 与 `/api/docs`、问卷模式全流程。

---

## 7. 目录结构

```
.
├── Cargo.toml
├── doc/
│   ├── requirements.md     # 原始需求
│   └── api.md              # API 参考
├── strings/
│   └── zh-CN.txt           # 简体中文 UI 文案（启动时同步到 strings.db）
├── scripts/
│   ├── smoke.sh            # HTTP 冒烟测试
│   ├── mp_strings.py       # 按 A-Z 排序字符串并生成小程序 strings.js
│   └── auth-client.js      # 命令行非对称登录客户端
└── src/
    ├── main.rs             # 路由与启动
    ├── schema.sql          # SQLite DDL（由 db.rs 加载）
    ├── strings.rs          # 字符串解析、strings.db 同步、标签/格式化
    ├── survey.rs           # 问卷 / 答题卡：控件解析、渲染、必填校验、答案整理、批改结果
    ├── crypto.rs           # 非对称登录密码学：X25519 / HKDF / AES-256-GCM / base64
    ├── db.rs               # 唯一业务 SQL/事务/连接层、建班/成员、演示数据、公钥迁移
    ├── docs.rs             # 文档与相关：README.md 嵌入、Markdown → HTML、纯文本输出
    ├── logging.rs          # ./log 每日文件日志、请求/错误/panic 记录
    ├── types.rs            # 状态、模型、请求/表单、登录挑战会话
    ├── tools.rs            # 时间、base64、转义、会话、MatchMode
    ├── api.rs              # /api/* 处理、/multi-api 批量调用
    ├── pages.rs            # 页面路由、账号中心动作（只调用 db::*）
    ├── view.rs             # 服务端 HTML 渲染（@[strings/key] 标签）
    ├── views/              # 页面片段模板（format! 占位符）
    └── assets/
        ├── app.css         # 重置 / 主题变量 / 双端适配 / 扁平控件样式
        ├── app.js          # 上传、回复、删除、主题等交互（无行内样式）
        └── auth.js         # 本地 KDF + X25519 + AES-GCM 登录 / 注册 / 改密 / 轮换密钥
```

---

## 8. 安全说明与已知限制

- 账号登录使用 X25519 挑战应答：密码只在本机派生私钥，服务端只保存公钥；挑战用 AES-256-GCM 加密，回答密钥一次性使用。班级密钥仍为随机大写串。生产环境必须通过内置 TLS 或反向代理启用 HTTPS，并建议增加登录限流、CSRF token 与审计日志。
- 攻击者拿到挑战密文后可以离线猜测密码，因此请使用强密码；服务端使用 210,000 次 PBKDF2 迭代提高破解成本。改密成功会同时作废旧账号会话与班级角色会话。
- 会话保存在内存，重启失效；多实例部署需要共享会话存储。
- 附件以 base64 存进 SQLite，单次上传限制约 18MB；大文件/高并发场景应使用对象存储与流式接口。
- 没有分页；演示数据与班级规模下足够，数据量增大后应在 `/api/download`、提交列表与账号页增加游标分页。
- `/api/new-user` 生成的密钥只返回一次，请管理员妥善保存；重新发放会创建新密钥。
- 演示密钥、演示账号仅用于本地体验，部署前请删除数据库或替换种子数据；旧数据库账号的密码哈希会保留到首次公钥迁移 / 改密，之后清空，新账号不保存密码哈希。
- `/multi-api` 单次最多 100 个子请求，按数组顺序串行执行；禁止嵌套 `/multi-api` 以及 `login-try` / `get-auths` / `reset-password` / `refresh-key` 等依赖一次性挑战的接口。
- 运行日志只记录启动信息、HTTP 路径 / 状态 / 耗时与错误描述，不记录请求体、密码、班级密钥、cookie、`encryptedAnswer` 或附件内容。请限制日志目录权限并配置保留 / 清理策略。
- `strings.db` 只保存 UI 文案，不包含用户数据；`strings/` 缺失或格式错误时服务会拒绝启动，以避免页面显示未翻译文本。