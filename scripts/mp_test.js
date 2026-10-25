#!/usr/bin/env node
/* 小程序离线模拟端自测（无需微信开发者工具）。
 *
 *   node scripts/mp_test.js
 *
 * 覆盖：
 *   1. 结构检查：app.json 里的每个页面都有 js/json/wxml/wxss，JSON 可解析；
 *   2. 文案检查：所有 strings.t()/S() 的 key 都在 strings/zh-CN.txt 里；
 *   3. utils 单测：时间/批改/问卷解析/MatchMode 与服务端规则一致；
 *   4. 离线 /api 同构：逐个接口校验请求字段与响应字段；
 *   5. 在线请求同构：拦截 wx.request，校验 URL、方法与请求体；
 *   6. 页面流程：登录 → 首页 → 征集 → 提交 → 回复 → 答题卡 → 账号中心，
 *      用假的 Page/wx 环境跑通 onShow 与交互方法。 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MP = path.join(ROOT, "miniprogram");

// ---------------------------------------------------------------------------
// 1. 结构检查
// ---------------------------------------------------------------------------

function checkStructure() {
  const appJson = readJson(path.join(MP, "app.json"));
  assert(Array.isArray(appJson.pages) && appJson.pages.length > 0, "app.json 缺少 pages");
  appJson.pages.forEach((page) => {
    ["js", "json", "wxml", "wxss"].forEach((ext) => {
      const file = path.join(MP, `${page}.${ext}`);
      assert(fs.existsSync(file), `缺少页面文件 ${page}.${ext}`);
    });
    readJson(path.join(MP, `${page}.json`));
  });
  readJson(path.join(MP, "theme.json"));
  readJson(path.join(MP, "sitemap.json"));
  const project = readJson(path.join(ROOT, "project.config.json"));
  assert(project.miniprogramRoot === "miniprogram/", "project.config.json 的 miniprogramRoot 不正确");
  // 组件
  ["index.js", "index.json", "index.wxml", "index.wxss"].forEach((f) => {
    assert(fs.existsSync(path.join(MP, "components/bottom-nav", f)), `缺少组件文件 ${f}`);
  });
  // 每个 json 都能解析
  walk(MP, (file) => {
    if (file.endsWith(".json")) readJson(file);
  });
  return appJson.pages.length;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function walk(dir, fn) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, fn);
    else fn(full);
  });
}

// ---------------------------------------------------------------------------
// 2. 假 wx 环境
// ---------------------------------------------------------------------------

const storageMap = new Map();
const log = { request: [], reLaunch: [], redirectTo: [], navigateTo: [], toast: [], clipboard: [] };
let modalQueue = [];

function resetStorage() {
  storageMap.clear();
}

function installWx() {
  global.wx = {
    getStorageSync: (k) => (storageMap.has(k) ? storageMap.get(k) : ""),
    setStorageSync: (k, v) => {
      storageMap.set(k, JSON.parse(JSON.stringify(v === undefined ? null : v)));
    },
    removeStorageSync: (k) => storageMap.delete(k),
    request: (opts) => {
      log.request.push({ url: opts.url, method: opts.method, data: opts.data });
      const reply = global.__nextResponse || { statusCode: 200, data: { ok: true } };
      global.__nextResponse = null;
      setImmediate(() => opts.success && opts.success(reply));
    },
    showToast: (opts) => log.toast.push(opts.title),
    hideToast: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    showModal: (opts) => {
      const next = modalQueue.shift() || { confirm: true, content: "" };
      setImmediate(() =>
        opts.success && opts.success({ confirm: next.confirm, cancel: !next.confirm, content: next.content })
      );
    },
    navigateTo: (opts) => log.navigateTo.push(opts.url),
    redirectTo: (opts) => log.redirectTo.push(opts.url),
    reLaunch: (opts) => log.reLaunch.push(opts.url),
    navigateBack: () => {},
    switchTab: () => {},
    setNavigationBarTitle: () => {},
    setClipboardData: (opts) => {
      log.clipboard.push(opts.data);
      opts.success && opts.success();
    },
    getSystemInfoSync: () => ({ theme: "light", platform: "devtools" }),
    onThemeChange: () => {},
    stopPullDownRefresh: () => {},
    env: { USER_DATA_PATH: "/tmp/mp" },
    getFileSystemManager: () => ({
      readFileSync: () => "aGVsbG8=",
      writeFileSync: () => {},
    }),
    chooseMessageFile: (opts) => {
      opts.success({ tempFiles: [{ path: "/tmp/demo/homework.txt", name: "homework.txt" }] });
    },
    previewImage: (opts) => opts.success && opts.success(),
    openDocument: (opts) => opts.success && opts.success(),
  };
}

// ---------------------------------------------------------------------------
// 3. 页面加载器
// ---------------------------------------------------------------------------

const pageRegistry = new Map();

function loadPage(route, query) {
  const file = path.join(MP, `${route}.js`);
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  let config = null;
  global.Page = (cfg) => {
    config = cfg;
  };
  global.Component = (cfg) => {
    config = cfg;
  };
  require(resolved);
  assert(config, `${route} 没有调用 Page()`);
  const inst = Object.create(config);
  inst.data = JSON.parse(JSON.stringify(config.data || {}));
  inst.route = route;
  inst.setData = function (patch, cb) {
    applyPatch(inst.data, patch);
    if (typeof cb === "function") cb();
  };
  pageRegistry.set(route, inst);
  if (typeof inst.onLoad === "function") inst.onLoad(query || {});
  if (typeof inst.onShow === "function") inst.onShow();
  return inst;
}

function applyPatch(target, patch) {
  Object.keys(patch || {}).forEach((key) => {
    if (key.includes(".")) {
      const parts = key.split(".");
      let node = target;
      for (let i = 0; i < parts.length - 1; i++) {
        if (node[parts[i]] === undefined || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = patch[key];
      return;
    }
    target[key] = patch[key];
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 0));
}

async function settle() {
  // 在线模式下页面会串行发起多个 wx.request（每次都是 setTimeout 模拟），多跑几轮定时器
  for (let i = 0; i < 120; i++) await wait(1);
}

function installGlobals() {
  global.getApp = () => ({
    globalData: { version: "test" },
    theme: () => "light",
    config: () => require(path.join(MP, "utils/config.js")).get(),
    session: () => require(path.join(MP, "utils/session.js")).get(),
  });
  global.getCurrentPages = () => Array.from(pageRegistry.values());
  global.App = () => {};
}

// ---------------------------------------------------------------------------
// 3.4 WXML 结构检查（标签配对 / 自闭合 / 注释）
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(["input", "image", "icon", "progress", "slider", "switch", "checkbox", "radio", "import", "include", "wxs"]);

function checkWxml() {
  const problems = [];
  walk(MP, (file) => {
    if (!file.endsWith(".wxml")) return;
    let src = fs.readFileSync(file, "utf8");
    src = src.replace(/<!--[\s\S]*?-->/g, "");
    const stack = [];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    let m;
    while ((m = re.exec(src))) {
      const closing = m[1] === "/";
      const name = m[2].toLowerCase();
      const selfClosing = m[4] === "/";
      if (closing) {
        const top = stack.pop();
        if (top !== name) {
          problems.push(`${path.relative(ROOT, file)}: </${name}> 与 <${top || "?"}> 不匹配`);
          return;
        }
        continue;
      }
      if (selfClosing || VOID_TAGS.has(name)) continue;
      stack.push(name);
    }
    if (stack.length) {
      problems.push(`${path.relative(ROOT, file)}: 未闭合标签 ${stack.join(" > ")}`);
    }
  });
  assert.deepStrictEqual(problems, [], `WXML 结构问题：\n${problems.join("\n")}`);
}

// ---------------------------------------------------------------------------
// 3.5 文案与 WXML 引用检查
// ---------------------------------------------------------------------------

function checkStrings() {
  const strings = require(path.join(MP, "utils/strings.js"));
  const used = new Set();
  const dynamic = new Set(["role_"]);
  walk(MP, (file) => {
    if (!file.endsWith(".js")) return;
    const src = fs.readFileSync(file, "utf8");
    const re = /strings\.(?:t|S)\("([a-z0-9_]+)"(?!\s*\+)/g;
    let m;
    while ((m = re.exec(src))) used.add(m[1]);
  });
  const missing = Array.from(used).filter((key) => !strings.has(key));
  assert.deepStrictEqual(missing, [], `以下文案 key 不在 strings/zh-CN.txt 中：${missing.join(", ")}`);

  // WXML 里引用的 s.<name> 必须在其页面 JS 中赋值（拼写错误的兜底检查）
  const problems = [];
  walk(MP, (file) => {
    if (!file.endsWith(".wxml")) return;
    const js = fs.readFileSync(file.replace(/\.wxml$/, ".js"), "utf8");
    const wxml = fs.readFileSync(file, "utf8");
    const re = /\bs\.([A-Za-z0-9_]+)/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(wxml))) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      if (!new RegExp(`\\b${name}\\s*:`).test(js)) {
        problems.push(`${path.relative(ROOT, file)} -> s.${name}`);
      }
    }
  });
  assert.deepStrictEqual(problems, [], `WXML 引用了未定义的文案字段：\n${problems.join("\n")}`);
  return used.size;
}

// ---------------------------------------------------------------------------
// 4. utils 单测
// ---------------------------------------------------------------------------

function testUtils() {
  const mp = (rel) => require(path.join(MP, rel));
  const strings = mp("utils/strings.js");
  const time = mp("utils/time.js");
  const survey = mp("utils/survey.js");
  const matchmode = mp("utils/matchmode.js");
  const attachments = mp("utils/attachments.js");

  assert.strictEqual(strings.t("title"), "智慧校园");
  assert.strictEqual(strings.S("submissions_page_sub", 3, "班级"), "3 个征集 · 单位：班级");
  assert.strictEqual(strings.t("no_such_key"), "@[strings/no_such_key]");
  assert.strictEqual(strings.S("no_such_key"), "@[strings/no_such_key]");

  // 时间：无时区按北京时间，+00:00 与 +08:00 等价换算
  const ts = time.parseTime("2026-11-01T20:00");
  assert.strictEqual(time.fmtISO(ts), "2026-11-01T20:00:00+08:00");
  assert.strictEqual(time.parseTime("2026-11-01T12:00:00Z"), ts);
  assert.strictEqual(time.parseTime("2026-11-01 20:00:00"), ts);
  assert.strictEqual(time.parseTime("2026-11-01"), time.parseTime("2026-11-01T00:00"));
  assert.strictEqual(time.parseTime("2026-02-30"), null);
  assert.strictEqual(time.parseDuration("7d"), 7 * 86400);
  assert.strictEqual(time.parseDuration("12h"), 12 * 3600);
  assert.deepStrictEqual(time.deadlineChip(null, 1000), { text: "无截止", tone: "muted" });
  assert.strictEqual(time.deadlineChip(1000, 2000).text, "已截止");
  assert.strictEqual(time.typeLabel("answer sheet"), "答题卡");

  // 问卷 / 答题卡解析
  const desc = '姓名：<input id="form_name" required/>\n想参加的社团：<checkbox id="form_club" value="math"/>数学社 <checkbox id="form_club" value="art"/>美术社\n接收通知：<switch id="form_notify"/>';
  const s1 = survey.parseSurvey(desc, survey.MODE_SURVEY);
  assert.deepStrictEqual(s1.requiredIds(), ["form_name"]);
  assert.strictEqual(s1.fields.length, 4);
  assert.strictEqual(s1.fields[0].label, "姓名");
  assert.strictEqual(s1.fields[1].groupSize, 2);
  assert.strictEqual(s1.fields[1].groupLabel, "想参加的社团");
  assert.strictEqual(s1.fields[1].label, "数学社");
  const values = survey.collectAnswers(s1, {
    form_name: "陈小满",
    form_club: true,
    form_club__2: false,
    form_notify: true,
  });
  assert.deepStrictEqual(values, { form_name: "陈小满", form_club: "math", form_notify: "on" });
  assert.strictEqual(survey.validateAnswer(desc, JSON.stringify({}), survey.MODE_SURVEY),
    "missing required form fields: form_name");
  assert.strictEqual(survey.validateAnswer(desc, "普通文字说明", survey.MODE_SURVEY), null);

  // 答题卡：缺 data-answer 视为非法标签，发布时拒绝
  const sheet = '1+1=<input id="form_q1" data-answer="2" data-score="5"/>\n地球是圆的：<switch id="form_q3" data-answer="on" data-score="2"/>';
  assert.strictEqual(survey.validateDefinition("answer sheet", sheet), null);
  assert.ok(survey.validateDefinition("answer sheet", "没有题目的简介"));
  assert.ok(
    survey.validateDefinition("answer sheet", '<input id="form_q1" data-score="5"/>')
      .startsWith("invalid answer sheet item")
  );
  const s2 = survey.parseSurvey(sheet, survey.MODE_ANSWER_SHEET);
  assert.deepStrictEqual(s2.requiredIds(), ["form_q1", "form_q3"]);
  const graded = survey.gradeSheet(s2, { form_q1: "2", form_q3: "off" });
  assert.deepStrictEqual(
    { score: graded.score, full: graded.full, right: graded.right, count: graded.count },
    { score: 5, full: 7, right: 1, count: 2 }
  );
  assert.strictEqual(graded.detail.form_q1.ok, true);
  assert.strictEqual(graded.detail.form_q3.ok, false);
  // 答案渲染
  const rows = survey.answerRows(desc, JSON.stringify({ form_name: "陈小满", form_club: "math,art" }), survey.MODE_SURVEY);
  assert.deepStrictEqual(rows.map((r) => r.label), ["姓名", "想参加的社团"]);
  assert.strictEqual(rows[1].value, "数学社、美术社");
  // 批改结果读取
  const answer = JSON.stringify({ form_q1: "2", form_q3: "off", __grade: graded });
  const read = survey.gradeOf(sheet, answer);
  assert.strictEqual(read.score, 5);
  assert.strictEqual(read.full, 7);
  assert.strictEqual(survey.switchText("on"), "开");

  // MatchMode
  assert.deepStrictEqual(matchmode.parseMatchMode(undefined), { ok: true, value: { type: "All" } });
  assert.deepStrictEqual(matchmode.parseMatchMode("All"), { ok: true, value: { type: "All" } });
  assert.deepStrictEqual(matchmode.parseMatchMode({ Random: 3 }), {
    ok: true,
    value: { type: "Random", quantity: 3 },
  });
  assert.deepStrictEqual(matchmode.parseMatchMode({ ShortStudentID: 1 }), {
    ok: true,
    value: { type: "ShortStudentID", id: 1 },
  });
  assert.deepStrictEqual(matchmode.parseMatchMode({ type: "Random", quantity: 3 }), {
    ok: true,
    value: { type: "Random", quantity: 3 },
  });
  assert.strictEqual(matchmode.parseMatchMode({ Random: -1 }).ok, false);
  assert.strictEqual(matchmode.parseMatchMode({ StudentID: "" }).ok, false);
  assert.ok(matchmode.parseMatchMode({ TitleReGex: "[" }).ok === true); // 正则错误在 applyMode 阶段报
  assert.strictEqual(
    matchmode.applyMode({ type: "TitleReGex", pattern: "[" }, []).ok,
    false
  );

  // 附件归一化（与 tools.rs::normalize_data 一致）
  const normalized = attachments.normalizeData(["aGVsbG8="]);
  assert.strictEqual(normalized.ok, true);
  assert.deepStrictEqual(normalized.value[0], {
    name: "Attachment 1",
    mime: "application/octet-stream",
    data: "aGVsbG8=",
  });
  assert.strictEqual(attachments.normalizeData("nope").ok, false);
  assert.strictEqual(attachments.normalizeData([{ mime: "text/plain", data: "不是base64!" }]).ok, false);
  assert.strictEqual(attachments.normalizeData([{ mime: "not a mime", data: "aGVsbG8=" }]).ok, false);
  const dataUrl = attachments.normalizeData(["data:image/png;base64,aGVsbG8="]);
  assert.strictEqual(dataUrl.value[0], "data:image/png;base64,aGVsbG8=");
}

// ---------------------------------------------------------------------------
// 5. 离线 /api 同构
// ---------------------------------------------------------------------------

function testMockApi() {
  const mp = (rel) => require(path.join(MP, rel));
  const config = mp("utils/config.js");
  const api = mp("utils/api.js");
  const mock = mp("utils/mock/index.js");

  config.save({ mode: "offline" });
  mock.reset();

  const STUDENT = "SC-STU-DEMO-2026";
  const TEACHER = "SC-TEA-DEMO-2026";
  const ADMIN = "SC-ADM-DEMO-2026";

  // 健康检查
  const health = mock.handle("health", {});
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.service, "smart-campus");

  // 鉴权语义
  const noAuth = mock.handle("all-submission", {});
  assert.deepStrictEqual([noAuth.ok, noAuth.status], [false, 422]);
  const badAuth = mock.handle("all-submission", { auth: "SC-XXX" });
  assert.deepStrictEqual([badAuth.ok, badAuth.status, badAuth.msg], [false, 401, "invalid or expired auth"]);

  // all-submission：字段齐全 + 公示置顶
  const subs = mock.handle("all-submission", { auth: STUDENT });
  assert.strictEqual(subs.ok, true);
  const first = subs.datas[0];
  ["id", "name", "desc", "deadLine", "type", "createdAt", "createdBy", "uploadCount", "myUploadCount", "pendingCount", "latestUploadID"].forEach(
    (key) => assert(key in first, `all-submission 缺少字段 ${key}`)
  );
  assert.strictEqual(first.type, "notice");
  assert.ok(/\+08:00$/.test(first.createdAt));

  // 学生视角只统计自己的提交
  const homework = subs.datas.find((s) => s.name.indexOf("函数与导数") >= 0);
  assert.strictEqual(homework.myUploadCount, 1);
  assert.strictEqual(homework.uploadCount, 1);
  const teacherSubs = mock.handle("all-submission", { auth: TEACHER });
  const teacherHomework = teacherSubs.datas.find((s) => s.name.indexOf("函数与导数") >= 0);
  assert.strictEqual(teacherHomework.uploadCount, 2);
  assert.strictEqual(teacherHomework.myUploadCount, 0);

  // download：权限 + 字段
  const forbidden = mock.handle("download", { auth: STUDENT, which: homework.id });
  assert.deepStrictEqual([forbidden.ok, forbidden.status], [false, 403]);
  const dl = mock.handle("download", { auth: TEACHER, which: homework.id });
  assert.strictEqual(dl.ok, true);
  ["id", "studentID", "shortStudentID", "title", "desc", "data", "reply", "uploader", "role", "createdAt"].forEach(
    (key) => assert(key in dl.datas[0], `download 缺少字段 ${key}`)
  );
  assert.ok(Array.isArray(dl.datas[0].reply));
  // MatchMode
  const byShort = mock.handle("download", { auth: TEACHER, which: homework.id, match_mode: { ShortStudentID: 1 } });
  assert.strictEqual(byShort.datas.length, 1);
  assert.strictEqual(byShort.datas[0].studentID, "G2603-01");
  const byRegex = mock.handle("download", { auth: TEACHER, which: homework.id, match_mode: { TitleReGex: "^周末" } });
  assert.strictEqual(byRegex.datas.length, 1);
  const byBadRegex = mock.handle("download", { auth: TEACHER, which: homework.id, match_mode: { TitleReGex: "[" } });
  assert.strictEqual(byBadRegex.status, 400);
  const byRandom = mock.handle("download", { auth: TEACHER, which: homework.id, match_mode: { Random: 2 } });
  assert.strictEqual(byRandom.datas.length, 2);
  const sports = subs.datas.find((s) => s.name.indexOf("秋季运动会") >= 0);
  const byStudent = mock.handle("download", { auth: TEACHER, which: sports.id, match_mode: { StudentID: "G2603-03" } });
  assert.strictEqual(byStudent.datas.length, 1);
  assert.strictEqual(byStudent.datas[0].shortStudentID, 3);
  assert.strictEqual(
    mock.handle("download", { auth: TEACHER, which: homework.id, match_mode: { StudentID: "G2603-03" } }).datas.length,
    0
  );
  // Before 按提交时间升序过滤：早于 1 小时前的是 3 小时前与 70 分钟前的两条
  const byBefore = mock.handle("download", { auth: TEACHER, which: homework.id, match_mode: { Before: "1h" } });
  assert.deepStrictEqual(byBefore.datas.map((d) => d.title), ["周末练习 · 第 1 页", "李知遥的周末练习"]);
  const byBeforeAll = mock.handle("download", { auth: TEACHER, which: homework.id, match_mode: { Before: "1s" } });
  assert.strictEqual(byBeforeAll.datas.length, 2);

  // upload：字段校验 + 成功
  const up = mock.handle("upload", {
    auth: STUDENT,
    which: homework.id,
    title: "离线模拟上传",
    desc: "来自 mp_test",
    data: [{ name: "hello.txt", mime: "text/plain", data: "aGVsbG8=" }],
  });
  assert.strictEqual(up.ok, true);
  assert.ok(/^up_/.test(up.id));
  assert.strictEqual(mock.handle("upload", { auth: STUDENT, which: homework.id, title: " " }).status, 400);
  const noticeSub = subs.datas.find((s) => s.type === "notice");
  assert.strictEqual(mock.handle("upload", { auth: STUDENT, which: noticeSub.id, title: "x" }).status, 403);
  assert.strictEqual(
    mock.handle("upload", { auth: STUDENT, which: "sub_missing", title: "x" }).status,
    404
  );
  // 跨班级
  const otherClassSub = mock.handle("all-submission", { auth: "SC-ADM-DEMO-2027" }).datas[0];
  assert.strictEqual(
    mock.handle("upload", { auth: STUDENT, which: otherClassSub.id, title: "x" }).status,
    404
  );

  // 问卷必填校验（服务端语义）
  const surveySub = subs.datas.find((s) => s.type === "survey");
  const missing = mock.handle("upload", {
    auth: STUDENT,
    which: surveySub.id,
    title: "bot-upload",
    desc: JSON.stringify({ form_club: "math" }),
  });
  assert.deepStrictEqual([missing.status, missing.msg], [400, "missing required form fields: form_name"]);
  const surveyOk = mock.handle("upload", {
    auth: STUDENT,
    which: surveySub.id,
    title: "bot-upload",
    desc: JSON.stringify({ form_name: "陈小满", form_club: "math,art", form_notify: "on" }),
  });
  assert.strictEqual(surveyOk.ok, true);
  // 非 JSON 说明仍可提交
  const plain = mock.handle("upload", { auth: STUDENT, which: surveySub.id, title: "随笔", desc: "普通文字" });
  assert.strictEqual(plain.ok, true);

  // new-submission：权限 + 答题卡校验
  assert.strictEqual(mock.handle("new-submission", { auth: STUDENT, name: "x" }).status, 403);
  assert.strictEqual(
    mock.handle("new-submission", { auth: TEACHER, name: "答题卡", type: "answer sheet", desc: "没有题目" }).status,
    400
  );
  const created = mock.handle("new-submission", {
    auth: TEACHER,
    name: "离线新增征集",
    desc: "说明",
    type: "homework",
    deadLine: "2027-01-01T20:00",
  });
  assert.strictEqual(created.ok, true);
  assert.ok(/^sub_/.test(created.id));
  assert.strictEqual(
    mock.handle("new-submission", { auth: TEACHER, name: "x", deadLine: "not-a-date" }).status,
    400
  );

  // reply
  assert.strictEqual(mock.handle("reply", { auth: STUDENT, uploadID: up.id, content: "x" }).status, 403);
  const rep = mock.handle("reply", { auth: TEACHER, uploadID: up.id, content: "收到，写得不错。" });
  assert.strictEqual(rep.ok, true);
  assert.ok(/^rep_/.test(rep.id));
  const afterReply = mock.handle("download", { auth: TEACHER, which: homework.id });
  const replied = afterReply.datas.find((d) => d.id === up.id);
  assert.deepStrictEqual(replied.reply, ["收到，写得不错。"]);

  // rename-auth：同步历史快照
  const renamed = mock.handle("rename-auth", { auth: TEACHER, name: "林老师" });
  assert.deepStrictEqual([renamed.ok, renamed.name], [true, "林老师"]);
  const afterRename = mock.handle("all-submission", { auth: TEACHER });
  assert.strictEqual(afterRename.datas.find((s) => s.id === homework.id).createdBy, "林老师");
  assert.strictEqual(mock.handle("rename-auth", { auth: TEACHER, name: "  " }).status, 400);

  // new-class + new-user
  assert.strictEqual(mock.handle("new-class", { auth: TEACHER, desc: "x" }).status, 403);
  assert.strictEqual(mock.handle("new-class", { auth: ADMIN }).status, 400);
  const cls = mock.handle("new-class", { auth: ADMIN, name: "高三（2）班", desc: "模拟新建班级" });
  assert.strictEqual(cls.ok, true);
  assert.ok(/^cls_/.test(cls.id));
  assert.ok(/^SC-ADM-/.test(cls.auth));
  assert.ok(/^auth_/.test(cls.authID));
  const members = mock.handle("new-user", { auth: cls.auth, classID: cls.id, quantity: 2, type: "Student" });
  assert.strictEqual(members.ok, true);
  assert.strictEqual(members.IDs.length, 2);
  assert.strictEqual(members.keys.length, 2);
  assert.ok(members.keys[0].indexOf("SC-STU-") === 0);
  assert.strictEqual(members.members[0].studentID, cls.code + "-01");
  assert.strictEqual(members.members[1].shortDisplay, undefined);
  assert.strictEqual(members.members[1].studentID, cls.code + "-02");
  assert.strictEqual(
    mock.handle("new-user", { auth: cls.auth, classID: "cls_other", quantity: 1, type: "Student" }).status,
    400
  );
  assert.strictEqual(mock.handle("new-user", { auth: cls.auth, classID: cls.id, quantity: 0, type: "Student" }).status, 400);

  // del-object：up_ / rep_ / sub_ 三种前缀都要能识别
  const tempUpload = mock.handle("upload", { auth: STUDENT, which: homework.id, title: "待删除提交" });
  const tempReply = mock.handle("reply", { auth: TEACHER, uploadID: tempUpload.id, content: "待删除回复" });
  assert.deepStrictEqual(mock.handle("del-object", { auth: ADMIN, id: tempReply.id }).msg, "deleted");
  assert.deepStrictEqual(mock.handle("del-object", { auth: ADMIN, id: tempUpload.id }).msg, "deleted");
  const afterDelete = mock.handle("download", { auth: TEACHER, which: homework.id });
  assert.ok(!afterDelete.datas.some((d) => d.id === tempUpload.id), "删除后不应再出现");

  // del-object 级联
  const delSub = mock.handle("del-object", { auth: ADMIN, id: created.id });
  assert.strictEqual(delSub.ok, true);
  assert.strictEqual(mock.handle("del-object", { auth: ADMIN, id: "rep_missing" }).status, 404);
  assert.strictEqual(mock.handle("del-object", { auth: TEACHER, id: created.id }).status, 403);
  assert.strictEqual(mock.handle("del-object", { id: created.id }).status, 401);
  assert.strictEqual(mock.handle("del-object", { auth: ADMIN, id: "sub_missing" }).status, 404);

  // del-key
  const memberKey = members.keys[0];
  const delKey = mock.handle("del-key", { auth: memberKey });
  assert.deepStrictEqual([delKey.ok, delKey.msg], [true, "key deleted"]);
  assert.strictEqual(mock.handle("all-submission", { auth: memberKey }).status, 401);

  // 探测角色（三步只读探测）
  return api
    .probeIdentity(STUDENT)
    .then((r) => {
      assert.deepStrictEqual(r, { ok: true, role: "student" });
      return api.probeIdentity(TEACHER);
    })
    .then((r) => {
      assert.deepStrictEqual(r, { ok: true, role: "teacher" });
      return api.probeIdentity(ADMIN);
    })
    .then((r) => {
      assert.deepStrictEqual(r, { ok: true, role: "admin" });
      return api.probeIdentity("SC-NOPE");
    })
    .then((r) => {
      assert.strictEqual(r.ok, false);
    });
}

// ---------------------------------------------------------------------------
// 6. 在线请求同构（拦截 wx.request）
// ---------------------------------------------------------------------------

function testOnlineRequests() {
  const mp = (rel) => require(path.join(MP, rel));
  const config = mp("utils/config.js");
  const api = mp("utils/api.js");

  config.save({ mode: "online", baseUrl: "192.168.1.20:3000" });
  assert.strictEqual(config.get().baseUrl, "http://192.168.1.20:3000");

  log.request.length = 0;
  global.__nextResponse = { statusCode: 200, data: { ok: true, id: "up_abc" } };
  return api
    .upload({ auth: "SC-STU-DEMO-2026", which: "sub_1", title: "t", desc: "d", data: [] })
    .then((res) => {
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(log.request[0], {
        url: "http://192.168.1.20:3000/api/upload",
        method: "POST",
        data: { auth: "SC-STU-DEMO-2026", which: "sub_1", title: "t", desc: "d", data: [] },
      });
      // 4xx 也要把 msg 透出
      global.__nextResponse = { statusCode: 400, data: { ok: false, msg: "title must not be empty" } };
      return api.upload({ auth: "a", which: "b", title: "" });
    })
    .then((res) => {
      assert.deepStrictEqual([res.ok, res.status, res.msg], [false, 400, "title must not be empty"]);
      // 非 JSON 响应
      global.__nextResponse = { statusCode: 502, data: "<html>bad gateway</html>" };
      return api.health();
    })
    .then((res) => {
      assert.strictEqual(res.ok, false);
      // 网络错误
      wx.request = (opts) => opts.fail({ errMsg: "request:fail timeout" });
      return api.reply({ auth: "a", uploadID: "b", content: "c" });
    })
    .then((res) => {
      assert.strictEqual(res.ok, false);
      assert.ok(res.msg.indexOf("network error") === 0);
      // 恢复
      installWx();
      config.save({ mode: "offline" });
    });
}

// ---------------------------------------------------------------------------
// 7. 页面流程（离线模拟）
// ---------------------------------------------------------------------------

async function testPages() {
  const mp = (rel) => require(path.join(MP, rel));
  const config = mp("utils/config.js");
  const session = mp("utils/session.js");
  const account = mp("utils/account.js");
  const mock = mp("utils/mock/index.js");
  const cache = mp("utils/cache.js");

  resetStorage();
  config.save({ mode: "offline", baseUrl: "http://localhost:3000" });
  mock.reset();
  account.load();
  session.clear();
  cache.clear();

  // 1) 登录首页
  const login = loadPage("pages/login/login");
  assert.strictEqual(login.data.cards.length, 4);
  assert.strictEqual(login.data.s.mode, "离线模拟");

  // 2) 学生密钥登录
  log.reLaunch.length = 0;
  const loginKey = loadPage("pages/login-key/login-key", { role: "student" });
  assert.strictEqual(loginKey.data.role, "student");
  loginKey.onFillDemo();
  loginKey.onSubmit();
  await settle();
  const student = session.get();
  assert.ok(student, "登录后应写入会话");
  assert.deepStrictEqual([student.role, student.pageRole], ["student", "student"]);
  assert.ok(log.reLaunch.indexOf("/pages/home/home") >= 0);

  // 3) 家长视角登录（同一密钥，不同展示视角）
  const parentLogin = loadPage("pages/login-key/login-key", { role: "parent" });
  parentLogin.onFillDemo();
  parentLogin.onSubmit();
  await settle();
  assert.deepStrictEqual([session.get().role, session.get().pageRole], ["student", "parent"]);
  // 视角与角色不匹配时拒绝
  const wrongRole = loadPage("pages/login-key/login-key", { role: "teacher" });
  wrongRole.setData({ key: "SC-STU-DEMO-2026" });
  wrongRole.onSubmit();
  await settle();
  assert.ok(wrongRole.data.error.indexOf("学生") >= 0);

  // 回到学生视角
  session.set({ key: "SC-STU-DEMO-2026", role: "student", pageRole: "student", view: "student" });

  // 4) 首页
  const home = loadPage("pages/home/home");
  await settle();
  assert.strictEqual(home.data.loading, false);
  assert.ok(home.data.stats.length === 4);
  assert.ok(home.data.submissions.length > 0);
  assert.ok(home.data.submissions[0].name, "首屏应有征集卡片");

  // 5) 征集列表
  const submissionsPage = loadPage("pages/submissions/submissions");
  await settle();
  assert.ok(submissionsPage.data.rows.length >= 8, "演示数据里应有 9 个征集");
  const noticeRow = submissionsPage.data.rows.find((r) => r.isNotice);
  assert.ok(noticeRow && noticeRow.pinned, "公示应置顶");

  // 6) 征集详情（普通征集）
  const homeworkSub = submissionsPage.data.rows.find((r) => r.name.indexOf("函数与导数") >= 0);
  const detail = loadPage("pages/submission/submission", { id: homeworkSub.id });
  await settle();
  assert.strictEqual(detail.data.loading, false);
  assert.ok(detail.data.uploads.length >= 1, "学生应看到自己的提交（离线本地读取）");

  // 7) 上传表单：普通征集
  const form = loadPage("pages/upload-form/upload-form", { id: homeworkSub.id });
  await settle();
  assert.strictEqual(form.data.isForm, false);
  form.onTitle({ detail: { value: "小程序离线提交" } });
  form.onDesc({ detail: { value: "来自 scripts/mp_test.js" } });
  await form.onChooseFiles();
  await settle();
  assert.strictEqual(form.data.fileList.length, 1);
  log.redirectTo.length = 0;
  form.onSubmitUpload();
  await settle();
  assert.ok(log.redirectTo[0].indexOf("/pages/upload-detail/upload-detail?id=up_") === 0);
  assert.strictEqual(cache.list("SC-STU-DEMO-2026").length, 1);

  // 8) 提交详情
  const uploadId = cache.list("SC-STU-DEMO-2026")[0].id;
  const uploadDetail = loadPage("pages/upload-detail/upload-detail", {
    id: uploadId,
    sid: homeworkSub.id,
  });
  await settle();
  assert.strictEqual(uploadDetail.data.loading, false);
  assert.ok(uploadDetail.data.upload.title === "小程序离线提交");
  assert.strictEqual(uploadDetail.data.upload.attachmentCount, 1);

  // 9) 问卷征集：就地填写并 bot 提交
  const surveyRow = submissionsPage.data.rows.find((r) => r.isSurvey);
  const surveyDetail = loadPage("pages/submission/submission", { id: surveyRow.id });
  await settle();
  assert.strictEqual(surveyDetail.data.isForm, true);
  assert.ok(surveyDetail.data.blocks.some((b) => b.kind === "field"));
  surveyDetail.onSurveyInput({ currentTarget: { dataset: { dom: "form_name" } }, detail: { value: "陈小满" } });
  surveyDetail.onToggleBox({ currentTarget: { dataset: { dom: "form_club" } } });
  surveyDetail.onToggleSwitch({ currentTarget: { dataset: { dom: "form_notify" } }, detail: { value: true } });
  surveyDetail.onSubmitSurvey();
  await settle();
  const afterSurvey = mock.localUploads("SC-STU-DEMO-2026", surveyRow.id, true);
  const bot = afterSurvey.datas.find((d) => d.title === "bot-upload");
  assert.ok(bot, "问卷应以 title=bot-upload 提交");
  assert.deepStrictEqual(JSON.parse(bot.desc), {
    form_name: "陈小满",
    form_club: "math",
    form_notify: "on",
  });
  // 必填缺失时被前端拦下
  const surveyDetail2 = loadPage("pages/submission/submission", { id: surveyRow.id });
  await settle();
  log.toast.length = 0;
  surveyDetail2.onSubmitSurvey();
  await settle();
  assert.ok(log.toast.some((t) => t.indexOf("必填") >= 0), "缺少必填项应提示");

  // 10) 答题卡：自动批改 + __grade
  const sheetRow = submissionsPage.data.rows.find((r) => r.isAnswerSheet);
  const sheetDetail = loadPage("pages/submission/submission", { id: sheetRow.id });
  await settle();
  assert.strictEqual(sheetDetail.data.isAnswerSheet, true);
  sheetDetail.onSurveyInput({ currentTarget: { dataset: { dom: "form_q1" } }, detail: { value: "2" } });
  sheetDetail.onToggleBox({ currentTarget: { dataset: { dom: "form_q2__2" } } });
  sheetDetail.onToggleSwitch({ currentTarget: { dataset: { dom: "form_q3" } }, detail: { value: false } });
  sheetDetail.onSubmitSurvey();
  await settle();
  const sheetUploads = mock.localUploads("SC-STU-DEMO-2026", sheetRow.id, true);
  const sheetAnswer = sheetUploads.datas.find((d) => d.title === "bot-upload");
  const parsedSheet = JSON.parse(sheetAnswer.desc);
  assert.strictEqual(parsedSheet.__grade.score, 8);
  assert.strictEqual(parsedSheet.__grade.full, 10);
  assert.strictEqual(parsedSheet.__grade.right, 2);
  assert.strictEqual(parsedSheet.__grade.count, 3);
  assert.strictEqual(parsedSheet.__grade.detail.form_q3.ok, false);
  // 详情页展示批改结果
  const sheetDetail2 = loadPage("pages/submission/submission", { id: sheetRow.id });
  await settle();
  const gradedRow = sheetDetail2.data.uploads.find((u) => u.title === "bot-upload");
  assert.ok(gradedRow.grade, "提交列表应显示自动批改结果");

  // 11) 老师身份：提交列表 + 回复
  session.set({ key: "SC-TEA-DEMO-2026", role: "teacher", pageRole: "teacher", view: "student" });
  const uploadsPage = loadPage("pages/uploads/uploads");
  await settle();
  assert.strictEqual(uploadsPage.data.loading, false);
  assert.ok(uploadsPage.data.counts.all >= 3, "老师应看到全班提交");
  assert.ok(uploadsPage.data.counts.pending >= 1);
  uploadsPage.onFilter({ currentTarget: { dataset: { filter: "pending" } } });
  assert.ok(uploadsPage.data.rows.every((r) => !r.replyCount));

  const studentUploads = mock.localUploads("SC-STU-DEMO-2026", homeworkSub.id, true);
  const targetUpload = studentUploads.datas.find((d) => d.title === "小程序离线提交");
  const teacherDetail = loadPage("pages/upload-detail/upload-detail", {
    id: targetUpload.id,
    sid: homeworkSub.id,
  });
  await settle();
  assert.strictEqual(teacherDetail.data.ctx.staff, true);
  teacherDetail.onReplyInput({ detail: { value: "离线模拟：已批阅。" } });
  teacherDetail.onSendReply();
  await settle();
  const replied = mock.localUploads("SC-TEA-DEMO-2026", homeworkSub.id, false).datas.find(
    (d) => d.id === targetUpload.id
  );
  assert.deepStrictEqual(replied.reply, ["离线模拟：已批阅。"]);

  // 12) 老师发布征集
  session.set({ key: "SC-TEA-DEMO-2026", role: "teacher", pageRole: "teacher", view: "student" });
  const publish = loadPage("pages/submission-new/submission-new");
  publish.onName({ detail: { value: "小程序发布的征集" } });
  publish.onDesc({ detail: { value: "来自离线模拟" } });
  publish.onType({ detail: { value: "1" } });
  log.reLaunch.length = 0;
  publish.onSubmit();
  await settle();
  assert.ok(log.reLaunch.indexOf("/pages/submissions/submissions") >= 0);
  const teacherSubs = mock.handle("all-submission", { auth: "SC-TEA-DEMO-2026" }).datas;
  const published = teacherSubs.find((s) => s.name === "小程序发布的征集");
  assert.ok(published, "发布后应出现在征集列表");
  assert.strictEqual(published.type, "open call");

  // 13) 账号中心：登录、创建班级、生成成员
  account.login("admin", "admin123");
  const accountPage = loadPage("pages/account/account");
  await settle();
  assert.ok(accountPage.data.bindings.length === 2, "演示账号应有两个管理员身份");
  assert.strictEqual(accountPage.data.stats.admins, 2);

  modalQueue = [];
  accountPage.onClassName({ detail: { value: "高一（9）班" } });
  accountPage.onClassDesc({ detail: { value: "小程序创建" } });
  accountPage.onCreateClass();
  await settle();
  assert.ok(accountPage.data.memberForm.classId.indexOf("cls_") === 0, "创建班级后应记住 classID");
  const newBinding = account.bindings().find((b) => b.label.indexOf("高一（9）班") >= 0);
  assert.ok(newBinding, "新班级的管理员密钥应绑定到账号");

  accountPage.onMemberQuantity({ detail: { value: "2" } });
  accountPage.onGenerateMembers();
  await settle();
  assert.strictEqual(accountPage.data.generated.length, 2);
  assert.ok(accountPage.data.generated[0].key.indexOf("SC-STU-") === 0);
  assert.ok(/2/.test(accountPage.data.s.generatedTitle), "生成结果标题应带数量");
  // 改名（/api/rename-auth）
  modalQueue = [{ confirm: true, content: "林书言" }];
  accountPage.onRename({ currentTarget: { dataset: { key: "SC-TEA-DEMO-2026" } } });
  await settle();

  // 14) 账号登录页 / 设置页
  account.logout();
  log.redirectTo.length = 0;
  const accountLogin = loadPage("pages/account-login/account-login");
  await settle();
  assert.ok(log.redirectTo.indexOf("/pages/account/account") < 0, "未登录时不应跳到账号中心");
  accountLogin.onTab({ currentTarget: { dataset: { tab: "register" } } });
  accountLogin.onUsername({ detail: { value: "newbie" } });
  accountLogin.onPassword({ detail: { value: "secret123" } });
  accountLogin.onPassword2({ detail: { value: "secret123" } });
  accountLogin.onKey({ detail: { value: "SC-STU-DEMO-2026-02" } });
  accountLogin.onRegister();
  await settle();
  assert.strictEqual(account.currentUser().username, "newbie");
  assert.strictEqual(account.bindings().length, 1);
  assert.strictEqual(account.bindings()[0].role, "student");
  await settle();
  assert.ok(accountLogin.data.s.title);
  const settings = loadPage("pages/settings/settings");
  await settle();
  assert.strictEqual(settings.data.mode, "offline");
  settings.onMode({ currentTarget: { dataset: { mode: "online" } } });
  assert.strictEqual(config.get().mode, "online");
  settings.onInput({ detail: { value: "10.0.0.8:3000" } });
  settings.onSave();
  assert.strictEqual(config.get().baseUrl, "http://10.0.0.8:3000");
  settings.onMode({ currentTarget: { dataset: { mode: "offline" } } });
  settings.onResetMock();

  // 15) 未登录访问受保护页面会回登录页
  session.clear();
  log.reLaunch.length = 0;
  loadPage("pages/home/home");
  assert.ok(log.reLaunch.indexOf("/pages/login/login") >= 0, "未登录应跳转登录页");

  // 16) 底部导航组件（按身份切换「我的上传 / 提交管理」）
  session.set({ key: "SC-TEA-DEMO-2026", role: "teacher", pageRole: "teacher", view: "student" });
  let navCfg = null;
  global.Component = (cfg) => {
    navCfg = cfg;
  };
  delete require.cache[require.resolve(path.join(MP, "components/bottom-nav/index.js"))];
  require(path.join(MP, "components/bottom-nav/index.js"));
  const nav = {
    data: {},
    setData(p) {
      Object.assign(this.data, p);
    },
  };
  Object.assign(nav, navCfg.methods);
  navCfg.lifetimes.attached.call(nav);
  assert.strictEqual(nav.data.items.length, 4);
  assert.strictEqual(nav.data.items[2].label, "提交管理");
}

// ---------------------------------------------------------------------------
// 7.5 在线模式的页面流程（假服务器直接复用离线 mock 作为「契约合规的服务端」）
// ---------------------------------------------------------------------------

async function testOnlinePages() {
  const mp = (rel) => require(path.join(MP, rel));
  const config = mp("utils/config.js");
  const session = mp("utils/session.js");
  const account = mp("utils/account.js");
  const mock = mp("utils/mock/index.js");
  const cache = mp("utils/cache.js");

  resetStorage();
  mock.reset();
  account.load();
  account.login("admin", "admin123");
  session.clear();
  cache.clear();
  config.save({ mode: "online", baseUrl: "http://campus.test:3000" });

  // 假服务器：URL 必须是 <base>/api/<endpoint>，请求体/响应体与 mock 契约一致
  const seen = [];
  global.wx.request = (opts) => {
    seen.push({ url: opts.url, method: opts.method, data: opts.data });
    const m = /^http:\/\/campus\.test:3000\/api\/([a-z-]+)$/.exec(opts.url);
    if (!m) {
      setTimeout(() => opts.success({ statusCode: 404, data: "<html>not found</html>" }), 0);
      return;
    }
    const body = mock.handle(m[1], opts.data || {});
    const statusCode = body.status || 200;
    const payload = Object.assign({}, body);
    delete payload.status;
    setTimeout(() => opts.success({ statusCode, data: payload }), 0);
  };

  // 老师：登录 -> 首页 -> 征集 -> 提交列表
  const teacherLogin = loadPage("pages/login-key/login-key", { role: "teacher" });
  teacherLogin.onFillDemo();
  teacherLogin.onSubmit();
  await settle();
  assert.strictEqual(session.get().role, "teacher");

  const home = loadPage("pages/home/home");
  await settle();
  assert.strictEqual(home.data.loading, false);
  assert.ok(home.data.submissions.length > 0, "在线模式首页应渲染征集");
  assert.ok(seen.some((r) => r.url === "http://campus.test:3000/api/all-submission"));
  assert.ok(seen.some((r) => r.url === "http://campus.test:3000/api/download"), "老师首页应逐个征集读取提交");

  const subs = loadPage("pages/submissions/submissions");
  await settle();
  assert.ok(subs.data.rows.length >= 8);

  const uploadsPage = loadPage("pages/uploads/uploads");
  await settle();
  assert.ok(uploadsPage.data.counts.all >= 3, "在线模式老师应能汇总全班提交");
  assert.ok(uploadsPage.data.rows[0].submissionName, "提交行应带上征集名称");

  // 学生：上传写入本机缓存，提交页从缓存回看
  session.set({ key: "SC-STU-DEMO-2026", role: "student", pageRole: "student", view: "student" });
  const homework = subs.data.rows.find((r) => r.name.indexOf("函数与导数") >= 0);
  const form = loadPage("pages/upload-form/upload-form", { id: homework.id });
  await settle();
  form.onTitle({ detail: { value: "在线模式提交" } });
  form.onDesc({ detail: { value: "写入本机缓存" } });
  form.onSubmitUpload();
  await settle();
  const uploadReq = seen.filter((r) => r.url.endsWith("/api/upload")).pop();
  assert.ok(uploadReq, "应发起 /api/upload 请求");
  assert.deepStrictEqual(uploadReq.data.which, homework.id);
  assert.strictEqual(uploadReq.data.title, "在线模式提交");
  assert.strictEqual(cache.bySubmission("SC-STU-DEMO-2026", homework.id).length, 1);

  const studentUploads = loadPage("pages/uploads/uploads");
  await settle();
  assert.strictEqual(studentUploads.data.sourceNote, stringsLocal("mp_local_hint"));
  assert.strictEqual(studentUploads.data.counts.all, 1);

  const detail = loadPage("pages/submission/submission", { id: homework.id });
  await settle();
  assert.strictEqual(detail.data.uploads.length, 1);
  assert.strictEqual(detail.data.uploads[0].title, "在线模式提交");

  // 在线模式下的权限错误透出
  const studentDownload = await mp("utils/api.js").download({
    auth: "SC-STU-DEMO-2026",
    which: homework.id,
  });
  assert.deepStrictEqual([studentDownload.ok, studentDownload.status], [false, 403]);

  config.save({ mode: "offline" });
  installWx();
}

function stringsLocal(key) {
  return require(path.join(MP, "utils/strings.js")).t(key);
}

// ---------------------------------------------------------------------------
// 8. 运行
// ---------------------------------------------------------------------------

async function main() {
  installWx();
  installGlobals();

  const pageCount = checkStructure();
  console.log(`✓ 结构检查：${pageCount} 个页面`);

  checkWxml();
  console.log("✓ WXML：标签配对与自闭合检查通过");

  const keyCount = checkStrings();
  console.log(`✓ 文案：${keyCount} 个 key 全部存在，WXML 引用字段齐全`);

  testUtils();
  console.log("✓ utils：时间 / 问卷 / 答题卡 / MatchMode / 附件");

  await testMockApi();
  console.log("✓ 离线 /api：11 个接口的字段、权限与错误信息");

  await testOnlineRequests();
  console.log("✓ 在线模式：请求 URL / 方法 / 请求体与响应解析");

  await testPages();
  console.log("✓ 页面流程（离线）：登录 / 首页 / 征集 / 提交 / 回复 / 答题卡 / 账号中心 / 设置");

  await testOnlinePages();
  console.log("✓ 页面流程（在线）：请求发往 /api，学生端读本机缓存，权限错误正确透出");

  console.log("\n全部通过 ✅");
}

main().catch((err) => {
  console.error("\n测试失败 ❌");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
