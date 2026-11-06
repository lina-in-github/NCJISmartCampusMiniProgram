/* 征集类型管理（管理员）：查看 / 新增 / 删除本班自定义征集模式。 */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var time = require("../../utils/time");
var api = require("../../utils/api");
var ui = require("../../utils/ui");
var dialog = require("../../utils/dialog");

function baseLabel(base) {
  var raw = String(base === null || base === undefined ? "" : base).trim();
  if (!raw) return strings.t("type_other");
  return time.typeLabel(raw);
}

function flagsOf(mode) {
  var badges = [];
  if (mode.abstract) badges.push({ label: strings.t("account_mode_flag_abstract"), tone: "warn" });
  if (mode.invisible) badges.push({ label: strings.t("account_mode_flag_invisible"), tone: "danger" });
  if (mode.adminOnly) badges.push({ label: strings.t("account_mode_flag_admin_only"), tone: "danger" });
  else if (mode.teacherOnly) {
    badges.push({ label: strings.t("account_mode_flag_teacher_only"), tone: "warn" });
  }
  if (mode.hidden) badges.push({ label: strings.t("account_mode_flag_hidden"), tone: "warn" });
  if (mode.separateList && !mode.abstract) {
    badges.push({ label: strings.t("account_mode_flag_separate"), tone: "pinned" });
  }
  return badges;
}

Page({
  data: {
    theme: "light",
    ctx: null,
    modes: [],
    loading: true,
    modeForm: { name: "", displayName: "", extends: "", abstract: false },
    dialog: dialog.base(),
    s: {},
  },

  onShow: function () {
    var ctx = pageUtil.guard(this);
    if (!ctx) return;
    if (ctx.role !== "admin") {
      ui.toast(strings.t("flash_forbidden"), "error");
      wx.reLaunch({ url: "/pages/account/account" });
      return;
    }
    this.setData({
      s: {
        title: strings.t("mp_modes_title"),
        subtitle: strings.t("mp_modes_hint"),
        account: strings.t("role_account"),
        listTitle: strings.t("mp_modes_title"),
        listHint: strings.t("mp_modes_hint"),
        none: strings.t("mp_modes_none"),
        emptyHint: strings.t("mp_modes_empty_hint"),
        countText: "",
        extendsLabel: strings.t("mp_modes_extends_label"),
        createdLabel: strings.t("mp_modes_created_label"),
        delete: strings.t("mp_modes_delete"),
        formTitle: strings.t("mp_mode_form_title"),
        nameLabel: strings.t("mp_mode_name_label"),
        displayNameLabel: strings.t("mp_mode_display_name_label"),
        extendsFieldLabel: strings.t("mp_mode_extends_label"),
        extendsPlaceholder: strings.t("mp_extend_placeholder"),
        create: strings.t("mp_mode_create"),
        formHint: strings.t("mp_mode_hint"),
        abstract: strings.t("mp_mode_abstract"),
        abstractHint: strings.t("mp_mode_abstract_hint"),
        saving: strings.t("toast_saving"),
      },
    });
    this.loadModes(ctx);
  },

  loadModes: function (ctx) {
    var self = this;
    this.setData({ loading: true });
    api
      .allModes({ auth: ctx.key })
      .then(function (res) {
        if (!res.ok) {
          self.setData({ loading: false });
          ui.toast(res.msg || strings.t("flash_request_failed"), "error");
          return;
        }
        var modes = (res.modes || [])
          .filter(function (mode) {
            return !mode.builtin;
          })
          .map(function (mode) {
            var displayName =
              mode.displayName || mode.modeName || mode.name || strings.t("type_generic");
            var extendsText = (mode.extendModes || []).length
              ? mode.extendModes.join(", ")
              : "—";
            var created = String(mode.createdAt || "").slice(0, 10);
            var createdText = [created, mode.createdBy || ""]
              .filter(function (part) {
                return String(part || "").trim();
              })
              .join(" · ");
            return {
              id: mode.id,
              name: mode.modeName || mode.name || "",
              displayName: displayName,
              baseLabel: baseLabel(mode.baseType),
              extendsText: extendsText,
              createdText: createdText,
              badges: flagsOf(mode),
            };
          });
        self.setData({
          loading: false,
          modes: modes,
          "s.countText": strings.S("mp_modes_count", modes.length),
        });
      })
      .catch(function (err) {
        self.setData({ loading: false });
        ui.toast(String(err && err.message ? err.message : err), "error");
      });
  },

  onBack: function () {
    wx.navigateBack({
      fail: function () {
        wx.reLaunch({ url: "/pages/account/account" });
      },
    });
  },

  onModeName: function (e) {
    this.setData({ "modeForm.name": e.detail.value });
  },

  onModeDisplayName: function (e) {
    this.setData({ "modeForm.displayName": e.detail.value });
  },

  onModeExtends: function (e) {
    this.setData({ "modeForm.extends": e.detail.value });
  },

  onModeAbstract: function () {
    this.setData({ "modeForm.abstract": !this.data.modeForm.abstract });
  },

  onAddMode: function () {
    var self = this;
    var ctx = this.data.ctx;
    var name = String(this.data.modeForm.name || "").trim();
    if (!name) {
      ui.toast(strings.t("mp_mode_name_required"), "error");
      return;
    }
    var extendModes = String(this.data.modeForm.extends || "")
      .split(/[,，]/)
      .map(function (value) {
        return value.trim();
      })
      .filter(Boolean);
    ui.loading(strings.t("toast_saving"));
    api
      .newMode({
        auth: ctx.key,
        modeName: name,
        displayName: String(this.data.modeForm.displayName || "").trim() || name,
        extendModes: extendModes,
        abstract: this.data.modeForm.abstract === true,
      })
      .then(function (res) {
        ui.hideLoading();
        if (!res.ok) {
          ui.toast(res.msg || strings.t("flash_request_failed"), "error");
          return;
        }
        self.setData({
          "modeForm.name": "",
          "modeForm.displayName": "",
          "modeForm.extends": "",
          "modeForm.abstract": false,
        });
        ui.toast(strings.S("mp_mode_created", res.modeName || name), "ok");
        self.loadModes(ctx);
      })
      .catch(function (err) {
        ui.hideLoading();
        ui.toast(String(err && err.message ? err.message : err), "error");
      });
  },

  onDeleteMode: function (e) {
    var self = this;
    var ctx = this.data.ctx;
    var id = e.currentTarget.dataset.id;
    var name = e.currentTarget.dataset.name || id;
    dialog.open(this, {
      title: strings.t("mp_modes_delete_confirm_title"),
      message: strings.S("mp_modes_delete_confirm_message", name),
      objectInfo: [
        { label: strings.t("mp_mode_name_label"), value: name },
        { label: strings.t("mp_dialog_id"), value: id },
      ],
      confirmText: strings.t("common_delete"),
      danger: true,
      onConfirm: function () {
        dialog.setLoading(self, true);
        api
          .delMode({ auth: ctx.key, id: id })
          .then(function (res) {
            if (res.ok) {
              dialog.close(self);
              ui.toast(strings.S("mp_modes_deleted", name), "ok");
              self.loadModes(ctx);
              return;
            }
            dialog.close(self);
            self.handleDeleteError(res.msg, id, name, ctx);
          })
          .catch(function (err) {
            dialog.close(self);
            ui.toast(String(err && err.message ? err.message : err), "error");
          });
      },
    });
  },

  handleDeleteError: function (apiMsg, id, name, ctx) {
    var self = this;
    var msg = String(apiMsg || "");
    if (/inherited/i.test(msg)) {
      ui.toast(strings.t("mp_modes_delete_inherited"), "error");
      return;
    }
    if (!/still used/i.test(msg)) {
      ui.toast(strings.t("mp_modes_delete_failed"), "error");
      return;
    }
    dialog.open(this, {
      title: strings.t("mp_modes_force_title"),
      message: strings.S("mp_modes_force_message", name),
      objectInfo: [
        { label: strings.t("mp_mode_name_label"), value: name },
        { label: strings.t("mp_dialog_id"), value: id },
      ],
      confirmText: strings.t("mp_modes_force_delete"),
      danger: true,
      onConfirm: function () {
        dialog.setLoading(self, true);
        api
          .delMode({ auth: ctx.key, id: id, force: true })
          .then(function (res) {
            dialog.close(self);
            if (!res.ok) {
              if (/inherited/i.test(String(res.msg || ""))) {
                ui.toast(strings.t("mp_modes_delete_inherited"), "error");
              } else {
                ui.toast(strings.t("mp_modes_delete_failed"), "error");
              }
              return;
            }
            ui.toast(strings.S("mp_modes_force_deleted", name), "ok");
            self.loadModes(ctx);
          })
          .catch(function (err) {
            dialog.close(self);
            ui.toast(String(err && err.message ? err.message : err), "error");
          });
      },
    });
  },

  onDialogConfirm: function (e) {
    dialog.confirm(this, e);
  },

  onDialogCancel: function () {
    dialog.cancel(this);
  },
});
