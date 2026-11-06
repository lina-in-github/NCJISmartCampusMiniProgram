/* 深浅色模式：账号偏好（light / dark / system）+ 系统主题。
 *
 * 页面内容用 `.app.theme-dark` 上的 CSS 变量切换；原生导航栏则在运行时用
 * `wx.setNavigationBarColor` 跟着换色。
 *
 * 注意：这里**不使用** app.json 的 `themeLocation` / theme.json。部分微信开发者工具
 * 版本在编译 app.json 时会走 SummerCompiler.checkThemeJSON，而该构建缺少这个方法，
 * 会导致「Build server task failed: getAppConfig: SummerCompiler has no method
 * "checkThemeJSON"」。`darkmode: true` 仍然保留：`wx.onThemeChange` 与
 * `wx.getAppBaseInfo().theme` 依赖它。 */
var account = require("./account");
var storage = require("./storage");

var GUEST_KEY = "sc.mp.theme.guest";
var NAV_COLORS = { light: "#0010ff", dark: "#0b0d1a" };

function systemTheme() {
  if (typeof wx === "undefined" || !wx) return "light";
  try {
    // 新基础库推荐 getAppBaseInfo（含 theme）；只有它没给出 theme 时才回退旧接口。
    if (typeof wx.getAppBaseInfo === "function") {
      var app = wx.getAppBaseInfo();
      if (app && (app.theme === "dark" || app.theme === "light")) return app.theme;
    }
    if (typeof wx.getSystemInfoSync === "function") {
      var info = wx.getSystemInfoSync();
      if (info && info.theme === "dark") return "dark";
    }
  } catch (e) {
    /* ignore */
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

/** 原生导航栏跟随当前主题（页面里没有 theme.json，也就不需要重启小程序） */
function applyNavigationBar(theme) {
  if (typeof wx === "undefined" || !wx || typeof wx.setNavigationBarColor !== "function") return;
  wx.setNavigationBarColor({
    frontColor: "#ffffff",
    backgroundColor: NAV_COLORS[theme] || NAV_COLORS.light,
    animation: { duration: 0, timingFunc: "linear" },
    fail: function () {
      /* 某些宿主/页面不支持时忽略 */
    },
  });
}

/** 给页面写入 `theme` 字段（WXML 根节点用 `class="app theme-{{theme}}"`） */
function apply(page) {
  var theme = resolve();
  if (page && typeof page.setData === "function") page.setData({ theme: theme });
  applyNavigationBar(theme);
  return theme;
}

/** 顶栏一键切换主题；登录账号时写进偏好，否则只记在本机 */
function toggle() {
  var next = resolve() === "dark" ? "light" : "dark";
  if (account.currentUser()) account.savePrefs({ theme: next });
  else storage.writeJson(GUEST_KEY, next);
  applyNavigationBar(next);
  return next;
}

module.exports = {
  GUEST_KEY: GUEST_KEY,
  systemTheme: systemTheme,
  resolve: resolve,
  apply: apply,
  applyNavigationBar: applyNavigationBar,
  toggle: toggle,
};
