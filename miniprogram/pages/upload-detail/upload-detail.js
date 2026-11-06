/* 提交详情：附件、答案 / 批改结果、回复时间线、回复输入、管理员删除。 */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var time = require("../../utils/time");
var view = require("../../utils/view");
var works = require("../../utils/works");
var api = require("../../utils/api");
var cache = require("../../utils/cache");
var files = require("../../utils/file");
var surveyLib = require("../../utils/survey");
var ui = require("../../utils/ui");

Page({
  data: {
    theme: "light",
    ctx: null,
    loading: true,
    error: "",
    upload: null,
    submission: null,
    answers: [],
    grade: null,
    replies: [],
    replyText: "",
    sending: false,
    sourceNote: "",
    s: {},
  },

  onLoad: function (query) {
    this.uploadId = (query && query.id) || "";
    this.submissionId = (query && query.sid) || "";
  },

  onShow: function () {
    var ctx = pageUtil.guard(this);
    if (!ctx) return;
    this.setData({
      s: {
        title: strings.t("page_upload_detail"),
        backList: strings.t("upload_back_list"),
        backSubmission: strings.t("upload_back_submission"),
        viewSubmission: strings.t("upload_view_submission"),
        reupload: strings.t("upload_reupload"),
        deleteUpload: strings.t("upload_delete"),
        attachmentsTitle: strings.t("upload_attachments_title"),
        noAttachments: strings.t("upload_no_attachments"),
        noDesc: strings.t("upload_no_desc"),
        infoTitle: strings.t("upload_info_title"),
        infoUploader: strings.t("upload_info_uploader"),
        infoRole: strings.t("upload_info_role"),
        infoStudentNo: strings.t("upload_info_student_no"),
        infoSubmittedAt: strings.t("upload_info_submitted_at"),
        infoLastReply: strings.t("upload_info_last_reply"),
        infoReplyCount: strings.t("upload_info_reply_count"),
        repliesTitle: strings.t("upload_replies"),
        replyPlaceholder: strings.t("upload_reply_placeholder"),
        replyPublish: strings.t("upload_reply_publish"),
        replyNote: strings.t("upload_reply_note"),
        replyRoleHint: strings.t("upload_reply_role_hint"),
        replyOnlyStaff: strings.t("upload_reply_only_staff"),
        replyEmptyTitle: strings.t("upload_reply_empty_title"),
        replyEmptyStaff: strings.t("upload_reply_empty_staff"),
        replyEmptyStudent: strings.t("upload_reply_empty_student"),
        quickDone: strings.t("upload_quick_done"),
        quickSupplement: strings.t("upload_quick_supplement"),
        quickReceived: strings.t("upload_quick_received"),
        quickDoneText: strings.t("upload_quick_done_text"),
        quickSupplementText: strings.t("upload_quick_supplement_text"),
        quickReceivedText: strings.t("upload_quick_received_text"),
        tipStaff: strings.t("upload_tip_staff"),
        tipStudent: strings.t("upload_tip_student"),
        gradeTitle: strings.t("answer_sheet_grade_title"),
        itemScore: strings.t("answer_sheet_item_score"),
        expected: strings.t("answer_sheet_expected"),
        emptyAnswer: strings.t("survey_answer_empty"),
        openAttachment: strings.t("mp_open_attachment"),
        removeReplyNote: strings.t("mp_reply_delete_note"),
      },
    });
    this.load();
  },

  load: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (!ctx || !this.uploadId) {
      this.setData({ loading: false, error: strings.t("error_upload_missing") });
      return;
    }
    this.setData({ loading: true, error: "" });
    works
      .uploadDetail(ctx.key, this.uploadId, this.submissionId, ctx.role)
      .then(function (res) {
        if (!res.ok) {
          self.setData({ loading: false, error: strings.t("error_upload_missing") });
          return;
        }
        var now = time.now();
        var sub = res.submission
          ? view.decorateSubmission(res.submission, { pageRole: ctx.pageRole, now: now })
          : null;
        var upload = view.decorateUpload(res.upload, {
          now: now,
          formDesc: sub && sub.isForm ? res.submission.desc || "" : "",
        });
        var state = {
          loading: false,
          submission: sub,
          upload: upload,
          replies: upload.replyList.map(function (content, idx) {
            return { content: content, key: "r" + idx, no: idx + 1 };
          }),
          sourceNote: res.source === "device" ? strings.t("mp_local_hint") : "",
        };
        if (sub && sub.isForm) {
          state.answers = surveyLib.answerRows(
            res.submission.desc || "",
            res.upload.desc || "",
            surveyLib.kindMode(res.submission.type)
          ) || [];
          if (sub.isAnswerSheet) {
            var grade = surveyLib.gradeOf(res.submission.desc || "", res.upload.desc || "");
            if (grade) {
              state.grade = {
                score: surveyLib.formatScore(grade.score),
                full: surveyLib.formatScore(grade.full),
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
        self.setData(state);
      })
      .catch(function (err) {
        self.setData({ loading: false, error: String(err && err.message ? err.message : err) });
      });
  },

  onOpenAttachment: function (e) {
    var idx = e.currentTarget.dataset.index;
    var att = (this.data.upload.attachments || [])[idx];
    if (!att) return;
    files.openAttachment(att).then(function (res) {
      if (!res.ok) ui.toast(res.msg || strings.t("flash_request_failed"), "error");
    });
  },

  onReplyInput: function (e) {
    this.setData({ replyText: e.detail.value });
  },

  onQuickReply: function (e) {
    this.setData({ replyText: e.currentTarget.dataset.text || "" });
  },

  onSendReply: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (!ctx.staff) {
      ui.toast(strings.t("flash_forbidden"), "error");
      return;
    }
    var content = String(this.data.replyText || "").trim();
    if (!content) {
      ui.toast(strings.t("toast_reply_empty"), "error");
      return;
    }
    if (this.data.sending) return;
    this.setData({ sending: true });
    api
      .reply({ auth: ctx.key, uploadID: this.uploadId, content: content })
      .then(function (res) {
        self.setData({ sending: false });
        if (!res.ok) {
          ui.toast(res.msg || strings.t("flash_request_failed"), "error");
          return;
        }
        cache.appendReply(self.uploadId, content);
        ui.toast(strings.t("toast_reply_published"), "ok");
        self.setData({ replyText: "" });
        self.load();
      })
      .catch(function (err) {
        self.setData({ sending: false });
        ui.toast(String(err && err.message ? err.message : err), "error");
      });
  },

  onDeleteUpload: function () {
    var self = this;
    var ctx = this.data.ctx;
    ui.confirm(
      strings.S("toast_delete_confirm_message", this.data.upload.title),
      strings.t("toast_delete_confirm_title")
    ).then(function (yes) {
      if (!yes) return;
      api.delObject({ auth: ctx.key, id: self.uploadId }).then(function (res) {
        if (res.ok) {
          ui.toast(strings.t("toast_deleted"), "ok");
          wx.reLaunch({ url: "/pages/uploads/uploads" });
        } else {
          ui.toast(res.msg || strings.t("flash_delete_failed"), "error");
        }
      });
    });
  },

  onReupload: function () {
    var sid = this.submissionId || (this.data.upload && this.data.upload.submissionId);
    if (!sid) {
      ui.toast(strings.t("toast_missing_submission"), "error");
      return;
    }
    wx.navigateTo({ url: "/pages/upload-form/upload-form?id=" + sid });
  },

  onOpenSubmission: function () {
    var sid = this.submissionId || (this.data.upload && this.data.upload.submissionId);
    if (!sid) return;
    wx.redirectTo({ url: "/pages/submission/submission?id=" + sid });
  },

  onBack: function () {
    if (typeof getCurrentPages === "function" && getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/uploads/uploads" });
  },
});
