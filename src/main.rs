use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::{
    extract::{DefaultBodyLimit, Request},
    http::{header, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};

use crate::types::AppState;

mod api;
mod crypto;
mod db;
mod docs;
mod logging;
mod pages;
mod strings;
mod survey;
mod tools;
mod types;
mod view;

const FAVICON: &str = include_str!("./assets/favicon.csv");

async fn static_css() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        include_str!("assets/app.css"),
    )
        .into_response()
}

async fn static_js() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        crate::strings::apply(include_str!("assets/app.js")),
    )
        .into_response()
}

async fn static_auth_js() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        crate::strings::apply(include_str!("assets/auth.js")),
    )
        .into_response()
}

async fn static_strings() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        strings::js_object(),
    )
        .into_response()
}

async fn favicon() -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        FAVICON,
    )
        .into_response()
}

async fn log_requests(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let started = Instant::now();
    let response = next.run(req).await;
    let status = response.status();
    let elapsed = started.elapsed().as_millis();
    let line = format!("{method} {path} -> {} ({elapsed}ms)", status.as_u16());
    // 静态资源、favicon 和成功的健康检查只在 debug 级别记录，避免刷屏。
    let quiet = path.starts_with("/static/") || path == "/favicon.svg" || path == "/api/health";
    if quiet && status.is_success() {
        logging::debug("http", line);
    } else if status.is_server_error() {
        logging::error("http", line);
    } else if status.is_client_error() {
        logging::warn("http", line);
    } else {
        logging::info("http", line);
    }
    response
}

async fn fallback(uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return tools::api_not_found("endpoint not found");
    }
    view::not_found(None, &strings::t("error_not_found_desc"))
}

#[tokio::main]
async fn main() {
    let log_dir = std::env::var("SC_LOG_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "log".to_string());
    let log_level = std::env::var("SC_LOG_LEVEL").unwrap_or_else(|_| "info".to_string());
    if let Err(e) = logging::init(&log_dir, &log_level) {
        eprintln!("failed to initialize logging: {e}");
    }
    logging::info(
        "boot",
        format!(
            "smart-campus v{} starting (log dir: {log_dir}, level: {log_level})",
            env!("CARGO_PKG_VERSION")
        ),
    );
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        logging::error("panic", format!("{info}"));
        default_panic(info);
    }));

    let strings_dir = std::env::var("SC_STRINGS_DIR").unwrap_or_else(|_| "strings".to_string());
    let strings_db = std::env::var("SC_STRINGS_DB").unwrap_or_else(|_| "strings.db".to_string());
    let lang = std::env::var("SC_LANG").unwrap_or_else(|_| "zh-CN".to_string());
    match strings::init(&strings_dir, &strings_db, &lang) {
        Ok(Some(warning)) => {
            eprintln!("{warning}");
            logging::warn("strings", &warning);
        }
        Ok(None) => {}
        Err(e) => {
            logging::error("strings", format!("failed to load UI strings: {e}"));
            std::process::exit(1);
        }
    }
    logging::info("boot", format!("strings loaded from {strings_dir}"));

    let db_path = std::env::var("SC_DB").unwrap_or_else(|_| "smartcampus.db".to_string());
    let conn = match db::open(&db_path) {
        Ok(conn) => conn,
        Err(e) => {
            logging::error("db", format!("database initialization failed: {e}"));
            std::process::exit(1);
        }
    };
    logging::info("boot", format!("database ready: {db_path}"));

    let state = AppState {
        db: Arc::new(db::Database::new(conn)),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        user_sessions: Arc::new(Mutex::new(HashMap::new())),
        login_sessions: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/", get(pages::root))
        .route("/login", get(pages::login_index))
        .route("/login/account", get(pages::login_account_page))
        .route("/logout", post(pages::logout))
        .route("/home", get(pages::home_entry))
        .route("/home/{mode}/{role}", get(pages::home_index))
        .route("/home/{mode}/{role}/", get(pages::home_slash))
        .route("/home/{mode}/{role}/{*rest}", get(pages::home_wild))
        .route("/user", get(pages::user_page))
        .route("/user/login", post(pages::user_login))
        .route("/user/register", post(pages::user_register))
        .route("/user/claim", post(pages::user_claim))
        .route("/user/enter", post(pages::user_enter))
        .route("/user/auth/{id}/delete", post(pages::user_delete_auth))
        .route("/user/prefs", post(pages::user_prefs))
        .route("/user/password", post(pages::user_password))
        .route("/user/class", post(pages::user_create_class))
        .route("/user/logout", post(pages::user_logout))
        .route("/docs", get(pages::docs_page))
        .route("/docs/", get(pages::docs_page))
        .route("/api/upload", post(api::upload))
        .route("/api/download", post(api::download))
        .route("/api/new-submission", post(api::new_submission))
        .route("/api/all-submission", post(api::all_submission))
        .route("/api/my-uploads", post(api::my_uploads))
        .route("/api/my-upload", post(api::my_uploads))
        .route("/api/all-my-uploads", post(api::my_uploads))
        .route("/api/all-my-upload", post(api::my_uploads))
        .route("/api/my-submissions", post(api::my_submissions))
        .route("/api/my-submission", post(api::my_submissions))
        .route("/api/all-my-submissions", post(api::my_submissions))
        .route("/api/all-my-submission", post(api::my_submissions))
        .route("/api/pending-uploads", post(api::pending_uploads))
        .route("/api/new-mode", post(api::new_mode))
        .route("/api/all-modes", post(api::all_modes))
        .route("/api/class-modes", post(api::all_modes))
        .route("/api/del-mode", post(api::del_mode))
        .route("/api/reply", post(api::reply))
        .route("/api/new-class", post(api::new_class))
        .route("/api/new-user", post(api::new_user))
        .route("/api/del-key", post(api::del_key))
        .route("/api/rename-auth", post(api::rename_auth))
        .route("/api/del-object", post(api::del_object))
        .route("/api/health", get(api::health))
        .route("/api/docs", post(api::docs))
        .route("/api/login-try", post(api::login_try))
        .route("/api/get-auths", post(api::get_auths))
        .route("/api/refresh-key", post(api::refresh_key))
        .route("/api/reset-password", post(api::reset_password))
        .route("/api/register", post(api::register))
        .route("/api/upgrade-pubkey", post(api::upgrade_pubkey))
        .route("/multi-api", post(api::multi_api))
        .route("/api/multi-api", post(api::multi_api))
        .route("/static/app.css", get(static_css))
        .route("/static/app.js", get(static_js))
        .route("/static/auth.js", get(static_auth_js))
        .route("/static/strings.js", get(static_strings))
        .route("/favicon.svg", get(favicon))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .fallback(fallback)
        .layer(middleware::from_fn(log_requests))
        .with_state(state);

    let port: u16 = std::env::var("SC_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let bind = std::env::var("SC_BIND").unwrap_or_else(|_| format!("[::]:{port}"));
    let addr: SocketAddr = match bind.parse() {
        Ok(addr) => addr,
        Err(_) => tokio::net::lookup_host(&bind)
            .await
            .unwrap_or_else(|_| panic!("invalid SC_BIND address: {bind}"))
            .next()
            .unwrap_or_else(|| panic!("SC_BIND did not resolve to an address: {bind}")),
    };

    let tls_cert = std::env::var("SC_TLS_CERT").ok().filter(|v| !v.is_empty());
    let tls_key = std::env::var("SC_TLS_KEY").ok().filter(|v| !v.is_empty());
    let tls = match (tls_cert, tls_key) {
        (Some(cert), Some(key)) => Some((cert, key)),
        (None, None) => None,
        _ => panic!("SC_TLS_CERT and SC_TLS_KEY must be set together"),
    };

    let display = if addr.ip().is_unspecified() {
        format!("localhost:{}", addr.port())
    } else {
        bind
    };
    let scheme = if tls.is_some() { "https" } else { "http" };

    let (string_count, string_lang) = strings::stats();
    logging::info(
        "boot",
        format!("strings ready: {string_count} ({string_lang})"),
    );
    logging::info("boot", format!("listening on {scheme}://{display}"));
    println!("{} · Campus OS", strings::t("title"));
    println!("  Address : {scheme}://{display}");
    println!("  Strings : {string_count} ({string_lang})");
    println!("  Database: {db_path}");
    println!(
        "  Demo    : keys {} / {} / {}",
        db::DEMO_ADMIN_KEY,
        db::DEMO_TEACHER_KEY,
        db::DEMO_STUDENT_KEY
    );
    println!("            accounts admin/admin123 · teacher/teacher123 · student/student123");

    if let Some((cert, key)) = tls {
        let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key)
            .await
            .expect("failed to load TLS certificate or key");
        logging::info("boot", "TLS enabled");
        println!("  TLS     : {cert} / {key}");
        axum_server::tls_rustls::bind_rustls(addr, config)
            .serve(app.into_make_service())
            .await
            .expect("server failed");
    } else {
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .expect("failed to bind listener");
        axum::serve(listener, app).await.expect("server failed");
    }
}
