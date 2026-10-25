/* 上传到征集：普通征集填标题 / 说明 / 附件；问卷与答题卡改为填写简介里的题目。 */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var time = require("../../utils/time");
var view = require("../../utils/view");
var works = require("../../utils/works");
var api = require("../../utils/api");
var cache = require("../../utils/cache");
var files = require("../../utils/file");
var surveyForm = require("../../utils/surveyform");
var attachments = require("../../utils/attachments");
var ui = require("../../utils/ui");

Page({
  data: {
    theme: "light",
    ctx: null,
    loading: true,
    error: "",
    submission: null,
    isForm: false,
    isAnswerSheet: false,
    blocks: [],
    answers: {},
    hasFields: false,
    title: "",
    desc: "",
    fileList: [],
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
        titleLabel: strings.t("upload_form_title_label"),
        titleHint: strings.t("upload_form_title_hint"),
        titlePlaceholder: strings.t("new_name_placeholder"),
        descLabel: strings.t("new_desc_label"),
        descPlaceholder: strings.t("upload_form_desc_placeholder"),
        chooseFiles: strings.t("mp_choose_files"),
        dropHint: strings.t("upload_form_drop_hint"),
        remove: strings.t("file_remove_aria"),
        submit: strings.t("common_save"),
        submissionInfo: strings.t("upload_form_submission_info"),
        publisher: strings.t("upload_form_publisher"),
        publishedAt: strings.t("upload_form_published_at"),
        tip: strings.t("upload_form_tip"),
        surveyTip: strings.t("survey_tip"),
        answerSheetTip: strings.t("answer_sheet_tip"),
        allRequired: strings.t("answer_sheet_all_required"),
        submitSurvey: strings.t("survey_submit"),
        submitAnswerSheet: strings.t("answer_sheet_submit"),
        back: strings.t("upload_back_submission"),
        first: strings.t("upload_form_first"),
        firstParent: strings.t("upload_form_first_parent"),
        existing: strings.t("upload_form_existing"),
        existingParent: strings.t("upload_form_existing_parent"),
        noFields: strings.t("survey_no_fields"),
        noFieldsSheet: strings.t("answer_sheet_no_fields"),
      },
    });
    this.load();
  },

  load: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (!ctx) return;
    if (!this.submissionId) {
      this.setData({ loading: false, error: strings.t("toast_missing_submission") });
      return;
    }
    this.setData({ loading: true, error: "" });
    works
      .findSubmission(ctx.key, this.submissionId)
      .then(function (res) {
        if (!res.ok) {
          self.setData({ loading: false, error: strings.t("error_submission_missing") });
          return;
        }
        var now = time.now();
        var sub = view.decorateSubmission(res.submission, { pageRole: ctx.pageRole, now: now });
        if (sub.isNotice) {
          ui.toast(strings.t("submission_notice_no_upload"), "error");
          wx.redirectTo({ url: "/pages/submission/submission?id=" + sub.id });
          return;
        }
        var state = { loading: false, submission: sub };
        if (sub.isForm) {
          var form = surveyForm.build(res.submission.desc || "", res.submission.type);
          state.isForm = true;
          state.isAnswerSheet = form.isAnswerSheet;
          state.blocks = form.blocks;
          state.answers = form.answers;
          state.hasFields = form.hasFields;
          // Survey 对象带方法，不放进 data（setData 只处理可序列化数据）
          self.surveyState = form.survey;
        }
        state.existingText =
          ctx.parent
            ? strings.S("upload_form_existing_parent", sub.myUploadCount)
            : strings.S("upload_form_existing", sub.myUploadCount);
        state.firstText = ctx.parent ? strings.t("upload_form_first_parent") : strings.t("upload_form_first");
        self.setData(state);
      })
      .catch(function (err) {
        self.setData({ loading: false, error: String(err && err.message ? err.message : err) });
      });
  },

  onTitle: function (e) {
    this.setData({ title: e.detail.value });
  },

  onDesc: function (e) {
    this.setData({ desc: e.detail.value });
  },

  onChooseFiles: function () {
    var self = this;
    var remaining = attachments.MAX_ATTACHMENTS - this.data.fileList.length;
    if (remaining <= 0) {
      ui.toast(strings.S("toast_upload_limit_reached", attachments.MAX_ATTACHMENTS), "error");
      return;
    }
    files.pickFiles(remaining).then(function (res) {
      if (!res.ok) {
        if (!res.cancel) ui.toast(res.msg || strings.t("flash_request_failed"), "error");
        return;
      }
      var list = self.data.fileList.concat(
        res.files.map(function (f) {
          return {
            name: f.name,
            mime: f.mime,
            data: f.data,
            sizeText: time.formatSize(attachments.b64BinaryLen(f.data)),
          };
        })
      );
      var total = list.reduce(function (sum, f) {
        return sum + attachments.b64BinaryLen(f.data);
      }, 0);
      if (total > attachments.MAX_TOTAL_BYTES) {
        ui.toast(strings.t("toast_upload_too_large"), "error");
        return;
      }
      self.setData({ fileList: list });
    });
  },

  onRemoveFile: function (e) {
    var idx = e.currentTarget.dataset.index;
    var list = this.data.fileList.slice();
    list.splice(idx, 1);
    this.setData({ fileList: list });
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
        wx.redirectTo({
          url: "/pages/upload-detail/upload-detail?id=" + res.id + "&sid=" + self.submissionId,
        });
      })
      .catch(function (err) {
        self.setData({ submitting: false });
        ui.toast(String(err && err.message ? err.message : err), "error");
      });
  },

  onSubmitUpload: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (this.data.submitting) return;
    var title = String(this.data.title || "").trim();
    if (!title) {
      ui.toast(strings.t("toast_upload_title_required"), "error");
      return;
    }
    this.setData({ submitting: true });
    var data = this.data.fileList.map(function (f) {
      return { name: f.name, mime: f.mime, data: f.data };
    });
    api
      .upload({
        auth: ctx.key,
        which: this.submissionId,
        title: title,
        desc: String(this.data.desc || "").trim(),
        data: data,
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
          title: title,
          desc: String(self.data.desc || "").trim(),
          data: data,
          createdAt: time.fmtISO(time.now()),
          uploader: ctx.identityText,
          role: ctx.role,
        });
        ui.toast(strings.t("toast_uploaded"), "ok");
        wx.redirectTo({
          url: "/pages/upload-detail/upload-detail?id=" + res.id + "&sid=" + self.submissionId,
        });
      })
      .catch(function (err) {
        self.setData({ submitting: false });
        ui.toast(String(err && err.message ? err.message : err), "error");
      });
  },

  onBackSubmission: function () {
    wx.redirectTo({ url: "/pages/submission/submission?id=" + this.submissionId });
  },
});
