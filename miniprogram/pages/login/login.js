/* 登录首页：选择身份（家长 / 学生 / 老师 / 管理员），并可进入服务器设置与账号中心。 */
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var config = require("../../utils/config");
var session = require("../../utils/session");

Page({
  data: {
    theme: "light",
    cards: [],
    demo: [],
    modeText: "",
    current: null,
    s: {},
  },

  onShow: function () {
    theme.apply(this);
    var current = session.get();
    var online = config.isOnline();
    var cfg = config.get();
    this.setData({
      s: {
        title: strings.t("title"),
        tagline: strings.t("brand_tagline"),
        welcome: strings.t("login_welcome"),
        welcomeDesc: strings.t("login_welcome_desc"),
        choose: strings.t("login_choose_identity"),
        demoSummary: strings.t("login_demo_summary"),
        footer: strings.t("login_footer_note"),
        accountCenter: strings.t("login_account_center"),
        settings: strings.t("mp_settings_title"),
        continueEnter: strings.t("mp_continue_enter"),
        switchIdentity: strings.t("common_switch_identity"),
        keyOnly: strings.t("common_key_only_visible"),
        account: strings.t("role_account"),
        mode: online ? strings.t("mp_mode_online") : strings.t("mp_mode_offline"),
      },
      cards: [
        {
          role: "parent",
          label: strings.t("login_demo_parent_student"),
          title: strings.t("role_parent"),
          desc: strings.t("login_parent_desc"),
          demo: "SC-STU-DEMO-2026",
        },
        {
          role: "student",
          label: strings.t("role_student"),
          title: strings.t("role_student"),
          desc: strings.t("login_student_page_desc"),
          demo: "SC-STU-DEMO-2026",
        },
        {
          role: "teacher",
          label: strings.t("role_teacher"),
          title: strings.t("role_teacher"),
          desc: strings.t("login_teacher_desc"),
          demo: "SC-TEA-DEMO-2026",
        },
        {
          role: "admin",
          label: strings.t("role_admin"),
          title: strings.t("role_admin"),
          desc: strings.t("login_admin_desc"),
          demo: "SC-ADM-DEMO-2026",
        },
      ],
      demo: [
        { label: strings.t("login_demo_parent"), key: "SC-STU-DEMO-2026" },
        { label: strings.t("login_demo_teacher"), key: "SC-TEA-DEMO-2026" },
        { label: strings.t("login_demo_admin"), key: "SC-ADM-DEMO-2026" },
      ],
      modeText: (online ? strings.t("mp_mode_online") : strings.t("mp_mode_offline")) + " · " + cfg.baseUrl,
      current: current,
    });
    if(current){
      wx.reLaunch({ url: "/pages/home/home" });
    }else{
      wx.reLaunch({ url: "/pages/account-login/account-login"});
    }
  },

  onPickRole: function (e) {
    var role = e.currentTarget.dataset.role;
    wx.navigateTo({ url: "/pages/login-key/login-key?role=" + role });
  },

  onSettings: function () {
    wx.navigateTo({ url: "/pages/settings/settings" });
  },

  onAccount: function () {
    wx.navigateTo({ url: "/pages/account-login/account-login" });
  },

  onContinue: function () {
    var current = session.get();
    if (!current) return;
    wx.reLaunch({ url: "/pages/home/home" });
  },

  onSwitchIdentity: function () {
    session.clear();
    this.onShow();
  },

  onToggleTheme: function () {
    theme.toggle();
    theme.apply(this);
  },
});
