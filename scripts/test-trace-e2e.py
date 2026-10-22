#!/usr/bin/env python3
"""Browser E2E for the model trace and the one-question HITL.

Uses a throwaway storage root and a copy of the current SQLite/blob store.
Project file roots stay in the repository so the real 长鑫科技 artifacts are read.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PROJECT = "p-c1db281e"
PASSED = 0
FAILED = 0
FAILURES: list[str] = []


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


PORT = free_port()
BASE = f"http://127.0.0.1:{PORT}"


def api(method: str, path: str, body: dict | None = None, timeout: float = 30):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
        return json.loads(raw) if raw else None


def wait_health(timeout: float = 25.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            api("GET", "/api/health", timeout=2)
            return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError("server did not become healthy")


def check(name: str, fn) -> None:
    global PASSED, FAILED
    try:
        fn()
        print(f"  ok   {name}")
        PASSED += 1
    except Exception:
        FAILED += 1
        FAILURES.append(name)
        print(f"  fail {name}")
        traceback.print_exc()


def main() -> int:
    temp = Path(tempfile.mkdtemp(prefix="pe-trace-e2e-"))
    data = temp / "data"
    data.mkdir(parents=True)
    for name in ("workbench.db", "workbench.db-wal", "workbench.db-shm"):
        src = ROOT / "data" / name
        if src.exists():
            shutil.copy2(src, data / name)
    blobs = ROOT / "data" / "blobs"
    if blobs.exists():
        shutil.copytree(blobs, data / "blobs")
    (temp / "projects").mkdir(parents=True)

    env = os.environ.copy()
    env.update({
        "WORKBENCH_STORAGE_ROOT": str(temp),
        "PI_FAKE_AGENT": "1",
        "PORT": str(PORT),
        "TRACKING_SCHEDULER": "0",
        "MONITOR_SCHEDULER": "0",
        "SOURCE_SCHEDULER": "0",
    })
    server = subprocess.Popen(
        ["node", "server.mjs"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        wait_health()
        api("POST", f"/api/trace/current/reset?project={PROJECT}")

        PROPOSAL_FILES = [
            "exports/investment-model/高盛-长鑫-Model-20260904/归母净利润与少数股东权益专题分析.md",
            "exports/investment-model/高盛-长鑫-Model-20260904/估值模型调整方案_归母权益口径.md",
            "exports/investment-model/高盛-长鑫-Model-20260904/估值模型_修正版_归母口径.tsv",
        ]
        PROPOSAL_TEXT = "现有模型全部用合并口径。目标价区间从 88–100 元整体下移到 55–85 元。引入归母系数 Mi。"

        def record_proposal(run_id: str) -> None:
            api("POST", f"/api/trace/record?project={PROJECT}", {
                "sessionId": "e2e-session",
                "runId": run_id,
                "changedFiles": PROPOSAL_FILES,
                "text": PROPOSAL_TEXT,
                "at": "2026-10-23T00:30:00.000Z",
            })

        record_proposal("e2e-run-1")

        def test_agent_run_hook() -> None:
            project = api("POST", "/api/projects", {"name": "Hook E2E", "note": "test"})
            pid = project["id"]
            session = api("POST", f"/api/sessions?project={pid}")
            api("POST", f"/api/sessions/{session['id']}/messages?project={pid}", {
                "text": "[scenario:trace-proposal] 调整估值模型",
            })
            view = None
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    view = api("GET", f"/api/trace/current?project={pid}")
                except Exception:
                    view = None
                if view and view.get("entries"):
                    break
                time.sleep(0.25)
            assert view and view.get("entries"), view
            entry = view["entries"][-1]
            assert entry["kind"] == "proposed", entry
            assert "60–85" in entry["title"], entry["title"]
            assert any("估值模型调整提案" in (file.get("name") or "") for file in entry["files"]), entry["files"]
            assert view["focus"] and view["focus"]["id"] == entry["id"], view.get("focus")

        check("agent run settle hook appends a proposal", test_agent_run_hook)

        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome")
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)

            def open_trace() -> None:
                page.goto(f"{BASE}/?project={PROJECT}", wait_until="domcontentloaded")
                page.wait_for_timeout(1200)
                page.locator('#fileFilters [data-filter="trace"]').click()
                page.wait_for_timeout(500)

            def test_trace_panel() -> None:
                open_trace()
                assert page.locator('#fileFilters [data-filter="card"]').count() == 0
                assert page.locator('#fileFilters [data-filter="tasks"]').count() == 0
                assert page.locator('#fileFilters [data-filter="trace"]').count() == 1
                assert page.locator("#panelTitle").inner_text() == "追踪"
                assert page.locator(".trp-entry").count() == 4
                text = page.locator("#fileList").inner_text()
                assert "当前目标价" in text and "92" in text
                assert "目标价 ¥129 → ¥92" in text
                assert "为什么变" in text and "改动文件" in text
                assert "高盛模型" in text
                assert "报告结论" in text
                assert "归母口径调整提案" in text and "55–85" in text
                assert "提案" in text
                assert "这次估值调整提案" in page.locator("#traceHitl").inner_text()
                assert not errors, errors

            def test_hitl_judge_and_cancel() -> None:
                page.locator('[data-trace-verdict="high"]').click()
                page.wait_for_timeout(150)
                page.locator("[data-trace-submit]").click()
                page.wait_for_timeout(700)
                assert "你判断这次估值偏高" in page.locator("#traceHitl").inner_text()
                assert page.locator('[data-trace-confirm="adjust"]').count() == 1
                page.locator('[data-trace-confirm="cancel"]').click()
                page.wait_for_timeout(700)
                assert "已保留你的判断" in page.locator("#traceHitl").inner_text()
                page.locator("[data-trace-open]").click()
                page.wait_for_timeout(400)
                assert page.locator("#panelTitle").inner_text() == "追踪"
                assert "暂不调整" in page.locator("#fileList").inner_text()
                assert page.locator(".trp-entry").count() == 4

            def test_hitl_adopt_record() -> None:
                api("POST", f"/api/trace/current/reset?project={PROJECT}")
                record_proposal("e2e-run-2")
                page.reload(wait_until="domcontentloaded")
                page.wait_for_timeout(1200)
                page.locator('[data-trace-verdict="fair"]').click()
                page.wait_for_timeout(150)
                assert page.locator("[data-trace-submit]").inner_text() == "认可提案"
                page.locator("[data-trace-submit]").click()
                page.wait_for_timeout(300)
                assert page.locator(".trh-adopt").count() == 1
                page.locator('[data-trace-adopt="no"]').click()
                page.wait_for_timeout(700)
                assert "已记录：认可提案，暂不写入" in page.locator("#traceHitl").inner_text()
                page.locator("[data-trace-open]").click()
                page.wait_for_timeout(400)
                assert page.locator(".trp-entry").count() == 4
                assert "合理" in page.locator("#fileList").inner_text()

            def test_hitl_adopt_write() -> None:
                api("POST", f"/api/trace/current/reset?project={PROJECT}")
                record_proposal("e2e-run-5")
                page.reload(wait_until="domcontentloaded")
                page.wait_for_timeout(1200)
                page.locator('[data-trace-verdict="fair"]').click()
                page.wait_for_timeout(150)
                page.locator("[data-trace-submit]").click()
                page.wait_for_timeout(300)
                page.locator('[data-trace-adopt="yes"]').click()
                page.wait_for_timeout(1600)
                assert "已采纳提案" in page.locator("#traceHitl").inner_text()
                assert "人工已采纳这次估值调整提案" in page.locator("#thread").inner_text()
                page.locator('#fileFilters [data-filter="trace"]').click()
                page.wait_for_timeout(400)
                assert page.locator(".trp-entry").count() == 4
                assert "已采纳" in page.locator("#fileList").inner_text()

            def test_hitl_confirm_adjust() -> None:
                api("POST", f"/api/trace/current/reset?project={PROJECT}")
                record_proposal("e2e-run-3")
                page.reload(wait_until="domcontentloaded")
                page.wait_for_timeout(1200)
                page.locator('[data-trace-verdict="low"]').click()
                page.wait_for_timeout(150)
                page.locator("[data-trace-submit]").click()
                page.wait_for_timeout(600)
                assert "你判断这次估值偏低" in page.locator("#traceHitl").inner_text()
                page.locator('[data-trace-confirm="adjust"]').click()
                page.wait_for_timeout(1000)
                hitl = page.locator("#traceHitl").inner_text()
                assert "已确认调整" in hitl
                page.locator('#fileFilters [data-filter="trace"]').click()
                page.wait_for_timeout(400)
                assert page.locator(".trp-entry").count() == 5
                assert "已确认调整：估值偏低" in page.locator("#fileList").inner_text()
                assert "已确认调整" in page.locator("#fileList").inner_text()

            def test_mobile() -> None:
                api("POST", f"/api/trace/current/reset?project={PROJECT}")
                record_proposal("e2e-run-4")
                mobile = browser.new_page(viewport={"width": 390, "height": 844})
                try:
                    mobile.goto(f"{BASE}/?project={PROJECT}", wait_until="domcontentloaded")
                    mobile.wait_for_timeout(1200)
                    mobile.locator("#filesToggle").click()
                    mobile.wait_for_timeout(350)
                    mobile.locator('#fileFilters [data-filter="trace"]').click()
                    mobile.wait_for_timeout(400)
                    assert mobile.locator(".trp-entry").count() == 4
                    assert mobile.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
                    assert mobile.locator("#traceHitl").is_visible()
                    assert "这次估值调整提案" in mobile.locator("#traceHitl").inner_text()
                finally:
                    mobile.close()

            check("trace panel reads ordered history", test_trace_panel)
            check("HITL judge then cancel keeps history", test_hitl_judge_and_cancel)
            check("HITL proposal can be acknowledged", test_hitl_adopt_record)
            check("HITL proposal can be adopted and written", test_hitl_adopt_write)
            check("HITL confirm appends an adjustment", test_hitl_confirm_adjust)
            check("mobile trace and HITL", test_mobile)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(temp, ignore_errors=True)

    print(f"\n{PASSED} passed, {FAILED} failed")
    if FAILURES:
        print("failed:", ", ".join(FAILURES))
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
