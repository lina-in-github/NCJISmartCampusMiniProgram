/* 附件工具：`src/tools.rs` 里 base64 / MIME / normalize_data 规则的移植。
 *
 * `/api/upload` 的 `data` 允许三种写法：
 *   * `{name, mime, data}`（推荐）；
 *   * `"data:image/png;base64,..."` 这样的 data URL；
 *   * 裸 base64 字符串（服务端会包装成 application/octet-stream）。
 * 这里把它们统一成 `{name, mime, data}`，与服务端保存的格式一致。 */
var MAX_ATTACHMENTS = 8;
var MAX_TOTAL_BYTES = 18 * 1024 * 1024;

function isBase64(value) {
  var s = String(value === null || value === undefined ? "" : value).trim();
  if (!s) return false;
  var pad = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (/[A-Za-z0-9+/]/.test(c)) {
      if (pad > 0) return false;
    } else if (c === "=") {
      pad += 1;
      if (pad > 2) return false;
      if (i + 1 < s.length && s.charAt(i + 1) !== "=") return false;
    } else {
      return false;
    }
  }
  if (pad > 0 && s.length % 4 !== 0) return false;
  return true;
}

function b64BinaryLen(s) {
  var pad = 0;
  for (var i = s.length - 1; i >= 0 && s.charAt(i) === "="; i--) pad += 1;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

function validMime(m) {
  var mime = String(m === null || m === undefined ? "" : m);
  if (!mime || mime.length > 120) return false;
  var parts = mime.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  return /^[A-Za-z0-9/+._-]+$/.test(mime);
}

function dataUrlParts(s) {
  var raw = String(s || "");
  if (raw.indexOf("data:") !== 0) return null;
  var comma = raw.indexOf(",");
  if (comma < 0) return null;
  var meta = raw.slice(5, comma);
  var data = raw.slice(comma + 1);
  if (!/;base64$/.test(meta)) return null;
  var mime = meta.slice(0, meta.length - ";base64".length);
  if (!validMime(mime) || !isBase64(data)) return null;
  return { mime: mime, data: data };
}

function truncateChars(s, n) {
  var chars = Array.from(String(s === null || s === undefined ? "" : s));
  if (chars.length <= n) return chars.join("");
  return chars.slice(0, n).join("") + "…";
}

/** 归一化 `/api/upload` 的 data 字段。返回 `{ok:true, value}` 或 `{ok:false, msg}` */
function normalizeData(input) {
  var arr;
  if (input === null || input === undefined) arr = [];
  else if (Array.isArray(input)) arr = input;
  else return { ok: false, msg: "data must be an array" };
  if (arr.length > MAX_ATTACHMENTS) {
    return { ok: false, msg: "too many attachments (max " + MAX_ATTACHMENTS + ")" };
  }
  var out = [];
  var total = 0;
  for (var idx = 0; idx < arr.length; idx++) {
    var item = arr[idx];
    if (typeof item === "string") {
      var raw = item.trim();
      if (!raw) continue;
      var parts = dataUrlParts(raw);
      if (parts) {
        total += b64BinaryLen(parts.data);
        if (total > MAX_TOTAL_BYTES) {
          return { ok: false, msg: "attachments exceed the size limit (about 18MB)" };
        }
        out.push("data:" + parts.mime + ";base64," + parts.data);
      } else if (isBase64(raw)) {
        total += b64BinaryLen(raw);
        if (total > MAX_TOTAL_BYTES) {
          return { ok: false, msg: "attachments exceed the size limit (about 18MB)" };
        }
        out.push({
          name: "Attachment " + (idx + 1),
          mime: "application/octet-stream",
          data: raw,
        });
      } else {
        return { ok: false, msg: "attachment must be base64 or a base64 data URL" };
      }
      continue;
    }
    if (item && typeof item === "object") {
      var dataRaw = item.data;
      if (typeof dataRaw !== "string") {
        return { ok: false, msg: "attachment object is missing the data field" };
      }
      var data = dataRaw.trim();
      if (!isBase64(data)) return { ok: false, msg: "attachment data must be base64" };
      var mime = item.mime || item.type || "application/octet-stream";
      if (!validMime(mime)) return { ok: false, msg: "invalid attachment mime type" };
      var name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) name = "Attachment " + (idx + 1);
      name = truncateChars(name, 120);
      total += b64BinaryLen(data);
      if (total > MAX_TOTAL_BYTES) {
        return { ok: false, msg: "attachments exceed the size limit (about 18MB)" };
      }
      out.push({ name: name, mime: mime, data: data });
      continue;
    }
    return { ok: false, msg: "unsupported attachment format" };
  }
  return { ok: true, value: out };
}

/** 把服务端保存的 data 转成可直接渲染的列表 */
function toList(data) {
  var arr = Array.isArray(data) ? data : [];
  var out = [];
  arr.forEach(function (item, idx) {
    if (typeof item === "string") {
      var parts = dataUrlParts(item);
      if (!parts) return;
      out.push({
        index: idx,
        name: "Attachment " + (idx + 1),
        mime: parts.mime,
        data: parts.data,
        src: item,
        isImage: parts.mime.indexOf("image/") === 0,
        size: b64BinaryLen(parts.data),
      });
      return;
    }
    if (!item || typeof item !== "object") return;
    var mime = item.mime || "application/octet-stream";
    var b64 = String(item.data || "");
    out.push({
      index: idx,
      name: item.name || "Attachment " + (idx + 1),
      mime: mime,
      data: b64,
      src: "data:" + mime + ";base64," + b64,
      isImage: mime.indexOf("image/") === 0,
      size: b64BinaryLen(b64),
    });
  });
  return out;
}

module.exports = {
  MAX_ATTACHMENTS: MAX_ATTACHMENTS,
  MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
  isBase64: isBase64,
  b64BinaryLen: b64BinaryLen,
  validMime: validMime,
  dataUrlParts: dataUrlParts,
  normalizeData: normalizeData,
  toList: toList,
};
