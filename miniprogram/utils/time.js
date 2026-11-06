/* 时间与展示文案：与 src/tools.rs + src/view.rs 的规则保持一致。
 * 所有时间统一按北京时间（UTC+8）解析与展示，API 返回值形如
 * `2026-11-01T20:00:00+08:00`。 */
var strings = require("./strings");

var TZ_OFFSET = 8 * 3600;

function now() {
  return Math.floor(Date.now() / 1000);
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function pad4(n) {
  var s = String(n);
  while (s.length < 4) s = "0" + s;
  return s;
}

function daysInMonth(y, m) {
  if (m === 2) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  }
  return [4, 6, 9, 11].indexOf(m) >= 0 ? 30 : 31;
}

// Howard Hinnant 的 civil date 算法（与 tools.rs 相同）
function daysFromCivil(y, m, d) {
  var yy = m <= 2 ? y - 1 : y;
  var era = (yy >= 0 ? yy : yy - 399) / 400;
  era = Math.floor(era);
  var yoe = yy - era * 400;
  var mp = (m + 9) % 12;
  var doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  var zz = z + 719468;
  var era = Math.floor((zz >= 0 ? zz : zz - 146096) / 146097);
  var doe = zz - era * 146097;
  var yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  var y = yoe + era * 400;
  var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  var mp = Math.floor((5 * doy + 2) / 153);
  var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  var m = mp < 10 ? mp + 3 : mp - 9;
  return { y: m <= 2 ? y + 1 : y, m: m, d: d };
}

function localParts(ts) {
  var t = ts + TZ_OFFSET;
  var days = Math.floor(t / 86400);
  var secs = t - days * 86400;
  if (secs < 0) {
    secs += 86400;
    days -= 1;
  }
  var c = civilFromDays(days);
  return {
    y: c.y,
    m: c.m,
    d: c.d,
    hh: Math.floor(secs / 3600),
    mm: Math.floor((secs % 3600) / 60),
    ss: secs % 60,
  };
}

function fmtISO(ts) {
  if (ts === null || ts === undefined) return null;
  var p = localParts(ts);
  return (
    pad4(p.y) + "-" + pad2(p.m) + "-" + pad2(p.d) + "T" +
    pad2(p.hh) + ":" + pad2(p.mm) + ":" + pad2(p.ss) + "+08:00"
  );
}

function fmtDateTime(ts) {
  var p = localParts(ts);
  return pad4(p.y) + "-" + pad2(p.m) + "-" + pad2(p.d) + " " + pad2(p.hh) + ":" + pad2(p.mm);
}

function fmtDate(ts) {
  var p = localParts(ts);
  return pad4(p.y) + "-" + pad2(p.m) + "-" + pad2(p.d);
}

function fmtDateTimeLocal(ts) {
  var p = localParts(ts);
  return (
    pad4(p.y) + "-" + pad2(p.m) + "-" + pad2(p.d) + "T" + pad2(p.hh) + ":" + pad2(p.mm)
  );
}

function parseTzOffset(tz) {
  if (tz.length < 3) return null;
  var sign = tz.charAt(0);
  if (sign !== "+" && sign !== "-") return null;
  var digits = tz.slice(1).replace(/:/g, "");
  if (digits.length !== 4 || !/^\d{4}$/.test(digits)) return null;
  var h = parseInt(digits.slice(0, 2), 10);
  var m = parseInt(digits.slice(2, 4), 10);
  if (h > 23 || m > 59) return null;
  return (sign === "-" ? -1 : 1) * (h * 3600 + m * 60);
}

function splitTz(s) {
  if (/[Zz]$/.test(s)) return { datetime: s.slice(0, -1), offset: 0 };
  if (s.length > 10) {
    var tail = s.slice(10);
    var idx = Math.max(tail.lastIndexOf("+"), tail.lastIndexOf("-"));
    if (idx >= 0) {
      var pos = 10 + idx;
      var off = parseTzOffset(s.slice(pos));
      if (off !== null) return { datetime: s.slice(0, pos), offset: off };
    }
  }
  return { datetime: s, offset: null };
}

/** 解析时间：ISO / `2026-11-01 20:00:00` / `2026-11-01` / Unix 秒。
 *  无时区输入按北京时间解释。返回 Unix 秒，失败返回 null。 */
function parseTime(input) {
  var raw = String(input === null || input === undefined ? "" : input).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (/[^\x00-\x7F]/.test(raw)) return null;

  var split = splitTz(raw);
  var datetime = split.datetime;
  var offset = split.offset;
  var sep = datetime.search(/[T ]/);
  var datePart = sep >= 0 ? datetime.slice(0, sep) : datetime;
  var timePart = sep >= 0 ? datetime.slice(sep + 1).trim() : "";

  var bits = datePart.split("-");
  if (bits.length !== 3) return null;
  if (!/^\d+$/.test(bits[0]) || !/^\d+$/.test(bits[1]) || !/^\d+$/.test(bits[2])) return null;
  var y = parseInt(bits[0], 10);
  var m = parseInt(bits[1], 10);
  var d = parseInt(bits[2], 10);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;

  var h = 0;
  var mi = 0;
  var sec = 0;
  if (timePart) {
    var parts = timePart.split(":");
    if (parts.length < 2 || parts.length > 3) return null;
    if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
    h = parseInt(parts[0], 10);
    mi = parseInt(parts[1], 10);
    if (parts.length === 3) {
      var secPart = parts[2].split(".")[0];
      if (!/^\d+$/.test(secPart)) return null;
      sec = parseInt(secPart, 10);
    }
    if (h > 23 || mi > 59 || sec > 59) return null;
  }
  var local = daysFromCivil(y, m, d) * 86400 + h * 3600 + mi * 60 + sec;
  return local - (offset === null ? TZ_OFFSET : offset);
}

/** 解析 `7d` / `12h` / `30m` / `90s` / `2w` -> 秒数 */
function parseDuration(input) {
  var s = String(input === null || input === undefined ? "" : input).trim().toLowerCase();
  if (s.length < 2 || /[^\x00-\x7F]/.test(s)) return null;
  var unit = s.charAt(s.length - 1);
  var num = s.slice(0, -1);
  if (!/^\d+$/.test(num)) return null;
  var mult = { s: 1, m: 60, h: 3600, d: 86400, w: 7 * 86400 }[unit];
  if (!mult) return null;
  return parseInt(num, 10) * mult;
}

/** `/api/new-submission` 的 deadLine：null / 时间串 / 时间戳（整数，与 serde 的 i64 一致） */
function parseDeadlineValue(v) {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v === "number") {
    if (!isFinite(v) || Math.floor(v) !== v) return { ok: false, msg: "invalid deadLine" };
    return { ok: true, value: v <= 0 ? null : v };
  }
  if (typeof v === "string") {
    var s = v.trim();
    if (!s) return { ok: true, value: null };
    var ts = parseTime(s);
    if (ts === null) {
      return {
        ok: false,
        msg: "invalid deadLine format (e.g. 2026-11-01T20:00 or 2026-11-01)",
      };
    }
    return { ok: true, value: ts };
  }
  return { ok: false, msg: "deadLine must be a time string or timestamp" };
}

// ---------------------------------------------------------------------------
// 展示文案（与 view.rs 保持一致）
// ---------------------------------------------------------------------------

function relativeTime(ts, reference) {
  var ref = reference === undefined ? now() : reference;
  var d = ref - ts;
  if (d < 0) return fmtDateTime(ts);
  if (d < 60) return strings.t("time_just_now");
  if (d < 3600) return strings.S("time_minutes_ago", Math.floor(d / 60));
  if (d < 86400) return strings.S("time_hours_ago", Math.floor(d / 3600));
  if (d < 7 * 86400) return strings.S("time_days_ago", Math.floor(d / 86400));
  return fmtDate(ts);
}

function deadlineChip(deadline, reference) {
  var ref = reference === undefined ? now() : reference;
  if (deadline === null || deadline === undefined) {
    return { text: strings.t("deadline_none"), tone: "muted" };
  }
  var d = deadline - ref;
  if (d <= 0) return { text: strings.t("deadline_expired"), tone: "danger" };
  if (d < 3600) {
    return { text: strings.S("deadline_minutes", Math.max(1, Math.floor(d / 60))), tone: "danger" };
  }
  if (d < 86400) return { text: strings.S("deadline_hours", Math.floor(d / 3600)), tone: "warn" };
  return { text: strings.S("deadline_days", Math.floor(d / 86400)), tone: "ok" };
}

function typeLabel(kind) {
  var k = String(kind || "").trim().toLowerCase();
  if (k === "homework") return strings.t("type_homework");
  if (k === "open call" || k === "open_call" || k === "opencall") return strings.t("type_open_call");
  if (k === "leave request" || k === "leave_request" || k === "leaverequest") {
    return strings.t("type_leave_request");
  }
  if (k === "notice") return strings.t("type_notice");
  if (k === "survey") return strings.t("type_survey");
  if (k === "answer sheet" || k === "answer_sheet" || k === "answersheet" || k === "sheet") {
    return strings.t("type_answer_sheet");
  }
  if (k === "other") return strings.t("type_other");
  if (k === "") return strings.t("type_generic");
  return truncateChars(k, 24);
}

function roleLabel(role) {
  if (role === "parent") return strings.t("role_parent");
  if (role === "teacher") return strings.t("role_teacher");
  if (role === "admin") return strings.t("role_admin");
  return strings.t("role_student");
}

function truncateChars(s, n) {
  var text = String(s === null || s === undefined ? "" : s);
  var chars = Array.from(text);
  if (chars.length <= n) return text;
  return chars.slice(0, n).join("") + "…";
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

function initial(name) {
  var text = String(name || "").trim();
  if (!text) return strings.t("avatar_fallback");
  return Array.from(text)[0];
}

module.exports = {
  TZ_OFFSET: TZ_OFFSET,
  now: now,
  fmtISO: fmtISO,
  fmtDateTime: fmtDateTime,
  fmtDate: fmtDate,
  fmtDateTimeLocal: fmtDateTimeLocal,
  parseTime: parseTime,
  parseDuration: parseDuration,
  parseDeadlineValue: parseDeadlineValue,
  relativeTime: relativeTime,
  deadlineChip: deadlineChip,
  typeLabel: typeLabel,
  roleLabel: roleLabel,
  truncate: truncateChars,
  formatSize: formatSize,
  initial: initial,
};
