export const UNIFIED_SESSION_VERSION = 1;

export type UnifiedSource = "opencode" | "codex" | "pi" | "claude" | "factory";

export type Metadata = Record<string, unknown>;

export interface UnifiedSession {
  readonly version: number;
  readonly source: UnifiedSource;
  readonly source_schema_version?: string | null;
  readonly session: UnifiedSessionInfo;
  readonly items: UnifiedSessionItem[];
}

export interface UnifiedSessionInfo {
  readonly id: string;
  readonly parent_session_id?: string | null;
  readonly title?: string | null;
  readonly cwd?: string | null;
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
  readonly provider_version?: string | null;
  readonly metadata: Metadata;
}

export interface UnifiedSessionItem {
  readonly id: string;
  readonly parent_id?: string | null;
  readonly compaction_ref_id?: string | null;
  readonly timestamp?: string | null;
  readonly kind: string;
  readonly role?: string | null;
  readonly model?: string | null;
  readonly provider?: string | null;
  readonly agent?: string | null;
  readonly usage?: Metadata | null;
  readonly blocks: UnifiedBlock[];
  readonly metadata: Metadata;
}

export type UnifiedBlock =
  | TextBlock
  | ThinkingBlock
  | CodeBlock
  | ImageBlock
  | FileRefBlock
  | PatchRefBlock
  | ToolCallBlock
  | ToolResultBlock
  | SearchBlock
  | StepBlock
  | CompactionBlock
  | RawBlock;

export interface BaseBlock {
  readonly type: string;
  readonly metadata: Metadata;
}

export interface TextBlock extends BaseBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ThinkingBlock extends BaseBlock {
  readonly type: "thinking";
  readonly text: string;
  readonly signature?: string | null;
}

export interface CodeBlock extends BaseBlock {
  readonly type: "code";
  readonly text: string;
  readonly language?: string | null;
}

export interface ImageBlock extends BaseBlock {
  readonly type: "image";
  readonly url?: string | null;
  readonly mime?: string | null;
  readonly alt?: string | null;
  readonly data?: string | null;
}

export interface FileRefBlock extends BaseBlock {
  readonly type: "file_ref";
  readonly path?: string | null;
  readonly url?: string | null;
  readonly mime?: string | null;
  readonly label?: string | null;
}

export interface PatchRefBlock extends BaseBlock {
  readonly type: "patch_ref";
  readonly hash?: string | null;
  readonly files: string[];
}

export interface ToolCallBlock extends BaseBlock {
  readonly type: "tool_call";
  readonly call_id?: string | null;
  readonly tool_name?: string | null;
  readonly arguments: Record<string, unknown> | string | null;
}

export interface ToolResultBlock extends BaseBlock {
  readonly type: "tool_result";
  readonly call_id?: string | null;
  readonly tool_name?: string | null;
  readonly is_error: boolean;
  readonly content?: string | null;
}

export interface SearchBlock extends BaseBlock {
  readonly type: "search";
  readonly query?: string | null;
  readonly status?: string | null;
  readonly provider?: string | null;
}

export interface StepBlock extends BaseBlock {
  readonly type: "step";
  readonly name: string;
  readonly status?: "start" | "finish" | "other" | null;
}

export interface CompactionBlock extends BaseBlock {
  readonly type: "compaction";
  readonly mode?: "summary" | "replacement" | "marker" | "unknown" | null;
  readonly summary_text?: string | null;
  readonly summary_kind?: string | null;
  readonly summary_tokens?: number | null;
  readonly removed_count?: number | null;
  readonly replacement_items?: unknown[];
}

export interface RawBlock extends BaseBlock {
  readonly type: "raw";
  readonly raw: unknown;
}
