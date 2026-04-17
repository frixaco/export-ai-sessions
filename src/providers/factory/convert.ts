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

function blocksFromFactoryContent(content: unknown): UnifiedBlock[] {
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
            call_id:
              typeof record.id === "string"
                ? record.id
                : typeof record.tool_use_id === "string"
                  ? record.tool_use_id
                  : null,
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
        return [
          toolResultBlock({
            call_id: typeof record.tool_use_id === "string" ? record.tool_use_id : null,
            tool_name: null,
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
          summary_text: typeof entry.summaryText === "string" ? entry.summaryText : null,
          summary_kind: typeof entry.summaryKind === "string" ? entry.summaryKind : null,
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

  const message =
    typeof entry.message === "object" && entry.message !== null && !Array.isArray(entry.message)
      ? (entry.message as Record<string, unknown>)
      : entry;
  const role = typeof message.role === "string" ? message.role : null;
  const blocks = blocksFromFactoryContent(message.content);
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
    ...(typeof message.model === "string" ? { model: message.model } : {}),
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
        id: typeof sessionStart?.id === "string" ? sessionStart.id : "factory-session",
        ...(typeof sessionStart?.parent === "string"
          ? { parent_session_id: sessionStart.parent }
          : {}),
        ...(typeof sessionStart?.title === "string" ? { title: sessionStart.title } : {}),
        ...(typeof sessionStart?.cwd === "string" ? { cwd: sessionStart.cwd } : {}),
        ...(typeof sessionStart?.version === "number"
          ? { provider_version: String(sessionStart.version) }
          : {}),
        metadata: {
          ...(typeof sessionStart?.owner === "string" ? { owner: sessionStart.owner } : {}),
          ...(typeof sessionStart?.sessionTitle === "string"
            ? { session_title: sessionStart.sessionTitle }
            : {}),
        },
      },
      items,
    };
  },
} as const;
