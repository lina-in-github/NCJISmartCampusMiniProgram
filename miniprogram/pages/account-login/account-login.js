/* 账号中心登录 / 注册（对应 web 端 /login/account）。
 *
 * 小程序无法复用服务端 /user 的 HttpOnly cookie 会话，因此账号本身保存在本机
 * （utils/account.js）；账号里可以绑定多个班级密钥，进入某个身份时再切到对应 auth。 */
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var account = require("../../utils/account");
var api = require("../../utils/api");
var config = require("../../utils/config");
var ui = require("../../utils/ui");

Page({
  data: {
    theme: "light",
    tab: "login",
    username: "",
    password: "",
    password2: "",
    key: "",
    loading: false,
    error: "",
    s: {},
  },

  onShow: function () {
    theme.apply(this);
    if (account.currentUser()) {
      wx.redirectTo({ url: "/pages/account/account" });
      return;
    }
    var cfg = config.get();
    this.setData({
      s: {
        title: strings.t("role_account"),
        desc: strings.t("account_login_desc"),
        username: strings.t("account_username"),
        password: strings.t("account_password"),
        password2: strings.t("account_confirm_password"),
        login: strings.t("account_login"),
        register: strings.t("account_create_bind"),
        firstUse: strings.t("account_first_use"),
        keyOptional: strings.t("account_key_optional"),
        keyNote: strings.t("account_key_note"),
        demo: strings.t("mp_demo_accounts"),
        back: strings.t("account_back_login"),
        settings: strings.t("mp_settings_title"),
        localNote: strings.t("mp_local_account_note"),
        mode: (cfg.mode === "online" ? strings.t("mp_mode_online") : strings.t("mp_mode_offline")) + " · " + cfg.baseUrl,
      },
    });
  },

  onTab: function (e) {
    this.setData({ tab: e.currentTarget.dataset.tab, error: "" });
  },

  onUsername: function (e) {
    this.setData({ username: e.detail.value });
  },

  onPassword: function (e) {
    this.setData({ password: e.detail.value });
  },

  onPassword2: function (e) {
    this.setData({ password2: e.detail.value });
  },

  onKey: function (e) {
    this.setData({ key: e.detail.value });
  },

  onLogin: function () {
    var res = account.login(this.data.username, this.data.password);
    if (!res.ok) {
      this.setData({ error: strings.t(res.key) });
      return;
    }
    ui.toast(strings.t("flash_welcome"), "ok");
    wx.redirectTo({ url: "/pages/account/account" });
  },

  onRegister: function () {
    var self = this;
    var res = account.register(this.data.username, this.data.password, this.data.password2, "");
    if (!res.ok) {
      this.setData({ error: strings.t(res.key) });
      return;
    }
    var key = String(this.data.key || "").trim();
    if (!key) {
      ui.toast(strings.t("flash_account_created"), "ok");
      wx.redirectTo({ url: "/pages/account/account" });
      return;
    }
    this.setData({ loading: true });
    api.probeIdentity(key).then(function (probe) {
      self.setData({ loading: false });
      if (!probe.ok) {
        ui.toast(strings.t("flash_key_invalid"), "error");
        wx.redirectTo({ url: "/pages/account/account" });
        return;
      }
      account.bindKey(key, probe.role, key);
      ui.toast(strings.t("flash_account_created_bound"), "ok");
      wx.redirectTo({ url: "/pages/account/account" });
    });
  },

  onBack: function () {
    wx.reLaunch({ url: "/pages/login/login" });
  },

  onSettings: function () {
    wx.navigateTo({ url: "/pages/settings/settings" });
  },

  onDemo: function () {
    this.setData({ username: "student", password: "student123", error: "" });
  },

  onToggleTheme: function () {
    theme.toggle();
    theme.apply(this);
  },
});
