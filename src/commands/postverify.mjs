/**
 * postVerify command: independent run routed AFTER the main run is VERIFIED
 * (v0.6.3 R3, design §2.4).
 *
 * `postVerifyRelease` produces an INDEPENDENT run record (reused run +
 * checkpoint machinery) whose lineage source is the VERIFIED verify run:
 *
 * - hooks receive the §2.3 context with `verifyEvidence` PRESENT (distribute
 *   phase contexts never carry it); `publishedAt` comes from the sealed
 *   publish run referenced by the verify run's own lineage;
 * - failure classification reuses the distribute saga family: PARTIAL after
 *   an external success, BLOCKED at zero side effects, NEEDS_INPUT for a
 *   pure awaiting-approval park — and the source verify run is NEVER
 *   touched: VERIFIED never rolls back, the failure is evidenced;
 * - requiresApproval hooks park at AWAITING_APPROVAL without a checkpoint
 *   approval (NEEDS_INPUT at zero side effects) and run once approved;
 * - a non-verify / non-VERIFIED / differently-bound source run fails closed
 *   BEFORE any write (no run authority is allocated for a rejected lineage).
 *
 * Reconcile equivalence: a rerun IS the reconcile. Every hook starts from a
 * fresh observation of its own downstream state (preset idempotence), so a
 * failed postVerify run retries to DISTRIBUTED once the failure is cleared.
 *
 * @module commands/postverify
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { boundedOutputTail } from '../core/bounded-output.mjs';
import {
  buildPostPublishContext,
  validatePostPublishDeclaration,
  effectiveHookRequiresApproval,
  POSTPUBLISH_CONTEXT_ENV,
  PAYLOAD_SOURCE_TAG_WORKTREE,
} from '../core/postpublish.mjs';
import { verifyAndInstallExecutionBundle } from '../core/postpublish-bundle.mjs';
import { assertPostPublishApprovalAuthority, validatePostPublishApproval } from '../core/postpublish-approval.mjs';
import { executePresetHook } from '../core/preset-executor.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  POST_PUBLISH_VERIFY_FAILED,
} from '../core/errors.mjs';

const execFileAsync = promisify(execFileCb);

/** Executor identity recorded in every postVerify checkpoint trace. */
const EXECUTOR = 'release-skill postverify';

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
const NEEDS_INPUT = 'NEEDS_INPUT';

function defaultClock() {
  return new Date().toISOString();
}

function defaultExec(command, args, options = {}) {
  return execFileAsync(command, args, { shell: false, encoding: 'utf8', timeout: 120_000, ...options });
}

/** Map a preset/transport error code onto the run-schema checkpoint enum. */
function mapToSchemaCode(code) {
  return SCHEMA_ERROR_CODES.has(code) ? code : GATE_FAILED;
}

/**
 * Execute the postVerify phase of a frozen, approved plan as an independent
 * run bound to the VERIFIED verify run.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.approvalPath - Absolute path to the approval record.
 * @param {string} options.sourceRunPath - Absolute path to the sealed VERIFIED verify run.
 * @param {string} [options.root] - Project root (git repository). Defaults to cwd.
 * @param {string} [options.runDir] - Evidence directory override.
 * @param {boolean} [options.dryRun] - Rehearsal: zero hook/preset execution.
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {Function} [options.execFn] - Injectable git exec (tests).
 * @param {Function} [options.runHookFn] - Injectable hook runner (tests).
 * @param {string[]} [options.postpublishApprovalPaths] - Checkpoint approval
 *   records for requiresApproval postVerify hooks; each record binds
 *   (planDigest, hookId), must be consumed from the immutable digest-
 *   addressed authority minted by approvePostPublishHook (F-02), and is
 *   validated fail-closed before any write.
 *
 * @returns {Promise<{ planPath: string, runPath: string, status: string, checkpoints: Object[] }>}
 *
 * @throws {ReleaseError} on any safety-gate failure (before any write while
 *   the lineage is untrusted; evidenced afterwards).
 */
export async function postVerifyRelease(options) {
  const {
    planPath,
    approvalPath,
    sourceRunPath,
    root = process.cwd(),
    runDir: runDirOpt,
    dryRun = false,
    clock: clockOpt,
    execFn,
    runHookFn,
    postpublishApprovalPaths,
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
      'release plan has no postPublish declaration; nothing to postVerify',
      { planPath },
    );
  }

  // =========================================================================
  // Gate 2: approval record validation (binding checks; the post-publish
  // phase waives only the expiry window, exactly like distribute).
  // =========================================================================
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
  const approvalDigestValue = assertImmutableApprovalAuthority(approvalPath, plan, approvalRaw)
    ?? computeApprovalDigest(approvalRaw);
  validateApprovalRecordSchema(approval);
  validateApproval(plan, approval, { clock: clockFn, requireUnexpired: false });

  // =========================================================================
  // Gate 3: source run lineage — ONLY a VERIFIED verify run bound to this
  // exact plan may drive postVerify. Fails closed before any write.
  // =========================================================================
  const verifyRun = await loadRun(sourceRunPath, { requireDigest: true });
  if (verifyRun.command !== 'verify') {
    throw new ReleaseError(
      GATE_FAILED,
      `postVerify source run must be a verify run, got command "${verifyRun.command}"`,
      { sourceRunPath, command: verifyRun.command },
    );
  }
  if (verifyRun.status !== 'VERIFIED') {
    throw new ReleaseError(
      GATE_FAILED,
      `postVerify source run must be VERIFIED, got "${verifyRun.status}"; the verify conclusion never rolls back, so only a VERIFIED run may drive postVerify`,
      { sourceRunPath, status: verifyRun.status },
    );
  }
  validateRunPlanDigest(verifyRun, plan, { planPath });

  // The publish run referenced by the verify run's own lineage supplies
  // publishedAt (context §2.3): verify runs never fabricate it.
  if (!verifyRun.sourceRunPath || !verifyRun.sourceRunId || !verifyRun.sourceRunDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      'postVerify source verify run is missing complete source run lineage; publishedAt cannot be trusted',
      { sourceRunPath },
    );
  }
  const publishRun = await loadRun(verifyRun.sourceRunPath, { requireDigest: true });
  if (publishRun.runId !== verifyRun.sourceRunId || publishRun.runDigest !== verifyRun.sourceRunDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      'postVerify source verify run lineage id/digest does not match the referenced publish run bytes',
      { sourceRunPath, publishRunPath: verifyRun.sourceRunPath },
    );
  }

  // =========================================================================
  // Declaration re-validation + postVerify-phase hook selection.
  // =========================================================================
  const postPublish = plan.postPublish;
  validatePostPublishDeclaration(postPublish, { unitId: postPublish.unitId });
  const declaredHooks = postPublish.hooks ?? [];
  const postVerifyHooks = declaredHooks.filter((hook) => (hook.phase ?? 'distribute') === 'postVerify');

  // =========================================================================
  // Gate 4: checkpoint approvals for requiresApproval hooks. Every provided
  // record is validated fail-closed BEFORE any write: first the immutable
  // authority binding (F-02: the consumption path must BE the digest-
  // addressed authority minted by approvePostPublishHook — recomputed
  // planDigest directory, recomputed approvalDigest file name, strict
  // no-follow regular-file read, no symlinked ancestor), then the content
  // checks (schema, planDigest binding, declared hook, requiresApproval,
  // 24h window, expiry). A bad approval aborts the whole run; a missing one
  // parks the hook at AWAITING_APPROVAL.
  // =========================================================================
  const approvedHookIds = new Set();
  const hookApprovalPaths = postpublishApprovalPaths ?? [];
  for (const hookApprovalPath of hookApprovalPaths) {
    let hookApprovalRaw;
    try {
      hookApprovalRaw = await readFile(hookApprovalPath, 'utf8');
    } catch (err) {
      throw new ReleaseError(
        GATE_FAILED,
        `cannot read postpublish hook approval: ${err.message}`,
        { hookApprovalPath, cause: err.code },
      );
    }
    let hookApproval;
    try {
      hookApproval = JSON.parse(hookApprovalRaw);
    } catch (err) {
      throw new ReleaseError(
        GATE_FAILED,
        `postpublish hook approval is not valid JSON: ${err.message}`,
        { hookApprovalPath },
      );
    }
    // F-02: identical bytes anywhere else are not an approval. The authority
    // assertion runs before content validation and before the hook may enter
    // approvedHookIds.
    await assertPostPublishApprovalAuthority(planPath, hookApprovalPath, plan, hookApprovalRaw);
    validatePostPublishApproval(plan, hookApproval, { clock: clockFn });
    if (approvedHookIds.has(hookApproval.hookId)) {
      throw new ReleaseError(
        GATE_FAILED,
        `duplicate postpublish hook approvals for hook "${hookApproval.hookId}"`,
        { hookId: hookApproval.hookId },
      );
    }
    approvedHookIds.add(hookApproval.hookId);
  }

  // =========================================================================
  // Gate 5: tag identity — the live tag must still point at the frozen
  // tagCommit (read-only observation; still before any write).
  // =========================================================================
  if (postPublish.payloadSource !== PAYLOAD_SOURCE_TAG_WORKTREE) {
    throw new ReleaseError(
      GATE_FAILED,
      `postPublish.payloadSource must be "${PAYLOAD_SOURCE_TAG_WORKTREE}"`,
      { payloadSource: postPublish.payloadSource },
    );
  }
  if (typeof postPublish.tagCommit !== 'string' || !SHA_RE.test(postPublish.tagCommit)) {
    throw new ReleaseError(
      GATE_FAILED,
      'postPublish is missing a frozen tagCommit binding; postVerify fails closed',
      { tagCommit: postPublish.tagCommit ?? null },
    );
  }
  let observedTagCommit;
  try {
    const { stdout } = await exec('git', ['-C', root, 'rev-parse', '--verify', `${postPublish.tag}^{commit}`]);
    observedTagCommit = `${stdout}`.trim();
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `tag "${postPublish.tag}" does not resolve to a commit in the source repository; postVerify fails closed`,
      { tag: postPublish.tag, stderrTail: boundedOutputTail(err?.stderr ?? err?.message) },
    );
  }
  if (observedTagCommit !== postPublish.tagCommit) {
    throw new ReleaseError(
      GATE_FAILED,
      `tag "${postPublish.tag}" points at ${observedTagCommit}, but the frozen plan binds tagCommit ${postPublish.tagCommit}`,
      { tag: postPublish.tag, frozenTagCommit: postPublish.tagCommit, observedTagCommit },
    );
  }

  // =========================================================================
  // All gates passed: allocate the independent run authority. From here on,
  // every failure is evidenced; the source verify run is never touched.
  // =========================================================================
  const runId = `postverify-${Date.now()}`;
  let runDir = runDirOpt ?? resolveDefaultRunDir(planPath, 'postverify', runId);
  if (plan.production?.mode === 'github-npm-v1') {
    runDir = await createProductionRunDir(runDir, planPath);
  } else {
    await mkdir(runDir, { recursive: true });
  }
  const runPath = join(runDir, 'release-run.json');
  const evidence = createEvidenceWriter({ runDir, command: 'postverify', clock: clockFn });

  let finalRecordWritten = false;
  const startedAt = clockFn();
  let stateSequence = -1;

  const checkpoints = postVerifyHooks.map((hook) => ({
    actionId: hook.id,
    actionType: 'postpublish-hook',
    status: 'PENDING',
    executor: EXECUTOR,
  }));
  const checkpointById = new Map(checkpoints.map((cp) => [cp.actionId, cp]));

  const buildPersistedState = (status, finishedAt) => ({
    runId,
    command: 'postverify',
    status,
    planDigest: plan.digest ?? actualDigest,
    planPath,
    ...(approvalDigestValue ? { approvalDigest: approvalDigestValue } : {}),
    ...(approvalPath ? { approvalPath } : {}),
    sourceRunId: verifyRun.runId,
    sourceRunDigest: verifyRun.runDigest,
    sourceRunPath,
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
        : cp.status, // NO_CHANGE / AWAITING_APPROVAL pass through as-is
      ...(cp.mode ? { mode: cp.mode } : {}),
      ...(cp.pushedCommit ? { pushedCommit: cp.pushedCommit } : {}),
      ...(cp.executor ? { executor: cp.executor } : {}),
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

  /** Persist the BLOCKED run record (idempotent) once the run exists. */
  const recordBlocked = async () => {
    if (finalRecordWritten) return;
    try {
      await writeRunAtomic(runPath, buildPersistedState(BLOCKED, clockFn()));
      finalRecordWritten = true;
    } catch {
      // Persistence must never mask the primary failure.
    }
  };

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
    await evidence.append({
      phase: 'postverify',
      status: 'started',
      sourceVerifyRunId: verifyRun.runId,
      sourcePublishRunId: publishRun.runId,
      hookCount: postVerifyHooks.length,
      dryRun: dryRun === true,
    });

    // Durable pre-execute authority (seq 0).
    await snapshot(DISTRIBUTING);

    // =======================================================================
    // F-04 root split: postVerify holds TWO distinct roots —
    // - releaseWorkspaceRoot: the real project root the user releases from;
    //   only used to resolve preset target.workspace, compare the release-
    //   workspace write exclusion, and audit;
    // - executionWorktreeRoot (worktreePath): the detached worktree at the
    //   frozen tagCommit; only used as the hook runner context.root for
    //   custom command hooks.
    // The two roots never fall back onto each other through defaults.
    // =======================================================================
    let releaseWorkspaceRoot;
    try {
      releaseWorkspaceRoot = await realpath(root);
    } catch (err) {
      await recordBlocked();
      throw new ReleaseError(
        GATE_FAILED,
        `release workspace root does not resolve to an existing directory: ${err.message}`,
        { root, cause: err.code },
      );
    }

    // R1 timing contract carries over: hooks run inside a detached worktree
    // at the frozen tagCommit, never in the live workspace. Dry-run executes
    // nothing, so no worktree is allocated for a rehearsal.
    if (dryRun !== true) {
      try {
        tmpBase = await mkdtemp(join(tmpdir(), 'release-skill-postverify-'));
        worktreePath = join(tmpBase, 'worktree');
        await exec('git', ['-C', root, 'worktree', 'add', '--detach', worktreePath, postPublish.tagCommit]);
      } catch (err) {
        await evidence.append({
          phase: 'worktree',
          status: 'failed',
          error: boundedOutputTail(err?.stderr ?? err?.message),
        });
        await recordBlocked();
        throw new ReleaseError(
          GATE_FAILED,
          `cannot create the detached tag worktree at ${postPublish.tagCommit}: ${err?.message ?? err}`,
          { tagCommit: postPublish.tagCommit },
        );
      }
      await evidence.append({ phase: 'worktree', status: 'passed' });

      // =====================================================================
      // Private execution bundle (F-01 / T1): postVerify re-entry consumes
      // the SAME frozen bundle bytes — never the live workspace copies.
      // Strictly re-read the digest-addressed bytes, recompute the closure
      // through Foundation, and install ONLY the verified bytes into the
      // fresh tag worktree before any hook runs; any mismatch fails closed
      // before a hook or an external write.
      // =====================================================================
      let installedBundlePaths = [];
      try {
        ({ installed: installedBundlePaths } = await verifyAndInstallExecutionBundle({
          plan,
          planPath,
          worktreePath,
        }));
      } catch (err) {
        await evidence.append({
          phase: 'worktree',
          gate: 'execution-bundle',
          status: 'failed',
          error: boundedOutputTail(err?.message ?? String(err)),
        });
        await recordBlocked();
        throw err instanceof ReleaseError ? err : new ReleaseError(
          GATE_FAILED,
          `cannot verify the frozen execution bundle: ${err?.message ?? err}`,
        );
      }
      await evidence.append({
        phase: 'worktree',
        gate: 'execution-bundle',
        status: 'passed',
        installed: installedBundlePaths,
      });
    }

    // §2.3 context projection: verifyEvidence PRESENT (postVerify phase);
    // publishedAt from the sealed publish run; payloadDir never travels.
    const verifyEvidence = {
      runId: verifyRun.runId,
      status: verifyRun.status,
      finishedAt: verifyRun.finishedAt,
    };
    const hookContextProjection = buildPostPublishContext({
      plan,
      runId,
      sourceRun: publishRun,
      payloadDir: undefined,
      phase: 'postVerify',
      verifyEvidence,
    });

    // Proposal documents must stay byte-deterministic across redeliveries of
    // the SAME release event (NO_CHANGE idempotence): they travel with the
    // stable lineage-derived event identity, not the per-attempt runId.
    const proposalContextProjection = {
      ...hookContextProjection,
      runId: `postverify-${verifyRun.runId}`,
    };

    // =========================================================================
    // postVerify hooks, declared order. A failure stops the chain; a
    // requiresApproval hook without a checkpoint approval parks at
    // AWAITING_APPROVAL and never executes; dry-run executes nothing.
    // =========================================================================
    let hooksStopped = false;
    let failures = 0;
    let awaitingApproval = 0;
    let externalSuccesses = 0;

    for (const hook of postVerifyHooks) {
      const cp = checkpointById.get(hook.id);
      cp.startedAt = clockFn();

      if (hooksStopped) {
        cp.status = 'SKIPPED';
        cp.reason = 'EARLIER_HOOK_FAILED';
        cp.finishedAt = clockFn();
        await evidence.append({
          phase: 'postpublish-hook',
          hookId: hook.id,
          status: 'skipped',
          reason: 'EARLIER_HOOK_FAILED',
        });
        continue;
      }

      if (dryRun === true) {
        cp.status = 'SKIPPED';
        cp.reason = 'DRY_RUN';
        cp.finishedAt = clockFn();
        await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'skipped', reason: 'DRY_RUN' });
        continue;
      }

      if (effectiveHookRequiresApproval(hook) && !approvedHookIds.has(hook.id)) {
        // No checkpoint approval: the hook must not execute. It parks (does
        // not stop the chain — the approved rerun re-executes it).
        cp.status = 'AWAITING_APPROVAL';
        cp.finishedAt = clockFn();
        awaitingApproval += 1;
        await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'awaiting-approval' });
        continue;
      }

      // -----------------------------------------------------------------
      // Preset hooks dispatch through the R4 preset executor (one seam for
      // every registered preset; fail-closed wording for presets registered
      // but not yet shipped).
      // -----------------------------------------------------------------
      if (hook.preset !== undefined) {
        await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'started' });
        let delivery;
        try {
          delivery = await executePresetHook({
            hook,
            contextProjection: hookContextProjection,
            proposalContextProjection,
            commitIdentity: postPublish.commitIdentity,
            // F-04: presets receive the RELEASE workspace root (target.workspace
            // resolution + release-workspace write exclusion). The detached
            // worktree is the execution worktree and never impersonates it.
            releaseWorkspaceRoot,
            evidencePath: join(runDir, 'evidence.jsonl'),
            exec,
            hookRunner,
          });
        } catch (err) {
          const code = mapToSchemaCode(err?.code);
          cp.status = 'FAILED';
          cp.error = { code, message: err?.message ?? String(err) };
          cp.finishedAt = clockFn();
          failures += 1;
          hooksStopped = true;
          await evidence.append({
            phase: 'postpublish-hook',
            hookId: hook.id,
            status: 'failed',
            error: err?.message ?? String(err),
            details: { code },
          });
          await snapshot(PARTIAL);
          continue;
        }

        if (delivery.status === 'NO_CHANGE') {
          cp.status = 'NO_CHANGE';
          cp.mode = 'no-change';
          cp.finishedAt = clockFn();
          externalSuccesses += 1;
          await evidence.append({
            phase: 'postpublish-hook',
            hookId: hook.id,
            status: 'no-change',
            ...(delivery.manualSyncPrompt ? { manualSyncPrompt: delivery.manualSyncPrompt } : {}),
            // §2.6 execution realpath evidence (R4 review m-2).
            ...(delivery.observation?.workspaceRealpath
              ? { workspaceRealpath: delivery.observation.workspaceRealpath }
              : {}),
            ...(delivery.workspaceRealpath ? { workspaceRealpath: delivery.workspaceRealpath } : {}),
          });
          await snapshot(PARTIAL);
          continue;
        }

        cp.status = 'SUCCEEDED';
        if (delivery.observation?.mode === 'pushed' && delivery.observation?.pushedCommit) {
          cp.mode = 'pushed';
          cp.pushedCommit = delivery.observation.pushedCommit;
        }
        cp.finishedAt = clockFn();
        externalSuccesses += 1;
        await evidence.append({
          phase: 'postpublish-hook',
          hookId: hook.id,
          status: 'succeeded',
          preset: hook.preset,
          mode: delivery.mode ?? delivery.observation?.mode,
          ...(delivery.observation?.pushedCommit ? { pushedCommit: delivery.observation.pushedCommit } : {}),
          ...(delivery.manualSyncPrompt ? { manualSyncPrompt: delivery.manualSyncPrompt } : {}),
          ...(delivery.checklist ? { checklist: delivery.checklist } : {}),
          ...(delivery.degradedToNotifyHandoff === true ? { degradedToNotifyHandoff: true } : {}),
          ...(Array.isArray(delivery.observations) ? { targets: delivery.observations } : {}),
          // §2.6 execution realpath evidence (R4 review m-2) + explicit
          // cross-check skip note (R4 review m-4).
          ...(delivery.observation?.workspaceRealpath
            ? { workspaceRealpath: delivery.observation.workspaceRealpath }
            : {}),
          ...(delivery.workspaceRealpath ? { workspaceRealpath: delivery.workspaceRealpath } : {}),
          ...(delivery.observation?.crossCheck ? { crossCheck: delivery.observation.crossCheck } : {}),
        });
        await snapshot(PARTIAL);
        continue;
      }

      // -----------------------------------------------------------------
      // Custom command hooks: executed inside the frozen tag worktree with
      // the §2.3 context injected via the contract env var.
      // -----------------------------------------------------------------
      await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'started' });
      let hookExecution;
      try {
        hookExecution = await hookRunner(
          {
            command: hook.command,
            ...(hook.cwd ? { cwd: hook.cwd } : {}),
            ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
            ...(hook.envAllowlist ? { envAllowlist: hook.envAllowlist } : {}),
          },
          {
            // F-04: custom command hooks keep running in the execution
            // worktree; the runner's cwd containment binds them there.
            root: worktreePath,
            env: process.env,
            injectEnv: { [POSTPUBLISH_CONTEXT_ENV]: JSON.stringify(hookContextProjection) },
          },
        );
      } catch (err) {
        // HOOK_TIMEOUT (or a runner defect): FAILED checkpoint, stop the chain.
        const code = err?.code === 'HOOK_TIMEOUT' ? 'HOOK_TIMEOUT' : POST_PUBLISH_VERIFY_FAILED;
        cp.status = 'FAILED';
        cp.error = { code, message: err?.message ?? String(err) };
        cp.finishedAt = clockFn();
        failures += 1;
        hooksStopped = true;
        await evidence.append({
          phase: 'postpublish-hook',
          hookId: hook.id,
          status: 'failed',
          error: err?.message ?? String(err),
        });
        await snapshot(PARTIAL);
        continue;
      }

      if (hookExecution.exitCode !== 0) {
        cp.status = 'FAILED';
        cp.error = {
          code: POST_PUBLISH_VERIFY_FAILED,
          message: `postVerify hook "${hook.id}" exited with code ${hookExecution.exitCode}`,
        };
        cp.finishedAt = clockFn();
        failures += 1;
        hooksStopped = true;
        await evidence.append({
          phase: 'postpublish-hook',
          hookId: hook.id,
          status: 'failed',
          exitCode: hookExecution.exitCode,
          stdoutTail: boundedOutputTail(hookExecution.stdout),
          stderrTail: boundedOutputTail(hookExecution.stderr),
        });
        await snapshot(PARTIAL);
        continue;
      }

      cp.status = 'SUCCEEDED';
      cp.finishedAt = clockFn();
      externalSuccesses += 1;
      await evidence.append({ phase: 'postpublish-hook', hookId: hook.id, status: 'succeeded' });
      await snapshot(PARTIAL);
    }

    // =========================================================================
    // Classification (returned, not thrown) — distribute saga family:
    // - DISTRIBUTED: no failures and no awaiting-approval hooks;
    // - NEEDS_INPUT: only awaiting-approval checkpoints and zero external
    //   side effects so far (pure input-needed state, never PARTIAL);
    // - PARTIAL: at least one external success alongside failures or
    //   awaiting-approval checkpoints;
    // - BLOCKED: failures with zero external side effects landed.
    // =========================================================================
    let overallStatus;
    if (failures === 0 && awaitingApproval === 0) {
      overallStatus = DISTRIBUTED;
    } else if (failures === 0) {
      overallStatus = externalSuccesses > 0 ? PARTIAL : NEEDS_INPUT;
    } else {
      overallStatus = externalSuccesses > 0 ? PARTIAL : BLOCKED;
    }

    const finishedAt = clockFn();
    await snapshot(overallStatus);
    await writeRunAtomic(runPath, buildPersistedState(overallStatus, finishedAt));
    finalRecordWritten = true;

    await evidence.append({
      phase: 'postverify',
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
    try {
      await evidence.append({
        phase: 'postverify',
        status: 'failed',
        error: { code: err.code, message: err.message },
      });
      if (!finalRecordWritten) await recordBlocked();
    } catch {
      // Persistence must never mask the primary failure.
    }
    await evidence.finish({
      status: BLOCKED,
      error: { code: err.code, message: err.message },
      failedAt: clockFn(),
    }).catch(() => {});
    throw err;
  } finally {
    await cleanupWorktree();
  }
}
