import type {
  UnifiedBlock,
  UnifiedSession,
  UnifiedSessionItem,
} from "../../schema/unified-session.js";
import { UNIFIED_SESSION_VERSION } from "../../schema/unified-session.js";
import {
  compactionBlock,
  imageBlock,
  rawBlock,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolResultBlock,
} from "../shared/blocks.js";
import { fallbackId } from "../shared/ids.js";
import { parseJsonLines } from "../shared/jsonl.js";
import { normalizeTimestamp } from "../shared/timestamps.js";
import type { PiEntry } from "./types.js";

interface ParsedPiPayload {
  readonly entries: PiEntry[];
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

function normalizePiContent(content: unknown): UnifiedBlock[] {
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
          ? [thinkingBlock(record.thinking, asString(record.thinkingSignature), { raw: record })]
          : [];
      case "toolCall":
        return [
          toolCallBlock({
            call_id: asString(record.id),
            tool_name: asString(record.name),
            arguments:
              typeof record.arguments === "string" || asRecord(record.arguments) !== null
                ? (record.arguments as Record<string, unknown> | string | null)
                : null,
            metadata: { raw: record },
          }),
        ];
      case "image":
        return [
          imageBlock({
            data: asString(record.data),
            mime: asString(record.mimeType),
            metadata: { raw: record },
          }),
        ];
      default:
        return [rawBlock(record)];
    }
  });
}

function exportableEntry(entry: PiEntry): boolean {
  return entry.type === "message" || entry.type === "compaction";
}

function buildActiveBranch(entries: PiEntry[]): {
  readonly branch: PiEntry[];
  readonly linkageBroken: boolean;
} {
  const exportableEntries = entries.filter(
    (entry) => exportableEntry(entry) && typeof entry.id === "string",
  );
  const entryById = new Map(exportableEntries.map((entry) => [entry.id as string, entry]));
  const leaf = exportableEntries.at(-1);

  if (leaf === undefined) {
    return { branch: [], linkageBroken: false };
  }

  const branch: PiEntry[] = [];
  let current: PiEntry | undefined = leaf;
  let linkageBroken = false;

  while (current !== undefined) {
    branch.unshift(current);
    if (current.parentId === null || current.parentId === undefined) {
      break;
    }
    current = entryById.get(current.parentId);
    if (current === undefined) {
      linkageBroken = true;
      break;
    }
  }

  if (linkageBroken) {
    return {
      branch: entries.filter((entry) => exportableEntry(entry)),
      linkageBroken: true,
    };
  }

  return { branch, linkageBroken };
}

function itemFromPiEntry(entry: PiEntry, index: number): UnifiedSessionItem | null {
  const timestamp = normalizeTimestamp(entry.timestamp);

  if (entry.type === "compaction") {
    return {
      id: entry.id ?? fallbackId("pi-compaction", index),
      ...(entry.parentId !== undefined ? { parent_id: entry.parentId } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "compaction",
      blocks: [
        compactionBlock({
          mode: "summary",
          summary_text: asString(entry.summary),
          metadata: { raw: entry },
        }),
      ],
      metadata: { raw: entry },
    };
  }

  const message = entry.message ?? {};
  const role = asString(message.role);
  const blocks = normalizePiContent(message.content);
  const usage = asRecord(message.usage);
  const provider = asString(message.provider);
  const model = asString(message.model);

  if (role === "toolResult") {
    const toolResultBlocks: UnifiedBlock[] = [
      toolResultBlock({
        call_id: asString(message.toolCallId),
        tool_name: asString(message.toolName),
        is_error: message.isError === true,
        content:
          blocks
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n") || null,
        metadata: { raw: message },
      }),
      ...blocks,
    ];

    return {
      id: entry.id ?? fallbackId("pi-tool-result", index),
      ...(entry.parentId !== undefined ? { parent_id: entry.parentId } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "tool_result",
      role: "tool",
      ...(model !== null ? { model } : {}),
      ...(provider !== null ? { provider } : {}),
      ...(usage !== null ? { usage } : {}),
      blocks: toolResultBlocks,
      metadata: { raw: message },
    };
  }

  return {
    id: entry.id ?? fallbackId("pi-message", index),
    ...(entry.parentId !== undefined ? { parent_id: entry.parentId } : {}),
    ...(timestamp !== null ? { timestamp } : {}),
    kind: "message",
    ...(role !== null ? { role } : {}),
    ...(model !== null ? { model } : {}),
    ...(provider !== null ? { provider } : {}),
    ...(usage !== null ? { usage } : {}),
    blocks: blocks.length > 0 ? blocks : [rawBlock(message)],
    metadata: { raw: message },
  };
}

export const piConverter = {
  source: "pi",

  parse(input: string, filePath?: string): ParsedPiPayload {
    return {
      entries: parseJsonLines(input) as PiEntry[],
      ...(filePath !== undefined ? { filePath } : {}),
    };
  },

  normalize(payload: ParsedPiPayload): UnifiedSession {
    const header = payload.entries.find((entry) => entry.type === "session");
    const { branch, linkageBroken } = buildActiveBranch(payload.entries);
    const items = branch
      .map((entry, index) => itemFromPiEntry(entry, index))
      .filter((item): item is UnifiedSessionItem => item !== null);

    return {
      version: UNIFIED_SESSION_VERSION,
      source: "pi",
      ...(typeof header?.version === "number"
        ? { source_schema_version: String(header.version) }
        : {}),
      session: {
        id: asString(header?.id) ?? "pi-session",
        ...(asString(header?.cwd) !== null ? { cwd: asString(header?.cwd) } : {}),
        ...(normalizeTimestamp(header?.timestamp) !== null
          ? { created_at: normalizeTimestamp(header?.timestamp) }
          : {}),
        ...(typeof header?.version === "number"
          ? { provider_version: String(header.version) }
          : {}),
        metadata: {
          ...(payload.filePath !== undefined ? { source_file: payload.filePath } : {}),
          ...(linkageBroken ? { branch_linkage_broken: true } : {}),
        },
      },
      items,
    };
  },
} as const;
