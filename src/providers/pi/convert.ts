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
import { classifyItemKindFromBlocks } from "../shared/classify-item-kind.js";
import { fallbackId } from "../shared/ids.js";
import { parseJsonLines } from "../shared/jsonl.js";
import { normalizeTimestamp } from "../shared/timestamps.js";
import type { PiEntry } from "./types.js";

interface ParsedPiPayload {
  readonly entries: PiEntry[];
  readonly filePath?: string;
}

interface PiBranchSelection {
  readonly branch: PiEntry[];
  readonly linkageBroken: boolean;
}

function normalizePiContent(content: unknown): UnifiedBlock[] {
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
                typeof record.thinkingSignature === "string" ? record.thinkingSignature : null,
                { raw: record },
              ),
            ]
          : [];
      case "toolCall":
        return [
          toolCallBlock({
            call_id: typeof record.id === "string" ? record.id : null,
            tool_name: typeof record.name === "string" ? record.name : null,
            arguments:
              typeof record.arguments === "string" ||
              (typeof record.arguments === "object" &&
                record.arguments !== null &&
                !Array.isArray(record.arguments))
                ? (record.arguments as Record<string, unknown> | string | null)
                : null,
            metadata: { raw: record },
          }),
        ];
      case "image":
        return [
          imageBlock({
            data: typeof record.data === "string" ? record.data : null,
            mime: typeof record.mimeType === "string" ? record.mimeType : null,
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

function entryId(entry: PiEntry): string | null {
  return typeof entry.id === "string" ? entry.id : null;
}

function buildActiveBranch(entries: PiEntry[]): PiBranchSelection {
  const exportableEntries = entries.filter(
    (entry) => exportableEntry(entry) && typeof entry.id === "string",
  );
  const entryById = new Map(
    entries
      .map((entry) => [entryId(entry), entry] as const)
      .filter((pair): pair is readonly [string, PiEntry] => pair[0] !== null),
  );
  const leaf = exportableEntries.at(-1);

  if (leaf === undefined) {
    return { branch: [], linkageBroken: false };
  }

  const branch: PiEntry[] = [];
  let current: PiEntry | undefined = leaf;
  let linkageBroken = false;
  const visited = new Set<string>();

  while (current !== undefined) {
    const currentId = entryId(current);

    if (currentId !== null) {
      if (visited.has(currentId)) {
        linkageBroken = true;
        break;
      }
      visited.add(currentId);
    }

    if (exportableEntry(current)) {
      branch.unshift(current);
    }

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

function resolveExportedParentId(
  entry: PiEntry,
  retainedIds: ReadonlySet<string>,
  allEntriesById: ReadonlyMap<string, PiEntry>,
): string | null | undefined {
  const parentId = entry.parentId;

  if (parentId === undefined || parentId === null) {
    return parentId;
  }

  if (retainedIds.has(parentId)) {
    return parentId;
  }

  let current = allEntriesById.get(parentId);
  const visited = new Set<string>([parentId]);

  while (current !== undefined) {
    const currentId = entryId(current);

    if (currentId !== null && retainedIds.has(currentId)) {
      return currentId;
    }

    const nextParentId = current.parentId;
    if (nextParentId === null) {
      return null;
    }
    if (nextParentId === undefined) {
      return undefined;
    }
    if (visited.has(nextParentId)) {
      break;
    }

    visited.add(nextParentId);
    current = allEntriesById.get(nextParentId);
  }

  return parentId;
}

function itemFromPiEntry(
  entry: PiEntry,
  index: number,
  parentId: string | null | undefined,
): UnifiedSessionItem | null {
  const timestamp = normalizeTimestamp(entry.timestamp);

  if (entry.type === "compaction") {
    return {
      id: entry.id ?? fallbackId("pi-compaction", index),
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "compaction",
      blocks: [
        compactionBlock({
          mode: "summary",
          summary_text: typeof entry.summary === "string" ? entry.summary : null,
          metadata: { raw: entry },
        }),
      ],
      metadata: { raw: entry },
    };
  }

  const message = entry.message ?? {};
  const role = typeof message.role === "string" ? message.role : null;
  const blocks = normalizePiContent(message.content);
  const usage =
    typeof message.usage === "object" && message.usage !== null && !Array.isArray(message.usage)
      ? (message.usage as Record<string, unknown>)
      : null;
  const provider = typeof message.provider === "string" ? message.provider : null;
  const model = typeof message.model === "string" ? message.model : null;

  if (role === "toolResult") {
    const toolResultBlocks: UnifiedBlock[] = [
      toolResultBlock({
        call_id: typeof message.toolCallId === "string" ? message.toolCallId : null,
        tool_name: typeof message.toolName === "string" ? message.toolName : null,
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
      ...(parentId !== undefined ? { parent_id: parentId } : {}),
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

  const classification = classifyItemKindFromBlocks(blocks, role);

  return {
    id: entry.id ?? fallbackId("pi-message", index),
    ...(parentId !== undefined ? { parent_id: parentId } : {}),
    ...(timestamp !== null ? { timestamp } : {}),
    kind: classification.kind,
    ...(classification.role !== null ? { role: classification.role } : {}),
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
    const allEntriesById = new Map(
      payload.entries
        .map((entry) => [entryId(entry), entry] as const)
        .filter((pair): pair is readonly [string, PiEntry] => pair[0] !== null),
    );
    const retainedIds = new Set(
      branch.map((entry) => entryId(entry)).filter((id): id is string => id !== null),
    );
    const items = branch
      .map((entry, index) =>
        itemFromPiEntry(entry, index, resolveExportedParentId(entry, retainedIds, allEntriesById)),
      )
      .filter((item): item is UnifiedSessionItem => item !== null);
    const sessionMetadata = linkageBroken ? { branch_linkage_broken: true } : {};

    return {
      version: UNIFIED_SESSION_VERSION,
      source: "pi",
      ...(typeof header?.version === "number"
        ? { source_schema_version: String(header.version) }
        : {}),
      session: {
        id: typeof header?.id === "string" ? header.id : "pi-session",
        ...(typeof header?.cwd === "string" ? { cwd: header.cwd } : {}),
        ...(normalizeTimestamp(header?.timestamp) !== null
          ? { created_at: normalizeTimestamp(header?.timestamp) }
          : {}),
        ...(typeof header?.version === "number"
          ? { provider_version: String(header.version) }
          : {}),
        metadata: sessionMetadata,
      },
      items,
    };
  },
} as const;
