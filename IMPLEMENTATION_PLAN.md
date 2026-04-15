# Implementation Plan

This plan covers the first implementation pass for converting provider session files into the unified shape defined in [UNIFIED_SESSION_SHAPE.md](./UNIFIED_SESSION_SHAPE.md).

## Assumptions

- `data/` is local research input, not stable test fixture material.
- The first implementation goal is deterministic conversion into unified JSON, not a full end-user CLI product.
- We should preserve provider order and source IDs exactly whenever possible.
- We should prefer small, explicit parser logic per provider over generic reflection-heavy code.
- Milestone 1 is file-based only. Direct reads from provider home-directory storage come later as separate adapters.

## End State

We want a codebase that can:

- load a single file-backed session payload from `opencode`, `codex`, `pi`, `claude`, or `factory`
- convert it into the unified session shape
- validate the produced result
- snapshot the converted JSON for regression testing
- run `lint`, `typecheck`, and `test` as strict pre-handoff gates

## Proposed Layout

```text
src/
  core/
    convert-session.ts
    errors.ts
  schema/
    unified-session.ts
    validate-unified-session.ts
  providers/
    shared/
      json.ts
      jsonl.ts
      ids.ts
      timestamps.ts
      blocks.ts
    opencode/
      convert.ts
      types.ts
    codex/
      convert.ts
      types.ts
    pi/
      convert.ts
      types.ts
    claude/
      convert.ts
      types.ts
    factory/
      convert.ts
      types.ts
tests/
  fixtures/
    opencode/
    codex/
    pi/
    claude/
    factory/
  providers/
  schema/
  integration/
```

CLI entrypoints are out of scope for milestone 1. Add them only after the library API is stable behind at least two providers.

## Core Design

### 1. Unified schema module

Create first-class TypeScript types for the unified format:

- `UnifiedSession`
- `UnifiedSessionInfo`
- `UnifiedSessionItem`
- block unions for `text`, `thinking`, `tool_call`, `tool_result`, `compaction`, and the rest

Also create a validator layer:

- structural assertions for required fields
- ID uniqueness checks where required
- compaction-specific checks:
  - `mode = "replacement"` may carry `replacement_items`
  - `mode = "summary"` may carry summary fields
  - `mode = "marker"` must not require summary text

The validator should run in tests and in any CLI export path.

Keep converter-fidelity checks separate from schema validation:

- schema validation checks unified shape correctness
- provider tests check source-order preservation, source-ID preservation, and provider-specific mapping behavior

### 2. Provider converter contract

Use one narrow contract for all providers:

```ts
interface SessionConverter {
  readonly source: "opencode" | "codex" | "pi" | "claude" | "factory";
  parse(input: string): ProviderPayload;
  normalize(payload: ProviderPayload): UnifiedSession;
}
```

Implementation rule:

- provider converters own provider-specific parsing and mapping
- shared code only handles generic helpers, never provider branching
- top-level orchestration calls `parse`, then `normalize`, then schema validation

### 3. Conversion boundaries

Keep the pipeline explicit:

1. read file or exported JSON
2. parse raw source payload
3. normalize into unified session
4. validate unified session
5. serialize or return it

Do not mix parsing, normalization, and validation in the same function.

## Normalization Policies

These are fixed rules for milestone 1. Converters should implement them directly instead of deferring the decision to tests or later refactors.

### OpenCode input scope

- Milestone 1 accepts OpenCode CLI export JSON only.
- It does not read `opencode.db` or legacy `storage/` directly.
- If we later need direct storage support, add separate adapters rather than widening the first converter.

### Codex dual-stream policy

Use `response_item` as the authoritative structured stream.

Rules:

- always emit normalized items for `response_item`
- emit `turn_context`, `session_meta`, and `compacted`
- drop `event_msg.token_count` in milestone 1
- preserve `event_msg.context_compacted` as `meta` or `context`
- treat `event_msg.user_message`, `event_msg.agent_message`, and `event_msg.agent_reasoning` as transport-layer duplicates when an equivalent `response_item` exists
- emit those `event_msg` records only when no equivalent `response_item` exists

Equivalent means:

- same normalized role or kind
- same normalized text content
- timestamp within a deterministic nearby window, such as the same second or within two seconds

This keeps structured output without duplicating transcript content.

### Pi active-branch policy

Treat Pi sessions as a linked conversation graph.

Rules:

- exportable node types in milestone 1 are `message` and `compaction`
- choose the latest exportable node with an `id` as the active leaf
- walk `parentId` links back to root
- emit only nodes on that active branch
- preserve branch order from root to leaf
- if linkage is broken, fall back to source order for exportable nodes and record the break in `session.metadata`

This matches the “current conversation branch” behavior better than flattening the whole persisted tree.

### Non-transcript state policy

For all providers:

- preserve session-defining state that affects interpretation:
  - `session_meta`
  - `turn_context`
  - `session_start`
  - compaction records
- drop pure telemetry that does not affect transcript meaning in milestone 1
- preserve ambiguous but potentially meaningful records as `meta`, not by silently dropping them

## Provider Rollout

Implement one provider at a time in this order:

1. `opencode`
2. `codex`
3. `pi`
4. `claude`
5. `factory`

Reasoning:

- `opencode` is the cleanest target format and establishes block mapping patterns.
- `codex` is the hardest structural outlier and will stress the schema early.
- `pi`, `claude`, and `factory` then become simpler adaptations of the same item/block model.

### Provider-specific mapping concerns

#### OpenCode

- Input is exported JSON, not direct DB access in milestone 1.
- Normalize message `parts[]` into unified `blocks[]`.
- Promote embedded `compaction` parts into standalone `compaction` items during normalization.

#### Codex

- Input is JSONL event stream.
- Preserve event order exactly.
- Use `response_item` as the authoritative structured stream.
- Treat `compacted` as authoritative compaction.
- Preserve `event_msg.context_compacted` as `meta` or `context`, not as the primary compaction record.
- Suppress duplicate `event_msg.user_message`, `event_msg.agent_message`, and `event_msg.agent_reasoning` when an equivalent `response_item` exists nearby in time.
- Keep unmatched `event_msg` transcript events.

#### Pi

- Input is JSONL tree-like log.
- Follow the active branch only: latest exportable leaf back to root by `parentId`.
- Treat top-level `compaction` entries as first-class unified `compaction` items.

#### Claude

- Input is JSONL transcript with non-message records.
- Convert transcript-bearing entries first.
- Preserve optional non-transcript entries as `meta` only if they add stable value.

#### Factory

- Input is JSONL transcript plus state entries.
- Use `session_start` for session metadata.
- Treat `compaction_state` as first-class unified `compaction`.
- Preserve `compactionSummaryId` as `compaction_ref_id`.

## Test Strategy

### Fixture policy

Split fixtures into two classes:

- `tests/fixtures/`: small, stable, checked-in fixtures used by CI
- `data/`: local large real-world samples used for manual verification only

Do not point automated tests at `data/`.

For each provider fixture set, keep:

- `source.*`
- `expected.unified.json`

For compaction-capable providers, include at least one compacted fixture:

- `opencode`
- `codex`
- `pi`
- `factory`

For `claude`, include a normal transcript fixture and document that no explicit compaction fixture exists yet.

### Test layers

#### Schema tests

- valid unified sessions are accepted
- malformed sessions fail with clear messages
- unknown future `item.kind` and `block.type` are tolerated when allowed by schema rules

#### Provider unit tests

Per provider:

- parses valid source fixture
- maps required session fields correctly
- preserves item ordering
- preserves IDs
- maps tool calls/results correctly
- maps compaction correctly where supported
- applies the fixed normalization policy for that provider
- does not emit invalid unified JSON

#### Golden snapshot tests

Per provider fixture:

- convert source fixture
- compare against checked-in `expected.unified.json`

This should be the primary regression mechanism because output shape stability matters more than micro-level implementation details.

#### Integration tests

- library pipeline converts a fixture file end-to-end
- output is valid JSON
- output passes schema validation

## Strict Verification Setup

Add explicit scripts:

```json
{
  "scripts": {
    "lint": "oxlint",
    "fmt-check": "oxfmt --check",
    "typecheck": "tsgo --noEmit",
    "test": "vitest run",
    "check": "pnpm lint && pnpm fmt-check && pnpm typecheck && pnpm test"
  }
}
```

Also add:

- `vitest`
- `@types/node`
- TypeScript config for Node and test typing

Verification gates before each handoff:

- `pnpm lint`
- `pnpm fmt-check`
- `pnpm typecheck`
- `pnpm test`
- targeted manual conversion check against at least one real sample in `data/` for the provider being added
- no golden snapshot updates without intentional review of the semantic diff

## Execution Plan

### Phase 1. Foundation

- create `src/` layout
- define unified TS types
- define validator
- define converter registry
- wire `vitest`
- update `tsconfig.json` for Node and test typing

### Phase 2. First provider

- implement `opencode`
- add fixtures
- add schema tests
- add first library end-to-end path

### Phase 3. Event-stream outlier

- implement `codex`
- add compaction and dual-event coverage
- harden validator and helper utilities as needed

### Phase 4. Remaining providers

- implement `pi`
- implement `claude`
- implement `factory`

Each provider should land as its own logical task with its own fixtures and tests.

### Phase 5. Final hardening

- add cross-provider invariants
- verify all compacted fixtures normalize correctly
- run full `pnpm check`
- run targeted manual conversions against `data/`
- add CLI only if the library surface is stable

## Acceptance Criteria

- every provider has at least one checked-in fixture and one golden unified output
- compaction is explicitly covered for every provider that persists it
- converter output is deterministic
- `pnpm check` passes cleanly
- no tests depend on personal local paths or mutable home-directory data
- Codex duplicate-stream handling is deterministic and covered by tests
- Pi branch-selection behavior is deterministic and covered by tests

## First Task Recommendation

Start with the foundation only:

- create `src/schema/` types
- create validator
- add `vitest`
- add one schema test file
- update `tsconfig.json` and package scripts for strict verification

That gives us a strict base before any provider-specific parsing starts.
