/* 首页：统计卡片 + 最近的征集 + 最近的提交（待回复优先）。 */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var time = require("../../utils/time");
var view = require("../../utils/view");
var works = require("../../utils/works");
var ui = require("../../utils/ui");

Page({
  data: {
    theme: "light",
    ctx: null,
    loading: true,
    stats: [],
    submissions: [],
    uploads: [],
    hero: {},
    emptyText: "",
    uploadsHint: "",
    sourceNote: "",
    error: "",
    s: {},
  },

  onShow: function () {
    var ctx = pageUtil.guard(this);
    if (!ctx) return;
    this.setData({ s: this.buildStrings(ctx) });
    this.load();
  },

  buildStrings: function (ctx) {
    var pageRole = ctx.pageRole;
    var heroTitleKey =
      pageRole === "teacher" ? "home_title_teacher" : pageRole === "admin" ? "home_title_admin" : "home_title_student";
    var heroDescKey =
      pageRole === "parent"
        ? "home_desc_parent"
        : pageRole === "teacher"
        ? "home_desc_teacher"
        : pageRole === "admin"
        ? "home_desc_admin"
        : "home_desc_student";
    var eyebrowKey =
      pageRole === "parent"
        ? "home_eyebrow_parent"
        : pageRole === "teacher"
        ? "home_eyebrow_teacher"
        : pageRole === "admin"
        ? "home_eyebrow_admin"
        : "home_eyebrow_student";
    var uploadsTitleKey =
      ctx.staff
        ? pageRole === "teacher"
          ? "home_recent_teacher"
          : "home_recent_admin"
        : pageRole === "parent"
        ? "home_recent_parent"
        : "home_recent_self";
    var hintKey = ctx.staff ? (pageRole === "teacher" ? "home_pending_hint" : "home_admin_hint") : pageRole === "parent" ? "home_parent_hint" : "home_self_hint";
    return {
      hero: {
        eyebrow: strings.t(eyebrowKey),
        title:
          pageRole === "parent"
            ? strings.S("mp_home_title_parent", ctx.identityText)
            : strings.t(heroTitleKey),
        desc: strings.t(heroDescKey),
      },
      recentSubmissions: strings.t("home_recent_submissions"),
      uploadsTitle: strings.t(uploadsTitleKey),
      uploadsHint: strings.t(hintKey),
      viewAll: strings.t("common_view_all"),
      browse: strings.t("home_action_browse"),
      publish: strings.t("nav_publish"),
      uploadsNav: strings.t(
        ctx.staff ? "nav_uploads_staff" : pageRole === "parent" ? "nav_uploads_parent" : "nav_uploads_self"
      ),
      account: strings.t("nav_account"),
      emptySubmissionsTitle: strings.t("home_empty_submissions_title"),
      emptySubmissionsDesc: strings.t("home_empty_submissions_desc"),
      emptyUploadsTitle: strings.t("home_empty_uploads_title"),
      noticePinned: strings.t("submission_notice_pinned"),
      switchToParent: strings.t("layout_switch_view_parent"),
      switchToStudent: strings.t("layout_switch_view_student"),
      localHint: strings.t("mp_local_hint"),
    };
  },

  load: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (!ctx) return;
    this.setData({ loading: true, error: "" });
    works
      .submissions(ctx.key)
      .then(function (res) {
        if (!res.ok) {
          self.setData({ loading: false, error: res.msg || strings.t("flash_request_failed") });
          return null;
        }
        var now = time.now();
        var rows = (res.datas || []).map(function (row) {
          return view.decorateSubmission(row, { pageRole: ctx.pageRole, now: now });
        });
        // 老师视角只展示「待回复」的提交，并使用 /api/pending-uploads 的个人发布优先排序。
        var request =
          ctx.role === "teacher"
            ? works.pendingUploads(ctx.key)
            : works.allUploads(ctx.key, ctx.role, { maxSubmissions: 6, filter: "all" });
        return request
          .then(function (uploads) {
            var rowsUploads = (uploads.datas || []).map(function (row) {
              return view.decorateUpload(row, { now: now });
            });
            self.setData({
              loading: false,
              submissions: rows.slice(0, 4),
              uploads: rowsUploads.slice(0, 4),
              stats: works.statsFor(rows, rowsUploads, ctx.pageRole).map(function (stat) {
                return {
                  key: stat.key,
                  value: stat.value,
                  tone: stat.tone || "",
                  label: strings.t(stat.label),
                };
              }),
              sourceNote:
                uploads.source === "device"
                  ? strings.t("mp_local_hint")
                  : uploads.source === "mock"
                  ? strings.t("mp_offline_only_tip")
                  : "",
            });
          });
      })
      .catch(function (err) {
        self.setData({ loading: false, error: String(err && err.message ? err.message : err) });
      });
  },

  onPullDownRefresh: function () {
    this.load();
    wx.stopPullDownRefresh();
  },

  onOpenSubmission: function (e) {
    var id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/submission/submission?id=" + id });
  },

  onOpenUpload: function (e) {
    var id = e.currentTarget.dataset.id;
    var sid = e.currentTarget.dataset.sid || "";
    wx.navigateTo({ url: "/pages/upload-detail/upload-detail?id=" + id + "&sid=" + sid });
  },

  onSubmissions: function () {
    wx.reLaunch({ url: "/pages/submissions/submissions" });
  },

  onUploads: function () {
    wx.reLaunch({ url: "/pages/uploads/uploads" });
  },

  onPublish: function () {
    wx.navigateTo({ url: "/pages/submission-new/submission-new" });
  },

  onAccount: function () {
    wx.reLaunch({ url: "/pages/account/account" });
  },

  onSwitchView: function (e) {
    var pageRole = e.currentTarget.dataset.role;
    pageUtil.switchView(this, pageRole);
    this.setData({ s: this.buildStrings(this.data.ctx) });
    this.load();
  },

  onToggleTheme: function () {
    theme.toggle();
    theme.apply(this);
  },
});
