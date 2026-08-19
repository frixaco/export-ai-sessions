# AGENTS.md

## Context

- This repository is a fresh rewrite.
- Use [`ref/`](./ref) as a loose reference for ideas, behavior, and prior implementation details.
- Do not treat `ref/` as the active source of truth for new code.

## Working Rules

- Prefer building new code from first principles.
- Copy behavior intentionally, not mechanically.
- Keep the new implementation small, clear, and easy to verify.
- When referencing old behavior, verify it against `ref/` instead of assuming.

## Releasing

- Follow the release procedure in [`README.md`](./README.md).
- Publishing is tag-driven through `.github/workflows/release.yml` and npm trusted publishing.
- Use Jujutsu for the release commit, `main` bookmark, tag, and push.
- Do not add an `NPM_TOKEN` secret or publish manually.
