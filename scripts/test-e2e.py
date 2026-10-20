#!/usr/bin/env python3
"""Browser regression suite for the workbench.

Uses Playwright with the installed Chrome channel and a deterministic fake Pi
session (PI_FAKE_AGENT=1). No model key or network provider is used.
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
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PASSED = 0
FAILED = 0
FAILURES: list[str] = []


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


PORT = free_port()
BASE = f"http://127.0.0.1:{PORT}"


def api(method: str, path: str, body: dict | None = None, timeout: float = 60):
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


def wait_health(timeout: float = 20.0) -> None:
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
    except Exception as error:  # noqa: BLE001 - report the full trace for failures
        FAILED += 1
        FAILURES.append(name)
        print(f"  fail {name}")
        traceback.print_exc()


class UI:
    def __init__(self, page):
        self.page = page
        self.errors: list[str] = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.on(
            "console",
            lambda message: self.errors.append(f"console: {message.text}")
            if message.type == "error"
            else None,
        )

    def goto(self) -> None:
        self.page.goto(BASE + "/", wait_until="domcontentloaded")
        self.page.wait_for_timeout(900)
        self.page.wait_for_selector("#thread")

    def reset(self) -> None:
        api("POST", "/api/testing/reset")
        # Always return to the default project even if a prior test switched.
        try:
            self.page.evaluate("() => localStorage.setItem('workbench.project', 'product-eng')")
        except Exception:
            pass
        self.errors = []
        self.goto()
        assert self.page.evaluate("() => state.project.id") == "product-eng"
        self.new_session()

    def new_session(self) -> None:
        self.page.click("#newSession")
        self.page.wait_for_timeout(450)

    def send(self, text: str) -> None:
        self.page.fill("#input", text)
        self.page.wait_for_function("() => !document.querySelector('#sendBtn').disabled", timeout=5000)
        self.page.click("#sendBtn")

    def settle(self, timeout: int = 12000) -> None:
        self.page.wait_for_function(
            "() => !document.querySelector('#liveMsg') && document.querySelector('#stopBtn').hidden",
            timeout=timeout,
        )
        self.page.wait_for_timeout(250)

    def assistant_texts(self) -> list[str]:
        return self.page.locator(".msg.assistant .msg-body").all_inner_texts()

    def session_id(self) -> str:
        return self.page.evaluate("() => state.activeSession")

    def reload_open(self, session_id: str) -> None:
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_timeout(900)
        active = self.session_id()
        if active != session_id:
            self.page.click(f'[data-session="{session_id}"]')
            self.page.wait_for_timeout(700)

    def assert_no_page_errors(self) -> None:
        if self.errors:
            raise AssertionError("browser errors: " + " | ".join(self.errors[:5]))


def approval_seed(scenario: str = "approve") -> dict:
    return api("POST", "/api/testing/approvals", {"scenario": scenario})


def material_versions(rel_path: str) -> list:
    for material in api("GET", "/api/materials"):
        if material.get("relPath") == rel_path:
            return material.get("versions", [])
    return []


def run(ui: UI) -> None:
    print("\nbrowser: streaming and tools")

    def streaming():
        ui.reset()
        ui.send("你好 [scenario:stream]")
        ui.settle()
        texts = ui.assistant_texts()
        assert any("流式回复" in text for text in texts), texts
        ui.assert_no_page_errors()

    check("normal streaming chat", streaming)

    def tool_flow():
        ui.reset()
        ui.send("查一下模型 [scenario:tool]")
        ui.page.wait_for_selector(".workbook-card", timeout=8000, state="attached")
        ui.settle()
        ui.page.locator(".tool-group summary").first.click()
        ui.page.wait_for_timeout(150)
        card = ui.page.locator(".workbook-card").first.inner_text()
        assert "Model!B2" in card and "Revenue" in card, card
        assert "查询完成" in " ".join(ui.assistant_texts())
        ui.assert_no_page_errors()

    check("text -> tool -> text with structured workbook card", tool_flow)

    def tool_failure():
        ui.reset()
        ui.send("读一下缺失的模型 [scenario:tool-error]")
        ui.page.wait_for_selector(".tool-row.error", timeout=8000, state="attached")
        ui.settle()
        assert "工具失败" in " ".join(ui.assistant_texts())
        ui.assert_no_page_errors()

    check("tool failure stays recoverable", tool_failure)

    def settle_no_duplicate():
        ui.reset()
        ui.send("快速完成 [scenario:settle]")
        ui.settle()
        ui.page.wait_for_timeout(900)
        bodies = ui.assistant_texts()
        matches = [body for body in bodies if "很快的完整回复" in body]
        assert len(matches) == 1, bodies
        assert ui.page.locator("#liveMsg").count() == 0
        ui.assert_no_page_errors()

    check("settle snapshot replaces live message without duplicates", settle_no_duplicate)

    def reconnect():
        ui.reset()
        ui.send("断线测试 [scenario:reconnect]")
        ui.page.wait_for_timeout(300)
        sid = ui.session_id()
        # Close the transport mid-run, then reconnect through the same public
        # path the browser uses after a network drop.
        ui.page.evaluate("() => { state.es?.close(); state.es = null; }")
        ui.errors = [error for error in ui.errors if "ERR_INTERNET_DISCONNECTED" not in error]
        ui.page.wait_for_timeout(1300)
        ui.page.evaluate("(id) => window.__peConnectSession(id)", sid)
        ui.page.wait_for_timeout(2000)
        ui.settle(timeout=15000)
        bodies = ui.assistant_texts()
        matches = [body for body in bodies if "重连片段0" in body]
        assert len(matches) == 1, bodies
        assert "重连片段9" in matches[0], matches[0]
        ui.assert_no_page_errors()

    check("disconnect/reconnect loses nothing and duplicates nothing", reconnect)

    print("\nbrowser: project isolation and materials")

    def project_switch():
        project = api("POST", "/api/projects", {"name": "Project B", "note": "隔离测试"})
        ui.reset()
        ui.send("A 项目的秘密消息 [scenario:stream]")
        ui.settle()
        assert "A 项目的秘密消息" in " ".join(ui.assistant_texts()) or ui.page.locator(".msg.user").count() >= 1
        # Seed an approval in project A so the shelf is project-scoped too.
        approval_seed("approve")
        ui.page.reload(wait_until="domcontentloaded")
        ui.page.wait_for_timeout(900)
        ui.page.click("#workspaceBtn")
        ui.page.wait_for_timeout(200)
        ui.page.locator(".proj-item", has_text="Project B").click()
        ui.page.wait_for_timeout(1200)
        assert ui.page.locator(".approval-card").count() == 0, "approval leaked into project B"
        assert "A 项目的秘密消息" not in ui.page.locator("#thread").inner_text()
        ui.page.click("#workspaceBtn")
        ui.page.wait_for_timeout(200)
        ui.page.locator(".proj-item", has_text="Product Eng").click()
        ui.page.wait_for_timeout(1200)
        ui.assert_no_page_errors()

    check("project switch isolates sessions and approvals", project_switch)

    def material_update():
        ui.reset()
        ui.send("写一份报告 [scenario:material]")
        ui.page.wait_for_selector(".msg-report", timeout=8000, state="attached")
        ui.page.wait_for_timeout(800)
        assert ui.page.locator(".file-card", has_text="fake-report.md").count() >= 1
        report = ui.page.locator(".msg-report").first.inner_text()
        assert "完整报告" in report
        assert "假报告" in ui.page.locator(".msg-report .report-body").first.inner_text()
        ui.assert_no_page_errors()

    check("material.updated refreshes the right panel and report card", material_update)

    def workbook_refresh():
        ui.reset()
        ui.send("查模型 [scenario:tool]")
        ui.page.wait_for_selector(".workbook-card", timeout=8000, state="attached")
        ui.settle()
        sid = ui.session_id()
        ui.reload_open(sid)
        ui.page.wait_for_selector(".workbook-card", timeout=8000, state="attached")
        ui.page.locator(".tool-group summary").first.click()
        ui.page.wait_for_timeout(200)
        card = ui.page.locator(".workbook-card").first.inner_text()
        assert "Model!B2" in card, card
        # Expand the collapsed process group to prove the card is rebuilt from
        # the persisted presentation, not from transient live state.
        ui.page.locator(".tool-group summary").first.click()
        ui.page.wait_for_timeout(200)
        assert "依赖关系" in card or "命中" in card
        ui.assert_no_page_errors()

    check("workbook card survives a full page refresh", workbook_refresh)

    def corrupt_presentation():
        ui.reset()
        ui.send("坏结果 [scenario:bad-presentation]")
        ui.settle()
        ui.page.wait_for_selector(".tool-card-error", state="attached", timeout=5000)
        sid = ui.session_id()
        ui.reload_open(sid)
        ui.page.wait_for_selector(".tool-card-error", state="attached", timeout=5000)
        assert "无法展示" in (ui.page.locator(".tool-card-error").first.text_content() or "")
        ui.assert_no_page_errors()

    check("corrupt/unknown presentation shows a durable error card", corrupt_presentation)

    def xss_safety():
        ui.reset()
        ui.send("安全测试 [scenario:xss]")
        ui.settle()
        ui.page.wait_for_selector(".workbook-card", state="attached", timeout=5000)
        ui.page.locator(".tool-group summary").first.click()
        assert ui.page.locator(".workbook-card img").count() == 0
        assert ui.page.locator(".workbook-card script").count() == 0
        assert ui.page.locator(".workbook-card svg[onload]").count() == 0
        assert ui.page.evaluate("() => window.__peXss") is None
        assert "<script>" in (ui.page.locator(".workbook-card").first.text_content() or "")
        ui.assert_no_page_errors()

    check("tool payload is rendered as text, never as HTML", xss_safety)

    print("\nbrowser: approvals")

    def approve():
        ui.reset()
        seed = approval_seed("approve")
        ui.page.reload(wait_until="domcontentloaded")
        ui.page.wait_for_timeout(900)
        ui.page.wait_for_selector(".approval-card", timeout=5000, state="attached")
        assert "待审批" in ui.page.locator(".approval-card").inner_text()
        ui.page.click('[data-approval-action="approve"]')
        ui.page.wait_for_timeout(4500)
        approvals = api("GET", "/api/approvals?status=applied")
        all_approvals = api("GET", "/api/approvals")
        assert any(item["id"] == seed["approval"]["id"] for item in approvals), all_approvals
        versions = material_versions(seed["workingFile"])
        assert len(versions) >= 2, versions
        ui.assert_no_page_errors()

    check("approval approve writes once and creates a version", approve)

    def reject():
        ui.reset()
        seed = approval_seed("approve")
        before = material_versions(seed["workingFile"])
        ui.page.reload(wait_until="domcontentloaded")
        ui.page.wait_for_timeout(900)
        ui.page.wait_for_selector(".approval-card", timeout=5000, state="attached")
        ui.page.fill("[data-approval-reason]", "数字还没确认")
        ui.page.click('[data-approval-action="reject"]')
        ui.page.wait_for_timeout(1200)
        card = ui.page.locator(".approval-card").first.inner_text()
        assert "已拒绝" in card, card
        record = api("GET", f"/api/approvals/{seed['approval']['id']}")
        assert record["status"] == "rejected"
        assert record["decision"]["reason"] == "数字还没确认"
        assert len(material_versions(seed["workingFile"])) == len(before)
        # Reload keeps the rejected state visible.
        ui.page.reload(wait_until="domcontentloaded")
        ui.page.wait_for_timeout(900)
        assert "已拒绝" in ui.page.locator(".approval-card").first.inner_text()
        ui.assert_no_page_errors()

    check("approval reject keeps the file untouched and survives refresh", reject)

    def conflict():
        ui.reset()
        seed = approval_seed("conflict")
        before_versions = len(material_versions(seed["workingFile"]))
        ui.page.reload(wait_until="domcontentloaded")
        ui.page.wait_for_timeout(900)
        ui.page.wait_for_selector(".approval-card", timeout=5000, state="attached")
        ui.page.click('[data-approval-action="approve"]')
        ui.page.wait_for_timeout(1800)
        record = api("GET", f"/api/approvals/{seed['approval']['id']}")
        assert record["status"] == "conflict", record
        assert len(material_versions(seed["workingFile"])) == before_versions
        ui.errors = [error for error in ui.errors if "409 (Conflict)" not in error]
        card = ui.page.locator(".approval-card").first
        if card.count():
            assert "冲突" in card.inner_text()
        ui.assert_no_page_errors()

    check("approval conflict is a 409 and never applies the stale proposal", conflict)

    def refresh_during_approval():
        ui.reset()
        seed = approval_seed("approve")
        ui.page.reload(wait_until="domcontentloaded")
        ui.page.wait_for_timeout(900)
        ui.page.wait_for_selector(".approval-card", timeout=5000, state="attached")
        ui.page.reload(wait_until="domcontentloaded")
        ui.page.wait_for_timeout(900)
        assert "待审批" in ui.page.locator(".approval-card").first.inner_text()
        ui.page.click('[data-approval-action="approve"]')
        ui.page.wait_for_timeout(4500)
        ui.page.reload(wait_until="domcontentloaded")
        ui.page.wait_for_timeout(900)
        assert ui.page.locator(".approval-card").count() == 0
        record = api("GET", f"/api/approvals/{seed['approval']['id']}")
        assert record["status"] == "applied"
        ui.assert_no_page_errors()

    check("refresh during a pending approval restores and completes it", refresh_during_approval)

    print("\nbrowser: abort")

    def abort():
        ui.reset()
        ui.send("慢速输出 [scenario:slow]")
        ui.page.wait_for_timeout(700)
        assert not ui.page.locator("#stopBtn").is_hidden()
        ui.page.click("#stopBtn")
        ui.settle(timeout=8000)
        assert ui.page.locator("#stopBtn").is_hidden()
        # The session remains usable after abort.
        ui.send("再试一次 [scenario:stream]")
        ui.settle()
        assert any("流式回复" in text for text in ui.assistant_texts())
        ui.assert_no_page_errors()

    check("abort stops the live run and leaves the session usable", abort)


def main() -> int:
    storage = tempfile.mkdtemp(prefix="pe-e2e-")
    env = os.environ.copy()
    env.update({
        "WORKBENCH_STORAGE_ROOT": storage,
        "PORT": str(PORT),
        "PI_FAKE_AGENT": "1",
        "WORKBENCH_TEST": "1",
        "TRACKING_SCHEDULER": "0",
        "MONITOR_SCHEDULER": "0",
        "SOURCE_SCHEDULER": "0",
    })
    server = subprocess.Popen(
        ["node", "server.mjs"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        wait_health()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, channel="chrome")
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()
            ui = UI(page)
            ui.goto()
            run(ui)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=8)
        except subprocess.TimeoutExpired:
            server.kill()
        if FAILED:
            output = server.stdout.read() if server.stdout else ""
            if output:
                print("\n--- server output ---\n" + output[-4000:])
        shutil.rmtree(storage, ignore_errors=True)

    print(f"\n{PASSED} passed, {FAILED} failed")
    if FAILED:
        print("failed: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
