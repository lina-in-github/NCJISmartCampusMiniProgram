/* 服务器设置：在线（真实 /api）或离线（本地模拟）。
 *
 * 在线模式下所有数据都来自 `POST <baseUrl>/api/*`，请求体与响应体与 Rust 服务完全同构；
 * 离线模式由 utils/mock/* 在本地按同一套契约应答，因此页面代码无需区分两种模式。 */
var storage = require("./storage");

var KEY = "sc.mp.config.v1";
var DEFAULTS = {
  mode: "online", // offline | online
  baseUrl: "https://utter-overlord-headlamp.ngrok-free.dev",
  timeout: 15000,
};
var HEALTH_PATH = "/api/health";

function normalizeBase(input) {
  var raw = String(input === null || input === undefined ? "" : input).trim();
  if (!raw) return "";
  // 允许只填 IP：192.168.1.20 / 192.168.1.20:3000 / campus.example.com:8080
  if (!/^https?:\/\//i.test(raw)) raw = "http://" + raw;
  raw = raw.replace(/\/+$/, "");
  return raw;
}

function get() {
  var saved = storage.readJson(KEY, null) || {};
  var mode = saved.mode === "offline" ? "offline" : "online";
  var baseUrl = normalizeBase(saved.baseUrl) || DEFAULTS.baseUrl;
  var timeout = parseInt(saved.timeout, 10);
  if (!isFinite(timeout) || timeout < 1000) timeout = DEFAULTS.timeout;
  return { mode: mode, baseUrl: baseUrl, timeout: timeout };
}

function save(patch) {
  var next = get();
  if (patch && Object.prototype.hasOwnProperty.call(patch, "mode")) {
    next.mode = patch.mode === "offline" ? "offline" : "online";
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, "baseUrl")) {
    next.baseUrl = normalizeBase(patch.baseUrl) || DEFAULTS.baseUrl;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, "timeout")) {
    var t = parseInt(patch.timeout, 10);
    next.timeout = isFinite(t) && t >= 1000 ? t : DEFAULTS.timeout;
  }
  storage.writeJson(KEY, next);
  return next;
}

function isOnline() {
  return get().mode === "online";
}

function apiUrl(endpoint) {
  return get().baseUrl + "/api/" + endpoint;
}

function healthUrl() {
  return get().baseUrl + HEALTH_PATH;
}

function reset() {
  storage.remove(KEY);
  return get();
}

module.exports = {
  DEFAULTS: DEFAULTS,
  normalizeBase: normalizeBase,
  get: get,
  save: save,
  reset: reset,
  isOnline: isOnline,
  apiUrl: apiUrl,
  healthUrl: healthUrl,
};
