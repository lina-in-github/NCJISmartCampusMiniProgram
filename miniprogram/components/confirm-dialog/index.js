/* 敏感操作确认弹窗：居中显示、遮罩不可点击关闭、必须确认或取消。
 *
 * 与 wx.showModal 的区别：
 *   * 可以展示被操作对象的结构化信息（objectInfo）；
 *   * 可以附带密码输入框（needPassword），用于重置密钥等二次确认；
 *   * 遮罩层 catchtouchmove / catchtap，无法通过划走或点击外部关闭。
 *
 * 事件：
 *   bind:confirm -> detail: { password }
 *   bind:cancel  -> detail: {}
 */
Component({
  properties: {
    open: { type: Boolean, value: false },
    title: { type: String, value: "" },
    message: { type: String, value: "" },
    objectLabel: { type: String, value: "" },
    // [{ label, value }]
    objectInfo: { type: Array, value: [] },
    needPassword: { type: Boolean, value: false },
    passwordLabel: { type: String, value: "" },
    passwordPlaceholder: { type: String, value: "" },
    confirmText: { type: String, value: "" },
    cancelText: { type: String, value: "" },
    loading: { type: Boolean, value: false },
    danger: { type: Boolean, value: true },
  },

  data: {
    password: "",
  },

  observers: {
    open: function (open) {
      if (open) this.setData({ password: "" });
    },
  },

  methods: {
    // 阻止遮罩滚动 / 点击穿透；点击遮罩不关闭弹窗。
    noop: function () {},

    onCancel: function () {
      if (this.data.loading) return;
      this.triggerEvent("cancel", {});
    },

    onConfirm: function () {
      if (this.data.loading) return;
      this.triggerEvent("confirm", { password: this.data.password });
    },

    onPasswordInput: function (e) {
      this.setData({ password: e.detail.value });
    },
  },
});
