# @frixaco/shair

Convert local AI agent session exports into one unified JSON shape.

Supported sources:

- `claude`
- `codex`
- `factory`
- `opencode`
- `pi`

## What it does

- converts provider-specific session files into a shared block-based schema
- validates converted sessions against the unified schema
- exports normalized sessions through a small CLI
- keeps provider-specific raw details in metadata for fidelity

The schema is documented in [UNIFIED_SESSION_SHAPE.md](./UNIFIED_SESSION_SHAPE.md).

## CLI

Published usage:

```sh
npx @frixaco/shair claude
bunx @frixaco/shair codex
```

Local development usage:

```sh
pnpm export-session claude
pnpm export-session codex
```

Export all checked-in sessions for one provider:

```sh
npx @frixaco/shair codex
npx @frixaco/shair claude
npx @frixaco/shair opencode
npx @frixaco/shair pi
npx @frixaco/shair factory
```

Default behavior:

- reads from the provider's real local session storage when supported:
  - `codex`: `~/.codex/{sessions,archived_sessions}` and `~/.codex-local/...`
  - `claude`: `~/.claude/projects`, `~/.claude-code/projects`, `~/.claude-local/projects`
  - `factory`: `~/.factory/sessions`
  - `opencode`: `~/.local/share/opencode/opencode.db` or `~/Library/Application Support/opencode/opencode.db`
  - `pi`: `~/.pi/agent/sessions`
- falls back to `data/<source>/` when no runtime sessions are found, except `opencode`, which requires `opencode.db`
- writes normalized output to `exported/<source>/<session-id>.json`

Useful options:

```sh
npx @frixaco/shair codex --input tests/fixtures/codex/source.jsonl --pretty
npx @frixaco/shair factory --out-dir ./tmp/factory-exports
npx @frixaco/shair claude --fail-fast
```

Help:

```sh
npx @frixaco/shair --help
```

## Library API

```ts
import { convertSessionFile, convertSessionText } from "@frixaco/shair";

const session = convertSessionFile("codex", "path/to/session.jsonl");
```

Main exports:

- `convertSessionFile`
- `convertSessionText`
- `getConverter`
- `validateUnifiedSession`
- `assertUnifiedSession`

## Development

Build:

```sh
pnpm build
```

Run the full verification suite:

```sh
pnpm check
```

Publish smoke test:

```sh
pnpm pack
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm init -y
npm install /path/to/frixaco-shair-1.1.1.tgz
npx @frixaco/shair --help
```

## Repo Notes

- `data/` contains local source sessions used for sampling and audit work
- `exported/` contains generated normalized output
- `ref/` is prior art only, not the active implementation
