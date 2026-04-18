import type {
  UnifiedBlock,
  UnifiedSession,
  UnifiedSessionItem,
} from "../../schema/unified-session.js";
import { UNIFIED_SESSION_VERSION } from "../../schema/unified-session.js";
import {
  compactionBlock,
  fileRefBlock,
  patchRefBlock,
  rawBlock,
  stepBlock,
  textBlock,
  toolCallBlock,
  toolResultBlock,
} from "../shared/blocks.js";
import { parseJson } from "../shared/json.js";
import { normalizeTimestamp } from "../shared/timestamps.js";
import type { OpencodeExport, OpencodeMessage } from "./types.js";

interface ParsedOpencodePayload {
  readonly exportData: OpencodeExport;
  readonly filePath?: string;
}

function normalizeRole(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value === "toolResult") {
    return "tool";
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolArgumentValue(value: unknown): Record<string, unknown> | string | null {
  if (typeof value === "string") {
    return value;
  }
  return asRecord(value);
}

function toolContentValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return null;
}

function normalizeOpencodeBlock(
  part: Record<string, unknown>,
  role: string | null,
): UnifiedBlock | null {
  switch (part.type) {
    case "text":
      return typeof part.text === "string" ? textBlock(part.text, { raw: part }) : null;
    case "file":
      return fileRefBlock({
        path:
          typeof part.path === "string"
            ? part.path
            : typeof part.filePath === "string"
              ? part.filePath
              : null,
        url: typeof part.url === "string" ? part.url : null,
        mime:
          typeof part.mime === "string"
            ? part.mime
            : typeof part.mimeType === "string"
              ? part.mimeType
              : null,
        label:
          typeof part.label === "string"
            ? part.label
            : typeof part.text === "string"
              ? part.text
              : null,
        metadata: { raw: part },
      });
    case "patch": {
      const files = Array.isArray(part.files)
        ? part.files.filter((value): value is string => typeof value === "string")
        : [];
      return patchRefBlock(files, typeof part.hash === "string" ? part.hash : null, { raw: part });
    }
    case "tool": {
      const state = asRecord(part.state);
      const toolName =
        typeof part.tool === "string"
          ? part.tool
          : typeof part.name === "string"
            ? part.name
            : typeof state?.tool === "string"
              ? state.tool
              : typeof state?.name === "string"
                ? state.name
                : null;
      const callId =
        typeof part.toolCallID === "string"
          ? part.toolCallID
          : typeof part.callID === "string"
            ? part.callID
            : typeof part.id === "string"
              ? part.id
              : typeof state?.toolCallID === "string"
                ? state.toolCallID
                : typeof state?.callID === "string"
                  ? state.callID
                  : typeof state?.id === "string"
                    ? state.id
                    : null;
      const outputValue =
        "output" in part
          ? part.output
          : "result" in part
            ? part.result
            : state !== null && "output" in state
              ? state.output
              : state !== null && "result" in state
                ? state.result
                : null;
      const hasOutput =
        "output" in part ||
        "result" in part ||
        (state !== null && ("output" in state || "result" in state)) ||
        role === "tool";
      if (hasOutput) {
        return toolResultBlock({
          call_id: callId,
          tool_name: toolName,
          is_error: part.isError === true || state?.isError === true,
          content: toolContentValue(outputValue),
          metadata: { raw: part },
        });
      }
      const argumentsValue =
        toolArgumentValue(part.input) ??
        toolArgumentValue(part.arguments) ??
        toolArgumentValue(state?.input) ??
        toolArgumentValue(state?.arguments);
      return toolCallBlock({
        call_id: callId,
        tool_name: toolName,
        arguments: argumentsValue ?? null,
        metadata: { raw: part },
      });
    }
    case "step-start":
      return stepBlock("step", "start", { raw: part });
    case "step-finish":
      return stepBlock("step", "finish", { raw: part });
    default:
      return rawBlock(part);
  }
}

function messageUsage(info: Record<string, unknown>): Record<string, unknown> | null {
  const usage: Record<string, unknown> = {};
  if (typeof info.cost === "number") {
    usage.cost = info.cost;
  }
  if (typeof info.tokens === "object" && info.tokens !== null) {
    usage.tokens = info.tokens;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function normalizeMessageItems(message: OpencodeMessage, index: number): UnifiedSessionItem[] {
  const info = message.info;
  const messageId = typeof info.id === "string" ? info.id : `opencode-message:${index + 1}`;
  const timestamp = normalizeTimestamp((info.time as { created?: number } | undefined)?.created);
  const role = normalizeRole(info.role);
  const model =
    typeof info.modelID === "string"
      ? info.modelID
      : typeof (info.model as { modelID?: string } | undefined)?.modelID === "string"
        ? (info.model as { modelID?: string }).modelID
        : null;
  const provider =
    typeof info.providerID === "string"
      ? info.providerID
      : typeof (info.model as { providerID?: string } | undefined)?.providerID === "string"
        ? (info.model as { providerID?: string }).providerID
        : null;
  const agent =
    typeof info.agent === "string" ? info.agent : typeof info.mode === "string" ? info.mode : null;
  const parentId = typeof info.parentID === "string" ? info.parentID : null;
  const usage = messageUsage(info);

  const normalBlocks: UnifiedBlock[] = [];
  const compactionItems: UnifiedSessionItem[] = [];
  let compactionCount = 0;

  for (const [partIndex, part] of message.parts.entries()) {
    if (part.type === "compaction") {
      compactionCount += 1;
      compactionItems.push({
        id: `${messageId}:compaction:${partIndex + 1}`,
        parent_id: parentId,
        ...(timestamp !== null ? { timestamp } : {}),
        kind: "compaction",
        ...(role !== null ? { role } : {}),
        ...(model !== null ? { model } : {}),
        ...(provider !== null ? { provider } : {}),
        ...(agent !== null ? { agent } : {}),
        ...(usage !== null ? { usage } : {}),
        blocks: [
          compactionBlock({
            mode: "marker",
            metadata: { raw: part, auto: part.auto },
          }),
        ],
        metadata: { raw: info },
      });
      continue;
    }

    const block = normalizeOpencodeBlock(part, role);
    if (block !== null) {
      normalBlocks.push(block);
    }
  }

  const items: UnifiedSessionItem[] = [];
  if (normalBlocks.length > 0) {
    items.push({
      id: messageId,
      ...(parentId !== null ? { parent_id: parentId } : {}),
      ...(timestamp !== null ? { timestamp } : {}),
      kind: role === "tool" ? "tool_result" : "message",
      ...(role !== null ? { role } : {}),
      ...(model !== null ? { model } : {}),
      ...(provider !== null ? { provider } : {}),
      ...(agent !== null ? { agent } : {}),
      ...(usage !== null ? { usage } : {}),
      blocks: normalBlocks,
      metadata: { raw: info },
    });
  }

  if (normalBlocks.length === 0 && compactionCount > 0) {
    const [firstCompaction, ...restCompactions] = compactionItems;
    if (firstCompaction !== undefined) {
      items.push({
        ...firstCompaction,
        id: messageId,
      });
    }
    items.push(...restCompactions);
    return items;
  }

  items.push(...compactionItems);
  return items;
}

export const opencodeConverter = {
  source: "opencode",

  parse(input: string, filePath?: string): ParsedOpencodePayload {
    return {
      exportData: parseJson(input) as OpencodeExport,
      ...(filePath !== undefined ? { filePath } : {}),
    };
  },

  normalize(payload: ParsedOpencodePayload): UnifiedSession {
    const data = payload.exportData;
    const items = data.messages.flatMap((message, index) => normalizeMessageItems(message, index));

    return {
      version: UNIFIED_SESSION_VERSION,
      source: "opencode",
      ...(data.info.version ? { source_schema_version: data.info.version } : {}),
      session: {
        id: data.info.id,
        ...(data.info.title !== undefined ? { title: data.info.title } : {}),
        ...(data.info.directory !== undefined ? { cwd: data.info.directory } : {}),
        ...(normalizeTimestamp(data.info.time?.created) !== null
          ? { created_at: normalizeTimestamp(data.info.time?.created) }
          : {}),
        ...(normalizeTimestamp(data.info.time?.updated) !== null
          ? { updated_at: normalizeTimestamp(data.info.time?.updated) }
          : {}),
        ...(data.info.version !== undefined ? { provider_version: data.info.version } : {}),
        metadata: {
          ...(data.info.slug !== undefined ? { slug: data.info.slug } : {}),
          ...(data.info.projectID !== undefined ? { project_id: data.info.projectID } : {}),
          ...(data.info.summary !== undefined ? { summary: data.info.summary } : {}),
        },
      },
      items,
    };
  },
} as const;

export function normalizeOpencodeExport(
  exportData: OpencodeExport,
  filePath?: string,
): UnifiedSession {
  return opencodeConverter.normalize({
    exportData,
    ...(filePath !== undefined ? { filePath } : {}),
  });
}
