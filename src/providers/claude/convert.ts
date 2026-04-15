import type {
  UnifiedBlock,
  UnifiedSession,
  UnifiedSessionItem,
} from "../../schema/unified-session.js";
import { UNIFIED_SESSION_VERSION } from "../../schema/unified-session.js";
import {
  rawBlock,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolResultBlock,
} from "../shared/blocks.js";
import { fallbackId } from "../shared/ids.js";
import { parseJsonLines } from "../shared/jsonl.js";
import { normalizeTimestamp } from "../shared/timestamps.js";
import type { ClaudeEntry } from "./types.js";

interface ParsedClaudePayload {
  readonly entries: ClaudeEntry[];
  readonly filePath?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeClaudeBlocks(content: unknown): UnifiedBlock[] {
  if (typeof content === "string") {
    return [textBlock(content)];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap<UnifiedBlock>((item) => {
    const record = asRecord(item);
    if (record === null) {
      return [];
    }
    switch (record.type) {
      case "text":
        return typeof record.text === "string" ? [textBlock(record.text, { raw: record })] : [];
      case "thinking":
        return typeof record.thinking === "string"
          ? [thinkingBlock(record.thinking, asString(record.signature), { raw: record })]
          : [];
      case "tool_use":
        return [
          toolCallBlock({
            call_id: asString(record.id),
            tool_name: asString(record.name),
            arguments:
              typeof record.input === "string" || asRecord(record.input) !== null
                ? (record.input as Record<string, unknown> | string | null)
                : null,
            metadata: { raw: record },
          }),
        ];
      case "tool_result":
        return [
          toolResultBlock({
            call_id: asString(record.tool_use_id),
            tool_name: null,
            is_error: record.is_error === true,
            content: asString(record.content),
            metadata: { raw: record },
          }),
        ];
      default:
        return [rawBlock(record)];
    }
  });
}

function classifyClaudeItem(entry: ClaudeEntry): UnifiedSessionItem | null {
  if (entry.type !== "user" && entry.type !== "assistant") {
    return null;
  }

  const message = entry.message ?? {};
  const timestamp = normalizeTimestamp(entry.timestamp);
  const blocks = normalizeClaudeBlocks(message.content ?? message);
  const firstBlock = blocks[0];
  const role = asString(message.role) ?? (entry.type === "user" ? "user" : "assistant");

  let kind = "message";
  let normalizedRole: string | null = role;

  if (firstBlock?.type === "thinking") {
    kind = "reasoning";
  } else if (firstBlock?.type === "tool_call") {
    kind = "tool_call";
  } else if (firstBlock?.type === "tool_result") {
    kind = "tool_result";
    normalizedRole = "tool";
  }

  return {
    id: entry.uuid ?? asString(message.id) ?? fallbackId("claude-item", 0),
    ...(entry.parentUuid !== undefined ? { parent_id: entry.parentUuid } : {}),
    ...(timestamp !== null ? { timestamp } : {}),
    kind,
    ...(normalizedRole !== null ? { role: normalizedRole } : {}),
    ...(asString(message.model) !== null ? { model: asString(message.model) } : {}),
    ...(blocks.length > 0 ? { blocks } : { blocks: [rawBlock(message)] }),
    metadata: { raw: entry },
  };
}

export const claudeConverter = {
  source: "claude",

  parse(input: string, filePath?: string): ParsedClaudePayload {
    return {
      entries: parseJsonLines(input) as ClaudeEntry[],
      ...(filePath !== undefined ? { filePath } : {}),
    };
  },

  normalize(payload: ParsedClaudePayload): UnifiedSession {
    const transcriptEntries = payload.entries.filter(
      (entry) => entry.type === "user" || entry.type === "assistant",
    );
    const firstEntry = transcriptEntries[0];
    const items = transcriptEntries
      .map((entry) => classifyClaudeItem(entry))
      .filter((item): item is UnifiedSessionItem => item !== null);

    return {
      version: UNIFIED_SESSION_VERSION,
      source: "claude",
      ...(asString(firstEntry?.version) !== null
        ? { source_schema_version: asString(firstEntry?.version) }
        : {}),
      session: {
        id: asString(firstEntry?.sessionId) ?? "claude-session",
        ...(asString(firstEntry?.cwd) !== null ? { cwd: asString(firstEntry?.cwd) } : {}),
        ...(normalizeTimestamp(firstEntry?.timestamp) !== null
          ? { created_at: normalizeTimestamp(firstEntry?.timestamp) }
          : {}),
        ...(asString(firstEntry?.version) !== null
          ? { provider_version: asString(firstEntry?.version) }
          : {}),
        metadata: {
          ...(payload.filePath !== undefined ? { source_file: payload.filePath } : {}),
          ...(asString(firstEntry?.gitBranch) !== null
            ? { git_branch: asString(firstEntry?.gitBranch) }
            : {}),
        },
      },
      items,
    };
  },
} as const;
