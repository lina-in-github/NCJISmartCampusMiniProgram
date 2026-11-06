/* 当前班级身份会话（相当于服务端的 sc_sid 会话）。
 *
 * 一个 auth = 一个班级 + 一个角色；切换班级必须切换密钥。学生身份另外带一个
 * 「学生视角 / 家长视角」的展示偏好（pageRole），与 v0.1.6 的行为一致：
 * 只影响文案，不影响数据范围，也不影响 /api。 */
var storage = require("./storage");

var KEY = "sc.mp.session.v1";

function get() {
  var saved = storage.readJson(KEY, null);
  if (!saved || !saved.key) return null;
  return {
    key: saved.key,
    role: saved.role || "student",
    pageRole: saved.pageRole || saved.role || "student",
    label: saved.label || "",
    classLabel: saved.classLabel || "",
    view: saved.view === "parent" ? "parent" : "student",
    enteredAt: saved.enteredAt || 0,
  };
}

function set(session) {
  var next = {
    key: String(session.key || "").trim(),
    role: session.role || "student",
    pageRole: session.pageRole || session.role || "student",
    label: session.label || "",
    classLabel: session.classLabel || "",
    view: session.view === "parent" ? "parent" : "student",
    enteredAt: Math.floor(Date.now() / 1000),
  };
  if (!next.key) {
    storage.remove(KEY);
    return null;
  }
  storage.writeJson(KEY, next);
  return next;
}

function patch(partial) {
  var current = get();
  if (!current) return null;
  var next = {};
  Object.keys(current).forEach(function (k) {
    next[k] = current[k];
  });
  Object.keys(partial || {}).forEach(function (k) {
    next[k] = partial[k];
  });
  return set(next);
}

function clear() {
  storage.remove(KEY);
}

/** 顶栏显示的身份文字：优先使用账号里给这个密钥起的名字 */
function displayName(session) {
  var current = session || get();
  if (!current) return "";
  if (current.label) return current.label;
  var tail = current.key.slice(-4);
  return tail ? "SC-…-" + tail : current.key;
}

module.exports = {
  KEY: KEY,
  get: get,
  set: set,
  patch: patch,
  clear: clear,
  displayName: displayName,
};
