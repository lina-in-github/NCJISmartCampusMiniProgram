/* 角色密钥登录：与 web 端 /login/<mob|pc>/<role> 等价。
 *
 * 登录时用 /api 探测密钥的真实角色（只读探测，不写入任何数据）：
 *   /api/all-submission -> 401 表示密钥无效
 *   /api/download       -> 403 学生 / 404 教职工
 *   /api/new-class      -> 403 老师 / 400 管理员
 * 角色不匹配时与 web 端一样拒绝登录（一个密钥只对应一个班级与一个角色）。 */
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var api = require("../../utils/api");
var config = require("../../utils/config");
var session = require("../../utils/session");
var account = require("../../utils/account");
var mock = require("../../utils/mock");
var ui = require("../../utils/ui");

var DEMO = {
  parent: "SC-STU-DEMO-2026",
  student: "SC-STU-DEMO-2026",
  teacher: "SC-TEA-DEMO-2026",
  admin: "SC-ADM-DEMO-2026",
};

Page({
  data: {
    theme: "light",
    role: "student",
    key: "",
    loading: false,
    error: "",
    s: {},
  },

  onLoad: function (query) {
    var role = (query && query.role) || "student";
    if (["parent", "student", "teacher", "admin"].indexOf(role) < 0) role = "student";
    this.setData({ role: role });
  },

  onShow: function () {
    theme.apply(this);
    var role = this.data.role;
    var titleKey =
      role === "parent"
        ? "login_parent_page_title"
        : role === "teacher"
        ? "login_teacher_page_title"
        : role === "admin"
        ? "login_admin_page_title"
        : "login_student_page_title";
    var descKey =
      role === "parent"
        ? "login_parent_page_desc"
        : role === "teacher"
        ? "login_teacher_page_desc"
        : role === "admin"
        ? "login_admin_page_desc"
        : "login_student_page_desc";
    var placeholderKey =
      role === "teacher"
        ? "login_placeholder_teacher"
        : role === "admin"
        ? "login_placeholder_admin"
        : "login_placeholder";
    var demoKey =
      role === "teacher"
        ? "login_demo_teacher"
        : role === "admin"
        ? "login_demo_admin"
        : "login_demo_parent";
    this.setData({
      s: {
        title: strings.t(titleKey),
        desc: strings.t(descKey),
        keyLabel: strings.t("login_key_label"),
        keyHint: strings.t("login_key_hint"),
        placeholder: strings.t(placeholderKey),
        demoLabel: strings.t(demoKey),
        demo: DEMO[role] || "",
        submit: strings.t("login_submit"),
        other: strings.t("login_other_identity"),
        authorized: strings.t("login_authorized_note"),
        roleText: strings.t(
          role === "parent" ? "role_parent" : role === "teacher" ? "role_teacher" : role === "admin" ? "role_admin" : "role_student"
        ),
        fill: strings.t("common_click_fill"),
        accountCenter: strings.t("login_account_center_link"),
      },
    });
    if (typeof wx !== "undefined" && wx && wx.setNavigationBarTitle) {
      wx.setNavigationBarTitle({ title: strings.t(titleKey) });
    }
  },

  onInput: function (e) {
    this.setData({ key: e.detail.value, error: "" });
  },

  onFillDemo: function () {
    this.setData({ key: this.data.s.demo || DEMO[this.data.role] || "", error: "" });
    ui.toast(strings.t("toast_demo_filled"));
  },

  onSubmit: function () {
    var self = this;
    var role = this.data.role;
    var key = String(this.data.key || "").trim();
    if (!key) {
      this.setData({ error: strings.t("login_error_enter_key") });
      return;
    }
    if (this.data.loading) return;
    this.setData({ loading: true, error: "" });
    api
      .probeIdentity(key)
      .then(function (probe) {
        if (!probe.ok) {
          self.setData({ loading: false, error: strings.t("login_error_invalid_key") });
          return;
        }
        var expected = role === "parent" || role === "student" ? "student" : role;
        if (probe.role !== expected) {
          self.setData({
            loading: false,
            error: strings.S(
              "login_error_role_mismatch",
              strings.t("role_" + probe.role),
              strings.t("role_" + expected)
            ),
          });
          return;
        }
        var label = "";
        var classLabel = "";
        var binding = account.findBinding(key);
        if (binding) {
          label = binding.label || "";
          classLabel = label;
        }
        if (!config.isOnline()) {
          var profile = mock.localProfile(key);
          if (profile && profile.class) classLabel = profile.class.name;
          if (!label && profile) label = profile.class ? profile.class.name + " · " + profile.identity : profile.identity;
        }
        session.set({
          key: key,
          role: probe.role,
          pageRole: role,
          view: role === "parent" ? "parent" : "student",
          label: label,
          classLabel: classLabel,
        });
        if (account.currentUser() && !binding) {
          account.bindKey(key, probe.role, label || key);
        }
        self.setData({ loading: false });
        ui.toast(strings.t("flash_welcome"), "ok");
        wx.reLaunch({ url: "/pages/home/home" });
      })
      .catch(function (err) {
        self.setData({ loading: false, error: String(err && err.message ? err.message : err) });
      });
  },

  onOtherIdentity: function () {
    if (typeof getCurrentPages === "function" && getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/login/login" });
  },

  onAccount: function () {
    wx.navigateTo({ url: "/pages/account-login/account-login" });
  },
});
