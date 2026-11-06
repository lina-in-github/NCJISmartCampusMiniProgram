/* 发布征集（老师 / 管理员）：与 /api/new-submission 字段一一对应。 */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var time = require("../../utils/time");
var api = require("../../utils/api");
var ui = require("../../utils/ui");

var TYPES = [
  { value: "homework", labelKey: "type_homework", base: "homework" },
  { value: "open call", labelKey: "type_open_call", base: "open call" },
  { value: "leave request", labelKey: "type_leave_request", base: "leave request" },
  { value: "survey", labelKey: "type_survey", base: "survey" },
  { value: "answer sheet", labelKey: "type_answer_sheet", base: "answer sheet" },
  { value: "notice", labelKey: "type_notice", base: "notice" },
  { value: "other", labelKey: "type_other", base: "other" },
  { value: "hidden", labelKey: "type_hidden", base: "other" },
  { value: "teacher only", labelKey: "type_teacher_only", base: "other" },
  { value: "admin only", labelKey: "type_admin_only", base: "other" },
  { value: "invisible", labelKey: "type_invisible", base: "other" },
];

Page({
  data: {
    theme: "light",
    ctx: null,
    name: "",
    desc: "",
    typeIndex: 0,
    typeLabels: [],
    typeValues: [],
    typeBases: [],
    typeValue: "homework",
    typeBase: "homework",
    manualType: false,
    manualName: "",
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
    var baseTypes = TYPES.filter(function (t) {
      return ctx.role === "admin" || t.value !== "admin only";
    }).map(function (t) {
      return {
        value: t.value,
        label: strings.t(t.labelKey),
        base: t.base,
      };
    });
    this.setData({
      typeLabels: baseTypes.map(function (t) {
        return t.label;
      }),
      typeValues: baseTypes.map(function (t) {
        return t.value;
      }),
      typeBases: baseTypes.map(function (t) {
        return t.base;
      }),
      s: {
        title: strings.t("new_page_title"),
        subtitle: strings.t("new_subtitle"),
        nameLabel: strings.t("new_name_label"),
        namePlaceholder: strings.t("new_name_placeholder"),
        typeLabel: strings.t("new_type_label"),
        manualType: strings.t("new_type_manual"),
        manualTypeName: strings.t("new_type_manual_name"),
        manualTypePlaceholder: strings.t("new_type_manual_placeholder"),
        manualTypeHint: strings.t("new_type_manual_hint"),
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
    this.loadModes(ctx);
  },

  /** 班级自定义征集模式（管理员通过 /api/new-mode 添加）。 */
  loadModes: function (ctx) {
    var self = this;
    api.allModes({ auth: ctx.key }).then(function (res) {
      if (!res.ok || !res.modes) return;
      var known = {};
      self.data.typeValues.forEach(function (v) {
        known[String(v).toLowerCase()] = true;
      });
      var labels = self.data.typeLabels.slice();
      var values = self.data.typeValues.slice();
      var bases = self.data.typeBases.slice();
      (res.modes || []).forEach(function (mode) {
        if (mode.builtin) return;
        if (mode.abstract) return;
        if (mode.adminOnly && ctx.role !== "admin") return;
        var name = mode.modeName || mode.name || "";
        if (!name || known[String(name).toLowerCase()]) return;
        known[String(name).toLowerCase()] = true;
        labels.push(mode.displayName || name);
        values.push(name);
        bases.push(mode.baseType || "other");
      });
      self.setData({ typeLabels: labels, typeValues: values, typeBases: bases });
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
    var values = this.data.typeValues;
    var bases = this.data.typeBases;
    this.setData({
      typeIndex: idx,
      typeValue: values[idx] || "homework",
      typeBase: bases[idx] || "homework",
    });
  },

  /** 手动输入的类型命中了已知模式时，沿用它的行为基类（问卷 / 答题卡提示）。 */
  manualBase: function (raw) {
    var key = String(raw === null || raw === undefined ? "" : raw)
      .trim()
      .toLowerCase()
      .replace(/[_-]/g, " ")
      .replace(/\s+/g, " ");
    if (!key) return "other";
    var values = this.data.typeValues;
    var labels = this.data.typeLabels;
    var bases = this.data.typeBases;
    for (var i = 0; i < values.length; i++) {
      if (
        String(values[i]).toLowerCase() === key ||
        String(labels[i]).toLowerCase() === key
      ) {
        return bases[i] || "other";
      }
    }
    return "other";
  },

  onToggleManualType: function () {
    var manualType = !this.data.manualType;
    this.setData({
      manualType: manualType,
      typeBase: manualType
        ? this.manualBase(this.data.manualName)
        : this.data.typeBases[this.data.typeIndex] || "homework",
    });
  },

  onManualName: function (e) {
    var raw = String(e.detail.value || "");
    this.setData({ manualName: raw, typeBase: this.manualBase(raw) });
  },

  onDeadlineSwitch: function () {
    this.setData({ hasDeadline: !this.data.hasDeadline });
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
    var manual = this.data.manualType === true;
    var kind = manual
      ? String(this.data.manualName || "").trim()
      : this.data.typeValue;
    if (manual && !kind) {
      ui.toast(strings.t("toast_type_manual_required"), "error");
      return;
    }
    var deadline = this.data.hasDeadline ? this.data.date + "T" + this.data.time : null;
    this.setData({ submitting: true });
    api
      .newSubmission({
        auth: ctx.key,
        name: name,
        desc: String(this.data.desc || "").trim(),
        type: kind,
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
