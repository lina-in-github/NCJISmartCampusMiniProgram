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
  return db;
}

function save(db) {
  storage.writeJson(DB_KEY, db);
}

function reset() {
  var db = seed();
  storage.writeJson(DB_KEY, db);
  return db;
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

function isNotice(sub) {
  return NOTICE_RE.test(String(sub.type || ""));
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
  return {
    id: sub.id,
    name: sub.name,
    desc: sub.desc,
    deadLine: sub.deadline === null ? null : time.fmtISO(sub.deadline),
    type: sub.type,
    createdAt: time.fmtISO(sub.created_at),
    createdBy: sub.created_name,
    uploadCount: own.length,
    myUploadCount: staff ? 0 : own.length,
    pendingCount: pending.length,
    latestUploadID: sorted.length ? sorted[0].id : null,
  };
}

function downloadRow(db, upload) {
  return {
    id: upload.id,
    studentID: upload.student_id || "",
    shortStudentID: upload.short_id || 0,
    title: upload.title,
    desc: upload.desc,
    data: upload.data,
    reply: repliesOfUpload(db, upload.id).map(function (r) {
      return r.content;
    }),
    uploader: upload.uploader_name,
    role: upload.role,
    createdAt: time.fmtISO(upload.created_at),
  };
}

// ---------------------------------------------------------------------------
// 接口实现
// ---------------------------------------------------------------------------

function requireAuth(db, body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "auth")) {
    return { error: fail(422, "missing field `auth`") };
  }
  var key = String(body.auth === null || body.auth === undefined ? "" : body.auth);
  if (!key.trim()) return { error: fail(401, "missing auth parameter") };
  var auth = loadAuthByKey(db, key);
  if (!auth) return { error: fail(401, "invalid or expired auth") };
  return { auth: auth };
}

function upload(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;

  var title = String(body.title === undefined || body.title === null ? "" : body.title).trim();
  var desc = String(body.desc === undefined || body.desc === null ? "" : body.desc).trim();
  if (!title) return fail(400, "title must not be empty");
  if (charCount(title) > MAX_TITLE) return fail(400, "title is too long (max " + MAX_TITLE + " characters)");
  if (charCount(desc) > MAX_DESC) return fail(400, "desc is too long (max " + MAX_DESC + " characters)");

  var normalized = attachments.normalizeData(body.data === undefined ? null : body.data);
  if (!normalized.ok) return fail(400, normalized.msg);

  var which = String(body.which === undefined || body.which === null ? "" : body.which).trim();
  var sub = null;
  for (var i = 0; i < db.submissions.length; i++) {
    if (db.submissions[i].id === which) sub = db.submissions[i];
  }
  if (!sub) return fail(404, "submission not found");
  if (sub.class_id !== auth.class_id) {
    return fail(404, "submission does not belong to the current class");
  }
  if (isNotice(sub)) return fail(403, "uploads are disabled for notice submissions");
  var surveyError = survey.validateSubmission(sub.type, sub.desc, desc);
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

  var which = String(body.which === undefined || body.which === null ? "" : body.which).trim();
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
  var rows = sortSubmissions(submissionsOf(db, auth.class_id), now).map(function (sub) {
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
  return ok({ datas: rows });
}

function newSubmission(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role === "student") {
    return fail(403, "only teachers or admins can create submissions");
  }
  var name = String(body.name === undefined || body.name === null ? "" : body.name).trim();
  var desc = String(body.desc === undefined || body.desc === null ? "" : body.desc).trim();
  var kind = String(body.type === undefined || body.type === null ? "" : body.type).trim() || "homework";
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

  var definitionError = survey.validateDefinition(kind, desc);
  if (definitionError) return fail(400, definitionError);

  var id = newId("sub");
  db.submissions.push({
    id: id,
    class_id: auth.class_id,
    name: name,
    desc: desc,
    type: kind,
    deadline: deadline.value,
    created_at: time.now(),
    created_by: auth.id,
    created_name: identity(auth),
  });
  return ok({ id: id });
}

function reply(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role === "student") return fail(403, "only teachers or admins can reply");
  var content = String(body.content === undefined || body.content === null ? "" : body.content).trim();
  if (!content) return fail(400, "content must not be empty");
  if (charCount(content) > MAX_DESC) {
    return fail(400, "content is too long (max " + MAX_DESC + " characters)");
  }
  var uploadId = String(
    body.uploadID !== undefined && body.uploadID !== null
      ? body.uploadID
      : body.upload_id !== undefined
      ? body.upload_id
      : body.uploadId === undefined || body.uploadId === null
      ? ""
      : body.uploadId
  ).trim();
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
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role !== "admin") return fail(403, "only admins can create classes");
  var desc = String(body.desc === undefined || body.desc === null ? "" : body.desc).trim();
  var name = String(body.name === undefined || body.name === null ? "" : body.name).trim();
  if (!name && !desc) return fail(400, "desc (class description) must not be empty");

  var className = name || truncateChars(String(desc).split("\n")[0], 30) || "未命名班级";
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
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var auth = ctx.auth;
  if (auth.role !== "admin") return fail(403, "only admins can add members");
  var classId = String(
    body.classID !== undefined && body.classID !== null
      ? body.classID
      : body.class_id !== undefined && body.class_id !== null
      ? body.class_id
      : body.classId === undefined || body.classId === null
      ? ""
      : body.classId
  ).trim();
  if (classId !== auth.class_id) {
    return fail(400, "members can only be added to the class of the current admin auth");
  }
  var quantity = parseInt(body.quantity, 10);
  if (!isFinite(quantity) || quantity < 1 || quantity > 100) {
    return fail(400, "quantity must be between 1 and 100");
  }
  var role = normalizeRole(body.type);
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
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, msg: "name must not contain control characters" };
  }
  return { ok: true, value: name };
}

function renameAuth(db, body) {
  var ctx = requireAuth(db, body);
  if (ctx.error) return ctx.error;
  var cleaned = cleanDisplayName(body.name);
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
  var auth = null;
  if (body.auth !== undefined && body.auth !== null && String(body.auth).trim()) {
    var ctx = requireAuth(db, body);
    if (ctx.error) return ctx.error;
    auth = ctx.auth;
  } else {
    return fail(401, "missing auth and not logged in");
  }
  if (auth.role !== "admin") return fail(403, "only admins can delete objects");
  var id = String(body.id === undefined || body.id === null ? "" : body.id).trim();
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

var HANDLERS = {
  upload: upload,
  download: download,
  "new-submission": newSubmission,
  "all-submission": allSubmission,
  reply: reply,
  "new-class": newClass,
  "new-user": newUser,
  "del-key": delKey,
  "rename-auth": renameAuth,
  "del-object": delObject,
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
