#!/usr/bin/env python3
"""按 key 排序 strings/zh-CN.txt，并生成小程序端 strings.js。

用法：
    python3 scripts/mp_strings.py          # 排序源文件并生成 strings.js
    python3 scripts/mp_strings.py --check  # 只检查是否已同步（CI 用）

字符串格式：
    key:
    value

条目之间允许空行和 # 注释；排序时注释会跟随其后的条目移动。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "strings" / "zh-CN.txt"
DEFAULT_OUTPUT = ROOT / "miniprogram" / "utils" / "strings.js"

KEY_RE = re.compile(r"[A-Za-z0-9_.-]+")

JS_HEADER = """/* 由 scripts/mp_strings.py 从 strings/zh-CN.txt 自动生成，请勿手工编辑。
 * 与 Rust 侧 src/strings.rs 使用同一份文案：API 仍保持英文，界面文案全部来自这里。
 */
var RAW = {
"""

JS_FOOTER = """};

// 与 src/strings.rs::t 一致：缺失 key 时保留 @[strings/key] 标记，方便排查。
function has(key) {
  return Object.prototype.hasOwnProperty.call(RAW, key);
}

function t(key) {
  return has(key) ? RAW[key] : "@[strings/" + key + "]";
}

// 与前端 app.js 的 S() 一致：{} 按顺序替换，{{ / }} 为字面量花括号。
function formatString(template, args) {
  var out = "";
  var idx = 0;
  for (var i = 0; i < template.length; i++) {
    var c = template.charAt(i);
    var n = template.charAt(i + 1);
    if (c === "{" && n === "{") {
      out += "{";
      i++;
    } else if (c === "}" && n === "}") {
      out += "}";
      i++;
    } else if (c === "{" && n === "}") {
      if (idx < args.length) out += String(args[idx++]);
      else out += "{}";
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function S(key) {
  var args = Array.prototype.slice.call(arguments, 1);
  return formatString(t(key), args);
}

function keys() {
  return Object.keys(RAW);
}

module.exports = { raw: RAW, t: t, S: S, has: has, keys: keys };
"""


def parse_source(text: str, path: Path) -> tuple[list[str], list[tuple[list[str], str, str]], list[str]]:
    """Return (header, entries, trailing), where entries are (leading, key, value)."""
    lines = [line[:-1] if line.endswith("\r") else line for line in text.split("\n")]
    header: list[str] = []
    entries: list[tuple[list[str], str, str]] = []
    pending: list[str] = []
    seen_key = False
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            pending.append(line)
            i += 1
            continue

        if not stripped.endswith(":"):
            raise ValueError(f"{path}:{i + 1}: 条目必须以 `key:` 开头")
        key = stripped[:-1].rstrip()
        if not key or not KEY_RE.fullmatch(key):
            raise ValueError(f"{path}:{i + 1}: 非法 key `{key}`")

        i += 1
        if i >= len(lines):
            raise ValueError(f"{path}:{i + 1}: key `{key}` 缺少内容行")
        value = lines[i]
        i += 1

        leading = pending
        pending = []
        if not seen_key:
            header = leading
            leading = []
            seen_key = True
        entries.append((leading, key, unescape(value)))

    if not entries:
        raise ValueError(f"{path}: 没有任何字符串条目")

    seen: set[str] = set()
    for _, key, _ in entries:
        if key in seen:
            raise ValueError(f"{path}: 重复 key `{key}`")
        seen.add(key)

    return header, entries, pending


def render_source(header: list[str], entries: list[tuple[list[str], str, str]], trailing: list[str]) -> str:
    out = list(header)
    if not out or out[-1].strip():
        out.append("")

    for leading, key, value in entries:
        out.extend(leading)
        out.append(f"{key}:")
        out.append(value)

    out.extend(trailing)
    text = "\n".join(out)
    if not text.endswith("\n"):
        text += "\n"
    return text


def render_js(entries: list[tuple[list[str], str, str]]) -> str:
    items = [
        f"  {json.dumps(key, ensure_ascii=False)}: {json.dumps(value, ensure_ascii=False)}"
        for _, key, value in entries
    ]
    return JS_HEADER + ",\n".join(items) + "\n" + JS_FOOTER


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="按 A-Z 排序字符串并生成小程序 strings.js")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="字符串源文件")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="生成的 strings.js")
    parser.add_argument("--check", action="store_true", help="只检查，不写文件")
    args = parser.parse_args()

    source_text = args.source.read_text(encoding="utf-8")
    header, entries, trailing = parse_source(source_text, args.source)
    entries.sort(key=lambda item: item[1].casefold())

    sorted_text = render_source(header, entries, trailing)
    js_text = render_js(entries)

    if args.check:
        stale: list[str] = []
        if source_text != sorted_text:
            stale.append(f"{args.source} 未按 A-Z 排序")
        if not args.output.exists() or args.output.read_text(encoding="utf-8") != js_text:
            stale.append(f"{args.output} 未同步")
        if stale:
            for message in stale:
                print(f"检查失败：{message}", file=sys.stderr)
            return 1
        print(f"检查通过：{args.source} 已排序，{args.output} 已同步")
        return 0

    source_changed = write_if_changed(args.source, sorted_text)
    js_changed = write_if_changed(args.output, js_text)
    print(
        f"已处理 {len(entries)} 条字符串："
        f"{args.source} {'已排序' if source_changed else '已是最新'}，"
        f"{args.output} {'已生成' if js_changed else '已是最新'}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)
