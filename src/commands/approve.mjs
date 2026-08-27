/**
 * Approve command: record approval for a frozen release plan.
 *
 * Reads a frozen release plan, validates its digest against the expected value,
 * constructs an approval record, validates it, and writes it to disk.
 *
 * Approval invariants:
 * - `planDigest` must match the actual plan digest (otherwise PLAN_DIGEST_MISMATCH).
 * - `approvedActions` must be explicit (no wildcards).
 * - Approval expires after a default of 24 hours.
 * - If the plan's baseline has changed since freeze, approval is invalidated.
 *
 * @module commands/approve
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';

import {
  assertAuthorityFileTarget,
  assertImmutablePlanAuthority,
  computePlanDigest,
  prepareAuthorityDirectory,
  validatePlan,
  validatePlanActionCompleteness,
} from '../core/plan.mjs';
import { ReleaseError, PLAN_DIGEST_MISMATCH, GATE_FAILED } from '../core/errors.mjs';
import {
  computeApprovalDigest,
  validateApprovalRecordSchema,
  MAX_APPROVAL_MS,
} from '../core/approval.mjs';
import { validatePostPublishApproval, derivePostPublishApprovalAuthorityPath } from '../core/postpublish-approval.mjs';
import {
  normalizePostPublishHook,
  effectiveHookRequiresApproval,
  normalizePostPublishView,
  validatePostPublishHookIdUniqueness,
} from '../core/postpublish.mjs';
import { WORKSPACE_DIGEST_ALGORITHM } from '../core/baseline.mjs';

// ---------------------------------------------------------------------------
// Default clock
// ---------------------------------------------------------------------------

function defaultClock() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Approve a frozen release plan.
 *
 * Steps:
 * 1. Read the plan from `planPath`.
 * 2. Compute the plan's actual digest.
 * 3. Compare against `expectedDigest`; throw PLAN_DIGEST_MISMATCH if different.
 * 4. Validate the plan against the release-plan schema.
 * 5. Build the approval record with explicit action IDs, actor, and timestamps.
 * 6. Validate the approval record against the approval-record schema.
 * 7. Write the approval record to disk.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} [options.expectedDigest] - Expected SHA-256 digest of the plan.
 *   When omitted, the digest is computed from the immutable plan file.
 * @param {string} options.actor - Identity of the approver.
 * @param {number} [options.expiresInMs=86400000] - Approval validity in ms (default 24h).
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {string} [options.outputPath] - Path to write the approval record.
 *   Defaults to `<releaseDir>/approval-record.json`; a digest-addressed copy is
 *   preserved at `<releaseDir>/approvals/<planDigest>/<approvalDigest>.json`.
 *
 * @returns {Promise<object>} The validated ApprovalRecord.
 *
 * @throws {ReleaseError} PLAN_DIGEST_MISMATCH if the plan digest does not match.
 * @throws {ReleaseError} GATE_FAILED on schema validation or other gate failures.
 */
export async function approvePlan(options) {
  const {
    planPath,
    expectedDigest: expectedDigestInput,
    actor,
    expiresInMs = 24 * 60 * 60 * 1000, // 24 hours
    clock,
    outputPath,
  } = options ?? {};

  const clockFn = typeof clock === 'function' ? clock : defaultClock;

  // --- Validate required parameters ---
  if (!planPath || typeof planPath !== 'string') {
    throw new ReleaseError(PLAN_DIGEST_MISMATCH, 'planPath must be a non-empty string');
  }
  if (!actor || typeof actor !== 'string') {
    throw new ReleaseError(GATE_FAILED, 'actor must be a non-empty string');
  }

  // --- Step 1: Read the plan ---
  let planRaw;
  try {
    planRaw = await readFile(planPath, 'utf8');
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `cannot read release plan: ${err.message}`,
      { planPath, cause: err.code },
    );
  }

  let plan;
  try {
    plan = JSON.parse(planRaw);
  } catch (err) {
    throw new ReleaseError(
      GATE_FAILED,
      `release plan is not valid JSON: ${err.message}`,
      { planPath },
    );
  }

  // --- Step 2: Compute actual plan digest ---
  // The plan was written by writePlanAtomic, which embeds the digest.
  // We recompute from the stored content minus the digest field.
  const actualDigest = computePlanDigest(plan);
  assertImmutablePlanAuthority(planPath, plan);

  // --- Step 3: Resolve expectedDigest ---
  // When expectedDigest is omitted, auto-compute from the immutable plan file.
  const expectedDigest = expectedDigestInput ?? actualDigest;

  // --- Step 4: Compare digests ---
  if (actualDigest !== expectedDigest) {
    throw new ReleaseError(
      PLAN_DIGEST_MISMATCH,
      `plan digest mismatch: expected ${expectedDigest.slice(0, 16)}..., got ${actualDigest.slice(0, 16)}...`,
      { expectedDigest, actualDigest },
    );
  }

  // --- Step 4: Validate the plan ---
  validatePlan(plan);

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

  // --- Step 4b: Validate action completeness ---
  const completenessResult = validatePlanActionCompleteness(plan);
  if (!completenessResult.passed) {
    throw new ReleaseError(
      GATE_FAILED,
      `plan action completeness gate failed: ${completenessResult.details.failures.join('; ')}`,
      { failures: completenessResult.details.failures },
    );
  }

  // --- Step 5a: Validate expiresInMs ---
  if (typeof expiresInMs !== 'number' || !Number.isFinite(expiresInMs) || expiresInMs <= 0) {
    throw new ReleaseError(
      GATE_FAILED,
      'expiresInMs must be a positive finite number',
      { expiresInMs },
    );
  }
  const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
  if (expiresInMs > MAX_EXPIRY_MS) {
    throw new ReleaseError(
      GATE_FAILED,
      `expiresInMs must not exceed 24 hours (${MAX_EXPIRY_MS}ms), got ${expiresInMs}ms`,
      { expiresInMs },
    );
  }

  // --- Step 5b: Materialize every unit version into the approval authority ---
  const units = plan.units ?? [];
  const versions = new Set();
  const unitVersions = {};
  for (const unit of units) {
    if (!unit.targetVersion || typeof unit.targetVersion !== 'string' || unit.targetVersion.trim() === '') {
      throw new ReleaseError(
        GATE_FAILED,
        `unit "${unit.id ?? '(unknown)'}" is missing targetVersion; all units must have a non-empty targetVersion`,
        { unitId: unit.id },
      );
    }
    versions.add(unit.targetVersion);
    unitVersions[unit.id] = unit.targetVersion;
  }
  const targetVersion = versions.size === 1 ? units[0]?.targetVersion : undefined;

  // --- Step 5c: Build approval record ---
  const approvedAt = clockFn();
  const approvedAtDate = new Date(approvedAt);
  if (Number.isNaN(approvedAtDate.getTime())) {
    throw new ReleaseError(
      GATE_FAILED,
      `invalid approvedAt timestamp: "${approvedAt}"`,
      { approvedAt },
    );
  }
  const expiresAt = new Date(approvedAtDate.getTime() + expiresInMs).toISOString();

  // Collect all external action IDs (explicit, no wildcards)
  const approvedActions = (plan.externalActions ?? []).map((a) => a.id);

  // Build baseline with workspaceDigest when plan has it
  const baseline = {
    gitTreeHash: plan.baseline.gitTreeHash,
  };
  if (plan.baseline.workspaceDigest) {
    baseline.workspaceDigest = plan.baseline.workspaceDigest;
  }
  if (plan.baseline.workspaceDigestAlgorithm) {
    baseline.workspaceDigestAlgorithm = plan.baseline.workspaceDigestAlgorithm;
  }

  const approvalRecord = {
    planDigest: actualDigest,
    baseline,
    unitVersions,
    ...(targetVersion ? { targetVersion } : {}),
    approvedActions,
    actor,
    approvedAt,
    expiresAt,
  };

  // --- Step 6: Validate approval record ---
  validateApprovalRecordSchema(approvalRecord);

  // --- Step 7: Preserve a digest-addressed authority and update convenience copy ---
  const planDir = dirname(resolve(planPath));
  const releaseDir = basename(planDir) === 'plans' && basename(planPath) === `${actualDigest}.json`
    ? dirname(planDir)
    : planDir;
  if (
    plan.production?.mode === 'github-npm-v1' &&
    outputPath &&
    resolve(outputPath) !== resolve(releaseDir, 'approval-record.json')
  ) {
    throw new ReleaseError(
      GATE_FAILED,
      'production approve requires the canonical approval-record.json alias next to the immutable plan authority; custom --output is supported only outside production',
      { outputPath: resolve(outputPath), expected: resolve(releaseDir, 'approval-record.json') },
    );
  }
  const json = JSON.stringify(approvalRecord, null, 2);
  const approvalDigest = computeApprovalDigest(json);
  const immutableApprovalPath = resolve(
    releaseDir,
    'approvals',
    actualDigest,
    `${approvalDigest}.json`,
  );
  await prepareAuthorityDirectory(dirname(immutableApprovalPath));
  await assertAuthorityFileTarget(immutableApprovalPath);
  try {
    await writeFile(immutableApprovalPath, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(immutableApprovalPath, 'utf8');
    if (existing !== json) {
      throw new ReleaseError(
        GATE_FAILED,
        'approval authority digest collision: existing bytes differ',
        { planDigest: actualDigest, approvalDigest, immutableApprovalPath },
      );
    }
  }

  const writePath = outputPath ?? resolve(releaseDir, 'approval-record.json');
  await prepareAuthorityDirectory(dirname(writePath));
  await assertAuthorityFileTarget(writePath);
  await writeFile(writePath, json, 'utf8');

  return Object.freeze({
    ...approvalRecord,
    approvalDigest,
    approvalPath: immutableApprovalPath,
    latestApprovalPath: writePath,
  });
}

/**
 * Approve a requiresApproval postPublish hook (checkpoint-level approval,
 * v0.6.3 R1, design §2.7 ruling 2).
 *
 * The record binds (planDigest, hookId) — the plan-level approval schema is
 * untouched. Hook config changes change the plan digest, so approvals
 * invalidate naturally with the plan. The result carries the approved hook's
 * normalized entry summary (review N-6) so the checkpoint approval interface
 * can display exactly what was approved.
 *
 * @param {Object} options
 * @param {string} options.planPath - Absolute path to the frozen release plan.
 * @param {string} options.hookId - id of the declared hook to approve.
 * @param {string} options.actor - Identity of the approver.
 * @param {number} [options.expiresInMs] - Validity window in ms (default and max 24h).
 * @param {() => string} [options.clock] - Clock function returning ISO-8601 strings.
 * @param {string} [options.runId] - Audit-only distribute run id (never a binding).
 *
 * @returns {Promise<object>} { planDigest, hookId, actor, approvedAt,
 *   expiresAt, approvalDigest, approvalPath, hookSummary }.
 *
 * @throws {ReleaseError} GATE_FAILED when the hook is undeclared, does not
 *   require approval, or the window exceeds 24h.
 */
export async function approvePostPublishHook(options) {
  const {
    planPath,
    hookId,
    actor,
    expiresInMs = MAX_APPROVAL_MS,
    clock,
    runId,
  } = options ?? {};

  const clockFn = typeof clock === 'function' ? clock : defaultClock;

  if (!planPath || typeof planPath !== 'string') {
    throw new ReleaseError(GATE_FAILED, 'planPath must be a non-empty string');
  }
  if (!hookId || typeof hookId !== 'string') {
    throw new ReleaseError(GATE_FAILED, 'hookId must be a non-empty string');
  }
  if (!actor || typeof actor !== 'string') {
    throw new ReleaseError(GATE_FAILED, 'actor must be a non-empty string');
  }
  if (typeof expiresInMs !== 'number' || !Number.isFinite(expiresInMs) || expiresInMs <= 0) {
    throw new ReleaseError(GATE_FAILED, 'expiresInMs must be a positive finite number', { expiresInMs });
  }
  if (expiresInMs > MAX_APPROVAL_MS) {
    throw new ReleaseError(
      GATE_FAILED,
      `expiresInMs must not exceed 24 hours (${MAX_APPROVAL_MS}ms), got ${expiresInMs}ms`,
      { expiresInMs },
    );
  }

  // --- Load and validate the frozen plan ---
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
  const actualDigest = computePlanDigest(plan);
  assertImmutablePlanAuthority(planPath, plan);
  validatePlan(plan);

  // --- Locate the declared hook (fail-closed) ---
  // §4.3 unified normalization (rework R-02): hookId is globally unique
  // across the v3 declaration array; minting resolves the same normalized
  // view the runtime gating uses AND re-asserts the single array-level
  // uniqueness authority — a duplicate hook id must never mint an approval
  // that would authorize two units.
  const declarations = normalizePostPublishView(plan);
  validatePostPublishHookIdUniqueness(declarations);
  const hooks = declarations.flatMap((declaration) => declaration.hooks ?? []);
  const hook = hooks.find((entry) => entry.id === hookId);
  if (!hook) {
    throw new ReleaseError(
      GATE_FAILED,
      `hook "${hookId}" is not declared in the frozen plan's postPublish hooks`,
      { hookId, declaredHookIds: hooks.map((entry) => entry.id) },
    );
  }
  // Effective requiresApproval (§2.6 grading, R4 review M-1): preset hooks
  // may inherit the preset-declared default (proposal-inbox git-push,
  // declared OR inferred from a remoteUrl address -> true) without an
  // explicit declaration. Grading by the literal value here would refuse to
  // mint approvals for exactly the hooks the runtime gates — the mint and
  // validatePostPublishApproval must agree on the effective value.
  const effectiveRequiresApproval = effectiveHookRequiresApproval(hook);
  if (effectiveRequiresApproval !== true) {
    throw new ReleaseError(
      GATE_FAILED,
      `hook "${hookId}" does not require approval (effective requiresApproval is not true)`,
      { hookId, requiresApproval: effectiveRequiresApproval },
    );
  }

  // --- Build the checkpoint approval record ---
  const approvedAt = clockFn();
  const approvedAtDate = new Date(approvedAt);
  if (Number.isNaN(approvedAtDate.getTime())) {
    throw new ReleaseError(GATE_FAILED, `invalid approvedAt timestamp: "${approvedAt}"`, { approvedAt });
  }
  const expiresAt = new Date(approvedAtDate.getTime() + expiresInMs).toISOString();

  const approvalRecord = {
    planDigest: actualDigest,
    hookId,
    actor,
    approvedAt,
    expiresAt,
    ...(runId ? { runId } : {}),
  };

  // Full fail-closed re-validation (schema + bindings + time window).
  validatePostPublishApproval(plan, approvalRecord, { clock: clockFn });

  // --- Write the digest-addressed authority ---
  const json = JSON.stringify(approvalRecord, null, 2);
  const approvalDigest = computeApprovalDigest(json);
  // Single authority-layout source (core/postpublish-approval.mjs): the
  // consumer-side assertion derives the exact same path fail-closed.
  const { authorityPath: immutableApprovalPath } = derivePostPublishApprovalAuthorityPath(
    planPath,
    actualDigest,
    approvalDigest,
  );
  await prepareAuthorityDirectory(dirname(immutableApprovalPath));
  await assertAuthorityFileTarget(immutableApprovalPath);
  try {
    await writeFile(immutableApprovalPath, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(immutableApprovalPath, 'utf8');
    if (existing !== json) {
      throw new ReleaseError(
        GATE_FAILED,
        'postpublish approval authority digest collision: existing bytes differ',
        { planDigest: actualDigest, approvalDigest, immutableApprovalPath },
      );
    }
  }

  // Review N-6: the normalized entry summary is the display surface of the
  // checkpoint approval interface (defaults applied, digest-bound).
  const hookSummary = normalizePostPublishHook(hook);

  return Object.freeze({
    ...approvalRecord,
    approvalDigest,
    approvalPath: immutableApprovalPath,
    hookSummary,
  });
}
