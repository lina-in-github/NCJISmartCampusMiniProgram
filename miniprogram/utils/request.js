/* 传输层：把 `/api/*` 的调用统一成「同一份请求体、同一份响应体」。
 *
 * 在线模式：POST <服务器地址>/api/<endpoint>，请求头 Content-Type: application/json，
 *           响应体与 `src/api.rs` 完全一致（`{ok:true,...}` / `{ok:false,msg}`），
 *           另外补一个 `status`（HTTP 状态码）方便页面提示。
 * 离线模式：交给 utils/mock 在本地按同一份契约应答，响应体结构与在线模式一致。
 *
 * 因此页面 / api 层只依赖响应体，不关心数据来源。 */
var config = require("./config");
var mock = require("./mock/index.js");

function normalizeEndpoint(endpoint) {
  return String(endpoint === null || endpoint === undefined ? "" : endpoint)
    .trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/?api\//, "")
    .replace(/^\//, "");
}

function parseBody(data) {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  }
  return data;
}

function hasWx() {
  return typeof wx !== "undefined" && wx && typeof wx.request === "function";
}

/** 调用一个 `/api/<endpoint>`，返回 Promise<响应体>。网络错误也会 resolve 成 `{ok:false}` */
function post(endpoint, payload) {
  var name = normalizeEndpoint(endpoint);
  var body = payload && typeof payload === "object" ? payload : {};
  if (!config.isOnline()) {
    return new Promise(function (resolve) {
      resolve(mock.handle(name, body));
    });
  }
  return new Promise(function (resolve) {
    if (!hasWx()) {
      resolve({ ok: false, msg: "wx.request is not available in this environment", status: 0 });
      return;
    }
    var cfg = config.get();
    wx.request({
      url: config.apiUrl(name),
      method: "POST",
      data: body,
      timeout: cfg.timeout,
      header: { "content-type": "application/json" },
      success: function (res) {
        var data = parseBody(res.data);
        if (data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "ok")) {
          data.status = res.statusCode;
          resolve(data);
        } else {
          resolve({
            ok: false,
            msg: "unexpected response from server (HTTP " + res.statusCode + ")",
            status: res.statusCode,
          });
        }
      },
      fail: function (err) {
        var detail = err && err.errMsg ? err.errMsg : "request failed";
        resolve({ ok: false, msg: "network error: " + detail, status: 0 });
      },
    });
  });
}

/** `/api/health` 是唯一的 GET 接口；离线模式直接回答本地模拟的健康信息。 */
function health() {
  if (!config.isOnline()) {
    return new Promise(function (resolve) {
      resolve(mock.handle("health", {}));
    });
  }
  return new Promise(function (resolve) {
    if (!hasWx()) {
      resolve({ ok: false, msg: "wx.request is not available in this environment", status: 0 });
      return;
    }
    var cfg = config.get();
    wx.request({
      url: config.healthUrl(),
      method: "GET",
      timeout: cfg.timeout,
      success: function (res) {
        var data = parseBody(res.data);
        if (data && typeof data === "object" && data.ok === true) {
          data.status = res.statusCode;
          resolve(data);
        } else {
          resolve({
            ok: false,
            msg: "health check failed (HTTP " + res.statusCode + ")",
            status: res.statusCode,
          });
        }
      },
      fail: function (err) {
        var detail = err && err.errMsg ? err.errMsg : "request failed";
        resolve({ ok: false, msg: "network error: " + detail, status: 0 });
      },
    });
  });
}

module.exports = {
  post: post,
  health: health,
  normalizeEndpoint: normalizeEndpoint,
};
