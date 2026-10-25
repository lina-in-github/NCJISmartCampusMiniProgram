#!/usr/bin/env python3
"""把 strings/<lang>.txt 转换成微信小程序可直接 require 的 JS 模块。

用法：
    python3 scripts/mp_strings.py            # 默认 zh-CN -> miniprogram/utils/strings.js
    python3 scripts/mp_strings.py --lang en-US

格式与 src/strings.rs 完全一致：

    name=<key> lines=0 content=<单行内容>
    name=<key> lines=N content=
    第一行
    ...
    第 N 行

生成的文件会被 --check 模式用于校验「字符串文件与生成物是否同步」。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "miniprogram" / "utils" / "strings.js"

HEADER = """/* 由 scripts/mp_strings.py 从 strings/{lang}.txt 自动生成，请勿手工编辑。
 * 与 Rust 侧 src/strings.rs 使用同一份文案：API 仍保持英文，界面文案全部来自这里。
 */
"""


def parse_strings(path: pathlib.Path) -> dict[str, str]:
    """解析 name=/lines=/content= 格式，语义与 src/strings.rs 保持一致。"""
    entries: dict[str, str] = {}
    key: str | None = None
    lines = 0
    content: str | None = None
    pending = 0
    buffer: list[str] = []

    def flush() -> None:
        nonlocal key, lines, content, buffer
        if key is None:
            return
        if lines > 0:
            # content= 之后独立的 N 行（保留换行）
            entries[key] = "\n".join(buffer[:lines])
        else:
            entries[key] = content or ""
        key, lines, content, buffer = None, 0, None, []

    for raw in path.read_text(encoding="utf-8").splitlines():
        if pending > 0:
            buffer.append(raw)
            pending -= 1
            if pending == 0:
                flush()
            continue
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            # 注释与空行不参与内容，避免像 Rust 侧那样打断块
            continue
        if not stripped.startswith("name="):
            raise SystemExit(f"{path}: 无法解析的行：{raw!r}")
        flush()
        rest = stripped[len("name="):]
        if " lines=" not in rest:
            raise SystemExit(f"{path}: 缺少 lines=：{raw!r}")
        key_part, rest = rest.split(" lines=", 1)
        line_part, _, content_part = rest.partition(" content=")
        key = key_part.strip()
        try:
            lines = int(line_part.strip())
        except ValueError as exc:
            raise SystemExit(f"{path}: lines 不是整数：{raw!r}") from exc
        content = content_part
        if lines > 0:
            pending = lines
    flush()
    return entries


def render(entries: dict[str, str], lang: str) -> str:
    body = json.dumps(entries, ensure_ascii=False, indent=2, sort_keys=False)
    return (
        HEADER.format(lang=lang)
        + "var RAW = "
        + body
        + ";\n\n"
        + """// 与 src/strings.rs::t 一致：缺失 key 时保留 @[strings/key] 标记，方便排查。
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
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lang", default="zh-CN")
    parser.add_argument("--out", default=None)
    parser.add_argument("--check", action="store_true", help="只校验生成物是否最新")
    args = parser.parse_args(argv)

    src = ROOT / "strings" / f"{args.lang}.txt"
    if not src.exists():
        print(f"missing strings file: {src}", file=sys.stderr)
        return 1
    out = pathlib.Path(args.out) if args.out else DEFAULT_OUT
    text = render(parse_strings(src), args.lang)

    if args.check:
        current = out.read_text(encoding="utf-8") if out.exists() else ""
        if current != text:
            print(f"{out} 与 {src} 不同步，请重新运行 scripts/mp_strings.py", file=sys.stderr)
            return 1
        print(f"{out.name}: {len(parse_strings(src))} 条文案与 {src.name} 同步")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"wrote {out} ({len(parse_strings(src))} strings, lang={args.lang})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
