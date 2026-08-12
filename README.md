# release-skill

[简体中文](README.zh-CN.md) · Installation: [English](INSTALL.md) / [简体中文](INSTALL.zh-CN.md)

<!-- release-skill:release-version: 0.4.2 -->
Release preparation for Claude Code, CodeBuddy, WorkBuddy, Codex, and Kimi Code, with human-edited files kept intact.

release-skill helps a maintainer answer three questions: what will be released,
which checks still fail, and which exact bytes will reach users. release-skill
does not regenerate or rewrite project source files. `prepare` copies each
configured public file into an isolated snapshot and verifies the copied bytes —
it freezes the reviewed artifacts first and publishes those same artifacts later.
Setup surfaces only the deterministic `compactSummary` review view; the full
report stays in a temporary session directory.

<!-- release-skill:managed:start id=latest-release -->
**0.4.2** (2026-08-12)

v0.4.2 makes the CodeBuddy consumer marketplace configurable per distribution instead of hardcoding a single marketplace, so CodeBuddy plugin distributions can target a project-declared marketplace source.

**Changed**

- **Plan schema**: production plans carry the resolved codebuddy marketplace coordinates so approval and publish review the exact marketplace target.

**Fixed**

- **Configurable CodeBuddy marketplace**: codebuddy-plugin distributions now accept `marketplace` and `marketplaceSource` in project configuration, and prepare threads both values into the consumer install action instead of assuming a fixed marketplace.
<!-- release-skill:managed:end id=latest-release -->

<!-- release-skill:capability:external-write-boundary -->
> **Current boundary:** v0.4.2 is the current source candidate; v0.4.1 remains
> the latest published release (v0.2.2 previously held
> published status before the platform verification convergence fix was added).
> v0.1.1 completed a real production release to GitHub and npm — the first
> production-verified milestone — followed by
> exact npm installation and Claude/Codex consumer installation verification
> from the frozen Git ref; "current release" and "first production-verified
> milestone" are two distinct facts and must not be conflated. The same
> workflow also has a local production-equivalent protocol suite using the
> real release-skill CLI and frozen artifacts, local bare Git remotes, and
> protocol fakes for `gh`, `npm`, Claude, and Codex. The suite does not
> provide OS-level network isolation, and it does not prove that another
> project's credentials, permissions, rate limits, or eventual-consistency
> behavior will match this release. Treat each project's first production run
> as a monitored canary. `prepare --online` observes bound previous-public
> baselines and fails closed on drift; remote uniqueness checks run during
> publish global preflight.

<!-- release-skill:capability:safe-first-command -->
> **Production path verified since the v0.1.1 milestone; v0.4.2 is the current
> source candidate and v0.4.1 is the latest published release.** The npm-installed CLI is the supported user entry. Source checkout
> is the development/contributor fallback.
>
> **Start here:**
> - npm install: `npm install -g release-skill` → `release-skill help`
> - source checkout: `node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help`

<!-- release-skill:maturity:v0.1-boundary -->
<!-- release-skill:maturity:boundary -->
> **Safe defaults:** the recommended path is `help → assess → prepare --offline →
> human review`. `help` and `assess` are read-only. The release-skill-owned part of
> `prepare --offline` writes only under `.release-skill/` and does not call remote
> publish adapters, but configured hooks and gates are unsandboxed processes: they
> may write outside the project, access credentials, make network calls, or publish.
> Treat `prepare` as local-only only when those processes are absent or separately
> audited and explicitly acknowledged. Production publishing uses
> `ship --target-version <ver> → ship --approve --actor <name>`.
> The `ship` command runs hooks and gates automatically; the only human gate is plan approval.
> Kimi/CodeBuddy installations are non-blocking manual follow-up tasks (not verified by system).

## Table of contents

- [Quick start](#quick-start)
- [Release workflow](#release-workflow)
- [Documentation](#documentation)
- [Skills](#skills)
- [Platform distribution](#platform-distribution)
- [License](#license)

## Quick start

### Install

- Node.js 22+, Git 2.30+, a target Git repository with at least one commit.

**npm (recommended):**

```bash
npm install -g release-skill
release-skill help
```

Or run directly without installing:

```bash
npx release-skill help
```

**Plugin (Claude Code / CodeBuddy / WorkBuddy / Codex):**

Claude Code, CodeBuddy, WorkBuddy, and Codex install from the bundled-family
marketplace `ifoohoo/release-skill`:

```
/plugin marketplace add ifoohoo/release-skill
/plugin install release-skill@release-skill
```

> **Prerequisite: GitHub access.** The `owner/repo` shorthand makes Claude Code
> clone via SSH. If you do not use SSH, pass the full HTTPS URL —
> `/plugin marketplace add https://github.com/ifoohoo/release-skill` — or set
> `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.

**Kimi Code:** Kimi Code has no marketplace install API. Install manually from a
pinned release tag — see [INSTALL.md](INSTALL.md#install-as-a-kimi-code-plugin).

See [INSTALL.md](INSTALL.md) for CodeBuddy, Codex, and Kimi Code commands.

### Main workflow

For routine releases, use the durable fast path. It persists authoritative
paths and resumes safely, so a normal run needs at most one human gate: the
frozen plan approval. `ship` runs configured hooks and verification gates
automatically. Kimi/CodeBuddy installations are non-blocking post-release
manual tasks; the system does not verify their completion.

```bash
release-skill ship --root "$PROJECT" --target-version 1.2.3 --json
release-skill ship --root "$PROJECT" --approve --actor "$ACTOR" --json
```

During development, `release-skill hooks validate` runs declared hooks and
writes the same content-bound cache receipts that `prepare` consumes.

Run these steps in order. Steps 1-3 are read-only. In step 4, release-skill's own
prepare pipeline is local-only and never invokes remote publish adapters; configured
hooks and gates remain arbitrary unsandboxed processes and can perform local or remote
side effects. Step 4 is therefore local-only only when those processes are absent or
separately audited and explicitly acknowledged. Steps 5-9 require explicit human gates.

```bash
CLI=(release-skill)           # or: CLI=(node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs")
PROJECT=/absolute/path/to/my-project
ACTOR=your-name
```

1. **help** — check the environment:
   ```bash
   "${CLI[@]}" help
   ```
2. **setup** — first-use only (read-only discovery, then create-once config):
   ```bash
   SETUP_SESSION="$(mktemp -d "${TMPDIR:-/tmp}/release-setup.XXXXXX")"
   REPORT="$SETUP_SESSION/discovery.json"
   ANSWERS="$SETUP_SESSION/answers.json"
   printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"
   "${CLI[@]}" setup --root "$PROJECT" --json > "$REPORT" || test "$?" -eq 2
   ```
   If `proposalConflicts` is non-empty, stop and let a human correct the
   conflicting repository or mapping authority. With no conflicts, extract
   `recommendedAnswers` mechanically (never hand-write complete answers):
   ```bash
   SETUP_SESSION='<session-directory-absolute-path-printed-above>'
   node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if((r.proposalConflicts??[]).length){console.error("proposal conflicts require human resolution");process.exit(2)}if(!r.recommendedAnswers){console.error("recommendedAnswers missing");process.exit(2)}fs.writeFileSync(process.argv[2],JSON.stringify(r.recommendedAnswers,null,2)+"\n",{flag:"wx",mode:0o600})' "$REPORT" "$ANSWERS"
   ```
   Confirm the bound `setupDigest` once, then create the config:
   ```bash
   SETUP_SESSION='<session-directory-absolute-path-printed-above>'
   PROJECT='<project-absolute-path-printed-above>'
   ANSWERS="$SETUP_SESSION/answers.json"
   CREATED_REPORT="$SETUP_SESSION/created.json"
   POST_REPORT="$SETUP_SESSION/post-setup.json"
   ASSESS_REPORT="$SETUP_SESSION/assess.json"
   "${CLI[@]}" setup --root "$PROJECT" --answers "$ANSWERS" \
     --write --confirm-setup <confirmed-setupDigest> --json > "$CREATED_REPORT"
   "${CLI[@]}" setup --root "$PROJECT" --json > "$POST_REPORT"
   set +e
   "${CLI[@]}" assess --root "$PROJECT" --offline --json > "$ASSESS_REPORT"
   ASSESS_EXIT=$?
   set -e
   [ "$ASSESS_EXIT" -eq 0 ] || [ "$ASSESS_EXIT" -eq 1 ] || exit "$ASSESS_EXIT"
   node -e 'const fs=require("node:fs");const [c,p,a]=process.argv.slice(1).map(x=>JSON.parse(fs.readFileSync(x,"utf8")));if(c.status!=="CONFIG_CREATED"||p.status!=="ALREADY_CONFIGURED"||!["ASSESSED","NEEDS_INPUT","BLOCKED"].includes(a.status)){process.exit(2)}' "$CREATED_REPORT" "$POST_REPORT" "$ASSESS_REPORT"
   node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:false})' "$SETUP_SESSION"
   ```
   The write must return `CONFIG_CREATED`; the next setup must return
   `ALREADY_CONFIGURED`. Existing configuration is never regenerated — make only
   reviewed incremental edits. For npm units, setup also reports each concrete
   `bin`/`main`/`module`/`types`/`typings`/`exports` target and legacy
   `npmRequiredPackagePaths` as tracked, untracked, ignored, missing, or
   non-regular. These are review candidates only: setup never copies them into
   `publicFiles` or `requiredPublicFiles`. Discovered scripts are
   `SIDE_EFFECTS_UNPROVEN`.
   Add a project-specific hook or gate only after human review: edit
   `projectConfig.hooks`, or edit `verificationGates` and add the same id to
   `selectedGateIds`, then rerun the bound dry-run.
   See [INSTALL.md](INSTALL.md#first-use-setup) for the full multi-step flow.
3. **assess** — read-only readiness:
   ```bash
   "${CLI[@]}" assess --root "$PROJECT" --offline --json
   ```
4. **prepare** — local snapshot and plan freeze:
   ```bash
   "${CLI[@]}" prepare --root "$PROJECT" --offline --json
   ```
5. **Human review:** inspect `planPath`, `externalActions`, `targetVersion`, and `planDigest`.
6. **prepare --production** — freeze the production plan:
   ```bash
   PLAN_JSON=$("${CLI[@]}" prepare --root "$PROJECT" --online --production --json)
   PLAN_PATH=$(printf '%s\n' "$PLAN_JSON" | jq -r '.planPath')
   PLAN_DIGEST=$(printf '%s\n' "$PLAN_JSON" | jq -r '.planDigest')
   ```
7. **approve** — human approval (digest auto-read from plan, 24-hour expiry):
   ```bash
   APPROVAL_JSON=$("${CLI[@]}" approve --plan "$PLAN_PATH" \
     --actor "$ACTOR" --json)
   APPROVAL_PATH=$(printf '%s\n' "$APPROVAL_JSON" | jq -r '.approvalPath')
   ```
   `--actor` is an unauthenticated local audit string. It is not identity
   verification, a signature, or proof that a particular human approved the plan;
   use an external authenticated approval system when that assurance is required.
8. **publish** — remote writes start here:
   ```bash
   PUBLISH_JSON=$("${CLI[@]}" publish --root "$PROJECT" \
     --plan "$PLAN_PATH" --approval "$APPROVAL_PATH" --json)
   PUBLISH_RUN_PATH=$(printf '%s\n' "$PUBLISH_JSON" | jq -r '.runPath')
   ```
   `PUBLISHED` is **not** the terminal state.
9. **verify** — consumer install check:
   ```bash
   "${CLI[@]}" verify --root "$PROJECT" \
     --plan "$PLAN_PATH" --run "$PUBLISH_RUN_PATH" --json
   ```

The handoff example requires `jq`. Without it, copy the returned JSON fields
exactly; do not pass angle-bracket labels as shell syntax.

### PARTIAL recovery and reconcile

When `publish` succeeds at some checkpoints but fails at others, the run enters
`PARTIAL` status. **Do not restart from scratch and do not delete remote state.**

```bash
RECONCILE_JSON=$("${CLI[@]}" reconcile --root "$PROJECT" \
  --run "$PUBLISH_RUN_PATH" \
  --plan "$PLAN_PATH" \
  --approval "$APPROVAL_PATH" --json)
RECONCILE_RUN_PATH=$(printf '%s\n' "$RECONCILE_JSON" | jq -r '.runPath')
"${CLI[@]}" verify --root "$PROJECT" \
  --plan "$PLAN_PATH" --run "$RECONCILE_RUN_PATH" --json
```

`reconcile` queries the actual remote state, skips already-consistent steps,
and retries only safe incomplete actions. Remote conflicts require human
decision. Successful reconcile returns `PUBLISHED`, not `VERIFIED`.

## Release workflow

release-skill models the release lifecycle as a strict state machine
(normative definition: `references/01-state-machine.md`):

```text
DISCOVERED -> ASSESSED -> PREPARED -> APPROVED -> PUBLISHING -> PUBLISHED -> VERIFIED
                                   exception states: NEEDS_INPUT / BLOCKED / PARTIAL
```

Each CLI command maps to one transition. `PUBLISHED` is **not** the terminal
state — only a fresh `verify` that confirms remote state and consumer installs
match the frozen plan reaches `VERIFIED`.

**Preservation contract:** release-skill does not regenerate or rewrite project
source files. `prepare` copies each configured public file into an isolated
snapshot and verifies the copied bytes. A later prepare reads the current file
again; it never rebuilds from a template. Only files listed in `publicFiles` are
copied. `prepare` never refreshes or rewrites human docs — maintainers update
README, INSTALL, and CHANGELOG first, then prepare, review, and approve.

**Workspace source authority:** production config names the workspace source
repository with `project.sourceRepository` and its real remote default branch
with `project.defaultBranch`. Prepare binds the content and Git mode of every
expanded `publicFiles.from` input plus each `version.source`; publish compares
that frozen closure with the remote default branch before the first adapter
write. The check accepts merge, squash, and rebase when the bytes still match,
but blocks a lost or reverted README by path. It never merges, switches
branches, pushes, or creates a PR.

**Write safety:** `setup` is read-only by default (create-once after digest
confirmation). Release-skill's own `prepare` pipeline writes only under
`.release-skill/` and does not invoke remote publish adapters. Project hooks and
gates are acknowledged processes without an OS sandbox; they may write outside the
project, access credentials, make network calls, or publish. `publish` is the
release-skill-owned production write entry and requires both approval and the current
plan digest.

## Documentation

| Document | Description |
|---|---|
| [INSTALL.md](INSTALL.md) / [INSTALL.zh-CN.md](INSTALL.zh-CN.md) | Full installation guide: npm, plugin, source checkout, setup flow, branch strategies |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute (includes generated-artifact rules) |
| [SECURITY.md](SECURITY.md) | Security policy |
| `references/01-state-machine.md` | Normative state machine definition |
| `references/02-project-config.md` | Project configuration schema reference |
| `references/05-evidence-and-errors.md` | Evidence format and error codes |
| `references/06-adapter-contract.md` | Adapter and marketplace contract details |
| [GitHub Issues](https://github.com/ifoohoo/release-skill/issues) | Bug reports and feature requests |

## Configuration

A minimal human-authored configuration (see [INSTALL.md](INSTALL.md) for the
full schema and setup flow):

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject
project:
  name: my-project
  defaultBranch: main
  sourceRepository: owner/my-workspace
releaseUnits:
  - id: my-project
    source: .
    publicRepo: owner/my-project
    version:
      source: package.json
      tagTemplate: v{version}
    publicFiles:
      - from: README.md
        to: README.md
        mode: preserve
      - from: package.json
        to: package.json
        mode: preserve
    requiredPublicFiles: [README.md, package.json]
    previousPublicBaseline:
      mode: none
    distributions:
      - type: npm
        package: my-project
        access: public
        provenance: false
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
    production:
      branchTemplate: release/{tag}
      branchStrategy: create-release-branch
```

`version.source` is resolved relative to that release unit's `source` directory
(`version.source` 相对于该发布单元的 `source` 目录解析). A monorepo with
separate npm and plugin units defines multiple release units:

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject
project:
  name: my-workspace
  defaultBranch: main
  sourceRepository: owner/my-workspace
releaseUnits:
  - id: my-app
    source: packages/app
    publicRepo: owner/my-app
    version:
      source: package.json
      tagTemplate: my-app-v{version}
    distributions:
      - type: npm
        package: my-app
        access: public
        provenance: false
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
    publicFiles:
      - from: packages/app/package.json
        to: package.json
        mode: preserve
    requiredPublicFiles: [package.json]
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      branchStrategy: create-release-branch
  - id: my-plugin
    source: packages/plugin
    publicRepo: owner/my-plugin
    version:
      source: package.json
      tagTemplate: my-plugin-v{version}
    distributions:
      - type: claude-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
        marketplaceSourceType: bundled-family
    publicFiles:
      - from: packages/plugin/package.json
        to: package.json
        mode: preserve
    requiredPublicFiles: [package.json]
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      branchStrategy: create-release-branch
```

Add a gate to the extracted `recommendedAnswers` by editing `verificationGates`
and binding the same id in `selectedGateIds`:

```json
{
  "projectConfig": {
    "apiVersion": "release-skill/v1",
    "kind": "ReleaseProject",
    "project": {
      "name": "my-project",
      "defaultBranch": "main",
      "sourceRepository": "owner/my-workspace"
    },
    "releaseUnits": [{
      "id": "my-project",
      "source": ".",
      "publicRepo": "owner/my-project",
      "version": { "source": "package.json", "tagTemplate": "v{version}" },
      "distributions": [{
        "type": "npm", "package": "my-project", "access": "public",
        "provenance": false, "tag": "latest",
        "registry": "https://registry.npmjs.org", "publisher": "my-npm-username"
      }],
      "publicFiles": [{ "from": "package.json", "to": "package.json", "mode": "preserve" }],
      "requiredPublicFiles": ["package.json"],
      "previousPublicBaseline": { "mode": "none" },
      "production": { "branchTemplate": "release/{tag}", "branchStrategy": "create-release-branch" }
    }],
    "verificationGates": [{
      "id": "my-project-script-test",
      "phase": "snapshot-verify",
      "scope": { "unit": "my-project" },
      "command": ["node", "-e", "const p=require('./package.json');if(!p.name)process.exit(1)"],
      "cwd": ".",
      "timeoutMs": 30000,
      "envAllowlist": []
    }]
  },
  "selectedGateIds": ["my-project-script-test"]
}
```

### Hooks and gates

`hooks.docs/build/test/typecheck/lint` run before the snapshot is frozen. Each
hook is an object. `command` is an executable/argument array, not a shell string
(`command` 是可执行文件/参数数组，不是 shell 字符串):

```yaml
hooks:
  build:
    command: [node, scripts/build.mjs]
    cwd: .
    timeoutMs: 120000
    envAllowlist: [CI]
  test:
    command: [node, --test, test/]
    cwd: .
    timeoutMs: 300000
    envAllowlist: []
```

Hooks run when `prepare` is invoked; the command call itself authorizes
execution. Gates are the controlled extension point for release calibration
(see `references/02-project-config.md`).

## Skills

- `release-help`: environment check and next-step guidance.
- `release-setup`: read-only discovery, human calibration, and create-once configuration.
- `release-assess`: read-only release readiness report.
- `release-prepare`: local snapshot and reviewable release plan.
- `release-publish`: approved frozen GitHub+npm publishing; the internal digest is checked automatically.
- `release-reconcile`: evidence-based PARTIAL recovery with human intervention on conflicts.
- `release-verify`: post-publish verification; only `VERIFIED` is the happy end.

## Platform distribution

One deterministic core engine ships to several targets through build-only adapter
closures. A release unit declares what reaches users via `distributions`:

| `distributions` type | Physical artifact | Install |
|---|---|---|
| `npm` | npm package with CLI entry | `npm install -g release-skill` |
| `claude-plugin` | self-contained closure under `adapters/claude/` | automated marketplace checkpoint |
| `codex-plugin` | self-contained closure under `adapters/codex/` | automated marketplace checkpoint |
| `kimi-plugin` | self-contained closure (no scriptable install API) | non-blocking post-release manual task |
| `codebuddy-plugin` | generated `adapters/workbuddy/` with `.codebuddy-plugin/plugin.json` | non-blocking post-release manual task |

Each adapter closure bundles its own CLI, skills, and schemas for zero external
dependency after installation. `publish` only publishes frozen Git objects and
npm tarballs, then checks remote commit/tree/tag integrity. Claude/Codex
verification is automated. Kimi Code and CodeBuddy/WorkBuddy are returned as
`manualFollowUps` with `verifiedBySystem: false`; their completion is not a
condition for the automated release to reach `VERIFIED`.

A `codebuddy-plugin` distribution may optionally declare `marketplace` (and
`marketplaceSource`, the URL consumers use to add the marketplace) to override
the default unified marketplace `artifact-skill-set`; undeclared distributions
keep the default and produce byte-identical frozen plans.

For every npm distribution, `prepare` statically checks the exact packed
tarball against concrete `package.json` entry targets. `publish` and
`reconcile` repeat the same check on the frozen tarball before any remote
action, and `verify` repeats it against the exact installed package before
allowing `VERIFIED`. `smokeBin` remains optional: when configured it adds an
authorized runtime smoke test; when absent, the static entry-closure check is
still mandatory. Wildcard exports and fallback arrays are deliberately outside
the first minimal semantic boundary, so the static gate fails closed until the
declaration is narrowed to concrete targets.

<!-- release-skill:capability:unsupported-scope -->
- no automatic README generation or source-file overwrite;
- no automatic conflict merge or rollback workflow;
- no claim that a real production canary has run for marketplace verification;
- `prepare --online` observes previous public baselines (bound mode) and defers
  remote uniqueness checks to publish global preflight;
- no overwrite of branches/tags/releases or npm unpublish; create-only refs use
  `--force-with-lease=<ref>:` solely as an atomic compare-and-set assertion that
  the ref is absent, while existing branches use an ordinary non-force push;
- no automated Kimi or CodeBuddy/WorkBuddy marketplace install checkpoint —
  these installations remain explicit post-release team tasks and the system
  does not verify their completion;
- no promise of Windows or broad multi-platform native write support;
- no hidden commit, push, tag, release, or package publication.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
