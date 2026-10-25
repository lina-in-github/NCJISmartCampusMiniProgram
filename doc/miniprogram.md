# 智慧校园 · 微信小程序模拟端

把本项目（Rust · Axum · SQLite 的 Web 服务）在**微信小程序**里完整重做一遍：

- **页面 1:1 对应** Web 端的 `/login`、`/home/*/*`、`/user` 等路由；
- **`/api` 完全同构**：小程序发出去的请求体、收到的响应体与 [`doc/api.md`](api.md) 逐字段一致，
  Rust 服务**无需任何修改**；
- **两种数据源**：既可以连真实服务器（登录页/设置页里填写服务器 IP），也可以**完全离线模拟**
  （本地按同一套 `/api` 契约应答，内置演示班级、征集、提交、回复、问卷与答题卡）。

```
miniprogram/            # 小程序源码
├── app.js / app.json / app.wxss / theme.json / sitemap.json
├── components/bottom-nav/          # 底部导航（首页 / 征集 / 提交 / 账号）
├── pages/                          # 12 个页面
└── utils/                          # 传输层、API 客户端、离线模拟、问卷解析……
project.config.json     # 微信开发者工具项目配置（miniprogramRoot = miniprogram/）
scripts/mp_test.js      # 离线自测：结构 / 文案 / 接口同构 / 页面流程
scripts/mp_strings.py   # 从 strings/zh-CN.txt 生成 miniprogram/utils/strings.js
scripts/make_demo_images.py  # 生成离线模拟用的内嵌演示附件
```

---

## 1. 快速开始

1. 微信开发者工具 →「导入项目」→ 选择**仓库根目录**（含 `project.config.json`）；
   AppID 可用「测试号」，`miniprogramRoot` 已配置为 `miniprogram/`。
2. 首次打开默认是**离线模拟**：无需启动服务器，直接点「学生视角 / 老师 / 管理员」卡片，
   用演示密钥登录即可（密钥可一键填入）。
3. 想连真实服务器时：右上角「服务器与数据源」→ 切到「在线模式」→ 填服务器 IP → 保存/测试连接。

> 真机调试网络请求要在开发者工具「详情 → 本地设置」勾选
> **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**；
> 正式发布则必须在小程序后台把服务器域名加入白名单（且必须是 HTTPS）。

### 启动后端

```bash
cargo run                       # 默认监听 0.0.0.0:3000
SC_BIND=0.0.0.0:3000 cargo run  # 手机真机访问时需要监听所有网卡
```

### 演示数据

离线模拟的种子数据与 `src/db.rs` 的演示数据一一对应（两个班级、8 个密钥、9 个征集、
6 份提交、3 条回复），另加一份问卷与一份答题卡征集，方便验证 v0.1.4 / v0.1.5 的表单模式：

| 身份 | 班级密钥 | 班级 | 姓名 |
| --- | --- | --- | --- |
| 家长 / 学生 | `SC-STU-DEMO-2026` | 高一（3）班 | 陈小满 |
| 学生 | `SC-STU-DEMO-2026-02` | 高一（3）班 | 李知遥 |
| 学生 | `SC-STU-DEMO-2026-03` | 高一（3）班 | 王浩然 |
| 老师 | `SC-TEA-DEMO-2026` | 高一（3）班 | 林书言 |
| 管理员 | `SC-ADM-DEMO-2026` | 高一（3）班 | 赵明远 |
| 管理员 | `SC-ADM-DEMO-2027` | 高二（1）班 | 赵明远 |

账号中心演示账号：`admin/admin123`、`teacher/teacher123`、`student/student123`。

---

## 2. 服务器 IP 与两种模式

设置页（`pages/settings/settings`）：

| 项 | 说明 |
| --- | --- |
| 在线模式 | 所有业务请求都 `POST <服务器地址>/api/<endpoint>`，请求头 `Content-Type: application/json`，请求体/响应体与 `doc/api.md` 完全一致 |
| 离线模拟 | 不发起任何网络请求，`utils/mock/*` 在本地按同一套契约应答；数据存在本机存储里，可一键重置 |
| 服务器 IP / 地址 | 可只填 IP，例如 `192.168.1.20`、`192.168.1.20:3000`、`https://campus.example.com`；缺省 `http://localhost:3000`；会自动补 `http://` 并去掉结尾 `/` |
| 测试连接 | `GET <服务器地址>/api/health`（`/api/health` 是唯一 GET 接口） |

配置保存在本机 `sc.mp.config.v1`，登录页右上角也提供入口。

> 手机真机要访问电脑上的服务：手机与电脑连同一个 Wi-Fi，`SC_BIND=0.0.0.0:3000 cargo run`，
> 然后在设置页填写电脑的局域网 IP（如 `192.168.1.20:3000`）。

---

## 3. `/api` 同构

### 3.1 请求与响应

`utils/api.js` 是**唯一**的业务入口，函数与接口一一对应：

| 函数 | 接口 | 请求字段 | 响应字段 |
| --- | --- | --- | --- |
| `upload` | `/api/upload` | `auth, which, title, desc, data` | `ok, id` |
| `download` | `/api/download` | `auth, which, match_mode` | `ok, datas[{id, studentID, shortStudentID, title, desc, data, reply, uploader, role, createdAt}]` |
| `newSubmission` | `/api/new-submission` | `auth, name, desc, type, deadLine` | `ok, id` |
| `allSubmission` | `/api/all-submission` | `auth, match_mode` | `ok, datas[{id, name, desc, deadLine, type, createdAt, createdBy, uploadCount, myUploadCount, pendingCount, latestUploadID}]` |
| `reply` | `/api/reply` | `auth, uploadID, content` | `ok, id` |
| `newClass` | `/api/new-class` | `auth, name, desc` | `ok, id, code, auth, authID` |
| `newUser` | `/api/new-user` | `auth, classID, quantity, type` | `ok, IDs, keys, members[{id,key,role,studentID,displayName}]` |
| `delKey` | `/api/del-key` | `auth` | `ok, msg` |
| `renameAuth` | `/api/rename-auth` | `auth, name` | `ok, name, msg` |
| `delObject` | `/api/del-object` | `auth, id` | `ok, msg` |
| `health` | `/api/health`（GET） | — | `ok, service, time` |

失败响应统一为 `{ "ok": false, "msg": "英文错误信息" }`，与 Rust 服务逐字一致；客户端额外把
HTTP 状态码放到 `status` 字段（仅用于提示，不改变响应体语义）。

### 3.2 离线模拟也是同一份契约

`utils/mock/index.js` 按 `src/api.rs` / `src/db.rs` 的行为实现：

- 校验顺序、错误文案、HTTP 状态码与线上一致（`401 invalid or expired auth`、
  `403 only teachers or admins can download class submissions`、
  `404 submission not found`、`400 missing required form fields: form_name` 等）；
- `match_mode` 支持 `All`、`Random(quantity)`、`StudentID`、`ShortStudentID`、`TitleReGex`、
  `Before`（ISO 时间或 `7d` / `12h` / `30m`），以及显式写法 `{type, quantity}`；
- 征集排序与 SQL 相同：未过期的公示置顶 → 过期靠后 → 无截止时间最后 → 截止时间升序 → 创建时间倒序；
- 提交内容按提交时间升序返回（`/api/download`），`reply` 为回复内容数组；
- 问卷必填校验、答题卡发布校验、改名同步历史快照、删除对象的级联规则都照搬；
- 附件归一化（`{name,mime,data}` / data URL / 裸 base64、最多 8 个、总计约 18MB、MIME 与 base64 校验）。

因此 `node scripts/mp_test.js` 可以逐条比对「离线响应的字段与线上契约是否一致」。

### 3.3 登录时如何得知密钥角色（只读探测）

`/api` 没有「查询身份信息」的接口，但角色决定页面形态，小程序用三步**无副作用**探测
（`utils/api.js#probeIdentity`）：

| 步骤 | 调用 | 学生 | 老师 | 管理员 |
| --- | --- | --- | --- | --- |
| 1 | `POST /api/all-submission {auth}` | 200（密钥有效） | 200 | 200 |
| 2 | `POST /api/download {auth, which:"probe-does-not-exist"}` | **403** | 404 | 404 |
| 3 | `POST /api/new-class {auth, name:"", desc:""}` | — | **403** | **400**（参数校验先于写入） |

三步都不会写入数据：`which` 不存在只会返回 404，`new-class` 的空参数会在写库前被拒绝。
判定结果与 Web 端登录页一致：密钥与所选身份不匹配时拒绝登录（一个密钥只对应一个班级与一个角色）。

---

## 4. 页面路由对照

| Web 端 | 小程序页面 | 说明 |
| --- | --- | --- |
| `/login` | `pages/login/login` | 身份卡片（家长 / 学生 / 老师 / 管理员）、演示密钥、设置入口、账号入口 |
| `/login/<mode>/<role>` | `pages/login-key/login-key?role=` | 密钥登录 + 角色校验 + 演示密钥一键填入 |
| `/login/account` | `pages/account-login/account-login` | 账号登录 / 注册（本机账号） |
| `/home/<mode>/<role>/` | `pages/home/home` | 统计卡片、最近征集、最近 / 待回复提交、学生↔家长视角切换 |
| `…/submissions/` | `pages/submissions/submissions` | 征集列表；老师可发布，管理员可删除 |
| `…/submissions/new` | `pages/submission-new/submission-new` | 发布征集（含问卷 / 答题卡提示、截止时间选择） |
| `…/submission/<id>/all` | `pages/submission/submission?id=` | 公示详情 / 问卷就地填写 / 提交列表（含答案与批改结果） |
| `…/submission/<id>/upload` | `pages/upload-form/upload-form?id=` | 上传表单（多附件）或问卷 / 答题卡填写 |
| `…/uploads/` | `pages/uploads/uploads` | 学生看自己；老师 / 管理员看全班，可筛选待回复 / 已回复 |
| `…/upload/<id>/` | `pages/upload-detail/upload-detail?id=&sid=` | 附件、答案 / 批改、回复时间线、回复输入、管理员删除 |
| `/user` | `pages/account/account` | 偏好、密码、多身份（进入 / 改名 / 解绑 / 删除密钥）、创建班级、生成成员密钥 |
| —— | `pages/settings/settings` | 服务器 IP、在线 / 离线切换、测试连接、重置离线数据 |

---

## 5. 关键实现

### 5.1 文案（v0.1.2 约定）

`miniprogram/utils/strings.js` 由 `strings/zh-CN.txt` 生成，与 Web 端共用同一份文案：

```bash
python3 scripts/mp_strings.py           # 重新生成
python3 scripts/mp_strings.py --check   # 校验是否与 strings/zh-CN.txt 同步
```

页面里 `strings.t("key")` / `strings.S("key", arg)` 与 Rust 的 `t/f1/f2`、前端 `S()` 语义一致
（`{}` 顺序替换，`{{` / `}}` 为字面量花括号，缺失 key 保留 `@[strings/key]`）。
API 的错误信息仍然是英文，不使用该字符串库。

### 5.2 问卷 / 答题卡

`utils/survey.js` 是 `src/survey.rs` 的移植：控件解析（`<input/>`、`<checkbox/>`、`<switch/>`、
`id` 必须 `form_` 开头、答题卡强制 `data-answer` + `data-score`）、题目标签推断（input 取前文、
checkbox/switch 取后文、多选组取组前文本）、必填校验、答案整理（`{控件 id: 值}`）、
自动批改（`__grade` 追加在 JSON 末尾）。提交统一走：

```js
// utils/surveyform.js
api.upload({ auth, which, title: "bot-upload", desc: JSON.stringify(values), data: [] })
```

答题卡的批改规则与 `src/assets/app.js` 完全一致（`|` 多答案、集合比较、`on/off` 归一化、
`round2` 保留两位）。

### 5.3 时间

`utils/time.js` 复刻 `src/tools.rs`：无时区输入按北京时间（UTC+8）解析，响应格式
`2026-11-01T20:00:00+08:00`，支持 `7d/12h/30m` 相对时长与 Unix 秒；展示规则（剩 N 天 / 已截止、
相对时间）与 `src/view.rs` 相同。

### 5.4 附件

- 选择：`wx.chooseMessageFile`（回退 `wx.chooseImage`）→ `FileSystemManager.readFileSync(path,"base64")`；
- 预览：写临时文件后 `wx.previewImage`（图片）/ `wx.openDocument`（PDF、Office 等）；
- 上限：8 个、总计约 18MB，与服务端一致；MIME 由扩展名推断。

### 5.5 会话与「本机提交缓存」

- `utils/session.js`：当前班级身份（`key` + `role` + `pageRole`），等价于服务端的 `sc_sid`；
  学生身份的「学生视角 / 家长视角」只是前台展示差异，与 v0.1.6 语义一致（API 不变）。
- `utils/cache.js`：本机发生的每一次上传都会记下来（标题 / 说明 / 附件 / 时间 / 服务端返回的 ID），
  在线模式下学生端用它回看自己的提交。

---

## 6. 与 Web 端的差异与已知限制

这些差异都由 `/api` 的能力边界或微信运行环境决定，**没有修改任何后端接口**：

1. **学生读取自己的提交**：`/api` 没有「读取本人提交」的接口（Web 端由服务端直接查库渲染）。
   小程序的处理：离线模式读取本地模拟库（`mock.localUploads`，体验与服务端一致）；
   在线模式读取本机提交缓存，老师回复只显示老师 / 管理员视角能看到的内容。
2. **逐条删除回复**：`/api/download` 只返回回复内容字符串，没有 `rep_` id，因此小程序内不提供
   「删除单条回复」，只能删除整条提交 / 征集（`/api/del-object`）。Web 端管理员可逐条删除。
3. **班级名称 / 成员数**：`/api` 不返回班级信息与成员数量，线上模式的顶栏只显示身份名称与密钥尾号；
   离线模式可显示种子数据里的班级名。成员数量统计在线上不可用（首页统计改用征集与提交推导）。
4. **账号中心是本机的**：服务端 `/user` 使用 HttpOnly cookie 会话 + 同源表单 POST，小程序无法复用，
   因此账号、偏好、绑定关系保存在本机；真正作用于班级数据的操作（创建班级、生成成员密钥、
   改名、删除密钥 / 对象）仍然调用 `/api`。
5. **生成成员密钥需要 classID**：`/api` 没有「查询班级 ID」的接口。小程序在创建班级时会记住
   `new-class` 返回的 `cls_` ID 并自动填入，也可以手动粘贴管理员提供的 ID。
6. **手机 / 电脑视图**：小程序的 `mob/pc` 视图不适用，界面固定为手机版；「默认视图」偏好不再展示。
7. **附件大小**：微信 `wx.chooseMessageFile` 单文件上限与网络条件更严格，大文件建议在 Web 端上传。
8. **演示附件素材**：真实服务的演示附件是 SVG（浏览器可直接预览），离线模拟用的是内嵌 PNG
   （微信 `previewImage` 不支持 SVG）。两者都是 `{name, mime, data}` 结构，契约一致，仅素材不同。
9. **提交列表的聚合**：`/api` 没有「跨征集查询提交」的接口，老师的提交列表是对最近 20 个征集
   逐个调用 `/api/download` 汇总出来的（并发/次数都有上限），数据量很大时应增加分页接口。
10. **深色模式**：小程序自己实现主题（`theme-light` / `theme-dark` 变量类），默认跟随系统，
   账号中心可强制浅色 / 深色，与 Web 端配色一致（强调色 `#0010ff`，危险 `#ff0000`，警告 `#eedd00`）。

---

## 7. 自测

```bash
node scripts/mp_test.js     # 纯离线自测，不需要后端
./scripts/mp_parity.sh      # 起一个临时后端，逐字段对比「离线模拟 vs 真实 /api」
```

覆盖内容：

1. **结构**：`app.json` 中每个页面都有 `js/json/wxml/wxss`，所有 JSON 可解析，组件文件齐全；
2. **文案**：所有 `strings.t()/S()` 用到的 key 都存在于 `strings/zh-CN.txt`，且 WXML 里引用的
   `s.*` 字段都在页面 JS 中赋值；
3. **utils**：时间解析 / 格式化、问卷解析与必填校验、答题卡批改、MatchMode、附件归一化；
4. **离线 `/api` 同构**：11 个接口的字段、权限、错误文案、MatchMode、级联删除、改名快照；
5. **在线请求同构**：拦截 `wx.request`，校验 URL、方法、请求体，以及 4xx / 非 JSON / 网络错误处理；
6. **页面流程**：学生登录 → 首页 → 征集 → 上传 → 提交详情 → 问卷 bot 提交 → 答题卡自动批改 →
   老师回复 → 发布征集 → 账号中心（创建班级 / 生成成员 / 改名）→ 设置页切换模式 → 未登录守卫。

7. **在线页面流程**：用「离线 mock 当作契约合规的服务端」拦截 `wx.request`，
   验证在线模式下页面请求的 URL / 请求体，以及学生端「读本机缓存」的行为与权限错误透出。

它使用一个最小的 `wx` / `Page` 假环境（本机存储、弹窗自动确认、文件系统桩），
因此**不需要微信开发者工具**就能跑，也不依赖网络。

`scripts/mp_parity.sh` 则更进一步：启动真实 Rust 服务（临时数据库），把同一串请求
（51 个用例：读取、MatchMode、全部校验错误、上传 / 回复 / 发布 / 建班 / 生成成员 / 改名 / 删除）
分别打给真实服务和离线模拟，归一化随机 ID、时间戳、密钥、学号、演示附件后**逐字段比较响应体与 HTTP 状态码**。

---

## 8. 常见问题

**连不上服务器？**
先看设置页的「测试连接」结果：`network error` 说明地址/端口不对或手机与电脑不在同一网段；
`health check failed (HTTP 404)` 说明该地址不是智慧校园服务；真机还需要开启「不校验合法域名」。

**登录提示「该密钥属于「学生」，请使用「老师」身份登录」？**
与 Web 端一致：一个班级密钥只对应一个角色，换身份要换密钥。

**想恢复演示数据？**
设置页「重置离线模拟数据」会重建离线数据库（账号与偏好不受影响）；
连的若是真实服务器，删除 `smartcampus.db` 重启即可。

**改了 `strings/zh-CN.txt` 但小程序文案没变？**
运行 `python3 scripts/mp_strings.py` 重新生成 `miniprogram/utils/strings.js`。
