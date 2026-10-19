#!/usr/bin/env python3
"""PDF -> JSON text document for the Workbench agent.

Design constraints:

- One parse per blob sha; the caller caches the gzipped JSON. The output here is
  compact (page paragraphs, not every glyph), so a 100-page research report
  stays in the low megabytes before gzip.
- Text first: pdfplumber keeps reading order better than pypdf for CJK reports,
  pypdf is only used for metadata/outline and as a fallback when pdfplumber
  cannot open the file.
- Page numbers are preserved everywhere. The agent must be able to cite p.N.
- Scanned pages are reported instead of silently returning "".
- Tables are opt-in (`--tables`): extraction is the slowest part of pdfplumber
  and most agent reads only need prose.

Usage:
  python3 parse_pdf.py FILE
  python3 parse_pdf.py FILE --tables [--pages 2-4]

Stdout is a single JSON object. Errors exit non-zero with a message on stderr.
"""

import argparse
import json
import re
import sys
import unicodedata

SCHEMA_VERSION = 1
PARSER_VERSION = 1

CJK = r"\u3400-\u9fff\u3000-\u303f\uff00-\uffef"
CJK_RE = re.compile(f"[{CJK}]")
SENTENCE_END = "。！？!?；;…：:”』」）)》"
PAGE_NUMBER_LINE = re.compile(
    r"^\s*(?:[-—–]{0,2}\s*\d{1,4}\s*[-—–]{0,2}|\d{1,4}\s*/\s*\d{1,4}|第\s*\d{1,4}\s*页(?:\s*[/／]\s*共\s*\d{1,4}\s*页)?|page\s*\d{1,4}(?:\s*of\s*\d{1,4})?)\s*$",
    re.IGNORECASE,
)
SPEAKER_LINE = re.compile(r"^(?:主持人|专家|嘉宾|记者|编辑|问|答|受访人|访谈者)\s*[:：]")
LIST_ITEM = re.compile(r"^(?:\d{1,2}\s*[.．、)）]|[（(]\d{1,2}[）)]|[•·▪◦]\s*)")
SECTION_L1 = re.compile(r"^(?:[一二三四五六七八九十百]+、|第[一二三四五六七八九十百]+[章节部分])")
SECTION_L2 = re.compile(r"^(?:[（(][一二三四五六七八九十百]+[）)]|[A-Z][.、]\s+\S)")
KNOWN_HEADING = re.compile(
    r"^(?:核心要点|要点|摘要|内容摘要|投资要点|投资摘要|风险提示|结论|引言|前言|背景|附录|免责声明)\s*$"
)
CALLOUT = re.compile(r"^(?:编者注|注|资料来源|数据来源|来源)\s*[｜|:：]")

MAX_TABLE_ROWS = 200
MAX_TABLE_COLS = 24


class PdfError(Exception):
    """Expected, user-facing parse failure."""


def norm_text(value):
    """Normalise whitespace/unicode without collapsing paragraph structure."""
    text = unicodedata.normalize("NFC", str(value or ""))
    text = text.replace("\u00ad", "")
    text = re.sub(r"[\u200b-\u200d\u2060\ufeff]", "", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    return text


def dehyphenate(lines):
    """Join Latin words split by a trailing hyphen across a line break."""
    out = []
    for line in lines:
        if out and out[-1].endswith("-") and re.match(r"^[a-z]", line):
            out[-1] = out[-1][:-1] + line
        else:
            out.append(line)
    return out


def is_cjk(ch):
    return bool(ch) and bool(CJK_RE.match(ch))


def join_lines(left, right):
    if not left:
        return right
    if left.endswith("-") and re.match(r"^[a-z]", right):
        return left[:-1] + right
    if line_breaks_paragraph(left, right):
        return None  # caller starts a new paragraph
    joiner = "" if (is_cjk(left[-1]) or is_cjk(right[0])) else " "
    return left + joiner + right


def line_breaks_paragraph(left, right):
    if not left:
        return False
    if left[-1] in SENTENCE_END:
        return True
    if SPEAKER_LINE.match(right):
        return True
    if SECTION_L1.match(right) or SECTION_L2.match(right) or KNOWN_HEADING.match(right):
        return True
    if LIST_ITEM.match(right) and not LIST_ITEM.match(left):
        return True
    if CALLOUT.match(right):
        return True
    # A short line that does not end in punctuation is usually a heading.
    if len(left) <= 24 and left[-1] not in "，,、；;：:（(":
        return True
    return False


def split_long_paragraph(text, limit=1600):
    """Split an over-long paragraph on sentence boundaries (keeps reading order)."""
    if len(text) <= limit:
        return [text]
    parts = []
    buf = ""
    for piece in re.split(r"(?<=[。！？!?；;])", text):
        if not piece:
            continue
        if len(buf) + len(piece) > limit and buf:
            parts.append(buf)
            buf = piece
        else:
            buf += piece
    if buf:
        parts.append(buf)
    return parts


def heading_level(line):
    stripped = line.strip()
    if not stripped:
        return 0
    if KNOWN_HEADING.match(stripped):
        return 2
    if SECTION_L1.match(stripped) and len(stripped) <= 44:
        return 1
    if SECTION_L2.match(stripped) and len(stripped) <= 44:
        return 2
    return 0


def clean_lines(raw_text):
    lines = [line.strip() for line in norm_text(raw_text).split("\n")]
    lines = [line for line in lines if line]
    lines = [line for line in lines if not PAGE_NUMBER_LINE.match(line)]
    return dehyphenate(lines)


def build_paragraphs(raw_text):
    """Group hard-wrapped lines into paragraphs; return (paragraphs, headings)."""
    paragraphs = []
    headings = []
    buf = ""
    for line in clean_lines(raw_text):
        level = heading_level(line)
        if level:
            if buf:
                paragraphs.extend(split_long_paragraph(buf))
                buf = ""
            paragraphs.append(line)
            headings.append({"text": line, "level": level})
            continue
        if SPEAKER_LINE.match(line) or LIST_ITEM.match(line) or CALLOUT.match(line):
            if buf:
                paragraphs.extend(split_long_paragraph(buf))
            buf = line
            continue
        merged = join_lines(buf, line)
        if merged is None:
            if buf:
                paragraphs.extend(split_long_paragraph(buf))
            buf = line
        else:
            buf = merged
    if buf:
        paragraphs.extend(split_long_paragraph(buf))
    return paragraphs, headings


def parse_pages_argument(value, total):
    """Parse "3", "2-4", "1,5-6" into a sorted unique page list (1-based)."""
    pages = set()
    for part in str(value or "").split(","):
        part = part.strip()
        if not part:
            continue
        match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if match:
            start, end = int(match.group(1)), int(match.group(2))
            if start > end:
                start, end = end, start
            pages.update(range(start, min(end, total) + 1))
        elif part.isdigit():
            pages.add(int(part))
        else:
            raise PdfError(f"无法识别的页码：{part}（示例：2、2-4、1,5-6）")
    return sorted(p for p in pages if 1 <= p <= total)


def extract_metadata(path):
    meta = {}
    outline = []
    try:
        from pypdf import PdfReader
    except Exception:
        return meta, outline
    try:
        reader = PdfReader(path)
        info = reader.metadata or {}
        meta = {
            "title": str(info.get("/Title") or "").strip(),
            "author": str(info.get("/Author") or "").strip(),
            "subject": str(info.get("/Subject") or "").strip(),
            "creator": str(info.get("/Creator") or "").strip(),
            "producer": str(info.get("/Producer") or "").strip(),
            "createdAt": str(info.get("/CreationDate") or "").strip(),
            "encrypted": bool(reader.is_encrypted),
        }
        try:
            outline = flatten_outline(reader, reader.outline)
        except Exception:
            outline = []
    except Exception as error:  # metadata is best-effort
        meta = {"error": str(error)}
    return meta, outline


def flatten_outline(reader, items, depth=0, out=None, guard=0):
    out = out if out is not None else []
    if guard > 8 or len(out) > 300:
        return out
    for item in items or []:
        if isinstance(item, list):
            flatten_outline(reader, item, depth + 1, out, guard + 1)
            continue
        try:
            title = str(item.title or "").strip()
            page = reader.get_destination_page_number(item) + 1
        except Exception:
            continue
        if title:
            out.append({"title": title, "page": page, "level": depth + 1})
    return out


def open_pdfplumber(path):
    try:
        import pdfplumber
    except Exception as error:
        raise PdfError(f"缺少 pdfplumber，无法解析 PDF：{error}")
    try:
        return pdfplumber.open(path)
    except Exception as error:
        raise PdfError(f"无法打开 PDF：{error}")


def parse_with_pdfplumber(path):
    pdf = open_pdfplumber(path)
    pages = []
    headings = []
    scanned = []
    try:
        for index, page in enumerate(pdf.pages, start=1):
            try:
                raw = page.extract_text() or ""
            except Exception:
                raw = ""
            paragraphs, page_headings = build_paragraphs(raw)
            text = "\n\n".join(paragraphs)
            image_count = len(getattr(page, "images", []) or [])
            char_count = len(re.sub(r"\s+", "", text))
            is_scanned = char_count < 12 and image_count > 0
            if is_scanned:
                scanned.append(index)
            for heading in page_headings:
                headings.append({"page": index, "text": heading["text"], "level": heading["level"]})
            pages.append(
                {
                    "page": index,
                    "width": round(float(page.width or 0), 1),
                    "height": round(float(page.height or 0), 1),
                    "chars": char_count,
                    "images": image_count,
                    "scanned": is_scanned,
                    "paragraphs": paragraphs,
                }
            )
    finally:
        try:
            pdf.close()
        except Exception:
            pass
    return pages, headings, scanned, "pdfplumber"


def parse_with_pypdf(path):
    try:
        from pypdf import PdfReader
    except Exception as error:
        raise PdfError(f"缺少 pypdf，无法解析 PDF：{error}")
    try:
        reader = PdfReader(path)
    except Exception as error:
        raise PdfError(f"无法打开 PDF：{error}")
    if reader.is_encrypted:
        raise PdfError("PDF 已加密，无法读取正文；请先解除密码后重新上传。")
    pages = []
    headings = []
    scanned = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            raw = page.extract_text() or ""
        except Exception:
            raw = ""
        paragraphs, page_headings = build_paragraphs(raw)
        text = "\n\n".join(paragraphs)
        char_count = len(re.sub(r"\s+", "", text))
        is_scanned = char_count < 12
        if is_scanned:
            scanned.append(index)
        for heading in page_headings:
            headings.append({"page": index, "text": heading["text"], "level": heading["level"]})
        pages.append(
            {
                "page": index,
                "width": 0,
                "height": 0,
                "chars": char_count,
                "images": 0,
                "scanned": is_scanned,
                "paragraphs": paragraphs,
            }
        )
    return pages, headings, scanned, "pypdf"


def extract_tables(path, page_numbers):
    pdf = open_pdfplumber(path)
    tables = []
    try:
        total = len(pdf.pages)
        targets = page_numbers or list(range(1, total + 1))
        for number in targets:
            if number < 1 or number > total:
                continue
            try:
                found = pdf.pages[number - 1].extract_tables() or []
            except Exception:
                found = []
            for table_index, rows in enumerate(found, start=1):
                cleaned = []
                for row in rows[:MAX_TABLE_ROWS]:
                    cleaned.append([norm_text(cell).strip() if cell is not None else "" for cell in row[:MAX_TABLE_COLS]])
                if not any(any(cell for cell in row) for row in cleaned):
                    continue
                tables.append(
                    {
                        "page": number,
                        "index": table_index,
                        "rows": len(cleaned),
                        "cols": max((len(row) for row in cleaned), default=0),
                        "data": cleaned,
                    }
                )
            if len(tables) >= 40:
                break
    finally:
        try:
            pdf.close()
        except Exception:
            pass
    return tables


def parse(path, tables=False, page_spec=None):
    if not path:
        raise PdfError("缺少 PDF 路径")
    meta, outline = extract_metadata(path)
    if meta.get("encrypted"):
        raise PdfError("PDF 已加密，无法读取正文；请先解除密码后重新上传。")

    try:
        pages, headings, scanned, parser = parse_with_pdfplumber(path)
    except PdfError:
        pages, headings, scanned, parser = parse_with_pypdf(path)

    doc_chars = sum(page["chars"] for page in pages)
    if doc_chars == 0:
        hint = "该 PDF 没有可提取的文字，可能是扫描件或纯图片；需要 OCR 才能阅读正文。"
        if not scanned:
            scanned = list(range(1, len(pages) + 1))
        meta["warning"] = hint

    document = {
        "schema": SCHEMA_VERSION,
        "parser": parser,
        "version": PARSER_VERSION,
        "doc": {
            **{key: value for key, value in meta.items() if key != "error"},
            "pages": len(pages),
            "chars": doc_chars,
            "scannedPages": scanned,
            "headings": len(headings),
        },
        "outline": outline,
        "headings": headings,
        "pages": pages,
    }

    if tables:
        page_numbers = parse_pages_argument(page_spec, len(pages)) if page_spec else None
        document["tables"] = extract_tables(path, page_numbers)
    return document


def main(argv):
    parser = argparse.ArgumentParser(description="Parse a PDF into page-addressed JSON.")
    parser.add_argument("path")
    parser.add_argument("--tables", action="store_true", help="also extract tables (slower)")
    parser.add_argument("--pages", default="", help="only these pages for --tables, e.g. 2-4")
    args = parser.parse_args(argv)
    try:
        document = parse(args.path, tables=args.tables, page_spec=args.pages)
        json.dump(document, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    except PdfError as error:
        sys.stderr.write(str(error) + "\n")
        return 2
    except Exception as error:  # noqa: BLE001 - report, never dump a traceback body
        sys.stderr.write(f"PDF 解析失败：{error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
