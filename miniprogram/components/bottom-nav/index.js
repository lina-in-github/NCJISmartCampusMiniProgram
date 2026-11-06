/* 底部导航：首页 / 征集 / 提交 / 账号（对应 web 端主导航）。 */
var strings = require("../../utils/strings");

Component({
  properties: {
    active: { type: String, value: "home" },
    uploadsLabel: { type: String, value: "" },
  },
  data: {
    items: [],
  },
  lifetimes: {
    attached: function () {
      this.buildItems();
    },
  },
  observers: {
    uploadsLabel: function () {
      this.buildItems();
    },
  },
  methods: {
    buildItems: function () {
      var session = require("../../utils/session").get();
      var role = session ? session.role : "student";
      var pageRole = session ? session.pageRole : "student";
      var uploadsKey =
        role === "teacher" || role === "admin"
          ? "nav_uploads_staff"
          : pageRole === "parent"
          ? "nav_uploads_parent"
          : "nav_uploads_self";
      this.setData({
        items: [
          { key: "home", label: strings.t("nav_home"), url: "/pages/home/home" },
          { key: "submissions", label: strings.t("type_generic"), url: "/pages/submissions/submissions" },
          { key: "uploads", label: strings.t(uploadsKey), url: "/pages/uploads/uploads" },
          { key: "docs", label: strings.t("nav_docs"), url: "/pages/docs/docs" },
          { key: "account", label: strings.t("nav_account"), url: "/pages/account/account" },
        ],
      });
    },
    onTap: function (e) {
      var item = e.currentTarget.dataset.item;
      if (!item || item.key === this.data.active) return;
      wx.reLaunch({ url: item.url });
    },
  },
});
