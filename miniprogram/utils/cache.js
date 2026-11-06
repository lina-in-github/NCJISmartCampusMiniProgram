/* 本机提交缓存。
 *
 * 学生身份在 `/api` 里没有「读取自己提交」的接口（真实服务由渲染层直接查库），
 * 因此小程序把本机发生的每一次上传记录在本地，离线/在线模式都能回看：
 *   * 标题、说明、附件、提交时间；
 *   * 服务端返回的 ID（可用来在老师端核对）。
 * 老师的回复只能在老师/管理员视角通过 `/api/download` 看到；离线模式下
 * utils/mock 会额外提供本地读取（见 mock.localUploads），让模拟体验完整。
 */
var storage = require("./storage");
var time = require("./time");

var KEY = "sc.mp.uploads.v1";

function readAll() {
  var list = storage.readJson(KEY, []);
  return Array.isArray(list) ? list : [];
}

function writeAll(list) {
  storage.writeJson(KEY, list.slice(0, 200));
}

/** 记录一次本机上传（响应体中的 id 由服务端生成） */
function record(entry) {
  var list = readAll().filter(function (item) {
    return !(item.id === entry.id && item.authKey === entry.authKey);
  });
  list.unshift({
    id: entry.id,
    authKey: entry.authKey,
    submissionId: entry.submissionId,
    submissionName: entry.submissionName || "",
    title: entry.title || "",
    desc: entry.desc || "",
    data: entry.data || [],
    createdAt: entry.createdAt || time.fmtISO(time.now()),
    uploader: entry.uploader || "",
    studentID: entry.studentID || "",
    shortStudentID: entry.shortStudentID || 0,
    role: entry.role || "student",
    reply: entry.reply || [],
    source: entry.source || "device",
  });
  writeAll(list);
  return list[0];
}

function list(authKey) {
  return readAll()
    .filter(function (item) {
      return !authKey || item.authKey === authKey;
    })
    .sort(function (a, b) {
      var ta = time.parseTime(a.createdAt) || 0;
      var tb = time.parseTime(b.createdAt) || 0;
      return tb - ta;
    });
}

function bySubmission(authKey, submissionId) {
  return list(authKey).filter(function (item) {
    return item.submissionId === submissionId;
  });
}

function get(uploadId) {
  var list = readAll();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === uploadId) return list[i];
  }
  return null;
}

/** 老师端回复后，把回复写回本机缓存（同一台设备上切换身份时可以看到） */
function appendReply(uploadId, content) {
  var list = readAll();
  var changed = false;
  list.forEach(function (item) {
    if (item.id !== uploadId) return;
    item.reply = (item.reply || []).concat([content]);
    changed = true;
  });
  if (changed) writeAll(list);
}

function clear() {
  storage.remove(KEY);
}

module.exports = {
  KEY: KEY,
  record: record,
  list: list,
  bySubmission: bySubmission,
  get: get,
  appendReply: appendReply,
  clear: clear,
};
