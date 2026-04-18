import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { convertSessionFile, convertSessionText } from "../../src/core/convert-session.js";

const root = process.cwd();

describe("provider regressions", () => {
  it("parses real-style nested Factory messages and keeps mixed blocks as a message", () => {
    const session = convertSessionFile(
      "factory",
      resolve(root, "tests/fixtures/factory/source.mixed.jsonl"),
    );
    const item = session.items[0]!;

    expect(item.kind).toBe("message");
    expect(item.role).toBe("assistant");
    expect(item.blocks.map((block) => block.type)).toEqual(["thinking", "tool_call", "text"]);
  });

  it("keeps Factory compaction and non-message state while parsing nested message envelopes", () => {
    const session = convertSessionFile(
      "factory",
      resolve(root, "tests/fixtures/factory/source.jsonl"),
    );
    const compaction = session.items[0]!;
    const meta = session.items[1]!;
    const mixedMessage = session.items[2]!;
    const toolCall = session.items[3]!;
    const toolResult = session.items[4]!;

    expect(compaction.kind).toBe("compaction");
    expect(meta.kind).toBe("meta");
    expect(mixedMessage.blocks.map((block) => block.type)).toEqual(["thinking", "text"]);
    expect(toolCall.blocks.map((block) => block.type)).toEqual(["tool_call"]);
    expect(toolResult.blocks.map((block) => block.type)).toEqual(["tool_result"]);
    expect(toolResult.blocks[0]).toMatchObject({
      type: "tool_result",
      tool_name: "read_file",
    });
  });

  it("maps Pi tool results and preserves image blocks", () => {
    const session = convertSessionFile("pi", resolve(root, "tests/fixtures/pi/source.jsonl"));
    const toolResult = session.items.find((item) => item.id === "tool_1");

    expect(toolResult).toBeDefined();
    expect(toolResult?.kind).toBe("tool_result");
    expect(toolResult?.role).toBe("tool");
    expect(toolResult?.blocks.some((block) => block.type === "image")).toBe(true);
  });

  it("exports only the active Pi branch", () => {
    const session = convertSessionFile(
      "pi",
      resolve(root, "tests/fixtures/pi/source.active-branch.jsonl"),
    );

    expect(session.items.map((item) => item.id)).toEqual(["root", "branch_b"]);
  });

  it("falls back to source order when Pi branch linkage is broken", () => {
    const session = convertSessionFile(
      "pi",
      resolve(root, "tests/fixtures/pi/source.broken-linkage.jsonl"),
    );

    expect(session.session.metadata).toEqual({ branch_linkage_broken: true });
    expect(session.items.map((item) => item.id)).toEqual(["root", "child", "orphan"]);
  });

  it("repairs Pi parent links through omitted state entries", () => {
    const session = convertSessionText(
      "pi",
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi_state_parent_fixture",
          timestamp: "2026-04-18T12:00:00.000Z",
          cwd: "/tmp/pi-state-parent",
        }),
        JSON.stringify({
          type: "model_change",
          id: "model_1",
          parentId: null,
          timestamp: "2026-04-18T12:00:00.100Z",
          modelId: "gpt-5.4",
        }),
        JSON.stringify({
          type: "thinking_level_change",
          id: "state_1",
          parentId: "model_1",
          timestamp: "2026-04-18T12:00:00.200Z",
          thinkingLevel: "high",
        }),
        JSON.stringify({
          type: "message",
          id: "user_1",
          parentId: "state_1",
          timestamp: "2026-04-18T12:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant_1",
          parentId: "user_1",
          timestamp: "2026-04-18T12:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
          },
        }),
      ].join("\n"),
    );

    expect(session.session.metadata).toEqual({});
    expect(session.items.map((item) => item.id)).toEqual(["user_1", "assistant_1"]);
    expect(session.items[0]?.parent_id).toBeNull();
    expect(session.items[1]?.parent_id).toBe("user_1");
  });

  it("preserves Claude system text and compact-boundary compaction markers", () => {
    const session = convertSessionFile(
      "claude",
      resolve(root, "tests/fixtures/claude/source.jsonl"),
    );
    const localSystem = session.items.find((item) => item.id === "claude_system_local_1");
    const compactBoundary = session.items.find((item) => item.id === "claude_compact_boundary_1");
    const compaction = session.items.find((item) => item.id === "claude_compaction_summary_1");

    expect(localSystem?.kind).toBe("context");
    expect(localSystem?.role).toBe("system");
    expect(localSystem?.blocks[0]).toMatchObject({
      type: "text",
      text: "<local-command-stdout>Total cost: $0.1357</local-command-stdout>",
    });
    expect(compactBoundary?.kind).toBe("compaction");
    expect(compactBoundary?.parent_id).toBe("claude_system_local_1");
    expect(compactBoundary?.blocks.map((block) => block.type)).toEqual(["compaction", "text"]);
    expect(compactBoundary?.blocks[0]).toMatchObject({
      type: "compaction",
      mode: "marker",
    });
    expect(compactBoundary?.blocks[1]).toMatchObject({
      type: "text",
      text: "Conversation compacted",
    });
    expect(compaction?.kind).toBe("compaction");
    expect(compaction?.blocks[0]).toMatchObject({
      type: "compaction",
      mode: "summary",
    });
  });

  it("treats explicit Claude metadata wrappers as meta instead of transcript messages", () => {
    const session = convertSessionText(
      "claude",
      [
        JSON.stringify({
          type: "system",
          uuid: "claude_before_compact",
          timestamp: "2026-04-15T21:32:10.947Z",
          content: "<local-command-stdout>Total cost: $0.1357</local-command-stdout>",
        }),
        JSON.stringify({
          type: "system",
          uuid: "claude_compact_boundary_inline",
          parentUuid: null,
          logicalParentUuid: "claude_before_compact",
          subtype: "compact_boundary",
          content: "Conversation compacted",
          timestamp: "2026-04-15T21:33:13.563Z",
        }),
        JSON.stringify({
          type: "user",
          uuid: "claude_caveat_inline",
          parentUuid: "claude_compact_boundary_inline",
          isMeta: true,
          timestamp: "2026-04-15T21:33:13.600Z",
          message: {
            role: "user",
            content:
              "<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>",
          },
        }),
      ].join("\n"),
    );
    const compactBoundary = session.items.find(
      (item) => item.id === "claude_compact_boundary_inline",
    );
    const localSystem = session.items.find((item) => item.id === "claude_before_compact");
    const caveat = session.items.find((item) => item.id === "claude_caveat_inline");

    expect(localSystem?.blocks[0]).toMatchObject({
      type: "text",
      text: "<local-command-stdout>Total cost: $0.1357</local-command-stdout>",
    });
    expect(compactBoundary?.kind).toBe("compaction");
    expect(compactBoundary?.parent_id).toBe("claude_before_compact");
    expect(compactBoundary?.blocks.map((block) => block.type)).toEqual(["compaction", "text"]);
    expect(compactBoundary?.blocks[0]).toMatchObject({
      type: "compaction",
      mode: "marker",
    });
    expect(compactBoundary?.blocks[1]).toMatchObject({
      type: "text",
      text: "Conversation compacted",
    });
    expect(caveat?.kind).toBe("meta");
    expect(caveat?.role).toBe("user");
    expect(caveat?.blocks[0]).toMatchObject({
      type: "text",
      text: "<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>",
    });
  });

  it("maps Claude attachment subtypes by intent", () => {
    const session = convertSessionFile(
      "claude",
      resolve(root, "tests/fixtures/claude/source.jsonl"),
    );
    const fileAttachment = session.items.find((item) => item.id === "claude_attach_file_1");
    const taskReminder = session.items.find((item) => item.id === "claude_attach_task_1");

    expect(fileAttachment).toBeDefined();
    expect(taskReminder).toBeDefined();
    expect(fileAttachment!.blocks[0]!.type).toBe("file_ref");
    expect(taskReminder!.kind).toBe("meta");
    expect(taskReminder!.blocks[0]!.type).toBe("raw");
  });

  it("keeps Claude mixed assistant content as a message and command wrappers as meta", () => {
    const session = convertSessionFile(
      "claude",
      resolve(root, "tests/fixtures/claude/source.jsonl"),
    );
    const assistant = session.items.find((item) => item.id === "claude_assistant_mix_1");
    const toolResult = session.items.find((item) => item.id === "claude_tool_result_1");
    const command = session.items.find((item) => item.id === "claude_compact_command_1");
    const stdout = session.items.find((item) => item.id === "claude_compact_stdout_1");

    expect(assistant?.kind).toBe("message");
    expect(assistant?.blocks.map((block) => block.type)).toEqual(["thinking", "tool_call", "text"]);
    expect(toolResult?.blocks[0]).toMatchObject({
      type: "tool_result",
      call_id: "toolu_read_1",
      tool_name: "Read",
    });
    expect(command?.kind).toBe("meta");
    expect(stdout?.kind).toBe("meta");
  });

  it("preserves Codex developer messages and web search calls", () => {
    const session = convertSessionFile("codex", resolve(root, "tests/fixtures/codex/source.jsonl"));
    const developerMessage = session.items.find((item) => item.role === "developer");
    const search = session.items.find((item) => item.kind === "search");
    const toolResult = session.items.find((item) => item.kind === "tool_result");

    expect(developerMessage).toBeDefined();
    expect(search?.blocks[0]).toMatchObject({
      type: "search",
      query: "codex duplicate suppression",
    });
    expect(toolResult?.blocks[0]).toMatchObject({
      type: "tool_result",
      tool_name: "exec_command",
    });
  });

  it("suppresses only true Codex duplicates and keeps non-duplicates", () => {
    const session = convertSessionFile(
      "codex",
      resolve(root, "tests/fixtures/codex/source.duplicates.jsonl"),
    );
    const userMessages = session.items.filter(
      (item) => item.kind === "message" && item.role === "user",
    );
    const reasoning = session.items.filter((item) => item.kind === "reasoning");
    const firstUserMessage = userMessages[0]!;
    const secondUserMessage = userMessages[1]!;

    expect([firstUserMessage.blocks[0], secondUserMessage.blocks[0]]).toEqual([
      expect.objectContaining({ type: "text", text: "review this patch" }),
      expect.objectContaining({ type: "text", text: "this is new" }),
    ]);
    expect(reasoning).toHaveLength(1);
  });

  it("reads Codex web-search queries from nested action payloads", () => {
    const session = convertSessionText(
      "codex",
      [
        JSON.stringify({
          timestamp: "2026-02-28T08:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex_nested_search" },
        }),
        JSON.stringify({
          timestamp: "2026-02-28T08:00:01.000Z",
          type: "response_item",
          payload: {
            type: "web_search_call",
            id: "search_nested",
            action: { type: "search", query: "nested codex query" },
            status: "completed",
            provider: "web",
          },
        }),
      ].join("\n"),
    );
    const search = session.items.find((item) => item.id === "search_nested");

    expect(search?.blocks[0]).toMatchObject({
      type: "search",
      query: "nested codex query",
    });
  });

  it("coalesces repetitive Codex turn_context items and emits concise context deltas", () => {
    const session = convertSessionText(
      "codex",
      [
        JSON.stringify({
          timestamp: "2026-02-28T08:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex_turn_context_deltas", cwd: "/tmp/codex" },
        }),
        JSON.stringify({
          timestamp: "2026-02-28T08:00:01.000Z",
          type: "turn_context",
          payload: {
            turn_id: "turn_1",
            cwd: "/tmp/codex",
            model: "gpt-5.3-codex",
            approval_policy: "never",
            sandbox_policy: { type: "danger-full-access" },
            user_instructions: "Keep answers concise.",
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-28T08:00:02.000Z",
          type: "turn_context",
          payload: {
            turn_id: "turn_2",
            cwd: "/tmp/codex",
            model: "gpt-5.3-codex",
            approval_policy: "never",
            sandbox_policy: { type: "danger-full-access" },
            user_instructions: "Keep answers concise.",
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-28T08:00:03.000Z",
          type: "turn_context",
          payload: {
            turn_id: "turn_3",
            cwd: "/tmp/codex/subdir",
            model: "gpt-5.4",
            approval_policy: "never",
            sandbox_policy: { type: "danger-full-access" },
            user_instructions: "Keep answers concise.",
            effort: "high",
          },
        }),
      ].join("\n"),
    );

    const contexts = session.items.filter((item) => item.kind === "context");

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.blocks.map((block) => block.type)).toEqual([
      "text",
      "text",
      "text",
      "text",
      "text",
    ]);
    expect(contexts[0]?.blocks.map((block) => ("text" in block ? block.text : null))).toEqual([
      "cwd: /tmp/codex",
      "model: gpt-5.3-codex",
      "approval_policy: never",
      "sandbox_policy: danger-full-access",
      "user_instructions: updated (21 chars)",
    ]);
    expect(contexts[1]?.model).toBe("gpt-5.4");
    expect(contexts[1]?.blocks.map((block) => ("text" in block ? block.text : null))).toEqual([
      "cwd: /tmp/codex/subdir",
      "model: gpt-5.4",
      "effort: high",
    ]);
  });

  it("maps OpenCode file, patch, tool call, tool result, and compaction parts", () => {
    const session = convertSessionFile(
      "opencode",
      resolve(root, "tests/fixtures/opencode/source.json"),
    );
    const assistant = session.items.find((item) => item.id === "msg_assistant_1");
    const toolResult = session.items.find((item) => item.id === "msg_tool_result_1");
    const compactions = session.items.filter((item) => item.kind === "compaction");

    expect(assistant).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(assistant!.blocks.map((block) => block.type)).toEqual([
      "step",
      "tool_call",
      "file_ref",
      "patch_ref",
      "text",
      "step",
    ]);
    expect(toolResult!.kind).toBe("tool_result");
    expect(toolResult!.blocks.map((block) => block.type)).toEqual(["tool_result"]);
    expect(compactions).toHaveLength(2);
    expect(compactions[0]?.id).toBe("msg_compaction_1");
    expect(compactions[1]?.id).toBe("msg_compaction_1:compaction:2");
  });

  it("preserves OpenCode compaction-only message ids as parent anchors", () => {
    const session = convertSessionText(
      "opencode",
      JSON.stringify({
        info: { id: "ses_compaction_anchor" },
        messages: [
          {
            info: {
              id: "msg_before_compaction",
              role: "assistant",
              time: { created: 1704067200000 },
            },
            parts: [{ type: "text", text: "before" }],
          },
          {
            info: {
              id: "msg_compaction_anchor",
              role: "assistant",
              parentID: "msg_before_compaction",
              time: { created: 1704067201000 },
            },
            parts: [{ type: "compaction", auto: false }],
          },
          {
            info: {
              id: "msg_after_compaction",
              role: "assistant",
              parentID: "msg_compaction_anchor",
              time: { created: 1704067202000 },
            },
            parts: [{ type: "text", text: "after" }],
          },
        ],
      }),
    );
    const compaction = session.items.find((item) => item.id === "msg_compaction_anchor");
    const after = session.items.find((item) => item.id === "msg_after_compaction");

    expect(compaction?.kind).toBe("compaction");
    expect(compaction?.blocks[0]).toMatchObject({
      type: "compaction",
      mode: "marker",
    });
    expect(after?.parent_id).toBe("msg_compaction_anchor");
  });

  it("reads OpenCode tool arguments and results from nested state payloads", () => {
    const session = convertSessionText(
      "opencode",
      JSON.stringify({
        info: { id: "ses_nested_state" },
        messages: [
          {
            info: { id: "msg_nested_call", role: "assistant" },
            parts: [
              {
                type: "tool",
                id: "call_nested_1",
                name: "grep",
                state: {
                  status: "running",
                  input: {
                    pattern: "TODO",
                    path: "src/providers/opencode/convert.ts",
                  },
                },
              },
            ],
          },
          {
            info: { id: "msg_nested_result", role: "assistant" },
            parts: [
              {
                type: "tool",
                id: "call_nested_1",
                name: "grep",
                state: {
                  status: "completed",
                  output: {
                    matches: ["src/providers/opencode/convert.ts:87"],
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    const toolCall = session.items.find((item) => item.id === "msg_nested_call");
    const toolResult = session.items.find((item) => item.id === "msg_nested_result");

    expect(toolCall?.blocks[0]).toMatchObject({
      type: "tool_call",
      call_id: "call_nested_1",
      tool_name: "grep",
      arguments: {
        pattern: "TODO",
        path: "src/providers/opencode/convert.ts",
      },
    });
    expect(toolResult?.blocks[0]).toMatchObject({
      type: "tool_result",
      call_id: "call_nested_1",
      tool_name: "grep",
      content: JSON.stringify({
        matches: ["src/providers/opencode/convert.ts:87"],
      }),
    });
  });
});
