/* 提交列表：学生看自己的提交；老师 / 管理员看全班提交，可筛选待回复 / 已回复。 */
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
    rows: [],
    filter: "all",
    counts: { all: 0, pending: 0, replied: 0, mine: 0 },
    sourceNote: "",
    error: "",
    s: {},
  },

  onShow: function () {
    var ctx = pageUtil.guard(this);
    if (!ctx) return;
    this.setData({
      s: {
        titleStaff: strings.t("uploads_title_staff"),
        titleParent: strings.t("uploads_title_parent"),
        titleSelf: strings.t("nav_uploads_self"),
        subStaff: strings.t("uploads_sub_staff"),
        subParent: strings.t("uploads_sub_parent"),
        subSelf: strings.t("uploads_sub_self"),
        tabAll: strings.t("uploads_tab_all"),
        tabPending: strings.t("uploads_tab_pending"),
        tabReplied: strings.t("uploads_tab_replied"),
        tabMine: strings.t("mp_uploads_tab_mine"),
        emptyPending: strings.t("uploads_empty_pending"),
        emptyReplied: strings.t("uploads_empty_replied"),
        emptyAll: strings.t("uploads_empty_all"),
        emptyMine: strings.t("mp_uploads_empty_mine"),
        mineBadge: strings.t("mp_dialog_mine_badge"),
        emptyDescStaff: strings.t("uploads_empty_desc_staff"),
        emptyDescParent: strings.t("uploads_empty_desc_parent"),
        emptyDescSelf: strings.t("uploads_empty_desc_self"),
        go: strings.t("uploads_go"),
        ownCount: strings.t("uploads_count_own"),
      },
    });
    this.load();
  },

  load: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (!ctx) return;
    this.setData({ loading: true, error: "" });
    // 个人提交走 /api/my-uploads；教职工另外读取全班提交用于全部 / 待回复 / 已回复。
    var personal = works.myUploads(ctx.key);
    var classWide = ctx.staff
      ? works.allUploads(ctx.key, ctx.role, { filter: "all", maxSubmissions: 20 })
      : personal;
    // 教职工的「待回复」使用服务端排序：自己发布的征集优先。
    var pendingPriority = ctx.staff ? works.pendingUploads(ctx.key) : personal;
    Promise.all([personal, classWide, pendingPriority])
      .then(function (results) {
        var personalRes = results[0];
        var classRes = results[1];
        var pendingRes = results[2];
        if (!personalRes.ok || !classRes.ok || !pendingRes.ok) {
          var failed = !personalRes.ok ? personalRes : !classRes.ok ? classRes : pendingRes;
          self.setData({ loading: false, error: failed.msg || strings.t("flash_request_failed") });
          return;
        }
        var now = time.now();
        var decorate = function (row) {
          return view.decorateUpload(row, { now: now });
        };
        var all = (classRes.datas || []).map(decorate);
        var mine = (personalRes.datas || []).map(decorate);
        var pending = ctx.staff
          ? (pendingRes.datas || []).map(decorate)
          : all.filter(function (r) {
              return !r.replyCount;
            });
        var replied = all.filter(function (r) {
          return r.replyCount > 0;
        });
        self.allRows = { all: all, pending: pending, replied: replied, mine: mine };
        self.setData({
          loading: false,
          counts: {
            all: all.length,
            pending: pending.length,
            replied: replied.length,
            mine: mine.length,
          },
          sourceNote:
            classRes.source === "mock"
              ? strings.t("mp_offline_only_tip")
              : "",
        });
        self.applyFilter();
      })
      .catch(function (err) {
        self.setData({ loading: false, error: String(err && err.message ? err.message : err) });
      });
  },

  applyFilter: function () {
    var filter = this.data.filter;
    var rows = (this.allRows && this.allRows[filter]) || [];
    this.setData({ rows: rows });
  },

  onFilter: function (e) {
    var filter = e.currentTarget.dataset.filter;
    this.setData({ filter: filter });
    this.applyFilter();
  },

  onOpen: function (e) {
    var row = this.data.rows[e.currentTarget.dataset.index];
    if (!row) return;
    wx.navigateTo({
      url:
        "/pages/upload-detail/upload-detail?id=" +
        row.id +
        "&sid=" +
        (row.submissionId || ""),
    });
  },

  onGoSubmissions: function () {
    wx.reLaunch({ url: "/pages/submissions/submissions" });
  },

  onPullDownRefresh: function () {
    this.load();
    wx.stopPullDownRefresh();
  },

  onToggleTheme: function () {
    theme.toggle();
    theme.apply(this);
  },
});
