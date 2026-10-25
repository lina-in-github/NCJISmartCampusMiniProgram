/* 页面公共逻辑：会话守卫、顶栏数据、学生 / 家长视角切换。 */
var sessionStore = require("./session");
var config = require("./config");
var theme = require("./theme");
var time = require("./time");
var strings = require("./strings");

function ctxOf() {
  var session = sessionStore.get();
  if (!session) return null;
  var staff = session.role === "teacher" || session.role === "admin";
  return {
    key: session.key,
    keyTail: session.key.slice(-4),
    role: session.role,
    pageRole: session.pageRole,
    staff: staff,
    parent: session.pageRole === "parent",
    studentView: session.role === "student",
    identityText: sessionStore.displayName(session),
    roleText: time.roleLabel(session.pageRole),
    classText: session.classLabel || "",
    offline: !config.isOnline(),
    modeText: (config.isOnline() ? strings.t("mp_mode_online") : strings.t("mp_mode_offline")) + " · " + config.get().baseUrl,
    viewText: session.pageRole === "parent" ? strings.t("common_view_parent") : strings.t("common_view_student"),
  };
}

/** 页面 onShow 调用：保证已登录，并写入 theme / ctx */
function guard(page) {
  var themeName = theme.apply(page);
  var ctx = ctxOf();
  if (!ctx) {
    page.setData({ ctx: null });
    wx.reLaunch({ url: "/pages/login/login" });
    return null;
  }
  page.setData({ ctx: ctx, theme: themeName });
  return ctx;
}

/** 「学生视角 / 家长视角」切换（仅学生身份；只影响文案，数据范围不变） */
function switchView(page, pageRole) {
  var session = sessionStore.get();
  if (!session || session.role !== "student") return null;
  var next = pageRole === "parent" ? "parent" : "student";
  sessionStore.patch({ pageRole: next, view: next });
  var ctx = ctxOf();
  if (page && typeof page.setData === "function") page.setData({ ctx: ctx });
  return ctx;
}

module.exports = {
  ctxOf: ctxOf,
  guard: guard,
  switchView: switchView,
  strings: strings,
};
