use std::sync::{LockResult, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::tools::{
    b64_encode, hash_password, new_auth_key, new_class_code, new_id, now_ts, rand_string,
};
use crate::types::{
    AuthCtx, ClassModeRow, ModeFlags, ModeTab, Prefs, ReplyRow, SubmissionRow, UploadRow, UserCtx,
    ROLE_ADMIN, ROLE_STUDENT, ROLE_TEACHER,
};

pub const SCHEMA: &str = include_str!("schema.sql");

pub const DEMO_ADMIN_KEY: &str = "SC-ADM-DEMO-2026";
pub const DEMO_TEACHER_KEY: &str = "SC-TEA-DEMO-2026";
pub const DEMO_STUDENT_KEY: &str = "SC-STU-DEMO-2026";
pub const DEMO_STUDENT2_KEY: &str = "SC-STU-DEMO-2026-02";
pub const DEMO_STUDENT3_KEY: &str = "SC-STU-DEMO-2026-03";
pub const DEMO_ADMIN2_KEY: &str = "SC-ADM-DEMO-2027";
pub const DEMO_TEACHER2_KEY: &str = "SC-TEA-DEMO-2027";
pub const DEMO_STUDENT_C2_KEY: &str = "SC-STU-DEMO-2027";

/// 演示账号公钥（X25519）。由 PBKDF2-HMAC-SHA256(密码, `smart-campus/auth/v1:<用户名>`)
/// 派生私钥后计算得到；密码本身不参与服务端校验。
pub const DEMO_ADMIN_PUBKEY: &str = "aJ2+2QZhfvj/e30rH+si+J3e8gIbllhrAryrw8ou5BY=";
pub const DEMO_TEACHER_PUBKEY: &str = "twPKqsL5RPHwLOWAbZw09o7CpwwoXCba+V0bJGkHMAw=";
pub const DEMO_STUDENT_PUBKEY: &str = "3zcMdg6sj9+9nhW6FO2LVc48RxItRNw/YkXvZEnofVE=";

/// 数据库句柄。所有 SQL 都封装在本模块中，其他模块只通过 db 函数访问。
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    pub fn lock(&self) -> LockResult<MutexGuard<'_, Connection>> {
        self.conn.lock()
    }
}

pub fn open(path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA synchronous=NORMAL;",
    )?;
    conn.execute_batch(SCHEMA)?;
    migrate(&conn)?;
    seed_if_empty(&conn)?;
    ensure_demo_pubkeys(&conn)?;
    Ok(conn)
}

/// 轻量迁移：为旧数据库补上新增列（`users.pubkey`、`submissions.base_type`、
/// `class_modes` 的显示名称与可见性属性）。
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    if !table_has_column(conn, "users", "pubkey")? {
        conn.execute_batch("ALTER TABLE users ADD COLUMN pubkey TEXT")?;
    }
    if !table_has_column(conn, "submissions", "base_type")? {
        conn.execute_batch("ALTER TABLE submissions ADD COLUMN base_type TEXT")?;
    }
    for column in ["hidden", "teacher_only", "admin_only", "invisible"] {
        if !table_has_column(conn, "submissions", column)? {
            conn.execute_batch(&format!(
                "ALTER TABLE submissions ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
            ))?;
        }
    }
    let class_mode_columns = [
        ("display_name", "TEXT NOT NULL DEFAULT ''"),
        ("hidden", "INTEGER NOT NULL DEFAULT 0"),
        ("teacher_only", "INTEGER NOT NULL DEFAULT 0"),
        ("admin_only", "INTEGER NOT NULL DEFAULT 0"),
        ("invisible", "INTEGER NOT NULL DEFAULT 0"),
        ("separate_list", "INTEGER NOT NULL DEFAULT 0"),
        ("abstract_mode", "INTEGER NOT NULL DEFAULT 0"),
    ];
    for (column, ddl) in class_mode_columns {
        if !table_has_column(conn, "class_modes", column)? {
            conn.execute_batch(&format!(
                "ALTER TABLE class_modes ADD COLUMN {column} {ddl}"
            ))?;
        }
    }
    Ok(())
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 为旧数据库中的演示账号补公钥（不覆盖用户已经设置的新公钥）。
fn ensure_demo_pubkeys(conn: &Connection) -> rusqlite::Result<()> {
    let demos = [
        ("admin", DEMO_ADMIN_PUBKEY),
        ("teacher", DEMO_TEACHER_PUBKEY),
        ("student", DEMO_STUDENT_PUBKEY),
    ];
    for (username, pubkey) in demos {
        conn.execute(
            "UPDATE users SET pubkey = ?1
             WHERE username = ?2 COLLATE NOCASE
               AND (pubkey IS NULL OR pubkey = '')",
            params![pubkey, username],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

const AUTH_SQL: &str = "SELECT a.id, a.key, a.class_id, c.name, c.desc, a.user_id, a.role,
                               a.student_id, a.short_id, a.display_name
                        FROM auths a JOIN classes c ON c.id = a.class_id";

fn auth_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AuthCtx> {
    Ok(AuthCtx {
        id: r.get(0)?,
        key: r.get(1)?,
        class_id: r.get(2)?,
        class_name: r.get(3)?,
        class_desc: r.get(4)?,
        user_id: r.get(5)?,
        role: r.get(6)?,
        student_id: r.get(7)?,
        short_id: r.get(8)?,
        display_name: r.get(9)?,
    })
}

pub fn load_auth_by_id(db: &Connection, id: &str) -> Option<AuthCtx> {
    db.query_row(
        &format!("{AUTH_SQL} WHERE a.id = ?1"),
        params![id],
        auth_from_row,
    )
    .optional()
    .ok()
    .flatten()
}

pub fn load_auth_by_key(db: &Connection, key: &str) -> Option<AuthCtx> {
    let key = key.trim();
    let found = db
        .query_row(
            &format!("{AUTH_SQL} WHERE a.key = ?1"),
            params![key],
            auth_from_row,
        )
        .optional()
        .ok()
        .flatten();
    if found.is_some() {
        return found;
    }
    let upper = key.to_uppercase();
    if upper != key {
        return db
            .query_row(
                &format!("{AUTH_SQL} WHERE a.key = ?1"),
                params![upper],
                auth_from_row,
            )
            .optional()
            .ok()
            .flatten();
    }
    None
}

pub fn auth_key_exists(db: &Connection, key: &str) -> bool {
    db.query_row("SELECT 1 FROM auths WHERE key = ?1", params![key], |_| {
        Ok(())
    })
    .optional()
    .ok()
    .flatten()
    .is_some()
}

pub fn load_user_by_id(db: &Connection, id: i64) -> Option<UserCtx> {
    db.query_row(
        "SELECT id, username, display_name, prefs FROM users WHERE id = ?1",
        params![id],
        |r| {
            Ok(UserCtx {
                id: r.get(0)?,
                username: r.get(1)?,
                display_name: r.get(2)?,
                prefs: Prefs::from_json(&r.get::<_, String>(3)?),
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

pub struct UserWithSecret {
    pub user: UserCtx,
    pub salt: String,
    pub pwhash: String,
}

/// 登录流程需要的用户公开信息。
#[derive(Clone, Debug)]
pub struct LoginUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub pubkey: Option<String>,
}

pub fn load_login_user(db: &Connection, username: &str) -> Option<LoginUser> {
    db.query_row(
        "SELECT id, username, display_name, pubkey
         FROM users WHERE username = ?1 COLLATE NOCASE",
        params![username.trim()],
        |r| {
            Ok(LoginUser {
                id: r.get(0)?,
                username: r.get(1)?,
                display_name: r.get(2)?,
                pubkey: r.get(3)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

pub fn load_user_with_secret(db: &Connection, username: &str) -> Option<UserWithSecret> {
    db.query_row(
        "SELECT id, username, display_name, prefs, salt, pwhash
         FROM users WHERE username = ?1 COLLATE NOCASE",
        params![username.trim()],
        |r| {
            Ok(UserWithSecret {
                user: UserCtx {
                    id: r.get(0)?,
                    username: r.get(1)?,
                    display_name: r.get(2)?,
                    prefs: Prefs::from_json(&r.get::<_, String>(3)?),
                },
                salt: r.get(4)?,
                pwhash: r.get(5)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

pub fn user_auths(db: &Connection, user_id: i64) -> Vec<AuthCtx> {
    let sql = format!(
        "{AUTH_SQL} WHERE a.user_id = ?1 ORDER BY c.name COLLATE NOCASE, a.role, a.short_id"
    );
    let mut stmt = match db.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![user_id], auth_from_row);
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn class_code(db: &Connection, class_id: &str) -> String {
    db.query_row(
        "SELECT code FROM classes WHERE id = ?1",
        params![class_id],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| "CLASS".to_string())
}

// ---------------------------------------------------------------------------
// 征集模式（内置模式 + 班级自定义模式）
// ---------------------------------------------------------------------------

/// 内置行为模式（规范化后的名称）。
pub const BUILTIN_BEHAVIOR_MODES: &[&str] = &[
    "homework",
    "open call",
    "leave request",
    "survey",
    "answer sheet",
    "notice",
    "other",
];

/// 全部内置模式：行为模式（可改变表单 / 校验行为）与可见性模式
/// （隐藏 / 仅教师 / 仅管理员 / 不显示 / 单独列出）。
/// 它们都可以直接用于征集或作为父模式被继承；`separate list` 是抽象模式。
pub const BUILTIN_MODES: &[&str] = &[
    "homework",
    "open call",
    "leave request",
    "survey",
    "answer sheet",
    "notice",
    "other",
    "hidden",
    "teacher only",
    "admin only",
    "invisible",
    "separate list",
];

/// 把模式名规范化：去首尾空白、小写、`_` / `-` 视为空格、折叠连续空白。
pub fn normalize_mode_name(raw: &str) -> String {
    raw.trim()
        .to_ascii_lowercase()
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 内置模式的规范名称（同时兼容若干别名，包括中文显示名称）。
pub fn builtin_mode(normalized: &str) -> Option<&'static str> {
    match normalized {
        "homework" => Some("homework"),
        "open call" | "opencall" => Some("open call"),
        "leave request" | "leaverequest" => Some("leave request"),
        "survey" => Some("survey"),
        "answer sheet" | "answersheet" | "sheet" => Some("answer sheet"),
        "notice" => Some("notice"),
        "other" => Some("other"),
        // 隐藏征集
        "hidden" | "hidden submission" | "hide" | "隐藏" | "隐藏征集" => Some("hidden"),
        // 仅教师征集
        "teacher only" | "teachers only" | "teacher" | "仅教师" | "仅教师征集" => {
            Some("teacher only")
        }
        // 仅管理员征集
        "admin only" | "admins only" | "administrator only" | "仅管理员" | "仅管理员征集" => {
            Some("admin only")
        }
        // 不显示征集
        "invisible" | "not listed" | "not shown" | "不显示" | "不显示征集" => {
            Some("invisible")
        }
        // 单独列出征集（抽象）
        "separate list" | "separate lists" | "listed separately" | "list separately"
        | "separately listed" | "单独列出" | "单独列出征集" => Some("separate list"),
        _ => None,
    }
}

fn builtin_mode_display_name(canonical: &str) -> String {
    let key = match canonical {
        "homework" => "type_homework",
        "open call" => "type_open_call",
        "leave request" => "type_leave_request",
        "survey" => "type_survey",
        "answer sheet" => "type_answer_sheet",
        "notice" => "type_notice",
        "other" => "type_other",
        "hidden" => "type_hidden",
        "teacher only" => "type_teacher_only",
        "admin only" => "type_admin_only",
        "invisible" => "type_invisible",
        "separate list" => "type_separate_list",
        _ => "type_generic",
    };
    crate::strings::t(key)
}

fn builtin_mode_flags(canonical: &str) -> ModeFlags {
    let mut flags = ModeFlags::default();
    match canonical {
        "hidden" => flags.hidden = true,
        "teacher only" => flags.teacher_only = true,
        "admin only" => flags.admin_only = true,
        "invisible" => flags.invisible = true,
        "separate list" => {
            flags.separate_list = true;
            flags.abstract_mode = true;
        }
        _ => {}
    }
    flags
}

fn builtin_mode_info(canonical: &str) -> ModeInfo {
    ModeInfo {
        id: format!("builtin_{}", canonical.replace(' ', "_")),
        name: canonical.to_string(),
        normalized: normalize_mode_name(canonical),
        display_name: builtin_mode_display_name(canonical),
        base_type: if BUILTIN_BEHAVIOR_MODES.contains(&canonical) {
            canonical.to_string()
        } else {
            "other".to_string()
        },
        extend_modes: Vec::new(),
        ancestors: vec![normalize_mode_name(canonical)],
        flags: builtin_mode_flags(canonical),
        builtin: true,
        created_at: 0,
    }
}

/// 一个已解析的征集模式。
#[derive(Clone, Debug)]
pub struct ModeInfo {
    pub id: String,
    /// 模式名（内置模式为规范英文名，自定义模式为创建时的名称）。
    pub name: String,
    /// 规范化名称。
    pub normalized: String,
    /// 展示名称（支持中文）；内置模式由 strings 本地化。
    pub display_name: String,
    /// 行为基类：`survey` / `answer sheet` / `notice` / `homework` 等。
    pub base_type: String,
    /// 直接继承的父模式（规范化名称）。
    pub extend_modes: Vec<String>,
    /// 继承链（含自身，规范化名称），用于「单独列出」分类过滤与菱形检测。
    pub ancestors: Vec<String>,
    /// 可见性 / 列表属性（含继承；抽象属性不继承）。
    pub flags: ModeFlags,
    /// 是否为内置模式。
    pub builtin: bool,
    pub created_at: i64,
}

impl ModeInfo {
    pub fn effective_display_name(&self) -> String {
        if self.display_name.trim().is_empty() {
            self.name.clone()
        } else {
            self.display_name.clone()
        }
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({
            "id": self.id,
            "name": self.name,
            "modeName": self.name,
            "displayName": self.effective_display_name(),
            "normalized": self.normalized,
            "baseType": self.base_type,
            "extendModes": self.extend_modes,
            "inheritModes": self.ancestors,
            "builtin": self.builtin,
            "hidden": self.flags.hidden,
            "teacherOnly": self.flags.teacher_only,
            "adminOnly": self.flags.admin_only,
            "invisible": self.flags.invisible,
            "separateList": self.flags.separate_list,
            "abstract": self.flags.abstract_mode,
            "flags": self.flags,
        });
        if let Some(map) = value.as_object_mut() {
            map.insert(
                "visibility".to_string(),
                Value::String(crate::types::visibility_name(&self.flags)),
            );
            map.insert(
                "createdAt".to_string(),
                if self.builtin {
                    Value::Null
                } else {
                    Value::String(crate::tools::fmt_iso(self.created_at))
                },
            );
        }
        value
    }
}

pub fn list_class_modes(db: &Connection, class_id: &str) -> Vec<ClassModeRow> {
    let mut stmt = match db.prepare(
        "SELECT id, name, normalized, display_name, extend_modes, base_type,
                hidden, teacher_only, admin_only, invisible, separate_list, abstract_mode,
                created_at, created_by, created_name
         FROM class_modes WHERE class_id = ?1 ORDER BY name COLLATE NOCASE, created_at",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![class_id], |r| {
        let flags = ModeFlags {
            hidden: r.get::<_, i64>(6)? != 0,
            teacher_only: r.get::<_, i64>(7)? != 0,
            admin_only: r.get::<_, i64>(8)? != 0,
            invisible: r.get::<_, i64>(9)? != 0,
            separate_list: r.get::<_, i64>(10)? != 0,
            abstract_mode: r.get::<_, i64>(11)? != 0,
        };
        Ok(ClassModeRow {
            id: r.get(0)?,
            name: r.get(1)?,
            normalized: r.get(2)?,
            display_name: r.get(3)?,
            extend_modes: serde_json::from_str::<Vec<String>>(&r.get::<_, String>(4)?)
                .unwrap_or_default(),
            base_type: r.get(5)?,
            flags,
            created_at: r.get(12)?,
            created_by: r.get(13)?,
            created_name: r.get(14)?,
        })
    });
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

fn load_class_mode_row(db: &Connection, class_id: &str, normalized: &str) -> Option<ClassModeRow> {
    db.query_row(
        "SELECT id, name, normalized, display_name, extend_modes, base_type,
                hidden, teacher_only, admin_only, invisible, separate_list, abstract_mode,
                created_at, created_by, created_name
         FROM class_modes WHERE class_id = ?1 AND normalized = ?2",
        params![class_id, normalized],
        |r| {
            Ok(ClassModeRow {
                id: r.get(0)?,
                name: r.get(1)?,
                normalized: r.get(2)?,
                display_name: r.get(3)?,
                extend_modes: serde_json::from_str::<Vec<String>>(&r.get::<_, String>(4)?)
                    .unwrap_or_default(),
                base_type: r.get(5)?,
                flags: ModeFlags {
                    hidden: r.get::<_, i64>(6)? != 0,
                    teacher_only: r.get::<_, i64>(7)? != 0,
                    admin_only: r.get::<_, i64>(8)? != 0,
                    invisible: r.get::<_, i64>(9)? != 0,
                    separate_list: r.get::<_, i64>(10)? != 0,
                    abstract_mode: r.get::<_, i64>(11)? != 0,
                },
                created_at: r.get(12)?,
                created_by: r.get(13)?,
                created_name: r.get(14)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// 解析一个模式名（内置或班级自定义）。返回 `None` 表示未定义。
///
/// 除模式名外也接受创建时填写的「显示名称」（例如中文标签页名称）。
pub fn find_mode(db: &Connection, class_id: &str, raw: &str) -> Option<ModeInfo> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut visiting = Vec::new();
    if let Some(info) = find_mode_inner(db, class_id, raw, &mut visiting) {
        return Some(info);
    }
    let display_match: Option<String> = db
        .query_row(
            "SELECT normalized FROM class_modes
             WHERE class_id = ?1 AND (display_name = ?2 COLLATE NOCASE OR name = ?2 COLLATE NOCASE)
             LIMIT 1",
            params![class_id, raw],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    display_match.and_then(|normalized| {
        let mut visiting = Vec::new();
        find_mode_inner(db, class_id, &normalized, &mut visiting)
    })
}

fn find_mode_inner(
    db: &Connection,
    class_id: &str,
    raw: &str,
    visiting: &mut Vec<String>,
) -> Option<ModeInfo> {
    let normalized = normalize_mode_name(raw);
    if normalized.is_empty() {
        return None;
    }
    if let Some(canonical) = builtin_mode(&normalized) {
        return Some(builtin_mode_info(canonical));
    }
    let row = load_class_mode_row(db, class_id, &normalized)?;
    if visiting.iter().any(|v| v == &normalized) {
        // 数据损坏导致的环：停止向下解析，但仍然返回当前模式。
        let display_name = row.effective_display_name();
        return Some(ModeInfo {
            id: row.id,
            name: row.name,
            normalized: row.normalized,
            display_name,
            base_type: row.base_type,
            extend_modes: row.extend_modes,
            ancestors: vec![normalized],
            flags: row.flags,
            builtin: false,
            created_at: row.created_at,
        });
    }
    visiting.push(normalized.clone());
    let mut ancestors = vec![normalized.clone()];
    let mut flags = row.flags;
    for parent in &row.extend_modes {
        if let Some(info) = find_mode_inner(db, class_id, parent, visiting) {
            flags.inherit_from(&info.flags);
            for a in info.ancestors {
                if !ancestors.contains(&a) {
                    ancestors.push(a);
                }
            }
        }
    }
    visiting.pop();
    let display_name = row.effective_display_name();
    Some(ModeInfo {
        id: row.id,
        name: row.name,
        normalized: row.normalized,
        display_name,
        base_type: row.base_type,
        extend_modes: row.extend_modes,
        ancestors,
        flags,
        builtin: false,
        created_at: row.created_at,
    })
}

/// 解析班级可用的征集模式（内置或自定义）；未定义时返回 `None`。
pub fn resolve_mode(db: &Connection, class_id: &str, raw: &str) -> Option<ModeInfo> {
    find_mode(db, class_id, raw)
}

/// 当前班级全部可用模式（内置 + 自定义）。
pub fn list_mode_infos(db: &Connection, class_id: &str) -> Vec<ModeInfo> {
    let mut out: Vec<ModeInfo> = BUILTIN_MODES
        .iter()
        .filter_map(|name| builtin_mode(name).map(builtin_mode_info))
        .collect();
    for row in list_class_modes(db, class_id) {
        if let Some(info) = find_mode(db, class_id, &row.normalized) {
            out.push(info);
        }
    }
    out
}

fn pick_base_type(bases: &[String]) -> String {
    for candidate in [
        "answer sheet",
        "survey",
        "notice",
        "homework",
        "open call",
        "leave request",
        "other",
    ] {
        if bases.iter().any(|b| b == candidate) {
            return candidate.to_string();
        }
    }
    bases
        .first()
        .cloned()
        .unwrap_or_else(|| "other".to_string())
}

/// 创建自定义模式的参数。
///
/// 可见性不在创建参数里单独声明，而是通过 `extends` 继承内置模式
/// （`hidden` / `teacher only` / `admin only` / `invisible` / `separate list`）。
/// 只有「抽象类别」例外：抽象属性不继承，必须显式声明。
#[derive(Clone, Debug, Default)]
pub struct ModeCreateOptions {
    pub display_name: String,
    pub abstract_mode: bool,
}

/// 创建班级自定义征集模式（管理员）。`extends` 为父模式名。
pub fn create_class_mode(
    db: &Connection,
    auth: &AuthCtx,
    name: &str,
    extends: &[String],
) -> Result<ClassModeRow, String> {
    create_class_mode_with_options(db, auth, name, extends, &ModeCreateOptions::default())
}

/// 创建班级自定义征集模式（带显示名称；可见性由 `extends` 继承，抽象属性显式声明）。
///
/// 允许嵌套继承；任意两个父模式的继承链（含父模式自身）若有交集，
/// 说明同一个祖先存在多条继承路径（菱形继承），直接拒绝。
pub fn create_class_mode_with_options(
    db: &Connection,
    auth: &AuthCtx,
    name: &str,
    extends: &[String],
    options: &ModeCreateOptions,
) -> Result<ClassModeRow, String> {
    create_class_mode_impl(db, auth, name, extends, options)
}

fn create_class_mode_impl(
    db: &Connection,
    auth: &AuthCtx,
    name: &str,
    extends: &[String],
    options: &ModeCreateOptions,
) -> Result<ClassModeRow, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("modeName must not be empty".to_string());
    }
    if name.chars().count() > 60 {
        return Err("modeName is too long (max 60 characters)".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("modeName must not contain control characters".to_string());
    }
    let display_name = options.display_name.trim();
    if display_name.chars().count() > 60 {
        return Err("displayName is too long (max 60 characters)".to_string());
    }
    if display_name.chars().any(char::is_control) {
        return Err("displayName must not contain control characters".to_string());
    }
    let normalized = normalize_mode_name(name);
    if normalized.is_empty() {
        return Err("modeName must not be empty".to_string());
    }
    if find_mode(db, &auth.class_id, &normalized).is_some() {
        return Err(format!("submission mode already exists: {name}"));
    }
    if extends.len() > 16 {
        return Err("extendModes supports at most 16 entries".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let mut extend_modes: Vec<String> = Vec::new();
    let mut parents: Vec<ModeInfo> = Vec::new();
    for raw in extends {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let Some(info) = find_mode(db, &auth.class_id, raw) else {
            return Err(format!("unknown extend mode: {raw}"));
        };
        if seen.insert(info.normalized.clone()) {
            extend_modes.push(info.normalized.clone());
            parents.push(info);
        }
    }
    // 菱形继承检测：任意两个父模式的继承链不能有交集。
    for i in 0..parents.len() {
        for j in (i + 1)..parents.len() {
            if let Some(common) = parents[i]
                .ancestors
                .iter()
                .find(|a| parents[j].ancestors.contains(a))
            {
                return Err(format!(
                    "diamond inheritance is not allowed: '{}' and '{}' both inherit '{}'",
                    parents[i].name, parents[j].name, common
                ));
            }
        }
    }
    let bases: Vec<String> = parents.iter().map(|p| p.base_type.clone()).collect();
    let base_type = pick_base_type(&bases);
    // 可见性全部来自继承链；抽象属性不继承，只接受显式声明。
    let mut flags = ModeFlags::default();
    for parent in &parents {
        flags.inherit_from(&parent.flags);
    }
    flags.abstract_mode = options.abstract_mode;
    let mut ancestors: Vec<String> = vec![normalized.clone()];
    for parent in &parents {
        for a in &parent.ancestors {
            if !ancestors.contains(a) {
                ancestors.push(a.clone());
            }
        }
    }
    let id = new_id("mode");
    let now = now_ts();
    let stored_display_name = if display_name.is_empty() {
        name.to_string()
    } else {
        display_name.to_string()
    };
    db.execute(
        "INSERT INTO class_modes
         (id, class_id, name, normalized, display_name, extend_modes, base_type,
          hidden, teacher_only, admin_only, invisible, separate_list, abstract_mode,
          created_at, created_by, created_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            id,
            auth.class_id,
            name,
            normalized,
            stored_display_name,
            serde_json::to_string(&extend_modes).unwrap_or_else(|_| "[]".to_string()),
            base_type,
            flags.hidden as i64,
            flags.teacher_only as i64,
            flags.admin_only as i64,
            flags.invisible as i64,
            flags.separate_list as i64,
            flags.abstract_mode as i64,
            now,
            auth.id,
            auth.identity()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(ClassModeRow {
        id,
        name: name.to_string(),
        normalized,
        display_name: stored_display_name,
        extend_modes,
        base_type,
        flags,
        created_at: now,
        created_by: Some(auth.id.clone()),
        created_name: auth.identity(),
    })
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

pub struct CreatedClass {
    pub id: String,
    pub code: String,
    pub auth_id: String,
    pub key: String,
}

pub fn create_class(
    db: &Connection,
    creator: &AuthCtx,
    name: &str,
    desc: &str,
) -> Result<CreatedClass, String> {
    let name = name.trim();
    let desc = desc.trim();
    let class_name = if !name.is_empty() {
        name.to_string()
    } else if !desc.is_empty() {
        crate::tools::truncate_chars(desc.lines().next().unwrap_or(desc), 30)
    } else {
        "未命名班级".to_string()
    };
    let name_chars = class_name.chars().count();
    if name_chars > 40 {
        return Err("class name is too long (max 40 characters)".to_string());
    }
    if desc.chars().count() > 500 {
        return Err("class description is too long (max 500 characters)".to_string());
    }

    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let class_id = new_id("cls");
    let mut code = new_class_code();
    for _ in 0..20 {
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM classes WHERE code = ?1",
                params![code],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_none() {
            break;
        }
        code = new_class_code();
    }
    let now = now_ts();
    tx.execute(
        "INSERT INTO classes (id, code, name, desc, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![class_id, code, class_name, desc, now, creator.id],
    )
    .map_err(|e| e.to_string())?;

    let auth_id = new_id("auth");
    let mut key = new_auth_key(ROLE_ADMIN);
    for _ in 0..20 {
        if !auth_key_exists(&tx, &key) {
            break;
        }
        key = new_auth_key(ROLE_ADMIN);
    }
    tx.execute(
        "INSERT INTO auths (id, key, class_id, user_id, role, display_name, created_at)
         VALUES (?1, ?2, ?3, ?4, 'admin', ?5, ?6)",
        params![
            auth_id,
            key,
            class_id,
            creator.user_id,
            creator.identity(),
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(CreatedClass {
        id: class_id,
        code,
        auth_id,
        key,
    })
}

#[derive(Debug, Clone)]
pub struct CreatedMember {
    pub id: String,
    pub key: String,
    pub role: String,
    pub student_id: Option<String>,
    pub display_name: String,
}

pub fn normalize_role(kind: &str) -> Option<&'static str> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "student" | "学生" => Some(ROLE_STUDENT),
        "teacher" | "老师" => Some(ROLE_TEACHER),
        "admin" | "管理员" => Some(ROLE_ADMIN),
        _ => None,
    }
}

pub fn create_members(
    db: &Connection,
    admin: &AuthCtx,
    class_id: &str,
    kind: &str,
    quantity: i64,
) -> Result<Vec<CreatedMember>, String> {
    if class_id != admin.class_id {
        return Err("members can only be added to the class of the current admin auth".to_string());
    }
    if !(1..=100).contains(&quantity) {
        return Err("quantity must be between 1 and 100".to_string());
    }
    let role = normalize_role(kind)
        .ok_or_else(|| "type must be one of Student / Teacher / Admin".to_string())?;
    let code = class_code(db, class_id);
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let max_short: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(short_id), 0) FROM auths WHERE class_id = ?1",
            params![class_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let now = now_ts();
    let mut out = Vec::new();
    for i in 0..quantity {
        let short = if role == ROLE_STUDENT {
            Some(max_short + i + 1)
        } else {
            None
        };
        let student_id = short.map(|s| format!("{code}-{s:02}"));
        let display_name = match role {
            ROLE_STUDENT => format!("学生 {:02}", short.unwrap_or(0)),
            ROLE_TEACHER => format!("教师 {:02}", i + 1),
            _ => format!("管理员 {:02}", i + 1),
        };
        let id = new_id("auth");
        let mut key = new_auth_key(role);
        for _ in 0..20 {
            if !auth_key_exists(&tx, &key) {
                break;
            }
            key = new_auth_key(role);
        }
        tx.execute(
            "INSERT INTO auths
             (id, key, class_id, user_id, role, student_id, short_id, display_name, created_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                key,
                class_id,
                role,
                student_id,
                short,
                display_name,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        out.push(CreatedMember {
            id,
            key,
            role: role.to_string(),
            student_id,
            display_name,
        });
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// 征集 / 提交 / 回复查询
// ---------------------------------------------------------------------------

pub fn submission_class_id(db: &Connection, id: &str) -> Option<String> {
    db.query_row(
        "SELECT class_id FROM submissions WHERE id = ?1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// 上传前需要确认的征集信息：`(class_id, 生效类型, desc)`。
/// 生效类型对自定义模式取 `base_type`（如 answer sheet），问卷模式要靠 `desc`
/// 解析必填控件，因此一并取出。
pub fn submission_meta(db: &Connection, id: &str) -> Option<(String, String, String)> {
    db.query_row(
        "SELECT class_id, COALESCE(NULLIF(TRIM(base_type), ''), type), desc
         FROM submissions WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// 上传时需要的征集信息：班级、行为基类、说明与模式可见性。
pub fn submission_meta_access(
    db: &Connection,
    id: &str,
) -> Option<(String, String, String, ModeFlags)> {
    let (class_id, kind, base_type, desc, own): (
        String,
        String,
        Option<String>,
        String,
        ModeFlags,
    ) = db
        .query_row(
            "SELECT class_id, type, base_type, desc, hidden, teacher_only, admin_only, invisible
             FROM submissions WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    ModeFlags {
                        hidden: r.get::<_, i64>(4)? != 0,
                        teacher_only: r.get::<_, i64>(5)? != 0,
                        admin_only: r.get::<_, i64>(6)? != 0,
                        invisible: r.get::<_, i64>(7)? != 0,
                        ..ModeFlags::default()
                    },
                ))
            },
        )
        .optional()
        .ok()
        .flatten()?;
    let effective = base_type
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| kind.clone());
    let mut flags = find_mode(db, &class_id, &kind)
        .map(|info| info.flags)
        .unwrap_or_default();
    flags.hidden |= own.hidden;
    flags.teacher_only |= own.teacher_only;
    flags.admin_only |= own.admin_only;
    flags.invisible |= own.invisible;
    Some((class_id, effective, desc, flags))
}

pub fn upload_class_id(db: &Connection, id: &str) -> Option<String> {
    db.query_row(
        "SELECT class_id FROM uploads WHERE id = ?1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn reply_class_id(db: &Connection, id: &str) -> Option<String> {
    db.query_row(
        "SELECT u.class_id FROM replies r JOIN uploads u ON u.id = r.upload_id WHERE r.id = ?1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn map_submission_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SubmissionRow> {
    Ok(SubmissionRow {
        id: r.get(0)?,
        name: r.get(1)?,
        desc: r.get(2)?,
        kind: r.get(3)?,
        deadline: r.get(4)?,
        created_at: r.get(5)?,
        created_name: r.get(6)?,
        upload_count: r.get(7)?,
        my_upload_count: r.get(8)?,
        pending_count: r.get(9)?,
        last_upload_id: r.get(10)?,
        base_kind: r.get(11)?,
        created_by: r.get(12)?,
        display_name: String::new(),
        flags: ModeFlags {
            hidden: r.get::<_, i64>(13)? != 0,
            teacher_only: r.get::<_, i64>(14)? != 0,
            admin_only: r.get::<_, i64>(15)? != 0,
            invisible: r.get::<_, i64>(16)? != 0,
            ..ModeFlags::default()
        },
        mode_ancestors: Vec::new(),
    })
}

fn map_upload_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<UploadRow> {
    let data_raw: String = r.get(5)?;
    let data = serde_json::from_str::<Value>(&data_raw).unwrap_or(Value::Null);
    Ok(UploadRow {
        id: r.get(0)?,
        submission_id: r.get(1)?,
        submission_name: r.get(2)?,
        title: r.get(3)?,
        desc: r.get(4)?,
        data,
        created_at: r.get(6)?,
        uploader_name: r.get(7)?,
        student_id: r.get(8)?,
        short_id: r.get(9)?,
        role: r.get(10)?,
        auth_id: r.get(11)?,
        reply_count: r.get(12)?,
        last_reply_at: r.get(13)?,
        submission_created_by: r.get(14)?,
        submission_created_name: r.get(15)?,
    })
}

/// 为征集行补充模式的显示名称、可见性属性与继承链。
fn decorate_submissions(db: &Connection, class_id: &str, rows: &mut [SubmissionRow]) {
    if rows.is_empty() {
        return;
    }
    let infos = list_mode_infos(db, class_id);
    let mut by_norm = std::collections::HashMap::new();
    for info in infos {
        by_norm.insert(info.normalized.clone(), info);
    }
    for row in rows {
        let normalized = normalize_mode_name(&row.kind);
        let own_flags = row.flags;
        if let Some(info) = by_norm.get(&normalized) {
            row.display_name = info.effective_display_name();
            row.flags = info.flags;
            row.flags.hidden |= own_flags.hidden;
            row.flags.teacher_only |= own_flags.teacher_only;
            row.flags.admin_only |= own_flags.admin_only;
            row.flags.invisible |= own_flags.invisible;
            row.mode_ancestors = info.ancestors.clone();
        } else {
            row.display_name = row.kind.clone();
            row.flags = own_flags;
            row.mode_ancestors = vec![normalized];
        }
    }
}

/// 「单独列出」分类标签页（不包括抽象基类自身）。
pub fn separate_mode_tabs(
    db: &Connection,
    class_id: &str,
    rows: &[SubmissionRow],
    role: &str,
) -> Vec<ModeTab> {
    let mut tabs = Vec::new();
    for info in list_mode_infos(db, class_id) {
        if !info.flags.separate_list || info.flags.abstract_mode {
            continue;
        }
        if !info.flags.can_view(role) {
            continue;
        }
        let count = rows
            .iter()
            .filter(|row| row.mode_ancestors.iter().any(|a| a == &info.normalized))
            .count() as i64;
        tabs.push(ModeTab {
            id: info.id.clone(),
            name: info.name.clone(),
            display_name: info.effective_display_name(),
            normalized: info.normalized.clone(),
            count,
        });
    }
    tabs.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
            .then_with(|| a.normalized.cmp(&b.normalized))
    });
    tabs
}

/// 按「单独列出」分类过滤征集行；分类可以写模式名或显示名称。
pub fn filter_submissions_category(
    db: &Connection,
    class_id: &str,
    rows: &mut Vec<SubmissionRow>,
    category: &str,
) {
    let category = category.trim();
    if category.is_empty() {
        return;
    }
    let normalized = find_mode(db, class_id, category)
        .map(|info| info.normalized)
        .unwrap_or_else(|| normalize_mode_name(category));
    rows.retain(|row| {
        row.mode_ancestors.iter().any(|a| a == &normalized)
            || normalize_mode_name(&row.kind) == normalized
    });
}

/// 征集对当前角色是否可见（按 ID 直接访问也使用该规则）。
pub fn submission_access(db: &Connection, submission_id: &str) -> Option<(String, ModeFlags)> {
    let (class_id, kind, own): (String, String, ModeFlags) = db
        .query_row(
            "SELECT class_id, type, hidden, teacher_only, admin_only, invisible
             FROM submissions WHERE id = ?1",
            params![submission_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    ModeFlags {
                        hidden: r.get::<_, i64>(2)? != 0,
                        teacher_only: r.get::<_, i64>(3)? != 0,
                        admin_only: r.get::<_, i64>(4)? != 0,
                        invisible: r.get::<_, i64>(5)? != 0,
                        ..ModeFlags::default()
                    },
                ))
            },
        )
        .optional()
        .ok()
        .flatten()?;
    let mut flags = find_mode(db, &class_id, &kind)
        .map(|info| info.flags)
        .unwrap_or_default();
    flags.hidden |= own.hidden;
    flags.teacher_only |= own.teacher_only;
    flags.admin_only |= own.admin_only;
    flags.invisible |= own.invisible;
    Some((class_id, flags))
}

fn submission_sql(staff: bool, with_limit: bool, own_first: bool) -> String {
    let tail = if with_limit {
        if staff {
            if own_first {
                " LIMIT ?3"
            } else {
                " LIMIT ?2"
            }
        } else {
            " LIMIT ?3"
        }
    } else {
        ""
    };
    if staff {
        let own_order = if own_first {
            "CASE WHEN s.created_by = ?2 THEN 0 ELSE 1 END, "
        } else {
            ""
        };
        format!(
            "SELECT s.id, s.name, s.desc, s.type, s.deadline, s.created_at, s.created_name,
                (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id),
                0,
                (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id
                    AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.upload_id = u.id)),
                (SELECT u.id FROM uploads u WHERE u.submission_id = s.id
                    ORDER BY u.created_at DESC, u.id DESC LIMIT 1),
                s.base_type, s.created_by, s.hidden, s.teacher_only, s.admin_only, s.invisible
             FROM submissions s WHERE s.class_id = ?1
             ORDER BY CASE WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(s.base_type), ''), s.type))) = 'notice' AND (s.deadline IS NULL OR s.deadline > CAST(strftime('%s','now') AS INTEGER)) THEN 0 ELSE 1 END, {own_order}CASE WHEN s.deadline IS NOT NULL AND s.deadline < CAST(strftime('%s','now') AS INTEGER) THEN 1 ELSE 0 END, CASE WHEN s.deadline IS NULL THEN 1 ELSE 0 END, s.deadline ASC, s.created_at DESC{tail}"
        )
    } else {
        format!(
            "SELECT s.id, s.name, s.desc, s.type, s.deadline, s.created_at, s.created_name,
                (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id AND u.auth_id = ?2),
                (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id AND u.auth_id = ?2),
                (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id AND u.auth_id = ?2
                    AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.upload_id = u.id)),
                (SELECT u.id FROM uploads u WHERE u.submission_id = s.id AND u.auth_id = ?2
                    ORDER BY u.created_at DESC, u.id DESC LIMIT 1),
                s.base_type, s.created_by, s.hidden, s.teacher_only, s.admin_only, s.invisible
             FROM submissions s WHERE s.class_id = ?1
             ORDER BY CASE WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(s.base_type), ''), s.type))) = 'notice' AND (s.deadline IS NULL OR s.deadline > CAST(strftime('%s','now') AS INTEGER)) THEN 0 ELSE 1 END, CASE WHEN s.deadline IS NOT NULL AND s.deadline < CAST(strftime('%s','now') AS INTEGER) THEN 1 ELSE 0 END, CASE WHEN s.deadline IS NULL THEN 1 ELSE 0 END, s.deadline ASC, s.created_at DESC{tail}"
        )
    }
}

pub fn list_submissions(
    db: &Connection,
    auth: &AuthCtx,
    limit: i64,
    own_first: bool,
) -> Vec<SubmissionRow> {
    list_submissions_visible(db, auth, limit, own_first, false)
}

/// 全部征集列表（按可见性过滤）。`show_hiddens` 对应需求中的 `show-hiddens`。
pub fn list_submissions_visible(
    db: &Connection,
    auth: &AuthCtx,
    limit: i64,
    own_first: bool,
    show_hiddens: bool,
) -> Vec<SubmissionRow> {
    let staff = auth.is_staff();
    let sql = submission_sql(staff, true, own_first);
    let mut stmt = match db.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = if staff {
        if own_first {
            stmt.query_map(params![auth.class_id, auth.id, limit], map_submission_row)
        } else {
            stmt.query_map(params![auth.class_id, limit], map_submission_row)
        }
    } else {
        stmt.query_map(params![auth.class_id, auth.id, limit], map_submission_row)
    };
    let mut out: Vec<SubmissionRow> = match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => return Vec::new(),
    };
    decorate_submissions(db, &auth.class_id, &mut out);
    out.retain(|row| row.flags.listed(&auth.role, show_hiddens));
    out
}

pub fn load_submission(db: &Connection, auth: &AuthCtx, sub_id: &str) -> Option<SubmissionRow> {
    let staff = auth.is_staff();
    let sql = if staff {
        "SELECT s.id, s.name, s.desc, s.type, s.deadline, s.created_at, s.created_name,
            (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id),
            0,
            (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id
                AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.upload_id = u.id)),
            (SELECT u.id FROM uploads u WHERE u.submission_id = s.id
                ORDER BY u.created_at DESC, u.id DESC LIMIT 1),
            s.base_type, s.created_by, s.hidden, s.teacher_only, s.admin_only, s.invisible
         FROM submissions s WHERE s.id = ?1 AND s.class_id = ?2"
    } else {
        "SELECT s.id, s.name, s.desc, s.type, s.deadline, s.created_at, s.created_name,
            (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id AND u.auth_id = ?3),
            (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id AND u.auth_id = ?3),
            (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id AND u.auth_id = ?3
                AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.upload_id = u.id)),
            (SELECT u.id FROM uploads u WHERE u.submission_id = s.id AND u.auth_id = ?3
                ORDER BY u.created_at DESC, u.id DESC LIMIT 1),
            s.base_type, s.created_by, s.hidden, s.teacher_only, s.admin_only, s.invisible
         FROM submissions s WHERE s.id = ?1 AND s.class_id = ?2"
    };
    let mut row = if staff {
        db.query_row(sql, params![sub_id, auth.class_id], map_submission_row)
    } else {
        db.query_row(
            sql,
            params![sub_id, auth.class_id, auth.id],
            map_submission_row,
        )
    }
    .optional()
    .ok()
    .flatten()?;
    decorate_submissions(db, &auth.class_id, std::slice::from_mut(&mut row));
    if !row.flags.can_view(&auth.role) {
        return None;
    }
    Some(row)
}

#[allow(clippy::too_many_arguments)]
pub fn list_uploads(
    db: &Connection,
    auth: &AuthCtx,
    filter: Option<&str>,
    limit: i64,
    include_data: bool,
    own_first: bool,
) -> Vec<UploadRow> {
    let staff = auth.is_staff();
    let data_col = if include_data { "u.data" } else { "'[]'" };
    let reply_filter = if staff {
        match filter {
            Some("pending") => "AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.upload_id = u.id)",
            Some("replied") => "AND EXISTS (SELECT 1 FROM replies r WHERE r.upload_id = u.id)",
            _ => "",
        }
    } else {
        ""
    };
    let own_filter = if staff { "" } else { "AND u.auth_id = ?2" };
    // 老师 / 管理员：优先展示自己发布的征集中的待回复提交。
    let order_prefix = if staff && own_first {
        "CASE WHEN s.created_by = ?2 THEN 0 ELSE 1 END, "
    } else {
        ""
    };
    let sql = format!(
        "SELECT u.id, u.submission_id, s.name, u.title, u.desc, {data_col}, u.created_at,
                u.uploader_name, u.student_id, u.short_id, u.role, u.auth_id,
                (SELECT COUNT(*) FROM replies r WHERE r.upload_id = u.id),
                (SELECT MAX(r.created_at) FROM replies r WHERE r.upload_id = u.id),
                s.created_by, s.created_name
         FROM uploads u JOIN submissions s ON s.id = u.submission_id
         WHERE u.class_id = ?1 {own_filter} {reply_filter}
         ORDER BY {order_prefix}u.created_at DESC, u.id DESC LIMIT {limit}"
    );
    let mut stmt = match db.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = if staff {
        if own_first {
            stmt.query_map(params![auth.class_id, auth.id], map_upload_row)
        } else {
            stmt.query_map(params![auth.class_id], map_upload_row)
        }
    } else {
        stmt.query_map(params![auth.class_id, auth.id], map_upload_row)
    };
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// 当前身份的提交（个人所有提交）。可选按征集 / 提交 ID 过滤。
pub fn list_my_uploads(
    db: &Connection,
    auth: &AuthCtx,
    submission_id: Option<&str>,
    upload_id: Option<&str>,
    limit: i64,
    include_data: bool,
) -> Vec<UploadRow> {
    let data_col = if include_data { "u.data" } else { "'[]'" };
    let mut conditions = String::from("u.class_id = ?1 AND u.auth_id = ?2");
    if submission_id.is_some() {
        conditions.push_str(" AND u.submission_id = ?3");
    }
    if upload_id.is_some() {
        // 没有 submissionID 时上传 ID 是第 3 个绑定参数。
        let placeholder = if submission_id.is_some() { "?4" } else { "?3" };
        conditions.push_str(&format!(" AND u.id = {placeholder}"));
    }
    let sql = format!(
        "SELECT u.id, u.submission_id, s.name, u.title, u.desc, {data_col}, u.created_at,
                u.uploader_name, u.student_id, u.short_id, u.role, u.auth_id,
                (SELECT COUNT(*) FROM replies r WHERE r.upload_id = u.id),
                (SELECT MAX(r.created_at) FROM replies r WHERE r.upload_id = u.id),
                s.created_by, s.created_name
         FROM uploads u JOIN submissions s ON s.id = u.submission_id
         WHERE {conditions}
         ORDER BY u.created_at DESC, u.id DESC LIMIT {limit}"
    );
    let mut stmt = match db.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match (submission_id, upload_id) {
        (Some(sub), Some(up)) => {
            stmt.query_map(params![auth.class_id, auth.id, sub, up], map_upload_row)
        }
        (Some(sub), None) => stmt.query_map(params![auth.class_id, auth.id, sub], map_upload_row),
        (None, Some(up)) => stmt.query_map(params![auth.class_id, auth.id, up], map_upload_row),
        (None, None) => stmt.query_map(params![auth.class_id, auth.id], map_upload_row),
    };
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn count_my_uploads(db: &Connection, auth: &AuthCtx) -> i64 {
    db.query_row(
        "SELECT COUNT(*) FROM uploads WHERE class_id = ?1 AND auth_id = ?2",
        params![auth.class_id, auth.id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// 当前身份发布的征集（个人发布的所有征集）。
pub fn list_my_submissions(db: &Connection, auth: &AuthCtx, limit: i64) -> Vec<SubmissionRow> {
    let sql = "SELECT s.id, s.name, s.desc, s.type, s.deadline, s.created_at, s.created_name,
            (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id),
            (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id AND u.auth_id = ?2),
            (SELECT COUNT(*) FROM uploads u WHERE u.submission_id = s.id
                AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.upload_id = u.id)),
            (SELECT u.id FROM uploads u WHERE u.submission_id = s.id
                ORDER BY u.created_at DESC, u.id DESC LIMIT 1),
            s.base_type, s.created_by, s.hidden, s.teacher_only, s.admin_only, s.invisible
         FROM submissions s WHERE s.class_id = ?1 AND s.created_by = ?2
         ORDER BY s.created_at DESC, s.id DESC LIMIT ?3";
    let mut stmt = match db.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![auth.class_id, auth.id, limit], map_submission_row);
    let mut out: Vec<SubmissionRow> = match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => return Vec::new(),
    };
    decorate_submissions(db, &auth.class_id, &mut out);
    out
}

pub fn load_upload(db: &Connection, auth: &AuthCtx, upload_id: &str) -> Option<UploadRow> {
    let row = db
        .query_row(
            "SELECT u.id, u.submission_id, s.name, u.title, u.desc, u.data, u.created_at,
                    u.uploader_name, u.student_id, u.short_id, u.role, u.auth_id,
                    (SELECT COUNT(*) FROM replies r WHERE r.upload_id = u.id),
                    (SELECT MAX(r.created_at) FROM replies r WHERE r.upload_id = u.id),
                    s.created_by, s.created_name
             FROM uploads u JOIN submissions s ON s.id = u.submission_id
             WHERE u.id = ?1 AND u.class_id = ?2",
            params![upload_id, auth.class_id],
            map_upload_row,
        )
        .optional()
        .ok()
        .flatten()?;
    if auth.is_student() && row.auth_id.as_deref() != Some(auth.id.as_str()) {
        return None;
    }
    Some(row)
}

pub fn load_replies(db: &Connection, upload_id: &str) -> Vec<ReplyRow> {
    let mut stmt = match db.prepare(
        "SELECT id, content, replier_name, role, created_at
         FROM replies WHERE upload_id = ?1 ORDER BY created_at ASC, id ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![upload_id], |r| {
        Ok(ReplyRow {
            id: r.get(0)?,
            content: r.get(1)?,
            replier_name: r.get(2)?,
            role: r.get(3)?,
            created_at: r.get(4)?,
        })
    });
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn latest_upload_id(db: &Connection, auth: &AuthCtx, sub_id: &str) -> Option<String> {
    let sql = if auth.is_staff() {
        "SELECT id FROM uploads WHERE submission_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1"
    } else {
        "SELECT id FROM uploads WHERE submission_id = ?1 AND auth_id = ?2
         ORDER BY created_at DESC, id DESC LIMIT 1"
    };
    let row = if auth.is_staff() {
        db.query_row(sql, params![sub_id], |r| r.get::<_, String>(0))
    } else {
        db.query_row(sql, params![sub_id, auth.id], |r| r.get::<_, String>(0))
    };
    row.optional().ok().flatten()
}

pub fn own_upload_info(db: &Connection, auth: &AuthCtx, sub_id: &str) -> (i64, Option<String>) {
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM uploads WHERE submission_id = ?1 AND auth_id = ?2",
            params![sub_id, auth.id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let last = db
        .query_row(
            "SELECT id FROM uploads WHERE submission_id = ?1 AND auth_id = ?2
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![sub_id, auth.id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    (count, last)
}

pub fn upload_counts(db: &Connection, auth: &AuthCtx) -> (i64, i64, i64) {
    let total: i64 = if auth.is_staff() {
        db.query_row(
            "SELECT COUNT(*) FROM uploads u WHERE u.class_id = ?1",
            params![auth.class_id],
            |r| r.get(0),
        )
    } else {
        db.query_row(
            "SELECT COUNT(*) FROM uploads u WHERE u.class_id = ?1 AND u.auth_id = ?2",
            params![auth.class_id, auth.id],
            |r| r.get(0),
        )
    }
    .unwrap_or(0);
    let pending: i64 = if auth.is_staff() {
        db.query_row(
            "SELECT COUNT(*) FROM uploads u WHERE u.class_id = ?1
             AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.upload_id = u.id)",
            params![auth.class_id],
            |r| r.get(0),
        )
    } else {
        db.query_row(
            "SELECT COUNT(*) FROM uploads u WHERE u.class_id = ?1 AND u.auth_id = ?2
             AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.upload_id = u.id)",
            params![auth.class_id, auth.id],
            |r| r.get(0),
        )
    }
    .unwrap_or(0);
    (total, pending, total - pending)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct HomeCounts {
    pub members: i64,
    pub submissions: i64,
    pub uploads: i64,
    pub pending: i64,
    pub replied: i64,
    pub active: i64,
    pub replies: i64,
}

pub fn home_counts(db: &Connection, auth: &AuthCtx, now: i64) -> HomeCounts {
    let members: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM auths WHERE class_id = ?1",
            params![auth.class_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    // 统计只计入当前角色在「全部征集」列表中可见的征集（隐藏 / 仅教师 / 仅管理员 /
    // 不显示都会按可见性规则排除；隐藏开关只影响列表，不影响首页统计）。
    let visible = list_submissions_visible(db, auth, i64::MAX, false, false);
    let submissions = visible.len() as i64;
    let active = visible
        .iter()
        .filter(|row| row.deadline.map_or(true, |deadline| deadline > now))
        .count() as i64;
    let (uploads, pending, replied) = upload_counts(db, auth);
    if auth.is_staff() {
        HomeCounts {
            members,
            submissions,
            uploads,
            pending,
            replied,
            active,
            replies: 0,
        }
    } else {
        let replies: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM replies r JOIN uploads u ON u.id = r.upload_id
                 WHERE u.auth_id = ?1",
                params![auth.id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        HomeCounts {
            members,
            submissions,
            uploads,
            pending,
            replied,
            active: 0,
            replies,
        }
    }
}

// ---------------------------------------------------------------------------
// 下载 / 导出
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct DownloadUploadRow {
    pub id: String,
    pub student_id: Option<String>,
    pub short_id: Option<i64>,
    pub title: String,
    pub desc: String,
    pub data: Value,
    pub created_at: i64,
    pub uploader_name: String,
    pub role: String,
}

pub fn list_download_uploads(db: &Connection, submission_id: &str) -> Vec<DownloadUploadRow> {
    let mut stmt = match db.prepare(
        "SELECT id, student_id, short_id, title, desc, data, created_at, uploader_name, role
         FROM uploads WHERE submission_id = ?1 ORDER BY created_at ASC, id ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![submission_id], |r| {
        let data_raw: String = r.get(5)?;
        let data = serde_json::from_str::<Value>(&data_raw).unwrap_or_else(|_| json!([]));
        Ok(DownloadUploadRow {
            id: r.get(0)?,
            student_id: r.get(1)?,
            short_id: r.get(2)?,
            title: r.get(3)?,
            desc: r.get(4)?,
            data,
            created_at: r.get(6)?,
            uploader_name: r.get(7)?,
            role: r.get(8)?,
        })
    });
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn reply_contents(db: &Connection, upload_id: &str) -> Vec<String> {
    let mut stmt = match db
        .prepare("SELECT content FROM replies WHERE upload_id = ?1 ORDER BY created_at ASC")
    {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![upload_id], |r| r.get::<_, String>(0));
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// 回复 ID 列表，顺序与 `reply_contents` 完全一致。
pub fn reply_ids(db: &Connection, upload_id: &str) -> Vec<String> {
    let mut stmt = match db
        .prepare("SELECT id FROM replies WHERE upload_id = ?1 ORDER BY created_at ASC, id ASC")
    {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![upload_id], |r| r.get::<_, String>(0));
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn submission_ids_by_student(db: &Connection, class_id: &str, student_id: &str) -> Vec<String> {
    let mut stmt = match db.prepare(
        "SELECT DISTINCT submission_id FROM uploads
         WHERE class_id = ?1 AND student_id = ?2",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![class_id, student_id], |r| r.get::<_, String>(0));
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn submission_ids_by_short(db: &Connection, class_id: &str, short_id: i64) -> Vec<String> {
    let mut stmt = match db.prepare(
        "SELECT DISTINCT submission_id FROM uploads
         WHERE class_id = ?1 AND short_id = ?2",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![class_id, short_id], |r| r.get::<_, String>(0));
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// 写入：征集 / 提交 / 回复
// ---------------------------------------------------------------------------

pub fn insert_upload(
    db: &Connection,
    auth: &AuthCtx,
    submission_id: &str,
    title: &str,
    desc: &str,
    data: &Value,
) -> Result<String, String> {
    let id = new_id("up");
    let now = now_ts();
    db.execute(
        "INSERT INTO uploads
         (id, submission_id, class_id, auth_id, user_id, student_id, short_id,
          uploader_name, role, title, desc, data, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            submission_id,
            auth.class_id,
            auth.id,
            auth.user_id,
            auth.student_id,
            auth.short_id,
            auth.identity(),
            auth.role,
            title,
            desc,
            data.to_string(),
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[allow(dead_code)]
pub fn insert_submission(
    db: &Connection,
    auth: &AuthCtx,
    name: &str,
    desc: &str,
    kind: &str,
    deadline: Option<i64>,
) -> Result<String, String> {
    insert_submission_mode(db, auth, name, desc, kind, kind, deadline)
}

/// 插入征集；`base_kind` 是自定义模式解析出的行为基类。
#[allow(clippy::too_many_arguments)]
pub fn insert_submission_mode(
    db: &Connection,
    auth: &AuthCtx,
    name: &str,
    desc: &str,
    kind: &str,
    base_kind: &str,
    deadline: Option<i64>,
) -> Result<String, String> {
    insert_submission_mode_flags(
        db,
        auth,
        name,
        desc,
        kind,
        base_kind,
        deadline,
        &ModeFlags::default(),
    )
}

/// 插入征集，并保存单条征集的可见性覆盖（与模式属性取并集）。
#[allow(clippy::too_many_arguments)]
pub fn insert_submission_mode_flags(
    db: &Connection,
    auth: &AuthCtx,
    name: &str,
    desc: &str,
    kind: &str,
    base_kind: &str,
    deadline: Option<i64>,
    flags: &ModeFlags,
) -> Result<String, String> {
    let id = new_id("sub");
    db.execute(
        "INSERT INTO submissions
         (id, class_id, name, desc, type, base_type,
          hidden, teacher_only, admin_only, invisible,
          deadline, created_at, created_by, created_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id,
            auth.class_id,
            name,
            desc,
            kind,
            base_kind,
            flags.hidden as i64,
            flags.teacher_only as i64,
            flags.admin_only as i64,
            flags.invisible as i64,
            deadline,
            now_ts(),
            auth.id,
            auth.identity()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn insert_reply(
    db: &Connection,
    auth: &AuthCtx,
    upload_id: &str,
    content: &str,
) -> Result<String, String> {
    let id = new_id("rep");
    db.execute(
        "INSERT INTO replies (id, upload_id, auth_id, replier_name, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            upload_id,
            auth.id,
            auth.identity(),
            auth.role,
            content,
            now_ts()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn delete_auth(db: &Connection, auth_id: &str) -> Result<(), String> {
    db.execute("DELETE FROM auths WHERE id = ?1", params![auth_id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 轮换 auth 密钥（auth 泄漏处置）。
///
/// 在同一个事务里：
///   1. 删除旧 auth（先删除，避免 `(class_id, student_id)` / `(class_id, short_id)`
///      唯一索引在插入新 auth 时冲突）；
///   2. 用新的随机密钥创建新 auth，继承旧 auth 的班级、角色、学号、短学号和显示名称；
///   3. 把旧 auth 名下的征集 / 提交 / 回复 / 班级创建者引用迁移到新 auth。
///
/// 旧 auth 的历史展示快照（姓名、学号等）保持不变。调用方必须先完成账号挑战验证，
/// 并传入该 auth 绑定账号的 `user_id`。成功时返回新 auth 的密钥。
pub fn refresh_auth(db: &Connection, auth: &AuthCtx, user_id: i64) -> Result<String, String> {
    if auth.user_id != Some(user_id) {
        return Err("auth does not belong to this account".to_string());
    }

    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let old_created_at: Option<i64> = tx
        .query_row(
            "SELECT created_at FROM auths WHERE id = ?1",
            params![auth.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(created_at) = old_created_at else {
        return Err("auth no longer exists".to_string());
    };

    let removed = tx
        .execute("DELETE FROM auths WHERE id = ?1", params![auth.id])
        .map_err(|e| e.to_string())?;
    if removed != 1 {
        return Err("auth no longer exists".to_string());
    }

    let new_auth_id = new_id("auth");
    let mut new_key = new_auth_key(&auth.role);
    let mut unique = false;
    for _ in 0..32 {
        if new_key != auth.key && !auth_key_exists(&tx, &new_key) {
            unique = true;
            break;
        }
        new_key = new_auth_key(&auth.role);
    }
    if !unique {
        return Err("failed to generate a unique auth key".to_string());
    }

    tx.execute(
        "INSERT INTO auths
         (id, key, class_id, user_id, role, student_id, short_id, display_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            new_auth_id,
            new_key,
            auth.class_id,
            auth.user_id,
            auth.role,
            auth.student_id,
            auth.short_id,
            auth.display_name,
            created_at
        ],
    )
    .map_err(|e| e.to_string())?;

    // 旧 auth 没有外键约束，必须手动把历史数据挂到新 auth 上。
    for sql in [
        "UPDATE uploads SET auth_id = ?1 WHERE auth_id = ?2",
        "UPDATE replies SET auth_id = ?1 WHERE auth_id = ?2",
        "UPDATE submissions SET created_by = ?1 WHERE created_by = ?2",
        "UPDATE classes SET created_by = ?1 WHERE created_by = ?2",
    ] {
        tx.execute(sql, params![new_auth_id, auth.id])
            .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_key)
}

pub fn auth_ids_in_class(db: &Connection, class_id: &str) -> Vec<String> {
    let mut stmt = match db.prepare("SELECT id FROM auths WHERE class_id = ?1") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![class_id], |r| r.get::<_, String>(0));
    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn delete_class(db: &Connection, class_id: &str) -> Result<(), String> {
    db.execute("DELETE FROM classes WHERE id = ?1", params![class_id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn delete_submission(db: &Connection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM submissions WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn delete_upload(db: &Connection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM uploads WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn delete_reply(db: &Connection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM replies WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn rename_auth(db: &Connection, auth_id: &str, name: &str) -> Result<(), String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE auths SET display_name = ?1 WHERE id = ?2",
        params![name, auth_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE uploads SET uploader_name = ?1 WHERE auth_id = ?2",
        params![name, auth_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE replies SET replier_name = ?1 WHERE auth_id = ?2",
        params![name, auth_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE submissions SET created_name = ?1 WHERE created_by = ?2",
        params![name, auth_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 用户账号
// ---------------------------------------------------------------------------

pub fn username_taken(db: &Connection, username: &str) -> bool {
    db.query_row(
        "SELECT 1 FROM users WHERE username = ?1 COLLATE NOCASE",
        params![username],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

pub fn register_user(
    db: &Connection,
    username: &str,
    pubkey: &str,
    display_name: &str,
) -> Result<i64, String> {
    if username_taken(db, username) {
        return Err("username already exists".to_string());
    }
    let display_name = if display_name.trim().is_empty() {
        username
    } else {
        display_name.trim()
    };
    // salt / pwhash 留空：新账号不使用服务端密码校验；旧账号迁移时才会用到。
    db.execute(
        "INSERT INTO users (username, salt, pwhash, pubkey, display_name, prefs, created_at)
         VALUES (?1, '', '', ?2, ?3, '{}', ?4)",
        params![username, pubkey, display_name, now_ts()],
    )
    .map_err(|e| e.to_string())?;
    Ok(db.last_insert_rowid())
}

pub fn update_user_pubkey(db: &Connection, user_id: i64, pubkey: &str) -> Result<(), String> {
    db.execute(
        "UPDATE users SET pubkey = ?1, salt = '', pwhash = '' WHERE id = ?2",
        params![pubkey, user_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// 仅在账号还没有公钥时写入（用于旧密码账号的一次性迁移）。
pub fn upgrade_user_pubkey(db: &Connection, user_id: i64, pubkey: &str) -> Result<bool, String> {
    let changed = db
        .execute(
            "UPDATE users SET pubkey = ?1, salt = '', pwhash = ''
             WHERE id = ?2 AND (pubkey IS NULL OR pubkey = '')",
            params![pubkey, user_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// 删除刚创建、但绑定密钥失败的账号（仅用于注册回滚）。
pub fn delete_user(db: &Connection, user_id: i64) -> Result<(), String> {
    db.execute("DELETE FROM users WHERE id = ?1", params![user_id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn bind_auth_if_unclaimed(
    db: &Connection,
    auth_id: &str,
    user_id: i64,
) -> Result<bool, String> {
    let changed = db
        .execute(
            "UPDATE auths SET user_id = ?1 WHERE id = ?2 AND user_id IS NULL",
            params![user_id, auth_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

pub fn update_user_prefs(
    db: &Connection,
    user_id: i64,
    display_name: &str,
    prefs: &Prefs,
) -> Result<(), String> {
    db.execute(
        "UPDATE users SET display_name = ?1, prefs = ?2 WHERE id = ?3",
        params![display_name, prefs.to_json(), user_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 演示数据
// ---------------------------------------------------------------------------

fn seed_if_empty(conn: &Connection) -> rusqlite::Result<()> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM classes", [], |r| r.get(0))?;
    if n > 0 {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let now = now_ts();

    // 用户
    let admin = seed_user(&tx, "admin", "admin123", DEMO_ADMIN_PUBKEY, "赵明远")?;
    let teacher = seed_user(&tx, "teacher", "teacher123", DEMO_TEACHER_PUBKEY, "林书言")?;
    let student = seed_user(&tx, "student", "student123", DEMO_STUDENT_PUBKEY, "陈小满")?;

    // 班级
    let c1 = new_id("cls");
    let c2 = new_id("cls");
    tx.execute(
        "INSERT INTO classes (id, code, name, desc, created_at, created_by)
         VALUES (?1, 'G2603', '高一（3）班', '2026 级 · 智慧校园示范班', ?2, NULL)",
        params![c1, now - 30 * 86_400],
    )?;
    tx.execute(
        "INSERT INTO classes (id, code, name, desc, created_at, created_by)
         VALUES (?1, 'G2601', '高二（1）班', '2026 级 · 理科实验班', ?2, NULL)",
        params![c2, now - 25 * 86_400],
    )?;

    // 身份 / auth
    let admin1 = new_id("auth");
    let admin2 = new_id("auth");
    let teacher1 = new_id("auth");
    let teacher2 = new_id("auth");
    let stu1 = new_id("auth");
    let stu2 = new_id("auth");
    let stu3 = new_id("auth");
    let stu_c2 = new_id("auth");

    seed_auth(
        &tx,
        &admin1,
        DEMO_ADMIN_KEY,
        &c1,
        Some(admin),
        ROLE_ADMIN,
        None,
        None,
        "赵明远",
    )?;
    seed_auth(
        &tx,
        &admin2,
        DEMO_ADMIN2_KEY,
        &c2,
        Some(admin),
        ROLE_ADMIN,
        None,
        None,
        "赵明远",
    )?;
    seed_auth(
        &tx,
        &teacher1,
        DEMO_TEACHER_KEY,
        &c1,
        Some(teacher),
        ROLE_TEACHER,
        None,
        None,
        "林书言",
    )?;
    seed_auth(
        &tx,
        &teacher2,
        DEMO_TEACHER2_KEY,
        &c2,
        None,
        ROLE_TEACHER,
        None,
        None,
        "待认领教师",
    )?;
    seed_auth(
        &tx,
        &stu1,
        DEMO_STUDENT_KEY,
        &c1,
        Some(student),
        ROLE_STUDENT,
        Some("G2603-01"),
        Some(1),
        "陈小满",
    )?;
    seed_auth(
        &tx,
        &stu2,
        DEMO_STUDENT2_KEY,
        &c1,
        None,
        ROLE_STUDENT,
        Some("G2603-02"),
        Some(2),
        "李知遥",
    )?;
    seed_auth(
        &tx,
        &stu3,
        DEMO_STUDENT3_KEY,
        &c1,
        None,
        ROLE_STUDENT,
        Some("G2603-03"),
        Some(3),
        "王浩然",
    )?;
    seed_auth(
        &tx,
        &stu_c2,
        DEMO_STUDENT_C2_KEY,
        &c2,
        None,
        ROLE_STUDENT,
        Some("G2601-01"),
        Some(1),
        "周雨桐",
    )?;

    // 征集
    let sub_homework = new_id("sub");
    let sub_sports = new_id("sub");
    let sub_leave = new_id("sub");
    let sub_photo = new_id("sub");
    let sub_english = new_id("sub");
    let sub_physics = new_id("sub");

    seed_submission(
        &tx,
        &sub_homework,
        &c1,
        "函数与导数 · 周末练习",
        "完成练习册 P42–P45，拍照上传完整的解题过程。重点复习导数的几何意义与链式法则。",
        "homework",
        Some(now + 2 * 86_400 + 4 * 3600),
        now - 2 * 86_400,
        &teacher1,
        "林书言",
    )?;
    seed_submission(
        &tx,
        &sub_sports,
        &c1,
        "秋季运动会报名",
        "10 月 30 日校园秋季运动会开始报名。请上传报名的项目与联系方式，每人最多报名两项。",
        "open call",
        Some(now + 4 * 86_400),
        now - 20 * 3600,
        &teacher1,
        "林书言",
    )?;
    seed_submission(
        &tx,
        &sub_leave,
        &c1,
        "研学活动请假申请",
        "11 月 5 日城市研学活动，无法参加的同学请提交请假申请并说明原因，需附家长签字。",
        "leave request",
        Some(now + 6 * 86_400),
        now - 5 * 3600,
        &teacher1,
        "林书言",
    )?;
    seed_submission(
        &tx,
        &sub_photo,
        &c1,
        "校园摄影展作品征集",
        "主题：秋日校园。上传一张原创摄影作品，并附 100 字以内的作品说明。",
        "open call",
        Some(now - 7 * 3600),
        now - 8 * 86_400,
        &teacher1,
        "林书言",
    )?;
    seed_submission(
        &tx,
        &sub_english,
        &c1,
        "英语单元测验订正",
        "Unit 3 单元测验订正，请在错题旁写出正确选项与解析，周一前提交。",
        "homework",
        Some(now + 30 * 3600),
        now - 3 * 86_400,
        &teacher1,
        "林书言",
    )?;
    seed_submission(
        &tx,
        &sub_physics,
        &c2,
        "物理实验报告 · 伏安特性曲线",
        "完成测量小灯泡伏安特性曲线的实验报告，附上数据表与图像。",
        "homework",
        Some(now + 3 * 86_400),
        now - 86_400,
        &admin2,
        "赵明远",
    )?;

    // 上传
    let up1 = new_id("up");
    seed_upload(
        &tx,
        &up1,
        &sub_homework,
        &c1,
        &stu1,
        Some(student),
        Some("G2603-01"),
        Some(1),
        "陈小满",
        ROLE_STUDENT,
        "周末练习 · 第 1 页",
        "完成练习册 P42–P45，第 3 题不太确定。",
        json!([
            demo_homework_svg("函数与导数 · 周末练习", "陈小满  G2603-01"),
            demo_text(
                "解题过程.txt",
                "1. 导数定义：f'(x)=lim...\n2. 第 3 题使用链式法则：...\n"
            )
        ]),
        now - 3 * 3600,
    )?;
    let up2 = new_id("up");
    seed_upload(
        &tx,
        &up2,
        &sub_homework,
        &c1,
        &stu2,
        None,
        Some("G2603-02"),
        Some(2),
        "李知遥",
        ROLE_STUDENT,
        "李知遥的周末练习",
        "已完成，请老师检查。",
        json!([demo_homework_svg(
            "函数与导数 · 周末练习",
            "李知遥  G2603-02"
        )]),
        now - 70 * 60,
    )?;
    let up3 = new_id("up");
    seed_upload(
        &tx,
        &up3,
        &sub_sports,
        &c1,
        &stu3,
        None,
        Some("G2603-03"),
        Some(3),
        "王浩然",
        ROLE_STUDENT,
        "运动会报名：100m / 跳远",
        "报名 100 米和跳远，联系方式：138****6721。",
        json!([demo_text(
            "运动会报名.txt",
            "姓名：王浩然\n学号：G2603-03\n项目：100m、跳远\n联系方式：138****6721\n"
        )]),
        now - 40 * 60,
    )?;
    let up4 = new_id("up");
    seed_upload(
        &tx,
        &up4,
        &sub_leave,
        &c1,
        &stu1,
        Some(student),
        Some("G2603-01"),
        Some(1),
        "陈小满",
        ROLE_STUDENT,
        "研学活动请假申请",
        "因家庭安排无法参加 11 月 5 日研学活动，家长已签字。",
        json!([demo_leave_svg("研学活动请假申请", "陈小满  G2603-01")]),
        now - 25 * 60,
    )?;
    let up5 = new_id("up");
    seed_upload(
        &tx,
        &up5,
        &sub_photo,
        &c1,
        &stu2,
        None,
        Some("G2603-02"),
        Some(2),
        "李知遥",
        ROLE_STUDENT,
        "秋日校园 · 银杏大道",
        "拍摄于周三傍晚的银杏大道，逆光下的落叶很有层次。",
        json!([demo_photo_svg("秋日校园 · 银杏大道", "摄影：李知遥")]),
        now - 10 * 3600,
    )?;
    let up6 = new_id("up");
    seed_upload(
        &tx,
        &up6,
        &sub_physics,
        &c2,
        &stu_c2,
        None,
        Some("G2601-01"),
        Some(1),
        "周雨桐",
        ROLE_STUDENT,
        "伏安特性曲线实验报告",
        "数据表和图像已整理，误差分析还需要补充。",
        json!([demo_homework_svg("物理实验报告", "周雨桐  G2601-01")]),
        now - 2 * 3600,
    )?;

    // 回复
    seed_reply(
        &tx,
        &new_id("rep"),
        &up1,
        &teacher1,
        "林书言",
        ROLE_TEACHER,
        "整体完成得很好：第 1、2 题步骤完整。第 3 题注意链式法则，已在上传第 2 页标出。",
        now - 2 * 3600,
    )?;
    seed_reply(
        &tx,
        &new_id("rep"),
        &up4,
        &admin1,
        "赵明远",
        ROLE_ADMIN,
        "已收到，课程笔记和研学手册请于返校后到教务处补领。",
        now - 10 * 60,
    )?;
    seed_reply(
        &tx,
        &new_id("rep"),
        &up5,
        &teacher1,
        "林书言",
        ROLE_TEACHER,
        "构图和光影都不错，建议投稿到本次摄影展。",
        now - 9 * 3600,
    )?;

    tx.commit()
}

fn seed_user(
    conn: &Connection,
    username: &str,
    password: &str,
    pubkey: &str,
    display_name: &str,
) -> rusqlite::Result<i64> {
    // 保留旧密码哈希用于兼容迁移；正常登录只使用公钥挑战。
    let salt = rand_string(16);
    let pwhash = hash_password(&salt, password);
    conn.execute(
        "INSERT INTO users (username, salt, pwhash, pubkey, display_name, prefs, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6)",
        params![username, salt, pwhash, pubkey, display_name, now_ts()],
    )?;
    Ok(conn.last_insert_rowid())
}

#[allow(clippy::too_many_arguments)]
fn seed_auth(
    conn: &Connection,
    id: &str,
    key: &str,
    class_id: &str,
    user_id: Option<i64>,
    role: &str,
    student_id: Option<&str>,
    short_id: Option<i64>,
    display_name: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO auths
         (id, key, class_id, user_id, role, student_id, short_id, display_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            key,
            class_id,
            user_id,
            role,
            student_id,
            short_id,
            display_name,
            now_ts()
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn seed_submission(
    conn: &Connection,
    id: &str,
    class_id: &str,
    name: &str,
    desc: &str,
    kind: &str,
    deadline: Option<i64>,
    created_at: i64,
    created_by: &str,
    created_name: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO submissions
         (id, class_id, name, desc, type, deadline, created_at, created_by, created_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            class_id,
            name,
            desc,
            kind,
            deadline,
            created_at,
            created_by,
            created_name
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn seed_upload(
    conn: &Connection,
    id: &str,
    submission_id: &str,
    class_id: &str,
    auth_id: &str,
    user_id: Option<i64>,
    student_id: Option<&str>,
    short_id: Option<i64>,
    uploader_name: &str,
    role: &str,
    title: &str,
    desc: &str,
    data: Value,
    created_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO uploads
         (id, submission_id, class_id, auth_id, user_id, student_id, short_id,
          uploader_name, role, title, desc, data, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            submission_id,
            class_id,
            auth_id,
            user_id,
            student_id,
            short_id,
            uploader_name,
            role,
            title,
            desc,
            data.to_string(),
            created_at
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn seed_reply(
    conn: &Connection,
    id: &str,
    upload_id: &str,
    auth_id: &str,
    replier_name: &str,
    role: &str,
    content: &str,
    created_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO replies (id, upload_id, auth_id, replier_name, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            upload_id,
            auth_id,
            replier_name,
            role,
            content,
            created_at
        ],
    )?;
    Ok(())
}

fn demo_attachment(name: &str, svg: &str) -> Value {
    json!({
        "name": name,
        "mime": "image/svg+xml",
        "data": b64_encode(svg.as_bytes())
    })
}

fn demo_text(name: &str, content: &str) -> Value {
    json!({
        "name": name,
        "mime": "text/plain",
        "data": b64_encode(content.as_bytes())
    })
}

fn demo_homework_svg(title: &str, subtitle: &str) -> Value {
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="880" height="620" viewBox="0 0 880 620">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#eef2ff"/>
  </linearGradient>
  <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
    <path d="M28 0H0V28" fill="none" stroke="#dbe3f4" stroke-width="1"/>
  </pattern>
</defs>
<rect width="880" height="620" rx="20" fill="url(#bg)"/>
<rect x="54" y="40" width="772" height="540" rx="14" fill="#ffffff" stroke="#dbe3f4"/>
<rect x="54" y="40" width="772" height="76" rx="14" fill="#eef2ff"/>
<rect x="54" y="102" width="772" height="14" fill="#eef2ff"/>
<text x="86" y="76" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="22" font-weight="700" fill="#312e81">{title}</text>
<text x="86" y="102" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="14" fill="#64748b">{subtitle}</text>
<rect x="86" y="140" width="708" height="408" fill="url(#grid)" rx="8"/>
<text x="108" y="180" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="16" fill="#334155">1. 求函数 f(x)=x³-3x 的单调区间与极值。</text>
<text x="108" y="214" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="15" fill="#475569">解：f'(x)=3x² - 3 = 3(x-1)(x+1)</text>
<text x="108" y="246" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="15" fill="#475569">令 f'(x)=0，得 x=±1；列表讨论符号变化……</text>
<line x1="108" y1="268" x2="760" y2="268" stroke="#e2e8f0"/>
<text x="108" y="306" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="16" fill="#334155">2. 已知曲线 y=x²+2x，求过点 (1,3) 的切线方程。</text>
<text x="108" y="340" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="15" fill="#475569">解：y'=2x+2，在 x=1 处斜率为 4，切线方程为 y-3=4(x-1)。</text>
<line x1="108" y1="362" x2="760" y2="362" stroke="#e2e8f0"/>
<circle cx="560" cy="430" r="60" fill="#f0fdf4" stroke="#86efac" stroke-width="2"/>
<circle cx="560" cy="430" r="46" fill="none" stroke="#22c55e" stroke-width="4" stroke-dasharray="220 80"/>
<text x="560" y="438" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="20" fill="#15803d">已检查</text>
<text x="108" y="500" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="14" fill="#94a3b8">第 3 题：注意链式法则，先对外层求导再乘内层导数。</text>
<text x="760" y="552" text-anchor="end" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="13" fill="#94a3b8">智慧校园 · 作业归档</text>
</svg>"##,
        title = title,
        subtitle = subtitle
    );
    demo_attachment("作业详情.svg", &svg)
}

fn demo_leave_svg(title: &str, subtitle: &str) -> Value {
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="880" height="620" viewBox="0 0 880 620">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fef7ed"/><stop offset="1" stop-color="#fff1f2"/>
  </linearGradient>
</defs>
<rect width="880" height="620" rx="20" fill="url(#bg)"/>
<rect x="70" y="48" width="740" height="524" rx="16" fill="#ffffff" stroke="#fde2e4"/>
<text x="440" y="116" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="30" font-weight="700" fill="#9f1239">{title}</text>
<text x="440" y="146" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="14" fill="#a16207">SMART CAMPUS · LEAVE REQUEST</text>
<line x1="120" y1="174" x2="760" y2="174" stroke="#fecdd3"/>
<text x="120" y="224" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="17" fill="#3f3f46">申请人：{subtitle}</text>
<text x="120" y="268" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="17" fill="#3f3f46">活动名称：城市研学 · 11 月 5 日</text>
<text x="120" y="312" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="17" fill="#3f3f46">请假原因：因家庭行程安排，无法参加本次研学活动。</text>
<text x="120" y="356" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="17" fill="#3f3f46">补课安排：返校后领取研学手册，并补齐课程笔记。</text>
<text x="120" y="406" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="14" fill="#71717a">本人已了解活动安排，并对请假期间的安全与学习负责。</text>
<rect x="120" y="440" width="240" height="58" rx="12" fill="#fff7ed" stroke="#fdba74"/>
<text x="240" y="466" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="13" fill="#c2410c">家长签字</text>
<text x="240" y="488" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="13" fill="#9a3412">陈女士 · 已确认</text>
<circle cx="672" cy="452" r="52" fill="none" stroke="#fb7185" stroke-width="3" opacity=".7"/>
<text x="672" y="459" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="16" fill="#e11d48">已提交</text>
<text x="760" y="540" text-anchor="end" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="13" fill="#a1a1aa">高一（3）班 · 智慧校园</text>
</svg>"##,
        title = title,
        subtitle = subtitle
    );
    demo_attachment("家长签字请假单.svg", &svg)
}

fn demo_photo_svg(title: &str, subtitle: &str) -> Value {
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7dd3fc"/><stop offset=".55" stop-color="#fde68a"/>
    <stop offset="1" stop-color="#fbbf24"/>
  </linearGradient>
  <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#92400e"/><stop offset="1" stop-color="#451a03"/>
  </linearGradient>
  <radialGradient id="sun" cx="50%" cy="50%" r="50%">
    <stop offset="0" stop-color="#fffbeb"/><stop offset="1" stop-color="#fbbf24"/>
  </radialGradient>
</defs>
<rect width="960" height="640" fill="url(#sky)"/>
<circle cx="740" cy="150" r="68" fill="url(#sun)"/>
<path d="M0 430 Q180 350 360 420 T720 400 T960 430 V640 H0 Z" fill="url(#ground)"/>
<g fill="#78350f" opacity=".9">
  <rect x="120" y="220" width="20" height="250" rx="8"/>
  <circle cx="130" cy="210" r="90" fill="#f59e0b"/>
  <circle cx="86" cy="250" r="70" fill="#fbbf24"/>
  <circle cx="178" cy="258" r="62" fill="#d97706"/>
</g>
<g fill="#a16207" opacity=".85">
  <rect x="420" y="260" width="16" height="220" rx="7"/>
  <circle cx="428" cy="250" r="76" fill="#fbbf24"/>
  <circle cx="386" cy="288" r="56" fill="#f59e0b"/>
  <circle cx="470" cy="286" r="52" fill="#eab308"/>
</g>
<g fill="#fcd34d" opacity=".9">
  <rect x="700" y="300" width="14" height="180" rx="6"/>
  <circle cx="707" cy="292" r="64" fill="#f59e0b"/>
  <circle cx="670" cy="322" r="46" fill="#fbbf24"/>
</g>
<g fill="#fde68a" opacity=".8">
  <circle cx="250" cy="480" r="7"/><circle cx="300" cy="520" r="5"/><circle cx="560" cy="500" r="6"/>
  <circle cx="620" cy="540" r="4"/><circle cx="840" cy="480" r="6"/><circle cx="90" cy="540" r="5"/>
</g>
<rect x="48" y="48" width="864" height="544" rx="20" fill="none" stroke="#fffbeb" stroke-width="2" opacity=".55"/>
<text x="90" y="104" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="34" font-weight="700" fill="#fffbeb">{title}</text>
<text x="90" y="138" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="16" fill="#fffbeb" opacity=".9">{subtitle}</text>
<text x="880" y="560" text-anchor="end" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="15" fill="#fffbeb" opacity=".85">AUTUMN · CAMPUS</text>
</svg>"##,
        title = title,
        subtitle = subtitle
    );
    demo_attachment("秋日校园.svg", &svg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{hash_password, now_ts, parse_time};

    fn temp_db() -> String {
        let path = format!("/tmp/smart-campus-test-{}.db", rand_string(8));
        path
    }

    #[test]
    fn seed_and_auth_lookup() {
        let path = temp_db();
        {
            let conn = open(&path).unwrap();
            let a = load_auth_by_key(&conn, DEMO_STUDENT_KEY).unwrap();
            assert_eq!(a.role, "student");
            assert_eq!(a.student_id.as_deref(), Some("G2603-01"));
            assert_eq!(a.class_name, "高一（3）班");
            let t = load_auth_by_key(&conn, DEMO_TEACHER_KEY).unwrap();
            assert!(t.is_staff());
            let adm = load_auth_by_key(&conn, DEMO_ADMIN_KEY).unwrap();
            assert!(adm.is_admin());
            let login = load_login_user(&conn, "student").unwrap();
            assert_eq!(login.username, "student");
            assert_eq!(login.pubkey.as_deref(), Some(DEMO_STUDENT_PUBKEY));
            let u = load_user_with_secret(&conn, "student").unwrap();
            assert_eq!(u.user.username, "student");
            let salt = u.salt.clone();
            assert_eq!(hash_password(&salt, "student123"), u.pwhash);
            assert_eq!(
                load_user_with_secret(&conn, "STUDENT").unwrap().user.id,
                u.user.id
            );
            assert!(load_auth_by_id(&conn, &a.id).is_some());
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn create_class_and_members() {
        let path = temp_db();
        {
            let conn = open(&path).unwrap();
            let admin = load_auth_by_key(&conn, DEMO_ADMIN_KEY).unwrap();
            let c = create_class(&conn, &admin, "测试班", "单元测试班级").unwrap();
            assert_eq!(c.code.len(), 6);
            let members = create_members(&conn, &admin, &admin.class_id, "Student", 2).unwrap();
            assert_eq!(members.len(), 2);
            let keys: Vec<&str> = members.iter().map(|m| m.key.as_str()).collect();
            assert!(keys.iter().all(|k| k.starts_with("SC-STU-")));
            let c2 = load_auth_by_key(&conn, &c.key).unwrap();
            assert_eq!(c2.class_id, c.id);
            assert!(c2.is_admin());
            // 不允许跨班新增
            assert!(create_members(&conn, &admin, &c.id, "Student", 1).is_err());
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn refresh_auth_moves_data_and_rotates_key() {
        let path = temp_db();
        {
            let conn = open(&path).unwrap();
            let teacher = load_auth_by_key(&conn, DEMO_TEACHER_KEY).unwrap();
            let student = load_auth_by_key(&conn, DEMO_STUDENT_KEY).unwrap();
            let user_id = student.user_id.expect("demo student is bound");

            let sub = insert_submission(&conn, &teacher, "轮换测试", "", "homework", None)
                .expect("submission");
            let up = insert_upload(&conn, &student, &sub, "作业", "", &serde_json::json!([]))
                .expect("upload");
            let rep = insert_reply(&conn, &teacher, &up, "收到").expect("reply");

            let old_key = student.key.clone();
            let old_id = student.id.clone();
            let new_key = refresh_auth(&conn, &student, user_id).expect("refresh student");
            assert_ne!(new_key, old_key);
            assert!(load_auth_by_key(&conn, &old_key).is_none());
            let rotated = load_auth_by_key(&conn, &new_key).expect("new auth");
            assert_ne!(rotated.id, old_id);
            assert_eq!(rotated.class_id, student.class_id);
            assert_eq!(rotated.role, student.role);
            assert_eq!(rotated.student_id, student.student_id);
            assert_eq!(rotated.short_id, student.short_id);
            assert_eq!(rotated.display_name, student.display_name);
            assert_eq!(rotated.user_id, student.user_id);

            // 旧 auth 名下的提交仍属于这个身份，并且能用新密钥读取。
            let (count, latest) = own_upload_info(&conn, &rotated, &sub);
            assert_eq!(count, 1);
            assert_eq!(latest.as_deref(), Some(up.as_str()));
            assert!(load_upload(&conn, &rotated, &up).is_some());
            // 回复是老师写的，不应被学生 auth 的轮换影响。
            let reply_auth: String = conn
                .query_row(
                    "SELECT auth_id FROM replies WHERE id = ?1",
                    params![rep],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(reply_auth, teacher.id);

            // 旧 auth 已删除，不能再次轮换。
            assert!(refresh_auth(&conn, &student, user_id).is_err());

            // 老师和征集创建者同样迁移 created_by / replies.auth_id。
            let old_teacher_key = teacher.key.clone();
            let new_teacher_key = refresh_auth(&conn, &teacher, teacher.user_id.expect("bound"))
                .expect("refresh teacher");
            assert_ne!(new_teacher_key, old_teacher_key);
            let teacher2 = load_auth_by_key(&conn, &new_teacher_key).expect("new teacher auth");
            let created_by: String = conn
                .query_row(
                    "SELECT created_by FROM submissions WHERE id = ?1",
                    params![sub],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(created_by, teacher2.id);
            let reply_auth: String = conn
                .query_row(
                    "SELECT auth_id FROM replies WHERE id = ?1",
                    params![rep],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(reply_auth, teacher2.id);
            assert!(load_submission(&conn, &teacher2, &sub).is_some());

            // 创建班级时记录的 auth 引用也要迁移。
            let admin = load_auth_by_key(&conn, DEMO_ADMIN_KEY).unwrap();
            let created = create_class(&conn, &admin, "轮换测试班", "").expect("class");
            let new_admin_key =
                refresh_auth(&conn, &admin, admin.user_id.expect("bound")).expect("refresh admin");
            let new_admin = load_auth_by_key(&conn, &new_admin_key).expect("new admin auth");
            let class_creator: Option<String> = conn
                .query_row(
                    "SELECT created_by FROM classes WHERE id = ?1",
                    params![created.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(class_creator.as_deref(), Some(new_admin.id.as_str()));
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn class_modes_define_and_resolve() {
        let path = temp_db();
        {
            let conn = open(&path).unwrap();
            let admin = load_auth_by_key(&conn, DEMO_ADMIN_KEY).unwrap();
            let teacher = load_auth_by_key(&conn, DEMO_TEACHER_KEY).unwrap();

            let mode = create_class_mode(
                &conn,
                &admin,
                "maths multiple-choise homework",
                &["homework".to_string(), "answer sheet".to_string()],
            )
            .expect("create mode");
            assert_eq!(mode.base_type, "answer sheet");
            assert_eq!(mode.extend_modes, vec!["homework", "answer sheet"]);

            let found = find_mode(&conn, &admin.class_id, "Maths_Multiple-Choise Homework")
                .expect("resolve custom mode");
            assert_eq!(found.name, mode.name);
            assert_eq!(found.base_type, "answer sheet");
            assert!(find_mode(&conn, &admin.class_id, "survey").is_some());
            assert!(find_mode(&conn, &admin.class_id, "not-defined").is_none());
            assert!(create_class_mode(&conn, &admin, &mode.name, &[]).is_err());
            assert!(create_class_mode(&conn, &admin, "bad extend", &["nope".to_string()]).is_err());
            assert_eq!(list_class_modes(&conn, &admin.class_id).len(), 1);

            // 自定义模式按 base_type 生效：答题卡校验与问卷表单都走 answer sheet。
            let desc = r#"1+1=<input id="form_q1" data-answer="2" data-score="5"/>"#;
            let sub = insert_submission_mode(
                &conn,
                &teacher,
                "自定义模式征集",
                desc,
                &mode.name,
                &mode.base_type,
                None,
            )
            .expect("insert submission");
            let (_, effective, _) = submission_meta(&conn, &sub).expect("meta");
            assert_eq!(effective, "answer sheet");
            let row = load_submission(&conn, &teacher, &sub).expect("row");
            assert_eq!(row.kind, mode.name);
            assert!(row.is_answer_sheet());
            assert!(row.is_form());
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn mode_visibility_inheritance_and_tabs() {
        let path = temp_db();
        {
            let conn = open(&path).unwrap();
            let admin = load_auth_by_key(&conn, DEMO_ADMIN_KEY).unwrap();
            let teacher = load_auth_by_key(&conn, DEMO_TEACHER_KEY).unwrap();
            let student = load_auth_by_key(&conn, DEMO_STUDENT_KEY).unwrap();

            // 单独列出类别 + 中文显示名称。
            let separate = create_class_mode_with_options(
                &conn,
                &admin,
                "weekly report",
                &["homework".to_string(), "separate list".to_string()],
                &ModeCreateOptions {
                    display_name: "每周汇报".to_string(),
                    ..ModeCreateOptions::default()
                },
            )
            .unwrap();
            assert!(separate.flags.separate_list);
            assert!(!separate.flags.abstract_mode);
            // 嵌套继承：子类别继承父类别的单独列出属性。
            let child = create_class_mode_with_options(
                &conn,
                &admin,
                "weekly report math",
                &["weekly report".to_string()],
                &ModeCreateOptions {
                    display_name: "数学周报".to_string(),
                    ..ModeCreateOptions::default()
                },
            )
            .unwrap();
            assert!(child.flags.separate_list);
            let child_info = find_mode(&conn, &admin.class_id, "数学周报").unwrap();
            assert!(child_info.ancestors.contains(&"weekly report".to_string()));
            // 菱形继承被拒绝：两个父模式共享祖先 homework。
            let cousin = create_class_mode_with_options(
                &conn,
                &admin,
                "weekly report english",
                &["homework".to_string()],
                &ModeCreateOptions::default(),
            )
            .unwrap();
            let diamond = create_class_mode_with_options(
                &conn,
                &admin,
                "bad diamond",
                &[
                    "weekly report".to_string(),
                    "weekly report english".to_string(),
                ],
                &ModeCreateOptions::default(),
            );
            assert!(diamond.is_err());
            assert!(cousin.flags.separate_list == false);

            // 抽象类别（内置「单独列出征集」）不能直接发布。
            let abstract_try =
                insert_submission_mode(&conn, &teacher, "抽象", "", "separate list", "other", None);
            assert!(abstract_try.is_ok()); // db 层不拦截，API 层拦截
            let hidden_mode = create_class_mode_with_options(
                &conn,
                &admin,
                "secret",
                &["homework".to_string(), "hidden".to_string()],
                &ModeCreateOptions {
                    display_name: "秘密".to_string(),
                    ..ModeCreateOptions::default()
                },
            )
            .unwrap();
            let invisible_mode = create_class_mode_with_options(
                &conn,
                &admin,
                "ghost",
                &["homework".to_string(), "invisible".to_string()],
                &ModeCreateOptions::default(),
            )
            .unwrap();
            assert!(invisible_mode.flags.invisible);
            // 抽象属性例外：不继承，必须在创建时显式声明。
            let abstract_mode = create_class_mode_with_options(
                &conn,
                &admin,
                "abstract category",
                &["separate list".to_string()],
                &ModeCreateOptions {
                    display_name: "抽象类别".to_string(),
                    abstract_mode: true,
                },
            )
            .unwrap();
            assert!(abstract_mode.flags.separate_list);
            assert!(abstract_mode.flags.abstract_mode);

            let normal =
                insert_submission_mode(&conn, &teacher, "普通", "", "homework", "homework", None)
                    .unwrap();
            let hidden = insert_submission_mode(
                &conn,
                &teacher,
                "隐藏",
                "",
                &hidden_mode.name,
                &hidden_mode.base_type,
                None,
            )
            .unwrap();
            let invisible = insert_submission_mode(
                &conn,
                &teacher,
                "不显示",
                "",
                &invisible_mode.name,
                &invisible_mode.base_type,
                None,
            )
            .unwrap();
            let tabbed = insert_submission_mode(
                &conn,
                &teacher,
                "周报",
                "",
                &separate.name,
                &separate.base_type,
                None,
            )
            .unwrap();
            // 单条征集可见性覆盖。
            let own_hidden = insert_submission_mode_flags(
                &conn,
                &teacher,
                "单条隐藏",
                "",
                "homework",
                "homework",
                None,
                &ModeFlags {
                    hidden: true,
                    ..ModeFlags::default()
                },
            )
            .unwrap();

            let teacher_default = list_submissions_visible(&conn, &teacher, 500, false, false);
            let teacher_names: Vec<&str> =
                teacher_default.iter().map(|r| r.name.as_str()).collect();
            assert!(teacher_names.contains(&"普通"));
            assert!(!teacher_names.contains(&"隐藏"));
            assert!(!teacher_names.contains(&"不显示"));
            assert!(teacher_names.contains(&"周报"));
            assert!(!teacher_names.contains(&"单条隐藏"));

            let teacher_hidden = list_submissions_visible(&conn, &teacher, 500, false, true);
            let hidden_names: Vec<&str> = teacher_hidden.iter().map(|r| r.name.as_str()).collect();
            assert!(hidden_names.contains(&"隐藏"));
            assert!(hidden_names.contains(&"单条隐藏"));
            assert!(!hidden_names.contains(&"不显示"));

            let student_shown = list_submissions_visible(&conn, &student, 500, false, true);
            assert!(student_shown.iter().any(|r| r.id == hidden));
            assert!(student_shown.iter().all(|r| r.id != invisible));

            let tabs = separate_mode_tabs(&conn, &admin.class_id, &teacher_hidden, "admin");
            let tab_names: Vec<&str> = tabs.iter().map(|t| t.display_name.as_str()).collect();
            assert!(tab_names.contains(&"每周汇报"));
            assert!(tab_names.contains(&"数学周报"));
            assert!(!tab_names.contains(&"单独列出征集"));

            let mut filtered = teacher_hidden.clone();
            filter_submissions_category(&conn, &admin.class_id, &mut filtered, "数学周报");
            assert!(filtered.iter().all(|r| r.name != "周报"));
            let mut filtered_all = teacher_hidden.clone();
            filter_submissions_category(&conn, &admin.class_id, &mut filtered_all, "每周汇报");
            assert!(filtered_all.iter().any(|r| r.id == tabbed));

            // 不可见征集仍可按 ID 直接访问 / 上传（角色允许时）。
            assert!(submission_access(&conn, &invisible).is_some());
            assert!(load_submission(&conn, &teacher, &invisible).is_some());
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn personal_queries_and_pending_priority() {
        let path = temp_db();
        {
            let conn = open(&path).unwrap();
            let teacher = load_auth_by_key(&conn, DEMO_TEACHER_KEY).unwrap();
            let admin = load_auth_by_key(&conn, DEMO_ADMIN_KEY).unwrap();
            let student = load_auth_by_key(&conn, DEMO_STUDENT_KEY).unwrap();

            let own_sub = insert_submission(&conn, &teacher, "我的征集", "", "homework", None)
                .expect("own submission");
            let other_sub = insert_submission(&conn, &admin, "其他征集", "", "homework", None)
                .expect("other submission");
            let own_up = insert_upload(&conn, &student, &own_sub, "我的提交", "", &json!([]))
                .expect("own upload");
            let other_up = insert_upload(&conn, &student, &other_sub, "其他提交", "", &json!([]))
                .expect("other upload");

            let mine = list_my_uploads(&conn, &student, None, None, 100, true);
            assert!(mine.iter().any(|u| u.id == own_up));
            assert!(mine.iter().any(|u| u.id == other_up));
            let only_one = list_my_uploads(&conn, &student, Some(&own_sub), None, 100, true);
            assert_eq!(only_one.len(), 1);
            assert_eq!(only_one[0].id, own_up);
            let one_upload = list_my_uploads(&conn, &student, None, Some(&other_up), 100, true);
            assert_eq!(one_upload.len(), 1);

            let subs = list_my_submissions(&conn, &teacher, 100);
            assert!(subs.iter().any(|s| s.id == own_sub));
            assert!(!subs.iter().any(|s| s.id == other_sub));

            // 待回复提交：老师自己发布的征集优先。
            let pending = list_uploads(&conn, &teacher, Some("pending"), 100, true, true);
            assert_eq!(
                pending.first().map(|u| u.id.as_str()),
                Some(own_up.as_str())
            );
            assert!(pending.iter().any(|u| u.id == other_up));
            assert!(pending
                .iter()
                .find(|u| u.id == own_up)
                .is_some_and(|u| u.submission_created_by.as_deref() == Some(teacher.id.as_str())));
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn time_helpers_smoke() {
        let t = parse_time("2026-11-01T20:00").unwrap();
        assert_eq!(crate::tools::fmt_datetime(t), "2026-11-01 20:00");
    }

    #[test]
    fn notice_pinned_until_deadline() {
        let path = temp_db();
        {
            let conn = open(&path).unwrap();
            let teacher = load_auth_by_key(&conn, DEMO_TEACHER_KEY).unwrap();
            let now = now_ts();
            let regular = insert_submission(
                &conn,
                &teacher,
                "普通征集",
                "",
                "homework",
                Some(now + 86_400),
            )
            .unwrap();
            let notice = insert_submission(
                &conn,
                &teacher,
                "公示通知",
                "",
                "notice",
                Some(now + 172_800),
            )
            .unwrap();
            let expired = insert_submission(
                &conn,
                &teacher,
                "过期公示",
                "",
                "notice",
                Some(now - 86_400),
            )
            .unwrap();

            let rows = list_submissions(&conn, &teacher, 500, false);
            assert_eq!(rows[0].id, notice);
            assert!(rows[0].is_pinned_notice(now));
            assert!(rows.iter().any(|row| row.id == regular));
            assert!(!rows
                .iter()
                .find(|row| row.id == expired)
                .unwrap()
                .is_pinned_notice(now));
        }
        let _ = std::fs::remove_file(&path);
    }
}
