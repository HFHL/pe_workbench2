#!/usr/bin/env python3
"""Generate a small Chinese PDF fixture for scripts/test-pdf.mjs.

Three pages:
  1. image-only cover  -> must be reported as a scanned/no-text page
  2. prose + headings  -> must be found by page text and keyword search
  3. a ruled table     -> must be extractable with --tables

Requires reportlab (+ Pillow for the cover). The test script skips when they
are missing, the same way the workbook test skips without openpyxl.
"""

import sys

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

FONT = "STSong-Light"
pdfmetrics.registerFont(UnicodeCIDFont(FONT))

BODY = ParagraphStyle("body", fontName=FONT, fontSize=10.5, leading=18)
HEAD = ParagraphStyle("head", fontName=FONT, fontSize=14, leading=22)

PAGE_2 = [
    ("head", "一、行业概览与核心结论"),
    ("body", "本纪要讨论 HBM 的接口设计与定制趋势。专家在美光负责 HBM 基座裸片的接口，"),
    ("body", "一侧连接 GPU，一侧连接 DRAM 核心裸片。随着引脚速率提升，信道损耗与布线难度同"),
    ("body", "时上升，厂商需要在更多内部通路上分摊速率。"),
    ("body", "财务口径上，公司 2026 年收入预计增长 18%，毛利率维持在 42% 左右；资本开支"),
    ("body", "主要用于 HBM 产能扩张。以上数字仅用于测试检索，不构成投资建议。"),
]

PAGE_3 = [
    ("head", "二、风险因素"),
    ("body", "客户集中度较高，若主要客户调整产品路线，收入与毛利率可能承压。"),
]

TABLE = [
    ["指标", "2025A", "2026E"],
    ["收入", "1,200", "1,416"],
    ["毛利率", "40%", "42%"],
]


def draw_paragraphs(pdf, items, top):
    y = top
    for kind, text in items:
        style = HEAD if kind == "head" else BODY
        # The fixture is short: wrap by character count, CJK has no spaces.
        width = 34 if kind == "body" else 24
        for start in range(0, len(text), width):
            pdf.setFont(FONT, style.fontSize)
            pdf.drawString(22 * mm, y, text[start:start + width])
            y -= style.leading
        y -= 4


def make_cover(path):
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (640, 360), (244, 241, 234))
    draw = ImageDraw.Draw(image)
    draw.rectangle([40, 40, 600, 320], outline=(60, 60, 60), width=3)
    draw.text((80, 150), "COVER", fill=(60, 60, 60))
    image.save(path)


def main(target):
    cover = target + ".cover.png"
    make_cover(cover)

    pdf = canvas.Canvas(target, pagesize=A4)
    width, height = A4

    pdf.drawImage(cover, 0, 0, width=width, height=height, preserveAspectRatio=False)
    pdf.showPage()

    draw_paragraphs(pdf, PAGE_2, height - 30 * mm)
    pdf.showPage()

    draw_paragraphs(pdf, PAGE_3, height - 30 * mm)
    table = Table(TABLE, colWidths=[60 * mm, 40 * mm, 40 * mm])
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), FONT),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("GRID", (0, 0), (-1, -1), 0.8, (0.12, 0.12, 0.12)),
        ("BACKGROUND", (0, 0), (-1, 0), (0.94, 0.93, 0.91)),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ]))
    table.wrapOn(pdf, width, height)
    table.drawOn(pdf, 22 * mm, height - 120 * mm)
    pdf.showPage()
    pdf.save()
    print(target)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.stderr.write("usage: make-pdf-fixture.py OUT.pdf\n")
        raise SystemExit(2)
    main(sys.argv[1])
