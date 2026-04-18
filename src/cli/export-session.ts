#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { convertSessionFile } from "../core/convert-session.js";
import { ConversionError } from "../core/errors.js";
import type { UnifiedSession, UnifiedSource } from "../schema/unified-session.js";

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

function resolveDefaultInputFiles(source: UnifiedSource, cwd: string, homeDir: string): string[] {
  const runtimeFiles = defaultRuntimeRoots(source, homeDir).flatMap((root) =>
    listSessionFiles(source, root, isRuntimeSessionFile),
  );

  if (runtimeFiles.length > 0) {
    return runtimeFiles;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const dataRoot = resolve(workspaceRoot, DEFAULT_INPUT_DIR, source);
  const dataFiles = listSessionFiles(source, dataRoot);
  if (dataFiles.length > 0) {
    return dataFiles;
  }

  throw new ConversionError(
    `No default ${source} session files found in runtime locations or ${dataRoot}`,
  );
}

function resolveExplicitInputFiles(
  source: UnifiedSource,
  cwd: string,
  inputPath: string,
): string[] {
  const targetPath = resolve(cwd, inputPath);

  if (!existsSync(targetPath)) {
    throw new ConversionError(`Input path does not exist: ${targetPath}`);
  }

  const targetStat = statSync(targetPath);
  if (targetStat.isFile()) {
    return [targetPath];
  }

  if (!targetStat.isDirectory()) {
    throw new ConversionError(`Input path is neither a file nor a directory: ${targetPath}`);
  }

  const files = listSessionFiles(source, targetPath);
  if (files.length === 0) {
    throw new ConversionError(`No ${source} session files found in: ${targetPath}`);
  }

  return files;
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

export function runExportSessionCli(
  argv: string[],
  environment: CliEnvironment = {
    cwd: process.cwd(),
    homeDir: homedir(),
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
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
    const inputFiles =
      options.inputPath !== undefined
        ? resolveExplicitInputFiles(options.source, environment.cwd, options.inputPath)
        : resolveDefaultInputFiles(options.source, environment.cwd, environment.homeDir);
    const outDir = resolve(
      options.outDir !== undefined ? environment.cwd : workspaceRoot,
      options.outDir ?? `${DEFAULT_OUTPUT_DIR}/${options.source}`,
    );
    const writtenPaths = new Set<string>();
    const successes: ExportResult[] = [];
    const failures: string[] = [];

    for (const inputFile of inputFiles) {
      try {
        const session = convertSessionFile(options.source, inputFile);
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
        const failure = formatFailure(options.source, inputFile, error);
        failures.push(failure);
        environment.stderr.write(`${failure}\n`);

        if (options.failFast) {
          break;
        }
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
  process.exitCode = runExportSessionCli(process.argv.slice(2));
}
