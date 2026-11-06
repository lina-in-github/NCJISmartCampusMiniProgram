/* 账号（对应 web 端 /user 账号中心）。
 *
 * v0.1.7 起服务端改为**非对称挑战登录**：密码只在本机通过 PBKDF2 派生 X25519 私钥，
 * 注册 / 改密只上传公钥；登录时解密服务端下发的挑战。小程序无法复用浏览器的
 * HttpOnly cookie 会话，但可以完整复用这套 `/api/login-try` → `/api/get-auths` 协议：
 *
 *   在线模式：请求真实 Rust 服务；
 *   离线模式：utils/mock 用同一套密码学与接口契约在本机应答。
 *
 * 账号的偏好（主题 / 学生视角）与「进入哪个身份」仍保存在本机；班级数据操作
 * （创建班级、生成成员密钥、改名、删除密钥/对象）继续走 `/api`。
 * 旧版本留下的纯本机账号（只有加盐哈希）在离线模式下仍可用密码登录一次。
 */
var storage = require("./storage");
var config = require("./config");
var api = require("./api");
var authcrypto = require("./authcrypto");

var KEY = "sc.mp.account.v1";
var VERSION = 1;

function hashPassword(salt, password) {
  // 仅用于 v0.1.7 之前的本机账号兜底，不再用于新账号。
  // 加盐后多轮 FNV-1a，不用于任何真实凭据。
  var seed = String(salt) + ":" + String(password);
  var h = 2166136261;
  for (var round = 0; round < 2000; round++) {
    for (var i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i) + round;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h.toString(16);
}

function newSalt() {
  return Math.random().toString(36).slice(2, 10);
}

function seed() {
  function user(id, username, password, displayName, bindings) {
    var salt = newSalt();
    return {
      id: id,
      username: username,
      salt: salt,
      hash: hashPassword(salt, password),
      displayName: displayName,
      prefs: { theme: "system", view: "student" },
      bindings: bindings.map(function (b, idx) {
        return {
          id: "bd_" + id + "_" + idx,
          key: b.key,
          role: b.role,
          label: b.label,
          createdAt: Math.floor(Date.now() / 1000),
        };
      }),
    };
  }
  return {
    version: VERSION,
    nextUserId: 4,
    currentUserId: null,
    users: [
      user(1, "admin", "admin123", "赵明远", [
        { key: "SC-ADM-DEMO-2026", role: "admin", label: "高一（3）班 · 赵明远" },
        { key: "SC-ADM-DEMO-2027", role: "admin", label: "高二（1）班 · 赵明远" },
      ]),
      user(2, "teacher", "teacher123", "林书言", [
        { key: "SC-TEA-DEMO-2026", role: "teacher", label: "高一（3）班 · 林书言" },
      ]),
      user(3, "student", "student123", "陈小满", [
        { key: "SC-STU-DEMO-2026", role: "student", label: "高一（3）班 · 陈小满" },
      ]),
    ],
  };
}

function load() {
  var db = storage.readJson(KEY, null);
  if (!db || db.version !== VERSION || !Array.isArray(db.users)) {
    db = seed();
    storage.writeJson(KEY, db);
  }
  return db;
}

function save(db) {
  storage.writeJson(KEY, db);
  return db;
}

function reset() {
  return save(seed());
}

function findUserByUsername(db, username) {
  var target = String(username || "").trim().toLowerCase();
  for (var i = 0; i < db.users.length; i++) {
    if (String(db.users[i].username).toLowerCase() === target) return db.users[i];
  }
  return null;
}

function findUserById(db, id) {
  if (!id) return null;
  for (var i = 0; i < db.users.length; i++) {
    if (db.users[i].id === id) return db.users[i];
  }
  return null;
}

function currentUser() {
  var db = load();
  return findUserById(db, db.currentUserId);
}

function prefs() {
  var user = currentUser();
  var p = user && user.prefs ? user.prefs : {};
  return {
    theme: p.theme === "light" || p.theme === "dark" ? p.theme : "system",
    view: p.view === "parent" ? "parent" : "student",
  };
}

var LETTER_RE = null;
try {
  // 与 Rust `char::is_alphanumeric` 对齐（Unicode 字母 / 数字）。
  LETTER_RE = new RegExp("^[\\p{L}\\p{N}_-]+$", "u");
} catch (e) {
  LETTER_RE = /^[A-Za-z0-9_\-\u00A0-\uFFFF]+$/;
}

function validUsername(name) {
  var chars = Array.from(String(name || ""));
  if (chars.length < 2 || chars.length > 32) return false;
  return LETTER_RE.test(chars.join(""));
}

// ---------------------------------------------------------------------------
// 挑战登录
// ---------------------------------------------------------------------------

function authError(key) {
  var err = new Error(key);
  err.key = key;
  return err;
}

/** 把 `/api/*` 的英文错误映射成 `strings` 里的提示 key。 */
function apiErrorKey(res) {
  var msg = String((res && res.msg) || "");
  var status = res && res.status;
  if (!res) return "flash_request_failed";
  if (status === 0) return "flash_network_error";
  if (status === 401) {
    if (res.code === "pubkey_missing") return "flash_pubkey_missing";
    if (msg.indexOf("expired login session") >= 0) return "flash_login_expired";
    return "flash_wrong_credentials";
  }
  if (status === 400) {
    if (res.code === "username_taken" || msg.indexOf("username already exists") >= 0) {
      return "flash_username_taken";
    }
    if (msg.indexOf("already bound") >= 0) return "flash_key_bound";
    if (msg.indexOf("invalid key") >= 0) return "flash_key_invalid";
    if (msg.indexOf("public key") >= 0 || msg.indexOf("base64") >= 0) return "flash_pubkey_invalid";
    return "flash_request_failed";
  }
  if (status >= 500) return "flash_server_error";
  return "flash_request_failed";
}

function deriveKey(password, salt, iterations) {
  try {
    return authcrypto.derivePrivateKey(password, salt, iterations || authcrypto.KDF_ITERATIONS);
  } catch (e) {
    throw authError("flash_crypto_unsupported");
  }
}

/** `/api/login-try` → 解密挑战 → `/api/get-auths`；返回 `{user, members, auths}`。 */
function performLogin(username, password, precomputedPrivate) {
  return Promise.resolve()
    .then(function () {
      return api.loginTry({ username: username });
    })
    .then(function (info) {
      if (info.ok) return info;
      if (info.code !== "pubkey_missing") throw authError(apiErrorKey(info));
      // 旧库账号：先用旧密码做一次公钥迁移，再重新拿挑战。
      var legacyPrivate = deriveKey(password, authcrypto.defaultSalt(username));
      var pubkey = authcrypto.b64encode(authcrypto.publicKey(legacyPrivate));
      return api
        .upgradePubkey({
          username: username,
          password: password,
          pubkey: pubkey,
        })
        .then(function (upgraded) {
          // 400 表示另一个客户端已经迁移完成，继续登录即可。
          if (!upgraded.ok && upgraded.status !== 400) throw authError(apiErrorKey(upgraded));
          return api.loginTry({ username: username });
        })
        .then(function (retry) {
          if (!retry.ok) throw authError(apiErrorKey(retry));
          return retry;
        });
    })
    .then(function (info) {
      var kdf = info.kdf || {};
      var salt = kdf.salt || authcrypto.defaultSalt(username);
      var iterations = kdf.iterations || authcrypto.KDF_ITERATIONS;
      var privateBytes = precomputedPrivate || deriveKey(password, salt, iterations);
      var challenge;
      try {
        challenge = authcrypto.decryptChallenge(privateBytes, info.challengeEncrypt);
      } catch (e) {
        if (e && e.message === "WRONG_PASSWORD") throw authError("flash_wrong_credentials");
        throw authError("flash_login_challenge_error");
      }
      return authcrypto
        .encryptAnswer(info.answerEncryptingKey, challenge)
        .then(function (encryptedAnswer) {
          return api.getAuths({
            loginSessionID: info.loginSessionID,
            encryptedAnswer: encryptedAnswer,
          });
        })
        .then(function (result) {
          if (!result.ok) throw authError(apiErrorKey(result));
          return { info: info, result: result };
        });
    });
}

function memberLabel(member) {
  var className = String(member.className || "").trim();
  var name = String(member.displayName || "").trim();
  if (className && name) return className + " · " + name;
  return name || String(member.key || "");
}

/** 合并服务端返回的 members 与本机已有的绑定（保留服务端没有的本机绑定）。 */
function mergeBindings(existing, members) {
  var out = [];
  (members || []).forEach(function (m) {
    out.push({
      id: m.id || "bd_" + String(m.key || ""),
      key: String(m.key || ""),
      role: m.role || "student",
      label: memberLabel(m),
      classID: m.classID || "",
      className: m.className || "",
      studentID: m.studentID || "",
      shortStudentID: m.shortStudentID || 0,
      createdAt: Math.floor(Date.now() / 1000),
    });
  });
  (existing || []).forEach(function (b) {
    var found = out.some(function (x) {
      return x.key === b.key;
    });
    if (!found) out.push(b);
  });
  return out;
}

function applyLogin(db, existing, fallbackName, outcome) {
  var result = outcome.result;
  var user = existing;
  if (!user) {
    user = {
      id: db.nextUserId++,
      username: fallbackName,
      displayName: fallbackName,
      prefs: { theme: "system", view: "student" },
      bindings: [],
    };
    db.users.push(user);
  }
  var infoUser = result.user || {};
  user.username = infoUser.username || user.username;
  user.displayName = infoUser.displayName || user.displayName || user.username;
  user.source = "server";
  // 新流程不再在本机保存任何密码材料；旧字段清空，登录只依赖本机私钥派生。
  user.salt = "";
  user.hash = "";
  user.bindings = mergeBindings(user.bindings, result.members);
  db.currentUserId = user.id;
  return user;
}

/**
 * 账号登录。返回 `{ok,user}` 或 `{ok:false,key}`；不会把密码写到任何地方。
 */
function login(username, password) {
  var name = String(username || "").trim();
  if (!name || !password) {
    return Promise.resolve({ ok: false, key: "flash_enter_username_password" });
  }
  var db = load();
  var existing = findUserByUsername(db, name);
  return performLogin(name, password)
    .then(function (outcome) {
      var user = applyLogin(db, existing, name, outcome);
      save(db);
      return { ok: true, user: user };
    })
    .catch(function (err) {
      var key = err && err.key ? err.key : "flash_request_failed";
      // 旧版本地账号（不在服务端 / 离线 mock 里）允许继续用本机口令登录。
      if (
        key === "flash_wrong_credentials" &&
        !config.isOnline() &&
        existing &&
        existing.salt &&
        existing.hash &&
        hashPassword(existing.salt, password) === existing.hash
      ) {
        db.currentUserId = existing.id;
        save(db);
        return { ok: true, user: existing, legacy: true };
      }
      return { ok: false, key: key };
    });
}

/**
 * 注册账号：本机派生公钥后调用 `/api/register`，再走一次挑战登录拿到绑定身份。
 * 返回 `{ok,user}` 或 `{ok:false,key}`。
 */
function register(username, password, password2, key) {
  var name = String(username || "").trim();
  if (!validUsername(name)) return Promise.resolve({ ok: false, key: "flash_username_invalid" });
  if (Array.from(String(password || "")).length < 6) {
    return Promise.resolve({ ok: false, key: "flash_password_min" });
  }
  if (password !== password2) return Promise.resolve({ ok: false, key: "flash_password_mismatch" });
  var trimmedKey = String(key || "").trim();
  var privateBytes;
  try {
    privateBytes = deriveKey(password, authcrypto.defaultSalt(name));
  } catch (err) {
    return Promise.resolve({ ok: false, key: err.key || "flash_crypto_unsupported" });
  }
  var pubkey = authcrypto.b64encode(authcrypto.publicKey(privateBytes));
  var db = load();
  var existing = findUserByUsername(db, name);
  var created = null;
  return api
    .registerAccount({
      username: name,
      passwordPubKey: pubkey,
      displayName: name,
      key: trimmedKey || undefined,
    })
    .then(function (res) {
      if (!res.ok) throw authError(apiErrorKey(res));
      created = res;
      return performLogin(name, password, privateBytes);
    })
    .then(function (outcome) {
      var user = applyLogin(db, existing, name, outcome);
      user.source = "server";
      save(db);
      return { ok: true, user: user, boundAuth: created.boundAuth || null };
    })
    .catch(function (err) {
      return { ok: false, key: err && err.key ? err.key : "flash_request_failed" };
    });
}

/** 修改密码：验证旧密码的挑战，再用新密码派生的公钥替换服务端公钥。 */
function changePassword(oldPassword, newPassword, newPassword2) {
  var user = currentUser();
  if (!user) return Promise.resolve({ ok: false, key: "flash_need_login" });
  if (Array.from(String(newPassword || "")).length < 6) {
    return Promise.resolve({ ok: false, key: "flash_password_min" });
  }
  if (newPassword !== newPassword2) {
    return Promise.resolve({ ok: false, key: "flash_password_mismatch" });
  }
  var db = load();
  // 旧版本机账号：没有服务端记录，继续在本机更新加盐哈希。
  if (user.hash && user.salt && user.source !== "server") {
    if (hashPassword(user.salt, oldPassword) !== user.hash) {
      return Promise.resolve({ ok: false, key: "flash_current_password_wrong" });
    }
    user.salt = newSalt();
    user.hash = hashPassword(user.salt, newPassword);
    save(db);
    return Promise.resolve({ ok: true });
  }
  var infoRef = null;
  var privateBytes = null;
  return api
    .loginTry({ username: user.username })
    .then(function (info) {
      if (!info.ok) throw authError(apiErrorKey(info));
      infoRef = info;
      var kdf = info.kdf || {};
      var salt = kdf.salt || authcrypto.defaultSalt(user.username);
      var iterations = kdf.iterations || authcrypto.KDF_ITERATIONS;
      privateBytes = deriveKey(oldPassword, salt, iterations);
      var challenge;
      try {
        challenge = authcrypto.decryptChallenge(privateBytes, info.challengeEncrypt);
      } catch (e) {
        throw authError(
          e && e.message === "WRONG_PASSWORD" ? "flash_current_password_wrong" : "flash_login_challenge_error"
        );
      }
      return authcrypto.encryptAnswer(info.answerEncryptingKey, challenge);
    })
    .then(function (encryptedAnswer) {
      var kdf = infoRef.kdf || {};
      var salt = kdf.salt || authcrypto.defaultSalt(user.username);
      var iterations = kdf.iterations || authcrypto.KDF_ITERATIONS;
      var newPrivate = deriveKey(newPassword, salt, iterations);
      return api.resetPassword({
        loginSessionID: infoRef.loginSessionID,
        encryptedAnswer: encryptedAnswer,
        newPasswordPubKey: authcrypto.b64encode(authcrypto.publicKey(newPrivate)),
      });
    })
    .then(function (res) {
      if (!res.ok) throw authError(apiErrorKey(res));
      save(db);
      return { ok: true };
    })
    .catch(function (err) {
      return { ok: false, key: err && err.key ? err.key : "flash_request_failed" };
    });
}

function refreshKeyErrorKey(res) {
  if (res && res.code === "auth_invalid") return "flash_refresh_key_invalid";
  if (res && res.status === 403) return "flash_refresh_key_forbidden";
  if (res && res.status === 401) {
    var msg = String(res.msg || "");
    if (msg.indexOf("session") >= 0 || msg.indexOf("expired") >= 0) {
      return "flash_login_challenge_expired";
    }
    return "flash_wrong_credentials";
  }
  if (res && res.status === 400) return "flash_refresh_key_invalid";
  return apiErrorKey(res);
}

/**
 * 轮换当前账号绑定的某个 auth 密钥。
 * 必须同时通过账号挑战（密码）与旧密钥校验；服务端会把历史数据迁到新 auth 并删除旧 auth。
 * 返回 `{ok,newAuth,oldKey}` 或 `{ok:false,key}`。
 */
function refreshKey(authKey, password) {
  var user = currentUser();
  if (!user) return Promise.resolve({ ok: false, key: "flash_need_login" });
  var target = String(authKey || "").trim();
  if (!target) return Promise.resolve({ ok: false, key: "flash_refresh_key_missing" });
  if (!password) return Promise.resolve({ ok: false, key: "flash_enter_password" });
  var db = load();
  var binding = findBinding(target);
  if (!binding) return Promise.resolve({ ok: false, key: "flash_refresh_key_missing" });
  var infoRef = null;
  return api
    .loginTry({ username: user.username })
    .then(function (info) {
      if (!info.ok) throw authError(apiErrorKey(info));
      infoRef = info;
      var kdf = info.kdf || {};
      var salt = kdf.salt || authcrypto.defaultSalt(user.username);
      var iterations = kdf.iterations || authcrypto.KDF_ITERATIONS;
      var privateBytes = deriveKey(password, salt, iterations);
      var challenge;
      try {
        challenge = authcrypto.decryptChallenge(privateBytes, info.challengeEncrypt);
      } catch (e) {
        throw authError(
          e && e.message === "WRONG_PASSWORD" ? "flash_wrong_credentials" : "flash_login_challenge_error"
        );
      }
      return authcrypto.encryptAnswer(info.answerEncryptingKey, challenge);
    })
    .then(function (encryptedAnswer) {
      return api.refreshKey({
        loginSessionID: infoRef.loginSessionID,
        encryptedAnswer: encryptedAnswer,
        authRefreshing: target,
      });
    })
    .then(function (res) {
      if (!res.ok) throw authError(refreshKeyErrorKey(res));
      var newAuth = String(res.newAuth || "").trim();
      if (!newAuth) throw authError("flash_refresh_key_invalid");
      var dbNow = load();
      var userNow = findUserById(dbNow, dbNow.currentUserId);
      if (userNow) {
        userNow.bindings.forEach(function (b) {
          if (b.key === target) b.key = newAuth;
        });
        save(dbNow);
      }
      return { ok: true, newAuth: newAuth, oldKey: target };
    })
    .catch(function (err) {
      return { ok: false, key: err && err.key ? err.key : "flash_request_failed" };
    });
}

function logout() {
  var db = load();
  db.currentUserId = null;
  save(db);
}

function bindings() {
  var user = currentUser();
  return user ? user.bindings.slice() : [];
}

function findBinding(key) {
  var target = String(key || "").trim();
  var list = bindings();
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === target) return list[i];
  }
  return null;
}

function bindKey(key, role, label) {
  var db = load();
  var user = findUserById(db, db.currentUserId);
  if (!user) return { ok: false, key: "flash_need_login" };
  var trimmed = String(key || "").trim();
  if (!trimmed) return { ok: false, key: "flash_enter_key" };
  var exists = user.bindings.some(function (b) {
    return b.key === trimmed;
  });
  if (exists) return { ok: false, key: "flash_already_bound" };
  user.bindings.push({
    id: "bd_" + user.id + "_" + Date.now().toString(36),
    key: trimmed,
    role: role || "student",
    label: label || trimmed,
    createdAt: Math.floor(Date.now() / 1000),
  });
  save(db);
  return { ok: true };
}

function unbind(key) {
  var db = load();
  var user = findUserById(db, db.currentUserId);
  if (!user) return { ok: false, key: "flash_need_login" };
  var before = user.bindings.length;
  user.bindings = user.bindings.filter(function (b) {
    return b.key !== String(key || "").trim();
  });
  save(db);
  return { ok: user.bindings.length !== before, key: "flash_identity_deleted" };
}

function renameBinding(key, label) {
  var db = load();
  var user = findUserById(db, db.currentUserId);
  if (!user) return { ok: false, key: "flash_need_login" };
  var target = String(key || "").trim();
  user.bindings.forEach(function (b) {
    if (b.key === target) b.label = String(label || "").trim() || b.label;
  });
  save(db);
  return { ok: true };
}

function savePrefs(partial) {
  var db = load();
  var user = findUserById(db, db.currentUserId);
  if (!user) return { ok: false, key: "flash_need_login" };
  var next = user.prefs || { theme: "system", view: "student" };
  if (partial.displayName !== undefined) {
    var display = String(partial.displayName || "").trim();
    if (Array.from(display).length > 40) return { ok: false, key: "flash_display_name_too_long" };
    user.displayName = display || user.username;
  }
  if (partial.theme !== undefined) {
    next.theme = ["light", "dark", "system"].indexOf(partial.theme) >= 0 ? partial.theme : "system";
  }
  if (partial.view !== undefined) {
    next.view = partial.view === "parent" ? "parent" : "student";
  }
  user.prefs = next;
  save(db);
  return { ok: true, prefs: prefs() };
}

module.exports = {
  KEY: KEY,
  hashPassword: hashPassword,
  load: load,
  reset: reset,
  currentUser: currentUser,
  prefs: prefs,
  validUsername: validUsername,
  login: login,
  register: register,
  logout: logout,
  bindings: bindings,
  findBinding: findBinding,
  bindKey: bindKey,
  unbind: unbind,
  renameBinding: renameBinding,
  savePrefs: savePrefs,
  changePassword: changePassword,
  refreshKey: refreshKey,
};
