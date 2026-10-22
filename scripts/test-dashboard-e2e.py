#!/usr/bin/env python3
"""Playwright coverage for the fixed investment dashboard.

Uses the real HTTP stack, real SQLite store and a seeded analysis-state fixture.
No model provider, no network source, no approval action.
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
    except Exception:  # noqa: BLE001 - full trace is useful for browser failures
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

    def reload(self) -> None:
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_timeout(900)
        self.page.wait_for_selector("#thread")

    def seed(self, scenario: str) -> dict:
        self.errors = []
        seed = api("POST", "/api/testing/dashboard", {"scenario": scenario})
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_timeout(900)
        self.page.wait_for_selector("#thread")
        return seed

    def open_tracking(self, tracking_id: str) -> None:
        self.page.evaluate(
            "async (id) => { await window.Tracking.reload(); window.Tracking.openDetail(id); }",
            tracking_id,
        )
        self.page.wait_for_selector("[data-track-dashboard]", timeout=8000)

    def open_dashboard(self, tracking_id: str) -> None:
        if self.page.locator("#overlay").is_visible():
            self.page.evaluate("() => window.closeFile?.()")
            self.page.wait_for_selector("#overlay", state="hidden", timeout=4000)
        if self.page.locator("#dashboardOverlay").is_visible():
            self.page.evaluate("() => window.TrackingDashboard?.close?.()")
            self.page.wait_for_selector("#dashboardOverlay", state="hidden", timeout=4000)
        self.open_tracking(tracking_id)
        self.page.click("[data-track-dashboard]")
        self.page.wait_for_selector("#dashboardOverlay .dash-dialog", timeout=8000)
        self.page.wait_for_selector(".dash-valuation", timeout=8000)

    def close_dashboard(self) -> None:
        self.page.evaluate("() => window.TrackingDashboard?.close?.()")
        self.page.wait_for_selector("#dashboardOverlay", state="hidden", timeout=4000)

    def text(self) -> str:
        return self.page.locator("#dashboardOverlay").inner_text()

    def overflow(self) -> dict:
        return self.page.evaluate(
            """() => {
              const dialog = document.querySelector('#dashboardOverlay .dash-dialog');
              if (!dialog) return { missing: true };
              return {
                dialogScroll: dialog.scrollWidth,
                dialogClient: dialog.clientWidth,
                documentScroll: document.documentElement.scrollWidth,
                inner: window.innerWidth,
              };
            }"""
        )

    def assert_no_errors(self) -> None:
        # The legacy framework detail view probes /model and logs a 409 when no
        # working model exists. Dashboard failures surface as an error card and
        # are asserted separately.
        relevant = [error for error in self.errors if "409 (Conflict)" not in error]
        assert not relevant, "\n".join(relevant)


def screenshot(page, name: str) -> None:
    page.wait_for_timeout(350)
    target = ROOT / "docs" / "ui-shots" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(target), full_page=False)


def main() -> int:
    global PASSED
    storage = tempfile.mkdtemp(prefix="pe-dashboard-e2e-")
    env = os.environ.copy()
    env.update({
        "WORKBENCH_STORAGE_ROOT": storage,
        "PORT": str(PORT),
        "PI_FAKE_AGENT": "1",
        "WORKBENCH_TEST": "1",
        "TRACKING_SCHEDULER": "0",
        "MONITOR_SCHEDULER": "0",
        "SOURCE_SCHEDULER": "0",
        "WORKBOOK_QUERY": "1",
        "PDF_READ": "0",
        "WESTOCK_QUERY": "0",
        "ANYSEARCH_QUERY": "0",
        "ASR": "0",
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
            context = browser.new_context(viewport={"width": 1440, "height": 960})
            page = context.new_page()
            ui = UI(page)
            # Seed before first load so the materials panel also knows the fixture.
            full = api("POST", "/api/testing/dashboard", {"scenario": "full"})
            page.goto(BASE + "/", wait_until="domcontentloaded")
            page.wait_for_timeout(900)
            page.wait_for_selector("#thread")
            print("\nbrowser: full dashboard")

            def full_dashboard():
                ui.errors = []
                ui.open_dashboard(full["trackingId"])
                text = ui.text()
                assert "投研 Dashboard" in text
                assert "估值结论" in text and "版本变化" in text and "敏感性" in text and "推翻条件" in text
                assert "目标价" in text and "97 元/股" in text, text
                assert "上行" in text and "24.4%" in text, text
                assert "基准" in text and "情景估值矩阵" in text
                assert "已触发" in text and "缺数据" in text
                assert "仅审计版本" not in text
                # Triggered checks are rendered first.
                first = page.locator(".dash-check").first
                assert first.get_attribute("data-status") == "triggered", first.get_attribute("data-status")
                # Unknown is text, not just a colour.
                assert page.locator(".dash-status.unknown", has_text="缺数据").count() >= 1
                screenshot(page, "dashboard-full-1440.png")
                ui.assert_no_errors()

            check("full dashboard answers the four questions", full_dashboard)

            def source_jump_to_cell():
                ui.open_dashboard(full["trackingId"])
                # The workbook source is first (run output, Model!B4).
                page.locator(".dash-valuation .dash-src", has_text="工作模型输出").first.click()
                page.wait_for_selector("#overlay:not([hidden])", timeout=5000)
                page.wait_for_selector("#xlsxName", timeout=8000)
                assert page.input_value("#xlsxName") == "B4", page.input_value("#xlsxName")
                assert "model.xlsx" in page.inner_text("#dName")
                page.click("#dClose")
                page.wait_for_timeout(200)

            check("source link opens the workbook at Sheet!Cell", source_jump_to_cell)

            def material_source_jump():
                ui.open_dashboard(full["trackingId"])
                page.locator(".dash-valuation .dash-src", has_text="analysis-state.json").first.click()
                page.wait_for_selector("#overlay:not([hidden])", timeout=5000)
                assert "analysis-state.json" in page.inner_text("#dName")
                page.click("#dClose")
                page.wait_for_timeout(200)

            check("source link opens the material version", material_source_jump)

            def history_switch():
                ui.open_dashboard(full["trackingId"])
                page.select_option("#dashRun", full["runIds"][0])
                page.wait_for_function(
                    "() => document.querySelector('.dash-valuation .dash-price-block.is-target strong')?.textContent.includes('95')",
                    timeout=8000,
                )
                assert "历史 run" in ui.text()
                page.locator("[data-dash-latest]").click()
                page.wait_for_function(
                    "() => document.querySelector('.dash-valuation .dash-price-block.is-target strong')?.textContent.includes('97')",
                    timeout=8000,
                )
                assert "历史 run" not in ui.text()
                ui.assert_no_errors()

            check("historical run switch is explicit and returns to latest", history_switch)

            def many_checks():
                ui.open_dashboard(full["trackingId"])
                all_checks = page.locator(".dash-check").count()
                assert all_checks >= 20, all_checks
                assert page.locator(".dash-checks").first.locator(".dash-check").count() == 6
                page.locator("[data-dash-more]").click()
                assert page.locator("#dashChecksRest .dash-check").count() == all_checks - 6
                assert page.locator("[data-dash-more]").get_attribute("aria-expanded") == "true"
                # The list expands in place; it must not block the dialog scroll area.
                assert page.locator("#dashScroll").count() == 1
                ui.assert_no_errors()

            check("20+ checks are paginated without blocking the page", many_checks)

            def keyboard_and_focus():
                assert page.locator("[data-dash-close]").count() >= 1
                page.locator(".dash-dialog").focus()
                page.keyboard.press("Escape")
                page.wait_for_selector("#dashboardOverlay", state="hidden", timeout=4000)
                ui.open_dashboard(full["trackingId"])
                inside = page.evaluate(
                    "() => Boolean(document.querySelector('.dash-dialog')?.contains(document.activeElement))"
                )
                assert inside, "dialog did not take focus"
                page.locator(".dash-dialog").focus()
                for _ in range(8):
                    page.keyboard.press("Tab")
                    assert page.evaluate(
                        "() => Boolean(document.querySelector('.dash-dialog')?.contains(document.activeElement))"
                    ), "focus escaped the dashboard dialog"
                page.locator(".dash-dialog").focus()
                page.keyboard.press("Escape")
                page.wait_for_selector("#dashboardOverlay", state="hidden", timeout=4000)
                ui.assert_no_errors()

            check("keyboard escape and focus stay inside the dialog", keyboard_and_focus)

            print("\nbrowser: responsive")
            ui.open_dashboard(full["trackingId"])
            for width, height, name in [
                (1024, 900, "dashboard-full-1024.png"),
                (390, 844, "dashboard-full-390.png"),
            ]:
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(300)
                overflow = ui.overflow()
                assert not overflow.get("missing")
                assert overflow["dialogScroll"] <= overflow["dialogClient"] + 1, overflow
                assert overflow["documentScroll"] <= overflow["inner"] + 1, overflow
                screenshot(page, name)
            page.set_viewport_size({"width": 1440, "height": 960})
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            ui.assert_no_errors()

            PASSED += 1
            print("  ok   1440 / 1024 / 390 layouts do not overflow")

            print("\nbrowser: partial, empty and hostile data")

            def partial_dashboard():
                partial = ui.seed("partial")
                ui.open_dashboard(partial["trackingId"])
                text = ui.text()
                assert "未知" in text and "无法计算" in text, text
                assert "缺失" in text or "断链" in text, text
                assert "未验证" in text, text
                assert "尚无敏感性数据" in text, text
                assert page.locator(".dash-matrix").count() == 0
                ui.assert_no_errors()

            check("partial data shows unknown, broken link and true empty states", partial_dashboard)

            def no_sensitivity():
                nosens = ui.seed("nosens")
                ui.open_dashboard(nosens["trackingId"])
                assert "尚无敏感性数据" in ui.text()
                assert page.locator(".dash-matrix").count() == 0
                ui.assert_no_errors()

            check("no sensitivity data never fabricates a matrix", no_sensitivity)

            def hostile_payload():
                page.evaluate("() => { delete window.__dashXss; }")
                xss = ui.seed("xss")
                ui.open_dashboard(xss["trackingId"])
                text = ui.text()
                assert "<script>" in text, text
                assert page.evaluate("() => window.__dashXss") is None
                assert page.locator("#dashboardOverlay script").count() == 0
                assert page.locator("#dashboardOverlay img[onerror]").count() == 0
                assert page.locator("#dashboardOverlay iframe").count() == 0
                assert page.locator('#dashboardOverlay [href^="javascript:"]').count() == 0
                screenshot(page, "dashboard-xss-1440.png")
                ui.assert_no_errors()

            check("payload HTML, event attributes and javascript: URLs never execute", hostile_payload)

            def empty_dashboard():
                empty = api("POST", "/api/testing/dashboard", {"scenario": "empty"})
                page.evaluate("async () => { await window.Tracking.reload(); }")
                ui.open_dashboard(empty["trackingId"])
                assert page.locator(".dash-warnings").count() == 1
                assert "尚无运行结果" in ui.text()
                assert "无结果，未产生可比较结论" in ui.text()
                assert "无业务变化" not in ui.text()
                assert "empty" in page.locator(".dash-warnings").inner_text()
                ui.assert_no_errors()

            check("tracking without a run shows an explicit empty dashboard", empty_dashboard)

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=8)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(storage, ignore_errors=True)

    print(f"\n{PASSED} passed, {FAILED} failed")
    if FAILED:
        print("failures: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
