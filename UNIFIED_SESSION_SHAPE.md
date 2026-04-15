# Unified Session Shape

This document defines the recommended JSON shape for the new all-in-one AI session exporter.

## Goals

- Preserve high-fidelity session structure across `opencode`, `codex`, `pi`, `claude`, and `factory`
- Avoid forcing event-log sources into an artificial chat-only model
- Support additive evolution when providers make small schema changes
- Keep provider-specific details without making them part of the required core schema

## Decision

Do not use OpenCode's exported JSON shape as the exact universal target.

Use an OpenCode-inspired, event-first, block-based schema instead:

- top-level session envelope
- ordered `items[]`
- each item has typed `blocks[]`
- provider-specific details live in optional fields and `metadata`

## Why Not Use OpenCode's Exact Shape

OpenCode's `info + messages[].info + parts[]` shape is a strong source format, but it is not the best universal target:

- `codex` is fundamentally an event stream, not a session document with nested message parts
- `pi`, `claude`, and `factory` expose different block taxonomies (`thinking`, `tool_use`, `tool_result`, `image`, etc.)
- `codex` has first-class items like `reasoning`, `function_call`, `function_call_output`, `web_search_call`, and streamed events
- OpenCode part types are provider-specific, not neutral

OpenCode should be treated as a high-quality source format, not as the exact common format.

## Recommended Shape

```json
{
  "version": 1,
  "source": "opencode",
  "source_schema_version": null,
  "session": {
    "id": "ses_123",
    "parent_session_id": null,
    "title": "Typing setChildren conditionally with null",
    "cwd": "/Users/frixa/Documents/letui",
    "created_at": "2026-01-06T22:39:14.596Z",
    "updated_at": "2026-01-07T00:51:31.281Z",
    "provider_version": "1.1.3",
    "metadata": {}
  },
  "items": [
    {
      "id": "msg_1",
      "parent_id": null,
      "timestamp": "2026-01-06T22:39:14.605Z",
      "kind": "message",
      "role": "user",
      "model": null,
      "provider": null,
      "agent": null,
      "usage": null,
      "blocks": [
        {
          "type": "text",
          "text": "How do I make setChildren unavailable if T is null?",
          "metadata": {}
        }
      ],
      "metadata": {}
    }
  ]
}
```

## Top-Level Fields

### `version`

Schema version for the unified format.

- Required
- Integer
- Increment only for breaking changes to the unified schema

### `source`

Which provider produced the session.

- Required
- String
- Expected values initially: `opencode`, `codex`, `pi`, `claude`, `factory`

### `source_schema_version`

Provider-specific version string when available.

- Optional
- String or `null`

### `session`

Session-level metadata.

- Required
- Object

### `items`

Ordered session items.

- Required
- Array
- Preserve source order

## Session Object

```json
{
  "id": "string",
  "parent_session_id": "string|null",
  "title": "string|null",
  "cwd": "string|null",
  "created_at": "ISO-8601|null",
  "updated_at": "ISO-8601|null",
  "provider_version": "string|null",
  "metadata": {}
}
```

### Required session fields

- `id`
- `metadata`

### Optional session fields

- `parent_session_id`
- `title`
- `cwd`
- `created_at`
- `updated_at`
- `provider_version`

## Item Object

Each `item` is a meaningful ordered unit in the session. An item may be a normal message, a tool result, a reasoning event, a web search event, context update, or provider-specific metadata event.

```json
{
  "id": "string",
  "parent_id": "string|null",
  "compaction_ref_id": "string|null",
  "timestamp": "ISO-8601|null",
  "kind": "message|tool_call|tool_result|reasoning|search|context|compaction|meta",
  "role": "user|assistant|developer|system|tool|null",
  "model": "string|null",
  "provider": "string|null",
  "agent": "string|null",
  "usage": {},
  "blocks": [],
  "metadata": {}
}
```

### Required item fields

- `id`
- `kind`
- `blocks`
- `metadata`

### Optional item fields

- `parent_id`
- `compaction_ref_id`
- `timestamp`
- `role`
- `model`
- `provider`
- `agent`
- `usage`

### `kind`

Initial recommended values:

- `message`
- `tool_call`
- `tool_result`
- `reasoning`
- `search`
- `context`
- `compaction`
- `meta`

Consumers must allow unknown future `kind` values.

### `role`

Initial recommended values:

- `user`
- `assistant`
- `developer`
- `system`
- `tool`
- `null`

`role` is optional because some event-like items do not map naturally to a conversational role.

## Block Object

Blocks preserve the internal structure of an item.

```json
{
  "type": "text",
  "metadata": {}
}
```

Every block must have:

- `type`
- `metadata`

All other fields depend on `type`.

## Initial Block Types

### `text`

```json
{
  "type": "text",
  "text": "string",
  "metadata": {}
}
```

### `thinking`

```json
{
  "type": "thinking",
  "text": "string",
  "signature": "string|null",
  "metadata": {}
}
```

### `code`

```json
{
  "type": "code",
  "text": "string",
  "language": "string|null",
  "metadata": {}
}
```

### `image`

```json
{
  "type": "image",
  "url": "string|null",
  "mime": "string|null",
  "alt": "string|null",
  "metadata": {}
}
```

### `file_ref`

```json
{
  "type": "file_ref",
  "path": "string|null",
  "url": "string|null",
  "mime": "string|null",
  "label": "string|null",
  "metadata": {}
}
```

### `patch_ref`

```json
{
  "type": "patch_ref",
  "hash": "string|null",
  "files": [],
  "metadata": {}
}
```

### `tool_call`

```json
{
  "type": "tool_call",
  "call_id": "string|null",
  "tool_name": "string|null",
  "arguments": {},
  "metadata": {}
}
```

### `tool_result`

```json
{
  "type": "tool_result",
  "call_id": "string|null",
  "tool_name": "string|null",
  "is_error": false,
  "content": "string|null",
  "metadata": {}
}
```

### `search`

```json
{
  "type": "search",
  "query": "string|null",
  "status": "string|null",
  "provider": "string|null",
  "metadata": {}
}
```

### `step`

```json
{
  "type": "step",
  "name": "string",
  "status": "start|finish|other|null",
  "metadata": {}
}
```

### `compaction`

```json
{
  "type": "compaction",
  "mode": "summary|replacement|marker|unknown|null",
  "summary_text": "string|null",
  "summary_kind": "string|null",
  "summary_tokens": "number|null",
  "removed_count": "number|null",
  "replacement_items": [],
  "metadata": {}
}
```

Use this for persisted compaction records and deterministic continuation-summary records that semantically replace earlier context.

Guidance:

- `mode = "replacement"` when the provider stores replaced prior content
- `mode = "summary"` when the provider stores only a summary of removed context
- `mode = "marker"` when the provider stores only a light compaction marker
- `mode = "summary"` also fits providers that persist compaction indirectly as a synthetic continuation-summary prompt rather than a dedicated compaction event
- `replacement_items` is mainly for providers like Codex that retain compacted prior content inline
- provider-specific fields with no good common slot should remain in `metadata`

## Compatibility Rules

This schema is intentionally additive and permissive.

### Rules

- Unknown top-level fields may be preserved by producers and ignored by consumers
- Unknown `item.kind` values must not break consumers
- Unknown `block.type` values must not break consumers
- Providers may add optional fields inside `session`, `item`, `block`, or `metadata`
- Consumers should only require the stable core:
  - `version`
  - `source`
  - `session.id`
  - ordered `items[]`
  - `item.kind`
  - `blocks[]`

### Design guidance

- Prefer optional fields over required fields
- Prefer additive new block types over changing existing block semantics
- Preserve source-specific details in `metadata` when there is no good common field
- Do not reject an item only because one block type is unknown

## Mapping Guidance By Provider

### OpenCode

Map:

- exported top-level `info` -> `session`
- exported `messages[]` -> `items[]`
- each message `parts[]` -> `blocks[]`

Suggested mappings:

- OpenCode `text` -> `text`
- OpenCode `file` -> `file_ref`
- OpenCode `patch` -> `patch_ref`
- OpenCode `tool` -> `tool_call` or `tool_result` depending on state and payload
- OpenCode `step-start` / `step-finish` -> `step`
- OpenCode `compaction` -> `compaction` item with `mode = "marker"`

Notes:

- OpenCode export currently persists compaction as a light message part marker
- preserve fields like `auto` in `block.metadata`
- when possible, normalize embedded compaction parts into standalone `item.kind = "compaction"` records for consistency

### Codex

Map event log entries directly to `items[]`.

Suggested mappings:

- `response_item.message` -> `message`
- `response_item.reasoning` -> `reasoning`
- `response_item.function_call` / `custom_tool_call` -> `tool_call`
- `response_item.function_call_output` / `custom_tool_call_output` -> `tool_result`
- `response_item.web_search_call` -> `search`
- `event_msg.user_message` -> `message`
- `event_msg.agent_message` -> `message`
- `event_msg.agent_reasoning` -> `reasoning`
- `turn_context` -> `context`
- `compacted` -> `compaction`
- `session_meta` -> `meta` or merge into `session`
- `event_msg.context_compacted` -> `meta` or `context`

Do not force Codex into a nested `messages[].parts[]` model before normalization.

Compaction guidance:

- treat `type = "compacted"` as the authoritative compaction record
- map `payload.replacement_history` into a `compaction` block with `mode = "replacement"`
- preserve `event_msg.context_compacted` for event-log fidelity, but do not treat it as the main compaction payload

### Pi

Map each top-level `message` line to one `item`.

Suggested mappings:

- `text` -> `text`
- `thinking` -> `thinking`
- `toolCall` -> `tool_call`
- `toolResult` role or tool-result block -> `tool_result`
- `image` -> `image`
- top-level `compaction` -> `compaction`

Compaction guidance:

- Pi persists compaction as a dedicated top-level object
- map its `summary` field to a `compaction` block with `mode = "summary"` and `summary_text`

### Claude

Map Claude's ordered event stream directly to `items[]`.

Suggested mappings:

- `text` -> `text`
- `thinking` -> `thinking`
- `tool_use` -> `tool_call`
- `tool_result` -> `tool_result`
- `system` -> `context`
- `permission-mode` -> `meta`
- `attachment` -> `meta`
- `file-history-snapshot` -> `meta`
- `last-prompt` -> `meta`

For Claude entries that mix multiple block types in one message, classify by block composition:

- all `thinking` -> `reasoning`
- all `tool_call` -> `tool_call`
- all `tool_result` -> `tool_result`
- mixed blocks -> `message`

Compaction guidance:

- Claude may persist compaction indirectly rather than as a dedicated top-level compaction event
- preserve `/compact` command wrappers and local command stdout as `meta`
- when Claude writes a synthetic continuation-summary user entry, normalize it to `item.kind = "compaction"`
- map that synthetic summary entry to a `compaction` block with `mode = "summary"` and `summary_text`
- preserve the original Claude payload in `metadata.raw`
- if Claude later adds an explicit compaction event, map that to `item.kind = "compaction"` too

### Factory

Map each `message` entry to one `item`.

Suggested mappings:

- `text` -> `text`
- `thinking` -> `thinking`
- `tool_use` -> `tool_call`
- `tool_result` -> `tool_result`

Use `session_start` to populate `session`. Preserve extra state like `todo_state` in `metadata` or emit `meta` items if desired.

Compaction guidance:

- Droid / Factory may persist compaction as `type = "compaction_state"`
- map `compaction_state` to `item.kind = "compaction"`
- use:
  - `summaryText` -> `summary_text`
  - `summaryKind` -> `summary_kind`
  - `summaryTokens` -> `summary_tokens`
  - `removedCount` -> `removed_count`
- preserve provider-specific fields like `systemInfo` in `metadata`
- when later messages include `compactionSummaryId`, map that to `item.compaction_ref_id`

## Implementation Notes

- Preserve source order exactly
- Preserve source IDs when available
- Preserve parent-child relationships when available
- Prefer standalone `item.kind = "compaction"` records over burying compaction inside unrelated items
- Keep runtime conversion context such as the input file path outside the unified session payload
- When a provider message mixes block types, do not classify by the first block alone
- Preserve original provider payloads in `metadata.raw` only if needed for debugging or diffing
- Keep normalization deterministic

## Non-Goals

- This schema is not optimized for training format output
- This schema is not a byte-for-byte archival format
- This schema does not try to erase all provider differences

It is the high-fidelity interchange format between raw provider exports and downstream exporters.
