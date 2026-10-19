#!/usr/bin/env python3
"""
Export a compact, read-only preview of an Excel workbook.

The parser is intentionally separate from parse_workbook.py: the formula graph
only needs cells that participate in formulas, while the preview needs layout,
styles and every display value. The output is a gzipped JSON document consumed
by lib/excel-preview.mjs and rendered by a virtualised grid in app.js.

Shape (schemaVersion 1):
  {
    schemaVersion, parserVersion, fileName, props,
    styles: [{ b,i,u,st,sz,fc,bg,ft,h,v,wrap,ind,nf,bd }],
    sheets: [{
      name, state, rowCount, colCount, originalRowCount, originalColCount,
      truncated, freeze, merges: [[r1,c1,r2,c2]], cols: {c: [width,hidden]},
      rows: {r: [height,hidden]}, tab, cells: [[r,c,value,formula,style]]
    }]
  }

Cells use 1-based row/column numbers. `value` is the cached display value for
formula cells, so the viewer can switch between values and formulas without a
second round trip. Styles are indexed into the workbook-level style table.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import gzip
import json
import sys
import time
import warnings
from decimal import Decimal
from pathlib import Path
from typing import Any

PARSER_VERSION = 2
SCHEMA_VERSION = 1

MAX_ROWS = 4_000
MAX_COLS = 320
MAX_CELL_CHARS = 1_000
MAX_MERGES = 5_000
MAX_STYLE_INDENT = 8

# Office default theme colours. Excel stores theme indexes instead of RGB for
# many cells; this keeps the common case faithful without shipping a theme file.
THEME_COLORS = [
    "FFFFFF", "000000", "E7E6E6", "44546A",
    "4472C4", "ED7D31", "A5A5A5", "FFC000",
    "5B9BD5", "70AD47", "0563C1", "954F72",
    "4F81BD", "C0504D", "9BBB59", "8064A2",
]

try:  # openpyxl is already required by the workbook graph parser.
    import openpyxl
    from openpyxl.styles.colors import COLOR_INDEX
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.formula import ArrayFormula, DataTableFormula
except ModuleNotFoundError as error:  # pragma: no cover - host dependent
    print(
        "openpyxl is required: pip install openpyxl (missing module: %s)" % error.name,
        file=sys.stderr,
    )
    raise SystemExit(3)


def ext_of(path: Path) -> str:
    return path.suffix.lower()


def safe_value(value: Any) -> Any:
    """Convert a Python/openpyxl value into a JSON-safe display scalar."""
    if value is None or isinstance(value, (bool, int, str)):
        if isinstance(value, str):
            return value[:MAX_CELL_CHARS]
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        # Avoid 0.30000000000000004 leaking into the UI.
        return float(f"{value:.12g}")
    if isinstance(value, Decimal):
        try:
            return float(f"{float(value):.12g}")
        except (ValueError, OverflowError):
            return str(value)[:MAX_CELL_CHARS]
    if isinstance(value, dt.datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    if isinstance(value, (bytes, bytearray)):
        return "base64:" + base64.b64encode(value[:200]).decode("ascii")
    text = str(value)
    return text[:MAX_CELL_CHARS]


def apply_tint(hex_color: str, tint: float) -> str:
    if not tint:
        return hex_color
    tint = max(-1.0, min(1.0, float(tint)))
    try:
        r = int(hex_color[0:2], 16)
        g = int(hex_color[2:4], 16)
        b = int(hex_color[4:6], 16)
    except (ValueError, IndexError):
        return hex_color

    def channel(c: int) -> int:
        if tint < 0:
            return int(round(c * (1.0 + tint)))
        return int(round(c * (1.0 - tint) + 255 * tint))

    return f"{channel(r):02X}{channel(g):02X}{channel(b):02X}"


def color_hex(color: Any) -> str | None:
    """Return an RRGGBB string for rgb/indexed/theme colors."""
    if color is None:
        return None
    try:
        kind = getattr(color, "type", None)
        tint = float(getattr(color, "tint", 0) or 0)
        rgb = getattr(color, "rgb", None)
        if kind == "rgb" and isinstance(rgb, str) and len(rgb) >= 6:
            candidate = rgb[-6:].upper()
            # openpyxl sometimes surfaces an all-zero alpha placeholder.
            if candidate != "000000" or rgb.upper().endswith("000000"):
                return apply_tint(candidate, tint)
            return None
        if kind == "indexed":
            index = getattr(color, "indexed", None)
            if isinstance(index, int) and 0 <= index < len(COLOR_INDEX):
                candidate = COLOR_INDEX[index][-6:].upper()
                if candidate != "000000" or index in (0, 1, 8):
                    return apply_tint(candidate, tint)
            return None
        if kind == "theme":
            theme = getattr(color, "theme", None)
            if isinstance(theme, int) and 0 <= theme < len(THEME_COLORS):
                return apply_tint(THEME_COLORS[theme], tint)
            return None
    except (TypeError, ValueError):
        return None
    return None


def border_bits(border: Any) -> int | None:
    if border is None:
        return None
    bits = 0
    for bit, side_name in ((1, "top"), (2, "right"), (4, "bottom"), (8, "left")):
        side = getattr(border, side_name, None)
        style = getattr(side, "style", None) if side is not None else None
        if style and style != "none":
            bits |= bit
    return bits or None


def style_of(cell: Any, style_index: dict[tuple, int], style_table: list[dict]) -> int:
    font = cell.font
    fill = cell.fill
    alignment = cell.alignment
    has_fill = bool(fill and fill.fill_type and fill.fill_type != "none")
    bg = color_hex(fill.fgColor) if has_fill else None
    # A solid white fill is visually the same as the default paper, but keep it
    # so alternating/banded tables survive the preview.
    if has_fill and bg is None:
        bg = color_hex(fill.bgColor)
    bits = border_bits(cell.border)
    number_format = cell.number_format or "General"
    if number_format == "General":
        number_format = None

    horizontal = getattr(alignment, "horizontal", None)
    vertical = getattr(alignment, "vertical", None)
    indent = getattr(alignment, "indent", None)
    try:
        indent = min(MAX_STYLE_INDENT, max(0, int(indent or 0)))
    except (TypeError, ValueError):
        indent = 0

    key = (
        bool(font.bold),
        bool(font.italic),
        bool(font.underline),
        bool(font.strike),
        float(font.sz) if font.sz else None,
        color_hex(font.color),
        bg,
        number_format,
        horizontal,
        vertical,
        bool(alignment.wrap_text),
        indent,
        bits,
    )
    if key in style_index:
        return style_index[key]

    index = len(style_table)
    style_index[key] = index
    style_table.append(
        {
            "b": 1 if key[0] else None,
            "i": 1 if key[1] else None,
            "u": 1 if key[2] else None,
            "st": 1 if key[3] else None,
            "sz": key[4],
            "fc": key[5],
            "bg": key[6],
            "nf": key[7],
            "h": key[8],
            "v": key[9],
            "wrap": 1 if key[10] else None,
            "ind": key[11] or None,
            "bd": key[12],
        }
    )
    return index


def is_blank_but_visible(cell: Any) -> bool:
    fill = cell.fill
    if fill and fill.fill_type and fill.fill_type != "none":
        return True
    return border_bits(cell.border) is not None


def clamp_range(value: int, maximum: int) -> int:
    return max(1, min(int(value or 1), maximum))


def sheet_payload(ws: Any, ws_values: Any, style_index: dict, style_table: list) -> dict:
    original_rows = int(ws.max_row or 1)
    original_cols = int(ws.max_column or 1)
    max_row = min(original_rows, MAX_ROWS)
    max_col = min(original_cols, MAX_COLS)

    cells: list[list[Any]] = []
    for row in ws.iter_rows(min_row=1, max_row=max_row, max_col=max_col):
        for cell in row:
            raw = cell.value
            formula = None
            if isinstance(raw, (ArrayFormula, DataTableFormula)):
                formula = getattr(raw, "text", None)
                raw = ws_values.cell(cell.row, cell.column).value if ws_values is not None else None
            elif isinstance(raw, str) and raw.startswith("="):
                formula = raw
                raw = ws_values.cell(cell.row, cell.column).value if ws_values is not None else None

            if raw is None and not formula and not is_blank_but_visible(cell):
                continue

            style_id = style_of(cell, style_index, style_table)
            cells.append([cell.row, cell.column, safe_value(raw), formula, style_id])
            if len(cells) >= MAX_ROWS * MAX_COLS:
                break
        if len(cells) >= MAX_ROWS * MAX_COLS:
            break

    merges: list[list[int]] = []
    for merged in ws.merged_cells.ranges:
        r1 = clamp_range(merged.min_row, max_row)
        c1 = clamp_range(merged.min_col, max_col)
        r2 = clamp_range(merged.max_row, max_row)
        c2 = clamp_range(merged.max_col, max_col)
        if r1 == r2 and c1 == c2:
            continue
        merges.append([r1, c1, r2, c2])
        if len(merges) >= MAX_MERGES:
            break

    cols: dict[str, list[Any]] = {}
    for key, dimension in ws.column_dimensions.items():
        try:
            index = openpyxl.utils.column_index_from_string(key)
        except (ValueError, KeyError):
            continue
        if index > max_col:
            continue
        width = float(dimension.width) if dimension.width is not None else None
        hidden = bool(dimension.hidden)
        if width is None and not hidden:
            continue
        cols[str(index)] = [width, hidden]

    rows: dict[str, list[Any]] = {}
    for index, dimension in ws.row_dimensions.items():
        try:
            row_index = int(index)
        except (TypeError, ValueError):
            continue
        if row_index > max_row:
            continue
        height = float(dimension.height) if dimension.height is not None else None
        hidden = bool(dimension.hidden)
        if height is None and not hidden:
            continue
        rows[str(row_index)] = [height, hidden]

    tab = None
    tab_color = getattr(ws.sheet_properties, "tabColor", None)
    if tab_color is not None:
        tab = color_hex(tab_color)

    return {
        "name": ws.title,
        "state": ws.sheet_state or "visible",
        "rowCount": max_row,
        "colCount": max_col,
        "originalRowCount": original_rows,
        "originalColCount": original_cols,
        "truncated": original_rows > max_row or original_cols > max_col,
        "freeze": ws.freeze_panes if isinstance(ws.freeze_panes, str) else None,
        "merges": merges,
        "cols": cols,
        "rows": rows,
        "tab": tab,
        "cells": cells,
    }


def workbook_props(wb: Any) -> dict:
    props = wb.properties
    def iso(value: Any) -> str | None:
        if isinstance(value, (dt.datetime, dt.date)):
            return value.isoformat()
        return None

    return {
        "title": getattr(props, "title", None),
        "creator": getattr(props, "creator", None) or getattr(props, "lastModifiedBy", None),
        "subject": getattr(props, "subject", None),
        "description": getattr(props, "description", None),
        "created": iso(getattr(props, "created", None)),
        "modified": iso(getattr(props, "modified", None)),
        "activeSheet": wb.active.title if wb.active is not None else None,
    }


def export_preview(path: Path) -> dict:
    started = time.time()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wb = openpyxl.load_workbook(path, data_only=False, read_only=False, keep_links=False)
        wb_values = openpyxl.load_workbook(path, data_only=True, read_only=False, keep_links=False)

    style_index: dict[tuple, int] = {}
    style_table: list[dict] = []
    sheets: list[dict] = []
    warnings_out: list[str] = []

    for ws in wb.worksheets:
        try:
            payload = sheet_payload(ws, wb_values[ws.title], style_index, style_table)
            sheets.append(payload)
        except Exception as error:  # keep the rest of the workbook usable
            warnings_out.append(f"{ws.title}: {error}")

    total_cells = sum(len(sheet["cells"]) for sheet in sheets)
    truncated_sheets = [sheet["name"] for sheet in sheets if sheet["truncated"]]
    stats = {
        "sheetCount": len(sheets),
        "cellCount": total_cells,
        "styleCount": len(style_table),
        "truncatedSheets": truncated_sheets,
        "parseMs": int((time.time() - started) * 1000),
    }

    return {
        "schemaVersion": SCHEMA_VERSION,
        "parserVersion": PARSER_VERSION,
        "fileName": path.name,
        "props": workbook_props(wb),
        "styles": style_table,
        "sheets": sheets,
        "stats": stats,
        "warnings": warnings_out[:20],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path, help="xlsx/xlsm file to read")
    parser.add_argument("--out", type=Path, required=True, help="gzipped JSON output")
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args()

    if args.version:
        print(PARSER_VERSION)
        return
    if not args.file.exists():
        parser.error(f"file not found: {args.file}")
    if ext_of(args.file) not in (".xlsx", ".xlsm", ".xltx", ".xltm"):
        print(f"unsupported workbook format: {args.file.suffix}", file=sys.stderr)
        raise SystemExit(4)

    print(f"Exporting preview for {args.file.name} ...", file=sys.stderr)
    doc = export_preview(args.file)
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(args.out.suffix + ".tmp")
    with gzip.open(tmp, "wb", compresslevel=6) as handle:
        handle.write(raw)
    tmp.replace(args.out)
    print(
        "Done: %s sheets, %s cells, %s styles, %.1f MB raw, %.1f MB gz, %sms"
        % (
            doc["stats"]["sheetCount"],
            doc["stats"]["cellCount"],
            doc["stats"]["styleCount"],
            len(raw) / 1024 / 1024,
            args.out.stat().st_size / 1024 / 1024,
            doc["stats"]["parseMs"],
        ),
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
