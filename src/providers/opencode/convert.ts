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

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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

function normalizeOpencodeBlock(
  part: Record<string, unknown>,
  role: string | null,
): UnifiedBlock | null {
  switch (part.type) {
    case "text":
      return typeof part.text === "string" ? textBlock(part.text, { raw: part }) : null;
    case "file":
      return fileRefBlock({
        path: asString(part.path) ?? asString(part.filePath),
        url: asString(part.url),
        mime: asString(part.mime) ?? asString(part.mimeType),
        label: asString(part.label) ?? asString(part.text),
        metadata: { raw: part },
      });
    case "patch": {
      const files = Array.isArray(part.files)
        ? part.files.filter((value): value is string => typeof value === "string")
        : [];
      return patchRefBlock(files, asString(part.hash), { raw: part });
    }
    case "tool": {
      const toolName = asString(part.tool) ?? asString(part.name);
      const callId = asString(part.toolCallID) ?? asString(part.callID) ?? asString(part.id);
      const hasOutput = "output" in part || "result" in part || role === "tool";
      if (hasOutput) {
        const contentValue =
          typeof part.output === "string"
            ? part.output
            : typeof part.result === "string"
              ? part.result
              : null;
        return toolResultBlock({
          call_id: callId,
          tool_name: toolName,
          is_error: part.isError === true,
          content: contentValue,
          metadata: { raw: part },
        });
      }
      const argumentsValue =
        (typeof part.input === "string"
          ? part.input
          : typeof part.input === "object" && part.input !== null
            ? (part.input as Record<string, unknown>)
            : undefined) ??
        (typeof part.arguments === "string"
          ? part.arguments
          : typeof part.arguments === "object" && part.arguments !== null
            ? (part.arguments as Record<string, unknown>)
            : null);
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
  const messageId = asString(info.id) ?? `opencode-message:${index + 1}`;
  const timestamp = normalizeTimestamp((info.time as { created?: number } | undefined)?.created);
  const role = normalizeRole(info.role);
  const model =
    asString(info.modelID) ?? asString((info.model as { modelID?: string } | undefined)?.modelID);
  const provider =
    asString(info.providerID) ??
    asString((info.model as { providerID?: string } | undefined)?.providerID);
  const agent = asString(info.agent) ?? asString(info.mode);
  const parentId = asString(info.parentID);
  const usage = messageUsage(info);

  const normalBlocks: UnifiedBlock[] = [];
  const compactionItems: UnifiedSessionItem[] = [];

  for (const [partIndex, part] of message.parts.entries()) {
    if (part.type === "compaction") {
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
          ...(payload.filePath !== undefined ? { source_file: payload.filePath } : {}),
        },
      },
      items,
    };
  },
} as const;
