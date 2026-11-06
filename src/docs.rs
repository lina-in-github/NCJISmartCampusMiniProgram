/* 文档与相关：把仓库根目录的 README.md 作为唯一内容源。
 *
 * Web 端由服务端渲染为 HTML；小程序端通过 /api/docs 获取 Markdown 原文，
 * 按纯文本显示（不解析 Markdown）。
 */
use pulldown_cmark::{html, Options, Parser};

/// 仓库根目录 README.md（编译期嵌入，静态资源缺失时也能正常展示）。
pub const README: &str = include_str!("../README.md");

/// 文档文件名，供页面展示。
pub const FILE_NAME: &str = "README.md";

/// 将 README.md 渲染为 HTML（支持表格、删除线、任务列表与脚注）。
pub fn render_html() -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);
    let parser = Parser::new_ext(README, options);
    let mut out = String::with_capacity(README.len() * 2);
    html::push_html(&mut out, parser);
    // README 本身会举例说明 `@[strings/key]` 标签；转义 @ 可避免页面统一替换
    // 字符串时误改文档内容（浏览器仍显示为 @）。
    out.replace("@[strings/", "&#64;[strings/")
}

/// 返回 Markdown 原文，保持换行与缩进，供小程序按纯文本展示。
pub fn plain_text() -> String {
    README.replace("\r\n", "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readme_renders_markdown_blocks() {
        let html = render_html();
        assert!(html.contains("<h1>"));
        assert!(html.contains("<table>"));
        assert!(html.contains("<code>"));
        assert!(html.contains("<pre>"));
        assert!(html.contains("<ul>"));
        assert!(html.contains("<li>"));
        assert!(!html.trim().is_empty());
    }

    #[test]
    fn plain_text_keeps_markdown_source() {
        let text = plain_text();
        assert!(text.starts_with("# "));
        assert!(text.contains("## 2. 页面路由"));
        assert!(text.contains("\n"));
    }
}
