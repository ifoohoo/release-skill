# release-skill

[简体中文](README.zh-CN.md) · Installation: [English](INSTALL.md) / [简体中文](INSTALL.zh-CN.md)

<!-- release-skill:release-version: 0.9.1 -->
Release preparation for Claude Code, CodeBuddy, WorkBuddy, Codex, and Kimi Code, with human-edited files kept intact.

release-skill helps a maintainer answer three questions: what will be released,
which checks still fail, and which exact bytes will reach users. release-skill
does not regenerate or rewrite project source files. `prepare` copies each
configured public file into an isolated snapshot and verifies the copied bytes —
it freezes the reviewed artifacts first and publishes those same artifacts later.
Setup surfaces only the deterministic `compactSummary` review view; the full
report stays in a temporary session directory.

<!-- release-skill:managed:start id=latest-release -->
**0.9.1** (2026-08-28)

0.9.1 is a local source candidate for safer post-release host finishing. It now pins Foundation 0.14.0, whose public temporary-workspace and raw-output APIs pass the default Node.js 22 macOS consumer composition. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

**Security**

- Real-host acceptance requires a qualified frozen release plan and a VERIFIED run from the same release lineage. The workflow confirms the exact plan digest and selected hosts before any host write. release-skill's optional local finishing never changes the terminal release state.

**Changed**

- Pin skill-family-contracts, skill-family-harness-node, and skill-family-engineering-kit together at 0.14.0. A consumer test now combines the public withTemporaryWorkspace and superviseProcess.rawSink APIs under the default Node.js 22 macOS temporary directory.
- Derive platform-manifest.json version ownership from package.json.version and check manifest freshness before prepare runs hooks, including docs-only and config-only workflows.
- Expand ship's plan-approval summary from the frozen plan so reviewers can see public repositories, branch strategies, tags, npm targets, GitHub Releases, external action targets, waivers, and separately gated postPublish hooks.
- Claude now re-observes the installed plugin after marketplace rebinding before deciding whether a plugin update is still required. Codex keeps the formal frozen-marketplace reinstall path.
- Kimi accepts a managed installation without a .git directory when the package name, version, release tag, installed revision, managed root, and real payload all match. Legacy local-path entries are removed and reinstalled from the pinned release tag in one controlled TUI session.
- CodeBuddy/WorkBuddy can update an existing bundled-family entry only when one remote query proves that the frozen tag and mutable marketplace branch both resolve to the frozen commit. The final installed list must contain exactly one entry with the expected marketplace, version, and revision.

**Fixed**

- Prevent prepare from freezing a stale platform manifest into the public snapshot or npm tarball.
- Remove the misleading claim that plan approval includes a requiresApproval postPublish checkpoint. Plan approval remains the single normal release-level approval; each gated postPublish hook needs its own approval record, bound to the plan digest and hook id for at most 24 hours.
- Avoid a redundant Claude plugin update after marketplace rebinding has already removed or replaced the old installed entry.
- Classify legacy Kimi local-path installations before managed-root checks so they can follow the explicit migration path.
- Keep CodeBuddy/WorkBuddy host state unchanged when the target is absent, standalone, inaccessible, ambiguous, or inconsistent with the frozen release identity.

**Upgrade Notes**

Real-host acceptance can begin only after 0.9.1 is officially published and VERIFIED; the official 0.9.1 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update and a second run that reports `ALREADY_CURRENT`.
<!-- release-skill:managed:end id=latest-release -->

<!-- release-skill:capability:external-write-boundary -->
> **Current boundary:** v0.9.1 is the current source candidate. This README
> records intended scope and verification boundaries; it is not evidence of
> publication, consumer-installation verification, or independent acceptance.
> Release availability must be established from the corresponding release records
> and post-publish verification results.
> v0.4.1 was an earlier published milestone;
> v0.2.2 previously held published status before the platform verification
> convergence fix was added.
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
> **Production path verified since the v0.1.1 milestone; v0.9.1 is the current
> source candidate. Its README does not establish publication,
> consumer-installation verification, or independent acceptance.**
> The npm-installed CLI is the supported user entry. Source checkout
> is the development/contributor fallback.
>
> **Start here:**
> - npm install: `npm install -g release-skill` → `release-skill help`
> - source checkout: `node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help`

### 0.8.0 scope and verification boundaries

For `prepare --workflow config`, public-byte comparison selects the branch:

- Branch A (`no-publish-needed`) has no external actions and no `sourceAuthority`,
  even with a configured public source receipt. It ends without approve/publish/verify.
- Branch B (`publish-needed`) must freeze `plan.sourceAuthority` in production.
  Docs production has the same requirement; publish/reconcile/verify retain
  frozen-source and remote consistency checks.

Marketplace delegation to the target workspace is unchanged.

Old production plans missing `sourceAuthority` are rejected before external writes.
Plans with no external writes must be prepared again and receive approval for the
new digest; do not patch old plans or migrate approvals. Existing `PARTIAL`
checkpoints remain intact and use matching-version recovery. Evidence v1 stays
read-only; v2 uses a closed top level with phase extensions in `details`.
Summaries and recovery suggestions are diagnostic, never publication authority.

This version excludes R-02 safe full-tree inventory, R-05 Hook cache v2,
R-10 historical-release verification implementation, real Kimi/WorkBuddy
public-marketplace installation and invocation gates, and an Audit public
offline release-record verifier.
Foundation dependencies are pinned to the three released 0.14.0 packages.
For new bundled-family Kimi/CodeBuddy plans, verify calls the released
`runPluginVerification` entry with the complete frozen payload and records a
minimal `install-only` observation receipt. Kimi maps to `kimi-code`; CodeBuddy
maps to the compatible `workbuddy` host. `observed` and `payloadMatches` are
mechanism facts, not remote publication or release-domain VERIFIED facts.
Standalone marketplace sources, real marketplace installation, and host
invocation remain manual follow-ups.
This scope summary is not a remote publication record or a consumer upgrade instruction.

<!-- release-skill:maturity:distribute-v1 -->
<!-- release-skill:capability:distribute -->
> **Distribute maturity v1.0 (W2 closure):** postPublish distribution is available as a separate `distribute` command for mirror and marketplace-index actions. After `publish` reaches PUBLISHED status, run `ship distribute` or manually invoke `release-skill distribute --plan <path> --approval <path> --json`. The distribute action implements fail-closed semantics: NO_CHANGE on empty diff (no commit/tag/push), REMOTE_CONFLICT on tag move attempts (never force-push), AUTH_MISSING when external writes are not authorized. Supported modes: `--dry-run` (local commit+tag only), `--json` (structured output), `--help` (command reference). Tag commitment guarantees version consistency — distributed plugin.json.version must match input tag. See [docs/design/2026-08-17-postpublish-distribution.md](../../docs/design/2026-08-17-postpublish-distribution.md) for detailed architecture.
<!-- release-skill:capability:distribute -->

<!-- release-skill:maturity:postpublish-hooks-v2 -->
<!-- release-skill:capability:postpublish-hooks -->
> **postPublish hooks v2:** `releaseUnit.postPublish` accepts a declarative
> `hooks` array alongside the existing `targets`. Each hook is either a named
> preset or a custom command hook; custom command hooks follow the same rules
> as prepare hooks — executable/argument arrays, relative cwd, timeout, and an
> environment allowlist, with shell strings rejected — and, like all
> configured hooks and gates, they run as unsandboxed processes. Every
> declaration is normalized into the frozen plan, so a hook change changes the
> plan digest and invalidates existing approvals. A hook with
> `requiresApproval: true` (the default for public-write presets; projects may
> tighten this, never loosen it) needs its own checkpoint-level approval
> before execution: mint one with
> `release-skill approve --plan <plan> --hook <hookId> --actor <name>`, then
> consume it with `distribute --hook-approval <record>` or
> `ship --hook-approval <record>` (24-hour expiry, bound to the plan digest
> and the hook id). Git credentials come only from the host credential
> helper / OS keychain; release-skill never reads, stores, or prints them.
<!-- release-skill:capability:postpublish-hooks -->

<!-- release-skill:capability:postpublish-presets -->
> **postPublish presets:** six built-in presets ship with the bundle and are
> enumerated by `release-skill distribute --list-presets`: `git-mirror` and
> `marketplace-index-render` (declared in `targets` form), plus
> `proposal-inbox`, `marketplace-registry-entry`, `docs-refresh`, and
> `notify-handoff` (declared in `hooks` form). `proposal-inbox` delivers a
> machine-readable update proposal through a git-push or local-file transport
> for autonomous downstream consumption; without a target it degrades to
> `notify-handoff` behavior instead of failing. `notify-handoff` is the
> zero-write floor: it only renders a deterministic manual sync checklist.
> release-skill dogfoods this capability: this repository's own project
> configuration declares a `proposal-inbox` (git-push) hub-entry proposal
> toward the public `skill-family-hub` repository, to be delivered during the
> v0.7.0 release in the postVerify phase under its own checkpoint approval.
<!-- release-skill:capability:postpublish-presets -->

<!-- release-skill:capability:postverify-stage -->
> **postVerify stage:** hooks declared with `phase: postVerify` run only after
> the main run reaches VERIFIED; `ship` routes them into an independent
> postVerify run whose hook context carries the verification evidence
> (`verifyEvidence`, present in this phase only). A failed postVerify run
> stays PARTIAL and can be reconciled, but it never rolls the main run back
> from VERIFIED — the failure is recorded prominently in evidence, never
> silently.
<!-- release-skill:capability:postverify-stage -->

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
> Frozen-plan approval is the only normal release-level human gate.
> Here, “only human gate” means the only normal release-level approval. A postPublish hook whose effective
> `requiresApproval` is true still needs a separate checkpoint approval bound
> to the plan digest and hook id; that approval expires after at most 24 hours.
> For bundled-family Kimi/CodeBuddy releases, Foundation first observes the
> complete frozen payload in a fresh local installation. Real marketplace
> installation and host invocation remain non-blocking manual follow-up tasks.

## Table of contents

- [Quick start](#quick-start)
- [Release workflow](#release-workflow)
- [Documentation](#documentation)
- [Skills](#skills)
- [Platform distribution](#platform-distribution)
- [License](#license)

## Quick start

A release unit is a release object with independently configured version, public files, and distribution targets.

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
paths and resumes safely. Frozen plan approval is the only normal
release-level approval. `ship` runs configured hooks and verification gates
automatically. A gated postPublish hook still needs its independent checkpoint
approval; plan approval does not include it. For bundled-family Kimi/CodeBuddy releases, Foundation first
observes the complete frozen payload in a fresh local installation. Real
marketplace installation and host invocation remain non-blocking post-release
manual tasks; the system does not verify their completion.

A release plan is a record for review before approval, linking target versions, frozen artifacts, and proposed external actions; see the [human review and approval steps](#release-plan-review).

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
   Downstream postPublish guidance is also read-only until confirmed:
   `setup --discover-downstream` enumerates downstream candidates (git
   remotes, neighboring marketplace/docs repositories,
   `artifact-graph.config.yaml`, and a foundation profile when present), and
   `setup --propose-hooks` turns those cues into postPublish hook declaration
   drafts bound by a `setupDigest`. For an already-configured project,
   `setup --propose-hooks --write --confirm-setup <digest>` appends only the
   target release unit's `postPublish.hooks` block and never regenerates or
   rewrites any other part of the configuration (create-once is untouched). A
   foundation profile is one proposal input among several and never
   auto-applies.
   See [INSTALL.md](INSTALL.md#first-use-setup) for the full multi-step flow.
   **Adoption assessment (read-only):** for an already-configured project,
   `setup --assess-adoption` reports satisfied items, mandatory gaps, optional
   suggestions, and not-applicable items without writing anything; a
   not-yet-configured project returns `NOT_CONFIGURED` with a pointer to
   first-time setup. Hook-duration suggestions are derived only from events
   produced by the current version; the tool never guesses or writes
   `cacheInputs` for a project.
3. **assess** — read-only readiness:
   ```bash
   "${CLI[@]}" assess --root "$PROJECT" --offline --json
   ```
4. **prepare** — local snapshot and plan freeze:
   ```bash
   "${CLI[@]}" prepare --root "$PROJECT" --offline --json
   ```
5. <a id="release-plan-review"></a>**Human review:** inspect `planPath`, `externalActions`, `targetVersion`, and `planDigest`.
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
   Approval binds the plan digest (`planDigest`), each release unit's target version,
   and the approved action set. Changes to these bindings require a new approval.

   `planVersion: 2` binds the frozen artifacts, configuration, and actions through the digest.
   Workspace baseline drift is record-layer audit data and does not by itself invalidate
   approval; frozen artifacts must still be reverified before publishing.
   `planVersion: 1` retains the legacy binding, including the workspace baseline.

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
      - from: packages/plugin/.claude-plugin/marketplace.json
        to: .claude-plugin/marketplace.json
        mode: preserve
      - from: packages/plugin/.claude-plugin/plugin.json
        to: .claude-plugin/plugin.json
        mode: preserve
      - from: packages/plugin/skills/my-plugin-help/SKILL.md
        to: skills/my-plugin-help/SKILL.md
        mode: preserve
    requiredPublicFiles:
      - package.json
      - .claude-plugin/marketplace.json
      - .claude-plugin/plugin.json
      - skills/my-plugin-help/SKILL.md
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      branchStrategy: create-release-branch
```

This example places the plugin at the snapshot root. Create the four mapped source files
under `packages/plugin` before preparing:

- In `.claude-plugin/marketplace.json`, name the marketplace `my-plugin` and set its `my-plugin` entry's `source` to `"./"`.
- In `.claude-plugin/plugin.json`, set `name` to `my-plugin`, match `version` to `package.json`, and set `skills` to `"./skills/"`.
- The entry file is `skills/my-plugin-help/SKILL.md`, with frontmatter `name: my-plugin-help`.

This minimal Skill references no other files; map any
required resources explicitly if references are added.

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

Hooks run when `prepare` is invoked. Configuring the command and invoking the
workflow authorizes execution without an extra confirmation point. The legacy
`--acknowledge-hook-side-effects` and `--acknowledge-gate-side-effects` flags
remain accepted as no-effect compatibility inputs. Gates are the controlled
extension point for release calibration (see `references/02-project-config.md`).

### postPublish hooks

`postPublish.hooks` declares downstream delivery actions that run after
`publish`; each entry is a named preset or a custom command hook and follows
the same command rules as above (executable/argument arrays, not shell
strings). Presets receive a read-only projection of the frozen plan; custom
command hooks run in the frozen tag worktree. The `materialize` hook is
optional: when it is omitted, `distribute` stages the payload from the
release unit's frozen `publicFiles` mapping through a Foundation managed
projection — a fresh payload root with full preflight, zero-write refusal,
and complete closure rollback — and live project configuration is never
re-read after the plan is frozen:

```yaml
postPublish:
  materialize:
    command: [node, scripts/materialize-payload.mjs]
    cwd: .
    timeoutMs: 600000
    outputMarker: "payload dir: "
  commitIdentity:
    name: release-bot
    email: mzdbxqh@example.com
  hooks:
    - id: mirror-downstream
      preset: git-mirror
      config:
        target:
          remoteUrl: https://gitlab.example.internal/team/my-project.git
          branch: main
    - id: hub-entry-proposal
      preset: proposal-inbox
      phase: postVerify
      requiresApproval: true
      config:
        delivery: git-push
        target:
          remoteUrl: https://github.com/example/hub.git
          branch: main
    - id: custom-notify
      command: [node, scripts/notify-downstream.mjs]
      timeoutMs: 300000
      envAllowlist: [CI]
```

A hook with `requiresApproval: true` parks at `AWAITING_APPROVAL` until a
checkpoint approval is minted and consumed. The approval record is bound to
the plan digest and the hook id, and expires after 24 hours. Frozen plan
approval never includes this checkpoint approval:

```bash
release-skill approve --plan "$PLAN_PATH" --hook hub-entry-proposal --actor "$ACTOR" --json
release-skill ship --root "$PROJECT" --hook-approval "$HOOK_APPROVAL_PATH" --json
```

For an already-configured project, `setup --discover-downstream` and
`setup --propose-hooks` draft these declarations for human review; the
append-only incremental flow is described in the setup step above and in
[INSTALL.md](INSTALL.md#first-use-setup).

## Skills

- `release-help`: environment check and next-step guidance.
- `release-setup`: read-only discovery, human calibration, create-once configuration, and read-only adoption assessment (`setup --assess-adoption`).
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

After `VERIFIED`, the optional `release-finish` workflow can update Claude and
Codex from the frozen marketplace identity, migrate or update Kimi through one
controlled TUI session and verify its real managed payload, or update an existing
bundled-family CodeBuddy/WorkBuddy entry when the frozen tag and mutable branch
both resolve to the frozen commit. It requires explicit user confirmation and
does not change release status. Missing, standalone, inaccessible, or ambiguous
CodeBuddy/WorkBuddy targets remain manual and receive no host mutation.

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
- **not in the current version:** Hook cache v2 (executor-identity receipts, R-05) — the current version keeps the v1 content-bound hook cache and never imports old run evidence; full consumer install-tree scanning (R-02) — only declared files are verified byte-for-byte; and a real-host (Kimi/WorkBuddy) verification gate — host verification stays a design and can never produce `PASS`/`VERIFIED` in this version;
- no automatic README generation or source-file overwrite;
- no automatic conflict merge or rollback workflow;
- no claim that a real production canary has run for marketplace verification;
- `prepare --online` observes previous public baselines (bound mode) and defers
  remote uniqueness checks to publish global preflight;
- no overwrite of branches/tags/releases or npm unpublish; create-only refs use
  `--force-with-lease=<ref>:` solely as an atomic compare-and-set assertion that
  the ref is absent, while existing branches use an ordinary non-force push;
- no Kimi or CodeBuddy/WorkBuddy marketplace install checkpoint in the release
  state machine — optional release-finish can drive and re-check Kimi locally,
  or update an existing CodeBuddy/WorkBuddy entry under strict frozen-identity
  checks, but those results do not become publication evidence;
- no promise of Windows or broad multi-platform native write support;
- no hidden commit, push, tag, release, or package publication.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
