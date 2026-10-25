/* 深浅色模式：账号偏好（light / dark / system）+ 系统主题。 */
var account = require("./account");
var storage = require("./storage");

var GUEST_KEY = "sc.mp.theme.guest";

function systemTheme() {
  if (typeof wx !== "undefined" && wx && typeof wx.getSystemInfoSync === "function") {
    try {
      var info = wx.getSystemInfoSync();
      if (info && info.theme === "dark") return "dark";
    } catch (e) {
      /* ignore */
    }
  }
  return "light";
}

/** 解析当前应使用的主题：账号偏好优先，其次未登录时记住的临时主题，最后跟随系统 */
function resolve() {
  var prefs = account.prefs();
  if (prefs.theme === "dark" || prefs.theme === "light") return prefs.theme;
  var guest = storage.readJson(GUEST_KEY, null);
  if (guest === "dark" || guest === "light") return guest;
  return systemTheme();
}

/** 给页面写入 `theme` 字段（WXML 根节点用 `class="app theme-{{theme}}"`） */
function apply(page) {
  var theme = resolve();
  if (page && typeof page.setData === "function") page.setData({ theme: theme });
  return theme;
}

/** 顶栏一键切换主题；登录账号时写进偏好，否则只记在本机 */
function toggle() {
  var next = resolve() === "dark" ? "light" : "dark";
  if (account.currentUser()) account.savePrefs({ theme: next });
  else storage.writeJson(GUEST_KEY, next);
  return next;
}

module.exports = {
  GUEST_KEY: GUEST_KEY,
  systemTheme: systemTheme,
  resolve: resolve,
  apply: apply,
  toggle: toggle,
};
