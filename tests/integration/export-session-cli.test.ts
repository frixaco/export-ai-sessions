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
import initSqlJs from "sql.js";

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

async function writeOpencodeDb(
  dbPath: string,
  rows: {
    sessions: Array<{
      id: string;
      projectId: string;
      slug: string;
      directory: string;
      title: string;
      version: string;
      createdAt: number;
      updatedAt: number;
    }>;
    messages: Array<{
      id: string;
      sessionId: string;
      createdAt: number;
      updatedAt: number;
      data: Record<string, unknown>;
    }>;
    parts: Array<{
      id: string;
      messageId: string;
      sessionId: string;
      createdAt: number;
      updatedAt: number;
      data: Record<string, unknown>;
    }>;
  },
): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  const insertSession = db.prepare(`
    INSERT INTO session (
      id, project_id, parent_id, slug, directory, title, version,
      share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
      revert, permission, time_created, time_updated, time_compacting, time_archived, workspace_id
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertPart = db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const session of rows.sessions) {
    insertSession.run([
      session.id,
      session.projectId,
      session.slug,
      session.directory,
      session.title,
      session.version,
      session.createdAt,
      session.updatedAt,
    ]);
  }

  for (const message of rows.messages) {
    insertMessage.run([
      message.id,
      message.sessionId,
      message.createdAt,
      message.updatedAt,
      JSON.stringify(message.data),
    ]);
  }

  for (const part of rows.parts) {
    insertPart.run([
      part.id,
      part.messageId,
      part.sessionId,
      part.createdAt,
      part.updatedAt,
      JSON.stringify(part.data),
    ]);
  }

  writeFileSync(dbPath, Buffer.from(db.export()));
  insertSession.free();
  insertMessage.free();
  insertPart.free();
  db.close();
}

describe("export-session CLI", () => {
  it("writes a converted session to exported/<source>/<session-id>.json", async () => {
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const root = process.cwd();
    const outputRoot = tempDir();
    const homeDir = tempDir();
    const sourcePath = resolve(root, "tests/fixtures/codex/source.jsonl");
    const exitCode = await runExportSessionCli(
      ["codex", "--input", sourcePath, "--out-dir", outputRoot, "--pretty"],
      { cwd: root, homeDir, stdout, stderr },
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

  it("scans the default data/<source> directory and skips factory settings files", async () => {
    const cwd = tempDir();
    const homeDir = tempDir();
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

    const exitCode = await runExportSessionCli(["factory"], { cwd, homeDir, stdout, stderr });
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

  it("finds the project root from nested directories for repo data fallback", async () => {
    const root = process.cwd();
    const workspace = tempDir();
    const homeDir = tempDir();
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

    const exitCode = await runExportSessionCli(["codex"], {
      cwd: nestedCwd,
      homeDir,
      stdout,
      stderr,
    });
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

  it("prefers runtime Codex sessions from the home directory over repo fixtures", async () => {
    const root = process.cwd();
    const workspace = tempDir();
    const homeDir = tempDir();
    const nestedCwd = resolve(workspace, "exported", "scratch");
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const runtimeDir = resolve(homeDir, ".codex", "sessions", "2026", "02", "28");
    const fixtureDataDir = resolve(workspace, "data", "codex");

    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(fixtureDataDir, { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });
    copyFileSync(
      resolve(root, "tests/fixtures/codex/source.jsonl"),
      resolve(runtimeDir, "rollout-2026-02-28T08-00-00-codex_fixture.jsonl"),
    );
    copyFileSync(
      resolve(root, "tests/fixtures/codex/source.duplicates.jsonl"),
      resolve(fixtureDataDir, "source.duplicates.jsonl"),
    );

    const exitCode = await runExportSessionCli(["codex"], {
      cwd: nestedCwd,
      homeDir,
      stdout,
      stderr,
    });
    const outputPath = resolve(workspace, "exported", "codex", "codex_fixture.json");
    const fallbackOutputPath = resolve(
      workspace,
      "exported",
      "codex",
      "codex_duplicate_fixture.json",
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("Exported 1 codex session");
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(fallbackOutputPath)).toBe(false);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      source: "codex",
      session: { id: "codex_fixture" },
    });
  });

  it("uses the runtime OpenCode SQLite database and exports every session", async () => {
    const workspace = tempDir();
    const homeDir = tempDir();
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const dbDir = resolve(homeDir, ".local", "share", "opencode");
    const dbPath = resolve(dbDir, "opencode.db");

    mkdirSync(dbDir, { recursive: true });
    await writeOpencodeDb(dbPath, {
      sessions: [
        {
          id: "ses_fixture_a",
          projectId: "proj_fixture",
          slug: "fixture-a",
          directory: "/tmp/opencode-a",
          title: "Fixture A",
          version: "1.2.3",
          createdAt: 1704067200000,
          updatedAt: 1704067260000,
        },
        {
          id: "ses_fixture_b",
          projectId: "proj_fixture",
          slug: "fixture-b",
          directory: "/tmp/opencode-b",
          title: "Fixture B",
          version: "1.2.3",
          createdAt: 1704067300000,
          updatedAt: 1704067360000,
        },
      ],
      messages: [
        {
          id: "msg_fixture_a_1",
          sessionId: "ses_fixture_a",
          createdAt: 1704067201000,
          updatedAt: 1704067201000,
          data: {
            role: "user",
            time: { created: 1704067201000 },
          },
        },
        {
          id: "msg_fixture_b_1",
          sessionId: "ses_fixture_b",
          createdAt: 1704067301000,
          updatedAt: 1704067301000,
          data: {
            role: "assistant",
            time: { created: 1704067301000 },
            providerID: "anthropic",
            modelID: "claude-opus",
          },
        },
      ],
      parts: [
        {
          id: "prt_fixture_a_1",
          messageId: "msg_fixture_a_1",
          sessionId: "ses_fixture_a",
          createdAt: 1704067201001,
          updatedAt: 1704067201001,
          data: { type: "text", text: "hello from sqlite a" },
        },
        {
          id: "prt_fixture_b_1",
          messageId: "msg_fixture_b_1",
          sessionId: "ses_fixture_b",
          createdAt: 1704067301001,
          updatedAt: 1704067301001,
          data: { type: "text", text: "hello from sqlite b" },
        },
      ],
    });

    const exitCode = await runExportSessionCli(["opencode"], {
      cwd: workspace,
      homeDir,
      stdout,
      stderr,
    });

    const outputA = resolve(workspace, "exported", "opencode", "ses_fixture_a.json");
    const outputB = resolve(workspace, "exported", "opencode", "ses_fixture_b.json");

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("Exported 2 opencode sessions");
    expect(existsSync(outputA)).toBe(true);
    expect(existsSync(outputB)).toBe(true);
    expect(JSON.parse(readFileSync(outputA, "utf8"))).toMatchObject({
      source: "opencode",
      session: { id: "ses_fixture_a" },
    });
    expect(JSON.parse(readFileSync(outputB, "utf8"))).toMatchObject({
      source: "opencode",
      session: { id: "ses_fixture_b" },
    });
  });

  it("merges sessions from every detected runtime OpenCode database", async () => {
    const workspace = tempDir();
    const homeDir = tempDir();
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const linuxDbDir = resolve(homeDir, ".local", "share", "opencode");
    const macDbDir = resolve(homeDir, "Library", "Application Support", "opencode");
    const linuxDbPath = resolve(linuxDbDir, "opencode.db");
    const macDbPath = resolve(macDbDir, "opencode.db");

    mkdirSync(linuxDbDir, { recursive: true });
    mkdirSync(macDbDir, { recursive: true });
    await writeOpencodeDb(linuxDbPath, {
      sessions: [
        {
          id: "ses_linux",
          projectId: "proj_fixture",
          slug: "linux",
          directory: "/tmp/opencode-linux",
          title: "Fixture Linux",
          version: "1.2.3",
          createdAt: 1704067200000,
          updatedAt: 1704067260000,
        },
      ],
      messages: [
        {
          id: "msg_linux_1",
          sessionId: "ses_linux",
          createdAt: 1704067201000,
          updatedAt: 1704067201000,
          data: { role: "user", time: { created: 1704067201000 } },
        },
      ],
      parts: [
        {
          id: "prt_linux_1",
          messageId: "msg_linux_1",
          sessionId: "ses_linux",
          createdAt: 1704067201001,
          updatedAt: 1704067201001,
          data: { type: "text", text: "hello from linux db" },
        },
      ],
    });
    await writeOpencodeDb(macDbPath, {
      sessions: [
        {
          id: "ses_mac",
          projectId: "proj_fixture",
          slug: "mac",
          directory: "/tmp/opencode-mac",
          title: "Fixture Mac",
          version: "1.2.3",
          createdAt: 1704067300000,
          updatedAt: 1704067360000,
        },
      ],
      messages: [
        {
          id: "msg_mac_1",
          sessionId: "ses_mac",
          createdAt: 1704067301000,
          updatedAt: 1704067301000,
          data: { role: "assistant", time: { created: 1704067301000 } },
        },
      ],
      parts: [
        {
          id: "prt_mac_1",
          messageId: "msg_mac_1",
          sessionId: "ses_mac",
          createdAt: 1704067301001,
          updatedAt: 1704067301001,
          data: { type: "text", text: "hello from mac db" },
        },
      ],
    });

    const exitCode = await runExportSessionCli(["opencode"], {
      cwd: workspace,
      homeDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("Exported 2 opencode sessions");
    expect(existsSync(resolve(workspace, "exported", "opencode", "ses_linux.json"))).toBe(true);
    expect(existsSync(resolve(workspace, "exported", "opencode", "ses_mac.json"))).toBe(true);
  });

  it("treats an explicit opencode.db file as a SQLite input", async () => {
    const workspace = tempDir();
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const dbPath = resolve(workspace, "copied-opencode.db");

    await writeOpencodeDb(dbPath, {
      sessions: [
        {
          id: "ses_explicit_db",
          projectId: "proj_fixture",
          slug: "explicit-db",
          directory: "/tmp/opencode-explicit-db",
          title: "Fixture Explicit DB",
          version: "1.2.3",
          createdAt: 1704067400000,
          updatedAt: 1704067460000,
        },
      ],
      messages: [
        {
          id: "msg_explicit_db_1",
          sessionId: "ses_explicit_db",
          createdAt: 1704067401000,
          updatedAt: 1704067401000,
          data: { role: "user", time: { created: 1704067401000 } },
        },
      ],
      parts: [
        {
          id: "prt_explicit_db_1",
          messageId: "msg_explicit_db_1",
          sessionId: "ses_explicit_db",
          createdAt: 1704067401001,
          updatedAt: 1704067401001,
          data: { type: "text", text: "hello from explicit db file" },
        },
      ],
    });

    const exitCode = await runExportSessionCli(["opencode", "--input", dbPath], {
      cwd: workspace,
      homeDir: tempDir(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("Exported 1 opencode session");
    expect(existsSync(resolve(workspace, "exported", "opencode", "ses_explicit_db.json"))).toBe(
      true,
    );
  });

  it("treats an explicit OpenCode install directory as a SQLite input", async () => {
    const workspace = tempDir();
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const installDir = resolve(workspace, "copied-opencode-install");
    const dbPath = resolve(installDir, "opencode.db");

    mkdirSync(installDir, { recursive: true });
    await writeOpencodeDb(dbPath, {
      sessions: [
        {
          id: "ses_explicit_dir",
          projectId: "proj_fixture",
          slug: "explicit-dir",
          directory: "/tmp/opencode-explicit-dir",
          title: "Fixture Explicit Dir",
          version: "1.2.3",
          createdAt: 1704067500000,
          updatedAt: 1704067560000,
        },
      ],
      messages: [
        {
          id: "msg_explicit_dir_1",
          sessionId: "ses_explicit_dir",
          createdAt: 1704067501000,
          updatedAt: 1704067501000,
          data: { role: "assistant", time: { created: 1704067501000 } },
        },
      ],
      parts: [
        {
          id: "prt_explicit_dir_1",
          messageId: "msg_explicit_dir_1",
          sessionId: "ses_explicit_dir",
          createdAt: 1704067501001,
          updatedAt: 1704067501001,
          data: { type: "text", text: "hello from explicit install dir" },
        },
      ],
    });

    const exitCode = await runExportSessionCli(["opencode", "--input", installDir], {
      cwd: workspace,
      homeDir: tempDir(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("Exported 1 opencode session");
    expect(existsSync(resolve(workspace, "exported", "opencode", "ses_explicit_dir.json"))).toBe(
      true,
    );
  });

  it("returns a clear error when the runtime OpenCode database is unavailable", async () => {
    const workspace = tempDir();
    const homeDir = tempDir();
    const stdout = memoryWriter();
    const stderr = memoryWriter();

    const exitCode = await runExportSessionCli(["opencode"], {
      cwd: workspace,
      homeDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("No OpenCode database found.");
  });

  it("returns a non-zero exit code for unsupported sources", async () => {
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const homeDir = tempDir();

    const exitCode = await runExportSessionCli(["unknown-source"], {
      cwd: process.cwd(),
      homeDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Unsupported source: unknown-source");
  });

  it("writes help text to stdout", async () => {
    const stdout = memoryWriter();
    const stderr = memoryWriter();
    const homeDir = tempDir();

    const exitCode = await runExportSessionCli(["--help"], {
      cwd: process.cwd(),
      homeDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("Usage: shair <source> [options]");
  });
});
