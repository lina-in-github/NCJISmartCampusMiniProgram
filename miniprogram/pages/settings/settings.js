/* 服务器设置：填写服务器 IP（或完整地址），在「在线」与「离线模拟」之间切换。 */
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var config = require("../../utils/config");
var api = require("../../utils/api");
var mock = require("../../utils/mock/index.js");
var ui = require("../../utils/ui");
var dialog = require("../../utils/dialog");

Page({
  data: {
    theme: "light",
    mode: "offline",
    baseUrl: "",
    testing: false,
    result: null,
    dialog: dialog.base(),
    s: {},
    defaults: {},
  },

  onShow: function () {
    theme.apply(this);
    var cfg = config.get();
    this.setData({
      mode: cfg.mode,
      baseUrl: cfg.baseUrl,
      s: {
        title: strings.t("mp_settings_title"),
        online: strings.t("mp_mode_online"),
        offline: strings.t("mp_mode_offline"),
        onlineDesc: strings.t("mp_mode_online_desc"),
        offlineDesc: strings.t("mp_mode_offline_desc"),
        ipLabel: strings.t("mp_server_ip"),
        ipHint: strings.t("mp_server_ip_hint"),
        test: strings.t("mp_server_test"),
        reset: strings.t("mp_reset_data"),
        resetDesc: strings.t("mp_reset_desc"),
        dataSource: strings.t("mp_data_source"),
        domainTip: strings.t("mp_required_domain_tip"),
        offlineTip: strings.t("mp_offline_only_tip"),
        save: strings.t("common_save"),
        back: strings.t("mp_back"),
        isOnline: cfg.mode === "online",
      },
    });
  },

  onMode: function (e) {
    var mode = e.currentTarget.dataset.mode;
    config.save({ mode: mode });
    this.setData({ mode: mode, "s.isOnline": mode === "online", result: null });
  },

  onInput: function (e) {
    this.setData({ baseUrl: e.detail.value });
  },

  onSave: function () {
    var saved = config.save({ baseUrl: this.data.baseUrl });
    this.setData({ baseUrl: saved.baseUrl });
    ui.toast(strings.t("common_save") + " · " + saved.baseUrl);
  },

  onTest: function () {
    var self = this;
    var saved = config.save({ baseUrl: this.data.baseUrl, mode: this.data.mode });
    this.setData({ baseUrl: saved.baseUrl, testing: true, result: null });
    api
      .health()
      .then(function (res) {
        self.setData({ testing: false });
        if (res.ok) {
          self.setData({
            result: {
              ok: true,
              text: strings.S("mp_server_ok", res.service || "smart-campus", res.time || ""),
            },
          });
        } else {
          self.setData({ result: { ok: false, text: strings.S("mp_server_fail", res.msg || "") } });
        }
      })
      .catch(function (err) {
        self.setData({
          testing: false,
          result: { ok: false, text: strings.S("mp_server_fail", String(err)) },
        });
      });
  },

  onResetMock: function () {
    var self = this;
    dialog.open(this, {
      title: strings.t("mp_reset_data"),
      message: strings.t("mp_reset_desc"),
      objectInfo: [
        { label: strings.t("mp_data_source"), value: strings.t("mp_mode_offline") },
        { label: strings.t("mp_dialog_tip"), value: strings.t("mp_dialog_notice") },
      ],
      confirmText: strings.t("mp_reset_data"),
      danger: true,
      onConfirm: function () {
        dialog.close(self);
        mock.reset();
        ui.toast(strings.t("mp_reset_done"), "ok");
        self.onShow();
      },
    });
  },

  onDialogConfirm: function (e) {
    dialog.confirm(this, e);
  },

  onDialogCancel: function () {
    dialog.cancel(this);
  },

  onBack: function () {
    if (typeof getCurrentPages === "function" && getCurrentPages().length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: "/pages/login/login" });
    }
  },
});
