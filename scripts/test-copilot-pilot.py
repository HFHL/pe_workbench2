#!/usr/bin/env python3
"""Browser parity tests for the CopilotKit Headless Core pilot.

Both transports run against the same deterministic fake Pi agent. The suite
records first-text latency, completion latency, duplicate/lost message counts,
the actual request list, and the pilot bundle size.
"""

from __future__ import annotations

import gzip
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
RESULTS: dict[str, dict] = {}


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


def wait_health(base: str = BASE, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=2):
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
    def __init__(self, page, base: str = BASE):
        self.page = page
        self.base = base
        self.errors: list[str] = []
        self.requests: list = []
        self.responses: list = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.on(
            "console",
            lambda message: self.errors.append(f"console: {message.text}")
            if message.type == "error"
            else None,
        )
        page.on("request", lambda request: self.requests.append(request))
        page.on("response", lambda response: self.responses.append(response))

    def goto(self, pilot: bool = False) -> None:
        url = self.base + ("/?agentTransport=copilotkit" if pilot else "/")
        self.page.goto(url, wait_until="domcontentloaded")
        self.page.wait_for_timeout(1000)
        self.page.wait_for_selector("#thread")

    def reset(self, pilot: bool = False) -> None:
        api("POST", "/api/testing/reset")
        try:
            self.page.evaluate("() => localStorage.setItem('workbench.project', 'product-eng')")
        except Exception:
            pass
        self.errors = []
        self.requests = []
        self.responses = []
        self.goto(pilot)
        assert self.page.evaluate("() => state.project.id") == "product-eng"
        self.errors = []
        self.new_session()

    def new_session(self) -> None:
        self.page.click("#newSession")
        self.page.wait_for_timeout(500)

    def send(self, text: str) -> float:
        self.page.fill("#input", text)
        self.page.wait_for_function("() => !document.querySelector('#sendBtn').disabled", timeout=5000)
        started = time.monotonic()
        self.page.click("#sendBtn")
        return started

    def wait_first_text(self, timeout: int = 10000) -> None:
        self.page.wait_for_function(
            "() => (((document.querySelector('#liveBody') || {}).innerText || '').trim().length > 0) || (((document.querySelector('.msg.assistant .msg-body') || {}).innerText || '').trim().length > 0)",
            timeout=timeout,
        )

    def settle(self, timeout: int = 15000) -> None:
        self.page.wait_for_function(
            "() => !state.streaming && !document.querySelector('#liveMsg') && document.querySelector('#stopBtn').hidden",
            timeout=timeout,
        )
        self.page.wait_for_timeout(300)

    def assistant_texts(self) -> list[str]:
        return self.page.locator(".msg.assistant .msg-body").all_inner_texts()

    def user_texts(self) -> list[str]:
        return self.page.locator(".msg.user .msg-body").all_inner_texts()

    def session_id(self) -> str:
        return self.page.evaluate("() => state.activeSession")

    def metrics(self) -> dict | None:
        return self.page.evaluate("() => window.__copilotPilot?.snapshotMetrics() || null")

    def reload_open(self, session_id: str) -> None:
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_timeout(1200)
        if self.session_id() != session_id:
            self.page.click(f'[data-session="{session_id}"]')
            self.page.wait_for_timeout(700)

    def open_legacy(self, session_id: str) -> None:
        self.page.goto(self.base + "/", wait_until="domcontentloaded")
        self.page.wait_for_timeout(1200)
        if self.session_id() != session_id:
            self.page.click(f'[data-session="{session_id}"]')
            self.page.wait_for_timeout(700)

    def open_pilot(self, session_id: str) -> None:
        self.page.goto(self.base + "/?agentTransport=copilotkit", wait_until="domcontentloaded")
        self.page.wait_for_timeout(1200)
        if self.session_id() != session_id:
            self.page.click(f'[data-session="{session_id}"]')
            self.page.wait_for_timeout(700)

    def assert_no_page_errors(self, allow_network: bool = False) -> None:
        errors = list(self.errors)
        if allow_network:
            errors = [
                error for error in errors
                if not any(
                    token in error
                    for token in (
                        "network error",
                        "NetworkError",
                        "Failed to fetch",
                        "ERR_INTERNET_DISCONNECTED",
                        "net::ERR",
                    )
                )
            ]
        if errors:
            raise AssertionError("browser errors: " + " | ".join(errors[:5]))

    def http_requests(self) -> list[str]:
        return [request.url for request in self.requests if request.url.startswith("http")]


def count_occurrences(values: list[str], needle: str) -> int:
    return sum(value.count(needle) for value in values)


def tool_count(ui: UI) -> int:
    return ui.page.locator(".tool-row").count()


def open_tool_groups(ui: UI) -> None:
    ui.page.evaluate("() => { document.querySelectorAll('.tool-group').forEach((node) => { node.open = true; }); }")


def run_stream(ui: UI, pilot: bool, text: str, needle: str) -> dict:
    ui.reset(pilot)
    started = ui.send(text)
    ui.wait_first_text()
    first = time.monotonic() - started
    ui.settle()
    completion = time.monotonic() - started
    bodies = ui.assistant_texts()
    assert any(needle in body for body in bodies), bodies
    assert count_occurrences(bodies, needle) == 1, bodies
    return {
        "first_text_s": round(first, 3),
        "completion_s": round(completion, 3),
        "messages": len(bodies),
        "occurrences": count_occurrences(bodies, needle),
        "metrics": ui.metrics() if pilot else None,
    }


def run(ui: UI) -> None:
    print("\ndefault path isolation")

    def default_path():
        ui.reset(False)
        assert ui.page.evaluate("() => state.agentTransport") == "legacy"
        ui.send("默认路径 [scenario:stream]")
        ui.wait_first_text()
        ui.settle()
        assert "流式回复" in " ".join(ui.assistant_texts())
        requests = ui.http_requests()
        assert not any("/api/copilotkit" in url for url in requests), requests
        assert not any("pilot.bundle.js" in url for url in requests), requests
        assert not any(not url.startswith(BASE) for url in requests), requests
        ui.assert_no_page_errors()

    check("default path loads no pilot bundle or endpoint", default_path)

    print("\npilot transport and streaming parity")

    def stream_parity():
        legacy = run_stream(ui, False, "旧链路 [scenario:stream]", "流式回复")
        pilot = run_stream(ui, True, "新链路 [scenario:stream]", "流式回复")
        assert ui.page.evaluate("() => state.agentTransport") == "copilotkit"
        assert ui.page.evaluate("() => Boolean(window.__copilotPilot)")
        assert any("pilot.bundle.js" in url for url in ui.http_requests())
        assert ui.page.evaluate("() => !state.es"), "legacy agent SSE is open under pilot"
        assert legacy["occurrences"] == 1 and pilot["occurrences"] == 1
        assert pilot["messages"] == legacy["messages"] == 1
        RESULTS["stream"] = {"legacy": legacy, "pilot": pilot}
        ui.assert_no_page_errors()

    check("streaming parity (same fixture, one message, no duplicate)", stream_parity)

    print("\ntext -> tool -> text and structured card parity")

    def tool_parity():
        ui.reset(False)
        ui.send("旧工具 [scenario:tool]")
        ui.wait_first_text()
        ui.page.wait_for_selector(".workbook-card", timeout=8000, state="attached")
        ui.settle()
        open_tool_groups(ui)
        legacy_text = ui.assistant_texts()
        legacy_card = ui.page.locator(".workbook-card").first.inner_text()
        assert "查询完成" in " ".join(legacy_text)
        legacy_tools = tool_count(ui)

        ui.reset(True)
        ui.send("新工具 [scenario:tool]")
        ui.wait_first_text()
        ui.page.wait_for_selector(".workbook-card", timeout=8000, state="attached")
        ui.settle()
        open_tool_groups(ui)
        pilot_text = ui.assistant_texts()
        pilot_card = ui.page.locator(".workbook-card").first.inner_text()
        assert "查询完成" in " ".join(pilot_text)
        assert "Model!B2" in pilot_card and "Revenue" in pilot_card, pilot_card
        assert tool_count(ui) == legacy_tools == 1
        sid = ui.session_id()
        ui.reload_open(sid)
        ui.page.wait_for_selector(".workbook-card", timeout=8000, state="attached")
        open_tool_groups(ui)
        assert "Model!B2" in ui.page.locator(".workbook-card").first.inner_text()
        RESULTS["tool"] = {"legacy_tools": legacy_tools, "pilot_tools": tool_count(ui)}
        ui.assert_no_page_errors()

    check("text/tool/text + structured workbook card survives refresh", tool_parity)

    print("\nmultiple tools")

    def multiple_tools():
        ui.reset(True)
        ui.send("多工具 [scenario:multi-tool]")
        ui.wait_first_text()
        ui.settle()
        open_tool_groups(ui)
        thread_text = ui.page.locator("#thread").inner_text()
        assert "我先查两个地方" in thread_text, thread_text
        assert "两处都看完了" in thread_text, thread_text
        assert tool_count(ui) >= 2, tool_count(ui)
        ui.reload_open(ui.session_id())
        open_tool_groups(ui)
        assert tool_count(ui) >= 2, tool_count(ui)
        ui.assert_no_page_errors()

    check("multiple tools and their cards survive refresh", multiple_tools)

    print("\ntool failure parity")

    def tool_failure():
        ui.reset(True)
        ui.send("失败工具 [scenario:tool-error]")
        ui.wait_first_text()
        ui.settle()
        assert ui.page.locator(".tool-row.error").count() >= 1
        assert "工具失败" in " ".join(ui.assistant_texts())
        ui.assert_no_page_errors()

    check("tool failure is surfaced and the session stays usable", tool_failure)

    print("\nfinal snapshot failure")

    def snapshot_failure():
        ui.reset(True)
        pattern = "**/api/sessions/*/state"
        ui.page.route(pattern, lambda route: route.abort())
        try:
            ui.send("快照失败 [scenario:stream]")
            ui.wait_first_text()
            ui.settle()
            assert "流式回复" in " ".join(ui.assistant_texts())
        finally:
            ui.page.unroute(pattern)
        ui.errors = [error for error in ui.errors if "Failed to fetch" not in error and "net::" not in error]
        ui.assert_no_page_errors(allow_network=True)

    check("snapshot failure keeps the completed live answer", snapshot_failure)

    print("\nagent error")

    def agent_error():
        ui.reset(True)
        ui.send("错误 [scenario:error]")
        ui.settle()
        assert ui.page.evaluate("() => state.streaming") is False
        ui.assert_no_page_errors()

    check("agent error settles without a stuck run", agent_error)

    print("\nabort and reuse")

    def abort_and_reuse():
        ui.reset(True)
        ui.send("慢速 [scenario:slow]")
        ui.page.wait_for_timeout(700)
        assert ui.page.locator("#stopBtn").is_visible()
        ui.page.click("#stopBtn")
        ui.settle(timeout=8000)
        assert ui.page.evaluate("() => state.streaming") is False
        ui.send("再试一次 [scenario:stream]")
        ui.wait_first_text()
        ui.settle()
        assert "流式回复" in " ".join(ui.assistant_texts())
        ui.assert_no_page_errors()

    check("abort stops the run and the same session accepts a new prompt", abort_and_reuse)

    print("\nrefresh during an active run")

    def refresh_reconnect():
        ui.reset(True)
        # Leave one completed historical run in the thread first: the replay
        # must not end the current run when it encounters the old RUN_FINISHED.
        ui.send("刷新前一轮 [scenario:stream]")
        ui.wait_first_text()
        ui.settle()
        ui.send("断线刷新 [scenario:reconnect-long]")
        ui.page.wait_for_timeout(280)
        sid = ui.session_id()
        ui.reload_open(sid)
        ui.settle(timeout=15000)
        bodies = ui.assistant_texts()
        assert count_occurrences(bodies, "重连片段0") == 1, bodies
        assert "重连片段24" in " ".join(bodies), bodies
        RESULTS["refresh_reconnect"] = {"metrics": ui.metrics()}
        ui.assert_no_page_errors(allow_network=True)

    check("refresh + connect recovers the active run exactly once", refresh_reconnect)

    print("\nsend during connect")

    def send_during_connect():
        ui.reset(True)
        ui.send("长连接 [scenario:reconnect-long]")
        ui.page.wait_for_timeout(250)
        sid = ui.session_id()
        ui.page.reload(wait_until="domcontentloaded")
        ui.page.wait_for_function("() => Boolean(window.__copilotPilot) && Boolean(state.activeSession)", timeout=8000)
        ui.page.wait_for_timeout(120)
        result = ui.page.evaluate(
            """async () => {
                try { await window.__copilotPilot.send({ text: '抢跑' }); return 'ok'; }
                catch (error) { return String(error && error.message || error); }
            }"""
        )
        assert "尚未结束" in result or "状态已变化" in result or "重连" in result, result
        ui.settle(timeout=20000)
        assert "重连片段24" in " ".join(ui.assistant_texts())
        ui.assert_no_page_errors(allow_network=True)

    check("a send racing with connect does not start a second run", send_during_connect)

    print("\nmid-run transport drop and reconnect")

    def drop_reconnect():
        ui.reset(True)
        ui.send("断线重连 [scenario:reconnect]")
        ui.page.wait_for_timeout(260)
        context = ui.page.context
        context.set_offline(True)
        ui.page.wait_for_timeout(350)
        context.set_offline(False)
        ui.page.wait_for_timeout(200)
        ui.settle(timeout=20000)
        bodies = ui.assistant_texts()
        assert count_occurrences(bodies, "重连片段0") == 1, bodies
        assert "重连片段9" in " ".join(bodies), bodies
        metrics = ui.metrics()
        assert metrics["reconnects"] >= 1, metrics
        RESULTS["drop_reconnect"] = {"metrics": metrics}
        ui.assert_no_page_errors(allow_network=True)

    check("offline drop + reconnect loses and duplicates nothing", drop_reconnect)

    print("\nproject isolation")

    def project_isolation():
        project_b = api("POST", "/api/projects", {"name": "Pilot B", "note": "隔离测试"})
        ui.reset(True)
        ui.send("A 项目秘密 [scenario:stream]")
        ui.wait_first_text()
        ui.settle()
        ui.page.click("#workspaceBtn")
        ui.page.wait_for_timeout(200)
        ui.page.locator(".proj-item", has_text="Pilot B").click()
        ui.page.wait_for_timeout(1500)
        assert ui.page.evaluate("() => state.project.id") == project_b["id"]
        assert "A 项目秘密" not in ui.page.locator("#thread").inner_text()
        info_requests = [r for r in ui.requests if "/api/copilotkit/info" in r.url]
        assert info_requests, "pilot did not connect in project B"
        assert info_requests[-1].headers.get("x-project-id") == project_b["id"], info_requests[-1].headers
        ui.page.click("#workspaceBtn")
        ui.page.wait_for_timeout(200)
        ui.page.locator(".proj-item", has_text="Product Eng").click()
        ui.page.wait_for_timeout(1500)
        assert ui.page.evaluate("() => state.project.id") == "product-eng"
        assert "A 项目秘密" in ui.page.locator("#thread").inner_text()
        ui.assert_no_page_errors()

    check("project switch isolates messages and rewrites the project header", project_isolation)

    print("\nsame Pi thread across both transports")

    def same_thread():
        ui.reset(True)
        ui.send("跨链路第一条 [scenario:stream]")
        ui.wait_first_text()
        ui.settle()
        sid = ui.session_id()
        ui.open_legacy(sid)
        assert ui.page.evaluate("() => state.activeSession") == sid
        assert "跨链路第一条" in " ".join(ui.user_texts())
        ui.send("旧链路追加 [scenario:stream]")
        ui.wait_first_text()
        ui.settle()
        ui.open_pilot(sid)
        assert ui.page.evaluate("() => state.activeSession") == sid
        assert "旧链路追加" in " ".join(ui.user_texts())
        ui.send("新链路追加 [scenario:stream]")
        ui.wait_first_text()
        ui.settle()
        ui.open_legacy(sid)
        users = " ".join(ui.user_texts())
        assert "跨链路第一条" in users and "旧链路追加" in users and "新链路追加" in users, users
        RESULTS["same_thread"] = {"session_id": sid}
        ui.assert_no_page_errors()

    check("both transports read and write the same Pi thread", same_thread)

    print("\nnetwork and privacy audit")

    def network_privacy():
        ui.reset(True)
        ui.send("隐私检查 [scenario:tool]")
        ui.wait_first_text()
        ui.page.wait_for_selector(".workbook-card", timeout=8000, state="attached")
        ui.settle()
        requests = ui.http_requests()
        external = [url for url in requests if not url.startswith(BASE)]
        assert not external, external
        forbidden = [
            "api.deepseek.com",
            "telemetry.copilotkit.ai",
            "cdn.copilotkit.ai",
            "api.anysearch.com",
            "api.17zhiling.com",
        ]
        assert not [url for url in requests if any(host in url for host in forbidden)], requests
        run_requests = [r for r in ui.requests if "/api/copilotkit/agent/pi/run" in r.url]
        assert run_requests, "no run request captured"
        payload = run_requests[-1].post_data_json or {}
        assert set(payload.get("forwardedProps", {})) <= {"projectId", "attachments", "threadId"}, payload
        raw = json.dumps(payload)
        for secret in ("DEEPSEEK_API_KEY", "sk-", "apiKey", "Authorization"):
            assert secret not in raw, secret
        headers = {key.lower() for key in run_requests[-1].headers}
        assert "authorization" not in headers, headers
        assert "cookie" not in headers, headers
        RESULTS["network"] = {
            "requests": [
                {"method": r.method, "url": r.url}
                for r in ui.requests
                if "/api/copilotkit" in r.url or "pilot.bundle.js" in r.url
            ],
            "external": external,
        }
        ui.assert_no_page_errors()

    check("only same-origin configured endpoints; no keys or material bodies", network_privacy)

    print("\nmissing bundle")

    def missing_bundle():
        pattern = "**/pilot.bundle.js"
        ui.page.route(pattern, lambda route: route.abort())
        try:
            ui.page.goto(BASE + "/?agentTransport=copilotkit", wait_until="domcontentloaded")
            ui.page.wait_for_timeout(1000)
            assert ui.page.evaluate("() => state.agentTransport") == "unavailable"
            ui.page.fill("#input", "missing")
            ui.page.wait_for_timeout(100)
            assert ui.page.evaluate("() => document.querySelector('#sendBtn').disabled") is True
        finally:
            ui.page.unroute(pattern)
        ui.reset(True)
        ui.errors = [error for error in ui.errors if "bundle failed" not in error and "Failed to fetch" not in error]
        ui.assert_no_page_errors(allow_network=True)

    check("missing pilot bundle fails closed and disables sending", missing_bundle)

    print("\nbundle size")

    def bundle_size():
        bundle = ROOT / "ui/copilot-pilot/pilot.bundle.js"
        assert bundle.exists(), "pilot bundle missing; run npm run build:copilot-pilot"
        raw_size = bundle.stat().st_size
        gzip_size = len(gzip.compress(bundle.read_bytes()))
        assert raw_size > 0
        RESULTS["bundle"] = {"bytes": raw_size, "gzip_bytes": gzip_size}
        print(f"       bundle: {raw_size} bytes, gzip {gzip_size} bytes")

    check("pilot bundle is built and measurable", bundle_size)


def run_env_flag() -> None:
    """A separate server proves COPILOTKIT_CORE_EXPERIMENT=1 enables the pilot
    without a URL parameter."""
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    storage = tempfile.mkdtemp(prefix="pe-pilot-env-")
    env = os.environ.copy()
    env.update({
        "WORKBENCH_STORAGE_ROOT": storage,
        "PORT": str(port),
        "PI_FAKE_AGENT": "1",
        "WORKBENCH_TEST": "1",
        "COPILOTKIT_CORE_EXPERIMENT": "1",
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
        wait_health(base)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, channel="chrome")
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            local = UI(page, base)
            local.goto(False)
            assert page.evaluate("() => state.agentTransport") == "copilotkit"
            assert page.evaluate("() => Boolean(window.__copilotPilot)")
            local.send("环境开关 [scenario:stream]")
            local.wait_first_text()
            local.settle()
            assert "流式回复" in " ".join(local.assistant_texts())
            local.assert_no_page_errors()
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=8)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(storage, ignore_errors=True)


def main() -> int:
    storage = tempfile.mkdtemp(prefix="pe-pilot-e2e-")
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
        check("environment flag enables the pilot", run_env_flag)
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

    print("\n--- measurements ---")
    print(json.dumps(RESULTS, indent=2, ensure_ascii=False))
    print(f"\n{PASSED} passed, {FAILED} failed")
    if FAILED:
        print("failed: " + ", ".join(FAILURES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
