/* 本地存储的薄封装：小程序里用 wx.*StorageSync，Node 测试里退化为内存 Map。
 * 所有持久化都经过这里，方便测试与「重置离线数据」。 */
var memory = {};
var hasWx = typeof wx !== "undefined" && wx && typeof wx.getStorageSync === "function";

function getRaw(key) {
  if (hasWx) {
    try {
      var v = wx.getStorageSync(key);
      return v === "" ? null : v;
    } catch (e) {
      return null;
    }
  }
  return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
}

function setRaw(key, value) {
  if (hasWx) {
    try {
      wx.setStorageSync(key, value);
    } catch (e) {
      /* 存储写满时静默失败，页面仍可用内存数据 */
    }
    return value;
  }
  memory[key] = value;
  return value;
}

function remove(key) {
  if (hasWx) {
    try {
      wx.removeStorageSync(key);
    } catch (e) {
      /* ignore */
    }
    return;
  }
  delete memory[key];
}

function readJson(key, fallback) {
  var raw = getRaw(key);
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    var parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

function writeJson(key, value) {
  return setRaw(key, value);
}

module.exports = {
  getRaw: getRaw,
  setRaw: setRaw,
  readJson: readJson,
  writeJson: writeJson,
  remove: remove,
};
