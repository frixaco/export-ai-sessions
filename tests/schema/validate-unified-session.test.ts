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

  it("rejects invalid compaction marker payloads", () => {
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
