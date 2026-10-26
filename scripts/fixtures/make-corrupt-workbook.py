#!/usr/bin/env python3
"""Generate small workbooks with damaged *optional* parts.

Used by scripts/test-workbook.mjs to prove that a corrupt drawing, image,
comment or hyperlink does not discard the cell data.

Modes:
  emf        an EMF image whose bounds/frame are 0x0, which makes Pillow raise
             ZeroDivisionError while computing DPI (the 泡泡马特 model bug)
  drawing    a truncated drawing XML part
  comments   a truncated comments part
  hyperlink  a hyperlink with a dangling relationship id
  clean      no damage (control case)

Usage:
  python3 make-corrupt-workbook.py <out.xlsx> [mode]
"""

from __future__ import annotations

import io
import struct
import sys
import zipfile
from pathlib import Path

import openpyxl
from openpyxl.comments import Comment

REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
DRAWING_MAIN_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def zero_frame_emf() -> bytes:
    """A minimal EMR_HEADER with zero bounds and zero frame."""
    header = struct.pack("<II", 1, 88)
    header += struct.pack("<4i", 0, 0, 0, 0)  # rclBounds
    header += struct.pack("<4i", 0, 0, 0, 0)  # rclFrame -> /0 in Pillow
    header += b" EMF"
    header += struct.pack("<IIIIII", 0x10000, 0, 0, 0, 0, 0)
    header += struct.pack("<II", 0, 0)
    header += struct.pack("<4i", 0, 0, 0, 0)
    header += struct.pack("<2i", 0, 0)
    return header.ljust(88, b"\x00")


def drawing_xml(broken: bool) -> bytes:
    if broken:
        return b'<xdr:wsDr xmlns:xdr="' + DRAWING_NS.encode() + b'"><xdr:oneCellAnchor>'
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<xdr:wsDr xmlns:xdr="{DRAWING_NS}" xmlns:a="{DRAWING_MAIN_NS}">'
        "<xdr:oneCellAnchor>"
        "<xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff>"
        "<xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>"
        '<xdr:ext cx="9525" cy="9525"/>'
        "<xdr:pic><xdr:nvPicPr>"
        '<xdr:cNvPr id="2" name="logo"/><xdr:cNvPicPr/>'
        "</xdr:nvPicPr><xdr:blipFill>"
        f'<a:blip xmlns:r="{REL_NS}" r:embed="rId1"/>'
        "<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>"
        "<xdr:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/>"
        '<a:ext cx="9525" cy="9525"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>'
        "</xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>"
    ).encode("utf-8")


DRAWING_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    f'<Relationship Id="rId1" Type="{REL_NS}/image" Target="../media/image1.emf"/>'
    "</Relationships>"
).encode("utf-8")

SHEET_DRAWING_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    f'<Relationship Id="rId1" Type="{REL_NS}/drawing" Target="../drawings/drawing1.xml"/>'
    "</Relationships>"
).encode("utf-8")


def build_base(out: io.BytesIO, with_comment: bool = False) -> None:
    workbook = openpyxl.Workbook()
    ws = workbook.active
    ws.title = "Model"
    ws.append(["Metric", 2024, 2025, 2026])
    ws.append(["Revenue", 100, 110, 121])
    ws.append(["COGS", 40, 44, 48])
    ws.append(["Gross profit", "=B2-B3", "=C2-C3", "=D2-D3"])
    ws.append(["Gross margin", "=B4/B2", "=C4/C2", "=D4/D2"])
    ws.append(["EBITDA", "=B4*0.8", "=C4*0.8", "=D4*0.8"])
    if with_comment:
        ws["A1"].comment = Comment("note", "test")
    workbook.save(out)


def add_drawing_namespace(data: bytes) -> bytes:
    text = data.decode("utf-8")
    if "xmlns:r=" not in text[:2000]:
        text = text.replace("<worksheet ", f'<worksheet xmlns:r="{REL_NS}" ', 1)
    return text.encode("utf-8")


def patch_sheet(data: bytes, mode: str) -> bytes:
    data = add_drawing_namespace(data)
    if mode in ("emf", "drawing"):
        return data.replace(b"</worksheet>", b'<drawing r:id="rId1"/></worksheet>')
    if mode == "hyperlink":
        return data.replace(
            b"</worksheet>",
            b'<hyperlinks><hyperlink ref="A1" r:id="rId99"/></hyperlinks></worksheet>',
        )
    return data


def patch_content_types(data: bytes, mode: str) -> bytes:
    if mode not in ("emf", "drawing"):
        return data
    return data.replace(
        b"</Types>",
        b'<Default Extension="emf" ContentType="image/x-emf"/></Types>',
    )


def make(out: Path, mode: str) -> None:
    buffer = io.BytesIO()
    build_base(buffer, with_comment=mode == "comments")
    buffer.seek(0)

    with zipfile.ZipFile(buffer) as source, zipfile.ZipFile(
        out, "w", zipfile.ZIP_DEFLATED
    ) as target:
        for info in source.infolist():
            data = source.read(info.filename)
            name = info.filename

            if name.startswith("xl/worksheets/") and name.endswith(".xml"):
                data = patch_sheet(data, mode)
            elif name == "[Content_Types].xml":
                data = patch_content_types(data, mode)
            elif mode == "comments" and name.startswith("xl/comments"):
                data = b"<comments><authors><author>test</author>"

            target.writestr(info, data)

        if mode in ("emf", "drawing"):
            target.writestr(
                "xl/worksheets/_rels/sheet1.xml.rels", SHEET_DRAWING_RELS
            )
            target.writestr(
                "xl/drawings/drawing1.xml", drawing_xml(broken=mode == "drawing")
            )
            target.writestr(
                "xl/drawings/_rels/drawing1.xml.rels", DRAWING_RELS
            )
            target.writestr("xl/media/image1.emf", zero_frame_emf())


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: make-corrupt-workbook.py <out.xlsx> [mode]")
    out = Path(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else "emf"
    if mode not in {"emf", "drawing", "comments", "hyperlink", "clean"}:
        raise SystemExit(f"unknown mode: {mode}")
    out.parent.mkdir(parents=True, exist_ok=True)
    make(out, mode)
    print(out)


if __name__ == "__main__":
    main()
