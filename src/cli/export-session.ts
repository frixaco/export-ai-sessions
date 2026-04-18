#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { convertSessionFile } from "../core/convert-session.js";
import { ConversionError } from "../core/errors.js";
import type { UnifiedSession, UnifiedSource } from "../schema/unified-session.js";
import {
  openOpencodeSqliteStore,
  resolveDefaultOpencodeDbPaths,
  type OpenCodeSqliteStore,
} from "../providers/opencode/sqlite.js";
import { normalizeOpencodeExport } from "../providers/opencode/convert.js";

interface CliOptions {
  readonly source: UnifiedSource;
  readonly inputPath?: string;
  readonly outDir?: string;
  readonly pretty: boolean;
  readonly failFast: boolean;
}

interface CliEnvironment {
  readonly cwd: string;
  readonly homeDir: string;
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

interface ExportResult {
  readonly outputPath: string;
  readonly sessionId: string;
}

interface CliInput {
  readonly kind: "file" | "opencode-session";
  readonly ref: string;
  readonly dbPath?: string;
}

const SUPPORTED_SOURCES = ["opencode", "codex", "pi", "claude", "factory"] as const;

const DEFAULT_INPUT_DIR = "data";
const DEFAULT_OUTPUT_DIR = "exported";

function usage(): string {
  return [
    "Usage: shair <source> [options]",
    "",
    "Sources:",
    `  ${SUPPORTED_SOURCES.join(", ")}`,
    "",
    "Options:",
    "  --input <path>    Convert a specific file or scan a specific directory",
    "  --out-dir <path>  Write unified JSON files into this directory",
    "  --pretty          Pretty-print JSON output",
    "  --fail-fast       Stop on the first conversion error",
    "  --help            Show this help text",
  ].join("\n");
}

function isUnifiedSource(value: string): value is UnifiedSource {
  return SUPPORTED_SOURCES.includes(value as UnifiedSource);
}

function isSessionFile(source: UnifiedSource, filePath: string): boolean {
  if (source === "opencode") {
    return filePath.endsWith(".json");
  }

  if (source === "factory") {
    return filePath.endsWith(".jsonl") && !filePath.endsWith(".settings.json");
  }

  return filePath.endsWith(".jsonl");
}

function isRuntimeSessionFile(source: UnifiedSource, filePath: string): boolean {
  if (!isSessionFile(source, filePath)) {
    return false;
  }

  if (source === "codex") {
    return basename(filePath).startsWith("rollout-");
  }

  return true;
}

function walkFiles(directoryPath: string): string[] {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(directoryPath, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(fullPath);
    }
    return entry.isFile() ? [fullPath] : [];
  });
}

function listSessionFiles(
  source: UnifiedSource,
  directoryPath: string,
  fileMatcher: (source: UnifiedSource, filePath: string) => boolean = isSessionFile,
): string[] {
  if (!existsSync(directoryPath)) {
    return [];
  }

  const directoryStat = statSync(directoryPath);
  if (!directoryStat.isDirectory()) {
    return [];
  }

  return walkFiles(directoryPath)
    .filter((filePath) => fileMatcher(source, filePath))
    .sort((left, right) => left.localeCompare(right));
}

function parseArgs(argv: string[]): CliOptions {
  let source: UnifiedSource | null = null;
  let inputPath: string | undefined;
  let outDir: string | undefined;
  let pretty = false;
  let failFast = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === "--help") {
      throw new ConversionError(usage());
    }

    if (argument === "--pretty") {
      pretty = true;
      continue;
    }

    if (argument === "--fail-fast") {
      failFast = true;
      continue;
    }

    if (argument === "--input" || argument === "--out-dir") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new ConversionError(`Missing value for ${argument}`);
      }

      if (argument === "--input") {
        inputPath = value;
      } else {
        outDir = value;
      }

      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new ConversionError(`Unknown option: ${argument}`);
    }

    if (source === null) {
      if (!isUnifiedSource(argument)) {
        throw new ConversionError(`Unsupported source: ${argument}`);
      }
      source = argument;
      continue;
    }

    throw new ConversionError(`Unexpected argument: ${argument}`);
  }

  if (source === null) {
    throw new ConversionError("Missing required <source> argument");
  }

  return {
    source,
    ...(inputPath !== undefined ? { inputPath } : {}),
    ...(outDir !== undefined ? { outDir } : {}),
    pretty,
    failFast,
  };
}

function resolveWorkspaceRoot(cwd: string): string {
  let currentDirectory = resolve(cwd);

  while (true) {
    if (
      existsSync(resolve(currentDirectory, "package.json")) ||
      existsSync(resolve(currentDirectory, DEFAULT_OUTPUT_DIR)) ||
      existsSync(resolve(currentDirectory, DEFAULT_INPUT_DIR))
    ) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return resolve(cwd);
    }

    currentDirectory = parentDirectory;
  }
}

function defaultRuntimeRoots(source: UnifiedSource, homeDir: string): string[] {
  switch (source) {
    case "claude":
      return [
        join(homeDir, ".claude", "projects"),
        join(homeDir, ".claude-code", "projects"),
        join(homeDir, ".claude-local", "projects"),
      ];
    case "codex":
      return [
        join(homeDir, ".codex", "sessions"),
        join(homeDir, ".codex", "archived_sessions"),
        join(homeDir, ".codex-local", "sessions"),
        join(homeDir, ".codex-local", "archived_sessions"),
      ];
    case "factory":
      return [join(homeDir, ".factory", "sessions")];
    case "pi":
      return [join(homeDir, ".pi", "agent", "sessions")];
    case "opencode":
      return [];
  }
}

function resolveDefaultInputs(source: UnifiedSource, cwd: string, homeDir: string): CliInput[] {
  const runtimeFiles = defaultRuntimeRoots(source, homeDir).flatMap((root) =>
    listSessionFiles(source, root, isRuntimeSessionFile),
  );

  if (runtimeFiles.length > 0) {
    return runtimeFiles.map((filePath) => ({ kind: "file", ref: filePath }));
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const dataRoot = resolve(workspaceRoot, DEFAULT_INPUT_DIR, source);
  const dataFiles = listSessionFiles(source, dataRoot);
  if (dataFiles.length > 0) {
    return dataFiles.map((filePath) => ({ kind: "file", ref: filePath }));
  }

  throw new ConversionError(
    `No default ${source} session files found in runtime locations or ${dataRoot}`,
  );
}

function resolveExplicitInputFiles(
  source: UnifiedSource,
  cwd: string,
  inputPath: string,
): CliInput[] {
  const targetPath = resolve(cwd, inputPath);

  if (!existsSync(targetPath)) {
    throw new ConversionError(`Input path does not exist: ${targetPath}`);
  }

  const targetStat = statSync(targetPath);
  if (targetStat.isFile()) {
    if (source === "opencode" && targetPath.endsWith(".db")) {
      return [{ kind: "opencode-session", ref: "", dbPath: targetPath }];
    }
    return [{ kind: "file", ref: targetPath }];
  }

  if (!targetStat.isDirectory()) {
    throw new ConversionError(`Input path is neither a file nor a directory: ${targetPath}`);
  }

  if (source === "opencode") {
    const installDbPath = resolve(targetPath, "opencode.db");
    if (existsSync(installDbPath) && statSync(installDbPath).isFile()) {
      return [{ kind: "opencode-session", ref: "", dbPath: installDbPath }];
    }
  }

  const files = listSessionFiles(source, targetPath);
  if (files.length === 0) {
    throw new ConversionError(`No ${source} session files found in: ${targetPath}`);
  }

  return files.map((filePath) => ({ kind: "file", ref: filePath }));
}

function writeJson(path: string, value: UnifiedSession, pretty: boolean): void {
  const spacing = pretty ? 2 : undefined;
  writeFileSync(path, `${JSON.stringify(value, null, spacing)}\n`, "utf8");
}

function outputPathForSession(outDir: string, sessionId: string): string {
  return resolve(outDir, `${sessionId}.json`);
}

function formatFailure(source: UnifiedSource, inputPath: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `[${source}] Failed to convert ${inputPath}: ${detail}`;
}

function convertCliInput(
  source: UnifiedSource,
  input: CliInput,
  opencodeStoresByPath: ReadonlyMap<string, OpenCodeSqliteStore>,
): UnifiedSession {
  if (input.kind === "file") {
    return convertSessionFile(source, input.ref);
  }

  if (source !== "opencode" || input.dbPath === undefined) {
    throw new ConversionError(`Unsupported CLI input kind for ${source}: ${input.kind}`);
  }

  const opencodeStore = opencodeStoresByPath.get(input.dbPath);
  if (opencodeStore === undefined) {
    throw new ConversionError(`OpenCode database was not opened for session: ${input.ref}`);
  }

  return normalizeOpencodeExport(
    opencodeStore.loadSessionExport(input.ref),
    `sqlite:${opencodeStore.dbPath}:${input.ref}`,
  );
}

async function openOpencodeStores(
  dbPaths: readonly string[],
): Promise<Map<string, OpenCodeSqliteStore>> {
  const stores = new Map<string, OpenCodeSqliteStore>();

  for (const dbPath of dbPaths) {
    if (!stores.has(dbPath)) {
      stores.set(dbPath, await openOpencodeSqliteStore(dbPath));
    }
  }

  return stores;
}

function listOpencodeSessionInputs(stores: ReadonlyMap<string, OpenCodeSqliteStore>): CliInput[] {
  const inputs: CliInput[] = [];

  for (const [dbPath, store] of stores.entries()) {
    for (const sessionId of store.listSessionIds()) {
      inputs.push({
        kind: "opencode-session",
        ref: sessionId,
        dbPath,
      });
    }
  }

  return inputs;
}

export async function runExportSessionCli(
  argv: string[],
  environment: CliEnvironment = {
    cwd: process.cwd(),
    homeDir: homedir(),
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let options: CliOptions;

  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      environment.stdout.write(`${message}\n`);
      return 0;
    }
    const showUsage =
      !(error instanceof ConversionError) ||
      (!message.startsWith("Usage:") && !message.startsWith("Unsupported source:"));
    environment.stderr.write(`${message}\n`);
    if (showUsage) {
      environment.stderr.write(`\n${usage()}\n`);
    }
    return 1;
  }

  try {
    const workspaceRoot = resolveWorkspaceRoot(environment.cwd);
    let opencodeStoresByPath = new Map<string, OpenCodeSqliteStore>();
    let inputs =
      options.inputPath !== undefined
        ? resolveExplicitInputFiles(options.source, environment.cwd, options.inputPath)
        : options.source === "opencode"
          ? []
          : resolveDefaultInputs(options.source, environment.cwd, environment.homeDir);

    if (options.source === "opencode") {
      const opencodeDbPaths =
        options.inputPath !== undefined
          ? [...new Set(inputs.flatMap((input) => input.dbPath ?? []))]
          : resolveDefaultOpencodeDbPaths(environment.homeDir);

      if (opencodeDbPaths.length > 0) {
        opencodeStoresByPath = await openOpencodeStores(opencodeDbPaths);
        const fileInputs = inputs.filter((input) => input.kind === "file");
        inputs = [...fileInputs, ...listOpencodeSessionInputs(opencodeStoresByPath)];
      }
    }

    const outDir = resolve(
      options.outDir !== undefined ? environment.cwd : workspaceRoot,
      options.outDir ?? `${DEFAULT_OUTPUT_DIR}/${options.source}`,
    );
    const writtenPaths = new Set<string>();
    const successes: ExportResult[] = [];
    const failures: string[] = [];

    try {
      for (const input of inputs) {
        try {
          const session = convertCliInput(options.source, input, opencodeStoresByPath);
          mkdirSync(outDir, { recursive: true });
          const outputPath = outputPathForSession(outDir, session.session.id);

          if (writtenPaths.has(outputPath)) {
            throw new ConversionError(`Duplicate session id in this run: ${session.session.id}`);
          }

          writtenPaths.add(outputPath);
          writeJson(outputPath, session, options.pretty);
          successes.push({
            outputPath,
            sessionId: session.session.id,
          });
        } catch (error) {
          const failure = formatFailure(options.source, input.ref, error);
          failures.push(failure);
          environment.stderr.write(`${failure}\n`);

          if (options.failFast) {
            break;
          }
        }
      }
    } finally {
      for (const store of opencodeStoresByPath.values()) {
        store.close();
      }
    }

    if (failures.length > 0) {
      if (successes.length > 0) {
        environment.stderr.write(
          `Converted ${successes.length} ${options.source} session${successes.length === 1 ? "" : "s"} before failure\n`,
        );
      }
      return 1;
    }

    environment.stdout.write(
      `Exported ${successes.length} ${options.source} session${successes.length === 1 ? "" : "s"} to ${outDir}\n`,
    );

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    environment.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = await runExportSessionCli(process.argv.slice(2));
}
