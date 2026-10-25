/* 把 `/api` 的响应加工成 WXML 直接可渲染的字段（文案全部来自 strings）。 */
var strings = require("./strings");
var time = require("./time");
var survey = require("./survey");
var attachments = require("./attachments");

var NOTICE_RE = /^\s*notice\s*$/i;

function copyOf(row) {
  var out = {};
  Object.keys(row || {}).forEach(function (k) {
    out[k] = row[k];
  });
  return out;
}

/** 征集卡片 / 列表项 */
function decorateSubmission(row, options) {
  var opts = options || {};
  var now = opts.now || time.now();
  var pageRole = opts.pageRole || "student";
  var staff = pageRole === "teacher" || pageRole === "admin";
  var parent = pageRole === "parent";
  var out = copyOf(row);
  var deadlineTs = row.deadLine ? time.parseTime(row.deadLine) : null;
  var chip = time.deadlineChip(deadlineTs, now);
  var createdTs = row.createdAt ? time.parseTime(row.createdAt) : null;
  var type = String(row.type || "");
  var notice = NOTICE_RE.test(type);

  out.typeText = time.typeLabel(type);
  out.deadlineTs = deadlineTs;
  out.deadlineText = chip.text;
  out.deadlineTone = chip.tone;
  out.deadlineFull = deadlineTs === null ? strings.t("time_no_deadline") : time.fmtDateTime(deadlineTs);
  out.createdText = createdTs === null ? "" : time.relativeTime(createdTs, now);
  out.createdFull = createdTs === null ? "" : time.fmtDateTime(createdTs);
  out.isNotice = notice;
  out.pinned = notice && (deadlineTs === null || deadlineTs > now);
  out.isForm = survey.kindMode(type) !== null;
  out.isSurvey = survey.kindMode(type) === survey.MODE_SURVEY;
  out.isAnswerSheet = survey.kindMode(type) === survey.MODE_ANSWER_SHEET;
  out.descShort = time.truncate(row.desc || "", 90);

  var own = staff ? row.uploadCount || 0 : row.myUploadCount || 0;
  out.countText = staff
    ? strings.S("submissions_count_staff", own)
    : parent
    ? strings.S("submissions_count_child", own)
    : strings.S("submissions_count_own", own);
  out.notSubmitted = own === 0;
  out.notSubmittedText = parent
    ? strings.t("submissions_child_not_submitted")
    : strings.t("submissions_not_submitted");
  out.pendingCount = row.pendingCount || 0;
  out.uploadCount = row.uploadCount || 0;
  out.myUploadCount = row.myUploadCount || 0;
  return out;
}

/** 提交列表项 / 首页最近提交 */
function decorateUpload(row, options) {
  var opts = options || {};
  var now = opts.now || time.now();
  var createdTs = row.createdAt ? time.parseTime(row.createdAt) : null;
  var out = copyOf(row);
  var replies = Array.isArray(row.reply) ? row.reply : [];
  out.replyList = replies;
  out.replyCount = replies.length;
  out.timeText = createdTs === null ? "" : time.relativeTime(createdTs, now);
  out.createdFull = createdTs === null ? "" : time.fmtDateTime(createdTs);
  out.statusText = out.replyCount
    ? strings.S("uploads_status_replies", out.replyCount)
    : strings.t("uploads_status_pending");
  out.statusTone = out.replyCount ? "ok" : "warn";
  out.uploaderText = row.uploader || "";
  out.roleText = time.roleLabel(row.role || "student");
  out.initials = time.initial(row.uploader || "");
  out.studentNo = formatStudentNo(row.studentID, row.shortStudentID);
  out.attachments = attachments.toList(row.data);
  out.attachmentCount = out.attachments.length;
  out.descShort = time.truncate(row.desc || "", 80);
  out.submissionName = opts.submissionName || row.submissionName || "";
  out.gradeText = "";
  if (opts.formDesc) {
    var grade = survey.gradeOf(opts.formDesc, row.desc || "");
    if (grade) out.gradeText = survey.formatScore(grade.score) + " / " + survey.formatScore(grade.full);
  }
  return out;
}

function formatStudentNo(studentId, shortId) {
  var id = String(studentId || "").trim();
  var short = shortId ? (shortId < 10 ? "0" + shortId : String(shortId)) : "";
  if (id && short) return strings.S("student_no_full", id, short);
  if (id) return id;
  if (short) return strings.S("student_no_short", short);
  return "";
}

module.exports = {
  decorateSubmission: decorateSubmission,
  decorateUpload: decorateUpload,
  formatStudentNo: formatStudentNo,
};
