#!/usr/bin/env python3
"""
Read a workbook without letting one damaged part discard the whole file.

openpyxl loads drawings, charts, comments, tables and pivot caches eagerly.
When any of those parts is corrupt it raises and the caller gets *nothing*,
even though every cell, formula and cached value may still be intact. A real
example: an EMF image inside a .wmf media part whose header says 0x0 pixels,
which makes Pillow raise ``ZeroDivisionError`` while computing DPI.

This module keeps the cell data reachable and reports what was skipped:

1. ``find_images`` (drawings, charts, images) is wrapped so a broken visual
   part becomes a warning instead of a fatal error. Healthy images/charts in
   the same drawing are kept, and other sheets are unaffected.
2. If openpyxl still fails, a temporary sanitised copy of the package is
   built and retried:
     tier 1 - all drawings are replaced by an empty (valid) drawing part;
     tier 2 - auxiliary parts (comments, tables, pivot caches/tables,
              external links, printer settings, customXml) and their
              relationships are removed;
     tier 3 - worksheet formatting/decoration is stripped so only cells,
              merges and column widths remain.
   Cell data, formulas, styles, merges, column/row dimensions are copied
   byte-for-byte. The original file is never modified.
3. If even the sanitised copies fail, the original exception is re-raised so
   genuinely unreadable files (encrypted, not a zip, truncated sheet XML)
   still produce a clear error.

Usage:
    from openpyxl_safe import load_workbook_resilient

    wb, warnings = load_workbook_resilient(path, data_only=False)
"""

from __future__ import annotations

import contextlib
import contextvars
import shutil
import tempfile
import warnings as py_warnings
import zipfile
from pathlib import Path
from typing import Any, Iterator
from xml.etree import ElementTree as ET

import openpyxl

MAX_WARNINGS = 12
MAX_WARNING_CHARS = 300

# Drawing XML is replaced by this empty but valid part for the first fallback
# tier. A drawing with no anchors references no images or charts.
EMPTY_DRAWING = (
    b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    b'<xdr:wsDr xmlns:xdr='
    b'"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>'
)

# Parts that only carry aux data. They are dropped in tier 2 together with the
# relationships that point at them, so openpyxl never tries to read them.
AUX_PART_PREFIXES = (
    "xl/comments",
    "xl/threadedComments/",
    "xl/people.xml",
    "xl/tables/",
    "xl/pivotCache/",
    "xl/pivotTables/",
    "xl/externalLinks/",
    "xl/calcChain.xml",
    "xl/printerSettings/",
    "xl/metadata.xml",
    "customXml/",
)

# Relationship types (last path segment) that must disappear with their part.
AUX_REL_TYPES = {
    "comments",
    "threadedComment",
    "table",
    "pivotCacheDefinition",
    "pivotCacheRecords",
    "pivotTable",
    "externalLink",
    "calcChain",
    "printerSettings",
    "customXml",
    "people",
}

# Worksheet elements whose relationship is gone in tier 2.
DROP_SHEET_TAGS = {"tableParts", "oleObjects", "controls"}
DROP_WORKBOOK_TAGS = {"externalReferences", "pivotCaches"}

# Tier 3 keeps only what cell extraction needs. Formatting and decorations are
# dropped so a malformed view/hyperlink/validation cannot block the cells.
KEEP_SHEET_TAGS = {
    "sheetPr",
    "dimension",
    "sheetFormatPr",
    "cols",
    "sheetData",
    "mergeCells",
}

_warning_sink: contextvars.ContextVar[list[str] | None] = contextvars.ContextVar(
    "workbook_loader_warnings", default=None
)


def _record(message: str) -> None:
    sink = _warning_sink.get()
    if sink is None:
        return
    text = " ".join(str(message).split())[:MAX_WARNING_CHARS]
    if text and text not in sink:
        sink.append(text)


def _error_text(error: BaseException) -> str:
    detail = str(error).strip()
    return f"{type(error).__name__}: {detail}" if detail else type(error).__name__


_PATCHED = False


def _salvage_drawing(archive: Any, path: str) -> tuple[list[Any], list[Any], bool]:
    """Re-read a drawing item by item so one bad image/chart is skipped.

    openpyxl parses the whole drawing in one go; a single corrupt image drops
    every chart and image in that part. This mirrors the same logic but keeps
    the healthy items. Returns ``(charts, images, handled)`` where ``handled``
    is False when even the drawing XML could not be understood.
    """
    try:
        from io import BytesIO

        from openpyxl.chart.chartspace import ChartSpace
        from openpyxl.chart.reader import read_chart
        from openpyxl.drawing.image import Image, PILImage
        from openpyxl.drawing.spreadsheet_drawing import SpreadsheetDrawing
        from openpyxl.packaging.relationship import (
            get_dependents,
            get_rel,
            get_rels_path,
        )
        from openpyxl.reader.drawings import IMAGE_NS
        from openpyxl.xml.functions import fromstring
    except Exception:  # pragma: no cover - openpyxl internals moved
        return [], [], False

    try:
        tree = fromstring(archive.read(path))
        drawing = SpreadsheetDrawing.from_tree(tree)
        rels_path = get_rels_path(path)
        deps = (
            get_dependents(archive, rels_path)
            if rels_path in archive.namelist()
            else None
        )
    except Exception:  # noqa: BLE001 - the drawing XML itself is broken
        return [], [], False

    charts: list[Any] = []
    for rel in getattr(drawing, "_chart_rels", []):
        try:
            chart_space = get_rel(archive, deps, rel.id, ChartSpace)
            chart = read_chart(chart_space)
            chart.anchor = rel.anchor
            charts.append(chart)
        except Exception as error:  # noqa: BLE001 - keep the other charts
            _record(
                f"图表无法解析，已跳过（{path} · {rel.id}：{_error_text(error)}）"
            )

    images: list[Any] = []
    if PILImage:
        for rel in getattr(drawing, "_blip_rels", []):
            dep = deps.get(rel.embed) if deps is not None else None
            if dep is None or dep.Type != IMAGE_NS:
                continue
            try:
                image = Image(BytesIO(archive.read(dep.target)))
            except Exception as error:  # noqa: BLE001 - keep the other images
                _record(
                    f"图片无法解析，已跳过（{dep.target}：{_error_text(error)}）"
                )
                continue
            if (image.format or "").upper() == "WMF":
                _record(f"图片是 WMF/EMF 元文件，无法保存，已跳过（{dep.target}）。")
                continue
            image.anchor = rel.anchor
            images.append(image)

    return charts, images, True


def install_tolerant_drawing_reader() -> None:
    """Make drawing/chart/image parse failures non-fatal (idempotent)."""
    global _PATCHED
    if _PATCHED:
        return

    from openpyxl.reader import drawings as drawings_reader
    from openpyxl.reader import excel as excel_reader

    original = drawings_reader.find_images

    def tolerant_find_images(archive: Any, path: str):
        try:
            return original(archive, path)
        except Exception as error:  # noqa: BLE001 - a bad part must not kill the load
            charts, images, handled = _salvage_drawing(archive, path)
            if not handled:
                _record(
                    f"图形/图表部件损坏，已跳过（{path}：{_error_text(error)}）；"
                    "单元格数据不受影响。"
                )
            return charts, images

    drawings_reader.find_images = tolerant_find_images
    # openpyxl.reader.excel imported the function by value.
    excel_reader.find_images = tolerant_find_images
    _PATCHED = True


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _xml_bytes(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="UTF-8", xml_declaration=True)


def _strip_relationships(data: bytes, dropped_types: set[str]) -> bytes:
    """Remove <Relationship> entries for parts that were dropped."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return data

    changed = False
    for parent in list(root.iter()):
        for child in list(parent):
            if _local_name(child.tag) != "Relationship":
                continue
            rel_type = (child.get("Type") or "").rsplit("/", 1)[-1]
            if rel_type in dropped_types:
                parent.remove(child)
                changed = True
    return _xml_bytes(root) if changed else data


def _strip_sheet_xml(data: bytes) -> bytes:
    """Drop worksheet elements that point at removed auxiliary parts."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return data

    changed = False
    for parent in list(root.iter()):
        for child in list(parent):
            if _local_name(child.tag) in DROP_SHEET_TAGS:
                parent.remove(child)
                changed = True
    return _xml_bytes(root) if changed else data


def _strip_sheet_decorations(data: bytes) -> bytes:
    """Tier 3: keep only the worksheet elements needed to read cells."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return data

    changed = False
    for child in list(root):
        if _local_name(child.tag) not in KEEP_SHEET_TAGS:
            root.remove(child)
            changed = True
    return _xml_bytes(root) if changed else data


def _strip_workbook_xml(data: bytes) -> bytes:
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return data

    changed = False
    for parent in list(root.iter()):
        for child in list(parent):
            if _local_name(child.tag) in DROP_WORKBOOK_TAGS:
                parent.remove(child)
                changed = True
    return _xml_bytes(root) if changed else data


def _strip_content_types(data: bytes, dropped: set[str]) -> bytes:
    if not dropped:
        return data
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return data

    changed = False
    for parent in list(root.iter()):
        for child in list(parent):
            if _local_name(child.tag) != "Override":
                continue
            part = (child.get("PartName") or "").lstrip("/")
            if part in dropped:
                parent.remove(child)
                changed = True
    return _xml_bytes(root) if changed else data


def _is_aux_part(name: str) -> bool:
    lowered = name.lower()
    return any(lowered.startswith(prefix.lower()) for prefix in AUX_PART_PREFIXES)


def _is_sheet_xml(name: str) -> bool:
    return (
        name.startswith("xl/worksheets/")
        and name.endswith(".xml")
        and "/_rels/" not in name
    )


def _is_drawing_xml(name: str) -> bool:
    return (
        name.startswith("xl/drawings/")
        and name.endswith(".xml")
        and "/_rels/" not in name
    )


def sanitized_copy(source: Path, target: Path, tier: int) -> list[str]:
    """Write a copy of *source* that openpyxl can read without optional parts.

    ``tier`` 1 stubs drawings; ``tier`` 2 additionally removes auxiliary parts
    and the XML/relationship references to them; ``tier`` 3 also strips
    worksheet formatting/decoration, keeping cells, merges and column widths.
    Returns the names of the parts that were stubbed or removed.
    """
    parts: set[str] = set()
    changed: set[str] = set()
    with zipfile.ZipFile(source) as zin:
        infos = [info for info in zin.infolist() if not info.filename.endswith("/")]
        names = {info.filename for info in infos}

        stubbed = {
            name for name in names if tier >= 1 and _is_drawing_xml(name)
        }
        dropped = {
            name for name in names if tier >= 2 and _is_aux_part(name)
        }

        with zipfile.ZipFile(target, "w") as zout:
            for info in infos:
                name = info.filename
                if name in dropped:
                    parts.add(name)
                    continue

                original_data = zin.read(name)
                data = original_data
                if name in stubbed:
                    data = EMPTY_DRAWING
                    parts.add(name)
                elif tier >= 2 and name.endswith(".rels"):
                    data = _strip_relationships(data, AUX_REL_TYPES)
                elif tier >= 2 and _is_sheet_xml(name):
                    data = _strip_sheet_xml(data)
                    if tier >= 3:
                        data = _strip_sheet_decorations(data)
                elif tier >= 2 and name == "xl/workbook.xml":
                    data = _strip_workbook_xml(data)
                elif name == "[Content_Types].xml":
                    data = _strip_content_types(data, dropped)
                if data is not original_data:
                    changed.add(name)
                zout.writestr(info, data)

    # Prefer concrete parts in the user-facing message; fall back to the sheet
    # XML when tier 3 only removed formatting.
    return sorted(parts or changed)


@contextlib.contextmanager
def _captured_warnings() -> Iterator[list[Any]]:
    """Record Python warnings; translate them once the block is done."""
    with py_warnings.catch_warnings(record=True) as caught:
        py_warnings.simplefilter("always")
        try:
            yield caught
        finally:
            for item in caught:
                message = str(item.message).strip()
                if message:
                    _record(message)


def _dedupe(warnings_out: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for message in warnings_out:
        if message in seen:
            continue
        seen.add(message)
        result.append(message)
        if len(result) >= MAX_WARNINGS:
            break
    return result


def load_workbook_resilient(
    path: Path | str,
    *,
    data_only: bool = False,
    read_only: bool = False,
    keep_links: bool = False,
    **load_kwargs: Any,
) -> tuple[Any, list[str]]:
    """Load a workbook, degrading gracefully when optional parts are damaged.

    Returns ``(workbook, warnings)``. Warnings are short, user-facing strings
    describing what was skipped; they never contain a traceback.
    """
    source = Path(path)
    warnings_out: list[str] = []
    install_tolerant_drawing_reader()

    token = _warning_sink.set(warnings_out)
    try:
        workbook = None
        original_error: BaseException | None = None
        with _captured_warnings():
            try:
                workbook = openpyxl.load_workbook(
                    source,
                    data_only=data_only,
                    read_only=read_only,
                    keep_links=keep_links,
                    **load_kwargs,
                )
            except Exception as first_error:  # noqa: BLE001 - retried below
                original_error = first_error

        if workbook is not None:
            return workbook, _dedupe(warnings_out)
        assert original_error is not None

        if read_only:
            # Read-only mode never parses drawings/comments; another failure is
            # not something a sanitised copy can fix.
            raise original_error

        tiers = (
            (1, "图形/图表"),
            (2, "批注/表格/透视表等辅助部件"),
            (3, "工作表格式与装饰"),
        )
        for tier, label in tiers:
            workdir = Path(tempfile.mkdtemp(prefix="workbook-safe-"))
            target = workdir / f"sanitized-{tier}{source.suffix or '.xlsx'}"
            try:
                touched = sanitized_copy(source, target, tier)
                if not touched:
                    continue
                with _captured_warnings():
                    workbook = openpyxl.load_workbook(
                        target,
                        data_only=data_only,
                        read_only=read_only,
                        keep_links=keep_links,
                        **load_kwargs,
                    )
                warnings_out.insert(
                    0,
                    f"原始文件的部分{label}无法解析，已跳过（"
                    + "、".join(touched[:4])
                    + ("等" if len(touched) > 4 else "")
                    + "）；单元格与公式数据完整。",
                )
                return workbook, _dedupe(warnings_out)
            except Exception as error:  # noqa: BLE001 - try the next tier
                _record(f"{label}降级重试仍失败（{_error_text(error)}）")
            finally:
                shutil.rmtree(workdir, ignore_errors=True)

        # Keep the original error: it describes the file better than a retry.
        raise original_error
    finally:
        _warning_sink.reset(token)
