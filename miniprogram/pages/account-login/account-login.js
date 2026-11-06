/* 账号中心登录 / 注册（对应 web 端 /login/account）。
 *
 * v0.1.7 起与 Web 端一致：密码只在本机通过 PBKDF2 派生 X25519 私钥，
 * 注册 / 改密只上传公钥，登录时解密服务端挑战；密码不会出现在任何请求体里。
 * 在线模式请求真实服务器，离线模式由 utils/mock 按同一套接口契约应答。 */
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var account = require("../../utils/account");
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
        deriving: strings.t("mp_deriving_key"),
        mode: (cfg.mode === "online" ? strings.t("mp_mode_online") : strings.t("mp_mode_offline")) + " · " + cfg.baseUrl,
      },
    });
  },

  onTab: function (e) {
    if (this.data.loading) return;
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
    var self = this;
    if (self.data.loading) return;
    var username = String(self.data.username || "").trim();
    var password = self.data.password;
    if (!username || !password) {
      self.setData({ error: strings.t("flash_enter_username_password") });
      return;
    }
    self.setData({ loading: true, error: "" });
    account.login(username, password).then(function (res) {
      self.setData({ loading: false });
      if (!res.ok) {
        self.setData({ error: strings.t(res.key) });
        return;
      }
      ui.toast(strings.t("flash_welcome"), "ok");
      wx.redirectTo({ url: "/pages/account/account" });
    }).catch(function () {
      self.setData({ loading: false, error: strings.t("flash_request_failed") });
    });
  },

  onRegister: function () {
    var self = this;
    if (self.data.loading) return;
    var username = String(self.data.username || "").trim();
    var password = self.data.password;
    if (!username || !password) {
      self.setData({ error: strings.t("flash_enter_username_password") });
      return;
    }
    if (Array.from(String(password)).length < 6) {
      self.setData({ error: strings.t("flash_password_min") });
      return;
    }
    if (password !== self.data.password2) {
      self.setData({ error: strings.t("flash_password_mismatch") });
      return;
    }
    self.setData({ loading: true, error: "" });
    account.register(username, password, self.data.password2, self.data.key).then(function (res) {
      self.setData({ loading: false });
      if (!res.ok) {
        self.setData({ error: strings.t(res.key) });
        return;
      }
      ui.toast(
        strings.t(res.boundAuth ? "flash_account_created_bound" : "flash_account_created"),
        "ok"
      );
      wx.redirectTo({ url: "/pages/account/account" });
    }).catch(function () {
      self.setData({ loading: false, error: strings.t("flash_request_failed") });
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
