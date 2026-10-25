/* 账号中心：偏好设置、密码、班级身份（进入 / 改名 / 解绑 / 删除密钥）、
 * 管理员操作（创建班级、生成成员密钥）。
 *
 * 账号与偏好保存在本机（服务端 /user 依赖 HttpOnly cookie 会话，小程序无法复用）；
 * 涉及班级数据的操作一律走 `/api`：
 *   改名 -> /api/rename-auth  删除密钥 -> /api/del-key
 *   创建班级 -> /api/new-class  生成成员 -> /api/new-user */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var time = require("../../utils/time");
var account = require("../../utils/account");
var sessionStore = require("../../utils/session");
var config = require("../../utils/config");
var api = require("../../utils/api");
var ui = require("../../utils/ui");

var MEMBER_TYPES = [
  { value: "Student", labelKey: "role_student" },
  { value: "Teacher", labelKey: "role_teacher" },
  { value: "Admin", labelKey: "role_admin" },
];

Page({
  data: {
    theme: "light",
    ctx: null,
    user: null,
    prefs: {},
    displayName: "",
    themeLabels: [],
    themeValues: ["system", "light", "dark"],
    viewLabels: [],
    viewValues: ["student", "parent"],
    themeIndex: 0,
    viewIndex: 0,
    stats: { identities: 0, admins: 0, classes: 0 },
    bindings: [],
    adminBindings: [],
    adminIndex: 0,
    newKey: "",
    binding: false,
    classForm: { name: "", desc: "", classId: "" },
    memberForm: { classId: "", quantity: "3", typeIndex: 0 },
    generated: [],
    pwd: { old: "", new1: "", new2: "" },
    s: {},
  },

  onShow: function () {
    theme.apply(this);
    var user = account.currentUser();
    if (!user) {
      wx.redirectTo({ url: "/pages/account-login/account-login" });
      return;
    }
    this.setData({
      s: {
        title: strings.t("role_account"),
        statsAuths: strings.t("account_stats_auths"),
        statsClasses: strings.t("account_stats_classes"),
        statsAdmin: strings.t("account_stats_admin"),
        displayName: strings.t("account_display_name"),
        theme: strings.t("account_theme"),
        themeLabels: [
          strings.t("account_theme_system"),
          strings.t("account_theme_light"),
          strings.t("account_theme_dark"),
        ],
        viewMode: strings.t("account_view_mode"),
        viewModeHint: strings.t("account_view_mode_hint"),
        viewLabels: [strings.t("common_view_student"), strings.t("common_view_parent")],
        savePrefs: strings.t("account_save_prefs"),
        security: strings.t("account_security"),
        currentPassword: strings.t("account_current_password"),
        newPassword: strings.t("account_new_password"),
        confirmNewPassword: strings.t("account_confirm_new_password"),
        changePassword: strings.t("account_change_password"),
        logoutAccount: strings.t("account_logout"),
        myAuths: strings.t("account_my_auths"),
        noAuthsTitle: strings.t("account_no_auths_title"),
        noAuthsDesc: strings.t("account_no_auths_desc"),
        addAuth: strings.t("account_add_auth"),
        addAuthPlaceholder: strings.t("account_add_auth_placeholder"),
        bind: strings.t("account_bind"),
        adminArea: strings.t("account_admin_area"),
        adminHint: strings.t("account_admin_hint"),
        notAdminNote: strings.t("account_not_admin_note"),
        className: strings.t("account_class_name"),
        classNamePlaceholder: strings.t("account_class_name_placeholder"),
        classCreateAs: strings.t("account_class_create_as"),
        classDesc: strings.t("account_class_desc"),
        classDescPlaceholder: strings.t("account_class_desc_placeholder"),
        classCreate: strings.t("account_class_create"),
        memberRole: strings.t("account_member_role"),
        memberQuantity: strings.t("account_member_quantity"),
        memberGenerate: strings.t("account_member_generate"),
        memberNote: strings.t("account_member_note"),
        memberHint: strings.t("account_member_hint"),
        copyKey: strings.t("account_copy_key"),
        renameIdentity: strings.t("account_rename_identity"),
        deleteIdentity: strings.t("account_delete_identity"),
        renameTitle: strings.t("account_rename_title"),
        renameLabel: strings.t("account_rename_label"),
        renameHint: strings.t("account_rename_hint"),
        enter: strings.t("common_enter"),
        generatedTitle: "",
        memberTypeLabels: MEMBER_TYPES.map(function (t) {
          return strings.t(t.labelKey);
        }),
        mode: (config.isOnline() ? strings.t("mp_mode_online") : strings.t("mp_mode_offline")) +
          " · " + config.get().baseUrl,
        localNote: strings.t("mp_local_account_note"),
        unbind: strings.t("mp_unbind_identity"),
        deleteKey: strings.t("mp_delete_key_remote"),
        classIdLabel: strings.t("mp_class_id_label"),
        classIdHint: strings.t("mp_class_id_hint"),
        settings: strings.t("mp_settings_title"),
      },
    });
    this.refresh();
  },

  refresh: function () {
    var user = account.currentUser();
    if (!user) return;
    var prefs = account.prefs();
    var themeIndex = ["system", "light", "dark"].indexOf(prefs.theme);
    var current = sessionStore.get();
    var bindings = (user.bindings || []).map(function (b) {
      return {
        key: b.key,
        role: b.role,
        roleText: time.roleLabel(b.role),
        label: b.label || b.key,
        current: current ? current.key === b.key : false,
        keyTail: String(b.key).slice(-4),
      };
    });
    var adminBindings = bindings.filter(function (b) {
      return b.role === "admin";
    });
    this.setData({
      user: { username: user.username, displayName: user.displayName },
      prefs: prefs,
      displayName: user.displayName || user.username,
      themeIndex: themeIndex < 0 ? 0 : themeIndex,
      viewIndex: prefs.view === "parent" ? 1 : 0,
      bindings: bindings,
      adminBindings: adminBindings,
      stats: {
        identities: bindings.length,
        admins: adminBindings.length,
        classes: bindings.length,
      },
    });
    if (typeof wx !== "undefined" && wx && wx.setNavigationBarTitle) {
      wx.setNavigationBarTitle({ title: strings.t("role_account") });
    }
  },

  onDisplayName: function (e) {
    this.setData({ displayName: e.detail.value });
  },

  onThemePick: function (e) {
    var idx = parseInt(e.detail.value, 10) || 0;
    this.setData({ themeIndex: idx });
  },

  onViewPick: function (e) {
    var idx = parseInt(e.detail.value, 10) || 0;
    this.setData({ viewIndex: idx });
  },

  onSavePrefs: function () {
    var res = account.savePrefs({
      displayName: this.data.displayName,
      theme: this.data.themeValues[this.data.themeIndex],
      view: this.data.viewValues[this.data.viewIndex],
    });
    if (!res.ok) {
      ui.toast(strings.t(res.key), "error");
      return;
    }
    var session = sessionStore.get();
    if (session && session.role === "student") {
      var view = this.data.viewValues[this.data.viewIndex];
      sessionStore.patch({ view: view, pageRole: view });
    }
    ui.toast(strings.t("flash_prefs_saved"), "ok");
    theme.apply(this);
    this.refresh();
  },

  onPwdOld: function (e) {
    this.setData({ "pwd.old": e.detail.value });
  },
  onPwdNew: function (e) {
    this.setData({ "pwd.new1": e.detail.value });
  },
  onPwdNew2: function (e) {
    this.setData({ "pwd.new2": e.detail.value });
  },

  onChangePassword: function () {
    var res = account.changePassword(this.data.pwd.old, this.data.pwd.new1, this.data.pwd.new2);
    if (!res.ok) {
      ui.toast(strings.t(res.key), "error");
      return;
    }
    ui.toast(strings.t("flash_password_changed"), "ok");
    this.setData({ pwd: { old: "", new1: "", new2: "" } });
  },

  onLogoutAccount: function () {
    account.logout();
    wx.reLaunch({ url: "/pages/login/login" });
  },

  onNewKey: function (e) {
    this.setData({ newKey: e.detail.value });
  },

  onBindKey: function () {
    var self = this;
    var key = String(this.data.newKey || "").trim();
    if (!key) {
      ui.toast(strings.t("flash_enter_key"), "error");
      return;
    }
    this.setData({ binding: true });
    api.probeIdentity(key).then(function (probe) {
      self.setData({ binding: false });
      if (!probe.ok) {
        ui.toast(strings.t("flash_key_invalid"), "error");
        return;
      }
      var res = account.bindKey(key, probe.role, key);
      if (!res.ok) {
        ui.toast(strings.t(res.key), "error");
        return;
      }
      ui.toast(strings.t("flash_bound"), "ok");
      self.setData({ newKey: "" });
      self.refresh();
    });
  },

  onEnter: function (e) {
    var key = e.currentTarget.dataset.key;
    var binding = account.findBinding(key);
    if (!binding) return;
    var prefs = account.prefs();
    var pageRole = binding.role === "student" ? (prefs.view === "parent" ? "parent" : "student") : binding.role;
    sessionStore.set({
      key: binding.key,
      role: binding.role,
      pageRole: pageRole,
      view: pageRole,
      label: binding.label || binding.key,
      classLabel: binding.label || "",
    });
    ui.toast(strings.t("flash_welcome"), "ok");
    wx.reLaunch({ url: "/pages/home/home" });
  },

  onCopyKey: function (e) {
    var key = e.currentTarget.dataset.key;
    ui.copy(key).then(function (ok) {
      ui.toast(ok ? strings.t("toast_copy_ok") : strings.t("toast_copy_failed"), ok ? "ok" : "error");
    });
  },

  onRename: function (e) {
    var self = this;
    var key = e.currentTarget.dataset.key;
    if (typeof wx === "undefined" || !wx || typeof wx.showModal !== "function") return;
    wx.showModal({
      title: strings.t("account_rename_title"),
      editable: true,
      placeholderText: strings.t("account_rename_label"),
      success: function (res) {
        if (!res.confirm) return;
        var name = String(res.content || "").trim();
        if (!name) {
          ui.toast(strings.t("toast_enter_rename"), "error");
          return;
        }
        ui.loading(strings.t("toast_saving"));
        api.renameAuth({ auth: key, name: name }).then(function (r) {
          ui.hideLoading();
          if (!r.ok) {
            ui.toast(r.msg || strings.t("flash_change_failed"), "error");
            return;
          }
          account.renameBinding(key, name);
          var session = sessionStore.get();
          if (session && session.key === key) sessionStore.patch({ label: name });
          ui.toast(strings.t("toast_renamed"), "ok");
          self.refresh();
        });
      },
    });
  },

  onUnbind: function (e) {
    var self = this;
    var key = e.currentTarget.dataset.key;
    ui.confirm(strings.t("mp_unbind_confirm"), strings.t("mp_unbind_identity")).then(function (yes) {
      if (!yes) return;
      account.unbind(key);
      var session = sessionStore.get();
      if (session && session.key === key) sessionStore.clear();
      ui.toast(strings.t("flash_identity_deleted"), "ok");
      self.refresh();
    });
  },

  onDeleteKeyRemote: function (e) {
    var self = this;
    var key = e.currentTarget.dataset.key;
    ui.confirm(strings.S("toast_delete_confirm_message", key), strings.t("toast_delete_confirm_title")).then(
      function (yes) {
        if (!yes) return;
        api.delKey({ auth: key }).then(function (res) {
          if (!res.ok) {
            ui.toast(res.msg || strings.t("flash_delete_failed"), "error");
            return;
          }
          account.unbind(key);
          var session = sessionStore.get();
          if (session && session.key === key) sessionStore.clear();
          ui.toast(strings.t("toast_deleted"), "ok");
          self.refresh();
        });
      }
    );
  },

  onAdminPick: function (e) {
    this.setData({ adminIndex: parseInt(e.detail.value, 10) || 0 });
  },

  onClassName: function (e) {
    this.setData({ "classForm.name": e.detail.value });
  },
  onClassDesc: function (e) {
    this.setData({ "classForm.desc": e.detail.value });
  },

  onCreateClass: function () {
    var self = this;
    var admin = this.data.adminBindings[this.data.adminIndex];
    if (!admin) {
      ui.toast(strings.t("toast_select_admin"), "error");
      return;
    }
    var name = String(this.data.classForm.name || "").trim();
    var desc = String(this.data.classForm.desc || "").trim();
    if (!name && !desc) {
      ui.toast(strings.t("account_class_name"), "error");
      return;
    }
    ui.loading(strings.t("toast_saving"));
    api.newClass({ auth: admin.key, name: name, desc: desc }).then(function (res) {
      ui.hideLoading();
      if (!res.ok) {
        ui.toast(res.msg || strings.t("flash_request_failed"), "error");
        return;
      }
      account.bindKey(res.auth, "admin", (name || desc) + " · " + strings.t("role_admin"));
      self.setData({
        "classForm.name": "",
        "classForm.desc": "",
        "memberForm.classId": res.id,
      });
      ui.toast(strings.t("flash_class_created"), "ok");
      self.refresh();
      // 自动选中刚创建班级的管理员身份，便于立即生成成员密钥
      var list = self.data.adminBindings || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].key === res.auth) self.setData({ adminIndex: i });
      }
    });
  },

  onMemberClassId: function (e) {
    this.setData({ "memberForm.classId": e.detail.value });
  },
  onMemberQuantity: function (e) {
    this.setData({ "memberForm.quantity": e.detail.value });
  },
  onMemberType: function (e) {
    this.setData({ "memberForm.typeIndex": parseInt(e.detail.value, 10) || 0 });
  },

  onGenerateMembers: function () {
    var self = this;
    var admin = this.data.adminBindings[this.data.adminIndex];
    if (!admin) {
      ui.toast(strings.t("toast_select_admin"), "error");
      return;
    }
    var classId = String(this.data.memberForm.classId || "").trim();
    if (!classId) {
      ui.toast(strings.t("mp_class_id_hint"), "error");
      return;
    }
    var quantity = parseInt(this.data.memberForm.quantity, 10);
    if (!isFinite(quantity) || quantity < 1 || quantity > 100) {
      ui.toast(strings.t("toast_quantity_range"), "error");
      return;
    }
    ui.loading(strings.t("toast_generating"));
    api
      .newUser({
        auth: admin.key,
        classID: classId,
        quantity: quantity,
        type: MEMBER_TYPES[this.data.memberForm.typeIndex].value,
      })
      .then(function (res) {
        ui.hideLoading();
        if (!res.ok) {
          ui.toast(res.msg || strings.t("flash_request_failed"), "error");
          return;
        }
        var generated = (res.members || []).map(function (m) {
          return {
            id: m.id,
            key: m.key,
            roleText: time.roleLabel(m.role),
            studentID: m.studentID,
            displayName: m.displayName,
          };
        });
        self.setData({
          generated: generated,
          "s.generatedTitle": strings.S("account_member_generated_title", generated.length),
        });
        ui.toast(strings.S("account_member_generated_toast", (res.keys || []).length), "ok");
      });
  },

  onCopyGenerated: function () {
    var text = this.data.generated
      .map(function (m) {
        return m.key + "\t" + m.roleText + "\t" + (m.studentID || "") + "\t" + m.displayName;
      })
      .join("\n");
    ui.copy(text).then(function (ok) {
      ui.toast(ok ? strings.t("toast_copy_ok") : strings.t("toast_copy_failed"), ok ? "ok" : "error");
    });
  },

  onSubmissions: function () {
    wx.reLaunch({ url: "/pages/home/home" });
  },

  onSettings: function () {
    wx.navigateTo({ url: "/pages/settings/settings" });
  },

  onToggleTheme: function () {
    theme.toggle();
    theme.apply(this);
    this.refresh();
  },
});
