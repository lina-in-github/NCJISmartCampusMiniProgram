/* 所有征集：卡片列表 + 发布入口（老师 / 管理员）+ 删除（管理员）。 */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var time = require("../../utils/time");
var view = require("../../utils/view");
var works = require("../../utils/works");
var api = require("../../utils/api");
var ui = require("../../utils/ui");

Page({
  data: {
    theme: "light",
    ctx: null,
    loading: true,
    rows: [],
    total: 0,
    error: "",
    s: {},
  },

  onShow: function () {
    var ctx = pageUtil.guard(this);
    if (!ctx) return;
    var unit = ctx.staff
      ? strings.t("submissions_unit_class")
      : ctx.parent
      ? strings.t("submissions_unit_child")
      : strings.t("submissions_unit_person");
    this.setData({
      s: {
        title: strings.t("submissions_page_title"),
        publish: strings.t("nav_publish"),
        publishFirst: strings.t("submissions_publish_first"),
        emptyDesc: strings.t("submissions_empty_desc"),
        unit: unit,
        delete: strings.t("common_delete"),
        viewAll: strings.t("common_view_all"),
        goSubmit: strings.t("common_go_submit"),
        noticePinned: strings.t("submission_notice_pinned"),
        noticeNoUpload: strings.t("submission_notice_no_upload"),
      },
    });
    this.load();
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
          return;
        }
        var now = time.now();
        var rows = (res.datas || []).map(function (row) {
          return view.decorateSubmission(row, { pageRole: ctx.pageRole, now: now });
        });
        self.setData({
          loading: false,
          rows: rows,
          total: rows.length,
          countText: strings.S("submissions_page_sub", rows.length, strings.t(
            ctx.staff ? "submissions_unit_class" : ctx.parent ? "submissions_unit_child" : "submissions_unit_person"
          )),
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

  onOpen: function (e) {
    var row = this.data.rows[e.currentTarget.dataset.index];
    if (!row) return;
    if (row.isNotice) {
      wx.navigateTo({ url: "/pages/submission/submission?id=" + row.id });
      return;
    }
    wx.navigateTo({ url: "/pages/submission/submission?id=" + row.id });
  },

  onPublish: function () {
    wx.navigateTo({ url: "/pages/submission-new/submission-new" });
  },

  onDelete: function (e) {
    var self = this;
    var row = this.data.rows[e.currentTarget.dataset.index];
    if (!row) return;
    ui.confirm(strings.S("toast_delete_confirm_message", row.name), strings.t("toast_delete_confirm_title")).then(
      function (yes) {
        if (!yes) return;
        api.delObject({ auth: self.data.ctx.key, id: row.id }).then(function (res) {
          if (res.ok) {
            ui.toast(strings.t("toast_deleted"), "ok");
            self.load();
          } else {
            ui.toast(res.msg || strings.t("flash_delete_failed"), "error");
          }
        });
      }
    );
  },

  onToggleTheme: function () {
    theme.toggle();
    theme.apply(this);
  },
});
