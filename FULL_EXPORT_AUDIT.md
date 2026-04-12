# Full Export Audit

## Goal

Verify whether `pi-brain` preserves the full session transcript for:

- `claude`
- `codex`
- `factory`
- `pi`

This audit treats the on-disk provider session data as the source of truth.

## Assumptions

- "Full export" means preserving every transcript-bearing unit in a session:
  - user messages
  - assistant messages
  - system / developer messages when present
  - tool calls
  - tool results
  - reasoning / thinking summaries if they exist as readable stored text
- Non-transcript telemetry can be skipped:
  - token counts
  - rate limits
  - cache stats
  - progress-only envelopes
  - encrypted blobs with no readable text
- Source data must not be modified by `pi-brain`.

## Important Caveat

`pi-brain`'s standalone CLI currently always runs:

1. privacy redaction
2. anonymization

That means the default `sessions.jsonl` export is **not** a byte-faithful raw archive, even if the source plugin is otherwise correct.

For this audit, I am testing two layers separately:

1. raw provider session -> canonical session produced by the source plugin
2. canonical session -> exported `sessions.jsonl`

If layer 1 is incomplete, the export is incomplete.
If layer 2 mutates content, the export is not raw/full.

## Method

1. Enumerate real session files for each provider.
2. Build independent raw readers from first principles for each provider format.
3. Count transcript-bearing units directly from raw data.
4. Load the same sessions through `pi-brain`.
5. Compare:
   - session counts
   - message counts
   - tool call counts
   - tool result counts
   - readable reasoning/thinking counts
   - ordering on representative long sessions
6. Run export into isolated temp dirs and verify source trees remain unchanged.

## Progress Log

- 2026-04-11: Audit started.
- 2026-04-11: Confirmed export artifact under audit is `sessions.jsonl`.
- 2026-04-11: Confirmed CLI export mutates content via redaction + anonymization by default.
- 2026-04-11: Mapping raw on-disk formats for Claude, Codex, Factory, and Pi before writing verifier logic.
- 2026-04-11: Added `scripts/full-export-audit.ts` to compare raw provider sessions against `pi-brain` canonical output and a real `pi-brain export` run.
- 2026-04-11: Fixed the audit harness after discovering Pi stores most tool results as top-level `message.role = "toolResult"`, not embedded user blocks.
- 2026-04-11: Completed full-corpus passes for Claude, Codex, Factory, and Pi.
- 2026-04-11: Verification after adding audit artifacts passed:
  - `npm run check`
  - `npm run typecheck`
  - `npm test`

## Findings

### Overall

Current conclusion: `pi-brain` does **not** yet produce a full transcript export for these four providers.

The dominant missing content is readable assistant reasoning / thinking:

- Claude: readable `thinking` blocks are dropped
- Codex: readable reasoning summaries are dropped
- Factory: readable `thinking` blocks are dropped
- Pi: readable `thinking` blocks are dropped

Separately, the standalone CLI cannot currently be called a raw/full archive export because it always redacts and anonymizes content.

### CLI Export Is Not Raw / Full

This was verified directly with a real `pi-brain export pi` run.

Observed in exported `sessions.jsonl`:

- real session IDs are replaced
- project paths are replaced with `<project>`
- filesystem paths inside message content are replaced with `<PATH_N>`
- timestamps are fuzzed

Example proof from exported Pi bundle:

- real session id `6531bd9e-c2c4-4b47-821a-732c0b4f4c79` does not appear in the exported file
- exported session ids look like `56e1461c547fb060`
- exported tool output contains placeholders like `<PATH_1>`

So even with a perfect source plugin, the default CLI export is a sanitized/anonymized dataset export, not a full raw archive.

### Claude

Full-corpus result:

- source files: `19`
- exportable raw sessions: `19`
- plugin-loaded sessions: `19`
- raw transcript-bearing units: `138`
- plugin/export units: `103`
- mismatched sessions: `18 / 19`

Counts:

- raw tool calls: `27`
- plugin tool calls: `27`
- raw tool results: `25`
- plugin tool results: `25`
- raw readable reasoning/thinking: `35`
- plugin readable reasoning/thinking: `0`

Observed raw Claude block types:

- `assistant:thinking = 35`
- `assistant:text = 27`
- `assistant:tool_use = 27`
- `user:tool_result = 25`
- `user:text = 4`

Representative long-session check:

- session: `1d3ec339-a4f0-4566-b23c-2747e88aa8e7`
- raw units: `30`
- plugin units: `23`
- missing units: `7`
- first missing unit is a stored Claude `thinking` block

Conclusion:

- Claude tool calls/results are preserved
- Claude readable thinking is not preserved

### Codex

Full-corpus result:

- source files: `424`
- exportable raw sessions: `424`
- plugin-loaded sessions: `424`
- raw transcript-bearing units: `53,377`
- plugin/export units: `47,242`
- mismatched sessions: `201 / 424`

Counts:

- raw tool calls: `18,214`
- plugin tool calls: `18,214`
- raw tool results: `18,193`
- plugin tool results: `18,193`
- raw system/developer messages: `825`
- plugin system/developer messages: `825`
- raw readable reasoning summaries: `6,135`
- plugin readable reasoning summaries: `0`

Representative long-session checks:

- session: `019c7c09-0e6e-7001-9eef-cce24818dcfd`
  - raw units: `1,184`
  - plugin units: `922`
  - missing units: `262`
- session: `019c7bca-0799-77f0-a0b8-cee0d02e52f6`
  - raw units: `1,177`
  - plugin units: `907`
  - missing units: `270`
- session: `019c7a3a-94be-7db1-a8c4-91cb6eaa607d`
  - raw units: `1,128`
  - plugin units: `881`
  - missing units: `247`

Observed raw Codex item types include:

- `response_item:message`
- `response_item:function_call`
- `response_item:function_call_output`
- `response_item:custom_tool_call`
- `response_item:custom_tool_call_output`
- `response_item:reasoning`
- `event_msg:agent_reasoning`

Conclusion:

- Codex tool calls/results and system/developer messages are preserved
- duplicate streamed/finalized turns are no longer the dominant problem
- readable reasoning summaries are still not preserved

Safety note:

- the only source-tree change observed during Codex export was the current active rollout log:
  - `~/.codex/sessions/2026/04/11/rollout-2026-04-11T16-34-35-019d7c52-84c8-76a2-bc37-e4830887aca9.jsonl`
- this is attributable to the live Codex session itself, so Codex source immutability cannot be proven as cleanly as the other providers while this session is active

### Factory

Full-corpus result:

- source files: `6`
- exportable raw sessions: `2`
- plugin-loaded sessions: `2`
- raw transcript-bearing units: `335`
- plugin/export units: `274`
- mismatched sessions: `2 / 2`

Counts:

- raw tool calls: `125`
- plugin tool calls: `125`
- raw tool results: `125`
- plugin tool results: `125`
- raw readable reasoning/thinking: `61`
- plugin readable reasoning/thinking: `0`

Representative long-session check:

- session: `5d6c61b3-5b11-4a46-b33b-d9a9cc41317d`
- raw units: `255`
- plugin units: `211`
- missing units: `44`

Conclusion:

- empty Factory stubs are correctly excluded now
- Factory tool calls/results are preserved
- Factory readable thinking is not preserved

### Pi

Full-corpus result:

- source files: `147`
- exportable raw sessions: `147`
- plugin-loaded sessions: `147`
- raw transcript-bearing units: `8,281`
- plugin/export units: `6,965`
- mismatched sessions: `88 / 147`

Counts:

- raw tool calls: `2,727`
- plugin tool calls: `2,727`
- raw tool results: `2,725`
- plugin tool results: `2,725`
- raw readable reasoning/thinking: `1,316`
- plugin readable reasoning/thinking: `0`

Representative long-session checks:

- session: `eb7dc27d-561e-438e-bdbb-8a9a67360133`
  - raw units: `514`
  - plugin units: `441`
  - missing units: `73`
- session: `ef0d847e-4e84-428d-a6f4-7cef39997cd3`
  - raw units: `441`
  - plugin units: `373`
  - missing units: `68`
- session: `241d6b05-792d-4a91-a0aa-7e7099c68a19`
  - raw units: `368`
  - plugin units: `314`
  - missing units: `54`

Conclusion:

- Pi session coverage is correct, including older id-less sessions
- Pi tool calls/results are preserved
- Pi readable thinking is not preserved

### Source Safety

Observed during real export runs:

- Claude source files: unchanged
- Factory source files: unchanged
- Pi source files: unchanged
- Codex source files: one changed live rollout log, attributable to the currently active Codex session

No evidence found that `pi-brain` writes back into Claude, Factory, or Pi source session files.

## Current Status

The current code is good enough for:

- session discovery
- session loading
- preserving tool calls/results
- avoiding previous duplicate-stream problems in Codex

The current code is **not** good enough for the user's stated requirement of **full export** because:

1. readable reasoning / thinking content is still dropped across all four audited providers
2. the CLI export path always sanitizes/anonymizes content, so it is not a raw archive export

## Next Changes Needed

Historical note: this section captured the pre-fix gap analysis. The "Retest After Fix" section below supersedes it.

To satisfy full export requirements, the code needs at least:

1. provider support for reasoning / thinking preservation in:
   - `plugins/claude/index.ts`
   - `plugins/codex/index.ts`
   - `plugins/factory/index.ts`
   - `plugins/pi/index.ts`
2. a raw export mode that bypasses:
   - redaction
   - anonymization
3. regression tests covering:
   - stored reasoning / thinking blocks
   - raw export mode preserving ids, paths, and timestamps

## Retest After Fix

Status after patching:

- readable reasoning / thinking is now preserved in:
  - `plugins/claude/index.ts`
  - `plugins/codex/index.ts`
  - `plugins/factory/index.ts`
  - `plugins/pi/index.ts`
- raw archive export is now available from the standalone CLI via:
  - `pi-brain export <source> --raw`
- Pi local export command also supports `--raw`
- public Pi export rejects `--raw`

### Full-Corpus Retest

Using:

- `bun scripts/full-export-audit.ts`
- real source files on disk
- real `node dist/cli.js export <source> --raw` runs

Result:

- Claude: `19 / 19` sessions matched, `0` mismatches
- Codex: `424 / 424` sessions matched, `0` mismatches
- Factory: `2 / 2` real sessions matched, `0` mismatches
- Pi: `147 / 147` sessions matched, `0` mismatches

Counts after fix:

- Claude
  - raw messages: `138`
  - plugin messages: `138`
  - raw reasoning: `35`
  - plugin reasoning: `35`
- Codex
  - raw messages: `53,544`
  - plugin messages: `53,544`
  - raw reasoning: `6,135`
  - plugin reasoning: `6,135`
- Factory
  - raw messages: `335`
  - plugin messages: `335`
  - raw reasoning: `61`
  - plugin reasoning: `61`
- Pi
  - raw messages: `8,281`
  - plugin messages: `8,281`
  - raw reasoning: `1,316`
  - plugin reasoning: `1,316`

### Long-Session Retest

Representative long sessions now match exactly:

- Claude
  - `1d3ec339-a4f0-4566-b23c-2747e88aa8e7`
  - `fc8e98b3-d30c-4c0c-878b-60f3fc76b96b`
  - `42ba73d0-ae2b-40e6-9eb6-62449db14199`
- Codex
  - `019c7c09-0e6e-7001-9eef-cce24818dcfd`
  - `019c7bca-0799-77f0-a0b8-cee0d02e52f6`
  - `019c7a3a-94be-7db1-a8c4-91cb6eaa607d`
- Factory
  - `5d6c61b3-5b11-4a46-b33b-d9a9cc41317d`
  - `a5b7526a-ef3b-4241-8988-9f9413cdf1bd`
- Pi
  - `eb7dc27d-561e-438e-bdbb-8a9a67360133`
  - `ef0d847e-4e84-428d-a6f4-7cef39997cd3`
  - `241d6b05-792d-4a91-a0aa-7e7099c68a19`

For all of the above, the audit reported:

- identical message counts
- identical tool call counts
- identical tool result counts
- identical reasoning counts
- no first-diff mismatch

### Source Safety Retest

Observed during raw export runs:

- Claude source files: unchanged
- Factory source files: unchanged
- Pi source files: unchanged
- Codex source files: one changed live rollout log, still attributable to the currently active Codex session

### Current Conclusion

For the audited providers, the source plugins now preserve the full transcript-bearing session content.

For a true raw archive, use:

- `node dist/cli.js export claude --raw`
- `node dist/cli.js export codex --raw`
- `node dist/cli.js export factory --raw`
- `node dist/cli.js export pi --raw`
