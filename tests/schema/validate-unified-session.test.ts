import { describe, expect, it } from "vitest";

import type { UnifiedSession } from "../../src/schema/unified-session.js";
import { UNIFIED_SESSION_VERSION } from "../../src/schema/unified-session.js";
import { validateUnifiedSession } from "../../src/schema/validate-unified-session.js";

function validSession(): UnifiedSession {
  return {
    version: UNIFIED_SESSION_VERSION,
    source: "opencode",
    session: {
      id: "ses_1",
      metadata: {},
    },
    items: [
      {
        id: "msg_1",
        kind: "message",
        role: "user",
        blocks: [{ type: "text", text: "hello", metadata: {} }],
        metadata: {},
      },
    ],
  };
}

describe("validateUnifiedSession", () => {
  it("accepts a valid unified session", () => {
    expect(() => validateUnifiedSession(validSession())).not.toThrow();
  });

  it("rejects duplicate item ids", () => {
    const session: UnifiedSession = {
      ...validSession(),
      items: [
        ...validSession().items,
        {
          id: "msg_1",
          kind: "message",
          blocks: [{ type: "text", text: "duplicate", metadata: {} }],
          metadata: {},
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/must be unique/u);
  });

  it("rejects invalid session timestamps", () => {
    const session: UnifiedSession = {
      ...validSession(),
      session: {
        ...validSession().session,
        created_at: "not-a-timestamp",
      },
    };

    expect(() => validateUnifiedSession(session)).toThrow(/session\.session\.created_at/u);
  });

  it("rejects invalid item timestamps", () => {
    const baseItem = validSession().items[0]!;
    const session: UnifiedSession = {
      ...validSession(),
      items: [
        {
          id: baseItem.id,
          kind: baseItem.kind,
          blocks: baseItem.blocks,
          metadata: baseItem.metadata,
          ...(baseItem.role !== undefined ? { role: baseItem.role } : {}),
          timestamp: "not-a-timestamp",
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/session\.items\[0\]\.timestamp/u);
  });

  it("rejects missing session metadata", () => {
    const session = {
      ...validSession(),
      session: {
        id: "ses_1",
      },
    };

    expect(() => validateUnifiedSession(session)).toThrow(/session\.session\.metadata/u);
  });

  it("rejects missing item metadata", () => {
    const session = {
      ...validSession(),
      items: [
        {
          id: "msg_1",
          kind: "message",
          blocks: [{ type: "text", text: "hello", metadata: {} }],
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/session\.items\[0\]\.metadata/u);
  });

  it("rejects invalid tool call arguments", () => {
    const session: UnifiedSession = {
      ...validSession(),
      items: [
        {
          id: "tool_1",
          kind: "tool_call",
          role: "assistant",
          blocks: [
            {
              type: "tool_call",
              tool_name: "exec_command",
              arguments: 42 as any,
              metadata: {},
            },
          ],
          metadata: {},
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/arguments/u);
  });

  it("rejects invalid tool result is_error values", () => {
    const session = {
      ...validSession(),
      items: [
        {
          id: "tool_result_1",
          kind: "tool_result",
          role: "tool",
          blocks: [
            {
              type: "tool_result",
              is_error: "nope",
              metadata: {},
            },
          ],
          metadata: {},
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/is_error/u);
  });

  it("rejects invalid step statuses", () => {
    const session = {
      ...validSession(),
      items: [
        {
          id: "step_1",
          kind: "message",
          blocks: [
            {
              type: "step",
              name: "build",
              status: "running",
              metadata: {},
            },
          ],
          metadata: {},
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/step.*status/u);
  });

  it("rejects invalid compaction modes", () => {
    const session = {
      ...validSession(),
      items: [
        {
          id: "cmp_1",
          kind: "compaction",
          blocks: [
            {
              type: "compaction",
              mode: "weird",
              metadata: {},
            },
          ],
          metadata: {},
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/compaction mode/u);
  });

  it("rejects invalid replacement payloads for replacement compaction", () => {
    const session = {
      ...validSession(),
      items: [
        {
          id: "cmp_1",
          kind: "compaction",
          blocks: [
            {
              type: "compaction",
              mode: "replacement",
              replacement_items: "bad",
              metadata: {},
            },
          ],
          metadata: {},
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/replacement_items/u);
  });

  it("rejects invalid marker compaction payloads", () => {
    const session: UnifiedSession = {
      ...validSession(),
      items: [
        {
          id: "cmp_1",
          kind: "compaction",
          blocks: [
            {
              type: "compaction",
              mode: "marker",
              summary_text: "should not exist",
              metadata: {},
            },
          ],
          metadata: {},
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/summary_text/u);
  });

  it("rejects invalid usage shapes", () => {
    const session = {
      ...validSession(),
      items: [
        {
          ...validSession().items[0],
          usage: "bad",
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).toThrow(/usage/u);
  });

  it("rejects missing text for text and code blocks", () => {
    const textSession = {
      ...validSession(),
      items: [
        {
          id: "msg_1",
          kind: "message",
          blocks: [{ type: "text", metadata: {} }],
          metadata: {},
        },
      ],
    };
    const codeSession = {
      ...validSession(),
      items: [
        {
          id: "msg_2",
          kind: "message",
          blocks: [{ type: "code", metadata: {} }],
          metadata: {},
        },
      ],
    };

    expect(() => validateUnifiedSession(textSession)).toThrow(/text is required/u);
    expect(() => validateUnifiedSession(codeSession)).toThrow(/text is required/u);
  });

  it("allows unknown future kinds and block types", () => {
    const session: UnifiedSession = {
      ...validSession(),
      items: [
        {
          id: "future_1",
          kind: "future_kind",
          blocks: [{ type: "future_block", metadata: {} } as any],
          metadata: {},
        },
      ],
    };

    expect(() => validateUnifiedSession(session)).not.toThrow();
  });
});
