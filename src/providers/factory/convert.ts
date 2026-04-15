import type {
  UnifiedBlock,
  UnifiedSession,
  UnifiedSessionItem,
} from "../../schema/unified-session.js";
import { UNIFIED_SESSION_VERSION } from "../../schema/unified-session.js";
import {
  compactionBlock,
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
import type { FactoryEntry } from "./types.js";

interface ParsedFactoryPayload {
  readonly entries: FactoryEntry[];
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

function blocksFromFactoryContent(content: unknown): UnifiedBlock[] {
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
            call_id: asString(record.id) ?? asString(record.tool_use_id),
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

function itemFromFactoryEntry(entry: FactoryEntry, index: number): UnifiedSessionItem | null {
  const timestamp = normalizeTimestamp(entry.timestamp);

  if (entry.type === "compaction_state") {
    return {
      id: entry.id ?? fallbackId("factory-compaction", index),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "compaction",
      blocks: [
        compactionBlock({
          mode: "summary",
          summary_text: asString(entry.summaryText),
          summary_kind: asString(entry.summaryKind),
          summary_tokens: typeof entry.summaryTokens === "number" ? entry.summaryTokens : null,
          removed_count: typeof entry.removedCount === "number" ? entry.removedCount : null,
          metadata: { raw: entry, systemInfo: entry.systemInfo },
        }),
      ],
      metadata: { raw: entry },
    };
  }

  if (entry.type !== "message") {
    return {
      id: entry.id ?? fallbackId("factory-meta", index),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "meta",
      blocks: [rawBlock(entry)],
      metadata: { raw: entry },
    };
  }

  const role = asString(entry.role);
  const blocks = blocksFromFactoryContent(entry.content);
  const classification = classifyItemKindFromBlocks(blocks, role);

  return {
    id: entry.id ?? fallbackId("factory-message", index),
    ...(entry.parentId !== undefined ? { parent_id: entry.parentId } : {}),
    ...(entry.compactionSummaryId !== undefined
      ? { compaction_ref_id: entry.compactionSummaryId }
      : {}),
    ...(timestamp !== null ? { timestamp } : {}),
    kind: classification.kind,
    ...(classification.role !== null ? { role: classification.role } : {}),
    ...(asString(entry.model) !== null ? { model: asString(entry.model) } : {}),
    blocks: blocks.length > 0 ? blocks : [rawBlock(entry)],
    metadata: { raw: entry },
  };
}

export const factoryConverter = {
  source: "factory",

  parse(input: string, filePath?: string): ParsedFactoryPayload {
    return {
      entries: parseJsonLines(input) as FactoryEntry[],
      ...(filePath !== undefined ? { filePath } : {}),
    };
  },

  normalize(payload: ParsedFactoryPayload): UnifiedSession {
    const sessionStart = payload.entries.find((entry) => entry.type === "session_start");
    const items = payload.entries
      .filter((entry) => entry.type !== "session_start")
      .map((entry, index) => itemFromFactoryEntry(entry, index))
      .filter((item): item is UnifiedSessionItem => item !== null);

    return {
      version: UNIFIED_SESSION_VERSION,
      source: "factory",
      ...(typeof sessionStart?.version === "number"
        ? { source_schema_version: String(sessionStart.version) }
        : {}),
      session: {
        id: asString(sessionStart?.id) ?? "factory-session",
        ...(asString(sessionStart?.parent) !== null
          ? { parent_session_id: asString(sessionStart?.parent) }
          : {}),
        ...(asString(sessionStart?.title) !== null ? { title: asString(sessionStart?.title) } : {}),
        ...(asString(sessionStart?.cwd) !== null ? { cwd: asString(sessionStart?.cwd) } : {}),
        ...(typeof sessionStart?.version === "number"
          ? { provider_version: String(sessionStart.version) }
          : {}),
        metadata: {
          ...(asString(sessionStart?.owner) !== null
            ? { owner: asString(sessionStart?.owner) }
            : {}),
          ...(asString(sessionStart?.sessionTitle) !== null
            ? { session_title: asString(sessionStart?.sessionTitle) }
            : {}),
        },
      },
      items,
    };
  },
} as const;
