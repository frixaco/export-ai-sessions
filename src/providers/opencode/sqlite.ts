import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Database, SqlJsStatic } from "sql.js";
import initSqlJs from "sql.js";

import { ConversionError } from "../../core/errors.js";
import { asObject, parseJson } from "../shared/json.js";
import type { OpencodeExport, OpencodeMessage } from "./types.js";

interface SessionRow {
  readonly id: string;
  readonly project_id: string;
  readonly slug: string;
  readonly directory: string;
  readonly title: string;
  readonly version: string;
  readonly summary_additions: number | null;
  readonly summary_deletions: number | null;
  readonly summary_files: number | null;
  readonly summary_diffs: string | null;
  readonly time_created: number;
  readonly time_updated: number;
}

interface MessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly time_created: number;
  readonly time_updated: number;
  readonly data: string;
}

interface PartRow {
  readonly id: string;
  readonly message_id: string;
  readonly time_created: number;
  readonly time_updated: number;
  readonly data: string;
}

export interface OpenCodeSqliteStore {
  readonly dbPath: string;
  listSessionIds(): string[];
  loadSessionExport(sessionId: string): OpencodeExport;
  close(): void;
}

const require = createRequire(import.meta.url);

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

type SqliteBindValue = number | string | Uint8Array | null;

export function defaultOpencodeDbPaths(homeDir: string): string[] {
  return [
    join(homeDir, ".local", "share", "opencode", "opencode.db"),
    join(homeDir, "Library", "Application Support", "opencode", "opencode.db"),
  ];
}

export function resolveDefaultOpencodeDbPaths(homeDir: string): string[] {
  const dbPaths = defaultOpencodeDbPaths(homeDir).filter((dbPath) => existsSync(dbPath));

  if (dbPaths.length > 0) {
    return dbPaths;
  }

  throw new ConversionError(
    `No OpenCode database found. Checked: ${defaultOpencodeDbPaths(homeDir).join(", ")}`,
  );
}

export async function openOpencodeSqliteStore(dbPath: string): Promise<OpenCodeSqliteStore> {
  if (!existsSync(dbPath)) {
    throw new ConversionError(`OpenCode database does not exist: ${dbPath}`);
  }

  const SQL = await getSqlJs();
  const database = new SQL.Database(readFileSync(dbPath));

  validateSchema(database);

  return {
    dbPath,

    listSessionIds(): string[] {
      return queryRows<{ id: string }>(
        database,
        [
          "SELECT session.id AS id",
          "FROM session",
          "ORDER BY session.time_created ASC, session.id ASC",
        ].join(" "),
      ).map((row) => row.id);
    },

    loadSessionExport(sessionId: string): OpencodeExport {
      return loadSessionExport(database, sessionId);
    },

    close(): void {
      database.close();
    },
  };
}

function validateSchema(database: Database): void {
  const rows = queryRows<{ name: string }>(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const tableNames = new Set(rows.map((row) => row.name));

  for (const requiredTable of ["session", "message", "part"]) {
    if (!tableNames.has(requiredTable)) {
      throw new ConversionError(`OpenCode database is missing required table: ${requiredTable}`);
    }
  }
}

function loadSessionExport(database: Database, sessionId: string): OpencodeExport {
  const sessionRow = queryOne<SessionRow>(
    database,
    [
      "SELECT id, project_id, slug, directory, title, version,",
      "summary_additions, summary_deletions, summary_files, summary_diffs,",
      "time_created, time_updated",
      "FROM session",
      "WHERE id = ?",
    ].join(" "),
    [sessionId],
  );

  if (sessionRow === null) {
    throw new ConversionError(`OpenCode session not found in database: ${sessionId}`);
  }

  const partRows = queryRows<PartRow>(
    database,
    [
      "SELECT id, message_id, time_created, time_updated, data",
      "FROM part",
      "WHERE session_id = ?",
      "ORDER BY message_id ASC, time_created ASC, id ASC",
    ].join(" "),
    [sessionId],
  );
  const partsByMessageId = new Map<string, Record<string, unknown>[]>();

  for (const partRow of partRows) {
    const parsedPart = parseObjectJson(
      partRow.data,
      `OpenCode part ${partRow.id} in session ${sessionId}`,
    );
    const existingParts = partsByMessageId.get(partRow.message_id) ?? [];
    existingParts.push(parsedPart);
    partsByMessageId.set(partRow.message_id, existingParts);
  }

  const messageRows = queryRows<MessageRow>(
    database,
    [
      "SELECT id, session_id, time_created, time_updated, data",
      "FROM message",
      "WHERE session_id = ?",
      "ORDER BY time_created ASC, id ASC",
    ].join(" "),
    [sessionId],
  );
  const messages = messageRows.map((messageRow) =>
    adaptMessageRow(messageRow, partsByMessageId.get(messageRow.id) ?? []),
  );

  return {
    info: adaptSessionInfo(sessionRow),
    messages,
  };
}

function adaptSessionInfo(row: SessionRow): OpencodeExport["info"] {
  const summary: Record<string, unknown> = {};

  if (row.summary_additions !== null) {
    summary.additions = row.summary_additions;
  }
  if (row.summary_deletions !== null) {
    summary.deletions = row.summary_deletions;
  }
  if (row.summary_files !== null) {
    summary.files = row.summary_files;
  }
  if (row.summary_diffs !== null) {
    summary.diffs = parsePossiblyJson(row.summary_diffs);
  }

  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    directory: row.directory,
    title: row.title,
    version: row.version,
    ...(Object.keys(summary).length > 0 ? { summary } : {}),
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  };
}

function adaptMessageRow(row: MessageRow, parts: Record<string, unknown>[]): OpencodeMessage {
  const parsedInfo = parseObjectJson(
    row.data,
    `OpenCode message ${row.id} in session ${row.session_id}`,
  );
  const rawTime = asOptionalObject(parsedInfo.time);

  return {
    info: {
      ...parsedInfo,
      id: row.id,
      sessionID: row.session_id,
      time: {
        ...rawTime,
        created: row.time_created,
        updated: row.time_updated,
      },
    },
    parts,
  };
}

function asOptionalObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseObjectJson(input: string, label: string): Record<string, unknown> {
  try {
    return asObject(parseJson(input));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConversionError(`${label} contains invalid JSON: ${detail}`);
  }
}

function parsePossiblyJson(input: string): unknown {
  try {
    return parseJson(input);
  } catch {
    return input;
  }
}

function queryOne<TRow extends object>(
  database: Database,
  sql: string,
  params: readonly SqliteBindValue[] = [],
): TRow | null {
  const [row] = queryRows<TRow>(database, sql, params);
  return row ?? null;
}

function queryRows<TRow extends object>(
  database: Database,
  sql: string,
  params: readonly SqliteBindValue[] = [],
): TRow[] {
  const statement = database.prepare(sql);

  try {
    if (params.length > 0) {
      statement.bind([...params]);
    }

    const rows: TRow[] = [];
    while (statement.step()) {
      rows.push(statement.getAsObject() as TRow);
    }
    return rows;
  } finally {
    statement.free();
  }
}

async function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsPromise === undefined) {
    sqlJsPromise = initSqlJs({
      locateFile(file) {
        return require.resolve(`sql.js/dist/${file}`);
      },
    });
  }

  return sqlJsPromise;
}
