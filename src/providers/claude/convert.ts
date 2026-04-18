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

type ClaudeToolNameByCallId = ReadonlyMap<string, string>;

const CLAUDE_COMPACTION_PREFIX =
  "This session is being continued from a previous conversation that ran out of context.";

function normalizeClaudeBlocks(
  content: unknown,
  toolNameByCallId: ClaudeToolNameByCallId,
): UnifiedBlock[] {
  if (typeof content === "string") {
    return [textBlock(content)];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap<UnifiedBlock>((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;

    switch (record.type) {
      case "text":
        return typeof record.text === "string" ? [textBlock(record.text, { raw: record })] : [];
      case "thinking":
        return typeof record.thinking === "string"
          ? [
              thinkingBlock(
                record.thinking,
                typeof record.signature === "string" ? record.signature : null,
                { raw: record },
              ),
            ]
          : [];
      case "tool_use":
        return [
          toolCallBlock({
            call_id: typeof record.id === "string" ? record.id : null,
            tool_name: typeof record.name === "string" ? record.name : null,
            arguments:
              typeof record.input === "string" ||
              (typeof record.input === "object" &&
                record.input !== null &&
                !Array.isArray(record.input))
                ? (record.input as Record<string, unknown> | string | null)
                : null,
            metadata: { raw: record },
          }),
        ];
      case "tool_result":
        const callId = typeof record.tool_use_id === "string" ? record.tool_use_id : null;
        return [
          toolResultBlock({
            call_id: callId,
            tool_name: callId !== null ? (toolNameByCallId.get(callId) ?? null) : null,
            is_error: record.is_error === true,
            content: typeof record.content === "string" ? record.content : null,
            metadata: { raw: record },
          }),
        ];
      default:
        return [rawBlock(record)];
    }
  });
}

function normalizeClaudeAttachment(entry: ClaudeEntry): UnifiedBlock[] {
  if (
    typeof entry.attachment !== "object" ||
    entry.attachment === null ||
    Array.isArray(entry.attachment)
  ) {
    return [rawBlock(entry)];
  }

  const attachment = entry.attachment as Record<string, unknown>;

  if (attachment.type === "file") {
    return [
      fileRefBlock({
        path: typeof attachment.filename === "string" ? attachment.filename : null,
        label: typeof attachment.displayPath === "string" ? attachment.displayPath : null,
        metadata: { raw: attachment },
      }),
    ];
  }

  return [rawBlock(attachment)];
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
  const message =
    typeof entry.message === "object" && entry.message !== null && !Array.isArray(entry.message)
      ? (entry.message as Record<string, unknown>)
      : null;
  return (
    entry.uuid ?? (typeof message?.id === "string" ? message.id : null) ?? fallbackId(prefix, index)
  );
}

function claudeParentId(entry: ClaudeEntry): string | null | undefined {
  if (typeof entry.parentUuid === "string") {
    return entry.parentUuid;
  }
  if (typeof entry.logicalParentUuid === "string") {
    return entry.logicalParentUuid;
  }
  return entry.parentUuid;
}

function claudeContent(value: unknown): unknown {
  if (typeof value === "string" || Array.isArray(value)) {
    return value;
  }
  return undefined;
}

function claudeMessageContent(
  entry: ClaudeEntry,
  message: Record<string, unknown> | null,
): unknown {
  return claudeContent(message?.content) ?? claudeContent(entry.content) ?? message ?? entry;
}

function collectClaudeToolNames(entries: ClaudeEntry[]): ClaudeToolNameByCallId {
  const toolNames = new Map<string, string>();

  for (const entry of entries) {
    const message =
      typeof entry.message === "object" && entry.message !== null && !Array.isArray(entry.message)
        ? (entry.message as Record<string, unknown>)
        : null;
    const content = claudeMessageContent(entry, message);

    if (!Array.isArray(content)) {
      continue;
    }

    for (const item of content) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }

      const record = item as Record<string, unknown>;
      if (record.type !== "tool_use") {
        continue;
      }

      const callId = typeof record.id === "string" ? record.id : null;
      const toolName = typeof record.name === "string" ? record.name : null;
      if (callId !== null && toolName !== null) {
        toolNames.set(callId, toolName);
      }
    }
  }

  return toolNames;
}

function itemFromClaudeEntry(
  entry: ClaudeEntry,
  index: number,
  toolNameByCallId: ClaudeToolNameByCallId,
): UnifiedSessionItem {
  const message =
    typeof entry.message === "object" && entry.message !== null && !Array.isArray(entry.message)
      ? (entry.message as Record<string, unknown>)
      : null;
  const timestamp = normalizeTimestamp(entry.timestamp);
  const baseId = claudeItemId(entry, `claude-${entry.type}`, index);
  const parentId = claudeParentId(entry);

  if (entry.type === "attachment") {
    return {
      id: baseId,
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
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
    if (entry.subtype === "compact_boundary") {
      return {
        id: baseId,
        ...(parentId !== undefined ? { parent_id: parentId } : {}),
        ...(timestamp !== null ? { timestamp } : {}),
        kind: "compaction",
        blocks: [
          compactionBlock({
            mode: "marker",
            metadata: { raw: entry },
          }),
          ...(typeof entry.content === "string" ? [textBlock(entry.content, { raw: entry })] : []),
        ],
        metadata: { raw: entry },
      };
    }

    const blocks = normalizeClaudeBlocks(claudeMessageContent(entry, message), toolNameByCallId);
    return {
      id: baseId,
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "context",
      role: "system",
      ...(typeof message?.model === "string" ? { model: message.model } : {}),
      blocks: blocks.length > 0 ? blocks : [rawBlock(message ?? entry)],
      metadata: { raw: entry },
    };
  }

  if (entry.type !== "user" && entry.type !== "assistant") {
    return {
      id: baseId,
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "meta",
      blocks: [rawBlock(entry)],
      metadata: { raw: entry },
    };
  }

  const role =
    typeof message?.role === "string" ? message.role : entry.type === "user" ? "user" : "assistant";
  const stringContent = typeof message?.content === "string" ? message.content : null;

  if (isClaudeCompactionSummary(entry, stringContent)) {
    return {
      id: baseId,
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
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

  if (entry.isMeta === true) {
    const blocks = normalizeClaudeBlocks(message?.content ?? message ?? entry, toolNameByCallId);
    return {
      id: baseId,
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "meta",
      ...(role !== null ? { role } : {}),
      ...(blocks.length > 0 ? { blocks } : { blocks: [rawBlock(message ?? entry)] }),
      metadata: { raw: entry },
    };
  }

  if (isClaudeCommandMetadata(stringContent)) {
    return {
      id: baseId,
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "meta",
      ...(role !== null ? { role } : {}),
      blocks: [textBlock(stringContent ?? "", { raw: entry })],
      metadata: { raw: entry },
    };
  }

  const blocks = normalizeClaudeBlocks(message?.content ?? message ?? entry, toolNameByCallId);
  const classification = classifyItemKindFromBlocks(blocks, role);

  return {
    id: baseId,
    ...(parentId !== undefined ? { parent_id: parentId } : {}),
    ...(timestamp !== null ? { timestamp } : {}),
    kind: classification.kind,
    ...(classification.role !== null ? { role: classification.role } : {}),
    ...(typeof message?.model === "string" ? { model: message.model } : {}),
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
      (entry) => typeof entry.sessionId === "string",
    );
    const firstTimestampedEntry = payload.entries.find(
      (entry) => normalizeTimestamp(entry.timestamp) !== null,
    );
    const sourceSchemaVersion =
      entriesWithSession.find((entry) => typeof entry.version === "string")?.version ?? null;
    const sessionId =
      entriesWithSession.find((entry) => typeof entry.sessionId === "string")?.sessionId ?? null;
    const cwd = entriesWithSession.find((entry) => typeof entry.cwd === "string")?.cwd ?? null;
    const gitBranch =
      entriesWithSession.find((entry) => typeof entry.gitBranch === "string")?.gitBranch ?? null;
    const toolNameByCallId = collectClaudeToolNames(payload.entries);
    const items = payload.entries.map((entry, index) =>
      itemFromClaudeEntry(entry, index, toolNameByCallId),
    );

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
