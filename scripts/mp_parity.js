#!/usr/bin/env node
/* 离线模拟 vs 真实 Rust 服务：同一批请求的响应逐字段对比。
 *
 * 用法（先启动后端）：
 *   SC_DB=/tmp/parity.db cargo run &          # 或用 scripts/smoke.sh 里的方式起临时服务
 *   SC_BASE=http://127.0.0.1:3000 node scripts/mp_parity.js
 *
 * 脚本会：
 *   1. 在两侧准备同一份逻辑数据（缺的演示征集用 /api/new-submission 补齐）；
 *   2. 依次执行同一串请求：真实服务用 HTTP，离线模拟用 utils/mock；
 *   3. 归一化 ID / 时间 / 密钥 / 学号后逐字段比较响应体与 HTTP 状态码。
 * 任何差异（字段、顺序、错误文案、状态码）都会打印出来并以非 0 退出。 */
"use strict";

const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const MP = path.join(ROOT, "miniprogram");
const BASE = (process.env.SC_BASE || "http://127.0.0.1:3999").replace(/\/+$/, "");

const mock = require(path.join(MP, "utils/mock/index.js"));
const time = require(path.join(MP, "utils/time.js"));

const ADMIN = "SC-ADM-DEMO-2026";
const TEACHER = "SC-TEA-DEMO-2026";
const STUDENT = "SC-STU-DEMO-2026";
const STUDENT2 = "SC-STU-DEMO-2026-02";

// ---------------------------------------------------------------------------
// 两侧调用
// ---------------------------------------------------------------------------

async function realCall(endpoint, body) {
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { ok: false, msg: `non-json response: ${text.slice(0, 80)}` };
  }
  data.status = res.status;
  return data;
}

function mockCall(endpoint, body) {
  return mock.handle(endpoint, JSON.parse(JSON.stringify(body)));
}

const sides = {
  real: realCall,
  mock: mockCall,
};

// ---------------------------------------------------------------------------
// 归一化：把随机 ID / 时间 / 密钥 / 学号替换成占位符
// ---------------------------------------------------------------------------

const ID_RE = /^(sub|up|rep|cls|auth)_[a-z0-9]+$/;
const KEY_RE = /^SC-[A-Z]{3}-[A-Z0-9-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const STUDENT_ID_RE = /^C[A-Z0-9]{5}-\d{2}$/;

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    // 附件对象：{name, mime, data} 的素材内容不参与比较（演示素材差异）
    if (typeof value.data === "string" && (value.mime || /^data:/.test(value.data))) {
      return { name: "<attachment>", mime: "<mime>", data: "<base64>" };
    }
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        out[key] = normalize(value[key]);
      });
    return out;
  }
  if (typeof value === "string") {
    if (ID_RE.test(value)) return value.replace(ID_RE, "<$1>");
    if (KEY_RE.test(value)) return "<key>";
    if (ISO_RE.test(value)) return "<iso>";
    if (STUDENT_ID_RE.test(value)) return "<studentID>";
    // 正则错误信息里的引擎细节（Rust regex / JS RegExp）不参与比较
    if (/^invalid regular expression: [\s\S]*$/.test(value)) return "invalid regular expression: <detail>";
    // 演示附件素材不同（服务端是 SVG，离线端是便于微信预览的 PNG），只比较结构
    if (/^data:[^,]+,/.test(value)) return "<dataurl>";
    return value;
  }
  return value;
}

function pickNormalized(res) {
  const out = {};
  Object.keys(res).forEach((key) => {
    if (key === "time" || key === "service") return; // health 的时间戳/服务名单独处理
    // 框架层 422（JSON 反序列化失败）的文案由 axum 生成，措辞不参与比较
    if (res.status === 422 && key === "msg") {
      out[key] = "<422>";
      return;
    }
    out[key] = res[key];
  });
  return normalize(out);
}

// ---------------------------------------------------------------------------
// 用例定义（两侧执行同一份）
// ---------------------------------------------------------------------------

function fixtures() {
  // 离线模拟的种子数据额外带了公示、问卷、答题卡，真实服务侧按同样参数补齐
  const now = time.now();
  return [
    {
      name: "本周校历与作息调整公示",
      desc: "10 月 28 日起启用冬季作息：上午 8:00 上课，下午 17:10 放学；周五第七节调整为社团活动。",
      type: "notice",
      deadLine: null,
    },
    {
      name: "秋季社团报名问卷",
      desc:
        '姓名：<input id="form_name" required/>\n想参加的社团：<checkbox id="form_club" value="math"/>数学社 <checkbox id="form_club" value="art"/>美术社\n接收通知：<switch id="form_notify"/>',
      type: "survey",
      deadLine: time.fmtDateTimeLocal(now + 5 * 86400),
    },
    {
      name: "导数小测答题卡",
      desc:
        '1 + 1 = <input id="form_q1" data-answer="2" data-score="5"/>\n选出正确答案：<checkbox id="form_q2" value="a" data-answer="b" data-score="3"/>A <checkbox id="form_q2" value="b"/>B\n地球是圆的：<switch id="form_q3" data-answer="on" data-score="2"/>',
      type: "answer sheet",
      deadLine: time.fmtDateTimeLocal(now + 3 * 86400),
    },
  ];
}

async function prepareFixtures(call) {
  const res = await call("all-submission", { auth: TEACHER });
  assert.strictEqual(res.ok, true, "准备数据：all-submission 失败");
  const names = res.datas.map((s) => s.name);
  for (const fixture of fixtures()) {
    if (names.includes(fixture.name)) continue;
    const created = await call("new-submission", {
      auth: TEACHER,
      name: fixture.name,
      desc: fixture.desc,
      type: fixture.type,
      deadLine: fixture.deadLine,
    });
    assert.strictEqual(created.ok, true, `准备数据：创建「${fixture.name}」失败 ${created.msg || ""}`);
  }
}

async function resolveIds(call) {
  const res = await call("all-submission", { auth: TEACHER });
  const byName = (part) => {
    const row = res.datas.find((s) => s.name.indexOf(part) >= 0);
    assert(row, `找不到征集「${part}」`);
    return row.id;
  };
  return {
    homework: byName("函数与导数"),
    sports: byName("秋季运动会"),
    notice: byName("校历"),
    survey: byName("社团报名"),
    sheet: byName("答题卡"),
    otherClass: null,
  };
}

function cases(ids) {
  const longTitle = "标".repeat(201);
  const longName = "名".repeat(201);
  return [
    // ---- 读 ----
    ["all-submission / 老师视角", "all-submission", { auth: TEACHER }],
    ["all-submission / 学生视角", "all-submission", { auth: STUDENT }],
    ["all-submission / TitleReGex", "all-submission", { auth: TEACHER, match_mode: { TitleReGex: "^函数" } }],
    ["all-submission / StudentID", "all-submission", { auth: TEACHER, match_mode: { StudentID: "G2603-01" } }],
    ["all-submission / ShortStudentID", "all-submission", { auth: TEACHER, match_mode: { ShortStudentID: 2 } }],
    ["all-submission / Before 相对时长", "all-submission", { auth: TEACHER, match_mode: { Before: "1d" } }],
    ["all-submission / 非法正则", "all-submission", { auth: TEACHER, match_mode: { TitleReGex: "[" } }],
    ["all-submission / 非法 match_mode", "all-submission", { auth: TEACHER, match_mode: 42 }],
    ["download / All", "download", { auth: TEACHER, which: ids.homework }],
    ["download / TitleReGex", "download", { auth: TEACHER, which: ids.homework, match_mode: { TitleReGex: "^周末" } }],
    ["download / StudentID", "download", { auth: TEACHER, which: ids.homework, match_mode: { StudentID: "G2603-03" } }],
    ["download / ShortStudentID", "download", { auth: TEACHER, which: ids.homework, match_mode: { ShortStudentID: 1 } }],
    ["download / Before", "download", { auth: TEACHER, which: ids.homework, match_mode: { Before: "1h" } }],
    ["download / 学生越权", "download", { auth: STUDENT, which: ids.homework }],
    ["download / 征集不存在", "download", { auth: TEACHER, which: "sub_doesnotexist" }],
    // ---- 鉴权 ----
    ["upload / 缺少密钥", "upload", { which: ids.homework, title: "x" }],
    ["upload / 空密钥", "upload", { auth: "", which: ids.homework, title: "x" }],
    ["upload / 无效密钥", "upload", { auth: "SC-STU-NOPE-0000", which: ids.homework, title: "x" }],
    // ---- 上传校验 ----
    ["upload / 空标题", "upload", { auth: STUDENT, which: ids.homework, title: "   " }],
    ["upload / 标题过长", "upload", { auth: STUDENT, which: ids.homework, title: longTitle }],
    ["upload / 非法附件", "upload", { auth: STUDENT, which: ids.homework, title: "x", data: ["not base64 !!!"] }],
    ["upload / 附件不是数组", "upload", { auth: STUDENT, which: ids.homework, title: "x", data: "nope" }],
    ["upload / 公示版禁止提交", "upload", { auth: STUDENT, which: ids.notice, title: "x" }],
    ["upload / 问卷缺必填", "upload", { auth: STUDENT, which: ids.survey, title: "bot-upload", desc: '{"form_club":"math"}' }],
    ["upload / 问卷非 JSON 仍可提交", "upload", { auth: STUDENT, which: ids.survey, title: "随笔", desc: "普通文字说明" }],
    ["upload / 问卷 bot 提交", "upload", {
      auth: STUDENT,
      which: ids.survey,
      title: "bot-upload",
      desc: '{"form_name":"陈小满","form_club":"math,art","form_notify":"on"}',
      data: [],
    }],
    ["upload / 普通提交（附件对象）", "upload", {
      auth: STUDENT,
      which: ids.homework,
      title: "对比测试提交",
      desc: "来自 mp_parity",
      data: [{ name: "hello.txt", mime: "text/plain", data: "aGVsbG8=" }],
    }],
    // ---- 回复 ----
    ["reply / 学生越权", "reply", { auth: STUDENT, uploadID: "up_doesnotexist", content: "x" }],
    ["reply / 空内容", "reply", { auth: TEACHER, uploadID: "up_doesnotexist", content: "  " }],
    ["reply / 提交不存在", "reply", { auth: TEACHER, uploadID: "up_doesnotexist", content: "x" }],
    // ---- 发布征集 ----
    ["new-submission / 学生越权", "new-submission", { auth: STUDENT, name: "x" }],
    ["new-submission / 空名称", "new-submission", { auth: TEACHER, name: " " }],
    ["new-submission / 名称过长", "new-submission", { auth: TEACHER, name: longName }],
    ["new-submission / 非法截止时间", "new-submission", { auth: TEACHER, name: "x", deadLine: "not-a-date" }],
    ["new-submission / 答题卡缺 data-answer", "new-submission", {
      auth: TEACHER,
      name: "坏答题卡",
      type: "answer sheet",
      desc: '<input id="form_q1" data-score="5"/>',
    }],
    ["new-submission / 答题卡无题目", "new-submission", { auth: TEACHER, name: "空答题卡", type: "answer sheet", desc: "没有题目" }],
    ["new-submission / 正常发布", "new-submission", {
      auth: TEACHER,
      name: "对比测试征集",
      desc: "来自 mp_parity",
      type: "homework",
      deadLine: "2027-06-01T20:00",
    }],
    // ---- 班级 / 成员 ----
    ["new-class / 老师越权", "new-class", { auth: TEACHER, desc: "x" }],
    ["new-class / 空参数", "new-class", { auth: ADMIN, name: "", desc: "" }],
    ["new-user / 跨班级", "new-user", { auth: ADMIN, classID: "cls_otherclass", quantity: 1, type: "Student" }],
    ["new-user / 数量越界", "new-user", { auth: ADMIN, classID: "cls_otherclass", quantity: 0, type: "Student" }],
    ["new-user / 非法类型", "new-user", { auth: ADMIN, classID: "cls_otherclass", quantity: 1, type: "Parent" }],
    // ---- 改名 ----
    ["rename-auth / 空名称", "rename-auth", { auth: TEACHER, name: "  " }],
    ["rename-auth / 名称过长", "rename-auth", { auth: TEACHER, name: "字".repeat(41) }],
    ["rename-auth / 成功", "rename-auth", { auth: TEACHER, name: "林老师" }],
    ["all-submission / 改名后快照刷新", "all-submission", { auth: TEACHER }],
    // ---- 删除 ----
    ["del-object / 无密钥", "del-object", { id: "sub_x" }],
    ["del-object / 老师越权", "del-object", { auth: TEACHER, id: "sub_x" }],
    ["del-object / 对象不存在", "del-object", { auth: ADMIN, id: "sub_doesnotexist" }],
    ["del-object / 不支持的类型", "del-object", { auth: ADMIN, id: "zzz_123" }],
    // ---- 密钥 ----
    ["del-key / 无效密钥", "del-key", { auth: "SC-STU-NOPE-0000" }],
  ];
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

async function runSide(name, call) {
  await prepareFixtures(call);
  const ids = await resolveIds(call);
  const results = [];
  for (const [label, endpoint, body] of cases(ids)) {
    const res = await call(endpoint, body);
    results.push({ label, endpoint, res });
  }
  return { name, ids, results };
}

function diff(a, b, pathStr, out) {
  if (a === b) return;
  if (typeof a !== typeof b || a === null || b === null) {
    out.push(`${pathStr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return;
  }
  if (typeof a !== "object") {
    out.push(`${pathStr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${pathStr}: 数组/对象类型不一致`);
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${pathStr}.length: ${a.length} !== ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${pathStr}[${i}]`, out);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.forEach((key) => {
    if (!(key in a)) out.push(`${pathStr}.${key}: 真实服务缺失`);
    else if (!(key in b)) out.push(`${pathStr}.${key}: 离线模拟缺失`);
    else diff(a[key], b[key], `${pathStr}.${key}`, out);
  });
}

async function main() {
  let reachable = false;
  try {
    const res = await fetch(`${BASE}/api/health`);
    const data = await res.json();
    reachable = data && data.ok === true;
  } catch (e) {
    reachable = false;
  }
  if (!reachable) {
    console.error(`无法连接 ${BASE}/api/health —— 请先启动后端，例如：`);
    console.error("  SC_DB=/tmp/parity.db SC_BIND=127.0.0.1:4000 cargo run &");
    console.error("  SC_BASE=http://127.0.0.1:4000 node scripts/mp_parity.js");
    process.exit(2);
  }

  mock.reset();
  const real = await runSide("real", realCall);
  mock.reset();
  const offline = await runSide("mock", mockCall);

  assert.strictEqual(real.results.length, offline.results.length);
  let failures = 0;
  for (let i = 0; i < real.results.length; i++) {
    const a = real.results[i];
    const b = offline.results[i];
    const out = [];
    if (a.res.status !== b.res.status) out.push(`status: ${a.res.status} !== ${b.res.status}`);
    diff(pickNormalized(a.res), pickNormalized(b.res), "body", out);
    if (out.length) {
      failures += 1;
      console.error(`\n✗ ${a.label}  (/api/${a.endpoint})`);
      out.slice(0, 12).forEach((line) => console.error(`    ${line}`));
    } else {
      console.log(`✓ ${a.label}`);
    }
  }

  if (failures) {
    console.error(`\n${failures} 个用例不一致 ❌`);
    process.exit(1);
  }
  console.log(`\n${real.results.length} 个用例全部一致：离线模拟与真实 /api 同构 ✅`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
