/* 问卷 / 答题卡：`src/survey.rs` 的小程序移植版。
 *
 * 简介（desc）里的 `<input/>` / `<checkbox/>` / `<switch/>` 会被解析成控件：
 *   * id 必填且以 `form_` 开头；
 *   * 答题卡模式还要求 `data-answer` + `data-score`（多选组后续选项除外），并且全部必填；
 *   * 提交时按 `{控件 id: 值}` 打包成 JSON 字符串，配合 `title: "bot-upload"` 调用 `/api/upload`；
 *   * 答题卡在客户端自动批改，批改结果以 `__grade` 追加在同一个 JSON 末尾。
 *
 * 服务端的校验规则（validateAnswer / validateDefinition）在离线模拟里复用同一份实现。
 */
var strings = require("./strings");

var FIELD_PREFIX = "form_";
var GRADE_KEY = "__grade";
var INPUT_TYPES = ["text", "number", "email", "tel", "url", "date", "time"];
var MAX_LABEL = 80;

var MODE_SURVEY = "survey";
var MODE_ANSWER_SHEET = "answer sheet";

/** 由征集 type 推断表单模式；非表单类征集返回 null */
function kindMode(kind) {
  var normalized = String(kind || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (normalized === "survey") return MODE_SURVEY;
  if (normalized === "answer sheet" || normalized === "answersheet" || normalized === "sheet") {
    return MODE_ANSWER_SHEET;
  }
  return null;
}

function isAnswerSheetMode(mode) {
  return mode === MODE_ANSWER_SHEET;
}

function fieldKindFromTag(name) {
  if (name === "input" || name === "checkbox" || name === "switch") return name;
  return null;
}

function validFieldId(id) {
  if (typeof id !== "string" || id.indexOf(FIELD_PREFIX) !== 0) return false;
  var rest = id.slice(FIELD_PREFIX.length);
  if (!rest || id.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(rest);
}

function isClosingTag(inner) {
  var t = String(inner || "").trim();
  if (t.charAt(0) !== "/") return false;
  var name = t.slice(1).trim().replace(/\/+$/, "").trim().toLowerCase();
  return fieldKindFromTag(name) !== null;
}

function tagName(inner) {
  var trimmed = String(inner || "").trim();
  var m = trimmed.match(/^[^\s/]+/);
  if (!m) return null;
  return fieldKindFromTag(m[0].toLowerCase());
}

function readValue(s) {
  var quote = s.charAt(0);
  if (quote === '"' || quote === "'") {
    var rest = s.slice(1);
    var end = rest.indexOf(quote);
    if (end < 0) return null;
    return { value: rest.slice(0, end), rest: rest.slice(end + 1) };
  }
  var m = s.match(/^[^\s/]*/);
  var value = m ? m[0] : "";
  return { value: value, rest: s.slice(value.length) };
}

/** 解析属性串（`id="form_x" required`）-> {attrs:[[k,v]], flags:[k]} */
function parseAttrs(input) {
  var s = String(input || "");
  var attrs = [];
  var flags = [];
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (!s) return { attrs: attrs, flags: flags };
    if (s.charAt(0) === "/") {
      s = s.slice(1);
      continue;
    }
    var m = s.match(/^[^\s=/]+/);
    if (!m) return null;
    var key = m[0].toLowerCase();
    if (!/^[A-Za-z0-9_:-]+$/.test(key)) return null;
    s = s.slice(key.length);
    var afterWs = s.replace(/^\s+/, "");
    if (afterWs.charAt(0) === "=") {
      var read = readValue(afterWs.slice(1).replace(/^\s+/, ""));
      if (!read) return null;
      attrs.push([key, read.value]);
      s = read.rest;
    } else {
      flags.push(key);
      s = afterWs;
    }
  }
}

function attr(attrs, key) {
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i][0] === key) return attrs[i][1];
  }
  return null;
}

function parseTag(inner, mode, seenIds) {
  var trimmed = String(inner || "").trim();
  var m = trimmed.match(/^[^\s/]+/);
  if (!m) return null;
  var kind = fieldKindFromTag(m[0].toLowerCase());
  if (!kind) return null;
  var parsed = parseAttrs(trimmed.slice(m[0].length));
  if (!parsed) return null;

  var idAttr = attr(parsed.attrs, "id");
  if (idAttr === null) return null;
  var id = String(idAttr).trim();
  if (!validFieldId(id)) return null;

  var groupMember = Object.prototype.hasOwnProperty.call(seenIds, id);
  var answer = attr(parsed.attrs, "data-answer");
  var scoreRaw = attr(parsed.attrs, "data-score");
  var score = scoreRaw === null ? null : parseFloat(String(scoreRaw).trim());
  var graded =
    answer !== null && score !== null && isFinite(score) && score >= 0;
  if (isAnswerSheetMode(mode) && !graded && !groupMember) return null;

  var required =
    isAnswerSheetMode(mode) ||
    attr(parsed.attrs, "required") !== null ||
    parsed.flags.indexOf("required") >= 0;

  var typeAttr = attr(parsed.attrs, "type");
  var inputType = "text";
  if (typeAttr !== null) {
    var lowered = String(typeAttr).trim().toLowerCase();
    if (INPUT_TYPES.indexOf(lowered) >= 0) inputType = lowered;
  }

  return {
    kind: kind,
    id: id,
    required: required,
    inputType: inputType,
    placeholder: attr(parsed.attrs, "placeholder") || "",
    value: attr(parsed.attrs, "value") || "",
    label: "",
    groupLabel: "",
    groupSize: 1,
    answer: answer === null ? "" : answer,
    score: score === null || !isFinite(score) ? 0 : score,
    graded: graded,
  };
}

function cleanLabelText(s) {
  var text = String(s === null || s === undefined ? "" : s).trim();
  var chars = Array.from(text);
  if (chars.length <= MAX_LABEL) return text;
  return chars.slice(0, MAX_LABEL).join("") + "…";
}

function takeLinePrefix(nodes, j) {
  var node = nodes[j];
  if (!node || node.type !== "text") return null;
  if (node.text.charAt(0) === "\n") return null;
  var cut = node.text.indexOf("\n");
  if (cut < 0) cut = node.text.length;
  var head = node.text.slice(0, cut).trim();
  if (!head) return null;
  var label = cleanLabelText(head);
  node.text = node.text.slice(cut);
  return label;
}

function takeLineSuffix(nodes, j) {
  if (j === 0) return null;
  var node = nodes[j - 1];
  if (!node || node.type !== "text") return null;
  var start = node.text.lastIndexOf("\n");
  start = start < 0 ? 0 : start + 1;
  var tail = node.text.slice(start).trim().replace(/[:：=＝]+$/, "");
  var label = cleanLabelText(tail);
  if (!label) return null;
  node.text = node.text.slice(0, start);
  return label;
}

function peekLineSuffix(nodes, j) {
  if (j === 0) return null;
  var node = nodes[j - 1];
  if (!node || node.type !== "text") return null;
  var start = node.text.lastIndexOf("\n");
  start = start < 0 ? 0 : start + 1;
  var label = cleanLabelText(node.text.slice(start).trim().replace(/[:：=＝]+$/, ""));
  return label || null;
}

function assignLabels(nodes, fields) {
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.type !== "field") continue;
    var field = fields[node.index];
    if (field.kind === "checkbox") {
      var group = peekLineSuffix(nodes, i);
      if (group) field.groupLabel = group;
    }
    if (field.kind === "checkbox" || field.kind === "switch") {
      var after = takeLinePrefix(nodes, i + 1);
      if (after) {
        field.label = after;
        continue;
      }
    }
    var before = takeLineSuffix(nodes, i);
    if (before) field.label = before;
  }
}

/** 解析简介 -> Survey 对象 */
function parseSurvey(desc, mode) {
  var text = String(desc === null || desc === undefined ? "" : desc);
  var nodes = [];
  var fields = [];
  var invalid = [];
  var seenIds = {};
  var buffer = "";
  var rest = text;

  for (;;) {
    var lt = rest.indexOf("<");
    if (lt < 0) break;
    var gtRel = rest.indexOf(">", lt);
    if (gtRel < 0) break;
    var inner = rest.slice(lt + 1, gtRel);
    var raw = rest.slice(lt, gtRel + 1);
    if (isClosingTag(inner)) {
      buffer += rest.slice(0, lt);
      rest = rest.slice(gtRel + 1);
      continue;
    }
    var field = parseTag(inner, mode, seenIds);
    if (field) {
      buffer += rest.slice(0, lt);
      if (buffer) {
        nodes.push({ type: "text", text: buffer });
        buffer = "";
      }
      seenIds[field.id] = true;
      fields.push(field);
      nodes.push({ type: "field", index: fields.length - 1 });
    } else {
      if (tagName(inner)) invalid.push(raw);
      buffer += raw;
    }
    rest = rest.slice(gtRel + 1);
  }
  buffer += rest;
  if (buffer) nodes.push({ type: "text", text: buffer });

  assignLabels(nodes, fields);

  var counts = {};
  fields.forEach(function (f) {
    counts[f.id] = (counts[f.id] || 0) + 1;
  });
  fields.forEach(function (f) {
    f.groupSize = counts[f.id];
  });

  var survey = {
    mode: mode,
    nodes: nodes,
    fields: fields,
    invalidTags: invalid,
    isEmpty: fields.length === 0,
    requiredIds: function () {
      var out = [];
      fields.forEach(function (f) {
        if ((f.required || isAnswerSheetMode(mode)) && out.indexOf(f.id) < 0) out.push(f.id);
      });
      return out;
    },
    labels: function () {
      var map = {};
      fields.forEach(function (f) {
        var group = f.groupSize > 1 ? String(f.groupLabel || "").trim() : "";
        var label = group || String(f.label || "").trim();
        if (label && !Object.prototype.hasOwnProperty.call(map, f.id)) map[f.id] = label;
      });
      return map;
    },
    /** 渲染用的顺序块：文本段落与控件交替 */
    blocks: function () {
      var out = [];
      var occurrences = {};
      nodes.forEach(function (node) {
        if (node.type === "field") {
          var f = fields[node.index];
          occurrences[f.id] = (occurrences[f.id] || 0) + 1;
          var occ = occurrences[f.id];
          out.push({
            key: "f" + out.length,
            kind: "field",
            field: f,
            occurrence: occ,
            domId: occ === 1 ? f.id : f.id + "__" + occ,
            showLabel: occ === 1,
            showOption: f.kind === "checkbox",
            optionCaption: f.kind === "checkbox" ? String(f.label || f.value || f.id).trim() : "",
            groupCaption: f.kind === "checkbox" && occ === 1 ? String(f.groupLabel || "").trim() : "",
          });
        } else {
          var text = node.text;
          if (!String(text).trim()) return;
          String(text)
            .split("\n\n")
            .forEach(function (para) {
              if (!String(para).trim()) return;
              out.push({ key: "t" + out.length, kind: "text", text: para.split("\n").join("\n") });
            });
        }
      });
      return out;
    },
  };
  return survey;
}

// ---------------------------------------------------------------------------
// 答案收集与批改
// ---------------------------------------------------------------------------

/** 按 DOM 键（form_x / form_x__2）收集答案，输出 `{控件 id: 值}` */
function collectAnswers(survey, state) {
  var groups = {};
  var order = [];
  survey.fields.forEach(function (f) {
    if (!groups[f.id]) {
      groups[f.id] = [];
      order.push(f.id);
    }
    var occ = groups[f.id].length + 1;
    var domId = occ === 1 ? f.id : f.id + "__" + occ;
    groups[f.id].push({ field: f, domId: domId });
  });
  var out = {};
  order.forEach(function (id) {
    var list = groups[id];
    var kind = list[0].field.kind;
    if (kind === "switch") {
      out[id] = state[list[0].domId] === true ? "on" : "off";
    } else if (kind === "checkbox") {
      var picked = [];
      list.forEach(function (item) {
        if (state[item.domId] === true) picked.push(item.field.value || "on");
      });
      out[id] = picked.join(",");
    } else {
      var raw = state[list[0].domId];
      out[id] = String(raw === null || raw === undefined ? "" : raw).trim();
    }
  });
  return out;
}

/** 缺少的必填项 id 列表（空数组表示通过） */
function missingRequired(survey, values) {
  return survey.requiredIds().filter(function (id) {
    var v = values[id];
    return v === null || v === undefined || String(v).trim() === "";
  });
}

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeSwitch(value) {
  var s = normalizeText(value);
  if (s === "true" || s === "1" || s === "yes" || s === "on") return "on";
  if (s === "false" || s === "0" || s === "no" || s === "off" || s === "") return "off";
  return s;
}

function optionSet(text) {
  return String(text || "")
    .split(/[,，、]/)
    .map(normalizeText)
    .filter(Boolean)
    .sort()
    .join("|");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 逐题比对 data-answer，按 data-score 计分（答对得满分，答错 0 分） */
function gradeSheet(survey, values) {
  var grade = { score: 0, full: 0, right: 0, count: 0, detail: {} };
  var seen = {};
  survey.fields.forEach(function (field) {
    if (seen[field.id]) return;
    seen[field.id] = true;
    var expected = String(field.answer || "");
    var score = field.score;
    if (!isFinite(score) || score < 0) score = 0;
    var got = values[field.id] === null || values[field.id] === undefined ? "" : String(values[field.id]);
    var ok = false;
    if (field.kind === "checkbox") {
      ok = optionSet(expected) !== "" && optionSet(expected) === optionSet(got);
    } else if (field.kind === "switch") {
      ok = normalizeSwitch(got) === normalizeSwitch(expected);
    } else {
      ok =
        expected
          .split("|")
          .map(normalizeText)
          .filter(Boolean)
          .indexOf(normalizeText(got)) >= 0;
    }
    grade.detail[field.id] = { ok: ok, score: ok ? score : 0, answer: expected };
    grade.full += score;
    grade.count += 1;
    if (ok) {
      grade.score += score;
      grade.right += 1;
    }
  });
  grade.score = round2(grade.score);
  grade.full = round2(grade.full);
  return grade;
}

// ---------------------------------------------------------------------------
// 服务端校验（离线模拟复用）
// ---------------------------------------------------------------------------

function valueIsBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "boolean") return !v;
  return false;
}

function parseJsonObject(text) {
  try {
    var parsed = JSON.parse(String(text === null || text === undefined ? "" : text).trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return null;
  } catch (e) {
    return null;
  }
}

/** 与 Rust `validate_answer` 一致：只在答案能解析成 JSON 对象、且有必填项时才校验 */
function validateAnswer(formDesc, answer, mode) {
  var survey = parseSurvey(formDesc, mode);
  var required = survey.requiredIds();
  if (!required.length) return null;
  var obj = parseJsonObject(answer);
  if (!obj) return null;
  var missing = required.filter(function (id) {
    return !Object.prototype.hasOwnProperty.call(obj, id) || valueIsBlank(obj[id]);
  });
  if (!missing.length) return null;
  return "missing required form fields: " + missing.join(", ");
}

function validateSubmission(kind, formDesc, answer) {
  var mode = kindMode(kind);
  if (!mode) return null;
  return validateAnswer(formDesc, answer, mode);
}

/** 答题卡：发布时简介必须至少有一道合法题目，且不出现非法标签 */
function validateDefinition(kind, desc) {
  var mode = kindMode(kind);
  if (!mode) return null;
  if (!isAnswerSheetMode(mode)) return null;
  var survey = parseSurvey(desc, mode);
  if (survey.invalidTags.length) {
    return (
      'invalid answer sheet item (id must start with "form_" and both data-answer and data-score are required): ' +
      survey.invalidTags[0]
    );
  }
  if (survey.isEmpty) {
    return "an answer sheet needs at least one <input/>, <checkbox/> or <switch/> item with id, data-answer and data-score";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 展示：把提交内容里的 JSON 答案渲染成「题目 / 回答」
// ---------------------------------------------------------------------------

function displayJson(v) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

function answerPairs(answer) {
  var obj = parseJsonObject(answer);
  if (!obj) return null;
  var pairs = [];
  Object.keys(obj).forEach(function (key) {
    if (key.indexOf("__") === 0) return;
    pairs.push([key, displayJson(obj[key])]);
  });
  return pairs.length ? pairs : null;
}

function displayValue(survey, field, value) {
  if (field.groupSize <= 1 || !String(value).trim()) return value;
  return String(value)
    .split(",")
    .map(function (token) {
      var t = token.trim();
      var match = null;
      survey.fields.forEach(function (f) {
        if (match) return;
        if (f.id === field.id && String(f.value).trim() === t) {
          var label = String(f.label || "").trim();
          if (label) match = label;
        }
      });
      return match || t;
    })
    .join("、");
}

function answerRows(formDesc, answer, mode) {
  var survey = parseSurvey(formDesc, mode);
  var pairs = answerPairs(answer);
  if (!pairs) return null;
  var labels = survey.labels();
  var taken = pairs.map(function () {
    return false;
  });
  var rows = [];
  survey.fields.forEach(function (field) {
    for (var i = 0; i < pairs.length; i++) {
      if (!taken[i] && pairs[i][0] === field.id) {
        taken[i] = true;
        rows.push({
          label: labels[field.id] || field.id,
          value: displayValue(survey, field, pairs[i][1]),
          id: field.id,
        });
        return;
      }
    }
  });
  pairs.forEach(function (pair, i) {
    if (!taken[i]) rows.push({ label: pair[0], value: pair[1], id: pair[0] });
  });
  return rows;
}

function formatScore(score) {
  if (!isFinite(score)) return "0";
  var rounded = Math.round(score * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded));
  return String(rounded);
}

/** 读取提交内容里的 `__grade`，用于详情页展示自动批改结果 */
function gradeOf(formDesc, answer) {
  var obj = parseJsonObject(answer);
  if (!obj) return null;
  var grade = obj[GRADE_KEY];
  if (!grade || typeof grade !== "object" || Array.isArray(grade)) return null;
  var survey = parseSurvey(formDesc, MODE_ANSWER_SHEET);
  var labels = survey.labels();
  var detailObj = grade.detail && typeof grade.detail === "object" ? grade.detail : null;
  var detail = [];
  if (detailObj) {
    survey.fields.forEach(function (field) {
      if (detail.some(function (item) { return item.id === field.id; })) return;
      var entry = detailObj[field.id];
      if (!entry) return;
      detail.push(gradeItem(field.id, labels[field.id] || field.id, entry));
    });
    Object.keys(detailObj).forEach(function (id) {
      if (detail.some(function (item) { return item.id === id; })) return;
      detail.push(gradeItem(id, labels[id] || id, detailObj[id] || {}));
    });
  }
  function num(v, fallback) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }
  return {
    score: num(grade.score, 0),
    full: num(grade.full, 0),
    right: num(
      grade.right,
      detail.filter(function (i) { return i.ok; }).length
    ),
    count: num(grade.count, detail.length),
    detail: detail,
  };
}

function gradeItem(id, label, entry) {
  return {
    id: id,
    label: label,
    ok: entry && entry.ok === true,
    score: entry && isFinite(parseFloat(entry.score)) ? parseFloat(entry.score) : 0,
    answer: entry ? displayJson(entry.answer) : "",
  };
}

function switchText(value) {
  var v = String(value === null || value === undefined ? "" : value).trim();
  if (v === "on") return strings.t("survey_switch_on");
  if (v === "off") return strings.t("survey_switch_off");
  return String(value);
}

module.exports = {
  FIELD_PREFIX: FIELD_PREFIX,
  GRADE_KEY: GRADE_KEY,
  MODE_SURVEY: MODE_SURVEY,
  MODE_ANSWER_SHEET: MODE_ANSWER_SHEET,
  kindMode: kindMode,
  isAnswerSheetMode: isAnswerSheetMode,
  validFieldId: validFieldId,
  parseSurvey: parseSurvey,
  collectAnswers: collectAnswers,
  missingRequired: missingRequired,
  gradeSheet: gradeSheet,
  validateAnswer: validateAnswer,
  validateSubmission: validateSubmission,
  validateDefinition: validateDefinition,
  answerRows: answerRows,
  gradeOf: gradeOf,
  formatScore: formatScore,
  switchText: switchText,
};
