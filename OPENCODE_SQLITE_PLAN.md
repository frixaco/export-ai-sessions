## OpenCode SQLite Migration Plan

### Assumptions

- OpenCode's current source of truth is `opencode.db`.
- We will not support legacy `storage/` fallback in this implementation.
- If `opencode.db` is missing, unreadable, or has an unexpected schema, export should fail clearly instead of silently falling back to another source.

### Goal

Replace the current OpenCode CLI export path with a direct SQLite-backed loader so `shair opencode` exports all real OpenCode sessions from `opencode.db` using the same unified session schema as the other providers.

### Scope

In scope:

- Session discovery from `opencode.db`
- Session loading from `opencode.db`
- Adapting loaded rows into the existing OpenCode unified-session converter
- CLI wiring for default OpenCode export
- Regression and integration coverage for multi-session export

Out of scope:

- Legacy `storage/` support
- Shelling out to `opencode export`
- Mixed-source fallback logic

### Implementation Plan

#### 1. Lock the real SQLite schema

- Inspect the local OpenCode database schema and sample rows from:
  - `~/.local/share/opencode/opencode.db`
  - `~/Library/Application Support/opencode/opencode.db`
- Confirm the minimal tables and columns we need for export:
  - `session`
  - `message`
  - `part`
- Document the actual row shapes we rely on before writing adapter code.

Why:

- This keeps the new implementation grounded in the real runtime schema instead of assumptions from `ref/` or old storage layouts.

#### 2. Build a dedicated OpenCode DB reader

- Add a small read-only module for OpenCode SQLite access.
- Prefer `node:sqlite` first.
- Keep the API narrow and explicit, for example:
  - `listOpenCodeSessions(): SessionRef[]`
  - `loadOpenCodeSession(sessionId): LoadedOpenCodeSession`
- Query sessions in stable order.
- Query messages in stable chronological order.
- Query parts in stable chronological order.
- Parse JSON payload columns safely and treat malformed rows as data errors with clear messages.

Failure modes to handle:

- DB file missing
- DB unreadable or locked
- required table missing
- required row missing
- malformed JSON payload in message or part data

#### 3. Add an adapter into the existing OpenCode converter

- Keep [`src/providers/opencode/convert.ts`](/Users/frixa/Documents/export-ai-sessions/src/providers/opencode/convert.ts:1) as the normalization layer when possible.
- Add a small adapter that turns SQLite-loaded session data into the `OpencodeExport` shape the converter already expects.
- Only change converter behavior if the SQLite source exposes a real shape mismatch or more accurate data.

Why:

- This keeps the rewrite small and reduces regression risk.
- The converter already has OpenCode-specific normalization and test coverage we should continue to use.

#### 4. Replace CLI OpenCode discovery and loading

- Remove the current OpenCode-specific path based on:
  - `opencode export`
  - `storage/session` filename discovery
- Make `shair opencode` enumerate sessions directly from `opencode.db`.
- Make conversion load each session from SQLite and hand it to the adapter/converter pipeline.
- Keep output behavior unchanged:
  - default output directory remains `exported/opencode/`
  - output filename remains `<session-id>.json`

Important rule:

- No legacy fallback and no shell command fallback.

#### 5. Add regression and integration coverage

- Add DB-reader tests for:
  - multiple sessions listed
  - one session loaded with messages and parts in order
  - missing session
  - malformed row payload
  - missing DB / missing schema
- Add CLI integration coverage for:
  - exporting all OpenCode sessions from a test DB
  - exporting more than one session, not just one
  - clear failure when DB is unavailable
- Keep or refresh OpenCode golden output tests if the SQLite path changes exported fidelity.

Testing strategy:

- Treat SQLite as an external-system boundary.
- Verify our SQL inputs and snapshot the normalized outputs.

#### 6. Run a real end-to-end audit

- Export all real OpenCode sessions from the local OpenCode DB.
- Verify:
  - exported session count matches database session count
  - output files validate against the unified session schema
  - sampled exported sessions match underlying DB content
  - no temp files or shell-command artifacts are left behind
- Then run the full repo verification suite:
  - lint
  - typecheck
  - tests

### Acceptance Criteria

- `shair opencode` exports all sessions found in `opencode.db`
- OpenCode export no longer depends on `opencode export`
- OpenCode export does not read legacy `storage/` data
- Every exported OpenCode session validates against the unified session schema
- Export count matches the number of exported sessions we can list from the DB
- Multi-session export is covered by regression or integration tests
