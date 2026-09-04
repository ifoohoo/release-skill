# Changelog

<!-- release-skill:changelog:start version=0.9.12 locale=en baseline=sha256:c2511de86192c1798c17e579bed689c57c450516b10bd85d6a508b0b6e5e19b1 -->
## [0.9.12] - 2026-09-04

0.9.12 is a local source candidate that fixes the frozen postVerify execution closure used to publish verified releases into Skill Family Hub. It retains the 0.9.11 first-release baseline and GitHub-only distribution changes, with the three Foundation dependencies still pinned to the exact 0.17.0 release. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- The repair does not weaken the frozen execution-bundle boundary: the hook still runs from the verified tag plus the digest-bound private script. Hub branch updates remain compare-and-swap operations; a partial Hub publication is retained for recovery and is never rolled back or force-pushed.

### Fixed

- The Hub postVerify hook now imports proposal projection from a dependency-free public module. A detached frozen-tag worktree can load the module without node_modules, while runtime proposal transports continue to use the same implementation through a compatibility re-export.
- The project-private postVerify hook continues to publish verified entries and public snapshots to Skill Family Hub through GitHub's Git Data API.

### Upgrade Notes

Upgrade from 0.9.11 before relying on the bundled `hub-api-publish` postVerify hook. Remove any `release-skill` standalone marketplace registration, add or update `ifoohoo/skill-family-hub`, and use `release-skill@skill-family-hub`. Releases that do not use this hook are unaffected.
<!-- release-skill:changelog:end version=0.9.12 locale=en -->


<!-- release-skill:changelog:start version=0.9.11 locale=en baseline=sha256:c8015d6a26b39a9056c121425b8758a108048d78815476e7bf3d2711cec6ee25 -->
## [0.9.11] - 2026-09-04

0.9.11 is a local source candidate that makes first-release verification advance its public baseline and permits an explicit empty distribution list for GitHub-only plugin releases. It consumes the three Foundation packages at the exact 0.17.0 release. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- First-release baseline advancement runs only after immutable publication verification succeeds. Configuration writes are validated and atomic; restoration failures retain their phase and publication-state details in verification evidence without changing a successful publication result.
- An empty distribution list does not skip the GitHub snapshot, tag, or GitHub Release actions, and it does not grant a marketplace registration.
- Hub branch updates use compare-and-swap against the observed branch head. A partial Hub publication is retained for recovery and is never rolled back or force-pushed.

### Changed

- After a release reaches VERIFIED, a unit whose previous public baseline is `mode: none` is advanced to a bound baseline with the resolved repository and ref plus the exact frozen commit, tree, and manifest digest. Mixed plans and custom in-root config paths use the same existing atomic update path, preserve an explicit GitHub host, and report only units that changed.
- `releaseUnits[].distributions` remains required but may now be an explicit empty list. Such a unit still freezes and publishes its GitHub snapshot, tag, and GitHub Release, while npm and marketplace actions are omitted; postPublish and postVerify hooks remain independent.
- Pinned `skill-family-contracts`, `skill-family-harness-node`, and `skill-family-engineering-kit` dependencies were upgraded from 0.16.0 to the exact published 0.17.0 versions.
- Skill Family Hub remains the single marketplace source. After verification, the project-private postVerify hook applies the Hub proposal and publishes its private entry and public snapshot through GitHub's Git Data API.

### Upgrade Notes

Remove any `release-skill` standalone marketplace registration, add or update `ifoohoo/skill-family-hub`, and use `release-skill@skill-family-hub`. Use `distributions: []` only when the release unit is intentionally GitHub-only and marketplace registration is handled by an independent verified workflow. Existing non-empty distribution lists keep their behavior. After installing or reloading the official 0.9.11 release, a historical first release may be reverified without republishing; confirm that its configured previous public baseline changed from `none` to the verified frozen coordinates.
<!-- release-skill:changelog:end version=0.9.11 locale=en -->


<!-- release-skill:changelog:start version=0.9.10 locale=en baseline=sha256:4cd32926b3d8e0da10ec909f58268636c3e6025f59cd7f24d313460cf5524b7b -->
## [0.9.10] - 2026-09-04

0.9.10 is a local source candidate that removes release-skill's private marketplace and makes Skill Family Hub the single marketplace source. It consumes the three Foundation packages at the exact 0.16.0 release. The release workspace publishes a verified entry and the Hub's seven-file public snapshot through GitHub's Git Data API after verification. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- Hub branch updates are compare-and-swap writes against the observed main commit. Concurrent movement fails closed; a public-Hub failure after the private commit is retained as a recoverable partial result and is never rolled back or force-pushed.

### Changed

- Removed the bundled Claude, Codex, and adapter marketplace indexes from the release-skill package. Plugin manifests remain available for installation through Skill Family Hub.
- Installation guidance now uses `ifoohoo/skill-family-hub` and `release-skill@skill-family-hub` for Claude Code, Codex, CodeBuddy, and WorkBuddy.
- After a release reaches VERIFIED, the project-private postVerify hook applies the proposal with the Hub's own receiver, runs the Hub release gate once, and publishes the private and public Hub commits through GitHub's Git Data API with non-forced branch updates.

### Upgrade Notes

Remove any `release-skill` standalone marketplace registration from each host, add or update `ifoohoo/skill-family-hub`, and install `release-skill@skill-family-hub`.
<!-- release-skill:changelog:end version=0.9.10 locale=en -->


<!-- release-skill:changelog:start version=0.9.9 locale=en baseline=sha256:44d7cba7d5e4cbe182157c8b200e3a2d9b494d61a9555cd5af5c62c97a60fb37 -->
## [0.9.9] - 2026-09-04

0.9.9 is a local source candidate that makes Kimi Code plugin trust compare the complete displayed installation identity with the frozen URL. It consumes the three Foundation packages at the exact 0.16.0 release. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- Kimi Code extracts the complete installation identity from the plugin trust dialog, removes ANSI/OSC control sequences and soft wrapping, and compares the result exactly with the frozen installation URL. Similar repository names and tag prefixes or suffixes fail closed.
- Claude and Codex continue to verify the frozen marketplace repository, ref, and commit before the first marketplace or plugin write when a rebind is required. An unreachable remote, missing ref, or commit mismatch returns `MANUAL_REQUIRED` for that host with zero host writes; other selected hosts continue.
- Kimi Code continues only when the selected row is confirmed as `Trust and install`. A `Trust this folder?` dialog, an unknown screen, timeout, EOF, or mismatched identity fails closed before unintended confirmation.
- Any host plan remains a qualified frozen-plan path and requires a VERIFIED-run from the same release lineage before host acceptance; this source candidate does not provide that acceptance.

### Changed

- The English and Chinese README scope descriptions identify 0.9.9 as the current source candidate.
- The public release-finish flow continues to treat a `proposal-inbox` postVerify hook as proposal delivery plus delivery evidence. The receiver applies, renders, and synchronizes the proposal under its own runbook and governance; no Hub repository or push sequence is built into the public Skill.
- Kimi Code continues to resolve its effective configuration root from explicit `kimiHome`, then `KIMI_CODE_HOME`, then `~/.kimi-code`; the TUI process and post-install observation use the same root.
- The current 0.9.9 candidate keeps the narrow R-05 Hook cache v2 consumer path, keeps the CodeBuddy plugin entry explicit as `marketplace: release-skill`, and keeps `--root <project-root>` in release-finish local-finish examples. Foundation dependencies remain pinned to the three released 0.16.0 packages.

### Upgrade Notes

Prepare and approve a new 0.9.9 production plan for these changes. After verify reaches `VERIFIED`, complete every declared postVerify hook with its own immutable checkpoint approval before running release-finish. Real-host acceptance can begin only after 0.9.9 is officially published and VERIFIED; the official 0.9.9 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update. On the second run, Claude, Kimi, CodeBuddy, and WorkBuddy must report `ALREADY_CURRENT`; Codex may report `UPDATED` only when it reinstalls the same exact 0.9.9 frozen reference, payload validation passes, and `restartRequired=true` is declared. The local updater uses the Kimi Code TUI path verified for 0.40.1; it does not switch to a web or REST installation path. Confirm that the complete frozen installation URL shown by the plugin trust dialog is exact, and never approve a folder-trust dialog as part of plugin installation. This candidate does not claim that 0.9.9 has already been published or VERIFIED.
<!-- release-skill:changelog:end version=0.9.9 locale=en -->


<!-- release-skill:changelog:start version=0.9.8 locale=en baseline=sha256:ed56048811dd7946bfdaa4022d0430906db713ef86eed1528395dbfb031b075e -->
## [0.9.8] - 2026-09-04

0.9.8 is a local source candidate that makes release-finish safe across receiver boundaries and current local hosts. It removes Hub-specific work from the public finishing flow, verifies frozen Claude and Codex marketplace identities before rebind writes, supports the Kimi Code 0.40.1 TUI, and skips empty distribute runs for plans that contain only postVerify hooks. It consumes the three Foundation packages at the exact 0.16.0 release. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- Claude and Codex verify the frozen marketplace repository, ref, and commit before the first marketplace or plugin write when a rebind is required. An unreachable remote, missing ref, or commit mismatch returns `MANUAL_REQUIRED` for that host with zero host writes; other selected hosts continue.
- Kimi Code plugin trust proceeds only when the dialog contains the frozen repository and tag and the selected row is confirmed as `Trust and install`. A `Trust this folder?` dialog, an unknown screen, timeout, EOF, or mismatched identity fails closed before unintended confirmation.
- Kimi Code reports success only after the TUI displays its install-finished result and the installed registry, package version, tag, revision, managed root, and payload all match the frozen plan.
- Any host plan remains a qualified frozen-plan path and requires a VERIFIED-run from the same release lineage before host acceptance; this source candidate does not provide that acceptance.

### Changed

- The public release-finish flow treats a `proposal-inbox` postVerify hook as proposal delivery plus delivery evidence. The receiver applies, renders, and synchronizes the proposal under its own runbook and governance; no Hub repository or push sequence is built into the public Skill.
- Local-host ordering follows each host's frozen installation source. Receiver completion is not a universal prerequisite for updating unrelated hosts.
- Kimi Code resolves its effective configuration root from explicit `kimiHome`, then `KIMI_CODE_HOME`, then `~/.kimi-code`; the TUI process and post-install observation use the same root.
- The Kimi Code 0.40.1 TUI path normalizes ANSI/OSC control sequences and soft-wrapped URLs, uses a wide pseudo-terminal, submits commands through bracketed paste plus CSI Enter, and waits for explicit prompt, trust, install-result, reload, and exit states.
- A single phase-aware postPublish predicate now requires distribute only for targets, explicit distribute hooks, or hooks whose omitted phase defaults to distribute. A plan containing only postVerify hooks moves from PUBLISHED directly to verify and runs postVerify independently after VERIFIED.
- The current 0.9.8 candidate includes the narrow R-05 Hook cache v2 consumer path, keeps the CodeBuddy plugin entry explicit as `marketplace: release-skill`, and keeps `--root <project-root>` in release-finish local-finish examples. Foundation dependencies are pinned to the three released 0.16.0 packages.

### Upgrade Notes

Prepare and approve a new 0.9.8 production plan for these changes. After verify reaches `VERIFIED`, complete every declared postVerify hook with its own immutable checkpoint approval before running release-finish. Real-host acceptance can begin only after 0.9.8 is officially published and VERIFIED; the official 0.9.8 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update. On the second run, Claude, Kimi, CodeBuddy, and WorkBuddy must report `ALREADY_CURRENT`; Codex may report `UPDATED` only when it reinstalls the same exact 0.9.8 frozen reference, payload validation passes, and `restartRequired=true` is declared. The local updater uses the Kimi Code TUI path verified for 0.40.1; it does not switch to a web or REST installation path. Confirm the frozen repository and tag shown by the plugin trust dialog, and never approve a folder-trust dialog as part of plugin installation. This candidate does not claim that 0.9.8 has already been published or VERIFIED.
<!-- release-skill:changelog:end version=0.9.8 locale=en -->


<!-- release-skill:changelog:start version=0.9.7 locale=en baseline=sha256:6e411cb3026241b30954e2f23e0eadc8674b3531927e8c5069c92b46749fdb01 -->
## [0.9.7] - 2026-09-02

0.9.7 is a local source candidate that retains the 0.9.6 postverify and isolated install-tree safeguards and corrects verify's bundled-family install-root coordinate: when an adapter `installPath` is already the installed plugin root, manifest `skills` are interpreted relative to `.`. It consumes the three Foundation packages at the exact 0.16.0 release. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- `postverify` binds `planDigest`, the source `VERIFIED` run, each `hookId`, and its immutable hook approval; expired or mismatched approvals fail closed before hook execution, without adding a second state or authority.
- Declared payload symlinks, frozen-source symlinks, and legacy install-tree symlinks continue to fail closed; host-added symlinks are recorded as raw targets only.
- Missing paths, files, and symlinks continue to fail closed.
- Any host plan remains a qualified frozen-plan path and requires a VERIFIED-run from the same release lineage before host acceptance; this source candidate does not provide that acceptance.

### Changed

- When an adapter `installPath` is already the installed plugin root, verify interprets the manifest's `skills` path relative to `.`. prepare and publish keep their frozen-snapshot coordinates unchanged.
- Allow multiple frozen host manifests to share one non-empty canonical source Skill surface; closure scans that surface once while host coverage retains every declared host.
- Before any external write, publish re-derives the frozen manifest claims and rechecks the closure.
- Consumer install paths remain isolated by host realpath; overlapping realpaths fail closed.
- Retain the public `postverify` path and the stable isolated install-tree record path; this candidate does not expand standalone-index or host acceptance support.
- Use Foundation 0.16.0 `createFilesystemRootBinding` and `observeFilesystemTree` in record mode for Claude and Codex marketplace install-tree observation; ordinary files keep the existing comparison, directories stay out of extra installed paths, and the frozen `manifestDigest` remains unchanged.
- Keep the narrow R-05 Hook cache v2 consumer path, the explicit CodeBuddy plugin entry (`marketplace: release-skill`), and `--root <project-root>` in release-finish local-finish examples.

### Upgrade Notes

Prepare a new 0.9.7 plan when adopting this candidate. The `postverify` command requires the same plan digest, a source `VERIFIED` run, and an immutable approval for each declared hook; an expired or mismatched approval stops before hook execution. Real-host acceptance can begin only after 0.9.7 is officially published and VERIFIED; the official 0.9.7 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update. On the second run, Claude, Kimi, CodeBuddy, and WorkBuddy must report `ALREADY_CURRENT`; Codex may report `UPDATED` only when it reinstalls the same exact 0.9.7 frozen reference, payload validation passes, and `restartRequired=true` is declared. Before the official 0.9.7 release and VERIFIED result, do not claim that GLAF4 passed. After the official 0.9.7 release, the original GLAF4 0.5.4 immutable plan and PUBLISHED run can be reverified; GLAF4 does not need to be reissued. This source candidate does not claim publication, GLAF4 acceptance, or consumer-installation verification.
<!-- release-skill:changelog:end version=0.9.7 locale=en -->


<!-- release-skill:changelog:start version=0.9.6 locale=en baseline=sha256:cc19a29543385bc4fbb52ac576b2310bca4b6963121dce82ada0ac933e237bfd -->
## [0.9.6] - 2026-09-02

0.9.6 is a local source candidate that adds a public `postverify` CLI for same-lineage postPublish hooks without ship state, and records host-added symlinks in Claude and Codex marketplace install trees without following them. It consumes the three Foundation packages at the exact 0.16.0 release. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- `postverify` binds `planDigest`, the source `VERIFIED` run, each `hookId`, and its immutable hook approval; expired or mismatched approvals fail closed before hook execution, without adding a second state or authority.
- Declared payload symlinks, frozen-source symlinks, and legacy install-tree symlinks continue to fail closed; host-added symlinks are recorded as raw targets only.
- Any host plan remains a qualified frozen-plan path and requires a VERIFIED-run from the same release lineage before host acceptance; this source candidate does not provide that acceptance.

### Added

- Add the public `postverify` command for phase-by-phase `prepare` → `approve` → `publish` → `distribute` → `verify` lineages that need to run approved postPublish hooks without a ship state or a second authority.
- Record host-added symlinks in Claude and Codex marketplace install trees as paths and raw targets without following them, while keeping declared and frozen symlinks fail-closed.

### Changed

- Use Foundation 0.16.0 `createFilesystemRootBinding` and `observeFilesystemTree` in record mode for Claude and Codex marketplace install-tree observation; ordinary files keep the existing comparison, directories stay out of extra installed paths, and the frozen `manifestDigest` remains unchanged.
- Keep the narrow R-05 Hook cache v2 consumer path and the stable isolated install-tree record path; this candidate does not expand standalone-index or host acceptance support.
- Retain the explicit CodeBuddy plugin entry (`marketplace: release-skill`) and `--root <project-root>` in release-finish local-finish examples.

### Upgrade Notes

Prepare a new 0.9.6 plan when adopting these changes. The `postverify` command requires the same plan digest, a source `VERIFIED` run, and an immutable approval for each declared hook; an expired or mismatched approval stops before hook execution. Real-host acceptance still requires an officially published and VERIFIED release; the official 0.9.6 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update. On the second run, Claude, Kimi, CodeBuddy, and WorkBuddy must report `ALREADY_CURRENT`; Codex may report `UPDATED` only when it reinstalls the same exact 0.9.6 frozen reference, payload validation passes, and `restartRequired=true` is declared. This source candidate does not claim publication, GLAF4 acceptance, Hub postVerify, or consumer-installation verification.
<!-- release-skill:changelog:end version=0.9.6 locale=en -->

<!-- release-skill:changelog:start version=0.9.5 locale=en baseline=sha256:21c87f71244641b1819ee77ca067f65fd29caa64e42229184cd552b82829d86b -->
## [0.9.5] - 2026-09-02

0.9.5 is a local source candidate that closes the postVerify-to-local-finish lifecycle, recognizes the supported real host install commands, and tightens standalone-index marketplace identity checks. It consumes the three Foundation packages at the exact 0.16.0 release. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- Local finishing fails closed when the canonical plan or run evidence is missing, mismatched, incomplete, or not linked to the same VERIFIED lineage; host detection and host writes do not start on that path.
- Any host plan remains a qualified frozen-plan path and requires a VERIFIED-run from the same release lineage before host acceptance; this source candidate does not provide that acceptance.

### Added

- Require completed postVerify evidence, including same-lineage VERIFIED data and every declared checkpoint, before any local host update is probed or executed. Incomplete postVerify evidence returns a bound `ship` continuation when state evidence is available.
- Add the explicit `manual-index-checkpoint` first-release bootstrap path for Claude and Codex standalone-index distributions. The plan binds the expected plugin identity and leaves the final marketplace index commit pending until verify observes the remote index.

### Changed

- Recognize the supported real host install commands and environment boundaries separately for CodeBuddy and WorkBuddy; unsupported WorkBuddy platforms are reported without invoking a host command.
- Require first-release bootstrap plans to observe an empty plugin repository without the target tag or GitHub Release, then match the marketplace name and selected entry exactly before continuing.
- Preserve the complete selected marketplace entry metadata for ordinary non-bootstrap remote distributions while deriving verification identity only from the platform-owned fields.
- The CodeBuddy plugin declares `marketplace: release-skill`, and both release-finish local-finish examples pass `--root <project-root>`.
- Keep the narrow R-05 Hook cache v2 consumer path in the current 0.9.5 candidate; this does not add a broader Hook cache or host acceptance surface.

### Upgrade Notes

Prepare a new 0.9.5 plan when adopting these changes. Complete postVerify with `ship` before running post-release when the checklist reports `COMPLETE_POST_VERIFY`. Real-host acceptance can begin only after 0.9.5 is officially published and VERIFIED; the official 0.9.5 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update. On the second run, Claude, Kimi, CodeBuddy, and WorkBuddy must report `ALREADY_CURRENT`; Codex may report `UPDATED` only when it reinstalls the same exact 0.9.5 frozen reference, payload validation passes, and `restartRequired=true` is declared. A first-release bootstrap uses `manual-index-checkpoint` only for Claude or Codex standalone-index distributions and requires a manual index checkpoint during verify; it does not add general standalone-index support. This source candidate does not provide real-host acceptance.
<!-- release-skill:changelog:end version=0.9.5 locale=en -->


<!-- release-skill:changelog:start version=0.9.4 locale=en baseline=sha256:bd122e1e4f28539503d3bdd702f73cbabc675dc7006f750cc38ff08544b72dc5 -->
## [0.9.4] - 2026-09-01

0.9.4 is a local source candidate that lets multi-unit projects freeze and approve an explicit safe release scope while deferring unrelated units. It consumes the three Foundation packages at the exact 0.16.0 release. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- Ship persists an explicit unit request only before plan freeze and rejects attempts to change it while resuming the same state. Once external writes begin, partial success remains `PARTIAL` and recovery stays forward-only within the original plan.
- Any host plan remains a qualified frozen-plan path and requires a VERIFIED-run before host acceptance; this source candidate does not provide that acceptance.

### Added

- Add repeatable `--unit <id>` selection to prepare and the pre-freeze ship path. Successful explicit selection reports selected and deferred unit IDs plus the exact next prepare command for deferred units.
- Require an explicitly selected scope to include the complete existing `publicSourceAuthorityReceipt` dependency closure. The command reports missing units and stops before hooks, snapshots, or plan writes instead of expanding the scope automatically.

### Changed

- Run unit-scoped document, version, snapshot, distribution, and verification-gate work only for selected units. Project configuration validation, generated-artifact freshness checks, and top-level hooks still cover the whole project.
- Keep `plan.units` as the only frozen release-scope authority. Publish, reconcile, verify, and distribute continue to consume the complete frozen plan and do not accept a new unit selector.
- Consume skill-family-contracts, skill-family-harness-node, and skill-family-engineering-kit at the exact 0.16.0 release through their public package-root APIs. The CodeBuddy plugin declares marketplace: release-skill, and both release-finish local-finish examples pass --root <project-root>.
- For CodeBuddy, treat only the closed plugin-management command set as eligible to consume complete read-only output when the CLI reports childExitCode 0 but leaves a residual process group; retain the Foundation anomaly and completed SIGTERM cleanup as observable facts, run each write command at most once, and require the final plugin version and commit to match exactly. This handling does not extend to WorkBuddy or change release status.
- Improve Kimi TUI prompt matching for ANSI boxed prompts and `>` characters in command output, so trust-and-install and reload prompts are recognized without treating ordinary output as an input prompt.

### Upgrade Notes

Existing commands that omit `--unit` keep the full configured release scope. Multi-unit projects may repeat `--unit` on prepare or on a new ship state to defer unrelated units. Review `releaseScope.deferredUnitIds` and the approval summary before approving. A scope that touches `publicSourceAuthorityReceipt` must include its coordinator and every subject. Do not add `--unit` to publish, reconcile, verify, or distribute; those commands must execute the complete frozen plan. Real-host acceptance can begin only after 0.9.4 is officially published and VERIFIED; the official 0.9.4 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update. On the second run, Claude, Kimi, CodeBuddy, and WorkBuddy must report `ALREADY_CURRENT`; Codex may report `UPDATED` only when it reinstalls the same exact 0.9.4 frozen reference, payload validation passes, and `restartRequired=true` is declared.
<!-- release-skill:changelog:end version=0.9.4 locale=en -->


<!-- release-skill:changelog:start version=0.9.3 locale=en baseline=sha256:96e5f9167abb13203ba308ebacbb081452f8c23e26ff0b377514556338ebdfff -->
## [0.9.3] - 2026-08-31

0.9.3 is a local source candidate for the four workflow safeguards and the narrow Hook cache v2 and isolated-install-tree integrations. It consumes the three Foundation packages at the exact 0.15.0 release. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- Unknown, corrupt, non-stable, or unsupported observations remain fail-closed. A cache hit never replaces a Hook execution when the authority or identity evidence is unavailable, and no TTL or ambient PATH inference is used.
- Any host plan remains a qualified frozen-plan path and requires a VERIFIED-run before host acceptance; this source candidate does not provide that acceptance.

### Added

- Add the opt-in pre-hook public-surface check, ship help and target-version conflict guard, verify lineage guidance, and evidence-based adoption suggestions without adding a new command, state, or approval authority.
- Add the narrow Hook cache v2 consumer path: absolute-path and validated cwd-relative executable identity, closed input and environment binding, no TTL, and fail-closed cache reuse for bare PATH, PATHEXT, Windows, and unavailable observations while Hooks still execute cold.
- Add the narrow isolated install-tree record path after a completed host command, recording host-added links without following them and rejecting declared-payload symlinks while preserving legacy full-tree semantics.

### Changed

- Consume skill-family-contracts, skill-family-harness-node, and skill-family-engineering-kit at the exact 0.15.0 release through their public package-root APIs.
- Keep the 0.9.2 production plan PREPARED and immutable as an unpublished historical record now replaced by the 0.9.3 candidate; with an explicit target, only unfinished records that pass complete run, plan, digest/binding, and lineage validation and whose plan target matches participate in current recovery, while all other history remains diagnostics. Without a target, route still shows full-history diagnostics, but workflow selection remains based on the current diff and baseline.
- The CodeBuddy plugin explicitly declares marketplace: release-skill, and both release-finish local-finish examples pass --root <project-root>.

### Upgrade Notes

Real-host acceptance can begin only after 0.9.3 is officially published and VERIFIED; the official 0.9.3 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update. On the second run, Claude, Kimi, CodeBuddy, and WorkBuddy must report `ALREADY_CURRENT`; Codex may report `UPDATED` only when it reinstalls the same exact 0.9.3 frozen reference, payload validation passes, and `restartRequired=true` is declared. The 0.9.2 plan was never published and remains an immutable historical record. With an explicit target, only unfinished records that pass complete run, plan, digest/binding, and lineage validation and whose plan target matches participate in current recovery; all other history remains diagnostics. Without a target, route still shows full-history diagnostics, but workflow selection remains based on the current diff and baseline.
<!-- release-skill:changelog:end version=0.9.3 locale=en -->


<!-- release-skill:changelog:start version=0.9.2 locale=en baseline=sha256:748e2f51de3ee9b773ddc2f0f2ffccb3756065c814ec218dffc738364ad25630 -->
## [0.9.2] - 2026-08-30

0.9.2 is a local source candidate for two release-finish maintenance updates and a route recovery maintenance update. Foundation remains pinned to 0.14.0, whose public temporary-workspace and raw-output APIs pass the default Node.js 22 macOS consumer composition. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- The release-finish maintenance keeps the qualified frozen-plan boundary and the VERIFIED-run requirement; the consumer test combines the public withTemporaryWorkspace and superviseProcess.rawSink APIs under the default Node.js 22 macOS temporary directory.

### Changed

- Self-bootstrap now declares marketplace: release-skill explicitly for the CodeBuddy plugin.
- Both release-finish local-finish examples now pass --root <project-root> explicitly.
- Route recovery now skips only failed publish attempts that the current evidence-v2 writer contract proves never acquired release authority; unknown or corrupt history remains blocking DIAGNOSE with an exact path and formal next action.

### Upgrade Notes

Real-host acceptance can begin only after 0.9.2 is officially published and VERIFIED; the official 0.9.2 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update. On the second run, Claude, Kimi, CodeBuddy, and WorkBuddy must report `ALREADY_CURRENT`; Codex may report `UPDATED` only when it reinstalls the same exact 0.9.2 frozen reference, payload validation passes, and `restartRequired=true` is declared. In the current workspace, route still reports 63 DIAGNOSE records and 2 VERIFY records; the first UNKNOWN legacy record has no automatic safe recovery entry and requires the formal diagnostic action.
<!-- release-skill:changelog:end version=0.9.2 locale=en -->


<!-- release-skill:changelog:start version=0.9.1 locale=en baseline=sha256:71720f2bbde891ebccda25baf35ef03593d1f6aee1077aeccb3b4af4d2eddfc0 -->
## [0.9.1] - 2026-08-28

0.9.1 is a local source candidate for safer post-release host finishing. It now pins Foundation 0.14.0, whose public temporary-workspace and raw-output APIs pass the default Node.js 22 macOS consumer composition. This note is not evidence of publication, real-host acceptance, consumer installation verification, or independent acceptance.

### Security

- Real-host acceptance requires a qualified frozen release plan and a VERIFIED run from the same release lineage. The workflow confirms the exact plan digest and selected hosts before any host write. release-skill's optional local finishing never changes the terminal release state.

### Changed

- Pin skill-family-contracts, skill-family-harness-node, and skill-family-engineering-kit together at 0.14.0. A consumer test now combines the public withTemporaryWorkspace and superviseProcess.rawSink APIs under the default Node.js 22 macOS temporary directory.
- Derive platform-manifest.json version ownership from package.json.version and check manifest freshness before prepare runs hooks, including docs-only and config-only workflows.
- Expand ship's plan-approval summary from the frozen plan so reviewers can see public repositories, branch strategies, tags, npm targets, GitHub Releases, external action targets, waivers, and separately gated postPublish hooks.
- Claude now re-observes the installed plugin after marketplace rebinding before deciding whether a plugin update is still required. Codex keeps the formal frozen-marketplace reinstall path.
- Kimi accepts a managed installation without a .git directory when the package name, version, release tag, installed revision, managed root, and real payload all match. Legacy local-path entries are removed and reinstalled from the pinned release tag in one controlled TUI session.
- CodeBuddy/WorkBuddy can update an existing bundled-family entry only when one remote query proves that the frozen tag and mutable marketplace branch both resolve to the frozen commit. The final installed list must contain exactly one entry with the expected marketplace, version, and revision.

### Fixed

- Prevent prepare from freezing a stale platform manifest into the public snapshot or npm tarball.
- Remove the misleading claim that plan approval includes a requiresApproval postPublish checkpoint. Plan approval remains the single normal release-level approval; each gated postPublish hook needs its own approval record, bound to the plan digest and hook id for at most 24 hours.
- Avoid a redundant Claude plugin update after marketplace rebinding has already removed or replaced the old installed entry.
- Classify legacy Kimi local-path installations before managed-root checks so they can follow the explicit migration path.
- Keep CodeBuddy/WorkBuddy host state unchanged when the target is absent, standalone, inaccessible, ambiguous, or inconsistent with the frozen release identity.

### Upgrade Notes

Real-host acceptance can begin only after 0.9.1 is officially published and VERIFIED; the official 0.9.1 entry must be installed or reloaded first. A source candidate, an older installed entry, or the mere existence of plan and run files cannot complete real-host acceptance. Each selected host must complete a first successful update and a second run that reports `ALREADY_CURRENT`.
<!-- release-skill:changelog:end version=0.9.1 locale=en -->


<!-- release-skill:changelog:start version=0.9.0 locale=en baseline=sha256:80f51046ce63386f75ed1a2b869cf3245732e9a1b040e11eb8942dba5f7c8fed -->
## [0.9.0] - 2026-08-28

0.9.0 is a local source candidate for multi-unit postPublish plans and optional post-release local finishing. This note records the intended scope and verification boundaries; it is not evidence of publication, consumer-installation verification, or independent acceptance. Release availability must be established from the corresponding release records and post-publish verification results.

### Security

- release-finish requires a plan-digest confirmation and a VERIFIED run from the same release lineage before any host command. Host updates use a restricted environment; Claude/Codex exact results are bound to the real installed payload, and every host fails closed when the identity evidence its protocol can provide is insufficient.

### Added

- Plan version 3 freezes postPublish declarations per release unit as an ordered array. Each declaration carries its own targets, hooks, approval binding, execution bundle, checkpoints, and postVerify continuation while explicit plan versions 1 and 2 retain their established single-declaration behavior.
- A new release-finish workflow derives a read-only local checklist from the frozen plan and VERIFIED run. After explicit user confirmation it can update Claude and Codex, drive the Kimi TUI and verify the resulting installation, or confirm that CodeBuddy/WorkBuddy already matches the frozen identity; CodeBuddy/WorkBuddy updates that cannot pin the frozen ref remain manual. None of these local actions changes the published release terminal state.

### Changed

- The distribute and postVerify phases preflight every declaration before the first external write, then re-observe mutable remote proposal state during execution. Checkpoint identifiers are namespaced by release unit, and an earlier hook failure skips all later-unit work.
- PostPublish hook identifiers are unique across the complete plan. Prepare, setup, approval, distribute, and postVerify consume the same validation rule before side effects.

### Fixed

- Prevent a later unit's missing bundle or deterministic proposal conflict from being discovered only after an earlier unit has already written remotely.
- Preserve PARTIAL when a checkpoint has succeeded before a later failure, and preserve BLOCKED when no external checkpoint succeeded.
- Prevent duplicate target names and duplicate hook identifiers from collapsing evidence or approval identity across release units.

### Upgrade Notes

Prepare a new 0.9.0 plan to use plan version 3; do not edit or upgrade frozen older plans. Plan versions 1 and 2 remain readable only through their explicit compatibility path. release-finish is optional local follow-up, not publication evidence: branch merges, Kimi trust prompts, and local host changes still require explicit user consent, and unsupported exact-ref updates remain manual. Hook cache v2, safe full-tree inventory, the Audit offline release-record verifier, and mandatory public-marketplace host invocation gates remain outside this version.
<!-- release-skill:changelog:end version=0.9.0 locale=en -->


<!-- release-skill:changelog:start version=0.8.1 locale=en baseline=sha256:c1dcef984b85d6da26cba7f15225d03f1cbaedc510a7c63149306d49a2c5532e -->
## [0.8.1] - 2026-08-27

0.8.1 is a local source candidate. This note records its intended scope and verification boundaries; it is not evidence of publication, consumer-installation verification, or independent acceptance. Release availability must be established from the corresponding release records and post-publish verification results. The fresh 0.8.1 coordinate avoids overwriting the different public bytes already published as v0.8.0.

### Security

- The occupied v0.8.0 tag and npm coordinate are not overwritten or reused. v0.8.1 receives a newly frozen plan, approval, tag, package, release, and post-publish verification lineage.

### Changed

- Pin all three Foundation dependencies to released 0.13.0 packages. Packaging uses the existing generators for runtime resources, native files, legal materials, host profiles, and plugin-verification contracts.
- Reuse Foundation runPluginVerification for complete local payload observation of frozen Kimi and CodeBuddy bundled-family plugins. CodeBuddy maps to Foundation's compatible workbuddy host. Marketplace installation and host invocation remain explicit manual follow-ups; Foundation observations do not replace release-domain gates or three-role README acceptance.
- Evidence v2 closes the top level and stores phase extensions in typed details. Evidence v1 remains read-only. Summaries, producer versions, and recovery suggestions are diagnostic, never publication authority.

### Fixed

- Config branch A keeps zero external actions and no sourceAuthority, even with a configured public source receipt. Production branch B and docs production freeze plan.sourceAuthority and retain remote consistency checks. Marketplace delegation is unchanged.
- Fixes cover installed host surfaces, release-run lineage, Git hooks in frozen checkouts, pure configuration checks before long hooks, and adoption assessment. Focused self-tests verify their stated cases but do not establish publication, consumer installation, or independent candidate acceptance.
- FAILED summaries, compatibility details, and returned errors now project the same domain recovery result when current-run evidence is available. Existing fallbacks, unknown without evidence, and successful verify null suggestions remain unchanged.

### Upgrade Notes

Old production plans missing sourceAuthority and checker v4 plans must not be silently upgraded; when no external writes occurred, prepare again and approve the new digest. Do not migrate old approvals or evidence. Preserve existing PARTIAL checkpoints and use matching-version recovery. Hook cache v1 is unchanged; old full-test evidence is not imported. R-02 safe full-tree inventory, R-05 Hook cache v2, R-10 implementation, real Kimi/WorkBuddy public-marketplace installation and invocation gates, and the Audit public offline release-record verifier are excluded.
<!-- release-skill:changelog:end version=0.8.1 locale=en -->


<!-- release-skill:changelog:start version=0.8.0 locale=en baseline=sha256:3c6e847e287cd7d0f56929466bd7e71c1da208c53063a04f94c81fa6804217a9 -->
## [0.8.0] - 2026-08-26

0.8.0 is a local source candidate. This note records its intended scope and verification boundaries; it is not evidence of publication, consumer-installation verification, or independent acceptance. Release availability must be established from the corresponding release records and post-publish verification results.

### Changed

- Pin all three Foundation dependencies to released 0.13.0 packages. Packaging uses the existing generators for runtime resources, native files, legal materials, host profiles, and plugin-verification contracts.
- Reuse Foundation runPluginVerification for complete local payload observation of frozen Kimi and CodeBuddy bundled-family plugins. CodeBuddy maps to Foundation's compatible workbuddy host. Marketplace installation and host invocation remain explicit manual follow-ups; Foundation observations do not replace release-domain gates or three-role README acceptance.
- Evidence v2 closes the top level and stores phase extensions in typed details. Evidence v1 remains read-only. Summaries, producer versions, and recovery suggestions are diagnostic, never publication authority.

### Fixed

- Config branch A keeps zero external actions and no sourceAuthority, even with a configured public source receipt. Production branch B and docs production freeze plan.sourceAuthority and retain remote consistency checks. Marketplace delegation is unchanged.
- Fixes cover installed host surfaces, release-run lineage, Git hooks in frozen checkouts, pure configuration checks before long hooks, and adoption assessment. Focused self-tests verify their stated cases but do not establish publication, consumer installation, or independent candidate acceptance.
- FAILED summaries, compatibility details, and returned errors now project the same domain recovery result when current-run evidence is available. Existing fallbacks, unknown without evidence, and successful verify null suggestions remain unchanged.

### Upgrade Notes

Old production plans missing sourceAuthority and checker v4 plans must not be silently upgraded; when no external writes occurred, prepare again and approve the new digest. Do not migrate old approvals or evidence. Preserve existing PARTIAL checkpoints and use matching-version recovery. Hook cache v1 is unchanged; old full-test evidence is not imported. R-02 safe full-tree inventory, R-05 Hook cache v2, R-10 implementation, real Kimi/WorkBuddy public-marketplace installation and invocation gates, and the Audit public offline release-record verifier are excluded.
<!-- release-skill:changelog:end version=0.8.0 locale=en -->


<!-- release-skill:changelog:start version=0.7.8 locale=en baseline=sha256:058929eb1d0fa2abb8488f1b7f736da9046ac494c312057767d649f792bb9b81 -->
## [0.7.8] - 2026-08-24

v0.7.8 lets a fresh publish safely accept an npm version that already contains the exact frozen tarball, without executing npm publish again.

### Security

- **Fail-closed integrity check**: a different, missing, blank, or unparseable observed integrity stops the run before any adapter execute. The existing classifier, approval model, and forward-recovery state machine remain unchanged.
- **Checkpoint evidence**: a matching skipped npm checkpoint records only the observed integrity in `remoteRef.integrity`; package, version, registry, expected integrity, and tarball SHA-256 remain authoritative in the frozen plan.

### Fixed

- **Existing npm version recovery**: when npm preflight finds the target version already published, publish compares the registry observation with the immutable plan. An exact match becomes `SKIPPED`, the npm execute count stays zero, and the remaining release actions continue.

### Upgrade Notes

No configuration or migration is required. Existing release-run files remain valid because `remoteRef.integrity` is optional.
<!-- release-skill:changelog:end version=0.7.8 locale=en -->


<!-- release-skill:changelog:start version=0.7.7 locale=en baseline=sha256:bdd8a5cd123e916f5581051c7138f56572b35b3640187551aca6faa453ea1a51 -->
## [0.7.7] - 2026-08-24

v0.7.7 can publish a small public source-authority receipt that binds an exact source repository and commit to one or more frozen npm tarballs.

### Security

- **Remote commit binding**: publish now requires the remotely observed source commit to equal the receipt's frozen `sourceBaseCommit` before any adapter preflight or write. Verify and reconcile retain the same constraint.
- **Actual tarball verification**: offline receipt verification reopens every frozen subject tgz with the existing no-follow, file-identity, digest, package-name, and package-version checks before accepting its receipt entry.

### Added

- **Optional public source authority**: projects may declare `publicSourceAuthorityReceipt` with one coordinator release unit and one or more npm subject units. Production prepare freezes canonical `source-authority-receipt.json` bytes from the normalized source repository, baseline commit, package name, version, tarball filename, and SHA-256. Publish then uploads those exact bytes as a GitHub Release asset.

### Upgrade Notes

`publicSourceAuthorityReceipt` is optional. Existing projects require no configuration or migration; enable it only when a release needs the public source-authority asset.
<!-- release-skill:changelog:end version=0.7.7 locale=en -->


<!-- release-skill:changelog:start version=0.7.6 locale=en baseline=sha256:16665362b8c0f06b7ed94f2839f5b380216b13ca6ab5e6c51b043985f8a8c8c2 -->
## [0.7.6] - 2026-08-22

v0.7.6 executes every schema-declared prepare hook and corrects the documented postPublish hierarchy while preserving the current hook authorization and Codex adapter-root semantics.

### Changed

- **Codex adapter contract coverage**: isolated-copy and negative path tests now preserve the existing self-contained adapter root: the host-provided skill path matches `PLUGIN_ROOT/skills/<skill>/SKILL.md`, and the launcher remains `PLUGIN_ROOT/bin/release-skill.mjs`. This is contract hardening, not a runtime protocol change.
- **Hook authorization remains unchanged**: configuring a hook and invoking its workflow authorizes execution without a separate confirmation point. The legacy acknowledgement flags remain no-effect compatibility inputs; v0.7.6 does not restore a pre-execution confirmation gate.

### Fixed

- **Prepare lint hook**: `lint` now runs before `docs`, `build`, `test`, and `typecheck`; a non-zero lint result stops prepare with `GATE_FAILED`. A schema-to-execution-table contract prevents accepted hook keys from becoming silent dead configuration.
- **postPublish documentation**: the project configuration standard now places `postPublish` inside each `releaseUnits[]` item and carries a schema-validated example.
<!-- release-skill:changelog:end version=0.7.6 locale=en -->


<!-- release-skill:changelog:start version=0.7.5 locale=en baseline=sha256:39f8f00f21c9071341106ea4becf4e8d10a732bd01b430e244dc4e3c5bf07da2 -->
## [0.7.5] - 2026-08-22

v0.7.5 recognizes registered platform projections that publish a single `skill/` entry, closing the remaining false missing-host result for Skill Failure Auditor releases.

### Fixed

- **Singular platform skill surfaces**: resource closure now assigns `platforms/<host>/skill/SKILL.md` to the registered `platforms/<host>` surface, while preserving root, adapter, and plural `skills/` behavior. Unregistered platform trees still fail closed. The changed closure algorithm is identified as `skill-resource-closure-v4`, so plans frozen by earlier checker versions cannot cross the publish boundary.
<!-- release-skill:changelog:end version=0.7.5 locale=en -->


<!-- release-skill:changelog:start version=0.7.4 locale=en baseline=sha256:c1d8df84f44367edc819829462687c58f30eb7ea23b8761c317254bd386ece85 -->
## [0.7.4] - 2026-08-22

v0.7.4 recognizes declared plugin hosts in both generated adapter trees and registered platform projection trees, so valid releases such as Skill Family Audit are no longer blocked by a false missing-host result.

### Fixed

- **Registry-driven projection surfaces**: each platform descriptor now declares its exact `platforms/*` skill projection surface. The resource-closure gate derives the host from the existing `buildAdapter.name` authority. Claude, Codex, Kimi, and WorkBuddy projections satisfy declared-host coverage without copying adapter trees; unknown platform projections still fail closed. The changed closure algorithm is identified as `skill-resource-closure-v3`, so frozen plans from earlier checker versions cannot cross the publish boundary.
<!-- release-skill:changelog:end version=0.7.4 locale=en -->


<!-- release-skill:changelog:start version=0.7.3 locale=en baseline=sha256:18caf087c567201044292c958694b39ae9989d4c1abb1886aaa5a1ce8ca57bca -->
## [0.7.3] - 2026-08-22

v0.7.3 adopts Foundation 0.8.1 so generated host adapters can initialize Foundation reports and managed projection without rewriting Foundation package identity.

### Fixed

- **Foundation-owned bundle identity**: release-skill now consumes the exact 0.8.1 Contracts, Harness, and Engineering Kit packages and removes its report.mjs identity rewrite. Claude, Codex, Kimi, and WorkBuddy adapters now reach release-domain GATE_FAILED diagnostics for missing plans, while a frozen Codex distribution completes Foundation managed projection and reaches DISTRIBUTED.
<!-- release-skill:changelog:end version=0.7.3 locale=en -->


<!-- release-skill:changelog:start version=0.7.2 locale=en baseline=sha256:2d5868f216a43f817df4db597c239ab7db305398dba7af1ffe555b47105dbe75 -->
## [0.7.2] - 2026-08-22

v0.7.2 fixes native safe-fs loading from generated host adapters whose installation roots intentionally omit package.json.

### Fixed

- **Adapter-safe native loader anchor**: the bundled runtime now anchors createRequire() to the shipped CLI entry shared by source and adapter layouts. Claude, Codex, Kimi, and WorkBuddy adapters can load their packaged native safe-fs addon without relying on a root package manifest.
<!-- release-skill:changelog:end version=0.7.2 locale=en -->


<!-- release-skill:changelog:start version=0.7.1 locale=en baseline=sha256:9f86def686489f30d89bb67884dfd8c44ee1d48b5d0cf5efabba44f87998d7d4 -->
## [0.7.1] - 2026-08-22

v0.7.1 fixes a leakage-scan false positive that blocked generated JSON Schema validators containing POSIX-like JSON Pointer segments.

### Fixed

- **Context-aware POSIX path detection**: the snapshot leakage scanner no longer treats JSON Pointer property segments or ordinary URL paths as machine-local absolute paths. Concrete Linux root, home, and user-home paths remain release-blocking findings.
<!-- release-skill:changelog:end version=0.7.1 locale=en -->


<!-- release-skill:changelog:start version=0.7.0 locale=en baseline=sha256:a4d6989dd03d562c498344baf0dc1d0e1d0a225aecf0d48a7c4f9850c495b0ef -->
## [0.7.0] - 2026-08-22

v0.7.0 closes the release architecture gaps identified after v0.6.3. Private postPublish inputs are now frozen into the approved plan, checkpoint approvals must be consumed from their authoritative immutable path, and downstream projection reuses the published Skill Family Foundation 0.8.0 contracts instead of workspace-local substitutes.

### Added

- **Frozen postPublish execution bundles**: release units can declare private `executionFiles`; prepare freezes their exact bytes and resource closure into the immutable plan, and distribute or postVerify installs only that verified bundle into the detached execution worktree. Live workspace edits after approval cannot change the executed command.
- **Authoritative checkpoint approval consumption**: postPublish approvals are accepted only from the canonical path derived from the plan digest and hook id. The consumer rechecks the plan digest, approval digest, strict file bytes, and symlink-free authority chain before any hook or external write.
- **Foundation-managed downstream projection**: postPublish payload projection now uses the published `skill-family-engineering-kit` projection compiler and runner, with strict reads and resource-closure verification from `skill-family-harness-node`.

### Changed

- **Separated workspace roles**: preset execution now distinguishes the maintainer's `releaseWorkspaceRoot` from the detached `executionWorktreeRoot`; ambiguous legacy root fallback is rejected, and presets cannot target the release workspace itself.
- **Exact Foundation 0.8.0 baseline**: `skill-family-contracts`, `skill-family-harness-node`, and `skill-family-engineering-kit` are pinned to 0.8.0. The package runtime is pinned to Node.js `>=22.22.2 <23`.
- **Explicit distribute authority**: `distribute` requires the plan-bound release approval record; postPublish hook approvals remain separate checkpoint records.

### Fixed

- **Credential-bearing Git URL rejection and redaction**: configured Git remotes reject URL userinfo at schema and runtime boundaries. Errors, evidence, and summaries pass through the shared redaction path so embedded credentials are not persisted.
- **Fail-closed production gates**: `NODE_TEST_CONTEXT` can no longer exempt derived-artifact gates, adapter behavior is explicit for each plan version, and Node.js 22 test-reporter output is accepted without weakening assertions.
- **Public packaging and license closure**: the workspace documentation and public package now agree on Apache-2.0, and the public bundle carries the required Apache-2.0 and MIT license texts.
<!-- release-skill:changelog:end version=0.7.0 locale=en -->


<!-- release-skill:changelog:start version=0.6.3 locale=en baseline=sha256:a1b8f98d720cae60e0855677b22dd3fd75f6c43eb31123951a5129d149626e70 -->
## [0.6.3] - 2026-08-20

v0.6.3 adds the postPublish hooks v2 registration mechanism with six built-in presets, checkpoint-level approval records for hooks that write downstream, a postVerify stage that runs hooks only after the main run reaches VERIFIED, an append-only setup proposal flow that drafts postPublish hook declarations for already-configured projects, the O1-O7 release-cycle speed-ups, and release-skill's own dogfood hub-entry proposal declaration — which this release delivers to the public skill-family-hub repository during its postVerify phase under its own checkpoint approval.

### Added

- **postPublish hooks v2 and six presets**: `releaseUnit.postPublish` now accepts a declarative `hooks` array alongside the existing `targets`; each hook is a named preset or a custom command hook following the prepare-hook rules (executable/argument arrays, relative cwd, timeout, environment allowlist — shell strings rejected). Six built-in presets ship with the bundle and are enumerated by `release-skill distribute --list-presets`: `git-mirror` and `marketplace-index-render` (declared in `targets` form), plus `proposal-inbox`, `marketplace-registry-entry`, `docs-refresh`, and `notify-handoff` (declared in `hooks` form); writing presets share `remoteUrl`/`workspace` dual downstream addressing, `proposal-inbox` without a target degrades to `notify-handoff` behavior instead of failing, and `notify-handoff` is the zero-write floor rendering a deterministic manual sync checklist. Every declaration is normalized into the frozen plan, so a hook change changes the plan digest and invalidates existing approvals; existing `targets` configurations stay valid with unchanged execution semantics.
- **Checkpoint-level hook approval**: a hook with `requiresApproval: true` (the default for public-write presets; projects may tighten, never loosen) parks at `AWAITING_APPROVAL` with zero remote writes until its own checkpoint approval is minted with `release-skill approve --plan <plan> --hook <hookId> --actor <name>` and consumed via `distribute --hook-approval` or `ship --hook-approval`. Approval records follow the new `postpublish-approval-record` schema bound to `(planDigest, hookId)` with the 24-hour expiry; a hook configuration change changes the plan digest and invalidates the approval. The run schema gains the `AWAITING_APPROVAL` checkpoint status, and the approval interface displays the normalized entry summary of each approved hook.
- **postVerify stage**: hooks declared with `phase: postVerify` run only after the main run reaches VERIFIED; `ship` routes them into an independent postVerify run whose hook context carries the verification evidence (`verifyEvidence`, present in this phase only). A failed postVerify run stays PARTIAL and can be reconciled, but it never rolls the main run back from VERIFIED — the failure is recorded prominently in evidence, never silently.
- **Setup incremental hook proposal**: for already-configured projects, `setup --discover-downstream` performs read-only discovery of downstream candidates (git remotes, marketplace/docs repository clues, `artifact-graph` configuration, foundation profiles) and `setup --propose-hooks` drafts postPublish hook declarations for human review; after human confirmation of the `setupDigest` the flow appends only the hooks section and never rewrites any other part of the configuration. The create-once boundary is preserved: an existing configuration is never regenerated.
- **Dogfood hub proposal declaration**: release-skill's own project configuration declares a `proposal-inbox` (git-push) hub-entry proposal toward the public `skill-family-hub` repository, delivered during this release's postVerify phase under its own checkpoint approval; delivery plus the deterministic manual sync prompt in evidence is the closure criterion — hub-side consumption is out of scope for this release.

### Changed

- **Release-cycle speed optimizations (O1-O7)**: `build-adapters --check` and the self-bootstrap fact-pin suite are now fail-closed prepare pre-gates that run before hooks and the full-test gate (a fast pre-gate, not a replacement for full tests); a new one-click derived-artifact sync command validates and rebuilds the version/docs/bundle/adapters/manifest/public-files areas in dependency order and never writes src or test pins; `build-adapters --apply` is the supported rebuild path for existing drifted adapters; the `ship` happy end now orchestrates `prepare --production --online` by default with explicit remediation prompts for non-production and offline plans; online production prepare reports a warning-level observation when the local branch leads origin (non-blocking); `verify --run` accepts a run directory and resolves its `release-run.json` automatically (file form unchanged); and the `generate-platform-manifest --check` baseline drift is fixed.

### Fixed

- **Production CLI distribute adapter registration**: both production CLI adapter registries now register the distribute-git adapter; before this fix the production `distribute`/`ship` auto-distribution path failed with `no distribute adapter registered`. The state-machine reference completes the `DISTRIBUTING`/`DISTRIBUTED` states and their transitions.
<!-- release-skill:changelog:end version=0.6.3 locale=en -->


<!-- release-skill:changelog:start version=0.6.2 locale=en baseline=sha256:103dcbd11e52542a07da9a1220eb246cf812de79ede19ff63a374785393580b7 -->
## [0.6.2] - 2026-08-19

v0.6.2 promotes the skill resource closure checker to a fail-closed release gate spanning prepare, publish, and verify, closes the five gaps (G1–G5) confirmed by the clause-by-clause gate audit, and fixes lineage commit-identity parsing that corrupted rebuilt commits: missing or drifted skill resources, home-directory search paths, and undeclared host surfaces now block a release before plan freeze, and commit identities are parsed with an anchored regex that fails closed instead of fabricating identity fields.

### Added

- **Skill-resource-closure v2 release gate**: the closure checker is now a fail-closed release gate across all three phases — prepare scans the frozen snapshot and blocks plan freeze on any finding with `GATE_FAILED` (error code 13), publish Gate 2c recomputes closure against the verified frozen snapshots for production plans, and verify validates the real npm install tree and marketplace install directories with per-host receipts. Receipts now carry `unitId`, host/surface detail, digests, `checkerVersion` (`skill-resource-closure-v2`), and counts; the platform registry declares each adapter's host surface as an explicit adapter directory name, and the receipt schema is bound in all six release-plan schema copies. A version mismatch between an old frozen plan and the new checker fails closed.
- **Closure gate gap closure (G1–G5)**: source-only (`SOURCE_ONLY_NOT_SHIPPED`) exemptions are now listed per reference in the receipt projection and in the prepare evidence — auditable and non-blocking; `~/`, `$HOME/`, and `${HOME}/` search paths inside code spans, fences, and link targets fail closed as `HOME_DIRECTORY_SEARCH`; identical surface-relative resources whose contents diverge across surfaces fail closed as `RESOURCE_DRIFT` with cross-surface reference locations; unreferenced regular files inside adapter skill closure directories fail closed as `STALE_RESOURCE`; every declared plugin distribution must be backed by a receipt host surface with at least one skill (declared-host reconciliation), so a dropped adapter tree can no longer skip the gate silently; and frozen receipts bind a deterministic `preparedAt` freeze timestamp (never a wall-clock sample) plus `exitCode: 0`, so identical sources freeze byte-identical receipts on every re-prepare.

### Fixed

- **Lineage commit-identity parsing (lineage-ident)**: `lineage rebuild` parsed author/committer ident lines with `split(/\s+>/)`, which never matched a legal ident line and corrupted the identities written to rebuilt commits (names containing spaces or `>` were mis-parsed as well). Idents are now parsed with an anchored regex whose greedy name capture lets the last `<email> ts tz` group win; unparseable lines fail closed instead of fabricating identity fields. Commit messages are fed to `commit-tree` via `-F -` stdin from untrimmed `cat-file` output, preserving arbitrary message bytes including trailing whitespace and blank lines.
- **Assess npm-transport test stability (test-only)**: the assess npm-transport test flaked when the npm lifecycle injected a silent loglevel setting and ambient proxy variables into the child environment — emptying npm stderr and letting a released ephemeral localhost port be hijacked. The test now strips ambient npm-config-namespace environment keys and proxy variables (`isolateNpmTransportEnv`), holds the localhost port for the whole test (`startConnectionResetRegistry`), and asserts `ECONNRESET|ECONNREFUSED` deterministically. No production behavior changed.
<!-- release-skill:changelog:end version=0.6.2 locale=en -->


<!-- release-skill:changelog:start version=0.6.1 locale=en baseline=sha256:dd7c991244d72db1247dda808057fda060b1e7bb03ff866aae691841828e6239 -->
## [0.6.1] - 2026-08-18

v0.6.1 closes the four root causes of the 0.6.0 self-bootstrap release cycle, in which 22 of 25 runs failed and nearly all wall-clock time was spent in diagnose-repair loops or on external interference: hook failures are no longer silent, stale bundles fail closed at the earliest gate, the freeze path can never skip the full test suite, and a machine-readable frozen marker now tells sibling governance tasks to keep out of a repository mid-release.

### Added

- **Hook failure output passthrough (R1)**: when a prepare hook exits non-zero, the run evidence now carries bounded `stderrTail` / `stdoutTail` projections (last 50 lines, capped at 8 KiB) and the CLI echoes the stderr tail, so failures such as a bare `exit=13` are diagnosable immediately instead of by blind retry. Exit-code semantics are unchanged.
- **Bundle freshness gate (R2)**: every rebuilt bundle embeds a frozen digest of its source tree, and prepare compares source against bundle right after the config phase; any mismatch fails closed as `BUNDLE_STALE` (error code 54) with the rebuild command in the message, before hooks, snapshots, or network checks run. No workflow path is exempt.
- **Full-test freeze gate (R3)**: plan digests can no longer be computed unless the full test suite ran in this prepare; the gate sits before `computePlanDigest`, the `testSelection` value is validated against a schema enum in project and plan schemas, and no overlay switch can waive the freeze-path requirement.
- **Frozen-release marker (R4)**: a successful prepare writes `.release-skill/FROZEN` carrying `planDigest`, `targetVersions` (unit → version), `createdAt`, and `runId`; the marker is removed only when verify reaches `VERIFIED`, giving sibling repositories and governance tasks a machine-readable signal to skip a repository mid-release.
<!-- release-skill:changelog:end version=0.6.1 locale=en -->


<!-- release-skill:changelog:start version=0.6.0 locale=en baseline=sha256:1942e4534cc9ab36065168471875ba8c4648c73328a20ef3ee6a7a53eb1f1b7d -->
## [0.6.0] - 2026-08-18

v0.6.0 automates the most error-prone bookkeeping step of the release loop: after a release reaches VERIFIED, verify now advances each unit's previousPublicBaseline in project.yaml to the just-published commit, tree, and manifest digest recorded in the frozen plan. The advance is local-only, idempotent, validated with automatic rollback, and commits the config file on its own only when it was clean before the write, so the drift gate always sees a truthful previous public baseline without anyone hand-copying hashes.

### Added

- **Automatic baseline advance (baseline-advance)**: after `verify` reaches `VERIFIED`, every `mode: bound` unit's `previousPublicBaseline` (`commit`, `tree`, `manifestDigest`) is advanced to the published values derived from the frozen plan's `push-snapshot` binding — never recomputed from workspace state. The rewritten `project.yaml` preserves comments, is re-validated with `loadProjectConfig`, and is restored byte-for-byte if validation fails. The advance never demotes `VERIFIED`: failures are recorded in evidence and reported for manual handling.
- **Clean-worktree commit policy**: the baseline advance auto-commits the config file in an isolated commit only when `project.yaml` had no staged or unstaged changes before the write; a dirty worktree leaves the file written but uncommitted for human review, and a missing or broken git fails safe to never committing.
- **Ship-state traceability**: `ship` persists the verify `baselineAdvance` result (`advanced` / `already-current` / `committed` / `failed`) in its durable state, and the `verify` human-readable output reports the advance outcome line.
<!-- release-skill:changelog:end version=0.6.0 locale=en -->


<!-- release-skill:changelog:start version=0.5.1 locale=en baseline=sha256:2a8dc4241570c0919e55da270233728963ba1cda347c95c775678ec89a9f0ac0 -->
## [0.5.1] - 2026-08-17

v0.5.1 fixes three frozen-0.5.0 defects — explicit hook environment delivery (envAllowlist now reaches prepare hooks), a 64 MiB baseline maxBuffer for large tracked indexes, and the prefixed skill-directory fallback for marketplace-install preflight/observe — bumps the Skill Family Foundation dependencies to the released 0.5.0 packages, and hardens the release chain so every later release must bind the previous public release commit instead of degrading to an orphan root commit.

### Changed

- **Foundation 0.5.0 upgrade**: `skill-family-contracts` and `skill-family-harness-node` dependencies bumped from 0.4.0 to 0.5.0 (npm latest); the package-name import bridge keeps working unchanged and the harness-node 0.5.0 export surface was re-verified (`publishFileExclusive`, token-lock five functions, `HARNESS_ERROR_KINDS`).
- **Chain hardening (chain-integrity)**: `push-snapshot` now requires an explicit `branchStrategy` (the historical `create-release-branch` default that produced orphan root commits is gone); `create-release-branch` is only valid when `previousPublicBaseline.mode=none`; a production online prepare with `mode=none` on a repository that already carries release tags fails closed with `CHAIN_GAP`, demanding a bound baseline at the previous release commit; online `assess` registers a warning-level `VERSION_SEQUENCE_GAP` when the target version jumps the release sequence (e.g. 0.1.1 → 0.1.3 with no v0.1.2 tag), without blocking.

### Fixed

- **Hook environment delivery (hook-env-delivery)**: `runDeclaredHooks` now accepts an explicit `env` option and merges it into the hook context (`hookFn(hook, { root, env })`); prepare and `hooks validate` inject the invoking shell's environment, so `hooks.*.envAllowlist` keys exported by the caller finally reach the hook subprocess. Allowlist semantics are unchanged — the hook runner still reads allowlisted keys exclusively from the explicit map, never from `process.env` directly.
- **Large-tracked-index baseline (baseline-maxbuffer)**: `computeWorkspaceDigest` now runs its three git subprocesses with a 64 MiB `maxBuffer` (official fix 39c631f); workspaces with thousands of tracked files (measured 8494 tracked files → 1,519,151 B `ls-files -s` stdout) no longer fail with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
- **Prefixed skill-directory resolution (entry-skill-prefix)**: marketplace-install preflight and observe now fall back from `skills/<entrySkill>/SKILL.md` to `skills/<plugin>-<entrySkill>/SKILL.md` (plugin from the action parameters, D-ACA-30 platform physical names); candidate builds with prefixed skill directories pass preflight and observe instead of failing with `entry skill not found`.
<!-- release-skill:changelog:end version=0.5.1 locale=en -->


<!-- release-skill:changelog:start version=0.5.0 locale=en baseline=sha256:e59bef4bd7bc6e0809d1f415d7ff3d342e45a7e77075f66d6ffa48cfd9b71932 -->
## [0.5.0] - 2026-08-16

v0.5.0 adopts the released Skill Family Foundation 0.4.0 packages (skill-family-contracts / skill-family-harness-node) for digest computation, atomic writes, contained file reads, and project locking; migrates the project lock domain to a single-file token lock with fail-closed legacy detection; hardens the online assess npm check against fail-open; and documents the hooks authorization contract as config-time authorization.

### Added

- **Negative test coverage**: 12 additional tests covering exclusive publication, token-lock migration, and the assess npm-check behavior.

### Changed

- **Foundation adoption**: digest computation, atomic writes, contained-path reads and project locking now delegate to the published `skill-family-contracts@0.4.0` / `skill-family-harness-node@0.4.0` packages instead of local implementations; dependencies bumped from 0.3.0 to 0.4.0.
- **Token lock domain**: project locks migrated from a directory-based domain to a single `.release-skill/lock` file (0600, token record). Legacy directory-form locks are detected and fail closed with `LOCK_MIGRATION_REQUIRED`; no automatic conversion or deletion is performed.
- **Exclusive plan/run publication**: immutable plan and run records are published via `publishFileExclusive` — identical bytes are idempotent, divergent bytes fail with `GATE_FAILED`.
- **Assess npm check semantics**: the online `assess` npm check no longer treats every registry error as version-not-found; only E404/ETARGET mean a missing version, other failures surface as an `NPM_VERSION_CHECK_FAILED` warning.
- **Hooks authorization contract**: release-prepare/release-help now document the explicit contract that configuring a hook in project configuration IS the authorization (hooks are arbitrary local processes with no sandbox, no filesystem/network isolation, and no pre-trigger confirmation point); restoring a mandatory pre-trigger confirmation gate is a future hardening item.
- **Audit-scope ruling**: the bundled-family marketplace configuration is recorded as not applicable to the `release_artifact` target type (G3 target-side T4 ruling); T3/T5/T6 deferred to independent tasks.
- **Plan schema**: production plans carry the resolved codebuddy marketplace coordinates so approval and publish review the exact marketplace target.

### Fixed

- **Configurable CodeBuddy marketplace**: codebuddy-plugin distributions accept `marketplace` and `marketplaceSource` in project configuration, and prepare threads both values into the consumer install action instead of assuming a fixed marketplace.
- **Assess fail-open**: an online `assess` no longer silently reports no gaps when the npm registry check fails for reasons other than a missing version.
<!-- release-skill:changelog:end version=0.5.0 locale=en -->


<!-- release-skill:changelog:start version=0.4.2 locale=en baseline=sha256:b8676f90eb68c93e40f84ff16de18a8c472e6a06e321bcc25895799e9e6f3896 -->
## [0.4.2] - 2026-08-12

v0.4.2 makes the CodeBuddy consumer marketplace configurable per distribution instead of hardcoding a single marketplace, so CodeBuddy plugin distributions can target a project-declared marketplace source.

### Changed

- **Plan schema**: production plans carry the resolved codebuddy marketplace coordinates so approval and publish review the exact marketplace target.

### Fixed

- **Configurable CodeBuddy marketplace**: codebuddy-plugin distributions now accept `marketplace` and `marketplaceSource` in project configuration, and prepare threads both values into the consumer install action instead of assuming a fixed marketplace.
<!-- release-skill:changelog:end version=0.4.2 locale=en -->


<!-- release-skill:changelog:start version=0.4.1 locale=en baseline=sha256:e2ccb5ddfef6c5e00b047bbf4fa009f5f5c10b003aa2254756f6f9b73a9b3346 -->
## [0.4.1] - 2026-08-03

v0.4.1 is the unreleased source candidate that migrates release-skill to Apache License 2.0 and aligns public author metadata while preserving repository ownership and historical attribution.

### Changed

- **Open-source license**: package, plugin manifests, README, LICENSE, and NOTICE now consistently use Apache-2.0.
- **Identity separation**: project author and developer metadata names 广州市风荷科技有限公司, while the `ifoohoo` repository and Marketplace owner coordinates remain unchanged.
- **Historical attribution**: existing contributor and company copyright notices remain; metadata and license changes do not assert a copyright transfer.
<!-- release-skill:changelog:end version=0.4.1 locale=en -->


<!-- release-skill:changelog:start version=0.4.0 locale=en baseline=sha256:099d9db24049aeaae78a21d3bd5152582bb20d4efad1ceff085f9609e8e6d52e -->
## [0.4.0] - 2026-08-02

v0.4.0 simplifies the production release path to one frozen-plan approval and moves unavailable Kimi or CodeBuddy installations into non-blocking manual follow-up tasks.

### Added

- **Manual consumer follow-ups**: when Kimi or CodeBuddy cannot be installed automatically, the release records an installation task after publishing without requiring system attestation.

### Changed

- **Single release approval**: the normal production path now asks only for approval of the immutable release plan; invoking a command authorizes its configured hooks and gates.
- **Non-blocking human consumers**: Kimi and CodeBuddy manual installation tasks no longer prevent the automated release from reaching `VERIFIED`.

### Removed

- **Redundant confirmation flags**: legacy plan-digest repetition, production-confirmation, hook-authorization, and manual-attestation interactions were removed from the normal release path.
<!-- release-skill:changelog:end version=0.4.0 locale=en -->


<!-- release-skill:changelog:start version=0.3.0 locale=en baseline=sha256:ee0626856918a8fae3b49f3e1645b8f2dc4149519499edbd04e175939faa1b2e -->
## [0.3.0] - 2026-07-31

v0.3.0 streamlines production releases into a resumable orchestration with reusable hook receipts, consolidated approvals, and stronger consumer-install evidence.

### Added

- **Resumable ship orchestration**: the new `ship` command persists the active release state and resumes prepare, approval, publish, reconcile, and verification without rebuilding authority from conversational context.
- **Reusable hook receipts**: `hooks validate` executes declared hooks through the same content-bound cache used by prepare, so unchanged checks do not need to run again.
- **Manual consumer follow-ups**: Kimi and CodeBuddy installation tasks are emitted after automated publishing and explicitly remain outside system verification.
- **Git transport preflight**: production publishing selects one repository-consistent HTTPS or SSH transport before any remote write and blocks conflicting remote identities.

### Changed

- **Consolidated human decisions**: the normal path requires one immutable-plan approval; invoking a command authorizes its configured hooks and gates, while manual consumer tasks are collected after publishing.
- **Parallel consumer verification**: independent consumer checks run concurrently, drain before failure reporting, and produce deterministically ordered evidence.
- **Automatic release metadata**: successful verification advances each unit's `previousPublicBaseline` to the frozen public commit, tree, and manifest digest.
- **Compact prepare output**: JSON output references the immutable plan by path and digest instead of embedding the full plan.
<!-- release-skill:changelog:end version=0.3.0 locale=en -->


<!-- release-skill:changelog:start version=0.2.9 locale=en baseline=sha256:22b3d94c5d99fca0e6016334a108e4be5f3419f45507fae795b4d0714ca7ad6d -->
## [0.2.9] - 2026-07-31

v0.2.9 makes missing expected public-surface configuration visible during assessment and preparation without blocking existing projects.

### Added

- **Adoption warning**: assess reports `PUBLIC_SURFACE_CONFIG_MISSING` for every release unit that has not configured `expectedPublicSurface`.

### Changed

- **Prepare visibility**: prepare records and returns the same non-blocking warning, and the CLI exposes it in both JSON and human-readable output.
<!-- release-skill:changelog:end version=0.2.9 locale=en -->


<!-- release-skill:changelog:start version=0.2.8 locale=en baseline=sha256:ad6e8910f1af206463b5decf134b82590787b77f5a88faca3d8985d3686b111b -->
## [0.2.8] - 2026-07-30

v0.2.8 adds a project-configurable expected public-surface gate so newly added or omitted release files cannot silently disappear from a frozen snapshot.

### Added

- **Expected public surface**: release units can declare physical scan roots with compact `include` and `exclude` globs instead of maintaining a second per-file checker.
- **Exhaustive classification diagnostics**: prepare reports missing mappings, unexpected mappings, unclassified files, and files that ambiguously match both include and exclude rules.

### Changed

- **Post-build release gate**: prepare scans the actual workspace after build hooks and blocks before source-authority closure, baseline capture, snapshot construction, or plan creation.
- **Bounded glob and path safety**: the built-in scanner supports `*`, `?`, and `**`, rejects overlapping or escaping scan roots, and keeps workspace control paths outside the project classification surface.

### Fixed

- **Silent release-file omission**: a file classified for publication can no longer be absent from `publicFiles` while the release still reaches `PREPARED`.
<!-- release-skill:changelog:end version=0.2.8 locale=en -->


<!-- release-skill:changelog:start version=0.2.7 locale=en baseline=sha256:05d12ddcc435b3c4438561dba780481ead1ac7662d946c3c36ddf8123dcaebe3 -->
## [0.2.7] - 2026-07-29

v0.2.7 prevents npm packages with missing declared runtime entries from being prepared, published, reconciled, or marked as verified.

### Added

- **Static npm entry closure**: release-skill checks `bin`, `main`, `module`, `types`, `typings`, and concrete local `exports` targets against the exact frozen tarball and the freshly installed package.
- **Setup diagnostics**: setup reports declared npm entry candidates as tracked, untracked, ignored, missing, or non-regular without modifying project configuration.

### Changed

- **Fail-closed unsupported exports**: wildcard exports and fallback arrays remain outside the minimal resolver boundary and now block release instead of being guessed or silently skipped.
- **Final write-boundary verification**: the npm adapter rechecks the same digest-verified tarball buffer immediately before registry publication.

### Fixed

- **Empty-shell package verification**: a package can no longer reach `PREPARED`, remote publication, reconciliation, or `VERIFIED` when its declared runtime or type entry is absent.
<!-- release-skill:changelog:end version=0.2.7 locale=en -->


<!-- release-skill:changelog:start version=0.2.6 locale=en baseline=sha256:ba7fe1d8cbae8ea3a539016c1231acd066f6dbf30b6e1ebb9db50e7c04e69253 -->
## [0.2.6] - 2026-07-29

v0.2.6 adds a source-authority content gate so a production release cannot succeed while the project workspace's real default branch still exposes stale public files.

### Added

- **Source-authority content closure**: prepare freezes the exact public input paths and executable modes that must exist on the configured source repository's actual default branch.
- **Pre-publish remote proof**: publish compares the frozen closure with the remote default branch before any external write and records a digest-bound receipt that verify requires.

### Changed

- **Branch topology tolerance**: projects may develop directly on the default branch or use release branches; compliance is based on final content, not merge ancestry or a hard-coded branch name.
- **Minimal conflict policy**: divergent or conflicting source state fails closed with diagnostics; Release Skill does not auto-merge, rebase, force-push, or create a replacement branch workflow.

### Fixed

- **Stale workspace README after release**: production publishing now blocks when the source workspace's real default branch does not contain the frozen public README and other declared source inputs.
<!-- release-skill:changelog:end version=0.2.6 locale=en -->


<!-- release-skill:changelog:start version=0.2.5 locale=en baseline=sha256:8bd4c268f65c72efeb3866ef4bcae7d1fa902e02833e622ca66670b633b124b1 -->
## [0.2.5] - 2026-07-28

v0.2.5 adds a built-in skill resource-closure release gate. Release Skill now validates the actual frozen and installed plugin projections instead of treating repository-level file presence as proof that every skill can resolve its resources.

### Added

- **Skill resource-closure gate**: recursively discovers nested skills and validates skill-local references, assets, schemas, examples, and private scripts from each skill root.
- **Frozen and installed receipts**: prepare records closure receipts for every distribution surface, publish rechecks the frozen artifact before external writes, and verify requires matching receipts from real npm and plugin installation roots.
- **Adversarial path checks**: rejects current-working-directory fallbacks, source-tree backjumps, absolute machine paths, path escape, symbolic links, and non-regular resource targets.

### Changed

- **Shared runtime resolution is explicit**: plugin-level scripts and cross-skill resources must resolve from a validated plugin root; bounded source-only build tools remain auditable exceptions.
- **Kimi Code and CodeBuddy verification tightened**: consumer verification plans now bind to actual isolated or managed plugin installation paths.
- **Legacy plan compatibility preserved**: existing frozen plans remain readable, while newly prepared plans require resource-closure evidence.

### Fixed

- **Nested skill blind spot removed**: author, review, repair, and other nested skills are no longer skipped by resource validation.
- **Public baseline tests synchronized**: migration invariants now track the configured v0.2.4 public baseline commit.
<!-- release-skill:changelog:end version=0.2.5 locale=en -->


<!-- release-skill:changelog:start version=0.2.4 locale=en baseline=sha256:b0ad6c897df808a11a2630d1565327ff5092e407dd004dc71bc43b954cbf88a6 -->
## [0.2.4] - 2026-07-28

v0.2.4 is a documentation and marketplace-source remediation release. It corrects the default marketplace source to the bundled-family repository (ifoohoo/release-skill), eliminates stale v0.1.9 residuals, improves README bilingual consistency and navigation, and strengthens anti-regression gates for version drift.

### Changed

- **Default marketplace source corrected**: all installation documentation now uses the bundled-family repository `ifoohoo/release-skill` instead of the external marketplace `ifoohoo/artifact-skill-set`. Claude Code install command is now `/plugin marketplace add ifoohoo/release-skill` with `release-skill@release-skill`.
- **README restructured for readability**: both EN and ZH READMEs now include a table of contents, Documentation navigation section, and reorganized chapter flow (Quick start moved before preservation contract). Significantly shorter than before.
- **Positioning sentences completed**: README and root workspace README now list all supported platforms (Claude Code, CodeBuddy, WorkBuddy, Codex, Kimi Code).
- **Anti-regression gate expanded**: `sync-version.mjs` TEXT_TARGETS now covers the safe-first-command version statement in both EN and ZH READMEs, preventing future v0.1.9-type drift.

### Fixed

- **v0.1.9 residual eliminated**: the safe-first-command block in both READMEs now correctly references the current version (was stuck at v0.1.9).
- **Stale counting removed**: replaced fragile 'All four plugin hosts' / '四种插件宿主' with 'All supported plugin hosts' / '各插件宿主'.
- **Root README boundary corrected**: clarified that README/INSTALL/CHANGELOG are human-maintained source files, while references/schemas/adapters/skills are generated artifacts.
- **CONTRIBUTING updated**: added 'Do not edit generated files' section documenting the authority source and regeneration workflow for references/, schemas/, adapters/, and skills/.
- **AGENTS.md language rule adjusted**: governance rules file may use English; user-facing documentation remains Chinese.
<!-- release-skill:changelog:end version=0.2.4 locale=en -->


<!-- release-skill:changelog:start version=0.2.3 locale=en baseline=sha256:1bc1839f9d2de5481a9edc7748722c02c5c9369d2034f8c6495f6dd00a392339 -->
## [0.2.3] - 2026-07-26

v0.2.3 is a fix-forward release that addresses platform verification, public artifact, and documentation issues discovered in v0.2.2. The release converges platform fact sources, fixes consumer gate mapping errors, and strengthens attestation validation.

### Changed

- **Version synchronized to 0.2.3**: all plugin manifests (9 files), package.json, INSTALL.md, INSTALL.zh-CN.md, README.md, and README.zh-CN.md updated.

### Fixed

- **CodeBuddy marketplace-install distribution mapping**: `verify.mjs` now correctly maps `codebuddy-marketplace-install` to `codebuddy-plugin` distribution (was incorrectly falling back to `kimi-plugin`). The `fixedEnv` for codebuddy now uses only `HOME` without `KIMI_CODE_HOME`.
- **Unknown consumer fallback removed**: `plugin-marketplace.mjs` now throws an explicit error for unregistered consumer platforms instead of silently falling back to Kimi configuration. Error message includes the unknown consumer id and list of registered platforms.
- **CodeBuddy attestation baseline exclusion**: `.release-skill/codebuddy-attestations/` is now properly excluded from workspace baseline digest calculation, preventing self-drift when codebuddy attestation files are written during the release lifecycle.
- **CodeBuddy manifest skills field accepts array**: `normalizeCodeBuddySkillsRel()` now accepts both string and single-element array forms for the `skills` field, matching the real CodeBuddy validator's expected shape. The root `.codebuddy-plugin/plugin.json` now uses array form.
- **CLI channel attestation path validation**: `validateCodeBuddyAttestation()` now validates that CLI channel `installPath` ends with the well-known `.codebuddy/plugins/marketplaces/<marketplace>/plugins/<plugin>` segment tail, closing a path-escape gap.
<!-- release-skill:changelog:end version=0.2.3 locale=en -->


<!-- release-skill:changelog:start version=0.2.2 locale=en baseline=sha256:3208d6a99e84307e77201bb42f88030caac232a3bcbf0942e5747e1934c5c658 -->
## [0.2.2] - 2026-07-26

v0.2.2 closes the CodeBuddy platform distribution loop and adds the external independent marketplace distribution form. CodeBuddy/WorkBuddy joins the publish/reconcile/verify pipeline through a human attestation closed loop isomorphic to kimi: because the codebuddy CLI cannot pin a frozen ref (no ref option; installs track the default branch/latest), the execute phase writes a manual install requirement (never execs the CLI), and observe/verify consume a structured human attestation with read-only install-point validation — missing, expired, mismatched, or path-escaping attestations all fail closed, at the same severity as kimi (post-publish verification cannot be waived). The external marketplace form lets a distribution declare `marketplaceRepo` so prepare freezes the external marketplace HEAD online (codex hard-frozen to a commit sha, claude weak-frozen to its default branch name) with frozen-sha and index-entry integrity checks, and plugin-marketplace gains matching preflight/observe branches under the `external-marketplace-v1` payload contract while the inline/kimi/codebuddy/legacy branches stay byte-for-byte unchanged. Installation docs (en + zh-CN) are unified on the independent marketplace `ifoohoo/artifact-skill-set` primary path. The npm package name (`release-skill`), publishing identity (`publisher: mzdbxqh`), public repository (`ifoohoo/release-skill`), and corporate maintainer remain unchanged.

### Added

- **CodeBuddy platform human attestation closed loop**: CodeBuddy/WorkBuddy joins the release pipeline (`publish`/`reconcile`/`verify`) via a human attestation closed loop isomorphic to kimi. The codebuddy CLI's marketplace add/install cannot pin a frozen ref (no ref option; installs track the default branch/`latest`, measured), so the automated install checkpoint cannot guarantee frozen-artifact identity. Execute writes a manual install requirement and never execs the CLI; observe/verify consume a structured human attestation and read-only-validate the install point. Missing, expired, mismatched, or path-escaping attestations all fail closed, at the same severity as kimi (post-publish verification cannot be waived). Two measured install channels: desktop installs through the WorkBuddy desktop unified marketplace `artifact-skill-set` (`installPath` must contain the `/.workbuddy/plugins/marketplaces/artifact-skill-set/plugins/<plugin>` tail segment, segment-checked); cli runs the bundled CLI under an isolated `HOME=<authorityDir>/codebuddy-home` (`installPath` must be contained in that isolated home's marketplace plugin root). Attestations carry `installChannel` + `marketplace` fields and are validated per channel. Pipeline routing: platform id `codebuddy`, distributionType `codebuddy-plugin`, actionType `codebuddy-marketplace-install`, Tier 3 (same tier as kimi); the build adapter keeps its historical directory name `workbuddy` (`adapters/workbuddy/`, `.codebuddy-plugin/plugin.json` manifest, bytes unchanged).
- **External independent marketplace distribution form**: a distribution declaring `marketplaceRepo` enables the external form. The prepare production loop freezes the external marketplace HEAD online via `git ls-remote --symref` (codex hard-frozen to a commit sha, claude weak-frozen to its default branch name) and validates the external index entry via `gh api` (name match, exactly one entry, `entry.version == target version` for the claude form); declaring the external form while offline fails closed, and the external repository is strictly read-only. Frozen actions carry `repo=marketplaceRepo`, `ref=add-ref`, `marketplaceCommitSha`, `marketplaceLocation=external`, `payloadContract=external-marketplace-v1`; `snapshotPath`/`manifestDigest` still bind this unit's frozen snapshot (payload authority unchanged). Plan integrity gains an external branch (repo match, `marketplaceLocation`, 40-hex `marketplaceCommitSha`, ref structure safety); kimi/codebuddy with `marketplaceRepo` fail closed. `plugin-marketplace` gains external preflight/observe branches: `external-marketplace-v1` uses the same whole-tree containment semantics as `declared-manifest-v1` (authority is `.`, host-added paths recorded as `extraInstalledPaths` rather than failing); preflight skips the in-snapshot marketplace segment and reads the plugin manifest from the snapshot root, validating name/version and the frozen fields; observe reuses the existing strategy for install-side entry comparison (weak-frozen claude version drift fails closed). Inline/kimi/codebuddy/legacy/`declared-manifest-v1` branches are byte-for-byte unchanged.

### Changed

- **Installation docs unified on the marketplace primary path (en + zh-CN)**: README and INSTALL (all four documents) now route plugin installation through the independent marketplace `ifoohoo/artifact-skill-set` as the primary path, and the READMEs add a workflow overview and platform distribution description. Standards and public references (`standards/06-adapter-contract.md`, `references/06-adapter-contract.md`) are synchronized to the codebuddy attestation form and the external marketplace form with its ordering constraints.

### Fixed

- **CodeBuddy plugin manifest `skills` field is now an array**: the `.codebuddy-plugin/plugin.json` manifest's `skills` field is emitted as an array, matching the CodeBuddy host's expected shape.
- **`verificationGate` scope distribution enum includes `codebuddy-plugin`**: `release-project.schema.json` adds `codebuddy-plugin` to the `verificationGate.scope.distribution` enum (mirroring the existing `kimi-plugin` rule), keeping the schema and the runtime gate whitelist consistent; the embedded schema copies in all four adapters are rebuilt to match.
<!-- release-skill:changelog:end version=0.2.2 locale=en -->


<!-- release-skill:changelog:start version=0.2.1 locale=en baseline=sha256:7d616df824b1d28f9939ef181d6a5d5928d3e0f0455974bebb356c742992ac81 -->
## [0.2.1] - 2026-07-25

v0.2.1 adds a fourth platform adapter — workbuddy (CodeBuddy/WorkBuddy plugin) — using a build-only distribution model. The build-adapters generator and platform registry now register workbuddy alongside claude, codex, and kimi, producing a self-contained adapter directory at `adapters/workbuddy/` with a `.codebuddy-plugin/plugin.json` manifest, bundled CLI entry, native prebuilds, schemas, and skills. The sync-public-files and sync-version scripts cover the new manifest, and the adapter-contract standard documents build-only distribution. README and INSTALL (en + zh-CN) register the CodeBuddy installation entry. Installation is manual — the automated marketplace install checkpoint does not cover CodeBuddy yet.

### Added

- **WorkBuddy/CodeBuddy build-only distribution adapter**: new fourth platform adapter `workbuddy` registered in the platform registry and build-adapters generator. The generated self-contained adapter directory (`adapters/workbuddy/`) ships a `.codebuddy-plugin/plugin.json` manifest, a bundled CLI entry (`bin/release-skill.bundle.mjs`), native safe-write prebuilds, JSON schemas, and the full skill set. Skills resolve the CLI entry via `${CODEBUDDY_PLUGIN_ROOT}`, which CodeBuddy expands inline.
- **Build-only distribution model in adapter-contract standard**: both the parent `standards/06-adapter-contract.md` and the public `references/06-adapter-contract.md` now document the build-only distribution scope — the adapter is generated and self-contained, installation is manual, and the automated preflight/execute/observe/verify marketplace checkpoint is not yet wired for CodeBuddy.
- **sync-public-files and sync-version coverage for `.codebuddy-plugin`**: the `sync-public-files.mjs` script now validates the `.codebuddy-plugin/plugin.json` manifest as a public asset, and `sync-version.mjs` propagates the package version into it. The build-adapters generator produces workbuddy artifacts alongside the existing three platforms.
- **README and INSTALL registration (en + zh-CN)**: all four public documents (README.md, README.zh-CN.md, INSTALL.md, INSTALL.zh-CN.md) now list the CodeBuddy/WorkBuddy adapter, its manual installation path, and the scope limitation that the automated marketplace install checkpoint does not yet cover CodeBuddy.
<!-- release-skill:changelog:end version=0.2.1 locale=en -->


<!-- release-skill:changelog:start version=0.2.0 locale=en baseline=sha256:cc9236e620cdb2d9eef6fede00c54095bf0cc0ccdfeb9c1e584f063ff3af7e23 -->
## [0.2.0] - 2026-07-25

v0.2.0 is a hardening release that improves publish reliability, digest reproducibility, version management, and platform registry data-driven architecture. Nine hardening tasks are completed: observe retry backoff, digest decoupling with planVersion 2, declared-manifest payload contract, single-source versioning, real CLI contract tests, incremental hook caching, tiered parallel checkpoint execution, observe-before-execute idempotent skip, and platform registry data-driven architecture. The npm package name (`release-skill`), publishing identity (`publisher: mzdbxqh`), public repository (`ifoohoo/release-skill`), and corporate maintainer remain unchanged.

### Added

- **Observe retry backoff (`observeWithRetry`)**: post-execute observe in publish/reconcile now uses bounded exponential backoff for transient failures. Transient classification is propagating — retries only on transient errors (network timeouts, 5xx); CONFLICTING errors are never retried. Marketplace retry window is clamped to action `timeoutMs`. This resolves intermittent PARTIAL failures caused by transient observe timeouts on real networks.
- **Digest decoupling with planVersion 2**: plan fields split into binding layer (frozen artifacts, actions, versions, config) vs record layer (baseline, createdAt, status). Frozen commit timestamp derived from `headCommit` for reproducible digests. Approval no longer invalidated by tree/workspace digest drift (v2 plans); baseline check demoted to evidence warning. v1 legacy behavior preserved byte-for-byte (golden-value tested).
- **Declared-manifest payload contract for marketplace installs**: replace whole-tree byte equality with declared-manifest comparison. Authority entries must exist and match byte-for-byte in the install dir; host-added files are recorded (`extraInstalledPaths`, capped) instead of failing. Legacy plans without `payloadContract` keep exact whole-tree semantics. `consumerTransportExclusions` deprecated (legacy path only).
- **Single-source versioning with `sync-version` script**: `package.json` version is now the sole handwritten source. New `sync-version.mjs` propagates it to plugin manifests, marketplace.json, README boundary lines, and INSTALL docs (idempotent, `--check` mode, defensive whitelist). `smokeExpectedJson.version` is injected at runtime from `targetVersion`, ending the bump-invalidates-plan loop. docs hook now runs `check-docs-drift.mjs` (render check + sync-version check). Hardcoded version literals in tests replaced with dynamic reads.
- **Real CLI contract tests for claude/codex/kimi adapters**: isolated-HOME contract tests asserting adapter assumptions against real CLI protocol shapes (`list --json` output forms, subcommand existence), gated by `RELEASE_SKILL_LIVE_CLI=1` with skip-not-fail semantics. Static contract locks in 'kimi has no scriptable install' to prevent fabricated CLI commands from regressing silently.
- **Incremental hook caching for prepare**: hooks can declare `cacheable`+`cacheInputs`; results cached under `.release-skill/cache/hooks/<name>/<key>.json` keyed by hook config and input content hashes. Failures never cached; hits skip execution but not authorization gates; `--no-hook-cache` escape hatch. Cache dir registered in baseline control-plane exclusions and gitignore. test/typecheck hooks cached in this project: second prepare drops to ~2s with test hook served from cache.
- **Tiered parallel checkpoint execution for publish**: publish checkpoints grouped into hard-coded `TIER_TABLE` layers. Layers run sequentially, actions within a layer run concurrently with `allSettled` semantics (no fail-fast, successes preserved). State persistence moves to per-layer snapshots keeping the appendRunState hash chain intact; crash recovery verified via SIGKILL-mid-tier integration test. Evidence appends serialized through a mutex chain with sequence starting at 1 and tier info in `details.tier`.
- **Observe-before-execute idempotent skip**: publish each checkpoint execute now has a single read-only pre-observe. Four-way classification: CONSISTENT→SKIPPED / MISSING→execute / CONFLICTING→FAILED / not observable→execute. Two-layer preflight shares `classifyPreObservation` single source (global Safety Gate 10 arbitration). SKIPPED downstream adaptation: layer folding recognizes success, three `every` checks expanded to SUCCEEDED||SKIPPED, `buildPersistedState` maps skipped, TOCTOU as usual.
- **Platform registry data-driven architecture**: new `src/platforms/registry.mjs` with `PLATFORMS`/`getPlatform`/`assertRegistry` module self-validation. Three platforms complete description (§3.4 matrix full dimensions) + pure strategy functions. Golden tests 12 cases solidify three platforms execute/observe/list current behavior. `src/producers/build-adapters.mjs` PLATFORMS now derived from registry; `scripts/build-adapters.mjs` duplicate platform table removed for single-source. `build:adapters:check` byte-zero diff (zero behavior change strong evidence).
<!-- release-skill:changelog:end version=0.2.0 locale=en -->


<!-- release-skill:changelog:start version=0.1.10 locale=en baseline=sha256:ec4dbf3f44f1295d9af20e0fbf1ced4341d9b65d0c93598104e228244e33fa2b -->
## [0.1.10] - 2026-07-24

v0.1.10 fixes the codex marketplace install verification failure caused by the codex CLI materializing a `.codex-plugin/migrated-command-skills/` subtree (commands migrated to skill format) in the plugin install root at install time. That consumer-owned transport metadata is now exempted alongside the root `.git` checkout, and the frozen snapshot exclusion list supports multi-segment relative path prefixes while single-segment root-only behavior is unchanged. The sealed snapshot digest, release plan schema, and prepare-side freezing are unchanged, so already-frozen plans reconcile without re-approval. The npm package name (`release-skill`), publishing identity (`publisher: mzdbxqh`), public repository (`ifoohoo/release-skill`), and corporate maintainer remain unchanged.

### Fixed

- **Codex `migrated-command-skills` transport exemption**: the codex CLI
  converts plugin `commands/` into skill format at install time and writes the
  result under `.codex-plugin/migrated-command-skills/` in the install root.
  That consumer-owned subtree is not part of the published payload, so the
  whole-tree comparison failed every real codex marketplace install; the
  codex consumer transport exemptions widen from `['.git']` to
  `['.git', '.codex-plugin/migrated-command-skills']`. Claude (`.in_use`) and
  Kimi (`.git`) exemptions are unchanged, and the exemption deliberately
  never widens to `.codex-plugin/*` or arbitrary extra files. Verified
  against a real flow-architect install: the installed tree is byte-identical
  to the frozen snapshot except for the migrated-command-skills directory.
  Already-frozen plans reconcile unchanged because the sealed digest, plan
  schema, and prepare-side freezing are untouched.
- **Multi-segment snapshot exclusions, fail-closed**:
  `computeFrozenSnapshot`'s `excludeRootEntries` now accepts multi-segment
  relative path prefixes naming an exact excluded subtree (required for the
  `.codex-plugin/migrated-command-skills` exemption); single-segment entries
  keep the historical root-only matching. Malformed entries (non-string,
  absolute, `..`, backslash) fail closed: a bad exclusion list is a caller
  bug, not transport metadata.
- **Regression coverage**: new protocol-level tests cover the root-layout
  codex execute→observe→verify cycle with the CLI-generated
  migrated-command-skills tree present, including byte-tamper and extra-file
  negatives that must still fail closed.
<!-- release-skill:changelog:end version=0.1.10 locale=en -->


<!-- release-skill:changelog:start version=0.1.9 locale=en baseline=sha256:409f940c03e2d6fd41d33659b246b3d4b622918b4ac5a3a711d83aa09740ef11 -->
## [0.1.9] - 2026-07-23

v0.1.9 fixes a structural marketplace install verification failure: consumer installs that declare a plugin `source` subdirectory (e.g. `./adapters/claude`) now bind the installed payload to the declared subtree of the sealed whole-unit snapshot, and Claude's root `.in_use` marker is exempted as consumer-owned transport metadata. The sealed snapshot digest, release plan schema, and prepare-side freezing are unchanged, so already-frozen plans reconcile without re-approval. The npm package name (`release-skill`), publishing identity (`publisher: mzdbxqh`), public repository (`ifoohoo/release-skill`), and corporate maintainer remain unchanged.

### Fixed

- **Marketplace payload binding for subdirectory source layouts**: consumer
  marketplaces may declare a plugin `source` subdirectory such as
  `./adapters/claude`; the consumer CLI then installs only that subtree while
  the sealed authority is the whole unit snapshot. Install verification now
  revalidates the sealed whole-snapshot digest, re-reads the declared source
  from the marketplace manifest inside the digest-verified snapshot entries,
  and binds the installed payload to that prefix-stripped subtree. Root
  layouts and Kimi keep the whole-tree comparison. This resolves the
  flow-architect v0.4.1 and v0.5.0 PARTIAL marketplace install failures;
  already-frozen plans reconcile unchanged because the sealed digest, plan
  schema, and prepare-side freezing are untouched.
- **Claude `.in_use` transport marker exemption**: the Claude CLI writes an
  empty `.in_use` marker into the plugin install root; it is now exempted as
  consumer-owned transport metadata alongside the existing Codex/Kimi `.git`
  exemption, through a single shared exclusion helper that also backs the
  observe-time diagnostic fallback. Exemptions remain root-only: nested
  markers, extra payload, byte tampering, and sealed authority tampering
  still fail closed.
- **Regression coverage**: new protocol-level fake-CLI tests cover the
  subdirectory claude cycle with `.in_use` (including byte-tamper,
  extra-file, missing-file, `.git`-not-exempt, and nested-marker negatives),
  fail-closed manifest anomalies (duplicate plugin entry, wrong marketplace
  name, empty source projection), root-layout claude with `.in_use`, and a
  codex subdirectory variant.
<!-- release-skill:changelog:end version=0.1.9 locale=en -->


<!-- release-skill:changelog:start version=0.1.8 locale=en baseline=sha256:1e1a0af9d5807bceb7af1eae88b726f67e6811dba4db579fd625c07f3bdbca89 -->
## [0.1.8] - 2026-07-23

v0.1.8 adds Kimi Code as a first-class plugin host without rewriting the already-published v0.1.7 artifacts. Kimi delivery uses a generated self-contained adapter and a fail-closed, plan-bound manual installation attestation because Kimi Code has no scriptable non-interactive plugin installation interface. The npm package name (`release-skill`), publishing identity (`publisher: mzdbxqh`), public repository (`ifoohoo/release-skill`), and corporate maintainer remain unchanged.

### Changed

- **Kimi Code plugin delivery and verification**: v0.1.8 adds the root
  `.kimi-plugin/plugin.json`, a generated self-contained `adapters/kimi/` bundle,
  and public installation guidance. Because Kimi Code exposes no scriptable
  non-interactive plugin installation interface, production publish emits a
  version-pinned manual installation requirement and enters `PARTIAL`; an
  isolated `KIMI_CODE_HOME` installation and a trusted attestation bound
  independently to the frozen plan digest and payload digest are required before
  `reconcile` can reach `PUBLISHED` and `verify` can reach `VERIFIED`.
- **Immutable v0.1.7 history preserved**: the existing v0.1.7 Git tag,
  GitHub Release, npm version, and public commit remain untouched. The v0.1.8
  production plan binds the published v0.1.7 commit
  `fe5897456d4166a2ec60e99405836b122562b80d` as its previous public baseline.
<!-- release-skill:changelog:end version=0.1.8 locale=en -->


<!-- release-skill:changelog:start version=0.1.7 locale=en baseline=sha256:e41fd6460f5bb63343547f04b08e2cfcdd8a64cb53806cbcf39870a2fe27b03e -->
## [0.1.7] - 2026-07-23

v0.1.7 is an organizational migration release. The public GitHub repository moves from `mzdbxqh/release-skill` to `ifoohoo/release-skill` (the repository name is unchanged and GitHub redirects the old URL), the project gains an explicit corporate maintainer and copyright holder (广州市风荷科技有限公司), and the forward-looking repository, maintainer, author, and copyright metadata across the npm package, plugin marketplace manifests, NOTICE, LICENSE, and release configuration are aligned with the new organization. The npm package name (`release-skill`) and the npm publishing identity (`publisher: mzdbxqh`) are unchanged, and the already-published v0.1.6 tag, GitHub Release, and npm version are not rewritten.

### Changed

- **Public repository migrated to the `ifoohoo` organization**: the public
  GitHub repository is transferred from `mzdbxqh/release-skill` to
  `ifoohoo/release-skill` with the repository name unchanged. The default branch
  remains `main`, the v0.1.6 tag, release, and history are preserved, and the old
  URL redirects (HTTP 301) to the new location. The release configuration
  (`publicRepo` and the bound `previousPublicBaseline`) now points at
  `ifoohoo/release-skill` with the public v0.1.6 commit
  `48fb2a258a2786c2e32136ad67bd51f3a280b3b8` as the previous public baseline.
- **Corporate maintainer and copyright**: the MIT LICENSE (root and public
  package) now carries a dual copyright line for the release-skill contributors
  and 广州市风荷科技有限公司, and the NOTICE states that the project is maintained
  by 广州市风荷科技有限公司 and clarifies that the GitHub repository transfer is an
  administrative hosting/identity change that does not by itself constitute a
  copyright assignment.
- **Forward-looking metadata aligned with the organization**: the npm
  `package.json` repository, homepage, and issue tracker URLs point at
  `ifoohoo/release-skill`, and the package adds a corporate author while
  preserving the release-skill contributors. The Claude Code plugin marketplace
  owner now identifies the `ifoohoo` organization. The npm package name
  (`release-skill`) and the npm publishing identity (`publisher: mzdbxqh`) are
  unchanged.
<!-- release-skill:changelog:end version=0.1.7 locale=en -->


<!-- release-skill:changelog:start version=0.1.6 locale=en baseline=sha256:6b45d1aa912b32c9c00a616661ae3e2a9536e5ff85a7c0cf82b846a3ffb6c1d3 -->
## [0.1.6] - 2026-07-22

v0.1.6 is a release-preparation snapshot that closes the release-docs automation loop. A single structured release-notes source drives deterministic, multilingual CHANGELOG and README refresh behind a two-phase, digest-bound write protocol and a prepare-time documentation freshness gate, while terminal transaction receipts are bounded and the CLI lifecycle, path safety, and error-output redaction are hardened.

### Added

- **Structured release-notes-driven document refresh (`docs refresh`)**: a single
  structured release-notes source (`release-notes/0.1.6.yaml`) now drives
  deterministic, multilingual refresh of the managed CHANGELOG and README
  regions. Refresh runs as a two-phase protocol: a read-only planning phase
  renders every candidate and freezes an `inputDigest` (binding the canonical
  notes and the notes-source bytes) plus a `refreshDigest` (binding the protocol
  version, unit, version, configuration projection, and per-file old/new
  digests), and a separate write phase commits the changed targets only when all
  three authorizations are present (`--write`, an exact `--confirm-refresh
  <refreshDigest>` match, and `--ack-local-document-write`). The write phase
  re-plans under the exclusive lock; a diverging digest converges to
  `RELEASE_DOCS_REFRESH_STALE` with zero writes, and a clean plan is a zero-write
  no-op. A prepare-time documentation freshness gate makes version drift between
  the package version and the public docs fail closed before a release plan is
  frozen.
- **Bounded terminal transaction receipts with recovery safety**: terminal
  (committed / rolled-back) transactions now persist a summary-only receipt
  instead of full payload, capped at 256 KB per receipt
  (`TERMINAL_RECEIPT_SIZE_CAP`), under a retention cap of 50 terminal records
  (`DEFAULT_TRANSACTION_RETENTION_MAX`). Retention pruning only ever removes
  terminal records and never prunes `RECOVERY_CONFLICT` records or any
  non-terminal (recovery-relevant) record, so recovery evidence is preserved even
  when the count cap is reached; a retention failure never aborts an in-flight
  commit.
- **Strict `docs refresh` parameter validation (fail closed)**: the `docs`
  command validates every parameter before invoking the refresh service, so
  precise stable parameter errors surface even without project configuration or a
  safe-fs backend. The `--flag=value` equals form routes through exactly the same
  validation as the space-separated form; duplicated flags fail closed with
  `DUPLICATE_PARAMETER` before any service call, config read, lock, or
  transaction; and bare positional arguments and single-dash flags (such as `-w`)
  are rejected as unrecognized. Write-authorization flags supplied without
  `--write`, or `--write` without its full authorizations, fail closed with
  precise reasons rather than silently proceeding.

### Fixed

- **Bundle entry lifecycle settles with real exit codes**: the self-contained
  bundle now owns the command lifecycle. Its entry awaits command completion and
  exits with the real business exit code for success, business errors, handled
  async rejections, and unknown commands, so the launcher no longer leaves an
  unsettled top-level await (Node exit code 13). When the bundle is missing or
  cannot be evaluated, the launcher fails closed with static text only and never
  interpolates machine-specific paths, usernames, or host layout, because
  module-load failure messages carry absolute paths.
- **Fail-closed path canonicalization with stable diagnostics**: artifact path
  canonicalization requires POSIX separators and rejects absolute paths in POSIX
  (`/`), Windows drive-letter, and UNC spellings, along with traversal, Windows
  reserved device names, and colons, failing closed with `PATH_UNSAFE` rather
  than normalizing an unsafe spelling into a different public path. Error-output
  redaction now distinguishes real filesystem paths from strict RFC 6901 JSON
  Pointer diagnostic coordinates (such as `/units/0/version`): absolute
  POSIX/Windows/UNC paths collapse to a stable `<redacted-path>` placeholder
  while diagnostic pointers are preserved verbatim, keeping failures diagnosable
  without leaking host paths.
- **Self public-boundary redaction**: the centralized redaction authority
  (`core/redact.mjs`) now closes the self public boundary so runtime error
  outputs and detail structures never carry the release-skill workspace's own
  absolute path, nor the macOS `Users`, Linux home, macOS `private`/`var` alias,
  temp, or CI checkout realms. Redaction runs fail-closed through the
  `ReleaseError` choke point: any two-or-more-segment `/`-led token that is not a
  strict diagnostic JSON Pointer is replaced with `<redacted-path>`, so
  self-releasing never leaks private filesystem layout into public outputs.
<!-- release-skill:changelog:end version=0.1.6 locale=en -->


All notable changes to the `release-skill` plugin will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/).

<!-- release-skill:changelog:start version=0.1.5 locale=en baseline=sha256:72d222ff63008de63edcf20c89626fa18748e6cb39e54263e861b8f0c9669026 -->
## [0.1.5] - 2026-07-21

Claude and Codex marketplace installs now use an explicit, configurable timeout frozen into the release plan.

### Added

- **Explicit marketplace install timeout (`timeoutMs`)**: Claude and Codex
  plugin marketplace distributions now accept an optional `timeoutMs` integer
  field (range 30,000--900,000 ms; default 300,000 ms). The resolved value is
  frozen into each marketplace install action's `parameters.timeoutMs` during
  `prepare`, making it part of the plan digest, approval binding, and plan
  integrity. The `plugin-marketplace` adapter's marketplace add, plugin install,
  and plugin list commands all use the same frozen timeout, replacing the
  previous hardcoded 30-second limit that caused `PARTIAL` failures on real
  network installations requiring 40--105 seconds.
- **Old plan backward compatibility**: plans created before v0.1.5 that lack
  `parameters.timeoutMs` on marketplace install actions default to 300,000 ms,
  so existing `PARTIAL` runs can be reconciled without upgrading the plan.

### Fixed

- **Marketplace consumer install timeout**: v0.1.4 production releases hit
  `PARTIAL` because Claude Code and Codex plugin marketplace add commands
  required 40--105 seconds on real networks, while the adapter hardcoded a
  30-second subprocess timeout. The timeout is now explicitly configurable per
  distribution and verified through injected-executor tests. Invalid values
  (non-integer, non-finite, out-of-range) fail closed rather than being
  silently clamped.
<!-- release-skill:changelog:end version=0.1.5 locale=en -->

## [0.1.4] - 2026-07-19

### Added

- **Docs version hard gate**: the English and Chinese README and INSTALL each
  carry a machine-readable `release-skill:release-version` marker that must
  equal the `package.json` version, and the CHANGELOG must carry a formal
  heading for the current version. Any drift fails closed in
  `pnpm test:release` before prepare. A release freezes only the current
  truth: human docs are never auto-refreshed and must be updated, reviewed,
  and approved first.
- **Auditable frozen commit timestamps**: production `prepare` samples the
  plan freeze time once, validates it before any Git write, and binds it to
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and each unit's
  `frozenSnapshot.commitTimestamp` (schema-required); plans missing the field
  are rejected instead of silently rebuilt.

### Fixed

- **Self-contained installed CLI smoke**: the v0.1.3 self-release selected
  `help --json`, which correctly treats Git as a required environment
  dependency, while npm smoke intentionally exposes only the Node runtime.
  The CLI now supports `--version --json`, and self-release verification uses
  that dependency-free entry to bind the installed CLI name and exact version
  without widening the isolated process `PATH`.
- Added a real subprocess regression that runs the installed-style version
  entry with the Node-only `PATH` and proves an unrelated injected path is not
  inherited.

## [0.1.3] - 2026-07-19

> `0.1.2` was an internal release candidate and was never published to npm or
> GitHub Releases. Its fixes are included here; `0.1.3` is the next public
> release after `0.1.1`.

### Added

- **Create-once first-use setup**: `release-skill setup` performs deterministic,
  read-only discovery of packages, plugin manifests, Git remotes, legacy
  `public-release.json`, public-file hints, and project quality scripts. It
  reports `NEEDS_INPUT` or `LOCAL_ONLY_DETECTED` honestly and writes only an
  absent `.release-skill/project.yaml` after answers and the exact
  `setupDigest` are confirmed.
- **Discoverable `release-setup` skill**: Claude and Codex adapters now guide
  users through candidate review, explicit gate selection, fact-drift handling,
  and the safe handoff to `release-assess` without regenerating human content.
- **Project verification gates**: `snapshot-verify` runs selected commands in a
  disposable writable copy of the frozen public snapshot;
  `consumer-verify` runs after an exact isolated npm/Claude/Codex installation.
  Gate definitions, exact execution-input digests, and bounded output digests
  are frozen into plan/run evidence.
- **Identity-bound create-once setup**: the final facts/answers digest and
  config bytes are bound immediately before a directory-handle-relative,
  no-follow create. v0.1.3 ships a digest-registered `darwin-arm64` prebuild;
  unsupported platforms fail closed instead of using pathname writes.
- **Explicit production branch strategies**: projects can create an immutable
  release branch, fast-forward an existing branch from an exact bound baseline,
  or initialize an absent standard branch and make a separately approved,
  observable, reconcilable default-branch change.

### Changed

- Existing `public-release.json` snapshot commands are surfaced only as
  migration candidates. Discovery never grants execution authority; gate and
  legacy-hook side effects still require separate explicit acknowledgements.
- Compatibility configurations for artifact-graph, flow-architect, loop-agent,
  and agent-method-registry now bind real tag/channel/baseline semantics and
  project-owned verification behavior. glaf4-test is represented as local-only
  instead of receiving an invented remote channel.
- README and installation guidance now begin with safe setup, explain the three
  branch strategies, and distinguish pre-freeze hooks from frozen-snapshot and
  installed-consumer gates.

### Fixed

- **GitHub CLI Release-missing plain text compatibility**: `gh release view`
  returns plain text `release not found` when the target release does not
  exist; the previous implementation only recognized an HTTP 404 exit code.
  The adapter now maps that specific plain text to a missing-release
  decision without misclassifying `repository not found` or permission
  errors as a target release absence.
- **Plugin consumer install verification transport semantics**: frozen
  snapshots are sealed as read-only, but Git and plugin installation
  transport restores owner write permission on extraction. Verification
  now normalizes ordinary write permission from transport semantics and
  continues to strictly verify path, type, content, size, and executable
  intent. The frozen source digest is still compared against the plan and
  must not be back-filled from observed results.

## [0.1.1] - 2026-07-18

### Fixed

- **Stable npm byte handoff on macOS and Linux**: production publishing no
  longer passes `/dev/fd/*` or a mutable named path to npm. The adapter opens
  the frozen tarball with `O_NOFOLLOW`, verifies file identity, SHA-256,
  SHA-512 SRI, and embedded package name/version, then gives the same in-memory
  `Buffer` to `libnpmpublish`.
- **Registry and publisher authority**: plans freeze an explicit HTTPS npm
  registry and publisher. Preflight, token-specific `whoami`, publish,
  observation, and consumer install all use that registry; bearer credentials
  are sent with `forceAuth` and never fall back to ambient identity.
- **Pre-write tarball identity gate**: prepare and publish global preflight
  reject a tarball whose manifest name/version or independently computed
  integrity differs from the frozen unit and distribution, before any Git or
  npm external action executes.
- **Digest-addressed plan and approval history**: production commands consume
  `plans/<planDigest>.json` and
  `approvals/<planDigest>/<approvalDigest>.json`. Renewing an expired approval
  preserves prior approval bytes, so a long-lived PARTIAL recovery remains
  auditable without reusing expired authority.
- **Reconcile succeeded checkpoint fail-closed**: when re-observing a
  succeeded checkpoint, if the remote returns empty/error/uncertain state,
  reconcile now fails closed with REMOTE_CONFLICT instead of adding to the
  retry list. This prevents blind re-execution of already-succeeded actions.
- **Production README blocking findings**: missing required markers and
  readability requirements (install command, minimal example, failure
  diagnosis) in production prepare are now blocking findings (GATE_FAILED),
  not warnings.

## [0.1.0] - 2026-07-15

### Added

- **release-help** skill: discoverable entry point with environment checks,
  capability overview, minimal examples, read-only diagnosis, dry-run
  guidance, and failure triage.
- **release-assess** skill: read-only project topology identification and
  gap evaluation for documentation, configuration, supply chain, and
  release workflow.
- **release-prepare** skill: gate execution and release plan freezing
  without any external writes.
- **release-publish** skill: external release checkpoint execution from
  an approved, non-expired release plan.
- **release-reconcile** skill: remote state querying, partial success
  handling, safe retries, and post-publish verification.
- Deterministic release state machine:
  DISCOVERED -> ASSESSED -> PREPARED -> APPROVED -> PUBLISHING -> PUBLISHED -> VERIFIED.
- Exception states: NEEDS_INPUT, BLOCKED, PARTIAL.
- Adapter layer for Git/GitHub, npm, Claude Code marketplace, and Codex
  marketplace.
- Project declaration via `.release-skill/project.yaml` configuration.
- Hook execution model with executable/argument arrays, relative cwd,
  timeout, and environment allowlist.
- Structured evidence output in JSON/JSONL format with per-step
  checkpointing.
- Read-only assess and prepare phases; publish requires explicit approval
  bound to a frozen release plan digest.
- 24-hour approval expiry with automatic invalidation on plan, tree hash,
  target version, or remote conflict changes.
- Reconcile with idempotent skip of already-consistent steps and safe
  retry of incomplete actions.
