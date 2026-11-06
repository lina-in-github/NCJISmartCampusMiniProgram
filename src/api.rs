use axum::{
    body::to_bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rand::seq::SliceRandom;
use regex::Regex;
use serde_json::{json, Value};

use crate::crypto;
use crate::db;
use crate::tools::{
    api_bad, api_forbidden, api_not_found, api_ok, api_unauthorized, clean_display_name,
    constant_time_eq, cookie_value, create_user_session, fmt_iso, hash_password,
    invalidate_auth_sessions, normalize_data, now_ts, parse_deadline_value, parse_match_mode,
    role_session, session_cookie, valid_username, MatchMode, USID_COOKIE,
};
use crate::types::{
    AllModesReq, AllSubmissionReq, AppState, AuthCtx, ByteInput, DelKeyReq, DelObjectReq,
    DownloadReq, GetAuthsReq, LoginSession, LoginTryReq, MultiApiReq, MySubmissionsReq,
    MyUploadsReq, NewClassReq, NewModeReq, NewSubmissionReq, NewUserReq, PendingUploadsReq,
    RefreshKeyReq, RegisterReq, RenameAuthReq, ReplyReq, ResetPasswordReq, SubmissionRow,
    UpgradePubkeyReq, UploadReq, UploadRow,
};

const MAX_TITLE: usize = 200;
const MAX_DESC: usize = 5_000;
const MAX_SUBMISSION_DESC: usize = 2_000;
/// 登录挑战有效期（秒）。
const LOGIN_SESSION_TTL: i64 = 300;
/// 单个登录会话允许的错误尝试次数。
const MAX_LOGIN_ATTEMPTS: u8 = 5;

// ---------------------------------------------------------------------------
// 公共辅助
// ---------------------------------------------------------------------------

#[allow(clippy::result_large_err)]
fn require_auth(st: &AppState, key: &str) -> Result<AuthCtx, Response> {
    if key.trim().is_empty() {
        return Err(api_unauthorized("missing auth parameter"));
    }
    let db = st.db.lock().unwrap();
    db::load_auth_by_key(&db, key).ok_or_else(|| api_unauthorized("invalid or expired auth"))
}

// ---------------------------------------------------------------------------
// /api/upload
// ---------------------------------------------------------------------------

pub async fn upload(State(st): State<AppState>, Json(req): Json<UploadReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let title = req.title.trim().to_string();
    let desc = req.desc.trim().to_string();
    if title.is_empty() {
        return api_bad("title must not be empty");
    }
    if title.chars().count() > MAX_TITLE {
        return api_bad(format!("title is too long (max {MAX_TITLE} characters)"));
    }
    if desc.chars().count() > MAX_DESC {
        return api_bad(format!("desc is too long (max {MAX_DESC} characters)"));
    }
    let data = match normalize_data(req.data) {
        Ok(d) => d,
        Err(e) => return api_bad(e),
    };

    let db = st.db.lock().unwrap();
    match db::submission_meta_access(&db, &req.which) {
        Some((class_id, kind, form_desc, flags)) if class_id == auth.class_id => {
            if !flags.can_view(&auth.role) {
                return api_not_found("submission not found");
            }
            if kind.trim().eq_ignore_ascii_case("notice") {
                return api_forbidden("uploads are disabled for notice submissions");
            }
            // 问卷 / 答题卡：简介里的必填项在服务端再校验一次（answer 为 JSON 对象时）。
            // 答题卡模式下所有题目都必填。
            if let Some(err) = crate::survey::validate_submission(&kind, &form_desc, &desc) {
                return api_bad(err);
            }
        }
        Some(_) => return api_not_found("submission does not belong to the current class"),
        None => return api_not_found("submission not found"),
    }
    match db::insert_upload(&db, &auth, &req.which, &title, &desc, &data) {
        Ok(id) => api_ok(json!({ "ok": true, "id": id })),
        Err(e) => crate::tools::api_err(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("upload failed: {e}"),
        ),
    }
}

// ---------------------------------------------------------------------------
// /api/download
// ---------------------------------------------------------------------------

pub async fn download(State(st): State<AppState>, Json(req): Json<DownloadReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !auth.is_staff() {
        return api_forbidden("only teachers or admins can download class submissions");
    }
    let mode = match parse_match_mode(req.match_mode.as_ref()) {
        Ok(m) => m,
        Err(e) => return api_bad(e),
    };

    let db = st.db.lock().unwrap();
    match db::submission_access(&db, &req.which) {
        Some((c, flags)) if c == auth.class_id => {
            if !flags.can_view(&auth.role) {
                return api_not_found("submission not found");
            }
        }
        Some(_) => return api_not_found("submission does not belong to the current class"),
        None => return api_not_found("submission not found"),
    }

    let mut rows = db::list_download_uploads(&db, &req.which);

    match mode {
        MatchMode::All => {}
        MatchMode::Random(n) => {
            let mut idx: Vec<usize> = (0..rows.len()).collect();
            idx.shuffle(&mut rand::thread_rng());
            idx.truncate(n);
            idx.sort_unstable();
            let selected: Vec<db::DownloadUploadRow> =
                idx.into_iter().map(|i| rows[i].clone()).collect();
            rows = selected;
        }
        MatchMode::StudentId(id) => {
            rows.retain(|r| r.student_id.as_deref() == Some(id.as_str()));
        }
        MatchMode::ShortStudentId(id) => {
            rows.retain(|r| r.short_id == Some(id));
        }
        MatchMode::TitleRegex(re) => {
            let regex = match Regex::new(&re) {
                Ok(r) => r,
                Err(e) => return api_bad(format!("invalid regular expression: {e}")),
            };
            rows.retain(|r| regex.is_match(&r.title));
        }
        MatchMode::Before(ts) => {
            rows.retain(|r| r.created_at < ts);
        }
    }

    let mut datas = Vec::with_capacity(rows.len());
    for row in rows {
        let replies = db::reply_contents(&db, &row.id);
        let reply_ids = db::reply_ids(&db, &row.id);
        datas.push(json!({
            "id": row.id,
            "submissionID": req.which,
            "studentID": row.student_id.clone().unwrap_or_default(),
            "shortStudentID": row.short_id.unwrap_or(0),
            "title": row.title,
            "desc": row.desc,
            "data": row.data,
            "reply": replies,
            "replyIDs": reply_ids,
            "uploader": row.uploader_name,
            "role": row.role,
            "createdAt": fmt_iso(row.created_at),
        }));
    }

    api_ok(json!({ "ok": true, "datas": datas }))
}

// ---------------------------------------------------------------------------
// 个人视角查询：/api/my-uploads、/api/my-submissions、/api/pending-uploads
// ---------------------------------------------------------------------------

fn upload_json(db: &rusqlite::Connection, row: &UploadRow) -> Value {
    json!({
        "id": row.id,
        "submissionID": row.submission_id,
        "submissionName": row.submission_name,
        "studentID": row.student_id.clone().unwrap_or_default(),
        "shortStudentID": row.short_id.unwrap_or(0),
        "title": row.title,
        "desc": row.desc,
        "data": row.data,
        "reply": db::reply_contents(db, &row.id),
        "replyIDs": db::reply_ids(db, &row.id),
        "uploader": row.uploader_name,
        "role": row.role,
        "createdAt": fmt_iso(row.created_at),
        "submissionCreatedBy": row.submission_created_by,
        "submissionCreatedName": row.submission_created_name,
    })
}

fn submission_json(row: &SubmissionRow) -> Value {
    let display_name = if row.display_name.trim().is_empty() {
        row.kind.clone()
    } else {
        row.display_name.clone()
    };
    let mut value = json!({
        "id": row.id,
        "name": row.name,
        "desc": row.desc,
        "deadLine": row.deadline.map(fmt_iso),
        "type": row.kind,
        "displayName": display_name,
        "typeDisplayName": display_name,
        "baseType": row.effective_kind(),
        "createdAt": fmt_iso(row.created_at),
        "createdBy": row.created_name,
        "createdByID": row.created_by,
        "uploadCount": row.upload_count,
        "myUploadCount": row.my_upload_count,
        "pendingCount": row.pending_count,
        "latestUploadID": row.last_upload_id,
        "hidden": row.flags.hidden,
        "teacherOnly": row.flags.teacher_only,
        "adminOnly": row.flags.admin_only,
        "invisible": row.flags.invisible,
        "separateList": row.flags.separate_list,
        "abstract": row.flags.abstract_mode,
        "visibility": crate::types::visibility_name(&row.flags),
        "inheritModes": row.mode_ancestors,
    });
    if let Some(map) = value.as_object_mut() {
        map.insert("flags".to_string(), row.flags.to_json());
    }
    value
}

fn truthy_value(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(n)) => n.as_i64().map(|n| n != 0).unwrap_or(false),
        Some(Value::String(s)) => matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on" | "show"
        ),
        _ => false,
    }
}

fn limit_or(value: Option<i64>, default: i64, max: i64) -> i64 {
    match value {
        Some(n) if n > 0 => n.min(max),
        Some(_) => 0,
        None => default,
    }
}

pub async fn my_uploads(State(st): State<AppState>, Json(req): Json<MyUploadsReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let mode = match parse_match_mode(req.match_mode.as_ref()) {
        Ok(m) => m,
        Err(e) => return api_bad(e),
    };
    let limit = limit_or(req.limit, 500, 2_000);
    let submission_id = req
        .submission_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let upload_id = req
        .upload_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let db = st.db.lock().unwrap();
    // 指定征集时必须与当前身份同班；否则按个人身份查询，不会泄露其他班级数据。
    if let Some(sub_id) = submission_id {
        match db::submission_class_id(&db, sub_id) {
            Some(c) if c == auth.class_id => {}
            Some(_) => return api_not_found("submission does not belong to the current class"),
            None => return api_not_found("submission not found"),
        }
    }
    let mut rows = db::list_my_uploads(&db, &auth, submission_id, upload_id, limit, true);
    if let Err(e) = apply_upload_match_mode(&mut rows, mode) {
        return api_bad(e);
    }
    let datas: Vec<Value> = rows.iter().map(|row| upload_json(&db, row)).collect();
    api_ok(json!({ "ok": true, "datas": datas }))
}

fn apply_upload_match_mode(rows: &mut Vec<UploadRow>, mode: MatchMode) -> Result<(), String> {
    match mode {
        MatchMode::All => {}
        MatchMode::Random(n) => {
            let mut idx: Vec<usize> = (0..rows.len()).collect();
            idx.shuffle(&mut rand::thread_rng());
            idx.truncate(n);
            idx.sort_unstable();
            let selected: Vec<UploadRow> = idx.into_iter().map(|i| rows[i].clone()).collect();
            *rows = selected;
        }
        MatchMode::StudentId(id) => {
            rows.retain(|r| r.student_id.as_deref() == Some(id.as_str()));
        }
        MatchMode::ShortStudentId(id) => {
            rows.retain(|r| r.short_id == Some(id));
        }
        MatchMode::TitleRegex(re) => {
            let regex = Regex::new(&re).map_err(|e| format!("invalid regular expression: {e}"))?;
            rows.retain(|r| regex.is_match(&r.title));
        }
        MatchMode::Before(ts) => {
            rows.retain(|r| r.created_at < ts);
        }
    }
    Ok(())
}

pub async fn my_submissions(
    State(st): State<AppState>,
    Json(req): Json<MySubmissionsReq>,
) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let mode = match parse_match_mode(req.match_mode.as_ref()) {
        Ok(m) => m,
        Err(e) => return api_bad(e),
    };
    let limit = limit_or(req.limit, 500, 2_000);
    let db = st.db.lock().unwrap();
    let mut rows: Vec<SubmissionRow> = db::list_my_submissions(&db, &auth, limit);
    match mode {
        MatchMode::All => {}
        MatchMode::Random(n) => {
            let mut idx: Vec<usize> = (0..rows.len()).collect();
            idx.shuffle(&mut rand::thread_rng());
            idx.truncate(n);
            idx.sort_unstable();
            let selected: Vec<SubmissionRow> = idx.into_iter().map(|i| rows[i].clone()).collect();
            rows = selected;
        }
        MatchMode::StudentId(id) => {
            let set = db::submission_ids_by_student(&db, &auth.class_id, &id);
            rows.retain(|r| set.iter().any(|sid| sid == &r.id));
        }
        MatchMode::ShortStudentId(id) => {
            let set = db::submission_ids_by_short(&db, &auth.class_id, id);
            rows.retain(|r| set.iter().any(|sid| sid == &r.id));
        }
        MatchMode::TitleRegex(re) => {
            let regex = match Regex::new(&re) {
                Ok(r) => r,
                Err(e) => return api_bad(format!("invalid regular expression: {e}")),
            };
            rows.retain(|r| regex.is_match(&r.name));
        }
        MatchMode::Before(ts) => {
            rows.retain(|r| r.deadline.is_some_and(|d| d < ts));
        }
    }
    let datas: Vec<Value> = rows.iter().map(submission_json).collect();
    api_ok(json!({ "ok": true, "datas": datas }))
}

/// 待回复提交：老师 / 管理员默认「自己发布的征集优先」，其次按提交时间倒序。
pub async fn pending_uploads(
    State(st): State<AppState>,
    Json(req): Json<PendingUploadsReq>,
) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !auth.is_staff() {
        return api_forbidden("only teachers or admins can view pending uploads");
    }
    let limit = limit_or(req.limit, 100, 1_000);
    let fetch_limit = if req.own_only { 1_000 } else { limit };
    let db = st.db.lock().unwrap();
    let rows = db::list_uploads(
        &db,
        &auth,
        Some("pending"),
        fetch_limit,
        true,
        !req.own_only,
    );
    let datas: Vec<Value> = rows
        .iter()
        .filter(|row| {
            !req.own_only || row.submission_created_by.as_deref() == Some(auth.id.as_str())
        })
        .take(limit.max(0) as usize)
        .map(|row| {
            let mut value = upload_json(&db, row);
            value["mine"] = json!(row.submission_created_by.as_deref() == Some(auth.id.as_str()));
            value
        })
        .collect();
    api_ok(json!({ "ok": true, "datas": datas }))
}

// ---------------------------------------------------------------------------
// 征集模式：/api/new-mode、/api/all-modes
// ---------------------------------------------------------------------------

pub async fn all_modes(State(st): State<AppState>, Json(req): Json<AllModesReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let db = st.db.lock().unwrap();
    let modes: Vec<Value> = db::list_mode_infos(&db, &auth.class_id)
        .iter()
        .map(|m| m.to_json())
        .collect();
    let tabs: Vec<Value> = modes
        .iter()
        .filter(|m| {
            m["separateList"].as_bool().unwrap_or(false)
                && !m["abstract"].as_bool().unwrap_or(false)
        })
        .cloned()
        .collect();
    api_ok(json!({
        "ok": true,
        "modes": modes.clone(),
        "datas": modes,
        "tabs": tabs.clone(),
        "separateLists": tabs,
    }))
}

pub async fn new_mode(State(st): State<AppState>, Json(req): Json<NewModeReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !auth.is_admin() {
        return api_forbidden("only admins can add submission modes");
    }
    let db = st.db.lock().unwrap();
    let options = db::ModeCreateOptions {
        display_name: req.display_name.clone(),
        // 可见性必须通过 extendModes 继承；仅抽象属性可显式声明。
        abstract_mode: req.abstract_mode,
    };
    match db::create_class_mode_with_options(
        &db,
        &auth,
        &req.mode_name,
        &req.extend_modes,
        &options,
    ) {
        Ok(mode) => api_ok(json!({
            "ok": true,
            "success": true,
            "id": mode.id,
            "modeName": mode.name,
            "displayName": mode.effective_display_name(),
            "extends": mode.extend_modes,
            "extendModes": mode.extend_modes,
            "baseType": mode.base_type,
            "hidden": mode.flags.hidden,
            "teacherOnly": mode.flags.teacher_only,
            "adminOnly": mode.flags.admin_only,
            "invisible": mode.flags.invisible,
            "separateList": mode.flags.separate_list,
            "abstract": mode.flags.abstract_mode,
            "flags": mode.flags.to_json(),
            "createdAt": fmt_iso(mode.created_at),
            "createdBy": mode.created_name,
        })),
        Err(e) => api_bad(e),
    }
}

pub async fn all_submission(
    State(st): State<AppState>,
    Json(req): Json<AllSubmissionReq>,
) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let mode = match parse_match_mode(req.match_mode.as_ref()) {
        Ok(m) => m,
        Err(e) => return api_bad(e),
    };
    let db = st.db.lock().unwrap();
    let show_hiddens = truthy_value(req.show_hiddens.as_ref());
    let category = req
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // 按征集 ID 直接读取：隐藏 / 不显示征集也能取到（仅按角色可见性校验）。
    if let Some(id) = req
        .submission_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let Some(row) = db::load_submission(&db, &auth, id) else {
            return api_not_found("submission not found");
        };
        let tabs =
            db::separate_mode_tabs(&db, &auth.class_id, std::slice::from_ref(&row), &auth.role);
        let tab_values: Vec<Value> = tabs.iter().map(|tab| tab.to_json()).collect();
        return api_ok(json!({
            "ok": true,
            "datas": vec![submission_json(&row)],
            "tabs": tab_values.clone(),
            "separateLists": tab_values,
            "showHiddens": show_hiddens,
            "category": category,
            "direct": true,
        }));
    }
    let mut rows: Vec<SubmissionRow> =
        db::list_submissions_visible(&db, &auth, i64::MAX, false, show_hiddens);
    let tabs = db::separate_mode_tabs(&db, &auth.class_id, &rows, &auth.role);
    if let Some(category) = category {
        db::filter_submissions_category(&db, &auth.class_id, &mut rows, category);
    }

    match mode {
        MatchMode::All => {}
        MatchMode::Random(n) => {
            let mut idx: Vec<usize> = (0..rows.len()).collect();
            idx.shuffle(&mut rand::thread_rng());
            idx.truncate(n);
            idx.sort_unstable();
            let selected: Vec<SubmissionRow> = idx.into_iter().map(|i| rows[i].clone()).collect();
            rows = selected;
        }
        MatchMode::StudentId(id) => {
            let set = db::submission_ids_by_student(&db, &auth.class_id, &id);
            rows.retain(|r| set.iter().any(|sid| sid == &r.id));
        }
        MatchMode::ShortStudentId(id) => {
            let set = db::submission_ids_by_short(&db, &auth.class_id, id);
            rows.retain(|r| set.iter().any(|sid| sid == &r.id));
        }
        MatchMode::TitleRegex(re) => {
            let regex = match Regex::new(&re) {
                Ok(r) => r,
                Err(e) => return api_bad(format!("invalid regular expression: {e}")),
            };
            rows.retain(|r| regex.is_match(&r.name));
        }
        MatchMode::Before(ts) => {
            rows.retain(|r| r.deadline.is_some_and(|d| d < ts));
        }
    }

    let datas: Vec<Value> = rows.iter().map(submission_json).collect();
    let tab_values: Vec<Value> = tabs.iter().map(|tab| tab.to_json()).collect();
    api_ok(json!({
        "ok": true,
        "datas": datas,
        "tabs": tab_values.clone(),
        "separateLists": tab_values,
        "showHiddens": show_hiddens,
        "category": category,
    }))
}

// ---------------------------------------------------------------------------
// /api/new-submission
// ---------------------------------------------------------------------------

pub async fn new_submission(
    State(st): State<AppState>,
    Json(req): Json<NewSubmissionReq>,
) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !auth.is_staff() {
        return api_forbidden("only teachers or admins can create submissions");
    }
    let name = req.name.trim().to_string();
    let desc = req.desc.trim().to_string();
    let kind = if req.kind.trim().is_empty() {
        "homework".to_string()
    } else {
        req.kind.trim().to_string()
    };
    if name.is_empty() {
        return api_bad("name must not be empty");
    }
    if name.chars().count() > MAX_TITLE {
        return api_bad(format!("name is too long (max {MAX_TITLE} characters)"));
    }
    if desc.chars().count() > MAX_SUBMISSION_DESC {
        return api_bad(format!(
            "desc is too long (max {MAX_SUBMISSION_DESC} characters)"
        ));
    }
    if kind.chars().count() > 60 {
        return api_bad("type is too long (max 60 characters)");
    }
    let deadline = match parse_deadline_value(req.deadline.as_ref()) {
        Ok(d) => d,
        Err(e) => return api_bad(e),
    };
    let db = st.db.lock().unwrap();
    // 内置模式或班级自定义模式：自定义模式用 baseType 决定问卷 / 答题卡 / 公示等行为。
    let mode = db::resolve_mode(&db, &auth.class_id, &kind);
    let (kind, base_kind, mut flags) = match mode {
        Some(m) => {
            if m.flags.abstract_mode {
                return api_bad(format!(
                    "submission mode is abstract and cannot be used directly: {}",
                    m.name
                ));
            }
            if !m.flags.can_publish(&auth.role) {
                return api_forbidden(format!(
                    "submission mode requires a different role: {}",
                    m.name
                ));
            }
            (m.name, m.base_type, m.flags)
        }
        None => (
            kind,
            "other".to_string(),
            crate::types::ModeFlags::default(),
        ),
    };
    // 单条征集的可见性覆盖（可选）。
    flags.hidden |= req.hidden;
    flags.teacher_only |= req.teacher_only;
    flags.admin_only |= req.admin_only;
    flags.invisible |= req.invisible;
    if flags.admin_only && !auth.is_admin() {
        return api_forbidden("admin-only submissions can only be published by admins");
    }
    // 答题卡：简介里必须至少有一道带 id / data-answer / data-score 的题目。
    if let Some(err) = crate::survey::validate_definition(&base_kind, &desc) {
        return api_bad(err);
    }
    match db::insert_submission_mode_flags(
        &db, &auth, &name, &desc, &kind, &base_kind, deadline, &flags,
    ) {
        Ok(id) => api_ok(json!({
            "ok": true,
            "id": id,
            "type": kind,
            "baseType": base_kind,
            "hidden": flags.hidden,
            "teacherOnly": flags.teacher_only,
            "adminOnly": flags.admin_only,
            "invisible": flags.invisible,
            "flags": flags.to_json(),
        })),
        Err(e) => crate::tools::api_err(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("create failed: {e}"),
        ),
    }
}

// ---------------------------------------------------------------------------
// /api/reply
// ---------------------------------------------------------------------------

pub async fn reply(State(st): State<AppState>, Json(req): Json<ReplyReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !auth.is_staff() {
        return api_forbidden("only teachers or admins can reply");
    }
    let content = req.content.trim().to_string();
    if content.is_empty() {
        return api_bad("content must not be empty");
    }
    if content.chars().count() > MAX_DESC {
        return api_bad(format!("content is too long (max {MAX_DESC} characters)"));
    }
    let db = st.db.lock().unwrap();
    match db::upload_class_id(&db, &req.upload_id) {
        Some(c) if c == auth.class_id => {}
        Some(_) => return api_not_found("upload does not belong to the current class"),
        None => return api_not_found("upload not found"),
    }
    match db::insert_reply(&db, &auth, &req.upload_id, &content) {
        Ok(id) => api_ok(json!({ "ok": true, "id": id })),
        Err(e) => crate::tools::api_err(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("reply failed: {e}"),
        ),
    }
}

// ---------------------------------------------------------------------------
// /api/new-class
// ---------------------------------------------------------------------------

pub async fn new_class(State(st): State<AppState>, Json(req): Json<NewClassReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !auth.is_admin() {
        return api_forbidden("only admins can create classes");
    }
    let desc = req.desc.trim();
    let name = req.name.trim();
    if name.is_empty() && desc.is_empty() {
        return api_bad("desc (class description) must not be empty");
    }
    let db = st.db.lock().unwrap();
    match db::create_class(&db, &auth, name, desc) {
        Ok(c) => api_ok(json!({
            "ok": true,
            "id": c.id,
            "code": c.code,
            "auth": c.key,
            "authID": c.auth_id,
        })),
        Err(e) => api_bad(e),
    }
}

// ---------------------------------------------------------------------------
// /api/new-user
// ---------------------------------------------------------------------------

pub async fn new_user(State(st): State<AppState>, Json(req): Json<NewUserReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !auth.is_admin() {
        return api_forbidden("only admins can add members");
    }
    let db = st.db.lock().unwrap();
    match db::create_members(&db, &auth, &req.class_id, &req.kind, req.quantity) {
        Ok(members) => {
            let ids: Vec<String> = members.iter().map(|m| m.id.clone()).collect();
            let keys: Vec<String> = members.iter().map(|m| m.key.clone()).collect();
            let details: Vec<Value> = members
                .iter()
                .map(|m| {
                    json!({
                        "id": m.id,
                        "key": m.key,
                        "role": m.role,
                        "studentID": m.student_id,
                        "displayName": m.display_name,
                    })
                })
                .collect();
            api_ok(json!({
                "ok": true,
                "IDs": ids,
                "keys": keys,
                "members": details,
            }))
        }
        Err(e) => api_bad(e),
    }
}

// ---------------------------------------------------------------------------
// /api/del-key
// ---------------------------------------------------------------------------

pub async fn del_key(State(st): State<AppState>, Json(req): Json<DelKeyReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    {
        let db = st.db.lock().unwrap();
        if let Err(e) = db::delete_auth(&db, &auth.id) {
            return api_bad(format!("delete failed: {e}"));
        }
    }
    invalidate_auth_sessions(&st, &auth.id);
    api_ok(json!({ "ok": true, "msg": "key deleted" }))
}

// ---------------------------------------------------------------------------
// /api/rename-auth
// ---------------------------------------------------------------------------

pub async fn rename_auth(State(st): State<AppState>, Json(req): Json<RenameAuthReq>) -> Response {
    let auth = match require_auth(&st, &req.auth) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let name = match clean_display_name(&req.name) {
        Ok(n) => n,
        Err(e) => return api_bad(e),
    };

    // 同步刷新历史快照，让改名立即反映在已有的提交、回复和征集上。
    let db = st.db.lock().unwrap();
    match db::rename_auth(&db, &auth.id, &name) {
        Ok(()) => api_ok(json!({ "ok": true, "name": name, "msg": "identity name updated" })),
        Err(e) => crate::tools::api_err(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("rename failed: {e}"),
        ),
    }
}

// ---------------------------------------------------------------------------
// /api/del-object
// ---------------------------------------------------------------------------

pub async fn del_object(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DelObjectReq>,
) -> Response {
    // 官方接口只传 id；此处支持 body.auth（推荐）或登录 cookie。
    let auth = match req.auth.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(key) => match require_auth(&st, key) {
            Ok(a) => a,
            Err(r) => return r,
        },
        None => match role_session(&st, &headers) {
            Some((_, a)) => a,
            None => return api_unauthorized("missing auth and not logged in"),
        },
    };
    if !auth.is_admin() {
        return api_forbidden("only admins can delete objects");
    }
    let id = req.id.trim().to_string();
    if id.is_empty() {
        return api_bad("id must not be empty");
    }

    if let Some(class_id) = id.strip_prefix("cls_") {
        let class_id = format!("cls_{class_id}");
        if class_id != auth.class_id {
            return api_forbidden("you can only delete a class you manage");
        }
        let members = {
            let db = st.db.lock().unwrap();
            let members = db::auth_ids_in_class(&db, &class_id);
            if let Err(e) = db::delete_class(&db, &class_id) {
                return api_bad(format!("delete failed: {e}"));
            }
            members
        };
        for m in members {
            invalidate_auth_sessions(&st, &m);
        }
        return api_ok(json!({ "ok": true, "msg": "class deleted" }));
    }

    if id.starts_with("auth_") {
        let target = {
            let db = st.db.lock().unwrap();
            db::load_auth_by_id(&db, &id)
        };
        let Some(target) = target else {
            return api_not_found("auth not found");
        };
        if target.class_id != auth.class_id {
            return api_forbidden("you can only delete an auth in the current class");
        }
        {
            let db = st.db.lock().unwrap();
            if let Err(e) = db::delete_auth(&db, &id) {
                return api_bad(format!("delete failed: {e}"));
            }
        }
        invalidate_auth_sessions(&st, &id);
        return api_ok(json!({ "ok": true, "msg": "auth deleted" }));
    }

    let class = {
        let db = st.db.lock().unwrap();
        if id.starts_with("sub_") {
            db::submission_class_id(&db, &id)
        } else if id.starts_with("up_") {
            db::upload_class_id(&db, &id)
        } else if id.starts_with("rep_") {
            db::reply_class_id(&db, &id)
        } else {
            None
        }
    };
    let Some(class) = class else {
        return api_not_found("object not found or unsupported id type");
    };
    if class != auth.class_id {
        return api_forbidden("you can only delete objects in the current class");
    }
    {
        let db = st.db.lock().unwrap();
        let result = if id.starts_with("sub_") {
            db::delete_submission(&db, &id)
        } else if id.starts_with("up_") {
            db::delete_upload(&db, &id)
        } else {
            db::delete_reply(&db, &id)
        };
        if let Err(e) = result {
            return api_bad(format!("delete failed: {e}"));
        }
    }
    api_ok(json!({ "ok": true, "msg": "deleted" }))
}

// ---------------------------------------------------------------------------
// 用户登录（非对称挑战 / API）
// ---------------------------------------------------------------------------

fn api_error_code(status: StatusCode, msg: impl Into<String>, code: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "msg": msg.into(), "code": code })),
    )
        .into_response()
}

fn with_cookie(mut res: Response, cookie: String) -> Response {
    crate::tools::append_cookie(&mut res, cookie);
    res
}

fn decode_pubkey(input: &ByteInput) -> Result<String, String> {
    let bytes = input.decode()?;
    if bytes.len() != crypto::KEY_LEN {
        return Err("public key must be 32 bytes".to_string());
    }
    crypto::validate_public_key(&bytes)?;
    Ok(crypto::b64_encode(&bytes))
}

/// 校验 loginSessionID + encryptedAnswer；成功时返回会话快照。
#[allow(clippy::result_large_err)]
fn verify_login_answer(
    st: &AppState,
    session_id: &str,
    answer: &ByteInput,
) -> Result<LoginSession, Response> {
    let now = now_ts();
    let mut sessions = st.login_sessions.lock().unwrap();
    let Some(session) = sessions.get(session_id).cloned() else {
        return Err(api_unauthorized("invalid or expired login session"));
    };
    if now - session.created_at > LOGIN_SESSION_TTL {
        sessions.remove(session_id);
        return Err(api_unauthorized("login session expired"));
    }
    let decoded = match answer.decode() {
        Ok(bytes) => bytes,
        Err(e) => return Err(api_bad(e)),
    };
    if decoded.len() != crypto::ANSWER_CIPHERTEXT_LEN {
        let attempts = match sessions.get_mut(session_id) {
            Some(s) => {
                s.attempts = s.attempts.saturating_add(1);
                s.attempts
            }
            None => MAX_LOGIN_ATTEMPTS,
        };
        if attempts >= MAX_LOGIN_ATTEMPTS {
            sessions.remove(session_id);
        }
        return Err(api_bad("encryptedAnswer has an invalid length"));
    }
    let ok = crypto::aes_gcm_decrypt(&session.answer_key, &decoded)
        .map(|plain| crypto::constant_time_eq(&plain, &session.challenge))
        .unwrap_or(false);
    if !ok {
        let attempts = match sessions.get_mut(session_id) {
            Some(s) => {
                s.attempts = s.attempts.saturating_add(1);
                s.attempts
            }
            None => MAX_LOGIN_ATTEMPTS,
        };
        if attempts >= MAX_LOGIN_ATTEMPTS {
            sessions.remove(session_id);
        }
        return Err(api_unauthorized("encrypted answer verification failed"));
    }
    if let Some(s) = sessions.get_mut(session_id) {
        s.verified = true;
    }
    let mut verified = session;
    verified.verified = true;
    Ok(verified)
}

/// `/api/login-try`：给用户公钥加密一个随机挑战，并下发答案加密密钥。
pub async fn login_try(State(st): State<AppState>, Json(req): Json<LoginTryReq>) -> Response {
    let username = req.username.trim();
    if username.is_empty() {
        return api_bad("username must not be empty");
    }
    let user = {
        let db = st.db.lock().unwrap();
        db::load_login_user(&db, username)
    };
    let Some(user) = user else {
        return api_unauthorized("invalid username or account does not exist");
    };
    let Some(pubkey_b64) = user
        .pubkey
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return api_error_code(
            StatusCode::UNAUTHORIZED,
            "this account has no public key yet; upgrade the login first",
            "pubkey_missing",
        );
    };
    let pubkey = match crypto::b64_decode(pubkey_b64) {
        Ok(bytes) if bytes.len() == crypto::KEY_LEN => bytes,
        _ => {
            return crate::tools::api_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "stored public key is invalid",
            )
        }
    };
    if crypto::validate_public_key(&pubkey).is_err() {
        return crate::tools::api_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "stored public key is invalid",
        );
    }
    let challenge = match crypto::random_bytes(crypto::CHALLENGE_LEN) {
        Ok(bytes) => bytes,
        Err(e) => return crate::tools::api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let challenge_encrypt = match crypto::encrypt_challenge(&pubkey, &challenge) {
        Ok(bytes) => bytes,
        Err(e) => return crate::tools::api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let answer_key = match crypto::random_bytes(crypto::KEY_LEN) {
        Ok(bytes) => bytes,
        Err(e) => return crate::tools::api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let session_id = format!("login_{}", crate::tools::rand_string(32));
    let now = now_ts();
    {
        let mut sessions = st.login_sessions.lock().unwrap();
        sessions.retain(|_, s| now - s.created_at <= LOGIN_SESSION_TTL);
        sessions.insert(
            session_id.clone(),
            LoginSession {
                user_id: user.id,
                challenge,
                answer_key: answer_key.clone(),
                created_at: now,
                verified: false,
                attempts: 0,
            },
        );
    }
    api_ok(json!({
        "ok": true,
        "loginSessionID": session_id,
        "challengeEncrypt": crypto::b64_encode(&challenge_encrypt),
        "answerEncryptingKey": crypto::b64_encode(&answer_key),
        "expiresIn": LOGIN_SESSION_TTL,
        "username": user.username,
        "displayName": user.display_name,
        "kdf": {
            "name": "PBKDF2-HMAC-SHA256",
            "iterations": crypto::KDF_ITERATIONS,
            "salt": crypto::kdf_salt(&user.username),
            "privateKey": "X25519",
            "challengeEncryption": "X25519-HKDF-SHA256-AES-256-GCM",
            "answerEncryption": "AES-256-GCM"
        }
    }))
}

/// `/api/get-auths`：验证答案后返回该账号的全部班级密钥，并建立账号会话。
pub async fn get_auths(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<GetAuthsReq>,
) -> Response {
    let session = match verify_login_answer(&st, &req.login_session_id, &req.encrypted_answer) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let (user, auths) = {
        let db = st.db.lock().unwrap();
        (
            db::load_user_by_id(&db, session.user_id),
            db::user_auths(&db, session.user_id),
        )
    };
    let Some(user) = user else {
        return api_unauthorized("account no longer exists");
    };
    let keys: Vec<String> = auths.iter().map(|a| a.key.clone()).collect();
    let ids: Vec<String> = auths.iter().map(|a| a.id.clone()).collect();
    let members: Vec<Value> = auths
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "key": a.key,
                "classID": a.class_id,
                "className": a.class_name,
                "role": a.role,
                "studentID": a.student_id,
                "shortStudentID": a.short_id,
                "displayName": a.display_name,
            })
        })
        .collect();

    // 登录成功后给浏览器建立账号会话；API 客户端可以只使用返回的 auths。
    if let Some(old) = cookie_value(&headers, USID_COOKIE) {
        st.user_sessions.lock().unwrap().remove(&old);
    }
    let token = create_user_session(&st, user.id);
    let cookie = session_cookie(USID_COOKIE, &token);
    let res = api_ok(json!({
        "ok": true,
        "auths": keys,
        "authIDs": ids,
        "members": members,
        "user": {
            "id": user.id,
            "username": user.username,
            "displayName": user.display_name,
        }
    }));
    with_cookie(res, cookie)
}

/// `/api/refresh-key`：验证账号挑战后轮换 auth 密钥（auth 泄漏处置）。
///
/// 新 auth 继承旧 auth 的全部身份数据与历史数据；旧 auth 会被删除，
/// 因此旧密钥与绑在旧 auth 上的角色会话立即失效。
pub async fn refresh_key(State(st): State<AppState>, Json(req): Json<RefreshKeyReq>) -> Response {
    let session = match verify_login_answer(&st, &req.login_session_id, &req.encrypted_answer) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let old_key = req.auth_refreshing.trim();
    if old_key.is_empty() {
        return api_bad("authRefreshing must not be empty");
    }

    let (old_auth_id, new_auth) = {
        let db = st.db.lock().unwrap();
        let Some(auth) = db::load_auth_by_key(&db, old_key) else {
            return api_error_code(
                StatusCode::UNAUTHORIZED,
                "invalid or expired auth",
                "auth_invalid",
            );
        };
        match auth.user_id {
            Some(uid) if uid == session.user_id => {}
            Some(_) => return api_forbidden("auth belongs to another account"),
            None => return api_forbidden("auth is not bound to an account"),
        }
        match db::refresh_auth(&db, &auth, session.user_id) {
            Ok(new_auth) => (auth.id.clone(), new_auth),
            Err(e) => {
                return crate::tools::api_err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("refresh key failed: {e}"),
                )
            }
        }
    };

    // 旧密钥已删除；同时作废旧角色会话和该账号的一次性挑战，避免重放。
    invalidate_auth_sessions(&st, &old_auth_id);
    st.login_sessions
        .lock()
        .unwrap()
        .retain(|_, s| s.user_id != session.user_id);

    api_ok(json!({ "ok": true, "newAuth": new_auth }))
}

/// `/api/register`：提交用户名 + 公钥创建账号（可选绑定一个未认领的班级密钥）。
pub async fn register(State(st): State<AppState>, Json(req): Json<RegisterReq>) -> Response {
    let username = req.username.trim();
    if !valid_username(username) {
        return api_bad(
            "username must be 2-32 characters and contain only letters, digits, _ or -",
        );
    }
    let pubkey = match decode_pubkey(&req.pubkey) {
        Ok(key) => key,
        Err(e) => return api_bad(e),
    };
    let display_name = if req.display_name.trim().is_empty() {
        username.to_string()
    } else {
        match clean_display_name(&req.display_name) {
            Ok(name) => name,
            Err(e) => return api_bad(e),
        }
    };
    let key = req.key.trim();
    let claim = if key.is_empty() {
        None
    } else {
        let db = st.db.lock().unwrap();
        match db::load_auth_by_key(&db, key) {
            Some(auth) if auth.user_id.is_none() => Some(auth),
            Some(_) => return api_bad("this key is already bound to another account"),
            None => return api_bad("invalid key"),
        }
    };
    let created = {
        let db = st.db.lock().unwrap();
        db::register_user(&db, username, &pubkey, &display_name)
    };
    let user_id = match created {
        Ok(id) => id,
        Err(e) if e.contains("already exists") => {
            return api_error_code(
                StatusCode::BAD_REQUEST,
                "username already exists",
                "username_taken",
            )
        }
        Err(e) => {
            return crate::tools::api_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("register failed: {e}"),
            )
        }
    };
    let mut bound_key = None;
    if let Some(auth) = claim {
        let result = {
            let db = st.db.lock().unwrap();
            db::bind_auth_if_unclaimed(&db, &auth.id, user_id)
        };
        match result {
            Ok(true) => bound_key = Some(auth.key.clone()),
            Ok(false) => {
                let db = st.db.lock().unwrap();
                let _ = db::delete_user(&db, user_id);
                return api_bad("this key is already bound to another account");
            }
            Err(e) => {
                let db = st.db.lock().unwrap();
                let _ = db::delete_user(&db, user_id);
                return crate::tools::api_err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("bind key failed: {e}"),
                );
            }
        }
    }
    api_ok(json!({
        "ok": true,
        "id": user_id,
        "userID": user_id,
        "username": username,
        "displayName": display_name,
        "boundAuth": bound_key,
    }))
}

/// `/api/reset-password`：验证挑战后替换公钥（即修改密码）。
pub async fn reset_password(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ResetPasswordReq>,
) -> Response {
    let session = match verify_login_answer(&st, &req.login_session_id, &req.encrypted_answer) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let new_pubkey = match decode_pubkey(&req.new_password_pub_key) {
        Ok(key) => key,
        Err(e) => return api_bad(e),
    };
    let auth_ids = {
        let db = st.db.lock().unwrap();
        if let Err(e) = db::update_user_pubkey(&db, session.user_id, &new_pubkey) {
            return crate::tools::api_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("reset password failed: {e}"),
            );
        }
        db::user_auths(&db, session.user_id)
            .into_iter()
            .map(|a| a.id)
            .collect::<Vec<_>>()
    };
    // 旧密码、旧挑战、旧账号会话与班级角色会话全部作废；给当前浏览器发一个新会话。
    for auth_id in auth_ids {
        invalidate_auth_sessions(&st, &auth_id);
    }
    st.login_sessions
        .lock()
        .unwrap()
        .retain(|_, s| s.user_id != session.user_id);
    if let Some(old) = cookie_value(&headers, USID_COOKIE) {
        st.user_sessions.lock().unwrap().remove(&old);
    }
    st.user_sessions
        .lock()
        .unwrap()
        .retain(|_, uid| *uid != session.user_id);
    let token = create_user_session(&st, session.user_id);
    let cookie = session_cookie(USID_COOKIE, &token);
    with_cookie(
        api_ok(json!({ "ok": true, "msg": "password reset" })),
        cookie,
    )
}

/// `/api/upgrade-pubkey`：老账号的一次性迁移接口（仍校验旧密码哈希）。
pub async fn upgrade_pubkey(
    State(st): State<AppState>,
    Json(req): Json<UpgradePubkeyReq>,
) -> Response {
    let username = req.username.trim();
    if username.is_empty() || req.password.is_empty() {
        return api_bad("username and password are required");
    }
    let pubkey = match decode_pubkey(&req.pubkey) {
        Ok(key) => key,
        Err(e) => return api_bad(e),
    };
    let found = {
        let db = st.db.lock().unwrap();
        db::load_user_with_secret(&db, username)
    };
    let Some(found) = found else {
        return api_unauthorized("invalid username or password");
    };
    if found.pwhash.is_empty()
        || !constant_time_eq(&hash_password(&found.salt, &req.password), &found.pwhash)
    {
        return api_unauthorized("invalid username or password");
    }
    let changed = {
        let db = st.db.lock().unwrap();
        db::upgrade_user_pubkey(&db, found.user.id, &pubkey)
    };
    match changed {
        Ok(true) => api_ok(json!({
            "ok": true,
            "msg": "public key upgraded",
            "username": found.user.username,
        })),
        Ok(false) => api_bad("this account already has a public key"),
        Err(e) => crate::tools::api_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("upgrade failed: {e}"),
        ),
    }
}

// ---------------------------------------------------------------------------
// /multi-api：批量调用
// ---------------------------------------------------------------------------

/// 单次批量调用允许的最大子请求数。
const MAX_MULTI_APIS: usize = 100;
const MULTI_API_PATH_KEYS: &[&str] = &["api", "path", "endpoint", "url", "route", "uri"];
const MULTI_API_BODY_KEYS: &[&str] = &["body", "params", "request", "payload", "json"];
/// 需要两次确认 / 依赖一次性挑战的接口不能放进批量调用。
const MULTI_API_BLOCKED: &[&str] = &[
    "/api/login-try",
    "/api/get-auths",
    "/api/reset-password",
    "/api/refresh-key",
    "/api/multi-api",
];

/// `/multi-api`：按数组顺序依次调用内部 API，结果索引与 `apis` 严格对应。
pub async fn multi_api(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<MultiApiReq>,
) -> Response {
    if req.apis.len() > MAX_MULTI_APIS {
        return api_bad(format!(
            "too many api calls in one batch (max {MAX_MULTI_APIS})"
        ));
    }
    let mut results = Vec::with_capacity(req.apis.len());
    for item in req.apis {
        results.push(run_multi_api_item(&st, &headers, item).await);
    }
    api_ok(json!({ "ok": true, "results": results }))
}

async fn run_multi_api_item(st: &AppState, headers: &HeaderMap, item: Value) -> Value {
    let (path, body) = match parse_multi_api_item(item) {
        Ok(parsed) => parsed,
        Err(e) => return multi_api_error(e, "invalid_request"),
    };
    if MULTI_API_BLOCKED.contains(&path.as_str()) {
        return multi_api_error(
            format!("api is not allowed in multi-api: {path}"),
            "api_not_allowed",
        );
    }
    let response = dispatch_multi_api(st, headers, &path, body).await;
    response_to_json(response).await
}

fn multi_api_error(msg: impl Into<String>, code: &str) -> Value {
    json!({ "ok": false, "msg": msg.into(), "code": code })
}

/// 解析单个 `apis` 元素。支持：
///   * `{"api": "/api/xxx", "body": {...}}`（也接受 data / params / request / payload / json）
///   * `{"api": "/api/xxx", ...直接书写请求字段...}`
///   * `"/api/xxx"` 或 `["/api/xxx", {...}]`
fn parse_multi_api_item(item: Value) -> Result<(String, Value), String> {
    match item {
        Value::String(path) => Ok((normalize_multi_api_path(&path)?, json!({}))),
        Value::Array(mut parts) => {
            if parts.is_empty() {
                return Err("api item array must not be empty".to_string());
            }
            let path = parts.remove(0);
            let path = path
                .as_str()
                .ok_or_else(|| "api item path must be a string".to_string())?;
            let path = normalize_multi_api_path(path)?;
            let body = if parts.is_empty() {
                json!({})
            } else {
                parts.remove(0)
            };
            if !parts.is_empty() {
                return Err("api item array must be [path, body]".to_string());
            }
            Ok((path, body))
        }
        Value::Object(map) => {
            let path = MULTI_API_PATH_KEYS
                .iter()
                .find_map(|k| map.get(*k).and_then(Value::as_str))
                .ok_or_else(|| "api item must contain an api/path field".to_string())?;
            let path = normalize_multi_api_path(path)?;
            let body = if let Some(body) = MULTI_API_BODY_KEYS.iter().find_map(|k| map.get(*k)) {
                body.clone()
            } else if let Some(data) = map.get("data").filter(|v| v.is_object()) {
                // `data: {...}` 作为显式请求体；数组形式的 data 视为上传附件等内联字段。
                data.clone()
            } else {
                let mut inline = map;
                for k in MULTI_API_PATH_KEYS {
                    inline.remove(*k);
                }
                Value::Object(inline)
            };
            Ok((path, body))
        }
        _ => Err("each api item must be an object, string or [path, body] array".to_string()),
    }
}

fn normalize_multi_api_path(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("api path must not be empty".to_string());
    }
    if raw.starts_with("http://") || raw.starts_with("https://") || raw.starts_with("//") {
        return Err("only internal api paths are allowed".to_string());
    }
    let path = raw
        .split(|c: char| c == '?' || c == '#')
        .next()
        .unwrap_or(raw)
        .trim_end_matches('/');
    if path.is_empty() {
        return Err("api path must not be empty".to_string());
    }
    let path = if path.starts_with("/api/") {
        path.to_string()
    } else if path.starts_with("api/") {
        format!("/{path}")
    } else if path.starts_with('/') {
        return Err(format!("unsupported api path: {raw}"));
    } else {
        format!("/api/{path}")
    };
    Ok(path)
}

async fn dispatch_multi_api(
    st: &AppState,
    headers: &HeaderMap,
    path: &str,
    body: Value,
) -> Response {
    macro_rules! call {
        ($ty:ty, $handler:path) => {
            match serde_json::from_value::<$ty>(body) {
                Ok(req) => $handler(State(st.clone()), Json(req)).await,
                Err(e) => api_error_code(
                    StatusCode::BAD_REQUEST,
                    format!("invalid request body for {path}: {e}"),
                    "invalid_request",
                ),
            }
        };
    }

    match path {
        "/api/upload" => call!(UploadReq, upload),
        "/api/download" => call!(DownloadReq, download),
        "/api/new-submission" => call!(NewSubmissionReq, new_submission),
        "/api/all-submission" => call!(AllSubmissionReq, all_submission),
        "/api/my-uploads" | "/api/my-upload" | "/api/all-my-uploads" | "/api/all-my-upload" => {
            call!(MyUploadsReq, my_uploads)
        }
        "/api/my-submissions"
        | "/api/my-submission"
        | "/api/all-my-submissions"
        | "/api/all-my-submission" => call!(MySubmissionsReq, my_submissions),
        "/api/pending-uploads" => call!(PendingUploadsReq, pending_uploads),
        "/api/new-mode" => call!(NewModeReq, new_mode),
        "/api/all-modes" | "/api/class-modes" => call!(AllModesReq, all_modes),
        "/api/reply" => call!(ReplyReq, reply),
        "/api/new-class" => call!(NewClassReq, new_class),
        "/api/new-user" => call!(NewUserReq, new_user),
        "/api/del-key" => call!(DelKeyReq, del_key),
        "/api/rename-auth" => call!(RenameAuthReq, rename_auth),
        "/api/del-object" => match serde_json::from_value::<DelObjectReq>(body) {
            Ok(req) => del_object(State(st.clone()), headers.clone(), Json(req)).await,
            Err(e) => api_error_code(
                StatusCode::BAD_REQUEST,
                format!("invalid request body for {path}: {e}"),
                "invalid_request",
            ),
        },
        "/api/register" => call!(RegisterReq, register),
        "/api/upgrade-pubkey" => call!(UpgradePubkeyReq, upgrade_pubkey),
        "/api/health" => health().await,
        _ => api_error_code(
            StatusCode::NOT_FOUND,
            format!("unsupported api path: {path}"),
            "unsupported_api",
        ),
    }
}

async fn response_to_json(response: Response) -> Value {
    let status = response.status();
    let bytes = match to_bytes(response.into_body(), usize::MAX).await {
        Ok(bytes) => bytes,
        Err(e) => {
            return multi_api_error(
                format!("failed to read api response: {e}"),
                "response_failed",
            )
        }
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(mut map)) => {
            map.entry("ok".to_string())
                .or_insert(Value::Bool(status.is_success()));
            Value::Object(map)
        }
        Ok(other) => json!({ "ok": status.is_success(), "data": other }),
        Err(_) => json!({
            "ok": status.is_success(),
            "msg": "api returned a non-json response",
            "body": String::from_utf8_lossy(&bytes),
        }),
    }
}

// ---------------------------------------------------------------------------
// 健康检查（便于部署探活）
// ---------------------------------------------------------------------------

pub async fn health() -> Response {
    api_ok(json!({ "ok": true, "service": "smart-campus", "time": now_ts() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_api_item_parsing() {
        let (path, body) = parse_multi_api_item(json!({
            "api": "/api/all-submission",
            "data": { "auth": "SC-STU-DEMO-2026" }
        }))
        .unwrap();
        assert_eq!(path, "/api/all-submission");
        assert_eq!(body, json!({ "auth": "SC-STU-DEMO-2026" }));

        let (path, body) = parse_multi_api_item(json!({
            "path": "upload",
            "body": { "auth": "SC-STU-DEMO-2026", "which": "sub_x" }
        }))
        .unwrap();
        assert_eq!(path, "/api/upload");
        assert_eq!(
            body,
            json!({ "auth": "SC-STU-DEMO-2026", "which": "sub_x" })
        );

        // 内联字段（上传的 data 是数组，因此保留为请求字段而不是包装体）。
        let (path, body) = parse_multi_api_item(json!({
            "api": "/api/upload",
            "auth": "SC-STU-DEMO-2026",
            "which": "sub_x",
            "title": "t",
            "data": []
        }))
        .unwrap();
        assert_eq!(path, "/api/upload");
        assert_eq!(
            body.get("auth").and_then(Value::as_str),
            Some("SC-STU-DEMO-2026")
        );
        assert!(body.get("data").is_some());

        let (path, body) = parse_multi_api_item(json!(["/api/health"])).unwrap();
        assert_eq!(path, "/api/health");
        assert_eq!(body, json!({}));

        let (path, body) = parse_multi_api_item(json!(["api/health", { "x": 1 }])).unwrap();
        assert_eq!(path, "/api/health");
        assert_eq!(body, json!({ "x": 1 }));

        assert!(parse_multi_api_item(json!({ "auth": "x" })).is_err());
        assert!(parse_multi_api_item(json!(42)).is_err());
        assert!(parse_multi_api_item(json!("https://example.com/api")).is_err());
    }

    #[test]
    fn multi_api_path_normalization() {
        assert_eq!(
            normalize_multi_api_path("/api/all-submission/").unwrap(),
            "/api/all-submission"
        );
        assert_eq!(
            normalize_multi_api_path("api/all-submission").unwrap(),
            "/api/all-submission"
        );
        assert_eq!(
            normalize_multi_api_path("all-submission").unwrap(),
            "/api/all-submission"
        );
        assert_eq!(
            normalize_multi_api_path("/api/health?probe=1").unwrap(),
            "/api/health"
        );
        assert!(normalize_multi_api_path("   ").is_err());
        assert!(normalize_multi_api_path("/multi-api").is_err());
        assert!(normalize_multi_api_path("https://example.com/api/health").is_err());
    }

    #[test]
    fn multi_api_blocks_two_step_endpoints() {
        for path in [
            "/api/login-try",
            "/api/get-auths",
            "/api/reset-password",
            "/api/refresh-key",
            "/api/multi-api",
        ] {
            assert!(MULTI_API_BLOCKED.contains(&path));
        }
        assert!(!MULTI_API_BLOCKED.contains(&"/api/health"));
        assert!(!MULTI_API_BLOCKED.contains(&"/api/all-submission"));
    }
}
