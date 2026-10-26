#!/usr/bin/env python3
"""Read or write individual cells in an .xlsx workbook.

Used by the model-writer adapter. Values are written as literals; formulas
already in the workbook are never modified unless the caller writes that cell.

Usage:
  python3 workbook_values.py read  <file> <Sheet!A1> [Sheet!B2 ...]
  python3 workbook_values.py write <file> <out> <Sheet!A1=value> [...]

Output is a JSON object: {"ok": true, "values": {...}} for read, or
{"ok": true, "path": "..."} for write.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import openpyxl

    from openpyxl_safe import load_workbook_resilient
except ImportError:  # pragma: no cover - environment guard
    print(json.dumps({"ok": False, "error": "openpyxl is not installed"}))
    sys.exit(1)


def split_ref(ref: str) -> tuple[str, str]:
    if "!" not in ref:
        raise ValueError(f"cell reference must be Sheet!A1: {ref}")
    sheet, cell = ref.rsplit("!", 1)
    if not sheet or not cell:
        raise ValueError(f"cell reference must be Sheet!A1: {ref}")
    return sheet, cell.upper()


def parse_value(raw: str):
    text = raw.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return raw


def read_cells(
    file: str, refs: list[str], data_only: bool = True
) -> tuple[dict, list[str]]:
    workbook, load_warnings = load_workbook_resilient(
        file, data_only=data_only, read_only=True
    )
    values = {}
    try:
        for ref in refs:
            sheet, cell = split_ref(ref)
            if sheet not in workbook.sheetnames:
                raise ValueError(f"sheet not found: {sheet}")
            values[ref] = workbook[sheet][cell].value
    finally:
        workbook.close()
    return values, load_warnings


def write_cells(
    file: str, out: str, assignments: list[str]
) -> tuple[str, list[str]]:
    workbook, load_warnings = load_workbook_resilient(file, data_only=False)
    for assignment in assignments:
        if "=" not in assignment:
            raise ValueError(f"assignment must be Sheet!A1=value: {assignment}")
        ref, raw = assignment.split("=", 1)
        sheet, cell = split_ref(ref)
        if sheet not in workbook.sheetnames:
            raise ValueError(f"sheet not found: {sheet}")
        workbook[sheet][cell] = parse_value(raw)
    target = Path(out)
    target.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(target)
    return str(target), load_warnings


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    read = sub.add_parser("read")
    read.add_argument("file")
    read.add_argument("refs", nargs="+")
    read.add_argument("--formulas", action="store_true")

    write = sub.add_parser("write")
    write.add_argument("file")
    write.add_argument("out")
    write.add_argument("assignments", nargs="+")

    args = parser.parse_args()
    try:
        if args.command == "read":
            values, load_warnings = read_cells(
                args.file, args.refs, data_only=not args.formulas
            )
            payload = {"ok": True, "values": values}
            if load_warnings:
                payload["warnings"] = load_warnings
            print(json.dumps(payload))
        else:
            path, load_warnings = write_cells(args.file, args.out, args.assignments)
            payload = {"ok": True, "path": path}
            if load_warnings:
                payload["warnings"] = load_warnings
            print(json.dumps(payload))
    except Exception as error:  # keep the CLI machine-readable
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
