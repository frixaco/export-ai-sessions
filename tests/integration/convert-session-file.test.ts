import { describe, expect, it } from "vitest";

import { convertSessionFile } from "../../src/core/convert-session.js";

describe("convertSessionFile", () => {
  it("converts every checked-in fixture end-to-end", () => {
    const sources = [
      ["opencode", "tests/fixtures/opencode/source.json"],
      ["codex", "tests/fixtures/codex/source.jsonl"],
      ["pi", "tests/fixtures/pi/source.jsonl"],
      ["claude", "tests/fixtures/claude/source.jsonl"],
      ["factory", "tests/fixtures/factory/source.jsonl"],
    ] as const;

    for (const [source, filePath] of sources) {
      const session = convertSessionFile(source, filePath);
      expect(session.source).toBe(source);
      expect(session.items.length).toBeGreaterThan(0);
      expect(session.session.id.length).toBeGreaterThan(0);
    }
  });
});
