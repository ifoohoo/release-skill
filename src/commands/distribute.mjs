/**
 * Distribute command: post-publish distribution saga (R1–R4).
 *
 * After publish has pushed the frozen tag, `distributeRelease` mirrors the
 * release payload to the consumer-declared postPublish targets (append-only
 * git mirrors + marketplace indexes) through the distribute-git adapter.
 *
 * Timing contract (R1): the payload may ONLY ever come from a detached git
 * worktree checked out at the frozen `postPublish.tagCommit` — never from
 * the live workspace, which has already moved ahead. The consumer-declared
 * materialize hook runs inside that worktree and announces the isolated
 * payload directory through its `outputMarker` line.
 *
 * Safety gates (all verified before any adapter execute):
 *  1. plan schema validation
 *  2. plan digest verification (computePlanDigest vs plan.digest)
 *  3. approval record validation (core/approval.mjs)
 *  4. source run lineage: publish|reconcile run at PUBLISHED|VERIFIED whose
 *     planDigest matches the frozen plan (loadRun requireDigest)
 *  5. tag identity: `git rev-parse --verify <tag>^{commit}` in root must
 *     equal the frozen postPublish.tagCommit (fail-closed when absent)
 *  5b. optional assertMainVersionAhead (commit descent of HEAD over the tag)
 *  6. postPublish declaration re-validation (core/postpublish.mjs)
 *  7. per-target reachability preflight (DISTRIBUTE_PROBE)
 *
 * Reconcile equivalence: a rerun IS the reconcile. Every target is observed
 * BEFORE any write; a remote whose tag exists and whose branch tip equals
 * the tag oid is SKIPPED (CONSISTENT) without executing. distribute never
 * forces: NO_CHANGE is reported honestly, existing-tag conflicts fail closed.
 *
 * Failure semantics:
 * - Gate failures THROW ReleaseError. From the source-run gate on (lineage
 *   known) a BLOCKED run record is persisted before rethrowing.
 * - Target failures RETURN: PARTIAL when at least one push succeeded,
 *   BLOCKED when zero writes landed. Targets after a failure are skipped.
 *
 * @module commands/distribute
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { assertImmutablePlanAuthority, computePlanDigest, validatePlan } from '../core/plan.mjs';
import {
  assertImmutableApprovalAuthority,
  computeApprovalDigest,
  validateApproval,
  validateApprovalRecordSchema,
} from '../core/approval.mjs';
import {
  appendRunState,
  createProductionRunDir,
  loadRun,
  resolveDefaultRunDir,
  validateRunPlanDigest,
  writeRunAtomic,
} from '../core/run.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import { runHook } from '../core/hooks.mjs';
import {
  orderTargetsByDependency,
  validatePostPublishDeclaration,
  PAYLOAD_SOURCE_TAG_WORKTREE,
} from '../core/postpublish.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  POST_PUBLISH_VERIFY_FAILED,
  REMOTE_CONFLICT,
  REMOTE_UNAVAILABLE,
} from '../core/errors.mjs';
import { ActionType } from '../adapters/contract.mjs';

const execFileAsync = promisify(execFileCb);

/** Executor identity recorded in every distribute checkpoint trace. */
const EXECUTOR = 'release-skill distribute';

/** Tail length for hook stdout/stderr recorded in evidence. */
const TAIL_CHARS = 4000;

/** Full 40-hex commit sha. */
const SHA_RE = /^[a-f0-9]{40}$/;

/** Checkpoint error codes accepted by the release-run schema enum. */
const SCHEMA_ERROR_CODES = new Set([
  'CONFIG_INVALID',
  'BASELINE_CHANGED',
  'DIRTY_SCOPE_CONFLICT',
  'GATE_FAILED',
  'AUTH_MISSING',
  'REMOTE_CONFLICT',
  'REMOTE_UNAVAILABLE',
  'HOOK_TIMEOUT',
  'PARTIAL_RELEASE',
  'POST_PUBLISH_VERIFY_FAILED',
]);

/** Run statuses. */
const DISTRIBUTING = 'DISTRIBUTING';
const DISTRIBUTED = 'DISTRIBUTED';
const PARTIAL = 'PARTIAL';
const BLOCKED = 'BLOCKED';

function defaultClock() {
  return new Date().toISOString();
}

function defaultExec(command, args, options = {}) {
  return execFileAsync(command, args, { shell: false, encoding: 'utf8', timeout: 120_000, ...options });
}

function tail(text, limit = TAIL_CHARS) {
  const value = `${text ?? ''}`;
  return value.length > limit ? value.slice(-limit) : value;
}

/** Map an adapter/details error code onto the run-schema checkpoint enum. */
function mapToSchemaCode(code) {
  return SCHEMA_ERROR_CODES.has(code) ? code : GATE_FAILED;
}

/**
 * Parse the first JSON object line from hook stdout
 * (`requireReport.parse: "stdout-first-json"`).
 *
 * @param {string} stdout
 * @returns {Object|null} The first line that parses to a plain object.
 */
export function parseFirstJsonObject(stdout) {
  for (const line of `${stdout ?? ''}`.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Not JSON: keep scanning (hooks may print brace-prefixed noise).
    }
  }
  return null;
}

/**
 * Resolve the LAST stdout line containing the output marker to the text
 * after the marker (the announced payload directory).
 *
 * @param {string} stdout
 * @param {string} marker
 * @returns {string|null}
 */
export function parseOutputMarker(stdout, marker) {
  const lines = `${stdout ?? ''}`.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const markerIndex = lines[index].indexOf(marker);
    if (markerIndex >= 0) {
      return lines[index].slice(markerIndex + marker.length).trim();
    }
  }
  return null;
}

/** Assert `candidate` is a real directory contained inside `container`. */
async function assertContainedDirectory(container, candidate, label) {
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    throw new ReleaseError(
      POST_PUBLISH_VERIFY_FAILED,
      `${label} does not resolve to an existing path`,
      { candidate },
    );
  }
  const containerReal = await realpath(container);
  const rel = relative(containerReal, real);
  if (rel === '' || isAbsolute(rel) || rel === '..'
    || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new ReleaseError(
      POST_PUBLISH_VERIFY_FAILED,
      `${label} escapes the tag worktree; payload must stay inside the frozen checkout`,
      { candidate },
    );
  }
  const stats = await lstat(real).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new ReleaseError(
      POST_PUBLISH_VERIFY_FAILED,
      `${label} is not a directory`,
      { candidate },
    );
  }
  return real;
}

/**
 * Resolve the marketplace pluginName from the frozen plan unit's
 * distributions: claude-plugin first, codex-plugin as fallback.
 */
function resolvePluginName(plan, unitId) {
  const unit = (plan.units ?? []).find((entry) => entry.id === unitId);
  const distributions = unit?.distributions ?? [];
  const pluginDistribution = distributions.find((entry) => entry.type === 'claude-plugin')
    ?? distributions.find((entry) => entry.type === 'codex-plugin');
  if (!pluginDistribution || typeof pluginDistribution.plugin !== 'string' || pluginDistribution.plugin.length === 0) {
    throw new ReleaseError(
      GATE_FAILED,
      `marketplace-index targets require a claude-plugin or codex-plugin distribution with a plugin name on unit "${unitId}"`,
      { unitId },
    );
  }
  return pluginDistribution.plugin;
}

/**
 * Execute the post-publish distribution saga for a frozen, approved plan.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.approvalPath - Absolute path to the approval record.
 * @param {string} options.sourceRunPath - Absolute path to the sealed publish/reconcile run.
 * @param {Object} options.adapterRegistry - Registry carrying the distribute adapter.
 * @param {string} [options.root] - Project root (git repository). Defaults to cwd.
 * @param {string} [options.runDir] - Evidence directory override.
 * @param {boolean} [options.dryRun] - Stop before remote pushes (adapter-level).
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {Function} [options.execFn] - Injectable git exec (tests).
 * @param {Function} [options.runHookFn] - Injectable hook runner (tests).
 *
 * @returns {Promise<{ planPath: string, runPath: string, status: string, checkpoints: Object[] }>}
 *
 * @throws {ReleaseError} on any safety-gate failure (BLOCKED record persisted
 *   once the source-run lineage is known).
 */
export async function distributeRelease(options) {
  const {
    planPath,
    approvalPath,
    sourceRunPath,
    adapterRegistry,
    root = process.cwd(),
    runDir: runDirOpt,
    dryRun = false,
    clock: clockOpt,
    execFn,
    runHookFn,
  } = options ?? {};

  const clockFn = typeof clockOpt === 'function' ? clockOpt : defaultClock;
  const exec = typeof execFn === 'function' ? execFn : defaultExec;
  const hookRunner = typeof runHookFn === 'function' ? runHookFn : runHook;

  // =========================================================================
  // Gate 1: load and validate the frozen plan (before any write — a rejected
  // plan must never allocate a run authority).
  // =========================================================================
  let planRaw;
  try {
    planRaw = await readFile(planPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(GATE_FAILED, `cannot read release plan: ${err.message}`, { planPath, cause: err.code });
  }
  let plan;
  try {
    plan = JSON.parse(planRaw);
  } catch (err) {
    throw new ReleaseError(GATE_FAILED, `release plan is not valid JSON: ${err.message}`, { planPath });
  }
  validatePlan(plan);
  assertImmutablePlanAuthority(planPath, plan);

  const actualDigest = computePlanDigest(plan);
  if (plan.digest && plan.digest !== actualDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      `plan digest mismatch: expected ${String(plan.digest).slice(0, 16)}..., computed ${actualDigest.slice(0, 16)}...`,
      { expected: plan.digest, actual: actualDigest },
    );
  }
  if (!plan.postPublish) {
    throw new ReleaseError(
      GATE_FAILED,
      'release plan has no postPublish declaration; nothing to distribute',
      { planPath },
    );
  }

  // =========================================================================
  // Run authority + evidence. Every subsequent gate failure is evidenced.
  // =========================================================================
  const runId = `distribute-${Date.now()}`;
  let runDir = runDirOpt ?? resolveDefaultRunDir(planPath, 'distribute', runId);
  if (plan.production?.mode === 'github-npm-v1') {
    runDir = await createProductionRunDir(runDir, planPath);
  } else {
    await mkdir(runDir, { recursive: true });
  }
  const runPath = join(runDir, 'release-run.json');
  const evidence = createEvidenceWriter({ runDir, command: 'distribute', clock: clockFn });

  // Lineage becomes known at gate 3; only then may a BLOCKED record persist.
  let lineageKnown = false;
  let sourceRunId = null;
  let sourceRunDigest = null;
  let finalRecordWritten = false;

  const startedAt = clockFn();
  let checkpoints = [];
  let stateSequence = -1;

  const buildPersistedState = (status, finishedAt) => ({
    runId,
    command: 'distribute',
    status,
    planDigest: plan.digest ?? actualDigest,
    planPath,
    ...(approvalDigestValue ? { approvalDigest: approvalDigestValue } : {}),
    ...(approvalPath ? { approvalPath } : {}),
    ...(sourceRunId ? { sourceRunId } : {}),
    ...(sourceRunDigest ? { sourceRunDigest } : {}),
    ...(sourceRunPath ? { sourceRunPath } : {}),
    startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    checkpoints: checkpoints.map((cp) => ({
      actionId: cp.actionId,
      actionType: cp.actionType,
      status: cp.status === 'SUCCEEDED' ? 'succeeded'
        : cp.status === 'FAILED' ? 'failed'
        : cp.status === 'SKIPPED' ? 'skipped'
        : cp.status === 'UNCERTAIN' ? 'uncertain'
        : cp.status === 'PENDING' ? 'pending'
        : cp.status, // NO_CHANGE passes through as-is
      ...(cp.preObserve ? { preObserve: cp.preObserve } : {}),
      ...(cp.postObserve ? { postObserve: cp.postObserve } : {}),
      ...(cp.remoteUrl ? { remoteUrl: cp.remoteUrl } : {}),
      ...(cp.branch ? { branch: cp.branch } : {}),
      ...(cp.tag ? { tag: cp.tag } : {}),
      ...(cp.tagCommit ? { tagCommit: cp.tagCommit } : {}),
      ...(cp.previousHead ? { previousHead: cp.previousHead } : {}),
      ...(cp.pushedCommit ? { pushedCommit: cp.pushedCommit } : {}),
      ...(cp.mode ? { mode: cp.mode } : {}),
      ...(cp.executor ? { executor: cp.executor } : {}),
      ...(cp.payloadFileCount !== undefined ? { payloadFileCount: cp.payloadFileCount } : {}),
      ...(cp.startedAt ? { startedAt: cp.startedAt } : {}),
      ...(cp.finishedAt ? { finishedAt: cp.finishedAt } : {}),
      ...(cp.reason ? { reason: cp.reason } : {}),
      ...(cp.error ? { error: { code: cp.error.code, ...(cp.error.message ? { message: cp.error.message } : {}) } } : {}),
    })),
  });

  const snapshot = async (status) => {
    stateSequence += 1;
    return appendRunState(runDir, stateSequence, buildPersistedState(status));
  };

  /** Persist the BLOCKED run record once lineage is known (idempotent). */
  const recordBlocked = async () => {
    if (finalRecordWritten || !lineageKnown) return;
    try {
      await writeRunAtomic(runPath, buildPersistedState(BLOCKED, clockFn()));
      finalRecordWritten = true;
    } catch {
      // Persistence must never mask the primary failure.
    }
  };

  let approvalDigestValue = null;

  // Worktree cleanup: registered exactly once, idempotent, failure-tolerant.
  let worktreePath = null;
  let tmpBase = null;
  const cleanupWorktree = async () => {
    if (worktreePath) {
      await exec('git', ['-C', root, 'worktree', 'remove', '--force', worktreePath]).catch(() => {});
      worktreePath = null;
    }
    if (tmpBase) {
      await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
      tmpBase = null;
    }
  };

  try {
    // =======================================================================
    // Gate 2: approval record validation.
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'approval-load', status: 'started' });

    let approvalRaw;
    try {
      approvalRaw = await readFile(approvalPath, 'utf8');
    } catch (err) {
      throw new ReleaseError(GATE_FAILED, `cannot read approval record: ${err.message}`, { approvalPath, cause: err.code });
    }
    let approval;
    try {
      approval = JSON.parse(approvalRaw);
    } catch (err) {
      throw new ReleaseError(GATE_FAILED, `approval record is not valid JSON: ${err.message}`, { approvalPath });
    }

    approvalDigestValue = assertImmutableApprovalAuthority(approvalPath, plan, approvalRaw)
      ?? computeApprovalDigest(approvalRaw);

    validateApprovalRecordSchema(approval);
    validateApproval(plan, approval, { clock: clockFn });

    await evidence.append({ phase: 'safety-gate', gate: 'approval-validated', status: 'passed' });

    // =======================================================================
    // Gate 3: source run lineage (publish|reconcile at PUBLISHED|VERIFIED,
    // digest-bound to the same frozen plan).
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'source-run', status: 'started', sourceRunPath });

    const sourceRun = await loadRun(sourceRunPath, { requireDigest: true });
    if (!['publish', 'reconcile'].includes(sourceRun.command)) {
      throw new ReleaseError(
        GATE_FAILED,
        `source run command must be publish or reconcile, got "${sourceRun.command}"`,
        { sourceRunPath, command: sourceRun.command },
      );
    }
    if (!['PUBLISHED', 'VERIFIED'].includes(sourceRun.status)) {
      throw new ReleaseError(
        GATE_FAILED,
        `source run must be PUBLISHED or VERIFIED before distribute, got "${sourceRun.status}"`,
        { sourceRunPath, status: sourceRun.status },
      );
    }
    validateRunPlanDigest(sourceRun, plan, { planPath });

    sourceRunId = sourceRun.runId;
    sourceRunDigest = sourceRun.runDigest;
    lineageKnown = true;

    await evidence.append({
      phase: 'safety-gate',
      gate: 'source-run',
      status: 'passed',
      sourceRunId,
      sourceRunStatus: sourceRun.status,
    });

    // =======================================================================
    // Declaration re-validation + deterministic target ordering.
    // =======================================================================
    const postPublish = plan.postPublish;
    validatePostPublishDeclaration(postPublish, { unitId: postPublish.unitId });
    const orderedTargets = orderTargetsByDependency(postPublish.targets);

    // Checkpoint registry: one probe + one mirror per target, declared order.
    checkpoints = [];
    for (const target of orderedTargets) {
      checkpoints.push({
        actionId: `probe-${target.id}`,
        actionType: ActionType.DISTRIBUTE_PROBE,
        status: 'PENDING',
        remoteUrl: target.remoteUrl,
        branch: target.branch,
        tag: postPublish.tag,
        executor: EXECUTOR,
      });
    }
    for (const target of orderedTargets) {
      checkpoints.push({
        actionId: target.id,
        actionType: ActionType.DISTRIBUTE_MIRROR,
        status: 'PENDING',
        remoteUrl: target.remoteUrl,
        branch: target.branch,
        tag: postPublish.tag,
        tagCommit: SHA_RE.test(postPublish.tagCommit ?? '') ? postPublish.tagCommit : undefined,
        executor: EXECUTOR,
      });
    }
    const checkpointById = new Map(checkpoints.map((cp) => [cp.actionId, cp]));

    // Durable pre-execute authority (seq 0).
    await snapshot(DISTRIBUTING);

    /** Gate failure after lineage is known: persist BLOCKED, then rethrow. */
    const failBlocked = async (error) => {
      await recordBlocked();
      throw error;
    };

    // =======================================================================
    // Gate 4: tag identity — the live tag must still point at the frozen
    // tagCommit. A missing binding or a moved tag fails closed.
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'tag-identity', status: 'started' });

    if (postPublish.payloadSource !== PAYLOAD_SOURCE_TAG_WORKTREE) {
      await failBlocked(new ReleaseError(
        GATE_FAILED,
        `postPublish.payloadSource must be "${PAYLOAD_SOURCE_TAG_WORKTREE}"`,
        { payloadSource: postPublish.payloadSource },
      ));
    }
    if (typeof postPublish.tagCommit !== 'string' || !SHA_RE.test(postPublish.tagCommit)) {
      await failBlocked(new ReleaseError(
        GATE_FAILED,
        'postPublish is missing a frozen tagCommit binding; distribute fails closed',
        { tagCommit: postPublish.tagCommit ?? null },
      ));
    }
    let observedTagCommit;
    try {
      const { stdout } = await exec('git', ['-C', root, 'rev-parse', '--verify', `${postPublish.tag}^{commit}`]);
      observedTagCommit = `${stdout}`.trim();
    } catch (err) {
      await evidence.append({
        phase: 'safety-gate',
        gate: 'tag-identity',
        status: 'failed',
        error: tail(err?.stderr ?? err?.message),
      });
      await failBlocked(new ReleaseError(
        GATE_FAILED,
        `tag "${postPublish.tag}" does not resolve to a commit in the source repository; distribute fails closed`,
        { tag: postPublish.tag },
      ));
    }
    if (observedTagCommit !== postPublish.tagCommit) {
      await evidence.append({
        phase: 'safety-gate',
        gate: 'tag-identity',
        status: 'failed',
        frozenTagCommit: postPublish.tagCommit,
        observedTagCommit,
      });
      await failBlocked(new ReleaseError(
        GATE_FAILED,
        `tag "${postPublish.tag}" points at ${observedTagCommit}, but the frozen plan binds tagCommit ${postPublish.tagCommit}`,
        { tag: postPublish.tag, frozenTagCommit: postPublish.tagCommit, observedTagCommit },
      ));
    }

    await evidence.append({ phase: 'safety-gate', gate: 'tag-identity', status: 'passed', tagCommit: observedTagCommit });

    // =======================================================================
    // Gate 5 (optional): the main line must have moved ahead of the tag.
    // Interpreted as commit descent: tagCommit is an ancestor of HEAD and
    // HEAD is not the tag commit itself.
    // =======================================================================
    if (postPublish.assertMainVersionAhead === true) {
      await evidence.append({ phase: 'safety-gate', gate: 'main-version-ahead', status: 'started' });
      let branchName;
      try {
        const { stdout } = await exec('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD']);
        branchName = `${stdout}`.trim();
      } catch {
        await failBlocked(new ReleaseError(
          GATE_FAILED,
          'assertMainVersionAhead requires a checked-out branch, but HEAD is detached',
        ));
      }
      try {
        await exec('git', ['-C', root, 'merge-base', '--is-ancestor', postPublish.tagCommit, 'HEAD']);
      } catch {
        await failBlocked(new ReleaseError(
          GATE_FAILED,
          `assertMainVersionAhead failed: tagCommit ${postPublish.tagCommit} is not an ancestor of HEAD on branch "${branchName}"`,
          { branch: branchName, tagCommit: postPublish.tagCommit },
        ));
      }
      const { stdout: headOut } = await exec('git', ['-C', root, 'rev-parse', 'HEAD']);
      if (`${headOut}`.trim() === postPublish.tagCommit) {
        await failBlocked(new ReleaseError(
          GATE_FAILED,
          `assertMainVersionAhead failed: HEAD on branch "${branchName}" is still the tag commit; the main line has not moved ahead`,
          { branch: branchName, tagCommit: postPublish.tagCommit },
        ));
      }
      await evidence.append({ phase: 'safety-gate', gate: 'main-version-ahead', status: 'passed', branch: branchName });
    }

    // =======================================================================
    // Gate 6: adapter availability + per-target reachability preflight.
    // =======================================================================
    let probeAdapter;
    let mirrorAdapter;
    try {
      probeAdapter = adapterRegistry.getAdapter(ActionType.DISTRIBUTE_PROBE);
      mirrorAdapter = adapterRegistry.getAdapter(ActionType.DISTRIBUTE_MIRROR);
    } catch (err) {
      await failBlocked(new ReleaseError(
        GATE_FAILED,
        `no distribute adapter registered: ${err.message}`,
      ));
    }

    const probeObservations = new Map();
    for (const target of orderedTargets) {
      const probeCheckpoint = checkpointById.get(`probe-${target.id}`);
      probeCheckpoint.startedAt = clockFn();
      await evidence.append({
        phase: 'safety-gate',
        gate: `probe-${target.id}`,
        status: 'started',
        remoteUrl: target.remoteUrl,
      });
      const probeAction = {
        actionType: ActionType.DISTRIBUTE_PROBE,
        targetId: target.id,
        remoteUrl: target.remoteUrl,
        tag: postPublish.tag,
      };
      let probeResult;
      try {
        probeResult = await probeAdapter.preflight(probeAction, {
          externalWritesAuthorized: false,
          plan,
          root,
          runDir,
        });
      } catch (err) {
        probeResult = { status: 'PREFLIGHT_FAILED', error: err?.message ?? String(err), details: null };
      }
      probeCheckpoint.finishedAt = clockFn();
      if (probeResult.status !== 'PREFLIGHT_PASSED') {
        const code = [REMOTE_UNAVAILABLE, REMOTE_CONFLICT].includes(probeResult.details?.code)
          ? probeResult.details.code
          : GATE_FAILED;
        probeCheckpoint.status = 'FAILED';
        probeCheckpoint.error = { code, message: probeResult.error ?? 'distribute probe failed' };
        await evidence.append({
          phase: 'safety-gate',
          gate: `probe-${target.id}`,
          status: 'failed',
          error: probeResult.error,
          details: { code },
        });
        await recordBlocked();
        throw new ReleaseError(
          code,
          `distribute probe failed for target "${target.id}": ${probeResult.error ?? 'remote unreachable'}`,
          { targetId: target.id, remoteUrl: target.remoteUrl },
        );
      }
      probeCheckpoint.status = 'SUCCEEDED';
      probeObservations.set(target.id, probeResult.observation ?? {});
      await evidence.append({
        phase: 'safety-gate',
        gate: `probe-${target.id}`,
        status: 'passed',
        tagExists: probeResult.observation?.tagExists ?? false,
      });
    }

    // =======================================================================
    // R1 timing contract: detached worktree at the frozen tagCommit. The
    // payload may never come from the live workspace.
    // =======================================================================
    await evidence.append({ phase: 'worktree', status: 'started', tagCommit: postPublish.tagCommit });
    try {
      tmpBase = await mkdtemp(join(tmpdir(), 'release-skill-distribute-'));
      worktreePath = join(tmpBase, 'worktree');
      await exec('git', ['-C', root, 'worktree', 'add', '--detach', worktreePath, postPublish.tagCommit]);
    } catch (err) {
      await evidence.append({ phase: 'worktree', status: 'failed', error: tail(err?.stderr ?? err?.message) });
      await failBlocked(new ReleaseError(
        GATE_FAILED,
        `cannot create the detached tag worktree at ${postPublish.tagCommit}: ${err?.message ?? err}`,
        { tagCommit: postPublish.tagCommit },
      ));
    }
    await evidence.append({ phase: 'worktree', status: 'passed' });

    // =======================================================================
    // Materialize: run the consumer hook inside the tag worktree, verify its
    // report, and bind the announced payload directory (fail-closed).
    // =======================================================================
    await evidence.append({ phase: 'materialize', status: 'started' });

    const materialize = postPublish.materialize;
    const hookResult = await hookRunner(
      {
        command: materialize.command,
        ...(materialize.cwd ? { cwd: materialize.cwd } : {}),
        ...(materialize.timeoutMs !== undefined ? { timeoutMs: materialize.timeoutMs } : {}),
        ...(materialize.envAllowlist ? { envAllowlist: materialize.envAllowlist } : {}),
      },
      { root: worktreePath, env: process.env },
    );

    if (hookResult.exitCode !== 0) {
      await evidence.append({
        phase: 'materialize',
        status: 'failed',
        exitCode: hookResult.exitCode,
        stdoutTail: tail(hookResult.stdout),
        stderrTail: tail(hookResult.stderr),
      });
      await failBlocked(new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        `materialize hook exited with code ${hookResult.exitCode}; payload cannot be trusted`,
        { exitCode: hookResult.exitCode, stdoutTail: tail(hookResult.stdout), stderrTail: tail(hookResult.stderr) },
      ));
    }

    // requireReport: stdout-first-json deep compare (declared equals subset).
    if (materialize.requireReport) {
      const report = parseFirstJsonObject(hookResult.stdout);
      if (!report) {
        await evidence.append({
          phase: 'materialize',
          status: 'failed',
          reason: 'report-missing',
          stdoutTail: tail(hookResult.stdout),
        });
        await failBlocked(new ReleaseError(
          POST_PUBLISH_VERIFY_FAILED,
          'materialize report missing: no JSON object found on stdout (requireReport.parse = stdout-first-json)',
          { stdoutTail: tail(hookResult.stdout) },
        ));
      }
      const equals = materialize.requireReport.equals ?? {};
      for (const [key, expectedValue] of Object.entries(equals)) {
        if (JSON.stringify(report[key]) !== JSON.stringify(expectedValue)) {
          await evidence.append({
            phase: 'materialize',
            status: 'failed',
            reason: 'report-mismatch',
            mismatchedKeys: Object.keys(equals).filter(
              (k) => JSON.stringify(report[k]) !== JSON.stringify(equals[k]),
            ),
          });
          await failBlocked(new ReleaseError(
            POST_PUBLISH_VERIFY_FAILED,
            `materialize report mismatch: "${key}" did not meet the frozen requireReport contract`,
            { mismatchedKey: key },
          ));
        }
      }
    }

    // outputMarker: the LAST line containing the marker announces the payload.
    const announced = parseOutputMarker(hookResult.stdout, materialize.outputMarker);
    if (!announced) {
      await evidence.append({
        phase: 'materialize',
        status: 'failed',
        reason: 'marker-missing',
        stdoutTail: tail(hookResult.stdout),
      });
      await failBlocked(new ReleaseError(
        POST_PUBLISH_VERIFY_FAILED,
        `materialize output marker "${materialize.outputMarker}" not found on stdout; payload directory unbound`,
        { stdoutTail: tail(hookResult.stdout) },
      ));
    }
    const payloadReal = await assertContainedDirectory(
      worktreePath,
      resolve(worktreePath, announced),
      'materialized payload directory',
    );
    await evidence.append({ phase: 'materialize', status: 'passed', payloadDirAnnounced: announced });

    // =======================================================================
    // Declared postPublish steps, in order (fail-closed).
    // =======================================================================
    for (const step of postPublish.steps ?? []) {
      await evidence.append({ phase: 'postpublish-step', step: step.name, status: 'started' });
      const stepResult = await hookRunner(
        {
          command: step.command,
          ...(step.cwd ? { cwd: step.cwd } : {}),
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
          ...(step.envAllowlist ? { envAllowlist: step.envAllowlist } : {}),
        },
        { root: worktreePath, env: process.env },
      );
      if (stepResult.exitCode !== 0) {
        await evidence.append({
          phase: 'postpublish-step',
          step: step.name,
          status: 'failed',
          exitCode: stepResult.exitCode,
          stdoutTail: tail(stepResult.stdout),
          stderrTail: tail(stepResult.stderr),
        });
        await failBlocked(new ReleaseError(
          GATE_FAILED,
          `postPublish step "${step.name}" exited with code ${stepResult.exitCode}`,
          { step: step.name, exitCode: stepResult.exitCode },
        ));
      }
      await evidence.append({ phase: 'postpublish-step', step: step.name, status: 'passed' });
    }

    // =======================================================================
    // Target distribution: sequential, dependency-ordered, observe-before-
    // write (reconcile equivalence — never force).
    // =======================================================================
    await evidence.append({
      phase: 'distribute',
      status: 'started',
      targetCount: orderedTargets.length,
      dryRun: dryRun === true,
    });

    const mirrorResults = new Map(); // targetId -> { sha } for dependents
    let stopped = false;
    let failures = 0;
    let pushedWrites = 0;

    const adapterContext = {
      externalWritesAuthorized: true, // dry-run side effects are adapter-guaranteed zero
      plan,
      root,
      runDir,
    };

    for (const target of orderedTargets) {
      const cp = checkpointById.get(target.id);
      cp.startedAt = clockFn();

      if (stopped) {
        cp.status = 'SKIPPED';
        cp.reason = 'EARLIER_TARGET_FAILED';
        cp.finishedAt = clockFn();
        await evidence.append({ phase: 'checkpoint', actionId: target.id, status: 'skipped', reason: 'EARLIER_TARGET_FAILED' });
        continue;
      }

      // --- Pre-observe: a remote already at the frozen tag is SKIPPED. ---
      await evidence.append({ phase: 'checkpoint', actionId: target.id, status: 'pre-observe' });
      let preObserved = {};
      try {
        const observeResult = await mirrorAdapter.observe(
          {
            actionType: ActionType.DISTRIBUTE_MIRROR,
            targetId: target.id,
            remoteUrl: target.remoteUrl,
            branch: target.branch,
            tag: postPublish.tag,
          },
          adapterContext,
        );
        preObserved = observeResult?.observation ?? {};
      } catch (err) {
        preObserved = {};
        await evidence.append({
          phase: 'checkpoint',
          actionId: target.id,
          status: 'pre-observe-unobservable',
          error: err?.message ?? String(err),
        });
      }
      if (preObserved.tagOid && preObserved.branchTip === preObserved.tagOid) {
        cp.status = 'SKIPPED';
        cp.preObserve = 'CONSISTENT';
        cp.finishedAt = clockFn();
        mirrorResults.set(target.id, { sha: preObserved.tagOid });
        await evidence.append({
          phase: 'checkpoint',
          actionId: target.id,
          status: 'skipped',
          details: { preObserve: 'CONSISTENT', sha: preObserved.tagOid },
        });
        continue;
      }

      // --- UNCERTAIN-before-write snapshot (durable pre-execute authority). ---
      cp.status = 'UNCERTAIN';
      await snapshot(DISTRIBUTING);

      // --- Build the mirror action. ---
      const action = {
        actionType: ActionType.DISTRIBUTE_MIRROR,
        targetId: target.id,
        kind: target.kind,
        remoteUrl: target.remoteUrl,
        branch: target.branch,
        tag: postPublish.tag,
        commitIdentity: postPublish.commitIdentity,
        dryRun: dryRun === true,
      };
      if (target.kind === 'payload-mirror') {
        action.payloadDir = payloadReal;
      } else {
        action.marketplace = target.marketplace;
        action.pluginName = resolvePluginName(plan, postPublish.unitId);
        const dependencyTarget = orderedTargets.find((entry) => entry.id === target.dependsOn);
        action.dependency = {
          remoteUrl: dependencyTarget.remoteUrl,
          sha: mirrorResults.get(target.dependsOn)?.sha ?? null,
        };
      }
      action.staticFiles = (target.staticFiles ?? []).map((file) => {
        const sourcePath = resolve(payloadReal, file.from);
        const rel = relative(payloadReal, sourcePath);
        if (rel === '' || isAbsolute(rel) || rel === '..'
          || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
          throw new ReleaseError(
            GATE_FAILED,
            `target "${target.id}" staticFiles entry escapes the payload directory`,
            { targetId: target.id, from: file.from },
          );
        }
        return { sourcePath, to: file.to };
      });

      // --- Execute (the adapter never throws; it returns EXECUTE_FAILED). ---
      await evidence.append({ phase: 'checkpoint', actionId: target.id, status: 'started' });
      let executeResult;
      try {
        executeResult = await mirrorAdapter.execute(action, adapterContext);
      } catch (err) {
        executeResult = {
          status: 'EXECUTE_FAILED',
          error: err?.message ?? String(err),
          details: { code: err?.code ?? GATE_FAILED },
        };
      }

      const observation = executeResult.observation ?? {};

      if (executeResult.status === 'EXECUTE_FAILED') {
        const code = mapToSchemaCode(executeResult.details?.code);
        cp.status = 'FAILED';
        cp.error = { code, message: executeResult.error ?? 'mirror execute failed' };
        cp.finishedAt = clockFn();
        failures += 1;
        stopped = true;
        await evidence.append({
          phase: 'checkpoint',
          actionId: target.id,
          status: 'failed',
          error: executeResult.error,
          details: { code },
        });
        await snapshot(PARTIAL);
        continue;
      }

      if (executeResult.status === 'NO_CHANGE') {
        cp.status = 'NO_CHANGE';
        cp.mode = 'no-change';
        cp.previousHead = observation.previousHead ?? null;
        cp.payloadFileCount = observation.payloadFileCount;
        cp.finishedAt = clockFn();
        const sha = probeObservations.get(target.id)?.tagOid
          ?? observation.branchTip
          ?? observation.previousHead
          ?? null;
        mirrorResults.set(target.id, { sha });
        await evidence.append({ phase: 'checkpoint', actionId: target.id, status: 'no-change' });
        await snapshot(PARTIAL);
        continue;
      }

      // EXECUTED: pushed or dry-run.
      cp.mode = observation.mode;
      cp.previousHead = observation.previousHead ?? undefined;
      cp.payloadFileCount = observation.payloadFileCount;
      const pushed = observation.mode === 'pushed';
      if (pushed) {
        pushedWrites += 1;
        cp.pushedCommit = observation.pushedCommit;
        mirrorResults.set(target.id, { sha: observation.pushedCommit });
      } else {
        // Dry-run: no push result exists; dependents render without a sha.
        mirrorResults.set(target.id, { sha: null });
      }

      // --- Post-execute verify (observe cross-check; pushed only). ---
      let verifyResult;
      try {
        verifyResult = await mirrorAdapter.verify(
          {
            actionType: ActionType.DISTRIBUTE_MIRROR,
            targetId: target.id,
            remoteUrl: target.remoteUrl,
            branch: target.branch,
            tag: postPublish.tag,
            ...(pushed ? { pushedCommit: observation.pushedCommit } : {}),
          },
          adapterContext,
        );
      } catch (err) {
        verifyResult = { status: 'VERIFY_FAILED', error: err?.message ?? String(err) };
      }

      if (verifyResult.status !== 'VERIFIED') {
        cp.status = 'FAILED';
        cp.postObserve = 'CONFLICTING';
        cp.error = {
          code: POST_PUBLISH_VERIFY_FAILED,
          message: verifyResult.error ?? 'post-execute verification failed',
        };
        cp.finishedAt = clockFn();
        failures += 1;
        stopped = true;
        await evidence.append({
          phase: 'checkpoint',
          actionId: target.id,
          status: 'verify-failed',
          error: verifyResult.error ?? null,
        });
        await snapshot(PARTIAL);
        continue;
      }

      cp.status = 'SUCCEEDED';
      cp.postObserve = pushed ? 'CONSISTENT' : cp.postObserve;
      cp.finishedAt = clockFn();
      await evidence.append({
        phase: 'checkpoint',
        actionId: target.id,
        status: 'completed',
        mode: observation.mode,
        pushedCommit: pushed ? observation.pushedCommit : null,
      });
      await snapshot(PARTIAL);
    }

    // =======================================================================
    // Classification: DISTRIBUTED | PARTIAL | BLOCKED (returned, not thrown).
    // =======================================================================
    let overallStatus;
    if (failures === 0) {
      overallStatus = DISTRIBUTED;
    } else if (pushedWrites > 0) {
      overallStatus = PARTIAL;
    } else {
      overallStatus = BLOCKED;
    }

    const finishedAt = clockFn();
    await snapshot(overallStatus);
    await writeRunAtomic(runPath, buildPersistedState(overallStatus, finishedAt));
    finalRecordWritten = true;

    await evidence.append({
      phase: 'distribute',
      status: 'completed',
      overallStatus,
      checkpointStatuses: checkpoints.map((cp) => cp.status),
    });
    await evidence.finish({
      status: overallStatus,
      planPath,
      runPath,
      finishedAt: clockFn(),
    });

    return { planPath, runPath, status: overallStatus, checkpoints };
  } catch (err) {
    // The happy path returns before this catch, so `evidence.finish` can never
    // double-run here: it must ALWAYS close the evidence stream and seal the
    // summary, even when failBlocked already persisted the BLOCKED record.
    try {
      await evidence.append({
        phase: 'distribute',
        status: 'failed',
        error: { code: err.code, message: err.message },
      });
      if (lineageKnown && !finalRecordWritten) await recordBlocked();
    } catch {
      // Persistence must never mask the primary failure.
    }
    await evidence.finish({
      status: lineageKnown ? BLOCKED : 'FAILED',
      error: { code: err.code, message: err.message },
      failedAt: clockFn(),
    }).catch(() => {});
    throw err;
  } finally {
    await cleanupWorktree();
  }
}
