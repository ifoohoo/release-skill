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
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ReleaseError } from '../core/errors.mjs';
import { listReleaseTags } from './lineage.mjs';
import { readRunRecovery, renderRecoveryCommand } from '../core/recovery.mjs';

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
  const runsDir = resolve(cwd, '.release-skill', 'runs');
  let runDirs;
  try {
    runDirs = await readdir(runsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { hasPartialRun: false, recoveryActionCode: null, runs: [] };
    return { hasPartialRun: false, recoveryActionCode: 'DIAGNOSE', runs: [], diagnostic: { code: error.code, message: error.message } };
  }
  const records = [];
  for (const runDir of runDirs) {
    let runPath = resolve(runsDir, runDir, 'release-run.json');
    try {
      await readFile(runPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Prepare/assess have evidence directories but no release-run contract.
        if (/^(prepare|assess|hooks-validate)-/.test(runDir)) continue;
        // An append-only sequence is ordered by its bound slot, never by time.
        // readRunRecovery reuses validateRunLineage to check its predecessors.
        const states = await readdir(resolve(runsDir, runDir, 'states')).catch(() => []);
        const slots = states.filter((name) => /^\d{6}\.json$/.test(name)).sort();
        if (slots.length > 0) runPath = resolve(runsDir, runDir, 'states', slots.at(-1));
      }
    }
    records.push(await readRunRecovery(runPath, options));
  }
  const identity = (run) => `${run.planDigest}:${run.runId}:${run.runDigest}`;
  const consumed = new Set(records.filter((r) => r.run).flatMap((r) => r.lineage.map((edge) => identity(edge.run))));
  const samePublication = (a, b) => a.planDigest === b.planDigest
    && a.sourceRunId === b.sourceRunId && a.sourceRunDigest === b.sourceRunDigest;
  const unresolved = records.filter((record) => {
    if (!record.run) return true; // invalid/unknown never disappears as "no PARTIAL"
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
  const recoveryActionCode = priority.find((code) => unresolved.some((r) => r.recoveryActionCode === code)) ?? null;
  const runs = unresolved.filter((r) => r.recoveryActionCode).map((r) => ({
    runPath: r.runPath,
    planPath: r.run?.planPath,
    command: r.run?.command,
    status: r.run?.status,
    recoveryActionCode: r.recoveryActionCode,
    recoveryRunPath: r.recoveryRunPath,
    ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
  })).sort((a, b) => a.runPath.localeCompare(b.runPath));
  return { hasPartialRun: unresolved.some((r) => r.run?.status === 'PARTIAL'), recoveryActionCode, runs };
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
  if (recovery?.recoveryActionCode) {
    const action = recovery.recoveryActionCode;
    const selected = recovery.runs.find((run) => run.recoveryActionCode === action);
    const recoveryRunPath = selected?.recoveryRunPath ?? selected?.runPath;
    const workflowKind = ['RECONCILE', 'DISTRIBUTE', 'VERIFY'].includes(action) ? action.toLowerCase() : 'help';
    return {
      workflowKind,
      reason: action === 'DIAGNOSE' ? '运行权威、冲突或批准尚需诊断；保留既有记录，不开始新发布'
        : action === 'RETRY_COMMAND' ? '已校验为零写入阻断；修复原因后重试原命令'
          : '根据已校验的计划、运行和血缘继续未完成阶段',
      firstCommand: renderRecoveryCommand(action, { planPath: selected?.planPath, runPath: recoveryRunPath }) ?? 'release-skill help',
      routing: { rule: 1, hasPartialRun, recoveryActionCode: action, runs: recovery.runs },
    };
  }

  // Rule 1: PARTIAL run → reconcile first (highest priority).
  if (hasPartialRun) {
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
    const recovery = await readRunRouting(root);
    const partial = recovery.hasPartialRun;
    const recommendation = recommendWorkflow(
      classification,
      baselineSurface,
      targetVersion,
      partial,
      { publishAuthorized, recovery },
    );

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
