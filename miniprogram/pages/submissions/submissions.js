/* 所有征集：卡片列表 + 发布入口（老师 / 管理员）+ 删除（管理员）。 */
var pageUtil = require("../../utils/page");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");
var time = require("../../utils/time");
var view = require("../../utils/view");
var works = require("../../utils/works");
var api = require("../../utils/api");
var ui = require("../../utils/ui");
var dialog = require("../../utils/dialog");

Page({
  data: {
    theme: "light",
    ctx: null,
    loading: true,
    rows: [],
    total: 0,
    scope: "all",
    showHiddens: false,
    tabs: [],
    activeTab: "",
    dialog: dialog.base(),
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
        modes: strings.t("nav_modes"),
        publishFirst: strings.t("submissions_publish_first"),
        emptyDesc: strings.t("submissions_empty_desc"),
        unit: unit,
        delete: strings.t("common_delete"),
        viewAll: strings.t("common_view_all"),
        goSubmit: strings.t("common_go_submit"),
        noticePinned: strings.t("submission_notice_pinned"),
        noticeNoUpload: strings.t("submission_notice_no_upload"),
        scopeAll: strings.t("mp_submissions_scope_all"),
        scopeMine: strings.t("mp_submissions_scope_mine"),
        showHiddens: strings.t("mp_submissions_show_hiddens"),
        hideHiddens: strings.t("mp_submissions_hide_hiddens"),
        tabAll: strings.t("mp_submissions_tab_all"),
        tabsLabel: strings.t("mp_submissions_tabs_label"),
        myTitle: strings.t("mp_my_submissions_title"),
        myEmpty: strings.t("mp_my_submissions_empty"),
      },
    });
    this.load();
  },

  load: function () {
    var self = this;
    var ctx = this.data.ctx;
    if (!ctx) return;
    this.setData({ loading: true, error: "" });
    var mine = this.data.scope === "mine" && ctx.staff;
    var request = mine
      ? works.mySubmissions(ctx.key)
      : works.submissions(ctx.key, {
          showHiddens: this.data.showHiddens,
          category: this.data.activeTab,
        });
    request
      .then(function (res) {
        if (!res.ok) {
          self.setData({ loading: false, error: res.msg || strings.t("flash_request_failed") });
          return;
        }
        var now = time.now();
        var rows = (res.datas || []).map(function (row) {
          return view.decorateSubmission(row, { pageRole: ctx.pageRole, now: now });
        });
        var tabs = (res.tabs || []).map(function (tab) {
          return {
            name: tab.name,
            displayName: tab.displayName || tab.name,
            count: tab.count || 0,
            active: (tab.name || "") === self.data.activeTab,
          };
        });
        self.setData({
          loading: false,
          rows: rows,
          tabs: mine ? [] : tabs,
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

  onManageModes: function () {
    wx.navigateTo({ url: "/pages/modemanage/modemanage" });
  },

  onScope: function (e) {
    var scope = e.currentTarget.dataset.scope === "mine" ? "mine" : "all";
    if (scope === this.data.scope) return;
    this.setData({ scope: scope, activeTab: "" });
    this.load();
  },

  onToggleHiddens: function () {
    this.setData({ showHiddens: !this.data.showHiddens });
    this.load();
  },

  onTab: function (e) {
    var name = e.currentTarget.dataset.tab || "";
    if (name === this.data.activeTab) return;
    this.setData({ activeTab: name });
    this.load();
  },

  onDelete: function (e) {
    var self = this;
    var row = this.data.rows[e.currentTarget.dataset.index];
    if (!row || !ctxAdmin(self.data.ctx)) return;
    dialog.open(this, {
      title: strings.t("mp_dialog_delete_title"),
      message: strings.S("toast_delete_confirm_message", row.name),
      objectInfo: [
        { label: strings.t("mp_dialog_type"), value: row.typeText || row.type || "" },
        { label: strings.t("mp_dialog_id"), value: row.id },
        { label: strings.t("mp_dialog_creator"), value: row.createdBy || "" },
        { label: strings.t("mp_dialog_tip"), value: strings.t("mp_dialog_notice") },
      ],
      confirmText: strings.t("mp_dialog_confirm_delete"),
      danger: true,
      onConfirm: function () {
        dialog.setLoading(self, true);
        api.delObject({ auth: self.data.ctx.key, id: row.id }).then(function (res) {
          dialog.close(self);
          if (res.ok) {
            ui.toast(strings.t("toast_deleted"), "ok");
            self.load();
          } else {
            ui.toast(res.msg || strings.t("flash_delete_failed"), "error");
          }
        }).catch(function (err) {
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

  onToggleTheme: function () {
    theme.toggle();
    theme.apply(this);
  },
});

/* 小程序端删除征集由服务端校验管理员权限；这里只做入口保护。 */
function ctxAdmin(ctx) {
  return !!(ctx && ctx.role === "admin");
}
