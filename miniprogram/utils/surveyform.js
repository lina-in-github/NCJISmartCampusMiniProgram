/* 问卷 / 答题卡表单：把 parseSurvey 的结果变成页面状态，并负责 bot 提交。
 *
 * 提交格式与 web 端完全一致：
 *   { auth, which, title: "bot-upload", desc: JSON.stringify({控件 id: 值}), data: [] }
 * 答题卡会额外在 JSON 末尾追加 `__grade`（自动批改结果）。 */
var strings = require("./strings");
var surveyLib = require("./survey");
var api = require("./api");

/** 生成页面需要的初始数据 */
function build(desc, kind) {
  var mode = surveyLib.kindMode(kind) || surveyLib.MODE_SURVEY;
  var survey = surveyLib.parseSurvey(desc, mode);
  var answers = {};
  survey.fields.forEach(function (field, idx) {
    var occurrence = 0;
    // 按出现顺序生成 DOM 键：form_x、form_x__2…
    var seen = 0;
    for (var i = 0; i <= idx; i++) {
      if (survey.fields[i].id === field.id) seen += 1;
    }
    occurrence = seen;
    var domId = occurrence === 1 ? field.id : field.id + "__" + occurrence;
    answers[domId] = field.kind === "input" ? field.value || "" : field.kind === "switch" ? field.value === "on" : false;
  });
  return {
    mode: mode,
    isAnswerSheet: surveyLib.isAnswerSheetMode(mode),
    survey: survey,
    blocks: survey.blocks(),
    answers: answers,
    hasFields: !survey.isEmpty,
  };
}

function setInput(page, domId, value) {
  var answers = page.data.answers || {};
  answers[domId] = value;
  page.setData({ answers: answers });
}

function toggleBox(page, domId) {
  var answers = page.data.answers || {};
  answers[domId] = !answers[domId];
  page.setData({ answers: answers });
}

function setSwitch(page, domId, value) {
  var answers = page.data.answers || {};
  answers[domId] = !!value;
  page.setData({ answers: answers });
}

/** 收集答案并提交（`title: "bot-upload"`） */
function submit(authKey, submissionId, state) {
  var values = surveyLib.collectAnswers(state.survey, state.answers || {});
  var missing = surveyLib.missingRequired(state.survey, values);
  if (missing.length) {
    return Promise.resolve({
      ok: false,
      local: true,
      msg: strings.t("toast_survey_required"),
      missing: missing,
    });
  }
  var done = strings.t("toast_survey_submitted");
  if (state.isAnswerSheet) {
    var grade = surveyLib.gradeSheet(state.survey, values);
    values.__grade = grade;
    done = strings.S("toast_answer_sheet_submitted", surveyLib.formatScore(grade.score), surveyLib.formatScore(grade.full));
  }
  var desc = JSON.stringify(values);
  return api
    .upload({
      auth: authKey,
      which: submissionId,
      title: "bot-upload",
      desc: desc,
      data: [],
    })
    .then(function (res) {
      res.doneMessage = done;
      res.answer = desc;
      return res;
    });
}

module.exports = {
  build: build,
  setInput: setInput,
  toggleBox: toggleBox,
  setSwitch: setSwitch,
  submit: submit,
};
