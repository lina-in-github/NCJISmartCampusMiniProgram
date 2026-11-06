/* 智慧校园 · 微信小程序模拟端
 *
 * 两种数据来源：
 *   * 在线：真实 Rust 服务的 `POST /api/*`（请求/响应与 doc/api.md 完全同构）；
 *   * 离线：utils/mock 在本地按同一份契约应答。
 * 入口页可在「登录」页右上角或「设置」页随时切换并填写服务器 IP。 */
var config = require("./utils/config");
var theme = require("./utils/theme");
var session = require("./utils/session");
var account = require("./utils/account");

App({
  globalData: {
    version: "v0.1.6-mp.1",
    startedAt: 0,
  },

  onLaunch: function () {
    this.globalData.startedAt = Date.now();
    // 读一次配置，保证首次启动就写入默认值（在线模式 + 默认服务器地址）
    config.get();
    // 初始化本地账号（含演示账号 admin/teacher/student）与偏好
    account.load();
    if (typeof wx !== "undefined" && wx && typeof wx.onThemeChange === "function") {
      wx.onThemeChange(function () {
        var pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
        var top = pages.length ? pages[pages.length - 1] : null;
        if (top && typeof top.setData === "function") theme.apply(top);
      });
    }
  },

  /** 当前主题（light / dark） */
  theme: function () {
    return theme.resolve();
  },

  /** 顶栏一键切换主题 */
  toggleTheme: function () {
    return theme.toggle();
  },

  /** 当前班级身份会话 */
  session: function () {
    return session.get();
  },

  /** 服务器配置快照 */
  config: function () {
    return config.get();
  },
});
