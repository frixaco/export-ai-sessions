import type {
  CompactionBlock,
  FileRefBlock,
  ImageBlock,
  Metadata,
  PatchRefBlock,
  RawBlock,
  SearchBlock,
  StepBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultBlock,
  UnifiedBlock,
} from "../../schema/unified-session.js";

export function metadata(raw?: Record<string, unknown>): Metadata {
  return raw ?? {};
}

export function textBlock(text: string, raw?: Record<string, unknown>): TextBlock {
  return { type: "text", text, metadata: metadata(raw) };
}

export function thinkingBlock(
  text: string,
  signature?: string | null,
  raw?: Record<string, unknown>,
): ThinkingBlock {
  return {
    type: "thinking",
    text,
    ...(signature !== undefined ? { signature } : {}),
    metadata: metadata(raw),
  };
}

export function imageBlock(options: {
  readonly url?: string | null;
  readonly mime?: string | null;
  readonly alt?: string | null;
  readonly data?: string | null;
  readonly metadata?: Record<string, unknown>;
}): ImageBlock {
  return {
    type: "image",
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.mime !== undefined ? { mime: options.mime } : {}),
    ...(options.alt !== undefined ? { alt: options.alt } : {}),
    ...(options.data !== undefined ? { data: options.data } : {}),
    metadata: metadata(options.metadata),
  };
}

export function fileRefBlock(options: {
  readonly path?: string | null;
  readonly url?: string | null;
  readonly mime?: string | null;
  readonly label?: string | null;
  readonly metadata?: Record<string, unknown>;
}): FileRefBlock {
  return {
    type: "file_ref",
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.mime !== undefined ? { mime: options.mime } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
    metadata: metadata(options.metadata),
  };
}

export function patchRefBlock(
  files: string[],
  hash?: string | null,
  raw?: Record<string, unknown>,
): PatchRefBlock {
  return {
    type: "patch_ref",
    ...(hash !== undefined ? { hash } : {}),
    files,
    metadata: metadata(raw),
  };
}

export function toolCallBlock(options: {
  readonly call_id?: string | null;
  readonly tool_name?: string | null;
  readonly arguments: Record<string, unknown> | string | null;
  readonly metadata?: Record<string, unknown>;
}): ToolCallBlock {
  return {
    type: "tool_call",
    ...(options.call_id !== undefined ? { call_id: options.call_id } : {}),
    ...(options.tool_name !== undefined ? { tool_name: options.tool_name } : {}),
    arguments: options.arguments,
    metadata: metadata(options.metadata),
  };
}

export function toolResultBlock(options: {
  readonly call_id?: string | null;
  readonly tool_name?: string | null;
  readonly is_error: boolean;
  readonly content?: string | null;
  readonly metadata?: Record<string, unknown>;
}): ToolResultBlock {
  return {
    type: "tool_result",
    ...(options.call_id !== undefined ? { call_id: options.call_id } : {}),
    ...(options.tool_name !== undefined ? { tool_name: options.tool_name } : {}),
    is_error: options.is_error,
    ...(options.content !== undefined ? { content: options.content } : {}),
    metadata: metadata(options.metadata),
  };
}

export function searchBlock(options: {
  readonly query?: string | null;
  readonly status?: string | null;
  readonly provider?: string | null;
  readonly metadata?: Record<string, unknown>;
}): SearchBlock {
  return {
    type: "search",
    ...(options.query !== undefined ? { query: options.query } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    metadata: metadata(options.metadata),
  };
}

export function stepBlock(
  name: string,
  status?: "start" | "finish" | "other" | null,
  raw?: Record<string, unknown>,
): StepBlock {
  return {
    type: "step",
    name,
    ...(status !== undefined ? { status } : {}),
    metadata: metadata(raw),
  };
}

export function compactionBlock(options: {
  readonly mode?: "summary" | "replacement" | "marker" | "unknown" | null;
  readonly summary_text?: string | null;
  readonly summary_kind?: string | null;
  readonly summary_tokens?: number | null;
  readonly removed_count?: number | null;
  readonly replacement_items?: unknown[];
  readonly metadata?: Record<string, unknown>;
}): CompactionBlock {
  return {
    type: "compaction",
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.summary_text !== undefined ? { summary_text: options.summary_text } : {}),
    ...(options.summary_kind !== undefined ? { summary_kind: options.summary_kind } : {}),
    ...(options.summary_tokens !== undefined ? { summary_tokens: options.summary_tokens } : {}),
    ...(options.removed_count !== undefined ? { removed_count: options.removed_count } : {}),
    ...(options.replacement_items !== undefined
      ? { replacement_items: options.replacement_items }
      : {}),
    metadata: metadata(options.metadata),
  };
}

export function rawBlock(raw: unknown, extra?: Record<string, unknown>): RawBlock {
  return {
    type: "raw",
    raw,
    metadata: metadata(extra),
  };
}

export function compactBlocks(blocks: Array<UnifiedBlock | null>): UnifiedBlock[] {
  return blocks.filter((block): block is UnifiedBlock => block !== null);
}
