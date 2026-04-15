import { describe, expect, it } from "vitest";

import {
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolResultBlock,
} from "../../src/providers/shared/blocks.js";
import { classifyItemKindFromBlocks } from "../../src/providers/shared/classify-item-kind.js";

describe("classifyItemKindFromBlocks", () => {
  it("treats mixed blocks as a normal message", () => {
    const classification = classifyItemKindFromBlocks(
      [
        thinkingBlock("Need to inspect", "sig"),
        toolCallBlock({
          call_id: "toolu_1",
          tool_name: "Read",
          arguments: { file_path: "README.md" },
        }),
      ],
      "assistant",
    );

    expect(classification).toEqual({
      kind: "message",
      role: "assistant",
    });
  });

  it("maps pure thinking items to reasoning", () => {
    const classification = classifyItemKindFromBlocks(
      [thinkingBlock("Need to inspect")],
      "assistant",
    );

    expect(classification).toEqual({
      kind: "reasoning",
      role: "assistant",
    });
  });

  it("maps pure tool results to tool role", () => {
    const classification = classifyItemKindFromBlocks(
      [
        toolResultBlock({
          call_id: "toolu_1",
          tool_name: "Read",
          is_error: false,
          content: "ok",
        }),
      ],
      "user",
    );

    expect(classification).toEqual({
      kind: "tool_result",
      role: "tool",
    });
  });

  it("leaves regular text messages as messages", () => {
    const classification = classifyItemKindFromBlocks([textBlock("hello")], "user");

    expect(classification).toEqual({
      kind: "message",
      role: "user",
    });
  });
});
