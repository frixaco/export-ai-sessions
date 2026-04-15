import type { UnifiedSession, UnifiedSessionItem } from "../../schema/unified-session.js";
import { UNIFIED_SESSION_VERSION } from "../../schema/unified-session.js";
import {
  compactionBlock,
  rawBlock,
  searchBlock,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolResultBlock,
} from "../shared/blocks.js";
import { fallbackId } from "../shared/ids.js";
import { parseJsonLines } from "../shared/jsonl.js";
import { normalizeTimestamp } from "../shared/timestamps.js";
import type { CodexEntry } from "./types.js";

interface ParsedCodexPayload {
  readonly entries: CodexEntry[];
  readonly filePath?: string;
}

interface CanonicalCandidate {
  readonly kind: string;
  readonly role: string | null;
  readonly text: string;
  readonly timestampMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizedTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((block) => {
      const record = asRecord(block);
      if (record === null) {
        return [];
      }
      const type = asString(record.type);
      if ((type === "input_text" || type === "output_text") && typeof record.text === "string") {
        return [record.text.trim()];
      }
      return [];
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

function reasoningText(summary: unknown): string {
  if (!Array.isArray(summary)) {
    return "";
  }

  return summary
    .flatMap((item) => {
      const record = asRecord(item);
      if (record?.type === "summary_text" && typeof record.text === "string") {
        return [record.text.trim()];
      }
      return [];
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

function timestampMs(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function equivalentToCandidate(
  kind: string,
  role: string | null,
  text: string,
  timestamp: string | undefined,
  candidates: CanonicalCandidate[],
): boolean {
  const currentMs = timestampMs(timestamp);
  return candidates.some((candidate) => {
    if (candidate.kind !== kind || candidate.role !== role || candidate.text !== text) {
      return false;
    }
    if (currentMs === null || candidate.timestampMs === null) {
      return true;
    }
    return Math.abs(candidate.timestampMs - currentMs) <= 2_000;
  });
}

function itemFromResponseItem(
  entry: CodexEntry,
  index: number,
  currentModel: string | null,
): UnifiedSessionItem | null {
  const payload = entry.payload ?? {};
  const baseId =
    asString(payload.id) ?? asString(payload.call_id) ?? fallbackId("codex-response", index);
  const timestamp = normalizeTimestamp(entry.timestamp);
  const metadata = { raw: payload };

  switch (payload.type) {
    case "message": {
      const text = normalizedTextFromContent(payload.content);
      return {
        id: baseId,
        ...(timestamp !== null ? { timestamp } : {}),
        kind: "message",
        ...(asString(payload.role) !== null ? { role: asString(payload.role) } : {}),
        ...(currentModel !== null && asString(payload.role) === "assistant"
          ? { model: currentModel }
          : {}),
        blocks: text.length > 0 ? [textBlock(text, metadata)] : [rawBlock(payload)],
        metadata,
      };
    }
    case "reasoning": {
      const text = reasoningText(payload.summary);
      return {
        id: baseId,
        ...(timestamp !== null ? { timestamp } : {}),
        kind: "reasoning",
        role: "assistant",
        ...(currentModel !== null ? { model: currentModel } : {}),
        blocks: text.length > 0 ? [thinkingBlock(text, null, metadata)] : [rawBlock(payload)],
        metadata,
      };
    }
    case "function_call":
    case "custom_tool_call":
      return {
        id: `${baseId}:call`,
        ...(timestamp !== null ? { timestamp } : {}),
        kind: "tool_call",
        role: "assistant",
        ...(currentModel !== null ? { model: currentModel } : {}),
        blocks: [
          toolCallBlock({
            call_id: asString(payload.call_id),
            tool_name: asString(payload.name),
            arguments:
              (typeof payload.arguments === "string" || asRecord(payload.arguments) !== null
                ? (payload.arguments as Record<string, unknown> | string | null)
                : null) ??
              (typeof payload.input === "string" || asRecord(payload.input) !== null
                ? (payload.input as Record<string, unknown> | string | null)
                : null),
            metadata,
          }),
        ],
        metadata,
      };
    case "function_call_output":
    case "custom_tool_call_output":
      return {
        id: `${baseId}:result`,
        ...(timestamp !== null ? { timestamp } : {}),
        kind: "tool_result",
        role: "tool",
        blocks: [
          toolResultBlock({
            call_id: asString(payload.call_id),
            tool_name: asString(payload.name),
            is_error: payload.is_error === true,
            content:
              typeof payload.output === "string"
                ? payload.output
                : typeof payload.output === "object"
                  ? JSON.stringify(payload.output)
                  : null,
            metadata,
          }),
        ],
        metadata,
      };
    case "web_search_call":
      return {
        id: baseId,
        ...(timestamp !== null ? { timestamp } : {}),
        kind: "search",
        role: "assistant",
        ...(currentModel !== null ? { model: currentModel } : {}),
        blocks: [
          searchBlock({
            query: asString(payload.query) ?? asString(payload.search_query),
            status: asString(payload.status),
            provider: asString(payload.provider),
            metadata,
          }),
        ],
        metadata,
      };
    default:
      return {
        id: baseId,
        ...(timestamp !== null ? { timestamp } : {}),
        kind: "meta",
        blocks: [rawBlock(payload)],
        metadata,
      };
  }
}

function itemFromEventMessage(
  entry: CodexEntry,
  index: number,
  currentModel: string | null,
): UnifiedSessionItem | null {
  const payload = entry.payload ?? {};
  const eventType = asString(payload.type);
  const timestamp = normalizeTimestamp(entry.timestamp);
  const metadata = { raw: payload };

  if (eventType === "context_compacted") {
    return {
      id: fallbackId("codex-context-compacted", index),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "context",
      blocks: [rawBlock(payload)],
      metadata,
    };
  }

  if (eventType === "user_message" && typeof payload.message === "string") {
    return {
      id: fallbackId("codex-event-user", index),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "message",
      role: "user",
      blocks: [textBlock(payload.message, metadata)],
      metadata,
    };
  }

  if (eventType === "agent_message" && typeof payload.message === "string") {
    return {
      id: fallbackId("codex-event-assistant", index),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "message",
      role: "assistant",
      ...(currentModel !== null ? { model: currentModel } : {}),
      blocks: [textBlock(payload.message, metadata)],
      metadata,
    };
  }

  if (eventType === "agent_reasoning" && typeof payload.text === "string") {
    return {
      id: fallbackId("codex-event-reasoning", index),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: "reasoning",
      role: "assistant",
      ...(currentModel !== null ? { model: currentModel } : {}),
      blocks: [thinkingBlock(payload.text, null, metadata)],
      metadata,
    };
  }

  return null;
}

function candidateFromResponse(entry: CodexEntry): CanonicalCandidate | null {
  const payload = entry.payload ?? {};
  switch (payload.type) {
    case "message": {
      const text = normalizedTextFromContent(payload.content);
      return text.length > 0
        ? {
            kind: "message",
            role: asString(payload.role),
            text,
            timestampMs: timestampMs(entry.timestamp),
          }
        : null;
    }
    case "reasoning": {
      const text = reasoningText(payload.summary);
      return text.length > 0
        ? {
            kind: "reasoning",
            role: "assistant",
            text,
            timestampMs: timestampMs(entry.timestamp),
          }
        : null;
    }
    default:
      return null;
  }
}

export const codexConverter = {
  source: "codex",

  parse(input: string, filePath?: string): ParsedCodexPayload {
    return {
      entries: parseJsonLines(input) as CodexEntry[],
      ...(filePath !== undefined ? { filePath } : {}),
    };
  },

  normalize(payload: ParsedCodexPayload): UnifiedSession {
    const sessionMetaEntry = payload.entries.find((entry) => entry.type === "session_meta");
    const sessionMeta = sessionMetaEntry?.payload ?? {};
    const responseCandidates = payload.entries
      .filter((entry) => entry.type === "response_item")
      .map(candidateFromResponse)
      .filter((candidate): candidate is CanonicalCandidate => candidate !== null);

    const items: UnifiedSessionItem[] = [];
    let currentModel: string | null = null;
    let currentCwd: string | null = asString(sessionMeta.cwd);

    for (const [index, entry] of payload.entries.entries()) {
      if (entry.type === "turn_context") {
        currentModel = asString(entry.payload?.model) ?? currentModel;
        currentCwd = asString(entry.payload?.cwd) ?? currentCwd;
        items.push({
          id: fallbackId("codex-turn-context", index),
          ...(normalizeTimestamp(entry.timestamp) !== null
            ? { timestamp: normalizeTimestamp(entry.timestamp) }
            : {}),
          kind: "context",
          blocks: [rawBlock(entry.payload ?? {})],
          metadata: { raw: entry.payload ?? {} },
        });
        continue;
      }

      if (entry.type === "session_meta") {
        items.push({
          id: fallbackId("codex-session-meta", index),
          ...(normalizeTimestamp(entry.timestamp) !== null
            ? { timestamp: normalizeTimestamp(entry.timestamp) }
            : {}),
          kind: "meta",
          blocks: [rawBlock(entry.payload ?? {})],
          metadata: { raw: entry.payload ?? {} },
        });
        continue;
      }

      if (entry.type === "compacted") {
        items.push({
          id: fallbackId("codex-compaction", index),
          ...(normalizeTimestamp(entry.timestamp) !== null
            ? { timestamp: normalizeTimestamp(entry.timestamp) }
            : {}),
          kind: "compaction",
          blocks: [
            compactionBlock({
              mode: "replacement",
              replacement_items: Array.isArray(entry.payload?.replacement_history)
                ? entry.payload?.replacement_history
                : [],
              metadata: { raw: entry.payload ?? {} },
            }),
          ],
          metadata: { raw: entry.payload ?? {} },
        });
        continue;
      }

      if (entry.type === "response_item") {
        const item = itemFromResponseItem(entry, index, currentModel);
        if (item !== null) {
          items.push(item);
        }
        continue;
      }

      if (entry.type === "event_msg") {
        const eventType = asString(entry.payload?.type);
        if (eventType === "token_count") {
          continue;
        }

        if (eventType === "user_message" && typeof entry.payload?.message === "string") {
          const text = entry.payload.message;
          if (equivalentToCandidate("message", "user", text, entry.timestamp, responseCandidates)) {
            continue;
          }
        }

        if (eventType === "agent_message" && typeof entry.payload?.message === "string") {
          const text = entry.payload.message;
          if (
            equivalentToCandidate("message", "assistant", text, entry.timestamp, responseCandidates)
          ) {
            continue;
          }
        }

        if (eventType === "agent_reasoning" && typeof entry.payload?.text === "string") {
          const text = entry.payload.text;
          if (
            equivalentToCandidate(
              "reasoning",
              "assistant",
              text,
              entry.timestamp,
              responseCandidates,
            )
          ) {
            continue;
          }
        }

        const item = itemFromEventMessage(entry, index, currentModel);
        if (item !== null) {
          items.push(item);
        }
      }
    }

    return {
      version: UNIFIED_SESSION_VERSION,
      source: "codex",
      ...(asString(sessionMeta.cli_version) !== null
        ? { source_schema_version: asString(sessionMeta.cli_version) }
        : {}),
      session: {
        id: asString(sessionMeta.id) ?? "codex-session",
        ...(currentCwd !== null ? { cwd: currentCwd } : {}),
        ...(normalizeTimestamp(asString(sessionMeta.timestamp) ?? sessionMetaEntry?.timestamp) !==
        null
          ? {
              created_at: normalizeTimestamp(
                asString(sessionMeta.timestamp) ?? sessionMetaEntry?.timestamp,
              ),
            }
          : {}),
        ...(asString(sessionMeta.cli_version) !== null
          ? { provider_version: asString(sessionMeta.cli_version) }
          : {}),
        metadata: {
          ...(asString(sessionMeta.model_provider) !== null
            ? { model_provider: asString(sessionMeta.model_provider) }
            : {}),
          ...(asString(sessionMeta.originator) !== null
            ? { originator: asString(sessionMeta.originator) }
            : {}),
          ...(payload.filePath !== undefined ? { source_file: payload.filePath } : {}),
        },
      },
      items,
    };
  },
} as const;
