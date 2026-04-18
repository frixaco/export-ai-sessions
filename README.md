# export-ai-sessions

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

Export all checked-in sessions for one provider:

```sh
pnpm export-session codex
pnpm export-session claude
pnpm export-session opencode
pnpm export-session pi
pnpm export-session factory
```

Default behavior:

- reads from `data/<source>/`
- writes normalized output to `exported/<source>/<session-id>.json`

Useful options:

```sh
pnpm export-session codex --input tests/fixtures/codex/source.jsonl --pretty
pnpm export-session factory --out-dir ./tmp/factory-exports
pnpm export-session claude --fail-fast
```

Help:

```sh
pnpm export-session --help
```

## Library API

```ts
import { convertSessionFile, convertSessionText } from "export-ai-sessions";

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

## Repo Notes

- `data/` contains local source sessions used for sampling and audit work
- `exported/` contains generated normalized output
- `ref/` is prior art only, not the active implementation
