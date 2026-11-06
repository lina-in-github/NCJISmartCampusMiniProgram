/* 文档与相关：从 /api/docs 读取 README.md，按纯文本展示（不渲染 Markdown）。 */
var api = require("../../utils/api");
var strings = require("../../utils/strings");
var theme = require("../../utils/theme");

Page({
  data: {
    theme: "light",
    loading: true,
    error: "",
    content: "",
    fileName: "README.md",
    s: {},
  },

  onShow: function () {
    theme.apply(this);
    this.setData({
      s: {
        title: strings.t("nav_docs"),
        subtitle: strings.t("docs_subtitle"),
        file: strings.t("docs_file"),
        plainHint: strings.t("docs_plain_hint"),
        loading: strings.t("docs_loading"),
        empty: strings.t("docs_empty"),
        loadFailed: strings.t("docs_load_failed"),
        retry: strings.t("docs_retry"),
        back: strings.t("docs_back"),
      },
    });
    this.load();
  },

  load: function () {
    var self = this;
    this.setData({ loading: true, error: "" });
    api
      .docs()
      .then(function (res) {
        if (!res.ok) {
          self.setData({
            loading: false,
            error: res.msg || strings.t("docs_load_failed"),
          });
          return;
        }
        self.setData({
          loading: false,
          error: "",
          fileName: res.fileName || strings.t("docs_file"),
          content: res.content || "",
        });
      })
      .catch(function (err) {
        self.setData({
          loading: false,
          error: String(err && err.message ? err.message : err),
        });
      });
  },

  onRetry: function () {
    this.load();
  },

  onBack: function () {
    if (typeof getCurrentPages === "function" && getCurrentPages().length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: "/pages/home/home" });
    }
  },

  onToggleTheme: function () {
    theme.toggle();
    theme.apply(this);
  },
});
