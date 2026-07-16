import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { convertSessionText } from "../../src/core/convert-session.js";

const root = process.cwd();

describe("session conversion integration", () => {
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
