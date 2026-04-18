import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runExportSessionCli } from "../../src/cli/export-session.js";

function memoryWriter() {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text(): string {
      return chunks.join("");
    },
  };
}

const tempPaths: string[] = [];

function tempDir(): string {
  const directoryPath = mkdtempSync(resolve(tmpdir(), "export-ai-sessions-"));
  tempPaths.push(directoryPath);
  return directoryPath;
}

afterEach(() => {
  for (const directoryPath of tempPaths.splice(0)) {
    rmSync(directoryPath, { recursive: true, force: true });
  }
});

describe("export-session CLI", () => {
  it("writes a converted session to exported/<source>/<session-id>.json", () => {
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const root = process.cwd();
    const outputRoot = tempDir();
    const sourcePath = resolve(root, "tests/fixtures/codex/source.jsonl");
    const exitCode = runExportSessionCli(
      ["codex", "--input", sourcePath, "--out-dir", outputRoot, "--pretty"],
      { cwd: root, stdout, stderr },
    );

    const outputPath = resolve(outputRoot, "codex_fixture.json");

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain(outputRoot);
    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      source: "codex",
      session: { id: "codex_fixture" },
    });
  });

  it("scans the default data/<source> directory and skips factory settings files", () => {
    const cwd = tempDir();
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const root = process.cwd();
    const dataDir = resolve(cwd, "data", "factory");

    mkdirSync(dataDir, { recursive: true });
    copyFileSync(
      resolve(root, "tests/fixtures/factory/source.jsonl"),
      resolve(dataDir, "source.jsonl"),
    );
    writeFileSync(resolve(dataDir, "source.settings.json"), '{"ignored":true}\n', "utf8");

    const exitCode = runExportSessionCli(["factory"], { cwd, stdout, stderr });
    const outputPath = resolve(cwd, "exported", "factory", "factory_fixture.json");

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(existsSync(outputPath)).toBe(true);
    expect(stdout.text()).toContain("Exported 1 factory session");
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      source: "factory",
      session: { id: "factory_fixture" },
    });
  });

  it("finds the project root from nested directories for default input and output paths", () => {
    const root = process.cwd();
    const workspace = tempDir();
    const nestedCwd = resolve(workspace, "exported", "scratch");
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const dataDir = resolve(workspace, "data", "codex");

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });
    copyFileSync(
      resolve(root, "tests/fixtures/codex/source.jsonl"),
      resolve(dataDir, "source.jsonl"),
    );

    const exitCode = runExportSessionCli(["codex"], { cwd: nestedCwd, stdout, stderr });
    const outputPath = resolve(workspace, "exported", "codex", "codex_fixture.json");

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain(resolve(workspace, "exported", "codex"));
    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      source: "codex",
      session: { id: "codex_fixture" },
    });
  });

  it("returns a non-zero exit code for unsupported sources", () => {
    const stdout = memoryWriter();
    const stderr = memoryWriter();

    const exitCode = runExportSessionCli(["unknown-source"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Unsupported source: unknown-source");
  });

  it("writes help text to stdout", () => {
    const stdout = memoryWriter();
    const stderr = memoryWriter();

    const exitCode = runExportSessionCli(["--help"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("Usage: shair <source> [options]");
  });
});
