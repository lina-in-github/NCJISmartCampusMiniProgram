//! 轻量文件日志。
//!
//! 日志默认写入 `./log/app-YYYY-MM-DD.log`，每天自动切换到新文件。
//! 用法：
//!   * 启动时调用 [`init`]；
//!   * 运行期使用 [`debug`] / [`info`] / [`warn`] / [`error`]；
//!   * 只记录路径、状态码、耗时、错误等技术信息，不记录请求体、密码、密钥、
//!     cookie、encryptedAnswer 或附件内容。
//!
//! 级别 = `off` / `error` / `warn` / `info` / `debug`，由 `SC_LOG_LEVEL` 控制；
//! 目录由 `SC_LOG_DIR` 控制。日志写入失败不会影响主流程。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOGGER: OnceLock<Logger> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Level {
    Off = 0,
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
}

impl Level {
    fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" | "none" | "silent" => Level::Off,
            "error" => Level::Error,
            "warn" | "warning" => Level::Warn,
            "debug" | "trace" => Level::Debug,
            _ => Level::Info,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Level::Off => "OFF",
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
        }
    }
}

struct State {
    date: String,
    file: Option<File>,
}

struct Logger {
    dir: PathBuf,
    level: Level,
    state: Mutex<State>,
}

impl Logger {
    fn new(dir: PathBuf, level: Level) -> std::io::Result<Self> {
        let date = today();
        let file = if level == Level::Off {
            None
        } else {
            Some(open_file(&dir, &date)?)
        };
        Ok(Self {
            dir,
            level,
            state: Mutex::new(State { date, file }),
        })
    }

    fn enabled(&self, level: Level) -> bool {
        level != Level::Off && (level as u8) <= (self.level as u8)
    }

    fn write(&self, level: Level, scope: &str, msg: &str) {
        if !self.enabled(level) {
            return;
        }
        let (timestamp, date) = timestamp();
        let line = format!(
            "{timestamp} [{}] [{}] {}\n",
            level.label(),
            scope,
            one_line(msg)
        );

        let mut write_error = None;
        {
            let mut state = match self.state.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            if state.date != date {
                match open_file(&self.dir, &date) {
                    Ok(file) => {
                        state.date = date;
                        state.file = Some(file);
                    }
                    Err(e) => {
                        write_error = Some(format!(
                            "failed to rotate log file in {}: {e}",
                            self.dir.display()
                        ));
                    }
                }
            }
            if write_error.is_none() {
                if let Some(file) = state.file.as_mut() {
                    if let Err(e) = file.write_all(line.as_bytes()) {
                        write_error = Some(format!("failed to write log: {e}"));
                    }
                }
            }
        }

        if let Some(e) = write_error {
            eprintln!("{e}");
        }
        // 错误同时保留在 stderr，便于容器/终端直接看到；warn 以下只进文件。
        if level == Level::Error {
            eprint!("{line}");
        }
    }
}

/// 初始化全局日志。目录不存在时会自动创建。
pub fn init(dir: &str, level: &str) -> Result<(), String> {
    let logger = Logger::new(PathBuf::from(dir), Level::parse(level))
        .map_err(|e| format!("cannot initialize log directory {dir}: {e}"))?;
    // 重复初始化不视为错误（例如测试或嵌入式调用）。
    let _ = LOGGER.set(logger);
    Ok(())
}

fn global(level: Level, scope: &str, msg: &str) {
    if let Some(logger) = LOGGER.get() {
        logger.write(level, scope, msg);
    } else if level == Level::Error {
        eprintln!("[{scope}] {msg}");
    }
}

pub fn debug(scope: &str, msg: impl AsRef<str>) {
    global(Level::Debug, scope, msg.as_ref());
}

pub fn info(scope: &str, msg: impl AsRef<str>) {
    global(Level::Info, scope, msg.as_ref());
}

pub fn warn(scope: &str, msg: impl AsRef<str>) {
    global(Level::Warn, scope, msg.as_ref());
}

pub fn error(scope: &str, msg: impl AsRef<str>) {
    global(Level::Error, scope, msg.as_ref());
}

fn open_file(dir: &Path, date: &str) -> std::io::Result<File> {
    fs::create_dir_all(dir)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("app-{date}.log")))
}

fn today() -> String {
    let (_, date) = timestamp();
    date
}

fn timestamp() -> (String, String) {
    let now = SystemTime::now();
    let duration = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs() as i64;
    let millis = duration.subsec_millis();
    let iso = crate::tools::fmt_iso(secs);
    let date = iso.get(0..10).unwrap_or("1970-01-01").to_string();
    let timestamp = if iso.len() >= 19 {
        format!("{}.{:03}{}", &iso[..19], millis, &iso[19..])
    } else {
        iso
    };
    (timestamp, date)
}

/// 文件日志一行一条记录；消息里的换行转义，避免伪造日志行。
fn one_line(msg: &str) -> String {
    if !msg.contains('\n') && !msg.contains('\r') {
        return msg.to_string();
    }
    msg.replace("\r\n", "\\n")
        .replace('\n', "\\n")
        .replace('\r', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "smart-campus-log-{}-{}-{name}",
            std::process::id(),
            crate::tools::rand_string(8)
        ))
    }

    #[test]
    fn level_parsing() {
        assert_eq!(Level::parse("off"), Level::Off);
        assert_eq!(Level::parse(" ERROR "), Level::Error);
        assert_eq!(Level::parse("warning"), Level::Warn);
        assert_eq!(Level::parse("info"), Level::Info);
        assert_eq!(Level::parse("debug"), Level::Debug);
        assert_eq!(Level::parse("unknown"), Level::Info);
    }

    #[test]
    fn writes_daily_file_and_filters_levels() {
        let dir = temp_dir("write");
        let logger = Logger::new(dir.clone(), Level::Info).expect("logger");
        logger.write(Level::Info, "test", "hello\nworld");
        logger.write(Level::Debug, "test", "hidden");
        let date = logger.state.lock().unwrap().date.clone();
        let path = dir.join(format!("app-{date}.log"));
        let text = std::fs::read_to_string(&path).expect("log file");
        assert!(text.contains("[INFO] [test] hello\\nworld"));
        assert!(!text.contains("hidden"));
        drop(logger);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn off_does_not_create_log_directory() {
        let dir = temp_dir("off");
        let logger = Logger::new(dir.clone(), Level::Off).expect("logger");
        logger.write(Level::Error, "test", "should not write");
        assert!(!dir.exists());
    }
}
