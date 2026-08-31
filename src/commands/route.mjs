/**
 * release-route command: Deterministic quickstart routing for workflow profiles.
 *
 * Implements handoff §4.3:
 *   - Input A: current worktree diff classification (git status --porcelain,
 *     including untracked files; deterministic path-prefix rules);
 *   - Input B: change surface vs the previous release (previousPublicBaseline
 *     bound commit tree vs current worktree; fail-closed when undeterminable);
 *   - Input C: targetVersion requested, remote-write authorization, PARTIAL
 *     run state.
 *
 * Decision table (fail-closed):
 *   1. validated unfinished lineage → phase-specific recovery or diagnosis
 *   2. A empty && no targetVersion → help (report no change)
 *      (判据说明：决策表 §4.3 字面为「B=none 且无 targetVersion → help」，
 *      实现用「输入 A 空」判定——A 空但相对上一版本存在已提交未发布改动
 *      （B≠none）时仍报 help。help 不裁剪任何门禁，两者在安全方向上等价：
 *      A 空判定覆盖 B=none，且多余场景只会落到更保守的 help，无安全影响。)
 *   3. B indeterminable → full-happy-end (never trim gates on unknown surface)
 *   4. A=docs && B=docs → docs-only
 *   5. A=config && B=config → config-only
 *   6. A=marketplace && B=marketplace → marketplace-only
 *   7. A=marketplace+docs / marketplace+config (no code) → chained
 *      marketplace-<other> recommendation
 *   8. everything else (mixed, B≠A, code involvement) → full-happy-end
 *
 * Workflow Profiles (§4):
 *   - full-happy-end: longest path with all gates
 *   - docs-only: pure documentation changes (skips code-class gates/hooks)
 *   - config-only: pure configuration changes (schema gates; no publish path
 *     when public bytes are unchanged)
 *   - marketplace-only: pure marketplace index changes (delegates release to
 *     the workspace's own release skill)
 */

import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { relative, resolve, basename, dirname, join } from 'node:path';
import { ReleaseError, GATE_FAILED } from '../core/errors.mjs';
import { listReleaseTags } from './lineage.mjs';
import { readRunRecovery, renderRecoveryCommand } from '../core/recovery.mjs';
import {
  loadRun,
  validateRunLineage,
  validateRunPlanDigest,
  validateRunCheckpointMapping,
} from '../core/run.mjs';
import { computePlanDigest, validatePlan } from '../core/plan.mjs';
import { resolveProducerVersion } from '../core/evidence.mjs';
import { normalizePostPublishView, postPublishActionId } from '../core/postpublish.mjs';

const WORKFLOW_KINDS = Object.freeze([
  'full-happy-end',
  'docs-only',
  'config-only',
  'marketplace-only',
  'marketplace-docs',
  'marketplace-config',
  'reconcile',
  'distribute',
  'verify',
  'help',
]);

/**
 * Classify a single path per the handoff §4.3 prefix table.
 *
 * Order matters: marketplace and config paths are checked before generic
 * code-path rules (a `.mjs` file under `public-snapshot/` or a `plugins.mjs`
 * must never be classified as code).
 *
 * @param {string} path - repository-relative path
 * @returns {'code'|'docs'|'config'|'marketplace'|'version'|'other'|'ignore'}
 *   - ignore: evidence/run directories that are never part of a change surface
 */
export function classifyPath(path) {
  if (typeof path !== 'string' || path.length === 0) return 'ignore';
  const p = path.replace(/\\+/g, '/');

  // Evidence/run directories: not part of any change surface.
  if (
    p.startsWith('.release-skill/runs/') ||
    p.startsWith('.release-skill/plans/') ||
    p.startsWith('.release-skill/evidence/')
  ) {
    return 'ignore';
  }

  // Marketplace index and snapshot bytes.
  if (p === 'plugins.mjs' || p.endsWith('/plugins.mjs') || p.startsWith('public-snapshot/')) {
    return 'marketplace';
  }

  // Config: project config + schemas.
  if (p === '.release-skill/project.yaml' || p.startsWith('schemas/')) {
    return 'config';
  }

  // Docs per §4.3: docs/public/site/, README*, CHANGELOG, release-notes/.
  if (
    p.startsWith('docs/public/site/') ||
    /^README(\.|$)/i.test(p) ||
    /^CHANGELOG(\.|$)/i.test(p) ||
    p.startsWith('release-notes/')
  ) {
    return 'docs';
  }

  // Version sources (e.g. package.json) are their own category so input B can
  // report "version-only"; for routing purposes they behave like code.
  if (p === 'package.json' || p.endsWith('/package.json')) {
    return 'version';
  }

  // Code paths per §4.3: src/, test/, scripts/, native/.
  if (
    p.startsWith('src/') ||
    p.startsWith('test/') ||
    p.startsWith('scripts/') ||
    p.startsWith('native/')
  ) {
    return 'code';
  }

  // Any other source/manifest file is treated as code.
  if (p.endsWith('.mjs') || p.endsWith('.js') || p.endsWith('.cjs') || p.endsWith('.ts') || p.endsWith('.json')) {
    return 'code';
  }

  // Unclassified paths fail closed: treated as code (forces full-happy-end).
  return 'other';
}

/**
 * Bucket a list of paths into classification categories.
 *
 * @param {string[]} paths
 * @returns {{ code: string[], docs: string[], config: string[], marketplace: string[], version: string[], other: string[], mixed: boolean }}
 */
export function bucketPaths(paths) {
  const buckets = { code: [], docs: [], config: [], marketplace: [], version: [], other: [] };
  for (const path of paths) {
    const kind = classifyPath(path);
    if (kind === 'ignore') continue;
    if (kind === 'code' || kind === 'other') {
      buckets[kind].push(path);
    } else {
      buckets[kind].push(path);
    }
  }
  const codeLikeCount = buckets.code.length > 0 || buckets.other.length > 0 ? 1 : 0;
  const categoryCount =
    codeLikeCount +
    // version sources behave like code for mixing purposes: a version bump
    // alongside docs/config/marketplace changes is never a pure workflow.
    (buckets.version.length > 0 ? 1 : 0) +
    (buckets.docs.length > 0 ? 1 : 0) +
    (buckets.config.length > 0 ? 1 : 0) +
    (buckets.marketplace.length > 0 ? 1 : 0);
  return { ...buckets, mixed: categoryCount > 1 };
}

/**
 * Input A: classify the current worktree diff vs HEAD.
 *
 * Uses `git status --porcelain=v1 -z` (staged + unstaged + untracked; NUL
 * separated, unquoted paths). `git diff HEAD..HEAD` is never used — it is
 * always empty and would silently misreport a dirty worktree as "no change".
 *
 * @param {string} root - project root directory
 * @returns {Promise<{ code: string[], docs: string[], config: string[], marketplace: string[], version: string[], other: string[], mixed: boolean }>}
 */
export async function classifyWorktreeDiff(root) {
  const cwd = resolve(root);
  let output;
  try {
    // --untracked-files=all: never let git collapse an untracked directory to
    // `?? docs/` — every untracked file is listed individually so path-prefix
    // classification sees the real file, not a directory stub.
    output = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    throw new ReleaseError(
      'GIT_STATUS_FAILED',
      `failed to execute git status in ${cwd}: ${err.message}`,
      { reason: err.code ?? 'UNKNOWN_ERROR', root: cwd },
      2,
    );
  }

  // NUL-separated entries: "XY path" (renames: "XY old" then "new").
  const entries = output.length > 0 ? output.split('\0').filter((e) => e.length > 0) : [];
  const paths = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const statusPart = entry.slice(0, 2);
    const pathPart = entry.slice(3);
    if (pathPart.length === 0) continue;
    paths.push(pathPart);
    // Rename/copy entries have the destination as the next NUL field.
    if ((statusPart[0] === 'R' || statusPart[0] === 'C') && entries[i + 1] !== undefined) {
      paths.push(entries[i + 1]);
      i += 1;
    }
  }

  return bucketPaths(paths);
}

/**
 * Resolve the previous release commit (input B data source).
 *
 * Order of resolution:
 *   1. most recent frozen plan in `.release-skill/plans/` whose unit carries a
 *      bound previousPublicBaseline.commit — the same data source the
 *      chain-binding mechanism uses;
 *   2. newest release tag present in the local object database.
 *
 * @param {string} root - project root directory
 * @returns {Promise<{ commit: string, source: 'plan' | 'tag', detail: string } | null>}
 *   null when no previous release commit can be determined.
 */
export async function resolvePreviousReleaseCommit(root) {
  const cwd = resolve(root);

  // 1. Latest frozen plan with a bound previous public baseline.
  try {
    const plansDir = resolve(cwd, '.release-skill', 'plans');
    const planFiles = await readdir(plansDir).catch(() => []);
    let best = null;
    for (const file of planFiles) {
      if (!file.endsWith('.json')) continue;
      let plan;
      try {
        plan = JSON.parse(await readFile(resolve(plansDir, file), 'utf8'));
      } catch {
        continue;
      }
      if (!Array.isArray(plan.units)) continue;
      const ppb = plan.units[0]?.previousPublicBaseline;
      if (!ppb || ppb.mode !== 'bound' || typeof ppb.commit !== 'string') continue;
      const createdAt = plan.createdAt ?? '';
      if (!best || createdAt > best.createdAt) best = { createdAt, commit: ppb.commit, planFile: file };
    }
    if (best) {
      const exists = await objectExistsLocally(cwd, best.commit);
      if (exists) return { commit: best.commit, source: 'plan', detail: best.planFile };
    }
  } catch {
    // fall through to tag resolution
  }

  // 2. Newest local release tag.
  try {
    const releases = await listReleaseTags(cwd);
    if (releases.length > 0) {
      const latest = releases[releases.length - 1];
      return { commit: latest.commitSha, source: 'tag', detail: latest.name };
    }
  } catch {
    // fall through
  }

  return null;
}

async function objectExistsLocally(root, sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Input B: classify the change surface since the previous release commit.
 *
 * Compares the previous release commit's tree with the current worktree
 * (committed changes + uncommitted worktree state). Returns the category
 * union; a surface containing only version sources reports 'version-only'.
 *
 * @param {string} root - project root directory
 * @param {string} prevCommit - previous release commit SHA
 * @returns {Promise<{
 *   status: 'determinable',
 *   categories: { code: string[], docs: string[], config: string[], marketplace: string[], version: string[], other: string[] },
 *   kind: 'code'|'docs'|'config'|'marketplace'|'version-only'|'none'|'mixed',
 *   paths: string[]
 * }>}
 */
export async function classifyBaselineSurface(root, prevCommit) {
  const cwd = resolve(root);
  let diffOutput = '';
  try {
    diffOutput = execFileSync(
      'git',
      ['diff', '--name-only', prevCommit, 'HEAD'],
      { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    throw new ReleaseError(
      'GIT_DIFF_FAILED',
      `failed to diff previous release commit ${prevCommit}: ${err.message}`,
      { reason: err.code ?? 'UNKNOWN_ERROR', prevCommit },
      2,
    );
  }

  const worktree = await classifyWorktreeDiff(cwd);
  const committedPaths = diffOutput.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  // Only the path arrays join the surface; classifyWorktreeDiff also carries
  // a `mixed` boolean that must never be treated as a path.
  const allPaths = [...new Set([
    ...committedPaths,
    ...worktree.code,
    ...worktree.docs,
    ...worktree.config,
    ...worktree.marketplace,
    ...worktree.version,
    ...worktree.other,
  ])];
  const buckets = bucketPaths(allPaths);

  const hasCode = buckets.code.length > 0 || buckets.other.length > 0;
  const hasDocs = buckets.docs.length > 0;
  const hasConfig = buckets.config.length > 0;
  const hasMarketplace = buckets.marketplace.length > 0;
  const hasVersion = buckets.version.length > 0;

  let kind;
  if (allPaths.length === 0) {
    kind = 'none';
  } else if (!hasCode && !hasDocs && !hasConfig && !hasMarketplace && hasVersion) {
    kind = 'version-only';
  } else {
    const categoryCount = [hasCode, hasDocs, hasConfig, hasMarketplace].filter(Boolean).length;
    kind = categoryCount > 1 ? 'mixed' : hasCode ? 'code' : hasDocs ? 'docs' : hasConfig ? 'config' : 'marketplace';
  }

  return { status: 'determinable', categories: buckets, kind, paths: allPaths };
}

/**
 * Resolve unfinished release work from validated run authorities (rule 1).
 *
 * R-06A: `summary.json` is downgraded to a rebuildable diagnostic projection;
 * the route decision reads the sealed run record
 * `runs/<phase>-<ts>/release-run.json` instead. Plan/action mappings and source
 * lineage determine which stage remains unfinished. Summary files are not
 * read. Invalid authority is diagnostic, never permission for a new release.
 *
 * @param {string} root - project root directory
 * @returns {Promise<{hasPartialRun: boolean, recoveryActionCode: string|null, runs: object[]}>}
 */
export async function readRunRouting(root, options = {}) {
  const cwd = resolve(root);
  const targetVersion = options.targetVersion ?? null;
  const runsDir = resolve(cwd, '.release-skill', 'runs');
  let runDirs;
  try {
    runDirs = await readdir(runsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { hasPartialRun: false, recoveryActionCode: null, runs: [] };
    const relativePath = relative(cwd, runsDir);
    const diagnostic = {
      code: error.code ?? 'RUNS_DIRECTORY_UNREADABLE',
      message: `cannot read release runs directory: ${error.message}`,
      relativePath,
      nextActionCode: 'DIAGNOSE',
      nextAction: '保留历史记录，先按该路径完成人工诊断，再决定正式恢复动作',
      classification: 'UNKNOWN_LEGACY_OR_CORRUPT_AUTHORITY',
    };
    const run = {
      runPath: runsDir,
      recoveryActionCode: null,
      diagnostic,
    };
    return {
      hasPartialRun: false,
      recoveryActionCode: null,
      runs: [],
      diagnostics: [{
        path: relativePath,
        runPath: runsDir,
        classification: diagnostic.classification,
        basis: diagnostic.message,
        recoveryActionCode: null,
        nextActionCode: 'DIAGNOSE',
        nextAction: diagnostic.nextAction,
      }],
    };
  }
  const records = [];
  const diagnostics = [];
  for (const runDir of runDirs) {
    let runPath = resolve(runsDir, runDir, 'release-run.json');
    const runDirectory = resolve(runsDir, runDir);
    let authorityExists = false;
    let authorityMissing = false;
    let markerlessRunDebris = false;
    try {
      await readFile(runPath);
      authorityExists = true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        authorityMissing = true;
        // Prepare/assess have evidence directories but no release-run contract.
        if (/^(prepare|assess|hooks-validate)-/.test(runDir)) continue;
        const statesPath = resolve(runsDir, runDir, 'states');
        const stateInspection = await inspectStateDirectory(statesPath);
        if (!stateInspection.ok) {
          records.push({
            runPath: stateInspection.path,
            recoveryActionCode: 'DIAGNOSE',
            diagnostic: {
              code: stateInspection.code,
              message: stateInspection.message,
            },
          });
          continue;
        }
        // An append-only sequence is ordered by its bound slot, never by time.
        // readRunRecovery reuses validateRunLineage to check its predecessors.
        const slots = stateInspection.entries.filter((name) => /^\d{6}\.json$/.test(name)).sort();
        if (slots.length > 0) {
          runPath = resolve(runsDir, runDir, 'states', slots.at(-1));
          authorityExists = true;
        }
      }
    }
    if (!authorityExists && authorityMissing
      && await isProvenPreAuthorityFailure(runDirectory, runDir)) {
      diagnostics.push({
        path: relative(cwd, runDirectory),
        relativePath: relative(cwd, runPath),
        runPath,
        classification: 'PRE_AUTHORITY_FAILURE',
        basis: '版本化 evidence writer、发布命令顺序和缺少 states/release-run.json 共同证明未取得运行 authority，未进入 checkpoint execute',
        recoveryActionCode: 'RETRY_COMMAND',
        nextActionCode: 'RETRY_COMMAND',
        nextAction: '修复失败原因后重新运行原命令；该目录不是发布 authority',
      });
      continue;
    }
    const record = runDir.startsWith('postverify-') && authorityExists
      ? await readLegacyPostverifyRecovery(runPath)
      : await readRunRecovery(runPath, options);
    if (targetVersion && authorityMissing) {
      markerlessRunDebris = await isMarkerlessRunDebris(runDirectory);
      if (markerlessRunDebris) record.emptyRunDebris = true;
    }
    records.push(record);
  }
  const targetScopedRecords = [];
  const historicalDiagnostics = [];
  for (const record of records) {
    // Without an explicit target there is no safe release authority to
    // recover. Keep every finding visible, but leave workflow selection to
    // diff/baseline classification. This prevents an old DIAGNOSE or PARTIAL
    // record from becoming an implicit target or an authorization gate.
    if (!targetVersion) {
      historicalDiagnostics.push(buildHistoricalDiagnostic(cwd, record, null));
      continue;
    }
    if (!(await classifyTargetScope(cwd, record, targetVersion))) {
      historicalDiagnostics.push(buildHistoricalDiagnostic(cwd, record, targetVersion));
    } else {
      targetScopedRecords.push(record);
    }
  }
  const identity = (run) => `${run.planDigest}:${run.runId}:${run.runDigest}`;
  const consumed = new Set(records.filter((r) => r.run).flatMap((r) => r.lineage.map((edge) => identity(edge.run))));
  const samePublication = (a, b) => a.planDigest === b.planDigest
    && a.sourceRunId === b.sourceRunId && a.sourceRunDigest === b.sourceRunDigest;
  const unresolved = targetScopedRecords.filter((record) => {
    // A record is eligible for current recovery only after the existing
    // reader has validated its run and its bound plan. Invalid, legacy, and
    // damaged records remain diagnostics and can never authorize recovery.
    if (!record.run || !record.plan) return false;
    if (consumed.has(identity(record.run))) return false;
    // Distribute retries point to the same publication, not to each other.
    // Only a validated completed distribution can retire its failed sibling.
    if (record.run.command === 'distribute' && record.run.status !== 'DISTRIBUTED'
      && records.some((other) => other.run?.command === 'distribute'
        && other.run.status === 'DISTRIBUTED' && other.recoveryActionCode === 'VERIFY'
        && samePublication(record.run, other.run))) return false;
    if (record.run.command === 'distribute' && record.recoveryActionCode === 'VERIFY'
      && records.some((other) => other.run?.command === 'verify' && other.run.status === 'VERIFIED'
        && other.recoveryActionCode === null && samePublication(record.run, other.run))) return false;
    return true;
  });
  const priority = ['DIAGNOSE', 'RECONCILE', 'DISTRIBUTE', 'VERIFY', 'RETRY_COMMAND'];
  const actionable = unresolved.filter((record) =>
    typeof record.recoveryActionCode === 'string' && record.recoveryActionCode.length > 0);
  // Multiple valid unfinished authorities for one explicit target cannot be
  // selected by directory order, mtime, or producer metadata. Surface all of
  // them and require an operator to choose the exact lineage.
  const recoveryActionCode = actionable.length > 1
    ? 'DIAGNOSE'
    : priority.find((code) => unresolved.some((r) => r.recoveryActionCode === code)) ?? null;
  const runs = unresolved.filter((r) => r.recoveryActionCode).map((r) => ({
    runPath: r.runPath,
    planPath: r.run?.planPath,
    command: r.run?.command,
    status: r.run?.status,
    recoveryActionCode: r.recoveryActionCode,
    recoveryRunPath: r.recoveryRunPath,
    ...(r.diagnostic ? {
      diagnostic: {
        ...r.diagnostic,
        relativePath: r.runPath ? relative(cwd, r.runPath) : null,
        nextActionCode: 'DIAGNOSE',
        nextAction: '保留历史记录，先按该路径完成人工诊断，再决定正式恢复动作',
        classification: 'UNKNOWN_LEGACY_OR_CORRUPT_AUTHORITY',
      },
    } : {}),
  })).sort((a, b) => a.runPath.localeCompare(b.runPath));
  const unifiedDiagnostics = [
    ...diagnostics,
    ...historicalDiagnostics,
    ...runs.filter((run) => run.diagnostic).map((run) => ({
      path: run.diagnostic.relativePath,
      runPath: run.runPath,
      classification: run.diagnostic.classification,
      basis: run.diagnostic.message,
      recoveryActionCode: run.recoveryActionCode,
      nextActionCode: run.diagnostic.nextActionCode,
      nextAction: run.diagnostic.nextAction,
    })),
  ];
  return {
    hasPartialRun: unresolved.some((r) => r.run?.status === 'PARTIAL'),
    recoveryActionCode,
    runs,
    ...(unifiedDiagnostics.length > 0 ? { diagnostics: unifiedDiagnostics } : {}),
  };
}

/**
 * Resolve whether a validated record belongs to the explicitly requested
 * target. Plans are the only release-domain target authority; evidence and
 * directory names never substitute for a plan binding.
 */
function planTargetVersions(plan) {
  return [...new Set((Array.isArray(plan?.units) ? plan.units : [])
    .map((unit) => unit?.targetVersion)
    .filter((version) => typeof version === 'string' && version.length > 0))];
}

async function classifyTargetScope(cwd, record, targetVersion) {
  if (record.emptyRunDebris) return false;
  // Only the fully validated run + plan pair is a current-recovery
  // candidate. A readable path, producer version, directory name, timestamp,
  // summary, or error text cannot substitute for that authority.
  if (!(record.run && record.plan)) return false;
  const versions = planTargetVersions(record.plan);
  return versions.length > 0 && versions.every((version) => version === targetVersion);
}

function buildHistoricalDiagnostic(cwd, record, targetVersion) {
  const path = record.runPath ? relative(cwd, record.runPath) : null;
  const versions = planTargetVersions(record.plan);
  const binding = !targetVersion
    ? '未指定目标版本；该记录只能作为历史诊断，不能决定当前工作流'
    : record.emptyRunDebris
    ? '目录内没有可识别 authority、summary、evidence 或 state 制品的空 debris'
    : versions.length > 0
    ? `记录绑定版本 ${versions.join('、')}`
    : '记录属于不能绑定目标版本的旧 authority 或 legacy schema';
  return {
    path,
    runPath: record.runPath,
    classification: 'HISTORICAL_OUT_OF_SCOPE',
    basis: targetVersion
      ? `${binding}，显式目标为 ${targetVersion}；保留历史诊断，不参与目标版本阻断计数或下一动作`
      : `${binding}；保留历史诊断，不参与当前工作流或恢复动作`,
    recoveryActionCode: record.recoveryActionCode ?? null,
    nextActionCode: null,
    nextAction: '仅作历史诊断，不参与当前目标版本路由',
  };
}

async function isMarkerlessRunDebris(runDirectory) {
  const knownConsumers = new Set(['claude', 'codex', 'kimi', 'codebuddy', 'workbuddy']);
  const readDirectory = async (path) => {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch {
      return null;
    }
  };
  const entries = await readDirectory(runDirectory);
  if (entries === null) return false;
  if (entries.length === 0) return true;

  // A lifecycle run has its markers at the run root. The only markerless
  // exception is the known consumer-install evidence layout, whose payload
  // is nested below `evidence/` (with optional consumer homes beside it).
  const allowed = new Set(['evidence', 'consumers']);
  if (entries.some((entry) => !allowed.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())) return false;
  const evidence = entries.find((entry) => entry.name === 'evidence');
  if (!evidence) return false;
  const evidenceEntries = await readDirectory(join(runDirectory, 'evidence'));
  if (!evidenceEntries || evidenceEntries.length === 0) return false;
  for (const evidenceEntry of evidenceEntries) {
    if (!evidenceEntry.isDirectory() || evidenceEntry.isSymbolicLink()
      || !/^[a-z][a-z0-9-]*$/i.test(evidenceEntry.name)) return false;
    const evidenceFiles = await readDirectory(join(runDirectory, 'evidence', evidenceEntry.name));
    if (!evidenceFiles || evidenceFiles.length !== 1
      || evidenceFiles[0].name !== 'release-skill-install-evidence.json'
      || !evidenceFiles[0].isFile() || evidenceFiles[0].isSymbolicLink()) return false;
    try {
      const evidenceRecord = JSON.parse(await readFile(
        join(runDirectory, 'evidence', evidenceEntry.name, evidenceFiles[0].name),
        'utf8',
      ));
      if (!evidenceRecord || typeof evidenceRecord !== 'object' || Array.isArray(evidenceRecord)
        || !knownConsumers.has(evidenceRecord.consumer)
        || typeof evidenceRecord.plugin !== 'string' || evidenceRecord.plugin.length === 0
        || typeof evidenceRecord.version !== 'string' || evidenceRecord.version.length === 0) return false;
    } catch {
      return false;
    }
  }

  const consumers = entries.find((entry) => entry.name === 'consumers');
  if (consumers) {
    const consumerEntries = await readDirectory(join(runDirectory, 'consumers'));
    if (!consumerEntries || consumerEntries.length === 0) return false;
    for (const consumerEntry of consumerEntries) {
      const consumer = consumerEntry.name.split('-', 1)[0];
      if (!consumerEntry.isDirectory() || consumerEntry.isSymbolicLink()
        || !knownConsumers.has(consumer)) return false;
      const homeEntries = await readDirectory(join(runDirectory, 'consumers', consumerEntry.name));
      if (!homeEntries || homeEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()
        || !knownConsumers.has(entry.name.slice(1)))) return false;
    }
  }
  return true;
}

/**
 * The publish writer creates the run directory before evidence, but writes
 * its first immutable run state only after global preflight and immediately
 * before checkpoint execution. Its final catch appends one generic failed
 * `publish` event; when no authority exists, all preceding events must still
 * be pre-authority phases. A current v2 summary/evidence pair with that exact
 * shape therefore proves a failed, non-authoritative attempt. Legacy v1
 * streams use the same writer order but have no producer envelope; they are
 * accepted only when their older, looser event shape still proves the same
 * boundary. Summaries without matching evidence and any stream that reached
 * a persisted `publish` or checkpoint event remain diagnostic.
 */
async function inspectStateDirectory(statesPath) {
  let directoryStat;
  try {
    directoryStat = await lstat(statesPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, entries: [] };
    return {
      ok: false,
      path: statesPath,
      code: 'STATE_DIRECTORY_UNREADABLE',
      message: `cannot inspect run states directory: ${error.message}`,
    };
  }
  if (!directoryStat.isDirectory()) {
    return {
      ok: false,
      path: statesPath,
      code: 'STATE_DIRECTORY_INVALID',
      message: 'run states path is not a regular directory',
    };
  }
  let entries;
  try {
    entries = await readdir(statesPath);
  } catch (error) {
    return {
      ok: false,
      path: statesPath,
      code: 'STATE_DIRECTORY_UNREADABLE',
      message: `cannot read run states directory: ${error.message}`,
    };
  }
  for (const entry of entries) {
    let entryStat;
    const entryPath = join(statesPath, entry);
    try {
      entryStat = await lstat(entryPath);
    } catch (error) {
      return {
        ok: false,
        path: entryPath,
        code: 'STATE_ENTRY_UNREADABLE',
        message: `cannot inspect run state entry: ${error.message}`,
      };
    }
    if (!/^\d{6}\.json$/.test(entry) || !entryStat.isFile() || entryStat.isSymbolicLink()) {
      return {
        ok: false,
        path: entryPath,
        code: 'STATE_ENTRY_INVALID',
        message: 'run states must contain only regular files named NNNNNN.json',
      };
    }
  }
  return { ok: true, entries };
}

async function isProvenPreAuthorityFailure(runDir, runName) {
  if (!/^publish-/.test(runName)) return false;
  const summaryPath = join(runDir, 'summary.json');
  const evidencePath = join(runDir, 'evidence.jsonl');
  let summary;
  let events;
  try {
    summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    events = (await readFile(evidencePath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return false;
  }

  // The v1 writer (used before the producer-bound v2 envelope) created the
  // run directory and appended safety-gate events before its first
  // `release-run.json` state. A failed global preflight then appended only a
  // generic `publish` failure and sealed a summary. This branch deliberately
  // accepts that historical shape only when every byte still proves the same
  // pre-authority boundary. It never infers safety from a directory name,
  // mtime, summary alone, or a loosely similar phase.
  const legacyPreAuthorityPhases = new Set([
    'safety-gate',
    'global-preflight-arbitration',
    're-observe-previous-public-baseline',
  ]);
  const legacyInputFailure = /(?:global preflight failed|source authority .*failed|cannot read (?:release plan|approval record)|production (?:publish|commands) require|plan (?:digest mismatch|action completeness gate failed|is not valid|requires)|baseline (?:changed|check failed)|previous-public-baseline|adapter .*failed)/i;
  const legacyUnsafeFailure = /(?:remote (?:tag|branch|release) .*already exists|human intervention required|remote conflict|external write)/i;
  const legacyPreAuthorityGates = new Set([
    'plan-load',
    'plan-schema',
    'plan-digest',
    'action-completeness',
    'approval-load',
    'adapter-availability',
    'baseline-check',
    'source-authority',
  ]);
  const validLegacyTimestamp = (value) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
  const validLegacyError = (error) => error && typeof error === 'object' && !Array.isArray(error)
    && typeof error.code === 'string' && error.code.length > 0
    && (error.message === undefined || typeof error.message === 'string');
  const validLegacyEvent = (event, runId) => event && typeof event === 'object' && !Array.isArray(event)
    && event.schemaVersion === 1
    && !Object.hasOwn(event, 'producer')
    && typeof event.runId === 'string' && event.runId === runId
    && Number.isSafeInteger(event.sequence) && event.sequence >= 1
    && validLegacyTimestamp(event.timestamp)
    && event.command === 'publish'
    && typeof event.phase === 'string'
    && (legacyPreAuthorityPhases.has(event.phase) || event.phase === 'publish')
    && typeof event.status === 'string' && event.status.length > 0
    && (event.error === undefined || event.error === null || validLegacyError(event.error))
    && (event.duration === undefined || Number.isSafeInteger(event.duration) && event.duration >= 0)
    && (event.details === undefined || event.details !== null
      && typeof event.details === 'object' && !Array.isArray(event.details));
  const legacyRunId = basename(runDir);
  const legacyTerminal = events.at(-1);
  const legacyValid = summary && summary.status === 'FAILED'
    && validLegacyError(summary.error)
    && typeof summary.error.message === 'string' && legacyInputFailure.test(summary.error.message)
    && !legacyUnsafeFailure.test(summary.error.message)
    && (summary.recoveryActionCode === undefined || summary.recoveryActionCode === 'RETRY_COMMAND')
    && summary.runPath === undefined
    && summary.finalRunDigest === undefined
    && summary.latestStatePath === undefined
    && summary.checkpointStatuses === undefined
    && Array.isArray(events) && events.length >= 2
    && events.every((event, index) => validLegacyEvent(event, legacyRunId)
      && event.sequence === index + 1)
    && legacyTerminal.phase === 'publish'
    && legacyTerminal.status === 'failed'
    && validLegacyError(legacyTerminal.error)
    && legacyTerminal.error.code === summary.error.code
    && events.slice(0, -1).filter((event) => event.status === 'failed').every((event) =>
      event.phase === 'safety-gate'
      && legacyPreAuthorityGates.has(event.gate)
      && validLegacyError(event.error))
    && !events.some((event) => event.phase === 'global-preflight-arbitration'
      && event.status !== 'pre-observe')
    && !events.slice(0, -1).some((event) => event.phase === 'publish'
      || /checkpoint|execute|postpublish/i.test(event.phase)
      || Object.hasOwn(event, 'prePersistedRunPath')
      || Object.hasOwn(event, 'checkpointCount')
      || Object.hasOwn(event, 'checkpointStatuses'));
  if (legacyValid) return true;

  const producerVersion = resolveProducerVersion();
  const sameProducer = (value) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2
    && value.name === 'release-skill' && value.version === producerVersion;
  const envelopeKeys = new Set([
    'schemaVersion', 'runId', 'sequence', 'timestamp', 'command', 'producer',
    'phase', 'status', 'error', 'duration', 'details',
  ]);
  const validTimestamp = (value) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
  const detailValidators = {
    unitId: (value) => typeof value === 'string',
    gate: (value) => typeof value === 'string',
    hookName: (value) => typeof value === 'string',
    actionId: (value) => typeof value === 'string',
    step: (value) => typeof value === 'string',
    hookId: (value) => typeof value === 'string',
    tagCommit: (value) => typeof value === 'string',
    cached: (value) => typeof value === 'boolean',
    testSelection: (value) => typeof value === 'string',
    cacheKey: (value) => typeof value === 'string',
    durationMs: (value) => value === null || Number.isSafeInteger(value) && value >= 0,
    exitCode: (value) => Number.isSafeInteger(value),
    findingCount: (value) => Number.isSafeInteger(value) && value >= 0,
  };
  const validDetails = (value) => value === undefined
    || value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.entries(value).every(([key, detail]) => !detailValidators[key] || detailValidators[key](detail));
  const validEnvelope = (event) => event && typeof event === 'object'
    && Object.keys(event).every((key) => envelopeKeys.has(key))
    && event.schemaVersion === 2
    && typeof event.runId === 'string' && event.runId === basename(runDir)
    && Number.isSafeInteger(event.sequence) && event.sequence >= 1
    && validTimestamp(event.timestamp)
    && event.command === 'publish'
    && typeof event.phase === 'string' && event.phase.length > 0
    && typeof event.status === 'string' && event.status.length > 0
    && sameProducer(event.producer)
    && (event.error === undefined || event.error === null
      || (typeof event.error === 'object' && !Array.isArray(event.error)
        && Object.keys(event.error).every((key) => key === 'code' || key === 'message')
        && typeof event.error.code === 'string' && event.error.code.length > 0
        && (event.error.message === undefined || typeof event.error.message === 'string')))
    && (event.duration === undefined || Number.isSafeInteger(event.duration) && event.duration >= 0)
    && validDetails(event.details);
  if (summary.status !== 'FAILED' || summary.recoveryActionCode !== 'RETRY_COMMAND'
    || summary.evidencePath !== 'evidence.jsonl' || !sameProducer(summary.producer)
    || !Array.isArray(events) || events.length === 0) return false;
  let previousSequence = 0;
  let firstFailure = null;
  let genericFailure = null;
  for (const event of events) {
    if (!validEnvelope(event) || event.sequence !== previousSequence + 1) return false;
    previousSequence = event.sequence;
    if (event.status === 'failed' && firstFailure === null) firstFailure = event;
    if (event.phase === 'publish') {
      if (event.status !== 'failed' || genericFailure !== null || event.details?.prePersistedRunPath
        || event.details?.recoveryActionCode !== summary.recoveryActionCode) return false;
      genericFailure = event;
    } else if (!['safety-gate', 'global-preflight-arbitration'].includes(event.phase)) {
      return false;
    }
  }
  if (!firstFailure || !genericFailure || events.at(-1) !== genericFailure
    || summary.evidenceSequence !== firstFailure.sequence
    || summary.stablePhase !== firstFailure.phase) return false;
  return !events.some((event) => event.details?.prePersistedRunPath);
}

/**
 * Postverify is a downstream run type that predates the generic recovery
 * reader. A terminal legacy record is consumable only when its summary agrees
 * with its sealed status and its verify parent is fully lineage-valid.
 */
async function readLegacyPostverifyRecovery(runPath) {
  try {
    const run = await loadRun(runPath, { requireDigest: true });
    if (run.command !== 'postverify' || run.status !== 'DISTRIBUTED') {
      throw new ReleaseError(GATE_FAILED, 'legacy postverify status is not terminal DISTRIBUTED');
    }
    const planRaw = await readFile(run.planPath, 'utf8');
    const plan = JSON.parse(planRaw);
    validatePlan(plan);
    if (!plan.digest || plan.digest !== computePlanDigest(plan)) {
      throw new ReleaseError(GATE_FAILED, 'legacy postverify plan digest is not intact');
    }
    validateRunPlanDigest(run, plan, { planPath: run.planPath });
    const production = Boolean(plan.production);
    if (production) {
      // Production run authority is digest-addressed and must remain under
      // the plan's sibling runs/ directory, exactly as recovery consumes it.
      await loadRun(runPath, { requireDigest: true, authorityPlanPath: run.planPath });
    }
    if (!run.sourceRunPath || !run.sourceRunId || !run.sourceRunDigest) {
      throw new ReleaseError(GATE_FAILED, 'legacy postverify is missing complete verify parent lineage');
    }
    const parent = await loadRun(run.sourceRunPath, {
      requireDigest: true,
      ...(production ? { authorityPlanPath: run.planPath } : {}),
    });
    if (parent.command !== 'verify' || parent.status !== 'VERIFIED'
      || parent.runId !== run.sourceRunId || parent.runDigest !== run.sourceRunDigest) {
      throw new ReleaseError(GATE_FAILED, 'legacy postverify requires the same-lineage VERIFIED verify parent');
    }
    validateRunCheckpointMapping(parent, plan.externalActions ?? []);
    if (parent.checkpoints.some((checkpoint) => !['succeeded', 'skipped', 'NO_CHANGE'].includes(checkpoint.status))) {
      throw new ReleaseError(GATE_FAILED, 'legacy postverify verify parent has incomplete checkpoints');
    }
    await validateRunLineage(parent, {
      plan,
      planPath: run.planPath,
      runPath: run.sourceRunPath,
      production,
    });
    const summary = JSON.parse(await readFile(join(resolve(runPath, '..'), 'summary.json'), 'utf8'));
    if (!summary || summary.status !== run.status) {
      throw new ReleaseError(GATE_FAILED, 'legacy postverify summary status does not match its sealed run status');
    }
    const expectedPostVerifyActions = normalizePostPublishView(plan).flatMap((declaration) => (
      (declaration.hooks ?? [])
        .filter((hook) => (hook.phase ?? 'distribute') === 'postVerify')
        .map((hook) => ({
          id: postPublishActionId({
            planVersion: plan.planVersion,
            unitId: declaration.unitId,
            localId: hook.id,
          }),
          type: 'postpublish-hook',
        }))
    ));
    validateRunCheckpointMapping(run, expectedPostVerifyActions);
    if (run.checkpoints.some((checkpoint) => !['succeeded', 'skipped', 'NO_CHANGE'].includes(checkpoint.status))) {
      throw new ReleaseError(GATE_FAILED, 'legacy postverify DISTRIBUTED run has incomplete checkpoints');
    }
    return {
      runPath: resolve(runPath),
      run,
      plan,
      lineage: [{ run: parent, runPath: resolve(run.sourceRunPath) }],
      recoveryActionCode: null,
      legacyPostverify: true,
    };
  } catch (error) {
    return {
      runPath: resolve(runPath),
      recoveryActionCode: 'DIAGNOSE',
      diagnostic: { code: error.code ?? GATE_FAILED, message: error.message },
    };
  }
}

export async function hasPartialRun(root) {
  const result = await readRunRouting(root);
  if (result.recoveryActionCode === 'DIAGNOSE') {
    throw new ReleaseError('GATE_FAILED', '历史运行需要诊断 (diagnosis)，不能据此开始新发布', { recovery: result });
  }
  return result.hasPartialRun;
}

/**
 * Recommend a workflow profile per the fail-closed decision table (§4.3).
 *
 * @param {{ code: string[], docs: string[], config: string[], marketplace: string[], version: string[], other: string[], mixed: boolean }} diffClassification
 *   Input A result (worktree diff).
 * @param {{ status: 'determinable'|'indeterminable', kind?: string, categories?: object } | null} baselineSurface
 *   Input B result (change surface vs previous release). null/indeterminable
 *   fails closed to full-happy-end.
 * @param {string|null} targetVersion - Input C: requested target version.
 * @param {boolean} hasPartialRun - Input C: PARTIAL run needing reconcile.
 * @param {{ publishAuthorized?: boolean }} [options] - Input C: remote-write
 *   authorization state (informational only; never changes routing).
 * @returns {{ workflowKind: string, reason: string, firstCommand: string, requiresAuthorization?: boolean, routing: object }}
 */
export function recommendWorkflow(diffClassification, baselineSurface, targetVersion, hasPartialRun, options = {}) {
  const { publishAuthorized = false } = options;
  const { code, docs, config, marketplace, mixed } = diffClassification;

  const recovery = options.recovery;
  // Recovery advice is target-bound. With no explicit target, route must
  // remain a diff/baseline workflow recommendation even when diagnostics
  // contain old PARTIAL or DIAGNOSE records.
  if (targetVersion && recovery?.recoveryActionCode) {
    const action = recovery.recoveryActionCode;
    const selected = recovery.runs.find((run) => run.recoveryActionCode === action);
    const recoveryRunPath = selected?.recoveryRunPath ?? selected?.runPath;
    const workflowKind = ['RECONCILE', 'DISTRIBUTE', 'VERIFY'].includes(action) ? action.toLowerCase() : 'help';
    return {
      workflowKind,
      reason: action === 'DIAGNOSE' ? '运行权威、冲突或批准尚需诊断；保留既有记录，不开始新发布'
        : action === 'RETRY_COMMAND' ? '已校验为零写入阻断；修复原因后重试原命令'
          : '根据已校验的计划、运行和血缘继续未完成阶段',
      firstCommand: renderRecoveryCommand(action, { planPath: selected?.planPath, runPath: recoveryRunPath })
        ?? `无自动安全恢复入口；按 recoveryActionCode=${action} 处理既有记录`,
      routing: {
        rule: 1,
        hasPartialRun,
        recoveryActionCode: action,
        runs: recovery.runs,
        ...(recovery.diagnostics?.length > 0 ? { diagnostics: recovery.diagnostics } : {}),
      },
    };
  }

  // Rule 1: PARTIAL run → reconcile first (highest priority).
  if (targetVersion && hasPartialRun) {
    return {
      workflowKind: 'reconcile',
      reason: '存在 PARTIAL run，必须先 reconcile 再开始任何新操作',
      firstCommand: 'release-skill reconcile --plan <path> --run <path>',
      routing: { rule: 1, hasPartialRun },
    };
  }

  const hasAnyChange = code.length > 0 || docs.length > 0 || config.length > 0 || marketplace.length > 0 || diffClassification.version.length > 0;

  // Rule 2: no worktree changes + no target version → help (report no change).
  if (!hasAnyChange && !targetVersion) {
    return {
      workflowKind: 'help',
      reason: '工作树无变化且未指定目标版本',
      firstCommand: 'release-skill help',
      routing: { rule: 2, hasAnyChange, targetVersion },
    };
  }

  const surfaceKind = baselineSurface?.status === 'determinable' ? baselineSurface.kind : null;

  // Rule 3: B indeterminable → full-happy-end (fail-closed, never trim gates
  // on an unknown change surface).
  if (baselineSurface === null || baselineSurface.status !== 'determinable' || surfaceKind === null) {
    return {
      workflowKind: 'full-happy-end',
      reason: '相比上一版本的改动面不可判定（无绑定的 previousPublicBaseline 且本地无发布 tag），失败关闭到 full-happy-end',
      firstCommand: 'release-skill ship --target-version <version> --approve --actor <person-name>',
      routing: { rule: 3, baselineStatus: baselineSurface?.status ?? 'missing' },
    };
  }

  const b = baselineSurface;
  const hasBCode = (b.categories.code?.length ?? 0) > 0 || (b.categories.other?.length ?? 0) > 0;
  const hasBDocs = (b.categories.docs?.length ?? 0) > 0;
  const hasBConfig = (b.categories.config?.length ?? 0) > 0;
  const hasBMarketplace = (b.categories.marketplace?.length ?? 0) > 0;
  const bCategories = [hasBCode ? 'code' : null, hasBDocs ? 'docs' : null, hasBConfig ? 'config' : null, hasBMarketplace ? 'marketplace' : null].filter(Boolean);

  // Rule 4: A=docs && B=docs → docs-only.
  if (code.length === 0 && config.length === 0 && marketplace.length === 0 && docs.length > 0 && !mixed && bCategories.join(',') === 'docs') {
    return {
      workflowKind: 'docs-only',
      reason: `纯文档变更（${docs.length} 个文件），且相比上一版本改动面仅为文档；跳过代码类 gate/hook 与 skill-resource-closure`,
      firstCommand: 'release-docs',
      requiresAuthorization: !publishAuthorized,
      routing: { rule: 4, a: 'docs', b: bCategories },
    };
  }

  // Rule 5: A=config && B=config → config-only.
  if (code.length === 0 && docs.length === 0 && marketplace.length === 0 && config.length > 0 && !mixed && bCategories.join(',') === 'config') {
    return {
      workflowKind: 'config-only',
      reason: `纯配置变更（${config.length} 个文件），且相比上一版本改动面仅为配置；公开字节不变时无 publish 路径`,
      firstCommand: 'release-config',
      requiresAuthorization: !publishAuthorized,
      routing: { rule: 5, a: 'config', b: bCategories },
    };
  }

  // Rule 6: A=marketplace && B=marketplace → marketplace-only.
  if (code.length === 0 && docs.length === 0 && config.length === 0 && marketplace.length > 0 && !mixed && bCategories.join(',') === 'marketplace') {
    return {
      workflowKind: 'marketplace-only',
      reason: `纯市场索引变更（${marketplace.length} 个文件），且相比上一版本改动面仅为市场索引；发布委托目标 workspace 专属发布流程`,
      firstCommand: 'release-marketplace',
      requiresAuthorization: !publishAuthorized,
      routing: { rule: 6, a: 'marketplace', b: bCategories },
    };
  }

  // Rule 7: marketplace + docs/config (no code, exactly one other category)
  // → chained recommendation. `mixed` is intentionally NOT required here:
  // marketplace+docs implies mixed=true by construction; the precise check is
  // "no code, marketplace present, exactly one of docs/config present".
  const bSubsetOk = (bCategories.every((c) => c === 'docs' || c === 'marketplace') || bCategories.every((c) => c === 'config' || c === 'marketplace')) && bCategories.length > 0;
  if (
    code.length === 0 &&
    marketplace.length > 0 &&
    (docs.length > 0) !== (config.length > 0) &&
    bSubsetOk
  ) {
    const other = docs.length > 0 ? 'docs' : 'config';
    const kind = other === 'docs' ? 'marketplace-docs' : 'marketplace-config';
    return {
      workflowKind: kind,
      reason: `市场索引与${other === 'docs' ? '文档' : '配置'}组合变更：先跑 release-marketplace 再串联 ${other === 'docs' ? 'release-docs' : 'release-config'}`,
      firstCommand: other === 'docs' ? 'release-marketplace && release-docs' : 'release-marketplace && release-config',
      requiresAuthorization: !publishAuthorized,
      routing: { rule: 7, a: `marketplace+${other}`, b: bCategories },
    };
  }

  // Rule 8: everything else → full-happy-end (fail-closed).
  return {
    workflowKind: 'full-happy-end',
    reason: `混合或复杂变更（code=${code.length}, docs=${docs.length}, config=${config.length}, marketplace=${marketplace.length}, B=${bCategories.join('+') || surfaceKind}）。失败关闭到 full-happy-end，不裁剪任何门禁`,
    firstCommand: 'release-skill ship --target-version <version> --approve --actor <person-name>',
    requiresAuthorization: !publishAuthorized,
    routing: { rule: 8, a: mixed ? 'mixed' : 'other', b: bCategories },
  };
}

/**
 * Parse command-line arguments.
 *
 *   release-skill route --root <path> [--target-version <ver>] [--publish-authorized] [--json]
 *
 * @param {string[]} args
 * @returns {{ root: string, targetVersion: string|null, publishAuthorized: boolean, json: boolean, help: boolean }}
 */
export function parseArgs(args) {
  const result = {
    root: process.cwd(),
    targetVersion: null,
    publishAuthorized: false,
    json: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--root' && i + 1 < args.length) {
      result.root = args[++i];
    } else if (arg === '--target-version' && i + 1 < args.length) {
      result.targetVersion = args[++i];
    } else if (arg === '--publish-authorized') {
      result.publishAuthorized = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    }
    i += 1;
  }

  return result;
}

/**
 * Format classification output as human-readable text.
 */
function formatClassificationText(classification) {
  const lines = [
    '=== Diff Classification (input A) ===',
    `Mixed: ${classification.mixed ? 'Yes' : 'No'}`,
    '',
  ];
  for (const [label, key] of [['Code', 'code'], ['Documentation', 'docs'], ['Configuration', 'config'], ['Marketplace', 'marketplace'], ['Version source', 'version'], ['Unclassified', 'other']]) {
    if ((classification[key] ?? []).length > 0) {
      lines.push(`${label} (${classification[key].length}):`);
      for (const path of classification[key]) lines.push(`  - ${path}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Format recommendation output as human-readable text.
 */
function formatRecommendationText(recommendation) {
  const lines = [
    '',
    '=== Workflow Recommendation ===',
    '',
    `Workflow: ${recommendation.workflowKind}`,
    '',
    'Reason:',
    `  ${recommendation.reason}`,
    '',
    'First Command:',
    `  ${recommendation.firstCommand}`,
    '',
  ];
  if (recommendation.requiresAuthorization) {
    lines.push('Note: 远程写入（publish）未授权——prepare 只读冻结计划，publish 需另行授权。', '');
  }
  const diagnostics = recommendation.routing?.diagnostics ?? [
    ...(recommendation.routing?.runs ?? [])
      .filter((run) => run.diagnostic)
      .map((run) => ({ ...run.diagnostic, path: run.diagnostic.relativePath })),
  ];
  if (diagnostics.length > 0) {
    lines.push('Diagnostics:');
    for (const diagnostic of diagnostics) {
      lines.push(`  - 路径: ${diagnostic.path ?? diagnostic.relativePath ?? 'unknown'}`);
      lines.push(`    分类: ${diagnostic.classification ?? 'UNKNOWN_LEGACY_OR_CORRUPT_AUTHORITY'}`);
      lines.push(`    动作: ${diagnostic.nextActionCode ?? diagnostic.recoveryActionCode ?? 'DIAGNOSE'}`);
      if (diagnostic.nextAction) lines.push(`    下一步: ${diagnostic.nextAction}`);
      if ((diagnostic.nextActionCode ?? diagnostic.recoveryActionCode) === 'DIAGNOSE') {
        lines.push('    无自动安全恢复入口');
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

const HELP_TEXT = `release-route: Deterministic quickstart routing for workflow profiles

Usage:
  release-skill route --root <path> [--target-version <ver>] [--publish-authorized] [--json]

Options:
  --root <path>         项目根目录（默认当前目录）
  --target-version <ver> 目标版本
  --publish-authorized  声明远程写入已获授权（仅影响建议备注，不改变路由）
  --json                输出 JSON
  -h, --help            显示本帮助

Workflow Profiles:
  full-happy-end    混合或不可判定变更（失败关闭，全门禁）
  docs-only         纯文档变更（跳过代码类 gate/hook 与 skill-resource-closure）
  config-only       纯配置变更（公开字节不变时无 publish 路径）
  marketplace-only  纯市场索引变更（发布委托目标 workspace 专属流程）
  marketplace-docs / marketplace-config  市场+文档/配置组合（串联）
  reconcile         存在 PARTIAL run，先恢复
  help              工作树无变化且未指定目标版本
`;

/**
 * Main entry point for the route command.
 *
 * @param {string[]} args
 * @param {{ root?: string, json?: boolean, targetVersion?: string, publishAuthorized?: boolean }} [options]
 * @returns {Promise<{ status: string, classification: object, recommendation: object, baseline: object }>}
 */
export default async function main(args = [], options = {}) {
  const parsed = parseArgs(args);
  const root = options.root ?? parsed.root;
  const targetVersion = options.targetVersion ?? parsed.targetVersion;
  const publishAuthorized = options.publishAuthorized ?? parsed.publishAuthorized;
  const json = options.json ?? parsed.json;

  if (parsed.help) {
    if (json) {
      console.log(JSON.stringify({
        command: 'route',
        description: 'Deterministic quickstart routing for workflow profiles',
        usage: 'release-skill route --root <path> [--target-version <ver>] [--json]',
        options: {
          '--root': 'Project root directory (default: cwd)',
          '--target-version': 'Target version being released',
          '--publish-authorized': 'Declare remote writes authorized (informational)',
          '--json': 'Output results as JSON',
        },
        workflowKinds: WORKFLOW_KINDS,
      }, null, 2));
    } else {
      console.log(HELP_TEXT);
    }
    return { status: 'HELP_SHOWN', classification: {}, recommendation: {} };
  }

  try {
    const classification = await classifyWorktreeDiff(root);
    const baseline = await resolvePreviousReleaseCommit(root);
    let baselineSurface = null;
    if (baseline) {
      baselineSurface = await classifyBaselineSurface(root, baseline.commit);
    } else {
      baselineSurface = { status: 'indeterminable', kind: null, categories: {}, paths: [] };
    }
    const recovery = await readRunRouting(root, { targetVersion });
    const partial = recovery.hasPartialRun;
    const recommendation = recommendWorkflow(
      classification,
      baselineSurface,
      targetVersion,
      partial,
      { publishAuthorized, recovery },
    );
    if (recovery.diagnostics?.length > 0) {
      recommendation.routing = {
        ...recommendation.routing,
        diagnostics: recovery.diagnostics,
      };
    }

    if (json) {
      console.log(JSON.stringify({
        classification,
        baseline: baseline ? { ...baseline } : null,
        baselineSurface,
        hasPartialRun: partial,
        recommendation,
      }, null, 2));
    } else {
      console.log(formatClassificationText(classification));
      console.log(formatRecommendationText(recommendation));
    }

    return {
      status: 'SUCCESS',
      classification,
      baseline,
      baselineSurface,
      hasPartialRun: partial,
      recommendation,
    };
  } catch (err) {
    if (err instanceof ReleaseError) {
      if (json) {
        console.log(JSON.stringify({
          error: err.code,
          message: err.message,
          details: err.details ?? {},
          exitCode: err.exitCode ?? 1,
        }, null, 2));
      } else {
        console.error(`Error [${err.code}]: ${err.message}`);
      }
      return { status: 'ERROR', error: err.code, message: err.message, exitCode: err.exitCode ?? 1 };
    }

    if (json) {
      console.log(JSON.stringify({ error: 'UNKNOWN_ERROR', message: err.message, details: {}, exitCode: 1 }, null, 2));
    } else {
      console.error(`Unexpected error: ${err.message}`);
    }
    return { status: 'ERROR', error: 'UNKNOWN_ERROR', message: err.message, exitCode: 1 };
  }
}
