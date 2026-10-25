#!/usr/bin/env python3
"""生成 miniprogram/utils/mock/demo-images.js（离线模拟用的演示附件 PNG）。

演示附件需要在不联网、不带二进制资源的前提下也能预览，因此把几张很小的
PNG（16 色调色板）以 base64 形式内嵌进 JS 模块。重新生成：

    python3 scripts/make_demo_images.py
"""
from __future__ import annotations

import base64
import io
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "miniprogram" / "utils" / "mock" / "demo-images.js"
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"


def font(size: int):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def make(title: str, subtitle: str, body: list[str], accent: str) -> bytes:
    width, height = 360, 240
    img = Image.new("RGB", (width, height), "#ffffff")
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, width, 54], fill=accent)
    draw.text((16, 16), title, font=font(20), fill="#ffffff")
    draw.text((16, 62), subtitle, font=font(13), fill="#5a6072")
    y = 88
    for line in body:
        draw.text((16, y), line, font=font(12), fill="#1f2430")
        y += 20
    draw.line([(16, y + 4), (width - 16, y + 4)], fill="#dfe3ef", width=1)
    draw.text((16, y + 10), "智慧校园 · 演示附件", font=font(13), fill="#8a90a2")
    buf = io.BytesIO()
    img.convert("P", palette=Image.ADAPTIVE, colors=16).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


IMAGES = {
    "homework": make(
        "函数与导数 · 周末练习",
        "陈小满  G2603-01",
        [
            "1. 导数定义：f'(x) = lim (f(x+h)-f(x))/h",
            "2. 第 3 题使用链式法则：",
            "   y = sin(2x+1)  =>  y' = 2cos(2x+1)",
            "3. 单调区间：(-inf,-1) 递增，(1,+inf) 递增",
        ],
        "#0010ff",
    ),
    "leave": make(
        "研学活动请假申请",
        "陈小满  G2603-01",
        [
            "请假事由：家庭安排，无法参加 11 月 5 日研学活动。",
            "家长签字：陈××",
            "联系电话：138****6721",
        ],
        "#0010ff",
    ),
    "photo": make(
        "秋日校园 · 银杏大道",
        "摄影：李知遥",
        [
            "拍摄时间：周三 17:20",
            "地点：教学楼东侧银杏大道",
            "说明：逆光下的落叶层次分明。",
        ],
        "#2a3346",
    ),
}

TAIL = """ 
/** 生成 `{name, mime, data}` 形式的附件（base64，不含 data URL 前缀） */
function image(name, fileName) {
  var b64 = IMAGES[name];
  if (!b64) return null;
  return { name: fileName || name + ".png", mime: "image/png", data: b64 };
}

/** 直接给出 data URL 字符串，用于演示 `/api/upload` 兼容的 data 数组 */
function dataUrl(name) {
  var b64 = IMAGES[name];
  return b64 ? "data:image/png;base64," + b64 : "";
}

module.exports = { IMAGES: IMAGES, image: image, dataUrl: dataUrl };
"""


def main() -> int:
    lines = [
        "/* 离线模拟用的演示附件（内嵌 PNG，避免依赖网络）。生成脚本见 scripts/make_demo_images.py。 */",
        "var IMAGES = {",
    ]
    for name, data in IMAGES.items():
        lines.append('  %s: "%s",' % (name, base64.b64encode(data).decode()))
    lines.append("};")
    OUT.write_text("\n".join(lines) + "\n" + TAIL, encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(IMAGES)} images)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
