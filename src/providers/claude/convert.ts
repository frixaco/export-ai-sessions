import type {
  UnifiedBlock,
  UnifiedSession,
  UnifiedSessionItem,
} from "../../schema/unified-session.js";
import { UNIFIED_SESSION_VERSION } from "../../schema/unified-session.js";
import {
  compactionBlock,
  fileRefBlock,
  rawBlock,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolResultBlock,
} from "../shared/blocks.js";
import { classifyItemKindFromBlocks } from "../shared/classify-item-kind.js";
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

function firstString<T>(values: T[], read: (value: T) => string | null): string | null {
  for (const value of values) {
    const result = read(value);
    if (result !== null) {
      return result;
    }
  }
  return null;
}

const CLAUDE_COMPACTION_PREFIX =
  "This session is being continued from a previous conversation that ran out of context.";

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

function normalizeClaudeAttachment(entry: ClaudeEntry): UnifiedBlock[] {
  const attachment = asRecord(entry.attachment);
  if (attachment === null) {
    return [rawBlock(entry)];
  }

  if (attachment.type === "file") {
    return [
      fileRefBlock({
        path: asString(attachment.filename),
        label: asString(attachment.displayPath),
        metadata: { raw: attachment },
      }),
    ];
  }

  return [rawBlock(attachment)];
}

function claudeStringContent(message: Record<string, unknown>): string | null {
  return typeof message.content === "string" ? message.content : null;
}

function isClaudeCompactionSummary(entry: ClaudeEntry, content: string | null): boolean {
  return entry.isCompactSummary === true || content?.startsWith(CLAUDE_COMPACTION_PREFIX) === true;
}

function extractClaudeCompactionSummary(content: string): string {
  const marker = "\n\nSummary:\n";
  const markerIndex = content.indexOf(marker);
  return markerIndex === -1 ? content : content.slice(markerIndex + marker.length);
}

function isClaudeCommandMetadata(content: string | null): boolean {
  return (
    content?.startsWith("<command-name>") === true ||
    content?.startsWith("<local-command-stdout>") === true
  );
}

function claudeItemId(entry: ClaudeEntry, prefix: string, index: number): string {
  const message = asRecord(entry.message);
  return entry.uuid ?? asString(message?.id) ?? fallbackId(prefix, index);
}

function itemFromClaudeEntry(entry: ClaudeEntry, index: number): UnifiedSessionItem {
  const message = asRecord(entry.message);
  const timestamp = normalizeTimestamp(entry.timestamp);
  const baseId = claudeItemId(entry, `claude-${entry.type}`, index);

  if (entry.type === "attachment") {
    return {
      id: baseId,
      ...(entry.parentUuid !== undefined ? { parent_id: entry.parentUuid } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "meta",
      blocks: normalizeClaudeAttachment(entry),
      metadata: { raw: entry },
    };
  }

  if (entry.type === "file-history-snapshot") {
    return {
      id: baseId,
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "meta",
      blocks: [rawBlock(entry)],
      metadata: { raw: entry },
    };
  }

  if (entry.type === "last-prompt" && typeof entry.lastPrompt === "string") {
    return {
      id: baseId,
      kind: "meta",
      blocks: [textBlock(entry.lastPrompt, { raw: entry })],
      metadata: { raw: entry },
    };
  }

  if (entry.type === "permission-mode") {
    return {
      id: baseId,
      kind: "meta",
      blocks: [rawBlock(entry)],
      metadata: { raw: entry },
    };
  }

  if (entry.type === "system") {
    const blocks = normalizeClaudeBlocks(message?.content ?? message ?? entry);
    return {
      id: baseId,
      ...(entry.parentUuid !== undefined ? { parent_id: entry.parentUuid } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "context",
      role: "system",
      ...(asString(message?.model) !== null ? { model: asString(message?.model) } : {}),
      blocks: blocks.length > 0 ? blocks : [rawBlock(message ?? entry)],
      metadata: { raw: entry },
    };
  }

  if (entry.type !== "user" && entry.type !== "assistant") {
    return {
      id: baseId,
      ...(entry.parentUuid !== undefined ? { parent_id: entry.parentUuid } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "meta",
      blocks: [rawBlock(entry)],
      metadata: { raw: entry },
    };
  }

  const role = asString(message?.role) ?? (entry.type === "user" ? "user" : "assistant");
  const stringContent = message !== null ? claudeStringContent(message) : null;

  if (isClaudeCompactionSummary(entry, stringContent)) {
    return {
      id: baseId,
      ...(entry.parentUuid !== undefined ? { parent_id: entry.parentUuid } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "compaction",
      blocks: [
        compactionBlock({
          mode: "summary",
          summary_text:
            stringContent !== null ? extractClaudeCompactionSummary(stringContent) : null,
          metadata: { raw: entry },
        }),
      ],
      metadata: { raw: entry },
    };
  }

  if (isClaudeCommandMetadata(stringContent)) {
    return {
      id: baseId,
      ...(entry.parentUuid !== undefined ? { parent_id: entry.parentUuid } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "meta",
      ...(role !== null ? { role } : {}),
      blocks: [textBlock(stringContent ?? "", { raw: entry })],
      metadata: { raw: entry },
    };
  }

  const blocks = normalizeClaudeBlocks(message?.content ?? message ?? entry);
  const classification = classifyItemKindFromBlocks(blocks, role);

  return {
    id: baseId,
    ...(entry.parentUuid !== undefined ? { parent_id: entry.parentUuid } : {}),
    ...(timestamp !== null ? { timestamp } : {}),
    kind: classification.kind,
    ...(classification.role !== null ? { role: classification.role } : {}),
    ...(asString(message?.model) !== null ? { model: asString(message?.model) } : {}),
    ...(blocks.length > 0 ? { blocks } : { blocks: [rawBlock(message ?? entry)] }),
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
    const entriesWithSession = payload.entries.filter(
      (entry) => asString(entry.sessionId) !== null,
    );
    const firstTimestampedEntry = payload.entries.find(
      (entry) => normalizeTimestamp(entry.timestamp) !== null,
    );
    const sourceSchemaVersion = firstString(entriesWithSession, (entry) => asString(entry.version));
    const sessionId = firstString(entriesWithSession, (entry) => asString(entry.sessionId));
    const cwd = firstString(entriesWithSession, (entry) => asString(entry.cwd));
    const gitBranch = firstString(entriesWithSession, (entry) => asString(entry.gitBranch));
    const items = payload.entries.map((entry, index) => itemFromClaudeEntry(entry, index));

    return {
      version: UNIFIED_SESSION_VERSION,
      source: "claude",
      ...(sourceSchemaVersion !== null ? { source_schema_version: sourceSchemaVersion } : {}),
      session: {
        id: sessionId ?? "claude-session",
        ...(cwd !== null ? { cwd } : {}),
        ...(normalizeTimestamp(firstTimestampedEntry?.timestamp) !== null
          ? { created_at: normalizeTimestamp(firstTimestampedEntry?.timestamp) }
          : {}),
        ...(sourceSchemaVersion !== null ? { provider_version: sourceSchemaVersion } : {}),
        metadata: gitBranch !== null ? { git_branch: gitBranch } : {},
      },
      items,
    };
  },
} as const;
