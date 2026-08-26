/**
 * Reconcile command: idempotent recovery from partial publish.
 *
 * Reads the source run (a publish or prior reconcile run) and the frozen
 * release plan. For each checkpoint in the source run:
 * - SUCCEEDED: re-observe to verify remote state is still consistent.
 * - FAILED/PENDING: observe remote state; if consistent skip, if missing
 *   add to retry list, if conflicting => REMOTE_CONFLICT.
 *
 * Retry actions are validated against the approval record, then preflighted
 * globally before any execute. Each retry execute is followed by observe.
 *
 * Invariants:
 * - SUCCEEDED actions are never re-executed (only re-observed)
 * - Remote state conflict => REMOTE_CONFLICT (never blindly overwrite)
 * - All retry preflight must pass before first retry execute
 * - Every retry execute is followed by observe
 * - PARTIAL => PUBLISHED when all external actions are consistent
 * - A separate verify run performs fresh npm/plugin consumer installs and is
 *   the only command that may promote PUBLISHED to VERIFIED
 * - New run includes sourceRunId; source run and plan are never modified
 *
 * @module commands/reconcile
 */

import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
import { asError, createEvidenceWriter } from '../core/evidence.mjs';
import { readRunRecovery } from '../core/recovery.mjs';
import { CHECKPOINT_ORDER, ADAPTER_ACTION_TYPE_MAP, isRemoteWriteAction, isMarketplaceAction } from '../core/checkpoints.mjs';
import {
  loadRun,
  validateRunPlanDigest,
  validateRunCheckpointMapping,
  writeRunAtomic,
  appendRunState,
  computeRunDigest,
  createProductionRunDir,
  validateRunLineage,
  resolveDefaultRunDir,
} from '../core/run.mjs';
import {
  ReleaseError,
  GATE_FAILED,
  BASELINE_CHANGED,
  REMOTE_CONFLICT,
  CONSUMER_VERIFICATION_DEFERRED,
} from '../core/errors.mjs';
import { assertTransition, PARTIAL, PUBLISHED, BLOCKED } from '../core/state-machine.mjs';
import { verifySourceAuthorityReceipt } from '../core/source-authority.mjs';
import { matchObservation } from '../adapters/contract.mjs';
import { observeWithRetry, clampPolicyToTimeout, DEFAULT_OBSERVE_RETRY_POLICY } from '../core/observe-retry.mjs';
import { verifyFrozenNpmTarballContract } from '../adapters/npm.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// CHECKPOINT_ORDER and ADAPTER_ACTION_TYPE_MAP live in ../core/checkpoints.mjs
// (single source shared with publish.mjs; T3.1 §4.7). The historical
// `Must match publish.mjs` double-write is removed.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultClock() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconcile a release from a source run.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.sourceRunPath - Absolute path to the source run (publish or prior reconcile).
 * @param {string} [options.approvalPath] - Path to the approval record (required if any action needs retry).
 * @param {Object} options.adapterRegistry - Adapter registry for action execution.
 * @param {string} [options.runDir] - Evidence directory. Defaults to `<planDir>/runs/reconcile-<ts>`.
 * @param {string} [options.root] - Project root for baseline capture.
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {(root: string) => Promise<Object>} [options.captureBaselineFn] - Injectable baseline capture.
 *
 * @returns {Promise<{ planPath: string, runPath: string, status: string, checkpoints: Object[] }>}
 *
 * @throws {ReleaseError} GATE_FAILED on safety gate failures.
 * @throws {ReleaseError} BASELINE_CHANGED if the baseline has changed since freeze.
 * @throws {ReleaseError} REMOTE_CONFLICT if remote state is inconsistent with the plan.
 */
export async function reconcileRelease(options) {
  const {
    planPath,
    sourceRunPath,
    approvalPath,
    adapterRegistry,
    runDir: runDirOpt,
    root = process.cwd(),
    clock: clockOpt,
    captureBaselineFn,
    observePreviousPublicBaselineFn,
    observeRetrySleep,
  } = options ?? {};

  const clockFn = typeof clockOpt === 'function' ? clockOpt : defaultClock;
  const captureBaselineActual =
    typeof captureBaselineFn === 'function' ? captureBaselineFn : captureBaseline;

  // --- Gate: sourceRunPath is required ---
  if (!sourceRunPath) {
    throw new ReleaseError(
      GATE_FAILED,
      'reconcile requires a source run path (--run)',
      { parameter: 'sourceRunPath' },
    );
  }

  // Load the plan before selecting a production evidence authority. An unsafe
  // runDir must fail before this command writes through it or retries a remote
  // action.
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
  const runId = `reconcile-${Date.now()}`;
  let runDir = runDirOpt ?? resolveDefaultRunDir(planPath, 'reconcile', runId);
  if (isProductionPlan) {
    runDir = await createProductionRunDir(runDir, planPath);
  } else {
    await mkdir(runDir, { recursive: true });
  }

  const evidence = createEvidenceWriter({ runDir, command: 'reconcile', clock: clockFn });
  let recoveryRunPath = sourceRunPath;

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

    // =======================================================================
    // Safety Gate 2b: Validate plan action completeness
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'action-completeness', status: 'started' });

    // Use legacyCompatibility: old PARTIAL plans (pre-v0.1.5) lack
    // parameters.timeoutMs. Reconcile must still pass these plans,
    // while strict mode (prepare/approve/publish) rejects them.
    const completenessResult = validatePlanActionCompleteness(plan, { legacyCompatibility: true });
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

    // =======================================================================
    // Safety Gate 2c: Unconditional frozen npm entry-closure recheck
    // This is plan-global and intentionally precedes source-run observation:
    // a previously consistent npm checkpoint must not exempt a bad frozen
    // tarball while another action is being reconciled.
    // =======================================================================
    for (const unit of plan.units ?? []) {
      const frozen = unit.frozenSnapshot;
      if (!frozen?.npm) continue;
      const npmDistribution = (unit.distributions ?? []).find((distribution) => distribution.type === 'npm');
      if (!npmDistribution) {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" has a frozen npm tarball but no npm distribution`,
          { gate: 'npm-entry-closure', unitId: unit.id },
        );
      }
      await evidence.append({
        phase: 'safety-gate',
        gate: 'npm-entry-closure',
        unitId: unit.id,
        status: 'started',
      });
      await verifyFrozenNpmTarballContract({
        package: npmDistribution.package,
        version: unit.targetVersion,
        tarballPath: frozen.npm.tarballPath,
        tarballSha256: frozen.npm.tarballSha256,
        integrity: frozen.npm.integrity,
      }, root);
      await evidence.append({
        phase: 'safety-gate',
        gate: 'npm-entry-closure',
        unitId: unit.id,
        status: 'passed',
      });
    }

    // =======================================================================
    // Safety Gate 3: Load and validate source run
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'source-run-load', status: 'started' });

    const sourceRun = await loadRun(sourceRunPath, {
      requireDigest: Boolean(plan.production),
      ...(plan.production ? { authorityPlanPath: planPath } : {}),
    });
    await validateRunLineage(sourceRun, {
      plan,
      planPath,
      runPath: sourceRunPath,
      production: Boolean(plan.production),
    });
    const sourceAuthorityDigest = sourceRun.runDigest ?? computeRunDigest(sourceRun);
    validateRunCheckpointMapping(sourceRun, plan.externalActions ?? []);

    if (!['publish', 'reconcile'].includes(sourceRun.command)) {
      throw new ReleaseError(
        GATE_FAILED,
        `reconcile source command must be publish or reconcile, got "${sourceRun.command}"`,
      );
    }
    let sourceAuthorityReceipt = null;
    if (plan.sourceAuthority) {
      const receiptResult = verifySourceAuthorityReceipt({ plan, run: sourceRun });
      if (!receiptResult.passed) {
        throw new ReleaseError(
          GATE_FAILED,
          `reconcile source run has no valid source-authority receipt: ${receiptResult.reason}`,
          { gate: 'source-authority', sourceRunId: sourceRun.runId },
        );
      }
      sourceAuthorityReceipt = receiptResult.receipt;
    }

    let consumedApprovalPath = sourceRun.approvalPath;
    let consumedApprovalDigest = sourceRun.approvalDigest;
    if (plan.production) {
      if (!consumedApprovalPath || !consumedApprovalDigest) {
        throw new ReleaseError(
          GATE_FAILED,
          'production source run is missing immutable approvalPath/approvalDigest authority',
          { sourceRunId: sourceRun.runId },
        );
      }
      const sourceApprovalRaw = await readFile(consumedApprovalPath, 'utf8').catch((error) => {
        throw new ReleaseError(GATE_FAILED, 'source run approval authority is unavailable', {
          sourceRunId: sourceRun.runId,
          cause: error.code,
        });
      });
      const observedApprovalDigest = assertImmutableApprovalAuthority(
        consumedApprovalPath,
        plan,
        sourceApprovalRaw,
      );
      if (observedApprovalDigest !== consumedApprovalDigest) {
        throw new ReleaseError(
          GATE_FAILED,
          'source run approvalDigest does not match immutable approval bytes',
        );
      }
      let sourceApproval;
      try {
        sourceApproval = JSON.parse(sourceApprovalRaw);
      } catch (error) {
        throw new ReleaseError(GATE_FAILED, `source run approval is not valid JSON: ${error.message}`);
      }
      validateApprovalRecordSchema(sourceApproval);
      validateApproval(plan, sourceApproval, { clock: clockFn, requireUnexpired: false });
    }

    if (sourceRun.status !== PARTIAL) {
      throw new ReleaseError(
        GATE_FAILED,
        `reconcile only accepts PARTIAL runs; source status is "${sourceRun.status}". ` +
        'For BLOCKED with no durable writes, fix the gate and rerun publish; VERIFIED is terminal.',
        { sourceRunId: sourceRun.runId, sourceRunStatus: sourceRun.status },
      );
    }

    await evidence.append({
      phase: 'safety-gate',
      gate: 'source-run-load',
      status: 'passed',
      sourceRunId: sourceRun.runId,
    });

    // =======================================================================
    // Safety Gate 4: Baseline comparison
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
    // frozen-artifact re-verification, never by workspace equality. v1 plans
    // keep the BASELINE_CHANGED hard failure, byte for byte.
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

    // Re-observe every unit's frozen public baseline before any adapter
    // observation, preflight, or execute call.
    const defaultPpbObserveFn = async (repo, ref, expectedCommit, { githubHost = 'github.com' } = {}) => {
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const { stdout } = await promisify(execFile)(
          'git',
          ['ls-remote', `https://${githubHost}/${repo}.git`, ref],
          { shell: false, encoding: 'utf8', timeout: 30000 },
        );
        const [line] = stdout.trim().split('\n').filter(Boolean);
        if (!line) return { status: 'drifted', actual: null, diff: 'ref not found on remote' };
        const [actual] = line.split('\t');
        return actual === expectedCommit
          ? { status: 'consistent', actual }
          : { status: 'drifted', actual, diff: `expected ${expectedCommit}, got ${actual}` };
      } catch (error) {
        return { status: 'unknown', error: error.message };
      }
    };
    const ppbObserveFn = observePreviousPublicBaselineFn ?? defaultPpbObserveFn;

    for (const unit of plan.units ?? []) {
      const baseline = unit.previousPublicBaseline;
      if (!baseline) {
        if (isProductionPlan) {
          throw new ReleaseError(
            GATE_FAILED,
            `unit "${unit.id}" missing previousPublicBaseline in production plan`,
            { gate: 'previous-public-baseline', unitId: unit.id },
          );
        }
        continue;
      }
      const githubHost = unit.productionConfig?.githubHost ?? 'github.com';
      assertPreviousPublicBaselineTarget({
        baseline,
        githubHost,
        publicRepo: unit.publicRepo,
        requireHost: isProductionPlan,
      });
      if (baseline.mode === 'bound' && baseline.status !== 'consistent') {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}" previous public baseline is not frozen as consistent`,
          { gate: 'previous-public-baseline', unitId: unit.id, status: baseline.status },
        );
      }
      const observed = await reObservePreviousPublicBaseline({
        baseline,
        observeFn: ppbObserveFn,
        evidence,
        acceptedSuccessorCommits: (plan.externalActions ?? [])
          .filter((action) => (
            action.unitId === unit.id &&
            action.type === 'push-snapshot' &&
            action.parameters?.branchStrategy === 'advance-existing-branch'
          ))
          .map((action) => action.parameters.commit),
      });
      if (!observed.consistent) {
        throw new ReleaseError(
          GATE_FAILED,
          `unit "${unit.id}": ${observed.error}`,
          { gate: 'previous-public-baseline', unitId: unit.id, ...observed.detail },
        );
      }
    }

    // =======================================================================
    // Load approval if provided (needed for retrying actions)
    // =======================================================================
    let approval = null;
    if (approvalPath) {
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

      try {
        approval = JSON.parse(approvalRaw);
      } catch (err) {
        throw new ReleaseError(
          GATE_FAILED,
          `approval record is not valid JSON: ${err.message}`,
          { approvalPath },
        );
      }
      validateApprovalRecordSchema(approval);
      consumedApprovalDigest = assertImmutableApprovalAuthority(approvalPath, plan, approvalRaw)
        ?? computeApprovalDigest(approvalRaw);
      consumedApprovalPath = approvalPath;
      // Any supplied approval that may replace the source lineage must be
      // fully bound to this plan, even when observation later proves that no
      // retry is necessary.
      validateApproval(plan, approval, { clock: clockFn });
    }

    // =======================================================================
    // Safety Gate 5: Adapter availability for all plan action types
    // =======================================================================
    await evidence.append({ phase: 'safety-gate', gate: 'adapter-availability', status: 'started' });

    for (const action of plan.externalActions ?? []) {
      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
      if (!adapterActionType) continue;
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
    // Map source run checkpoints to plan actions
    // =======================================================================
    const planActions = (plan.externalActions ?? []).slice().sort((a, b) => {
      const ai = CHECKPOINT_ORDER.indexOf(a.type);
      const bi = CHECKPOINT_ORDER.indexOf(b.type);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    // Build a map from actionId -> source run checkpoint
    const sourceCpMap = new Map();
    for (const cp of sourceRun.checkpoints) {
      sourceCpMap.set(cp.actionId, cp);
    }

    await evidence.append({
      phase: 'reconcile',
      status: 'started',
      actionCount: planActions.length,
      sourceRunId: sourceRun.runId,
      sourceRunDigest: sourceRun.runDigest,
    });

    const context = {
      externalWritesAuthorized: false,
      plan,
      baseline: plan.baseline,
      root,
      runDir,
    };

    // --- Phase 1: Process each plan action using source run checkpoint ---
    //
    // Marketplace actions are reconstructable isolated consumer checks, not
    // permanent remote writes. Their recovery is DEFERRED to phase 4 (after
    // the non-marketplace remote-write retry loop): github-release is the
    // prerequisite for kimi's install URL, and a marketplace failure must
    // never block pending remote-write retries.
    //
    // Non-marketplace actions use observe-based consistency checks.
    // =======================================================================
    const actionsToRetry = [];
    const actionResults = new Map(); // actionId -> final status
    let remoteWriteRetryFailed = false;

    for (const action of planActions) {
      const sourceCp = sourceCpMap.get(action.id);
      const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];

      if (!adapterActionType) {
        // Meta-checkpoint, skip
        actionResults.set(action.id, 'skipped');
        continue;
      }

      const adapter = adapterRegistry.getAdapter(adapterActionType);

      // -------------------------------------------------------------------
      // Marketplace actions are deferred to the verify phase. They are
      // recorded as 'deferred' with CONSUMER_VERIFICATION_DEFERRED reason
      // and never participate in reconcile's observe/retry loop.
      // A marketplace failure must never block pending remote-write retries.
      // -------------------------------------------------------------------
      if (isMarketplaceAction(action.type)) {
        actionResults.set(action.id, 'deferred');
        continue;
      }

      // An advancing push has two safe observable states during recovery:
      // the exact frozen predecessor (retry is still possible) or the exact
      // planned successor (the release already advanced it). Any third tip is
      // a real remote conflict. Generic create-only logic cannot distinguish
      // the predecessor from an unexpected pre-existing branch.
      if (
        action.type === 'push-snapshot' &&
        action.parameters?.branchStrategy === 'advance-existing-branch'
      ) {
        const observeResult = await adapter.observe(
          { actionType: adapterActionType, ...action.parameters },
          context,
        );
        const observation = observeResult?.observation;
        if (!observation || (observeResult.error && Object.keys(observation).length === 0)) {
          throw new ReleaseError(
            REMOTE_CONFLICT,
            `advancing action "${action.id}" remote state is unobservable`,
            { actionId: action.id, observeError: observeResult?.error },
          );
        }
        const actual = observation.commit ?? observation.remoteCommit ?? '';
        const predecessor = action.parameters.expectedBaselineCommit;
        const successor = action.parameters.commit;
        if (actual === successor) {
          actionResults.set(action.id, sourceCp.status === 'succeeded' ? 'succeeded' : 'skipped');
          await evidence.append({
            phase: 'reconcile-observe', status: 'observed',
            actionId: action.id,
            actionType: action.type,
            decision: 'advance-already-at-planned-successor',
            sourceStatus: sourceCp.status,
          });
          continue;
        }
        if (actual === predecessor && sourceCp.status !== 'succeeded') {
          actionsToRetry.push(action);
          await evidence.append({
            phase: 'reconcile-observe', status: 'observed',
            actionId: action.id,
            actionType: action.type,
            decision: 'retry-advance-from-frozen-predecessor',
            sourceStatus: sourceCp.status,
          });
          continue;
        }
        throw new ReleaseError(
          REMOTE_CONFLICT,
          `Remote branch conflict for advancing action "${action.id}": expected predecessor ${predecessor} or planned successor ${successor}, got ${actual || 'missing'}`,
          { actionId: action.id, predecessor, successor, actual, sourceStatus: sourceCp.status },
        );
      }

      // -------------------------------------------------------------------
      // Non-marketplace actions: observe-based consistency checks
      // -------------------------------------------------------------------

      if (sourceCp.status === 'succeeded') {
        // SUCCEEDED: re-observe to verify remote state is still consistent.
        // Item 20 invariant: if the source checkpoint already succeeded, any
        // observe failure (empty observation, auth error, network error, or
        // uncertain state) must fail closed and require human intervention.
        // We never add a SUCCEEDED action to actionsToRetry or re-execute it.
        const observeResult = await adapter.observe(
          { actionType: adapterActionType, ...action.parameters },
          context,
        );

        if (action.expected) {
          if (
            !observeResult.observation ||
            (observeResult.error && Object.keys(observeResult.observation).length === 0)
          ) {
            // SUCCEEDED action but observe failed: fail closed. The remote
            // state is uncertain — we cannot confirm consistency, so we
            // cannot proceed. Requires human intervention.
            await evidence.append({
              phase: 'reconcile-observe', status: 'observed',
              actionId: action.id,
              actionType: action.type,
              decision: 'succeeded-observe-failed-fail-closed',
              error: asError('OBSERVE_FAILED', observeResult.error),
            });

            throw new ReleaseError(
              REMOTE_CONFLICT,
              `SUCCEEDED action "${action.id}" observe returned empty/error: ${observeResult.error ?? 'empty observation'}. Remote state uncertain; manual verification required.`,
              { actionId: action.id, observeError: observeResult.error },
            );
          }

          const { matches, mismatches } = matchObservation(
            action.expected,
            observeResult.observation,
          );

          if (!matches) {
            await evidence.append({
              phase: 'reconcile-observe', status: 'observed',
              actionId: action.id,
              actionType: action.type,
              decision: 'remote-conflict',
              mismatches,
            });

            throw new ReleaseError(
              REMOTE_CONFLICT,
              `Remote state conflict for SUCCEEDED action "${action.id}": ${mismatches.join('; ')}`,
              { actionId: action.id, mismatches },
            );
          }
        }

        actionResults.set(action.id, 'succeeded');
        await evidence.append({
          phase: 'reconcile-observe', status: 'observed',
          actionId: action.id,
          actionType: action.type,
          decision: 'skip-succeeded-verified',
        });
        continue;
      }

      // FAILED or PENDING: observe remote state (PROPAGATING retry, T1.1)
      const observeInput = { actionType: adapterActionType, ...action.parameters };
      const observePolicy = isMarketplaceAction(action.type)
        ? clampPolicyToTimeout(DEFAULT_OBSERVE_RETRY_POLICY, action.parameters?.timeoutMs)
        : DEFAULT_OBSERVE_RETRY_POLICY;
      const observeRetry = await observeWithRetry({
        observe: (act, ctx) => adapter.observe(act, ctx),
        action: observeInput,
        context,
        policy: observePolicy,
        sleep: observeRetrySleep,
        onAttempt: (info) => evidence.append({
          phase: 'reconcile-observe-retry',
          actionId: action.id,
          actionType: action.type,
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          missing: info.missing,
          delayMs: info.delayMs,
          status: info.missing ? 'propagating' : 'resolved',
          error: asError('OBSERVE_FAILED', info.error ?? null),
        }),
      });
      const observeResult = observeRetry.result;

      if (
        !observeResult.observation ||
        (observeResult.error && Object.keys(observeResult.observation).length === 0)
      ) {
        await evidence.append({
          phase: 'reconcile-observe', status: 'observed',
          actionId: action.id,
          actionType: action.type,
          decision: 'uncertain-observation-fail-closed',
          error: asError('OBSERVE_FAILED', observeResult.error ?? null),
        });
        throw new ReleaseError(
          REMOTE_CONFLICT,
          `action "${action.id}" cannot be retried because remote state is unobservable`,
          { actionId: action.id, observeError: observeResult.error },
        );
      }

      if (action.type === 'set-default-branch') {
        const current = observeResult.observation.defaultBranch;
        const observedNewBranchCommit = observeResult.observation.newBranchCommit;
        if (observedNewBranchCommit !== action.parameters.expectedNewBranchCommit) {
          await evidence.append({
            phase: 'reconcile-observe', status: 'observed',
            actionId: action.id,
            actionType: action.type,
            decision: 'remote-conflict',
            expectedNewBranchCommit: action.parameters.expectedNewBranchCommit,
            observedNewBranchCommit: observedNewBranchCommit ?? null,
          });
          throw new ReleaseError(
            REMOTE_CONFLICT,
            `Remote target branch commit conflict for action "${action.id}": expected ` +
              `"${action.parameters.expectedNewBranchCommit}", got "${observedNewBranchCommit ?? 'missing'}"`,
            {
              actionId: action.id,
              expectedNewBranchCommit: action.parameters.expectedNewBranchCommit,
              observedNewBranchCommit: observedNewBranchCommit ?? null,
            },
          );
        }
        if (current === action.parameters.newBranch) {
          actionResults.set(action.id, 'skipped');
          await evidence.append({
            phase: 'reconcile-observe', status: 'observed',
            actionId: action.id,
            actionType: action.type,
            decision: 'skip-remote-consistent',
          });
          continue;
        }
        if (current === action.parameters.oldBranch) {
          actionsToRetry.push(action);
          await evidence.append({
            phase: 'reconcile-observe', status: 'observed',
            actionId: action.id,
            actionType: action.type,
            decision: 'retry-default-branch-still-old',
          });
          continue;
        }
        throw new ReleaseError(
          REMOTE_CONFLICT,
          `Remote default branch conflict for action "${action.id}": expected old ` +
            `"${action.parameters.oldBranch}" or new "${action.parameters.newBranch}", got "${current}"`,
          { actionId: action.id, observedDefaultBranch: current },
        );
      }

      const explicitlyMissing = observeResult.observation.exists === false
        || observeResult.observation.remoteCommit === ''
        || observeResult.observation.commit === ''
        || observeResult.observation.published === false;
      if (explicitlyMissing) {
        actionsToRetry.push(action);
        await evidence.append({
          phase: 'reconcile-observe', status: 'observed',
          actionId: action.id,
          actionType: action.type,
          decision: 'retry-explicitly-missing',
        });
        continue;
      }

      // Check if remote already has the expected state
      if (observeResult.observation && action.expected) {
        const { matches, mismatches } = matchObservation(
          action.expected,
          observeResult.observation,
        );

        if (matches) {
          actionResults.set(action.id, 'skipped');
          await evidence.append({
            phase: 'reconcile-observe', status: 'observed',
            actionId: action.id,
            actionType: action.type,
            decision: 'skip-remote-consistent',
          });
          continue;
        }

        // Remote state exists but doesn't match: REMOTE_CONFLICT
        await evidence.append({
          phase: 'reconcile-observe', status: 'observed',
          actionId: action.id,
          actionType: action.type,
          decision: 'remote-conflict',
          mismatches,
        });

        throw new ReleaseError(
          REMOTE_CONFLICT,
          `Remote state conflict for action "${action.id}": ${mismatches.join('; ')}`,
          { actionId: action.id, mismatches },
        );
      }

      // No expected observation or no remote state: needs retry
      actionsToRetry.push(action);
      await evidence.append({
        phase: 'reconcile-observe', status: 'observed',
        actionId: action.id,
        actionType: action.type,
        decision: 'retry',
      });
    }

    // --- Phase 2: Validate approval and global preflight before retrying ---
    //
    // Marketplace recovery is deferred to phase 4 and does NOT require
    // approval; marketplace actions are isolated
    // consumer checks, not permanent remote writes. Only non-marketplace
    // retries require approval.
    // =======================================================================
    // Phase 1 only collects non-marketplace retry candidates.
    const nonMarketplaceRetries = actionsToRetry.filter((a) => !isMarketplaceAction(a.type));

    if (nonMarketplaceRetries.length > 0) {
      // Non-marketplace retries require a current immutable approval. The
      // approval already binds the exact plan digest and action set.
      if (!approval) {
        throw new ReleaseError(
          GATE_FAILED,
          'approval record is required when actions need retry but none was provided',
          { actionsToRetry: nonMarketplaceRetries.map((a) => a.id) },
        );
      }

      context.externalWritesAuthorized = true;

      await evidence.append({
        phase: 'reconcile-approval',
        status: 'validated',
        retryActionCount: nonMarketplaceRetries.length,
      });
    }

    if (actionsToRetry.length > 0) {
      // Global preflight: validate ALL retry actions before any execute
      await evidence.append({ phase: 'reconcile-preflight', status: 'started' });

      for (const action of actionsToRetry) {
        const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
        const adapter = adapterRegistry.getAdapter(adapterActionType);

        const preflightResult = await adapter.preflight(
          { actionType: adapterActionType, ...action.parameters },
          context,
        );

        if (preflightResult.status === 'PREFLIGHT_FAILED') {
          // Mark all retry actions as failed, stop.
          for (const retryAction of actionsToRetry) {
            actionResults.set(retryAction.id, 'failed');
          }
          remoteWriteRetryFailed = true;

          await evidence.append({
            phase: 'reconcile-preflight',
            status: 'failed',
            actionId: action.id,
            error: asError('PREFLIGHT_FAILED', preflightResult.error),
          });
          break;
        }
      }

      if (!remoteWriteRetryFailed) {
        await evidence.append({ phase: 'reconcile-preflight', status: 'passed' });
      }
    }

    // Build an append-only reconcile journal before the first retry execute.
    // It carries the complete source lineage and becomes PARTIAL as soon as an
    // action is marked uncertain, so a process kill is directly recoverable.
    const reconcileStartedAt = clockFn();
    let retryStateSequence = -1;
    let latestRetryState = null;
    const buildReconcileState = (status = PARTIAL, finishedAt) => ({
      runId,
      command: 'reconcile',
      planDigest: plan.digest,
      planPath,
      ...(consumedApprovalPath ? {
        approvalPath: consumedApprovalPath,
        approvalDigest: consumedApprovalDigest,
      } : {}),
      sourceRunId: sourceRun.runId,
      sourceRunDigest: sourceAuthorityDigest,
      sourceRunPath,
      status,
      ...(sourceAuthorityReceipt
        ? { sourceAuthorityReceipts: [sourceAuthorityReceipt] }
        : {}),
      checkpoints: planActions.map((action) => {
        const value = actionResults.get(action.id);
        const normalized = value === 'deferred' ? 'deferred'
          : value === 'succeeded' ? 'succeeded'
          : value === 'skipped' ? 'skipped'
          : value === 'failed' ? 'failed'
          : value === 'uncertain' ? 'uncertain'
          : 'pending';
        return {
          actionId: action.id,
          actionType: action.type,
          status: normalized,
          ...(normalized === 'deferred' ? { reason: CONSUMER_VERIFICATION_DEFERRED, phase: 'post-publish-verification' } : {}),
        };
      }),
      startedAt: reconcileStartedAt,
      ...(finishedAt ? { finishedAt } : {}),
    });
    const persistRetryState = async (status = PARTIAL, finishedAt) => {
      retryStateSequence += 1;
      latestRetryState = await appendRunState(
        runDir,
        retryStateSequence,
        buildReconcileState(status, finishedAt),
      );
      recoveryRunPath = latestRetryState.statePath;
      return latestRetryState;
    };
    if (!remoteWriteRetryFailed && actionsToRetry.length > 0) {
      await persistRetryState('PUBLISHING');
    }

    // Execute one homogeneous retry group in plan order. The first failure
    // stops the group (publish semantics) and marks only that group's own
    // failure flag; a failure in one group never blocks the other group's
    // retries.
    const executeRetryGroup = async (groupActions, markGroupFailed) => {
      for (const action of groupActions) {
        const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
        const adapter = adapterRegistry.getAdapter(adapterActionType);

        // Only non-marketplace actions enter executeRetryGroup; marketplace
        // actions are deferred in Phase 1 and never reach this path.
        const retryCtx = context;

        await evidence.append({
          phase: 'reconcile-retry',
          actionId: action.id,
          actionType: action.type,
          status: 'started',
        });

        // Persist UNCERTAIN before authorizing execute. This snapshot is a
        // complete PARTIAL authority and can be fed back to reconcile after a
        // process kill.
        actionResults.set(action.id, 'uncertain');
        await persistRetryState(PARTIAL);

        let executeResult;
        try {
          executeResult = await adapter.execute(
            { actionType: adapterActionType, ...action.parameters },
            retryCtx,
          );
        } catch (error) {
          executeResult = { status: 'EXECUTE_FAILED', error: error.message };
        }

        if (executeResult.status === 'EXECUTED') {
          // Non-marketplace only: observe after execute to verify remote state.
          // execute succeeded, so a missing/uncertain observe may be a
          // transient propagation delay — retry with bounded backoff
          // (PROPAGATING, T1.1). A present mismatch is a real
          // conflict and is never retried.
          {
            const observeInput = {
              actionType: adapterActionType,
              ...action.parameters,
              expected: action.expected,
            };
            const observePolicy = clampPolicyToTimeout(
              DEFAULT_OBSERVE_RETRY_POLICY,
              action.parameters?.timeoutMs,
            );
            const observeRetry = await observeWithRetry({
              observe: (act, ctx) => adapter.observe(act, ctx),
              action: observeInput,
              context: retryCtx,
              policy: observePolicy,
              sleep: observeRetrySleep,
              onAttempt: (info) => evidence.append({
                phase: 'reconcile-retry-observe',
                actionId: action.id,
                actionType: action.type,
                attempt: info.attempt,
                maxAttempts: info.maxAttempts,
                missing: info.missing,
                delayMs: info.delayMs,
                status: info.missing ? 'propagating' : 'resolved',
                error: asError('OBSERVE_FAILED', info.error ?? null),
              }),
            });
            const observation = observeRetry.result?.observation ?? null;
            const observeError = observeRetry.result?.error ?? null;
            if (!observation || (observeError && Object.keys(observation).length === 0)) {
              actionResults.set(action.id, 'uncertain');
              markGroupFailed();
              await evidence.append({
                phase: 'reconcile-retry',
                actionId: action.id,
                actionType: action.type,
                status: 'observe-failed',
                error: asError('OBSERVE_FAILED', observeError ?? 'empty observation after retry execute'),
              });
              await persistRetryState(PARTIAL);
              break;
            }

            // Check observation mismatch
            if (action.expected) {
              const { matches } = matchObservation(action.expected, observation);
              if (!matches) {
                actionResults.set(action.id, 'failed');
                markGroupFailed();
                await evidence.append({
                  phase: 'reconcile-retry',
                  actionId: action.id,
                  actionType: action.type,
                  status: 'observe-mismatch',
                  error: asError('OBSERVE_MISMATCH', 'observation does not match expected after retry execute'),
                });
                await persistRetryState(PARTIAL);
                break;
              }
            } else if (observation && observation.mismatched) {
              actionResults.set(action.id, 'failed');
              markGroupFailed();
                await evidence.append({
                phase: 'reconcile-retry',
                actionId: action.id,
                actionType: action.type,
                status: 'observe-mismatch',
                  error: asError('OBSERVE_MISMATCH', 'observation indicates mismatch after retry execute'),
                });
                await persistRetryState(PARTIAL);
                break;
              }
          }

          actionResults.set(action.id, 'succeeded');
          await evidence.append({
            phase: 'reconcile-retry',
            actionId: action.id,
            actionType: action.type,
            status: 'completed',
          });
          await persistRetryState(PARTIAL);
        } else {
          // A transport failure may occur after the remote accepted the
          // write. Non-marketplace actions must therefore be observed before
          // classifying the checkpoint; unknown remains uncertain and an
          // already-consistent remote is treated as succeeded.
          let observeResult;
          try {
            observeResult = await adapter.observe(
              { actionType: adapterActionType, ...action.parameters, expected: action.expected },
              retryCtx,
            );
          } catch (error) {
            observeResult = { observation: null, error: error.message };
          }
          const observation = observeResult?.observation;
          const missing = observation?.exists === false
            || observation?.remoteCommit === ''
            || observation?.commit === ''
            || observation?.published === false;
          const matches = action.expected && observation
            ? matchObservation(action.expected, observation).matches
            : false;
          if (matches) {
            actionResults.set(action.id, 'succeeded');
            await evidence.append({
              phase: 'reconcile-retry',
              actionId: action.id,
              actionType: action.type,
              status: 'completed-after-execute-failure-observe',
            });
            await persistRetryState(PARTIAL);
            continue;
          }
          actionResults.set(action.id, missing ? 'failed' : 'uncertain');
          markGroupFailed();

          await evidence.append({
            phase: 'reconcile-retry',
            actionId: action.id,
            actionType: action.type,
            status: actionResults.get(action.id),
            error: asError('EXECUTE_FAILED', executeResult.error),
          });
          await persistRetryState(PARTIAL);
          break;
        }
      }
    };

    // --- Phase 3: Execute non-marketplace remote-write retries ---
    //
    // Runs BEFORE marketplace recovery: github-release is the prerequisite
    // for kimi's install URL. Gated ONLY on the remote-write group's own
    // failure flag — a failing marketplace recovery must never block these
    // retries.
    if (!remoteWriteRetryFailed && actionsToRetry.length > 0) {
      await executeRetryGroup(actionsToRetry, () => { remoteWriteRetryFailed = true; });
    }

    // Mark remaining retry actions as pending if a group stopped early
    const markPendingAfterFailure = (groupActions) => {
      let foundFailed = false;
      for (const action of groupActions) {
        if (['failed', 'uncertain'].includes(actionResults.get(action.id))) {
          foundFailed = true;
          continue;
        }
        if (foundFailed) {
          actionResults.set(action.id, 'pending');
        }
      }
    };
    if (remoteWriteRetryFailed) {
      markPendingAfterFailure(actionsToRetry);
    }

    // Final branch/default-branch consistency closes late drift after a retry
    // or after the first observation pass. The set-default action expectation
    // includes both the branch name and its exact planned commit.
    if (!remoteWriteRetryFailed && planActions.filter((a) => isRemoteWriteAction(a.type)).every((action) => ['succeeded', 'skipped'].includes(actionResults.get(action.id)))) {
      await evidence.append({ phase: 'safety-gate', gate: 'final-branch-consistency', status: 'started' });
      for (const action of planActions) {
        if (!['push-snapshot', 'set-default-branch'].includes(action.type)) continue;
        const adapterActionType = ADAPTER_ACTION_TYPE_MAP[action.type];
        const adapter = adapterRegistry.getAdapter(adapterActionType);
        let observed;
        try {
          observed = await adapter.observe(
            { actionType: adapterActionType, ...action.parameters, expected: action.expected },
            context,
          );
        } catch (error) {
          observed = { observation: null, error: error.message };
        }
        const observation = observed?.observation;
        const observable = observation && !(observed.error && Object.keys(observation).length === 0);
        const comparison = observable ? matchObservation(action.expected ?? {}, observation) : { matches: false, mismatches: [] };
        if (!comparison.matches) {
          actionResults.set(action.id, observable ? 'failed' : 'uncertain');
          remoteWriteRetryFailed = true;
          await evidence.append({
            phase: 'safety-gate',
            gate: 'final-branch-consistency',
            status: 'failed',
            actionId: action.id,
            error: asError('OBSERVE_MISMATCH', observable ? comparison.mismatches.join('; ') : observed?.error ?? 'empty observation'),
          });
          break;
        }
      }
      if (!remoteWriteRetryFailed) {
        await evidence.append({ phase: 'safety-gate', gate: 'final-branch-consistency', status: 'passed' });
      }
    }

    // =======================================================================
    // Determine final status
    // =======================================================================
    // 远端写入动作的状态决定整体发布状态
    // 市场安装动作的结果记录在 run 中，但不阻止 PUBLISHED
    const remoteWriteAllSucceeded = planActions
      .filter((a) => isRemoteWriteAction(a.type))
      .every((a) => {
        const result = actionResults.get(a.id);
        return result === 'succeeded' || result === 'skipped';
      });

    const remoteWriteFailed = planActions
      .filter((a) => isRemoteWriteAction(a.type))
      .some((a) => {
        const result = actionResults.get(a.id);
        return result === 'failed' || result === 'uncertain';
      });

    const effectiveFromStatus = PARTIAL;

    // 远端写入动作的状态决定 PUBLISHED
    // 市场安装动作的失败不阻止 PUBLISHED
    let overallStatus;
    if (remoteWriteAllSucceeded && !remoteWriteRetryFailed) {
      overallStatus = PUBLISHED;
    } else if (remoteWriteFailed || remoteWriteRetryFailed) {
      overallStatus = PARTIAL;
    } else {
      overallStatus = PARTIAL;
    }

    // Only validate state transition if status actually changes
    if (effectiveFromStatus !== overallStatus) {
      assertTransition(effectiveFromStatus, overallStatus);
    }

    await evidence.append({
      phase: 'reconcile',
      status: 'completed',
      overallStatus,
      actionStatuses: planActions.map((a) => actionResults.get(a.id)),
    });

    // Build checkpoints for return value and run file
    const resultCheckpoints = planActions.map((a) => {
      const status = actionResults.get(a.id) ?? 'pending';
      const normalized = status === 'deferred' ? 'deferred'
        : status === 'succeeded' ? 'succeeded'
        : status === 'failed' ? 'failed'
        : status === 'skipped' ? 'skipped'
        : status === 'uncertain' ? 'uncertain'
        : 'pending';
      return {
        actionId: a.id,
        status: normalized,
        ...(normalized === 'deferred' ? { reason: CONSUMER_VERIFICATION_DEFERRED, phase: 'post-publish-verification' } : {}),
      };
    });

    // Write new reconcile run with sourceRunId
    const runPath = join(runDir, 'release-run.json');
    const sourceRunDigest = sourceAuthorityDigest;
    const runState = {
      runId,
      command: 'reconcile',
      planDigest: plan.digest,
      planPath,
      ...(consumedApprovalPath ? {
        approvalPath: consumedApprovalPath,
        approvalDigest: consumedApprovalDigest,
      } : {}),
      sourceRunId: sourceRun.runId,
      sourceRunDigest,
      sourceRunPath,
      status: overallStatus,
      ...(sourceAuthorityReceipt
        ? { sourceAuthorityReceipts: [sourceAuthorityReceipt] }
        : {}),
      checkpoints: planActions.map((a) => {
        const status = actionResults.get(a.id) ?? 'pending';
        const normalized = status === 'deferred' ? 'deferred'
          : status === 'succeeded' ? 'succeeded'
          : status === 'failed' ? 'failed'
          : status === 'skipped' ? 'skipped'
          : status === 'uncertain' ? 'uncertain'
          : 'pending';
        return {
          actionId: a.id,
          actionType: a.type,
          status: normalized,
          ...(normalized === 'deferred' ? { reason: CONSUMER_VERIFICATION_DEFERRED, phase: 'post-publish-verification' } : {}),
        };
      }),
      startedAt: reconcileStartedAt,
      finishedAt: clockFn(),
    };
    if (retryStateSequence >= 0) {
      await persistRetryState(overallStatus, runState.finishedAt);
    }
    const persistedRun = await writeRunAtomic(runPath, runState);
    recoveryRunPath = runPath;
    const { recoveryActionCode } = await readRunRecovery(runPath, { planPath, clock: clockFn });

    await evidence.finish({
      status: overallStatus,
      recoveryActionCode,
      planPath,
      runPath,
      sourceRunId: sourceRun.runId,
      sourceRunDigest,
      sourceRunPath,
      runDigest: persistedRun.runDigest,
      actionStatuses: planActions.map((a) => actionResults.get(a.id)),
      completedAt: clockFn(),
    });

    return { planPath, runPath, status: overallStatus, checkpoints: resultCheckpoints, recoveryActionCode };
  } catch (err) {
    const { recoveryActionCode } = await readRunRecovery(recoveryRunPath, {
      planPath, approvalPath, clock: clockFn, command: 'reconcile', error: err,
    });
    err.details = { ...err.details, recoveryActionCode };
    // M1/M2: record the failure best-effort and always seal the stream; the
    // original error must win. The writer normalizes the diagnostic fields
    // (a numeric Git 128 stays EXIT_128 and is never replaced by a schema
    // error), and the single-shot seal makes a second finish a no-op.
    try {
      await evidence.append({ phase: 'reconcile', status: 'failed', error: err, details: { recoveryActionCode } });
    } catch {
      // Failure evidence is best-effort; the seal below must never be skipped.
    }
    try {
      await evidence.finish({
        status: 'FAILED',
        recoveryActionCode,
        error: err,
        details: { recoveryActionCode },
        failedAt: clockFn(),
      });
    } catch {
      // Failure summary is best-effort; never mask the primary failure.
    }
    throw err;
  }
}
