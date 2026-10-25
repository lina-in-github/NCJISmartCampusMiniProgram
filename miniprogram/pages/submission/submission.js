/* 征集详情：公示只看详情；问卷 / 答题卡可就地填写；普通征集列出提交。 */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var time = require("../../utils/time");
var view = require("../../utils/view");
var works = require("../../utils/works");
var api = require("../../utils/api");
var cache = require("../../utils/cache");
var surveyLib = require("../../utils/survey");
var surveyForm = require("../../utils/surveyform");
var ui = require("../../utils/ui");

Page({
  data: {
    theme: "light",
    ctx: null,
    loading: true,
    error: "",
    submission: null,
    uploads: [],
    isForm: false,
    isAnswerSheet: false,
    blocks: [],
    answers: {},
    hasFields: false,
    sourceNote: "",
    submitting: false,
    s: {},
  },

  onLoad: function (query) {
    this.submissionId = (query && query.id) || "";
  },

  onShow: function () {
    var ctx = pageUtil.guard(this);
    if (!ctx) return;
    this.setData({
      s: {
        title: strings.t("page_submission_detail"),
        noticeTitle: strings.t("page_notice_detail"),
        export: strings.t("submission_all_export"),
        deleteSubmission: strings.t("submission_all_delete"),
        published: strings.t("submission_all_published"),
        emptyStaff: strings.t("submission_all_empty_staff"),
        emptyParent: strings.t("submission_all_empty_parent"),
        emptySelf: strings.t("submission_all_empty_self"),
        uploadFirst: strings.t("submission_all_upload_first"),
        listStaff: strings.t("submission_all_list_staff"),
        listParent: strings.t("submission_all_list_parent"),
        listSelf: strings.t("submission_all_list_self"),
        hintStaff: strings.t("submission_all_hint_staff"),
        hintParent: strings.t("submission_all_hint_parent"),
        hintSelf: strings.t("submission_all_hint_self"),
        noDesc: strings.t("submission_all_no_desc"),
        noticeNoUpload: strings.t("submission_notice_no_upload"),
        noticePinned: strings.t("submission_notice_pinned"),
        backList: strings.t("upload_back_list"),
        reupload: strings.t("upload_reupload"),
        goSubmit: strings.t("common_go_submit"),
        submitSurvey: strings.t("survey_submit"),
        submitAnswerSheet: strings.t("answer_sheet_submit"),
        allRequired: strings.t("answer_sheet_all_required"),
        surveyTip: strings.t("survey_all_hint"),
        answerSheetTip: strings.t("answer_sheet_all_hint"),
        noFields: strings.t("survey_no_fields"),
        noFieldsSheet: strings.t("answer_sheet_no_fields"),
        gradeTitle: strings.t("answer_sheet_grade_title"),
        itemScore: strings.t("answer_sheet_item_score"),
        expected: strings.t("answer_sheet_expected"),
        attachmentN: strings.t("common_attachment_n"),
        openDetail: strings.t("common_view"),
        emptyAnswer: strings.t("survey_answer_empty"),
      },
    });
    this.load();
  },

  load: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (!ctx) return;
    if (!this.submissionId) {
      this.setData({ loading: false, error: strings.t("error_submission_missing") });
      return;
    }
    this.setData({ loading: true, error: "" });
    works.findSubmission(ctx.key, this.submissionId).then(function (found) {
      if (!found.ok) {
        self.setData({ loading: false, error: strings.t("error_submission_missing") });
        return;
      }
      var now = time.now();
      var sub = view.decorateSubmission(found.submission, { pageRole: ctx.pageRole, now: now });
      var state = { submission: sub, isForm: sub.isForm, isAnswerSheet: sub.isAnswerSheet };
      if (sub.isForm) {
        var form = surveyForm.build(found.submission.desc || "", found.submission.type);
        state.blocks = form.blocks;
        state.answers = form.answers;
        state.hasFields = form.hasFields;
        self.surveyState = form.survey;
      }
      self.setData(state);
      return works.submissionUploads(ctx.key, self.submissionId, ctx.role).then(function (res) {
        var rows = (res.datas || []).map(function (row) {
          var decorated = view.decorateUpload(row, {
            now: now,
            formDesc: sub.isForm ? found.submission.desc || "" : "",
          });
          if (sub.isForm) {
            decorated.answers = surveyLib.answerRows(
              found.submission.desc || "",
              row.desc || "",
              surveyLib.kindMode(found.submission.type)
            ) || [];
            if (sub.isAnswerSheet) {
              var grade = surveyLib.gradeOf(found.submission.desc || "", row.desc || "");
              if (grade) {
                decorated.grade = {
                  score: surveyLib.formatScore(grade.score),
                  full: surveyLib.formatScore(grade.full),
                  right: grade.right,
                  count: grade.count,
                  rightText: strings.S("answer_sheet_right", grade.right, grade.count),
                  items: grade.detail.map(function (item) {
                    return {
                      id: item.id,
                      label: item.label,
                      ok: item.ok,
                      score: surveyLib.formatScore(item.score),
                      answer: item.answer,
                    };
                  }),
                };
              }
            }
          }
          return decorated;
        });
        self.setData({
          loading: false,
          uploads: rows,
          sourceNote:
            res.source === "device"
              ? strings.t("mp_local_hint")
              : res.source === "mock"
              ? strings.t("mp_offline_only_tip")
              : "",
        });
      });
    });
  },

  onGoUpload: function () {
    wx.navigateTo({ url: "/pages/upload-form/upload-form?id=" + this.submissionId });
  },

  onOpenUpload: function (e) {
    var id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: "/pages/upload-detail/upload-detail?id=" + id + "&sid=" + this.submissionId,
    });
  },

  onSurveyInput: function (e) {
    surveyForm.setInput(this, e.currentTarget.dataset.dom, e.detail.value);
  },

  onToggleBox: function (e) {
    surveyForm.toggleBox(this, e.currentTarget.dataset.dom);
  },

  onToggleSwitch: function (e) {
    surveyForm.setSwitch(this, e.currentTarget.dataset.dom, e.detail.value);
  },

  onSubmitSurvey: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    surveyForm
      .submit(ctx.key, this.submissionId, {
        survey: this.surveyState,
        answers: this.data.answers,
        isAnswerSheet: this.data.isAnswerSheet,
      })
      .then(function (res) {
        self.setData({ submitting: false });
        if (!res.ok) {
          ui.toast(res.msg || strings.t("flash_request_failed"), "error");
          return;
        }
        cache.record({
          id: res.id,
          authKey: ctx.key,
          submissionId: self.submissionId,
          submissionName: self.data.submission ? self.data.submission.name : "",
          title: "bot-upload",
          desc: res.answer,
          data: [],
          createdAt: time.fmtISO(time.now()),
          uploader: ctx.identityText,
          role: ctx.role,
        });
        ui.toast(res.doneMessage || strings.t("toast_uploaded"), "ok");
        self.load();
      })
      .catch(function (err) {
        self.setData({ submitting: false });
        ui.toast(String(err && err.message ? err.message : err), "error");
      });
  },

  onExport: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (!ctx.staff) {
      ui.toast(strings.t("flash_forbidden"), "error");
      return;
    }
    api.download({ auth: ctx.key, which: this.submissionId }).then(function (res) {
      if (!res.ok) {
        ui.toast(res.msg || strings.t("flash_request_failed"), "error");
        return;
      }
      var text = JSON.stringify(res.datas || [], null, 2);
      ui.copy(text).then(function (ok) {
        ui.toast(
          ok ? strings.S("toast_exported", (res.datas || []).length) : strings.t("toast_copy_failed"),
          ok ? "ok" : "error"
        );
      });
    });
  },

  onDeleteSubmission: function () {
    var self = this;
    var ctx = this.data.ctx;
    var sub = this.data.submission;
    if (!sub) return;
    ui.confirm(
      strings.S("toast_delete_confirm_message", sub.name),
      strings.t("toast_delete_confirm_title")
    ).then(function (yes) {
      if (!yes) return;
      api.delObject({ auth: ctx.key, id: sub.id }).then(function (res) {
        if (res.ok) {
          ui.toast(strings.t("toast_deleted"), "ok");
          wx.reLaunch({ url: "/pages/submissions/submissions" });
        } else {
          ui.toast(res.msg || strings.t("flash_delete_failed"), "error");
        }
      });
    });
  },

  onBack: function () {
    wx.reLaunch({ url: "/pages/submissions/submissions" });
  },

  onToggleTheme: function () {
    theme.toggle();
    theme.apply(this);
  },
});
