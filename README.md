# export-ai-sessions

Rewrite from scratch of an AI session export tool.

## CLI

Build and export checked-in provider sessions with:

```sh
pnpm export-session codex
pnpm export-session claude
pnpm export-session opencode
```

By default this scans `data/<source>/` and writes unified sessions to `exported/<source>/<session-id>.json`.

Useful options:

```sh
pnpm export-session codex --input tests/fixtures/codex/source.jsonl --pretty
pnpm export-session factory --out-dir ./tmp/factory-exports
```

## Notes

- This repo is the new implementation, built fresh.
- [`ref/`](./ref) contains the previous codebase copied in as a loose reference.
- Treat `ref/` as inspiration and prior-art only, not as the code to keep extending directly.
