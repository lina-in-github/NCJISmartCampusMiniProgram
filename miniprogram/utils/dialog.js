/* 敏感操作确认弹窗控制器：页面只需 setData({ dialog }) + 组件事件转发。
 *
 * 用法：
 *   var dialog = require("../../utils/dialog");
 *   dialog.open(this, {
 *     title: strings.t("mp_dialog_delete_title"),
 *     message: strings.S("toast_delete_confirm_message", row.name),
 *     objectInfo: [{ label: ..., value: ... }],
 *     onConfirm: function (password) { ... }
 *   });
 *
 * 页面 WXML 里放 <confirm-dialog ... bind:confirm="onDialogConfirm" bind:cancel="onDialogCancel" />，
 * JS 中转发给 dialog.confirm(this, e) / dialog.cancel(this)。
 */
var strings = require("./strings");
var ui = require("./ui");

function base() {
  return {
    open: false,
    title: "",
    message: "",
    objectLabel: "",
    objectInfo: [],
    needPassword: false,
    passwordLabel: "",
    passwordPlaceholder: "",
    confirmText: "",
    cancelText: "",
    loading: false,
    danger: true,
  };
}

function open(page, opts) {
  var options = opts || {};
  var dialog = base();
  Object.keys(options).forEach(function (key) {
    if (key !== "onConfirm") dialog[key] = options[key];
  });
  dialog.objectInfo = dialog.objectInfo || [];
  dialog.title = dialog.title || strings.t("common_confirm_title");
  dialog.confirmText = dialog.confirmText || strings.t("common_confirm");
  dialog.cancelText = dialog.cancelText || strings.t("common_cancel");
  dialog.objectLabel = dialog.objectLabel || (dialog.objectInfo.length ? strings.t("mp_dialog_object") : "");
  dialog.passwordLabel = dialog.passwordLabel || strings.t("mp_dialog_password");
  dialog.passwordPlaceholder =
    dialog.passwordPlaceholder || strings.t("mp_dialog_password_placeholder");
  dialog.open = true;
  page._scDialogHandler = typeof options.onConfirm === "function" ? options.onConfirm : null;
  page.setData({ dialog: dialog });
}

function close(page) {
  page._scDialogHandler = null;
  page.setData({ "dialog.open": false, "dialog.loading": false });
}

function setLoading(page, loading) {
  page.setData({ "dialog.loading": !!loading });
}

function confirm(page, e) {
  var handler = page._scDialogHandler;
  if (!handler) {
    close(page);
    return;
  }
  var password = e && e.detail ? e.detail.password : "";
  if (page.data.dialog && page.data.dialog.needPassword && !String(password || "").trim()) {
    ui.toast(strings.t("flash_enter_password"), "error");
    return;
  }
  handler(String(password || ""));
}

function cancel(page) {
  close(page);
}

module.exports = {
  base: base,
  open: open,
  close: close,
  setLoading: setLoading,
  confirm: confirm,
  cancel: cancel,
};
