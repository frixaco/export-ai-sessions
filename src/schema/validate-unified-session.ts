import type {
  CompactionBlock,
  Metadata,
  UnifiedBlock,
  UnifiedSession,
  UnifiedSessionItem,
} from "./unified-session.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertMetadata(value: unknown, path: string): asserts value is Metadata {
  assert(isRecord(value), `${path} must be an object`);
}

function assertNullableString(value: unknown, path: string) {
  assert(
    value === undefined || value === null || typeof value === "string",
    `${path} must be a string, null, or undefined`,
  );
}

function assertTimestamp(value: unknown, path: string) {
  assertNullableString(value, path);
  if (typeof value === "string") {
    assert(!Number.isNaN(Date.parse(value)), `${path} must be a valid ISO-8601 string`);
  }
}

function validateCompactionBlock(block: CompactionBlock, path: string) {
  assert(
    block.mode === undefined ||
      block.mode === null ||
      block.mode === "summary" ||
      block.mode === "replacement" ||
      block.mode === "marker" ||
      block.mode === "unknown",
    `${path}.mode must be a known compaction mode`,
  );
  if (block.mode === "marker") {
    assert(
      block.summary_text === undefined || block.summary_text === null,
      `${path}.summary_text must be empty for marker compaction`,
    );
  }
  if (block.mode === "replacement") {
    assert(
      block.replacement_items === undefined || Array.isArray(block.replacement_items),
      `${path}.replacement_items must be an array for replacement compaction`,
    );
  }
}

function validateBlock(block: unknown, path: string): asserts block is UnifiedBlock {
  assert(isRecord(block), `${path} must be an object`);
  assert(typeof block.type === "string" && block.type.length > 0, `${path}.type is required`);
  assertMetadata(block.metadata, `${path}.metadata`);

  switch (block.type) {
    case "text":
    case "code":
      assert(typeof block.text === "string", `${path}.text is required`);
      break;
    case "thinking":
      assert(typeof block.text === "string", `${path}.text is required`);
      assertNullableString(block.signature, `${path}.signature`);
      break;
    case "image":
      assertNullableString(block.url, `${path}.url`);
      assertNullableString(block.mime, `${path}.mime`);
      assertNullableString(block.alt, `${path}.alt`);
      assertNullableString(block.data, `${path}.data`);
      break;
    case "file_ref":
      assertNullableString(block.path, `${path}.path`);
      assertNullableString(block.url, `${path}.url`);
      assertNullableString(block.mime, `${path}.mime`);
      assertNullableString(block.label, `${path}.label`);
      break;
    case "patch_ref":
      assertNullableString(block.hash, `${path}.hash`);
      assert(Array.isArray(block.files), `${path}.files must be an array`);
      break;
    case "tool_call":
      assertNullableString(block.call_id, `${path}.call_id`);
      assertNullableString(block.tool_name, `${path}.tool_name`);
      assert(
        block.arguments === null ||
          block.arguments === undefined ||
          typeof block.arguments === "string" ||
          isRecord(block.arguments),
        `${path}.arguments must be an object, string, null, or undefined`,
      );
      break;
    case "tool_result":
      assertNullableString(block.call_id, `${path}.call_id`);
      assertNullableString(block.tool_name, `${path}.tool_name`);
      assert(typeof block.is_error === "boolean", `${path}.is_error is required`);
      assertNullableString(block.content, `${path}.content`);
      break;
    case "search":
      assertNullableString(block.query, `${path}.query`);
      assertNullableString(block.status, `${path}.status`);
      assertNullableString(block.provider, `${path}.provider`);
      break;
    case "step":
      assert(typeof block.name === "string", `${path}.name is required`);
      assert(
        block.status === undefined ||
          block.status === null ||
          block.status === "start" ||
          block.status === "finish" ||
          block.status === "other",
        `${path}.status must be a known step status`,
      );
      break;
    case "compaction":
      validateCompactionBlock(block as unknown as CompactionBlock, path);
      break;
    case "raw":
      break;
    default:
      break;
  }
}

function validateItem(item: unknown, path: string): asserts item is UnifiedSessionItem {
  assert(isRecord(item), `${path} must be an object`);
  assert(typeof item.id === "string" && item.id.length > 0, `${path}.id is required`);
  assert(typeof item.kind === "string" && item.kind.length > 0, `${path}.kind is required`);
  assert(Array.isArray(item.blocks), `${path}.blocks must be an array`);
  assertMetadata(item.metadata, `${path}.metadata`);
  assertNullableString(item.parent_id, `${path}.parent_id`);
  assertNullableString(item.compaction_ref_id, `${path}.compaction_ref_id`);
  assertTimestamp(item.timestamp, `${path}.timestamp`);
  assertNullableString(item.role, `${path}.role`);
  assertNullableString(item.model, `${path}.model`);
  assertNullableString(item.provider, `${path}.provider`);
  assertNullableString(item.agent, `${path}.agent`);
  assert(
    item.usage === undefined || item.usage === null || isRecord(item.usage),
    `${path}.usage must be an object, null, or undefined`,
  );

  for (const [index, block] of item.blocks.entries()) {
    validateBlock(block, `${path}.blocks[${index}]`);
  }
}

export function validateUnifiedSession(session: unknown): asserts session is UnifiedSession {
  assert(isRecord(session), "session must be an object");
  assert(typeof session.version === "number", "session.version is required");
  assert(
    typeof session.source === "string" && session.source.length > 0,
    "session.source is required",
  );
  assert(
    session.source_schema_version === undefined ||
      session.source_schema_version === null ||
      typeof session.source_schema_version === "string",
    "session.source_schema_version must be a string, null, or undefined",
  );
  assert(isRecord(session.session), "session.session must be an object");
  assert(Array.isArray(session.items), "session.items must be an array");

  assert(
    typeof session.session.id === "string" && session.session.id.length > 0,
    "session.session.id is required",
  );
  assertMetadata(session.session.metadata, "session.session.metadata");
  assertNullableString(session.session.parent_session_id, "session.session.parent_session_id");
  assertNullableString(session.session.title, "session.session.title");
  assertNullableString(session.session.cwd, "session.session.cwd");
  assertTimestamp(session.session.created_at, "session.session.created_at");
  assertTimestamp(session.session.updated_at, "session.session.updated_at");
  assertNullableString(session.session.provider_version, "session.session.provider_version");

  const itemIds = new Set<string>();
  for (const [index, item] of session.items.entries()) {
    validateItem(item, `session.items[${index}]`);
    assert(!itemIds.has(item.id), `session.items[${index}].id must be unique`);
    itemIds.add(item.id);
  }
}

export function assertUnifiedSession<T>(session: T): T & UnifiedSession {
  validateUnifiedSession(session);
  return session;
}
