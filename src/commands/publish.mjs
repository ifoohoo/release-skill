/**
 * Publish command: Saga-pattern checkpoint execution with safety gates.
 *
 * Reads a frozen, approved release plan and executes external actions
 * through registered adapters. Every step is a checkpoint: failure stops
 * subsequent actions and records PARTIAL status.
 *
 * Safety gates (all verified before any adapter execute):
 * 1. Plan schema validation
 * 2. Plan digest verification
 * 3. Approval record schema validation
 * 4. Approval-plan digest match
 * 5. Approval expiry check
 * 6. Target version match
 * 7. Approved actions allowlist check
 * 8. Action type adapter availability
 * 9. Baseline hash comparison (rejects stale baseline, calls zero adapter execute)
 * 10. Remote preflight (adapter-level)
 *
 * Invariants:
 * - Baseline change => BASELINE_CHANGED, zero adapter execute calls
 * - Any checkpoint failure => PARTIAL, no subsequent adapter execute calls
 * - System never auto-deletes remote tags, overwrites releases, or unpublishes npm
 *
 * @module commands/publish
 */

import { readFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { assertImmutablePlanAuthority, computePlanDigest, validatePlan, validatePlanActionCompleteness } from '../core/plan.mjs';
import {
  assertImmutableApprovalAuthority,
  computeApprovalDigest,
  validateApproval,
  validateApprovalRecordSchema,
} from '../core/approval.mjs';
import { captureBaseline, WORKSPACE_DIGEST_ALGORITHM } from '../core/baseline.mjs';
import {
  assertPreviousPublicBaselineTarget,
  reObservePreviousPublicBaseline,
} from '../core/previous-public-baseline.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import {
  ADAPTER_ACTION_TYPE_MAP,
  TIER_TABLE,
  groupActionsByTier,
  sortActionsByCheckpointOrder,
} from '../core/checkpoints.mjs';
import { appendRunState, createProductionRunDir, writeRunAtomic, resolveDefaultRunDir } from '../core/run.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  BASELINE_CHANGED,
  PARTIAL_RELEASE,
} from '../core/errors.mjs';
import { assertTransition, PUBLISHING, PUBLISHED, PARTIAL } from '../core/state-machine.mjs';
import { matchObservation } from '../adapters/contract.mjs';
import { observeWithRetry, clampPolicyToTimeout, DEFAULT_OBSERVE_RETRY_POLICY, isPropagatingMissing } from '../core/observe-retry.mjs';
import {
  resolveFrozenPath,
  verifyFrozenFile,
  verifyFrozenGitRepository,
  verifyFrozenSnapshot,
} from '../snapshot/frozen.mjs';
import { verifyFrozenNpmTarballIdentity } from '../adapters/npm.mjs';

function assertInsideAssetRoot(assetRoot, candidate, label) {
  const rel = relative(assetRoot, candidate);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new ReleaseError(GATE_FAILED, `${label} must be a child of the production asset root`);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTION_NOT_ALLOWED = 'ACTION_NOT_ALLOWED';

// CHECKPOINT_ORDER, ADAPTER_ACTION_TYPE_MAP and TIER_TABLE live in
// ../core/checkpoints.mjs (single source shared with reconcile.mjs; T3.1 §4.7).

const MARKETPLACE_TYPES = new Set([
  'claude-marketplace-install',
  'codex-marketplace-install',
  'kimi-marketplace-install',
  'codebuddy-marketplace-install',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultClock() {
  return new Date().toISOString();
}

/**
 * Deep-clone a JSON-serialisable value.
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Pre-observe classification (T3.3 observe-before-execute)
// ---------------------------------------------------------------------------

/**
 * Four-valued result of classifying a single read-only pre-observe.
 *
 * - CONSISTENT: the remote already satisfies the frozen plan -> SKIPPED.
 * - MISSING: an explicit absence marker -> proceed to execute.
 * - CONFLICTING: present but disagrees with the frozen plan -> fail closed.
 * - UNOBSERVABLE: no usable observation -> proceed to execute (the mandatory
 *   post-execute observe remains the safety net).
 *
 * @enum {string}
 */
export const PRE_OBSERVE = Object.freeze({
  CONSISTENT: 'CONSISTENT',
  MISSING: 'MISSING',
  CONFLICTING: 'CONFLICTING',
  UNOBSERVABLE: 'UNOBSERVABLE',
});

/** True when `expected` is a non-empty object (vacuous matches are rejected). */
function hasExpected(expected) {
  return !!expected && typeof expected === 'object' && Object.keys(expected).length > 0;
}

/**
 * Classify a single read-only pre-observe result for one action.
 *
 * Shared single source for BOTH preflight layers (the per-checkpoint pre-observe
 * inside executeCheckpoint and the Safety-Gate-10 global preflight arbitration);
 * the two layers must never drift apart (T3.3 §4.6).
 *
 * Classification order is the semantics:
 * 1. UNOBSERVABLE -- no observation, or an empty observation (a thrown observe
 *    surfaces as an empty observation with `error`). Fail-safe: the caller
 *    proceeds to execute.
 * 2. Double-safe-state actions (push-snapshot, set-default-branch) mirror
 *    reconcile's special templates: a "safe pre-state" (frozen predecessor /
 *    still-old default branch) is MISSING (execute), NOT CONFLICTING, so a fresh
 *    publish is not blown up by generic three-way classification.
 * 3. Generic actions -- CONSISTENT when the observation matches a non-empty
 *    expected; MISSING on an explicit absence marker (single-sourced from
 *    isPropagatingMissing); otherwise CONFLICTING.
 *
 * Actions with no (or an empty) expected can never be CONSISTENT here; callers
 * skip pre-observe for them entirely (matchObservation({}, obs) would vacuously
 * match and wrongly SKIPPED).
 *
 * @param {{ type?: string, expected?: Object, parameters?: Object }} action
 * @param {{ observation?: Object|null, error?: string|null }|null} observeResult
 * @returns {string} One of PRE_OBSERVE values.
 */
export function classifyPreObservation(action, observeResult) {
  const observation = observeResult?.observation;
  // 1. UNOBSERVABLE: missing or empty observation (covers thrown observes, which
  // adapters normalize to an empty observation + error).
  if (!observation || Object.keys(observation).length === 0) {
    return PRE_OBSERVE.UNOBSERVABLE;
  }

  const expected = action?.expected;
  const parameters = action?.parameters ?? {};

  // 2a. push-snapshot (mirrors reconcile.mjs advance-push template).
  if (action?.type === 'push-snapshot') {
    if (hasExpected(expected) && matchObservation(expected, observation).matches) {
      return PRE_OBSERVE.CONSISTENT; // already at the planned successor
    }
    if (parameters.expectedBaselineCommit && observation.commit === parameters.expectedBaselineCommit) {
      return PRE_OBSERVE.MISSING; // still at the frozen predecessor: safe to push
    }
    if (observation.exists === false) {
      return PRE_OBSERVE.MISSING; // remote branch absent: safe to create
    }
    return PRE_OBSERVE.CONFLICTING; // a third-party tip
  }

  // 2b. set-default-branch (mirrors reconcile.mjs default-branch template).
  if (action?.type === 'set-default-branch') {
    // Safety floor first: the target branch tip must not have advanced past the
    // frozen commit -- never switch the default branch onto a moved tip.
    if (parameters.expectedNewBranchCommit && observation.newBranchCommit !== parameters.expectedNewBranchCommit) {
      return PRE_OBSERVE.CONFLICTING;
    }
    if (observation.defaultBranch === parameters.newBranch
      && hasExpected(expected) && matchObservation(expected, observation).matches) {
      return PRE_OBSERVE.CONSISTENT; // already switched
    }
    if (observation.defaultBranch === parameters.oldBranch) {
      return PRE_OBSERVE.MISSING; // not switched yet: safe to execute
    }
    return PRE_OBSERVE.CONFLICTING; // a third branch is the default
  }

  // 3. Generic actions (create-tag, npm-publish, github-release, git-push, ...).
  if (hasExpected(expected) && matchObservation(expected, observation).matches) {
    return PRE_OBSERVE.CONSISTENT;
  }
  if (isPropagatingMissing(observeResult)) {
    return PRE_OBSERVE.MISSING;
  }
  return PRE_OBSERVE.CONFLICTING;
}

// ---------------------------------------------------------------------------
// Checkpoint execution
// ---------------------------------------------------------------------------

/**
 * Execute a single checkpoint action through the adapter registry.
 *
 * @param {Object} action - The external action from the plan.
 * @param {Object} adapterRegistry - The adapter registry.
 * @param {Object} context - Adapter context (plan, baseline, root, externalWritesAuthorized).
 * @returns {Promise<{ actionId: string, status: string, error: string|null }>}
 */
async function executeCheckpoint(action, adapterRegistry, context) {
  const { id: actionId, type: planActionType } = action;

  // write-remote-identifier is a meta-checkpoint: update the plan with
  // resource identifiers. No external adapter call.
  if (planActionType === 'write-remote-identifier') {
    return { actionId, status: 'SUCCEEDED', error: null };
  }

  const adapterActionType = ADAPTER_ACTION_TYPE_MAP[planActionType];
  if (!adapterActionType) {
    return {
      actionId,
      status: 'FAILED',
      error: `Unknown action type: ${planActionType}`,
    };
  }

  const adapter = adapterRegistry.getAdapter(adapterActionType);
  if (!adapter) {
    return {
      actionId,
      status: 'FAILED',
      error: `No adapter for action type: ${adapterActionType}`,
    };
  }

  // T3.3 pre-observe (observe-before-execute): read the remote ONCE, before
  // preflight. A remote already consistent with the frozen plan is SKIPPED
  // (idempotent, zero side effects); an explicit conflict fails closed for human
  // review. Order is the contract: pre-observe -> preflight -> execute, so an
  // "already consistent" remote is never misread by preflight as "occupied".
  // Single-shot on purpose (NOT observeWithRetry): a missing/unobservable
  // pre-observe simply proceeds to execute, whose mandatory post-observe remains
  // the safety net (T3.3 §4.4 asymmetry). Actions without a usable expected are
  // skipped here and keep the legacy preflight -> execute behavior.
  let preObserve;
  if (hasExpected(action.expected)) {
    const preObserveInput = {
      actionType: adapterActionType,
      ...action.parameters,
      expected: action.expected,
    };
    let preObserveResult;
    try {
      preObserveResult = await adapter.observe(preObserveInput, context);
    } catch (error) {
      preObserveResult = { observation: null, error: error?.message ?? String(error) };
    }
    const classification = classifyPreObservation(action, preObserveResult);
    await context.evidence?.append?.({
      phase: 'checkpoint-pre-observe',
      actionId,
      actionType: planActionType,
      status: 'pre-observe',
      details: { preObserve: classification },
    });
    if (classification === PRE_OBSERVE.CONSISTENT) {
      return {
        actionId,
        status: 'SKIPPED',
        error: null,
        observation: preObserveResult?.observation ?? null,
        preObserve: PRE_OBSERVE.CONSISTENT,
      };
    }
    if (classification === PRE_OBSERVE.CONFLICTING) {
      const mismatches = matchObservation(action.expected, preObserveResult?.observation ?? {}).mismatches;
      return {
        actionId,
        status: 'FAILED',
        error: `pre-observe conflict: ${mismatches.join('; ') || 'remote state is present but does not match the frozen plan'}`,
        observation: preObserveResult?.observation ?? null,
        preObserve: PRE_OBSERVE.CONFLICTING,
      };
    }
    if (classification === PRE_OBSERVE.MISSING) {
      preObserve = PRE_OBSERVE.MISSING;
    }
    // UNOBSERVABLE: `preObserve` stays undefined (left empty, never MISSING).
  }

  // Preflight (read-only, no authorization required)
  const preflightResult = await adapter.preflight(
    { actionType: adapterActionType, ...action.parameters },
    context,
  );
  if (preflightResult.status === 'PREFLIGHT_FAILED') {
    return {
      actionId,
      status: 'FAILED',
      error: preflightResult.error ?? 'Preflight failed',
    };
  }

  // Execute (write action, requires externalWritesAuthorized)
  let executeResult;
  let executeError = null;
  try {
    executeResult = await adapter.execute(
      { actionType: adapterActionType, ...action.parameters },
      context,
    );
  } catch (error) {
    executeError = error;
  }

  // Once execute was attempted, its return value is not authoritative: the
  // remote may have accepted the write before the connection failed. Always
  // observe before classifying the checkpoint.
  const observeInput = {
    actionType: adapterActionType,
    ...action.parameters,
    expected: action.expected,
  };

  let observeResult;
  if (executeError) {
    // execute threw: remote state is unknown. Keep the SINGLE observe
    // path and never retry — retrying cannot resolve an unknown write
    // outcome, and must not mask a real conflict. (T1.1 fail-closed.)
    try {
      observeResult = await adapter.observe(observeInput, context);
    } catch (error) {
      return {
        actionId,
        status: 'UNCERTAIN',
        error: `execute outcome is uncertain; observe threw: ${error.message}`,
        ...(preObserve ? { preObserve } : {}),
      };
    }
  } else {
    // execute did not throw: a missing/uncertain observe may be a
    // transient propagation delay (e.g. npm registry eventual
    // consistency). Retry the read-only observe with bounded backoff
    // (T1.1 PROPAGATING handling). A present-but-mismatched
    // observation (CONFLICTING) is never retried — it is an
    // authoritative conflict that must fail closed for human review.
    const observePolicy = MARKETPLACE_TYPES.has(planActionType)
      ? clampPolicyToTimeout(DEFAULT_OBSERVE_RETRY_POLICY, action.parameters?.timeoutMs)
      : DEFAULT_OBSERVE_RETRY_POLICY;
    const retryOutcome = await observeWithRetry({
      observe: (act, ctx) => adapter.observe(act, ctx),
      action: observeInput,
      context,
      policy: observePolicy,
      sleep: context.observeRetrySleep,
      onAttempt: (info) => context.evidence?.append?.({
        phase: 'checkpoint-observe-retry',
        actionId,
        actionType: planActionType,
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
        missing: info.missing,
        delayMs: info.delayMs,
        status: info.missing ? 'propagating' : 'resolved',
        error: info.error ?? null,
      }),
    });
    observeResult = retryOutcome.result;
  }

  const observation = observeResult?.observation;
  if (!observation || (observeResult.error && Object.keys(observation).length === 0)) {
    return {
      actionId,
      status: 'UNCERTAIN',
      error: `execute outcome is uncertain; observe failed: ${observeResult?.error ?? 'empty observation'}`,
      ...(preObserve ? { preObserve } : {}),
    };
  }

  if (action.expected && matchObservation(action.expected, observation).matches) {
    return { actionId, status: 'SUCCEEDED', error: null, observation, postObserve: PRE_OBSERVE.CONSISTENT, ...(preObserve ? { preObserve } : {}) };
  }
  if (!action.expected && !observation.mismatched && executeResult?.status === 'EXECUTED') {
    return { actionId, status: 'SUCCEEDED', error: null, observation, postObserve: PRE_OBSERVE.CONSISTENT, ...(preObserve ? { preObserve } : {}) };
  }

  const explicitlyMissing = observation.exists === false
    || observation.remoteCommit === ''
    || observation.commit === ''
    || observation.published === false;
  if (explicitlyMissing) {
    return {
      actionId,
      status: 'FAILED',
      error: executeError?.message ?? executeResult?.error ?? 'remote state is explicitly missing after execute',
      observation,
      postObserve: PRE_OBSERVE.MISSING,
      ...(preObserve ? { preObserve } : {}),
    };
  }

  return {
    actionId,
    status: executeResult?.status === 'EXECUTED' ? 'FAILED' : 'UNCERTAIN',
    error: executeError?.message
      ?? executeResult?.error
      ?? 'observation does not match expected state from frozen plan',
    observation,
    postObserve: PRE_OBSERVE.CONFLICTING,
    ...(preObserve ? { preObserve } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a Saga-pattern publish against a frozen, approved release plan.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.approvalPath - Absolute path to the approval record.
 * @param {Object} options.adapterRegistry - Adapter registry for action execution.
 * @param {string} [options.root] - Project root for baseline capture. Defaults to cwd.
 * @param {string} [options.runDir] - Evidence directory. Defaults to `<planDir>/runs/publish-<ts>`.
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {(root: string) => Promise<Object>} [options.captureBaselineFn] - Injectable baseline capture.
 *
 * @returns {Promise<{ planPath: string, status: string, checkpoints: Object[] }>}
 *
 * @throws {ReleaseError} GATE_FAILED on any safety gate failure.
 * @throws {ReleaseError} BASELINE_CHANGED if the baseline has changed since freeze.
 */
export async function publishRelease(options) {
  const {
    planPath,
    approvalPath,
    adapterRegistry,
    root = process.cwd(),
    runDir: runDirOpt,
    clock: clockOpt,
    captureBaselineFn,
    productionMode = false,
    productionConfirmation,
    observePreviousPublicBaselineFn,
    observeRetrySleep,
  } = options ?? {};

  const clockFn = typeof clockOpt === 'function' ? clockOpt : defaultClock;
  const captureBaselineActual = typeof captureBaselineFn === 'function'
    ? captureBaselineFn
    : captureBaseline;

  // Load the plan before choosing an evidence authority. A production command
  // must reject an unsafe runDir before writing through it or authorizing any
  // adapter execute.
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
  const isProductionPlan = plan.production?.mode === 'github-npm-v1';

  // --- Set up directories ---
  const runId = `publish-${Date.now()}`;
  let runDir = runDirOpt ?? resolveDefaultRunDir(planPath, 'publish', runId);
  if (isProductionPlan) {
    runDir = await createProductionRunDir(runDir, planPath);
  } else {
    await mkdir(runDir, { recursive: true });
  }

  const evidence = createEvidenceWriter({ runDir, command: 'publish', clock: clockFn });

  try {
    // =======================================================================
    // Safety Gate 1: Load and validate plan schema
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'plan-load', status: 'started' });

    await evidence.append({ phase: 'safety-gate', gate: 'plan-schema', status: 'passed' });

    // =======================================================================
    // Safety Gate 2: Verify plan digest
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'plan-digest', status: 'started' });

    const actualDigest = computePlanDigest(plan);
    if (plan.digest && plan.digest !== actualDigest) {
      throw new ReleaseError(
        GATE_FAILED,
        `plan digest mismatch: expected ${plan.digest.slice(0, 16)}..., computed ${actualDigest.slice(0, 16)}...`,
        { expected: plan.digest, actual: actualDigest },
      );
    }

    await evidence.append({ phase: 'safety-gate', gate: 'plan-digest', status: 'passed' });

    if (productionMode && !isProductionPlan) {
      throw new ReleaseError(GATE_FAILED, 'production publish requires a github-npm-v1 frozen plan');
    }
    if (isProductionPlan) {
      if (!plan.production.assetRoot || plan.production.assetRoot === '.') {
        throw new ReleaseError(GATE_FAILED, 'production plan requires a dedicated assetRoot');
      }
      if (!productionConfirmation || productionConfirmation !== actualDigest) {
        throw new ReleaseError(
          GATE_FAILED,
          'production confirmation must exactly match the current plan digest',
          { planDigest: actualDigest },
        );
      }
    }

    // =======================================================================
    // Safety Gate 2b: Validate plan action completeness
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'action-completeness', status: 'started' });

    const completenessResult = validatePlanActionCompleteness(plan);
    if (!completenessResult.passed) {
      await evidence.append({
        phase: 'safety-gate',
        gate: 'action-completeness',
        status: 'failed',
        failures: completenessResult.details.failures,
      });
      throw new ReleaseError(
        GATE_FAILED,
        `plan action completeness gate failed: ${completenessResult.details.failures.join('; ')}`,
        { failures: completenessResult.details.failures },
      );
    }

    await evidence.append({ phase: 'safety-gate', gate: 'action-completeness', status: 'passed' });

    if (isProductionPlan) {
      await evidence.append({ phase: 'safety-gate', gate: 'frozen-artifacts', status: 'started' });
      const assetRoot = await resolveFrozenPath(root, plan.production.assetRoot, 'production asset root');
      for (const unit of plan.units) {
        const frozen = unit.frozenSnapshot;
        const snapshot = await verifyFrozenSnapshot({
          root,
          snapshotPath: frozen.path,
          expectedDigest: frozen.manifestDigest,
        });
        assertInsideAssetRoot(assetRoot, snapshot.snapshotDir, 'frozen snapshot');
        const git = await verifyFrozenGitRepository({
          root,
          gitObjectDir: frozen.gitObjectDir,
          commit: frozen.commit,
          tree: frozen.tree,
          commitTimestamp: frozen.commitTimestamp,
        });
        assertInsideAssetRoot(assetRoot, git.gitDir, 'frozen git object directory');
        if (frozen.npm) {
          const tarball = await verifyFrozenFile({
            root,
            filePath: frozen.npm.tarballPath,
            expectedSha256: frozen.npm.tarballSha256,
            label: 'frozen npm tarball',
          });
          assertInsideAssetRoot(assetRoot, tarball.physical, 'frozen npm tarball');
          const npmDistribution = (unit.distributions ?? []).find((item) => item.type === 'npm');
          if (!npmDistribution) {
            throw new ReleaseError(GATE_FAILED, `unit "${unit.id}" has a frozen npm tarball but no npm distribution`);
          }
          await verifyFrozenNpmTarballIdentity({
            package: npmDistribution.package,
            version: unit.targetVersion,
            tarballPath: frozen.npm.tarballPath,
            tarballSha256: frozen.npm.tarballSha256,
            integrity: frozen.npm.integrity,
          }, root);
        }
      }
      await evidence.append({ phase: 'safety-gate', gate: 'frozen-artifacts', status: 'passed' });
    }

    // =======================================================================
    // Safety Gates 3-7: Load and validate approval record (shared)
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'approval-load', status: 'started' });

    let approvalRaw;
    try {
      approvalRaw = await readFile(approvalPath, 'utf8');
    } catch (err) {
      throw new ReleaseError(
        GATE_FAILED,
        `cannot read approval record: ${err.message}`,
        { approvalPath, cause: err.code },
      );
    }

    let approval;
    try {
      approval = JSON.parse(approvalRaw);
    } catch (err) {
      throw new ReleaseError(
        GATE_FAILED,
        `approval record is not valid JSON: ${err.message}`,
        { approvalPath },
      );
    }

    const approvalDigest = assertImmutableApprovalAuthority(approvalPath, plan, approvalRaw)
      ?? computeApprovalDigest(approvalRaw);

    validateApprovalRecordSchema(approval);
    validateApproval(plan, approval, { clock: clockFn });

    await evidence.append({ phase: 'safety-gate', gate: 'approval-validated', status: 'passed' });

    // =======================================================================
    // Safety Gate 8: Action type adapter availability
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'adapter-availability', status: 'started' });

    for (const action of plan.externalActions) {
      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
      if (!adapterActionType) {
        // write-remote-identifier and unknown types are handled at checkpoint time
        continue;
      }
      // Verify adapter exists for this action type
      try {
        adapterRegistry.getAdapter(adapterActionType);
      } catch {
        throw new ReleaseError(
          GATE_FAILED,
          `no adapter registered for action type "${adapterActionType}" (plan action "${action.id}")`,
          { actionId: action.id, adapterActionType },
        );
      }
    }

    await evidence.append({ phase: 'safety-gate', gate: 'adapter-availability', status: 'passed' });

    // =======================================================================
    // Safety Gate 9: Baseline comparison
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'baseline-check', status: 'started' });

    if (
      plan.production?.mode === 'github-npm-v1' &&
      plan.baseline?.workspaceDigestAlgorithm !== WORKSPACE_DIGEST_ALGORITHM
    ) {
      throw new ReleaseError(
        GATE_FAILED,
        `production plan workspace digest algorithm is missing or obsolete; re-run prepare (expected ${WORKSPACE_DIGEST_ALGORITHM})`,
        { expected: WORKSPACE_DIGEST_ALGORITHM, actual: plan.baseline?.workspaceDigestAlgorithm ?? null },
      );
    }

    const currentBaseline = await captureBaselineActual(root);

    // planVersion fork (design: t1-2-digest-decoupling.md §4.3): for v2
    // plans the baseline is record-layer audit data. Drift is recorded as a
    // warning and execution continues -- artifact integrity is sealed by the
    // frozen-artifact re-verification above, never by workspace equality.
    // v1 plans keep the BASELINE_CHANGED hard failure, byte for byte.
    const planV2 = plan.planVersion === 2;

    if (currentBaseline.gitTreeHash !== plan.baseline.gitTreeHash) {
      if (planV2) {
        await evidence.append({
          phase: 'safety-gate',
          gate: 'baseline-check',
          status: 'warning',
          severity: 'warning',
          reason: 'planVersion 2: baseline drift is record-layer audit data; frozen-artifact re-verification remains the integrity authority',
          planTreeHash: plan.baseline.gitTreeHash,
          currentTreeHash: currentBaseline.gitTreeHash,
        });
      } else {
        await evidence.append({
          phase: 'safety-gate',
          gate: 'baseline-check',
          status: 'failed',
          planTreeHash: plan.baseline.gitTreeHash,
          currentTreeHash: currentBaseline.gitTreeHash,
        });

        // BASELINE_CHANGED: zero adapter execute calls guaranteed
        throw new ReleaseError(
          BASELINE_CHANGED,
          `baseline has changed since plan freeze: plan=${plan.baseline.gitTreeHash}, current=${currentBaseline.gitTreeHash}`,
          { planTreeHash: plan.baseline.gitTreeHash, currentTreeHash: currentBaseline.gitTreeHash },
        );
      }
    }

    if (
      plan.baseline.workspaceDigest &&
      currentBaseline.workspaceDigest !== plan.baseline.workspaceDigest
    ) {
      if (planV2) {
        await evidence.append({
          phase: 'safety-gate',
          gate: 'baseline-check',
          status: 'warning',
          severity: 'warning',
          reason: 'planVersion 2: workspace digest drift is record-layer audit data; frozen-artifact re-verification remains the integrity authority',
          planWorkspaceDigest: plan.baseline.workspaceDigest,
          currentWorkspaceDigest: currentBaseline.workspaceDigest,
        });
      } else {
        await evidence.append({
          phase: 'safety-gate',
          gate: 'baseline-check',
          status: 'failed',
          planWorkspaceDigest: plan.baseline.workspaceDigest,
          currentWorkspaceDigest: currentBaseline.workspaceDigest,
        });

        throw new ReleaseError(
          BASELINE_CHANGED,
          `workspace digest has changed since plan freeze: plan=${plan.baseline.workspaceDigest}, current=${currentBaseline.workspaceDigest}`,
          { planWorkspaceDigest: plan.baseline.workspaceDigest, currentWorkspaceDigest: currentBaseline.workspaceDigest },
        );
      }
    }

    await evidence.append({
      phase: 'safety-gate',
      gate: 'baseline-check',
      status: 'passed',
      gitTreeHash: currentBaseline.gitTreeHash,
    });

    // =======================================================================
    // Safety Gate 9b: Per-unit previous public baseline re-observe
    // =======================================================================
    {
      const defaultPpbObserveFn = async (repo, ref, expectedCommit, { githubHost = 'github.com' } = {}) => {
        try {
          const { execFile: eCb } = await import("node:child_process");
          const { promisify: p } = await import("node:util");
          const ef = p(eCb);
          const host = githubHost || 'github.com';
          const { stdout } = await ef("git", ["ls-remote", `https://${host}/${repo}.git`, ref], {
            shell: false, encoding: "utf8", timeout: 30000,
          });
          const lines = stdout.trim().split("\n").filter(l => l.length > 0);
          if (lines.length === 0) return { status: "drifted", actual: null, diff: "ref not found on remote" };
          const [remoteCommit] = lines[0].split("\t");
          if (remoteCommit === expectedCommit) return { status: "consistent", actual: remoteCommit };
          return { status: "drifted", actual: remoteCommit, diff: "expected " + expectedCommit + ", got " + remoteCommit };
        } catch (err) {
          return { status: "unknown", error: err.message };
        }
      };
      const ppbObserveFn = observePreviousPublicBaselineFn ?? defaultPpbObserveFn;

      for (const unit of plan.units ?? []) {
        const unitPpb = unit.previousPublicBaseline;
        if (!unitPpb) {
          // Missing baseline on a unit: fail closed in production
          if (isProductionPlan) {
            await evidence.append({
              phase: "safety-gate",
              gate: "previous-public-baseline",
              unitId: unit.id,
              status: "failed",
              error: "missing previousPublicBaseline on unit",
            });
            throw new ReleaseError(
              GATE_FAILED,
              `unit "${unit.id}" missing previousPublicBaseline in plan; cannot proceed`,
              { gate: "previous-public-baseline", unitId: unit.id },
            );
          }
          continue;
        }

        const githubHost = unit.productionConfig?.githubHost ?? 'github.com';
        assertPreviousPublicBaselineTarget({
          baseline: unitPpb,
          githubHost,
          publicRepo: unit.publicRepo,
          requireHost: isProductionPlan,
        });

        if (unitPpb.mode === "none") {
          await evidence.append({
            phase: "safety-gate",
            gate: "previous-public-baseline",
            unitId: unit.id,
            status: "passed",
            reason: "fresh repository",
          });
          continue;
        }

        // Reject unobserved-offline or non-consistent status
        if (unitPpb.status !== "consistent") {
          await evidence.append({
            phase: "safety-gate",
            gate: "previous-public-baseline",
            unitId: unit.id,
            status: "failed",
            unitStatus: unitPpb.status,
            error: `unit "${unit.id}" previous public baseline status is "${unitPpb.status}", expected "consistent"`,
          });
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" previous public baseline not consistent (status: ${unitPpb.status}); all adapter execute blocked`,
            { gate: "previous-public-baseline", unitId: unit.id, unitStatus: unitPpb.status },
          );
        }

        // Re-observe bound unit
        await evidence.append({
          phase: "safety-gate",
          gate: "previous-public-baseline",
          unitId: unit.id,
          status: "started",
        });

        const reObserveResult = await reObservePreviousPublicBaseline({
          baseline: unitPpb,
          observeFn: ppbObserveFn,
          evidence,
        });

        if (!reObserveResult.consistent) {
          await evidence.append({
            phase: "safety-gate",
            gate: "previous-public-baseline",
            unitId: unit.id,
            status: "failed",
            error: reObserveResult.error,
          });
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}": ${reObserveResult.error ?? "previous public baseline changed since plan freeze"}`,
            { gate: "previous-public-baseline", unitId: unit.id },
          );
        }

        await evidence.append({
          phase: "safety-gate",
          gate: "previous-public-baseline",
          unitId: unit.id,
          status: "passed",
        });
      }
    }

    // =======================================================================
    // All safety gates passed -- prepare for execution
    // =======================================================================
    if (isProductionPlan && plan.status === 'PREPARED') {
      assertTransition('PREPARED', 'APPROVED');
      assertTransition('APPROVED', PUBLISHING);
    } else {
      assertTransition(plan.status, PUBLISHING);
    }

    // Deep-clone the plan for mutation
    const publishingPlan = deepClone(plan);
    publishingPlan.status = PUBLISHING;

    // Sort actions by checkpoint order (shared single source, T3.1 §4.7).
    const orderedActions = sortActionsByCheckpointOrder(publishingPlan.externalActions);

    // =======================================================================
    // Safety Gate 10: Global preflight - validate all actions before any execute
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'global-preflight', status: 'started' });

    for (const action of orderedActions) {
      if (action.type === 'write-remote-identifier') continue;

      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
      if (!adapterActionType) continue;

      const adapter = adapterRegistry.getAdapter(adapterActionType);
      const isMarketplace = MARKETPLACE_TYPES.has(action.type);
      const preflightContext = {
        externalWritesAuthorized: false,
        isolatedConsumerWritesAuthorized: isMarketplace,
        plan: publishingPlan,
        baseline: plan.baseline,
        root,
        runDir,
      };
      const preflightResult = await adapter.preflight(
        { actionType: adapterActionType, ...action.parameters },
        preflightContext,
      );
      if (preflightResult.status === 'PREFLIGHT_FAILED') {
        // T3.3 §4.6: an "occupied" preflight failure overlaps semantically with
        // "already consistent". For NON-marketplace action types, arbitrate with
        // a single read-only pre-observe using the SAME classifier as the
        // per-checkpoint path: CONSISTENT means the remote already satisfies the
        // frozen plan, so let the action through to its SKIPPED path instead of
        // failing the whole gate. Anything else (MISSING/CONFLICTING/UNOBSERVABLE)
        // keeps the fail-closed GATE_FAILED. Marketplace preflights are local
        // integrity checks, never remote occupation, so they are NEVER arbitrated
        // -- a CONSISTENT observation must not bypass their completeness gate.
        if (!isMarketplace && hasExpected(action.expected)) {
          let arbitration;
          try {
            arbitration = await adapter.observe(
              { actionType: adapterActionType, ...action.parameters, expected: action.expected },
              preflightContext,
            );
          } catch (error) {
            arbitration = { observation: null, error: error?.message ?? String(error) };
          }
          const verdict = classifyPreObservation(action, arbitration);
          await evidence.append({
            phase: 'global-preflight-arbitration',
            actionId: action.id,
            actionType: action.type,
            status: 'pre-observe',
            details: { preObserve: verdict, preflightError: preflightResult.error ?? null },
          });
          if (verdict === PRE_OBSERVE.CONSISTENT) {
            // Remote already consistent: the action takes the SKIPPED path inside
            // executeCheckpoint; do not fail the gate.
            continue;
          }
        }
        throw new ReleaseError(
          GATE_FAILED,
          `global preflight failed for action "${action.id}": ${preflightResult.error}`,
          { actionId: action.id, actionType: action.type },
        );
      }
    }

    await evidence.append({ phase: 'safety-gate', gate: 'global-preflight', status: 'passed' });

    // =======================================================================
    // Persist an append-only initial state before the first adapter execute.
    // =======================================================================
    const runPath = join(runDir, 'release-run.json');
    const checkpoints = orderedActions.map((action) => ({
      actionId: action.id,
      actionType: action.type,
      status: 'PENDING',
      error: null,
    }));

    const startedAt = clockFn();
    const buildPersistedState = (status = PUBLISHING, finishedAt) => ({
      runId,
      command: 'publish',
      planDigest: plan.digest,
      planPath,
      approvalDigest,
      approvalPath,
      status,
      checkpoints: checkpoints.map((checkpoint) => ({
        actionId: checkpoint.actionId,
        actionType: checkpoint.actionType,
        status: checkpoint.status === 'SUCCEEDED' ? 'succeeded'
          : checkpoint.status === 'FAILED' ? 'failed'
          : checkpoint.status === 'UNCERTAIN' ? 'uncertain'
          : checkpoint.status === 'SKIPPED' ? 'skipped'
          : 'pending',
        ...(checkpoint.preObserve ? { preObserve: checkpoint.preObserve } : {}),
        ...(checkpoint.postObserve ? { postObserve: checkpoint.postObserve } : {}),
        ...(checkpoint.error ? { error: { code: 'GATE_FAILED', message: checkpoint.error } } : {}),
      })),
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
    });
    let stateSequence = 0;
    let latestState = await appendRunState(runDir, stateSequence, buildPersistedState());

    await evidence.append({
      phase: 'publish',
      status: 'started',
      checkpointCount: orderedActions.length,
      prePersistedRunPath: latestState.statePath,
    });

    // =======================================================================
    // Execute checkpoints (dependency-tiered; T3.1).
    //
    // Tiers run strictly serially; the actions inside a tier are independent
    // and run concurrently with Promise.allSettled semantics -- no fail-fast
    // short-circuit, because a sibling's success and observation must never be
    // dropped (observations are reconcile's recovery authority). State is
    // snapshotted once per tier boundary instead of once per checkpoint:
    //   * tier start: every action in the tier is set UNCERTAIN and one
    //     appendRunState persists that durable pre-execute authority;
    //   * tier end: all of the tier's results are folded in and one
    //     appendRunState persists them.
    // Crash-recovery semantics: a kill inside a tier leaves that tier's actions
    // at UNCERTAIN in the last snapshot; reconcile rebuilds actual state per
    // actionId from that snapshot plus observe (it never depended on execution
    // order). appendRunState's seq chain (run.mjs) is unchanged.
    // =======================================================================
    const checkpointByActionId = new Map(checkpoints.map((cp) => [cp.actionId, cp]));
    const { tiers, unknown } = groupActionsByTier(orderedActions);
    let stopped = false;

    // Fail closed on any action type the tier table does not recognize. Such a
    // type is never silently appended to the last tier: an unrecognized external
    // write must stop the saga for human review. (Validated plans cannot contain
    // such a type -- the plan schema enumerates exactly the tier-table types --
    // so this is defense in depth, not a reachable path.)
    if (unknown.length > 0) {
      for (const action of unknown) {
        const checkpoint = checkpointByActionId.get(action.id);
        checkpoint.status = 'FAILED';
        checkpoint.error = `Unknown action type not present in the dependency tier table: ${action.type}`;
        action.status = 'FAILED';
        await evidence.append({
          phase: 'checkpoint',
          actionId: action.id,
          actionType: action.type,
          status: 'failed',
          error: checkpoint.error,
        });
      }
      stopped = true;
      stateSequence += 1;
      latestState = await appendRunState(runDir, stateSequence, buildPersistedState(PARTIAL));
    }

    for (let tierIndex = 0; tierIndex < tiers.length && !stopped; tierIndex += 1) {
      const tierActions = tiers[tierIndex];
      if (tierActions.length === 0) continue;
      const tierCheckpoints = tierActions.map((action) => checkpointByActionId.get(action.id));

      // --- Tier start: persist every action in this tier as UNCERTAIN in a
      // single snapshot BEFORE any execute is authorized. Once an execute is
      // about to start, this snapshot is itself a reconcile-consumable recovery
      // authority; a process kill after an adapter accepts a write must never
      // leave only PUBLISHING state.
      for (let i = 0; i < tierActions.length; i += 1) {
        tierCheckpoints[i].status = 'UNCERTAIN';
        await evidence.append({
          phase: 'checkpoint',
          actionId: tierActions[i].id,
          actionType: tierActions[i].type,
          status: 'started',
          details: { tier: tierIndex },
        });
      }
      stateSequence += 1;
      latestState = await appendRunState(runDir, stateSequence, buildPersistedState(PARTIAL));

      // --- Tier execute: concurrent, allSettled semantics (no fail-fast).
      const results = await Promise.all(tierActions.map(async (action) => {
        const isMarketplace = MARKETPLACE_TYPES.has(action.type);
        const actionContext = {
          externalWritesAuthorized: !isMarketplace,
          isolatedConsumerWritesAuthorized: isMarketplace,
          plan: publishingPlan,
          baseline: plan.baseline,
          root,
          runDir,
          evidence,
          observeRetrySleep,
        };
        try {
          return await executeCheckpoint(action, adapterRegistry, actionContext);
        } catch (error) {
          // executeCheckpoint classifies failures rather than throwing; a throw
          // is still an uncertain outcome and must never drop the action from
          // the tier snapshot.
          return { actionId: action.id, status: 'UNCERTAIN', error: `checkpoint threw: ${error.message}` };
        }
      }));

      // --- Tier settle: fold every result into the snapshot, successes and
      // failures alike (a failed sibling must not discard a success).
      let tierFailed = false;
      for (let i = 0; i < tierActions.length; i += 1) {
        const action = tierActions[i];
        const checkpoint = tierCheckpoints[i];
        const result = results[i];
        checkpoint.status = result.status;
        checkpoint.error = result.error;
        if (result.preObserve) checkpoint.preObserve = result.preObserve;
        if (result.postObserve) checkpoint.postObserve = result.postObserve;
        action.status = result.status;
        await evidence.append({
          phase: 'checkpoint',
          actionId: action.id,
          actionType: action.type,
          status: result.status === 'SUCCEEDED' || result.status === 'SKIPPED' ? 'completed' : 'failed',
          error: result.error,
          details: { tier: tierIndex, ...(result.status === 'SKIPPED' ? { skipped: true } : {}) },
        });
        // SKIPPED is a success (the remote was already consistent); it must not
        // stop the saga. Only FAILED/UNCERTAIN fail the tier.
        if (result.status !== 'SUCCEEDED' && result.status !== 'SKIPPED') {
          tierFailed = true;
        }
      }

      // --- Tier end: one snapshot carrying the whole tier's results.
      stateSequence += 1;
      latestState = await appendRunState(runDir, stateSequence, buildPersistedState(PARTIAL));

      if (tierFailed) {
        stopped = true;
      }
    }

    // Close the push -> default-branch TOCTOU window with a final read-only
    // consistency pass. Both the branch tip and default-branch name are bound
    // in the frozen action expectations. A late change keeps the saga PARTIAL
    // and must be resolved by reconcile/human review.
    if (checkpoints.every((cp) => cp.status === 'SUCCEEDED' || cp.status === 'SKIPPED')) {
      await evidence.append({ phase: 'safety-gate', gate: 'final-branch-consistency', status: 'started' });
      for (let index = 0; index < orderedActions.length; index += 1) {
        const action = orderedActions[index];
        if (!['push-snapshot', 'set-default-branch'].includes(action.type)) continue;
        const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
        const adapter = adapterRegistry.getAdapter(adapterActionType);
        let observed;
        try {
          observed = await adapter.observe(
            { actionType: adapterActionType, ...action.parameters, expected: action.expected },
            { externalWritesAuthorized: false, plan: publishingPlan, baseline: plan.baseline, root, runDir },
          );
        } catch (error) {
          observed = { observation: null, error: error.message };
        }
        const observation = observed?.observation;
        const observable = observation && !(observed.error && Object.keys(observation).length === 0);
        const comparison = observable ? matchObservation(action.expected ?? {}, observation) : { matches: false, mismatches: [] };
        if (!comparison.matches) {
          checkpoints[index].status = observable ? 'FAILED' : 'UNCERTAIN';
          checkpoints[index].error = observable
            ? `final branch consistency mismatch: ${comparison.mismatches.join('; ')}`
            : `final branch consistency unobservable: ${observed?.error ?? 'empty observation'}`;
          await evidence.append({
            phase: 'safety-gate',
            gate: 'final-branch-consistency',
            status: 'failed',
            actionId: action.id,
            error: checkpoints[index].error,
          });
          break;
        }
      }
      if (checkpoints.every((cp) => cp.status === 'SUCCEEDED' || cp.status === 'SKIPPED')) {
        await evidence.append({ phase: 'safety-gate', gate: 'final-branch-consistency', status: 'passed' });
      }
    }

    // Determine overall status
    const hasFailure = checkpoints.some((cp) => cp.status === 'FAILED' || cp.status === 'UNCERTAIN');
    // SKIPPED counts as success: the remote was already consistent with the
    // frozen plan, so an all-SKIPPED/SUCCEEDED run is a clean PUBLISHED (the
    // idempotent ideal -- zero writes were even needed).
    const allSucceeded = checkpoints.every((cp) => cp.status === 'SUCCEEDED' || cp.status === 'SKIPPED');

    let overallStatus;
    if (allSucceeded) {
      overallStatus = PUBLISHED;
      publishingPlan.status = PUBLISHED;
    } else if (hasFailure) {
      // Once any execute was attempted, recovery must go through reconcile,
      // even when no success was observed. Re-running publish could duplicate
      // a write accepted just before a transport failure.
      overallStatus = PARTIAL;
      publishingPlan.status = overallStatus;
    } else {
      overallStatus = PUBLISHING;
      publishingPlan.status = PUBLISHING;
    }

    // Assert valid state transition
    assertTransition(PUBLISHING, publishingPlan.status);

    await evidence.append({
      phase: 'publish',
      status: 'completed',
      overallStatus,
      checkpointStatuses: checkpoints.map((cp) => cp.status),
    });

    // Write final run state (runPath already declared in pre-persist section)
    const finishedAt = clockFn();
    stateSequence += 1;
    latestState = await appendRunState(
      runDir,
      stateSequence,
      buildPersistedState(overallStatus, finishedAt),
    );
    const finalRunState = await writeRunAtomic(
      runPath,
      buildPersistedState(overallStatus, finishedAt),
    );

    await evidence.finish({
      status: overallStatus,
      planPath,
      runPath,
      finalRunDigest: finalRunState.runDigest,
      latestStatePath: latestState.statePath,
      checkpointStatuses: checkpoints.map((cp) => cp.status),
      finishedAt: clockFn(),
    });

    return { planPath, runPath, status: overallStatus, checkpoints };
  } catch (err) {
    await evidence.append({
      phase: 'publish',
      status: 'failed',
      error: { code: err.code, message: err.message },
    });

    await evidence.finish({
      status: 'FAILED',
      error: { code: err.code, message: err.message },
      failedAt: clockFn(),
    });

    throw err;
  }
}
