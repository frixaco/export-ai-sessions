import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { convertSessionFile } from "../../src/core/convert-session.js";

const root = process.cwd();
const runAudit = process.env.RUN_REAL_SAMPLE_AUDIT === "1";

describe.skipIf(!runAudit)("real sample audit", () => {
  it("converts the real local samples with expected high-signal structures", () => {
    const cases = [
      {
        source: "factory" as const,
        path: "data/factory/sessions/-Users-frixa-Documents-xport/a5b7526a-ef3b-4241-8988-9f9413cdf1bd.jsonl",
        assert(session: ReturnType<typeof convertSessionFile>) {
          expect(session.items.some((item) => item.kind === "compaction")).toBe(true);
          expect(
            session.items.some((item) => item.blocks.some((block) => block.type !== "raw")),
          ).toBe(true);
        },
      },
      {
        source: "pi" as const,
        path: "data/pi/agent/sessions/--Users-frixa-Documents-intercept--/2026-01-30T16-08-16-204Z_8f18cf92-fec3-4fe1-a696-7ad51b22ca99.jsonl",
        assert(session: ReturnType<typeof convertSessionFile>) {
          expect(session.items.some((item) => item.kind === "tool_result")).toBe(true);
          expect(
            session.items.some((item) => item.blocks.some((block) => block.type === "image")),
          ).toBe(true);
        },
      },
      {
        source: "claude" as const,
        path: "data/claude/projects/-Users-frixa-Documents-export-ai-sessions/b508c7cc-a751-4a55-95e3-d1b9665959be.jsonl",
        assert(session: ReturnType<typeof convertSessionFile>) {
          expect(session.items.some((item) => item.kind === "compaction")).toBe(true);
          expect(
            session.items.some((item) => item.blocks.some((block) => block.type === "file_ref")),
          ).toBe(true);
        },
      },
      {
        source: "codex" as const,
        path: "data/codex/sessions/2026/02/28/rollout-2026-02-28T13-34-45-019ca362-c819-72d0-a96f-5385aca06cbb.jsonl",
        assert(session: ReturnType<typeof convertSessionFile>) {
          expect(session.items.some((item) => item.role === "developer")).toBe(true);
          expect(session.items.some((item) => item.kind === "search")).toBe(true);
        },
      },
      {
        source: "opencode" as const,
        path: "data/opencode/export-ses_46a891f5cffe22guxcWdpEwJqN.json",
        assert(session: ReturnType<typeof convertSessionFile>) {
          expect(
            session.items.some((item) => item.blocks.some((block) => block.type === "file_ref")),
          ).toBe(true);
          expect(
            session.items.some((item) => item.blocks.some((block) => block.type === "patch_ref")),
          ).toBe(true);
        },
      },
    ];

    for (const testCase of cases) {
      const fullPath = resolve(root, testCase.path);
      expect(existsSync(fullPath)).toBe(true);
      const session = convertSessionFile(testCase.source, fullPath);
      testCase.assert(session);
    }
  });
});
