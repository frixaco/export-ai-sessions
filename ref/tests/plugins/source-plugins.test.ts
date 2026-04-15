import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const tempDirs: string[] = [];

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("source plugins", () => {
  it("preserves Claude array-form user turns and tool activity", async () => {
    const homeDir = createTempHome();
    const sessionPath = join(
      homeDir,
      ".claude",
      "projects",
      "demo-project",
      "claude-session.jsonl",
    );

    writeJsonl(sessionPath, [
      {
        type: "user",
        sessionId: "claude-session",
        cwd: "/tmp/demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Start here" },
        uuid: "u1",
      },
      {
        type: "assistant",
        sessionId: "claude-session",
        cwd: "/tmp/demo",
        timestamp: "2026-01-01T00:00:01.000Z",
        uuid: "a1",
        parentUuid: "u1",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [
            { type: "thinking", thinking: "Need to inspect the file first." },
            { type: "text", text: "I'll inspect the file." },
            { type: "tool_use", id: "tool-1", name: "Read", input: { path: "/tmp/demo.txt" } },
          ],
        },
      },
      {
        type: "user",
        sessionId: "claude-session",
        cwd: "/tmp/demo",
        timestamp: "2026-01-01T00:00:02.000Z",
        uuid: "u2",
        parentUuid: "a1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "demo contents" },
            { type: "text", text: "[Request interrupted by user]" },
          ],
        },
      },
    ]);

    const { claudePlugin } = await import("../../plugins/claude/index.js");
    const refs = await claudePlugin.listSessions();
    expect(refs).toEqual([sessionPath]);

    const session = await claudePlugin.loadSession(sessionPath);
    expect(session.messages).toEqual([
      {
        role: "user",
        content: "Start here",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        role: "reasoning",
        content: "Need to inspect the file first.",
        timestamp: "2026-01-01T00:00:01.000Z",
        model: "claude-test",
      },
      {
        role: "assistant",
        content: "I'll inspect the file.",
        timestamp: "2026-01-01T00:00:01.000Z",
        model: "claude-test",
      },
      {
        role: "assistant",
        content: '[Tool call: Read] {"path":"/tmp/demo.txt"}',
        timestamp: "2026-01-01T00:00:01.000Z",
        model: "claude-test",
        toolName: "Read",
        toolCallId: "tool-1",
      },
      {
        role: "tool-result",
        content: "demo contents",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCallId: "tool-1",
      },
      {
        role: "user",
        content: "[Request interrupted by user]",
        timestamp: "2026-01-01T00:00:02.000Z",
      },
    ]);
  });

  it("prefers finalized Codex response items and keeps custom tool calls", async () => {
    const homeDir = createTempHome();
    const sessionPath = join(
      homeDir,
      ".codex",
      "sessions",
      "2026",
      "01",
      "01",
      "rollout-2026-01-01.jsonl",
    );

    writeJsonl(sessionPath, [
      {
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { id: "codex-session", cwd: "/tmp/codex", timestamp: "2026-01-01T00:00:00.000Z" },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:00.100Z",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Follow the repo rules." }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:00.200Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Implement the fix." }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.210Z",
        payload: { type: "user_message", message: "Implement the fix." },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:00.250Z",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Inspecting the patch before applying it." }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:00.300Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-1",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:00.400Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: '{"output":"Success"}',
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00.500Z",
        payload: { type: "agent_message", message: "Done." },
      },
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:00.500Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      },
    ]);

    const { codexPlugin } = await import("../../plugins/codex/index.js");
    const session = await codexPlugin.loadSession(sessionPath);
    expect(session.messages).toEqual([
      {
        role: "system",
        content: "Follow the repo rules.",
        timestamp: "2026-01-01T00:00:00.100Z",
        model: undefined,
      },
      {
        role: "user",
        content: "Implement the fix.",
        timestamp: "2026-01-01T00:00:00.200Z",
        model: undefined,
      },
      {
        role: "reasoning",
        content: "Inspecting the patch before applying it.",
        timestamp: "2026-01-01T00:00:00.250Z",
        model: undefined,
      },
      {
        role: "assistant",
        content: "[Tool call: apply_patch] *** Begin Patch\n*** End Patch",
        timestamp: "2026-01-01T00:00:00.300Z",
        toolName: "apply_patch",
        toolCallId: "call-1",
        model: undefined,
      },
      {
        role: "tool-result",
        content: '{"output":"Success"}',
        timestamp: "2026-01-01T00:00:00.400Z",
        toolCallId: "call-1",
      },
      {
        role: "assistant",
        content: "Done.",
        timestamp: "2026-01-01T00:00:00.500Z",
        model: undefined,
      },
    ]);
  });

  it("filters empty Factory sessions and preserves assistant tool calls", async () => {
    const homeDir = createTempHome();
    const emptyPath = join(homeDir, ".factory", "sessions", "demo", "empty.jsonl");
    const sessionPath = join(homeDir, ".factory", "sessions", "demo", "factory-session.jsonl");

    writeJsonl(emptyPath, [
      {
        type: "session_start",
        id: "empty-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/factory",
      },
    ]);
    writeJsonl(sessionPath, [
      {
        type: "session_start",
        id: "factory-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/factory",
      },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "Inspect the project" },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need a directory listing first." },
            { type: "text", text: "I'll list the files." },
            {
              type: "tool_use",
              id: "factory-tool-1",
              name: "LS",
              input: { directory_path: "/tmp/factory" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "factory-tool-1", content: "file-a\nfile-b" },
          ],
        },
      },
    ]);

    const { factoryPlugin } = await import("../../plugins/factory/index.js");
    const refs = await factoryPlugin.listSessions();
    expect(refs).toEqual([sessionPath]);

    const session = await factoryPlugin.loadSession(sessionPath);
    expect(session.messages).toEqual([
      {
        role: "user",
        content: "Inspect the project",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        role: "reasoning",
        content: "Need a directory listing first.",
        timestamp: "2026-01-01T00:00:02.000Z",
        model: undefined,
      },
      {
        role: "assistant",
        content: "I'll list the files.",
        timestamp: "2026-01-01T00:00:02.000Z",
        model: undefined,
      },
      {
        role: "assistant",
        content: '[Tool call: LS] {"directory_path":"/tmp/factory"}',
        timestamp: "2026-01-01T00:00:02.000Z",
        toolName: "LS",
        toolCallId: "factory-tool-1",
        model: undefined,
      },
      {
        role: "tool-result",
        content: "file-a\nfile-b",
        timestamp: "2026-01-01T00:00:03.000Z",
        toolCallId: "factory-tool-1",
      },
    ]);
  });

  it("loads older idless Pi sessions and preserves assistant tool calls", async () => {
    const homeDir = createTempHome();
    const emptyPath = join(homeDir, ".pi", "agent", "sessions", "demo", "empty.jsonl");
    const sessionPath = join(homeDir, ".pi", "agent", "sessions", "demo", "pi-session.jsonl");

    writeJsonl(emptyPath, [
      {
        type: "session",
        id: "empty-pi",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/pi",
      },
    ]);
    writeJsonl(sessionPath, [
      {
        type: "session",
        id: "pi-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/pi",
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Check the project" }],
          timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
        },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need to inspect the workspace first." },
            { type: "text", text: "I'll inspect it." },
            { type: "toolCall", id: "pi-tool-1", name: "bash", arguments: { command: "pwd" } },
          ],
          model: "pi-model",
          timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
        },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "/tmp/pi" }],
          toolCallId: "pi-tool-1",
          toolName: "bash",
          timestamp: Date.parse("2026-01-01T00:00:03.000Z"),
        },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          model: "pi-model",
          timestamp: Date.parse("2026-01-01T00:00:04.000Z"),
        },
      },
    ]);

    const { piPlugin } = await import("../../plugins/pi/index.js");
    const refs = await piPlugin.listSessions();
    expect(refs).toEqual([sessionPath]);

    const session = await piPlugin.loadSession(sessionPath);
    expect(session.messages).toEqual([
      {
        role: "user",
        content: "Check the project",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        role: "reasoning",
        content: "Need to inspect the workspace first.",
        timestamp: "2026-01-01T00:00:02.000Z",
        model: "pi-model",
      },
      {
        role: "assistant",
        content: "I'll inspect it.",
        timestamp: "2026-01-01T00:00:02.000Z",
        model: "pi-model",
      },
      {
        role: "assistant",
        content: '[Tool call: bash] {"command":"pwd"}',
        timestamp: "2026-01-01T00:00:02.000Z",
        model: "pi-model",
        toolName: "bash",
        toolCallId: "pi-tool-1",
      },
      {
        role: "tool-result",
        content: "/tmp/pi",
        timestamp: "2026-01-01T00:00:03.000Z",
        toolName: "bash",
        toolCallId: "pi-tool-1",
      },
      {
        role: "assistant",
        content: "Done.",
        timestamp: "2026-01-01T00:00:04.000Z",
        model: "pi-model",
      },
    ]);
  });
});

function createTempHome(): string {
  const homeDir = mkdtempSync(join(tmpdir(), "pi-brain-source-test-"));
  tempDirs.push(homeDir);
  process.env.HOME = homeDir;
  return homeDir;
}

function writeJsonl(filePath: string, entries: unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}
