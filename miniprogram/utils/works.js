/* 页面数据组装层：把 `/api` 的响应整理成页面直接渲染的结构。
 *
 * 关键约定：**所有读写都走 /api**（在线与离线同一套契约）。唯一的例外是学生视角的
 * 「读自己的提交」——真实服务没有对应接口（页面由服务端直接查库渲染），因此：
 *   * 离线模式：调用 utils/mock 的本地读取（localUploads / localUpload），体验与服务端渲染一致；
 *   * 在线模式：读取本机提交缓存（utils/cache），至少能看到本机上传过的内容。
 * 这两条路径返回的 `datas` 结构与 `/api/download` 完全一致。
 */
var api = require("./api");
var mock = require("./mock/index.js");
var config = require("./config");
var cache = require("./cache");
var time = require("./time");

function isOffline() {
  return !config.isOnline();
}

function isStaff(role) {
  return role === "teacher" || role === "admin";
}

/** `/api/all-submission`：征集列表（已是服务端排序） */
function submissions(authKey, matchMode) {
  var body = { auth: authKey };
  if (matchMode !== undefined) body.match_mode = matchMode;
  return api.allSubmission(body);
}

function findSubmission(authKey, submissionId) {
  return submissions(authKey).then(function (res) {
    if (!res.ok) return { ok: false, msg: res.msg, status: res.status };
    var list = res.datas || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === submissionId) return { ok: true, submission: list[i] };
    }
    return { ok: false, msg: "submission not found", status: 404 };
  });
}

/** 某个征集下的提交。
 *  教职工 -> `/api/download`；学生 -> 离线本地读取 / 在线本机缓存。 */
function submissionUploads(authKey, submissionId, role) {
  if (isStaff(role)) {
    return api.download({ auth: authKey, which: submissionId }).then(function (res) {
      if (!res.ok) return { ok: false, msg: res.msg, status: res.status, datas: [] };
      return { ok: true, datas: res.datas || [], source: isOffline() ? "mock" : "api" };
    });
  }
  if (isOffline()) {
    var res = mock.localUploads(authKey, submissionId, true);
    if (!res.ok) return Promise.resolve({ ok: false, msg: res.msg, status: res.status, datas: [] });
    return Promise.resolve({ ok: true, datas: res.datas || [], source: "mock" });
  }
  return Promise.resolve({
    ok: true,
    datas: cache.bySubmission(authKey, submissionId),
    source: "device",
  });
}

/** 全部提交（提交列表页）：离线按征集逐个读取，在线教职工逐个 `/api/download`。 */
function allUploads(authKey, role, options) {
  var opts = options || {};
  var maxSubmissions = opts.maxSubmissions || 20;
  var filter = opts.filter || "all";

  // `/api/download` 的响应里没有 submissionId，小程序在汇总时补上，
  // 这样老师从提交列表 / 首页点进「提交详情」时仍知道它属于哪个征集。
  function decorate(rows, submission) {
    var submissionId = submission ? submission.id : "";
    var submissionName = submission ? submission.name : "";
    return rows.map(function (row) {
      var copy = {};
      Object.keys(row).forEach(function (k) {
        copy[k] = row[k];
      });
      copy.submissionId = submissionId || copy.submissionId || "";
      copy.submissionName = submissionName || copy.submissionName || "";
      copy.replyCount = (row.reply || []).length;
      return copy;
    });
  }

  if (!isStaff(role)) {
    if (isOffline()) {
      return submissions(authKey).then(function (res) {
        if (!res.ok) return { ok: false, msg: res.msg, datas: [] };
        var merged = [];
        (res.datas || []).forEach(function (sub) {
          var local = mock.localUploads(authKey, sub.id, true);
          if (local.ok) merged = merged.concat(decorate(local.datas || [], sub));
        });
        return { ok: true, datas: sortByCreatedDesc(merged), source: "mock" };
      });
    }
    return Promise.resolve({
      ok: true,
      datas: sortByCreatedDesc(decorate(cache.list(authKey))),
      source: "device",
    });
  }

  return submissions(authKey).then(function (res) {
    if (!res.ok) return { ok: false, msg: res.msg, datas: [] };
    // 与 Web 端「最近提交」一致：先按最新的征集聚合，再按提交时间倒序展示。
    var subs = submissionsNewestFirst(res.datas || []).slice(0, maxSubmissions);
    var results = [];
    var chain = Promise.resolve();
    subs.forEach(function (sub) {
      chain = chain.then(function () {
        return api.download({ auth: authKey, which: sub.id }).then(function (dl) {
          if (dl.ok) results = results.concat(decorate(dl.datas || [], sub));
        });
      });
    });
    return chain.then(function () {
      var rows = sortByCreatedDesc(results);
      if (filter === "pending") {
        rows = rows.filter(function (r) {
          return !r.replyCount;
        });
      } else if (filter === "replied") {
        rows = rows.filter(function (r) {
          return r.replyCount > 0;
        });
      }
      return { ok: true, datas: rows, source: isOffline() ? "mock" : "api" };
    });
  });
}

function submissionsNewestFirst(rows) {
  return (rows || []).slice().sort(function (a, b) {
    var ta = time.parseTime(a.createdAt) || 0;
    var tb = time.parseTime(b.createdAt) || 0;
    if (tb !== ta) return tb - ta;
    return String(b.id).localeCompare(String(a.id));
  });
}

function sortByCreatedDesc(rows) {
  return rows.slice().sort(function (a, b) {
    var ta = time.parseTime(a.createdAt) || 0;
    var tb = time.parseTime(b.createdAt) || 0;
    if (tb !== ta) return tb - ta;
    return String(b.id).localeCompare(String(a.id));
  });
}

/** 单条提交详情：`{ok, upload, submission, source}` */
function uploadDetail(authKey, uploadId, submissionId, role) {
  function withSubmission(upload, source) {
    if (!submissionId) {
      return Promise.resolve({ ok: true, upload: upload, submission: null, source: source });
    }
    return findSubmission(authKey, submissionId).then(function (found) {
      return {
        ok: true,
        upload: upload,
        submission: found.ok ? found.submission : null,
        source: source,
      };
    });
  }

  if (isOffline()) {
    var res = mock.localUpload(authKey, uploadId);
    if (!res.ok) return Promise.resolve({ ok: false, msg: res.msg, status: res.status });
    return Promise.resolve({ ok: true, upload: res.data, submission: res.submission, source: "mock" });
  }

  if (isStaff(role)) {
    if (submissionId) {
      return api.download({ auth: authKey, which: submissionId }).then(function (dl) {
        if (!dl.ok) return { ok: false, msg: dl.msg, status: dl.status };
        var list = dl.datas || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === uploadId) return withSubmission(list[i], "api");
        }
        return { ok: false, msg: "upload not found", status: 404 };
      });
    }
    // 旧链接 / 外部跳转没有带 sid：从最近 20 个征集里找一次（`/api/download` 不含 submissionId）。
    return allUploads(authKey, role, { maxSubmissions: 20 }).then(function (res) {
      if (!res.ok) return { ok: false, msg: res.msg, status: 400 };
      for (var i = 0; i < res.datas.length; i++) {
        if (res.datas[i].id !== uploadId) continue;
        var row = res.datas[i];
        return findSubmission(authKey, row.submissionId).then(function (found) {
          return {
            ok: true,
            upload: row,
            submission: found.ok ? found.submission : null,
            source: "api",
          };
        });
      }
      return { ok: false, msg: "upload not found", status: 404 };
    });
  }

  var cached = cache.get(uploadId);
  if (!cached) return Promise.resolve({ ok: false, msg: "upload not found", status: 404 });
  return withSubmission(cached, "device");
}

/** 首页统计（服务端没有专门的统计接口，这里用征集与提交数据推导） */
function statsFor(rows, uploadRows, pageRole) {
  var submissions = rows || [];
  var uploads = uploadRows || [];
  var now = time.now();
  var active = submissions.filter(function (s) {
    return !s.deadLine || (time.parseTime(s.deadLine) || 0) > now;
  }).length;
  var pending = uploads.filter(function (u) {
    return !(u.reply && u.reply.length) && !u.replyCount;
  }).length;
  var replied = uploads.length - pending;
  if (isStaff(pageRole)) {
    return [
      { key: "submissions", label: "stat_class_submissions", value: submissions.length },
      { key: "active", label: "stat_active_submissions", value: active },
      { key: "pending", label: "stat_pending", value: pending, tone: "warn" },
      { key: "replied", label: "stat_replied", value: replied, tone: "ok" },
    ];
  }
  var parent = pageRole === "parent";
  var replies = 0;
  uploads.forEach(function (u) {
    replies += (u.reply || []).length;
  });
  return [
    { key: "submissions", label: "stat_class_submissions", value: submissions.length },
    {
      key: "uploads",
      label: parent ? "stat_child_uploads" : "stat_my_uploads",
      value: uploads.length,
    },
    { key: "replies", label: "stat_replies_received", value: replies, tone: "ok" },
    { key: "pending", label: "stat_pending", value: pending, tone: "warn" },
  ];
}

module.exports = {
  isOffline: isOffline,
  isStaff: isStaff,
  submissions: submissions,
  findSubmission: findSubmission,
  submissionUploads: submissionUploads,
  allUploads: allUploads,
  uploadDetail: uploadDetail,
  statsFor: statsFor,
  sortByCreatedDesc: sortByCreatedDesc,
};
