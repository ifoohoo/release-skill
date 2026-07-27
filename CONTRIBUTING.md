# Contributing to release-skill

Thank you for your interest in contributing to release-skill.

## Getting Started

1. Fork and clone the repository.
2. Install dependencies: `pnpm install`.
3. Run tests: `pnpm test`.
4. Run syntax validation: `pnpm build`.

## Project Structure

- `skills-src/` - Skill definition source files (SKILL.md for each skill).
- `src/core/` - Deterministic release kernel (baseline, errors, evidence, hooks).
- `src/adapters/` - Registry adapters (Git/GitHub, npm, plugin marketplace).
- `bin/` - CLI entry point.
- `schemas/` - JSON Schema definitions for configuration and plans.
- `references/` - Rendered reference documentation.
- `test/` - Test suite.

## Do not edit generated files

The following directories contain **generated artifacts** whose authoritative
source lives elsewhere. Do not edit them directly; changes will be overwritten
on the next regeneration.

| Generated directory | Authoritative source | Regeneration command |
|---|---|---|
| `references/` | `standards/` (workspace root) | `pnpm public:render` (workspace root) |
| `schemas/` | `standards/` (workspace root) | `pnpm public:render` (workspace root) |
| `adapters/` | `src/` + `skills-src/` | `npm run build:adapters` (this directory) |
| `skills/` | `skills-src/` | `npm run sync:skills` (this directory) |

To update a generated artifact:

1. Edit the authoritative source (e.g., `standards/01-state-machine.md` for
   `references/01-state-machine.md`, or `skills-src/release-help/SKILL.md` for
   `skills/release-help/SKILL.md`).
2. Run the regeneration command.
3. Verify with `pnpm public:verify` (workspace root) or
   `npm run build:adapters:check` / `npm run sync:skills:check` (this directory).

**README.md**, **INSTALL.md**, and **CHANGELOG.md** are human-maintained source
files. Their managed regions are refreshed by the `docs refresh` command using
structured release-notes YAML; do not hand-edit content between managed-region
markers.

## Development Guidelines

- All code uses ESM (`.mjs` extension) on Node.js 22+.
- All `.mjs` files must pass `node --check` (syntax validation).
- Hooks must use executable/argument arrays, not shell strings.
- Never include absolute paths like `/Users/...` in code or documentation.
- Test your changes before submitting a pull request.

## Pull Request Process

1. Create a feature branch from `main`.
2. Make your changes and ensure all tests pass.
3. Write clear commit messages describing what changed and why.
4. Open a pull request with a description of the change and any related
   issue numbers.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting Issues

For non-security issues, please open a GitHub issue with:

- A clear description of the problem.
- Steps to reproduce.
- Expected vs. actual behavior.
- Your environment (Node.js version, OS).
