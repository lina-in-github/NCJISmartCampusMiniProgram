/* 轻量交互封装：toast / 确认框 / loading / 复制。 */
function toast(message, type) {
  if (!message) return;
  if (typeof wx === "undefined" || !wx || typeof wx.showToast !== "function") {
    // Node 测试环境
    if (typeof console !== "undefined") console.log("[toast]", type || "info", message);
    return;
  }
  wx.showToast({
    title: String(message).slice(0, 120),
    icon: type === "error" ? "none" : type === "ok" ? "success" : "none",
    duration: 2000,
  });
}

function alert(message, title) {
  if (typeof wx === "undefined" || !wx || typeof wx.showModal !== "function") {
    if (typeof console !== "undefined") console.log("[alert]", title || "", message);
    return Promise.resolve(true);
  }
  return new Promise(function (resolve) {
    wx.showModal({
      title: title || "提示",
      content: String(message || ""),
      showCancel: false,
      success: function () {
        resolve(true);
      },
      fail: function () {
        resolve(false);
      },
    });
  });
}

function confirm(content, title) {
  if (typeof wx === "undefined" || !wx || typeof wx.showModal !== "function") {
    if (typeof console !== "undefined") console.log("[confirm]", title || "", content);
    return Promise.resolve(true);
  }
  return new Promise(function (resolve) {
    wx.showModal({
      title: title || "确认操作",
      content: String(content || ""),
      success: function (res) {
        resolve(!!res.confirm);
      },
      fail: function () {
        resolve(false);
      },
    });
  });
}

function loading(title) {
  if (typeof wx === "undefined" || !wx || typeof wx.showLoading !== "function") return;
  wx.showLoading({ title: title || "加载中…", mask: true });
}

function hideLoading() {
  if (typeof wx === "undefined" || !wx || typeof wx.hideLoading !== "function") return;
  wx.hideLoading();
}

function copy(text) {
  return new Promise(function (resolve) {
    if (typeof wx === "undefined" || !wx || typeof wx.setClipboardData !== "function") {
      resolve(false);
      return;
    }
    wx.setClipboardData({
      data: String(text === null || text === undefined ? "" : text),
      success: function () {
        resolve(true);
      },
      fail: function () {
        resolve(false);
      },
    });
  });
}

function navigate(url, replace) {
  if (typeof wx === "undefined" || !wx) return;
  if (replace) {
    wx.redirectTo({ url: url });
  } else {
    wx.navigateTo({ url: url });
  }
}

function relaunch(url) {
  if (typeof wx === "undefined" || !wx) return;
  wx.reLaunch({ url: url });
}

module.exports = {
  toast: toast,
  alert: alert,
  confirm: confirm,
  loading: loading,
  hideLoading: hideLoading,
  copy: copy,
  navigate: navigate,
  relaunch: relaunch,
};
