#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
    "Usage: pnpm export-session <source> [options]",
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

function walkFiles(directoryPath: string): string[] {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(directoryPath, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(fullPath);
    }
    return entry.isFile() ? [fullPath] : [];
  });
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

function resolveInputFiles(source: UnifiedSource, cwd: string, inputPath?: string): string[] {
  const targetPath =
    inputPath !== undefined ? resolve(cwd, inputPath) : resolve(cwd, DEFAULT_INPUT_DIR, source);

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

  const files = walkFiles(targetPath).filter((filePath) => isSessionFile(source, filePath));
  if (files.length === 0) {
    throw new ConversionError(`No ${source} session files found in: ${targetPath}`);
  }

  return files.sort((left, right) => left.localeCompare(right));
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
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  let options: CliOptions;

  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const showUsage =
      !(error instanceof ConversionError) ||
      (!message.startsWith("Usage:") && !message.startsWith("Unsupported source:"));
    environment.stderr.write(`${message}\n`);
    if (showUsage) {
      environment.stderr.write(`\n${usage()}\n`);
    }
    return message.startsWith("Usage:") ? 0 : 1;
  }

  try {
    const inputFiles = resolveInputFiles(options.source, environment.cwd, options.inputPath);
    const outDir = resolve(
      environment.cwd,
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
