/* `/api` 客户端：与 doc/api.md 一一对应。
 *
 * 每个函数都返回 Promise<响应体>，字段与 Rust 服务完全一致：
 *   /api/upload          -> {ok, id}
 *   /api/download        -> {ok, datas:[{id, studentID, shortStudentID, title, desc, data, reply, uploader, role, createdAt}]}
 *   /api/new-submission  -> {ok, id}
 *   /api/all-submission  -> {ok, datas:[{id, name, desc, deadLine, type, baseType, createdAt, createdBy,
 *                                        createdByID, uploadCount, myUploadCount, pendingCount, latestUploadID}]}
 *   /api/my-uploads      -> {ok, datas:[{id, submissionID, submissionName, title, desc, data, reply,
 *                                        replyIDs, uploader, role, createdAt,...}]}
 *   /api/my-submissions  -> {ok, datas:[与 all-submission 相同]}
 *   /api/pending-uploads -> {ok, datas:[与 my-uploads 相同 + mine]}
 *   /api/new-mode        -> {ok, id, modeName, extendModes, baseType}
 *   /api/all-modes       -> {ok, modes, datas}
 *   /api/del-mode        -> {ok, id, modeName, displayName, msg}
 *   /api/reply           -> {ok, id}
 *   /api/new-class       -> {ok, id, code, auth, authID}
 *   /api/new-user        -> {ok, IDs, keys, members}
 *   /api/del-key         -> {ok, msg}
 *   /api/rename-auth     -> {ok, name, msg}
 *   /api/del-object      -> {ok, msg}
 *   /api/register        -> {ok, id, userID, username, displayName, boundAuth}
 *   /api/login-try       -> {ok, loginSessionID, challengeEncrypt, answerEncryptingKey, expiresIn,
 *                            username, displayName, kdf:{name,iterations,salt,...}}
 *   /api/get-auths       -> {ok, auths, authIDs, members:[{id,key,classID,className,role,
 *                            studentID,shortStudentID,displayName}], user:{id,username,displayName}}
 *   /api/refresh-key     -> {ok, newAuth}
 *   /api/reset-password  -> {ok, msg}
 *   /api/upgrade-pubkey  -> {ok, msg, username}
 *   /api/multi-api       -> {ok, results:[...]}
 *   /api/health          -> {ok, service, time}
 */
var request = require("./request");

function upload(payload) {
  return request.post("upload", payload);
}

function download(payload) {
  return request.post("download", payload);
}

function newSubmission(payload) {
  return request.post("new-submission", payload);
}

function allSubmission(payload) {
  return request.post("all-submission", payload);
}

/** 当前身份的全部提交（支持 submissionID / uploadID / match_mode 过滤）。 */
function myUploads(payload) {
  return request.post("my-uploads", payload);
}

/** 当前身份发布的全部征集。 */
function mySubmissions(payload) {
  return request.post("my-submissions", payload);
}

/** 老师 / 管理员：待回复提交，默认自己发布的征集优先。 */
function pendingUploads(payload) {
  return request.post("pending-uploads", payload);
}

/** 管理员：为班级新增自定义征集模式。 */
function newMode(payload) {
  return request.post("new-mode", payload);
}

/** 班级可用的征集模式（内置 + 自定义）。 */
function allModes(payload) {
  return request.post("all-modes", payload);
}

/** 管理员：删除班级自定义征集模式（传 id 或 modeName；force 可强制删除仍被引用的模式）。 */
function delMode(payload) {
  return request.post("del-mode", payload);
}

function reply(payload) {
  return request.post("reply", payload);
}

function newClass(payload) {
  return request.post("new-class", payload);
}

function newUser(payload) {
  return request.post("new-user", payload);
}

function delKey(payload) {
  return request.post("del-key", payload);
}

function renameAuth(payload) {
  return request.post("rename-auth", payload);
}

function delObject(payload) {
  return request.post("del-object", payload);
}

/** 账号登录（v0.1.7 非对称挑战）：服务端下发加密挑战，客户端用本机私钥解密。 */
function loginTry(payload) {
  return request.post("login-try", payload);
}

function getAuths(payload) {
  return request.post("get-auths", payload);
}

/** 注册：只上传由密码派生的 X25519 公钥，密码本身不出本机。 */
function registerAccount(payload) {
  return request.post("register", payload);
}

function resetPassword(payload) {
  return request.post("reset-password", payload);
}

/** 验证账号挑战后轮换 auth 密钥（新密钥继承全部数据，旧密钥立即失效）。 */
function refreshKey(payload) {
  return request.post("refresh-key", payload);
}

/** 批量调用内部 API；服务端同时注册了 `/multi-api` 与 `/api/multi-api`。 */
function multiApi(payload) {
  return request.post("multi-api", payload);
}

/** 旧账号（只有密码哈希）一次性迁移到公钥登录。 */
function upgradePubkey(payload) {
  return request.post("upgrade-pubkey", payload);
}

function health() {
  return request.health();
}

/** 用只读/无副作用的调用推断密钥的角色。
 *
 *  1. `/api/all-submission` -> 401 表示密钥无效；
 *  2. `/api/download` 用不存在的 which 探测：学生 403、老师/管理员 404；
 *  3. `/api/new-class` 用空参数探测：老师 403、管理员 400（参数校验先于写入）。
 *  三步都不会写入任何数据，因此可以安全地在登录时使用。 */
function probeIdentity(key) {
  return allSubmission({ auth: key }).then(function (res) {
    if (!res.ok) {
      return { ok: false, msg: res.msg || "invalid auth", status: res.status };
    }
    return download({ auth: key, which: "probe-does-not-exist" }).then(function (staff) {
      if (staff.status === 403) return { ok: true, role: "student" };
      if (!staff.ok && staff.status !== 404) {
        return { ok: false, msg: staff.msg || "role probe failed", status: staff.status };
      }
      return newClass({ auth: key, name: "", desc: "" }).then(function (admin) {
        if (admin.status === 403) return { ok: true, role: "teacher" };
        if (admin.status === 400) return { ok: true, role: "admin" };
        // 兜底：能通过 download 的权限检查就说明是教职工
        return { ok: true, role: "teacher" };
      });
    });
  });
}

/** 学生 / 家长：同一个学生 auth 的两种展示视角 */
function pageRoleOf(role, view) {
  if (role === "student") return view === "parent" ? "parent" : "student";
  return role;
}

module.exports = {
  upload: upload,
  download: download,
  newSubmission: newSubmission,
  allSubmission: allSubmission,
  myUploads: myUploads,
  mySubmissions: mySubmissions,
  pendingUploads: pendingUploads,
  newMode: newMode,
  allModes: allModes,
  delMode: delMode,
  reply: reply,
  newClass: newClass,
  newUser: newUser,
  delKey: delKey,
  renameAuth: renameAuth,
  delObject: delObject,
  loginTry: loginTry,
  getAuths: getAuths,
  registerAccount: registerAccount,
  refreshKey: refreshKey,
  resetPassword: resetPassword,
  upgradePubkey: upgradePubkey,
  multiApi: multiApi,
  health: health,
  probeIdentity: probeIdentity,
  pageRoleOf: pageRoleOf,
};
