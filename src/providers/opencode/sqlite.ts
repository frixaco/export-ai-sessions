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
  readonly parent_id: string | null;
  readonly slug: string;
  readonly directory: string;
  readonly title: string;
  readonly version: string;
  readonly share_url: string | null;
  readonly summary_additions: number | null;
  readonly summary_deletions: number | null;
  readonly summary_files: number | null;
  readonly summary_diffs: string | null;
  readonly revert: string | null;
  readonly permission: string | null;
  readonly time_created: number;
  readonly time_updated: number;
  readonly time_compacting: number | null;
  readonly time_archived: number | null;
  readonly workspace_id: string | null;
  readonly path: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly cost: number | null;
  readonly tokens_input: number | null;
  readonly tokens_output: number | null;
  readonly tokens_reasoning: number | null;
  readonly tokens_cache_read: number | null;
  readonly tokens_cache_write: number | null;
  readonly metadata: string | null;
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

  const requiredColumnsByTable = {
    session: [
      "id",
      "project_id",
      "slug",
      "directory",
      "title",
      "version",
      "time_created",
      "time_updated",
    ],
    message: ["id", "session_id", "time_created", "time_updated", "data"],
    part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
  } as const;

  for (const [table, requiredColumns] of Object.entries(requiredColumnsByTable)) {
    const columns = tableColumns(database, table);
    for (const requiredColumn of requiredColumns) {
      if (!columns.has(requiredColumn)) {
        throw new ConversionError(
          `OpenCode database table ${table} is missing required column: ${requiredColumn}`,
        );
      }
    }
  }
}

function loadSessionExport(database: Database, sessionId: string): OpencodeExport {
  const sessionColumns = tableColumns(database, "session");
  const optionalColumn = (name: string): string =>
    sessionColumns.has(name) ? name : `NULL AS ${name}`;
  const sessionRow = queryOne<SessionRow>(
    database,
    [
      `SELECT id, project_id, ${optionalColumn("parent_id")}, slug, directory, title, version,`,
      `${optionalColumn("share_url")}, ${optionalColumn("revert")}, ${optionalColumn("permission")},`,
      "summary_additions, summary_deletions, summary_files, summary_diffs,",
      `${optionalColumn("workspace_id")}, ${optionalColumn("path")}, ${optionalColumn("agent")},`,
      `${optionalColumn("model")}, ${optionalColumn("cost")}, ${optionalColumn("tokens_input")},`,
      `${optionalColumn("tokens_output")}, ${optionalColumn("tokens_reasoning")},`,
      `${optionalColumn("tokens_cache_read")}, ${optionalColumn("tokens_cache_write")},`,
      `${optionalColumn("metadata")},`,
      `time_created, time_updated, ${optionalColumn("time_compacting")}, ${optionalColumn("time_archived")}`,
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
    existingParts.push({
      ...parsedPart,
      id: partRow.id,
      messageID: partRow.message_id,
      sessionID: sessionId,
    });
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
  const metadata: Record<string, unknown> = {};
  const usage: Record<string, unknown> = {};

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
  if (row.path !== null) {
    metadata.path = row.path;
  }
  if (row.agent !== null) {
    metadata.agent = row.agent;
  }
  if (row.model !== null) {
    metadata.model = parsePossiblyJson(row.model);
  }
  if (row.workspace_id !== null) {
    metadata.workspace_id = row.workspace_id;
  }
  if (row.share_url !== null) {
    metadata.share_url = row.share_url;
  }
  if (row.revert !== null) {
    metadata.revert = parsePossiblyJson(row.revert);
  }
  if (row.permission !== null) {
    metadata.permission = parsePossiblyJson(row.permission);
  }
  if (row.time_compacting !== null) {
    metadata.time_compacting = row.time_compacting;
  }
  if (row.time_archived !== null) {
    metadata.time_archived = row.time_archived;
  }
  if (row.metadata !== null) {
    metadata.raw = parsePossiblyJson(row.metadata);
  }
  if (row.cost !== null) {
    usage.cost = row.cost;
  }
  for (const [key, value] of [
    ["input", row.tokens_input],
    ["output", row.tokens_output],
    ["reasoning", row.tokens_reasoning],
    ["cache_read", row.tokens_cache_read],
    ["cache_write", row.tokens_cache_write],
  ] as const) {
    if (value !== null) {
      usage[key] = value;
    }
  }
  if (Object.keys(usage).length > 0) {
    metadata.usage = usage;
  }

  return {
    id: row.id,
    ...(row.parent_id !== null ? { parentID: row.parent_id } : {}),
    slug: row.slug,
    projectID: row.project_id,
    directory: row.directory,
    title: row.title,
    version: row.version,
    ...(Object.keys(summary).length > 0 ? { summary } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  };
}

function tableColumns(database: Database, table: string): Set<string> {
  return new Set(
    queryRows<{ name: string }>(database, `PRAGMA table_info(${table})`).map((row) => row.name),
  );
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
