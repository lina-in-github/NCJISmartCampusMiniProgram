/* MatchMode 解析：与 src/tools.rs 的 `parse_match_mode` 保持一致。
 *
 * 支持： "All" / {"Random":3} / {"Random":{"quantity":3}} / {"StudentID":"G2603-01"}
 *       / {"ShortStudentID":1} / {"TitleReGex":"^函数"} / {"Before":"7d"}
 *       以及显式对象 {"type":"Random","quantity":3}。 */
var time = require("./time");

function canonicalVariant(name) {
  return String(name || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

function payloadOf(map, mode) {
  if (Object.prototype.hasOwnProperty.call(map, mode)) return map[mode];
  var target = canonicalVariant(mode);
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    if (canonicalVariant(keys[i]) === target) return map[keys[i]];
  }
  return undefined;
}

function parseBefore(v) {
  if (typeof v === "number") {
    if (!isFinite(v)) return { ok: false, msg: "invalid Before timestamp" };
    return { ok: true, value: Math.floor(v) };
  }
  if (typeof v === "string") {
    var dur = time.parseDuration(v);
    if (dur !== null) return { ok: true, value: time.now() - dur };
    var ts = time.parseTime(v);
    if (ts === null) return { ok: false, msg: "invalid Before time format" };
    return { ok: true, value: ts };
  }
  if (v && typeof v === "object") {
    var inner = v.time !== undefined ? v.time : v.value !== undefined ? v.value : v.ts;
    if (inner === undefined) return { ok: false, msg: "Before requires a time field" };
    return parseBefore(inner);
  }
  return { ok: false, msg: "invalid Before time format" };
}

function variantFrom(name, map) {
  var key = canonicalVariant(name);
  var payload = map ? payloadOf(map, name) : undefined;

  if (key === "all") return { ok: true, value: { type: "All" } };

  if (key === "random") {
    var q = null;
    if (typeof payload === "number") q = payload;
    else if (typeof payload === "string" && /^\d+$/.test(payload.trim())) q = parseInt(payload, 10);
    else if (payload && typeof payload === "object") {
      var n = payload.quantity !== undefined ? payload.quantity : payload.count !== undefined ? payload.count : payload.n;
      if (n !== undefined && n !== null && isFinite(parseInt(n, 10))) q = parseInt(n, 10);
    } else if (map) {
      var n2 = map.quantity !== undefined ? map.quantity : map.count !== undefined ? map.count : map.n;
      if (n2 !== undefined && n2 !== null && isFinite(parseInt(n2, 10))) q = parseInt(n2, 10);
    }
    if (q === null) return { ok: false, msg: "Random requires a quantity" };
    if (q < 0) return { ok: false, msg: "Random quantity must not be negative" };
    return { ok: true, value: { type: "Random", quantity: Math.min(q, 10000) } };
  }

  if (key === "studentid") {
    var id = "";
    if (typeof payload === "string") id = payload.trim();
    else if (payload && typeof payload === "object") {
      var v = payload.id !== undefined ? payload.id : payload.studentID;
      id = v === undefined || v === null ? "" : String(v).trim();
    } else if (map) {
      var v2 = map.id !== undefined ? map.id : map.studentID;
      id = v2 === undefined || v2 === null ? "" : String(v2).trim();
    }
    if (!id) return { ok: false, msg: "StudentID requires an id" };
    return { ok: true, value: { type: "StudentID", id: id } };
  }

  if (key === "shortstudentid") {
    var raw = null;
    if (typeof payload === "number") raw = payload;
    else if (typeof payload === "string" && /^\d+$/.test(payload.trim())) raw = parseInt(payload, 10);
    else if (payload && typeof payload === "object") {
      raw = payload.id !== undefined ? payload.id : payload.shortStudentID;
    } else if (map) {
      raw = map.id !== undefined ? map.id : map.shortStudentID;
    }
    var shortId = typeof raw === "number" ? raw : parseInt(raw, 10);
    if (!isFinite(shortId)) {
      return { ok: false, msg: "ShortStudentID requires a number" };
    }
    return { ok: true, value: { type: "ShortStudentID", id: shortId } };
  }

  if (key === "titleregex" || key === "titleregexp") {
    var pattern = typeof payload === "string" ? payload : map && typeof map.TitleReGex === "string" ? map.TitleReGex : "";
    if (!String(pattern).trim()) return { ok: false, msg: "TitleReGex requires a pattern" };
    return { ok: true, value: { type: "TitleReGex", pattern: String(pattern) } };
  }

  if (key === "before") {
    if (payload === undefined) return { ok: false, msg: "invalid Before time format" };
    var parsed = parseBefore(payload);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { type: "Before", time: parsed.value } };
  }

  return { ok: false, msg: "invalid match_mode format" };
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
      re = new RegExp(mode.pattern);
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
