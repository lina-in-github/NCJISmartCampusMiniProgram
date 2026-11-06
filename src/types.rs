use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ROLE_STUDENT: &str = "student";
pub const ROLE_TEACHER: &str = "teacher";
pub const ROLE_ADMIN: &str = "admin";

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<crate::db::Database>,
    /// 角色会话：sc_sid cookie -> session（包含当前 auth）
    pub sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// 账号会话：sc_uid cookie -> user id（用于 /user 账号中心）
    pub user_sessions: Arc<Mutex<HashMap<String, i64>>>,
    /// 非对称登录的临时挑战会话：loginSessionID -> 挑战与状态。
    pub login_sessions: Arc<Mutex<HashMap<String, LoginSession>>>,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub auth_id: String,
    /// 页面角色：parent / student / teacher / admin
    pub page_role: String,
    pub mode: String,
    pub created_at: i64,
}

/// `/api/login-try` 创建的一次性挑战会话（保存在内存，5 分钟有效）。
#[derive(Clone, Debug)]
pub struct LoginSession {
    pub user_id: i64,
    pub challenge: Vec<u8>,
    pub answer_key: Vec<u8>,
    pub created_at: i64,
    /// 是否已经通过挑战验证（get-auths / reset-password 会置位）。
    pub verified: bool,
    pub attempts: u8,
}

#[derive(Clone, Debug)]
pub struct AuthCtx {
    pub id: String,
    pub key: String,
    pub class_id: String,
    pub class_name: String,
    pub class_desc: String,
    pub user_id: Option<i64>,
    pub role: String,
    pub student_id: Option<String>,
    pub short_id: Option<i64>,
    pub display_name: String,
}

impl AuthCtx {
    pub fn is_staff(&self) -> bool {
        self.role == ROLE_TEACHER || self.role == ROLE_ADMIN
    }

    pub fn is_admin(&self) -> bool {
        self.role == ROLE_ADMIN
    }

    pub fn is_student(&self) -> bool {
        self.role == ROLE_STUDENT
    }

    pub fn identity(&self) -> String {
        if self.display_name.trim().is_empty() {
            match self.role.as_str() {
                ROLE_ADMIN => crate::strings::t("identity_admin"),
                ROLE_TEACHER => crate::strings::t("identity_teacher"),
                _ => match &self.student_id {
                    Some(id) => crate::strings::f1("identity_student_id", id),
                    None => crate::strings::t("identity_student"),
                },
            }
        } else {
            self.display_name.clone()
        }
    }

    pub fn page_role(&self) -> &'static str {
        match self.role.as_str() {
            ROLE_ADMIN => "admin",
            ROLE_TEACHER => "teacher",
            _ => "student",
        }
    }

    pub fn student_no(&self) -> String {
        match (&self.student_id, self.short_id) {
            (Some(id), Some(short)) => {
                crate::strings::f2("student_no_full", id, format!("{short:02}"))
            }
            (Some(id), None) => id.clone(),
            (None, Some(short)) => crate::strings::f1("student_no_short", format!("{short:02}")),
            _ => String::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct UserCtx {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub prefs: Prefs,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Prefs {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    /// 学生身份的展示视角：`student`（我）/ `parent`（孩子）。
    /// 只是前台展示偏好：数据范围仍由班级密钥（auth）与角色决定，API 不受影响。
    #[serde(default = "default_view")]
    pub view: String,
}

fn default_theme() -> String {
    "system".to_string()
}
fn default_mode() -> String {
    "mob".to_string()
}
fn default_view() -> String {
    VIEW_STUDENT.to_string()
}

/// 学生身份的前台展示视角。
pub const VIEW_STUDENT: &str = "student";
pub const VIEW_PARENT: &str = "parent";

impl Prefs {
    /// 学生身份进入班级空间时使用的页面角色（老师/管理员不受影响）。
    pub fn student_page_role(&self) -> &'static str {
        if self.view == VIEW_PARENT {
            VIEW_PARENT
        } else {
            VIEW_STUDENT
        }
    }
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            mode: default_mode(),
            view: default_view(),
        }
    }
}

impl Prefs {
    pub fn from_json(raw: &str) -> Self {
        let mut p: Prefs = serde_json::from_str(raw).unwrap_or_default();
        p.sanitize();
        p
    }

    pub fn sanitize(&mut self) {
        self.theme = match self.theme.as_str() {
            "light" | "dark" | "system" => self.theme.clone(),
            _ => "system".to_string(),
        };
        self.mode = match self.mode.as_str() {
            "mob" | "pc" => self.mode.clone(),
            _ => "mob".to_string(),
        };
        self.view = match self.view.as_str() {
            VIEW_STUDENT | VIEW_PARENT => self.view.clone(),
            _ => VIEW_STUDENT.to_string(),
        };
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

// ---------------------------------------------------------------------------
// 页面 / API 视图
// ---------------------------------------------------------------------------

/// 征集模式的可见性 / 列表属性。
///
/// 这些属性定义在「征集模式」上，并通过继承向下传递；`abstract_mode`
/// 表示抽象模式，不能直接用于征集，只能被其他模式继承（不向下传递）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModeFlags {
    /// 隐藏征集：仅在 `show-hiddens` 打开时出现在全部征集列表。
    #[serde(default)]
    pub hidden: bool,
    /// 仅教师征集：学生不可见（管理员可见）。
    #[serde(default)]
    pub teacher_only: bool,
    /// 仅管理员征集：只有管理员可见。
    #[serde(default)]
    pub admin_only: bool,
    /// 不显示征集：永不进入全部征集列表，只能按征集 ID 直接访问。
    #[serde(default)]
    pub invisible: bool,
    /// 单独列出征集：在全部征集列表头部生成独立标签页。
    #[serde(default)]
    pub separate_list: bool,
    /// 抽象类别：不能直接发布，只能被继承。
    #[serde(default)]
    pub abstract_mode: bool,
}

impl ModeFlags {
    /// 该角色是否在业务上可访问（直接按 ID 访问也适用）。
    /// `hidden` / `invisible` 只影响列表，不影响按 ID 直接访问。
    pub fn can_view(&self, role: &str) -> bool {
        if self.admin_only {
            role == ROLE_ADMIN
        } else if self.teacher_only {
            role != ROLE_STUDENT
        } else {
            true
        }
    }

    /// 该角色是否可以在「全部征集」列表中看到（不含分类过滤）。
    pub fn listed(&self, role: &str, show_hiddens: bool) -> bool {
        self.can_view(role) && !self.invisible && (!self.hidden || show_hiddens)
    }

    /// 该角色是否可以直接发布该模式。
    pub fn can_publish(&self, role: &str) -> bool {
        if self.abstract_mode {
            return false;
        }
        if self.admin_only {
            role == ROLE_ADMIN
        } else {
            role == ROLE_TEACHER || role == ROLE_ADMIN
        }
    }

    /// 继承时合并父模式属性；抽象属性不继承。
    pub fn inherit_from(&mut self, parent: &ModeFlags) {
        self.hidden |= parent.hidden;
        self.teacher_only |= parent.teacher_only;
        self.admin_only |= parent.admin_only;
        self.invisible |= parent.invisible;
        self.separate_list |= parent.separate_list;
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "hidden": self.hidden,
            "teacherOnly": self.teacher_only,
            "adminOnly": self.admin_only,
            "invisible": self.invisible,
            "separateList": self.separate_list,
            "abstract": self.abstract_mode,
        })
    }
}

/// 「单独列出」标签页。
#[derive(Clone, Debug, Default)]
pub struct ModeTab {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub normalized: String,
    pub count: i64,
}

impl ModeTab {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "modeName": self.name,
            "displayName": self.display_name,
            "normalized": self.normalized,
            "count": self.count,
            "separateList": true,
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct SubmissionRow {
    pub id: String,
    pub name: String,
    pub desc: String,
    /// 征集类型：内置模式名或班级自定义模式名。
    pub kind: String,
    /// 自定义模式的行为基类（`survey` / `answer sheet` / `notice` 等）。
    /// 内置模式为空，直接使用 `kind`。
    pub base_kind: Option<String>,
    /// 模式的显示名称（支持中文）。
    pub display_name: String,
    /// 模式可见性（含继承）。
    pub flags: ModeFlags,
    /// 模式继承链（含自身，规范化名称），用于分类标签过滤。
    pub mode_ancestors: Vec<String>,
    pub deadline: Option<i64>,
    pub created_at: i64,
    pub created_by: Option<String>,
    pub created_name: String,
    pub upload_count: i64,
    pub my_upload_count: i64,
    pub pending_count: i64,
    pub last_upload_id: Option<String>,
}

impl SubmissionRow {
    /// 生效的行为类型：自定义模式用 `base_kind`，内置 / 旧数据用 `kind`。
    pub fn effective_kind(&self) -> &str {
        match &self.base_kind {
            Some(base) if !base.trim().is_empty() => base,
            _ => &self.kind,
        }
    }

    /// 公示版（notice）只展示详情，不开放作业提交。
    pub fn is_notice(&self) -> bool {
        self.effective_kind().trim().eq_ignore_ascii_case("notice")
    }

    /// 问卷模式：简介中可包含表单控件，提交时自动组装 JSON 答案。
    pub fn is_survey(&self) -> bool {
        crate::survey::kind_mode(self.effective_kind()) == Some(crate::survey::Mode::Survey)
    }

    /// 答题卡模式：问卷的派生模式，所有题目必填，提交时由前端自动批改。
    pub fn is_answer_sheet(&self) -> bool {
        crate::survey::kind_mode(self.effective_kind()) == Some(crate::survey::Mode::AnswerSheet)
    }

    /// 是否为「简介里写表单」的征集（问卷 / 答题卡）。
    pub fn is_form(&self) -> bool {
        crate::survey::kind_mode(self.effective_kind()).is_some()
    }

    /// 公示版在截止时间前置顶；未设置截止时间的公示长期有效。
    pub fn is_pinned_notice(&self, now: i64) -> bool {
        self.is_notice() && self.deadline.map_or(true, |deadline| deadline > now)
    }
}

#[derive(Clone, Debug, Default)]
pub struct UploadRow {
    pub id: String,
    pub submission_id: String,
    pub submission_name: String,
    /// 所属征集的创建者 auth ID（用于「我发布的征集」优先排序 / 标记）。
    pub submission_created_by: Option<String>,
    pub submission_created_name: String,
    pub title: String,
    pub desc: String,
    pub data: Value,
    pub created_at: i64,
    pub uploader_name: String,
    pub student_id: Option<String>,
    pub short_id: Option<i64>,
    pub role: String,
    pub auth_id: Option<String>,
    pub reply_count: i64,
    pub last_reply_at: Option<i64>,
}

/// 班级自定义征集模式。
#[derive(Clone, Debug, Default)]
pub struct ClassModeRow {
    pub id: String,
    pub name: String,
    pub normalized: String,
    pub display_name: String,
    pub extend_modes: Vec<String>,
    pub base_type: String,
    pub flags: ModeFlags,
    pub created_at: i64,
    pub created_by: Option<String>,
    pub created_name: String,
}

impl ClassModeRow {
    pub fn to_json(&self) -> Value {
        let mut value = serde_json::json!({
            "id": self.id,
            "name": self.name,
            "modeName": self.name,
            "displayName": self.effective_display_name(),
            "baseType": self.base_type,
            "extendModes": self.extend_modes,
            "createdAt": crate::tools::fmt_iso(self.created_at),
            "createdBy": self.created_name,
            "createdByID": self.created_by,
            "normalized": self.normalized,
            "builtin": false,
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
                Value::String(visibility_name(&self.flags)),
            );
        }
        value
    }

    pub fn effective_display_name(&self) -> String {
        if self.display_name.trim().is_empty() {
            self.name.clone()
        } else {
            self.display_name.clone()
        }
    }
}

/// 可见性枚举的稳定英文标识（API 输出）。
pub fn visibility_name(flags: &ModeFlags) -> String {
    if flags.admin_only {
        "admin_only".to_string()
    } else if flags.teacher_only {
        "teacher_only".to_string()
    } else if flags.invisible {
        "invisible".to_string()
    } else if flags.hidden {
        "hidden".to_string()
    } else {
        "normal".to_string()
    }
}

#[derive(Clone, Debug, Default)]
pub struct ReplyRow {
    pub id: String,
    pub content: String,
    pub replier_name: String,
    pub role: String,
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// API 请求体
// ---------------------------------------------------------------------------

/// JSON 中的 `byte[]`：既接受标准 base64 字符串，也接受 0–255 的整数数组。
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum ByteInput {
    Text(String),
    Array(Vec<u8>),
}

impl ByteInput {
    pub fn decode(&self) -> Result<Vec<u8>, String> {
        match self {
            ByteInput::Text(text) => crate::crypto::b64_decode(text),
            ByteInput::Array(bytes) => Ok(bytes.clone()),
        }
    }
}

#[derive(Deserialize)]
pub struct LoginTryReq {
    #[serde(alias = "user", alias = "name")]
    pub username: String,
}

#[derive(Deserialize)]
pub struct GetAuthsReq {
    #[serde(
        rename = "loginSessionID",
        alias = "login_session_id",
        alias = "loginSessionId",
        alias = "id"
    )]
    pub login_session_id: String,
    #[serde(rename = "encryptedAnswer", alias = "encrypted_answer")]
    pub encrypted_answer: ByteInput,
}

/// `/api/refresh-key`：账号挑战 + 旧 auth 密钥，用于 auth 泄漏后的密钥轮换。
#[derive(Deserialize)]
pub struct RefreshKeyReq {
    #[serde(
        rename = "loginSessionID",
        alias = "login_session_id",
        alias = "loginSessionId",
        alias = "id"
    )]
    pub login_session_id: String,
    #[serde(rename = "encryptedAnswer", alias = "encrypted_answer")]
    pub encrypted_answer: ByteInput,
    #[serde(rename = "authRefreshing", alias = "auth_refreshing", alias = "auth")]
    pub auth_refreshing: String,
}

/// `/multi-api`：批量调用内部 API。
#[derive(Deserialize)]
pub struct MultiApiReq {
    pub apis: Vec<Value>,
}

#[derive(Deserialize)]
pub struct ResetPasswordReq {
    #[serde(
        rename = "loginSessionID",
        alias = "login_session_id",
        alias = "loginSessionId",
        alias = "id"
    )]
    pub login_session_id: String,
    #[serde(rename = "encryptedAnswer", alias = "encrypted_answer")]
    pub encrypted_answer: ByteInput,
    #[serde(
        rename = "newPasswordPubKey",
        alias = "new_password_pub_key",
        alias = "newPasswordPubkey",
        alias = "new_password_pubkey",
        alias = "pubkey",
        alias = "publicKey"
    )]
    pub new_password_pub_key: ByteInput,
}

#[derive(Deserialize)]
pub struct RegisterReq {
    pub username: String,
    #[serde(
        rename = "passwordPubKey",
        alias = "password_pub_key",
        alias = "passwordPubkey",
        alias = "pubkey",
        alias = "pubKey",
        alias = "publicKey"
    )]
    pub pubkey: ByteInput,
    #[serde(default)]
    pub key: String,
    #[serde(default, rename = "displayName", alias = "display_name")]
    pub display_name: String,
}

#[derive(Deserialize)]
pub struct UpgradePubkeyReq {
    pub username: String,
    pub password: String,
    #[serde(rename = "pubkey", alias = "publicKey", alias = "passwordPubKey")]
    pub pubkey: ByteInput,
}

#[derive(Deserialize)]
pub struct UploadReq {
    pub auth: String,
    pub which: String,
    pub title: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub data: Value,
}

#[derive(Deserialize)]
pub struct DownloadReq {
    pub auth: String,
    pub which: String,
    #[serde(default, rename = "match_mode", alias = "matchMode")]
    pub match_mode: Option<Value>,
}

#[derive(Deserialize)]
pub struct NewSubmissionReq {
    pub auth: String,
    pub name: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default, rename = "type", alias = "mode", alias = "modeName")]
    pub kind: String,
    #[serde(default, rename = "deadLine", alias = "deadline")]
    pub deadline: Option<Value>,
    /// 单条征集的可见性覆盖（可选；与模式属性取并集）。
    #[serde(default)]
    pub hidden: bool,
    #[serde(default, rename = "teacherOnly", alias = "teacher_only")]
    pub teacher_only: bool,
    #[serde(default, rename = "adminOnly", alias = "admin_only")]
    pub admin_only: bool,
    #[serde(
        default,
        rename = "invisible",
        alias = "notListed",
        alias = "not_listed"
    )]
    pub invisible: bool,
}

/// `/api/new-mode`：管理员为班级新增一个自定义征集模式。
#[derive(Deserialize)]
pub struct NewModeReq {
    pub auth: String,
    #[serde(default, rename = "modeName", alias = "mode_name", alias = "name")]
    pub mode_name: String,
    /// 显示名称（支持中文）；为空时使用 `modeName`。
    #[serde(
        default,
        rename = "displayName",
        alias = "display_name",
        alias = "label"
    )]
    pub display_name: String,
    #[serde(
        default,
        rename = "extendModes",
        alias = "extend_modes",
        alias = "extends"
    )]
    pub extend_modes: Vec<String>,
    /// 抽象类别：不能直接发布，只能被继承。
    /// 可见性（隐藏 / 仅教师 / 仅管理员 / 不显示 / 单独列出）不再单独传字段，
    /// 而是在 `extendModes` 中继承对应的内置模式。
    #[serde(
        default,
        rename = "abstract",
        alias = "abstractMode",
        alias = "abstract_mode"
    )]
    pub abstract_mode: bool,
}

/// `/api/all-modes`：列出班级可用的征集模式（内置 + 自定义）。
#[derive(Deserialize)]
pub struct AllModesReq {
    pub auth: String,
}

/// `/api/del-mode`：管理员删除班级自定义征集模式。
#[derive(Deserialize)]
pub struct DelModeReq {
    pub auth: String,
    /// 模式 ID（`mode_*`）。与 `modeName` 至少填一个。
    #[serde(default, rename = "id", alias = "modeID", alias = "mode_id")]
    pub id: String,
    /// 模式名称（也接受显示名称）。与 `id` 至少填一个。
    #[serde(default, rename = "modeName", alias = "mode_name", alias = "name")]
    pub mode_name: String,
    /// 已有征集引用该模式时是否仍然删除（默认拒绝）。
    #[serde(default, alias = "forceDelete", alias = "force_delete")]
    pub force: bool,
}

/// `/api/my-uploads`：查询当前身份的提交；支持按征集 / 提交 ID 过滤。
#[derive(Deserialize)]
pub struct MyUploadsReq {
    pub auth: String,
    #[serde(default, rename = "match_mode", alias = "matchMode")]
    pub match_mode: Option<Value>,
    #[serde(
        default,
        rename = "submissionID",
        alias = "submission_id",
        alias = "submissionId",
        alias = "which"
    )]
    pub submission_id: Option<String>,
    #[serde(
        default,
        rename = "uploadID",
        alias = "upload_id",
        alias = "uploadId",
        alias = "id"
    )]
    pub upload_id: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// `/api/my-submissions`：查询当前身份发布的征集。
#[derive(Deserialize)]
pub struct MySubmissionsReq {
    pub auth: String,
    #[serde(default, rename = "match_mode", alias = "matchMode")]
    pub match_mode: Option<Value>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// `/api/pending-uploads`：教职工查看待回复提交，优先自己发布的征集。
#[derive(Deserialize)]
pub struct PendingUploadsReq {
    pub auth: String,
    #[serde(default, rename = "ownOnly", alias = "own_only")]
    pub own_only: bool,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct AllSubmissionReq {
    pub auth: String,
    #[serde(default, rename = "match_mode", alias = "matchMode")]
    pub match_mode: Option<Value>,
    /// 需求中的 `show-hiddens`：打开后才在全部征集列表显示隐藏征集。
    /// 使用 Value 以同时兼容布尔 / 字符串 / 数字写法。
    #[serde(
        default,
        rename = "show-hiddens",
        alias = "showHiddens",
        alias = "show_hiddens",
        alias = "showHidden",
        alias = "show_hidden"
    )]
    pub show_hiddens: Option<Value>,
    /// 只查看某个「单独列出」类别（模式名或显示名称）。
    #[serde(
        default,
        rename = "category",
        alias = "tab",
        alias = "separateList",
        alias = "separate_list",
        alias = "mode",
        alias = "type"
    )]
    pub category: Option<String>,
    /// 按征集 ID 直接读取：不受隐藏 / 不显示影响（仅按角色校验可见性）。
    #[serde(
        default,
        rename = "submissionID",
        alias = "submission_id",
        alias = "submissionId",
        alias = "id",
        alias = "which"
    )]
    pub submission_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ReplyReq {
    pub auth: String,
    #[serde(rename = "uploadID", alias = "upload_id", alias = "uploadId")]
    pub upload_id: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct NewClassReq {
    pub auth: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Deserialize)]
pub struct NewUserReq {
    pub auth: String,
    #[serde(rename = "classID", alias = "class_id", alias = "classId")]
    pub class_id: String,
    pub quantity: i64,
    #[serde(default, rename = "type")]
    pub kind: String,
}

#[derive(Deserialize)]
pub struct DelKeyReq {
    pub auth: String,
}

#[derive(Deserialize)]
pub struct RenameAuthReq {
    pub auth: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Deserialize)]
pub struct DelObjectReq {
    /// 官方接口只要求 id；auth 可选（缺省时回退到登录 cookie）。
    #[serde(default)]
    pub auth: Option<String>,
    pub id: String,
    /// 删除征集模式时，是否在仍有征集引用的情况下强制删除（默认拒绝）。
    #[serde(default, alias = "forceDelete", alias = "force_delete")]
    pub force: bool,
}

// ---------------------------------------------------------------------------
// 页面表单
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct UserLoginForm {
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct UserRegisterForm {
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub password2: String,
    /// 无 JS 兜底：客户端提前算好的 X25519 公钥（base64）。
    #[serde(default)]
    pub pubkey: String,
    #[serde(default)]
    pub key: String,
}

#[derive(Deserialize)]
pub struct ClaimForm {
    #[serde(default)]
    pub key: String,
}

#[derive(Deserialize)]
pub struct PrefsForm {
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub theme: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub view: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct PasswordForm {
    #[serde(default)]
    pub old: String,
    #[serde(default)]
    pub new: String,
    #[serde(default)]
    pub new2: String,
}

#[derive(Deserialize)]
pub struct EnterClassForm {
    pub auth_id: String,
}

#[derive(Deserialize)]
pub struct ClassForm {
    pub admin_auth_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub desc: String,
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_sanitize() {
        let mut p = Prefs {
            theme: "neon".into(),
            mode: "watch".into(),
            view: "everyone".into(),
        };
        p.sanitize();
        assert_eq!(p.theme, "system");
        assert_eq!(p.mode, "mob");
        assert_eq!(p.view, VIEW_STUDENT);
        assert_eq!(p.student_page_role(), "student");

        let mut parent = Prefs {
            view: VIEW_PARENT.into(),
            ..Prefs::default()
        };
        parent.sanitize();
        assert_eq!(parent.student_page_role(), "parent");
        // 老版本 prefs JSON 没有 view 字段时回退到学生视角
        let legacy = Prefs::from_json("{\"theme\":\"dark\",\"mode\":\"pc\"}");
        assert_eq!(legacy.view, VIEW_STUDENT);
    }

    fn init_test_strings() {
        if crate::strings::stats().0 == 0 {
            let path = std::env::temp_dir().join(format!(
                "smart-campus-types-{}-strings.db",
                std::process::id()
            ));
            let _ = crate::strings::init(
                concat!(env!("CARGO_MANIFEST_DIR"), "/strings"),
                &path.to_string_lossy(),
                "zh-CN",
            );
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn byte_input_accepts_base64_and_arrays() {
        let from_text: ByteInput = serde_json::from_str("\"aGVsbG8=\"").unwrap();
        assert_eq!(from_text.decode().unwrap(), b"hello");
        let from_array: ByteInput = serde_json::from_str("[104,101,108,108,111]").unwrap();
        assert_eq!(from_array.decode().unwrap(), b"hello");
    }

    #[test]
    fn auth_identity_fallback() {
        init_test_strings();
        let a = AuthCtx {
            id: "auth".into(),
            key: "k".into(),
            class_id: "c".into(),
            class_name: "c".into(),
            class_desc: String::new(),
            user_id: None,
            role: "student".into(),
            student_id: Some("G2603-01".into()),
            short_id: Some(1),
            display_name: String::new(),
        };
        assert_eq!(a.identity(), "学生 G2603-01");
        assert_eq!(a.student_no(), "G2603-01 · 01 号");
        assert!(a.is_student());
    }
}
