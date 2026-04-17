import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { convertSessionFile, convertSessionText } from "../../src/core/convert-session.js";

const root = process.cwd();

describe("session conversion integration", () => {
  it("converts every checked-in main fixture end-to-end and returns validated output", () => {
    const sources = [
      ["opencode", "tests/fixtures/opencode/source.json"],
      ["codex", "tests/fixtures/codex/source.jsonl"],
      ["pi", "tests/fixtures/pi/source.jsonl"],
      ["claude", "tests/fixtures/claude/source.jsonl"],
      ["factory", "tests/fixtures/factory/source.jsonl"],
    ] as const;

    for (const [source, filePath] of sources) {
      const session = convertSessionFile(source, resolve(root, filePath));
      expect(session.source).toBe(source);
      expect(session.items.length).toBeGreaterThan(0);
      expect(session.session.id.length).toBeGreaterThan(0);
      expect(session.session.metadata).toBeTypeOf("object");
    }
  });

  it("converts fixture text input directly", () => {
    const input = readFileSync(resolve(root, "tests/fixtures/codex/source.jsonl"), "utf8");
    const session = convertSessionText("codex", input, "tests/fixtures/codex/source.jsonl");

    expect(session.source).toBe("codex");
    expect(session.session.id).toBe("codex_fixture");
    expect(session.items.some((item) => item.kind === "search")).toBe(true);
  });

  it("throws when parsed input normalizes to an invalid unified session", () => {
    const invalidOpencode = JSON.stringify({
      info: {
        version: "1.2.3",
      },
      messages: [],
    });

    expect(() => convertSessionText("opencode", invalidOpencode)).toThrow(/session\.session\.id/u);
  });
});
