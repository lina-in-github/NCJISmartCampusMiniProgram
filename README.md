### 1 user 与 auth

- `users`：用户名、公开的 X25519 公钥（`pubkey`）、显示名称、偏好设置；密码本身不落库。
- `classes`：班级名称、简介、班级代码。
- `auths`：班级密钥（`key`）、所属班级、绑定用户、角色（student / teacher / admin）、学生学号与短学号、显示名称（可通过 `/api/rename-auth` 修改）。
- `submissions`：班级征集，含类型、说明、截止时间。类型为 `notice` 的公示版仅展示详情、不开放提交；未到截止时间的公示版会置顶。
- `uploads`：提交，含附件 JSON、提交人身份快照（姓名、学号、角色）。
- `replies`：老师/管理员回复，按时间排序。
- 删除班级会级联删除该班级的 auth、征集、提交、回复与自定义模式；删除 auth 不会删除历史提交（保留提交人快照）。删除征集/提交会级联删除其下提交/回复。删除自定义模式不会级联删除征集。
- 身份改名会同步刷新该 auth 在历史提交、回复与征集中的显示名称快照。
- `/api/refresh-key` 会先把旧 auth 的征集 / 提交 / 回复引用迁移到新 auth，再删除旧记录；历史展示快照保持不变。

### 2 权限

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

学生 / 家长只是前台视角，家长使用孩子的学生 `auth`，二者数据范围完全相同，区别只在页面文案。

### 3 登录与会话流程

- 账号登录流程：客户端用 PBKDF2-HMAC-SHA256（210,000 次）从密码派生 32 字节 X25519 私钥 → 公钥在注册 / 改密时上传。登录时用公钥加密随机挑战，客户端解密后用一次性对称密钥加密回答；验证通过后返回该账号的全部 auth 密钥。
- 密码和私钥不会发送到服务端；服务端只保存公钥。
- auth 泄漏处置：在完成账号挑战后，用旧 `auth` 换一个新密钥。新 auth 继承旧 auth 的班级、角色、学号、显示名称与全部历史数据；旧 auth 立即删除，绑在旧 auth 上的角色会话同步失效。
- 账号中心每个身份右侧提供「轮换密钥」按钮：弹窗内输入当前密码，完成挑战后展示新密钥并提供复制。
- 未登录访问 `/user` 会 `303` 跳转到 `/login/account`；仅持有角色 `sc_sid` 时同样不会进入账号中心。
- 两个会话可以同时存在且互不覆盖：`/user` 始终显示 `sc_uid` 对应的账号。
- 登录挑战会话保存在内存，5 分钟有效；同一会话连续 5 次回答错误后作废。
- 会话保存在内存中，每次重启服务器都需要重新登录。

### 4 附件格式

推荐元素格式：

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

图片在详情页内联预览，其他类型提供下载。MIME 与 base64 会在写入前校验，避免在页面中注入非 data URL 内容。





### 5 问卷模式

征集类型为 `survey`（「问卷」）时，简介不再是纯文本，而是可包含某些html标签的问卷定义：

```text
姓名：<input id="form_name" required/>

想参加的社团：<checkbox id="form_club" value="math"/>数学社 <checkbox id="form_club" value="art"/>美术社
接收通知：<switch id="form_notify"/>
备注：<input id="form_note" placeholder="写点什么"/>
```

- 允许的标签只有 `input`、`checkbox`、`switch`；`id` 必填且必须以 `form_` 开头，`required` 可选；`input` 还支持 `type`（`text`/`number`/`email`/`tel`/`url`/`date`/`time`）、`placeholder`、`value`，`checkbox` 支持 `value`。不合法或未知标签会按普通文本转义显示。
- 题目标签自动从简介文字推断：`input` 取前文，`checkbox` / `switch` 取后文，多选组的组标题取组前文本。
- 同一 `id` 的多个 `checkbox` 视为多选组（DOM id 依次为 `form_x`、`form_x__2`…，答案键仍是 `form_x`）。
- 问卷模式下不再显示标题/说明/附件表单，简介被渲染成可填写控件，末尾是一个「提交问卷」按钮；
- 提交按钮把答案打包成 `{控件 id: 值}` 的 JSON 字符串，以 `title: "bot-upload"` 调用 `/api/upload`（`desc` 即该 JSON），随后跳转到提交详情页。
- 提交详情页会把 JSON 答案按简介顺序渲染成「题目 / 回答」列表。

### 6 答题卡模式

征集类型为 `answer sheet`（「答题卡」）时，每一个标签在 `id` 之外必须再写 `data-answer` 与 `data-score`：

```text
1 + 1 = <input id="form_q1" data-answer="2" data-score="5"/>
选出正确答案：<checkbox id="form_q2" value="a" data-answer="b" data-score="3"/>A <checkbox id="form_q2" value="b"/>B
地球是圆的：<switch id="form_q3" data-answer="on" data-score="2"/>
```

- **所有项目都必填**
- 自动批改：提交时浏览器逐题比对 `data-answer`，按 `data-score` 计分，结果追加在提交内容（`desc`）末尾。
- 比对规则：`input` 去空白、忽略大小写，可用 `|` 给多个可接受答案；`checkbox` 多选组按集合比较（`,`/`，`/`、` 分隔）；`switch` 比较 `on` / `off`（也接受 `true`/`false`、`1`/`0`）。
- 提交详情页展示「自动批改结果」卡片（总分、答对题数、逐题 ✅/❌ 与得分，错题附正确答案），提交列表也会显示 `得分 / 满分` 标签。
- 发布时将校验简介（至少一项合法题目、每项都带 `id` + `data-answer` + `data-score`；多选组后续选项可省略后两者），不合法返回 `400`；提交时要求所有题目作答。


### 7 班级自定义征集模式

- 为班级新增名为 `modeName` ，显示名称为`displayName`,按顺序继承 `extendModes` 中类型的行为；例如 `maths multiple-choise homework` 继承 `homework` 与 `answer sheet`，实际行为是答题卡。
- `/api/all-modes` 返回内置与自定义模式；Web 发布页与小程序发布页都会动态展示，账号中心管理员区提供入口。


### 8 学生 / 家长视角（仅前台）

家长没有独立 `auth`，一直使用孩子的学生密钥。是否显示成「家长口吻」属于纯展示差异：

| 视角 | 页面角色 | 文案示例 | 数据范围 |
| --- | --- | --- | --- |
| 学生视角 | `student` | 「我的上传」「我的提交」「尚未提交」 | 自己的提交（由 `auth` 决定） |
| 家长视角 | `parent` | 「孩子提交」「孩子尚未提交」 | 同一个 `auth`，范围完全相同 |

- 在账号中心的「显示模式（学生身份）」里选择家长 / 学生视角，或从班级空间顶栏切换；选择会被记住（写进账号偏好）。
- 班级空间顶栏有「学生视角 / 家长视角」快捷切换（只对学生身份出现）；直接改 URL `/home/<mob|pc>/<student|parent>/` 同样生效。
- 老师 / 管理员身份没有家长视角：请求 `/home/*/parent/` 会跳回自己的空间。

### 9 征集可见性类别与单独列出

征集模式有五类可见性 / 列表属性，既能直接作为 `/api/new-submission` 的 `type`，也能被班级自定义模式继承：

| 属性 | 内置模式名 | 行为 |
| --- | --- | --- |
| 隐藏征集 | `hidden` | 默认不出现在 `/api/all-submission`；`show-hiddens: true` 时出现 |
| 仅教师征集 | `teacher only` | 学生不可见；教师与管理员可见 |
| 仅管理员征集 | `admin only` | 只有管理员可见；教师直接按 ID 访问也返回 404 |
| 不显示征集 | `invisible` | 永不进入全部征集列表，`show-hiddens` 也不显示；只能按征集 ID 调用 API / 直接打开页面 |
| 单独列出征集 | `separate list` | 抽象类别，不能直接发布，只能被继承；子类别会出现在征集列表头部标签页 |

- **可见性通过继承定义**：必须把对应内置模式写进 `extendModes`（例如 `["homework", "hidden", "separate list"]`）。只有 `abstract` 例外：抽象属性不继承，需要在创建模式时显式声明。
- 可见性直接按 ID 访问的规则：`teacher only` / `admin only` 会拦截无权角色；`hidden` / `invisible` 只影响列表，按 ID 访问仍然可用。
- 内置模式的 `displayName` 由 `strings/zh-CN.txt` 本地化；班级自定义模式在 `/api/new-mode` 里可传 `displayName`。
- 嵌套继承允许 `A -> B -> C`；任意两个父模式的继承链（含父模式自身）有交集时视为菱形继承，`/api/new-mode` 返回 400 并说明冲突祖先。

### 10 征集类型管理与手动输入

- **管理页**：Web 管理员在 `/home/<mob|pc>/admin/modes/` 查看本班自定义类型列表，页面包含列表、新增表单与删除按钮；侧边栏「征集类型」、征集列表页的「征集类型」按钮均可进入。小程序新增 `pages/modemanage/modemanage`，账号中心管理员区的「管理征集类型」按钮可进入。
- **手动输入**：Web 发布页与小程序发布页在「类型」下拉旁新增「手动输入」复选框。勾选后下拉被禁用，必须填写「征集类型原始名称」；未填写时前端提示并阻止提交。提交时该原始名称直接作为 `/api/new-submission` 的 `type`：命中内置 / 自定义模式时沿用其行为与可见性，否则按 `other` 处理。

### 11 项目相关

- 可以从`https://github.com/lina-in-github/NCJISmartCampusMiniProgram`中获取项目的代码
- 本项目为演示项目，请勿直接用于生产！