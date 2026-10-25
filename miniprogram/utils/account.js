/* 本地账号（对应服务端 /user 账号中心）。
 *
 * 服务端的账号中心使用 HttpOnly cookie 会话 + 同源表单 POST（`/user/*`），微信小程序
 * 无法复用这套会话，因此小程序把「账号 / 偏好 / 绑定关系」放在本地存储里；真正作用于
 * 班级数据的操作（创建班级、生成成员密钥、改名、删除密钥/对象）仍然调用 `/api`
 * ——也就是仍然保持与 Rust 服务同构。
 *
 * 演示账号与 README 一致：admin/admin123、teacher/teacher123、student/student123。 */
var storage = require("./storage");

var KEY = "sc.mp.account.v1";
var VERSION = 1;

function hashPassword(salt, password) {
  // 仅用于本地演示：加盐后多轮 FNV-1a，不用于任何真实凭据。
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

function validUsername(name) {
  var chars = Array.from(String(name || ""));
  if (chars.length < 2 || chars.length > 32) return false;
  return /^[\p{L}\p{N}_-]+$/u.test(chars.join(""));
}

function login(username, password) {
  var db = load();
  var user = findUserByUsername(db, username);
  if (!user) return { ok: false, key: "flash_wrong_credentials" };
  if (hashPassword(user.salt, password) !== user.hash) {
    return { ok: false, key: "flash_wrong_credentials" };
  }
  db.currentUserId = user.id;
  save(db);
  return { ok: true, user: user };
}

function register(username, password, password2, key) {
  var name = String(username || "").trim();
  if (!validUsername(name)) return { ok: false, key: "flash_username_invalid" };
  if (Array.from(String(password || "")).length < 6) {
    return { ok: false, key: "flash_password_min" };
  }
  if (password !== password2) return { ok: false, key: "flash_password_mismatch" };
  var db = load();
  if (findUserByUsername(db, name)) return { ok: false, key: "flash_username_taken" };
  var salt = newSalt();
  var user = {
    id: db.nextUserId++,
    username: name,
    salt: salt,
    hash: hashPassword(salt, password),
    displayName: name,
    prefs: { theme: "system", view: "student" },
    bindings: [],
  };
  if (key) {
    user.bindings.push({
      id: "bd_" + user.id + "_0",
      key: String(key).trim(),
      role: "student",
      label: String(key).trim(),
      createdAt: Math.floor(Date.now() / 1000),
    });
  }
  db.users.push(user);
  db.currentUserId = user.id;
  save(db);
  return { ok: true, user: user };
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

function changePassword(oldPassword, newPassword, newPassword2) {
  var db = load();
  var user = findUserById(db, db.currentUserId);
  if (!user) return { ok: false, key: "flash_need_login" };
  if (hashPassword(user.salt, oldPassword) !== user.hash) {
    return { ok: false, key: "flash_current_password_wrong" };
  }
  if (Array.from(String(newPassword || "")).length < 6) {
    return { ok: false, key: "flash_password_min" };
  }
  if (newPassword !== newPassword2) return { ok: false, key: "flash_password_mismatch" };
  user.salt = newSalt();
  user.hash = hashPassword(user.salt, newPassword);
  save(db);
  return { ok: true };
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
};
