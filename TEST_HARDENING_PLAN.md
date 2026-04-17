# Test Hardening Plan

## Goal

Close the gaps found in the current test suite so checked-in tests:

- reflect real provider data shapes
- catch current and likely parser/converter regressions
- validate the unified schema more rigorously
- avoid fixture drift toward converter bugs

This plan is ordered by defect risk, not convenience.

## Ground Rules

- Use real local session data as the source of truth when designing fixtures.
- Keep checked-in fixtures small, but structurally faithful to real provider payloads.
- Prefer one fixture per behavior cluster over one giant fixture per provider.
- For every bug found in real data, add a regression test before or with the fix.
- Do not hand-edit golden outputs unless there is a strong reason; generate them from the converter and review the diff.

## Priority 0: Fix the Live Factory Blind Spot

### Problem

The checked-in Factory fixture uses a synthetic shape with top-level `role`, `model`, and `content`, while real Factory sessions store those under `message`.

This means:

- the current fixture does not represent the real provider format
- the current fixture can pass while the real converter mis-parses actual sessions

### Work

1. Fix the Factory converter to read the real message envelope shape.
2. Replace the current Factory fixture with a minimal but faithful real-shape fixture:
   - `session_start`
   - `compaction_state`
   - one non-message state entry like `todo_state`
   - one assistant message with mixed `thinking + text`
   - one assistant `tool_use` message
   - one user `tool_result` message
3. Add one regression fixture for a mixed-content real-style Factory message:
   - `message.role = assistant`
   - `message.content = [thinking, tool_use, text]`
   - expected normalized `kind = "message"`
4. Regenerate the Factory golden.

### Acceptance

- converting the checked-in Factory fixture exercises the real `message` nesting
- mixed-content Factory messages no longer collapse to `raw`
- real sample under `data/factory/...` normalizes with meaningful block counts, not mostly `raw`

## Priority 1: Expand Pi Coverage to Match Real Sessions

### Problem

The current Pi fixture covers only:

- one user message
- one assistant mixed message
- one compaction object

It does not cover the dominant real Pi behaviors:

- `role = "toolResult"`
- `image` content blocks
- active-branch traversal beyond a trivial chain
- broken-linkage fallback

### Work

1. Keep the current small happy-path fixture or replace it with a better one that includes:
   - user text
   - assistant mixed `thinking + toolCall + text`
   - `toolResult` message with `toolCallId` and `toolName`
   - `image` block in a tool result or assistant result
   - top-level `compaction`
2. Add a second Pi fixture specifically for active-branch selection:
   - root
   - two branches
   - latest leaf on only one branch
   - expected output includes only the active branch
3. Add a third Pi fixture for broken linkage:
   - dangling `parentId`
   - expected `session.metadata.branch_linkage_broken = true`
   - expected output falls back to source order
4. Add direct assertions, not just goldens, for:
   - `toolResult` => `kind = "tool_result"`, `role = "tool"`
   - image block preserved as `type = "image"`
   - branch selection behavior

### Acceptance

- Pi tests cover both normal and degraded graph traversal
- at least one checked-in Pi fixture contains `toolResult`
- at least one checked-in Pi fixture contains `image`

## Priority 2: Expand Claude Coverage to Match Current Local Format

### Problem

The new Claude fixture improved compaction coverage, but it still misses real persisted Claude events:

- `system` local-command entries
- `system` `compact_boundary`
- richer attachment subtypes
- `tool_result` entries with extra result metadata such as `toolUseResult`

### Work

1. Add a second Claude fixture based on the real local session shape, but trimmed down:
   - `permission-mode`
   - `attachment: hook_non_blocking_error`
   - `attachment: deferred_tools_delta`
   - `attachment: file`
   - `attachment: task_reminder`
   - `system` local-command entry
   - `system` `compact_boundary`
   - compact-summary user prompt with `isCompactSummary: true`
   - post-compaction user prompt
2. Keep the current small Claude fixture for readability if useful, but add explicit tests for:
   - `compact_boundary` => normalized `context` or `meta`, whichever the converter intends
   - compact-summary user entry => `compaction`
   - command wrapper user entries => `meta`
   - mixed assistant blocks => `message`
3. Add one regression test ensuring attachment subtype `file` becomes `file_ref`.
4. Add one regression test ensuring attachment subtype `task_reminder` stays `meta`, not dropped.

### Acceptance

- Claude tests cover both inferred compaction and explicit compaction-adjacent system records
- at least one checked-in Claude fixture includes `compact_boundary`
- attachment handling is tested by subtype, not just by one file attachment

## Priority 3: Expand Codex Coverage Beyond the Minimal Event Mix

### Problem

The current Codex fixture is too small to protect:

- developer-role messages
- `web_search_call`
- more realistic duplicate suppression between `response_item` and `event_msg`
- fallback event preservation when no equivalent `response_item` exists

### Work

1. Add a Codex fixture with:
   - `session_meta`
   - `turn_context`
   - developer-role `response_item.message`
   - user-role `response_item.message`
   - assistant-role `response_item.message`
   - `response_item.reasoning`
   - `response_item.function_call`
   - `response_item.function_call_output`
   - `response_item.web_search_call`
   - `compacted`
   - `event_msg.context_compacted`
2. Add a second Codex fixture specifically for duplicate suppression:
   - one `response_item.message`
   - one equivalent `event_msg.user_message` within the timestamp window
   - one non-equivalent `event_msg.user_message`
   - one equivalent `event_msg.agent_reasoning`
   - expected output suppresses only the true duplicates
3. Add direct assertions for:
   - developer-role preservation
   - search mapping
   - duplicate suppression behavior
   - fallback preservation of non-duplicate `event_msg`

### Acceptance

- Codex tests no longer rely on one golden to validate duplicate suppression
- at least one fixture contains `web_search_call`
- at least one fixture contains developer-role transcript input

## Priority 4: Expand OpenCode Coverage to Real Export Types

### Problem

The current OpenCode fixture misses real export part types that exist in the local exported session:

- `file`
- `patch`
- more than one `tool`
- multiple compaction markers

### Work

1. Replace or extend the OpenCode fixture so it includes:
   - user text message
   - assistant message with `step-start`, `tool`, `file`, `patch`, text, `step-finish`
   - assistant message with `tool` output shape
   - assistant compaction-only message
2. Add direct assertions for:
   - `file` => `file_ref`
   - `patch` => `patch_ref`
   - tool input => `tool_call`
   - tool output => `tool_result`
   - compaction part => standalone `compaction` item

### Acceptance

- OpenCode file and patch handling are both covered by checked-in tests
- at least one fixture distinguishes tool input from tool output

## Priority 5: Strengthen Schema Validation Tests

### Problem

The validator tests are currently very thin. They do not cover many of the structural rules the validator actually enforces.

### Work

Add focused validator tests for:

1. invalid timestamp strings on:
   - `session.created_at`
   - `item.timestamp`
2. missing `session.metadata`
3. missing `item.metadata`
4. invalid `tool_call.arguments` type
5. invalid `tool_result.is_error` type
6. invalid `step.status`
7. invalid `compaction.mode`
8. invalid `replacement_items` for replacement compaction
9. invalid `usage` shape
10. missing required `text` on `text` and `code` blocks
11. unknown future kinds and block types remain allowed

### Acceptance

- validator tests exercise every non-trivial branch in `validate-unified-session.ts`
- each validator failure test asserts a meaningful error message fragment

## Priority 6: Replace Weak Integration Smoke Tests

### Problem

The current integration test only checks:

- `source`
- `items.length > 0`
- `session.id.length > 0`

That adds little value beyond “the converter did not throw.”

### Work

1. Keep one end-to-end smoke test if desired, but narrow its purpose:
   - “converts all fixture files without throwing and validates output”
2. Add a stronger integration test around `convertSessionText`:
   - parse from text input instead of file only
   - assert the returned session is validator-clean
3. Add one negative integration test:
   - invalid source text that parses but fails normalization validation
   - assert `convertSessionText` throws
4. Add one unsupported-input-shape regression per provider only when needed.

### Acceptance

- integration tests verify behavior the golden tests do not already cover
- no integration test is just a weaker duplicate of `provider-fixtures.test.ts`

## Priority 7: Add Real-Sample Audit Coverage Without Polluting CI Fixtures

### Problem

Checked-in fixtures should stay small, but right now nothing in the permanent suite confirms that the real local samples still normalize sanely.

### Work

1. Add a separate opt-in test file or script, excluded from default CI, that converts:
   - `data/opencode/...`
   - `data/codex/...`
   - `data/pi/...`
   - `data/claude/...`
   - `data/factory/...`
2. Assert only stable high-level invariants:
   - non-empty item count
   - expected provider source
   - at least one provider-specific item kind/block type known to exist
3. Document this as a local verification tool, not a CI gate.

### Acceptance

- maintainers can quickly smoke-check converter behavior against real captured sessions
- CI remains deterministic and lightweight

## Suggested Execution Order

1. Fix Factory converter and replace the Factory fixture.
2. Expand Pi fixtures and branch-logic tests.
3. Expand Claude fixtures around system compaction records.
4. Expand Codex duplicate/search coverage.
5. Expand OpenCode fixture part coverage.
6. Strengthen validator tests.
7. Replace weak integration smoke tests.
8. Add opt-in real-sample audit script/test.

## Verification Checklist

After each provider change:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

After the full hardening pass:

- review every golden diff manually
- run the opt-in real-sample audit against `data/`
- confirm no checked-in fixture still uses a shape contradicted by real local provider data

## Deliverables

- corrected provider fixtures
- additional provider-specific regression tests
- stronger schema validator tests
- stronger integration tests
- optional real-sample audit harness

The end state should be:

- a failing provider converter cannot stay green because of synthetic fixture drift
- the suite covers real compaction behavior across providers
- the suite protects the highest-risk normalization branches, not just the happy path
