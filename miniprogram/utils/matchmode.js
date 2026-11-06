/* MatchMode 解析：与 src/tools.rs 的 `parse_match_mode` 逐条一致。
 *
 * 支持： "All" / {"Random":3} / {"Random":{"quantity":3}} / {"StudentID":"G2603-01"}
 *       / {"ShortStudentID":1} / {"TitleReGex":"^函数"} / {"Before":"7d"}
 *       以及显式对象 {"type":"Random","quantity":3}。
 *
 * 错误信息与 Rust 服务逐字一致（`unknown match_mode: Foo`、
 * `ShortStudentID requires an integer id`、`TitleReGex requires a regular expression`、
 * `Random requires a quantity`、`Before requires a time` ……）；
 * 数字解析也按 serde 的语义：只接受 JSON 整数，字符串必须是完整的整数文本。 */
var time = require("./time");

function canonicalVariant(name) {
  return String(name || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function payloadOf(map, mode) {
  if (hasOwn(map, mode)) return map[mode];
  var target = canonicalVariant(mode);
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    if (canonicalVariant(keys[i]) === target) return map[keys[i]];
  }
  return undefined;
}

/** 与 serde 的 `Value::as_i64()` 一致：只接受 JSON 整数。 */
function asInt(v) {
  if (typeof v === "number" && isFinite(v) && Math.floor(v) === v) return v;
  return null;
}

/** 与 Rust `str::parse::<i64>()` 一致：允许正负号，不接受空白或小数。 */
function parseIntText(v) {
  if (typeof v !== "string" || !/^[+-]?\d+$/.test(v)) return null;
  var n = parseInt(v, 10);
  return isFinite(n) ? n : null;
}

function parseBefore(v) {
  if (typeof v === "number") {
    var n = asInt(v);
    if (n === null) return { ok: false, msg: "invalid Before timestamp" };
    return { ok: true, value: n };
  }
  if (typeof v === "string") {
    var dur = time.parseDuration(v);
    if (dur !== null) return { ok: true, value: time.now() - dur };
    var ts = time.parseTime(v);
    if (ts === null) return { ok: false, msg: "invalid Before time format" };
    return { ok: true, value: ts };
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    var inner = hasOwn(v, "time") ? v.time : hasOwn(v, "value") ? v.value : v.ts;
    if (inner === undefined) return { ok: false, msg: "Before requires a time field" };
    return parseBefore(inner);
  }
  return { ok: false, msg: "invalid Before time format" };
}

/** 从 map 里按顺序取第一个存在的键（对应 Rust 的 `m.get(a).or_else(|| m.get(b))`） */
function pickFrom(map, names) {
  if (!map) return undefined;
  for (var i = 0; i < names.length; i++) {
    if (hasOwn(map, names[i])) return map[names[i]];
  }
  return undefined;
}

/** 从 map 里按顺序取第一个字符串值；非字符串视为不存在 */
function pickString(map, names) {
  var v = pickFrom(map, names);
  return typeof v === "string" ? v : "";
}

function variantFrom(name, map) {
  var key = canonicalVariant(name);
  var payload = map ? payloadOf(map, name) : undefined;

  if (key === "all") return { ok: true, value: { type: "All" } };

  if (key === "random") {
    var q = null;
    if (typeof payload === "number") {
      q = asInt(payload);
    } else if (typeof payload === "string") {
      q = parseIntText(payload);
    } else if (payload && typeof payload === "object") {
      // 与 Rust 一致：对象里的 quantity / count / n 只接受整数
      q = asInt(pickFrom(payload, ["quantity", "count", "n"]));
    } else {
      q = asInt(pickFrom(map, ["quantity", "count", "n"]));
    }
    if (q === null) return { ok: false, msg: "Random requires a quantity" };
    if (q < 0) return { ok: false, msg: "Random quantity must not be negative" };
    return { ok: true, value: { type: "Random", quantity: Math.min(q, 10000) } };
  }

  if (key === "studentid") {
    var id = "";
    if (typeof payload === "string") {
      id = payload.trim();
    } else if (payload && typeof payload === "object") {
      var v = pickFrom(payload, ["id", "studentID"]);
      id = typeof v === "string" ? v.trim() : "";
    } else {
      var mv = pickFrom(map, ["id", "studentID"]);
      id = typeof mv === "string" ? mv.trim() : "";
    }
    if (!id) return { ok: false, msg: "StudentID requires an id" };
    return { ok: true, value: { type: "StudentID", id: id } };
  }

  if (key === "shortstudentid") {
    var pickInt = function (v) {
      if (typeof v === "number") return asInt(v);
      if (typeof v === "string") return parseIntText(v);
      return null;
    };
    var shortId;
    if (typeof payload === "number" || typeof payload === "string") {
      shortId = pickInt(payload);
    } else if (payload && typeof payload === "object") {
      shortId = pickInt(pickFrom(payload, ["id", "shortStudentID"]));
    } else {
      shortId = pickInt(pickFrom(map, ["id", "shortStudentID"]));
    }
    if (shortId === null) return { ok: false, msg: "ShortStudentID requires an integer id" };
    return { ok: true, value: { type: "ShortStudentID", id: shortId } };
  }

  if (key === "titleregex") {
    var pattern = "";
    if (typeof payload === "string") {
      pattern = payload;
    } else if (payload && typeof payload === "object") {
      pattern = pickString(payload, ["re", "regex", "pattern"]);
    } else {
      pattern = pickString(map, ["re", "regex", "pattern"]);
    }
    if (!pattern) return { ok: false, msg: "TitleReGex requires a regular expression" };
    return { ok: true, value: { type: "TitleReGex", pattern: pattern } };
  }

  if (key === "before") {
    var tv;
    if (payload !== undefined) {
      tv = payload;
    } else if (map) {
      tv = pickFrom(map, ["time", "value", "ts"]);
    }
    if (tv === undefined) return { ok: false, msg: "Before requires a time" };
    var parsed = parseBefore(tv);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { type: "Before", time: parsed.value } };
  }

  return { ok: false, msg: "unknown match_mode: " + name };
}

/** 解析 match_mode；缺省为 All。返回 `{ok:true, value}` 或 `{ok:false, msg}` */
function parseMatchMode(value) {
  if (value === null || value === undefined) return { ok: true, value: { type: "All" } };
  if (typeof value === "string") return variantFrom(value, null);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    var named = value.mode !== undefined ? value.mode : value.type !== undefined ? value.type : value.kind;
    if (typeof named === "string") return variantFrom(named, value);
    var keys = Object.keys(value);
    if (keys.length === 1) {
      var single = {};
      single[keys[0]] = value[keys[0]];
      return variantFrom(keys[0], single);
    }
    return { ok: false, msg: "invalid match_mode format" };
  }
  return { ok: false, msg: "invalid match_mode format" };
}

/** Rust regex 支持行内标志 `(?i)`，JS RegExp 不支持：这里转换到 flags。 */
function compileRegex(pattern) {
  var source = String(pattern === null || pattern === undefined ? "" : pattern);
  var flags = "";
  var m = source.match(/^\(\?([ims]+)\)/);
  if (m) {
    for (var i = 0; i < m[1].length; i++) {
      if (flags.indexOf(m[1][i]) < 0) flags += m[1][i];
    }
    source = source.slice(m[0].length);
  }
  if (/\\[pP]\{/.test(source) && flags.indexOf("u") < 0) flags += "u";
  return new RegExp(source, flags);
}

/** 把匹配模式作用到数组上（`beforeKey` 为用于 Before 匹配的时间字段） */
function applyMode(mode, rows, options) {
  var beforeKey = (options && options.beforeKey) || "createdAt";
  var titleKey = (options && options.titleKey) || "title";
  if (mode.type === "All") return { ok: true, rows: rows };
  if (mode.type === "Random") {
    var idx = rows.map(function (_, i) {
      return i;
    });
    for (var i = idx.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = idx[i];
      idx[i] = idx[j];
      idx[j] = tmp;
    }
    var picked = idx.slice(0, mode.quantity).sort(function (a, b) {
      return a - b;
    });
    return {
      ok: true,
      rows: picked.map(function (k) {
        return rows[k];
      }),
    };
  }
  if (mode.type === "TitleReGex") {
    var re;
    try {
      re = compileRegex(mode.pattern);
    } catch (e) {
      return { ok: false, msg: "invalid regular expression: " + e.message };
    }
    return {
      ok: true,
      rows: rows.filter(function (r) {
        return re.test(String(r[titleKey] === undefined ? "" : r[titleKey]));
      }),
    };
  }
  if (mode.type === "Before") {
    return {
      ok: true,
      rows: rows.filter(function (r) {
        var v = r[beforeKey];
        return v !== null && v !== undefined && v < mode.time;
      }),
    };
  }
  return { ok: true, rows: rows };
}

module.exports = {
  parseMatchMode: parseMatchMode,
  applyMode: applyMode,
  parseBefore: parseBefore,
};
