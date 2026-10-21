/**
 * Deterministic fake Pi session for browser tests.
 *
 * It implements the subset of AgentSession the host uses: messages, subscribe,
 * prompt, abort, dispose and the agent.beforeToolCall hook. No model key, no
 * network and no real file tools are involved. It is only enabled by
 * PI_FAKE_AGENT=1 and is ignored by normal `npm start`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { WORKBOOK_QUERY_RESULT } from "../../lib/contracts/index.mjs";
import { makeTitle } from "./snapshot.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scenarioOf(text) {
  const match = String(text || "").match(/\[scenario:([a-z0-9_-]+)\]/i);
  return match ? match[1].toLowerCase() : "stream";
}

function fakePresentation(count = 6) {
  const cells = Array.from({ length: count }, (_, index) => {
    const row = index + 2;
    return {
      ref: `Model!B${row}`,
      sheet: "Model",
      coord: `B${row}`,
      rowLabel: index === 0 ? "Revenue" : `Line ${index + 1}`,
      columnLabel: "2024",
      displayLabel: index === 0 ? "Revenue / 2024" : `Line ${index + 1} / 2024`,
      value: { raw: 100 + index, display: String(100 + index) },
      formula: index === 0 ? null : `=B${row - 1}+1`,
      relation: index === 0 ? "seed" : "downstream",
      score: index === 0 ? 20 : 5,
      upstreamRefs: index === 0 ? [] : [`Model!B${row - 1}`],
      downstreamRefs: [],
    };
  });
  const payload = {
    schema: { name: "pe.workbook-query.result", version: 1 },
    material: {
      id: "mat_fake_workbook",
      path: "uploads/model.xlsx",
      version: 3,
      sha256: "a".repeat(64),
    },
    query: "Revenue",
    summary: { matchedCells: count, returnedCells: count, truncated: false },
    cells,
    warnings: [],
  };
  const checked = WORKBOOK_QUERY_RESULT.validate(payload);
  if (!checked.ok) throw new Error("fake workbook presentation is invalid");
  return payload;
}

class FakeSession {
  constructor({ id, ctx = null } = {}) {
    this.ctx = ctx;
    this.sessionId = id || `sess_fake_${crypto.randomUUID()}`;
    this.sessionName = "";
    this.messages = [];
    this.isStreaming = false;
    this.listeners = new Set();
    this.aborted = false;
    this.disposed = false;
    this.sequence = 0;
    this.agent = { beforeToolCall: null };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSessionName(name) {
    this.sessionName = String(name || "");
  }

  emit(event) {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a bad listener must not break the fake run */
      }
    }
  }

  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}_${this.sequence}_${Date.now().toString(36)}`;
  }

  async textMessage(text, { chunk = 3, delay = 24 } = {}) {
    const message = {
      id: this.nextId("msg"),
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: Date.now(),
      stopReason: "stop",
    };
    this.emit({ type: "message_start", message });
    for (let index = 0; index < text.length; index += chunk) {
      if (this.aborted) break;
      const delta = text.slice(index, index + chunk);
      message.content[0].text += delta;
      this.emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", delta },
      });
      await sleep(delay);
    }
    if (!message.content[0].text) {
      message.content = [];
      message.stopReason = this.aborted ? "aborted" : "stop";
    }
    this.messages.push(message);
    this.emit({ type: "message_end", message });
    return message;
  }

  async toolCall({ name, args = {}, text = "", details = null, isError = false }) {
    const callId = this.nextId("call");
    const assistant = {
      id: this.nextId("msg"),
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        { type: "toolCall", id: callId, name, arguments: args },
      ],
      timestamp: Date.now(),
      stopReason: "toolUse",
    };
    this.messages.push(assistant);
    this.emit({ type: "message_start", message: assistant });
    this.emit({ type: "message_end", message: assistant });
    if (this.aborted) return null;

    this.emit({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
    await sleep(30);
    if (this.aborted) return null;
    const result = {
      content: [{ type: "text", text: details?.text || "ok" }],
      ...(details?.presentation ? { details: { presentation: details.presentation } } : {}),
      ...(isError ? { isError: true } : {}),
    };
    this.emit({
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: name,
      args,
      result,
      isError,
    });
    this.messages.push({
      role: "toolResult",
      toolCallId: callId,
      toolName: name,
      content: result.content,
      details: result.details || {},
      isError,
      timestamp: Date.now(),
    });
    return result;
  }

  async prompt(text, options = {}) {
    if (this.isStreaming) throw new Error("fake session is already streaming");
    if (this.disposed) throw new Error("fake session disposed");
    const promptText = String(text || "");
    const scenario = scenarioOf(promptText);
    this.isStreaming = true;
    this.aborted = false;
    if (!this.sessionName) this.sessionName = makeTitle(promptText);

    this.messages.push({
      role: "user",
      content: [
        { type: "text", text: promptText },
        ...((options.images || []).map(() => ({ type: "image" }))),
      ],
      timestamp: Date.now(),
    });

    try {
      this.emit({ type: "agent_start" });
      if (this.agent.beforeToolCall) {
        try {
          await this.agent.beforeToolCall({
            toolCall: { name: "workbook_query" },
            args: { path: "uploads/model.xlsx" },
          });
        } catch {
          /* the fake has no real tools */
        }
      }

      if (scenario === "tool" || scenario === "workbook") {
        const count = scenario === "workbook" ? 30 : 6;
        await this.textMessage("我先查一下工作簿。", { delay: 8 });
        await this.toolCall({
          name: "workbook_query",
          args: { path: "uploads/model.xlsx", query: "Revenue" },
          details: {
            text: "候选 30 个单元格，返回相关子图 6 个。",
            presentation: {
              schema: { name: "pe.workbook-query.result", version: 1 },
              payload: fakePresentation(count),
            },
          },
        });
        await this.textMessage("查询完成：2024 年营收是 100。", { delay: 12 });
      } else if (scenario === "multi-tool") {
        await this.textMessage("我先查两个地方。", { delay: 8 });
        await this.toolCall({
          name: "workbook_query",
          args: { path: "uploads/model.xlsx", query: "Revenue" },
          details: {
            text: "候选 6 个单元格。",
            presentation: {
              schema: { name: "pe.workbook-query.result", version: 1 },
              payload: fakePresentation(6),
            },
          },
        });
        await this.textMessage("再看一下资料。", { delay: 8 });
        await this.toolCall({
          name: "grep",
          args: { pattern: "收入" },
          details: { text: "命中 2 处" },
        });
        await this.textMessage("两处都看完了。", { delay: 8 });
      } else if (scenario === "bad-presentation") {
        await this.textMessage("这个工具结果有问题。", { delay: 8 });
        await this.toolCall({
          name: "workbook_query",
          args: { path: "uploads/model.xlsx", query: "Revenue" },
          details: {
            text: "坏 payload",
            presentation: {
              schema: { name: "pe.workbook-query.result", version: 1 },
              payload: {},
            },
          },
        });
        await this.textMessage("工具结果无法展示，但对话还可以继续。", { delay: 8 });
      } else if (scenario === "xss") {
        const payload = fakePresentation(1);
        payload.cells[0].rowLabel = '<img src=x onerror="window.__peXss=1">';
        payload.cells[0].displayLabel = '<script>window.__peXss=2</script>';
        payload.cells[0].formula = '<svg onload="window.__peXss=3">';
        await this.textMessage("检查转义。", { delay: 8 });
        await this.toolCall({
          name: "workbook_query",
          args: { path: "uploads/model.xlsx", query: "Revenue" },
          details: {
            text: "转义测试",
            presentation: {
              schema: { name: "pe.workbook-query.result", version: 1 },
              payload,
            },
          },
        });
        await this.textMessage("如果看到原始标签文本，说明按文本处理了。", { delay: 8 });
      } else if (scenario === "material") {
        await this.textMessage("我把结论写到报告里。", { delay: 8 });
        const rel = "exports/fake-report.md";
        fs.mkdirSync(path.join(this.ctx.root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(this.ctx.root, rel), "# 假报告\n\n这是测试生成的报告。\n", "utf8");
        await this.toolCall({
          name: "write",
          args: { path: rel },
          details: { text: `已写入 ${rel}` },
        });
        await this.textMessage("报告已更新，右栏应该出现新的卡片。", { delay: 10 });
      } else if (scenario === "tool-error") {
        await this.textMessage("我先读一下模型。", { delay: 8 });
        await this.toolCall({
          name: "workbook_query",
          args: { path: "uploads/missing.xlsx", query: "Revenue" },
          // Deliberately contains no "failed"/"失败" keyword: the protocol
          // adapter must carry the error semantic through standard content.
          details: { text: "No such workbook: uploads/missing.xlsx" },
          isError: true,
        });
        await this.textMessage("工具失败了，文件可能不在项目里。", { delay: 8 });
      } else if (scenario === "reconnect") {
        const message = {
          id: this.nextId("msg"),
          role: "assistant",
          content: [{ type: "text", text: "" }],
          timestamp: Date.now(),
          stopReason: "stop",
        };
        this.emit({ type: "message_start", message });
        for (let index = 0; index < 10; index += 1) {
          if (this.aborted) break;
          const delta = `重连片段${index} `;
          message.content[0].text += delta;
          this.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta } });
          await sleep(80);
        }
        this.messages.push(message);
        this.emit({ type: "message_end", message });
      } else if (scenario === "reconnect-long") {
        const message = {
          id: this.nextId("msg"),
          role: "assistant",
          content: [{ type: "text", text: "" }],
          timestamp: Date.now(),
          stopReason: "stop",
        };
        this.emit({ type: "message_start", message });
        for (let index = 0; index < 25; index += 1) {
          if (this.aborted) break;
          const delta = `重连片段${index} `;
          message.content[0].text += delta;
          this.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta } });
          await sleep(90);
        }
        this.messages.push(message);
        this.emit({ type: "message_end", message });
      } else if (scenario === "settle") {
        await this.textMessage("这是一次很快的完整回复。", { chunk: 8, delay: 4 });
      } else if (scenario === "slow" || scenario === "abort") {
        for (let index = 0; index < 120 && !this.aborted; index += 1) {
          const message = {
            id: `msg_slow_${index}`,
            role: "assistant",
            content: [{ type: "text", text: "" }],
            timestamp: Date.now(),
            stopReason: "stop",
          };
          this.emit({ type: "message_start", message });
          for (let chunk = 0; chunk < 4 && !this.aborted; chunk += 1) {
            const delta = `片段${index}-${chunk} `;
            message.content[0].text += delta;
            this.emit({
              type: "message_update",
              message,
              assistantMessageEvent: { type: "text_delta", delta },
            });
            await sleep(40);
          }
          this.messages.push(message);
          this.emit({ type: "message_end", message });
        }
      } else if (scenario === "error") {
        const message = {
          id: this.nextId("msg"),
          role: "assistant",
          content: [{ type: "text", text: "模拟错误" }],
          timestamp: Date.now(),
          stopReason: "error",
          errorMessage: "fake agent error",
        };
        this.messages.push(message);
        this.emit({ type: "message_start", message });
        this.emit({ type: "message_end", message });
      } else {
        await this.textMessage("你好，这是一条流式回复。", { chunk: 2, delay: 18 });
      }
      return { ok: true };
    } finally {
      this.isStreaming = false;
      this.emit({ type: "agent_settled", aborted: this.aborted });
    }
  }

  async abort() {
    this.aborted = true;
    this.isStreaming = false;
  }

  dispose() {
    this.disposed = true;
    this.isStreaming = false;
    this.listeners.clear();
  }
}

export async function createFakeSession({ id, ctx, config } = {}) {
  void config;
  return new FakeSession({ id, ctx });
}

export { FakeSession, fakePresentation, scenarioOf };
