import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

import initSqlJs from "sql.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  openOpencodeSqliteStore,
  resolveDefaultOpencodeDbPaths,
} from "../../src/providers/opencode/sqlite.js";

const require = createRequire(import.meta.url);
const tempPaths: string[] = [];

function tempDir(): string {
  const directoryPath = mkdtempSync(resolve(tmpdir(), "export-ai-sessions-opencode-sqlite-"));
  tempPaths.push(directoryPath);
  return directoryPath;
}

afterEach(() => {
  for (const directoryPath of tempPaths.splice(0)) {
    rmSync(directoryPath, { recursive: true, force: true });
  }
});

async function createOpencodeDb(
  dbPath: string,
  options: {
    malformedMessageJson?: boolean;
  } = {},
): Promise<void> {
  const SQL = await initSqlJs({
    locateFile(file) {
      return require.resolve(`sql.js/dist/${file}`);
    },
  });
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

  db.exec(`
    INSERT INTO session (
      id, project_id, parent_id, slug, directory, title, version,
      share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
      revert, permission, time_created, time_updated, time_compacting, time_archived, workspace_id
    ) VALUES
      ('ses_a', 'proj_1', NULL, 'alpha', '/tmp/a', 'Session A', '1.2.3', NULL, 5, 2, 1, NULL, NULL, NULL, 1000, 2000, NULL, NULL, NULL),
      ('ses_b', 'proj_1', NULL, 'beta', '/tmp/b', 'Session B', '1.2.3', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 3000, 4000, NULL, NULL, NULL);
  `);

  const messageJson =
    options.malformedMessageJson === true
      ? "{not valid json"
      : JSON.stringify({
          role: "assistant",
          parentID: "msg_prev",
          providerID: "anthropic",
          modelID: "claude-opus",
          mode: "build",
          time: { completed: 1500 },
          cost: 0.5,
          tokens: { input: 10, output: 20 },
        });

  db.exec(`
    INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('msg_a_1', 'ses_a', 1100, 1600, '${messageJson.replace(/'/g, "''")}'),
      ('msg_b_1', 'ses_b', 3100, 3200, '{"role":"user","time":{"created":3100}}');
  `);

  db.exec(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
      ('prt_a_1', 'msg_a_1', 'ses_a', 1101, 1101, '{"type":"step-start"}'),
      ('prt_a_2', 'msg_a_1', 'ses_a', 1102, 1102, '{"type":"text","text":"hello sqlite"}'),
      ('prt_b_1', 'msg_b_1', 'ses_b', 3101, 3101, '{"type":"text","text":"hi"}');
  `);

  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

describe("opencode sqlite loader", () => {
  it("resolves all default runtime database paths", async () => {
    const homeDir = tempDir();
    const linuxDbDir = join(homeDir, ".local", "share", "opencode");
    const macDbDir = join(homeDir, "Library", "Application Support", "opencode");
    const linuxDbPath = join(linuxDbDir, "opencode.db");
    const macDbPath = join(macDbDir, "opencode.db");

    expect(() => resolveDefaultOpencodeDbPaths(homeDir)).toThrow("No OpenCode database found.");

    mkdirSync(linuxDbDir, { recursive: true });
    mkdirSync(macDbDir, { recursive: true });
    await createOpencodeDb(linuxDbPath);
    await createOpencodeDb(macDbPath);

    expect(resolveDefaultOpencodeDbPaths(homeDir)).toEqual([linuxDbPath, macDbPath]);
  });

  it("lists and loads OpenCode sessions from sqlite", async () => {
    const homeDir = tempDir();
    const dbDir = join(homeDir, ".local", "share", "opencode");
    const dbPath = join(dbDir, "opencode.db");

    mkdirSync(dbDir, { recursive: true });
    await createOpencodeDb(dbPath);

    expect(resolveDefaultOpencodeDbPaths(homeDir)).toEqual([dbPath]);

    const store = await openOpencodeSqliteStore(dbPath);
    try {
      expect(store.listSessionIds()).toEqual(["ses_a", "ses_b"]);

      const session = store.loadSessionExport("ses_a");

      expect(session.info).toMatchObject({
        id: "ses_a",
        slug: "alpha",
        projectID: "proj_1",
        directory: "/tmp/a",
        title: "Session A",
        version: "1.2.3",
        summary: {
          additions: 5,
          deletions: 2,
          files: 1,
        },
        time: {
          created: 1000,
          updated: 2000,
        },
      });
      expect(session.messages[0]).toMatchObject({
        info: {
          id: "msg_a_1",
          sessionID: "ses_a",
          parentID: "msg_prev",
          providerID: "anthropic",
          modelID: "claude-opus",
          mode: "build",
          cost: 0.5,
          tokens: { input: 10, output: 20 },
          time: {
            created: 1100,
            completed: 1500,
            updated: 1600,
          },
        },
      });
      expect(session.messages[0]?.parts).toEqual([
        { type: "step-start" },
        { type: "text", text: "hello sqlite" },
      ]);
    } finally {
      store.close();
    }
  });

  it("fails clearly on malformed OpenCode row payloads", async () => {
    const dbDir = tempDir();
    const dbPath = join(dbDir, "opencode.db");

    await createOpencodeDb(dbPath, { malformedMessageJson: true });

    const store = await openOpencodeSqliteStore(dbPath);
    try {
      expect(() => store.loadSessionExport("ses_a")).toThrow(
        "OpenCode message msg_a_1 in session ses_a contains invalid JSON",
      );
    } finally {
      store.close();
    }
  });

  it("fails clearly when the database schema is incomplete", async () => {
    const SQL = await initSqlJs({
      locateFile(file) {
        return require.resolve(`sql.js/dist/${file}`);
      },
    });
    const dbDir = tempDir();
    const dbPath = join(dbDir, "opencode.db");
    const db = new SQL.Database();

    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, revert TEXT, permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER, workspace_id TEXT);",
    );
    writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();

    await expect(openOpencodeSqliteStore(dbPath)).rejects.toThrow(
      "OpenCode database is missing required table: message",
    );
  });
});
