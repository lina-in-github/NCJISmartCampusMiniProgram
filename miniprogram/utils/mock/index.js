/* 离线模拟后端：在本地按 `/api` 的契约应答。
 *
 * 目标是与 Rust 服务「同构」：请求字段、响应字段、错误信息（英文）、HTTP 状态语义
 * 都与 `src/api.rs` 一致，因此 `utils/request.js` 可以在「在线」与「离线」之间无缝切换，
 * 页面代码完全不需要知道数据来自真实服务器还是本地内存。
 *
 * 数据保存在本地存储（默认 wx.setStorageSync），首次使用时写入与 Rust 演示数据一致的
 * 种子数据（两个班级、8 个身份密钥、6 个征集、6 份提交、3 条回复）。
 */
var storage = require("../storage");
var time = require("../time");
var strings = require("../strings");
var survey = require("../survey");
var attachments = require("../attachments");
var matchmode = require("../matchmode");
var authcrypto = require("../authcrypto");
var demo = require("./demo-images");

var DB_KEY = "sc.mp.mock.v1";
var SEED_VERSION = 1;
var ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
var MAX_TITLE = 200;
var MAX_DESC = 5000;
var MAX_SUBMISSION_DESC = 2000;
// 与 src/db.rs 的 demo_text 一致的纯文本附件（base64 已预计算）
var DEMO_TEXT = {
  process: {
    name: "解题过程.txt",
    mime: "text/plain",
    data: "MS4g5a+85pWw5a6a5LmJ77yaZicoeCk9bGltLi4uCjIuIOesrCAzIOmimOS9v+eUqOmTvuW8j+azleWIme+8mi4uLgo=",
  },
  sports: {
    name: "运动会报名.txt",
    mime: "text/plain",
    data: "5aeT5ZCN77ya546L5rWp54S2CuWtpuWPt++8mkcyNjAzLTAzCumhueebru+8mjEwMG3jgIHot7Pov5wK6IGU57O75pa55byP77yaMTM4KioqKjY3MjEK",
  },
};

var DEMO_KEYS = {
  admin: "SC-ADM-DEMO-2026",
  admin2: "SC-ADM-DEMO-2027",
  teacher: "SC-TEA-DEMO-2026",
  teacher2: "SC-TEA-DEMO-2027",
  student: "SC-STU-DEMO-2026",
  student2: "SC-STU-DEMO-2026-02",
  student3: "SC-STU-DEMO-2026-03",
  studentC2: "SC-STU-DEMO-2027",
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function randString(n) {
  var out = "";
  for (var i = 0; i < n; i++) out += ALNUM.charAt(Math.floor(Math.random() * ALNUM.length));
  return out;
}

function newId(prefix) {
  return prefix + "_" + randString(12).toLowerCase();
}

function newAuthKey(role) {
  var tag = role === "admin" ? "ADM" : role === "teacher" ? "TEA" : "STU";
  return "SC-" + tag + "-" + randString(8).toUpperCase();
}

function newClassCode() {
  return "C" + randString(5).toUpperCase();
}

function ok(extra) {
  // 真实服务的 HTTP 状态码不会出现在响应体里；小程序客户端统一补一个 `status` 字段，
  // 因此离线模拟也返回 200，保持「客户端看到的响应形状」一致。
  var out = { ok: true, status: 200 };
  Object.keys(extra || {}).forEach(function (k) {
    out[k] = extra[k];
  });
  return out;
}

function fail(status, msg) {
  return { ok: false, msg: msg, status: status };
}

function identity(auth) {
  var name = String(auth.display_name || "").trim();
  if (name) return name;
  if (auth.role === "admin") return strings.t("identity_admin");
  if (auth.role === "teacher") return strings.t("identity_teacher");
  if (auth.student_id) return strings.S("identity_student_id", auth.student_id);
  return strings.t("identity_student");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function charCount(s) {
  return Array.from(String(s === null || s === undefined ? "" : s)).length;
}

function truncateChars(s, n) {
  var chars = Array.from(String(s === null || s === undefined ? "" : s));
  if (chars.length <= n) return chars.join("");
  return chars.slice(0, n).join("") + "…";
}

// ---------------------------------------------------------------------------
// 种子数据（与 src/db.rs::seed_if_empty 对齐）
// ---------------------------------------------------------------------------

function seed() {
  var now = time.now();
  var db = {
    version: SEED_VERSION,
    classes: [],
    auths: [],
    submissions: [],
    uploads: [],
    replies: [],
    modes: [],
  };

  var c1 = newId("cls");
  var c2 = newId("cls");
  db.classes.push({
    id: c1,
    code: "G2603",
    name: "高一（3）班",
    desc: "2026 级 · 智慧校园示范班",
    created_at: now - 30 * 86400,
    created_by: null,
  });
  db.classes.push({
    id: c2,
    code: "G2601",
    name: "高二（1）班",
    desc: "2026 级 · 理科实验班",
    created_at: now - 25 * 86400,
    created_by: null,
  });

  function addAuth(key, classId, role, studentId, shortId, displayName) {
    var auth = {
      id: newId("auth"),
      key: key,
      class_id: classId,
      user_id: null,
      role: role,
      student_id: studentId || null,
      short_id: shortId === undefined ? null : shortId,
      display_name: displayName,
      created_at: now - 20 * 86400,
    };
    db.auths.push(auth);
    return auth;
  }

  var admin1 = addAuth(DEMO_KEYS.admin, c1, "admin", null, null, "赵明远");
  var admin2 = addAuth(DEMO_KEYS.admin2, c2, "admin", null, null, "赵明远");
  var teacher1 = addAuth(DEMO_KEYS.teacher, c1, "teacher", null, null, "林书言");
  addAuth(DEMO_KEYS.teacher2, c2, "teacher", null, null, "待认领教师");
  var stu1 = addAuth(DEMO_KEYS.student, c1, "student", "G2603-01", 1, "陈小满");
  var stu2 = addAuth(DEMO_KEYS.student2, c1, "student", "G2603-02", 2, "李知遥");
  var stu3 = addAuth(DEMO_KEYS.student3, c1, "student", "G2603-03", 3, "王浩然");
  var stuC2 = addAuth(DEMO_KEYS.studentC2, c2, "student", "G2601-01", 1, "周雨桐");

  function addSubmission(classId, name, desc, type, deadlineOffset, createdOffset, createdBy, createdName) {
    var sub = {
      id: newId("sub"),
      class_id: classId,
      name: name,
      desc: desc,
      type: type,
      deadline: deadlineOffset === null ? null : now + deadlineOffset,
      created_at: now + createdOffset,
      created_by: createdBy,
      created_name: createdName,
    };
    db.submissions.push(sub);
    return sub;
  }

  var subHomework = addSubmission(
    c1,
    "函数与导数 · 周末练习",
    "完成练习册 P42–P45，拍照上传完整的解题过程。重点复习导数的几何意义与链式法则。",
    "homework",
    2 * 86400 + 4 * 3600,
    -2 * 86400,
    teacher1.id,
    "林书言"
  );
  var subSports = addSubmission(
    c1,
    "秋季运动会报名",
    "10 月 30 日校园秋季运动会开始报名。请上传报名的项目与联系方式，每人最多报名两项。",
    "open call",
    4 * 86400,
    -20 * 3600,
    teacher1.id,
    "林书言"
  );
  var subLeave = addSubmission(
    c1,
    "研学活动请假申请",
    "11 月 5 日城市研学活动，无法参加的同学请提交请假申请并说明原因，需附家长签字。",
    "leave request",
    6 * 86400,
    -5 * 3600,
    teacher1.id,
    "林书言"
  );
  var subPhoto = addSubmission(
    c1,
    "校园摄影展作品征集",
    "主题：秋日校园。上传一张原创摄影作品，并附 100 字以内的作品说明。",
    "open call",
    -7 * 3600,
    -8 * 86400,
    teacher1.id,
    "林书言"
  );
  addSubmission(
    c1,
    "英语单元测验订正",
    "Unit 3 单元测验订正，请在错题旁写出正确选项与解析，周一前提交。",
    "homework",
    30 * 3600,
    -3 * 86400,
    teacher1.id,
    "林书言"
  );
  addSubmission(
    c2,
    "物理实验报告 · 伏安特性曲线",
    "完成测量小灯泡伏安特性曲线的实验报告，附上数据表与图像。",
    "homework",
    3 * 86400,
    -86400,
    admin2.id,
    "赵明远"
  );

  // 问卷与答题卡：体现 v0.1.4 / v0.1.5 的表单模式
  addSubmission(
    c1,
    "秋季社团报名问卷",
    "姓名：<input id=\"form_name\" required/>\n想参加的社团：<checkbox id=\"form_club\" value=\"math\"/>数学社 <checkbox id=\"form_club\" value=\"art\"/>美术社\n接收通知：<switch id=\"form_notify\"/>",
    "survey",
    5 * 86400,
    -86400,
    teacher1.id,
    "林书言"
  );
  addSubmission(
    c1,
    "导数小测答题卡",
    "1 + 1 = <input id=\"form_q1\" data-answer=\"2\" data-score=\"5\"/>\n选出正确答案：<checkbox id=\"form_q2\" value=\"a\" data-answer=\"b\" data-score=\"3\"/>A <checkbox id=\"form_q2\" value=\"b\"/>B\n地球是圆的：<switch id=\"form_q3\" data-answer=\"on\" data-score=\"2\"/>",
    "answer sheet",
    3 * 86400,
    -2 * 3600,
    teacher1.id,
    "林书言"
  );
  // 公示版：只展示详情，不开放提交
  addSubmission(
    c1,
    "本周校历与作息调整公示",
    "10 月 28 日起启用冬季作息：上午 8:00 上课，下午 17:10 放学；周五第七节调整为社团活动。",
    "notice",
    null,
    -6 * 3600,
    teacher1.id,
    "林书言"
  );

  function addUpload(sub, auth, title, desc, data, createdOffset) {
    var up = {
      id: newId("up"),
      submission_id: sub.id,
      class_id: sub.class_id,
      auth_id: auth.id,
      user_id: null,
      student_id: auth.role === "student" ? auth.student_id : null,
      short_id: auth.role === "student" ? auth.short_id : null,
      uploader_name: identity(auth),
      role: auth.role,
      title: title,
      desc: desc,
      data: data,
      created_at: now + createdOffset,
    };
    db.uploads.push(up);
    return up;
  }

  var up1 = addUpload(
    subHomework,
    stu1,
    "周末练习 · 第 1 页",
    "完成练习册 P42–P45，第 3 题不太确定。",
    [demo.image("homework", "周末练习-第1页.png"), DEMO_TEXT.process],
    -3 * 3600
  );
  var up2 = addUpload(
    subHomework,
    stu2,
    "李知遥的周末练习",
    "已完成，请老师检查。",
    [demo.image("homework", "李知遥-周末练习.png")],
    -70 * 60
  );
  var up3 = addUpload(
    subSports,
    stu3,
    "运动会报名：100m / 跳远",
    "报名 100 米和跳远，联系方式：138****6721。",
    [DEMO_TEXT.sports],
    -40 * 60
  );
  var up4 = addUpload(
    subLeave,
    stu1,
    "研学活动请假申请",
    "因家庭安排无法参加 11 月 5 日研学活动，家长已签字。",
    [demo.image("leave", "请假申请.png")],
    -25 * 60
  );
  var up5 = addUpload(
    subPhoto,
    stu2,
    "秋日校园 · 银杏大道",
    "拍摄于周三傍晚的银杏大道，逆光下的落叶很有层次。",
    [demo.image("photo", "秋日校园-银杏大道.png")],
    -10 * 3600
  );

  function addReply(upload, auth, content, createdOffset) {
    db.replies.push({
      id: newId("rep"),
      upload_id: upload.id,
      auth_id: auth.id,
      replier_name: identity(auth),
      role: auth.role,
      content: content,
      created_at: now + createdOffset,
    });
  }

  addReply(
    up1,
    teacher1,
    "整体完成得很好：第 1、2 题步骤完整。第 3 题注意链式法则，已在上传第 2 页标出。",
    -2 * 3600
  );
  addReply(up4, admin1, "已收到，课程笔记和研学手册请于返校后到教务处补领。", -10 * 60);
  addReply(up5, teacher1, "构图和光影都不错，建议投稿到本次摄影展。", -9 * 3600);

  // 第二个班级的提交（用于验证「一个 auth 只属于一个班级」）
  addUpload(
    db.submissions[5],
    stuC2,
    "伏安特性曲线实验报告",
    "数据表和图像已整理，误差分析还需要补充。",
    [demo.image("homework", "物理实验报告.png")],
    -2 * 3600
  );

  return db;
}

// ---------------------------------------------------------------------------
// 存取
// ---------------------------------------------------------------------------

function load() {
  var db = storage.readJson(DB_KEY, null);
  if (!db || db.version !== SEED_VERSION || !Array.isArray(db.classes)) {
    db = seed();
    storage.writeJson(DB_KEY, db);
  }
  if (!Array.isArray(db.modes)) db.modes = [];
  return db;
}

function save(db) {
  storage.writeJson(DB_KEY, db);
}

function reset() {
  var db = seed();
  storage.writeJson(DB_KEY, db);
  // 账号（用户 / 公钥 / 绑定的密钥）与业务演示数据分开存放：重置演示数据不会把账号清掉，
  // 与真实服务「重启后业务数据仍在、账号仍是同一批」的行为一致。
  loadUsers();
  return db;
}

// ---------------------------------------------------------------------------
// 账号（与 src/db.rs 的 users 表对齐，离线模拟使用）
// ---------------------------------------------------------------------------

var USERS_KEY = "sc.mp.mock.users.v1";
var USERS_VERSION = 1;
var LOGIN_SESSION_TTL = 300;
var MAX_LOGIN_ATTEMPTS = 5;

// 与 src/db.rs 的 DEMO_*_PUBKEY 完全一致；离线登录也走同一套 X25519 挑战协议。
var DEMO_PUBKEYS = {
  admin: "aJ2+2QZhfvj/e30rH+si+J3e8gIbllhrAryrw8ou5BY=",
  teacher: "twPKqsL5RPHwLOWAbZw09o7CpwwoXCba+V0bJGkHMAw=",
  student: "3zcMdg6sj9+9nhW6FO2LVc48RxItRNw/YkXvZEnofVE=",
};

var loginSessions = {};

function seedUsers() {
  return {
    version: USERS_VERSION,
    nextUserId: 4,
    users: [
      {
        id: 1,
        username: "admin",
        display_name: "赵明远",
        pubkey: DEMO_PUBKEYS.admin,
        keys: [DEMO_KEYS.admin, DEMO_KEYS.admin2],
        salt: "",
        pwhash: "",
      },
      {
        id: 2,
        username: "teacher",
        display_name: "林书言",
        pubkey: DEMO_PUBKEYS.teacher,
        keys: [DEMO_KEYS.teacher],
        salt: "",
        pwhash: "",
      },
      {
        id: 3,
        username: "student",
        display_name: "陈小满",
        pubkey: DEMO_PUBKEYS.student,
        keys: [DEMO_KEYS.student],
        salt: "",
        pwhash: "",
      },
    ],
  };
}

function loadUsers() {
  var store = storage.readJson(USERS_KEY, null);
  if (!store || store.version !== USERS_VERSION || !Array.isArray(store.users)) {
    store = seedUsers();
    storage.writeJson(USERS_KEY, store);
  }
  return store;
}

function saveUsers(store) {
  storage.writeJson(USERS_KEY, store);
  return store;
}

function resetUsers() {
  loginSessions = {};
  return saveUsers(seedUsers());
}

function findUserByName(store, username) {
  var target = String(username === null || username === undefined ? "" : username)
    .trim()
    .toLowerCase();
  if (!target) return null;
  for (var i = 0; i < store.users.length; i++) {
    if (String(store.users[i].username).toLowerCase() === target) return store.users[i];
  }
  return null;
}

function keyClaimed(store, key) {
  var target = String(key || "").trim();
  return store.users.some(function (u) {
    return (u.keys || []).some(function (k) {
      return k === target;
    });
  });
}

function decodeBytes(value) {
  if (typeof value === "string") {
    try {
      return authcrypto.b64decode(value);
    } catch (e) {
      return null;
    }
  }
  if (Array.isArray(value)) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) {
      var n = value[i];
      if (typeof n !== "number" || n < 0 || n > 255 || Math.floor(n) !== n) return null;
      out[i] = n;
    }
    return out;
  }
  return null;
}

function decodePubkey(input) {
  var bytes = decodeBytes(input);
  if (!bytes || bytes.length !== authcrypto.KEY_LEN) {
    return { ok: false, msg: "public key must be 32 bytes" };
  }
  if (!authcrypto.validatePublicKey(bytes)) {
    return { ok: false, msg: "invalid X25519 public key" };
  }
  return { ok: true, value: authcrypto.b64encode(bytes) };
}

var USERNAME_CHARS = null;
try {
  USERNAME_CHARS = new RegExp("^[\\p{L}\\p{N}_-]+$", "u");
} catch (e) {
  USERNAME_CHARS = /^[A-Za-z0-9_\-\u00A0-\uFFFF]+$/;
}

function validUsername(name) {
  var chars = Array.from(String(name === null || name === undefined ? "" : name).trim());
  if (chars.length < 2 || chars.length > 32) return false;
  return USERNAME_CHARS.test(chars.join(""));
}

function normalizeDisplayName(raw, fallback) {
  var name = String(raw === null || raw === undefined ? "" : raw).trim();
  if (!name) return { ok: true, value: fallback };
  if (Array.from(name).length > 40) return { ok: false, msg: "name is too long (max 40 characters)" };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    return { ok: false, msg: "name must not contain control characters" };
  }
  return { ok: true, value: name };
}

/** 旧数据库密码哈希（与 src/tools.rs::hash_password 相同），仅用于 upgrade-pubkey。 */
function legacyPasswordHash(salt, password) {
  var digest = authcrypto.sha256(authcrypto.utf8(salt + ":" + password));
  for (var i = 0; i < 15000; i++) {
    digest = authcrypto.sha256(authcrypto.concatBytes([digest, authcrypto.utf8(salt)]));
  }
  return authcrypto.bytesToHex(digest);
}

function classById(db, id) {
  for (var i = 0; i < db.classes.length; i++) {
    if (db.classes[i].id === id) return db.classes[i];
  }
  return null;
}

function userAuths(db, user) {
  var out = [];
  (user.keys || []).forEach(function (key) {
    var auth = loadAuthByKey(db, key);
    if (!auth) return;
    var cls = classById(db, auth.class_id);
    out.push({
      id: auth.id,
      key: auth.key,
      classID: auth.class_id,
      className: cls ? cls.name : "",
      role: auth.role,
      studentID: auth.student_id === null || auth.student_id === undefined ? "" : auth.student_id,
      shortStudentID: auth.short_id === null || auth.short_id === undefined ? 0 : auth.short_id,
      displayName: auth.display_name,
    });
  });
  return out;
}

function loginFailure(status, msg, code) {
  var out = fail(status, msg);
  if (code) out.code = code;
  return out;
}

function verifyLoginAnswer(body) {
  var sessionId = body.loginSessionID;
  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, response: fail(422, "loginSessionID: invalid type") };
  }
  var session = loginSessions[sessionId];
  if (!session) return { ok: false, response: fail(401, "invalid or expired login session") };
  var now = time.now();
  if (now - session.created_at > LOGIN_SESSION_TTL) {
    delete loginSessions[sessionId];
    return { ok: false, response: fail(401, "login session expired") };
  }
  var decoded = decodeBytes(body.encryptedAnswer);
  if (!decoded) return { ok: false, response: fail(400, "invalid base64 character") };
  var answerLen = authcrypto.NONCE_LEN + authcrypto.CHALLENGE_LEN + authcrypto.TAG_LEN;
  var validLength = decoded.length === answerLen;
  var okAnswer = false;
  if (validLength) {
    try {
      var plain = authcrypto.aesGcmOpen(
        session.answer_key,
        decoded.subarray(0, authcrypto.NONCE_LEN),
        decoded.subarray(authcrypto.NONCE_LEN)
      );
      okAnswer = authcrypto.constantTimeEqual(plain, session.challenge);
    } catch (e) {
      okAnswer = false;
    }
  }
  if (!okAnswer) {
    session.attempts = (session.attempts || 0) + 1;
    if (session.attempts >= MAX_LOGIN_ATTEMPTS) delete loginSessions[sessionId];
    return {
      ok: false,
      response: validLength
        ? fail(401, "encrypted answer verification failed")
        : fail(400, "encryptedAnswer has an invalid length"),
    };
  }
  session.verified = true;
  return { ok: true, session: session };
}

function register(db, body) {
  var rawName = body.username;
  if (typeof rawName !== "string") return fail(422, "username: invalid type");
  var username = rawName.trim();
  if (!validUsername(username)) {
    return fail(400, "username must be 2-32 characters and contain only letters, digits, _ or -");
  }
  var keyInput =
    body.passwordPubKey !== undefined
      ? body.passwordPubKey
      : body.pubkey !== undefined
        ? body.pubkey
        : body.publicKey;
  var pub = decodePubkey(keyInput);
  if (!pub.ok) return fail(400, pub.msg);
  var display = normalizeDisplayName(body.displayName, username);
  if (!display.ok) return fail(400, display.msg);

  var store = loadUsers();
  if (findUserByName(store, username)) {
    return loginFailure(400, "username already exists", "username_taken");
  }
  var key = typeof body.key === "string" ? body.key.trim() : "";
  if (key) {
    if (!loadAuthByKey(db, key)) return fail(400, "invalid key");
    if (keyClaimed(store, key)) return fail(400, "this key is already bound to another account");
  }
  var user = {
    id: store.nextUserId++,
    username: username,
    display_name: display.value,
    pubkey: pub.value,
    keys: key ? [key] : [],
    salt: "",
    pwhash: "",
  };
  store.users.push(user);
  saveUsers(store);
  return ok({
    id: user.id,
    userID: user.id,
    username: user.username,
    displayName: user.display_name,
    boundAuth: key || null,
  });
}

function logintry(db, body) {
  var rawName = body.username;
  if (typeof rawName !== "string") return fail(422, "username: invalid type");
  var username = rawName.trim();
  if (!username) return fail(400, "username must not be empty");
  var store = loadUsers();
  var user = findUserByName(store, username);
  if (!user) return fail(401, "invalid username or account does not exist");
  if (!user.pubkey) {
    return loginFailure(
      401,
      "this account has no public key yet; upgrade the login first",
      "pubkey_missing"
    );
  }
  var pub = decodeBytes(user.pubkey);
  if (!pub || pub.length !== authcrypto.KEY_LEN) {
    return fail(500, "stored public key is invalid");
  }
  var challenge = authcrypto.randomBytes(authcrypto.CHALLENGE_LEN);
  var answerKey = authcrypto.randomBytes(authcrypto.KEY_LEN);
  var challengeEncrypt;
  try {
    challengeEncrypt = authcrypto.encryptChallenge(pub, challenge);
  } catch (e) {
    return fail(500, "challenge key agreement failed");
  }
  var now = time.now();
  Object.keys(loginSessions).forEach(function (id) {
    if (now - loginSessions[id].created_at > LOGIN_SESSION_TTL) delete loginSessions[id];
  });
  var sessionId = "login_" + randString(32);
  loginSessions[sessionId] = {
    user_id: user.id,
    challenge: challenge,
    answer_key: answerKey,
    created_at: now,
    attempts: 0,
    verified: false,
  };
  return ok({
    loginSessionID: sessionId,
    challengeEncrypt: authcrypto.b64encode(challengeEncrypt),
    answerEncryptingKey: authcrypto.b64encode(answerKey),
    expiresIn: LOGIN_SESSION_TTL,
    username: user.username,
    displayName: user.display_name,
    kdf: {
      name: "PBKDF2-HMAC-SHA256",
      iterations: authcrypto.KDF_ITERATIONS,
      salt: authcrypto.defaultSalt(user.username),
      privateKey: "X25519",
      challengeEncryption: "X25519-HKDF-SHA256-AES-256-GCM",
      answerEncryption: "AES-256-GCM",
    },
  });
}

function getAuths(db, body) {
  var verified = verifyLoginAnswer(body);
  if (!verified.ok) return verified.response;
  var store = loadUsers();
  var user = null;
  store.users.forEach(function (u) {
    if (u.id === verified.session.user_id) user = u;
  });
  if (!user) return fail(401, "account no longer exists");
  var members = userAuths(db, user);
  return ok({
    auths: members.map(function (m) {
      return m.key;
    }),
    authIDs: members.map(function (m) {
      return m.id;
    }),
    members: members,
    user: { id: user.id, username: user.username, displayName: user.display_name },
  });
}

function resetPassword(db, body) {
  var verified = verifyLoginAnswer(body);
  if (!verified.ok) return verified.response;
  var pub = decodePubkey(body.newPasswordPubKey);
  if (!pub.ok) return fail(400, pub.msg);
  var store = loadUsers();
  var user = null;
  store.users.forEach(function (u) {
    if (u.id === verified.session.user_id) user = u;
  });
  if (!user) return fail(401, "account no longer exists");
  user.pubkey = pub.value;
  user.salt = "";
  user.pwhash = "";
  saveUsers(store);
  Object.keys(loginSessions).forEach(function (id) {
    if (loginSessions[id].user_id === user.id) delete loginSessions[id];
  });
  return ok({ msg: "password reset" });
}

function upgradePubkey(db, body) {
  var username = typeof body.username === "string" ? body.username.trim() : "";
  var password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) return fail(400, "username and password are required");
  var pub = decodePubkey(body.pubkey);
  if (!pub.ok) return fail(400, pub.msg);
  var store = loadUsers();
  var user = findUserByName(store, username);
  if (!user) return fail(401, "invalid username or password");
  // 与 src/api.rs::upgrade_pubkey 一致：先校验旧密码哈希，再判断是否已有公钥。
  if (!user.pwhash || legacyPasswordHash(user.salt, password) !== user.pwhash) {
    return fail(401, "invalid username or password");
  }
  if (user.pubkey) return fail(400, "this account already has a public key");
  user.pubkey = pub.value;
  user.salt = "";
  user.pwhash = "";
  saveUsers(store);
  return ok({ msg: "public key upgraded", username: user.username });
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

function loadAuthByKey(db, key) {
  var target = String(key === null || key === undefined ? "" : key).trim();
  if (!target) return null;
  for (var i = 0; i < db.auths.length; i++) {
    if (db.auths[i].key === target) return db.auths[i];
  }
  // 与 db.rs::load_auth_by_key 一致：小写/混合大小写输入按大写再查一次。
  var upper = target.toUpperCase();
  if (upper !== target) {
    for (var j = 0; j < db.auths.length; j++) {
      if (db.auths[j].key === upper) return db.auths[j];
    }
  }
  return null;
}

function loadAuthById(db, id) {
  for (var i = 0; i < db.auths.length; i++) {
    if (db.auths[i].id === id) return db.auths[i];
  }
  return null;
}

function submissionsOf(db, classId) {
  return db.submissions.filter(function (s) {
    return s.class_id === classId;
  });
}

function uploadsOfSubmission(db, submissionId) {
  return db.uploads.filter(function (u) {
    return u.submission_id === submissionId;
  });
}

function repliesOfUpload(db, uploadId) {
  return db.replies
    .filter(function (r) {
      return r.upload_id === uploadId;
    })
    .sort(function (a, b) {
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

function hasReply(db, uploadId) {
  return db.replies.some(function (r) {
    return r.upload_id === uploadId;
  });
}

var NOTICE_RE = /^\s*notice\s*$/i;

var BUILTIN_BEHAVIOR_MODES = [
  "homework",
  "open call",
  "leave request",
  "survey",
  "answer sheet",
  "notice",
  "other",
];

var BUILTIN_TRAIT_MODES = [
  "hidden",
  "teacher only",
  "admin only",
  "invisible",
  "separate list",
];

var BUILTIN_MODES = BUILTIN_BEHAVIOR_MODES.concat(BUILTIN_TRAIT_MODES);

function normalizeModeName(raw) {
  return String(raw === null || raw === undefined ? "" : raw)
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function builtinMode(normalized) {
  if (normalized === "homework") return "homework";
  if (normalized === "open call" || normalized === "opencall") return "open call";
  if (normalized === "leave request" || normalized === "leaverequest") return "leave request";
  if (normalized === "survey") return "survey";
  if (normalized === "answer sheet" || normalized === "answersheet" || normalized === "sheet") {
    return "answer sheet";
  }
  if (normalized === "notice") return "notice";
  if (normalized === "other") return "other";
  if (normalized === "hidden" || normalized === "hidden submission" || normalized === "hide" ||
      normalized === "隐藏" || normalized === "隐藏征集") return "hidden";
  if (normalized === "teacher only" || normalized === "teachers only" || normalized === "teacher" ||
      normalized === "仅教师" || normalized === "仅教师征集") return "teacher only";
  if (normalized === "admin only" || normalized === "admins only" ||
      normalized === "administrator only" || normalized === "仅管理员" ||
      normalized === "仅管理员征集") return "admin only";
  if (normalized === "invisible" || normalized === "not listed" || normalized === "not shown" ||
      normalized === "不显示" || normalized === "不显示征集") return "invisible";
  if (normalized === "separate list" || normalized === "separate lists" ||
      normalized === "listed separately" || normalized === "list separately" ||
      normalized === "separately listed" || normalized === "单独列出" ||
      normalized === "单独列出征集") return "separate list";
  return null;
}

function defaultModeFlags() {
  return {
    hidden: false,
    teacherOnly: false,
    adminOnly: false,
    invisible: false,
    separateList: false,
    abstract: false,
  };
}

function builtinModeFlags(canonical) {
  var flags = defaultModeFlags();
  if (canonical === "hidden") flags.hidden = true;
  else if (canonical === "teacher only") flags.teacherOnly = true;
  else if (canonical === "admin only") flags.adminOnly = true;
  else if (canonical === "invisible") flags.invisible = true;
  else if (canonical === "separate list") {
    flags.separateList = true;
    flags.abstract = true;
  }
  return flags;
}

function builtinModeDisplayName(canonical) {
  var key = {
    "homework": "type_homework",
    "open call": "type_open_call",
    "leave request": "type_leave_request",
    "survey": "type_survey",
    "answer sheet": "type_answer_sheet",
    "notice": "type_notice",
    "other": "type_other",
    "hidden": "type_hidden",
    "teacher only": "type_teacher_only",
    "admin only": "type_admin_only",
    "invisible": "type_invisible",
    "separate list": "type_separate_list",
  }[canonical];
  return key ? strings.t(key) : strings.t("type_generic");
}

function builtinModeInfo(canonical) {
  return {
    id: "builtin_" + canonical.replace(/ /g, "_"),
    name: canonical,
    normalized: canonical,
    displayName: builtinModeDisplayName(canonical),
    baseType: BUILTIN_BEHAVIOR_MODES.indexOf(canonical) >= 0 ? canonical : "other",
    extendModes: [],
    inheritModes: [canonical],
    flags: builtinModeFlags(canonical),
    builtin: true,
  };
}

function classModesOf(db, classId) {
  return (db.modes || []).filter(function (m) {
    return m.class_id === classId;
  });
}

function flagsOfModeRow(row) {
  if (row.flags) return row.flags;
  return {
    hidden: !!row.hidden,
    teacherOnly: !!(row.teacher_only || row.teacherOnly),
    adminOnly: !!(row.admin_only || row.adminOnly),
    invisible: !!row.invisible,
    separateList: !!(row.separate_list || row.separateList),
    abstract: !!(row.abstract_mode || row.abstract),
  };
}

function mergeFlags(target, parent) {
  target.hidden = target.hidden || parent.hidden;
  target.teacherOnly = target.teacherOnly || parent.teacherOnly;
  target.adminOnly = target.adminOnly || parent.adminOnly;
  target.invisible = target.invisible || parent.invisible;
  target.separateList = target.separateList || parent.separateList;
  return target;
}

function findMode(db, classId, raw, visiting) {
  var normalized = normalizeModeName(raw);
  if (!normalized) return null;
  var builtin = builtinMode(normalized);
  if (builtin) return builtinModeInfo(builtin);
  var seen = visiting || [];
  if (seen.indexOf(normalized) >= 0) return null;
  var found = null;
  classModesOf(db, classId).forEach(function (m) {
    if (m.normalized === normalized) found = m;
  });
  if (!found) return null;
  var flags = flagsOfModeRow(found);
  var extend = found.extend_modes || [];
  var ancestors = [normalized];
  var nextSeen = seen.concat([normalized]);
  extend.forEach(function (parent) {
    var info = findMode(db, classId, parent, nextSeen);
    if (!info) return;
    mergeFlags(flags, info.flags);
    (info.inheritModes || info.ancestors || [info.normalized]).forEach(function (a) {
      if (ancestors.indexOf(a) < 0) ancestors.push(a);
    });
  });
  return {
    id: found.id,
    name: found.name,
    normalized: found.normalized,
    displayName: found.display_name || found.displayName || found.name,
    baseType: found.base_type || found.baseType || "other",
    extendModes: extend,
    inheritModes: ancestors,
    ancestors: ancestors,
    flags: flags,
    builtin: false,
    createdAt: found.created_at ? time.fmtISO(found.created_at) : "",
    createdBy: found.created_name || "",
  };
}

function listAllModes(db, classId) {
  var out = BUILTIN_MODES.map(function (name) {
    return builtinModeInfo(name);
  });
  classModesOf(db, classId).forEach(function (row) {
    var info = findMode(db, classId, row.normalized);
    if (info) out.push(info);
  });
  return out;
}

function modeInfoJson(info) {
  return {
    id: info.builtin ? info.id : info.id || info.normalized,
    name: info.name,
    modeName: info.name,
    displayName: info.displayName || info.name,
    normalized: info.normalized,
    baseType: info.baseType,
    extendModes: info.extendModes || [],
    inheritModes: info.inheritModes || info.ancestors || [info.normalized],
    builtin: !!info.builtin,
    hidden: !!info.flags.hidden,
    teacherOnly: !!info.flags.teacherOnly,
    adminOnly: !!info.flags.adminOnly,
    invisible: !!info.flags.invisible,
    separateList: !!info.flags.separateList,
    abstract: !!info.flags.abstract,
    flags: info.flags,
    visibility: info.flags.adminOnly
      ? "admin_only"
      : info.flags.teacherOnly
      ? "teacher_only"
      : info.flags.invisible
      ? "invisible"
      : info.flags.hidden
      ? "hidden"
      : "normal",
    createdAt: info.createdAt || "",
    createdBy: info.createdBy || "",
  };
}

function modeCanView(flags, role) {
  if (flags.adminOnly) return role === "admin";
  if (flags.teacherOnly) return role === "teacher" || role === "admin";
  return true;
}

function modeListed(flags, role, showHiddens) {
  return modeCanView(flags, role) && !flags.invisible && (!flags.hidden || showHiddens);
}
function flagsOfSubmission(db, classId, sub) {
  var info = findMode(db, classId, sub.type);
  var modeFlags = info ? info.flags : defaultModeFlags();
  return {
    hidden: !!modeFlags.hidden || !!sub.hidden,
    teacherOnly: !!modeFlags.teacherOnly || !!sub.teacher_only || !!sub.teacherOnly,
    adminOnly: !!modeFlags.adminOnly || !!sub.admin_only || !!sub.adminOnly,
    invisible: !!modeFlags.invisible || !!sub.invisible,
    separateList: !!modeFlags.separateList || !!sub.separate_list || !!sub.separateList,
    abstract: !!modeFlags.abstract,
  };
}


function truthy(value) {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return /^(1|true|yes|on|show)$/i.test(value.trim());
  }
  return false;
}

function effectiveKind(sub) {
  var base = String(sub.base_type || "").trim();
  return base || String(sub.type || "");
}

function isNotice(sub) {
  return NOTICE_RE.test(effectiveKind(sub));
}

/** 与 db.rs 的 ORDER BY 等价：公示置顶、过期靠后、无截止时间最后、截止升序、创建倒序 */
function sortSubmissions(rows, now) {
  return rows.slice().sort(function (a, b) {
    var aPinned = isNotice(a) && (a.deadline === null || a.deadline > now) ? 0 : 1;
    var bPinned = isNotice(b) && (b.deadline === null || b.deadline > now) ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;
    var aExpired = a.deadline !== null && a.deadline < now ? 1 : 0;
    var bExpired = b.deadline !== null && b.deadline < now ? 1 : 0;
    if (aExpired !== bExpired) return aExpired - bExpired;
    var aNull = a.deadline === null ? 1 : 0;
    var bNull = b.deadline === null ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    if (a.deadline !== b.deadline) return a.deadline - b.deadline;
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function sortUploadsNewestFirst(rows) {
  return rows.slice().sort(function (a, b) {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

function submissionRow(db, auth, sub, now) {
  var staff = auth.role !== "student";
  var uploads = uploadsOfSubmission(db, sub.id);
  var own = staff
    ? uploads
    : uploads.filter(function (u) {
        return u.auth_id === auth.id;
      });
  var pending = own.filter(function (u) {
    return !hasReply(db, u.id);
  });
  var sorted = sortUploadsNewestFirst(own);
  var mode = findMode(db, auth.class_id, sub.type);
  var flags = mode ? mode.flags : defaultModeFlags();
  flags = {
    hidden: !!flags.hidden || !!sub.hidden,
    teacherOnly: !!flags.teacherOnly || !!sub.teacher_only || !!sub.teacherOnly,
    adminOnly: !!flags.adminOnly || !!sub.admin_only || !!sub.adminOnly,
    invisible: !!flags.invisible || !!sub.invisible,
    separateList: !!flags.separateList || !!sub.separate_list || !!sub.separateList,
    abstract: !!flags.abstract,
  };
  return {
    id: sub.id,
    name: sub.name,
    desc: sub.desc,
    deadLine: sub.deadline === null ? null : time.fmtISO(sub.deadline),
    type: sub.type,
    displayName: mode ? mode.displayName : sub.type,
    typeDisplayName: mode ? mode.displayName : sub.type,
    baseType: effectiveKind(sub),
    hidden: !!flags.hidden,
    teacherOnly: !!flags.teacherOnly,
    adminOnly: !!flags.adminOnly,
    invisible: !!flags.invisible,
    separateList: !!flags.separateList,
    abstract: !!flags.abstract,
    flags: flags,
    inheritModes: mode ? mode.inheritModes : [normalizeModeName(sub.type)],
    createdAt: time.fmtISO(sub.created_at),
    createdBy: sub.created_name,
    createdByID: sub.created_by || null,
    uploadCount: own.length,
    myUploadCount: staff ? 0 : own.length,
    pendingCount: pending.length,
    latestUploadID: sorted.length ? sorted[0].id : null,
  };
}

function downloadRow(db, upload) {
  var replies = repliesOfUpload(db, upload.id);
  return {
    id: upload.id,
    submissionID: upload.submission_id,
    studentID: upload.student_id || "",
    shortStudentID: upload.short_id || 0,
    title: upload.title,
    desc: upload.desc,
    data: upload.data,
    reply: replies.map(function (r) {
      return r.content;
    }),
    replyIDs: replies.map(function (r) {
      return r.id;
    }),
    uploader: upload.uploader_name,
    role: upload.role,
    createdAt: time.fmtISO(upload.created_at),
  };
}

/** 个人视角的提交行：包含所属征集与「我发布的征集」标记。 */
function uploadApiRow(db, upload) {
  var row = downloadRow(db, upload);
  var sub = null;
  for (var i = 0; i < db.submissions.length; i++) {
    if (db.submissions[i].id === upload.submission_id) sub = db.submissions[i];
  }
  row.submissionName = sub ? sub.name : "";
  row.submissionCreatedBy = sub ? sub.created_by || null : null;
  row.submissionCreatedName = sub ? sub.created_name || "" : "";
  return row;
}

// ---------------------------------------------------------------------------
// 接口实现
// ---------------------------------------------------------------------------

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function missingField(name) {
  return fail(422, "missing field `" + name + "`");
}

function invalidType(name, expected) {
  return fail(422, "invalid type for field `" + name + "`: expected " + expected);
}

/** serde 语义的字符串字段：字段缺失用 fallback；字段存在但不是字符串则 422。
 *  names 为别名列表（第一个是规范名，用于错误信息）。 */
function stringField(body, names, fallback) {
  var present = null;
  for (var i = 0; i < names.length; i++) {
    if (body && hasOwn(body, names[i])) {
      present = names[i];
      break;
    }
  }
  if (present === null) return { ok: true, value: fallback };
  var raw = body[present];
  if (typeof raw === "string") return { ok: true, value: raw };
  return { ok: false, error: invalidType(names[0], "a string") };
}

/** serde 语义的必填字符串字段：缺失或类型错误都返回 422。 */
function requiredStringField(body, names) {
  var res = stringField(body, names, undefined);
  if (!res.ok) return res;
  if (res.value === undefined) return { ok: false, error: missingField(names[0]) };
  return res;
}

/** serde 语义的 i64 字段：只接受 JSON 整数。 */
function integerField(body, names) {
  var present = null;
  for (var i = 0; i < names.length; i++) {
    if (body && hasOwn(body, names[i])) {
      present = names[i];
      break;
    }
  }
  if (present === null) return { ok: false, error: missingField(names[0]) };
  var raw = body[present];
  if (typeof raw === "number" && isFinite(raw) && Math.floor(raw) === raw) {
    return { ok: true, value: raw };
  }
  return { ok: false, error: invalidType(names[0], "an integer") };
}

function requireAuth(db, body) {
  if (!body || !hasOwn(body, "auth")) {
    return { error: missingField("auth") };
  }
  if (typeof body.auth !== "string") {
    return { error: invalidType("auth", "a string") };
  }
  var key = body.auth;
  if (!key.trim()) return { error: fail(401, "missing auth parameter") };
  var auth = loadAuthByKey(db, key);
  if (!auth) return { error: fail(401, "invalid or expired auth") };
  return { auth: auth };
}

/** del-object 的 auth 是 `Option<String>`：缺失 / null / 空串都回退到「未登录」，
 *  非字符串则是 422（与 serde 一致）。 */
function optionalAuth(db, body) {
  if (!body || !hasOwn(body, "auth") || body.auth === null) return { auth: null };
  if (typeof body.auth !== "string") return { error: invalidType("auth", "a string") };
  var key = body.auth;
  if (!key.trim()) return { auth: null };
  var auth = loadAuthByKey(db, key);
  if (!auth) return { error: fail(401, "invalid or expired auth") };
  return { auth: auth };
}

function upload(db, body) {
  // serde 先于业务校验执行：字段缺失 / 类型错误统一返回 422。
  var whichRes = requiredStringField(body, ["which"]);
  if (!whichRes.ok) return whichRes.error;
  var titleRes = requiredStringField(body, ["title"]);
  if (!titleRes.ok) return titleRes.error;
  var descRes = stringField(body, ["desc"], "");
  if (!descRes.ok) return descRes.error;

  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;

  var title = titleRes.value.trim();
  var desc = descRes.value.trim();
  if (!title) return fail(400, "title must not be empty");
  if (charCount(title) > MAX_TITLE) return fail(400, "title is too long (max " + MAX_TITLE + " characters)");
  if (charCount(desc) > MAX_DESC) return fail(400, "desc is too long (max " + MAX_DESC + " characters)");

  var normalized = attachments.normalizeData(body.data === undefined ? null : body.data);
  if (!normalized.ok) return fail(400, normalized.msg);

  // 与 api.rs 一致：which 按原样匹配（不 trim）。
  var which = whichRes.value;
  var sub = null;
  for (var i = 0; i < db.submissions.length; i++) {
    if (db.submissions[i].id === which) sub = db.submissions[i];
  }
  if (!sub) return fail(404, "submission not found");
  if (sub.class_id !== auth.class_id) {
    return fail(404, "submission does not belong to the current class");
  }
  if (isNotice(sub)) return fail(403, "uploads are disabled for notice submissions");
  var surveyError = survey.validateSubmission(effectiveKind(sub), sub.desc, desc);
  if (surveyError) return fail(400, surveyError);

  var id = newId("up");
  db.uploads.push({
    id: id,
    submission_id: sub.id,
    class_id: auth.class_id,
    auth_id: auth.id,
    user_id: auth.user_id || null,
    student_id: auth.role === "student" ? auth.student_id : null,
    short_id: auth.role === "student" ? auth.short_id : null,
    uploader_name: identity(auth),
    role: auth.role,
    title: title,
    desc: desc,
    data: normalized.value,
    created_at: time.now(),
  });
  return ok({ id: id });
}

function download(db, body) {
  var whichRes = requiredStringField(body, ["which"]);
  if (!whichRes.ok) return whichRes.error;

  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role === "student") {
    return fail(403, "only teachers or admins can download class submissions");
  }
  var parsed = matchmode.parseMatchMode(
    body.match_mode !== undefined ? body.match_mode : body.matchMode
  );
  if (!parsed.ok) return fail(400, parsed.msg);

  var which = whichRes.value;
  var sub = null;
  for (var i = 0; i < db.submissions.length; i++) {
    if (db.submissions[i].id === which) sub = db.submissions[i];
  }
  if (!sub) return fail(404, "submission not found");
  if (sub.class_id !== auth.class_id) {
    return fail(404, "submission does not belong to the current class");
  }

  // 与 db.rs::list_download_uploads 一致：按提交时间升序
  var rows = uploadsOfSubmission(db, sub.id).sort(function (a, b) {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  var mode = parsed.value;
  if (mode.type === "Random") {
    var picked = matchmode.applyMode(mode, rows);
    if (!picked.ok) return fail(400, picked.msg);
    rows = picked.rows;
  } else if (mode.type === "StudentID") {
    rows = rows.filter(function (u) {
      return (u.student_id || "") === mode.id;
    });
  } else if (mode.type === "ShortStudentID") {
    rows = rows.filter(function (u) {
      return (u.short_id || 0) === mode.id;
    });
  } else if (mode.type === "TitleReGex") {
    var applied = matchmode.applyMode(mode, rows, { titleKey: "title" });
    if (!applied.ok) return fail(400, applied.msg);
    rows = applied.rows;
  } else if (mode.type === "Before") {
    rows = rows.filter(function (u) {
      return u.created_at < mode.time;
    });
  }

  return ok({
    datas: rows.map(function (u) {
      return downloadRow(db, u);
    }),
  });
}

function allSubmission(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  var parsed = matchmode.parseMatchMode(
    body.match_mode !== undefined ? body.match_mode : body.matchMode
  );
  if (!parsed.ok) return fail(400, parsed.msg);

  var now = time.now();
  var showHiddens = truthy(
    body["show-hiddens"] !== undefined
      ? body["show-hiddens"]
      : body.showHiddens !== undefined
      ? body.showHiddens
      : body.show_hiddens
  );
  var category = String(
    body.category !== undefined
      ? body.category
      : body.tab !== undefined
      ? body.tab
      : body.separateList !== undefined
      ? body.separateList
      : ""
  ).trim();

  var directId = String(
    body.submissionID !== undefined
      ? body.submissionID
      : body.submission_id !== undefined
      ? body.submission_id
      : body.submissionId !== undefined
      ? body.submissionId
      : body.which !== undefined
      ? body.which
      : body.id !== undefined
      ? body.id
      : ""
  ).trim();
  if (directId) {
    var directSub = null;
    submissionsOf(db, auth.class_id).forEach(function (sub) {
      if (sub.id === directId) directSub = sub;
    });
    if (!directSub) return fail(404, "submission not found");
    if (!modeCanView(flagsOfSubmission(db, auth.class_id, directSub), auth.role)) {
      return fail(404, "submission not found");
    }
    var directRow = submissionRow(db, auth, directSub, now);
    return ok({
      datas: [directRow],
      tabs: [],
      separateLists: [],
      showHiddens: showHiddens,
      category: category,
      direct: true,
    });
  }

  // 可见性过滤 + 单独列出标签页。
  var visibleSubs = submissionsOf(db, auth.class_id).filter(function (sub) {
    return modeListed(flagsOfSubmission(db, auth.class_id, sub), auth.role, showHiddens);
  });
  var tabs = [];
  listAllModes(db, auth.class_id).forEach(function (info) {
    if (!info.flags.separateList || info.flags.abstract) return;
    if (!modeCanView(info.flags, auth.role)) return;
    var count = visibleSubs.filter(function (sub) {
      var subInfo = findMode(db, auth.class_id, sub.type);
      return subInfo && subInfo.inheritModes.indexOf(info.normalized) >= 0;
    }).length;
    tabs.push({
      id: info.id,
      name: info.name,
      modeName: info.name,
      displayName: info.displayName,
      normalized: info.normalized,
      count: count,
      separateList: true,
    });
  });
  tabs.sort(function (a, b) {
    return String(a.displayName).localeCompare(String(b.displayName));
  });
  if (category) {
    var categoryInfo = findMode(db, auth.class_id, category);
    var categoryNorm = categoryInfo ? categoryInfo.normalized : normalizeModeName(category);
    visibleSubs = visibleSubs.filter(function (sub) {
      var info = findMode(db, auth.class_id, sub.type);
      return (
        normalizeModeName(sub.type) === categoryNorm ||
        (info && info.inheritModes.indexOf(categoryNorm) >= 0)
      );
    });
  }
  var rows = sortSubmissions(visibleSubs, now).map(function (sub) {
    return submissionRow(db, auth, sub, now);
  });

  var mode = parsed.value;
  if (mode.type === "StudentID" || mode.type === "ShortStudentID") {
    var keys = {};
    db.uploads.forEach(function (u) {
      if (u.class_id !== auth.class_id) return;
      var hit =
        mode.type === "StudentID" ? u.student_id === mode.id : u.short_id === mode.id;
      if (hit) keys[u.submission_id] = true;
    });
    rows = rows.filter(function (r) {
      return keys[r.id] === true;
    });
  } else if (mode.type === "TitleReGex") {
    var applied = matchmode.applyMode(mode, rows, { titleKey: "name" });
    if (!applied.ok) return fail(400, applied.msg);
    rows = applied.rows;
  } else if (mode.type === "Before") {
    rows = rows.filter(function (r) {
      if (!r.deadLine) return false;
      var ts = time.parseTime(r.deadLine);
      return ts !== null && ts < mode.time;
    });
  } else if (mode.type === "Random") {
    var picked = matchmode.applyMode(mode, rows);
    if (!picked.ok) return fail(400, picked.msg);
    rows = picked.rows;
  }
  return ok({
    datas: rows,
    tabs: tabs,
    separateLists: tabs,
    showHiddens: showHiddens,
    category: category,
  });
}

function applyUploadMatch(db, rows, body) {
  var parsed = matchmode.parseMatchMode(
    body.match_mode !== undefined ? body.match_mode : body.matchMode
  );
  if (!parsed.ok) return { ok: false, msg: parsed.msg };
  var mode = parsed.value;
  if (mode.type === "Random") {
    var picked = matchmode.applyMode(mode, rows);
    if (!picked.ok) return { ok: false, msg: picked.msg };
    rows = picked.rows;
  } else if (mode.type === "StudentID") {
    rows = rows.filter(function (u) {
      return (u.student_id || "") === mode.id;
    });
  } else if (mode.type === "ShortStudentID") {
    rows = rows.filter(function (u) {
      return (u.short_id || 0) === mode.id;
    });
  } else if (mode.type === "TitleReGex") {
    var applied = matchmode.applyMode(mode, rows, { titleKey: "title" });
    if (!applied.ok) return { ok: false, msg: applied.msg };
    rows = applied.rows;
  } else if (mode.type === "Before") {
    rows = rows.filter(function (u) {
      return u.created_at < mode.time;
    });
  }
  return { ok: true, rows: rows };
}

/** `/api/my-uploads`：当前身份的全部提交。 */
function myUploads(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  var submissionId =
    typeof body.submissionID === "string"
      ? body.submissionID
      : typeof body.which === "string"
      ? body.which
      : "";
  var uploadId =
    typeof body.uploadID === "string"
      ? body.uploadID
      : typeof body.id === "string"
      ? body.id
      : "";
  if (submissionId) {
    var sub = null;
    db.submissions.forEach(function (s) {
      if (s.id === submissionId) sub = s;
    });
    if (!sub) return fail(404, "submission not found");
    if (sub.class_id !== auth.class_id) {
      return fail(404, "submission does not belong to the current class");
    }
  }
  var limit = 500;
  if (typeof body.limit === "number" && body.limit > 0) limit = Math.min(body.limit, 2000);
  var rows = db.uploads
    .filter(function (u) {
      if (u.class_id !== auth.class_id || u.auth_id !== auth.id) return false;
      if (submissionId && u.submission_id !== submissionId) return false;
      if (uploadId && u.id !== uploadId) return false;
      return true;
    })
    .sort(function (a, b) {
      return b.created_at - a.created_at;
    })
    .slice(0, limit);
  var applied = applyUploadMatch(db, rows, body);
  if (!applied.ok) return fail(400, applied.msg);
  return ok({
    datas: applied.rows.map(function (u) {
      return uploadApiRow(db, u);
    }),
  });
}

/** `/api/my-submissions`：当前身份发布的征集。 */
function mySubmissions(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  var now = time.now();
  var rows = db.submissions
    .filter(function (s) {
      return s.class_id === auth.class_id && s.created_by === auth.id;
    })
    .sort(function (a, b) {
      if (a.created_at !== b.created_at) return b.created_at - a.created_at;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    })
    .map(function (sub) {
      return submissionRow(db, auth, sub, now);
    });
  return ok({ datas: rows });
}

/** `/api/pending-uploads`：待回复提交，自己发布的征集优先。 */
function pendingUploads(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role === "student") {
    return fail(403, "only teachers or admins can view pending uploads");
  }
  var ownOnly = body.ownOnly === true;
  var limit = 100;
  if (typeof body.limit === "number" && body.limit > 0) limit = Math.min(body.limit, 1000);
  var subById = {};
  db.submissions.forEach(function (s) {
    subById[s.id] = s;
  });
  var rows = db.uploads
    .filter(function (u) {
      if (u.class_id !== auth.class_id) return false;
      if (hasReply(db, u.id)) return false;
      var sub = subById[u.submission_id];
      if (ownOnly && (!sub || sub.created_by !== auth.id)) return false;
      return true;
    })
    .sort(function (a, b) {
      var aSub = subById[a.submission_id];
      var bSub = subById[b.submission_id];
      var aMine = aSub && aSub.created_by === auth.id ? 0 : 1;
      var bMine = bSub && bSub.created_by === auth.id ? 0 : 1;
      if (aMine !== bMine) return aMine - bMine;
      return b.created_at - a.created_at;
    })
    .slice(0, limit);
  return ok({
    datas: rows.map(function (u) {
      var row = uploadApiRow(db, u);
      row.mine = row.submissionCreatedBy === auth.id;
      return row;
    }),
  });
}

/** `/api/all-modes`：内置 + 班级自定义征集模式。 */
function allModes(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  var modes = listAllModes(db, auth.class_id).map(modeInfoJson);
  var tabs = modes.filter(function (m) {
    return m.separateList && !m.abstract;
  });
  return ok({ modes: modes, datas: modes, tabs: tabs, separateLists: tabs });
}

/** `/api/new-mode`：管理员新增班级征集模式。 */
function newMode(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role !== "admin") {
    return fail(403, "only admins can add submission modes");
  }
  var nameRes = stringField(body, ["modeName", "mode_name", "name"], "");
  if (!nameRes.ok) return nameRes.error;
  var name = nameRes.value.trim();
  if (!name) return fail(400, "modeName must not be empty");
  if (charCount(name) > 60) return fail(400, "modeName is too long (max 60 characters)");
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    return fail(400, "modeName must not contain control characters");
  }
  var normalized = normalizeModeName(name);
  if (findMode(db, auth.class_id, normalized)) {
    return fail(400, "submission mode already exists: " + name);
  }
  var displayName = stringField(
    body,
    ["displayName", "display_name", "label"],
    name
  );
  if (!displayName.ok) return displayName.error;
  displayName = displayName.value.trim() || name;
  if (charCount(displayName) > 60) {
    return fail(400, "displayName is too long (max 60 characters)");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(displayName)) {
    return fail(400, "displayName must not contain control characters");
  }
  var extendsRaw = body.extendModes !== undefined ? body.extendModes : body.extend_modes;
  if (!Array.isArray(extendsRaw)) extendsRaw = [];
  if (extendsRaw.length > 16) return fail(400, "extendModes supports at most 16 entries");
  var extendModes = [];
  var bases = [];
  var parents = [];
  for (var i = 0; i < extendsRaw.length; i++) {
    var raw = String(extendsRaw[i] === null || extendsRaw[i] === undefined ? "" : extendsRaw[i]).trim();
    if (!raw) continue;
    var mode = findMode(db, auth.class_id, raw);
    if (!mode) return fail(400, "unknown extend mode: " + raw);
    if (extendModes.indexOf(mode.normalized) >= 0) continue;
    extendModes.push(mode.normalized);
    bases.push(mode.baseType);
    parents.push(mode);
  }
  for (var a = 0; a < parents.length; a++) {
    for (var b = a + 1; b < parents.length; b++) {
      var common = null;
      for (var x = 0; x < parents[a].inheritModes.length; x++) {
        if (parents[b].inheritModes.indexOf(parents[a].inheritModes[x]) >= 0) {
          common = parents[a].inheritModes[x];
          break;
        }
      }
      if (common) {
        return fail(
          400,
          "diamond inheritance is not allowed: '" +
            parents[a].name +
            "' and '" +
            parents[b].name +
            "' both inherit '" +
            common +
            "'"
        );
      }
    }
  }
  var baseType = "other";
  ["answer sheet", "survey", "notice", "homework", "open call", "leave request", "other"].forEach(
    function (candidate) {
      if (baseType === "other" && bases.indexOf(candidate) >= 0) baseType = candidate;
    }
  );
  // 可见性只来自继承（extendModes）；只有抽象属性需要显式声明。
  var flags = defaultModeFlags();
  parents.forEach(function (parent) {
    flags.hidden = flags.hidden || !!parent.flags.hidden;
    flags.teacherOnly = flags.teacherOnly || !!parent.flags.teacherOnly;
    flags.adminOnly = flags.adminOnly || !!parent.flags.adminOnly;
    flags.invisible = flags.invisible || !!parent.flags.invisible;
    flags.separateList = flags.separateList || !!parent.flags.separateList;
  });
  flags.abstract =
    body.abstract === true || body.abstractMode === true || body.abstract_mode === true;
  var modeRow = {
    id: newId("mode"),
    class_id: auth.class_id,
    name: name,
    normalized: normalized,
    display_name: displayName,
    extend_modes: extendModes,
    base_type: baseType,
    hidden: flags.hidden,
    teacher_only: flags.teacherOnly,
    admin_only: flags.adminOnly,
    invisible: flags.invisible,
    separate_list: flags.separateList,
    abstract_mode: flags.abstract,
    flags: flags,
    created_at: time.now(),
    created_by: auth.id,
    created_name: identity(auth),
  };
  db.modes.push(modeRow);
  return ok({
    success: true,
    id: modeRow.id,
    modeName: modeRow.name,
    displayName: modeRow.display_name,
    extendModes: extendModes,
    baseType: baseType,
    hidden: flags.hidden,
    teacherOnly: flags.teacherOnly,
    adminOnly: flags.adminOnly,
    invisible: flags.invisible,
    separateList: flags.separateList,
    abstract: flags.abstract,
    flags: flags,
    createdAt: time.fmtISO(modeRow.created_at),
    createdBy: modeRow.created_name,
  });
}

function newSubmission(db, body) {
  var nameRes = requiredStringField(body, ["name"]);
  if (!nameRes.ok) return nameRes.error;
  var descRes = stringField(body, ["desc"], "");
  if (!descRes.ok) return descRes.error;
  var typeRes = stringField(body, ["type", "mode", "modeName"], "");
  if (!typeRes.ok) return typeRes.error;

  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role === "student") {
    return fail(403, "only teachers or admins can create submissions");
  }
  var name = nameRes.value.trim();
  var desc = descRes.value.trim();
  var kind = typeRes.value.trim() || "homework";
  if (!name) return fail(400, "name must not be empty");
  if (charCount(name) > MAX_TITLE) {
    return fail(400, "name is too long (max " + MAX_TITLE + " characters)");
  }
  if (charCount(desc) > MAX_SUBMISSION_DESC) {
    return fail(400, "desc is too long (max " + MAX_SUBMISSION_DESC + " characters)");
  }
  if (charCount(kind) > 60) return fail(400, "type is too long (max 60 characters)");

  var deadlineValue = body.deadLine !== undefined ? body.deadLine : body.deadline;
  var deadline = time.parseDeadlineValue(deadlineValue === undefined ? null : deadlineValue);
  if (!deadline.ok) return fail(400, deadline.msg);

  var mode = findMode(db, auth.class_id, kind);
  if (mode && mode.flags.abstract) {
    return fail(
      400,
      "submission mode is abstract and cannot be used directly: " + mode.name
    );
  }
  if (mode && mode.flags.adminOnly && auth.role !== "admin") {
    return fail(403, "submission mode requires a different role: " + mode.name);
  }
  if ((body.adminOnly === true || body.admin_only === true) && auth.role !== "admin") {
    return fail(403, "admin-only submissions can only be published by admins");
  }
  var baseKind = mode ? mode.baseType : "other";
  if (mode) kind = mode.name;
  var definitionError = survey.validateDefinition(baseKind, desc);
  if (definitionError) return fail(400, definitionError);

  var id = newId("sub");
  var subFlags = {
    hidden: body.hidden === true || (mode && mode.flags.hidden) || false,
    teacher_only: body.teacherOnly === true || body.teacher_only === true || (mode && mode.flags.teacherOnly) || false,
    admin_only: body.adminOnly === true || body.admin_only === true || (mode && mode.flags.adminOnly) || false,
    invisible: body.invisible === true || body.notListed === true || (mode && mode.flags.invisible) || false,
  };
  db.submissions.push({
    id: id,
    class_id: auth.class_id,
    name: name,
    desc: desc,
    type: kind,
    base_type: baseKind,
    hidden: subFlags.hidden,
    teacher_only: subFlags.teacher_only,
    admin_only: subFlags.admin_only,
    invisible: subFlags.invisible,
    deadline: deadline.value,
    created_at: time.now(),
    created_by: auth.id,
    created_name: identity(auth),
  });
  return ok({
    id: id,
    type: kind,
    baseType: baseKind,
    hidden: subFlags.hidden,
    teacherOnly: subFlags.teacher_only,
    adminOnly: subFlags.admin_only,
    invisible: subFlags.invisible,
  });
}

function reply(db, body) {
  var uploadRes = requiredStringField(body, ["uploadID", "upload_id", "uploadId"]);
  if (!uploadRes.ok) return uploadRes.error;
  var contentRes = requiredStringField(body, ["content"]);
  if (!contentRes.ok) return contentRes.error;

  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role === "student") return fail(403, "only teachers or admins can reply");
  var content = contentRes.value.trim();
  if (!content) return fail(400, "content must not be empty");
  if (charCount(content) > MAX_DESC) {
    return fail(400, "content is too long (max " + MAX_DESC + " characters)");
  }
  // 与 api.rs 一致：uploadID 按原样匹配（不 trim）。
  var uploadId = uploadRes.value;
  var upload = null;
  for (var i = 0; i < db.uploads.length; i++) {
    if (db.uploads[i].id === uploadId) upload = db.uploads[i];
  }
  if (!upload) return fail(404, "upload not found");
  if (upload.class_id !== auth.class_id) {
    return fail(404, "upload does not belong to the current class");
  }
  var id = newId("rep");
  db.replies.push({
    id: id,
    upload_id: upload.id,
    auth_id: auth.id,
    replier_name: identity(auth),
    role: auth.role,
    content: content,
    created_at: time.now(),
  });
  return ok({ id: id });
}

function newClass(db, body) {
  var nameRes = stringField(body, ["name"], "");
  if (!nameRes.ok) return nameRes.error;
  var descRes = stringField(body, ["desc"], "");
  if (!descRes.ok) return descRes.error;

  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role !== "admin") return fail(403, "only admins can create classes");
  var desc = descRes.value.trim();
  var name = nameRes.value.trim();
  if (!name && !desc) return fail(400, "desc (class description) must not be empty");

  // 与 db.rs::create_class 一致：name 为空时取 desc 首行（最多 30 字）；desc 也为空才用默认名。
  var className;
  if (name) className = name;
  else if (desc) className = truncateChars(String(desc).split("\n")[0], 30);
  else className = "未命名班级";
  if (charCount(className) > 40) return fail(400, "class name is too long (max 40 characters)");
  if (charCount(desc) > 500) return fail(400, "class description is too long (max 500 characters)");

  var classId = newId("cls");
  var code = newClassCode();
  for (var i = 0; i < 20; i++) {
    if (
      !db.classes.some(function (c) {
        return c.code === code;
      })
    ) {
      break;
    }
    code = newClassCode();
  }
  var now = time.now();
  db.classes.push({
    id: classId,
    code: code,
    name: className,
    desc: desc,
    created_at: now,
    created_by: auth.id,
  });
  var authId = newId("auth");
  var key = newAuthKey("admin");
  for (var j = 0; j < 20; j++) {
    if (!loadAuthByKey(db, key)) break;
    key = newAuthKey("admin");
  }
  db.auths.push({
    id: authId,
    key: key,
    class_id: classId,
    user_id: auth.user_id || null,
    role: "admin",
    student_id: null,
    short_id: null,
    display_name: identity(auth),
    created_at: now,
  });
  return ok({ id: classId, code: code, auth: key, authID: authId });
}

function normalizeRole(kind) {
  var k = String(kind === null || kind === undefined ? "" : kind).trim().toLowerCase();
  if (k === "student" || k === "学生") return "student";
  if (k === "teacher" || k === "老师") return "teacher";
  if (k === "admin" || k === "管理员") return "admin";
  return null;
}

function newUser(db, body) {
  var classRes = requiredStringField(body, ["classID", "class_id", "classId"]);
  if (!classRes.ok) return classRes.error;
  var qtyRes = integerField(body, ["quantity"]);
  if (!qtyRes.ok) return qtyRes.error;
  var typeRes = stringField(body, ["type", "mode", "modeName"], "");
  if (!typeRes.ok) return typeRes.error;

  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role !== "admin") return fail(403, "only admins can add members");
  var classId = classRes.value.trim();
  if (classId !== auth.class_id) {
    return fail(400, "members can only be added to the class of the current admin auth");
  }
  var quantity = qtyRes.value;
  if (quantity < 1 || quantity > 100) {
    return fail(400, "quantity must be between 1 and 100");
  }
  var role = normalizeRole(typeRes.value);
  if (!role) return fail(400, "type must be one of Student / Teacher / Admin");
  var classRow = null;
  for (var i = 0; i < db.classes.length; i++) {
    if (db.classes[i].id === classId) classRow = db.classes[i];
  }
  var code = classRow ? classRow.code : "";
  var maxShort = 0;
  db.auths.forEach(function (a) {
    if (a.class_id === classId && a.short_id !== null && a.short_id > maxShort) maxShort = a.short_id;
  });

  var now = time.now();
  var members = [];
  for (var n = 1; n <= quantity; n++) {
    var shortId = role === "student" ? maxShort + n : null;
    var studentId = shortId === null ? null : code + "-" + (shortId < 10 ? "0" + shortId : String(shortId));
    var displayName =
      role === "student" ? "学生 " + (shortId === null ? "00" : shortId < 10 ? "0" + shortId : String(shortId))
        : role === "teacher" ? "教师 " + (n < 10 ? "0" + n : String(n))
        : "管理员 " + (n < 10 ? "0" + n : String(n));
    var id = newId("auth");
    var key = newAuthKey(role);
    for (var k = 0; k < 20; k++) {
      if (!loadAuthByKey(db, key)) break;
      key = newAuthKey(role);
    }
    db.auths.push({
      id: id,
      key: key,
      class_id: classId,
      user_id: null,
      role: role,
      student_id: studentId,
      short_id: shortId,
      display_name: displayName,
      created_at: now,
    });
    members.push({
      id: id,
      key: key,
      role: role,
      studentID: studentId || "",
      displayName: displayName,
    });
  }
  return ok({
    IDs: members.map(function (m) {
      return m.id;
    }),
    keys: members.map(function (m) {
      return m.key;
    }),
    members: members,
  });
}

function delKey(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  db.auths = db.auths.filter(function (a) {
    return a.id !== ctx.auth.id;
  });
  return ok({ msg: "key deleted" });
}

function cleanDisplayName(raw) {
  var name = String(raw === null || raw === undefined ? "" : raw).trim();
  if (!name) return { ok: false, msg: "name must not be empty" };
  if (charCount(name) > 40) return { ok: false, msg: "name is too long (max 40 characters)" };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    return { ok: false, msg: "name must not contain control characters" };
  }
  return { ok: true, value: name };
}

function renameAuth(db, body) {
  var nameRes = stringField(body, ["name"], "");
  if (!nameRes.ok) return nameRes.error;

  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var cleaned = cleanDisplayName(nameRes.value);
  if (!cleaned.ok) return fail(400, cleaned.msg);
  var auth = ctx.auth;
  auth.display_name = cleaned.value;
  db.uploads.forEach(function (u) {
    if (u.auth_id === auth.id) u.uploader_name = cleaned.value;
  });
  db.replies.forEach(function (r) {
    if (r.auth_id === auth.id) r.replier_name = cleaned.value;
  });
  db.submissions.forEach(function (s) {
    if (s.created_by === auth.id) s.created_name = cleaned.value;
  });
  return ok({ name: cleaned.value, msg: "identity name updated" });
}

function delObject(db, body) {
  var idRes = requiredStringField(body, ["id"]);
  if (!idRes.ok) return idRes.error;
  var authCtx = optionalAuth(db, body);
  if (authCtx.error) return authCtx.error;
  var auth = authCtx.auth;
  if (!auth) return fail(401, "missing auth and not logged in");
  if (auth.role !== "admin") return fail(403, "only admins can delete objects");
  var id = idRes.value.trim();
  if (!id) return fail(400, "id must not be empty");

  if (id.indexOf("cls_") === 0) {
    if (id !== auth.class_id) return fail(403, "you can only delete a class you manage");
    var classId = id;
    var removedAuths = {};
    db.auths.forEach(function (a) {
      if (a.class_id === classId) removedAuths[a.id] = true;
    });
    db.classes = db.classes.filter(function (c) {
      return c.id !== classId;
    });
    db.modes = (db.modes || []).filter(function (m) {
      return m.class_id !== classId;
    });
    db.auths = db.auths.filter(function (a) {
      return a.class_id !== classId;
    });
    var submissionIds = {};
    db.submissions.forEach(function (s) {
      if (s.class_id === classId) submissionIds[s.id] = true;
    });
    db.submissions = db.submissions.filter(function (s) {
      return s.class_id !== classId;
    });
    var uploadIds = {};
    db.uploads.forEach(function (u) {
      if (u.class_id === classId || submissionIds[u.submission_id]) uploadIds[u.id] = true;
    });
    db.uploads = db.uploads.filter(function (u) {
      return u.class_id !== classId && !submissionIds[u.submission_id];
    });
    db.replies = db.replies.filter(function (r) {
      return !uploadIds[r.upload_id];
    });
    return ok({ msg: "class deleted" });
  }

  if (id.indexOf("auth_") === 0) {
    var target = loadAuthById(db, id);
    if (!target) return fail(404, "auth not found");
    if (target.class_id !== auth.class_id) {
      return fail(403, "you can only delete an auth in the current class");
    }
    db.auths = db.auths.filter(function (a) {
      return a.id !== id;
    });
    return ok({ msg: "auth deleted" });
  }

  var isSub = id.indexOf("sub_") === 0;
  var isUpload = id.indexOf("up_") === 0;
  var isReply = id.indexOf("rep_") === 0;
  if (isSub) {
    var sub = null;
    db.submissions.forEach(function (s) {
      if (s.id === id) sub = s;
    });
    if (!sub) return fail(404, "object not found or unsupported id type");
    if (sub.class_id !== auth.class_id) {
      return fail(403, "you can only delete objects in the current class");
    }
    var upIds = {};
    db.uploads.forEach(function (u) {
      if (u.submission_id === id) upIds[u.id] = true;
    });
    db.submissions = db.submissions.filter(function (s) {
      return s.id !== id;
    });
    db.uploads = db.uploads.filter(function (u) {
      return u.submission_id !== id;
    });
    db.replies = db.replies.filter(function (r) {
      return !upIds[r.upload_id];
    });
    return ok({ msg: "deleted" });
  }

  if (isUpload) {
    var up = null;
    db.uploads.forEach(function (u) {
      if (u.id === id) up = u;
    });
    if (!up) return fail(404, "object not found or unsupported id type");
    if (up.class_id !== auth.class_id) {
      return fail(403, "you can only delete objects in the current class");
    }
    db.uploads = db.uploads.filter(function (u) {
      return u.id !== id;
    });
    db.replies = db.replies.filter(function (r) {
      return r.upload_id !== id;
    });
    return ok({ msg: "deleted" });
  }

  if (isReply) {
    var rep = null;
    db.replies.forEach(function (r) {
      if (r.id === id) rep = r;
    });
    if (!rep) return fail(404, "object not found or unsupported id type");
    var owner = null;
    db.uploads.forEach(function (u) {
      if (u.id === rep.upload_id) owner = u;
    });
    var replyClass = owner ? owner.class_id : null;
    if (replyClass !== auth.class_id) {
      return fail(403, "you can only delete objects in the current class");
    }
    db.replies = db.replies.filter(function (r) {
      return r.id !== id;
    });
    return ok({ msg: "deleted" });
  }

  return fail(404, "object not found or unsupported id type");
}

function health() {
  return ok({ service: "smart-campus", time: time.now() });
}

// ---------------------------------------------------------------------------
// 密钥轮换 / 批量调用（与 src/api.rs 的 refresh-key、multi-api 对齐）
// ---------------------------------------------------------------------------

/** `/api/refresh-key`：验证账号挑战后生成新 auth，迁移历史数据并删除旧 auth。 */
function refreshKey(db, body) {
  var verified = verifyLoginAnswer(body);
  if (!verified.ok) return verified.response;
  var oldKey =
    typeof body.authRefreshing === "string"
      ? body.authRefreshing
      : typeof body.auth === "string"
        ? body.auth
        : "";
  oldKey = oldKey.trim();
  if (!oldKey) return fail(400, "authRefreshing must not be empty");
  var auth = loadAuthByKey(db, oldKey);
  if (!auth) {
    return loginFailure(401, "invalid or expired auth", "auth_invalid");
  }
  var store = loadUsers();
  var user = null;
  store.users.forEach(function (u) {
    if (u.id === verified.session.user_id) user = u;
  });
  var owned = user && (user.keys || []).indexOf(auth.key) >= 0;
  if (!owned) {
    var boundElsewhere = store.users.some(function (u) {
      return u.id !== (user ? user.id : -1) && (u.keys || []).indexOf(auth.key) >= 0;
    });
    return fail(
      403,
      boundElsewhere ? "auth belongs to another account" : "auth is not bound to an account"
    );
  }

  var newAuthId = newId("auth");
  var newKey = newAuthKey(auth.role);
  var canonicalOldKey = auth.key;
  for (var i = 0; i < 32; i++) {
    if (newKey !== canonicalOldKey && !loadAuthByKey(db, newKey)) break;
    newKey = newAuthKey(auth.role);
  }
  var oldId = auth.id;
  auth.id = newAuthId;
  auth.key = newKey;
  // 历史数据没有外键，必须手动迁移到新 auth（与 db.rs::refresh_auth 一致）。
  db.uploads.forEach(function (u) {
    if (u.auth_id === oldId) u.auth_id = newAuthId;
  });
  db.replies.forEach(function (r) {
    if (r.auth_id === oldId) r.auth_id = newAuthId;
  });
  db.submissions.forEach(function (s) {
    if (s.created_by === oldId) s.created_by = newAuthId;
  });
  db.classes.forEach(function (c) {
    if (c.created_by === oldId) c.created_by = newAuthId;
  });
  (db.modes || []).forEach(function (m) {
    if (m.created_by === oldId) m.created_by = newAuthId;
  });
  user.keys = (user.keys || []).map(function (k) {
    return k === canonicalOldKey ? newKey : k;
  });
  saveUsers(store);
  // 作废该账号的一次性挑战（与真实服务一致）。
  Object.keys(loginSessions).forEach(function (id) {
    if (loginSessions[id].user_id === user.id) delete loginSessions[id];
  });
  return ok({ newAuth: newKey });
}

var MULTI_API_MAX = 100;
var MULTI_API_PATH_KEYS = ["api", "path", "endpoint", "url", "route", "uri"];
var MULTI_API_BODY_KEYS = ["body", "params", "request", "payload", "json"];
var MULTI_API_BLOCKED = [
  "/api/login-try",
  "/api/get-auths",
  "/api/reset-password",
  "/api/refresh-key",
  "/api/multi-api",
];

function multiApiError(msg, code) {
  return { ok: false, msg: msg, code: code };
}

function normalizeMultiApiPath(raw) {
  var text = String(raw === null || raw === undefined ? "" : raw).trim();
  if (!text) return { ok: false, msg: "api path must not be empty" };
  if (/^(https?:)?\/\//i.test(text)) {
    return { ok: false, msg: "only internal api paths are allowed" };
  }
  var path = text.split(/[?#]/)[0].replace(/\/+$/, "");
  if (!path) return { ok: false, msg: "api path must not be empty" };
  if (path.indexOf("/api/") === 0) {
    // keep
  } else if (path.indexOf("api/") === 0) {
    path = "/" + path;
  } else if (path.charAt(0) === "/") {
    return { ok: false, msg: "unsupported api path: " + text };
  } else {
    path = "/api/" + path;
  }
  return { ok: true, path: path };
}

function parseMultiApiItem(item) {
  if (typeof item === "string") {
    var parsed = normalizeMultiApiPath(item);
    return parsed.ok ? { ok: true, path: parsed.path, body: {} } : { ok: false, msg: parsed.msg };
  }
  if (Array.isArray(item)) {
    if (!item.length) return { ok: false, msg: "api item array must not be empty" };
    if (typeof item[0] !== "string") return { ok: false, msg: "api item path must be a string" };
    var pathRes = normalizeMultiApiPath(item[0]);
    if (!pathRes.ok) return pathRes;
    if (item.length > 2) return { ok: false, msg: "api item array must be [path, body]" };
    return { ok: true, path: pathRes.path, body: item.length === 2 ? item[1] : {} };
  }
  if (item && typeof item === "object") {
    var pathText = null;
    for (var i = 0; i < MULTI_API_PATH_KEYS.length; i++) {
      var v = item[MULTI_API_PATH_KEYS[i]];
      if (typeof v === "string") {
        pathText = v;
        break;
      }
    }
    if (!pathText) return { ok: false, msg: "api item must contain an api/path field" };
    var norm = normalizeMultiApiPath(pathText);
    if (!norm.ok) return norm;
    var payload;
    for (var j = 0; j < MULTI_API_BODY_KEYS.length; j++) {
      if (item[MULTI_API_BODY_KEYS[j]] !== undefined) {
        payload = item[MULTI_API_BODY_KEYS[j]];
        break;
      }
    }
    if (payload === undefined && item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
      payload = item.data;
    }
    if (payload === undefined) {
      payload = {};
      Object.keys(item).forEach(function (k) {
        if (MULTI_API_PATH_KEYS.indexOf(k) < 0) payload[k] = item[k];
      });
    }
    return { ok: true, path: norm.path, body: payload };
  }
  return { ok: false, msg: "each api item must be an object, string or [path, body] array" };
}

function multiDispatch(db, path, body) {
  var endpoint = path.indexOf("/api/") === 0 ? path.slice(5) : "";
  var handler = HANDLERS[endpoint];
  if (!handler) {
    return { ok: false, msg: "unsupported api path: " + path, code: "unsupported_api" };
  }
  try {
    var res = handler(db, body);
    var out = {};
    Object.keys(res).forEach(function (k) {
      if (k !== "status") out[k] = res[k];
    });
    return out;
  } catch (e) {
    return { ok: false, msg: "internal error: " + (e && e.message ? e.message : String(e)) };
  }
}

/** `/multi-api`：按顺序调用内部 API，结果索引与 apis 严格对应。 */
function multiApi(db, body) {
  if (!Array.isArray(body.apis)) return fail(422, "apis: invalid type");
  if (body.apis.length > MULTI_API_MAX) {
    return fail(400, "too many api calls in one batch (max " + MULTI_API_MAX + ")");
  }
  var results = [];
  body.apis.forEach(function (item) {
    var parsed = parseMultiApiItem(item);
    if (!parsed.ok) {
      results.push(multiApiError(parsed.msg, "invalid_request"));
      return;
    }
    if (MULTI_API_BLOCKED.indexOf(parsed.path) >= 0) {
      results.push(
        multiApiError("api is not allowed in multi-api: " + parsed.path, "api_not_allowed")
      );
      return;
    }
    results.push(multiDispatch(db, parsed.path, parsed.body));
  });
  return ok({ results: results });
}

var HANDLERS = {
  upload: upload,
  download: download,
  "new-submission": newSubmission,
  "all-submission": allSubmission,
  "my-uploads": myUploads,
  "my-upload": myUploads,
  "all-my-uploads": myUploads,
  "my-submissions": mySubmissions,
  "my-submission": mySubmissions,
  "all-my-submissions": mySubmissions,
  "pending-uploads": pendingUploads,
  "new-mode": newMode,
  "all-modes": allModes,
  "class-modes": allModes,
  reply: reply,
  "new-class": newClass,
  "new-user": newUser,
  "del-key": delKey,
  "rename-auth": renameAuth,
  "del-object": delObject,
  register: register,
  "login-try": logintry,
  "get-auths": getAuths,
  "refresh-key": refreshKey,
  "reset-password": resetPassword,
  "upgrade-pubkey": upgradePubkey,
  "multi-api": multiApi,
  health: health,
};

/** 分发一次 `/api/<endpoint>` 调用。返回与真实服务同构的响应对象。 */
function handle(endpoint, payload) {
  var name = String(endpoint === null || endpoint === undefined ? "" : endpoint)
    .trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/?api\//, "")
    .replace(/^\//, "");
  var handler = HANDLERS[name];
  if (!handler) return fail(404, "endpoint not found");
  var db = load();
  var body = payload && typeof payload === "object" ? payload : {};
  var result;
  try {
    result = handler(db, body);
  } catch (e) {
    return fail(500, "internal error: " + (e && e.message ? e.message : String(e)));
  }
  save(db);
  return result;
}

// ---------------------------------------------------------------------------
// 离线附加能力（仅本地模拟使用，真实 /api 没有这些接口）
// ---------------------------------------------------------------------------

/** 读取某个征集下的提交（离线时用于「我的提交」等页面，线上由服务端页面直接查询）。
 *  `onlyMine` 为 true 时只返回该身份的提交，与服务端学生视角的数据范围一致。 */
function localUploads(authKey, submissionId, onlyMine) {
  var db = load();
  var auth = loadAuthByKey(db, authKey);
  if (!auth) return { ok: false, msg: "invalid or expired auth", status: 401 };
  var onlyAuthId = onlyMine === true ? auth.id : null;
  var sub = null;
  db.submissions.forEach(function (s) {
    if (s.id === submissionId) sub = s;
  });
  if (!sub) return { ok: false, msg: "submission not found", status: 404 };
  if (sub.class_id !== auth.class_id) {
    return { ok: false, msg: "submission does not belong to the current class", status: 404 };
  }
  var datas = uploadsOfSubmission(db, sub.id)
    .filter(function (u) {
      return !onlyAuthId || u.auth_id === onlyAuthId;
    })
    .sort(function (a, b) {
      if (a.created_at !== b.created_at) return b.created_at - a.created_at;
      return a.id < b.id ? 1 : -1;
    })
    .map(function (u) {
      return downloadRow(db, u);
    });
  return ok({ datas: datas });
}

/** 读取单个提交（含回复）。离线时用于学生查看自己的提交详情。 */
function localUpload(authKey, uploadId) {
  var db = load();
  var auth = loadAuthByKey(db, authKey);
  if (!auth) return { ok: false, msg: "invalid or expired auth", status: 401 };
  var upload = null;
  db.uploads.forEach(function (u) {
    if (u.id === uploadId) upload = u;
  });
  if (!upload) return { ok: false, msg: "upload not found", status: 404 };
  if (upload.class_id !== auth.class_id) {
    return { ok: false, msg: "upload not found", status: 404 };
  }
  if (auth.role === "student" && upload.auth_id !== auth.id) {
    return { ok: false, msg: "upload not found", status: 404 };
  }
  var sub = null;
  db.submissions.forEach(function (s) {
    if (s.id === upload.submission_id) sub = s;
  });
  return ok({
    data: downloadRow(db, upload),
    submission: sub
      ? {
          id: sub.id,
          name: sub.name,
          desc: sub.desc,
          type: sub.type,
          deadLine: sub.deadline === null ? null : time.fmtISO(sub.deadline),
          createdBy: sub.created_name,
          createdAt: time.fmtISO(sub.created_at),
        }
      : null,
  });
}

/** 读取当前身份所属的班级信息（离线时才有的便捷能力，方便界面展示班级名）。 */
function localProfile(authKey) {
  var db = load();
  var auth = loadAuthByKey(db, authKey);
  if (!auth) return null;
  var cls = null;
  db.classes.forEach(function (c) {
    if (c.id === auth.class_id) cls = c;
  });
  var members = db.auths.filter(function (a) {
    return a.class_id === auth.class_id;
  });
  return {
    auth: clone({
      id: auth.id,
      key: auth.key,
      role: auth.role,
      student_id: auth.student_id,
      short_id: auth.short_id,
      display_name: auth.display_name,
    }),
    identity: identity(auth),
    class: cls
      ? { id: cls.id, code: cls.code, name: cls.name, desc: cls.desc, memberCount: members.length }
      : null,
  };
}

module.exports = {
  DB_KEY: DB_KEY,
  DEMO_KEYS: DEMO_KEYS,
  handle: handle,
  reset: reset,
  seed: seed,
  localUploads: localUploads,
  localUpload: localUpload,
  localProfile: localProfile,
};
