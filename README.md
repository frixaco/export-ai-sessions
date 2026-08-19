# @frixaco/shair

Convert local AI agent sessions into one unified JSON shape.

Supported sources:

- `claude`
- `codex`
- `factory`
- `opencode`
- `pi`

## What it does

- exports all detected local sessions for a provider into a shared block-based schema
- validates every converted session against the unified schema
- supports both CLI usage and a small library API
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

Export all sessions for one provider:

```sh
npx @frixaco/shair codex
npx @frixaco/shair claude
npx @frixaco/shair opencode
npx @frixaco/shair pi
npx @frixaco/shair factory
```

Export one session by its provider and session ID:

```sh
npx @frixaco/shair codex 019f9f8e-2583-7772-aa27-b0842aec620b
```

Default behavior:

- reads from the provider's real local session storage first:
  - `codex`: `~/.codex/{sessions,archived_sessions}` and `~/.codex-local/...`
  - `claude`: `~/.claude/projects`, `~/.claude-code/projects`, `~/.claude-local/projects`
  - `factory`: `~/.factory/sessions`
  - `opencode`: `~/.local/share/opencode/opencode.db` and `~/Library/Application Support/opencode/opencode.db` when present
  - `pi`: `~/.pi/agent/sessions`
- falls back to `data/<source>/` for file-backed providers when no runtime sessions are found
- writes normalized output to `exported/<source>/<session-id>.json` under the current project/workspace root

Useful options:

```sh
npx @frixaco/shair codex --input tests/fixtures/codex/source.jsonl --pretty
npx @frixaco/shair factory --out-dir ./tmp/factory-exports
npx @frixaco/shair claude --fail-fast
```

OpenCode can also target a specific database file or install directory:

```sh
npx @frixaco/shair opencode --input ~/.local/share/opencode/opencode.db
npx @frixaco/shair opencode --input ~/.local/share/opencode
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
npm install /path/to/frixaco-shair-X.Y.Z.tgz
npx @frixaco/shair --help
```

## Releasing

Publishing uses npm trusted publishing through `.github/workflows/release.yml`. The workflow does not use an `NPM_TOKEN` secret.

1. Check the current npm version and choose a higher `X.Y.Z`:

   ```sh
   npm view @frixaco/shair version
   ```

2. Update `version` in `package.json`.
3. Verify the package:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check
   npm pack --dry-run
   ```

4. Commit the version, create a matching tag, and push both with Jujutsu:

   ```sh
   jj commit -m "Release X.Y.Z"
   jj bookmark set main -r @-
   jj tag set vX.Y.Z -r @-
   jj git push --bookmark main --tag vX.Y.Z
   ```

The tag must point to the commit containing version `X.Y.Z`. A tag push runs the release workflow. npm rejects a version that already exists.

The npm package must trust GitHub Actions for repository `frixaco/export-ai-sessions`, workflow `release.yml`, with `npm publish` permission.

## Repo Notes

- `data/` contains local source sessions used for sampling and audit work
- `exported/` contains generated normalized output
- `ref/` is prior art only, not the active implementation
