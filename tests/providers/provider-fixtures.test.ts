import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { convertSessionFile } from "../../src/core/convert-session.js";
import type { UnifiedSource } from "../../src/schema/unified-session.js";

const root = process.cwd();

const cases: Array<{
  readonly source: UnifiedSource;
  readonly sourceFile: string;
  readonly expectedFile: string;
}> = [
  {
    source: "opencode",
    sourceFile: "tests/fixtures/opencode/source.json",
    expectedFile: "tests/fixtures/opencode/expected.unified.json",
  },
  {
    source: "codex",
    sourceFile: "tests/fixtures/codex/source.jsonl",
    expectedFile: "tests/fixtures/codex/expected.unified.json",
  },
  {
    source: "pi",
    sourceFile: "tests/fixtures/pi/source.jsonl",
    expectedFile: "tests/fixtures/pi/expected.unified.json",
  },
  {
    source: "pi",
    sourceFile: "tests/fixtures/pi/source.state-parent.jsonl",
    expectedFile: "tests/fixtures/pi/expected.state-parent.unified.json",
  },
  {
    source: "claude",
    sourceFile: "tests/fixtures/claude/source.jsonl",
    expectedFile: "tests/fixtures/claude/expected.unified.json",
  },
  {
    source: "factory",
    sourceFile: "tests/fixtures/factory/source.jsonl",
    expectedFile: "tests/fixtures/factory/expected.unified.json",
  },
];

describe("provider fixtures", () => {
  for (const testCase of cases) {
    it(`matches golden output for ${testCase.source}`, () => {
      const sourcePath = resolve(root, testCase.sourceFile);
      const expectedPath = resolve(root, testCase.expectedFile);
      const actual = convertSessionFile(testCase.source, sourcePath);
      const expected = JSON.parse(readFileSync(expectedPath, "utf8"));

      expect(actual).toEqual(expected);
    });
  }
});
