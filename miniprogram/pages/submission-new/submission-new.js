/* 发布征集（老师 / 管理员）：与 /api/new-submission 字段一一对应。 */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var time = require("../../utils/time");
var api = require("../../utils/api");
var ui = require("../../utils/ui");

var TYPES = [
  { value: "homework", labelKey: "type_homework" },
  { value: "open call", labelKey: "type_open_call" },
  { value: "leave request", labelKey: "type_leave_request" },
  { value: "survey", labelKey: "type_survey" },
  { value: "answer sheet", labelKey: "type_answer_sheet" },
  { value: "notice", labelKey: "type_notice" },
  { value: "other", labelKey: "type_other" },
];

Page({
  data: {
    theme: "light",
    ctx: null,
    name: "",
    desc: "",
    typeIndex: 0,
    typeLabels: [],
    typeValue: "homework",
    hasDeadline: true,
    date: "",
    time: "20:00",
    submitting: false,
    s: {},
  },

  onLoad: function () {
    var deadline = time.fmtDateTimeLocal(time.now() + 3 * 86400 + 12 * 3600);
    this.setData({
      date: deadline.slice(0, 10),
      time: deadline.slice(11, 16),
    });
  },

  onShow: function () {
    var ctx = pageUtil.guard(this);
    if (!ctx) return;
    if (!ctx.staff) {
      ui.toast(strings.t("flash_teacher_only_publish"), "error");
      wx.reLaunch({ url: "/pages/submissions/submissions" });
      return;
    }
    this.setData({
      typeLabels: TYPES.map(function (t) {
        return strings.t(t.labelKey);
      }),
      s: {
        title: strings.t("new_page_title"),
        subtitle: strings.t("new_subtitle"),
        nameLabel: strings.t("new_name_label"),
        namePlaceholder: strings.t("new_name_placeholder"),
        typeLabel: strings.t("new_type_label"),
        deadlineLabel: strings.t("new_deadline_label"),
        noDeadline: strings.t("new_no_deadline"),
        descLabel: strings.t("new_desc_label"),
        descPlaceholder: strings.t("new_desc_placeholder"),
        tipsTitle: strings.t("new_tips_title"),
        tip1: strings.t("new_tip1"),
        tip2: strings.t("new_tip2"),
        tip3: strings.t("new_tip3"),
        tip4: strings.t("new_tip4"),
        tipSurvey: strings.t("new_tip_survey"),
        tipAnswerSheet: strings.t("new_tip_answer_sheet"),
        currentClass: strings.t("new_current_class"),
        publishIdentity: strings.t("new_publish_identity"),
        dataScope: strings.t("new_data_scope"),
        dataScopeValue: strings.t("new_data_scope_value"),
        submit: strings.t("nav_publish"),
        back: strings.t("new_back"),
        save: strings.t("common_save"),
      },
    });
  },

  onName: function (e) {
    this.setData({ name: e.detail.value });
  },

  onDesc: function (e) {
    this.setData({ desc: e.detail.value });
  },

  onType: function (e) {
    var idx = parseInt(e.detail.value, 10) || 0;
    this.setData({ typeIndex: idx, typeValue: TYPES[idx].value });
  },

  onDeadlineSwitch: function (e) {
    this.setData({ hasDeadline: e.detail.value });
  },

  onDate: function (e) {
    this.setData({ date: e.detail.value });
  },

  onTime: function (e) {
    this.setData({ time: e.detail.value });
  },

  onSubmit: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (this.data.submitting) return;
    var name = String(this.data.name || "").trim();
    if (!name) {
      ui.toast(strings.t("toast_submission_name_required"), "error");
      return;
    }
    var deadline = this.data.hasDeadline ? this.data.date + "T" + this.data.time : null;
    this.setData({ submitting: true });
    api
      .newSubmission({
        auth: ctx.key,
        name: name,
        desc: String(this.data.desc || "").trim(),
        type: this.data.typeValue,
        deadLine: deadline,
      })
      .then(function (res) {
        self.setData({ submitting: false });
        if (res.ok) {
          ui.toast(strings.t("toast_submission_published"), "ok");
          wx.reLaunch({ url: "/pages/submissions/submissions" });
        } else {
          ui.toast(res.msg || strings.t("flash_request_failed"), "error");
        }
      })
      .catch(function (err) {
        self.setData({ submitting: false });
        ui.toast(String(err && err.message ? err.message : err), "error");
      });
  },

  onBack: function () {
    wx.reLaunch({ url: "/pages/submissions/submissions" });
  },
});
